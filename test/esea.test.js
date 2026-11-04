import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDivisionName, pickCompetitions, readStandings, toMillis } from '../src/esea.js';
import { formatEsea } from '../src/format.js';

/**
 * Udvælgelsen bygger på status og datoer, ikke på navne. Første version
 * filtrerede på navnemønsteret og fandt kun 59 af ESEA's 543 championships —
 * og den sæson der faktisk kørte var ikke blandt dem.
 */

test('parseDivisionName læser etiketten når navnet følger mønsteret', () => {
  assert.deepEqual(parseDivisionName('ESEA League EU Advanced S55 Qualifier'), {
    region: 'EU',
    division: 'Advanced',
    season: 55,
  });
  assert.equal(parseDivisionName('esea league eu MAIN s49 qualifier').division, 'Main');
});

test('parseDivisionName giver null for alt andet — og det er nu harmløst', () => {
  // Navnet bestemmer ikke længere om turneringen kommer i betragtning.
  for (const name of ['S58 OCE Finals Central - Finals', 'ESEA ECL S47 EU Relegation', '', null]) {
    assert.equal(parseDivisionName(name), null);
  }
});

test('toMillis tager sekunder, millisekunder og ISO', () => {
  const expected = Date.parse('2026-01-12T00:00:00Z');
  assert.equal(toMillis(expected / 1000), expected);
  assert.equal(toMillis(expected), expected);
  assert.equal(toMillis('2026-01-12T00:00:00Z'), expected);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis('ikke en dato'), null);
});

const day = 86_400_000;
const now = Date.parse('2026-11-04T12:00:00Z');

const pool = [
  { id: 'gammel-eu', name: 'ESEA League EU Advanced S55 Qualifier', status: 'finished', region: 'EU', startedAt: now - 200 * day, division: 'Advanced', season: 55 },
  { id: 'live-eu', name: 'ESEA League Season 59 EU Advanced', status: 'ongoing', region: 'EU', startedAt: now - 10 * day, division: null, season: null },
  { id: 'live-na', name: 'ESEA League Season 59 NA Advanced', status: 'ongoing', region: 'NA', startedAt: now - 10 * day, division: null, season: null },
  { id: 'cup-eu', name: 'Cash Cup 14', status: 'join', region: 'EU', startedAt: now - 1 * day, division: null, season: null },
  { id: 'nyere-finished', name: 'ESEA League EU Main S55 Qualifier', status: 'finished', region: 'EU', startedAt: now - 100 * day, division: 'Main', season: 55 },
];

test('pickCompetitions tager igangværende i regionen først', () => {
  const order = pickCompetitions(pool, 'EU').map((c) => c.id);

  // Den kørende sæson i EU skal stå før alt afsluttet — også før en division
  // hvis navn matcher mønsteret. Det var præcis fejlen: S55 vandt over S59.
  assert.ok(order.indexOf('live-eu') < order.indexOf('gammel-eu'), order.join(', '));
  assert.ok(order.indexOf('live-eu') < order.indexOf('nyere-finished'), order.join(', '));
  assert.ok(order.indexOf('cup-eu') < order.indexOf('gammel-eu'), 'levende slår afsluttet');
});

test('pickCompetitions sætter egen region før andre regioner', () => {
  const order = pickCompetitions(pool, 'EU').map((c) => c.id);
  assert.ok(order.indexOf('live-eu') < order.indexOf('live-na'), order.join(', '));

  const na = pickCompetitions(pool, 'NA').map((c) => c.id);
  assert.ok(na.indexOf('live-na') < na.indexOf('live-eu'), na.join(', '));
});

test('pickCompetitions sorterer afsluttede nyeste først', () => {
  const order = pickCompetitions(pool, 'EU').map((c) => c.id);
  // nyere-finished startede 100 dage siden, gammel-eu 200.
  assert.ok(order.indexOf('nyere-finished') < order.indexOf('gammel-eu'), order.join(', '));
});

