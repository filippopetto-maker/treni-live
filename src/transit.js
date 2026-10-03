// Mezzi urbani da feed GTFS-Realtime (VehiclePositions), caricati solo su richiesta:
// il browser li chiede quando si zooma su una zona coperta da un feed.
// Include un decoder protobuf minimale, così il progetto resta senza dipendenze.

import fs from 'node:fs/promises';
import { fetchWithTimeout, log } from './util.js';
import { GtfsStatic } from './gtfs-static.js';

// ---------- decoder protobuf minimale ----------

export class Reader {
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
  /** int32 con segno: i negativi arrivano come varint da 10 byte, contano i 32 bit bassi. */
  int32() {
    let lo = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.b[this.p++];
      if (shift < 32) lo |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return lo | 0;
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

export function parse(buf, fields) {
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

/**
 * Ritardi dal feed TripUpdates: Map trip_id → { cancelled, upd: [{ seq, stop, delay, time }] }.
 * `delay` in secondi (può mancare), `time` in secondi Unix (può mancare).
 */
export function decodeTripUpdates(buf) {
  const out = new Map();
  const event = (r) => {
    const e = {};
    parse(r.bytes(), {
      1: (r2) => (e.delay = r2.int32()),
      2: (r2) => (e.time = r2.varint()),
    });
    return e;
  };
  parse(buf, {
    2: (r) =>
      parse(r.bytes(), {
        3: (r2) => {
          let trip = null;
          let cancelled = false;
          let tripDelay;
          const upd = [];
          parse(r2.bytes(), {
            1: (r3) =>
              parse(r3.bytes(), {
                1: (r4) => (trip = r4.string()),
                4: (r4) => (cancelled = r4.varint() === 3),
              }),
            2: (r3) => {
              const u = {};
              parse(r3.bytes(), {
                1: (r4) => (u.seq = r4.varint()),
                2: (r4) => (u.arr = event(r4)),
                3: (r4) => (u.dep = event(r4)),
                4: (r4) => (u.stop = r4.string()),
                5: (r4) => (u.skipped = r4.varint() === 1),
              });
              const e = u.arr || u.dep || {};
              upd.push({ seq: u.seq, stop: u.stop, delay: e.delay, time: e.time, skipped: u.skipped });
            },
            5: (r3) => (tripDelay = r3.int32()),
          });
          if (trip) out.set(trip, { cancelled, delay: tripDelay, upd });
        },
      }),
  });
  return out;
}

const EFFECTS = { 1: 'NO_SERVICE', 2: 'REDUCED_SERVICE', 3: 'SIGNIFICANT_DELAYS', 4: 'DETOUR', 5: 'ADDITIONAL_SERVICE', 6: 'MODIFIED_SERVICE', 7: 'OTHER_EFFECT', 8: 'UNKNOWN_EFFECT', 9: 'STOP_MOVED' };

/** Avvisi (ServiceAlerts): [{ id, start, end, routes, stops, effect, header, text }]. Orari in secondi Unix. */
export function decodeAlerts(buf) {
  const out = [];
  const tr = (r) => {
    let it = '';
    let any = '';
    parse(r.bytes(), {
      1: (r2) => {
        let text = '';
        let lang = '';
        parse(r2.bytes(), { 1: (r3) => (text = r3.string()), 2: (r3) => (lang = r3.string()) });
        if (!any) any = text;
        if (/^it/i.test(lang)) it = text;
      },
    });
    return it || any;
  };
  parse(buf, {
    2: (r) => {
      const a = { routes: [], stops: [], periods: [] };
      parse(r.bytes(), {
        1: (r2) => (a.id = r2.string()),
        5: (r2) =>
          parse(r2.bytes(), {
            1: (r3) => {
              const p = [0, 0];
              parse(r3.bytes(), { 1: (r4) => (p[0] = r4.varint()), 2: (r4) => (p[1] = r4.varint()) });
              a.periods.push(p);
            },
            5: (r3) =>
              parse(r3.bytes(), {
                2: (r4) => a.routes.push(r4.string()),
                5: (r4) => a.stops.push(r4.string()),
              }),
            7: (r3) => (a.effect = EFFECTS[r3.varint()] || 'UNKNOWN_EFFECT'),
            10: (r3) => (a.header = tr(r3)),
            11: (r3) => (a.text = tr(r3)),
          }),
      });
      if (a.header || a.text) out.push(a);
    },
  });
  return out;
}

// ---------- gestione dei feed ----------

export class TransitFeeds {
  constructor(file, dataDir) {
    this.file = file;
    this.dataDir = dataDir;
    this.feeds = [];
    this.statics = new Map(); // id feed → GtfsStatic
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
    for (const f of this.feeds) {
      if (!f.static) continue;
      const g = new GtfsStatic({ dataDir: this.dataDir, feed: f });
      this.statics.set(f.id, g);
      g.start(); // in sottofondo
    }
  }

  /** Percorso completo della corsa di un veicolo, dal GTFS statico del feed. */
  vehicleRoute(feedId, tripId, routeId) {
    if (feedId === 'astral') return this.astral?.routeCoords(routeId) || null;
    return this.statics.get(feedId)?.route(tripId, routeId) || null;
  }

  list() {
    return this.feeds.map(({ id, name, bbox }) => ({
      id,
      name,
      bbox,
      error: this.cache.get(id)?.error,
      gtfsStatico: this.statics.get(id)?.state,
    }));
  }

  /** Ritardi in tempo reale (TripUpdates) del feed, con cache di 30 s. null se il feed non li ha. */
  async tripUpdates(feedId) {
    const feed = this.feeds.find((f) => f.id === feedId);
    if (!feed?.tripUpdates) return null;
    this.tu ||= new Map();
    const c = this.tu.get(feedId);
    if (c && Date.now() - c.at < 30_000) return c;
    if (c?.p) return c.p;
    const p = (async () => {
      try {
        const res = await fetchWithTimeout(feed.tripUpdates, { headers: feed.headers || {} }, 20_000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const entry = { at: Date.now(), trips: decodeTripUpdates(Buffer.from(await res.arrayBuffer())) };
        this.tu.set(feedId, entry);
        return entry;
      } catch (e) {
        log(`Ritardi ${feedId}: ${e.message}`);
        const entry = { at: Date.now(), trips: c?.trips || new Map(), error: e.message };
        this.tu.set(feedId, entry);
        return entry;
      }
    })();
    this.tu.set(feedId, { ...(c || { at: 0 }), p });
    return p;
  }

  async vehicles(feed) {
    // Feed solo con orari statici (es. Milano): niente posizioni in tempo reale.
    if (!feed.url) return { at: Date.now(), vehicles: [], error: null };
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
      const st = this.statics.get(f.id);
      for (const v of r.vehicles) {
        if (v.lon < x0 || v.lon > x1 || v.lat < y0 || v.lat > y1) continue;
        const extra = st?.ready ? st.info(v.trip, v.route) : {};
        vehicles.push({ feed: f.id, ...v, rname: extra.rname, dest: extra.dest, mode: extra.mode || 'bus' });
        if (vehicles.length >= 5000) break;
      }
    }
    // Metro ricostruita dagli orari (nessuna delle due città pubblica le posizioni live).
    const metro = [];
    if (this.metro) {
      for (const f of hit) {
        if (!this.statics.get(f.id)?.ready) continue;
        try {
          metro.push(...(await this.metro.vehicles(f.id, bb)));
        } catch (e) {
          log(`Metro ${f.id}: ${e.message}`);
        }
      }
    }
    // Metromare e Roma–Viterbo (ASTRAL): orario + ritardi e soppressioni comunicati da ASTRAL.
    if (this.astral && !(bb[2] < 11.8 || bb[0] > 12.75 || bb[3] < 41.6 || bb[1] > 42.5)) {
      try {
        metro.push(...(await this.astral.vehicles(bb)));
      } catch (e) {
        log(`ASTRAL: ${e.message}`);
      }
    }
    const metroStatus = this.metro?.status ? this.metro.status.summary(hit.map((f) => f.id)) : [];
    return { feeds: hit.map((f) => ({ id: f.id, name: f.name, error: this.cache.get(f.id)?.error })), vehicles, metro, metroStatus };
  }
}
