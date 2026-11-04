import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-store-'));
  return { store: new Store(join(dir, 'tracker.json')), dir };
}

test('Store gemmer og genindlæser snapshots', () => {
  const { store, dir } = tempStore();
  try {
    store.setSnapshot('p1', 'PETSEN', { elo: 2300, at: 1000 });
    store.save();

    const reloaded = new Store(join(dir, 'tracker.json'));
    assert.deepEqual(reloaded.getSnapshot('p1'), { elo: 2300, at: 1000 });
    assert.equal(reloaded.getNickname('p1'), 'PETSEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store efterlader ingen temp-fil efter en gemning', () => {
  const { store, dir } = tempStore();
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
    const store = new Store(join(dir, 'findes-ikke.json'));
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
  const { store, dir } = tempStore();
  try {
    store.setSnapshot('p1', 'PETSEN', { elo: 1, at: 1 });
    store.save();

    // Simulér en ældre filversion hvor baseline var et bart tal.
    const file = join(dir, 'tracker.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.players.p1.baselines = { '2026-11-01': 2000 };
    writeFileSync(file, JSON.stringify(raw));

    const reloaded = new Store(join(dir, 'tracker.json'));
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
