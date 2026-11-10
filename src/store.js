import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { projectRoot } from './config.js';
import { openDatabase } from './sqlite.js';

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

/** Opstartslinjer skrives før loggeren findes, så de går til stdout. */
function logLine(message) {
  process.stdout.write(`[store] ${message}\n`);
}

function emptyState() {
  return { version: 1, players: {}, watch: {} };
}

/**
 * Om et Twitch-navn og et FACEIT-nick er den samme person.
 *
 * Mellemrum falder ud, fordi et Twitch-navn ikke kan indeholde et: "Lil
 * Rasmus" og "lilrasmus" er samme menneske der skriver samme navn under to
 * sæt regler. Store og små bogstaver går samme vej — Twitch skelner ikke,
 * FACEIT gør.
 */
export function namesMatch(twitch, nickname) {
  if (!twitch || !nickname) return false;

  const flatten = (value) => String(value).toLowerCase().replace(/\s+/g, '');
  return flatten(twitch) === flatten(nickname);
}

// Hvor længe der går, før et nyt opslag tæller som en ny interesse frem for
// gentagelse. Holder skrivninger nede uden at listen bliver forældet.
const WATCH_REFRESH_MS = 60 * 60_000;

export class Store {
  #state;
  #db;

  /**
   * @param {string} file JSON-filen. Databasen ligger ved siden af den, så en
   *   test med sin egen sti får sin egen database frem for projektets.
   */
  constructor(file = DATA_FILE, { quiet = false, useDatabase = true } = {}) {
    this.file = file;
    this.#db = useDatabase ? openDatabase(file.replace(/\.json$/, '.db')) : null;

    if (!this.#db) {
      this.#state = this.#load();
      if (!quiet) logLine('node:sqlite findes ikke — bruger JSON');
      return;
    }

    // En tom database på en bot der har kørt er første start efter
    // opgraderingen, så JSON-filen flyttes med over. Filen læses kun, aldrig
    // slettet: den er vejen tilbage hvis SQLite alligevel ikke var ønsket.
    if (this.#db.isEmpty()) {
      const existing = this.#load();
      const carried = Object.keys(existing.players ?? {}).length
        + Object.keys(existing.watch ?? {}).length;

      if (carried > 0) {
        this.#db.importState(existing);
        if (!quiet) logLine(`flyttede ${carried} poster fra JSON til SQLite`);
      }
    }

    this.#state = this.#db.readState();
    if (!quiet) logLine(`bruger SQLite (${this.#db.path})`);
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.players) {
        parsed.watch ??= {};
        return parsed;
      }
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  /**
   * På SQLite er dette en tom handling: hver ændring blev skrevet da den
   * skete. Kalderne kalder den stadig, for det skal de på JSON.
   */
  save() {
    if (this.#db) return;

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

    this.#db?.putPlayer(playerId, player.nickname);
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
    this.#db?.putSnapshot(playerId, snapshot);
  }

  /** Elo-ændringen målt for en bestemt kamp, eller null hvis vi aldrig så den. */
  getMatchDelta(playerId, matchId) {
    return this.#state.players[playerId]?.matches?.[matchId]?.eloDelta ?? null;
  }

  hasMatch(playerId, matchId) {
    return Boolean(this.#state.players[playerId]?.matches?.[matchId]);
  }

  recordMatch(playerId, nickname, matchId, { eloDelta, won, at }) {
    const record = { eloDelta, won, at: at ?? Date.now() };
    this.#player(playerId, nickname).matches[matchId] = record;
    this.#db?.putMatch(playerId, matchId, record);
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
      this.#db?.putBaseline(playerId, dateKey, { elo, at });
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
    this.#db?.putRanking(key, snapshot);
  }

  /**
   * Bottens egen watch-liste, uafhængig af kanalernes spillerlister.
   *
   * En kanals liste siger hvem streameren bryder sig om; denne siger hvem vi
   * måler. De er bevidst adskilt: at spørge om en spiller i chatten skal
   * starte målingen af dem, men ikke dukke op i kanalens !csbotplayerlist,
   * som mods selv plejer.
   *
   * Det er dét der gør at folk kan få deres egen konto med uden at nogen
   * tilføjer den i hånden — første gang en seer skriver `!rank <sit nick>`,
   * er kontoen på listen og bliver målt fra da af.
   *
   * `twitch` er den der skrev kommandoen, gemt fra den første der spurgte.
   * Botten kan ikke se om nogen spørger om sin egen konto, så det navn er et
   * gæt — og en senere spørger er normalt ikke mere sandsynlig.
   *
   * Med én undtagelse: hvis Twitch-navnet ER FACEIT-nicket. Det er det
   * tætteste botten kommer på et ejerskabsbevis, så det overtager linket fra
   * et gæt. Det kan ikke overtage fra et navn der matcher lige så godt, og et
   * navn der ikke matcher kan slet ikke overtage — så linket kan kun flytte
   * sig mod den sandsynlige ejer, aldrig væk.
   *
   * @returns {'added' | 'refreshed' | 'current'}
   */
  watch(player, { at = Date.now(), twitch = null, force = false } = {}) {
    if (!player?.playerId) return 'current';

    this.#state.watch ??= {};
    const existing = this.#state.watch[player.playerId];

    if (!existing) {
      const entry = {
        playerId: player.playerId,
        nickname: player.nickname ?? null,
        steamId: player.steamId ?? null,
        twitch: twitch ?? null,
        addedAt: at,
        lastAskedAt: at,
      };
      this.#state.watch[player.playerId] = entry;
      this.#db?.putWatch(entry);
      return 'added';
    }

    // Nicks kan ændres; listen skal vise det nuværende.
    if (player.nickname) existing.nickname = player.nickname;
    if (player.steamId) existing.steamId = player.steamId;

    // En tom post — fra før linket fandtes — tager den næste spørger den ser
    // frem for at blive stående tom for altid.
    const claimed = Boolean(twitch)
      && (force
        || !existing.twitch
        || (namesMatch(twitch, existing.nickname) && !namesMatch(existing.twitch, existing.nickname)));

    if (claimed) existing.twitch = twitch;

    if (!claimed && at - (existing.lastAskedAt ?? 0) < WATCH_REFRESH_MS) {
      // Et nick der har ændret sig er stadig værd at gemme, selv når
      // tidsstemplet ikke skal røres.
      this.#db?.putWatch(existing);
      return 'current';
    }

    existing.lastAskedAt = at;
    this.#db?.putWatch(existing);
    return 'refreshed';
  }

  /** Hele watch-listen. */
  watchedAccounts() {
    return Object.values(this.#state.watch ?? {});
  }

  /** Smider gamle kampe og baseliner væk, så filen ikke vokser uendeligt. */
  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS;
    const keepFrom = new Date(cutoff).toISOString().slice(0, 10);
    this.#db?.prune(cutoff, keepFrom);

    for (const player of Object.values(this.#state.players)) {
      for (const [matchId, record] of Object.entries(player.matches ?? {})) {
        if ((record.at ?? 0) < cutoff) delete player.matches[matchId];
      }

      for (const dateKey of Object.keys(player.baselines ?? {})) {
        if (dateKey < keepFrom) delete player.baselines[dateKey];
      }
    }
  }
}

export const store = new Store();
