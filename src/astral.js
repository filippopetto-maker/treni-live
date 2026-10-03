// Ferrovie regionali di Roma gestite da ASTRAL (ex ATAC): Metromare (Roma–Lido) e Roma–Viterbo.
// Non sono nei dati di Roma Mobilità. ASTRAL ha un servizio pubblico (lo stesso dei suoi tabelloni)
// con, per ogni stazione, tutte le corse del giorno, il ritardo e se la corsa è soppressa.
// Qui diventano una piccola rete per il navigatore e treni animati sulla mappa.

import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { fetchWithTimeout, normName, sleep, log } from './util.js';
import { dist, walkSeconds } from './planner/gtfs-net.js';
import { localTime } from './planner/index.js';
import { simplify, RailNetwork } from './rail.js';

const API = 'https://gestionecorse.astralspa.it/api';
const REFRESH_MS = 2 * 60_000;
export const ASTRAL_LINES = [
  { id: 'metromare', name: 'Metromare', short: 'ML', color: '#0096c7', dirs: ['RL_PSP-CC', 'RL_CC-PSP'] },
  { id: 'rv-urbana', name: 'Roma–Viterbo', short: 'RV', color: '#8e44ad', dirs: ['RN_RMMON', 'RN_MONRM'] },
  { id: 'rv-extra', name: 'Roma–Viterbo', short: 'RV', color: '#8e44ad', dirs: ['RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'] },
];
// Zona in cui cercare le stazioni (Roma, litorale, Tuscia).
const BOX = [11.8, 41.6, 12.75, 42.5];
// Nomi ASTRAL diversi da quelli di OpenStreetMap.
const ALIAS = { CASTELFUSANO: 'Castel Fusano', VITERBO: 'Viterbo Porta Fiorentina', 'GROTTA ROSSA': 'Grottarossa' };
const compact = (s) => normName(s).replace(/ /g, '');

// Il server di ASTRAL non invia il certificato intermedio (Sectigo OV R36): lo aggiungiamo noi,
// verificando comunque tutta la catena fino alle radici di sistema.
const CERT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'certs', 'sectigo-ov-r36.pem');
let agent = null;
async function getAgent() {
  if (!agent) {
    const extra = await fs.readFile(CERT, 'utf8').catch(() => null);
    agent = new https.Agent({ ca: extra ? [...tls.rootCertificates, extra] : undefined, keepAlive: true });
  }
  return agent;
}

