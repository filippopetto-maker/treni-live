// GTFS statico di un feed urbano: forme delle linee (shapes), corse (trips) e linee (routes).
// Serve per disegnare il percorso completo di un bus/tram selezionato e per mostrare
// il nome della linea e la destinazione. Lo zip si riscarica una volta a settimana.

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchWithTimeout, log } from './util.js';
import { simplify } from './rail.js';

import { modeOf } from './planner/gtfs-net.js';

const run = promisify(execFile);
const FILOBUS = { roma: new Set(['60', '74', '90']), milano: new Set(['90', '91', '92', '93']) };
// Su Render gli orari arrivano già pronti con ogni nuova versione (GTFS_MAX_AGE_DAYS più alto).
const MAX_AGE = (Number(process.env.GTFS_MAX_AGE_DAYS) || 7) * 24 * 3600 * 1000;

export class GtfsStatic {
  constructor({ dataDir, feed }) {
    this.feed = feed;
    this.dir = path.join(dataDir, 'gtfs', feed.id);
    this.ready = false;
    this.state = 'in attesa';
    this.routes = new Map(); // route_id → { short, long, color }
    this.trips = new Map(); // trip_id → [route_id, shape_id, headsign]
    this.shapes = new Map(); // shape_id → Float64Array [lon, lat, lon, lat…]
    this.cache = new Map(); // shape_id → coordinate semplificate
  }

  async start() {
    try {
      await this.ensureFiles();
      this.state = 'indicizzazione';
      await this.index();
      this.ready = true;
      this.state = 'pronto';
      log(`GTFS ${this.feed.id}: ${this.trips.size.toLocaleString('it-IT')} corse, ${this.shapes.size} forme`);
    } catch (e) {
      this.state = 'errore: ' + e.message;
      log(`GTFS ${this.feed.id}: ${this.state}`);
    }
  }

