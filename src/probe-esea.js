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
  console.log(`         ${champs.length} championships under ESEA`);

  const seasons = [...new Set(champs.map((c) => c.season).filter(Number.isFinite))]
    .sort((a, b) => b - a);
  console.log(`         sæsoner: ${seasons.join(', ') || '(ingen i navnene)'}`);

  const newest = seasons[0] ?? null;
  const current = champs.filter((c) => c.season === newest);

  console.log(`\n         sæson ${newest} — ${current.length} divisioner:`);
  for (const c of current) {
    console.log(`           ${c.name}`);
    console.log(`             id=${c.id} region=${c.region} status=${c.status} grupper=${c.groups}`);
  }

  // Foretræk en der stadig kører — en afsluttet sæson har ingen levende stilling.
  const target = current.find((c) => c.status !== 'finished') ?? current[0];
  if (!target) {
    console.log('\nIngen championships at følge.');
    return;
  }

  console.log(`\n--- følger "${target.name}" ---`);

  const defs = await show('leaderboards/championships/{id}',
    `/leaderboards/championships/${target.id}`, { limit: 10 });

  for (const def of defs?.items ?? []) {
    console.log(`         ${def.leaderboard_id}`);
    console.log(`           navn=${def.leaderboard_name} gruppe=${def.group} `
      + `type=${def.ranking_type} status=${def.status}`);
  }

  // Her ligger selve stillingen — det !esea skal vise.
  const first = defs?.items?.[0];
  if (first?.leaderboard_id) {
    const board = await show('leaderboards/{leaderboard_id}',
      `/leaderboards/${first.leaderboard_id}`, { limit: 5 });

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
  }

  // Holdene i divisionen: her skal en spillers hold kunne findes.
  const subs = await show('championships/{id}/subscriptions',
    `/championships/${target.id}/subscriptions`, { limit: 3 });

  const sub = subs?.items?.[0];
  if (sub) {
    console.log(`         subscription-felter: ${Object.keys(sub).join(', ')}`);
    const team = sub.team ?? sub.roster ?? null;
    if (team) {
      console.log(`         holdfelter: ${Object.keys(team).join(', ')}`);
      const roster = team.roster ?? team.members ?? null;
      if (Array.isArray(roster) && roster[0]) {
        console.log(`         spillerfelter: ${Object.keys(roster[0]).join(', ')}`);
      }
    }
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
