import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { projectRoot } from './config.js';
import { logger } from './logger.js';

/**
 * Fornyelse af Twitch-tokenet.
 *
 * Et Twitch-token udløber — typisk efter omkring 60 dage. Uden fornyelse
 * stopper botten en tilfældig dag med "Login authentication failed", og det
 * sker naturligvis mens ingen kigger. På en server der skal køre uovervåget er
 * det ikke en kosmetisk mangel.
 *
 * To veje, og den første er den rigtige:
 *
 *   1. Twitch's egen rute, /oauth2/token med grant_type=refresh_token. Den
 *      kræver et client secret, som man kun får ved at oprette sin egen app på
 *      dev.twitch.tv. Ingen afhængighed af nogen tredjepart.
 *   2. Token-generatorens egen fornyelsesrute. Den virker uden et secret,
 *      fordi generatoren selv ejer appen — men så afhænger botten af at den
 *      side bliver ved med at eksistere.
 *
 * Er TWITCH_CLIENT_SECRET sat, bruges 1. Ellers 2, med en advarsel i loggen.
 */

const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const GENERATOR_URL = 'https://twitchtokengenerator.com/api/refresh';

const TOKEN_FILE = join(projectRoot, 'data', 'twitch-tokens.json');

/** tmi.js vil have "oauth:" foran; Twitch's API vil have det væk. */
export function stripOauth(token) {
  const value = String(token ?? '').trim();
  return value.startsWith('oauth:') ? value.slice(6) : value;
}

export function withOauth(token) {
  const value = stripOauth(token);
  return value ? `oauth:${value}` : '';
}

/**
 * Hvilke tokens der gælder: de gemte, hvis de stammer fra den refresh token
 * der står i .env — ellers .env's egne.
 *
 * Sammenligningen er det der gør det sikkert at redigere .env: skriver man et
 * nyt token ind i hånden, bliver de gemte kasseret i stedet for at overskrive
 * det man lige har indsat.
 */
export function pickTokens(stored, fromEnv) {
  if (stored?.accessToken && stored.seededFrom && stored.seededFrom === fromEnv.refreshToken) {
    return { ...fromEnv, ...stored, seededFrom: stored.seededFrom };
  }
  return { ...fromEnv, seededFrom: fromEnv.refreshToken };
}

export class TwitchAuth {
  #accessToken;
  #refreshToken;
  #seededFrom;

  constructor({ accessToken, refreshToken, clientId, clientSecret, file = TOKEN_FILE }) {
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.file = file;

    const fromEnv = {
      accessToken: stripOauth(accessToken),
      refreshToken: refreshToken || null,
    };

    const chosen = pickTokens(this.#load(), fromEnv);
    this.#accessToken = chosen.accessToken;
    this.#refreshToken = chosen.refreshToken;
    this.#seededFrom = chosen.seededFrom;
  }

  /** Adgangskoden tmi.js skal bruge. */
  get password() {
    return withOauth(this.#accessToken);
  }

  get canRefresh() {
    return Boolean(this.#refreshToken);
  }

  #load() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  #save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({
        accessToken: this.#accessToken,
        refreshToken: this.#refreshToken,
        // Hvilken .env-værdi disse stammer fra, så en manuel udskiftning vinder.
        seededFrom: this.#seededFrom,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      renameSync(temp, this.file);
    } catch (error) {
      // Kan tokenet ikke gemmes, virker botten stadig — den henter bare et
      // nyt ved næste opstart. Det må ikke vælte noget.
      logger.warn(`kunne ikke gemme Twitch-token: ${error.message}`);
    }
  }

  /**
   * Spørger Twitch hvor længe tokenet holder.
   *
   * @returns {{ login: string|null, expiresIn: number|null } | null} null når
   *   tokenet er afvist — altså er udløbet eller trukket tilbage.
   */
  async validate() {
    let response;
    try {
      response = await fetch(VALIDATE_URL, {
        headers: { Authorization: `OAuth ${this.#accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // Et netværksudfald betyder ikke at tokenet er dårligt, så det må ikke
      // udløse en fornyelse. Kalderen skal kunne skelne.
      throw new Error(`kunne ikke nå Twitch: ${error.message}`);
    }

    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`Twitch validate svarede ${response.status}`);

    const body = await response.json();
    return {
      login: body?.login ?? null,
      expiresIn: Number.isFinite(Number(body?.expires_in)) ? Number(body.expires_in) : null,
    };
  }

  /** Henter et nyt access token. Returnerer true hvis det lykkedes. */
  async refresh() {
    if (!this.#refreshToken) {
      logger.warn('ingen TWITCH_REFRESH_TOKEN — kan ikke forny automatisk');
      return false;
    }

    const next = this.clientSecret
      ? await this.#refreshViaTwitch()
      : await this.#refreshViaGenerator();

    if (!next?.accessToken) return false;

    this.#accessToken = stripOauth(next.accessToken);
    // Twitch udsteder en ny refresh token ved hver fornyelse, og den gamle
    // holder op med at virke. Tabes den, er kæden brudt for altid.
    if (next.refreshToken) this.#refreshToken = next.refreshToken;

    this.#save();
    logger.info('Twitch-token fornyet');
    return true;
  }

  async #refreshViaTwitch() {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.#refreshToken,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.error(`Twitch afviste fornyelsen: ${response.status}`);
      return null;
    }

    const json = await response.json();
    return { accessToken: json?.access_token, refreshToken: json?.refresh_token };
  }

  /**
   * Generatorens egen rute. Virker uden et client secret, men binder botten
   * til at den side bliver ved med at findes.
   *
   * IKKE afprøvet: twitchtokengenerator.com var blokeret i udviklingsmiljøet.
   */
  async #refreshViaGenerator() {
    logger.warn(
      'fornyer via twitchtokengenerator — sæt TWITCH_CLIENT_SECRET for at gå uden om tredjepart',
    );

    const url = `${GENERATOR_URL}/${encodeURIComponent(this.#refreshToken)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      logger.error(`token-generatoren svarede ${response.status}`);
      return null;
    }

    const json = await response.json();
    if (json?.success === false) {
      logger.error(`token-generatoren afviste: ${json?.message ?? 'ukendt årsag'}`);
      return null;
    }

    return { accessToken: json?.token, refreshToken: json?.refresh };
  }

  /**
   * Sørger for at tokenet holder et stykke tid endnu.
   *
   * @returns {Promise<'ok' | 'refreshed' | 'failed' | 'unknown'>}
   *   'unknown' betyder at Twitch ikke kunne nås — tokenet er ikke
   *   nødvendigvis dårligt, så kalderen skal ikke gå i panik.
   */
  async ensureFresh({ minSeconds = 3600 } = {}) {
    let info;
    try {
      info = await this.validate();
    } catch (error) {
      logger.warn(error.message);
      return 'unknown';
    }

    if (info === null) {
      logger.warn('Twitch-tokenet er udløbet eller trukket tilbage — fornyer');
      return (await this.refresh()) ? 'refreshed' : 'failed';
    }

    if (info.expiresIn !== null && info.expiresIn < minSeconds) {
      logger.info(`Twitch-tokenet udløber om ${Math.round(info.expiresIn / 60)} min — fornyer`);
      return (await this.refresh()) ? 'refreshed' : 'failed';
    }

    return 'ok';
  }
}
