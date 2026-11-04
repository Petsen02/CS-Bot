import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlayerRef,
  normalizeCountry,
  normalizeRegion,
  sanitizeArgument,
  REGIONS,
} from '../src/config.js';

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

/**
 * MÅLT i en rigtig Twitch-chat: klienter hænger usynlige tegn på beskeder for
 * at omgå dublet-filteret. "!rank Petsen" ankom som "!rank Petsen ␀", og
 * argumentet blev afvist som ugyldigt navn — eller, når tegnet sad klistret på
 * navnet, sendt med ind i opslaget og gav 404.
 */
test('sanitizeArgument fjerner Twitch-klienters usynlige tegn', () => {
  // Begge disse er set i en rigtig chat.
  assert.equal(sanitizeArgument('petsen \u034F'), 'petsen', 'combining grapheme joiner');
  assert.equal(sanitizeArgument('petsen\u034F'), 'petsen');

  // U+E0000 er det tag-tegn Twitch bruger til dublet-omgåelse.
  assert.equal(sanitizeArgument('Petsen \u{E0000}'), 'Petsen');
  assert.equal(sanitizeArgument('Petsen\u{E0000}'), 'Petsen');
  assert.equal(sanitizeArgument('Petsen​'), 'Petsen', 'zero-width space');
  assert.equal(sanitizeArgument('Petsen﻿'), 'Petsen', 'BOM');
  assert.equal(sanitizeArgument('‎Petsen'), 'Petsen', 'retningsmarkør');
});

test('sanitizeArgument fjerner et indledende @', () => {
  // Seere skriver "!rank @Petsen" af vane.
  assert.equal(sanitizeArgument('@Petsen'), 'Petsen');
  assert.equal(sanitizeArgument('@@Petsen'), 'Petsen');
  assert.equal(sanitizeArgument('@Petsen \u{E0000}'), 'Petsen');
});

test('sanitizeArgument lader et rigtigt navn være i fred', () => {
  assert.equal(sanitizeArgument('Petsen'), 'Petsen');
  assert.equal(sanitizeArgument('vigg0'), 'vigg0');
  assert.equal(sanitizeArgument('76561198847373934'), '76561198847373934');
  // Bindestreger og understreger er gyldige i FACEIT-nicks.
  assert.equal(sanitizeArgument('-_-_-_-_-_-'), '-_-_-_-_-_-');
  assert.equal(sanitizeArgument(''), '');
  assert.equal(sanitizeArgument(null), '');
});

test('parsePlayerRef renser før den tolker', () => {
  assert.deepEqual(parsePlayerRef('Petsen \u{E0000}'), { kind: 'nickname', value: 'Petsen' });
  assert.deepEqual(parsePlayerRef('@Petsen'), { kind: 'nickname', value: 'Petsen' });
  assert.deepEqual(parsePlayerRef('76561198847373934\u{E0000}'), {
    kind: 'steam',
    value: '76561198847373934',
  });
});

test('parsePlayerRef afviser stadig en rigtig skrivefejl', () => {
  // Rensningen må ikke gøre alt gyldigt — to ord er stadig en fejl.
  assert.equal(parsePlayerRef('Navn Efternavn'), null);
  assert.equal(parsePlayerRef('\u{E0000}'), null, 'kun usynlige tegn er ingenting');
  assert.equal(parsePlayerRef('\u034F'), null);
});
