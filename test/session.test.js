import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attributeElo } from '../src/commands.js';

const H = 3600_000;
const snapshot = { elo: 2600 };

test('baselinen dækker hele dagen og slår enkeltmålingerne', () => {
  const result = attributeElo({
    endedAt: [10 * H, 11 * H, 12 * H],
    baseline: { elo: 2540, at: 9 * H },
    snapshot,
    eloTotal: 25,
    measuredCount: 1,
    measured: [false, true, false],
  });

  assert.deepEqual(result, {
    eloTotal: 60, measuredCount: 3, measured: [true, true, true],
  });
});

test('en baseline fra midt på dagen dækker kun kampene efter den', () => {
  // Botten startede kl. 11; kampen kl. 10 kan den ikke gøre rede for.
  const result = attributeElo({
    endedAt: [10 * H, 12 * H, 13 * H],
    baseline: { elo: 2550, at: 11 * H },
    snapshot,
    eloTotal: 0,
    measuredCount: 0,
    measured: [false, false, false],
  });

  // Kampen kl. 10 ligger før baselinen og tælles ikke med.
  assert.deepEqual(result, {
    eloTotal: 50, measuredCount: 2, measured: [false, true, true],
  });
});

test('en baseline efter dagens sidste kamp giver ingen elo-påstand', () => {
  const result = attributeElo({
    endedAt: [10 * H, 11 * H],
    baseline: { elo: 2600, at: 12 * H },
    snapshot,
    eloTotal: 0,
    measuredCount: 0,
    measured: [false, false],
  });

  assert.deepEqual(result, {
    eloTotal: 0, measuredCount: 0, measured: [false, false],
  });
});

test('uden baseline eller snapshot står enkeltmålingerne', () => {
  const sums = { eloTotal: 17, measuredCount: 2, measured: [true, true] };

  assert.deepEqual(
    attributeElo({ endedAt: [10 * H], baseline: null, snapshot, ...sums }),
    sums,
  );
  assert.deepEqual(
    attributeElo({ endedAt: [10 * H], baseline: { elo: 2500, at: 9 * H }, snapshot: null, ...sums }),
    sums,
  );
  assert.deepEqual(
    attributeElo({ endedAt: [10 * H], baseline: { elo: 2500 }, snapshot, ...sums }),
    sums,
  );
});

import { deriveMatchDelta, endedAtMs } from '../src/commands.js';

test('endedAtMs regner FACEIT-sekunder om til ms', () => {
  assert.equal(endedAtMs({ finished_at: 1700000000 }), 1700000000_000);
  assert.equal(endedAtMs({ started_at: 1700000000 }), 1700000000_000);
  assert.equal(endedAtMs({}), 0);
  assert.equal(endedAtMs(null), 0);
});

test('står kampen alene efter baselinen, er hele forskellen dens', () => {
  // Præcis dewis tilfælde: 5 kampe i dag, botten startede efter nr. 4.
  const delta = deriveMatchDelta({
    matchEndedAt: 20 * H,
    dayEndedAt: [12 * H, 14 * H, 16 * H, 18 * H, 20 * H],
    baseline: { elo: 2599, at: 19 * H },
    snapshot: { elo: 2570, at: 20.5 * H },
  });

  assert.equal(delta, -29);
});

test('to kampe efter baselinen kan ikke fordeles', () => {
  assert.equal(deriveMatchDelta({
    matchEndedAt: 20 * H,
    dayEndedAt: [18 * H, 20 * H],
    baseline: { elo: 2599, at: 17 * H },
    snapshot: { elo: 2570, at: 20.5 * H },
  }), null);
});

test('en kamp fra før baselinen kan ikke udledes', () => {
  assert.equal(deriveMatchDelta({
    matchEndedAt: 16 * H,
    dayEndedAt: [16 * H, 20 * H],
    baseline: { elo: 2599, at: 19 * H },
    snapshot: { elo: 2570, at: 20.5 * H },
  }), null);
});

test('et snapshot fra før kampen bruges ikke', () => {
  // Spurgt i minuttet mellem at kampen sluttede og næste poll.
  assert.equal(deriveMatchDelta({
    matchEndedAt: 20 * H,
    dayEndedAt: [20 * H],
    baseline: { elo: 2599, at: 19 * H },
    snapshot: { elo: 2599, at: 19.5 * H },
  }), null);
});

test('uden baseline eller snapshot udledes intet', () => {
  const base = { matchEndedAt: 20 * H, dayEndedAt: [20 * H] };
  assert.equal(deriveMatchDelta({ ...base, baseline: null, snapshot: { elo: 2570, at: 21 * H } }), null);
  assert.equal(deriveMatchDelta({ ...base, baseline: { elo: 2599, at: 19 * H }, snapshot: null }), null);
  assert.equal(deriveMatchDelta({
    ...base, baseline: { elo: 2599 }, snapshot: { elo: 2570, at: 21 * H },
  }), null);
});

test('stregen sættes hvor målingen begynder', async () => {
  const { formatSession } = await import('../src/format.js');

  // Dewis dag: fem kampe, botten startede før den sidste.
  const message = formatSession({
    nickname: 'dewi',
    results: [false, false, false, true, false],
    eloTotal: -29,
    measuredCount: 1,
    measured: [false, false, false, false, true],
  });

  assert.ok(message.includes('🟥🟥🟥🟩│🟥'), message);
  assert.ok(message.includes('[1/5 målt]'), message);
});

test('ingen streg når alle kampe er talt med', async () => {
  const { formatSession } = await import('../src/format.js');

  const message = formatSession({
    nickname: 'dewi',
    results: [true, false],
    eloTotal: 4,
    measuredCount: 2,
    measured: [true, true],
  });

  assert.ok(message.includes('🟩🟥'), message);
  assert.ok(!message.includes('│🟥'), message);
});

test('en streg ved hvert skift når målingerne ikke ligger samlet', async () => {
  const { formatSession } = await import('../src/format.js');

  const message = formatSession({
    nickname: 'dewi',
    results: [true, false, true],
    eloTotal: 10,
    measuredCount: 2,
    measured: [true, false, true],
  });

  assert.ok(message.includes('🟩│🟥│🟩'), message);
});
