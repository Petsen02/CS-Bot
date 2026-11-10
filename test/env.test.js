import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFile } from '../src/config.js';

function envFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'csbot-')), '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('en nøgle der ikke er i miljøet tages fra filen', () => {
  const env = {};
  loadEnvFile(envFile('TWITCH_CHANNELS=petsen02,dewi\n'), env);
  assert.equal(env.TWITCH_CHANNELS, 'petsen02,dewi');
});

test('et TOMT felt i panelet må ikke slette linjen i .env', () => {
  // Pelican sætter en miljøvariabel for hver variabel i ægget, også de
  // uudfyldte. Uden det her vandt den tomme streng, og kanalen forsvandt.
  const env = { TWITCH_CHANNELS: '' };
  loadEnvFile(envFile('TWITCH_CHANNELS=petsen02,dewi\n'), env);
  assert.equal(env.TWITCH_CHANNELS, 'petsen02,dewi');
});

test('en udfyldt værtsvariabel vinder stadig', () => {
  const env = { TWITCH_CHANNELS: 'kunpanelet' };
  loadEnvFile(envFile('TWITCH_CHANNELS=petsen02\n'), env);
  assert.equal(env.TWITCH_CHANNELS, 'kunpanelet');
});

test('kommentarer og citationstegn håndteres', () => {
  const env = {};
  loadEnvFile(envFile('# kommentar\nA="citeret"\nB=bar\n\nUGYLDIG\n'), env);
  assert.equal(env.A, 'citeret');
  assert.equal(env.B, 'bar');
});
