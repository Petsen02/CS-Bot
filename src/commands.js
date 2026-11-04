import { config, parsePlayerRef } from './config.js';
import { channels } from './channels.js';
import { store } from './store.js';
import { logger } from './logger.js';
import {
  FaceitError,
  resolvePlayer,
  refreshPlayer,
  getHistory,
  getMatch,
  getMatchStats,
  getPlayerStats,
  getRanking,
  getPlayerTeams,
  isFinished,
  isLive,
} from './faceit.js';
import { nextLevel, winsNeeded, levelFor } from './elo.js';
import {
  listChampionships,
  pickCompetitions,
  findTeamStanding,
  isLiveCompetition,
  parseTeamId,
  probeTeamRoutes,
  recentCompetitions,
} from './esea.js';
import { probeInternal, teamLeagueCandidates } from './internal.js';
import { localDateKey, startOfLocalDay } from './time.js';
import {
  SEP,
  truncate,
  formatPlayerRank,
  formatRanksMessage,
  formatSession,
  formatNextRank,
  formatLastGame,
  formatLobby,
  formatTop,
  formatMaps,
  formatEsea,
  formatNicknames,
} from './format.js';

export { truncate };

/**
 * Hvilken spiller en kommando handler om.
 *
 * Uden argument er det kanalens main. Med argument slås det op hos FACEIT, så
 * seere kan spørge om hvem som helst — men kun spillere på listen er trackede,
 * og det er trackingen der giver elo-historik. Kommandoer der kræver historik
 * siger det tydeligt frem for at svare med et tomt resultat.
 */
async function resolveTarget(channelName, argument) {
  if (argument) {
    const ref = parsePlayerRef(argument);
    if (!ref) {
      throw new FaceitError('bad_input', 'Ugyldigt navn — brug et FACEIT-nick eller et SteamID64');
    }

    const player = await resolvePlayer(ref);
    // Nick kan være ændret siden listen blev skrevet; hold den opdateret.
    if (player.playerId && player.nickname) {
      channels.renamePlayer(player.playerId, player.nickname);
    }
    return { player, tracked: false };
  }

  const stored = channels.mainPlayer(channelName);
  if (!stored) {
    throw new FaceitError(
      'bad_input',
      `Der er ingen spillere på listen endnu — en mod kan tilføje med !${config.adminPrefix}addplayer`,
    );
  }

  const player = await refreshPlayer(stored.playerId);
  if (player.nickname) channels.renamePlayer(player.playerId, player.nickname);

  return { player, tracked: true };
}

/** Placeringen, men kun når den er værd at hente. */
async function positionFor(channelName, player) {
  const channel = channels.get(channelName);

  // Rankings dækker kun Challenger-feltet, så et opslag for en level 5-spiller
  // er et spildt kald mod et budget der skal holde hele dagen.
  if (!Number.isFinite(player.elo) || player.elo < 2001) return null;

  try {
    const { position } = await getRanking(channel.region, player.playerId);
    return position;
  } catch (error) {
    // En manglende placering må ikke koste hele !rank-svaret.
    logger.warn(`ranking for ${player.nickname} fejlede: ${error.message}`);
    return null;
  }
}

export async function commandRank({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);
  const position = await positionFor(channel, player);

  return formatPlayerRank({ ...player, position });
}

export async function commandRanks({ channel }) {
  const roster = channels.get(channel).players;
  if (roster.length === 0) return 'Der er ingen spillere på listen endnu';

  const results = await Promise.allSettled(
    roster.map((entry) => refreshPlayer(entry.playerId)),
  );

  const players = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      players.push(result.value);
      if (result.value.nickname) {
        channels.renamePlayer(result.value.playerId, result.value.nickname);
      }
    } else {
      // En enkelt konto der ikke svarer skal ikke skjule hele listen.
      logger.warn(`!ranks: ${roster[index].nickname} fejlede: ${result.reason?.message}`);
    }
  }

  if (players.length === 0) return 'Kunne ikke hente nogen af kanalens spillere lige nu';

  players.sort((a, b) => (b.elo ?? -1) - (a.elo ?? -1));
  return formatRanksMessage(players);
}

