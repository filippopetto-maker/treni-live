// Rete ferroviaria da OpenStreetMap e percorsi tra stazioni.
//
// Al primo avvio scarica i binari d'Italia da Overpass a tasselli (una tantum, qualche minuto)
// e li salva compatti in data/rail.bin. Poi, per ogni coppia di località tra cui un treno
// sta viaggiando, calcola il percorso sui binari con A* e lo mette in cache (data/paths.json).
// Il browser fa scorrere il treno lungo quel percorso invece che in linea retta.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout, sleep, log } from './util.js';

const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// Italia con un po' di margine (stazioni di confine: Chiasso, Domodossola, Brennero, Villa Opicina…)
const BBOX = { s: 36.4, n: 47.2, w: 6.5, e: 18.6 };
const TILE_DEG = 2;
// Binari di linea: niente raccordi, piazzali e binari di servizio.
const FILTER = 'way["railway"~"^(rail|narrow_gauge)$"]["service"!~"siding|yard|spur"]';

const SNAP_RADIUS_M = 700; // distanza massima stazione → binario
const MAX_EXPANSIONS = 700_000; // limite di sicurezza per A*
const SIMPLIFY_M = 12; // tolleranza di semplificazione del percorso inviato al browser
const CELL = 0.01; // griglia spaziale per trovare i binari vicini (~1 km)

const M_LAT = 110_540;
const M_LON = 111_320 * Math.cos((42 * Math.PI) / 180); // approssimazione valida per l'Italia

export class RailNetwork {
  constructor({ dataDir, stations }) {
    this.binFile = path.join(dataDir, 'rail.bin');
    this.pathsFile = path.join(dataDir, 'paths.json');
    this.st = stations;
    this.ready = false;
    this.state = 'in attesa';
    this.paths = new Map(); // "S01700>S01820" → { coords: [[lon,lat]…], km } | null (non trovato)
    this.queue = [];
    this.queued = new Set();
    this.dirty = false;
    this.computed = 0;
    this.failed = 0;
  }

