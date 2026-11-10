import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function tempStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-store-'));
  return { store: new Store(join(dir, 'tracker.json'), { quiet: true, ...options }), dir };
}

/** De to tests der handler om JSON-filen selv skal ikke bruge databasen. */
function jsonStore() {
  return tempStore({ useDatabase: false });
}

test('Store gemmer og genindlæser snapshots', () => {
  const { store, dir } = tempStore();
  try {
    store.setSnapshot('p1', 'PETSEN', { elo: 2300, at: 1000 });
    store.save();

    const reloaded = new Store(join(dir, 'tracker.json'), { quiet: true });
    assert.deepEqual(reloaded.getSnapshot('p1'), { elo: 2300, at: 1000 });
    assert.equal(reloaded.getNickname('p1'), 'PETSEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store efterlader ingen temp-fil efter en gemning', () => {
  const { store, dir } = jsonStore();
  try {
    store.setSnapshot('p1', 'PETSEN', { elo: 2300, at: 1000 });
    store.save();
    assert.ok(existsSync(join(dir, 'tracker.json')));
    assert.ok(!existsSync(join(dir, 'tracker.json.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store starter tomt på ulæselige data frem for at kaste', () => {
  // En halvskrevet fil efter et strømsvigt må ikke forhindre botten i at starte.
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-store-'));
  try {
    const store = new Store(join(dir, 'findes-ikke.json'), { quiet: true });
    assert.equal(store.getSnapshot('p1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getMatchesBetween giver kampene i spillerækkefølge', () => {
  const { store, dir } = tempStore();
  try {
    store.recordMatch('p1', 'PETSEN', 'm2', { eloDelta: -20, won: false, at: 2000 });
    store.recordMatch('p1', 'PETSEN', 'm1', { eloDelta: 25, won: true, at: 1000 });
    store.recordMatch('p1', 'PETSEN', 'm3', { eloDelta: 25, won: true, at: 9000 });

    const window = store.getMatchesBetween('p1', 500, 5000);
    assert.deepEqual(window.map((m) => m.matchId), ['m1', 'm2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAverageEloGain bruger kun sejre og nægter at gætte', () => {
  const { store, dir } = tempStore();
  try {
    assert.equal(store.getAverageEloGain('p1'), null);

    store.recordMatch('p1', 'PETSEN', 'm1', { eloDelta: 20, won: true, at: 1 });
    store.recordMatch('p1', 'PETSEN', 'm2', { eloDelta: -30, won: false, at: 2 });
    store.recordMatch('p1', 'PETSEN', 'm3', { eloDelta: 30, won: true, at: 3 });
    // Umålte kampe må ikke trække gennemsnittet mod nul.
    store.recordMatch('p1', 'PETSEN', 'm4', { eloDelta: null, won: true, at: 4 });

    assert.equal(store.getAverageEloGain('p1'), 25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('baseline sættes kun én gang pr. dag', () => {
  const { store, dir } = tempStore();
  try {
    assert.equal(store.setBaselineIfMissing('p1', 'PETSEN', '2026-11-04', 2300, 100), true);
    // Et andet tal senere på dagen må ikke overskrive dagens anker.
    assert.equal(store.setBaselineIfMissing('p1', 'PETSEN', '2026-11-04', 2400, 200), false);

    assert.deepEqual(store.getBaseline('p1', '2026-11-04'), { elo: 2300, at: 100 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getBaseline markerer gamle tal uden tidsstempel som utroværdige', () => {
  const { store, dir } = jsonStore();
  try {
    store.setSnapshot('p1', 'PETSEN', { elo: 1, at: 1 });
    store.save();

    // Simulér en ældre filversion hvor baseline var et bart tal.
    const file = join(dir, 'tracker.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.players.p1.baselines = { '2026-11-01': 2000 };
    writeFileSync(file, JSON.stringify(raw));

    const reloaded = new Store(join(dir, 'tracker.json'), { quiet: true, useDatabase: false });
    assert.deepEqual(reloaded.getBaseline('p1', '2026-11-01'), { elo: 2000, at: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prune fjerner kampe ældre end opbevaringsvinduet', () => {
  const { store, dir } = tempStore();
  try {
    const now = Date.now();
    store.recordMatch('p1', 'PETSEN', 'gammel', { eloDelta: 20, won: true, at: now - 30 * 86_400_000 });
    store.recordMatch('p1', 'PETSEN', 'ny', { eloDelta: 20, won: true, at: now - 3_600_000 });

    store.prune(now);

    assert.equal(store.hasMatch('p1', 'gammel'), false);
    assert.equal(store.hasMatch('p1', 'ny'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Watch-listen er det der gør at folk kan få deres egen konto med uden at
 * nogen tilføjer den i hånden. Linket til et Twitch-navn er et gæt, så
 * reglerne for hvornår det må flytte sig er vigtigere end selve listen.
 */
test('watch optager den der spurgte første gang', () => {
  const { store, dir } = tempStore();
  try {
    const player = { playerId: 'p1', nickname: 'Petsen', steamId: '765' };

    assert.equal(store.watch(player, { twitch: 'enSeer' }), 'added');
    assert.equal(store.watchedAccounts()[0].twitch, 'enSeer');
    assert.equal(store.watchedAccounts()[0].nickname, 'Petsen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('en senere spørger overtager ikke linket', () => {
  const { store, dir } = tempStore();
  try {
    const player = { playerId: 'p1', nickname: 'Petsen' };
    store.watch(player, { twitch: 'enSeer' });

    // Botten kan ikke se hvem der ejer kontoen, og den anden er ikke mere
    // sandsynlig end den første.
    store.watch(player, { twitch: 'enAnden' });
    assert.equal(store.watchedAccounts()[0].twitch, 'enSeer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('et Twitch-navn der er nicket overtager linket', () => {
  const { store, dir } = tempStore();
  try {
    const player = { playerId: 'p1', nickname: 'Petsen' };
    store.watch(player, { twitch: 'enSeer' });

    // Det tætteste botten kommer på et ejerskabsbevis.
    store.watch(player, { twitch: 'Petsen' });
    assert.equal(store.watchedAccounts()[0].twitch, 'Petsen');

    // Og derfra kan et navn der ikke matcher ikke tage det tilbage.
    store.watch(player, { twitch: 'tyveknaegt' });
    assert.equal(store.watchedAccounts()[0].twitch, 'Petsen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mellemrum og store bogstaver skiller ikke navnene ad', async () => {
  const { namesMatch } = await import('../src/store.js');

  // Et Twitch-navn kan ikke indeholde mellemrum, så "Lil Rasmus" og
  // "lilrasmus" er samme menneske under to sæt regler.
  assert.equal(namesMatch('lilrasmus', 'Lil Rasmus'), true);
  assert.equal(namesMatch('PETSEN', 'Petsen'), true);
  assert.equal(namesMatch('enAnden', 'Petsen'), false);
  assert.equal(namesMatch('', 'Petsen'), false);
  assert.equal(namesMatch('petsen', null), false);
});

test('en tom post tager det næste navn den ser', () => {
  const { store, dir } = tempStore();
  try {
    const player = { playerId: 'p1', nickname: 'Petsen' };

    // Fra et opslag uden seernavn, fx trackerens egen poll.
    store.watch(player, { twitch: null });
    assert.equal(store.watchedAccounts()[0].twitch, null);

    store.watch(player, { twitch: 'enSeer' });
    assert.equal(store.watchedAccounts()[0].twitch, 'enSeer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanalens main slår et gæt, fordi den ikke er et gæt', () => {
  const { store, dir } = tempStore();
  try {
    const player = { playerId: 'p1', nickname: 'Petsen' };
    store.watch(player, { twitch: 'enSeer' });

    // force er for et navn der ikke er et gæt: kanalens egen main er
    // streamerens konto per definition.
    store.watch(player, { twitch: 'petsen02', force: true });
    assert.equal(store.watchedAccounts()[0].twitch, 'petsen02');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch-listen og målingerne overlever en genstart', () => {
  const { store, dir } = tempStore();
  const file = join(dir, 'tracker.json');
  try {
    store.watch({ playerId: 'p1', nickname: 'Petsen', steamId: '765' }, { twitch: 'petsen02' });
    store.recordMatch('p1', 'Petsen', 'm1', { eloDelta: 25, won: true, at: 1000 });
    store.setSnapshot('p1', 'Petsen', { elo: 1416, at: 2000 });
    store.save();

    const reopened = new Store(file, { quiet: true });
    assert.equal(reopened.watchedAccounts()[0].twitch, 'petsen02');
    assert.equal(reopened.getMatchDelta('p1', 'm1'), 25);
    assert.deepEqual(reopened.getSnapshot('p1'), { elo: 1416, at: 2000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('en JSON-tilstand flyttes med over i databasen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-store-'));
  const file = join(dir, 'tracker.json');
  try {
    // Først en bot der har kørt på JSON.
    const before = new Store(file, { quiet: true, useDatabase: false });
    before.watch({ playerId: 'p1', nickname: 'Petsen' }, { twitch: 'petsen02' });
    before.recordMatch('p1', 'Petsen', 'm1', { eloDelta: 25, won: true, at: 1000 });
    before.save();

    // Så den første start efter opgraderingen.
    const after = new Store(file, { quiet: true });
    assert.equal(after.watchedAccounts()[0].twitch, 'petsen02', 'watch-listen skal følge med');
    assert.equal(after.getMatchDelta('p1', 'm1'), 25, 'målingerne skal følge med');

    // JSON-filen bliver liggende: den er vejen tilbage.
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
