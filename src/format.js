import { config } from './config.js';
import { formatPlayerElo, formatLevel, formatEloDelta, levelFor } from './elo.js';
import { mapName } from './maps.js';
import { formatDate, formatClock, formatRelative } from './time.js';

/** Samme felt-adskiller som LoL-botten, så de to læses ens i chatten. */
export const SEP = ' │ ';

/** Twitch afviser beskeder over 500 tegn. Klip frem for at tabe hele svaret. */
export function truncate(message, limit = 480) {
  if (message.length <= limit) return message;
  return `${message.slice(0, limit - 1)}…`;
}

function oneDecimal(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

// K/D, K/R og rating skrives med to decimaler i al CS-statistik. 1.4 i stedet
// for 1.41 ser ud som en afrundingsfejl for folk der er vant til tallet.
function twoDecimals(value) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

// Swing er en ændring, så fortegnet er hele informationen: "4.2 swing" siger
// ikke om runderne blev vundet eller tabt på spillerens konto.
function signedOneDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
}

/** "PETSEN LEVEL10: 2347 elo (Rank#412)" */
export function formatPlayerRank({ nickname, elo, level, position }) {
  const base = formatPlayerElo({ nickname, elo, level }, config.rankStyle, config.rankEmotePrefix);

  // Placering vises kun nær toppen. Derover er den støj, og FACEIT's
  // rankings dækker alligevel kun Challenger-feltet.
  const show = Number.isFinite(position) && position > 0
    && position <= config.rankingPositionLimit;

  return show ? `${base} (Rank#${position})` : base;
}

/** Nummereret, højeste elo først, adskilt af bjælken. */
export function formatRanksMessage(players) {
  if (players.length === 0) return 'Der er ingen spillere på listen endnu';

  return players
    .map((player, index) => `${index + 1}. ${formatPlayerRank(player)}`)
    .join(SEP);
}

/**
 * "PETSEN: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥"
 *
 * Firkanterne løber ældst til nyest. Elo-summen udelades helt når ingen af
 * dagens kampe blev målt, frem for at påstå et misvisende 0.
 */
export function formatSession({ nickname, results, eloTotal, measuredCount }) {
  if (results.length === 0) return `${nickname} har ikke spillet FACEIT i dag`;

  const wins = results.filter(Boolean).length;
  const losses = results.length - wins;
  const squares = results.map((won) => (won ? '🟩' : '🟥')).join('');

  // Uden en eneste måling er der ingen elo at vise, og et tomt felt ligner at
  // dagen gik i nul. Sig det i stedet — og sig at der måles fra næste kamp,
  // så det ikke ligner at kommandoen er i stykker.
  if (measuredCount === 0) {
    return `${nickname}: ${wins}W ${losses}L${SEP}ingen elo-data endnu`
      + `${SEP}måler fra næste kamp ${squares}`;
  }

  // Når kun nogle kampe er målt, skal det ikke se ud som dagens fulde facit.
  const partial = measuredCount < results.length
    ? ` [${measuredCount}/${results.length} målt]`
    : '';

  return `${nickname}: ${wins}W ${losses}L (${formatEloDelta(eloTotal)} elo)${partial} ${squares}`;
}

/** "PETSEN LEVEL9: 1920 elo │ mangler 81 elo til LEVEL10 (ca 4 wins)" */
export function formatNextRank({ nickname, elo, level, next, wins }) {
  const base = formatPlayerElo({ nickname, elo, level }, config.rankStyle, config.rankEmotePrefix);

  if (!next) return `${base}${SEP}er på højeste level`;

  const target = formatLevel(next.level, config.rankStyle, config.rankEmotePrefix);
  const estimate = Number.isFinite(wins) && wins > 0 ? ` (ca ${wins} ${wins === 1 ? 'win' : 'wins'})` : '';

  return `${base}${SEP}mangler ${next.needed} elo til ${target}${estimate}`;
}