export async function commandSession({ channel, argument }) {
  const { player, tracked } = await resolveTarget(channel, argument);

  const dayStart = startOfLocalDay(config.timezone);
  const measured = store.getMatchesBetween(player.playerId, dayStart);

  // Kampene hentes fra FACEIT, ikke fra vores egen log: en spiller kan være
  // tilføjet midt på dagen, og så har trackeren ikke set de tidlige kampe.
  let history = [];
  try {
    history = await getHistory(player.playerId, { from: dayStart, limit: 30 });
  } catch (error) {
    logger.warn(`!session historik for ${player.nickname} fejlede: ${error.message}`);
  }

  if (history.length === 0 && measured.length === 0) {
    const hint = tracked ? '' : `${SEP}spilleren er ikke på kanalens liste`;
    return `${player.nickname} har ikke spillet FACEIT i dag${hint}`;
  }

  // Ældste først, så firkanterne læses i den rækkefølge kampene blev spillet.
  const ordered = [...history].sort(
    (a, b) => (a.finished_at ?? a.started_at ?? 0) - (b.finished_at ?? b.started_at ?? 0),
  );

  const results = [];
  let eloTotal = 0;
  let measuredCount = 0;

  for (const item of ordered) {
    const matchId = item.match_id;
    const record = measured.find((m) => m.matchId === matchId);

    const won = record?.won ?? didWin(item, player.playerId);
    if (won === null) continue; // Kan ikke afgøres — hellere udelade end gætte.

    results.push(won);

    if (typeof record?.eloDelta === 'number') {
      eloTotal += record.eloDelta;
      measuredCount += 1;
    }
  }

  return formatSession({
    nickname: player.nickname,
    results,
    eloTotal,
    measuredCount,
  });
}

/**
 * Om spilleren vandt en kamp fra historikken.
 *
 * Historikposter har holdopstillingen og en vinder, men feltnavnene er
 * ubekræftede, så alle plausible former prøves og null betyder "ved ikke".
 */
export function didWin(item, playerId) {
  const winner = item?.results?.winner ?? item?.winner;
  if (!winner) return null;

  const teams = item?.teams ?? {};

  for (const [key, team] of Object.entries(teams)) {
    const roster = team?.players ?? team?.roster ?? [];
    const onTeam = roster.some((p) => (p?.player_id ?? p?.id) === playerId);
    if (!onTeam) continue;

    const teamId = team?.team_id ?? key;
    return winner === key || winner === teamId;
  }

  return null;
}

export async function commandNextRank({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);

  const next = nextLevel(player.elo);
  const average = store.getAverageEloGain(player.playerId);
  const wins = next ? winsNeeded(next.needed, average) : null;

  return formatNextRank({ ...player, next, wins });
}

/**
 * Plukker spillerens række ud af et kampstatistik-svar.
 *
 * Skemaet er dybt nøstet og ubekræftet, så hvert niveau tjekkes. Nøglerne i
 * player_stats er menneskelæsbare strenge med mellemrum ("K/D Ratio"), hvilket
 * er grunden til opslagene herunder ser så klodsede ud. Hvert felt prøver flere
 * plausible navne, fordi FACEIT har tilføjet statistik over tid og de ældre og
 * nyere navne optræder side om side i community-wrappere.
 *
 * Alt der ikke blev fundet bliver null, ikke nul: et felt der mangler skal
 * udelades fra svaret, ikke vises som "0".
 */
