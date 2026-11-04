import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { projectRoot } from './config.js';

/**
 * Vedvarende tilstand for elo-måling.
 *
 * FACEIT udstiller nuværende elo, men ingen elo pr. kamp: /players/{id}/history
 * dokumenterer ikke et elo-felt. Derfor er hvert elo-tal denne bot rapporterer
 * målt af os selv — vi tager et snapshot af hver tracket spillers elo, og når
 * en ny kamp dukker op, tilskrives ændringen den kamp.
 *
 * At miste denne fil er at miste elo-historikken, så skrivninger er atomare:
 * skriv til en nabofil, omdøb. Rename er atomart på samme filsystem.
 *
 * Datamængden er lille — ét snapshot pr. spiller plus nogle få kampe om dagen
 * — så en JSON-fil slår en database her, og undgår en native afhængighed der
 * skulle kompilere på serveren.
 */

const DATA_DIR = join(projectRoot, 'data');
const DATA_FILE = join(DATA_DIR, 'tracker.json');
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1, players: {} };
}

export class Store {
  #state;

  constructor(file = DATA_FILE) {
    this.file = file;
    this.#state = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.players) return parsed;
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  save() {
    // Mappen udledes af filen, ikke af en modulkonstant: ellers ville en Store
    // med en anden sti oprette den forkerte mappe og skrive sin temp-fil et
    // tredje sted.
    mkdirSync(dirname(this.file), { recursive: true });

    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state), 'utf8');
    renameSync(temp, this.file);
  }

  #player(playerId, nickname) {
    let player = this.#state.players[playerId];
    if (!player) {
      player = { nickname, snapshot: null, matches: {}, baselines: {} };
      this.#state.players[playerId] = player;
    }
    // Nicks kan ændres. Opdatér når pollen alligevel har svaret i hånden.
    if (nickname) player.nickname = nickname;
    player.matches ??= {};
    player.baselines ??= {};
    return player;
  }

  getNickname(playerId) {
    return this.#state.players[playerId]?.nickname ?? null;
  }

  getSnapshot(playerId) {
    return this.#state.players[playerId]?.snapshot ?? null;
  }

  setSnapshot(playerId, nickname, snapshot) {
    this.#player(playerId, nickname).snapshot = snapshot;
  }

  /** Elo-ændringen målt for en bestemt kamp, eller null hvis vi aldrig så den. */
  getMatchDelta(playerId, matchId) {
    return this.#state.players[playerId]?.matches?.[matchId]?.eloDelta ?? null;
  }

  hasMatch(playerId, matchId) {
    return Boolean(this.#state.players[playerId]?.matches?.[matchId]);
  }

  recordMatch(playerId, nickname, matchId, { eloDelta, won, at }) {
    this.#player(playerId, nickname).matches[matchId] = {
      eloDelta,
      won,
      at: at ?? Date.now(),
    };
  }

  /** Alle kampe i et tidsrum, ældste først — det !session bygger på. */
  getMatchesBetween(playerId, fromMs, toMs = Date.now()) {
    const matches = this.#state.players[playerId]?.matches ?? {};

    return Object.entries(matches)
      .filter(([, record]) => record.at >= fromMs && record.at <= toMs)
      .sort((a, b) => a[1].at - b[1].at)
      .map(([matchId, record]) => ({ matchId, ...record }));
  }

  /**
   * Den elo en spiller startede det lokale døgn på, med tidspunktet den blev
   * taget. Tidsstemplet er vigtigt: en baseline taget efter spilleren allerede
   * havde spillet er ikke et gyldigt anker for hele dagen, og at bruge den
   * alligevel ville rapportere en dag med sejre som et fladt nul.
   */
  getBaseline(playerId, dateKey) {
    const stored = this.#state.players[playerId]?.baselines?.[dateKey];
    if (stored === undefined || stored === null) return null;

    if (typeof stored === 'number') return { elo: stored, at: null };
    return stored;
  }

  setBaselineIfMissing(playerId, nickname, dateKey, elo, at = Date.now()) {
    const player = this.#player(playerId, nickname);
    if (player.baselines[dateKey] === undefined) {
      player.baselines[dateKey] = { elo, at };
      return true;
    }
    return false;
  }

  /**
   * Spillerens egen gennemsnitlige elo-gevinst pr. sejr, fra målte kampe.
   *
   * Langt bedre end at antage et fast tal: FACEIT giver omkring 25 ved jævnbyrdig
   * matchning, men afviger meget op og ned. Returnerer null indtil mindst én
   * sejr er målt.
   */
  getAverageEloGain(playerId) {
    const matches = this.#state.players[playerId]?.matches;
    if (!matches) return null;

    const gains = Object.values(matches)
      .map((record) => record.eloDelta)
      .filter((delta) => typeof delta === 'number' && delta > 0);

    if (gains.length === 0) return null;

    return gains.reduce((sum, value) => sum + value, 0) / gains.length;
  }

  /** Hvornår spilleren sidst fik en kamp bogført — bruges til at pace pollen. */
  getLastMatchAt(playerId) {
    const matches = this.#state.players[playerId]?.matches;
    if (!matches) return null;

    let latest = null;
    for (const record of Object.values(matches)) {
      if (record.at && (latest === null || record.at > latest)) latest = record.at;
    }
    return latest;
  }

  /** Sidste planlagte !top-læsning for en region, bevaret over genstart. */
  getRankingSnapshot(key) {
    return this.#state.rankings?.[key] ?? null;
  }

  setRankingSnapshot(key, snapshot) {
    this.#state.rankings ??= {};
    this.#state.rankings[key] = snapshot;
  }

  /** Smider gamle kampe og baseliner væk, så filen ikke vokser uendeligt. */
  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS;

    for (const player of Object.values(this.#state.players)) {
      for (const [matchId, record] of Object.entries(player.matches ?? {})) {
        if ((record.at ?? 0) < cutoff) delete player.matches[matchId];
      }

      const keepFrom = new Date(cutoff).toISOString().slice(0, 10);
      for (const dateKey of Object.keys(player.baselines ?? {})) {
        if (dateKey < keepFrom) delete player.baselines[dateKey];
      }
    }
  }
}

export const store = new Store();
