import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDivisionName, pickSeason, readStandings } from '../src/esea.js';
import { formatEsea } from '../src/format.js';

/**
 * Strukturen herunder er MÅLT mod det rigtige API, ikke antaget. ESEA er en
 * organizer, divisionerne er championships, og region, division og sæson står
 * kun i navnet.
 */

test('parseDivisionName læser region, division og sæson ud af navnet', () => {
  assert.deepEqual(parseDivisionName('ESEA League EU Advanced S55 Qualifier'), {
    region: 'EU',
    division: 'Advanced',
    season: 55,
  });

  assert.deepEqual(parseDivisionName('ESEA League NA Entry S53 Qualifier'), {
    region: 'NA',
    division: 'Entry',
    season: 53,
  });
});

test('parseDivisionName normaliserer skrivemåden', () => {
  const parsed = parseDivisionName('esea league eu MAIN s49 qualifier');
  assert.equal(parsed.region, 'EU');
  assert.equal(parsed.division, 'Main');
  assert.equal(parsed.season, 49);
});

test('parseDivisionName afviser alt der ikke er en ligadivision', () => {
  // Blandt de 543 championships under ESEA er 402 ikke divisioner. At tage
  // dem med ramte "S58 OCE Finals Central" — aflyst, uden hold og stilling.
  for (const name of [
    'S58 OCE Finals Central - Finals',
    'ESEA ECL S47 EU Relegation - Stage 1',
    'ESL Impact S5 AS Wildcard Qualifier',
    'ESEA League EU Advanced Qualifier',
    '',
    null,
  ]) {
    assert.equal(parseDivisionName(name), null, `"${name}" er ikke en division`);
  }
});

const champs = [
  { id: 'a', region: 'EU', division: 'Advanced', season: 55 },
  { id: 'b', region: 'EU', division: 'Main', season: 55 },
  { id: 'c', region: 'EU', division: 'Advanced', season: 54 },
  { id: 'd', region: 'NA', division: 'Advanced', season: 56 },
];

test('pickSeason tager nyeste sæson der har divisioner i regionen', () => {
  const eu = pickSeason(champs, 'EU');
  assert.equal(eu.season, 55);
  assert.deepEqual(eu.divisions.map((d) => d.division).sort(), ['Advanced', 'Main']);

  // NA er nået længere; regionerne må ikke smitte af på hinanden.
  assert.equal(pickSeason(champs, 'NA').season, 56);
});

test('pickSeason tåler små bogstaver og en ukendt region', () => {
  assert.equal(pickSeason(champs, 'eu').season, 55);
  assert.equal(pickSeason(champs, 'OCE'), null);
  assert.equal(pickSeason([], 'EU'), null);
});

test('readStandings udleder placeringen af rækkefølgen', () => {
  // MÅLT: position er 0 på hver eneste række, også på føreren med 24 point.
  // Feltet er ubrugt, så det må ikke læses.
  const rows = [
    { player: { user_id: 't2', nickname: 'G2 Ares' }, played: 8, won: 7, lost: 1, points: 21, position: 0 },
    { player: { user_id: 't1', nickname: 'SPARTA' }, played: 8, won: 8, lost: 0, points: 24, position: 0 },
    { player: { user_id: 't3', nickname: 'GGDROP' }, played: 7, won: 6, lost: 1, points: 18, position: 0 },
  ];

  const standings = readStandings(rows);

  assert.deepEqual(standings.map((s) => s.teamName), ['SPARTA', 'G2 Ares', 'GGDROP']);
  assert.deepEqual(standings.map((s) => s.rank), [1, 2, 3]);
  assert.equal(standings[0].teamId, 't1');
  assert.equal(standings[0].won, 8);
  assert.equal(standings[0].points, 24);
});

test('readStandings sorterer selv frem for at stole på rækkefølgen', () => {
  const standings = readStandings([
    { player: { user_id: 'a', nickname: 'Sidst' }, points: 3 },
    { player: { user_id: 'b', nickname: 'Først' }, points: 30 },
  ]);

  assert.equal(standings[0].teamName, 'Først');
  assert.equal(standings[0].rank, 1);
});

test('readStandings tåler tomme og uventede svar', () => {
  assert.deepEqual(readStandings(null), []);
  assert.deepEqual(readStandings([]), []);

  const [row] = readStandings([{}]);
  assert.equal(row.teamId, null);
  assert.equal(row.teamName, null);
  assert.equal(row.won, null, 'manglende tal skal være null, ikke 0');
});

test('formatEsea samler division, hold, rekord og placering', () => {
  const message = formatEsea({
    nickname: 'vigg0',
    season: 55,
    region: 'EU',
    standing: {
      season: 55,
      division: 'Advanced',
      teamName: 'SPARTA',
      won: 8,
      lost: 0,
      rank: 1,
      total: 16,
      points: 24,
    },
  });

  assert.equal(message, 'vigg0 │ ESEA S55 Advanced │ SPARTA 8-0 │ #1 af 16 │ 24 pts');
});

test('formatEsea udelader rekorden når den ikke kendes', () => {
  const message = formatEsea({
    nickname: 'vigg0',
    season: 55,
    region: 'EU',
    standing: { season: 55, division: 'Main', teamName: 'Holdet', won: null, lost: null, rank: 4 },
  });

  assert.ok(message.includes('Holdet'), message);
  assert.ok(!/\d+-\d+/.test(message), `ingen rekord måtte vises: ${message}`);
});

test('formatEsea siger det pænt når spilleren ikke er med', () => {
  assert.equal(
    formatEsea({ nickname: 'vigg0', season: 55, region: 'EU', standing: null }),
    'vigg0 er ikke på et ESEA-hold i denne sæson (S55 EU)',
  );
});
