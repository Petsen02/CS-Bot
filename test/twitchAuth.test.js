import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripOauth, withOauth, pickTokens, TwitchAuth } from '../src/twitchAuth.js';

test('stripOauth og withOauth er hinandens modsatte', () => {
  assert.equal(stripOauth('oauth:abc123'), 'abc123');
  assert.equal(stripOauth('abc123'), 'abc123');
  assert.equal(stripOauth('  oauth:abc123  '), 'abc123');

  assert.equal(withOauth('abc123'), 'oauth:abc123');
  // Må ikke få præfikset to gange — tmi.js afviser "oauth:oauth:...".
  assert.equal(withOauth('oauth:abc123'), 'oauth:abc123');
});

test('withOauth giver tom streng for intet, ikke "oauth:"', () => {
  assert.equal(withOauth(''), '');
  assert.equal(withOauth(null), '');
});

test('pickTokens bruger de gemte når de stammer fra .env-tokenet', () => {
  const stored = { accessToken: 'nyt', refreshToken: 'r2', seededFrom: 'r1' };
  const fromEnv = { accessToken: 'gammelt', refreshToken: 'r1' };

  const picked = pickTokens(stored, fromEnv);
  assert.equal(picked.accessToken, 'nyt', 'det fornyede token skal vinde');
  assert.equal(picked.refreshToken, 'r2');
});

test('pickTokens kasserer de gemte når .env er skiftet i hånden', () => {
  // Indsætter man et nyt token i .env, må en gammel gemt kopi ikke overskrive
  // det man lige har sat ind.
  const stored = { accessToken: 'forældet', refreshToken: 'r2', seededFrom: 'r1' };
  const fromEnv = { accessToken: 'indsat-i-hånden', refreshToken: 'HELT-NY' };

  const picked = pickTokens(stored, fromEnv);
  assert.equal(picked.accessToken, 'indsat-i-hånden');
  assert.equal(picked.refreshToken, 'HELT-NY');
  assert.equal(picked.seededFrom, 'HELT-NY');
});

test('pickTokens tåler at der intet er gemt', () => {
  const fromEnv = { accessToken: 'a', refreshToken: 'r' };
  assert.deepEqual(pickTokens(null, fromEnv), { accessToken: 'a', refreshToken: 'r', seededFrom: 'r' });
  assert.equal(pickTokens({}, fromEnv).accessToken, 'a');
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bot-auth-'));
  return { dir, file: join(dir, 'twitch-tokens.json') };
}

test('TwitchAuth giver tmi.js en adgangskode med præfiks', () => {
  const { dir, file } = temp();
  try {
    const auth = new TwitchAuth({ accessToken: 'abc123', file });
    assert.equal(auth.password, 'oauth:abc123');
    assert.equal(auth.canRefresh, false, 'uden refresh token kan der ikke fornys');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TwitchAuth læser et gemt, fornyet token', () => {
  const { dir, file } = temp();
  try {
    writeFileSync(file, JSON.stringify({
      accessToken: 'fornyet',
      refreshToken: 'r2',
      seededFrom: 'r1',
    }));

    const auth = new TwitchAuth({ accessToken: 'oauth:gammelt', refreshToken: 'r1', file });
    assert.equal(auth.password, 'oauth:fornyet');
    assert.equal(auth.canRefresh, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TwitchAuth foretrækker .env når refresh-tokenet er skiftet', () => {
  const { dir, file } = temp();
  try {
    writeFileSync(file, JSON.stringify({
      accessToken: 'forældet',
      refreshToken: 'r2',
      seededFrom: 'r1',
    }));

    const auth = new TwitchAuth({ accessToken: 'frisk', refreshToken: 'HELT-NY', file });
    assert.equal(auth.password, 'oauth:frisk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TwitchAuth starter rent på en ulæselig tokenfil', () => {
  const { dir, file } = temp();
  try {
    writeFileSync(file, 'ikke json');
    const auth = new TwitchAuth({ accessToken: 'abc', refreshToken: 'r', file });
    assert.equal(auth.password, 'oauth:abc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh gemmer det nye token og den nye refresh token', async () => {
  const { dir, file } = temp();
  const realFetch = globalThis.fetch;

  try {
    // Twitch udsteder en NY refresh token ved hver fornyelse, og den gamle
    // holder op med at virke. Tabes den, er kæden brudt for altid.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ access_token: 'nyt-token', refresh_token: 'ny-refresh' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const auth = new TwitchAuth({
      accessToken: 'gammelt',
      refreshToken: 'gammel-refresh',
      clientId: 'id',
      clientSecret: 'hemmelig',
      file,
    });

    assert.equal(await auth.refresh(), true);
    assert.equal(auth.password, 'oauth:nyt-token');

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.accessToken, 'nyt-token');
    assert.equal(saved.refreshToken, 'ny-refresh');
    assert.ok(!existsSync(`${file}.tmp`), 'temp-filen skal være omdøbt væk');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh melder fejl tilbage frem for at kaste', async () => {
  const { dir, file } = temp();
  const realFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response('nope', { status: 400 });

    const auth = new TwitchAuth({
      accessToken: 'gammelt',
      refreshToken: 'r',
      clientSecret: 'hemmelig',
      file,
    });

    assert.equal(await auth.refresh(), false);
    // Et mislykket forsøg må ikke smide det token vi allerede har.
    assert.equal(auth.password, 'oauth:gammelt');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureFresh skelner et netværksudfald fra et dødt token', async () => {
  const { dir, file } = temp();
  const realFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => { throw new Error('ENOTFOUND'); };

    const auth = new TwitchAuth({ accessToken: 'a', refreshToken: 'r', clientSecret: 's', file });

    // Kan Twitch ikke nås, er tokenet ikke nødvendigvis dårligt — en fornyelse
    // her ville brænde refresh-tokenet af på en forbigående fejl.
    assert.equal(await auth.ensureFresh(), 'unknown');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureFresh fornyer når tokenet er afvist eller tæt på at udløbe', async () => {
  const { dir, file } = temp();
  const realFetch = globalThis.fetch;

  try {
    let phase = 'expired';
    globalThis.fetch = async (url) => {
      if (String(url).includes('/validate')) {
        if (phase === 'expired') return new Response('', { status: 401 });
        return new Response(JSON.stringify({ login: 'petcsbot', expires_in: 120 }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'nyt', refresh_token: 'r2' }), { status: 200 });
    };

    const auth = new TwitchAuth({ accessToken: 'a', refreshToken: 'r', clientSecret: 's', file });

    assert.equal(await auth.ensureFresh(), 'refreshed', '401 skal udløse fornyelse');

    phase = 'expiring';
    assert.equal(await auth.ensureFresh({ minSeconds: 3600 }), 'refreshed',
      '120 sekunder tilbage er under grænsen');

    assert.equal(await auth.ensureFresh({ minSeconds: 60 }), 'ok',
      '120 sekunder er rigeligt når grænsen er 60');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
