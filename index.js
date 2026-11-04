/**
 * Indgang i roden, med sin egen opstartslog.
 *
 * To grunde til at denne fil findes:
 *
 * 1. Node-værter kører som standard `index.js` i projektroden — Pterodactyl
 *    og Pelican har det som standardværdi. Botten ligger i src/.
 *
 * 2. Vigtigere: alt hvad der kan gå galt under opstart, går galt FØR botten
 *    kan logge noget. Den første ikke-indbyggede import er `tmi.js`, og
 *    mangler den, kaster Node inden loggeren overhovedet er indlæst. På en
 *    server hvor konsollen er upålidelig efterlader det nul spor — kun en
 *    container der standser.
 *
 * Derfor skriver denne fil til logs/boot.log med node:fs alene, før noget
 * andet indlæses, og fanger enhver fejl undervejs. Filen kan læses i et
 * panels filhåndtering, og den siger hvad der fejlede frem for ingenting.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const bootLog = join(root, 'logs', 'boot.log');

/** Skriver en linje, og fejler aldrig — en log må ikke vælte opstarten. */
function note(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  process.stdout.write(`${stamped}\n`);
  try {
    mkdirSync(dirname(bootLog), { recursive: true });
    appendFileSync(bootLog, `${stamped}\n`, 'utf8');
  } catch {
    // Kan der ikke skrives, er stdout stadig forsøgt.
  }
}

note(`opstart — node ${process.version}`);
note(`mappe: ${root}`);

let bot;
try {
  bot = await import('./src/index.js');
  note('moduler indlæst');
} catch (error) {
  note(`KUNNE IKKE INDLÆSE: ${error?.stack ?? error?.message ?? error}`);

  // De to typiske årsager, med en konkret udvej hver.
  const message = String(error?.message ?? '');
  if (/Cannot find (package|module)/i.test(message)) {
    note('→ afhængigheder mangler. Kør `npm install` i mappen ovenfor.');
  } else if (/Manglende indstilling|skal være/i.test(message)) {
    note('→ en værdi i .env er forkert eller mangler. Se .env.example.');
  }

  process.exitCode = 1;
}

if (bot) {
  bot.main().catch((error) => {
    note(`FATAL: ${error?.stack ?? error?.message ?? error}`);
    bot.runFatal(error);
  });
}
