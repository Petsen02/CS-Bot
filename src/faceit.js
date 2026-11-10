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

// Igangværende kampe ændrer sig hele tiden, men en byge af kommandoer i
// chatten skal stadig dele ét kald.
const liveCache = new TtlCache(30_000, 100);

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

/**
 * Vælger den rigtige blandt søgeresultater.
 *
 * Kun et eksakt match bortset fra versaler accepteres. FACEIT's søgning er
 * ordentligt fuzzy — "vigg0" giver også "vigg0r" og "Viggo" — og at tage det
 * første resultat ville svare om en tilfældig anden spiller, hvilket er værre
 * end at sige at nicket ikke findes.
 */
export function pickSearchMatch(items, nickname) {
  if (!Array.isArray(items)) return null;

  const wanted = String(nickname ?? '').trim().toLowerCase();
  if (!wanted) return null;

  return items.find((item) => String(item?.nickname ?? '').toLowerCase() === wanted) ?? null;
}

/**
 * Finder en spiller via søgningen i stedet for et direkte opslag.
 *
 * MÅLT: /players?nickname= er VERSALFØLSOMT. "vigg0" findes, "Vigg0" giver 404.
 * Seere skriver navne som de husker dem, ikke som de er stavet, så et direkte
 * opslag alene ville fejle konstant i en chat.
 */
export async function searchPlayerByNickname(nickname) {
  const payload = await request('/search/players', {
    params: { nickname, game: config.faceit.game, limit: 20 },
  });

  const match = pickSearchMatch(payload?.items, nickname);
  if (!match?.player_id) return null;

  // Søgeresultater er magre og mangler elo, så den fulde profil hentes.
  return refreshPlayer(match.player_id);
}

/** Slår et nick op. Resultatet er identiteten, ikke elo — den caches kort. */
export async function getPlayerByNickname(nickname) {
  const key = `nick:${nickname.toLowerCase()}`;

  const cached = identityCache.get(key);
  if (cached) return refreshPlayer(cached.playerId);

  let player = null;

  try {
    player = readPlayer(await request('/players', {
      params: { nickname, game: config.faceit.game },
    }));
  } catch (error) {
    // Et 404 her betyder bare "ikke stavet præcis sådan" — søgningen kan
    // stadig finde den. Alt andet er en rigtig fejl og skal op.
    if (error.kind !== 'not_found') throw error;
  }

  if (!player?.playerId) {
    player = await searchPlayerByNickname(nickname);
  }

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

/**
 * Kampstatus, normaliseret.
 *
 * MÅLT: /players/{id}/history svarer "finished" med SMÅT, mens /matches/{id}
 * svarer "FINISHED" med STORT. En direkte sammenligning mod "FINISHED" fandt
 * derfor aldrig en færdig kamp i historikken — !lastgame svarede "ingen
 * færdige kampe" for alle, og !lobby troede hver eneste afsluttede kamp var
 * i gang. Alt sammenlignes nu i versaler.
 */
export function normalizeStatus(status) {
  if (status === null || status === undefined || status === '') return null;
  return String(status).trim().toUpperCase();
}

/** Kampe uden status kommer fra historikken, hvor de altid er spillet færdig. */
export function isFinished(status) {
  const value = normalizeStatus(status);
  return value === null || value === 'FINISHED';
}

/**
 * Om kampen kører lige nu.
 *
 * Aflyste og afbrudte kampe er hverken færdige eller i gang. Uden dem her
 * ville !lobby vise en aflyst kamp som "igangværende" i al evighed.
 */
export function isLive(status) {
  const value = normalizeStatus(status);
  if (value === null) return false;
  return !['FINISHED', 'CANCELLED', 'CANCELED', 'ABORTED'].includes(value);
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

    return { position: readPosition(payload, playerId), raw: payload };
  });
}

/**
 * Placeringen ud af et rankings-svar.
 *
 * MÅLT: svaret har nøglerne position, items, start, end — altså et udsnit af
 * ranglisten omkring spilleren, plus en position.
 *
 * For en uplaceret spiller er position 0, hvilket er et gyldigt svar og ikke
 * et manglende felt: FACEIT's ranglister dækker kun Challenger-feltet. Derfor
 * er 0 "uden for listen", ikke "ved ikke".
 *
 * Er position fraværende, udledes placeringen i stedet af udsnittet: spillerens
 * indeks i items lagt til start. Det er robust over for om position skulle vise
 * sig at være 0-indekseret, hvilket ikke kunne afgøres af en uplaceret spiller.
 */
