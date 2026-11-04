/**
 * Tid og dato i kanalens tidszone.
 *
 * Alt der handler om "i dag" skal regnes i lokal tid, ikke UTC: en session der
 * slutter kl. 01 dansk tid hører til aftenen før for den der streamer, og en
 * dagsbaseline der skifter midt i en session er værdiløs.
 */

/** "2026-11-04" i den givne tidszone. Nøglen dagsbaseliner gemmes under. */
export function localDateKey(timezone, at = Date.now()) {
  // en-CA giver ISO-rækkefølgen år-måned-dag direkte.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/**
 * "04/11/26"
 *
 * da-DK skriver datoen med punktummer. Skråstreger er det LoL-botten bruger,
 * og de to bots skal se ens ud i samme chat, så de byttes her.
 */
export function formatDate(timezone, at = Date.now()) {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: timezone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(at))
    .replace(/\./g, '/');
}

/** "kl 00:00" — da-DK skriver 00.00, og kolon er husstilen. */
export function formatClock(timezone, at = Date.now()) {
  const time = new Intl.DateTimeFormat('da-DK', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(at))
    .replace('.', ':');

  return `kl ${time}`;
}

/** "1t 23m" eller "23m" eller "45s" */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}t ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Starten på det lokale døgn som et UNIX-millisekundtal, brugt som `from` når
 * dagens kampe skal hentes.
 *
 * Udregnet ved at spørge Intl om tidszonens aktuelle forskydning frem for at
 * hardkode en, så sommertid passer af sig selv.
 */
export function startOfLocalDay(timezone, at = Date.now()) {
  const key = localDateKey(timezone, at);
  const [year, month, day] = key.split('-').map(Number);

  // Gæt på midnat UTC, mål hvad tidszonen så viser, og korriger.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const shown = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(new Date(guess))
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z'),
  ).getTime();

  return guess - (shown - guess);
}

/**
 * Næste faste klokkeslæt delelig med intervallet, så alle i chatten ser den
 * samme opdateringstid. 1440 minutter = lokal midnat.
 */
export function nextBoundary(intervalMinutes, at = Date.now()) {
  const intervalMs = intervalMinutes * 60_000;
  return Math.floor(at / intervalMs) * intervalMs + intervalMs;
}
