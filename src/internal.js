/**
 * FACEIT's interne web-API — det deres eget site kører på.
 *
 * UDOKUMENTERET. Ingen garanti for at ruterne findes i morgen, ingen
 * versionering, ingen varsel ved ændringer. Taget i brug bevidst, fordi Data
 * API'et ikke udstiller den igangværende ESEA-sæson nogen steder: hverken
 * under organizerens championships, på holdet eller i dets turneringer.
 *
 * Alt herfra behandles som upålideligt. Hver funktion fanger sine egne fejl
 * og returnerer null, så en ændret rute kun koster !esea — aldrig resten af
 * botten.
 */
import { logger } from './logger.js';

/**
 * Kun FACEIT's egne værter. Listen findes så en fremtidig ændring her ikke
 * kan blive til et åbent hent-hvad-som-helst gennem en chatkommando.
 */
const ALLOWED_HOSTS = new Set(['www.faceit.com', 'api.faceit.com']);

/**
 * Henter en intern rute.
 *
 * @returns {Promise<{status: number, body: unknown} >} status 0 ved netværksfejl.
 */
export async function fetchInternal(url, { timeoutMs = 10_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 0, body: null };
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return { status: 0, body: null };
  }

  try {
    const response = await fetch(parsed, {
      headers: {
        Accept: 'application/json',
        // Uden en almindelig browser-agent svarer nogle af ruterne ikke.
        'User-Agent': 'CS-Bot (+https://github.com/Petsen02/CS-Bot)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return { status: response.status, body: null };

    const text = await response.text();
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      // En HTML-fejlside med status 200 er ikke et svar vi kan bruge.
      return { status: 200, body: null };
    }
  } catch (error) {
    logger.warn(`internt API: ${parsed.pathname} — ${error.message}`);
    return { status: 0, body: null };
  }
}

/**
 * Kandidater til "hvilke ligaer er dette hold med i".
 *
 * Ingen af dem er bekræftet. De prøves i rækkefølge, og den første der svarer
 * med JSON vinder. Listen står her frem for i en kommando, så den kan rettes
 * ét sted når vi ved hvad der virker.
 */
export function teamLeagueCandidates(teamId) {
  const id = encodeURIComponent(teamId);
  return [
    `https://www.faceit.com/api/team-leagues/v1/teams/${id}`,
    `https://www.faceit.com/api/team-leagues/v1/get_team_seasons?teamId=${id}`,
    `https://api.faceit.com/team-leagues/v1/teams/${id}`,
    `https://www.faceit.com/api/team/v1/team/${id}`,
    `https://api.faceit.com/team/v1/team/${id}`,
    `https://www.faceit.com/api/teams/v1/teams/${id}/competitions`,
  ];
}

/** De øverste nøgler i et svar — nok til at se om ruten bærer det vi søger. */
export function describeBody(body) {
  if (body === null || body === undefined) return 'tomt';
  if (Array.isArray(body)) return `array(${body.length})`;

  if (typeof body === 'object') {
    const keys = Object.keys(body);
    // FACEIT pakker typisk nyttelasten i "payload" eller "result".
    const inner = body.payload ?? body.result;
    if (inner && typeof inner === 'object') {
      const innerKeys = Array.isArray(inner) ? `array(${inner.length})` : Object.keys(inner).join(',');
      return `${keys.join(',')} → ${innerKeys}`;
    }
    return keys.join(',');
  }

  return typeof body;
}

/** Prøver kandidaterne og rapporterer hvad hver enkelt svarede. */
export async function probeInternal(urls) {
  const results = [];

  for (const url of urls) {
    const { status, body } = await fetchInternal(url);
    results.push({
      url,
      path: new URL(url).pathname.replace(/^\/api/, ''),
      status,
      shape: status === 200 ? describeBody(body) : null,
    });
  }

  return results;
}
