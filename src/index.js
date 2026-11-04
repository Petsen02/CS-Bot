import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import tmi from 'tmi.js';
import { installCrashHandlers, logPaths, logger } from './logger.js';
import {
  config,
  getTwitchConfig,
  bootstrapChannels,
  seedPlayers,
  seedMain,
  sanitizeArgument,
} from './config.js';
import { channels, normalizeChannel } from './channels.js';
import { TwitchAuth } from './twitchAuth.js';
import { gitRevision } from './version.js';
import { FaceitError, resolvePlayer } from './faceit.js';
import { store } from './store.js';
import { startTracker } from './tracker.js';
import {
  commandRank,
  commandRanks,
  commandSession,
  commandNextRank,
  commandLastGame,
  commandLobby,
  commandTop,
  commandMaps,
  commandEsea,
  commandNextEsea,
  commandEseaDebug,
  commandCommands,
  commandPlayerList,
  commandAddPlayer,
  commandRemovePlayer,
  commandAddMain,
  commandRemoveMain,
  commandRegion,
  commandCountry,
  truncate,
} from './commands.js';

/**
 * Præfikset på admin-kommandoerne, fra .env. Bygget ind i tabellen frem for
 * skrevet ind otte steder, så det kan skiftes uden en kodeændring.
 */
const ADMIN = config.adminPrefix;

/**
 * Kommandotabel. `level` er hvem der må køre den:
 *   everyone | mod (mods og broadcaster) | broadcaster
 *
 * Navnene er med vilje de samme som i LoL-botten, så seere og mods ikke skal
 * lære et nyt sæt for at følge en anden titel i samme chat.
 */
const handlers = new Map([
  ['rank', { level: 'everyone', run: commandRank }],
  ['ranks', { level: 'everyone', run: commandRanks }],
  // To navne, ét svar, som i LoL-botten.
  ['session', { level: 'everyone', run: commandSession }],
  ['gains', { level: 'everyone', run: commandSession }],
  ['nextrank', { level: 'everyone', run: commandNextRank }],
  ['lastgame', { level: 'everyone', run: commandLastGame }],
  ['lobby', { level: 'everyone', run: commandLobby }],
  // Erstatter LoL-bottens !chal: viser land og region frem for cutoffs.
  ['top', { level: 'everyone', run: commandTop }],
  ['maps', { level: 'everyone', run: commandMaps }],
  // ESEA er en holdliga, så svaret er holdets division og placering — derfor
  // sin egen kommando frem for en linje i !rank.
  ['esea', { level: 'everyone', run: commandEsea }],
  // Samme kommando under to navne: æ er besværligt på nogle tastaturer.
  ['næsteesea', { level: 'everyone', run: commandNextEsea }],
  ['nextesea', { level: 'everyone', run: commandNextEsea }],
  [`${ADMIN}commands`, { level: 'everyone', run: commandCommands }],
  [`${ADMIN}playerlist`, { level: 'mod', run: commandPlayerList }],
  [`${ADMIN}addplayer`, { level: 'mod', run: commandAddPlayer }],
  [`${ADMIN}removeplayer`, { level: 'mod', run: commandRemovePlayer }],
  [`${ADMIN}addmain`, { level: 'mod', run: commandAddMain }],
  [`${ADMIN}removemain`, { level: 'mod', run: commandRemoveMain }],
  [`${ADMIN}region`, { level: 'mod', run: commandRegion }],
  [`${ADMIN}country`, { level: 'mod', run: commandCountry }],
  // Diagnose i chatten, så fejlsøgning ikke kræver en terminal.
  [`${ADMIN}esea`, { level: 'mod', run: commandEseaDebug }],
]);

/**
 * Holder tokenet gyldigt mens botten kører.
 *
 * Et Twitch-token holder omkring to måneder, så der tjekkes sjældent — men
 * det SKAL tjekkes, for ellers falder botten ud af chatten en tilfældig dag.
 * Fornyes tokenet, skal tmi.js have det nye: klienten genbruger sin gamle
 * adgangskode ved hver genforbindelse, så den skal skrives om og forbindelsen
 * slås i stykker, før det nye bliver brugt.
 */
