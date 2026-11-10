import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEP,
  truncate,
  formatPlayerRank,
  formatRanksMessage,
  formatSession,
  formatNextRank,
  formatLastGame,
  formatLobby,
  formatTop,
  formatMaps,
} from '../src/format.js';

test('truncate holder sig under Twitch-grænsen', () => {
  assert.equal(truncate('kort'), 'kort');

  const long = 'x'.repeat(600);
  const cut = truncate(long);
  assert.ok(cut.length <= 480);
  assert.ok(cut.endsWith('…'));
});

test('formatPlayerRank viser placering nær toppen og skjuler den derunder', () => {
  assert.equal(
    formatPlayerRank({ nickname: 'PETSEN', elo: 2347, level: 10, position: 412 }),
    'PETSEN LVL10 2347 elo (Rank#412)',
  );
  // Standardgrænsen er 1000, så 9999 er støj og udelades.
  assert.equal(
    formatPlayerRank({ nickname: 'PETSEN', elo: 2347, level: 10, position: 9999 }),
    'PETSEN LVL10 2347 elo',
  );
  assert.equal(
    formatPlayerRank({ nickname: 'PETSEN', elo: 2347, level: 10, position: null }),
    'PETSEN LVL10 2347 elo',
  );
});

test('formatRanksMessage nummererer og siger til når listen er tom', () => {
  const message = formatRanksMessage([
    { nickname: 'A', elo: 2400, level: 10 },
    { nickname: 'B', elo: 1800, level: 9 },
  ]);
  assert.ok(message.startsWith('1. A '));
  assert.ok(message.includes(`${SEP}2. B `));

  assert.equal(formatRanksMessage([]), 'Der er ingen spillere på listen endnu');
});

test('formatSession viser W/L, elo og firkanter', () => {
  assert.equal(
    formatSession({
      nickname: 'PETSEN',
      results: [true, true, false, true, false],
      eloTotal: 47,
      measuredCount: 5,
    }),
    'PETSEN: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥',
  );
});

test('formatSession siger det ligeud når intet blev målt', () => {
  // Et "0" ville læses som "du gik i nul", og et tomt felt ligner at
  // kommandoen er i stykker. Begge dele er værre end at sige det.
  const message = formatSession({
    nickname: 'PETSEN',
    results: [true, false],
    eloTotal: 0,
    measuredCount: 0,
  });

  assert.ok(message.includes('1W 1L'), message);
  assert.ok(message.includes('ingen elo-data endnu'), message);
  assert.ok(message.includes('måler fra næste kamp'), message);
  assert.ok(message.includes('🟩🟥'), message);
  assert.ok(!/[+-]?\d+ elo/.test(message), `måtte ikke vise et elo-tal: ${message}`);
});

test('formatSession markerer delvis måling', () => {
  const message = formatSession({
    nickname: 'PETSEN',
    results: [true, true, false],
    eloTotal: 25,
    measuredCount: 1,
  });
  assert.ok(message.includes('[1/3 målt]'), message);
});

test('formatSession siger det pænt når der ikke er spillet', () => {
  assert.equal(
    formatSession({ nickname: 'PETSEN', results: [], eloTotal: 0, measuredCount: 0 }),
    'PETSEN har ikke spillet FACEIT i dag',
  );
});

test('formatNextRank regner i elo og nævner wins når de kendes', () => {
  assert.equal(
    formatNextRank({
      nickname: 'PETSEN',
      elo: 1920,
      level: 9,
      next: { level: 10, min: 2001, needed: 81 },
      wins: 4,
    }),
    `PETSEN LVL9 1920 elo${SEP}mangler 81 elo til LVL10 (ca 4 wins)`,
  );
});

test('formatNextRank udelader wins-gæt uden måledata', () => {
  const message = formatNextRank({
    nickname: 'PETSEN',
    elo: 1920,
    level: 9,
    next: { level: 10, min: 2001, needed: 81 },
    wins: null,
  });
  assert.ok(!message.includes('ca'), message);
});

test('formatNextRank håndterer level 10', () => {
  const message = formatNextRank({ nickname: 'PETSEN', elo: 2347, level: 10, next: null });
  assert.ok(message.includes('højeste level'), message);
});