export function readMatchStats(payload, playerId) {
  const round = payload?.rounds?.[0];
  if (!round) return null;

  const roundStats = round.round_stats ?? {};

  for (const team of round.teams ?? []) {
    for (const entry of team.players ?? []) {
      if (entry.player_id !== playerId) continue;

      const s = entry.player_stats ?? {};
      const num = (...keys) => {
        for (const key of keys) {
          const value = Number(s[key]);
          if (Number.isFinite(value)) return value;
        }
        return null;
      };

      const kills = num('Kills');
      const deaths = num('Deaths');
      const rounds = num('Rounds') ?? Number(roundStats.Rounds) ?? null;

      // K/D og K/R udregnes hvis de ikke kom med: begge kan udledes præcist
      // fra tal vi allerede har, så der er ingen grund til at vise et hul.
      const kd = num('K/D Ratio') ?? (deaths ? kills / deaths : null);
      const kr = num('K/R Ratio')
        ?? (Number.isFinite(kills) && rounds ? kills / rounds : null);

      const damage = num('Damage', 'Total Damage');
      const adr = num('ADR', 'Average Damage per Round')
        ?? (Number.isFinite(damage) && rounds ? damage / rounds : null);

      return {
        map: roundStats.Map ?? roundStats.map ?? null,
        score: roundStats.Score ?? roundStats.score ?? null,
        rounds,
        won: entry.player_stats?.Result !== undefined
          ? String(entry.player_stats.Result) === '1'
          : null,

        kills,
        deaths,
        assists: num('Assists'),
        kd,
        kr,

        adr,
        damage,
        hs: num('Headshots %'),

        // Utility. "Enemies Flashed" er antallet over hele kampen; nogle svar
        // har kun en pr-runde-værdi, som så ganges op.
        flashed: num('Enemies Flashed', 'Flash Count')
          ?? (rounds ? mul(num('Enemies Flashed per Round'), rounds) : null),
        utilDamage: num('Utility Damage'),

        // FACEIT Rating og Round Swing kom til med Season 8. De er IKKE
        // bekræftet at findes i Data API'et — de kan vise sig kun at være i
        // web-UI'et. Derfor mange kandidatnavne, og derfor nævner check.js dem
        // udtrykkeligt.
        rating: num('FACEIT Rating', 'Rating', 'Match Rating', 'faceit_rating'),
        // Enheden er ubekræftet. FACEIT viser swing som en ændring i
        // vinderchance, altså formentlig procent, men det bekræftes først af
        // et rigtigt svar — derfor skrives tallet uden enhed.
        swing: num('Round Swing', 'Swing', 'Average Round Swing', 'round_swing'),

        mvps: num('MVPs'),
        aces: num('Penta Kills'),
        quads: num('Quadro Kills'),
        triples: num('Triple Kills'),
        // MÅLT: svaret har både "Entry Count" (forsøg), "Entry Wins" (vundne)
        // og "First Kills". Count er forsøg, ikke kills — at vise det som
        // "5 entry" ville overdrive hvad spilleren faktisk åbnede med.
        entryKills: num('First Kills', 'Entry Wins'),
        entryAttempts: num('Entry Count'),
        clutches: add(num('1v1Wins'), num('1v2Wins')),
      };
    }
  }

  return null;
}

/** Hjælpere der bevarer null frem for at lave det om til 0. */
function mul(value, factor) {
  return Number.isFinite(value) && Number.isFinite(factor) ? Math.round(value * factor) : null;
}

function add(a, b) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
}

export async function commandLastGame({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);

  const history = await getHistory(player.playerId, { limit: 5 });
  const finished = history.find((item) => isFinished(item.status));

  if (!finished) return `${player.nickname} har ingen færdige FACEIT-kampe`;

  let stats = null;
  try {
    stats = readMatchStats(await getMatchStats(finished.match_id), player.playerId);
  } catch (error) {
    logger.warn(`!lastgame stats fejlede: ${error.message}`);
  }

  const eloDelta = store.getMatchDelta(player.playerId, finished.match_id);

  return formatLastGame({
    nickname: player.nickname,
    won: stats?.won ?? didWin(finished, player.playerId),
    ...(stats ?? {}),
    eloDelta: typeof eloDelta === 'number' ? eloDelta : undefined,
  });
}

/**
 * Gennemsnitselo pr. hold i en igangværende kamp.
 *
 * FACEIT har intet "nuværende kamp for spiller"-endpoint, så den nyeste post i
 * historikken bruges og dens status tjekkes. Det er bedste bud, ikke en
 * garanti: en kamp der netop er startet kan mangle i historikken.
 */
