import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, projectRoot } from './config.js';
import { store } from './store.js';
import { formatDate, formatClock } from './time.js';

/**
 * En almindelig tekstliste med Twitch-navn over for FACEIT-nick, i
 * data/spillere.txt.
 *
 * Alle der bliver slået op ved navn havner på watch-listen, og navnet på den
 * der spurgte følger med. Denne fil er netop den parring, skrevet så den kan
 * åbnes i en filhåndtering — trackerens egen tilstand er SQLite, som ikke kan.
 *
 * Parringen er et gæt, og et ærligt et kun fordi folk mest slår sig selv op.
 * Intet forhindrer en seer i at spørge om en andens konto, og botten kan ikke
 * se forskel, så Twitch-navnet her betyder "hvem introducerede dette nick",
 * ikke "hvem ejer det".
 *
 * Det er en visning, ikke et arkiv: skrives helt om ved hver pollrunde, og er
 * harmløs at slette.
 */

const DATA_DIR = join(projectRoot, 'data');
const FILE = join(DATA_DIR, 'spillere.txt');

const UNKNOWN = '—';

function rows() {
  return store
    .watchedAccounts()
    .map((entry) => ({
      twitch: entry.twitch || UNKNOWN,
      nickname: entry.nickname || UNKNOWN,
      steamId: entry.steamId || '',
    }))
    .sort((a, b) => a.twitch.localeCompare(b.twitch, 'da'));
}

export function render(entries, now = Date.now()) {
  const linked = entries.filter((entry) => entry.twitch !== UNKNOWN).length;
  const when = `${formatDate(config.timezone, now)} ${formatClock(config.timezone, now)}`;

  const lines = [
    `Linkede konti — ${entries.length} i alt, ${linked} med Twitch-navn`,
    `Opdateret ${when}`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('Ingen endnu. En konto linkes automatisk, første gang nogen');
    lines.push('skriver fx !rank <sit nick> i chatten.');
    return `${lines.join('\n')}\n`;
  }

  const width = (pick, min) => Math.max(min, ...entries.map((entry) => pick(entry).length));
  const twitchWidth = width((entry) => entry.twitch, 'Twitch'.length);
  const nickWidth = width((entry) => entry.nickname, 'FACEIT'.length);

  const header = `${'Twitch'.padEnd(twitchWidth)}  ${'FACEIT'.padEnd(nickWidth)}  SteamID`;
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const entry of entries) {
    lines.push(
      `${entry.twitch.padEnd(twitchWidth)}  ${entry.nickname.padEnd(nickWidth)}  ${entry.steamId}`
        .trimEnd(),
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Skriver listen. Kaster aldrig: en fil der ikke kan skrives er ikke en grund
 * til at tage trackeren med sig.
 */
export function writePlayerReport(now = Date.now()) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });

    const temp = `${FILE}.tmp`;
    writeFileSync(temp, render(rows(), now), 'utf8');
    renameSync(temp, FILE);
  } catch (error) {
    process.stderr.write(`[report] kunne ikke skrive spillerlisten: ${error.message}\n`);
  }
}
