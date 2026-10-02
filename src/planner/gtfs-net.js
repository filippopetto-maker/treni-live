// Rete di trasporto urbano da GTFS statico, pronta per il calcolo dei percorsi.
//
// Al primo uso legge gli orari (stop_times.txt, centinaia di MB) e li salva in un formato
// binario compatto (data/gtfs/<id>/net.bin + file JSON): i caricamenti successivi
// richiedono pochi secondi. La rete resta in memoria solo mentre si usa il navigatore.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../util.js';

const run = promisify(execFile);
const CACHE_VERSION = 1;
const M_LAT = 110_540;
const M_LON = 111_320 * Math.cos((42 * Math.PI) / 180);
const CELL = 0.005; // ~500 m
const WALK_MPS = 1.2; // 4,3 km/h
const DETOUR = 1.3; // le strade non sono in linea d'aria
const TRANSFER_RADIUS_M = 350;

export const walkSeconds = (meters) => Math.round((meters * DETOUR) / WALK_MPS);

export function dist(aLat, aLon, bLat, bLon) {
  return Math.hypot((aLon - bLon) * M_LON, (aLat - bLat) * M_LAT);
}

const MODES = { 0: 'tram', 1: 'metro', 2: 'treno', 3: 'bus', 4: 'traghetto', 5: 'tram', 6: 'funivia', 7: 'funicolare', 11: 'filobus', 12: 'monorotaia' };
export const modeOf = (routeType) => {
  const t = Number(routeType);
  if (MODES[t]) return MODES[t];
  if (t >= 100 && t < 200) return 'treno';
  if (t >= 400 && t < 500) return 'metro';
  if (t >= 700 && t < 800) return 'bus';
  if (t >= 900 && t < 1000) return 'tram';
  return 'bus';
};

/** "25:07:30" → secondi dalla mezzanotte del giorno di servizio. */
function hms(s) {
  if (!s) return -1;
  const a = s.split(':');
  return +a[0] * 3600 + +a[1] * 60 + +(a[2] || 0);
}

function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, onRow) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let idx = null;
  let nCols = 0;
  for await (const line of rl) {
    if (!line) continue;
    // Via veloce: Milano mette tutto tra virgolette, ma di rado ci sono virgole nei campi.
    let cells = line.includes('"') ? line.replaceAll('"', '').split(',') : line.split(',');
    if (idx && cells.length !== nCols) cells = splitCsv(line);
    if (!idx) {
      cells = splitCsv(line);
      idx = {};
      nCols = cells.length;
      cells.forEach((h, i) => (idx[h.replace(/^﻿/, '').trim()] = i));
      continue;
    }
    onRow(cells, idx);
  }
}

export class GtfsNetwork {
  /**
   * @param {object} o
   * @param {string} o.dataDir   cartella data/
   * @param {object} o.feed      voce di feeds.json (id, name, bbox)
   * @param {object} o.statics   GtfsStatic dello stesso feed (linee, corse, forme)
   */
  constructor({ dataDir, feed, statics }) {
    this.feed = feed;
    this.id = feed.id;
    this.dir = path.join(dataDir, 'gtfs', feed.id);
    this.statics = statics;
    this.stops = null; // [{ id, name, lat, lon }]
    this.loaded = false;
    this.loading = null;
    this.dates = new Map(); // "20261002" → strutture per quel giorno
    this.lastUse = 0;
    this.tripDelay = null; // ritardi in tempo reale per corsa (secondi), se il feed li ha
  }

  // ---------- costruzione / caricamento cache ----------

  async ensureStops() {
    if (this.stops) return this.stops;
    await this.ensureCache();
    this.stops = JSON.parse(await fs.readFile(path.join(this.dir, 'stops.json'), 'utf8'));
    this.buildGrid();
    return this.stops;
  }