export async function commandLobby({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);

  const history = await getHistory(player.playerId, { limit: 3 });
  const live = history.find((item) => isLive(item.status));

  if (!live) return formatLobby({ nickname: player.nickname, teams: [] });

  let match;
  try {
    match = await getMatch(live.match_id);
  } catch (error) {
    logger.warn(`!lobby match fejlede: ${error.message}`);
    return formatLobby({ nickname: player.nickname, teams: [] });
  }

  const teams = [];
  const factions = Object.entries(match?.teams ?? {});

  for (const [key, faction] of factions) {
    const roster = faction?.roster ?? faction?.players ?? [];
    const own = roster.some((p) => (p?.player_id ?? p?.id) === player.playerId);

    const elos = roster
      .map((p) => Number(p?.game_skill_level_elo ?? p?.elo ?? p?.faceit_elo))
      .filter((value) => Number.isFinite(value) && value > 0);

    teams.push({
      label: own ? `${player.nickname}s hold` : (faction?.name ?? `hold ${key}`),
      average: elos.length > 0 ? elos.reduce((a, b) => a + b, 0) / elos.length : null,
      counted: elos.length,
      size: roster.length,
      own,
    });
  }

  // Eget hold først, så streameren ikke skal lede efter sit eget tal.
  teams.sort((a, b) => Number(b.own) - Number(a.own));

  return formatLobby({
    nickname: player.nickname,
    map: match?.voting?.map?.pick?.[0] ?? match?.map ?? null,
    status: match?.status,
    teams,
  });
}

/**
 * Dansk og regional placering.
 *
 * Erstatter LoL-bottens !chal. FACEIT's rankings er altid regionale — regionen
 * er en del af stien — så der findes ingen verdensplacering at vise, og
 * svaret skriver regionen ved navn frem for at kalde den "verden".
 */
export async function commandTop({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);
  const { region, country } = channels.get(channel);

  const [countryResult, regionResult] = await Promise.allSettled([
    getRanking(region, player.playerId, country),
    getRanking(region, player.playerId),
  ]);

  if (countryResult.status === 'rejected' && regionResult.status === 'rejected') {
    throw countryResult.reason;
  }

  return formatTop({
    ...player,
    country,
    region,
    countryPosition: countryResult.status === 'fulfilled' ? countryResult.value.position : null,
    regionPosition: regionResult.status === 'fulfilled' ? regionResult.value.position : null,
    at: Date.now(),
  });
}

/**
 * Bedste og dårligste map efter winrate.
 *
 * Gratis ekstra i forhold til LoL-botten: FACEIT leverer segmenter pr. map i
 * samme kald som livstidsstatistikken, hvor Riot ikke har noget tilsvarende.
 */
export async function commandMaps({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);

  const payload = await getPlayerStats(player.playerId);
  const segments = (payload?.segments ?? []).filter(
    (segment) => (segment?.type ?? '').toLowerCase() === 'map',
  );

  const entries = segments
    .map((segment) => ({
      map: segment.label ?? segment.mode ?? null,
      matches: Number(segment.stats?.Matches),
      winRate: Number(segment.stats?.['Win Rate %']),
    }))
    // Under fem kampe er winrate støj, ikke information.
    .filter((entry) => entry.map && entry.matches >= 5 && Number.isFinite(entry.winRate));

  if (entries.length === 0) return `${player.nickname} — ingen map-statistik endnu`;

  entries.sort((a, b) => b.winRate - a.winRate);

  return formatMaps({
    nickname: player.nickname,
    best: entries[0],
    worst: entries.at(-1),
  });
}

/**
 * Spillerens hold i den nyeste ESEA-sæson.
 *
 * Bevidst adskilt fra !rank. ESEA er en holdliga med divisioner og sæsoner, så
 * svaret er holdets division, rekord og placering — ikke et personligt tal.
 *
 * Kæden er spiller -> hold -> divisioner -> stilling. Divisionerne og deres
 * stillinger caches en halv time, så kommandoen koster normalt nul kald: en
 * division spiller en kamp om ugen.
 */
