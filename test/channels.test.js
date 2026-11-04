import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../src/channels.js';

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-ch-'));
  return { channels: new ChannelStore(join(dir, 'channels.json')), dir };
}

const petsen = { playerId: 'p1', nickname: 'PETSEN', steamId: '76561198000000000' };
const rasmus = { playerId: 'p2', nickname: 'RASMUS', steamId: null };

test('en ny kanal får standardregion og -land', () => {
  const { channels, dir } = temp();
  try {
    const channel = channels.get('somechannel');
    assert.equal(channel.region, 'EU');
    assert.equal(channel.country, 'DK');
    assert.deepEqual(channel.players, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addPlayer afviser dubletter på player_id, ikke på nick', () => {
  const { channels, dir } = temp();
  try {
    assert.equal(channels.addPlayer('c', petsen), 'added');
    // Samme konto under et nyt nick er stadig samme konto.
    assert.equal(channels.addPlayer('c', { ...petsen, nickname: 'PETSEN2' }), 'duplicate');
    assert.equal(channels.get('c').players.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at fjerne mainen rydder også main-feltet', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('c', petsen);
    channels.setMain('c', 'PETSEN');

    assert.equal(channels.removePlayer('c', 'PETSEN'), 'removed');
    // En main uden for listen ville i stilhed ødelægge !rank.
    assert.equal(channels.get('c').main, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mainPlayer falder tilbage til den første på listen', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('c', petsen);
    channels.addPlayer('c', rasmus);

    assert.equal(channels.mainPlayer('c').nickname, 'PETSEN');

    channels.setMain('c', 'RASMUS');
    assert.equal(channels.mainPlayer('c').nickname, 'RASMUS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mainPlayer ignorerer en main der ikke er på listen', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('c', petsen);
    channels.setMain('c', 'FINDES-IKKE');

    // Bedre at svare om en rigtig spiller end at fejle på en forældet main.
    assert.equal(channels.mainPlayer('c').nickname, 'PETSEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renamePlayer følger nickskift og flytter main med', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('c', petsen);
    channels.setMain('c', 'PETSEN');

    assert.equal(channels.renamePlayer('p1', 'PETSEN_NY'), true);
    assert.equal(channels.get('c').players[0].nickname, 'PETSEN_NY');
    assert.equal(channels.get('c').main, 'PETSEN_NY');

    // Samme navn igen er ingen ændring, og skal ikke skrive filen.
    assert.equal(channels.renamePlayer('p1', 'PETSEN_NY'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setRegion og setCountry afviser ugyldige værdier', () => {
  const { channels, dir } = temp();
  try {
    assert.equal(channels.setRegion('c', 'eu'), true);
    assert.equal(channels.get('c').region, 'EU');
    assert.equal(channels.setRegion('c', 'euw1'), false);
    assert.equal(channels.get('c').region, 'EU', 'en afvist region må ikke ændre noget');

    assert.equal(channels.setCountry('c', 'se'), true);
    assert.equal(channels.get('c').country, 'SE');
    assert.equal(channels.setCountry('c', 'SWE'), false);
    assert.equal(channels.get('c').country, 'SE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trackedPlayers deduplikerer på tværs af kanaler', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('a', petsen);
    channels.addPlayer('b', petsen);
    channels.addPlayer('b', rasmus);

    const tracked = channels.trackedPlayers();
    assert.equal(tracked.length, 2, 'samme spiller i to kanaler er én konto at polle');

    const shared = tracked.find((p) => p.playerId === 'p1');
    assert.deepEqual(shared.channels.sort(), ['a', 'b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanalnavne normaliseres, så #Navn og navn er samme kanal', () => {
  const { channels, dir } = temp();
  try {
    channels.addPlayer('#MyChannel', petsen);
    assert.equal(channels.get('mychannel').players.length, 1);
    assert.deepEqual(channels.names(), ['mychannel']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
