// GTFS statico di un feed urbano: forme delle linee (shapes), corse (trips) e linee (routes).
// Serve per disegnare il percorso completo di un bus/tram selezionato e per mostrare
// il nome della linea e la destinazione. Lo zip si riscarica una volta a settimana.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchWithTimeout, log } from './util.js';
import { simplify } from './rail.js';

const run = promisify(execFile);
const MAX_AGE = 7 * 24 * 3600 * 1000;

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
      await fs.writeFile(zip, Buffer.from(await res.arrayBuffer()));
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
    await readCsv(path.join(this.dir, 'trips.txt'), (r) => {
      // [linea, forma, destinazione, servizio (calendario)]
      this.trips.set(r.trip_id, [r.route_id, r.shape_id, r.trip_headsign || '', r.service_id]);
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

  /** Informazioni su una corsa in tempo reale: nome linea, destinazione, colore. */
  info(tripId, routeId) {
    const t = this.trips.get(tripId);
    const r = this.routes.get(t ? t[0] : routeId);
    return { rname: r?.short || routeId, dest: t?.[2] || '', rcolor: r?.color || null, shape: t?.[1] };
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
