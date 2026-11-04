import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCurrentSeason, toMillis, readEseaStanding, hasEseaPlace } from '../src/esea.js';
import { formatEsea } from '../src/format.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const day = 86_400_000;

test('toMillis tager sekunder, millisekunder og ISO', () => {
  const expected = Date.parse('2026-01-12T00:00:00Z');
  assert.equal(toMillis(expected / 1000), expected, 'sekunder skal skaleres op');
  assert.equal(toMillis(expected), expected, 'millisekunder skal stå uændret');
  assert.equal(toMillis('2026-01-12T00:00:00Z'), expected, 'ISO skal parses');
});

test('toMillis giver null for det der ikke er en tid', () => {
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(undefined), null);
  assert.equal(toMillis(''), null);
  assert.equal(toMillis('ikke en dato'), null);
});

test('pickCurrentSeason vælger den sæson der kører nu', () => {
  const league = {
    seasons: [
      { season_id: 's57', name: 'Season 57', start_date: NOW - 200 * day, end_date: NOW - 100 * day },
      { season_id: 's58', name: 'Season 58', start_date: NOW - 10 * day, end_date: NOW + 10 * day },
      { season_id: 's59', name: 'Season 59', start_date: NOW + 30 * day, end_date: NOW + 90 * day },
    ],
  };

  const season = pickCurrentSeason(league, NOW);
  assert.equal(season.seasonId, 's58');
  assert.equal(season.name, 'Season 58');
});

test('pickCurrentSeason foretrækker en åben sæson over en kommende', () => {
  // Rækkefølgen i svaret må ikke afgøre noget, så den kommende står først.
  const league = {
    seasons: [
      { season_id: 's59', name: 'Season 59', start_date: NOW + 30 * day, end_date: NOW + 90 * day },
      { season_id: 's58', name: 'Season 58', start_date: NOW - 10 * day, end_date: NOW + 10 * day },
    ],
  };

  assert.equal(pickCurrentSeason(league, NOW).seasonId, 's58');
});

test('pickCurrentSeason falder tilbage til seneste begyndte sæson mellem sæsoner', () => {
  // Ingen sæson er åben: bedre at vise "sidste sæson" end ingenting.
  const league = {
    seasons: [
      { season_id: 's57', name: 'Season 57', start_date: NOW - 300 * day, end_date: NOW - 200 * day },
      { season_id: 's58', name: 'Season 58', start_date: NOW - 100 * day, end_date: NOW - 10 * day },
      { season_id: 's59', name: 'Season 59', start_date: NOW + 30 * day, end_date: NOW + 90 * day },
    ],
  };

  assert.equal(pickCurrentSeason(league, NOW).seasonId, 's58');
});

test('pickCurrentSeason læser også id og tider under andre feltnavne', () => {
  const league = {
    seasons: [{ id: 's58', title: 'Season 58', start: '2026-10-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }],
  };

  const season = pickCurrentSeason(league, NOW);
  assert.equal(season.seasonId, 's58');
  assert.equal(season.name, 'Season 58');
});

test('pickCurrentSeason giver null når der ikke er noget at vælge', () => {
  assert.equal(pickCurrentSeason(null, NOW), null);
  assert.equal(pickCurrentSeason({}, NOW), null);
  assert.equal(pickCurrentSeason({ seasons: [] }, NOW), null);
  // En sæson uden id kan ikke bruges til et opslag.
  assert.equal(pickCurrentSeason({ seasons: [{ name: 'uden id' }] }, NOW), null);
});

test('readEseaStanding plukker division, hold og rekord ud', () => {
  const standing = readEseaStanding({
    division: { name: 'Advanced', group_name: 'Group C' },
    team: { name: 'Nordic Noobs' },
    placement: 4,
    wins: 7,
    losses: 3,
    points: 21,
  });

  assert.equal(standing.division, 'Advanced');
  assert.equal(standing.group, 'Group C');
  assert.equal(standing.teamName, 'Nordic Noobs');
  assert.equal(standing.placement, 4);
  assert.equal(standing.wins, 7);
  assert.equal(standing.losses, 3);
  assert.equal(standing.points, 21);
});

test('readEseaStanding læser også data nøstet under "player"', () => {
  const standing = readEseaStanding({
    player: {
      division_name: 'Main',
      team_name: 'Holdet',
      position: 2,
      wins: 5,
      losses: 1,
    },
  });

  assert.equal(standing.division, 'Main');
  assert.equal(standing.teamName, 'Holdet');
  assert.equal(standing.placement, 2);
});

test('readEseaStanding giver null-felter frem for nuller', () => {
  // "0-0" ville læses som "spillet og vundet ingenting", ikke "vi ved det ikke".
  const standing = readEseaStanding({});
  assert.equal(standing.wins, null);
  assert.equal(standing.losses, null);
  assert.equal(standing.placement, null);

  assert.equal(readEseaStanding(null), null);
});

test('hasEseaPlace skelner en tom sæson fra en rigtig plads', () => {
  assert.equal(hasEseaPlace(null), false);
  assert.equal(hasEseaPlace(readEseaStanding({})), false);
  assert.equal(hasEseaPlace(readEseaStanding({ division: { name: 'Open' } })), true);
  assert.equal(hasEseaPlace(readEseaStanding({ team: { name: 'Holdet' } })), true);
});

test('formatEsea samler division, hold, rekord og placering', () => {
  const message = formatEsea({
    nickname: 'PETSEN',
    season: 'Season 58',
    standing: {
      division: 'Advanced',
      group: 'Group C',
      teamName: 'Nordic Noobs',
      placement: 4,
      wins: 7,
      losses: 3,
    },
  });

  assert.ok(message.includes('ESEA Advanced Group C'), message);
  assert.ok(message.includes('Nordic Noobs 7-3'), message);
  assert.ok(message.includes('#4'), message);
});

test('formatEsea udelader rekorden når den ikke kendes', () => {
  const message = formatEsea({
    nickname: 'PETSEN',
    season: 'Season 58',
    standing: { division: 'Main', group: null, teamName: 'Holdet', placement: null, wins: null, losses: null },
  });

  assert.equal(message.includes('-'), false, `ingen rekord måtte vises: ${message}`);
  assert.ok(message.includes('Holdet'), message);
});

test('formatEsea siger det pænt når spilleren ikke er med', () => {
  assert.equal(
    formatEsea({ nickname: 'PETSEN', season: 'Season 58', standing: null }),
    'PETSEN er ikke på et ESEA-hold i denne sæson (Season 58)',
  );
});
