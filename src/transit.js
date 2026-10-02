// Mezzi urbani da feed GTFS-Realtime (VehiclePositions), caricati solo su richiesta:
// il browser li chiede quando si zooma su una zona coperta da un feed.
// Include un decoder protobuf minimale, così il progetto resta senza dipendenze.

import fs from 'node:fs/promises';
import { fetchWithTimeout, log } from './util.js';

// ---------- decoder protobuf minimale ----------

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  eof() {
    return this.p >= this.b.length;
  }
  varint() {
    let r = 0;
    let mul = 1;
    let byte;
    do {
      byte = this.b[this.p++];
      r += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return r;
  }
  bytes() {
    const n = this.varint();
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  string() {
    return this.bytes().toString('utf8');
  }
  float() {
    const v = this.b.readFloatLE(this.p);
    this.p += 4;
    return v;
  }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) {
      // Attenzione: `this.p += this.varint()` leggerebbe p prima che varint() lo faccia avanzare.
      const n = this.varint();
      this.p += n;
    }
    else if (wt === 5) this.p += 4;
    else throw new Error('wire type non supportato: ' + wt);
  }
}

function parse(buf, fields) {
  const r = new Reader(buf);
  while (!r.eof()) {
    const tag = r.varint();
    const f = Math.floor(tag / 8);
    const wt = tag & 7;
    if (fields[f]) fields[f](r, wt);
    else r.skip(wt);
  }
}

/** Estrae le posizioni dei veicoli da un FeedMessage GTFS-Realtime. */
export function decodeVehiclePositions(buf) {
  const out = [];
  parse(buf, {
    2: (r) => {
      const ent = {};
      parse(r.bytes(), {
        1: (r2) => (ent.id = r2.string()),
        4: (r2) => {
          parse(r2.bytes(), {
            1: (r3) =>
              parse(r3.bytes(), {
                1: (r4) => (ent.trip = r4.string()),
                5: (r4) => (ent.route = r4.string()),
              }),
            2: (r3) =>
              parse(r3.bytes(), {
                1: (r4) => (ent.lat = r4.float()),
                2: (r4) => (ent.lon = r4.float()),
                3: (r4) => (ent.bearing = Math.round(r4.float())),
                5: (r4) => (ent.speed = Math.round(r4.float() * 3.6)),
              }),
            5: (r3) => (ent.ts = r3.varint()),
            8: (r3) =>
              parse(r3.bytes(), {
                1: (r4) => (ent.vid = r4.string()),
                2: (r4) => (ent.vlabel = r4.string()),
              }),
          });
        },
      });
      if (ent.lat && ent.lon) out.push(ent);
    },
  });
  return out;
}

// ---------- gestione dei feed ----------

export class TransitFeeds {
  constructor(file) {
    this.file = file;
    this.feeds = [];
    this.cache = new Map(); // id → { at, vehicles, error }
    this.inflight = new Map();
  }

  async load() {
    try {
      this.feeds = JSON.parse(await fs.readFile(this.file, 'utf8')).filter((f) => f.enabled !== false);
      log(`Mezzi urbani: ${this.feeds.length} feed configurati (${this.feeds.map((f) => f.id).join(', ')})`);
    } catch (e) {
      log('Mezzi urbani: feeds.json non leggibile:', e.message);
    }
  }

  list() {
    return this.feeds.map(({ id, name, bbox }) => ({ id, name, bbox, error: this.cache.get(id)?.error }));
  }

  async vehicles(feed) {
    const c = this.cache.get(feed.id);
    if (c && Date.now() - c.at < (feed.refreshMs || 20_000)) return c;
    if (this.inflight.has(feed.id)) return this.inflight.get(feed.id);
    const p = (async () => {
      try {
        const res = await fetchWithTimeout(feed.url, { headers: feed.headers || {} }, 20_000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const entry = { at: Date.now(), vehicles: decodeVehiclePositions(buf), error: null };
        this.cache.set(feed.id, entry);
        return entry;
      } catch (e) {
        const entry = { at: Date.now(), vehicles: c?.vehicles || [], error: e.message };
        this.cache.set(feed.id, entry);
        log(`Mezzi urbani: errore feed ${feed.id}: ${e.message}`);
        return entry;
      } finally {
        this.inflight.delete(feed.id);
      }
    })();
    this.inflight.set(feed.id, p);
    return p;
  }

  /** Veicoli dentro il riquadro [minLon, minLat, maxLon, maxLat], solo dai feed che lo toccano. */
  async inBbox(bb) {
    const [x0, y0, x1, y1] = bb;
    const hit = this.feeds.filter((f) => !(f.bbox[2] < x0 || f.bbox[0] > x1 || f.bbox[3] < y0 || f.bbox[1] > y1));
    const results = await Promise.all(hit.map((f) => this.vehicles(f).then((r) => ({ f, r }))));
    const vehicles = [];
    for (const { f, r } of results) {
      for (const v of r.vehicles) {
        if (v.lon < x0 || v.lon > x1 || v.lat < y0 || v.lat > y1) continue;
        vehicles.push({ feed: f.id, ...v });
        if (vehicles.length >= 5000) break;
      }
    }
    return { feeds: hit.map((f) => ({ id: f.id, name: f.name, error: this.cache.get(f.id)?.error })), vehicles };
  }
}