export function readPosition(payload, playerId) {
  const position = Number(payload?.position);
  if (Number.isFinite(position) && position > 0) return position;

  const items = payload?.items;
  if (Array.isArray(items) && playerId) {
    const index = items.findIndex((item) => (item?.player_id ?? item?.id) === playerId);
    if (index !== -1) {
      const start = Number(payload?.start);
      return (Number.isFinite(start) ? start : 0) + index + 1;
    }
  }

  return null;
}

/**
 * En turnerings kampe. `type` kan være upcoming, ongoing, past eller all.
 *
 * Kommende kampe er den eneste officielle kilde til hvornår der spilles
 * næste gang — spillerens historik indeholder kun det der er spillet.
 */
export function getChampionshipMatches(championshipId, { type = 'upcoming', limit = 20 } = {}) {
  return statsCache.wrap(`champmatches:${type}:${championshipId}`, () =>
    request(`/championships/${encodeURIComponent(championshipId)}/matches`,
      { params: { type, limit } }));
}

/**
 * Et holds stamdata, inklusive dets medlemmer.
 *
 * Holdlisten står i `members`; feltnavnene pr. spiller er ikke bekræftede, så
 * de læses defensivt.
 */
export function getTeam(teamId) {
  return statsCache.wrap(`team:${teamId}`, async () => {
    const payload = await request(`/teams/${encodeURIComponent(teamId)}`);

    const members = (payload?.members ?? payload?.roster ?? [])
      .map((item) => ({
        playerId: item?.user_id ?? item?.player_id ?? item?.id ?? null,
        nickname: item?.nickname ?? item?.name ?? null,
      }))
      .filter((member) => member.nickname);

    return { name: payload?.name ?? null, members };
  });
}

/**
 * Spillerens hubs. Sammen med turneringerne er de de eneste steder en
 * igangværende kamp kan findes: spillerens egen historik rummer kun
 * afsluttede kampe — målt på en kamp der kørte imens.
 */
export function getPlayerHubs(playerId) {
  return statsCache.wrap(`hubs:${playerId}`, async () => {
    const payload = await request(`/players/${encodeURIComponent(playerId)}/hubs`,
      { params: { limit: 20 } });

    return (payload?.items ?? [])
      .map((item) => ({ id: item?.hub_id ?? item?.id, name: item?.name ?? null }))
      .filter((hub) => hub.id);
  });
}

/**
 * En hubs igangværende kampe.
 *
 * Kort levetid i cachen: en kamp der er i gang er netop noget der ændrer sig,
 * og et svar fra ti minutter siden er værdiløst. Men lang nok til at en byge
 * af !hold i chatten deler ét kald.
 */
export function getHubMatches(hubId, { type = 'ongoing', limit = 20 } = {}) {
  return liveCache.wrap(`hub:${type}:${hubId}`, () =>
    request(`/hubs/${encodeURIComponent(hubId)}/matches`, { params: { type, limit } }));
}

/** Spillerens hold. Nøglen til at finde dem i en ESEA-division. */
export function getPlayerTeams(playerId) {
  return statsCache.wrap(`teams:${playerId}`, async () => {
    const payload = await request(`/players/${encodeURIComponent(playerId)}/teams`,
      { params: { limit: 20 } });

    return (payload?.items ?? [])
      .map((item) => ({ teamId: item.team_id ?? item.id, name: item.name ?? item.nickname }))
      .filter((team) => team.teamId);
  });
}

/** Regionens leaderboard — bruges til at vise hvad Challenger-grænsen er. */
export function getLeaderboard(region, { limit = 1, offset = 0, country } = {}) {
  return request(`/rankings/games/${config.faceit.game}/regions/${encodeURIComponent(region)}`, {
    params: { limit, offset, country },
  });
}

