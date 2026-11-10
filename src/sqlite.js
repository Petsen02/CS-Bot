import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite til tracker-tilstanden.
 *
 * JSON-filen den afløser blev skrevet helt om ved hver pollrunde, så prisen
 * voksede med mængden af historik — præcis det der stod i vejen for at gemme
 * historik overhovedet. SQLite skriver kun de rækker der ændrede sig, så
 * filen kan rumme år uden at skriveprisen flytter sig.
 *
 * `node:sqlite` er indbygget i Node og kræver ingen pakke, så det tilføjer
 * ingen afhængighed og intet der skal kompileres på serveren. Til gengæld kom
 * det først i Node 22.5, og serveren her kører Node 21 — derfor er alt
 * valgfrit: `openDatabase` returnerer null når modulet mangler, og store'en
 * bliver på JSON. Den dag imaget opgraderes, skifter den af sig selv ved
 * næste genstart.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  player_id TEXT PRIMARY KEY,
  nickname  TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  player_id TEXT PRIMARY KEY,
  elo       INTEGER,
  taken_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  player_id   TEXT NOT NULL,
  match_id    TEXT NOT NULL,
  elo_delta   INTEGER,
  won         INTEGER,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, match_id)
);

-- Hvert historikopslag er "denne spiller, dette tidsrum", så indekset der
-- betyder noget parrer de to. Uden det skanner en sæsonopgørelse tabellen.
CREATE INDEX IF NOT EXISTS matches_by_time ON matches (player_id, recorded_at);

CREATE TABLE IF NOT EXISTS baselines (
  player_id TEXT NOT NULL,
  date_key  TEXT NOT NULL,
  elo       INTEGER NOT NULL,
  taken_at  INTEGER,
  PRIMARY KEY (player_id, date_key)
);

