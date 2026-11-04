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
 * Læser region, division og sæson ud af et championship-navn.
 *
 * "ESEA League EU Advanced S55 Qualifier" -> { region: 'EU', division:
 * 'Advanced', season: 55 }
 *
 * Navnet er den eneste kilde: svarets `region`-felt findes, men division og
 * sæson står ingen andre steder. Alt der ikke passer på mønsteret er noget
 * andet end en ligadivision — finaler, relegation, ESL Impact — og skal ikke
 * med.
 */
export function parseDivisionName(name) {
  const match = String(name ?? '').match(
    /^ESEA League\s+([A-Z]{2,3})\s+(Entry|Intermediate|Main|Advanced|Open)\s+S(\d+)\b/i,
  );
  if (!match) return null;

  return {
    region: match[1].toUpperCase(),
    division: match[2][0].toUpperCase() + match[2].slice(1).toLowerCase(),
    season: Number(match[3]),
  };
}

/**
 * Alle championships under ESEA-organizeren.
 *
 * Der filtreres IKKE på navnet. Første version gjorde, og den fandt kun 59 af
 * 543 — resten havde ingen sæson i navnet, heriblandt den sæson der faktisk
 * kørte. Navnet bruges nu kun til at sætte en pæn etiket på svaret; udvælgelsen
 * sker på `status` og datoer, som er felter API'et vedligeholder.
 */
export function listChampionships() {
  return listCache.wrap('all', async () => {
    const all = [];

    for (let offset = 0; offset < 1000; offset += 50) {
      const payload = await request(`/organizers/${ESEA_ORGANIZER}/championships`, {
        params: { offset, limit: 50 },
      });

      const items = payload?.items ?? [];
      all.push(...items);
      if (items.length < 50) break;
    }

    return all
      .map((item) => {
        const id = item.championship_id ?? item.id;
        if (!id) return null;

        const parsed = parseDivisionName(item.name);
        return {
          id,
          name: String(item.name ?? ''),
          status: String(item.status ?? '').toLowerCase(),
          // Regionsfeltet er API'ets eget; navnet kan være uenigt med det.
          region: String(item.region ?? parsed?.region ?? '').toUpperCase(),
          startedAt: toMillis(item.championship_start ?? item.subscription_start),
          division: parsed?.division ?? null,
          season: parsed?.season ?? null,
        };
      })
      .filter(Boolean);
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
    .sort((a, b) => (b.points ?? -1) - (a.points ?? -1))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
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
