/**
 * Viser hvad FACEIT svarer om ESEA, opdelt på `type`-parameteren.
 *
 *   node src/probe-esea.js
 *
 * !esea finder ingen igangværende sæson og falder tilbage til en afsluttet.
 * Mistanken: `/organizers/{id}/championships` returnerer som standard kun
 * afsluttede turneringer, og den kørende sæson ligger bag `type=ongoing`
 * eller `type=all`.
 *
 * Denne sonde henter hver variant og stiller dem op ved siden af hinanden, så
 * forskellen kan ses frem for gættes. Den skriver intet og ændrer ingenting.
 */
import { config } from './config.js';
import { ESEA_ORGANIZER } from './esea.js';

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
    if (!response.ok) return { status: response.status, items: null };
    const body = await response.json();
    return { status: response.status, items: body?.items ?? [] };
  } catch (error) {
    return { status: 0, items: null, error: error.message };
  }
}

/** Henter alle sider for én type. */
async function fetchAll(path, type) {
  const all = [];

  for (let offset = 0; offset < 1000; offset += 50) {
    const params = { offset, limit: 50 };
    if (type) params.type = type;

    const { status, items, error } = await call(path, params);
    if (status !== 200) {
      return { status, error, items: all, stoppedAt: offset };
    }

    all.push(...items);
    if (items.length < 50) break;
  }

  return { status: 200, items: all };
}

const DEAD = new Set(['finished', 'cancelled', 'canceled', 'aborted']);

function summarise(label, result) {
  if (result.status !== 200) {
    console.log(`[ ${String(result.status || 'net').padStart(4)} ] ${label}`
      + `${result.error ? ` — ${result.error}` : ''}`);
    return [];
  }

  const items = result.items ?? [];
  const live = items.filter((i) => !DEAD.has(String(i.status ?? '').toLowerCase()));
  const seasons = [...new Set(items
    .map((i) => Number(String(i.name ?? '').match(/\bS(?:eason\s*)?(\d{1,2})\b/i)?.[1]))
    .filter(Number.isFinite))].sort((a, b) => b - a);

  console.log(`[  OK  ] ${label}`);
  console.log(`         ${items.length} turneringer, ${live.length} ikke afsluttede`);
  console.log(`         sæsoner i navnene: ${seasons.slice(0, 10).join(', ') || '(ingen)'}`);

  for (const item of live.slice(0, 12)) {
    console.log(`           [${String(item.status).padEnd(10)}] ${item.name}`);
    console.log(`             id=${item.championship_id ?? item.id} region=${item.region ?? '?'}`);
  }

  return items;
}

async function run() {
  console.log(`ESEA organizer: ${ESEA_ORGANIZER}\n`);

  const path = `/organizers/${ESEA_ORGANIZER}/championships`;
  const byType = new Map();

  console.log('--- organizers/{esea}/championships, pr. type ---\n');
  for (const type of [null, 'all', 'ongoing', 'upcoming', 'past']) {
    const label = type ? `type=${type}` : 'uden type (som botten gør nu)';
    const result = await fetchAll(path, type);
    byType.set(type ?? 'ingen', summarise(label, result));
    console.log('');
  }

  // Hvad fanger én variant, som den nuværende ikke gør?
  const current = new Set((byType.get('ingen') ?? []).map((i) => i.championship_id ?? i.id));
  console.log('--- hvad botten går glip af i dag ---');

  let foundExtra = false;
  for (const [type, items] of byType) {
    if (type === 'ingen' || !items?.length) continue;

    const extra = items.filter((i) => !current.has(i.championship_id ?? i.id));
    if (extra.length === 0) continue;

    foundExtra = true;
    console.log(`\n         type=${type} giver ${extra.length} som den nuværende ikke ser:`);
    for (const item of extra.slice(0, 20)) {
      console.log(`           [${String(item.status).padEnd(10)}] ${item.name}`);
      console.log(`             id=${item.championship_id ?? item.id} region=${item.region ?? '?'}`);
    }
  }

  if (!foundExtra) {
    console.log('         ingen — alle varianter giver det samme.');
    console.log('         Så ligger den kørende sæson ikke under denne organizer,');
    console.log('         og vejen går gennem holdet: npm run probe-team <team-id>');
  }

  console.log('\nFærdig. Send hele output\'et videre.');
}

run().catch((error) => {
  console.error(`probe fejlede: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
