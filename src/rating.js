/**
 * HLTV Rating 1.0, regnet ud af kampens egne tal.
 *
 * FACEIT Rating og Round Swing er ikke i Data API'et — målt på to spillere og
 * tre kampe, 47 felter, ingen af dem. De findes kun i FACEIT's web-UI.
 *
 * Rating 1.0 er derimod en offentligt beskrevet formel, og den bruger kun
 * felter vi får: kills, deaths, runder og multi-kills. Den er altså ikke et
 * opfundet tal, men den samme udregning HLTV selv offentliggjorde — derfor
 * hedder feltet "HLTV" i svaret og ikke "rating", så den ikke forveksles med
 * FACEIT's egen.
 *
 * Rating 2.0 kan IKKE regnes: den kræver KAST, som heller ikke er i svaret.
 */

// Gennemsnit for en typisk runde, fra HLTV's egen beskrivelse af formlen.
const AVERAGE_KPR = 0.679;
const AVERAGE_SPR = 0.317;
const AVERAGE_RMK = 1.277;

/**
 * @returns {number|null} null når et af de nødvendige tal mangler. Et gæt er
 *   værre end et tomt felt, og resten af linjen klarer sig fint uden.
 */
export function hltvRating({ kills, deaths, rounds, doubles, triples, quads, aces }) {
  if (!Number.isFinite(kills) || !Number.isFinite(deaths)) return null;
  if (!Number.isFinite(rounds) || rounds <= 0) return null;

  const k2 = finite(doubles);
  const k3 = finite(triples);
  const k4 = finite(quads);
  const k5 = finite(aces);

  // Runder med præcis ét drab udledes: de øvrige drab er bundet i multi-kills.
  // Et negativt tal betyder uenige felter i svaret, og klemmes til nul frem
  // for at trække ratingen ned på et regnestykke der ikke går op.
  const k1 = Math.max(0, kills - 2 * k2 - 3 * k3 - 4 * k4 - 5 * k5);

  const killRating = kills / rounds / AVERAGE_KPR;
  const survivalRating = (rounds - deaths) / rounds / AVERAGE_SPR;
  const multiKillRating =
    (1 * k1 + 4 * k2 + 9 * k3 + 16 * k4 + 25 * k5) / rounds / AVERAGE_RMK;

  const rating = (killRating + 0.7 * survivalRating + multiKillRating) / 2.7;

  return Number.isFinite(rating) && rating >= 0 ? rating : null;
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}
