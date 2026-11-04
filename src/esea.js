import { config } from './config.js';
import { TtlCache } from './cache.js';
import { request } from './faceit.js';

/**
 * ESEA League gennem FACEIT's Data API.
 *
 * Vejen hertil var ikke oplagt, og strukturen herunder er MÅLT, ikke gættet:
 *
 *   - ESEA er ikke en "league". Alle /leagues-ruter svarer 404.
 *   - ESEA er en ORGANIZER, 08b06cfc-74d0-454b-9a51-feda4b6b18da, fundet med
 *     /search/organizers?name=ESEA.
 *   - Divisionerne er CHAMPIONSHIPS under den organizer, navngivet
 *     "ESEA League EU Advanced S55 Qualifier" — region, division og
 *     sæsonnummer står kun i navnet, ikke i felter.
 *   - Stillingen ligger bag to kald: /leaderboards/championships/{id} giver et
 *     leaderboard_id, og /leaderboards/{leaderboard_id} giver rækkerne.
 *   - I et holdleaderboard er `player` HOLDET: user_id, nickname, avatar.
 */

export const ESEA_ORGANIZER = '08b06cfc-74d0-454b-9a51-feda4b6b18da';

// Championship-listen og stillingerne ændrer sig langsomt — en division spiller
// en kamp om ugen — så en lang TTL sparer kald uden at vise forældede tal.
const listCache = new TtlCache(60 * 60_000, 4);
const standingsCache = new TtlCache(30 * 60_000, 60);

/**
 * Læser sæson, region og division ud af et turneringsnavn.
 *
 * ESEA navngiver IKKE konsekvent. To former er set i praksis:
 *
 *   "ESEA League EU Advanced S55 Qualifier"   — historik under organizeren
 *   "S59 EU Main B - Regular Season"          — den kørende sæson
 *
 * Derfor matches der ikke på en fast rækkefølge. Hvert felt findes for sig,
 * hvor det end står, og det der mangler bliver null. Et strikt mønster var
 * grunden til at den kørende sæson aldrig blev genkendt.
 */
const SEASON = /\bS(?:eason\s*)?(\d{1,3})\b/i;
const REGION = /\b(EU|NA|SA|AS|OCE|ME)\b/;
const DIVISION = /\b(Entry|Intermediate|Main|Advanced|Open|Premier|Challenger)\b/i;

export function parseCompetitionName(name) {
  const text = String(name ?? '');
  if (!text) return { season: null, region: null, division: null };

  const season = Number(text.match(SEASON)?.[1] ?? NaN);
  const division = text.match(DIVISION)?.[1];

  return {
    season: Number.isFinite(season) ? season : null,
    region: text.match(REGION)?.[1]?.toUpperCase() ?? null,
    division: division ? division[0].toUpperCase() + division.slice(1).toLowerCase() : null,
  };
}

/** Beholdt under sit gamle navn, fordi resten af koden kalder den sådan. */
export function parseDivisionName(name) {
  const parsed = parseCompetitionName(name);
  // Uden en division er det ikke en ligadivision, men fx en finale.
  return parsed.division ? parsed : null;
}

/**
 * Hvilke `type`-varianter der spørges om.
 *
 * `/organizers/{id}/championships` ser ud til kun at give afsluttede
 * turneringer når man ikke beder om andet — botten fandt 543, ingen af dem
 * igangværende, og svarede derfor om en sæson der var slut. De to første
 * varianter er dem der kan indeholde den kørende sæson; den sidste, uden
 * parameter, er historikken.
 *
 * Afviser API'et en variant, springes den over. Ingen af dem er afgørende
 * alene, og en 400 på "ongoing" må ikke koste hele listen.
 */
const TYPES = ['ongoing', 'upcoming', null];

async function fetchType(type) {
  const all = [];

  for (let offset = 0; offset < 1000; offset += 50) {
    const params = { offset, limit: 50 };
    if (type) params.type = type;

    let payload;
    try {
      payload = await request(`/organizers/${ESEA_ORGANIZER}/championships`, { params });
    } catch {
      return all; // Varianten duer ikke; behold hvad den nåede at give.
    }

    const items = payload?.items ?? [];
    all.push(...items);
    if (items.length < 50) break;
  }

  return all;
}

