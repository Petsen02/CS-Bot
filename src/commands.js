import { config, parsePlayerRef } from './config.js';
import { gitRevision } from './version.js';
import { writePlayerReport } from './report.js';
import { channels, normalizeChannel } from './channels.js';
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
  getTeam,
  getPlayerHubs,
  probeHubQueues,
  probeMatchmaking,
  getHubMatches,
  getChampionshipMatches,
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
  parseCompetitionName,
  findNextMatch,
  parseMatchId,
  describeMatch,
  describeSchedule,
} from './esea.js';
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
  formatTeam,
  formatEseaTeam,
  formatNextMatch,
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
async function resolveTarget(channelName, argument, viewer = null) {
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

    noteLookup(player, viewer);
    return { player, tracked: false };
  }

  const stored = channels.mainPlayer(channelName);
  if (!stored) {
    throw new FaceitError(
      'bad_input',
      `Der er ingen spillere på listen endnu — skriv fx !rank <dit FACEIT-nick>`,
    );
  }

  const player = await refreshPlayer(stored.playerId);
  if (player.nickname) channels.renamePlayer(player.playerId, player.nickname);

  return { player, tracked: true };
}

/**
 * Sætter den opslåede spiller på watch-listen og noterer hvem der spurgte.
 *
 * Det er dét der gør at folk kan få deres egen konto med uden at nogen
 * tilføjer den i hånden: første gang en seer skriver `!rank <sit nick>`,
 * måles kontoen fra da af.
 *
 * Kun for et navn nogen har skrevet. Uden argument svarer kommandoerne om
 * kanalens main, og at binde en seer til streamerens konto fordi de kørte et
 * bart !rank ville være et værre link end slet ingen.
 *
 * Filen skrives her frem for at vente på næste pollrunde: et link der først
 * dukker op ti minutter senere ligner at det ikke virkede.
 */
