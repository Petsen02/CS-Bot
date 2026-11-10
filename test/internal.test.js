import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchInternal, ongoingMatchesUrl, describeBody, classify } from '../src/internal.js';

test('ongoingMatchesUrl peger på sidens egen rute', () => {
  assert.equal(
    ongoingMatchesUrl('83ec91dc-2339'),
    'https://www.faceit.com/api/match/v1/matches/groupByState?userId=83ec91dc-2339',
  );
});

test('fetchInternal nægter en fremmed vært uden at kalde ud', async () => {
  const result = await fetchInternal('https://example.com/api/match');
  assert.equal(result.status, 0);
  assert.equal(result.hint, 'vært ikke tilladt');
});

test('fetchInternal nægter http', async () => {
  const result = await fetchInternal('http://www.faceit.com/api/match');
  assert.equal(result.status, 0);
});

test('classify kender en botkontrol fra et rigtigt svar', () => {
  assert.equal(classify('<!DOCTYPE html><title>Just a moment...</title>'), 'botkontrol');
  assert.equal(classify('<html><body>502</body></html>'), 'html');
  assert.equal(classify(''), 'tomt svar');
  assert.equal(classify('not found'), 'ikke-json');
});

test('describeBody pakker payload ud', () => {
  assert.equal(describeBody({ payload: { ONGOING: [1, 2] }, code: 'OK' }), 'payload,code → ONGOING');
  assert.equal(describeBody([1, 2, 3]), 'array(3)');
  assert.equal(describeBody(null), 'tomt');
});