test('pickCompetitions beholder alt, men begrænser antallet', () => {
  // Hver kandidat koster to API-kald, så listen skal have en øvre grænse.
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`, name: `Cup ${i}`, status: 'ongoing', region: 'EU', startedAt: now - i * day,
    division: null, season: null,
  }));

  assert.equal(pickCompetitions(many, 'EU').length, 14);
  assert.equal(pickCompetitions(many, 'EU', 3).length, 3);
  assert.deepEqual(pickCompetitions([], 'EU'), []);
});

test('readStandings udleder placeringen af rækkefølgen', () => {
  // MÅLT: position er 0 på hver eneste række, også på føreren.
  const standings = readStandings([
    { player: { user_id: 't2', nickname: 'G2 Ares' }, won: 7, lost: 1, points: 21, position: 0 },
    { player: { user_id: 't1', nickname: 'SPARTA' }, won: 8, lost: 0, points: 24, position: 0 },
  ]);

  assert.deepEqual(standings.map((s) => s.teamName), ['SPARTA', 'G2 Ares']);
  assert.deepEqual(standings.map((s) => s.rank), [1, 2]);
  assert.equal(standings[0].teamId, 't1');
});

test('readStandings tåler tomme og uventede svar', () => {
  assert.deepEqual(readStandings(null), []);
  const [row] = readStandings([{}]);
  assert.equal(row.won, null, 'manglende tal skal være null, ikke 0');
});

test('formatEsea bruger sæson og division når navnet kunne læses', () => {
  const message = formatEsea({
    nickname: 'vigg0',
    region: 'EU',
    standing: {
      season: 55, division: 'Advanced', teamName: 'SPARTA',
      won: 8, lost: 0, rank: 1, total: 16, points: 24, live: true,
    },
  });

  assert.equal(message, 'vigg0 │ ESEA S55 Advanced │ SPARTA 8-0 │ #1 af 16 │ 24 pts');
});

test('formatEsea falder tilbage til turneringens navn', () => {
  // Den kørende sæson hedder ikke altid noget mønsteret kan læse.
  const message = formatEsea({
    nickname: 'vigg0',
    region: 'EU',
    standing: {
      season: null, division: null, competition: 'ESEA League Season 59 EU Advanced',
      teamName: 'Elitemilijoet', won: 3, lost: 1, rank: 4, total: 12, live: true,
    },
  });

  assert.ok(message.includes('ESEA League Season 59 EU Advanced'), message);
  assert.ok(message.includes('Elitemilijoet 3-1'), message);
  assert.ok(message.includes('#4 af 12'), message);
});

test('formatEsea markerer en afsluttet sæson som historik', () => {
  const message = formatEsea({
    nickname: 'vigg0',
    region: 'EU',
    standing: { season: 55, division: 'Main', teamName: 'Holdet', won: 5, lost: 2, rank: 3, live: false },
  });

  assert.ok(message.endsWith('afsluttet'), message);
});

test('formatEsea siger det pænt når holdet ikke blev fundet', () => {
  assert.equal(
    formatEsea({ nickname: 'vigg0', region: 'EU', standing: null }),
    'vigg0 er ikke på et ESEA-hold i EU lige nu',
  );
});

test('parseTeamId tager både et rå id og et FACEIT-link', async () => {
  const { parseTeamId } = await import('../src/esea.js');

  const id = '429cd873-24a8-4029-aa34-85622ba8976a';
  assert.equal(parseTeamId(id), id);
  assert.equal(parseTeamId(`https://www.faceit.com/en/teams/${id}`), id);
  assert.equal(parseTeamId(`  ${id}  `), id);
});

test('parseTeamId afviser alt der ikke er et id', async () => {
  const { parseTeamId } = await import('../src/esea.js');

  // Et nick er ikke et hold-id, og må ikke sendes videre som ét.
  assert.equal(parseTeamId('vigg0'), null);
  assert.equal(parseTeamId('429cd873'), null, 'for kort');
  assert.equal(parseTeamId(''), null);
  assert.equal(parseTeamId(null), null);
});

/**
 * ESEA navngiver ikke konsekvent. Begge disse er set i praksis, og det var et
 * strikt mønster der gjorde at den kørende sæson aldrig blev genkendt.
 */
test('parseCompetitionName læser begge navneformer', async () => {
  const { parseCompetitionName } = await import('../src/esea.js');

  // Den kørende sæson, fra en rigtig kamp i historikken.
  assert.deepEqual(parseCompetitionName('S59 EU Main B - Regular Season'), {
    season: 59,
    region: 'EU',
    division: 'Main',
  });

  // Historikken under organizeren — helt anden rækkefølge.
  assert.deepEqual(parseCompetitionName('ESEA League EU Advanced S55 Qualifier'), {
    season: 55,
    region: 'EU',
    division: 'Advanced',
  });
});

test('parseCompetitionName giver null for det den ikke finder', async () => {
  const { parseCompetitionName } = await import('../src/esea.js');

  // En finale har sæson og region, men ingen division.
  assert.deepEqual(parseCompetitionName('S58 OCE Finals Central - Finals'), {
    season: 58,
    region: 'OCE',
    division: null,
  });

  assert.deepEqual(parseCompetitionName('Europe 5v5 Queue'), {
    season: null,
    region: null,
    division: null,
  });

  assert.deepEqual(parseCompetitionName(''), { season: null, region: null, division: null });
});

test('parseDivisionName kræver stadig en division', async () => {
  const { parseDivisionName } = await import('../src/esea.js');

  assert.equal(parseDivisionName('S59 EU Main B - Regular Season').division, 'Main');
  assert.equal(parseDivisionName('S58 OCE Finals Central - Finals'), null);
  assert.equal(parseDivisionName('Europe 5v5 Queue'), null);
});

test('readStandings bruger sejre som skillelinje ved lige point', async () => {
  // Med 76 hold i en division ligger mange på samme pointtal. Uden en
  // skillelinje ville rækkefølgen mellem dem skifte fra opslag til opslag.
  const standings = readStandings([
    { player: { user_id: 'c', nickname: 'Cee' }, won: 4, lost: 5, points: 15 },
    { player: { user_id: 'a', nickname: 'Aaa' }, won: 5, lost: 4, points: 15 },
    { player: { user_id: 'b', nickname: 'Bee' }, won: 5, lost: 2, points: 15 },
  ]);

  // Flest sejre først; ved lige mange, bedste sejre-minus-nederlag.
  assert.deepEqual(standings.map((s) => s.teamName), ['Bee', 'Aaa', 'Cee']);
});

test('readStandings giver samme rækkefølge hver gang', async () => {
  // Helt ens hold skal stadig sorteres forudsigeligt, ellers hopper
  // placeringen mellem to opslag af den samme stilling.
  const rows = [
    { player: { user_id: '2', nickname: 'Zulu' }, won: 3, lost: 3, points: 9 },
    { player: { user_id: '1', nickname: 'Alfa' }, won: 3, lost: 3, points: 9 },
  ];

  assert.deepEqual(readStandings(rows).map((s) => s.rank), [1, 2]);
  assert.deepEqual(readStandings([...rows].reverse()).map((s) => s.teamName), ['Alfa', 'Zulu']);
  assert.deepEqual(readStandings(rows).map((s) => s.teamName), ['Alfa', 'Zulu']);
});
