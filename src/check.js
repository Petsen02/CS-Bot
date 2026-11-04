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
import { listChampionships, pickSeason, getStandings, findTeamStanding } from './esea.js';
import { getPlayerTeams } from './faceit.js';
import { levelFor, nextLevel } from './elo.js';

const PASS = '  ok  ';
const FAIL = ' FEJL ';
const WARN = ' obs  ';

const SEP_CHECK = '  |  ';
let failures = 0;

/** Spillerens rå player_stats, til at vise de faktiske nøglenavne. */
function findPlayerRow(payload, playerId) {
  for (const team of payload?.rounds?.[0]?.teams ?? []) {
    for (const entry of team.players ?? []) {
      if (entry.player_id === playerId) return entry.player_stats ?? {};
    }
  }
  return null;
}

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
        expect('runder', stats.rounds, { required: false });
        expect('kills', stats.kills);
        expect('deaths', stats.deaths);
        expect('assists', stats.assists, { required: false });
        expect('K/D', stats.kd, { required: false });
        expect('K/R', stats.kr, { required: false });
        expect('ADR', stats.adr, { required: false });
        expect('total damage', stats.damage, { required: false });
        expect('HS%', stats.hs, { required: false });
        expect('enemies flashed', stats.flashed, { required: false });
        expect('utility damage', stats.utilDamage, { required: false });
        expect('MVPs', stats.mvps, { required: false });
        expect('entry kills', stats.entryKills, { required: false });
        expect('clutches', stats.clutches, { required: false });

        // FACEIT Rating og Round Swing kom til med Season 8 og er de to mest
        // usikre felter i hele botten: de kan vise sig kun at findes i
        // web-UI'et. Derfor får de deres egen afsnit, og de rå nøgler printes
        // så det rigtige navn kan læses af hvis vores gæt var forkert.
        console.log('');
        const rating = expect('FACEIT Rating', stats.rating, { required: false });
        const swing = expect('Round Swing', stats.swing, { required: false });

        if (!rating || !swing) {
          const row = findPlayerRow(raw, player.playerId);
          console.log('         Data API\'et havde ikke begge. Alle nøgler i player_stats:');
          console.log(`         ${Object.keys(row ?? {}).join(', ') || '(ingen)'}`);
          console.log('         Står rating/swing på listen under et andet navn, tilføj det');
          console.log('         i readMatchStats i src/commands.js. Står de slet ikke, findes');
          console.log('         de kun i FACEIT\'s web-UI, og !lastgame udelader dem.');
        }

        if (Number.isFinite(stats.swing)) {
          // Enheden er ubekræftet: FACEIT viser swing som en ændring i
          // vinderchance, så procent er sandsynligt, men ikke bevist.
          console.log(`         swing rå værdi: ${stats.swing} `
            + `(${Math.abs(stats.swing) <= 100 ? 'kunne være procent' : 'næppe procent'})`);
        }
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
      national.position === null
        ? 'ingen position — country-filteret ser ikke ud til at virke på denne rute'
        : `#${national.position}`);
  }

  console.log('\n--- ESEA League ---');
  const championships = await step('listChampionships', () => listChampionships());

  if (Array.isArray(championships)) {
    report(championships.length > 0 ? PASS : FAIL, 'divisioner fundet', String(championships.length));

    const seasons = [...new Set(championships.map((c) => c.season))].sort((a, b) => b - a);
    console.log(`         sæsoner: ${seasons.slice(0, 8).join(', ')}`);

    const season = pickSeason(championships, defaultRegion);
    if (!season) {
      report(FAIL, `${defaultRegion}-sæson`, 'ingen divisioner i regionen');
    } else {
      report(PASS, `nyeste ${defaultRegion}-sæson`, `S${season.season}`);
      console.log(`         divisioner: ${season.divisions.map((d) => d.division).join(', ')}`);

      // Stillingen er det !esea lever af. Er den tom, er kommandoen død.
      const division = season.divisions[0];
      const standings = await step(`getStandings (${division.division})`,
        () => getStandings(division.id));

      if (Array.isArray(standings)) {
        report(standings.length > 0 ? PASS : FAIL, 'hold i stillingen', String(standings.length));

        const top = standings[0];
        if (top) {
          expect('holdnavn', top.teamName);
          // DETTE er den sidste ubekræftede antagelse: at team-id'et i
          // stillingen er det samme id som /players/{id}/teams giver.
          expect('hold-id', top.teamId);
          console.log(`         top 3: ${standings.slice(0, 3)
            .map((r) => `#${r.rank} ${r.teamName} ${r.won}-${r.lost}`).join(SEP_CHECK)}`);
        }
      }

      if (player.playerId) {
        const teams = await step('getPlayerTeams', () => getPlayerTeams(player.playerId));
        if (Array.isArray(teams)) {
          report(teams.length > 0 ? PASS : WARN, 'spillerens hold', String(teams.length));
          for (const team of teams.slice(0, 8)) {
            console.log(`           ${team.name}  ${team.teamId}`);
          }

          const standing = await findTeamStanding(teams.map((t) => t.teamId), season.divisions);
          if (standing) {
            report(PASS, 'spilleren fundet i en division',
              `${standing.division} — ${standing.teamName} #${standing.rank}`);
          } else {
            // Gyldigt svar: de fleste spiller ikke ESEA.
            report(WARN, 'spilleren i en division', 'ikke på et hold i denne sæson');
          }
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
