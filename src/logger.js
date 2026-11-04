import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

/**
 * Logning til fil og nedbrudsrapporter.
 *
 * Botten kører som en systemd-tjeneste i måneder ad gangen. Når den opfører sig
 * forkert, er spørgsmålet altid "hvad skete der for tre dage siden", og det
 * svarer journalctl kun på hvis man var forudseende nok til at bede om det.
 * Derfor skriver den sin egen log, og lægger hver uhåndteret fejl i sin egen
 * fil med fuld stak frem for kun at skrive den til stderr.
 */

const LOG_DIR = join(projectRoot, 'logs');
const CRASH_DIR = join(LOG_DIR, 'crashes');

export const logPaths = {
  logs: LOG_DIR,
  crashes: CRASH_DIR,
};

function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(CRASH_DIR, { recursive: true });
}

function logFileFor(at = new Date()) {
  return join(LOG_DIR, `${at.toISOString().slice(0, 10)}.log`);
}

/** Skriver en linje til dagens logfil. Fejler stille — log må aldrig vælte botten. */
export function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;

  try {
    ensureDirs();
    appendFileSync(logFileFor(), line, 'utf8');
  } catch {
    // Et fuldt disk eller en read-only mount må ikke stoppe chatten.
  }

  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

export const logger = {
  info: (message) => log('info', message),
  warn: (message) => log('warn', message),
  error: (message) => log('error', message),
};

function writeCrash(kind, error) {
  const at = new Date();
  const name = `${at.toISOString().replace(/[:.]/g, '-')}-${kind}.txt`;

  const body = [
    `kind: ${kind}`,
    `at:   ${at.toISOString()}`,
    `node: ${process.version}`,
    '',
    error?.stack ?? String(error),
    '',
  ].join('\n');

  try {
    ensureDirs();
    writeFileSync(join(CRASH_DIR, name), body, 'utf8');
  } catch {
    // Ingenting at gøre hvis selv nedbrudsrapporten ikke kan skrives.
  }

  log('error', `${kind}: ${error?.message ?? error}`);
}

/**
 * Fanger det der ellers ville dræbe processen uden spor, og giver kalderen en
 * chance for at gemme tilstand først.
 *
 * Målte elo-tal der kun findes i hukommelsen er tabt ved et nedbrud, og det er
 * netop dem der ikke kan genskabes fra API'et.
 */
export function installCrashHandlers(flush) {
  const persist = () => {
    try {
      flush?.();
    } catch (error) {
      log('error', `kunne ikke gemme tilstand: ${error.message}`);
    }
  };

  process.on('uncaughtException', (error) => {
    writeCrash('uncaughtException', error);
    persist();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    // En afvisning med en bar streng, eller med undefined, har ingen stak.
    // Pak den så rapporten peger på noget frem for at sige "undefined".
    const error = reason instanceof Error
      ? reason
      : new Error(`afvist uden Error: ${String(reason ?? 'undefined')}`);

    writeCrash('unhandledRejection', error);
    persist();
  });

  // systemd sender SIGTERM ved restart og stop. Uden dette ville hver
  // genstart smide dagens umålte elo væk.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', `${signal} modtaget — gemmer og lukker`);
      persist();
      process.exit(0);
    });
  }
}
