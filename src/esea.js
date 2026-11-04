import { config } from './config.js';
import { TtlCache } from './cache.js';
import { request } from './faceit.js';

/**
 * ESEA League gennem FACEIT's league-endpoints.
 *
 * ESEA drives af ESL FACEIT Group, og ligaen ligger på FACEIT's egen platform
 * (faceit.com/en/esealeague). Derfor hentes den gennem det samme officielle
 * Data API som alt andet her — ikke ved at skrabe play.esea.net, som er
 * Cloudflare-beskyttet og kun tilgængeligt uofficielt.
 *
 * ADVARSEL — som resten af dataklienten er stierne og feltnavnene herunder
 * IKKE verificeret: alle faceit.com-værter var blokeret i miljøet koden blev
 * skrevet i. `npm run check` prøver dem og siger hvad der manglede.
 *
 * ESEA er grundlæggende anderledes end FACEIT-elo: det er en HOLDLIGA med
 * sæsoner og divisioner, ikke en personlig stige. Der findes derfor ikke et
 * "ESEA-tal" der svarer til elo — det nærmeste er holdets division og
 * placering i den igangværende sæson.
 */

// Ligaen ændrer sig ikke; sæsonen gør. Lang TTL på ligaen, kortere på
// placeringer, der flytter sig når der spilles kampe.
const leagueCache = new TtlCache(60 * 60_000, 10);
const seasonCache = new TtlCache(30 * 60_000, 20);
const standingCache = new TtlCache(10 * 60_000, 200);

/** Ligaens stamdata, inklusive dens sæsoner. */
export function getLeague(leagueId = config.esea.leagueId) {
  return leagueCache.wrap(`league:${leagueId}`, () =>
    request(`/leagues/${encodeURIComponent(leagueId)}`));
}

export function getSeason(seasonId, leagueId = config.esea.leagueId) {
  return seasonCache.wrap(`season:${leagueId}:${seasonId}`, () =>
    request(`/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`));
}

/**
 * Den sæson der kører nu.
 *
 * Sæson-id'et skifter hver sæson, så det må ikke stå fast i koden — en bot der
 * skal redeployes hver gang ESEA starter en ny sæson er en bot der viser
 * forældede tal i ugevis. Derfor udledes den af ligaens egen sæsonliste.
 *
 * Rækkefølgen i svaret kan ikke antages, så sæsonerne sorteres på starttid, og
 * en sæson der er markeret som igangværende vinder over en nyere der endnu
 * ikke er begyndt.
 */
export function pickCurrentSeason(leaguePayload, now = Date.now()) {
  const seasons = leaguePayload?.seasons;
  if (!Array.isArray(seasons) || seasons.length === 0) return null;

  const normalized = seasons
    .map((season) => ({
      seasonId: season.season_id ?? season.id ?? null,
      name: season.name ?? season.title ?? null,
      // Tidsstempler har optrådt både som sekunder og som ISO-strenge.
      startedAt: toMillis(season.start_date ?? season.started_at ?? season.start),
      endedAt: toMillis(season.end_date ?? season.ended_at ?? season.end),
      status: season.status ?? null,
    }))
    .filter((season) => season.seasonId);

  if (normalized.length === 0) return null;

  const live = normalized.find(
    (season) =>
      (season.startedAt === null || season.startedAt <= now)
      && (season.endedAt === null || season.endedAt >= now),
  );
  if (live) return live;

  // Ingen sæson er åben lige nu — vis den seneste der er begyndt, så svaret
  // bliver "sidste sæson sluttede sådan" frem for ingenting.
  const started = normalized
    .filter((season) => season.startedAt !== null && season.startedAt <= now)
    .sort((a, b) => b.startedAt - a.startedAt);

  return started[0] ?? normalized.at(-1);
}

/** Sekunder, millisekunder eller ISO — alle tre har optrådt i FACEIT's svar. */
export function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Et sekund-tidsstempel for en CS2-sæson er omkring 1,7 milliarder;
    // millisekunder er tusind gange større.
    return value < 100_000_000_000 ? value * 1000 : value;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Spillerens plads i en sæson: division, hold og placering. */
export function getPlayerSeason(playerId, seasonId, leagueId = config.esea.leagueId) {
  const key = `standing:${leagueId}:${seasonId}:${playerId}`;

  return standingCache.wrap(key, () =>
    request(
      `/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`
      + `/players/${encodeURIComponent(playerId)}`,
    ));
}

/**
 * Plukker divisionen, holdet og rekorden ud af et player-season-svar.
 *
 * Som alle parsere her prøves flere plausible feltnavne, og alt der ikke blev
 * fundet bliver null frem for nul: "0-0" ville læses som "spillet og tabt
 * ingenting", hvor sandheden er "vi ved det ikke".
 */
export function readEseaStanding(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Svaret har haft spillerens data både i roden og under en division-nøgle.
  const root = payload.player ?? payload;
  const division = root.division ?? payload.division ?? {};
  const team = root.team ?? payload.team ?? {};

  const num = (...values) => {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  const divisionName = division.name ?? division.division_name ?? root.division_name ?? null;

  return {
    division: divisionName ? String(divisionName) : null,
    // Underdivisioner hedder fx "Advanced - Group C".
    group: division.group_name ?? division.group ?? root.group_name ?? null,
    teamName: team.name ?? team.team_name ?? root.team_name ?? null,
    placement: num(root.placement, root.position, root.rank, division.placement),
    wins: num(root.wins, root.win, team.wins),
    losses: num(root.losses, root.loss, team.losses),
    points: num(root.points, root.score, team.points),
  };
}

/** Om et sæsonsvar overhovedet indeholder en plads for spilleren. */
export function hasEseaPlace(standing) {
  if (!standing) return false;
  return Boolean(standing.division || standing.teamName || standing.placement !== null);
}
