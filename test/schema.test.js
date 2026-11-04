import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPlayer } from '../src/faceit.js';
import { didWin, readMatchStats } from '../src/commands.js';

/**
 * FACEIT's skema kunne ikke verificeres da koden blev skrevet, så disse
 * parsere er defensive med vilje. Testene fastholder to ting: at hver kendt
 * skemaform læses, og at en ukendt form giver null frem for at kaste — en
 * fejl her ville ellers vælte en chatkommando uden spor af hvorfor.
 */

test('readPlayer læser elo fra games.cs2', () => {
  const player = readPlayer({
    player_id: 'abc',
    nickname: 'PETSEN',
    country: 'dk',
    games: {
      cs2: {
        faceit_elo: 2347,
        skill_level: 10,
        game_player_id: '76561198000000000',
        region: 'EU',
      },
    },
  });

  assert.equal(player.playerId, 'abc');
  assert.equal(player.elo, 2347);
  assert.equal(player.level, 10);
  assert.equal(player.steamId, '76561198000000000');
  assert.equal(player.country, 'DK');
  assert.equal(player.region, 'EU');
});

test('readPlayer læser også den flade skemaform', () => {
  const player = readPlayer({
    player_id: 'abc',
    nickname: 'PETSEN',
    faceit_elo: 1820,
    skill_level: 9,
    steam_id_64: '76561198000000000',
  });

  assert.equal(player.elo, 1820);
  assert.equal(player.level, 9);
  assert.equal(player.steamId, '76561198000000000');
});

test('readPlayer giver null-felter i stedet for at kaste', () => {
  assert.equal(readPlayer(null), null);
  assert.equal(readPlayer('ikke et objekt'), null);

  const empty = readPlayer({});
  assert.equal(empty.elo, null);
  assert.equal(empty.level, null);
  assert.equal(empty.playerId, null);
});

const historyItem = {
  match_id: 'm1',
  finished_at: 1_762_000_000,
  status: 'FINISHED',
  results: { winner: 'faction1' },
  teams: {
    faction1: { team_id: 't1', players: [{ player_id: 'me' }, { player_id: 'other' }] },
    faction2: { team_id: 't2', players: [{ player_id: 'enemy' }] },
  },
};

test('didWin finder spillerens hold og sammenligner med vinderen', () => {
  assert.equal(didWin(historyItem, 'me'), true);
  assert.equal(didWin(historyItem, 'enemy'), false);
});

test('didWin matcher vinderen på team_id såvel som nøgle', () => {
  const byTeamId = { ...historyItem, results: { winner: 't2' } };
  assert.equal(didWin(byTeamId, 'enemy'), true);
  assert.equal(didWin(byTeamId, 'me'), false);
});

test('didWin siger "ved ikke" frem for at gætte', () => {
  // Ingen vinder, spilleren ikke på noget hold, eller slet ingen data.
  assert.equal(didWin({ ...historyItem, results: {} }, 'me'), null);
  assert.equal(didWin(historyItem, 'ukendt'), null);
  assert.equal(didWin(null, 'me'), null);
  assert.equal(didWin({}, 'me'), null);
});

const statsPayload = {
  rounds: [
    {
      round_stats: { Map: 'de_mirage', Score: '13 / 9' },
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
                'Headshots %': '48',
                ADR: '94.2',
                Result: '1',
              },
            },
          ],
        },
      ],
    },
  ],
};

test('readMatchStats plukker spillerens række ud', () => {
  const stats = readMatchStats(statsPayload, 'me');

  assert.equal(stats.map, 'de_mirage');
  assert.equal(stats.score, '13 / 9');
  assert.equal(stats.kills, 24);
  assert.equal(stats.deaths, 17);
  assert.equal(stats.assists, 6);
  assert.equal(stats.kd, 1.41);
  assert.equal(stats.adr, 94.2);
  assert.equal(stats.hs, 48);
  assert.equal(stats.won, true);
});

test('readMatchStats udregner K/D når feltet mangler', () => {
  const payload = structuredClone(statsPayload);
  delete payload.rounds[0].teams[0].players[0].player_stats['K/D Ratio'];

  const stats = readMatchStats(payload, 'me');
  assert.ok(Math.abs(stats.kd - 24 / 17) < 1e-9);
});

test('readMatchStats giver null for ADR når feltet ikke findes', () => {
  // ADR var det mest usikre felt. Det skal mangle, ikke blive nul.
  const payload = structuredClone(statsPayload);
  delete payload.rounds[0].teams[0].players[0].player_stats.ADR;

  assert.equal(readMatchStats(payload, 'me').adr, null);
});

test('readMatchStats returnerer null når spilleren ikke er i svaret', () => {
  assert.equal(readMatchStats(statsPayload, 'ingen'), null);
  assert.equal(readMatchStats({}, 'me'), null);
  assert.equal(readMatchStats(null, 'me'), null);
});

/**
 * MÅLT mod det rigtige API: /players?nickname= er versalfølsomt. "vigg0"
 * findes, "Vigg0" giver 404. Seere skriver navne som de husker dem, så
 * opslaget falder tilbage til søgningen — men kun på et eksakt match.
 */
test('pickSearchMatch tager kun et match der er identisk bortset fra versaler', async () => {
  const { pickSearchMatch } = await import('../src/faceit.js');

  const items = [
    { player_id: '1', nickname: 'vigg0r' },
    { player_id: '2', nickname: 'Vigg0' },
    { player_id: '3', nickname: 'viggo' },
  ];

  assert.equal(pickSearchMatch(items, 'vigg0').player_id, '2');
  assert.equal(pickSearchMatch(items, 'VIGG0').player_id, '2');
  assert.equal(pickSearchMatch(items, 'viggo').player_id, '3');
});

test('pickSearchMatch afviser et fuzzy resultat frem for at svare forkert', async () => {
  const { pickSearchMatch } = await import('../src/faceit.js');

  // FACEIT's søgning er fuzzy. Det første resultat er ikke nødvendigvis den
  // spiller seeren spurgte om, og et forkert svar er værre end intet.
  const items = [{ player_id: '1', nickname: 'vigg0r' }, { player_id: '2', nickname: 'vigg00' }];

  assert.equal(pickSearchMatch(items, 'vigg0'), null);
  assert.equal(pickSearchMatch([], 'vigg0'), null);
  assert.equal(pickSearchMatch(null, 'vigg0'), null);
  assert.equal(pickSearchMatch(items, ''), null);
});
