/**
 * Finder den rigtige vej til ESEA-data i FACEIT's Data API.
 *
 *   node src/probe-esea.js [nick]
 *
 * Antagelsen om at `/leagues/{league_id}` svarer på ESEA's liga-id fra den
 * offentlige URL viste sig forkert — den giver 404. Denne fil prøver de
 * plausible alternativer af og viser hvad hvert enkelt svarer, så gætteriet
 * kan erstattes af en måling.
 *
 * Den skriver intet og ændrer ingenting. Send output'et videre, så kan
 * src/esea.js rettes til det der faktisk virker.
 */
import { config, parsePlayerRef } from './config.js';
import { resolvePlayer } from './faceit.js';

// Fra den offentlige liga-URL:
// faceit.com/en/cs2/league/esea%20league/<LEAGUE>/<SEASON>/overview
const LEAGUE = 'a14b8616-45b9-4581-8637-4dfd0b5f6af8';
const SEASON = 'ec187700-30e2-4245-b5e2-daa762db12fc';

async function probe(label, path, params = {}) {
  const url = new URL(`${config.faceit.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.faceit.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.log(`[ net  ] ${label}\n         ${error.message}`);
    return null;
  }

  if (!response.ok) {
    console.log(`[ ${String(response.status).padStart(4)} ] ${label}`);
    console.log(`         ${path}${url.search}`);
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    console.log(`[  ok  ] ${label} — svarede, men ikke med JSON`);
    return null;
  }

  console.log(`[  OK  ] ${label}`);
  console.log(`         ${path}${url.search}`);
  console.log(`         nøgler: ${Object.keys(body ?? {}).join(', ') || '(tomt objekt)'}`);

  // Sæsonlister er det !esea er afhængig af, så de vises hvis de er der.
  for (const key of ['seasons', 'items', 'divisions', 'payload']) {
    const value = body?.[key];
    if (Array.isArray(value) && value.length > 0) {
      console.log(`         ${key}[0]: ${Object.keys(value[0]).join(', ')}`);
    }
  }

  // Luk pænt ned om det er en liga med sæsoner — så har vi fundet vejen.
  return body;
}

async function run() {
  console.log(`base: ${config.faceit.baseUrl}`);
  console.log(`liga fra URL:   ${LEAGUE}`);
  console.log(`sæson fra URL:  ${SEASON}\n`);

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

  console.log('--- liga-endpoints ---');
  await probe('leagues/{liga}', `/leagues/${LEAGUE}`);
  await probe('leagues/{sæson-id som liga}', `/leagues/${SEASON}`);
  await probe('leagues/{liga}/seasons/{sæson}', `/leagues/${LEAGUE}/seasons/${SEASON}`);

  console.log('\n--- championship-endpoints ---');
  await probe('championships/{liga}', `/championships/${LEAGUE}`);
  await probe('championships/{sæson}', `/championships/${SEASON}`);
  await probe('championships for cs2', '/championships', { game: config.faceit.game, limit: 5 });

  console.log('\n--- leaderboards ---');
  await probe('leaderboards/championships/{sæson}',
    `/leaderboards/championships/${SEASON}`, { limit: 3 });
  await probe('leaderboards/championships/{sæson}/groups/1',
    `/leaderboards/championships/${SEASON}/groups/1`, { limit: 3 });

  if (playerId) {
    console.log('\n--- spillerens plads ---');
    await probe('leagues/{liga}/seasons/{sæson}/players/{spiller}',
      `/leagues/${LEAGUE}/seasons/${SEASON}/players/${playerId}`);
    await probe('players/{spiller}/games/cs2/stats', `/players/${playerId}/games/${config.faceit.game}/stats`);
  }

  console.log('\nFærdig. Linjer med [  OK  ] er dem der svarede.');
  console.log('Svarede ingen, findes ESEA ikke i Data API\'et, og !esea kan ikke');
  console.log('bygges officielt — så er beslutningen om den skal udgå eller hente');
  console.log('fra FACEIT\'s interne web-API.');
}

run().catch((error) => {
  console.error(`probe fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