export async function commandEsea({ channel, argument }) {
  const { player } = await resolveTarget(channel, argument);
  const { region } = channels.get(channel);

  const [teams, championships] = await Promise.all([
    getPlayerTeams(player.playerId),
    listChampionships(),
  ]);

  if (teams.length === 0) {
    return `${player.nickname} er ikke på noget FACEIT-hold`;
  }

  const competitions = pickCompetitions(championships, region);
  if (competitions.length === 0) {
    return `Fandt ingen ESEA-turneringer${SEP}prøv igen senere`;
  }

  const standing = await findTeamStanding(teams.map((t) => t.teamId), competitions);

  return formatEsea({ nickname: player.nickname, region, standing });
}

/**
 * Hvad botten faktisk ser hos ESEA.
 *
 * Findes fordi fejlsøgning ellers kræver en terminal, og en streamer sidder
 * lige så ofte med en telefon. Den svarer i chatten med de tal der afgør
 * hvorfor !esea siger hvad den siger: hvor mange turneringer der blev hentet,
 * hvor mange der er igangværende, og hvilke den leder i først.
 */
export async function commandEseaDebug({ channel, argument: raw }) {
  let argument = raw;
  // "!csbotesea web <noget>" slår over i det interne API.
  const wantsInternal = /^web\s+/i.test(argument ?? '');
  if (wantsInternal) argument = argument.replace(/^web\s+/i, '');

  // Med et hold-id undersøges holdets egne ruter i stedet. ESEA's kørende
  // sæson findes ikke under organizeren, så den må nås fra holdets side — og
  // hvilke ruter der findes, kan kun afgøres ved at spørge.
  const teamId = parseTeamId(argument);

  // Et nick i stedet for et hold-id: vis hvilke turneringer spillerens egne
  // kampe hører til. Det er den sidste officielle vej til den kørende sæson.
  if (argument && !teamId) {
    const ref = parsePlayerRef(argument);
    if (!ref) return 'Brug: !csbotesea [nick, team-id eller FACEIT-link]';

    const player = await resolvePlayer(ref);
    const competitions = await recentCompetitions(player.playerId);

    if (competitions.length === 0) {
      return `${player.nickname}${SEP}ingen turneringer nævnt i de seneste kampe`;
    }

    const shown = competitions.slice(0, 4).map((c) => {
      const kind = c.type ? ` [${c.type}]` : '';
      return `${c.name}${kind}${c.id ? ` ${c.id.slice(0, 8)}` : ''}`;
    });

    return `${player.nickname}${SEP}${shown.join(SEP)}`;
  }

  if (teamId) {
    // "web <hold>" prøver FACEIT's interne API i stedet for Data API'et.
    // Udokumenteret, derfor en diagnose frem for noget der køres i det stille.
    if (wantsInternal) {
      const results = await probeInternal(teamLeagueCandidates(teamId));
      const ok = results.filter((r) => r.status === 200 && r.shape !== 'tomt');

      if (ok.length === 0) {
        const codes = [...new Set(results.map((r) => r.status || 'net'))].join('/');
        return `internt API${SEP}ingen af ${results.length} ruter svarede brugbart (${codes})`;
      }

      return ok.map((r) => `${r.path} → ${r.shape}`).join(SEP);
    }

    const results = await probeTeamRoutes(teamId);

    const parts = results.map((r) => {
      if (r.status !== 200) return `${r.route} ${r.status || 'fejl'}`;
      if (r.count === null) return `${r.route} ok${r.name ? ` (${r.name})` : ''}`;
      const names = r.names.length ? `: ${r.names.join(' · ')}` : '';
      return `${r.route} ${r.count}${names}`;
    });

    return parts.join(SEP);
  }

  return eseaOverview(channel);
}

