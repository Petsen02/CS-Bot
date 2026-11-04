import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitRevision } from '../src/version.js';

/**
 * Flere fejlsøgninger endte med at botten kørte kode fra før rettelsen, uden
 * at det kunne ses. Versionen i !csbotcommands og i opstartsloggen gør det
 * spørgsmål til et opslag frem for et gæt.
 */
test('gitRevision giver en kort commit, eller null uden at kaste', () => {
  const revision = gitRevision();

  // I dette repo er der en .git-mappe, så der skal komme noget.
  assert.notEqual(revision, undefined);
  if (revision !== null) {
    assert.match(revision, /^[0-9a-f]{7}$/, `uventet form: ${revision}`);
  }
});