/**
 * "PETSEN │ Mirage 13-9 W │ 24-17-6 │ 1.41 K/D │ 0.92 K/R │ 94.2 ADR │ 2451 dmg
 *  │ 48% HS │ 7 flashed │ 1.18 rating │ +4.2 swing │ +25 elo"
 *
 * Felterne står i prioritetsrækkefølge og tilføjes så længe der er plads.
 *
 * Det er ikke pynt: Twitch afviser beskeder over 500 tegn, og en blind
 * afklipning ville efterlade "+25 el" eller "1.1" — et tal der ser ud som et
 * faktum men er forkert. Hellere udelade et helt felt end vise et halvt.
 *
 * Felter uden data udelades også, frem for at vise en nulværdi: ADR, rating og
 * swing er alle ubekræftede i FACEIT's svar, og "0.0 ADR" ville læses som
 * "spillede og lavede ingen skade".
 */
export function formatLastGame(game, { budget = 420 } = {}) {
  const map = mapName(game.map);
  const score = game.score ? ` ${game.score}` : '';
  const outcome = game.won === true ? ' W' : game.won === false ? ' L' : '';
  const head = `${map ?? ''}${score}${outcome}`.trim();

  // Rækkefølgen er prioriteten. Det der ryger først, når pladsen er knap, er
  // det nederste.
  const fields = [
    head || null,

    Number.isFinite(game.kills) && Number.isFinite(game.deaths)
      ? `${game.kills}-${game.deaths}${Number.isFinite(game.assists) ? `-${game.assists}` : ''}`
      : null,

    Number.isFinite(game.kd) ? `${twoDecimals(game.kd)} K/D` : null,
    Number.isFinite(game.kr) ? `${twoDecimals(game.kr)} K/R` : null,
    Number.isFinite(game.adr) ? `${oneDecimal(game.adr)} ADR` : null,
    Number.isFinite(game.damage) ? `${Math.round(game.damage)} dmg` : null,
    Number.isFinite(game.hs) ? `${Math.round(game.hs)}% HS` : null,
    Number.isFinite(game.flashed) ? `${Math.round(game.flashed)} flashed` : null,

    // FACEIT's egne impact-tal. Rating er den mest interessante linje i hele
    // svaret, hvis den findes i API'et.
    Number.isFinite(game.rating) ? `${twoDecimals(game.rating)} rating` : null,
    Number.isFinite(game.swing) ? `${signedOneDecimal(game.swing)} swing` : null,

    // Vores eget målte tal — det eneste felt her FACEIT ikke leverer.
    Number.isFinite(game.eloDelta) ? `${formatEloDelta(game.eloDelta)} elo` : null,

    Number.isFinite(game.utilDamage) ? `${Math.round(game.utilDamage)} util dmg` : null,
    formatMultiKill(game),
    Number.isFinite(game.entryKills) && game.entryKills > 0 ? `${game.entryKills} entry` : null,
    Number.isFinite(game.clutches) && game.clutches > 0 ? `${game.clutches} clutch` : null,
    Number.isFinite(game.mvps) && game.mvps > 0 ? `${game.mvps} MVP` : null,
  ].filter(Boolean);

  if (fields.length === 0) return `${game.nickname} — ingen statistik på seneste kamp`;

  // Byg op felt for felt, så grænsen rammes mellem felter og aldrig inde i et.
  let message = game.nickname;
  for (const field of fields) {
    const candidate = `${message}${SEP}${field}`;
    if (candidate.length > budget) break;
    message = candidate;
  }

  return message;
}

/**
 * Den bedste multi-kill i kampen, hvis der var en.
 *
 * Kun den højeste nævnes: "1 ace │ 2 quad │ 3 triple" ville fylde tre felter
 * med noget der kan siges i ét.
 */
export function formatMultiKill({ aces, quads, triples }) {
  if (Number.isFinite(aces) && aces > 0) return aces === 1 ? '1 ace' : `${aces} aces`;
  if (Number.isFinite(quads) && quads > 0) return `${quads} quad`;
  if (Number.isFinite(triples) && triples > 0) return `${triples} triple`;
  return null;
}

