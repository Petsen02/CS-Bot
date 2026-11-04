import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_FLOORS,
  levelFor,
  nextLevel,
  winsNeeded,
  formatLevel,
  formatPlayerElo,
  formatEloDelta,
} from '../src/elo.js';

test('levelFor rammer hver grænse præcist', () => {
  // Hver grænse testes på selve tallet og lige under, fordi en off-by-one her
  // ville vise forkert level for alle spillere i et helt bånd.
  for (const { level, min } of LEVEL_FLOORS) {
    assert.equal(levelFor(min), level, `${min} elo skal være level ${level}`);
    if (level > 1) {
      assert.equal(levelFor(min - 1), level - 1, `${min - 1} elo skal være level ${level - 1}`);
    }
  }
});

test('levelFor klemmer og afviser ugyldige værdier', () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(5000), 10);
  assert.equal(levelFor(null), null);
  assert.equal(levelFor(NaN), null);
});

test('nextLevel giver det der mangler, og null på level 10', () => {
  assert.deepEqual(nextLevel(1920), { level: 10, min: 2001, needed: 81 });
  assert.deepEqual(nextLevel(2000), { level: 10, min: 2001, needed: 1 });
  assert.equal(nextLevel(2001), null);
  assert.equal(nextLevel(9999), null);
});

test('winsNeeded runder op og nægter at gætte uden data', () => {
  assert.equal(winsNeeded(81, 25), 4);
  assert.equal(winsNeeded(50, 25), 2);
  assert.equal(winsNeeded(81, null), null);
  assert.equal(winsNeeded(81, 0), null);
});

test('formatLevel følger den valgte stil', () => {
  assert.equal(formatLevel(10, 'emotes'), 'LEVEL10');
  assert.equal(formatLevel(10, 'letters'), 'L10');
});

test('formatPlayerElo skriver begge stilarter', () => {
  const player = { nickname: 'PETSEN', elo: 2347, level: 10 };
  assert.equal(formatPlayerElo(player, 'emotes'), 'PETSEN LEVEL10: 2347 elo');
  assert.equal(formatPlayerElo(player, 'letters'), 'PETSEN L10 2347elo');
});

test('formatPlayerElo udleder level når det mangler', () => {
  assert.equal(
    formatPlayerElo({ nickname: 'X', elo: 1800 }, 'emotes'),
    'X LEVEL9: 1800 elo',
  );
});

test('formatEloDelta har altid fortegn', () => {
  assert.equal(formatEloDelta(25), '+25');
  assert.equal(formatEloDelta(-25), '-25');
  assert.equal(formatEloDelta(0), '±0');
});