test('formatLastGame bruger to decimaler på K/D', () => {
  const message = formatLastGame({
    nickname: 'PETSEN',
    map: 'de_mirage',
    score: '13-9',
    won: true,
    kills: 24,
    deaths: 17,
    assists: 6,
    kd: 1.41,
    adr: 94.2,
    hs: 48,
  });
  assert.ok(message.includes('1.41 K/D'), message);
  assert.ok(message.includes('Mirage 13-9 W'), message);
  assert.ok(message.includes('94.2 ADR'), message);
});

test('formatLastGame udelader felter der mangler i stedet for at vise nul', () => {
  // ADR er ubekræftet i FACEIT's CS2-svar. "0.0 ADR" ville læses som et faktum.
  const message = formatLastGame({
    nickname: 'PETSEN',
    map: 'de_nuke',
    score: '8-13',
    won: false,
    kills: 14,
    deaths: 19,
    kd: 0.74,
  });
  assert.ok(!message.includes('ADR'), message);
  assert.ok(!message.includes('HS'), message);
  assert.ok(message.includes('0.74 K/D'), message);
});

test('formatLastGame siger til når elo ikke blev målt', () => {
  // Botten var nede da kampen sluttede. Et tomt felt ville læses som nul elo.
  const message = formatLastGame({
    nickname: 'DEWI', map: 'de_ancient', score: '13-10', won: true,
    kills: 20, deaths: 15, kd: 1.33, eloUnmeasured: true,
  });
  assert.ok(message.includes('elo ikke målt'), message);
});

test('formatLastGame tier om elo for en spiller botten ikke følger', () => {
  const message = formatLastGame({
    nickname: 'S1MPLE', map: 'de_dust2', score: '13-4', won: true,
    kills: 28, deaths: 9, kd: 3.11,
  });
  assert.ok(!message.includes('elo'), message);
});

test('et målt elo-tal slår beskeden om at det mangler', () => {
  const message = formatLastGame({
    nickname: 'DEWI', map: 'de_ancient', score: '13-10', won: true,
    kills: 20, deaths: 15, kd: 1.33, eloDelta: 25, eloUnmeasured: true,
  });
  assert.ok(message.includes('+25 elo'), message);
  assert.ok(!message.includes('ikke målt'), message);
});

test('formatLastGame siger til når der slet ikke var statistik', () => {
  assert.equal(
    formatLastGame({ nickname: 'PETSEN' }),
    'PETSEN — ingen statistik på seneste kamp',
  );
});

test('formatLobby viser snit og markerer delvise hold', () => {
  const message = formatLobby({
    nickname: 'PETSEN',
    map: 'de_inferno',
    status: 'ONGOING',
    teams: [
      { label: 'PETSENs hold', average: 2104, counted: 5, size: 5 },
      { label: 'modstandere', average: 2210.4, counted: 4, size: 5 },
    ],
  });
  assert.ok(message.includes('Igangværende: Inferno'), message);
  assert.ok(message.includes('2104 snit'), message);
  assert.ok(message.includes('(4/5)'), message);
});

test('formatLobby påstår ikke mere end botten kan se', () => {
  // MÅLT: en kø-kamp er usynlig for botten, så "er ikke i en FACEIT-kamp"
  // ville være et større udsagn end den kan stå inde for.
  const message = formatLobby({ nickname: 'PETSEN', teams: [] });

  assert.ok(message.startsWith('PETSEN er ikke i en ESEA- eller hub-kamp lige nu'), message);
  assert.ok(message.includes('kø-kampe kan botten ikke se'), message);
});

test('formatTop viser land og region, og kalder aldrig regionen "verden"', () => {
  const message = formatTop({
    nickname: 'PETSEN',
    elo: 2347,
    level: 10,
    country: 'DK',
    countryPosition: 12,
    region: 'EU',
    regionPosition: 418,
    at: null,
  });
  assert.ok(message.includes('DK #12'), message);
  assert.ok(message.includes('EU #418'), message);
  // FACEIT har ingen global rangliste, så ordet må ikke optræde.
  assert.ok(!/verden/i.test(message), message);
});