/**
 * "Igangværende: Mirage │ PETSENs hold 2104 snit │ modstandere 2210 snit"
 *
 * Gennemsnittet er kun så godt som de spillere FACEIT giver elo for. Hvor
 * mange der faktisk indgik, står med, så et snit baseret på tre af fem ikke
 * læses som hele holdet.
 */
export function formatLobby({ nickname, map, teams, status }) {
  if (!teams || teams.length === 0) {
    return `${nickname} er ikke i en FACEIT-kamp lige nu`;
  }

  const parts = [];

  const name = mapName(map);
  parts.push(name ? `Igangværende: ${name}` : 'Igangværende kamp');

  for (const team of teams) {
    if (!Number.isFinite(team.average)) {
      parts.push(`${team.label}: ingen elo-data`);
      continue;
    }

    const partial = team.counted < team.size ? ` (${team.counted}/${team.size})` : '';
    parts.push(`${team.label} ${Math.round(team.average)} snit${partial}`);
  }

  if (status && status !== 'ONGOING') parts.push(`status ${status}`);

  return parts.join(SEP);
}

/**
 * "PETSEN LEVEL10: 2347 elo │ DK #12 │ EU #418 │ opdateret 04/11/26 kl 00:00"
 *
 * Der står EU, ikke "verden": FACEIT's rankings er altid regionale, så et
 * globalt tal findes ikke. At skrive "verden" over et regionstal ville være en
 * påstand API'et ikke kan bakke op.
 */
export function formatTop({ nickname, elo, level, country, countryPosition, region, regionPosition, at }) {
  const parts = [formatPlayerElo({ nickname, elo, level }, config.rankStyle, config.rankEmotePrefix)];

  const places = [];
  if (Number.isFinite(countryPosition) && countryPosition > 0) {
    places.push(`${country} #${countryPosition}`);
  }
  if (Number.isFinite(regionPosition) && regionPosition > 0) {
    places.push(`${region} #${regionPosition}`);
  }

  // Et manglende tal udelades frem for at blive kaldt "uden for listen".
  //
  // MÅLT: en spiller på EU-ranglisten som #6024 fik ingen landeplacering, og
  // en delmængde af EU kan ikke mangle ham. Enten dækker country-filteret
  // ikke denne rute, eller også er landelisten kortere. At skrive "uden for
  // listen" ville i begge tilfælde være en påstand vi ikke kan bakke op.
  if (places.length === 0) {
    parts.push('ingen placering på ranglisten');
  } else {
    parts.push(...places);
  }

  if (at) {
    parts.push(`opdateret ${formatDate(config.timezone, at)} ${formatClock(config.timezone, at)}`);
  }

  return parts.join(SEP);
}

/** "PETSEN │ bedst Nuke 68% (31) │ værst Ancient 38% (24)" */
export function formatMaps({ nickname, best, worst }) {
  if (!best) return `${nickname} — ingen map-statistik endnu`;

  const describe = (entry) =>
    `${mapName(entry.map)} ${Math.round(entry.winRate)}% (${entry.matches})`;

  const parts = [nickname, `bedst ${describe(best)}`];
  // Med kun ét map spillet er "bedst" og "værst" det samme, hvilket ser forkert ud.
  if (worst && worst.map !== best.map) parts.push(`værst ${describe(worst)}`);

  return parts.join(SEP);
}

/**
 * "vigg0 │ ESEA S55 Advanced │ SPARTA 8-0 │ #1 af 16 │ 24 pts"
 *
 * ESEA er en holdliga, så svaret handler om holdet. Der findes intet
 * personligt ESEA-tal der svarer til FACEIT-elo.
 *
 * Etiketten tages fra navnet når det kan læses, og ellers fra turneringens
 * eget navn. Udvælgelsen af hvilken turnering der kigges i sker på status og
 * datoer — navnet bestemmer ingenting, netop fordi ESEA ikke navngiver
 * konsekvent.
 *
 * Placeringen er UDLEDT af rækkefølgen i stillingen: API'ets `position` er
 * målt til 0 på hver eneste række, også på føreren.
 */
