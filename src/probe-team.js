/**
 * Finder hvilken ESEA-sæson et hold faktisk spiller i.
 *
 *   node src/probe-team.js <team-id eller faceit.com/teams/...-link>
 *
 * !esea leder i den nyeste sæson der matcher navnemønsteret
 * "ESEA League EU Advanced S55 Qualifier". Men af de 543 championships under
 * ESEA-organizeren har 460 ingen sæson i navnet, og den igangværende sæson er
 * ikke blandt de 59 der matcher. Den hedder altså noget andet.
 *
 * Denne sonde går den modsatte vej: fra holdet til dets turneringer, og viser
 * samtidig de ESEA-navne der IKKE matcher mønsteret, så den rigtige form kan
 * læses af frem for gættes.
 */
import { config } from './config.js';
import { ESEA_ORGANIZER, parseDivisionName } from './esea.js';

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

function teamIdFrom(input) {
  const raw = String(input ?? '').trim();
  const link = raw.match(/teams\/([0-9a-f-]{36})/i);
  return link ? link[1] : raw;
}

async function run() {
  const teamId = teamIdFrom(process.argv[2]);
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
    console.error('Brug: node src/probe-team.js <team-id eller faceit.com/teams/...-link>');
    process.exitCode = 2;
    return;
  }

  console.log(`hold: ${teamId}\n`);

  console.log('--- holdet selv ---');
  const team = await show('teams/{id}', `/teams/${teamId}`);
  if (team) {
    console.log(`         navn: ${team.name ?? '?'}`);
    console.log(`         nøgler: ${Object.keys(team).join(', ')}`);
    const roster = team.members ?? team.roster ?? [];
    if (roster[0]) console.log(`         spillerfelter: ${Object.keys(roster[0]).join(', ')}`);
  }

  console.log('\n--- holdets turneringer ---');
  for (const [label, path] of [
    ['teams/{id}/tournaments', `/teams/${teamId}/tournaments`],
    ['teams/{id}/championships', `/teams/${teamId}/championships`],
    ['teams/{id}/leagues', `/teams/${teamId}/leagues`],
  ]) {
    const body = await show(label, path, { limit: 20 });
    for (const item of body?.items ?? []) {
      const name = item.name ?? item.competition_name ?? '(uden navn)';
      const id = item.competition_id ?? item.championship_id ?? item.tournament_id ?? item.id ?? '';
      console.log(`           ${name}  ${id}`);
    }
  }

  console.log('\n--- ESEA-navne der IKKE matcher mønsteret ---');
  console.log('    (her gemmer den igangværende sæson sig formentlig)');

  const all = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const { status, body } = await call(`/organizers/${ESEA_ORGANIZER}/championships`,
      { offset, limit: 50 });
    if (status !== 200) break;
    const items = body?.items ?? [];
    all.push(...items);
    if (items.length < 50) break;
  }

  const unmatched = all.filter((item) => !parseDivisionName(item.name));

  // Dem der ikke er afsluttet er langt de mest interessante: en igangværende
  // sæson har en status der ikke er "finished".
  const live = unmatched.filter((item) => item.status && item.status !== 'finished');
  console.log(`\n         ${all.length} i alt, ${unmatched.length} uden for mønsteret, `
    + `${live.length} ikke afsluttede:`);
  for (const item of live.slice(0, 40)) {
    console.log(`           [${String(item.status).padEnd(10)}] ${item.name}`);
    console.log(`             id=${item.championship_id ?? item.id} region=${item.region ?? '?'}`);
  }

  // Og alt der nævner en sæson over 55, uanset status.
  const newer = unmatched.filter((item) => {
    const n = Number(String(item.name ?? '').match(/\bS(?:eason\s*)?(\d{2})\b/i)?.[1]);
    return Number.isFinite(n) && n > 55;
  });
  if (newer.length) {
    console.log(`\n         ${newer.length} der nævner en sæson over 55:`);
    for (const item of newer.slice(0, 30)) {
      console.log(`           [${String(item.status).padEnd(10)}] ${item.name}`);
      console.log(`             id=${item.championship_id ?? item.id} region=${item.region ?? '?'}`);
    }
  }

  console.log('\nFærdig. Send hele output\'et videre.');
}

run().catch((error) => {
  console.error(`probe fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
