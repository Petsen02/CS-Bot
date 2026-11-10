import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Nøgler hvor værtens miljø slog .env-filen. Tom når der ingen konflikt var.
 *
 * Et spilpanel som Pelican injicerer en miljøvariabel for HVER variabel i
 * æggets opsætning, også dem man aldrig har rørt. Står en nøgle der, vinder
 * den over .env — og det skete i stilhed, så man kunne rette .env, genstarte,
 * og se botten bruge panelets værdi uden en forklaring. Opstarten siger det
 * nu højt.
 */
export const envOverrides = [];

/**
 * Minimal .env-indlæser. Undgår en dotenv-afhængighed og virker på enhver
 * Node >= 18, i modsætning til process.loadEnvFile() der kræver 20.12+.
 */
export function loadEnvFile(file = join(projectRoot, '.env'), env = process.env) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return envOverrides; // Ingen .env er fint når værten sætter miljøvariabler.
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

    // Værtens miljø vinder — men kun når det faktisk siger noget. Et tomt
    // felt i et panel er ikke et valg, det er en variabel ingen har udfyldt,
    // og den skal ikke kunne slette en linje man selv har skrevet i .env.
    const hostValue = env[key];

    if (hostValue === undefined || hostValue === '') {
      env[key] = value;
      continue;
    }

    if (hostValue !== value) envOverrides.push(key);
  }

  return envOverrides;
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
 * Renser det en seer skrev, før det bruges til noget.
 *
 * MÅLT i chatten: Twitch-klienter hænger usynlige tegn på beskeder for at
 * omgå dublet-filteret. "!rank Petsen" ankom som "!rank Petsen ␀" — argumentet
 * indeholdt dermed et mellemrum og blev afvist som ugyldigt navn. Sad tegnet
 * klistret på navnet, røg det med ind i opslaget og gav 404.
 *
 * To forskellige tegn er set i praksis: U+E0000 fra tag-blokken og U+034F,
 * combining grapheme joiner. Derfor listes der ikke tegn ét ad gangen her —
 * det er Unicode-egenskaben `Default_Ignorable_Code_Point` der bruges, altså
 * standardens egen definition af tegn der ikke skal vises. Den dækker også
 * dem der endnu ikke er dukket op: zero-width, BOM, retningsmarkører,
 * hangul filler, soft hyphen og resten.
 *
 * Fjerner også et indledende @, fordi seere skriver "!rank @Petsen" af vane.
 */
export function sanitizeArgument(input) {
  return String(input ?? '')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu, '')
    .replace(/^@+/, '')
    .trim();
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
  const raw = sanitizeArgument(input);
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
  /**
   * Præfikset på de kommandoer der styrer kanalens opsætning: !csbotaddplayer
   * og resten. Det holder dem adskilt fra seernes kommandoer og fra andre
   * bots i samme chat — LoL-botten i nabokanalen bruger !old til det samme.
   */
  adminPrefix: (process.env.ADMIN_PREFIX || 'csbot').trim().toLowerCase(),
  botOwners: botOwners(),
  // Navnet på kanalens 7TV-emotes: LVL1 … LVL10. Indstilleligt, fordi det er
  // en egenskab ved emote-sættet og ikke ved botten.
  rankEmotePrefix: (process.env.RANK_EMOTE_PREFIX || 'LVL').trim(),
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

/**
 * Twitch-logins der betjener botten, uanset hvilken kanal de står i.
 *
 * De kan køre enhver kommando i enhver kanal uden først at være moderator
 * dér — ellers kan botten ikke styres i en kanal man ikke selv ejer. Det er
 * adgangslisten: den ændres her, ikke i koden.
 */
export function botOwners() {
  return new Set(
    (process.env.BOT_OWNERS || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

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
