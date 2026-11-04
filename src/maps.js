/**
 * Mapnavne.
 *
 * LoL-botten hentede championnavne fra Data Dragon, fordi der er 170 af dem og
 * de ændrer sig. CS har en håndfuld, og de skifter kun når Valve roterer
 * puljen, så en statisk tabel er både hurtigere og mere pålidelig end et
 * opslag ved opstart.
 *
 * FACEIT skriver dem med de_-præfiks i kampdata. Nøglen er præfikset, værdien
 * er det navn folk faktisk bruger i chatten.
 */
const NAMES = {
  de_mirage: 'Mirage',
  de_inferno: 'Inferno',
  de_nuke: 'Nuke',
  de_ancient: 'Ancient',
  de_anubis: 'Anubis',
  de_dust2: 'Dust2',
  de_train: 'Train',
  de_overpass: 'Overpass',
  de_vertigo: 'Vertigo',
  de_cache: 'Cache',
  de_cbble: 'Cobblestone',
  de_tuscan: 'Tuscan',
  de_office: 'Office',
  de_italy: 'Italy',
  cs_office: 'Office',
  cs_italy: 'Italy',
};

/**
 * Mapnavnet som det skrives i chatten.
 *
 * Et ukendt map får sit rå navn pænet op frem for at blive skjult: en ny map i
 * puljen skal ikke få !lastgame til at sige "ukendt", og en manglende linje i
 * tabellen her er en kosmetisk fejl, ikke en funktionel.
 */
export function mapName(raw) {
  if (!raw) return null;

  const key = String(raw).trim().toLowerCase();
  if (NAMES[key]) return NAMES[key];

  // "de_somethingnew" -> "Somethingnew"
  const stripped = key.replace(/^(de|cs|ar|dz)_/, '');
  if (!stripped) return null;

  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