/**
 * Leder efter en dokumenteret rute der kan svare på "hvilken kø-kamp er
 * spilleren i nu".
 *
 * Hub- og turneringskampe kan findes: begge har en `/matches?type=ongoing`.
 * En almindelig kø-kamp hører til en *matchmaking*, og om den har samme rute
 * er aldrig blevet målt — kun gættet på. Den her kommando måler det.
 *
 * Diagnostik, ikke en kommando brugerne skal kende. Hver rute fanges for sig,
 * så en 404 på den ene ikke skjuler et svar fra den anden.
 */

/**
 * Om nøglen har adgang til en hubs kø-ruter.
 *
 * FACEIT's dokumentation siger om Queues: "Available only for game developers
 * and queue owners (organizers)". Kø-dataen findes altså officielt — adgangen
 * er rollebaseret, ikke lukket. "Europe 5v5 Queue" ejes af FACEIT selv og er
 * uden for rækkevidde, men ejer man en hub, er man ejer af dens kø.
 *
 * Diagnostik. Den prøver ruterne af og rapporterer statuskoder; en 403 er et
 * lige så gyldigt resultat som en 200, for den siger "du er ikke ejer".
 */
export async function probeHubQueues(playerId) {
  const hubs = await getPlayerHubs(playerId);
  const lines = [];

  for (const hub of hubs.slice(0, 6)) {
    const codes = [];

    for (const [label, path] of [
      ['queues', `/hubs/${encodeURIComponent(hub.id)}/queues`],
      ['stats', `/hubs/${encodeURIComponent(hub.id)}/stats`],
      ['members', `/hubs/${encodeURIComponent(hub.id)}/members`],
    ]) {
      try {
        const payload = await request(path, { retries: 0, params: { limit: 5 } });
        const items = Array.isArray(payload?.items) ? payload.items : null;
        codes.push(`${label} 200${items ? `(${items.length})` : ''}`);
      } catch (error) {
        codes.push(`${label} ${error?.status ?? 0}`);
      }
    }

    lines.push(`${hub.name ?? hub.id.slice(0, 6)}: ${codes.join(' ')}`);
  }

  return lines;
}

/**
 * Hvad en matchmaking faktisk bærer.
 *
 * Dokumentationen viser et `queues`-felt i svaret. En tidligere probe
 * printede kun de fire første nøgler og kasserede resten, og konkluderede
 * derfor for hurtigt at en matchmaking ikke fører nogen steder hen. Den her
 * viser hele nøglelisten og køernes id'er, og prøver derefter kø-ruterne.
 */
export async function probeMatchmaking(playerId) {
  const history = await getHistory(playerId, { limit: 20 });
  const queueGame = history.find(
    (item) => String(item.competition_type ?? '').toLowerCase() === 'matchmaking',
  );

  if (!queueGame?.competition_id) return ['ingen kø-kamp i historikken'];

  const lines = [];
  let payload;

  try {
    payload = await request(`/matchmakings/${encodeURIComponent(queueGame.competition_id)}`,
      { retries: 0 });
  } catch (error) {
    return [`matchmaking ${error?.status ?? 0}`];
  }

  // HELE nøglelisten, ikke de første fire.
  lines.push(`felter: ${Object.keys(payload ?? {}).join(',') || 'ingen'}`);

  const queues = Array.isArray(payload?.queues) ? payload.queues : [];
  lines.push(`queues: ${queues.length}`);

  for (const queue of queues.slice(0, 2)) {
    const queueId = queue?.id ?? queue?.queue_id ?? null;
    if (!queueId) {
      lines.push(`kø uden id: ${Object.keys(queue ?? {}).slice(0, 5).join(',')}`);
      continue;
    }

    const codes = [];
    for (const [label, path] of [
      // DOKUMENTERET sti. Køen ligger under spillet, ikke i sin egen rod —
      // fire gæt på /queues/... gav 404 før dokumentationen blev læst.
      ['q', `/games/${encodeURIComponent(config.faceit.game)}`
        + `/queues/${encodeURIComponent(queueId)}`],
    ]) {
      try {
        const body = await request(path, { retries: 0 });
        codes.push(`${label} 200 ${Object.keys(body ?? {}).slice(0, 5).join(',')}`);
      } catch (error) {
        codes.push(`${label} ${error?.status ?? 0}`);
      }
    }

    lines.push(`${queue?.name ?? queueId.slice(0, 8)}: ${codes.join(' ')}`);
  }

  return lines;
}
