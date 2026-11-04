/**
 * Finder den rigtige vej til ESEA-data i FACEIT's Data API — runde 2.
 *
 *   node src/probe-esea.js [nick]
 *
 * Første runde afviste det oplagte: `/leagues/{id}` giver 404 på begge UUID'er
 * fra den offentlige ESEA-URL. Men den gav også to spor:
 *
 *   1. `/leagues/{liga}/seasons/{sæson}` svarer 400, ikke 404. Et endpoint der
 *      ikke findes giver 404; 400 betyder at ruten findes og parametrene er
 *      forkerte. Sandsynligvis skal sæsonen være et TAL, ikke en UUID.
 *   2. `/championships?game=cs2` virker og returnerer navn, id og organizer_id.
 *      ESEA's divisioner er formentlig championships, og kan så findes på navn.
 *
 * Denne runde forfølger begge. Den skriver intet og ændrer ingenting.
 */
import { config, parsePlayerRef } from './config.js';
import { resolvePlayer } from './faceit.js';

const LEAGUE = 'a14b8616-45b9-4581-8637-4dfd0b5f6af8';

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

  const keys = Object.keys(body ?? {});
  const count = Array.isArray(body?.items) ? ` — ${body.items.length} items` : '';
  console.log(`[  OK  ] ${label}${count}`);
  console.log(`         nøgler: ${keys.join(', ')}`);
  return body;
}

/** Bladrer gennem alle cs2-championships og leder efter ESEA på navn. */
async function findEseaChampionships() {
  const found = [];
  const seenOrganizers = new Map();
  const PAGE = 50;

  for (let offset = 0; offset < 500; offset += PAGE) {
    const { status, body } = await call('/championships', {
      game: config.faceit.game,
      offset,
      limit: PAGE,
    });

    if (status !== 200) {
      console.log(`         (stoppede ved offset ${offset}: HTTP ${status})`);
      break;
    }

    const items = body?.items ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const name = String(item.name ?? '');
      if (item.organizer_id) {
        seenOrganizers.set(item.organizer_id, (seenOrganizers.get(item.organizer_id) ?? 0) + 1);
      }
      if (/esea/i.test(name)) {
        found.push({
          id: item.championship_id ?? item.id,
          name,
          region: item.region,
          status: item.status,
          type: item.type,
          organizer: item.organizer_id,
          url: item.faceit_url,
        });
      }
    }

    process.stdout.write(`\r         gennemsøgt ${offset + items.length} championships…`);
    if (items.length < PAGE) break;
  }

  process.stdout.write('\r');
  return { found, seenOrganizers };
}

async function run() {
  console.log(`base: ${config.faceit.baseUrl}\n`);

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

  // Spor 1: er sæsonen et tal?
  console.log('--- spor 1: sæson som tal i stedet for UUID ---');
  for (const season of [59, 58, 1]) {
    await show(`leagues/{liga}/seasons/${season}`, `/leagues/${LEAGUE}/seasons/${season}`);
  }
  // Måske er liga-id'et slet ikke en UUID.
  for (const league of ['esea', 'ESEA', 'esea-league']) {
    await show(`leagues/${league}`, `/leagues/${encodeURIComponent(league)}`);
  }

  // Spor 2: find ESEA blandt alle cs2-championships.
  console.log('\n--- spor 2: ESEA blandt cs2-championships ---');
  const { found, seenOrganizers } = await findEseaChampionships();

  if (found.length === 0) {
    console.log('         ingen championships med "esea" i navnet');
    const top = [...seenOrganizers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length > 0) {
      console.log('         hyppigste organizer_id (til et opslag i browseren):');
      for (const [id, count] of top) console.log(`           ${id} — ${count} championships`);
    }
  } else {
    console.log(`         ${found.length} fundet:`);
    for (const item of found.slice(0, 12)) {
      console.log(`           ${item.name}`);
      console.log(`             id=${item.id} region=${item.region} status=${item.status}`);
    }

    // Virker en af dem, har vi vejen.
    const first = found[0];
    console.log(`\n--- spor 3: prøver "${first.name}" ---`);
    await show('championships/{id}', `/championships/${first.id}`);
    const board = await show('leaderboards/championships/{id}',
      `/leaderboards/championships/${first.id}`, { limit: 5 });

    if (Array.isArray(board?.items) && board.items[0]) {
      console.log(`         items[0]: ${Object.keys(board.items[0]).join(', ')}`);
    }

    if (first.organizer) {
      await show('organizers/{id}', `/organizers/${first.organizer}`);
      await show('organizers/{id}/championships',
        `/organizers/${first.organizer}/championships`, { limit: 5 });
    }
  }

  if (playerId) {
    console.log('\n--- spor 4: spillerens egne hold og turneringer ---');
    await show('players/{id}/teams', `/players/${playerId}/teams`);
    await show('players/{id}/tournaments', `/players/${playerId}/tournaments`);
    await show('players/{id}/hubs', `/players/${playerId}/hubs`, { limit: 5 });
  }

  console.log('\nFærdig. Send hele output\'et videre.');
}

run().catch((error) => {
  console.error(`probe fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
