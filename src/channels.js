import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  projectRoot,
  REGIONS,
  normalizeRegion,
  normalizeCountry,
  defaultRegion,
  defaultCountry,
} from './config.js';

/**
 * Opsætning pr. kanal.
 *
 * Hver kanal ejer sin spillerliste, sin main, sin region og sit land, så én bot
 * kan betjene flere streamere uden at de ser hinandens spillere. Landet er
 * ekstra her sammenlignet med LoL-botten, fordi !top viser en landeplacering —
 * en svensk streamer skal se SE, ikke DK.
 *
 * Mods redigerer dette fra chatten, så det skal være holdbart og sikkert at
 * skrive på et vilkårligt tidspunkt — deraf samme atomare skrivning som
 * tracker-tilstanden.
 */

const DATA_DIR = join(projectRoot, 'data');
const FILE = join(DATA_DIR, 'channels.json');

function emptyState() {
  return { version: 1, channels: {} };
}

/** Normaliserer et kanalnavn som Twitch rapporterer det. */
export function normalizeChannel(name) {
  return name.trim().toLowerCase().replace(/^#/, '');
}

export class ChannelStore {
  #state;

  constructor(file = FILE) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.#state = parsed?.channels ? parsed : emptyState();
    } catch {
      this.#state = emptyState();
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state, null, 2), 'utf8');
    renameSync(temp, this.file);
  }

  /** Kanalens opsætning, oprettet tom hvis den er ny. */
  get(name) {
    const key = normalizeChannel(name);

    this.#state.channels[key] ??= {
      region: defaultRegion,
      country: defaultCountry,
      players: [],
      main: null,
    };

    const channel = this.#state.channels[key];
    channel.players ??= [];
    channel.region ??= defaultRegion;
    channel.country ??= defaultCountry;

    return channel;
  }

  names() {
    return Object.keys(this.#state.channels);
  }

  ensure(name) {
    this.get(name);
    return this;
  }

  setRegion(name, region) {
    const value = normalizeRegion(region);
    if (!REGIONS.has(value)) return false;

    this.get(name).region = value;
    this.save();
    return true;
  }

  setCountry(name, country) {
    const value = normalizeCountry(country);
    if (!value) return false;

    this.get(name).country = value;
    this.save();
    return true;
  }

  /** @returns 'added' | 'duplicate' */
  addPlayer(name, player) {
    const channel = this.get(name);

    if (channel.players.some((p) => p.playerId === player.playerId)) return 'duplicate';

    channel.players.push({
      playerId: player.playerId,
      nickname: player.nickname,
      steamId: player.steamId ?? null,
    });
    this.save();
    return 'added';
  }

  /** @returns 'removed' | 'missing' */
  removePlayer(name, nickname) {
    const channel = this.get(name);
    const wanted = nickname.toLowerCase();

    const index = channel.players.findIndex((p) => p.nickname?.toLowerCase() === wanted);
    if (index === -1) return 'missing';

    const [removed] = channel.players.splice(index, 1);

    // En main der ikke længere er på listen ville i stilhed ødelægge !rank.
    if (channel.main && channel.main.toLowerCase() === removed.nickname?.toLowerCase()) {
      channel.main = null;
    }

    this.save();
    return 'removed';
  }

  setMain(name, nickname) {
    this.get(name).main = nickname;
    this.save();
  }

  /** @returns 'removed' | 'missing' */
  clearMain(name, nickname) {
    const channel = this.get(name);
    if (!channel.main || channel.main.toLowerCase() !== nickname.toLowerCase()) return 'missing';

    channel.main = null;
    this.save();
    return 'removed';
  }

  /** Mainen som en gemt spillerpost, ellers den første på listen. */
  mainPlayer(name) {
    const channel = this.get(name);

    if (channel.main) {
      const wanted = channel.main.toLowerCase();
      const found = channel.players.find((p) => p.nickname?.toLowerCase() === wanted);
      if (found) return found;
    }

    return channel.players[0] ?? null;
  }

  /** Opdaterer et gemt nick når et opslag viser at det er ændret. */
  renamePlayer(playerId, nickname) {
    let changed = false;

    for (const channel of Object.values(this.#state.channels)) {
      for (const player of channel.players ?? []) {
        if (player.playerId === playerId && player.nickname !== nickname) {
          if (channel.main && channel.main.toLowerCase() === player.nickname?.toLowerCase()) {
            channel.main = nickname;
          }
          player.nickname = nickname;
          changed = true;
        }
      }
    }

    if (changed) this.save();
    return changed;
  }

  /**
   * Hver konto trackeren skal følge, dedupliceret på tværs af kanaler: den
   * samme spiller fulgt i tre kanaler er stadig én konto at polle.
   */
  trackedPlayers() {
    const seen = new Map();

    for (const [name, channel] of Object.entries(this.#state.channels)) {
      for (const player of channel.players ?? []) {
        if (!seen.has(player.playerId)) {
          seen.set(player.playerId, {
            ...player,
            region: channel.region,
            channels: [name],
          });
        } else {
          seen.get(player.playerId).channels.push(name);
        }
      }
    }

    return [...seen.values()];
  }
}

export const channels = new ChannelStore();