/**
 * Alle championships under ESEA-organizeren, samlet fra hver `type`.
 *
 * Der filtreres IKKE på navnet. Første version gjorde, og den fandt kun 59 af
 * 543 — resten havde ingen sæson i navnet, heriblandt den sæson der faktisk
 * kørte. Navnet bruges nu kun til at sætte en pæn etiket på svaret;
 * udvælgelsen sker på `status` og datoer, som er felter API'et vedligeholder.
 */
export function listChampionships() {
  return listCache.wrap('all', async () => {
    const seen = new Map();

    for (const type of TYPES) {
      for (const item of await fetchType(type)) {
        const id = item.championship_id ?? item.id;
        if (!id || seen.has(id)) continue;

        const parsed = parseDivisionName(item.name);
        seen.set(id, {
          id,
          name: String(item.name ?? ''),
          status: String(item.status ?? '').toLowerCase(),
          // Regionsfeltet er API'ets eget; navnet kan være uenigt med det.
          region: String(item.region ?? parsed?.region ?? '').toUpperCase(),
          startedAt: toMillis(item.championship_start ?? item.subscription_start),
          division: parsed?.division ?? null,
          season: parsed?.season ?? null,
          // Hvilken forespørgsel der fandt den — vises i !csbotesea.
          foundVia: type ?? 'historik',
        });
      }
    }

    return [...seen.values()];
  });
}

/** Sekunder, millisekunder eller ISO — alle tre optræder i FACEIT's svar. */
export function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Afsluttede og aflyste turneringer har ingen levende stilling. */
const DEAD = new Set(['finished', 'cancelled', 'canceled', 'aborted']);

/** Om turneringen stadig kan have en stilling der flytter sig. */
export function isLiveCompetition(competition) {
  return !DEAD.has(String(competition?.status ?? '').toLowerCase());
}

/**
 * De turneringer der er værd at lede i, bedste bud først.
 *
 * Rækkefølgen er hele pointen, for hver kandidat koster to API-kald:
 *
 *   1. Igangværende turneringer i regionen — det er næsten altid svaret.
 *   2. Igangværende i andre regioner, hvis holdet spiller et andet sted.
 *   3. Senest startede afsluttede, så svaret mellem to sæsoner bliver
 *      "sidste sæson sluttede sådan" frem for ingenting.
 *
 * Inden for hver gruppe kommer de der ligner en ligadivision først, så en
 * cash cup ikke æder budgettet foran den sæson spilleren rent faktisk er i.
 *
 * Ingen sæsonnumre, ingen navnemønstre. Det var dem der gjorde at botten kun
 * kiggede i S55 længe efter den sæson var slut.
 */
export function pickCompetitions(championships, region, limit = 14) {
  const wanted = String(region ?? '').toUpperCase();

  const score = (c) => {
    let rank = 0;
    if (DEAD.has(c.status)) rank += 100;
    if (c.region && wanted && c.region !== wanted) rank += 10;
    // En ligadivision slår en cash cup når alt andet er lige.
    if (!c.division) rank += 1;
    return rank;
  };

  return [...championships]
    .sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      // Nyeste først inden for samme gruppe.
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    })
    .slice(0, limit);
}

/**
 * Stillingen i en division.
 *
 * MÅLT: `position` er 0 på hver eneste række, også på den der klart fører.
 * Feltet er ubrugt, så placeringen udledes af rækkefølgen. Rækkerne kommer
 * sorteret efter point, men det sorteres igen her frem for at stole på det —
 * en forkert placering er værre end ingen.
 */
export function readStandings(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const team = row?.player ?? row?.team ?? {};
      return {
        // I et holdleaderboard er `player` holdet, og user_id dets id.
        teamId: team.user_id ?? team.team_id ?? team.id ?? null,
        teamName: team.nickname ?? team.name ?? null,
        played: num(row?.played),
        won: num(row?.won),
        lost: num(row?.lost),
        points: num(row?.points),
        winRate: num(row?.win_rate),
        streak: num(row?.current_streak),
      };
    })
    .sort(compareStandings)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Rækkefølgen i stillingen: point, så sejre, så sejre minus nederlag.
 *
 * API'ets `position` er 0 på hver eneste række, også på føreren, så
 * placeringen må udledes. Point alene er for groft — med 76 hold i en division
 * ligger mange på samme pointtal, og så ville rækkefølgen mellem dem være
 * tilfældig og skifte fra opslag til opslag.
 *
 * ESEA's egen skillelinje kender vi ikke; rundeforskel og indbyrdes opgør er
 * ikke i svaret. Placeringen kan derfor afvige fra ESEA's side for hold med
 * lige mange point. Navnet til sidst gør i det mindste rækkefølgen stabil, så
 * det samme opslag altid giver det samme tal.
 */
