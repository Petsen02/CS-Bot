import { config } from './config.js';
import { TtlCache } from './cache.js';
import { RateLimiter } from './limiter.js';

/**
 * Klient til FACEIT Data API v4.
 *
 * ADVARSEL — feltnavnene og stierne herunder er IKKE bekræftet mod FACEIT's
 * dokumentation: alle faceit.com-værter var blokeret af netværkspolitikken i
 * det miljø koden blev skrevet i. De stammer fra dokumentationsuddrag og
 * community-wrappere. `npm run check` er skrevet til at afsløre afvigelser med
 * det samme, og hver udtrækning herunder er defensiv: et felt der ligger et
 * andet sted end forventet giver null frem for at vælte en chatkommando.
 *
 * Verificér mod en rigtig nøgle før produktion.
 */

/** En API-fejl vi kan oversætte til en fornuftig chatbesked. */
export class FaceitError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'FaceitError';
    this.kind = kind;
    this.status = status;
  }
}

// Ét budget for hele API'et: FACEIT dokumenterer ikke et per-region-budget,
// så at antage flere ville risikere 429 frem for blot at være langsom.
const limiter = new RateLimiter(config.faceit.limits);

// Caches er nøglet på emne. player_id er uforanderligt for et nick, og en
// færdigspillet kamp ændrer sig aldrig, så de har TTL Infinity med en
// størrelsesgrænse. Elo skifter hele tiden og får en kort TTL.
const identityCache = new TtlCache(Infinity, 1000);
const playerCache = new TtlCache(config.rankCacheMs, 500);
const matchCache = new TtlCache(Infinity, 50);
const statsCache = new TtlCache(5 * 60_000, 200);
const rankingCache = new TtlCache(10 * 60_000, 200);

function describe(status) {
  switch (status) {
    case 401:
    case 403:
      return new FaceitError('auth', 'FACEIT API key rejected — expired or invalid', status);
    case 404:
      return new FaceitError('not_found', 'Not found', status);
    case 429:
      return new FaceitError('rate_limit', 'Rate limited by FACEIT', status);
    case 500:
    case 502:
    case 503:
    case 504:
      return new FaceitError('unavailable', 'FACEIT API is having problems', status);
    default:
      return new FaceitError('unknown', `Unexpected FACEIT API status ${status}`, status);
  }
}

/**
 * Eksporteret, så esea.js kan dele samme limiter, retry og fejloversættelse.
 * Ét budget for hele API'et er hele pointen — to klienter med hver sin tæller
 * ville tilsammen kunne overskride det uden at nogen af dem så det.
 */
