import { TtlCache } from './cache.js';
import { stillRelevant } from './esea.js';
import { logger } from './logger.js';

/**
 * Powerligaen, læst fra dust2.dk's offentlige sider.
 *
 * IKKE et API. Ligaen har ingen offentlig grænseflade: deres `robots.txt`
 * siger `Disallow: /api/`, så den vej er lukket for robotter og bruges ikke.
 * De samme robots.txt siger `Allow: /` for resten og udstiller sitemaps, så
 * de offentlige sider må læses — og de er server-renderede, med dataen lagt
 * ind i siden af Next.js.
 *
 * Derfor er det her skrøbeligere end FACEIT-delen: formatet er deres interne,
 * ikke en versioneret kontrakt, og et redesign kan slå det ud uden varsel.
 * Hver funktion fejler derfor blødt og returnerer null, så !næstepower kan
 * sige "ved ikke" frem for at vælte.
 *
 * Kæden er målt: /performance er nøglet på SteamID64 og bærer spillerens
 * hold; /kampe bærer alle kampe med hold, dato og `state`, hvor "open" er
 * endnu ikke spillet.
 */

const BASE = 'https://liga.dust2.dk';

// Botten melder sig som det den er, med en adresse der siger hvem der spørger.
const USER_AGENT = 'CS-Bot/1.0 (+https://github.com/Petsen02/CS-Bot)';

// Siderne er på 1-1,5 MB, og hverken en kampplan eller en holdtilknytning
// ændrer sig fra minut til minut. Ti minutter holder trafikken nede til et
// par kald i timen, uanset hvor mange der skriver kommandoen.
const pageCache = new TtlCache(10 * 60_000, 4);

/**
 * Next.js lægger sidens data i `self.__next_f.push([1,"…"])`-brudstykker, hver
 * især en JSON-streng. Samlet og af-escaped giver de hele datasættet.
 */
export function readFlightPayload(html) {
  const chunks = String(html ?? '').match(/self\.__next_f\.push\(\[1,\s*"(?:[^"\\]|\\.)*"\]\)/g);
  if (!chunks) return '';

  let out = '';
  for (const chunk of chunks) {
    const quoted = chunk.slice(chunk.indexOf('"'), chunk.lastIndexOf('"') + 1);
    try {
      out += JSON.parse(quoted);
    } catch {
      // Et ulæseligt brudstykke må ikke koste resten af siden.
    }
  }

  // Dataen ligger dobbelt-escaped inde i brudstykkerne.
  return out.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

async function rawPage(path) {
  return pageCache.wrap(`raw:${path}`, async () => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { accept: 'text/html', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        logger.warn(`powerligaen ${path}: ${response.status}`);
        return '';
      }

      return await response.text();
    } catch (error) {
      logger.warn(`powerligaen ${path}: ${error.message}`);
      return '';
    }
  });
}

async function page(path) {
  return pageCache.wrap(path, async () => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { accept: 'text/html', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        logger.warn(`powerligaen ${path}: ${response.status}`);
        return '';
      }

      return readFlightPayload(await response.text());
    } catch (error) {
      logger.warn(`powerligaen ${path}: ${error.message}`);
      return '';
    }
  });
}

/**
 * Spillerens hold, slået op på SteamID64.
 *
 * /performance er nøglet på SteamID, så opslaget er direkte — ingen scanning
 * af 121 holdsider.
 *
 * @returns {{name: string, id: string|null}|null}
 */
export function readTeam(payload, steamId) {
  if (!steamId) return null;

  const start = String(payload).indexOf(`"${steamId}":{`);
  if (start === -1) return null;

  // Spillerens post er stor; holdet står i playerInformation et stykke inde.
  // Vinduet holder opslaget inden for ÉN spiller, så en nabos hold ikke
  // bliver læst som denne spillers.
  const record = payload.slice(start, start + 3000);

  const team = record.match(/"team":\{[^}]*?"name":"([^"]{1,60})"/);
  if (!team) return null;

  const id = record.match(/"team":\{[^}]*?"id":"([a-f0-9]{24})"/);

  // Holdsiden bærer stillingen. Linket står med i samme objekt, så det
  // behøver ikke gættes ud fra navnet.
  const link = record.match(/"team":\{[^}]*?"link":"(\/[^"?]{3,120})/);

  return { name: team[1], id: id?.[1] ?? null, link: link?.[1] ?? null };
}