test('formatTop udelader en placering der mangler frem for at påstå noget', () => {
  // MÅLT: en spiller som #6024 på EU-ranglisten fik ingen landeplacering, og
  // en delmængde af EU kan ikke mangle ham. "Uden for listen" ville være en
  // påstand vi ikke kan bakke op.
  const message = formatTop({
    nickname: 'vigg0',
    elo: 3097,
    level: 10,
    country: 'DK',
    countryPosition: null,
    region: 'EU',
    regionPosition: 6024,
    at: null,
  });

  assert.ok(message.includes('EU #6024'), message);
  assert.ok(!message.includes('DK'), `landet måtte ikke nævnes: ${message}`);
});

test('formatTop siger det ligeud når ingen placering kendes', () => {
  const message = formatTop({
    nickname: 'RASMUS',
    elo: 1400,
    level: 7,
    country: 'DK',
    countryPosition: null,
    region: 'EU',
    regionPosition: null,
    at: null,
  });
  assert.ok(message.includes('ingen placering'), message);
});

test('formatMaps udelader "værst" når der kun er ét map', () => {
  const single = { map: 'de_nuke', winRate: 68, matches: 31 };
  const message = formatMaps({ nickname: 'PETSEN', best: single, worst: single });
  assert.ok(message.includes('bedst Nuke 68% (31)'), message);
  assert.ok(!message.includes('værst'), message);
});

test('formatMaps siger til uden data', () => {
  assert.equal(
    formatMaps({ nickname: 'PETSEN', best: null }),
    'PETSEN — ingen map-statistik endnu',
  );
});

test('formatTeam viser medspillerne med level', async () => {
  const { formatTeam } = await import('../src/format.js');

  const message = formatTeam({
    nickname: 'Petsen',
    map: 'de_mirage',
    mates: [
      { nickname: 'vigg0', level: 10 },
      { nickname: 'Rasmus', elo: 1800 },
      { nickname: 'Jonas', level: null, elo: null },
    ],
  });

  assert.ok(message.includes('Mirage'), message);
  assert.ok(message.includes('vigg0 LVL10'), message);
  // Level udledes af elo når det ikke står direkte.
  assert.ok(message.includes('Rasmus LVL9'), message);
  // Uden begge dele vises navnet alene frem for et gæt.
  assert.ok(message.includes('Jonas'), message);
  assert.ok(!message.includes('Jonas LVL'), message);
});

test('formatTeam siger til når der ingen kamp er', async () => {
  const { formatTeam } = await import('../src/format.js');

  const message = formatTeam({ nickname: 'Petsen', mates: [] });

  assert.ok(message.startsWith('Petsen er ikke i en ESEA- eller hub-kamp lige nu'), message);
  assert.ok(message.includes('kø-kampe kan botten ikke se'), message);
  // En kø-kamp er usynlig for botten, så svaret skal pege videre frem for at
  // ligne en blindgyde.
  assert.ok(message.includes('!eseahold'), message);
});

test('formatEseaTeam lister truppen', async () => {
  const { formatEseaTeam } = await import('../src/format.js');

  const message = formatEseaTeam({
    nickname: 'vigg0',
    teamName: 'Elitemilijoet',
    members: ['vigg0', 'Rasmus', 'Jonas', 'Mikkel', 'Anders'],
  });

  assert.equal(message, 'vigg0 │ Elitemilijoet │ vigg0 · Rasmus · Jonas · Mikkel · Anders');
});

test('formatEseaTeam siger til uden hold', async () => {
  const { formatEseaTeam } = await import('../src/format.js');

  assert.equal(
    formatEseaTeam({ nickname: 'vigg0', members: [] }),
    'vigg0 er ikke på et ESEA-hold lige nu',
  );
});

test('formatSession viser dagens samlede elo når alt er målt', () => {
  const message = formatSession({
    nickname: 'vigg0',
    results: [true, true, false, true, false],
    eloTotal: 47,
    measuredCount: 5,
  });

  assert.equal(message, 'vigg0: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥');
  assert.ok(!message.includes('målt]'), 'ingen delvis-markering når alt er målt');
});
