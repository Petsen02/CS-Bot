import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env-indlæser. Undgår en dotenv-afhængighed og virker på enhver
 * Node >= 18, i modsætning til process.loadEnvFile() der kræver 20.12+.
 */
function loadEnvFile() {
  let raw;
  try {
    raw = readFileSync(join(projectRoot, '.env'), 'utf8');
  } catch {
    return; // Ingen .env er fint når værten sætter rigtige miljøvariabler.
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }

    // Rigtige miljøvariabler vinder, så værtens opsætning kan overskrive filen.
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

/**
 * FACEIT's regioner, som de optræder i rankings-stien.
 *
 * IKKE bekræftet mod dokumentationen — den kunne ikke nås fra udviklings-
 * miljøet. En community-wrapper bruger "EU" for CS2, og de øvrige følger samme
 * mønster. Skal verificeres mod et rigtigt kald før produktion.
 */
export const REGIONS = new Set(['EU', 'NA', 'SA', 'AS', 'OCE']);

export function normalizeRegion(input) {
  return String(input ?? '').trim().toUpperCase();
}

/**
 * Landekoder valideres på form, ikke mod en liste.
 *
 * FACEIT tager ISO 3166-1 alpha-2. En indlejret liste over alle lande ville
 * skulle vedligeholdes for at undgå at afvise et gyldigt land, og den fejl er
 * værre end at sende en forkert kode videre og få et tomt svar.
 */
export function normalizeCountry(input) {
  const value = String(input ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

/**
 * Hvad der blev skrevet efter kommandoen: et FACEIT-nick, et SteamID64 eller
 * et link til en Steam-profil.
 *
 * Streamere har oftest et profillink ved hånden, ikke et nick, så alle tre
 * former accepteres og skelnes her frem for i hver kommando.
 *
 * @returns {{ kind: 'steam' | 'nickname', value: string } | null}
 */
export function parsePlayerRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Et SteamID64 er 17 cifre og begynder altid med 7656119.
  if (/^7656119\d{10}$/.test(raw)) return { kind: 'steam', value: raw };

  const profile = raw.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/i);
  if (profile) return { kind: 'steam', value: profile[1] };

  // steamcommunity.com/id/<vanity> kan ikke oversættes uden Steam Web API,
  // så den afvises tydeligt frem for at blive slået op som et FACEIT-nick.
  if (/steamcommunity\.com\/id\//i.test(raw)) return null;

  const faceit = raw.match(/faceit\.com\/[a-z]{2}\/players\/([^/?#]+)/i);
  if (faceit) return { kind: 'nickname', value: decodeURIComponent(faceit[1]) };

  // FACEIT-nicks må ikke indeholde mellemrum, så et argument med mellemrum er
  // en skrivefejl snarere end et nick.
  if (/\s/.test(raw)) return null;

  return { kind: 'nickname', value: raw };
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Manglende indstilling ${key} — se .env.example`);
  return value;
}

/**
 * En stavefejl faldt engang stille tilbage til standarden i LoL-botten, hvilket
 * lignede at indstillingen ingen effekt havde. Her afvises den i stedet.
 */
function parseRankStyle(raw) {
  if (!raw) return 'emotes';

  const value = raw.trim().toLowerCase();
  if (value === 'letters' || value === 'emotes') return value;

  throw new Error(`RANK_STYLE skal være "letters" eller "emotes", fik "${raw}"`);
}

function seconds(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} skal være et positivt tal`);
  return value * 1000;
}

function count(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} skal være et positivt tal`);
  return value;
}

export const defaultRegion = normalizeRegion(process.env.FACEIT_REGION || 'EU');
if (!REGIONS.has(defaultRegion)) {
  throw new Error(
    `FACEIT_REGION "${defaultRegion}" er ukendt. Gyldige: ${[...REGIONS].join(', ')}`,
  );
}

export const defaultCountry = normalizeCountry(process.env.FACEIT_COUNTRY || 'DK');
if (!defaultCountry) {
  throw new Error('FACEIT_COUNTRY skal være en ISO 3166-1 alpha-2-kode, fx DK');
}

export const config = {
  faceit: {
    get apiKey() {
      // Hentes ved brug, ikke ved import, så elo- og formatteringstests kan
      // køre uden en nøgle i miljøet.
      return required('FACEIT_API_KEY');
    },
    baseUrl: process.env.FACEIT_BASE_URL || 'https://open.faceit.com/data/v4',
    game: 'cs2',
    limits: [
      { limit: count('FACEIT_LIMIT_PER_SECOND', 5), windowMs: 1000 },
      { limit: count('FACEIT_LIMIT_PER_TEN_MINUTES', 400), windowMs: 600_000 },
    ],
  },
  esea: {
    /**
     * ESEA League's id på FACEIT, som det står i den offentlige liga-URL
     * (faceit.com/en/cs2/league/esea%20league/<dette id>/...).
     *
     * I .env frem for i koden, fordi et id der skifter ville kræve en ny
     * udrulning for at rette. Sæson-id'et står bevidst IKKE her — det udledes
     * af ligaen, så en ny sæson ikke kræver at nogen husker at opdatere noget.
     */
    leagueId: process.env.ESEA_LEAGUE_ID || 'a14b8616-45b9-4581-8637-4dfd0b5f6af8',
  },
  defaultRegion,
  defaultCountry,
  rankStyle: parseRankStyle(process.env.RANK_STYLE),
  timezone: process.env.TIMEZONE || 'Europe/Copenhagen',
  wikiUrl: process.env.WIKI_URL || 'https://github.com/Petsen02/CS-Bot',
  // Placering er kun interessant nær toppen; derover er det støj.
  rankingPositionLimit: count('RANKING_POSITION_LIMIT', 1000),
  rankingRefreshMs: seconds('RANKING_REFRESH_MINUTES', 1440) * 60,
  rankCacheMs: seconds('RANK_CACHE_SECONDS', 60),
  commandCooldownMs: seconds('COMMAND_COOLDOWN_SECONDS', 5),
  activePollMs: seconds('ACTIVE_POLL_SECONDS', 60),
  idlePollMs: seconds('IDLE_POLL_SECONDS', 600),
  activeWindowMs: seconds('ACTIVE_WINDOW_MINUTES', 60) * 60,
};

export function bootstrapChannels() {
  return (process.env.TWITCH_CHANNELS || '')
    .split(',')
    .map((c) => c.trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
}

/** Valgfri startliste til den første kanal, brugt kun når den er tom. */
export function seedPlayers() {
  return (process.env.PLAYERS || '')
    .split(',')
    .map((entry) => parsePlayerRef(entry))
    .filter(Boolean);
}

export function seedMain() {
  return parsePlayerRef(process.env.DEFAULT_PLAYER || '');
}

/**
 * Twitch-indstillinger valideres ved brug, ikke ved import, så FACEIT-only
 * smoke testen kan køre før der findes Twitch-credentials.
 */
export function getTwitchConfig() {
  return {
    username: required('TWITCH_BOT_USERNAME').toLowerCase(),
    accessToken: required('TWITCH_OAUTH_TOKEN'),
    // Alle tre er valgfrie. Uden refresh token fornyes der ikke; uden client
    // secret fornyes der gennem token-generatoren i stedet for Twitch selv.
    refreshToken: process.env.TWITCH_REFRESH_TOKEN || null,
    clientId: process.env.TWITCH_CLIENT_ID || null,
    clientSecret: process.env.TWITCH_CLIENT_SECRET || null,
  };
}