CREATE TABLE IF NOT EXISTS watch (
  player_id     TEXT PRIMARY KEY,
  nickname      TEXT,
  steam_id      TEXT,
  twitch        TEXT,
  added_at      INTEGER NOT NULL,
  last_asked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rankings (
  key     TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
`;

/** @returns en backend, eller null når denne Node ikke kan levere SQLite. */
export function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? {});
  } catch {
    return null;
  }
  if (!DatabaseSync || !file) return null;

  let db;
  try {
    mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);

    // WAL holder læsere ude af skriverens vej, hvilket betyder noget den dag
    // noget andet end botten læser filen. Den synkrone indstilling er den
    // sædvanlige makker: et strømsvigt kan koste de seneste øjeblikkes elo,
    // og næste poll læser alligevel forfra.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
  } catch {
    // En uskrivbar mappe eller en beskadiget fil må ikke tage botten med sig.
    return null;
  }

  const statements = {
    player: db.prepare('INSERT INTO players (player_id, nickname) VALUES (?, ?) '
      + 'ON CONFLICT(player_id) DO UPDATE SET nickname = excluded.nickname'),
    snapshot: db.prepare('INSERT INTO snapshots (player_id, elo, taken_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(player_id) DO UPDATE SET elo = excluded.elo, taken_at = excluded.taken_at'),
    match: db.prepare('INSERT INTO matches (player_id, match_id, elo_delta, won, recorded_at) '
      + 'VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id, match_id) DO UPDATE SET '
      + 'elo_delta = excluded.elo_delta, won = excluded.won, '
      + 'recorded_at = excluded.recorded_at'),
    baseline: db.prepare('INSERT INTO baselines (player_id, date_key, elo, taken_at) '
      + 'VALUES (?, ?, ?, ?) ON CONFLICT(player_id, date_key) DO NOTHING'),
    watch: db.prepare('INSERT INTO watch (player_id, nickname, steam_id, twitch, added_at, '
      + 'last_asked_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(player_id) DO UPDATE SET nickname = excluded.nickname, '
      + 'steam_id = excluded.steam_id, twitch = excluded.twitch, '
      + 'last_asked_at = excluded.last_asked_at'),
    ranking: db.prepare('INSERT INTO rankings (key, payload) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET payload = excluded.payload'),
    dropOldMatches: db.prepare('DELETE FROM matches WHERE recorded_at < ?'),
    dropOldBaselines: db.prepare('DELETE FROM baselines WHERE date_key < ?'),
    countRows: db.prepare('SELECT (SELECT COUNT(*) FROM players) + '
      + '(SELECT COUNT(*) FROM watch) AS total'),
  };

  // SQLite har hverken boolean eller forskel på null og undefined: alt der
  // gemmes skal være tal, tekst eller null, så værdier ensrettes på vejen ind.
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value) => (typeof value === 'string' && value ? value : null);
  const bool = (value) => (value === true ? 1 : value === false ? 0 : null);

  return {
    path: file,

    isEmpty() {
      return (statements.countRows.get()?.total ?? 0) === 0;
    },

    putPlayer(playerId, nickname) {
      statements.player.run(playerId, text(nickname));
    },

    putSnapshot(playerId, snapshot) {
      statements.snapshot.run(playerId, num(snapshot?.elo), num(snapshot?.at) ?? Date.now());
    },

    putMatch(playerId, matchId, record) {
      statements.match.run(playerId, matchId, num(record?.eloDelta), bool(record?.won),
        num(record?.at) ?? Date.now());
    },

    putBaseline(playerId, dateKey, entry) {
      statements.baseline.run(playerId, dateKey, num(entry?.elo) ?? 0, num(entry?.at));
    },

    putWatch(entry) {
      statements.watch.run(entry.playerId, text(entry.nickname), text(entry.steamId),
        text(entry.twitch), num(entry.addedAt) ?? Date.now(),
        num(entry.lastAskedAt) ?? Date.now());
    },

    putRanking(key, snapshot) {
      statements.ranking.run(key, JSON.stringify(snapshot ?? null));
    },

    prune(cutoffMs, keepFromDateKey) {
      statements.dropOldMatches.run(cutoffMs);
      statements.dropOldBaselines.run(keepFromDateKey);
    },

    /** Genskaber den form i hukommelsen som store'en altid har brugt. */
    readState() {
      const state = { version: 1, players: {}, watch: {}, rankings: {} };

      const player = (id, nickname) => {
        state.players[id] ??= { nickname: nickname ?? null, snapshot: null, matches: {}, baselines: {} };
        if (nickname) state.players[id].nickname = nickname;
        return state.players[id];
      };

      for (const row of db.prepare('SELECT * FROM players').all()) {
        player(row.player_id, row.nickname);
      }

      for (const row of db.prepare('SELECT * FROM snapshots').all()) {
        player(row.player_id).snapshot = { elo: row.elo, at: row.taken_at };
      }

      for (const row of db.prepare('SELECT * FROM matches').all()) {
        player(row.player_id).matches[row.match_id] = {
          eloDelta: row.elo_delta,
          won: row.won === null || row.won === undefined ? null : row.won === 1,
          at: row.recorded_at,
        };
      }

      for (const row of db.prepare('SELECT * FROM baselines').all()) {
        player(row.player_id).baselines[row.date_key] = { elo: row.elo, at: row.taken_at };
      }

      for (const row of db.prepare('SELECT * FROM watch').all()) {
        state.watch[row.player_id] = {
          playerId: row.player_id,
          nickname: row.nickname ?? null,
          steamId: row.steam_id ?? null,
          twitch: row.twitch ?? null,
          addedAt: row.added_at,
          lastAskedAt: row.last_asked_at,
        };
      }

      for (const row of db.prepare('SELECT * FROM rankings').all()) {
        try {
          state.rankings[row.key] = JSON.parse(row.payload);
        } catch {
          // En ulæselig række er ikke værd at vælte opstarten for.
        }
      }

      return state;
    },

    /** Flytter en eksisterende JSON-tilstand ind, én gang. */
    importState(existing) {
      for (const [playerId, entry] of Object.entries(existing?.players ?? {})) {
        this.putPlayer(playerId, entry.nickname);
        if (entry.snapshot) this.putSnapshot(playerId, entry.snapshot);

        for (const [matchId, record] of Object.entries(entry.matches ?? {})) {
          this.putMatch(playerId, matchId, record);
        }
        for (const [dateKey, baseline] of Object.entries(entry.baselines ?? {})) {
          if (baseline) this.putBaseline(playerId, dateKey, baseline);
        }
      }

      for (const entry of Object.values(existing?.watch ?? {})) {
        if (entry?.playerId) this.putWatch(entry);
      }
      for (const [key, snapshot] of Object.entries(existing?.rankings ?? {})) {
        this.putRanking(key, snapshot);
      }
    },
  };
}
