/**
 * Smoke test mod det rigtige FACEIT API, uden Twitch.
 *
 *   node src/check.js <nick-eller-SteamID64>
 *
 * Hele dataklienten er skrevet mod et skema der IKKE kunne verificeres under
 * udviklingen — alle faceit.com-værter var blokeret af netværkspolitikken i
 * miljøet. Denne fil findes for at lukke det hul: den kalder hvert endpoint
 * botten bruger, viser hvad der kom tilbage, og siger tydeligt hvilke felter
 * der manglede, så skemaet kan rettes ét sted i faceit.js.
 *
 * Den skriver intet til data/ og joiner ingen kanal.
 */
import { config, parsePlayerRef, defaultRegion, defaultCountry } from './config.js';
import {
  resolvePlayer,
  getHistory,
  getMatch,
  getMatchStats,
  getPlayerStats,
  getRanking,
} from './faceit.js';
import { readMatchStats, didWin } from './commands.js';
import { getLeague, pickCurrentSeason, getPlayerSeason, readEseaStanding, hasEseaPlace } from './esea.js';
import { levelFor, nextLevel } from './elo.js';

const PASS = '  ok  ';
const FAIL = ' FEJL ';
const WARN = ' obs  ';

let failures = 0;

function report(status, label, detail) {
  if (status === FAIL) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Tjekker at et felt vi er afhængige af faktisk kom med. */
function expect(label, value, { required = true } = {}) {
  const missing = value === null || value === undefined || value === '';
  if (missing) report(required ? FAIL : WARN, label, 'mangler i svaret');
  else report(PASS, label, String(value));
  return !missing;
}

async function step(label, fn) {
  try {
    const value = await fn();
    report(PASS, label);
    return value;
  } catch (error) {
    report(FAIL, label, error.message);
    return null;
  }
}

async function run() {
  const input = process.argv[2];
  if (!input) {
    console.error('Brug: node src/check.js <FACEIT-nick eller SteamID64>');
    process.exitCode = 2;
    return;
  }

  console.log(`base:   ${config.faceit.baseUrl}`);
  console.log(`game:   ${config.faceit.game}`);
  console.log(`region: ${defaultRegion}   land: ${defaultCountry}`);
  console.log(`budget: ${config.faceit.limits.map((l) => `${l.limit}/${l.windowMs}ms`).join(', ')}`);
  console.log('');

  const ref = parsePlayerRef(input);
  if (!ref) {
    console.error(`"${input}" kunne ikke læses som nick eller SteamID64`);
    process.exitCode = 2;
    return;
  }
  console.log(`--- opslag (${ref.kind}: ${ref.value}) ---`);

  const player = await step('resolvePlayer', () => resolvePlayer(ref));
  if (!player) {
    console.log('\nKan ikke fortsætte uden en spiller.');
    process.exitCode = 1;
    return;
  }

  expect('player_id', player.playerId);
  expect('nickname', player.nickname);
  expect('elo', player.elo);
  expect('skill_level', player.level);
  expect('steam id', player.steamId, { required: false });
  expect('country', player.country, { required: false });

  // Vores egen level-tabel mod FACEIT's eget tal. Afviger de, er tabellen i
  // elo.js forældet, og !nextrank lyver.
  if (Number.isFinite(player.elo) && Number.isFinite(player.level)) {
    const computed = levelFor(player.elo);
    if (computed === player.level) {
      report(PASS, 'level-tabel stemmer', `${player.elo} -> ${computed}`);
    } else {
      report(FAIL, 'level-tabel afviger',
        `FACEIT siger ${player.level}, LEVEL_FLOORS siger ${computed} for ${player.elo} elo`);
    }

    const next = nextLevel(player.elo);
    console.log(`         næste: ${next ? `level ${next.level} om ${next.needed} elo` : 'level 10'}`);
  }

  console.log('\n--- historik ---');
  const history = await step('getHistory(limit 5)', () => getHistory(player.playerId, { limit: 5 }));

  let finished = null;
  if (Array.isArray(history)) {
    report(history.length > 0 ? PASS : WARN, 'antal kampe', String(history.length));

    const first = history[0];
    if (first) {
      expect('match_id', first.match_id);
      expect('finished_at', first.finished_at, { required: false });
      expect('status', first.status, { required: false });

      const won = didWin(first, player.playerId);
      report(won === null ? FAIL : PASS, 'didWin kan afgøre resultatet',
        won === null ? 'hverken winner eller holdopstilling blev genkendt' : String(won));

      finished = history.find((item) => (item.status ?? 'FINISHED') === 'FINISHED') ?? first;
    }
  }

  if (finished?.match_id) {
    console.log('\n--- kamp ---');
    const match = await step('getMatch', () => getMatch(finished.match_id));
    if (match) {
      expect('status', match.status, { required: false });
      expect('teams', match.teams ? Object.keys(match.teams).join(',') : null, { required: false });
      expect('valgt map', match.voting?.map?.pick?.[0] ?? match.map ?? null, { required: false });
    }

    console.log('\n--- kampstatistik ---');
    const raw = await step('getMatchStats', () => getMatchStats(finished.match_id));
    if (raw) {
      const stats = readMatchStats(raw, player.playerId);
      if (!stats) {
        report(FAIL, 'readMatchStats', 'spillerens række blev ikke fundet i svaret');
      } else {
        expect('map', stats.map);
        expect('score', stats.score, { required: false });
        expect('kills', stats.kills);
        expect('deaths', stats.deaths);
        expect('K/D', stats.kd, { required: false });
        // ADR er den mest usikre: den var ikke bekræftet for CS2.
        expect('ADR', stats.adr, { required: false });
        expect('HS%', stats.hs, { required: false });
      }
    }
  }

  console.log('\n--- map-statistik ---');
  const playerStats = await step('getPlayerStats', () => getPlayerStats(player.playerId));
  if (playerStats) {
    const segments = (playerStats.segments ?? []).filter(
      (s) => (s?.type ?? '').toLowerCase() === 'map',
    );
    report(segments.length > 0 ? PASS : WARN, 'map-segmenter', String(segments.length));

    const first = segments[0];
    if (first) {
      expect('segment label', first.label);
      expect('Matches', first.stats?.Matches, { required: false });
      expect('Win Rate %', first.stats?.['Win Rate %'], { required: false });
    }
  }

  console.log('\n--- placering ---');
  const regional = await step('getRanking (region)', () => getRanking(defaultRegion, player.playerId));
  if (regional) {
    report(regional.position === null ? WARN : PASS, `${defaultRegion}-placering`,
      regional.position === null
        ? 'ingen position i svaret — se nøglerne nedenfor'
        : `#${regional.position}`);

    if (regional.position === null && regional.raw) {
      console.log(`         nøgler: ${Object.keys(regional.raw).join(', ')}`);
    }
  }

  const national = await step('getRanking (land)',
    () => getRanking(defaultRegion, player.playerId, defaultCountry));
  if (national) {
    report(national.position === null ? WARN : PASS, `${defaultCountry}-placering`,
      national.position === null ? 'ingen position i svaret' : `#${national.position}`);
  }

  console.log('\n--- ESEA League ---');
  const league = await step('getLeague', () => getLeague());

  if (league) {
    const seasons = Array.isArray(league.seasons) ? league.seasons : [];
    report(seasons.length > 0 ? PASS : FAIL, 'sæsoner i svaret', String(seasons.length));

    if (seasons.length === 0) {
      // Uden en sæsonliste kan sæsonen ikke udledes, og !esea har intet at slå op.
      console.log(`         nøgler i liga-svaret: ${Object.keys(league).join(', ')}`);
    }

    const season = pickCurrentSeason(league);
    if (!season?.seasonId) {
      report(FAIL, 'valgt sæson', 'kunne ikke udledes af ligaen');
    } else {
      report(PASS, 'valgt sæson', `${season.name ?? '(uden navn)'} — ${season.seasonId}`);

      const raw = await step('getPlayerSeason', () => getPlayerSeason(player.playerId, season.seasonId));
      if (raw) {
        const standing = readEseaStanding(raw);
        if (!hasEseaPlace(standing)) {
          // Et gyldigt svar: spilleren er ikke på et hold i denne sæson.
          report(WARN, 'ESEA-plads', 'spilleren er ikke med i sæsonen');
          console.log(`         nøgler: ${Object.keys(raw).join(', ')}`);
        } else {
          expect('division', standing.division, { required: false });
          expect('gruppe', standing.group, { required: false });
          expect('hold', standing.teamName, { required: false });
          expect('placering', standing.placement, { required: false });
          expect('W-L', standing.wins === null ? null : `${standing.wins}-${standing.losses}`,
            { required: false });
        }
      }
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('Alt det botten er afhængig af kom tilbage som forventet.');
  } else {
    console.log(`${failures} ting stemte ikke — ret skemaet i src/faceit.js og kør igen.`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`check fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
