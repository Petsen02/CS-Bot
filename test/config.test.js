import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerRef, normalizeCountry, normalizeRegion, REGIONS } from '../src/config.js';

test('parsePlayerRef genkender et SteamID64', () => {
  assert.deepEqual(parsePlayerRef('76561198000000000'), {
    kind: 'steam',
    value: '76561198000000000',
  });
});

test('parsePlayerRef trækker SteamID64 ud af et profillink', () => {
  assert.deepEqual(
    parsePlayerRef('https://steamcommunity.com/profiles/76561198000000000/'),
    { kind: 'steam', value: '76561198000000000' },
  );
});

test('parsePlayerRef afviser vanity-links frem for at gætte', () => {
  // Et vanity-navn kan ikke oversættes uden Steam Web API, og at slå det op
  // som et FACEIT-nick ville ramme en tilfældig anden spiller.
  assert.equal(parsePlayerRef('https://steamcommunity.com/id/petsen'), null);
});

test('parsePlayerRef trækker nick ud af et FACEIT-link', () => {
  assert.deepEqual(parsePlayerRef('https://www.faceit.com/en/players/PETSEN'), {
    kind: 'nickname',
    value: 'PETSEN',
  });
});

test('parsePlayerRef tager et almindeligt nick', () => {
  assert.deepEqual(parsePlayerRef('PETSEN'), { kind: 'nickname', value: 'PETSEN' });
});

test('parsePlayerRef afviser tomt input og mellemrum', () => {
  assert.equal(parsePlayerRef(''), null);
  assert.equal(parsePlayerRef('   '), null);
  assert.equal(parsePlayerRef(null), null);
  // FACEIT-nicks har ikke mellemrum, så det er en skrivefejl.
  assert.equal(parsePlayerRef('Navn Efternavn'), null);
});

test('parsePlayerRef afviser et tal der ikke er et SteamID64', () => {
  assert.deepEqual(parsePlayerRef('12345'), { kind: 'nickname', value: '12345' });
});

test('normalizeCountry kræver to bogstaver', () => {
  assert.equal(normalizeCountry('dk'), 'DK');
  assert.equal(normalizeCountry(' se '), 'SE');
  assert.equal(normalizeCountry('DNK'), null);
  assert.equal(normalizeCountry('D1'), null);
  assert.equal(normalizeCountry(''), null);
});

test('normalizeRegion versaliserer, og de ventede regioner findes', () => {
  assert.equal(normalizeRegion('eu'), 'EU');
  for (const region of ['EU', 'NA', 'SA', 'AS', 'OCE']) {
    assert.ok(REGIONS.has(region), `${region} skal være en gyldig region`);
  }
});
