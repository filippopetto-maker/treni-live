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

async function countLines(file) {
  let n = 0;
  for await (const chunk of createReadStream(file)) for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) n++;
  return n;
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
    this.dates = new Map(); // "20261002" → strutture per quel giorno (solo i giorni preparati)
    this.preparing = null;
    this.version = 0;
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

  /** Giorni pronti in memoria? */
  hasDays(ymds) {
    return this.loaded && ymds.every((y) => this.dates.has(y));
  }

  /**
   * Prepara i giorni richiesti (YYYYMMDD) e tiene in memoria solo le loro corse.
   * Le tabelle complete (net.bin, tutte le settimane del GTFS) si leggono per pochi secondi,
   * si estraggono i giorni e si liberano: così Roma e Milano stanno insieme in 512 MB.
   * La lista è quella completa da tenere: i giorni non elencati vengono tolti.
   */
  async ensureDays(ymds) {
    this.lastUse = Date.now();
    if (this.hasDays(ymds)) return this;
    while (this.preparing) await this.preparing.catch(() => {});
    if (this.hasDays(ymds)) return this;
    const want = [...new Set(ymds)].sort();
    const t0 = Date.now();
    this.preparing = (async () => {
      await this.ensureStops();
      await this.loadFull();
      const dates = new Map();
      for (const y of want) dates.set(y, this.dayFull(y));
      this.compactTo(dates);
      this.loaded = true;
      this.preparedAt = Date.now();
      const n = this.tripIds.length;
      log(`Navigatore: ${this.id} pronto per ${want.join(', ')} (${n.toLocaleString('it-IT')} corse, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      return this;
    })();
    try {
      return await this.preparing;
    } catch (e) {
      log(`Navigatore: preparazione di ${this.id} non riuscita: ${e.message}`);
      throw e;
    } finally {
      this.dropFull();
      this.preparing = null;
      globalThis.gc?.();
    }
  }

  /** Compatibilità: rete pronta per i giorni già in memoria (o per oggi). */
  async load() {
    if (this.loaded) return this;
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return this.ensureDays([ymd]);
  }

  /**
   * Fine validità dichiarata nel feed_info.txt del GTFS (YYYYMMDD o null).
   * ATM la indica separata: surface_end_date (bus/tram) e mm_end_date (metro).
   */
  async readFeedInfo() {
    const zip = path.join(this.dir, 'gtfs.zip');
    const st = await fs.stat(zip).catch(() => null);
    if (this.feedInfo && this.feedInfo.mtime === st?.mtimeMs) return this.feedInfo;
    let fi = {};
    try {
      const { stdout } = await run('unzip', ['-p', zip, 'feed_info.txt'], { maxBuffer: 1 << 20 });
      const [head, row] = stdout.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      const cells = (l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      const h = cells(head);
      const r = cells(row || '');
      h.forEach((k, i) => (fi[k] = r[i] || ''));
    } catch {}
    const d = (v) => (/^\d{8}$/.test(v || '') ? v : null);
    this.feedInfo = {
      mtime: st?.mtimeMs,
      version: fi.feed_version || null,
      start: d(fi.feed_start_date),
      surfaceEnd: d(fi.surface_end_date) || d(fi.feed_end_date),
      metroEnd: d(fi.mm_end_date) || d(fi.feed_end_date),
    };
    return this.feedInfo;
  }

  /** Primo giorno senza dati veri (il minimo tra fine dichiarata e fine del calendario). */
  dataEnd() {
    const ends = [this.feedInfo?.surfaceEnd, this.feedInfo?.metroEnd, this.calendarEnd()].filter(Boolean);
    return ends.length ? ends.sort()[0] : null;
  }

  /**
   * Giorno da usare al posto di ymd quando i dati sono scaduti: lo stesso giorno della settimana
   * nell'ultima settimana valida (null se ymd è coperto, o se non c'è una settimana valida).
   */
  proxyDay(ymd, end) {
    if (!end || ymd <= end) return null;
    let d = ymd;
    while (d > end) d = shiftYmd(d, -7);
    const start = this.feedInfo?.start;
    return start && d < start ? null : d;
  }

  /** Ultimo giorno coperto dal GTFS in uso (YYYYMMDD), o null. */
  calendarEnd() {
    let end = null;
    for (const c of Object.values(this.calendar || {})) if (!end || c.end > end) end = c.end;
    for (const c of Object.values(this.calDates || {})) for (const y of c.add) if (!end || y > end) end = y;
    return end;
  }

  /** Tabelle complete da net.bin (temporanee). */
  async loadFull() {
    {
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, 'net.json'), 'utf8'));
      const buf = await fs.readFile(path.join(this.dir, 'net.bin'));
      const nT = buf.readUInt32LE(4);
      const nR = buf.readUInt32LE(8);
      // Viste sul file letto, senza copiarlo (i blocchi sono allineati a 4 byte).
      const arr = (off, n) =>
        (buf.byteOffset + off) % 4 === 0
          ? new Int32Array(buf.buffer, buf.byteOffset + off, n)
          : new Int32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * 4));
      let o = 12;
      this.tripOff = arr(o, nT + 1);
      o += (nT + 1) * 4;
      this.stIdx = arr(o, nR);
      o += nR * 4;
      this.stArr = arr(o, nR);
      o += nR * 4;
      this.stDep = arr(o, nR);
      this.fullIds = meta.trips;
      this.calendar = meta.calendar;
      this.calDates = meta.calDates;
      // Servizio (calendario) e tipo (metro o superficie) di ogni corsa, dal GTFS indicizzato per la mappa.
      const st = this.statics;
      this.fullService = this.fullIds.map((t) => st.trips.get(t)?.[3] ?? '');
      this.fullMetro = Uint8Array.from(this.fullIds, (t) => (modeOf(st.routes.get(st.trips.get(t)?.[0])?.type) === 'metro' ? 1 : 0));
      await this.readFeedInfo();
      if (!this.fpOff) this.buildFootpaths();
    }
  }

  dropFull() {
    this.tripOff = this.stIdx = this.stArr = this.stDep = null;
    this.fullIds = this.fullService = this.fullMetro = null;
  }

  /**
   * Tiene solo le corse dei giorni estratti e le rinumera da 0: gli indici dei pattern,
   * dei ritardi e delle corse saltate si riferiscono a questa numerazione compatta.
   */
  compactTo(dates) {
    const old = this.fullIds.length;
    const map = new Int32Array(old).fill(-1);
    const ids = [];
    for (const d of dates.values()) {
      for (const P of d.patterns) {
        for (let j = 0; j < P.trips.length; j++) {
          const t = P.trips[j];
          if (map[t] < 0) {
            map[t] = ids.length;
            ids.push(this.fullIds[t]);
          }
          P.trips[j] = map[t];
        }
      }
    }
    this.tripIds = ids;
    this.tripIndex = new Map(ids.map((t, i) => [t, i]));
    this.tripDelay = new Int32Array(ids.length);
    this.tripLive = null;
    this.lastTu = null;
    this.dates = dates;
    this.version = (this.version || 0) + 1;
  }

  unload() {
    if (!this.loaded) return;
    this.loaded = false;
    this.dropFull();
    this.tripIds = this.tripIndex = this.tripDelay = this.tripLive = this.lastTu = null;
    this.dates = new Map();
    globalThis.gc?.();
    log(`Navigatore: rete ${this.id} tolta dalla memoria`);
  }

  /** Dopo un GTFS nuovo: si riparte da zero (fermate, cambi a piedi, giorni). */
  reset() {
    this.unload();
    this.stops = null;
    this.grid = null;
    this.fpOff = this.fpTo = this.fpSec = null;
    this.version = (this.version || 0) + 1;
  }

  async ensureCache() {
    const zip = path.join(this.dir, 'gtfs.zip');
    const zipStat = await fs.stat(zip).catch(() => null);
    if (!zipStat) throw new Error(`GTFS ${this.id} non ancora scaricato`);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, 'net-info.json'), 'utf8'));
      // Al secondo: le immagini Docker conservano le date dei file senza i millisecondi.
      if (meta.version === CACHE_VERSION && Math.floor(meta.zipMtime / 1000) === Math.floor(zipStat.mtimeMs / 1000)) return;
    } catch {}
    await this.buildCache(zip, zipStat.mtimeMs);
    globalThis.gc?.(); // libera gli array di lavoro prima di caricare la cache
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

    // Orari in due passate, per stare dentro server da 512 MB:
    //  1) si contano le fermate di ogni corsa → posizione di ogni corsa negli array finali;
    //  2) ogni riga va direttamente al suo posto. Poi si ordina per stop_sequence solo se serve.
    const file = path.join(tmp, 'stop_times.txt');
    const tripIndex = new Map();
    const trips = [];
    let counts = new Int32Array(1 << 16);
    await eachRow(file, (c, i) => {
      if (stopIndex.get(c[i.stop_id]) === undefined) return;
      let t = tripIndex.get(c[i.trip_id]);
      if (t === undefined) {
        t = trips.length;
        const id = Buffer.from(c[i.trip_id], 'utf8').toString('utf8'); // stringa propria, non legata alla riga
        tripIndex.set(id, t);
        trips.push(id);
        if (t >= counts.length) {
          const b = new Int32Array(counts.length * 2);
          b.set(counts);
          counts = b;
        }
      }
      counts[t]++;
    });
    const nT = trips.length;
    const tripOff = new Int32Array(nT + 1);
    for (let t = 0; t < nT; t++) tripOff[t + 1] = tripOff[t] + counts[t];
    counts = null;
    const n = tripOff[nT];
    const fill = tripOff.slice(0, nT);
    const stIdx = new Int32Array(n), stArr = new Int32Array(n), stDep = new Int32Array(n), seq = new Int32Array(n);
    await eachRow(file, (c, i) => {
      const s = stopIndex.get(c[i.stop_id]);
      if (s === undefined) return;
      const t = tripIndex.get(c[i.trip_id]);
      const o = fill[t]++;
      const a = hms(c[i.arrival_time]);
      const d = hms(c[i.departure_time]);
      stIdx[o] = s;
      stArr[o] = a >= 0 ? a : d;
      stDep[o] = d >= 0 ? d : a;
      seq[o] = +c[i.stop_sequence];
    });
    for (let t = 0; t < nT; t++) {
      const a = tripOff[t];
      const b = tripOff[t + 1];
      let sorted = true;
      for (let k = a + 1; k < b && sorted; k++) if (seq[k] < seq[k - 1]) sorted = false;
      if (sorted) continue;
      const idx = Array.from({ length: b - a }, (_, k) => a + k).sort((x, y) => seq[x] - seq[y]);
      const cp = (arr) => {
        const v = idx.map((k) => arr[k]);
        v.forEach((x, k) => (arr[a + k] = x));
      };
      cp(stIdx);
      cp(stArr);
      cp(stDep);
    }

    const header = Buffer.alloc(12);
    header.write('GNET', 0);
    header.writeUInt32LE(nT, 4);
    header.writeUInt32LE(n, 8);
    // Scrittura a blocchi: niente copia unica da ~80 MB in memoria.
    const fh = await fs.open(path.join(this.dir, 'net.bin'), 'w');
    try {
      await fh.write(header);
      for (const a of [tripOff, stIdx, stArr, stDep]) await fh.write(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    } finally {
      await fh.close();
    }
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
    const d = this.dates.get(ymd);
    if (d) return d;
    // Giorno non preparato (chi chiama doveva usare ensureDays): nessuna corsa, niente errori.
    if (!this.warned?.has(ymd)) {
      (this.warned ||= new Set()).add(ymd);
      log(`Navigatore: ${this.id} senza orari per il ${ymd}`);
    }
    return this.emptyDay(ymd);
  }

  emptyDay(ymd) {
    const N = this.stops?.length || 0;
    return { ymd, patterns: [], spOff: new Int32Array(N + 1), spP: new Int32Array(0), spPos: new Int32Array(0) };
  }

  /** Estrazione di un giorno dalle tabelle complete (indici di corsa "lunghi", poi compattati). */
  dayFull(ymd) {
    // Dati scaduti (es. ATM in ritardo con la pubblicazione): orari della settimana precedente.
    const surf = this.proxyDay(ymd, this.feedInfo?.surfaceEnd);
    const metro = this.proxyDay(ymd, this.feedInfo?.metroEnd);
    const actS = this.activeServices(surf || ymd);
    const actM = metro === surf ? actS : this.activeServices(metro || ymd);
    const groups = new Map();
    for (let t = 0; t < this.fullIds.length; t++) {
      if (!(this.fullMetro[t] ? actM : actS).has(this.fullService[t])) continue;
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
    const estimated = surf || metro ? { surface: surf, metro } : null;
    if (estimated) log(`Navigatore: ${this.id} ${ymd} con orari stimati (superficie da ${surf || '-'}, metro da ${metro || '-'})`);
    return { ymd, patterns, spOff: cnt, spP, spPos, estimated };
  }
}

function shiftYmd(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86400_000);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

export function titleCase(s) {
  // "TERMINI (MA-MB-FS)" e "lodi m3" → "Termini (MA-MB-FS)", "Lodi M3"
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/('.])([a-zàèéìòù])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Fs|Ma|Mb|Mc|M\d|Fl\d?|Atm|Atac)\b/g, (m) => m.toUpperCase());
}