async function post(p, body = {}) {
  const data = JSON.stringify(body);
  const ag = await getAgent();
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${API}/${p}`,
      { method: 'POST', agent: ag, timeout: 15_000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`ASTRAL HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('ASTRAL: risposta non valida'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('ASTRAL: timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const hm = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? +m[1] * 3600 + +m[2] * 60 : null;
};

export class AstralNet {
  constructor({ dataDir, rail }) {
    this.id = 'astral';
    this.file = path.join(dataDir, 'astral.json');
    this.rail = rail;
    this.stops = [];
    this.dirs = []; // { code, line, stations: [stopIdx], tperc: [sec], segs }
    this.trips = new Map(); // codice percorso → [{ corsa, start, delay, soppressa, bus, dest }]
    this.at = 0;
    this.ready = false;
    this.fpOff = new Int32Array(1);
    this.fpTo = new Int32Array(0);
    this.fpSec = new Int32Array(0);
  }

  /** Stazioni e tempi di percorrenza: si scaricano una volta (cache su disco), coordinate da OpenStreetMap. */
  async init() {
    if (this.ready) return;
    if (this.initP) return this.initP;
    this.initP = (async () => {
      let cache = {};
      try {
        cache = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch {}
      if (!cache.dirs || Date.now() - (cache.at || 0) > 7 * 86400_000) {
        const dirs = {};
        for (const L of ASTRAL_LINES) for (const code of L.dirs) dirs[code] = await post(`fermate/${code}`);
        cache = { at: Date.now(), dirs, coords: cache.coords || {} };
      }
      // Binari di queste linee: in OpenStreetMap sono "light_rail", esclusi dalla rete nazionale.
      this.localRail = new RailNetwork({
        dataDir: path.dirname(this.file),
        stations: { byCode: new Map() },
        file: 'astral-rail.bin',
        pathsFile: 'astral-paths.json',
        bbox: { s: 41.68, n: 42.45, w: 12.05, e: 12.55 },
        filter: 'way["railway"~"^(rail|light_rail|narrow_gauge|subway)$"]["service"!~"siding|yard|spur"]',
        tileDeg: 0.4,
        minNodes: 500,
      });
      await this.localRail.load().catch((e) => log('ASTRAL: binari non scaricati, uso linee rette:', e.message));
      const byName = new Map();
      for (const L of ASTRAL_LINES) {
        for (const code of L.dirs) {
          const list = (cache.dirs[code] || []).filter((s) => s.stato !== '0').sort((a, b) => a.ordine - b.ordine);
          const idx = [];
          const cum = []; // secondi dalla partenza al capolinea ("tperc" = tratto precedente, "00:03" = 3 minuti)
          let t = 0;
          for (const s of list) {
            const key = normName(s.nomeFermata);
            t += hm(s.tperc) ?? 0;
            if (!byName.has(key)) {
              if (!(key in cache.coords)) cache.coords[key] = await this.locate(s.nomeFermata);
              const c = cache.coords[key];
              if (!c) continue; // stazione non localizzata: si salta, gli orari restano giusti
              byName.set(key, this.stops.length);
              this.stops.push({ id: key, name: s.nomeFermata, lat: c[0], lon: c[1] });
            }
            idx.push(byName.get(key));
            cum.push(t);
          }
          if (idx.length >= 2) this.dirs.push({ code, line: L, stations: idx, cum, segs: this.segments(idx), origin: list[0]?.codice });
        }
      }
      await fs.writeFile(this.file, JSON.stringify(cache));
      this.buildGrid();
      this.ready = true;
      log(`ASTRAL: ${this.stops.length} stazioni su ${this.dirs.length} direzioni (Metromare, Roma–Viterbo)`);
    })().catch((e) => {
      this.initP = null;
      throw e;
    });
    return this.initP;
  }

  /** Coordinate di una stazione: Photon (OpenStreetMap) filtrato su oggetti ferroviari. */
  async locate(name) {
    const u = new URL('https://photon.komoot.io/api/');
    u.searchParams.set('q', ALIAS[normName(name)] || name);
    u.searchParams.set('osm_tag', 'railway');
    u.searchParams.set('bbox', BOX.join(','));
    u.searchParams.set('limit', '8');
    try {
      await sleep(250);
      const res = await fetchWithTimeout(u, {}, 15_000);
      const js = await res.json();
      const n = compact(ALIAS[normName(name)] || name);
      const feats = (js.features || []).filter((f) => /station|halt|stop/.test(f.properties.osm_value));
      const pick =
        feats.find((f) => compact(f.properties.name || '') === n) ||
        feats.find((f) => compact(f.properties.name || '').includes(n));
      if (!pick) log(`ASTRAL: stazione "${name}" non trovata su OpenStreetMap`);
      return pick ? [pick.geometry.coordinates[1], pick.geometry.coordinates[0]] : null;
    } catch {
      return null;
    }
  }

  /** Tracciato tra stazioni consecutive sui binari OpenStreetMap (o in linea retta). */
  segments(idx) {
    const out = [];
    for (let k = 0; k < idx.length - 1; k++) {
      const A = this.stops[idx[k]];
      const B = this.stops[idx[k + 1]];
      let c = null;
      for (const r of [this.localRail, this.rail]) {
        if (c || !r?.ready) continue;
        try {
          c = r.route(A, B)?.coords || null;
        } catch {}
      }
      out.push(c && c.length >= 2 ? [[A.lon, A.lat], ...c.slice(1, -1), [B.lon, B.lat]] : [[A.lon, A.lat], [B.lon, B.lat]]);
    }
    return out;
  }

  buildGrid() {
    // Poche stazioni: una ricerca lineare basta.
  }

  near(lat, lon, radius) {
    const out = [];
    this.stops.forEach((s, i) => {
      const d = dist(lat, lon, s.lat, s.lon);
      if (d <= radius) out.push([i, d]);
    });
    return out.sort((a, b) => a[1] - b[1]);
  }

  /** Corse del giorno con ritardi e soppressioni, lette dalla stazione di partenza di ogni direzione. */
  async refresh() {
    await this.init();
    if (Date.now() - this.at < REFRESH_MS) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      for (const d of this.dirs) {
        try {
          if (!d.origin) continue;
          const list = await post('transit', { percorso: d.code, fermata: d.origin });
          this.trips.set(
            d.code,
            list
              .map((x) => ({
                corsa: x.corsa,
                start: hm(x.oraInizio || x.orario),
                delay: Number(x.ritardo) || 0,
                soppressa: x.soppressa === 'S' || x.soppressa === 'Y',
                bus: x.busSostitutivo === 'S' || x.busSostitutivo === 'Y',
                partial: x.sParziale || null,
                dest: x.arrivo || '',
              }))
              .filter((x) => x.start !== null)
          );
        } catch (e) {
          log(`ASTRAL ${d.code}: ${e.message}`);
        }
      }
      this.at = Date.now();
      this.data = null;
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Corse come pattern per il navigatore (una corsa per pattern, orari in secondi dalla mezzanotte). */
  day(midnight) {
    if (this.data && this.dataMidnight === midnight) return this.data;
    const patterns = [];
    for (const d of this.dirs) {
      for (const tr of this.trips.get(d.code) || []) {
        if (tr.soppressa) continue;
        const n = d.stations.length;
        const t = d.cum.map((c) => tr.start + c + tr.delay * 60);
        patterns.push({
          stops: Int32Array.from(d.stations),
          trips: Int32Array.of(0),
          n,
          arr: Int32Array.from(t),
          dep: Int32Array.from(t),
          dir: d,
          info: { ...tr, line: d.line.short, name: d.line.name, color: d.line.color, dest: tr.dest.replace(/ Stazione$/i, '') },
        });
      }
    }
    const N = this.stops.length;
    const cnt = new Int32Array(N + 1);
    for (const p of patterns) for (const s of p.stops) cnt[s + 1]++;
    for (let i = 0; i < N; i++) cnt[i + 1] += cnt[i];
    const fill = cnt.slice(0, N);
    const spP = new Int32Array(cnt[N]);
    const spPos = new Int32Array(cnt[N]);
    patterns.forEach((p, pi) =>
      p.stops.forEach((s, pos) => {
        spP[fill[s]] = pi;
        spPos[fill[s]++] = pos;
      })
    );
    this.data = { patterns, spOff: cnt, spP, spPos };
    this.dataMidnight = midnight;
    return this.data;
  }

  /** Treni in viaggio adesso nel riquadro, con i prossimi tratti da animare (come la metro). */
  async vehicles(bb, now = Date.now()) {
    await this.refresh();
    const lt = localTime(now);
    const ms = (s) => lt.midnight + s * 1000;
    const inside = (c) => c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3];
    const out = [];
    for (const P of this.day(lt.midnight).patterns) {
      const n = P.n;
      if (lt.sec < P.dep[0] || lt.sec >= P.arr[n - 1]) continue;
      let k = 1;
      while (k < n && P.arr[k] <= lt.sec) k++;
      const legs = [];
      for (let s = k - 1; s < n - 1 && legs.length < 4; s++) legs.push({ c: P.dir.segs[s], t0: ms(P.dep[s]), t1: ms(P.arr[s + 1]) });
      if (!legs.length) continue;
      const cur = legs[0].c;
      if (!inside(cur[0]) && !inside(cur[cur.length - 1])) continue;
      const i = P.info;
      out.push({
        feed: 'astral',
        id: `a:${P.dir.code}:${i.corsa}`,
        trip: i.corsa,
        route: P.dir.code,
        mode: 'metro',
        rname: i.line,
        lineName: i.name,
        color: i.color,
        dest: i.dest,
        next: this.stops[P.stops[Math.min(k, n - 1)]].name,
        legs,
        scheduled: true,
        alert: i.bus
          ? { level: 'warn', text: 'Corsa effettuata con bus sostitutivo' }
          : i.delay >= 5
            ? { level: 'warn', text: `In ritardo di ${i.delay} min (ASTRAL)` }
            : { level: 'ok', text: i.delay ? `ritardo ${i.delay} min (ASTRAL)` : 'in orario (ASTRAL)' },
        live: true,
      });
    }
    return out;
  }

  /** Tracciato completo di una direzione (per disegnare il percorso del treno selezionato). */
  routeCoords(code) {
    const d = this.dirs.find((x) => x.code === code);
    return d ? { coords: simplify(d.segs.flatMap((c, j) => (j ? c.slice(1) : c)), 4) } : null;
  }

  /** Riassunto per il notiziario: corse soppresse e bus sostitutivi di oggi ancora da fare. */
  newsItems(now = Date.now()) {
    const lt = localTime(now);
    const items = [];
    const byLine = new Map();
    for (const d of this.dirs) {
      for (const tr of this.trips.get(d.code) || []) {
        if (tr.start < lt.sec - 3600 || tr.start > lt.sec + 3 * 3600) continue;
        const e = byLine.get(d.line.name) || { sopp: 0, bus: 0, late: 0 };
        if (tr.soppressa) e.sopp++;
        else if (tr.bus) e.bus++;
        else if (tr.delay >= 10) e.late++;
        byLine.set(d.line.name, e);
      }
    }
    for (const [name, e] of byLine) {
      if (e.sopp) items.push({ src: 'ASTRAL', level: e.sopp >= 3 ? 'stop' : 'warn', text: `${name}: ${e.sopp} ${e.sopp === 1 ? 'corsa soppressa' : 'corse soppresse'} tra un'ora fa e le prossime 3 ore` });
      if (e.bus) items.push({ src: 'ASTRAL', level: 'warn', text: `${name}: ${e.bus} corse con bus sostitutivi` });
      if (e.late) items.push({ src: 'ASTRAL', level: 'warn', text: `${name}: ${e.late} corse in ritardo di oltre 10 minuti` });
    }
    return items;
  }
}
