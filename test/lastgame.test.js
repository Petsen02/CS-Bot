import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLastGame, formatMultiKill } from '../src/format.js';
import { readMatchStats } from '../src/commands.js';

/** Et fuldt statistiksvar, som FACEIT formentlig leverer det. */
function payload(overrides = {}, roundOverrides = {}) {
  return {
    rounds: [
      {
        round_stats: { Map: 'de_mirage', Score: '13 / 9', Rounds: '22', ...roundOverrides },
        teams: [
          {
            players: [
              {
                player_id: 'me',
                player_stats: {
                  Kills: '24',
                  Deaths: '17',
                  Assists: '6',
                  'K/D Ratio': '1.41',
                  'K/R Ratio': '1.09',
                  ADR: '94.2',
                  Damage: '2451',
                  'Headshots %': '48',
                  'Enemies Flashed': '7',
                  'Utility Damage': '312',
                  'FACEIT Rating': '1.18',
                  'Round Swing': '4.23',
                  MVPs: '5',
                  'Penta Kills': '1',
                  'Quadro Kills': '0',
                  'Triple Kills': '2',
                  'First Kills': '2',
                  'Entry Count': '5',
                  'Entry Wins': '3',
                  '1v1Wins': '1',
                  '1v2Wins': '1',
                  Result: '1',
                  ...overrides,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

test('readMatchStats henter alle de felter !lastgame viser', () => {
  const stats = readMatchStats(payload(), 'me');

  assert.equal(stats.kills, 24);
  assert.equal(stats.deaths, 17);
  assert.equal(stats.assists, 6);
  assert.equal(stats.kd, 1.41);
  assert.equal(stats.kr, 1.09);
  assert.equal(stats.adr, 94.2);
  assert.equal(stats.damage, 2451);
  assert.equal(stats.hs, 48);
  assert.equal(stats.flashed, 7);
  assert.equal(stats.utilDamage, 312);
  assert.equal(stats.rating, 1.18);
  assert.equal(stats.swing, 4.23);
  assert.equal(stats.mvps, 5);
  assert.equal(stats.aces, 1);
  assert.equal(stats.triples, 2);
  // "Entry Count" er forsøg, ikke kills — entryKills skal tage First Kills.
  assert.equal(stats.entryKills, 2);
  assert.equal(stats.entryAttempts, 5);
  assert.equal(stats.clutches, 2, '1v1 og 1v2 skal lægges sammen');
  assert.equal(stats.rounds, 22);
});

test('readMatchStats udregner K/R fra kills og runder', () => {
  const raw = payload();
  delete raw.rounds[0].teams[0].player_stats;
  delete raw.rounds[0].teams[0].players[0].player_stats['K/R Ratio'];

  const stats = readMatchStats(raw, 'me');
  assert.ok(Math.abs(stats.kr - 24 / 22) < 1e-9, `fik ${stats.kr}`);
});

test('readMatchStats udregner ADR fra damage og runder', () => {
  const raw = payload();
  delete raw.rounds[0].teams[0].players[0].player_stats.ADR;

  const stats = readMatchStats(raw, 'me');
  assert.ok(Math.abs(stats.adr - 2451 / 22) < 1e-9, `fik ${stats.adr}`);
});

test('readMatchStats ganger enemies flashed op fra en pr-runde-værdi', () => {
  const raw = payload();
  const ps = raw.rounds[0].teams[0].players[0].player_stats;
  delete ps['Enemies Flashed'];
  ps['Enemies Flashed per Round'] = '0.5';

  assert.equal(readMatchStats(raw, 'me').flashed, 11, '0.5 * 22 runder');
});

test('readMatchStats lader rating og swing være null når de ikke findes', () => {
  // FACEIT Rating og Round Swing kom til med Season 8 og er ikke bekræftet i
  // Data API'et. Mangler de, skal de udelades — ikke blive nul.
  const raw = payload();
  const ps = raw.rounds[0].teams[0].players[0].player_stats;
  delete ps['FACEIT Rating'];
  delete ps['Round Swing'];

  const stats = readMatchStats(raw, 'me');
  assert.equal(stats.rating, null);
  assert.equal(stats.swing, null);
});

test('readMatchStats accepterer alternative navne for rating og swing', () => {
  const raw = payload();
  const ps = raw.rounds[0].teams[0].players[0].player_stats;
  delete ps['FACEIT Rating'];
  delete ps['Round Swing'];
  ps.Rating = '1.22';
  ps.Swing = '-3.1';

  const stats = readMatchStats(raw, 'me');
  assert.equal(stats.rating, 1.22);
  assert.equal(stats.swing, -3.1);
});

test('readMatchStats giver null for clutches når ingen af felterne findes', () => {
  const raw = payload();
  const ps = raw.rounds[0].teams[0].players[0].player_stats;
  delete ps['1v1Wins'];
  delete ps['1v2Wins'];

  assert.equal(readMatchStats(raw, 'me').clutches, null);
});

const full = {
  nickname: 'PETSEN',
  map: 'de_mirage',
  score: '13-9',
  won: true,
  kills: 24,
  deaths: 17,
  assists: 6,
  kd: 1.41,
  kr: 1.09,
  adr: 94.2,
  damage: 2451,
  hs: 48,
  flashed: 7,
  utilDamage: 312,
  rating: 1.18,
  swing: 4.23,
  mvps: 5,
  aces: 1,
  triples: 2,
  entryKills: 4,
  clutches: 2,
  eloDelta: 25,
};

test('formatLastGame viser alt det brugbare og holder sig under Twitch-grænsen', () => {
  const message = formatLastGame(full);

  for (const expected of [
    'Mirage 13-9 W', '24-17-6', '1.41 K/D', '1.09 K/R', '94.2 ADR',
    '2451 dmg', '48% HS', '7 flashed', '1.18 rating', '+4.2 swing', '+25 elo',
  ]) {
    assert.ok(message.includes(expected), `mangler "${expected}" i: ${message}`);
  }

  // 500 er Twitch's grænse; der skal være plads til "@viewer " foran.
  assert.ok(message.length < 450, `for lang: ${message.length}`);
});

test('formatLastGame viser swing med fortegn, også negativt', () => {
  assert.ok(formatLastGame({ ...full, swing: 4.23 }).includes('+4.2 swing'));
  assert.ok(formatLastGame({ ...full, swing: -3.17 }).includes('-3.2 swing'));
});

test('formatLastGame dropper hele felter ved pladsmangel, aldrig halve', () => {
  const message = formatLastGame(full, { budget: 120 });

  assert.ok(message.length <= 120, `over budget: ${message.length}`);
  // Et afklippet tal ville være værre end intet: hvert felt skal være helt.
  for (const field of message.split(' │ ').slice(1)) {
    assert.ok(field.length > 0);
    assert.ok(!field.endsWith('…'), `halvt felt: "${field}"`);
  }
  // De vigtigste felter skal være dem der bliver tilbage.
  assert.ok(message.includes('1.41 K/D'), message);
  assert.ok(!message.includes('MVP'), 'lavest prioriterede felt skulle være droppet');
});

test('formatLastGame beholder nicket selv med et minimalt budget', () => {
  assert.equal(formatLastGame(full, { budget: 5 }), 'PETSEN');
});

test('formatLastGame udelader felter uden data i stedet for at vise nul', () => {
  const sparse = {
    nickname: 'PETSEN',
    map: 'de_nuke',
    score: '8-13',
    won: false,
    kills: 14,
    deaths: 19,
    kd: 0.74,
  };
  const message = formatLastGame(sparse);

  for (const absent of ['ADR', 'HS', 'rating', 'swing', 'flashed', 'dmg', 'MVP']) {
    assert.ok(!message.includes(absent), `"${absent}" burde være udeladt: ${message}`);
  }
  assert.ok(message.includes('0.74 K/D'), message);
});

test('formatMultiKill nævner kun den højeste', () => {
  assert.equal(formatMultiKill({ aces: 1, quads: 2, triples: 3 }), '1 ace');
  assert.equal(formatMultiKill({ aces: 2, quads: 0, triples: 0 }), '2 aces');
  assert.equal(formatMultiKill({ aces: 0, quads: 1, triples: 3 }), '1 quad');
  assert.equal(formatMultiKill({ aces: 0, quads: 0, triples: 3 }), '3 triple');
  assert.equal(formatMultiKill({ aces: 0, quads: 0, triples: 0 }), null);
  assert.equal(formatMultiKill({}), null);
});

/**
 * Regressionstests for fejl fundet mod det rigtige FACEIT API.
 *
 * Historikken svarer "finished" med småt, mens /matches/{id} svarer "FINISHED"
 * med stort. Den forskel brød to kommandoer på hver sin måde, så den er
 * fastholdt her.
 */
test('isFinished accepterer begge skrivemåder af status', async () => {
  const { isFinished, isLive, normalizeStatus } = await import('../src/faceit.js');

  // MÅLT fra /players/{id}/history: små bogstaver.
  assert.equal(isFinished('finished'), true);
  // MÅLT fra /matches/{id}: store bogstaver.
  assert.equal(isFinished('FINISHED'), true);
  // Historikposter uden status er spillet færdig.
  assert.equal(isFinished(undefined), true);
  assert.equal(isFinished('ONGOING'), false);

  assert.equal(normalizeStatus(' finished '), 'FINISHED');
  assert.equal(normalizeStatus(null), null);
});

test('isLive udelukker aflyste og afbrudte kampe', async () => {
  const { isLive } = await import('../src/faceit.js');

  assert.equal(isLive('ONGOING'), true);
  assert.equal(isLive('ready'), true);
  // Den oprindelige fejl: alt der ikke var præcis "FINISHED" talte som i gang.
  assert.equal(isLive('finished'), false);
  assert.equal(isLive('FINISHED'), false);
  // En aflyst kamp ville ellers blive vist som igangværende for altid.
  assert.equal(isLive('CANCELLED'), false);
  assert.equal(isLive('aborted'), false);
  assert.equal(isLive(null), false);
});

test('readPosition læser position, og tager 0 som uplaceret', async () => {
  const { readPosition } = await import('../src/faceit.js');

  assert.equal(readPosition({ position: 412 }, 'me'), 412);
  // MÅLT: en uplaceret spiller får position 0. Det er et svar, ikke et hul.
  assert.equal(readPosition({ position: 0, items: [], start: 0, end: 0 }, 'me'), null);
  assert.equal(readPosition({}, 'me'), null);
});

test('readPosition udleder placeringen af udsnittet når position mangler', async () => {
  const { readPosition } = await import('../src/faceit.js');

  // start + indeks + 1, så det virker uanset om position er 0-indekseret.
  const payload = {
    start: 400,
    end: 403,
    items: [{ player_id: 'a' }, { player_id: 'me' }, { player_id: 'b' }],
  };
  assert.equal(readPosition(payload, 'me'), 402);

  // Spilleren er ikke i udsnittet: intet at udlede.
  assert.equal(readPosition(payload, 'ukendt'), null);
});