export function startTokenRefresh(client, auth, intervalMs = 6 * 60 * 60_000) {
  const tick = async () => {
    try {
      const result = await auth.ensureFresh();
      if (result !== 'refreshed') return;

      client.opts.identity.password = auth.password;
      logger.info('genforbinder med det fornyede token');
      await client.disconnect().catch(() => {});
      await client.connect();
    } catch (error) {
      logger.error(`token-fornyelse fejlede: ${error.message}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

/** Gør en API-fejl til noget en seer kan handle på. */
export function explain(error) {
  if (!(error instanceof FaceitError)) return 'Der gik noget galt';

  switch (error.kind) {
    case 'bad_input':
      return error.message;
    case 'auth':
      return 'FACEIT API-nøglen er ugyldig eller udløbet';
    case 'not_found':
      return 'Kunne ikke finde den spiller på FACEIT';
    case 'rate_limit':
      return 'For mange forespørgsler lige nu, prøv igen om et øjeblik';
    case 'unavailable':
    case 'network':
      return 'FACEIT svarer ikke lige nu';
    default:
      return 'Der gik noget galt i kontakten til FACEIT';
  }
}

export function permitted(level, tags, channel) {
  if (level === 'everyone') return true;

  const isBroadcaster =
    tags.badges?.broadcaster === '1' || tags.username === normalizeChannel(channel);
  if (level === 'broadcaster') return isBroadcaster;

  return isBroadcaster || tags.mod === true;
}

const lastUsed = new Map();

function onCooldown(channel, command) {
  const key = `${channel}:${command}`;
  const now = Date.now();

  if (now - (lastUsed.get(key) ?? 0) < config.commandCooldownMs) return true;

  lastUsed.set(key, now);
  return false;
}

/**
 * Opretter kanalerne fra .env og kopierer, kun første gang, PLAYERS-startlisten
 * ind i den første af dem. Derefter lever listen i chatkommandoer.
 */
async function bootstrap() {
  const names = bootstrapChannels();
  for (const name of names) channels.ensure(name);

  const first = names[0];
  if (!first) return names;

  if (channels.get(first).players.length > 0) return names;

  for (const ref of seedPlayers()) {
    try {
      channels.addPlayer(first, await resolvePlayer(ref));
    } catch (error) {
      logger.warn(`bootstrap ${ref.value}: ${error.message}`);
    }
  }

  // En main der ikke er på listen bliver aldrig pollet, så !session ville
  // mangle elo for den. Startlisten skal tilføje den, som addmain gør.
  const main = seedMain();
  if (main) {
    try {
      const player = await resolvePlayer(main);
      channels.addPlayer(first, player);
      channels.setMain(first, player.nickname);
    } catch (error) {
      logger.warn(`bootstrap main ${main.value}: ${error.message}`);
    }
  }

  channels.save();
  return names;
}

async function main() {
  // Gem målt elo før processen går ned, uanset hvordan den går ned.
  installCrashHandlers(() => store.save());

  const revision = gitRevision();
  logger.info(`version: ${revision ?? 'ukendt'}`);
  logger.info(`logs: ${logPaths.logs}`);
  logger.info(`crash reports: ${logPaths.crashes}`);

  const twitch = getTwitchConfig();

  // Tokenet fornyes FØR der forbindes. Starter botten efter at have været
  // nede i to måneder, er tokenet udløbet, og uden dette ville den bare
  // fejle med "Login authentication failed" og give op.
  const auth = new TwitchAuth(twitch);
  if (auth.canRefresh) {
    await auth.ensureFresh();
  } else {
    logger.warn('TWITCH_REFRESH_TOKEN mangler — tokenet fornyes ikke automatisk');
  }

  await bootstrap();

  const joined = channels.names();
  if (joined.length === 0) throw new Error('Ingen kanaler konfigureret — sæt TWITCH_CHANNELS');

  const client = new tmi.Client({
    options: { debug: false, skipUpdatingEmotesets: true },
    connection: { reconnect: true, secure: true },
    identity: { username: twitch.username, password: auth.password },
    // tmi.js skriver i dette array og sætter "#" foran hvert navn, så det får
    // en kopi — ellers ændrer vores egne kanalnavne sig under os.
    channels: [...joined],
  });

  client.on('connected', (address, port) => {
    logger.info(`forbundet til ${address}:${port} som ${twitch.username}`);
    logger.info(`kommandoer: ${[...handlers.keys()].map((c) => `!${c}`).join(' ')}`);
    logger.info(`rank style: ${config.rankStyle}`);

    for (const name of joined) {
      const channel = channels.get(name);
      logger.info(
        `  #${name} (${channel.region}/${channel.country}) — ${channel.players.length} spiller(e)`
        + `${channel.main ? `, main ${channel.main}` : ''}`,
      );
    }
  });

  client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const trimmed = message.trim();
    if (!trimmed.startsWith('!')) return;

    const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();

    const handler = handlers.get(command);
    if (!handler) return;

    // Ignorér uberettiget brug i stilhed frem for at invitere til at prøve igen.
    if (!permitted(handler.level, tags, channel)) return;

    if (onCooldown(channel, command)) return;

    const viewer = tags['display-name'] ?? tags.username;

    try {
      const reply = await handler.run({
        channel: normalizeChannel(channel),
        argument: sanitizeArgument(rest.join(' ')),
        viewer,
      });

      await client.say(channel, truncate(`@${viewer} ${reply}`));
    } catch (error) {
      // Argumentet logges med escapes, så usynlige tegn kan ses. Uden det
      // ligner "Petsen" og "Petsen␀" hinanden til forveksling i en log.
      const argument = rest.join(' ');
      const shown = argument ? ` (argument: ${JSON.stringify(argument)})` : '';
      logger.warn(`!${command} fejlede: ${error.message}${shown}`);
      await client.say(channel, `@${viewer} ${explain(error)}`);
    }
  });

  await client.connect();
  startTracker();

  if (auth.canRefresh) startTokenRefresh(client, auth);
}

/**
 * Kører kun når denne fil ER indgangen.
 *
 * Sammenligningen er på den fulde sti, ikke på filnavnet. Et navnetjek ville
 * også slå til når roden index.js importerer denne, og så ville botten starte
 * to gange og joine hver kanal dobbelt.
 */
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

export function runFatal(error) {
  // tmi.js afviser sit connect-promise med en bar streng, og undertiden med
  // ingenting. `error.stack ?? error.message` blev derfor "undefined" og
  // tabte den eneste oplysning om hvorfor botten ikke startede.
  const reason = error?.stack ?? error?.message ?? String(error ?? 'ukendt årsag');
  logger.error(`fatal: ${reason}`);
  process.exitCode = 1;
}

if (entry === import.meta.url) main().catch(runFatal);

export { handlers, main };