/** Hvad botten ser hos ESEA-organizeren. */
async function eseaOverview(channel) {
  const { region } = channels.get(channel);
  const championships = await listChampionships();

  const live = championships.filter(isLiveCompetition);
  const candidates = pickCompetitions(championships, region);

  const parts = [
    `${championships.length} turneringer`,
    `${live.length} igangværende`,
  ];

  // Hvilken forespørgsel der fandt de levende — afslører om type-varianterne
  // virker, uden at nogen skal køre en sonde.
  const sources = [...new Set(live.map((c) => c.foundVia))];
  if (sources.length) parts.push(`fundet via ${sources.join('+')}`);

  if (candidates.length === 0) return `ESEA: ${parts.join(SEP)}${SEP}ingen at søge i`;

  // Navnene er det der viser om den rigtige sæson er med.
  const names = candidates.slice(0, 3).map((c) => c.name).join(' · ');
  parts.push(`søger i ${candidates.length}: ${names}`);

  return `ESEA ${region}${SEP}${parts.join(SEP)}`;
}

// ---- Admin ---------------------------------------------------------------

export function commandCommands() {
  return `Kommandoer: ${config.wikiUrl}`;
}

export function commandPlayerList({ channel }) {
  const { players, region, country } = channels.get(channel);
  return `${region}/${country}${SEP}${formatNicknames(players)}`;
}

export async function commandAddPlayer({ channel, argument }) {
  const ref = parsePlayerRef(argument);
  if (!ref) return `Brug: !${config.adminPrefix}addplayer <FACEIT-nick eller SteamID64>`;

  // Slå op først: en tom eller forkert post på listen ville fejle ved hver
  // kommando bagefter, uden at det var tydeligt hvorfor.
  const player = await resolvePlayer(ref);

  const result = channels.addPlayer(channel, player);
  return result === 'duplicate'
    ? `${player.nickname} er allerede på listen`
    : `${player.nickname} tilføjet`;
}

export function commandRemovePlayer({ channel, argument }) {
  const ref = parsePlayerRef(argument);
  if (!ref || ref.kind !== 'nickname') return `Brug: !${config.adminPrefix}removeplayer <FACEIT-nick>`;

  const result = channels.removePlayer(channel, ref.value);
  return result === 'missing'
    ? `${ref.value} er ikke på listen`
    : `${ref.value} fjernet`;
}

export async function commandAddMain({ channel, argument }) {
  const ref = parsePlayerRef(argument);
  if (!ref) return `Brug: !${config.adminPrefix}addmain <FACEIT-nick eller SteamID64>`;

  const player = await resolvePlayer(ref);

  // En main der ikke er på listen bliver aldrig pollet, så !session ville
  // mangle elo for den. At sætte main skal derfor også tilføje.
  channels.addPlayer(channel, player);
  channels.setMain(channel, player.nickname);

  return `${player.nickname} er nu main`;
}

export function commandRemoveMain({ channel, argument }) {
  const ref = parsePlayerRef(argument);
  if (!ref || ref.kind !== 'nickname') return `Brug: !${config.adminPrefix}removemain <FACEIT-nick>`;

  const result = channels.clearMain(channel, ref.value);
  return result === 'missing'
    ? `${ref.value} er ikke main`
    : `${ref.value} er ikke længere main`;
}

export function commandRegion({ channel, argument }) {
  const current = channels.get(channel).region;

  if (!argument) {
    return `Region: ${current}${SEP}gyldige: EU, NA, SA, AS, OCE`;
  }

  if (!channels.setRegion(channel, argument)) {
    return `Ukendt region "${argument}"${SEP}gyldige: EU, NA, SA, AS, OCE`;
  }

  return `Region sat til ${channels.get(channel).region}`;
}

export function commandCountry({ channel, argument }) {
  const current = channels.get(channel).country;

  if (!argument) return `Land: ${current}${SEP}brug en landekode som DK, SE, NO`;

  if (!channels.setCountry(channel, argument)) {
    return `"${argument}" er ikke en landekode — brug to bogstaver, fx DK`;
  }

  return `Land sat til ${channels.get(channel).country}${SEP}bruges af !top`;
}

export { levelFor };
