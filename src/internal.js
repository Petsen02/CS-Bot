import { logger } from './logger.js';

/**
 * FACEIT's interne web-API — den rute deres eget site bruger.
 *
 * UDOKUMENTERET. Ingen versionering, ingen varsel ved ændringer. Bruges kun
 * til det Data API'et ikke har: hvilken kamp en spiller er i LIGE NU.
 * Spillerens historik indeholder kun afsluttede kampe — målt på en kamp med
 * status ONGOING, som slet ikke stod der mens den kørte.
 *
 * Ruten er fundet i sidens egen netværkstrafik og bærer ingen
 * Authorization-header, kun cookies. Om den også svarer uden dem, og for en
 * anden spiller end den der er logget ind, er netop det der skal måles.
 *
 * Botten melder sig som det den er. Vi udgiver os ikke for en browser for at
 * komme forbi FACEIT's botkontrol: svarer ruten ikke på et ærligt kald, er
 * svaret nej, og så lader vi den være.
 *
 * Intet herfra er pålideligt: hver funktion fanger sine egne fejl, så en
 * ændret rute kun koster den ene kommando.
 */

/** Kun FACEIT's egne værter, så en kommando ikke kan blive til en åben proxy. */
const ALLOWED_HOSTS = new Set(['www.faceit.com', 'api.faceit.com']);

const USER_AGENT = 'CS-Bot/1.0 (+https://github.com/Petsen02/CS-Bot)';

/**
 * @returns {Promise<{status: number, body: unknown, hint: string}>}
 *   status 0 ved netværksfejl. `hint` siger kort hvad der kom tilbage, så en
 *   Cloudflare-side ikke kan forveksles med et tomt svar.
 */
export async function fetchInternal(url, { timeoutMs = 10_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 0, body: null, hint: 'ugyldig url' };
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return { status: 0, body: null, hint: 'vært ikke tilladt' };
  }

  try {
    const response = await fetch(parsed, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': USER_AGENT,
        // Sidens eget kald sender denne; uden den svarer ruten muligvis ikke.
        'faceit-referer': 'web-next',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();

    if (!response.ok) {
      return { status: response.status, body: null, hint: classify(text) };
    }

    try {
      return { status: response.status, body: JSON.parse(text), hint: 'json' };
    } catch {
      // En botkontrol-side med status 200 er ikke et svar vi kan bruge.
      return { status: response.status, body: null, hint: classify(text) };
    }
  } catch (error) {
    logger.warn(`internt API: ${parsed.pathname} — ${error.message}`);
    return { status: 0, body: null, hint: error.message };
  }
}

/** Skelner en botkontrol fra et rigtigt fejlsvar. */
export function classify(text) {
  const head = String(text ?? '').slice(0, 2000).toLowerCase();
  if (!head) return 'tomt svar';
  if (head.includes('just a moment') || head.includes('cf-browser-verification')
    || head.includes('challenges.cloudflare.com')) {
    return 'botkontrol';
  }
  if (head.startsWith('<')) return 'html';
  return 'ikke-json';
}

/** Ruten der svarer på "hvilke kampe er denne spiller i nu". */
export function ongoingMatchesUrl(playerId) {
  return 'https://www.faceit.com/api/match/v1/matches/groupByState'
    + `?userId=${encodeURIComponent(playerId)}`;
}

/** De øverste nøgler i et svar — nok til at se om ruten bærer det vi søger. */
export function describeBody(body) {
  if (body === null || body === undefined) return 'tomt';
  if (Array.isArray(body)) return `array(${body.length})`;

  if (typeof body === 'object') {
    const keys = Object.keys(body);
    const inner = body.payload ?? body.result;
    if (inner && typeof inner === 'object') {
      const innerKeys = Array.isArray(inner)
        ? `array(${inner.length})`
        : Object.keys(inner).join(',');
      return `${keys.join(',')} → ${innerKeys}`;
    }
    return keys.join(',');
  }

  return typeof body;
}