  /** Carica orari e indici (ci vogliono pochi secondi se la cache è pronta). */
  async load() {
    this.lastUse = Date.now();
    if (this.loaded) return this;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await this.ensureStops();
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, 'net.json'), 'utf8'));
      const buf = await fs.readFile(path.join(this.dir, 'net.bin'));
      const nT = buf.readUInt32LE(4);
      const nR = buf.readUInt32LE(8);
      const arr = (off, n) => new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4));
      let o = 12;
      this.tripOff = arr(o, nT + 1);
      o += (nT + 1) * 4;
      this.stIdx = arr(o, nR);
      o += nR * 4;
      this.stArr = arr(o, nR);
      o += nR * 4;
      this.stDep = arr(o, nR);
      this.tripIds = meta.trips;
      this.tripIndex = new Map(this.tripIds.map((t, i) => [t, i]));
      this.calendar = meta.calendar;
      this.calDates = meta.calDates;
      // Linea, servizio e destinazione di ogni corsa, dal GTFS già indicizzato per la mappa.
      const st = this.statics;
      this.tripService = this.tripIds.map((t) => st.trips.get(t)?.[3] ?? '');
      this.tripDelay = new Int32Array(this.tripIds.length);
      this.buildFootpaths();
      this.loaded = true;
      this.loading = null;
      log(`Navigatore: rete ${this.id} in memoria (${this.stops.length} fermate, ${nT.toLocaleString('it-IT')} corse)`);
      return this;
    })();
    return this.loading;
  }

  unload() {
    if (!this.loaded) return;
    this.loaded = false;
    this.tripOff = this.stIdx = this.stArr = this.stDep = null;
    this.tripIds = this.tripIndex = this.tripService = this.tripDelay = this.tripLive = this.lastTu = null;
    this.dates.clear();
    log(`Navigatore: rete ${this.id} tolta dalla memoria (inutilizzata)`);
  }

  async ensureCache() {
    const zip = path.join(this.dir, 'gtfs.zip');
    const zipStat = await fs.stat(zip).catch(() => null);
    if (!zipStat) throw new Error(`GTFS ${this.id} non ancora scaricato`);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, 'net-info.json'), 'utf8'));
      if (meta.version === CACHE_VERSION && meta.zipMtime === zipStat.mtimeMs) return;
    } catch {}
    await this.buildCache(zip, zipStat.mtimeMs);
  }

  async buildCache(zip, zipMtime) {
    const t0 = Date.now();
    log(`Navigatore: preparo gli orari di ${this.id} (una tantum, può richiedere un paio di minuti)…`);
    const tmp = path.join(this.dir, 'tmp');
    await fs.mkdir(tmp, { recursive: true });
    await run('unzip', ['-o', '-q', zip, 'stops.txt', 'stop_times.txt', 'calendar_dates.txt', '-d', tmp]);
    await run('unzip', ['-o', '-q', zip, 'calendar.txt', '-d', tmp]).catch(() => {});

    // Fermate (solo quelle dove si sale: location_type vuoto o 0)
    const stops = [];
    const stopIndex = new Map();
    await eachRow(path.join(tmp, 'stops.txt'), (c, i) => {
      const lt = c[i.location_type];
      if (lt && lt !== '0') return;
      const lat = +c[i.stop_lat];
      const lon = +c[i.stop_lon];
      if (!lat || !lon) return;
      stopIndex.set(c[i.stop_id], stops.length);
      stops.push({ id: c[i.stop_id], name: titleCase(c[i.stop_name] || c[i.stop_id]), lat, lon });
    });

    // Calendario
    const calendar = {};
    try {
      await eachRow(path.join(tmp, 'calendar.txt'), (c, i) => {
        calendar[c[i.service_id]] = {
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => c[i[d]] === '1'),
          start: c[i.start_date],
          end: c[i.end_date],
        };
      });
    } catch {}
    const calDates = {};
    await eachRow(path.join(tmp, 'calendar_dates.txt'), (c, i) => {
      const s = (calDates[c[i.service_id]] ||= { add: [], rem: [] });
      (c[i.exception_type] === '1' ? s.add : s.rem).push(c[i.date]);
    });

    // Orari: righe raggruppate per corsa e ordinate per stop_sequence
    const tripIndex = new Map();
    const trips = [];
    let cap = 1 << 22;
    let tr = new Int32Array(cap), sq = new Int32Array(cap), sp = new Int32Array(cap), ar = new Int32Array(cap), dp = new Int32Array(cap);
    let n = 0;
    const grow = () => {
      cap *= 2;
      const g = (a) => {
        const b = new Int32Array(cap);
        b.set(a);
        return b;
      };
      tr = g(tr); sq = g(sq); sp = g(sp); ar = g(ar); dp = g(dp);
    };
    await eachRow(path.join(tmp, 'stop_times.txt'), (c, i) => {
      const s = stopIndex.get(c[i.stop_id]);
      if (s === undefined) return;
      let t = tripIndex.get(c[i.trip_id]);
      if (t === undefined) {
        t = trips.length;
        tripIndex.set(c[i.trip_id], t);
        trips.push(c[i.trip_id]);
      }
      if (n === cap) grow();
      const a = hms(c[i.arrival_time]);
      const d = hms(c[i.departure_time]);
      tr[n] = t;
      sq[n] = +c[i.stop_sequence];
      sp[n] = s;
      ar[n] = a >= 0 ? a : d;
      dp[n] = d >= 0 ? d : a;
      n++;
    });
    const nT = trips.length;
    const tripOff = new Int32Array(nT + 1);
    for (let k = 0; k < n; k++) tripOff[tr[k] + 1]++;
    for (let t = 0; t < nT; t++) tripOff[t + 1] += tripOff[t];
    const fill = tripOff.slice(0, nT);
    const order = new Int32Array(n);
    for (let k = 0; k < n; k++) order[fill[tr[k]]++] = k;
    const stIdx = new Int32Array(n), stArr = new Int32Array(n), stDep = new Int32Array(n);
    for (let t = 0; t < nT; t++) {
      const rows = Array.from(order.subarray(tripOff[t], tripOff[t + 1])).sort((x, y) => sq[x] - sq[y]);
      rows.forEach((k, j) => {
        const o = tripOff[t] + j;
        stIdx[o] = sp[k];
        stArr[o] = ar[k];
        stDep[o] = dp[k];
      });
    }

    const header = Buffer.alloc(12);
    header.write('GNET', 0);
    header.writeUInt32LE(nT, 4);
    header.writeUInt32LE(n, 8);
    await fs.writeFile(
      path.join(this.dir, 'net.bin'),
      Buffer.concat([header, ...[tripOff, stIdx, stArr, stDep].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength))])
    );
    await fs.writeFile(path.join(this.dir, 'stops.json'), JSON.stringify(stops));
    await fs.writeFile(path.join(this.dir, 'net.json'), JSON.stringify({ trips, calendar, calDates }));
    await fs.writeFile(path.join(this.dir, 'net-info.json'), JSON.stringify({ version: CACHE_VERSION, zipMtime }));
    await fs.rm(tmp, { recursive: true, force: true });
    log(`Navigatore: orari di ${this.id} pronti in ${Math.round((Date.now() - t0) / 1000)}s (${nT.toLocaleString('it-IT')} corse, ${n.toLocaleString('it-IT')} passaggi)`);
  }

  // ---------- indici spaziali e trasbordi a piedi ----------

  buildGrid() {
    this.grid = new Map();
    this.stops.forEach((s, i) => {
      const k = Math.floor(s.lat / CELL) * 1e5 + Math.floor(s.lon / CELL);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(i);
    });
  }

  /** Fermate entro `radius` metri: [[indice, metri], …] dalla più vicina. */
  near(lat, lon, radius) {
    const r = Math.ceil(radius / (CELL * M_LON));
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    const out = [];
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        for (const i of this.grid.get(y * 1e5 + x) || []) {
          const d = dist(lat, lon, this.stops[i].lat, this.stops[i].lon);
          if (d <= radius) out.push([i, d]);
        }
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  buildFootpaths() {
    const N = this.stops.length;
    const lists = Array.from({ length: N }, () => []);
    this.stops.forEach((s, i) => {
      for (const [j, d] of this.near(s.lat, s.lon, TRANSFER_RADIUS_M)) if (j !== i) lists[i].push(j, walkSeconds(d));
    });
    this.fpOff = new Int32Array(N + 1);
    lists.forEach((l, i) => (this.fpOff[i + 1] = this.fpOff[i] + l.length / 2));
    this.fpTo = new Int32Array(this.fpOff[N]);
    this.fpSec = new Int32Array(this.fpOff[N]);
    lists.forEach((l, i) => {
      for (let k = 0; k < l.length; k += 2) {
        this.fpTo[this.fpOff[i] + k / 2] = l[k];
        this.fpSec[this.fpOff[i] + k / 2] = l[k + 1];
      }
    });
  }

  /** Applica i ritardi del feed TripUpdates (Map trip_id → {cancelled, delay, upd}). */
  applyDelays(tu) {
    if (!this.loaded || !tu || tu === this.lastTu) return;
    this.lastTu = tu;
    this.tripDelay.fill(0);
    this.tripLive = new Uint8Array(this.tripIds.length);
    for (const [tid, v] of tu) {
      const t = this.tripIndex.get(tid);
      if (t === undefined) continue;
      const u = v.upd.find((x) => x.delay !== undefined && !x.skipped);
      this.tripDelay[t] = v.cancelled ? 1e7 : (u ? u.delay : v.delay) || 0;
      this.tripLive[t] = 1;
    }
  }

  /** Nome linea, colore, tipo e destinazione di una corsa (indice interno). */
  tripInfo(t) {
    const tid = this.tripIds[t];
    const tr = this.statics.trips.get(tid);
    const r = tr && this.statics.routes.get(tr[0]);
    return {
      tripId: tid,
      line: r?.short || '?',
      long: r?.long || '',
      color: r?.color || null,
      mode: modeOf(r?.type),
      headsign: tr?.[2] ? titleCase(tr[2]) : '',
      shape: tr?.[1],
    };
  }

  // ---------- servizio di un giorno ----------

  activeServices(ymd) {
    const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
    const wd = (d.getDay() + 6) % 7; // lunedì = 0
    const act = new Set();
    for (const [s, c] of Object.entries(this.calendar)) if (c.days[wd] && ymd >= c.start && ymd <= c.end) act.add(s);
    for (const [s, c] of Object.entries(this.calDates)) {
      if (c.add.includes(ymd)) act.add(s);
      if (c.rem.includes(ymd)) act.delete(s);
    }
    return act;
  }

  /**
   * Strutture per il calcolo dei percorsi in un giorno: corse raggruppate in "pattern"
   * (stessa sequenza di fermate) ordinate per orario, e per ogni fermata i pattern che vi passano.
   */
  day(ymd) {
    if (this.dates.has(ymd)) return this.dates.get(ymd);
    const act = this.activeServices(ymd);
    const groups = new Map();
    for (let t = 0; t < this.tripIds.length; t++) {
      if (!act.has(this.tripService[t])) continue;
      const a = this.tripOff[t];
      const b = this.tripOff[t + 1];
      if (b - a < 2) continue;
      const key = Array.prototype.join.call(this.stIdx.subarray(a, b), ',');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(t);
    }
    const patterns = [];
    for (const tripsOf of groups.values()) {
      const t0 = tripsOf[0];
      const n = this.tripOff[t0 + 1] - this.tripOff[t0];
      tripsOf.sort((x, y) => this.stDep[this.tripOff[x]] - this.stDep[this.tripOff[y]]);
      const arr = new Int32Array(tripsOf.length * n);
      const dep = new Int32Array(tripsOf.length * n);
      tripsOf.forEach((t, j) => {
        arr.set(this.stArr.subarray(this.tripOff[t], this.tripOff[t] + n), j * n);
        dep.set(this.stDep.subarray(this.tripOff[t], this.tripOff[t] + n), j * n);
      });
      patterns.push({ stops: this.stIdx.slice(this.tripOff[t0], this.tripOff[t0] + n), trips: Int32Array.from(tripsOf), n, arr, dep });
    }
    // fermata → [pattern, posizione]
    const N = this.stops.length;
    const cnt = new Int32Array(N + 1);
    for (const p of patterns) for (const s of p.stops) cnt[s + 1]++;
    for (let i = 0; i < N; i++) cnt[i + 1] += cnt[i];
    const fill = cnt.slice(0, N);
    const spP = new Int32Array(cnt[N]);
    const spPos = new Int32Array(cnt[N]);
    patterns.forEach((p, pi) => {
      p.stops.forEach((s, pos) => {
        spP[fill[s]] = pi;
        spPos[fill[s]++] = pos;
      });
    });
    const d = { ymd, patterns, spOff: cnt, spP, spPos };
    this.dates.set(ymd, d);
    if (this.dates.size > 3) this.dates.delete(this.dates.keys().next().value);
    return d;
  }
}

export function titleCase(s) {
  // "TERMINI (MA-MB-FS)" e "lodi m3" → "Termini (MA-MB-FS)", "Lodi M3"
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/('.])([a-zàèéìòù])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Fs|Ma|Mb|Mc|M\d|Fl\d?|Atm|Atac)\b/g, (m) => m.toUpperCase());
}
