/**
 * Kortlægger ESEA i FACEIT's Data API.
 *
 *   node src/probe-esea.js [nick]
 *
 * Tidligere runder afviste det oplagte og fandt så den rigtige vej:
 *
 *   - `/leagues/*` svarer 404 for ESEA. Ligaen findes ikke som "league".
 *   - `/search/organizers?name=ESEA` giver organizeren
 *     08b06cfc-74d0-454b-9a51-feda4b6b18da.
 *   - Divisionerne er CHAMPIONSHIPS under den organizer, navngivet
 *     "ESEA League EU Advanced S51 Qualifier" — region og sæsonnummer i navnet.
 *
 * Denne runde følger kæden derfra: championships -> leaderboard-definition ->
 * stilling -> holdene. Det er præcis det !esea skal bruge.
 *
 * Den skriver intet og ændrer ingenting.
 */
import { config, parsePlayerRef } from './config.js';
import { resolvePlayer } from './faceit.js';

const ESEA_ORGANIZER = '08b06cfc-74d0-454b-9a51-feda4b6b18da';

async function call(path, params = {}) {
  const url = new URL(`${config.faceit.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.faceit.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 0, body: null, error: error.message };
  }
}

async function show(label, path, params) {
  const { status, body, error } = await call(path, params);

  if (status !== 200) {
    console.log(`[ ${String(status || 'net').padStart(4)} ] ${label}${error ? ` — ${error}` : ''}`);
    return null;
  }

  const count = Array.isArray(body?.items) ? ` — ${body.items.length} items` : '';
  console.log(`[  OK  ] ${label}${count}`);
  return body;
}

/** Sæsonnummeret står kun i navnet, som "S59". */
export function parseSeason(name) {
  const match = String(name ?? '').match(/\bS(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

async function allEseaChampionships() {
  const all = [];

  for (let offset = 0; offset < 600; offset += 50) {
    const { status, body } = await call(`/organizers/${ESEA_ORGANIZER}/championships`,
      { offset, limit: 50 });

    if (status !== 200) {
      console.log(`         stoppede ved offset ${offset}: HTTP ${status}`);
      break;
    }

    const items = body?.items ?? [];
    all.push(...items);
    process.stdout.write(`\r         hentet ${all.length}…`);
    if (items.length < 50) break;
  }

  process.stdout.write('\r');
  return all.map((item) => ({
    id: item.championship_id ?? item.id,
    name: String(item.name ?? ''),
    season: parseSeason(item.name),
    region: item.region ?? '?',
    status: item.status ?? '?',
    groups: item.total_groups,
  }));
}

async function run() {
  console.log(`base: ${config.faceit.baseUrl}`);
  console.log(`ESEA organizer: ${ESEA_ORGANIZER}\n`);

  let playerId = null;
  const input = process.argv[2];
  if (input) {
    const ref = parsePlayerRef(input);
    if (ref) {
      try {
        const player = await resolvePlayer(ref);
        playerId = player.playerId;
        console.log(`spiller: ${player.nickname} — ${playerId}\n`);
      } catch (error) {
        console.log(`kunne ikke slå "${input}" op: ${error.message}\n`);
      }
    }
  }

  console.log('--- ESEA-championships ---');
  const champs = await allEseaChampionships();
  console.log(`         ${champs.length} championships under ESEA\n`);

  // Hvilke sæsoner, hvor mange, og hvilke statusser. Uden det her er et valg
  // af "nyeste sæson" bare et nyt gæt: S58 gav én aflyst OCE-finale.
  const bySeason = new Map();
  for (const c of champs) {
    const key = c.season ?? '(uden)';
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key).push(c);
  }

  const seasonKeys = [...bySeason.keys()]
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => b - a);

  console.log('         sæson  antal  statusser');
  for (const key of seasonKeys) {
    const list = bySeason.get(key);
    const statuses = [...new Set(list.map((c) => c.status))].join('/');
    console.log(`         ${String(key).padStart(5)}  ${String(list.length).padStart(5)}  ${statuses}`);
  }
  const noSeason = bySeason.get('(uden)') ?? [];
  if (noSeason.length) console.log(`         uden sæson i navnet: ${noSeason.length}`);

  // De rigtige ligadivisioner, i modsætning til finaler og kvalifikationer.
  const DIVISIONS = /\b(entry|intermediate|main|advanced|open)\b/i;
  const divisions = champs.filter((c) => DIVISIONS.test(c.name));

  console.log(`\n         ${divisions.length} med et divisionsnavn i titlen`);
  console.log('         nyeste 25:');
  for (const c of divisions.sort((a, b) => (b.season ?? 0) - (a.season ?? 0)).slice(0, 25)) {
    console.log(`           ${c.name}`);
    console.log(`             id=${c.id} region=${c.region} status=${c.status} grupper=${c.groups}`);
  }

  // Navne uden division: finaler, playoffs, hvad ellers? Mønstrene afgør
  // hvordan !esea skal vælge.
  const others = champs.filter((c) => !DIVISIONS.test(c.name));
  console.log(`\n         ${others.length} uden divisionsnavn — nyeste 15:`);
  for (const c of others.sort((a, b) => (b.season ?? 0) - (a.season ?? 0)).slice(0, 15)) {
    console.log(`           [${String(c.status).padEnd(9)}] ${c.name}`);
  }

  // Find en der FAKTISK har en stilling. Aflyste og tomme siger intet om
  // hvordan et rigtigt leaderboard ser ud.
  console.log('\n--- leder efter en division med en rigtig stilling ---');
  const candidates = divisions
    .filter((c) => c.status !== 'cancelled')
    .sort((a, b) => (b.season ?? 0) - (a.season ?? 0))
    .slice(0, 8);

  for (const c of candidates) {
    const { body } = await call(`/leaderboards/championships/${c.id}`, { limit: 5 });
    const defs = body?.items ?? [];
    if (defs.length === 0) {
      console.log(`         tom: ${c.name}`);
      continue;
    }

    console.log(`\n   >>> "${c.name}" har ${defs.length} leaderboard(s)`);
    const def = defs[0];
    console.log(`         ${def.leaderboard_id}`);
    console.log(`           navn=${def.leaderboard_name} gruppe=${def.group} `
      + `type=${def.ranking_type} status=${def.status}`);

    const board = await show('  leaderboards/{leaderboard_id}',
      `/leaderboards/${def.leaderboard_id}`, { limit: 5 });

    const rows = board?.items ?? [];
    if (rows[0]) {
      console.log(`         rækkefelter: ${Object.keys(rows[0]).join(', ')}`);
      const team = rows[0].team ?? rows[0].player ?? null;
      if (team) console.log(`         holdfelter: ${Object.keys(team).join(', ')}`);
    }
    for (const row of rows.slice(0, 5)) {
      const name = row.team?.name ?? row.player?.nickname ?? row.name ?? '?';
      console.log(`           #${row.position ?? '?'} ${name}  `
        + `W${row.won ?? '?'} L${row.lost ?? '?'} pts=${row.points ?? '?'}`);
    }

    const subs = await show('  championships/{id}/subscriptions',
      `/championships/${c.id}/subscriptions`, { limit: 3 });
    const sub = subs?.items?.[0];
    if (sub) {
      console.log(`         subscription-felter: ${Object.keys(sub).join(', ')}`);
      const team = sub.team ?? sub.roster ?? null;
      if (team) console.log(`         holdfelter: ${Object.keys(team).join(', ')}`);
    }

    break; // Én fuld kæde er nok til at bygge !esea på.
  }

  if (playerId) {
    console.log('\n--- spillerens hold ---');
    const teams = await show('players/{id}/teams', `/players/${playerId}/teams`, { limit: 20 });
    for (const team of teams?.items ?? []) {
      console.log(`           ${team.name}  ${team.team_id}`);
    }
    console.log('         (match disse team_id mod subscriptions ovenfor)');
  }

  console.log('\nFærdig. Send hele output\'et videre.');
}

run().catch((error) => {
  console.error(`probe fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