  /** Avvia caricamento o download senza bloccare il server. */
  start() {
    this.load()
      .catch((e) => {
        this.state = 'errore: ' + e.message;
        log('Binari: ' + this.state);
      })
      .finally(() => {
        setInterval(() => this.work(), 25);
        setInterval(() => this.savePaths(), 5 * 60_000);
      });
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.pathsFile, 'utf8'));
      for (const [k, v] of Object.entries(saved)) this.paths.set(k, v);
    } catch {}

    let buf = await fs.readFile(this.binFile).catch(() => null);
    if (!buf) {
      await this.download();
      buf = await fs.readFile(this.binFile);
    }
    this.buildGraph(buf);
    this.ready = true;
    this.state = 'pronta';
    log(`Binari: rete pronta (${this.N.toLocaleString('it-IT')} nodi, ${this.paths.size} percorsi in cache)`);
  }

  // ---------- download da Overpass ----------

  async download() {
    const tiles = [];
    for (let s = BBOX.s; s < BBOX.n; s += TILE_DEG) {
      for (let w = BBOX.w; w < BBOX.e; w += TILE_DEG) {
        tiles.push([s, w, Math.min(s + TILE_DEG, BBOX.n), Math.min(w + TILE_DEG, BBOX.e)]);
      }
    }
    log(`Binari: scarico la rete ferroviaria da OpenStreetMap (${tiles.length} tasselli, una tantum)…`);
    const nodeIdx = new Map();
    const lat = [];
    const lon = [];
    const edges = [];
    const edgeSet = new Set();
    let done = 0;
    let total = tiles.length;

    const add = (elements) => {
      for (const el of elements) {
        if (el.type === 'node' && !nodeIdx.has(el.id)) {
          nodeIdx.set(el.id, lat.length);
          lat.push(Math.round(el.lat * 1e6));
          lon.push(Math.round(el.lon * 1e6));
        }
      }
      for (const el of elements) {
        if (el.type !== 'way' || !el.nodes) continue;
        for (let k = 1; k < el.nodes.length; k++) {
          const a = nodeIdx.get(el.nodes[k - 1]);
          const b = nodeIdx.get(el.nodes[k]);
          if (a === undefined || b === undefined || a === b) continue;
          const key = Math.min(a, b) * 4_194_304 + Math.max(a, b);
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          edges.push(a, b);
        }
      }
    };

    const worker = async () => {
      while (tiles.length) {
        const t = tiles.shift();
        const elements = await this.fetchTile(t);
        if (elements === null) {
          // Tassello troppo pesante o server occupato: lo divido in quattro.
          const [s, w, n, e] = t;
          if (n - s > 0.3) {
            const ms = (s + n) / 2;
            const mw = (w + e) / 2;
            tiles.push([s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]);
            total += 3;
          } else {
            log(`Binari: tassello ${t.map((x) => x.toFixed(2)).join(',')} non scaricato, salto`);
            done++;
          }
          continue;
        }
        add(elements);
        done++;
        this.state = `download ${done}/${total} tasselli`;
        if (done % 5 === 0 || done === total) log(`Binari: ${this.state}, ${lat.length.toLocaleString('it-IT')} nodi`);
      }
    };
    await Promise.all([worker(), worker()]);

    const N = lat.length;
    const E = edges.length / 2;
    if (N < 50_000) throw new Error(`rete troppo piccola (${N} nodi): download non riuscito`);
    const header = Buffer.alloc(12);
    header.write('RAIL', 0);
    header.writeUInt32LE(N, 4);
    header.writeUInt32LE(E, 8);
    const body = [Int32Array.from(lat), Int32Array.from(lon), Int32Array.from(edges)].map((a) => Buffer.from(a.buffer));
    await fs.mkdir(path.dirname(this.binFile), { recursive: true });
    await fs.writeFile(this.binFile, Buffer.concat([header, ...body]));
    log(`Binari: rete salvata (${N.toLocaleString('it-IT')} nodi, ${E.toLocaleString('it-IT')} tratti)`);
  }

  async fetchTile([s, w, n, e]) {
    const q = `[out:json][timeout:180];${FILTER}(${s},${w},${n},${e});out skel qt;>;out skel qt;`;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const url of ENDPOINTS) {
        try {
          const res = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'treni-live/0.1 (uso personale)' },
              body: 'data=' + encodeURIComponent(q),
            },
            200_000
          );
          if (!res.ok) continue;
          const j = await res.json();
          if (j.remark && /error|timed out|runtime/i.test(j.remark)) continue;
          return j.elements || [];
        } catch {}
      }
      await sleep(5000);
    }
    return null;
  }

  // ---------- grafo ----------

  buildGraph(buf) {
    if (buf.toString('latin1', 0, 4) !== 'RAIL') throw new Error('rail.bin non valido: cancellalo e riavvia');
    const N = buf.readUInt32LE(4);
    const E = buf.readUInt32LE(8);
    const arr = (offset, len) => new Int32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + len * 4));
    const latI = arr(12, N);
    const lonI = arr(12 + N * 4, N);
    const ed = arr(12 + N * 8, E * 2);

    this.N = N;
    this.lat = new Float64Array(N);
    this.lon = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.lat[i] = latI[i] / 1e6;
      this.lon[i] = lonI[i] / 1e6;
    }
    // Liste di adiacenza compatte (CSR)
    const deg = new Int32Array(N + 1);
    for (let k = 0; k < ed.length; k++) deg[ed[k] + 1]++;
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    this.off = deg;
    this.nbr = new Int32Array(E * 2);
    this.w = new Float32Array(E * 2);
    const fill = this.off.slice(0, N);
    for (let k = 0; k < E; k++) {
      const a = ed[2 * k];
      const b = ed[2 * k + 1];
      const d = this.dist(a, b);
      this.nbr[fill[a]] = b;
      this.w[fill[a]++] = d;
      this.nbr[fill[b]] = a;
      this.w[fill[b]++] = d;
    }
    // Griglia spaziale
    this.grid = new Map();
    for (let i = 0; i < N; i++) {
      const key = this.cellKey(this.lat[i], this.lon[i]);
      let c = this.grid.get(key);
      if (!c) this.grid.set(key, (c = []));
      c.push(i);
    }
    // Strutture riutilizzate da A*
    this.g = new Float64Array(N);
    this.prev = new Int32Array(N);
    this.stamp = new Int32Array(N);
    this.closed = new Int32Array(N);
    this.run = 0;
  }

  cellKey(lat, lon) {
    return Math.floor(lat / CELL) * 100_000 + Math.floor(lon / CELL);
  }

  dist(a, b) {
    const dx = (this.lon[a] - this.lon[b]) * M_LON;
    const dy = (this.lat[a] - this.lat[b]) * M_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  distTo(i, lat, lon) {
    const dx = (this.lon[i] - lon) * M_LON;
    const dy = (this.lat[i] - lat) * M_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Nodi di binario entro `radius` metri dal punto, i più vicini per primi. */
  nearest(lat, lon, radius = SNAP_RADIUS_M, max = 30) {
    const r = Math.ceil(radius / (CELL * M_LON));
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    const out = [];
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const c = this.grid.get(y * 100_000 + x);
        if (!c) continue;
        for (const i of c) {
          const d = this.distTo(i, lat, lon);
          if (d <= radius) out.push([i, d]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    return out.slice(0, max);
  }

  /**
   * Percorso sui binari tra due località {lat, lon} con A*.
   * Parte da tutti i binari vicini alla prima e arriva al primo binario vicino alla seconda,
   * così una stazione con molti binari o su più linee non sceglie quello sbagliato.
   */
  route(A, B) {
    const src = this.nearest(A.lat, A.lon);
    const dst = this.nearest(B.lat, B.lon);
    if (!src.length || !dst.length) return null;
    const targets = new Set(dst.map(([i]) => i));
    const run = ++this.run;
    const heapF = [];
    const heapN = [];
    const push = (f, n) => {
      let i = heapF.length;
      heapF.push(f);
      heapN.push(n);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= f) break;
        heapF[i] = heapF[p];
        heapN[i] = heapN[p];
        i = p;
      }
      heapF[i] = f;
      heapN[i] = n;
    };
    const pop = () => {
      const top = heapN[0];
      const lastF = heapF.pop();
      const lastN = heapN.pop();
      if (heapF.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= heapF.length) break;
          if (c + 1 < heapF.length && heapF[c + 1] < heapF[c]) c++;
          if (heapF[c] >= lastF) break;
          heapF[i] = heapF[c];
          heapN[i] = heapN[c];
          i = c;
        }
        heapF[i] = lastF;
        heapN[i] = lastN;
      }
      return top;
    };
    const h = (i) => this.distTo(i, B.lat, B.lon);

    for (const [i, d] of src) {
      this.stamp[i] = run;
      this.g[i] = d;
      this.prev[i] = -1;
      push(d + h(i), i);
    }
    let end = -1;
    let expanded = 0;
    while (heapF.length) {
      const u = pop();
      if (this.closed[u] === run) continue;
      this.closed[u] = run;
      if (targets.has(u)) {
        end = u;
        break;
      }
      if (++expanded > MAX_EXPANSIONS) break;
      for (let k = this.off[u]; k < this.off[u + 1]; k++) {
        const v = this.nbr[k];
        if (this.closed[v] === run) continue;
        const ng = this.g[u] + this.w[k];
        if (this.stamp[v] !== run || ng < this.g[v]) {
          this.stamp[v] = run;
          this.g[v] = ng;
          this.prev[v] = u;
          push(ng + h(v), v);
        }
      }
    }
    if (end < 0) return null;
    const meters = this.g[end];
    const straight = Math.hypot((A.lon - B.lon) * M_LON, (A.lat - B.lat) * M_LAT);
    // Percorso assurdo (binario sbagliato, linee non collegate nei dati OSM): meglio la linea retta.
    if (meters > straight * 2.2 + 3000) return null;
    const nodes = [];
    for (let n = end; n !== -1; n = this.prev[n]) nodes.push(n);
    nodes.reverse();
    return { coords: simplify(nodes.map((n) => [this.lon[n], this.lat[n]]), SIMPLIFY_M), km: Math.round(meters / 100) / 10 };
  }

  // ---------- cache e coda ----------

  /**
   * Restituisce l'id del percorso tra due stazioni (codici RFI) se è già pronto,
   * altrimenti lo mette in coda e restituisce null (il browser intanto usa la linea retta).
   */
  pathFor(aCode, bCode) {
    if (!aCode || !bCode || aCode === bCode) return null;
    const key = `${aCode}>${bCode}`;
    if (this.paths.has(key)) return this.paths.get(key) ? key : null;
    if (this.ready && !this.queued.has(key)) {
      this.queued.add(key);
      this.queue.push(key);
    }
    return null;
  }

  /** Come pathFor, ma calcola subito il percorso se manca. Restituisce le coordinate o null. */
  pathSync(aCode, bCode) {
    if (!this.ready || !aCode || !bCode || aCode === bCode) return null;
    const key = `${aCode}>${bCode}`;
    if (!this.paths.has(key)) {
      const A = this.st.byCode.get(aCode);
      const B = this.st.byCode.get(bCode);
      const p = A && B ? this.route(A, B) : null;
      this.paths.set(key, p);
      if (p) this.paths.set(`${bCode}>${aCode}`, { coords: [...p.coords].reverse(), km: p.km });
      this.dirty = true;
    }
    return this.paths.get(key)?.coords || null;
  }

  work() {
    if (!this.ready || !this.queue.length) return;
    const t0 = Date.now();
    while (this.queue.length && Date.now() - t0 < 30) {
      const key = this.queue.shift();
      this.queued.delete(key);
      const [a, b] = key.split('>');
      const A = this.st.byCode.get(a);
      const B = this.st.byCode.get(b);
      const p = A && B ? this.route(A, B) : null;
      this.paths.set(key, p);
      if (p) {
        // Stesso percorso al contrario, gratis.
        this.paths.set(`${b}>${a}`, { coords: [...p.coords].reverse(), km: p.km });
        this.computed++;
      } else this.failed++;
      this.dirty = true;
    }
  }

  get(ids) {
    const out = {};
    for (const id of ids) {
      const p = this.paths.get(id);
      if (p) out[id] = p.coords;
    }
    return out;
  }

  async savePaths() {
    if (!this.dirty) return;
    this.dirty = false;
    const obj = {};
    for (const [k, v] of this.paths) obj[k] = v;
    await fs.writeFile(this.pathsFile, JSON.stringify(obj)).catch(() => {});
  }

  stats() {
    return {
      stato: this.state,
      nodi: this.N || 0,
      percorsiInCache: this.paths.size,
      calcolati: this.computed,
      nonTrovati: this.failed,
      inCoda: this.queue.length,
    };
  }
}

/** Douglas–Peucker in metri; restituisce coordinate arrotondate a ~1 m. */
export function simplify(pts, tol) {
  if (pts.length <= 2) return pts.map(round5);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const ax = pts[a][0] * M_LON, ay = pts[a][1] * M_LAT;
    const bx = pts[b][0] * M_LON, by = pts[b][1] * M_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * M_LON, py = pts[i][1] * M_LAT;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map(round5);
}

const round5 = ([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5];
