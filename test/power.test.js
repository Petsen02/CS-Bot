import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readFlightPayload, readTeam, readNextMatch } from '../src/power.js';
import { formatNextPower } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const payload = readFlightPayload(
  readFileSync(join(here, 'fixtures', 'powerligaen.html'), 'utf8'),
);

const VIGG0 = '76561198222914476';
const FØR = Date.parse('2026-11-16T00:00:00Z');

test('flight-payloaden pakkes ud af siden', () => {
  assert.ok(payload.includes('"playerInformation"'), payload.slice(0, 120));
  assert.ok(payload.includes('"hold_a":"Eliten"'), payload.slice(0, 120));
});

test('readFlightPayload klarer en side uden data', () => {
  assert.equal(readFlightPayload('<html><body>intet</body></html>'), '');
  assert.equal(readFlightPayload(null), '');
});

test('holdet slås op på SteamID', () => {
  assert.deepEqual(readTeam(payload, VIGG0), {
    name: 'Eliten',
    id: '6a9af3fa88b8dc0c3db43c81',
  });
});

test('en spiller der ikke er i ligaen giver null', () => {
  assert.equal(readTeam(payload, '76561190000000000'), null);
  assert.equal(readTeam(payload, null), null);
});

test('naboens hold læses ikke som spillerens', () => {
  // Posterne ligger efter hinanden i samme streng; vinduet skal holde
  // opslaget inde i én spiller.
  assert.equal(readTeam(payload, '76561198000000001').name, 'Andet Hold');
});

test('næste kamp er den tidligste der ikke er spillet', () => {
  const match = readNextMatch(payload, readTeam(payload, VIGG0), FØR);

  assert.equal(match.opponent, 'NXR DORADO');
  assert.equal(new Date(match.at).toISOString(), '2026-11-17T16:00:00.000Z');
});

test('en spillet kamp tælles ikke med', () => {
  // Kampen mod HavneTid står "complete" og ligger før de to andre.
  const match = readNextMatch(payload, readTeam(payload, VIGG0), FØR);
  assert.notEqual(match.opponent, 'HavneTid');
});

test('holdet findes uanset om det står som hold_a eller hold_b', () => {
  // Efter den første kamp er næste den hvor Eliten står som hold_b.
  const efter = Date.parse('2026-11-17T20:00:00Z');
  const match = readNextMatch(payload, readTeam(payload, VIGG0), efter);

  assert.equal(match.opponent, 'Zk Haha');
});

test('ingen kommende kampe giver null', () => {
  const sent = Date.parse('2027-01-01T00:00:00Z');
  assert.equal(readNextMatch(payload, readTeam(payload, VIGG0), sent), null);
  assert.equal(readNextMatch(payload, null), null);
});

test('formatNextPower svarer som !næsteesea når der ingen kamp er', () => {
  assert.equal(
    formatNextPower({ nickname: 'vigg0', team: 'Eliten', match: null }),
    'vigg0 har ingen planlagte Powerliga-kampe',
  );
  assert.equal(
    formatNextPower({ nickname: 'vigg0', team: null, match: null }),
    'vigg0 har ingen planlagte Powerliga-kampe',
  );
});

test('formatNextPower har samme felter som !næsteesea', () => {
  const message = formatNextPower({
    nickname: 'vigg0',
    team: 'Eliten',
    match: {
      opponent: 'NXR DORADO',
      league: 'CEPTER Divisionerne',
      at: Date.parse('2026-11-17T16:00:00Z'),
    },
  });

  const fields = message.split(' │ ');
  assert.equal(fields[0], 'vigg0');
  assert.equal(fields[1], 'CEPTER Divisionerne');
  assert.equal(fields[2], 'Eliten vs NXR DORADO');
  assert.ok(fields[3].includes('17/11/26'), message);
});

test('formatNextPower falder tilbage til "Powerligaen" uden liganavn', () => {
  const message = formatNextPower({
    nickname: 'vigg0', team: 'Eliten',
    match: { opponent: 'NXR DORADO', at: Date.parse('2026-11-17T16:00:00Z') },
  });

  assert.ok(message.includes('Powerligaen'), message);
});