export async function request(path, { retries = 2, params } = {}) {
  const url = new URL(`${config.faceit.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Hvert kald venter sin tur, så byger står i kø i stedet for at tjene 429.
    await limiter.acquire();

    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.faceit.apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      lastError = new FaceitError('network', `FACEIT API unreachable: ${cause.message}`);
      continue; // Netværksfejl er værd at prøve igen.
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch (cause) {
        throw new FaceitError('unknown', `FACEIT API returned invalid JSON: ${cause.message}`);
      }
    }

    const error = describe(response.status);

    // 404 og afvist nøgle bliver ikke bedre af at spørge igen.
    if (error.kind === 'not_found' || error.kind === 'auth') throw error;

    lastError = error;

    // Respektér Retry-After når den findes, ellers voksende ventetid.
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 250 * 2 ** attempt;

    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw lastError ?? new FaceitError('unknown', 'FACEIT API failed');
}

/**
 * Plukker de felter vi bruger ud af et spillersvar.
 *
 * Defensivt med vilje: skemaet er ubekræftet, og elo har i forskellige
 * wrappere ligget både under games.cs2 og i et fladt felt. Et manglende felt
 * giver null, så en kommando kan sige "ingen elo" i stedet for at kaste.
 */
export function readPlayer(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const game = payload.games?.[config.faceit.game] ?? {};

  const elo = Number(game.faceit_elo ?? payload.faceit_elo);
  const level = Number(game.skill_level ?? payload.skill_level);

  return {
    playerId: payload.player_id ?? null,
    nickname: payload.nickname ?? null,
    country: payload.country ? String(payload.country).toUpperCase() : null,
    // Steam-ID'et ligger som game_player_id for CS2, men et fladt steam_id_64
    // optræder også i ældre svar.
    steamId: game.game_player_id ?? payload.steam_id_64 ?? null,
    region: game.region ?? null,
    elo: Number.isFinite(elo) ? elo : null,
    level: Number.isFinite(level) ? level : null,
  };
}

/** Slår et nick op. Resultatet er identiteten, ikke elo — den caches kort. */
export async function getPlayerByNickname(nickname) {
  const key = `nick:${nickname.toLowerCase()}`;

  const cached = identityCache.get(key);
  if (cached) return refreshPlayer(cached.playerId);

  const payload = await request('/players', {
    params: { nickname, game: config.faceit.game },
  });

  const player = readPlayer(payload);
  if (!player?.playerId) throw new FaceitError('not_found', 'Not found', 404);

  identityCache.set(key, { playerId: player.playerId });
  playerCache.set(`id:${player.playerId}`, Promise.resolve(player));
  return player;
}

/** Slår et SteamID64 op — det streamere oftest har ved hånden. */
export async function getPlayerBySteamId(steamId) {
  const key = `steam:${steamId}`;

  const cached = identityCache.get(key);
  if (cached) return refreshPlayer(cached.playerId);

  const payload = await request('/players', {
    params: { game: config.faceit.game, game_player_id: steamId },
  });

  const player = readPlayer(payload);
  if (!player?.playerId) throw new FaceitError('not_found', 'Not found', 404);

  identityCache.set(key, { playerId: player.playerId });
  playerCache.set(`id:${player.playerId}`, Promise.resolve(player));
  return player;
}

/** Nuværende elo og level for et kendt player_id. */
export function refreshPlayer(playerId) {
  return playerCache.wrap(`id:${playerId}`, async () => {
    const payload = await request(`/players/${encodeURIComponent(playerId)}`);
    const player = readPlayer(payload);
    if (!player?.playerId) throw new FaceitError('not_found', 'Not found', 404);
    return player;
  });
}

/** Slår op ud fra hvad en mod skrev: nick, SteamID64 eller profillink. */
export function resolvePlayer(ref) {
  return ref.kind === 'steam'
    ? getPlayerBySteamId(ref.value)
    : getPlayerByNickname(ref.value);
}

/**
 * Kamphistorik, nyeste først.
 *
 * `from`/`to` er sekunder, ikke millisekunder. Flere forumtråde beskriver tomme
 * `items` ved høje offsets, så alt her spørger med et tidsvindue frem for at
 * paginere dybt.
 */
export async function getHistory(playerId, { from, to, limit = 20 } = {}) {
  const payload = await request(`/players/${encodeURIComponent(playerId)}/history`, {
    params: {
      game: config.faceit.game,
      limit,
      from: from ? Math.floor(from / 1000) : undefined,
      to: to ? Math.floor(to / 1000) : undefined,
    },
  });

  return Array.isArray(payload?.items) ? payload.items : [];
}

/** Kampens opsætning og status. ONGOING-kampe er det !lobby lever af. */
export function getMatch(matchId) {
  return matchCache.wrap(`match:${matchId}`, async () => {
    const payload = await request(`/matches/${encodeURIComponent(matchId)}`);

    // En igangværende kamp må ikke caches for evigt — den bliver færdig.
    if (payload?.status && payload.status !== 'FINISHED') {
      matchCache.set(`match:${matchId}`, Promise.resolve(payload), 30_000);
    }

    return payload;
  });
}

/** Statistik pr. spiller for en færdig kamp. */
export function getMatchStats(matchId) {
  return matchCache.wrap(`stats:${matchId}`, () =>
    request(`/matches/${encodeURIComponent(matchId)}/stats`));
}

/** Livstidsstatistik og segmenter pr. map. */
export function getPlayerStats(playerId) {
  return statsCache.wrap(`stats:${playerId}`, () =>
    request(`/players/${encodeURIComponent(playerId)}/stats/${config.faceit.game}`));
}

/**
 * Spillerens placering i en region, eventuelt filtreret til ét land.
 *
 * Det er sådan !top får både en dansk og en regional placering: samme endpoint,
 * to kald, hvoraf det ene har country sat.
 *
 * Der findes ingen global placering — regionen er en del af stien — så en
 * "verdensplacering" kan ikke hentes, og botten påstår derfor ikke at have en.
 */
export function getRanking(region, playerId, country) {
  const key = `rank:${region}:${country ?? '-'}:${playerId}`;

  return rankingCache.wrap(key, async () => {
    const payload = await request(
      `/rankings/games/${config.faceit.game}/regions/${encodeURIComponent(region)}`
        + `/players/${encodeURIComponent(playerId)}`,
      { params: { country, limit: 1 } },
    );

    // Placeringen har optrådt både som `position` og som en start-offset på
    // det returnerede udsnit. Begge læses, 1-indekseret som chatten forventer.
    const position = Number(
      payload?.position ?? payload?.current_page ?? payload?.start,
    );

    return {
      position: Number.isFinite(position) && position > 0 ? position : null,
      raw: payload,
    };
  });
}

/** Regionens leaderboard — bruges til at vise hvad Challenger-grænsen er. */
export function getLeaderboard(region, { limit = 1, offset = 0, country } = {}) {
  return request(`/rankings/games/${config.faceit.game}/regions/${encodeURIComponent(region)}`, {
    params: { limit, offset, country },
  });
}
