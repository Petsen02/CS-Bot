/**
 * Lille in-memory cache med udløb pr. post og en størrelsesgrænse.
 *
 * TTL Infinity udløber aldrig, hvilket passer til værdier der er uforanderlige
 * når de først findes: en nicks player_id, en færdigspillet kamp. Netop de
 * poster har stadig brug for en grænse — processen kører i måneder, så en
 * ubegrænset cache af kamp-payloads vokser til containeren bliver dræbt.
 *
 * Udsmidning er least-recently-used: at læse en post gør den frisk igen.
 */
export class TtlCache {
  #entries = new Map();

  constructor(defaultTtlMs, maxEntries = Infinity) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  get size() {
    return this.#entries.size;
  }

  #evictIfFull() {
    // Map holder indsættelsesrækkefølgen, så første nøgle er den ældste.
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      this.#entries.delete(oldest);
    }
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }

    // Sæt ind igen, så nøglen tælles som den nyest brugte.
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    const expiresAt = ttlMs === Infinity ? Infinity : Date.now() + ttlMs;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });
    this.#evictIfFull();
    return value;
  }

  /** Den cachede værdi, ellers beregnes, gemmes og returneres en ny. */
  wrap(key, producer, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    // Selve promiset caches, så en byge af chatkommandoer deler ét kald opad
    // i stedet for at affyre hver sit. Fejl smides ud med det samme, så en
    // forbigående FACEIT-udfald ikke hænger hele TTL'en ud.
    const pending = producer().catch((error) => {
      this.#entries.delete(key);
      throw error;
    });

    return this.set(key, pending, ttlMs);
  }
}