function noteLookup(player, viewer) {
  if (store.watch(player, { twitch: viewer ?? null }) === 'current') return;

  store.save();
  writePlayerReport();
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

export async function commandRank({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);
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

export async function commandSession({ channel, argument, viewer }) {
  const { player, tracked } = await resolveTarget(channel, argument, viewer);

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
  const endedAt = [];
  let eloMeasured = [];
  let eloTotal = 0;
  let measuredCount = 0;

  for (const item of ordered) {
    const matchId = item.match_id;
    const record = measured.find((m) => m.matchId === matchId);

    const won = record?.won ?? didWin(item, player.playerId);
    if (won === null) continue; // Kan ikke afgøres — hellere udelade end gætte.

    results.push(won);
    endedAt.push(endedAtMs(item));

    const hasElo = typeof record?.eloDelta === 'number';
    eloMeasured.push(hasElo);

    if (hasElo) {
      eloTotal += record.eloDelta;
      measuredCount += 1;
    }
  }

  // Dagsbaselinen slår enkeltkampene sammenlagt.
  //
  // At lægge enkeltkampe sammen er kun rigtigt hvis hver eneste blev målt —
  // og en kamp der sluttede mens botten var nede, blev den ikke. En baseline
  // sammenligner et elo-tal med nu, og det forbliver rigtigt selv når de
  // enkelte kampe imellem mangler.
  //
  // Baselinen sættes første gang trackeren ser spilleren på dagen, og det er
  // ikke altid før dagens første kamp: starter botten kl. 18 og blev der
  // spillet kl. 15, kan den ikke gøre rede for de tidlige kampe. Men den kan
  // gøre rede for alle der sluttede efter den, og de tælles med. Tidligere
  // blev hele baselinen kasseret i det tilfælde, og !session kunne så ikke
  // vise elo overhovedet resten af dagen.
  const baseline = store.getBaseline(player.playerId, localDateKey(config.timezone));
  const snapshot = store.getSnapshot(player.playerId);

  ({ eloTotal, measuredCount, measured: eloMeasured } = attributeElo({
    endedAt, baseline, snapshot, eloTotal, measuredCount, measured: eloMeasured,
  }));

  return formatSession({
    nickname: player.nickname,
    results,
    eloTotal,
    measuredCount,
    measured: eloMeasured,
  });
}

/**
 * Hvor meget elo dagen har givet, og hvor mange kampe tallet dækker.
 *
 * Ren funktion, så reglen kan testes uden at ringe til FACEIT.
 *
 * @param {object} input
 * @param {number[]} input.endedAt  Sluttidspunkt (ms) for dagens kampe.
 * @param {{elo: number, at?: number}|null} input.baseline  Dagens anker.
 * @param {{elo: number}|null} input.snapshot  Seneste målte elo.
 * @param {number} input.eloTotal  Summen af de enkeltmålte kampe.
 * @param {number} input.measuredCount  Hvor mange af dem der blev målt.
 */
/** Hvornår en kamp fra historikken sluttede, i ms. FACEIT svarer i sekunder. */
export function endedAtMs(item) {
  return (item?.finished_at ?? item?.started_at ?? 0) * 1000;
}

/**
 * Elo-ændringen for ÉN bestemt kamp, udledt af dagsbaselinen.
 *
 * Trackeren måler normalt pr. kamp ved at se elo-tallet flytte sig mellem to
 * pollrunder, men den måling går tabt hvis botten var nede da kampen sluttede.
 * Baselinen overlever derimod en genstart, og når kun én kamp ligger efter
 * den, er hele forskellen mellem baseline og nu netop den kamps.
 *
 * Det er samme regneskab som !session bruger. Uden det kunne !session sige
 * "(-29 elo) [1/5 målt]" mens !lastgame kaldte den samme kamp umålt.
 *
 * @param {object} input
 * @param {number} input.matchEndedAt  Hvornår kampen sluttede (ms).
 * @param {number[]} input.dayEndedAt  Sluttidspunkt for dagens kampe (ms).
 * @param {{elo: number, at?: number}|null} input.baseline
 * @param {{elo: number, at?: number}|null} input.snapshot
 * @returns {number|null} null når tallet ikke kan isoleres.
 */
export function deriveMatchDelta({ matchEndedAt, dayEndedAt, baseline, snapshot }) {
  if (!baseline || !snapshot) return null;
  if (baseline.at == null || snapshot.at == null) return null;
  if (!Number.isFinite(baseline.elo) || !Number.isFinite(snapshot.elo)) return null;

  // Kampen skal ligge efter baselinen, ellers siger forskellen intet om den.
  if (!(matchEndedAt > baseline.at)) return null;

  // Og elo-tallet skal være aflæst efter kampen. Spørger nogen i minuttet
  // mellem at kampen slutter og næste poll, er snapshottet fra før kampen.
  if (!(snapshot.at >= matchEndedAt)) return null;

  // Kun hvis den står alene efter baselinen. Er der to, kan forskellen ikke
  // fordeles mellem dem uden at gætte.
  if (dayEndedAt.filter((at) => at > baseline.at).length !== 1) return null;

  return snapshot.elo - baseline.elo;
}

export function attributeElo({ endedAt, baseline, snapshot, eloTotal, measuredCount, measured }) {
  if (!baseline || !snapshot || baseline.at == null || !Number.isFinite(snapshot.elo)) {
    return { eloTotal, measuredCount, measured };
  }

  // Hvilke kampe baselinen dækker, ikke kun hvor mange: !session tegner en
  // streg mellem de talte og de utalte, og den skal stå det rigtige sted.
  const covered = endedAt.map((at) => at > baseline.at);
  const count = covered.filter(Boolean).length;
  if (count === 0) return { eloTotal, measuredCount, measured };

  // Baselinen slår enkeltkampene sammenlagt: den er stadig rigtig når en
  // kamp imellem ikke blev målt.
  return { eloTotal: snapshot.elo - baseline.elo, measuredCount: count, measured: covered };
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

export async function commandNextRank({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

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
        doubles: num('Double Kills'),
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

export async function commandLastGame({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

  // Ti frem for fem: dagens kampe skal være med, ellers kan deriveMatchDelta
  // ikke se om den seneste står alene efter baselinen.
  const history = await getHistory(player.playerId, { limit: 10 });
  const finished = history.find((item) => isFinished(item.status));

  if (!finished) return `${player.nickname} har ingen færdige FACEIT-kampe`;

  let stats = null;
  try {
    stats = readMatchStats(await getMatchStats(finished.match_id), player.playerId);
  } catch (error) {
    logger.warn(`!lastgame stats fejlede: ${error.message}`);
  }

  let eloDelta = store.getMatchDelta(player.playerId, finished.match_id);

  // Målte trackeren den ikke, kan dagsbaselinen måske stadig isolere den.
  if (typeof eloDelta !== 'number') {
    const dayStart = startOfLocalDay(config.timezone);
    eloDelta = deriveMatchDelta({
      matchEndedAt: endedAtMs(finished),
      dayEndedAt: history
        .filter((item) => isFinished(item.status) && endedAtMs(item) >= dayStart)
        .map(endedAtMs),
      baseline: store.getBaseline(player.playerId, localDateKey(config.timezone)),
      snapshot: store.getSnapshot(player.playerId),
    });
  }

  // Elo pr. kamp er det eneste felt her FACEIT ikke leverer — vi måler det
  // selv ved at se elo-tallet ændre sig mellem to pollrunder. Det virker
  // mens botten kører, og kun der: sluttede kampen mens den var nede, kom
  // ændringen som ét spring sammen med de andre kampe fra nedetiden, og den
  // kan ikke fordeles mellem dem uden at gætte.
  //
  // Så sig det. Et felt der bare forsvinder ligner en kommando i stykker —
  // det var præcis hvad !session gjorde forkert. For en spiller botten slet
  // ikke følger, udelades feltet derimod: der er intet at forklare.
  const tracked = store.watchedAccounts().some((e) => e.playerId === player.playerId);

  return formatLastGame({
    nickname: player.nickname,
    won: stats?.won ?? didWin(finished, player.playerId),
    ...(stats ?? {}),
    eloDelta: typeof eloDelta === 'number' ? eloDelta : undefined,
    eloUnmeasured: typeof eloDelta !== 'number' && tracked,
  });
}

/**
 * Gennemsnitselo pr. hold i en igangværende kamp.
 *
 * FACEIT har intet "nuværende kamp for spiller"-endpoint, så den nyeste post i
 * historikken bruges og dens status tjekkes. Det er bedste bud, ikke en
 * garanti: en kamp der netop er startet kan mangle i historikken.
 */
/**
 * Spillerens igangværende kamp, hvis der er en.
 *
 * FACEIT har intet "nuværende kamp for spiller"-endpoint, så den nyeste post i
 * historikken bruges og dens status tjekkes. Det er bedste bud, ikke en
 * garanti: en kamp der netop er startet kan mangle i historikken.
 */
async function findLiveMatch(playerId) {
  // MÅLT: spillerens historik indeholder IKKE en kamp der er i gang. En kamp
  // med status ONGOING stod ikke i deltagernes historik overhovedet, så den
  // vej — som !hold og !lobby byggede på — kan aldrig virke.
  //
  // Tilbage er at spørge de steder spilleren hører til, om hvad de har kørende:
  // hubs og de turneringer spillerens seneste kampe hørte til. Det dækker
  // ESEA og hub-spil. En ren matchmaking-kamp hører ikke til noget af det, og
  // den kan botten ikke finde — FACEIT udstiller ingen "hvad spiller denne
  // spiller lige nu".
  const [hubs, competitions] = await Promise.all([
    getPlayerHubs(playerId).catch(() => []),
    recentCompetitions(playerId).catch(() => []),
  ]);

  const sources = [
    ...hubs.map((hub) => ({ kind: 'hub', id: hub.id, name: hub.name })),
    ...competitions
      .filter((c) => c.id && c.type === 'championship')
      .map((c) => ({ kind: 'championship', id: c.id, name: c.name })),
  ];

  for (const source of sources) {
    let payload;
    try {
      payload = source.kind === 'hub'
        ? await getHubMatches(source.id)
        : await getChampionshipMatches(source.id, { type: 'ongoing', limit: 20 });
    } catch (error) {
      logger.warn(`live i ${source.name ?? source.id}: ${error.message}`);
      continue;
    }

    for (const item of payload?.items ?? []) {
      if (!isLive(item.status)) continue;

      const roster = Object.values(item.teams ?? {})
        .flatMap((faction) => faction?.roster ?? faction?.players ?? []);

      if (!roster.some((p) => (p?.player_id ?? p?.id) === playerId)) continue;

      // Listen fra en hub er mager; kampens egen rute har hele opstillingen.
      try {
        return await getMatch(item.match_id ?? item.id);
      } catch {
        return item;
      }
    }
  }

  return null;
}

/**
 * Hvad live-søgningen ser. Samme kilder som findLiveMatch, men rapporteret
 * frem for brugt — så "ikke i en kamp" kan skelnes fra "fandt ikke kampen".
 */
export async function describeLiveSearch(playerId) {
  const [hubs, competitions] = await Promise.all([
    getPlayerHubs(playerId).catch(() => []),
    recentCompetitions(playerId).catch(() => []),
  ]);

  const sources = [
    ...hubs.map((hub) => ({ kind: 'hub', id: hub.id, name: hub.name })),
    ...competitions
      .filter((c) => c.id && c.type === 'championship')
      .map((c) => ({ kind: 'turnering', id: c.id, name: c.name })),
  ];

  const seen = [];
  let foundPlayer = false;

  for (const source of sources.slice(0, 10)) {
    let payload;
    try {
      payload = source.kind === 'hub'
        ? await getHubMatches(source.id)
        : await getChampionshipMatches(source.id, { type: 'ongoing', limit: 20 });
    } catch (error) {
      seen.push(`${source.name ?? source.id}: ${error.status ?? 'fejl'}`);
      continue;
    }

    const live = (payload?.items ?? []).filter((item) => isLive(item.status));
    seen.push(`${source.name ?? source.id}: ${live.length}`);

    for (const item of live) {
      const roster = Object.values(item.teams ?? {})
        .flatMap((faction) => faction?.roster ?? faction?.players ?? []);
      if (roster.some((p) => (p?.player_id ?? p?.id) === playerId)) foundPlayer = true;
    }
  }

  return {
    hubs: hubs.length,
    competitions: sources.length - hubs.length,
    seen,
    foundPlayer,
  };
}

/** Spillerens eget hold i en kamp, og de øvrige i den. */
function factionsOf(match, playerId) {
  const own = [];
  const others = [];

  for (const [key, faction] of Object.entries(match?.teams ?? {})) {
    const roster = faction?.roster ?? faction?.players ?? [];
    const isOwn = roster.some((p) => (p?.player_id ?? p?.id) === playerId);

    const people = roster.map((p) => ({
      playerId: p?.player_id ?? p?.id ?? null,
      nickname: p?.nickname ?? p?.name ?? null,
      elo: Number(p?.game_skill_level_elo ?? p?.elo ?? p?.faceit_elo) || null,
      level: Number(p?.game_skill_level ?? p?.skill_level) || null,
    }));

    (isOwn ? own : others).push({ key, name: faction?.name ?? null, people });
  }

  return { own: own[0] ?? null, others };
}

export async function commandLobby({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

  const match = await findLiveMatch(player.playerId);
  if (!match) return formatLobby({ nickname: player.nickname, teams: [] });

  const { own, others } = factionsOf(match, player.playerId);

  const teams = [own, ...others].filter(Boolean).map((faction) => {
    const elos = faction.people.map((p) => p.elo).filter((e) => Number.isFinite(e) && e > 0);
    return {
      label: faction === own ? `${player.nickname}s hold` : (faction.name ?? `hold ${faction.key}`),
      average: elos.length > 0 ? elos.reduce((a, b) => a + b, 0) / elos.length : null,
      counted: elos.length,
      size: faction.people.length,
      own: faction === own,
    };
  });

  return formatLobby({
    nickname: player.nickname,
    map: match?.voting?.map?.pick?.[0] ?? match?.map ?? null,
    status: match?.status,
    teams,
  });
}

/**
 * Hvem spilleren er i kamp med lige nu.
 *
 * Holdkammeraterne i den igangværende kamp. Et FACEIT-party er ikke i Data
 * API'et, men har man køet sammen, er partyet netop det hold man står på — så
 * i praksis svarer det på det samme.
 */
export async function commandTeam({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

  // Kun den igangværende kamp. En afsluttet kamps opstilling er støj når
  // spørgsmålet er hvem der spiller NU — så hellere sige at der ingen kamp er.
  const match = await findLiveMatch(player.playerId);
  if (!match) return formatTeam({ nickname: player.nickname, mates: [] });

  const { own } = factionsOf(match, player.playerId);

  // Spilleren selv udelades — man ved godt man er der.
  const mates = (own?.people ?? []).filter((p) => p.playerId !== player.playerId && p.nickname);

  return formatTeam({
    nickname: player.nickname,
    map: match?.voting?.map?.pick?.[0] ?? match?.map ?? null,
    mates,
  });
}

/**
 * ESEA-holdets faste trup.
 *
 * Holdet findes samme vej som !esea: gennem de turneringer spillerens egne
 * kampe hører til, fordi den kørende sæson ikke findes andre steder.
 */
export async function commandEseaTeam({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

  const [teams, played] = await Promise.all([
    getPlayerTeams(player.playerId),
    recentCompetitions(player.playerId).catch(() => []),
  ]);

  if (teams.length === 0) {
    return formatEseaTeam({ nickname: player.nickname, members: [] });
  }

  const competitions = played
    .filter((c) => c.id && c.type === 'championship')
    .map((c) => ({ id: c.id, name: c.name }));

  const standing = await findTeamStanding(teams.map((t) => t.teamId), competitions);
  if (!standing?.teamId) {
    return formatEseaTeam({ nickname: player.nickname, members: [] });
  }

  const team = await getTeam(standing.teamId);

  return formatEseaTeam({
    nickname: player.nickname,
    teamName: team.name ?? standing.teamName,
    members: team.members.map((m) => m.nickname),
  });
}

/**
 * Dansk og regional placering.
 *
 * Erstatter LoL-bottens !chal. FACEIT's rankings er altid regionale — regionen
 * er en del af stien — så der findes ingen verdensplacering at vise, og
 * svaret skriver regionen ved navn frem for at kalde den "verden".
 */
export async function commandTop({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);
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
export async function commandMaps({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

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
export async function commandEsea({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);
  const { region } = channels.get(channel);

  const [teams, played] = await Promise.all([
    getPlayerTeams(player.playerId),
    recentCompetitions(player.playerId).catch(() => []),
  ]);

  if (teams.length === 0) {
    return `${player.nickname} er ikke på noget FACEIT-hold`;
  }

  const teamIds = teams.map((t) => t.teamId);

  // Første vej: turneringerne bag spillerens egne kampe.
  //
  // Det er den eneste officielle kilde til den KØRENDE sæson. Organizerens
  // championships kender den ikke — 542 turneringer, ingen igangværende, også
  // med type=ongoing — og holdets egne ruter giver nul eller 404. Men hver
  // kamp hører til en turnering, så en spiller der er aktiv i ligaen bærer
  // den i sin historik.
  const fromMatches = played
    .filter((c) => c.id && c.type === 'championship')
    .map((c) => ({
      id: c.id,
      name: c.name,
      startedAt: c.at,
      ...parseCompetitionName(c.name),
    }));

  const current = await findTeamStanding(teamIds, fromMatches);
  if (current) {
    return formatEsea({ nickname: player.nickname, region, standing: current });
  }

  // Anden vej: organizerens historik, for en spiller der ikke har spillet
  // ligakampe for nylig. Svaret bliver mærket "afsluttet".
  const championships = await listChampionships();
  const candidates = pickCompetitions(championships, region);
  const historic = await findTeamStanding(teamIds, candidates);

  return formatEsea({ nickname: player.nickname, region, standing: historic });
}

/**
 * Hvornår holdet spiller næste ESEA-kamp.
 *
 * Spillerens historik indeholder kun spillede kampe, så programmet hentes fra
 * turneringen selv med `type=upcoming`. Turneringen findes samme vej som
 * !esea: gennem de kampe spilleren allerede har spillet.
 */
export async function commandNextEsea({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);

  const [teams, played] = await Promise.all([
    getPlayerTeams(player.playerId),
    recentCompetitions(player.playerId).catch(() => []),
  ]);

  if (teams.length === 0) {
    return `${player.nickname} er ikke på noget FACEIT-hold`;
  }

  const competitions = played
    .filter((c) => c.id && c.type === 'championship')
    .map((c) => ({ id: c.id, name: c.name }));

  if (competitions.length === 0) {
    return `${player.nickname}${SEP}ingen ESEA-turnering i de seneste kampe`;
  }

  const match = await findNextMatch(teams.map((t) => t.teamId), competitions);

  return formatNextMatch({ nickname: player.nickname, match });
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
  const argument = raw;

  // Med et hold-id undersøges holdets egne ruter i stedet. ESEA's kørende
  // sæson findes ikke under organizeren, så den må nås fra holdets side — og
  // hvilke ruter der findes, kan kun afgøres ved at spørge.
  const teamId = parseTeamId(argument);

  // Et match-id eller et room-link: vis hvad kampen indeholder. Findes for at
  // afgøre hvorfor !næsteesea ikke ser en kamp der står på hjemmesiden.
  const matchId = teamId ? null : parseMatchId(argument);
  if (matchId) {
    const info = await describeMatch(matchId);
    if (!info) return `Kunne ikke hente kampen ${matchId}`;

    const parts = [`status ${info.status ?? '?'}`];
    if (info.competition) {
      parts.push(`${info.competition}${info.competitionType ? ` [${info.competitionType}]` : ''}`);
    }
    if (info.competitionId) parts.push(`comp ${info.competitionId.slice(0, 8)}`);
    parts.push(info.times.length ? info.times.join(' ') : 'INGEN TIDSFELTER');
    parts.push(info.factions.join(' · ') || 'ingen hold');

    return parts.join(SEP);
  }

  // "matches <nick>": hvad kampprogram-ruten svarer for spillerens
  // turneringer. Det er dér !næsteesea kan fejle uden at det ses.
  const schedule = /^matches\s+/i.test(argument ?? '');
  if (schedule) {
    const ref = parsePlayerRef(argument.replace(/^matches\s+/i, ''));
    if (!ref) return 'Brug: !csbotesea matches <nick>';

    const player = await resolvePlayer(ref);
    const competitions = (await recentCompetitions(player.playerId))
      .filter((c) => c.id && c.type === 'championship');

    if (competitions.length === 0) return `${player.nickname}: ingen turneringer`;

    const lines = [];
    for (const competition of competitions.slice(0, 2)) {
      lines.push(`${competition.name}: ${await describeSchedule(competition)}`);
    }
    return lines.join(SEP);
  }

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
  // Versionen med: "har serveren hentet den nye kode" skal kunne besvares
  // fra chatten, ikke ved at lede efter en ændring i opførslen.
  const revision = gitRevision();
  return `Kommandoer: ${config.wikiUrl}${revision ? `${SEP}version ${revision}` : ''}`;
}

export function commandPlayerList({ channel }) {
  const { players, region, country } = channels.get(channel);
  return `${region}/${country}${SEP}${formatNicknames(players)}`;
}

export async function commandAddPlayer({ channel, argument, viewer }) {
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

export function commandRemovePlayer({ channel, argument, viewer }) {
  const ref = parsePlayerRef(argument);
  if (!ref || ref.kind !== 'nickname') return `Brug: !${config.adminPrefix}removeplayer <FACEIT-nick>`;

  const result = channels.removePlayer(channel, ref.value);
  return result === 'missing'
    ? `${ref.value} er ikke på listen`
    : `${ref.value} fjernet`;
}

export async function commandAddMain({ channel, argument, viewer }) {
  const ref = parsePlayerRef(argument);
  if (!ref) return `Brug: !${config.adminPrefix}addmain <FACEIT-nick eller SteamID64>`;

  const player = await resolvePlayer(ref);

  // En main der ikke er på listen bliver aldrig pollet, så !session ville
  // mangle elo for den. At sætte main skal derfor også tilføje.
  channels.addPlayer(channel, player);
  channels.setMain(channel, player.nickname);

  return `${player.nickname} er nu main`;
}

export function commandRemoveMain({ channel, argument, viewer }) {
  const ref = parsePlayerRef(argument);
  if (!ref || ref.kind !== 'nickname') return `Brug: !${config.adminPrefix}removemain <FACEIT-nick>`;

  const result = channels.clearMain(channel, ref.value);
  return result === 'missing'
    ? `${ref.value} er ikke main`
    : `${ref.value} er ikke længere main`;
}

/**
 * Hvorfor !hold og elo-tallet i !lastgame opfører sig som de gør.
 *
 * De to hviler på hver sin antagelse, og ingen af dem kan efterprøves herfra:
 * at FACEIT lægger en IGANGVÆRENDE kamp i spillerens historik, og at
 * trackeren har nået at måle den seneste kamp. Denne svarer på begge i
 * chatten, hvor det kan køres mens der faktisk spilles.
 */
export async function commandLiveDebug({ channel, argument, viewer }) {
  // Et room-link afgør spørgsmålet direkte: hvad siger FACEIT om kampen, og
  // står den i deltagernes historik mens den kører? Det er præcis det !hold
  // hviler på, og det kan kun måles på en kamp der er i gang.
  const matchId = parseMatchId(argument);
  if (matchId) {
    const match = await getMatch(matchId);
    const status = String(match?.status ?? '?');

    const roster = Object.values(match?.teams ?? {})
      .flatMap((faction) => faction?.roster ?? faction?.players ?? []);
    const someone = roster.find((p) => p?.player_id);

    const parts = [`kamp ${status}`, `live efter botten: ${isLive(status) ? 'ja' : 'nej'}`];

    if (!someone) return `${parts.join(SEP)}${SEP}ingen spillere i svaret`;

    const history = await getHistory(someone.player_id, { limit: 10 });
    const found = history.find((item) => item.match_id === matchId);

    parts.push(`${someone.nickname ?? 'spiller'}s historik: ${history.length} kampe`);
    parts.push(found
      ? `KAMPEN ER I HISTORIKKEN som "${found.status ?? '?'}"`
      : 'KAMPEN ER IKKE I HISTORIKKEN');

    return parts.join(SEP);
  }

  const { player } = await resolveTarget(channel, argument, viewer);

  const history = await getHistory(player.playerId, { limit: 5 });
  const statuses = history.map((item) => String(item.status ?? '?').toLowerCase());
  const live = history.find((item) => isLive(item.status));

  const parts = [
    player.nickname,
    `historik: ${statuses.join('/') || 'tom'}`,
    `live: ${live ? 'ja' : 'nej'}`,
  ];

  // Watch-listen afgør om trackeren overhovedet måler spilleren.
  const watched = store.watchedAccounts().find((e) => e.playerId === player.playerId);
  parts.push(`watch: ${watched ? (watched.twitch ?? 'uden navn') : 'NEJ'}`);

  // Og hvor mange kampe der faktisk er målt elo for.
  const measured = store.getMatchesBetween(player.playerId, 0);
  const withElo = measured.filter((m) => typeof m.eloDelta === 'number').length;
  parts.push(`målte kampe: ${withElo}/${measured.length}`);

  const newest = history.find((item) => isFinished(item.status));
  if (newest?.match_id) {
    const delta = store.getMatchDelta(player.playerId, newest.match_id);
    parts.push(`seneste kamp: ${delta === null ? 'ikke målt' : `${delta > 0 ? '+' : ''}${delta}`}`);
  }

  const snapshot = store.getSnapshot(player.playerId);
  parts.push(`snapshot: ${snapshot ? `${snapshot.elo} elo` : 'ingen'}`);

  // Hvor live-søgningen leder, og hvad den fandt. Uden det kan "ikke i en
  // kamp" ikke skelnes fra "fandt ikke kampen".
  const search = await describeLiveSearch(player.playerId);
  parts.push(`kilder: ${search.hubs} hubs + ${search.competitions} turneringer`);
  parts.push(search.seen.length ? `ongoing: ${search.seen.join(', ')}` : 'ingen kilder');
  parts.push(`hende i en af dem: ${search.foundPlayer ? 'JA' : 'nej'}`);

  return parts.join(SEP);
}

/**
 * Om nøglen ejer nogen af spillerens hubs.
 *
 * Queues-ruterne er forbeholdt "game developers and queue owners". Ejer
 * kanalen en hub, gælder det den — og så kan !hold få kø-data for de kampe
 * der spilles der. En 403 er svaret "ikke ejer" og lige så nyttigt som en 200.
 */
export async function commandHubDebug({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);
  const lines = await probeHubQueues(player.playerId);

  if (lines.length === 0) return `${player.nickname} er ikke i nogen hubs`;

  return [player.nickname, ...lines].join(SEP);
}

/**
 * Hvad en matchmaking bærer, og om dens køer kan læses.
 *
 * Dokumentationen viser et `queues`-felt. Kan vi nå en kø derfra, er der en
 * officiel vej til kø-kampe; svarer den 403, er adgangen forbeholdt ejeren,
 * præcis som Queues-taggen siger.
 */
export async function commandQueueDebug({ channel, argument, viewer }) {
  const { player } = await resolveTarget(channel, argument, viewer);
  const lines = await probeMatchmaking(player.playerId);

  return [player.nickname, ...lines].join(SEP);
}

/**
 * Får botten til at forlade en kanal.
 *
 * Tjekker sine egne rettigheder frem for at stå på 'mod'-niveau: i kanalen
 * selv må broadcasteren det, og en operatør fra BOT_OWNERS må det hvor som
 * helst — også for en anden kanal end den de står i. Ellers kan botten ikke
 * fjernes fra en kanal hvis ejer er holdt op med at bruge den.
 */
let partChannel = null;

export function setLeaveHandler(handler) {
  partChannel = handler;
}

export function commandLeave({ channel, argument, viewer, tags }) {
  const target = argument ? normalizeChannel(argument) : channel;
  const owner = config.botOwners.has(String(viewer ?? '').toLowerCase());

  // En anden kanal end sin egen kræver operatør. Et tomt svar betyder
  // "ikke din at køre" og ignoreres i stilhed, som de øvrige rettighedstjek.
  if (target !== channel && !owner) return '';

  if (!owner) {
    const broadcaster = tags?.badges?.broadcaster === '1'
      || String(tags?.username ?? '').toLowerCase() === channel;
    if (!broadcaster) return '';
  }

  if (!channels.names().includes(target)) return `Botten er ikke i #${target}`;

  partChannel?.(target);
  return `Forlader #${target} — tilføj kanalen i TWITCH_CHANNELS for at få den tilbage`;
}

export function commandRegion({ channel, argument, viewer }) {
  const current = channels.get(channel).region;

  if (!argument) {
    return `Region: ${current}${SEP}gyldige: EU, NA, SA, AS, OCE`;
  }

  if (!channels.setRegion(channel, argument)) {
    return `Ukendt region "${argument}"${SEP}gyldige: EU, NA, SA, AS, OCE`;
  }

  return `Region sat til ${channels.get(channel).region}`;
}

export function commandCountry({ channel, argument, viewer }) {
  const current = channels.get(channel).country;

  if (!argument) return `Land: ${current}${SEP}brug en landekode som DK, SE, NO`;

  if (!channels.setCountry(channel, argument)) {
    return `"${argument}" er ikke en landekode — brug to bogstaver, fx DK`;
  }

  return `Land sat til ${channels.get(channel).country}${SEP}bruges af !top`;
}

export { levelFor };