/**
 * Holdets placering, læst af holdsidens egen tekst.
 *
 * Siden skriver det samlet: "CEPTER 4. Division C · Sæson 33 — Eliten,
 * 1. plads, 17 sejre · 1 nederlag · 51 point". Det hele hentes i ét greb,
 * så et felt ikke kan samles op fra et andet holds blok.
 *
 * Antallet af hold i divisionen står ikke på siden, så `total` er null og
 * svaret skriver "#1" frem for "#1 af 10".
 *
 * @returns {{rank: number, won: number, lost: number, points: number,
 *            division: string|null, season: number|null}|null}
 */
export function readStanding(html) {
  const text = String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  // Placering og rekord står tæt sammen og hentes i ét greb, så et felt ikke
  // kan samles op fra et andet holds blok.
  const m = text.match(
    /(\d{1,2})\.\s*plads\s+(\d{1,3})\s*sejre?\s*·\s*(\d{1,3})\s*nederlag\s*·\s*(\d{1,4})\s*point/,
  );
  if (!m) return null;

  const [, rank, won, lost, points] = m;

  // Divisionen navngives af ligaen selv og står foran sæsonen. Et grådigt
  // udtryk her slæbte nabohold med, så de to familier nævnes ved navn.
  const where = text.match(/(POWER Ligaen|CEPTER[^·|]{0,32}?)\s*·\s*S\u00e6son\s+(\d{1,3})/);

  return {
    division: where?.[1]?.trim() || null,
    season: where ? Number(where[2]) : null,
    rank: Number(rank),
    won: Number(won),
    lost: Number(lost),
    points: Number(points),
  };
}

/**
 * Næste kamp der ikke er spillet.
 *
 * `state` er "open" indtil kampen er afviklet, og "complete" bagefter, så
 * programmet er dem der står "open". Datoen er allerede ISO i `date_object`.
 *
 * @returns {{opponent: string|null, at: number, league: string|null}|null}
 */
export function readNextMatch(payload, team, now = Date.now()) {
  if (!team?.name) return null;

  const pattern = /"liga":"([^"]*)","hold_a":"([^"]*)","hold_a_id":"([a-f0-9]{24})"[\s\S]{0,500}?"hold_b":"([^"]*)","hold_b_id":"([a-f0-9]{24})"[\s\S]{0,600}?"date_object":"([^"]{10,40})"[\s\S]{0,200}?"state":"(open|complete)"/g;

  let best = null;

  for (const m of String(payload).matchAll(pattern)) {
    const [, league, a, aId, b, bId, date, state] = m;
    if (state !== 'open') continue;

    // Både navn og id: id'et er det sikre, navnet fanger de kampe hvor
    // holdet står opført uden at id'erne stemmer overens.
    const isA = a === team.name || (team.id && aId === team.id);
    const isB = b === team.name || (team.id && bId === team.id);
    if (!isA && !isB) continue;

    const at = Date.parse(date);
    // Samme slæk som ESEA: en kamp der er gået i gang tæller stadig.
    if (!stillRelevant(at, now)) continue;

    if (!best || at < best.at) {
      best = { opponent: (isA ? b : a) || null, at, league: league || null };
    }
  }

  return best;
}

/** Spillerens hold i Powerligaen, eller null. */
export async function findTeam(steamId) {
  return readTeam(await page('/performance'), steamId);
}

/** Holdets næste kamp, eller null. */
export async function findNextMatch(team) {
  return readNextMatch(await page('/kampe'), team);
}

/** Holdets placering i divisionen, eller null. */
export async function findStanding(team) {
  if (!team?.link) return null;

  // Holdsidens stilling står i den renderede tekst, ikke i Next.js-dataen,
  // så her bruges siden som den er.
  return readStanding(await rawPage(team.link));
}