export function compareStandings(a, b) {
  const by = (x, y) => (y ?? -Infinity) - (x ?? -Infinity);

  return by(a.points, b.points)
    || by(a.won, b.won)
    || by(
      Number.isFinite(a.won) && Number.isFinite(a.lost) ? a.won - a.lost : null,
      Number.isFinite(b.won) && Number.isFinite(b.lost) ? b.won - b.lost : null,
    )
    || String(a.teamName ?? '').localeCompare(String(b.teamName ?? ''));
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rækkerne for ét championship, gennem dets leaderboard.
 *
 * MÅLT: `limit=100` afvises med 400. Endpointet har et loft, så der bladres i
 * sider af 50 i stedet. En ESEA-division har sjældent over 50 hold, men
 * Advanced-feltet kan være større, og et afkortet felt ville give forkerte
 * placeringer for alle under afskæringen.
 */
export const STANDINGS_PAGE = 50;

export function getStandings(championshipId) {
  return standingsCache.wrap(`standings:${championshipId}`, async () => {
    const defs = await request(`/leaderboards/championships/${encodeURIComponent(championshipId)}`,
      { params: { limit: 10 } });

    const boardId = defs?.items?.[0]?.leaderboard_id;
    if (!boardId) return [];

    const rows = [];
    for (let offset = 0; offset < 400; offset += STANDINGS_PAGE) {
      const page = await request(`/leaderboards/${encodeURIComponent(boardId)}`,
        { params: { offset, limit: STANDINGS_PAGE } });

      const items = page?.items ?? [];
      rows.push(...items);
      if (items.length < STANDINGS_PAGE) break;
    }

    return readStandings(rows);
  });
}

/**
 * Finder spillerens hold blandt de givne turneringer.
 *
 * Søger i den rækkefølge pickCompetitions gav, og stopper ved første træffer.
 * En turnering uden stilling springes over frem for at stoppe søgningen — en
 * aflyst cash cup må ikke skjule den sæson holdet faktisk spiller i.
 */
export async function findTeamStanding(teamIds, competitions) {
  const wanted = new Set(teamIds.filter(Boolean));
  if (wanted.size === 0) return null;

  for (const competition of competitions) {
    let standings;
    try {
      standings = await getStandings(competition.id);
    } catch {
      continue;
    }

    const row = standings.find((entry) => wanted.has(entry.teamId));
    if (row) {
      return {
        ...row,
        total: standings.length,
        division: competition.division,
        season: competition.season,
        competition: competition.name,
        live: !DEAD.has(competition.status),
      };
    }
  }

  return null;
}

/** Læser et team-id ud af et rå id eller et faceit.com/teams/...-link. */
export function parseTeamId(input) {
  const raw = String(input ?? '').trim();
  const link = raw.match(/teams\/([0-9a-f-]{36})/i);
  const id = link ? link[1] : raw;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

/**
 * Prøver de ruter der kunne fortælle hvad et hold er tilmeldt.
 *
 * ESEA's kørende sæson findes ikke under organizerens championships, så den
 * må nås fra holdets side. Hvilke af disse ruter der findes, er ubekendt —
 * derfor prøves de, og svaret rapporteres i stedet for at blive gættet.
 *
 * Kaster aldrig: en rute der ikke findes er et resultat, ikke en fejl.
 */
export async function probeTeamRoutes(teamId) {
  const routes = ['', '/tournaments', '/championships', '/leagues'];
  const results = [];

  for (const suffix of routes) {
    const path = `/teams/${encodeURIComponent(teamId)}${suffix}`;

    try {
      const payload = await request(path, { params: suffix ? { limit: 10 } : undefined });
      const items = Array.isArray(payload?.items) ? payload.items : null;

      results.push({
        route: suffix || '(holdet)',
        status: 200,
        count: items ? items.length : null,
        names: (items ?? [])
          .map((item) => item.name ?? item.competition_name ?? null)
          .filter(Boolean)
          .slice(0, 3),
        name: suffix ? null : (payload?.name ?? null),
      });
    } catch (error) {
      results.push({ route: suffix || '(holdet)', status: error?.status ?? 0, count: null, names: [] });
    }
  }

  return results;
}

/**
 * Finder de turneringer en spiller faktisk har spillet i for nylig.
 *
 * Sidste officielle vej. Hverken organizerens championships eller holdets egne
 * ruter kender den kørende ESEA-sæson — men hver kamp hører til en turnering,
 * og en spiller der er aktiv i ligaen har den i sin historik.
 *
 * Historikposterne nævner måske turneringen direkte; gør de ikke, hentes
 * kampens detaljer. Antallet af opslag er begrænset, for det her skal kunne
 * køre fra en chatkommando.
 *
 * @returns {Promise<Array<{id: string|null, name: string, type: string|null, at: number|null}>>}
 */
export async function recentCompetitions(playerId, { matches = 20, lookups = 6 } = {}) {
  const { getHistory, getMatch } = await import('./faceit.js');

  const history = await getHistory(playerId, { limit: matches });
  const found = new Map();
  let spent = 0;

  for (const item of history) {
    const at = (item.finished_at ?? item.started_at ?? 0) * 1000;

    // Nævner historikposten turneringen selv, er det gratis.
    let id = item.competition_id ?? null;
    let name = item.competition_name ?? null;
    let type = item.competition_type ?? null;

    if (!name && item.match_id && spent < lookups) {
      spent += 1;
      try {
        const match = await getMatch(item.match_id);
        id = match?.competition_id ?? id;
        name = match?.competition_name ?? name;
        type = match?.competition_type ?? type;
      } catch {
        continue;
      }
    }

    if (!name) continue;

    const key = id ?? name;
    if (!found.has(key) || (found.get(key).at ?? 0) < at) {
      found.set(key, { id, name: String(name), type: type ? String(type) : null, at });
    }
  }

  return [...found.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/**
 * Læser tidspunkt og hold ud af en kommende kamp.
 *
 * Feltnavnene er ikke bekræftet for kommende kampe — de spillede kampe bruger
 * `finished_at`, og en kamp der ikke er spillet endnu har noget andet. Derfor
 * prøves flere, og det der ikke findes bliver null.
 */
export function readScheduledMatch(item) {
  if (!item || typeof item !== 'object') return null;

  const at = toMillis(
    item.scheduled_at ?? item.started_at ?? item.configured_at ?? item.match_start,
  );

  const factions = Object.values(item.teams ?? {});
  const teamIds = [];
  const names = [];

  for (const faction of factions) {
    if (!faction) continue;

    const id = faction.faction_id ?? faction.team_id ?? faction.id ?? faction.roster_id;
    if (id) teamIds.push(String(id));

    const name = faction.name ?? faction.nickname;
    if (name) names.push(String(name));
  }

  return {
    matchId: item.match_id ?? item.id ?? null,
    at,
    teamIds,
    names,
    status: String(item.status ?? '').toLowerCase(),
  };
}

/**
 * Næste kamp for et af holdene, i en af turneringerne.
 *
 * Returnerer den tidligste, så svaret er "hvornår spiller de næste gang" og
 * ikke en vilkårlig kamp fra programmet.
 */
export async function findNextMatch(teamIds, competitions) {
  const { getChampionshipMatches } = await import('./faceit.js');

  const wanted = new Set(teamIds.filter(Boolean));
  if (wanted.size === 0) return null;

  let best = null;

  for (const competition of competitions) {
    let payload;
    try {
      payload = await getChampionshipMatches(competition.id, { type: 'upcoming', limit: 20 });
    } catch {
      continue;
    }

    for (const item of payload?.items ?? []) {
      const match = readScheduledMatch(item);
      if (!match?.at || !match.teamIds.some((id) => wanted.has(id))) continue;

      if (!best || match.at < best.at) {
        best = { ...match, competition: competition.name, ...parseCompetitionName(competition.name) };
      }
    }
  }

  return best;
}