export function formatEsea({ nickname, region, standing }) {
  if (!standing) {
    const where = region ? ` i ${region}` : '';
    return `${nickname} er ikke på et ESEA-hold${where} lige nu`;
  }

  const label = Number.isFinite(standing.season) && standing.division
    ? `ESEA S${standing.season} ${standing.division}`
    : truncate(standing.competition || 'ESEA', 60);

  const parts = [nickname, label];

  const record = Number.isFinite(standing.won) && Number.isFinite(standing.lost)
    ? `${standing.won}-${standing.lost}`
    : null;

  if (standing.teamName && record) parts.push(`${standing.teamName} ${record}`);
  else if (standing.teamName) parts.push(standing.teamName);
  else if (record) parts.push(record);

  if (Number.isFinite(standing.rank)) {
    parts.push(standing.total ? `#${standing.rank} af ${standing.total}` : `#${standing.rank}`);
  }

  if (Number.isFinite(standing.points)) parts.push(`${standing.points} pts`);

  // En afsluttet sæson er stadig et svar, men seeren skal vide det er historik.
  if (standing.live === false) parts.push('afsluttet');

  return parts.join(SEP);
}

/**
 * "vigg0 │ ESEA S59 Main │ Elitemilijoet vs Astralis Talent │ 06/11/26 kl 20:00 │ om 2 dage"
 *
 * Både dato og "om hvor længe". En dato alene svarer ikke på det folk spørger
 * om i en chat, og et "om 2 dage" alene kan man ikke planlægge efter.
 */
export function formatNextMatch({ nickname, match }) {
  if (!match) return `${nickname} har ingen planlagte ESEA-kampe`;

  const label = Number.isFinite(match.season) && match.division
    ? `ESEA S${match.season} ${match.division}`
    : truncate(match.competition || 'ESEA', 50);

  const parts = [nickname, label];

  if (match.names.length >= 2) parts.push(match.names.slice(0, 2).join(' vs '));
  else if (match.names.length === 1) parts.push(match.names[0]);

  if (Number.isFinite(match.at)) {
    parts.push(`${formatDate(config.timezone, match.at)} ${formatClock(config.timezone, match.at)}`);

    const relative = formatRelative(match.at);
    if (relative) parts.push(relative);
  }

  return parts.join(SEP);
}

/**
 * "Petsen │ Mirage │ vigg0 LVL10 · Rasmus LVL8 · Jonas LVL7 · Mikkel LVL6"
 *
 * Medspillerne i den igangværende kamp. Spilleren selv udelades — man ved godt
 * man er der, og pladsen er bedre brugt på de andre.
 */
export function formatTeam({ nickname, map, mates }) {
  // Kun den igangværende kamp. En afsluttet kamps opstilling er støj når
  // spørgsmålet er hvem der spiller nu.
  if (!mates || mates.length === 0) {
    return `${nickname} er ikke i en FACEIT-kamp lige nu`;
  }

  const parts = [nickname];

  const name = mapName(map);
  if (name) parts.push(name);

  parts.push(mates
    .map((mate) => {
      const level = mate.level ?? levelFor(mate.elo);
      const label = level ? ` ${formatLevel(level, config.rankStyle, config.rankEmotePrefix)}` : '';
      return `${mate.nickname}${label}`;
    })
    .join(' · '));

  return parts.join(SEP);
}

/**
 * "vigg0 │ Elitemilijoet │ Rasmus · Jonas · Mikkel · Anders"
 *
 * ESEA-holdets faste trup. Ingen levels: holdlisten indeholder dem ikke, og et
 * opslag pr. spiller ville koste fem kald for at pynte på en linje.
 */
export function formatEseaTeam({ nickname, teamName, members }) {
  if (!members || members.length === 0) {
    return `${nickname} er ikke på et ESEA-hold lige nu`;
  }

  return [nickname, teamName ?? 'ESEA-hold', members.join(' · ')].join(SEP);
}

/** Hjælper til playerlist og lignende: en læsbar liste af nicks. */
export function formatNicknames(players) {
  if (players.length === 0) return 'listen er tom';
  return players.map((p) => p.nickname).join(', ');
}

export { levelFor };
