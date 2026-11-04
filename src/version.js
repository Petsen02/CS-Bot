import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

/**
 * Hvilken commit der kører.
 *
 * Findes fordi "har serveren hentet den nye kode" ellers kun kan besvares ved
 * at lede efter en ændring i opførslen — og flere fejlsøgninger i dag endte
 * med at botten kørte en version fra før rettelsen uden at nogen kunne se det.
 *
 * Læser git-mappen direkte. Ingen afhængigheder, og den virker i en container
 * hvor `git` ikke nødvendigvis er installeret.
 */
export function gitRevision() {
  try {
    const head = readFileSync(join(projectRoot, '.git', 'HEAD'), 'utf8').trim();

    // Løsrevet HEAD: filen ER allerede commit-id'et.
    if (!head.startsWith('ref:')) return short(head);

    const ref = head.slice(4).trim();

    try {
      return short(readFileSync(join(projectRoot, '.git', ref), 'utf8').trim());
    } catch {
      // Efter en gc ligger referencen i packed-refs i stedet for sin egen fil.
      const packed = readFileSync(join(projectRoot, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? short(line.split(' ')[0]) : null;
    }
  } catch {
    // Ingen git-mappe: kørt fra et zip-udtræk eller lignende.
    return null;
  }
}

function short(sha) {
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : null;
}
