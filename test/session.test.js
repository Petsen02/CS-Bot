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
  });

  assert.deepEqual(result, { eloTotal: 60, measuredCount: 3 });
});

test('en baseline fra midt på dagen dækker kun kampene efter den', () => {
  // Botten startede kl. 11; kampen kl. 10 kan den ikke gøre rede for.
  const result = attributeElo({
    endedAt: [10 * H, 12 * H, 13 * H],
    baseline: { elo: 2550, at: 11 * H },
    snapshot,
    eloTotal: 0,
    measuredCount: 0,
  });

  assert.deepEqual(result, { eloTotal: 50, measuredCount: 2 });
});

test('en baseline efter dagens sidste kamp giver ingen elo-påstand', () => {
  const result = attributeElo({
    endedAt: [10 * H, 11 * H],
    baseline: { elo: 2600, at: 12 * H },
    snapshot,
    eloTotal: 0,
    measuredCount: 0,
  });

  assert.deepEqual(result, { eloTotal: 0, measuredCount: 0 });
});

test('uden baseline eller snapshot står enkeltmålingerne', () => {
  const sums = { eloTotal: 17, measuredCount: 2 };

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
