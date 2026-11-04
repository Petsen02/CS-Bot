/**
 * FACEIT-elo og skill level.
 *
 * Langt simplere end Leagues rangsystem: ét tal, ti faste grænser, ingen
 * divisioner og ingen promotion-serier. Derfor er "hvor langt til næste level"
 * ren subtraktion, hvor LoL-botten skal regne i LP, divisioner og tiers.
 */

/**
 * Nedre elo-grænse for hvert level. Level 10 har ingen øvre grænse.
 *
 * Grænserne har flyttet sig historisk — ældre guides har level 9 fra 1851 —
 * så de står samlet her med kun én kilde til sandheden. Skal de justeres, er
 * det én diff.
 *
 * Tallene er ikke bekræftet mod FACEIT's egen supportside, som ikke kunne nås
 * fra udviklingsmiljøet. De stemmer mellem flere uafhængige oversigter.
 */
export const LEVEL_FLOORS = [
  { level: 1, min: 100 },
  { level: 2, min: 501 },
  { level: 3, min: 751 },
  { level: 4, min: 901 },
  { level: 5, min: 1051 },
  { level: 6, min: 1201 },
  { level: 7, min: 1351 },
  { level: 8, min: 1531 },
  { level: 9, min: 1751 },
  { level: 10, min: 2001 },
];

/** Elo-gulvet hos FACEIT. Nye konti starter over dette. */
export const ELO_FLOOR = 100;

/**
 * Levelet en elo hører til.
 *
 * Elo under gulvet burde ikke findes, men en API der svarer 0 eller null skal
 * ikke give `undefined` videre ind i en chatbesked, så det klemmes til 1.
 */
export function levelFor(elo) {
  if (!Number.isFinite(elo)) return null;

  let current = 1;
  for (const { level, min } of LEVEL_FLOORS) {
    if (elo >= min) current = level;
  }
  return current;
}

/**
 * Næste level og hvad der mangler, eller null for en spiller på level 10.
 *
 * @returns {{ level: number, min: number, needed: number } | null}
 */
export function nextLevel(elo) {
  if (!Number.isFinite(elo)) return null;

  const next = LEVEL_FLOORS.find(({ min }) => elo < min);
  if (!next) return null; // Level 10 — der er ikke mere at nå.

  return { level: next.level, min: next.min, needed: next.min - elo };
}

/**
 * Hvor mange sejre der mangler, ud fra spillerens egen målte gennemsnitlige
 * elo-gevinst.
 *
 * Langt bedre end at antage et fast tal: FACEIT giver omkring 25 ved jævnbyrdig
 * matchning, men afviger meget når modstanderne er stærkere eller svagere.
 * Returnerer null indtil mindst én sejr er målt, frem for at gætte.
 */
export function winsNeeded(needed, averageGain) {
  if (!Number.isFinite(averageGain) || averageGain <= 0) return null;
  return Math.ceil(needed / averageGain);
}

/**
 * Levelet som det skrives i chatten.
 *
 * "emotes" skriver LEVEL7, som 7TV bytter til et ikon hos seere med
 * udvidelsen. Uden den læses det som almindelig tekst, hvilket stadig virker.
 * "letters" er til kanaler uden emote-sættet.
 */
export function formatLevel(level, style) {
  if (level === null) return '';
  return style === 'letters' ? `L${level}` : `LEVEL${level}`;
}

/** "PETSEN LEVEL10: 2347 elo" / "PETSEN L10 2347elo" */
export function formatPlayerElo({ nickname, elo, level }, style) {
  const shown = level ?? levelFor(elo);
  const label = formatLevel(shown, style);

  if (!Number.isFinite(elo)) return `${nickname} ${label}`.trim();

  return style === 'letters'
    ? `${nickname} ${label} ${elo}elo`
    : `${nickname} ${label}: ${elo} elo`;
}

/** "+47" / "-23" / "±0" — fortegnet skal altid med. */
export function formatEloDelta(delta) {
  if (!Number.isFinite(delta)) return '';
  if (delta === 0) return '±0';
  return delta > 0 ? `+${delta}` : `${delta}`;
}
