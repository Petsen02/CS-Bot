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

/** Alle championships under ESEA-organizeren, med navnet tolket. */
export function listChampionships() {
  return listCache.wrap('all', async () => {
    const all = [];

    // 543 i skrivende stund. Grænsen er en sikring mod at bladre i det
    // uendelige hvis API'et holder op med at tømme sig.
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
        const parsed = parseDivisionName(item.name);
        if (!parsed) return null;
        return {
          id: item.championship_id ?? item.id,
          name: String(item.name ?? ''),
          status: item.status ?? null,
          ...parsed,
        };
      })
      .filter(Boolean);
  });
}

/**
 * Divisionerne i den nyeste sæson for en region.
 *
 * "Nyeste" er højeste sæsonnummer der FAKTISK har divisioner i regionen. At
 * tage højeste sæsonnummer i det hele taget ramte "S58 OCE Finals Central",
 * en aflyst finale uden hold og uden stilling.
 */
export function pickSeason(championships, region) {
  const inRegion = championships.filter((c) => c.region === region.toUpperCase());
  if (inRegion.length === 0) return null;

  const season = Math.max(...inRegion.map((c) => c.season));
  return {
    season,
    divisions: inRegion.filter((c) => c.season === season),
  };
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
 * Finder spillerens hold i en sæsons divisioner.
 *
 * Divisionerne gennemsøges fra stærkeste til svageste, så et hold der optræder
 * i flere rapporteres på sit højeste niveau.
 */
const DIVISION_ORDER = ['Advanced', 'Main', 'Intermediate', 'Entry', 'Open'];

export async function findTeamStanding(teamIds, divisions) {
  const wanted = new Set(teamIds.filter(Boolean));
  if (wanted.size === 0) return null;

  const ordered = [...divisions].sort(
    (a, b) => DIVISION_ORDER.indexOf(a.division) - DIVISION_ORDER.indexOf(b.division),
  );

  for (const division of ordered) {
    let standings;
    try {
      standings = await getStandings(division.id);
    } catch {
      continue; // En division uden stilling må ikke stoppe søgningen.
    }

    const row = standings.find((entry) => wanted.has(entry.teamId));
    if (row) return { ...row, division: division.division, season: division.season, total: standings.length };
  }

  return null;
}
