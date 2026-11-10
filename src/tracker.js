import { config } from './config.js';
import { store } from './store.js';
import { channels } from './channels.js';
import { logger } from './logger.js';
import { refreshPlayer, getHistory } from './faceit.js';
import { localDateKey } from './time.js';
import { writePlayerReport } from './report.js';
import { didWin } from './commands.js';

/**
 * Baggrundsmåling af elo.
 *
 * FACEIT udstiller nuværende elo, men ingen elo pr. kamp, så den eneste måde
 * at rapportere "den kamp var +25" er at følge hver tracket spillers elo og
 * tilskrive hver ændring den kamp der forårsagede den.
 *
 * Pollingen er adaptiv. De fleste konti er inaktive det meste af dagen, og at
 * polle dem alle hvert minut er netop det der ville sprænge budgettet for en
 * bot med mange kanaler. Inaktive konti tjekkes derfor sjældent og rykker kun
 * op i det hurtige interval når de faktisk spiller. Det er sikkert, fordi
 * målingen kun kræver at højst én kamp falder mellem to læsninger, og en
 * FACEIT-kamp varer langt længere end det aktive interval.
 */

// Hvor langt tilbage der ledes efter kampe når der ikke findes et tidligere
// snapshot at ankre mod — langt nok til at dække en genstart, kort nok til at
// være billigt.
const COLD_START_LOOKBACK_MS = 6 * 60 * 60 * 1000;

// Lidt slæk når historikken hentes: kampens sluttid og vores målingstidspunkt
// er ikke samme ur.
const HISTORY_SLACK_MS = 5 * 60 * 1000;

const lastPolledAt = new Map();

function isActive(playerId, now) {
  const snapshot = store.getSnapshot(playerId);
  const lastMatch = store.getLastMatchAt(playerId);

  // Nytilføjede konti tælles som aktive, så deres første læsning er prompt.
  if (!snapshot) return true;

  return lastMatch !== null && now - lastMatch < config.activeWindowMs;
}

function isDue(player, now) {
  const last = lastPolledAt.get(player.playerId) ?? 0;
  const interval = isActive(player.playerId, now) ? config.activePollMs : config.idlePollMs;
  return now - last >= interval;
}

/**
 * Måler én konto.
 *
 * Eksporteret, så den kan kaldes direkte fra en test eller fra check.js uden
 * at starte hele løkken.
 */
export async function pollPlayer(entry, now = Date.now()) {
  const player = await refreshPlayer(entry.playerId);
  const { playerId, nickname, elo } = player;

  if (nickname) channels.renamePlayer(playerId, nickname);

  if (!Number.isFinite(elo)) {
    logger.warn(`tracker: ${nickname ?? playerId} har ingen elo`);
    return { measured: 0 };
  }

  const dateKey = localDateKey(config.timezone, now);
  const previous = store.getSnapshot(playerId);

  // Dagens anker. Sættes kun hvis det mangler, så en genstart midt på dagen
  // ikke nulstiller dagens regnskab.
  store.setBaselineIfMissing(playerId, nickname, dateKey, elo, now);

  let measured = 0;

  if (previous && previous.elo !== elo) {
    const from = (previous.at ?? now - COLD_START_LOOKBACK_MS) - HISTORY_SLACK_MS;

    let history = [];
    try {
      history = await getHistory(playerId, { from, limit: 10 });
    } catch (error) {
      logger.warn(`tracker: historik for ${nickname} fejlede: ${error.message}`);
    }

    const fresh = history.filter((item) => item.match_id && !store.hasMatch(playerId, item.match_id));
    const delta = elo - previous.elo;

    if (fresh.length === 1) {
      const item = fresh[0];
      store.recordMatch(playerId, nickname, item.match_id, {
        eloDelta: delta,
        won: didWin(item, playerId) ?? delta > 0,
        at: (item.finished_at ?? item.started_at ?? now / 1000) * 1000,
      });
      measured = 1;
    } else if (fresh.length > 1) {
      // Flere nye kampe i ét vindue: ændringen kan ikke fordeles mellem dem
      // uden at gætte. Kampene bogføres med resultat men uden elo, og
      // !session viser så "3/5 målt" frem for et forkert totaltal.
      for (const item of fresh) {
        store.recordMatch(playerId, nickname, item.match_id, {
          eloDelta: null,
          won: didWin(item, playerId),
          at: (item.finished_at ?? item.started_at ?? now / 1000) * 1000,
        });
      }
      logger.warn(
        `tracker: ${nickname} havde ${fresh.length} nye kampe på én gang `
        + `(${delta > 0 ? '+' : ''}${delta} elo kunne ikke fordeles)`,
      );
    }
  }

  store.setSnapshot(playerId, nickname, { elo, at: now });
  return { measured, elo };
}

/**
 * Alle konti der skal måles: kanalernes lister plus bottens watch-liste.
 *
 * De to er bevidst adskilt. En kanals liste siger hvem streameren bryder sig
 * om; watch-listen siger hvem nogen har spurgt om. At blive spurgt om starter
 * målingen, men dukker ikke op i kanalens !csbotplayerlist, som mods selv
 * plejer.
 */
export function accountsToPoll() {
  const seen = new Map();

  for (const player of channels.trackedPlayers()) {
    seen.set(player.playerId, player);
  }

  for (const entry of store.watchedAccounts()) {
    if (entry.playerId && !seen.has(entry.playerId)) {
      seen.set(entry.playerId, { playerId: entry.playerId, nickname: entry.nickname });
    }
  }

  return [...seen.values()];
}

async function tick() {
  const now = Date.now();
  const due = accountsToPoll().filter((player) => isDue(player, now));

  if (due.length === 0) return;

  for (const player of due) {
    lastPolledAt.set(player.playerId, now);

    try {
      await pollPlayer(player, now);
    } catch (error) {
      logger.warn(`tracker: ${player.nickname ?? player.playerId}: ${error.message}`);
    }
  }

  store.prune(now);
  store.save();

  // Listen skrives her, så den afspejler de nicks pollen lige har set.
  writePlayerReport(now);
}

export function startTracker() {
  // Et kort interval her betyder ikke hyppige kald: isDue() afgør hvem der
  // faktisk spørges. Løkken skal bare vågne tit nok til at ramme intervallerne.
  const timer = setInterval(() => {
    tick().catch((error) => logger.error(`tracker tick: ${error.message}`));
  }, 15_000);

  timer.unref?.();

  // Første runde med det samme, så en nystartet bot har tal at vise.
  tick().catch((error) => logger.error(`tracker start: ${error.message}`));

  return timer;
}
