import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hltvRating } from '../src/rating.js';

/**
 * HLTV Rating 1.0 er en offentligt beskrevet formel, ikke et opfundet tal.
 * Den bruges fordi FACEIT Rating ikke er i Data API'et — målt på to spillere
 * og tre kampe, 47 felter, ingen rating blandt dem.
 */

test('en gennemsnitlig præstation lander på omkring 1.00', () => {
  // Formlens konstanter er netop valgt så gennemsnittet giver 1.
  const rating = hltvRating({ kills: 15, deaths: 15, rounds: 22, doubles: 3, triples: 1 });
  assert.ok(Math.abs(rating - 1) < 0.05, `fik ${rating}`);
});

test('en god og en dårlig kamp ligger hvor de skal', () => {
  const good = hltvRating({ kills: 25, deaths: 15, rounds: 22, doubles: 5, triples: 2 });
  const bad = hltvRating({ kills: 6, deaths: 16, rounds: 19, doubles: 1 });

  assert.ok(good > 1.3, `god kamp: ${good}`);
  assert.ok(bad < 0.6, `dårlig kamp: ${bad}`);
});

test('multi-kills trækker ratingen op ved samme antal drab', () => {
  const base = { kills: 20, deaths: 15, rounds: 22 };

  // Tyve drab fordelt på tyve runder er mindre værd end tyve drab i ti.
  const spread = hltvRating({ ...base, doubles: 0, triples: 0 });
  const clustered = hltvRating({ ...base, doubles: 4, triples: 2, aces: 1 });

  assert.ok(clustered > spread, `${clustered} skulle være over ${spread}`);
});

test('manglende multi-kill-tal giver stadig en rating', () => {
  // Felterne kan mangle i svaret; så antages alle drab at stå alene.
  const rating = hltvRating({ kills: 25, deaths: 15, rounds: 22 });
  assert.ok(rating > 0, `fik ${rating}`);
});

test('uenige felter trækker ikke ratingen under nul', () => {
  // Hvis multi-kills tilsammen overstiger antal drab, går regnestykket ikke
  // op. Resultatet skal stadig være brugbart frem for negativt.
  const rating = hltvRating({ kills: 4, deaths: 10, rounds: 20, aces: 3 });
  assert.ok(rating >= 0, `fik ${rating}`);
});

test('hltvRating giver null frem for et gæt når et tal mangler', () => {
  // Et opdigtet tal i en statistiklinje er værre end et tomt felt.
  assert.equal(hltvRating({ kills: 25, deaths: 15, rounds: 0 }), null, 'ingen runder');
  assert.equal(hltvRating({ deaths: 15, rounds: 22 }), null, 'ingen kills');
  assert.equal(hltvRating({ kills: 25, rounds: 22 }), null, 'ingen deaths');
  assert.equal(hltvRating({}), null);
});