  async ensureFiles() {
    const zip = path.join(this.dir, 'gtfs.zip');
    const stat = await fs.stat(zip).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs > MAX_AGE) {
      this.state = 'download';
      log(`GTFS ${this.feed.id}: scarico gli orari statici…`);
      const res = await fetchWithTimeout(this.feed.static, {}, 180_000);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      await fs.mkdir(this.dir, { recursive: true });
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(zip, buf);
      await this.saveMeta({ ...sigOf(res), sha1: sha1(buf), size: buf.length, at: new Date().toISOString() });
    }
    // `unzip` è presente di serie su macOS e sulla maggior parte dei Linux.
    await run('unzip', ['-o', '-q', zip, 'routes.txt', 'trips.txt', 'shapes.txt', '-d', this.dir]);
  }

  async index() {
    await readCsv(path.join(this.dir, 'routes.txt'), (r) => {
      this.routes.set(r.route_id, {
        short: r.route_short_name || r.route_id,
        long: r.route_long_name || '',
        color: r.route_color ? '#' + r.route_color : null,
        type: r.route_type,
      });
    });
    // I pezzi ottenuti con split() tengono in vita l'intera riga del CSV: a Milano erano ~150 MB.
    // Valori ripetuti (linea, forma, destinazione, servizio) condivisi, id copiati in stringhe proprie.
    const pool = new Map();
    const intern = (s) => {
      if (!s) return '';
      let v = pool.get(s);
      if (v === undefined) pool.set(s, (v = own(s)));
      return v;
    };
    await readCsv(path.join(this.dir, 'trips.txt'), (r) => {
      // [linea, forma, destinazione, servizio (calendario)]
      this.trips.set(own(r.trip_id), [intern(r.route_id), intern(r.shape_id), intern(r.trip_headsign || ''), intern(r.service_id)]);
    });
    const tmp = new Map();
    await readCsv(path.join(this.dir, 'shapes.txt'), (r) => {
      let a = tmp.get(r.shape_id);
      if (!a) tmp.set(r.shape_id, (a = []));
      a.push(+r.shape_pt_sequence, +r.shape_pt_lon, +r.shape_pt_lat);
    });
    for (const [id, a] of tmp) {
      const idx = [];
      for (let i = 0; i < a.length; i += 3) idx.push(i);
      idx.sort((x, y) => a[x] - a[y]);
      const out = new Float64Array(idx.length * 2);
      idx.forEach((i, k) => {
        out[2 * k] = a[i + 1];
        out[2 * k + 1] = a[i + 2];
      });
      this.shapes.set(id, out);
    }
  }

  async readMeta() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, 'zip-meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async saveMeta(meta) {
    await fs.writeFile(path.join(this.dir, 'zip-meta.json'), JSON.stringify(meta)).catch(() => {});
  }

  /**
   * Controlla gli orari sul sito e scarica quelli nuovi solo se sono cambiati (o con force).
   * Prima una richiesta leggera (HEAD: data, ETag, dimensione); se non basta si scarica e si
   * confronta l'impronta del file. Lo zip nuovo si verifica prima di sostituire quello in uso.
   */
  async checkUpdate({ force = false } = {}) {
    const zip = path.join(this.dir, 'gtfs.zip');
    const meta = await this.readMeta();
    if (!force && meta) {
      const head = await fetchWithTimeout(this.feed.static, { method: 'HEAD' }, 30_000).catch(() => null);
      if (head?.ok) {
        const sig = sigOf(head);
        const known = ['etag', 'lastModified', 'length'].filter((k) => sig[k] && meta[k]);
        if (known.length && known.every((k) => sig[k] === meta[k])) return { changed: false, reason: 'nessuna novità sul sito' };
      }
    }
    // Download direttamente su file (niente 50 MB in memoria), calcolando l'impronta strada facendo.
    const res = await fetchWithTimeout(this.feed.static, {}, 300_000);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const tmp = zip + '.new';
    const hash = crypto.createHash('sha1');
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
    const sig = { ...sigOf(res), sha1: hash.digest('hex'), size, at: new Date().toISOString() };
    const oldSha = meta?.sha1 || (await sha1File(zip).catch(() => null));
    if (oldSha === sig.sha1) {
      await fs.rm(tmp, { force: true });
      await this.saveMeta(sig);
      return { changed: false, reason: 'scaricati, identici a quelli in uso' };
    }
    try {
      await run('unzip', ['-tq', tmp]);
      const { stdout } = await run('unzip', ['-Z1', tmp]);
      for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt']) if (!stdout.split(/\r?\n/).includes(f)) throw new Error(`manca ${f}`);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw new Error('zip scaricato non valido: ' + e.message.split('\n')[0]);
    }
    await fs.rename(tmp, zip);
    await this.saveMeta(sig);
    log(`GTFS ${this.feed.id}: orari nuovi scaricati (${(size / 1e6).toFixed(1)} MB)`);
    return { changed: true };
  }

  /** Dopo un GTFS nuovo: si indicizza a parte e si sostituisce solo a lavoro finito. */
  async reindex() {
    const zip = path.join(this.dir, 'gtfs.zip');
    await run('unzip', ['-o', '-q', zip, 'routes.txt', 'trips.txt', 'shapes.txt', '-d', this.dir]);
    const fresh = new GtfsStatic({ dataDir: path.dirname(path.dirname(this.dir)), feed: this.feed });
    await fresh.index();
    this.routes = fresh.routes;
    this.trips = fresh.trips;
    this.shapes = fresh.shapes;
    this.cache = new Map();
    this.lineCache = null;
    log(`GTFS ${this.feed.id}: mappa aggiornata ai nuovi orari (${this.trips.size.toLocaleString('it-IT')} corse)`);
  }

  /** Informazioni su una corsa in tempo reale: nome linea, destinazione, colore. */
  info(tripId, routeId) {
    const t = this.trips.get(tripId);
    const r = this.routes.get(t ? t[0] : routeId);
    const rname = r?.short || routeId;
    let mode = modeOf(r?.type);
    // I filobus nei GTFS di Roma e Milano risultano "bus": li riconosco dal numero di linea.
    if (mode === 'bus' && FILOBUS[this.feed.id]?.has(rname)) mode = 'filobus';
    return { rname, dest: t?.[2] || '', rcolor: r?.color || null, shape: t?.[1], mode };
  }

  /**
   * Linea cercata per nome ("64", "tram 8", "n11", "A", "M1"): percorso principale per ogni
   * destinazione, colore e tipo di mezzo. null se la linea non esiste in questa città.
   */
  line(q) {
    if (!this.ready) return null;
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
    const raw = norm(q);
    const word = raw.match(/^(linea|bus|autobus|tram|filobus|metro|metropolitana)/)?.[1];
    const want = { bus: 'bus', autobus: 'bus', tram: 'tram', filobus: 'filobus', metro: 'metro', metropolitana: 'metro' }[word] || null;
    const key = word ? raw.slice(word.length) : raw;
    if (!key) return null;
    this.lineCache ||= new Map();
    const ck = `${want}|${key}`;
    if (this.lineCache.has(ck)) return this.lineCache.get(ck);
    // Metro col nome che usa la gente: a Roma "A" (nel GTFS "MEA"), a Milano "M1" (nel GTFS "1").
    const display = (r, mode) => (mode !== 'metro' ? r.short : this.feed.id === 'roma' ? r.short.replace(/^ME/i, '') : /^\d$/.test(r.short) ? 'M' + r.short : r.short);
    let cand = [];
    for (const [id, r] of this.routes) {
      const mode = this.info(undefined, id).mode;
      const direct = norm(r.short) === key;
      const alias = mode === 'metro' && norm(display(r, mode)) === key;
      if ((direct || alias) && (!want || want === mode)) cand.push({ id, mode, direct, alias });
    }
    // "1" a Milano è il tram 1, non la M1 (per quella si scrive M1 o "metro 1").
    if (!want && cand.some((c) => c.mode !== 'metro')) cand = cand.filter((c) => c.mode !== 'metro' || c.alias);
    if (cand.length) {
      const first = cand[0].mode;
      cand = cand.filter((c) => c.mode === first);
    }
    const ids = cand.map((c) => c.id);
    let res = null;
    if (ids.length) {
      const want = new Set(ids);
      const per = new Map(); // forma → { destinazione, corse }
      for (const t of this.trips.values()) {
        if (!want.has(t[0]) || !t[1]) continue;
        let e = per.get(t[1]);
        if (!e) per.set(t[1], (e = { head: t[2], n: 0 }));
        e.n++;
      }
      // Per ogni destinazione la forma con più corse (le varianti rare si tralasciano).
      const byHead = new Map();
      for (const [shape, e] of per) {
        const cur = byHead.get(e.head);
        if ((!cur || e.n > cur.n) && this.shapes.has(shape)) byHead.set(e.head, { shape, ...e });
      }
      const dirs = [...byHead.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, 6)
        .map((e) => {
          const f = this.shapes.get(e.shape);
          const pts = [];
          for (let i = 0; i < f.length; i += 2) pts.push([f[i], f[i + 1]]);
          return { headsign: e.head, coords: simplify(pts, 6) };
        });
      const r = this.routes.get(ids[0]);
      const mode = cand[0].mode;
      res = { feed: this.feed.id, routeIds: ids, name: display(r, mode), short: r.short, long: r.long, color: r.color, mode, dirs };
    }
    if (this.lineCache.size > 200) this.lineCache.clear();
    this.lineCache.set(ck, res);
    return res;
  }

  /** Forma completa della corsa (coordinate semplificate) o null. */
  route(tripId, routeId) {
    if (!this.ready) return null;
    const inf = this.info(tripId, routeId);
    if (!inf.shape || !this.shapes.has(inf.shape)) return null;
    if (!this.cache.has(inf.shape)) {
      const f = this.shapes.get(inf.shape);
      const pts = [];
      for (let i = 0; i < f.length; i += 2) pts.push([f[i], f[i + 1]]);
      this.cache.set(inf.shape, simplify(pts, 4));
    }
    return { coords: this.cache.get(inf.shape), rname: inf.rname, dest: inf.dest, rcolor: inf.rcolor };
  }
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
async function sha1File(file) {
  const h = crypto.createHash('sha1');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
const sigOf = (res) => ({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), length: res.headers.get('content-length') });

/** Copia di una stringa che non dipende dalla riga da cui è stata ritagliata. */
const own = (s) => Buffer.from(s, 'utf8').toString('utf8');

async function readCsv(file, onRow) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cells = splitCsv(line);
    if (!header) {
      header = cells.map((h) => h.replace(/^﻿/, '').trim());
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    onRow(row);
  }
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
