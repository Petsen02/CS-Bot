import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/cache.js';
import { RateLimiter } from '../src/limiter.js';

test('TtlCache udløber poster', async () => {
  const cache = new TtlCache(20);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.get('a'), undefined);
});

test('TtlCache smider den mindst brugte ud ved overløb', () => {
  const cache = new TtlCache(Infinity, 2);
  cache.set('a', 1);
  cache.set('b', 2);

  // Læsning af 'a' gør den frisk, så 'b' er nu den ældste.
  cache.get('a');
  cache.set('c', 3);

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('wrap deler ét kald mellem samtidige kaldere', async () => {
  const cache = new TtlCache(1000);
  let calls = 0;

  const producer = async () => {
    calls += 1;
    return 'værdi';
  };

  const [one, two] = await Promise.all([
    cache.wrap('k', producer),
    cache.wrap('k', producer),
  ]);

  assert.equal(one, 'værdi');
  assert.equal(two, 'værdi');
  assert.equal(calls, 1, 'en byge af kommandoer skal dele ét kald opad');
});

test('wrap cacher ikke en fejl', async () => {
  const cache = new TtlCache(1000);
  let calls = 0;

  const failing = async () => {
    calls += 1;
    throw new Error('nede');
  };

  await assert.rejects(() => cache.wrap('k', failing));
  // En forbigående udfald må ikke hænge hele TTL'en ud.
  await assert.rejects(() => cache.wrap('k', failing));
  assert.equal(calls, 2);
});

test('RateLimiter holder sig inden for vinduet', async () => {
  const limiter = new RateLimiter([{ limit: 2, windowMs: 60 }]);

  const started = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  // Det tredje kald skal vente på at vinduet frigives.
  await limiter.acquire();

  assert.ok(Date.now() - started >= 55, 'tredje kald må ikke slippe igennem med det samme');
});
