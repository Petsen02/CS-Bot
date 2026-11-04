/**
 * Rate limiter for udgående kald.
 *
 * FACEIT's dokumenterede budget er endnu ikke bekræftet, så vinduerne kommer
 * fra .env og er sat lavt som udgangspunkt. Alle kald kanaliseres herigennem
 * frem for at stole på at caches og cooldowns tilfældigvis holder forbruget
 * nede: et 429 kaskaderer til fejlede kommandoer i alle kanaler på én gang.
 *
 * Kaldere stiller sig i kø og betjenes i rækkefølge; intet smides væk.
 */
export class RateLimiter {
  #windows;
  #chain = Promise.resolve();

  /** @param windows fx [{ limit: 5, windowMs: 1000 }, { limit: 400, windowMs: 600000 }] */
  constructor(windows) {
    this.#windows = windows.map((window) => ({ ...window, hits: [] }));
  }

  #waitFor(now) {
    let longest = 0;

    for (const window of this.#windows) {
      while (window.hits.length > 0 && window.hits[0] <= now - window.windowMs) {
        window.hits.shift();
      }

      if (window.hits.length >= window.limit) {
        longest = Math.max(longest, window.hits[0] + window.windowMs - now);
      }
    }

    return longest;
  }

  #record(now) {
    for (const window of this.#windows) window.hits.push(now);
  }

  /** Resolver når kalderen må sende sin forespørgsel. */
  acquire() {
    // Serialisering på en promise-kæde holder regnskabet fri for races uden
    // låse: hver venter ser de hits den foregående har bogført.
    const result = this.#chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const wait = this.#waitFor(now);

        if (wait === 0) {
          this.#record(now);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    });

    this.#chain = result.catch(() => {});
    return result;
  }
}
