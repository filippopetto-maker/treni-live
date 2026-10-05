// Rete ferroviaria "live" per il navigatore: ogni treno seguito da ViaggiaTreno o Italo
// diventa una corsa con i suoi orari (reali dove già passato, previsti + ritardo per il resto).
// Si ricostruisce al massimo una volta al minuto, solo quando qualcuno calcola un percorso.

import { dist, walkSeconds } from './gtfs-net.js';

const CELL = 0.01;
const M_LON = 111_320 * Math.cos((42 * Math.PI) / 180);
const TRANSFER_RADIUS_M = 300;

export class RailLiveNet {
  constructor({ stations, trackers }) {
    this.id = 'rail';
    this.trackers = trackers; // [vt, italo]
    // Tutte le stazioni RFI con coordinate: indice stabile = fermata del navigatore.
    this.stops = stations.list
      .filter((s) => s.lat && s.lon)
      .map((s) => ({ id: s.code, name: s.name, lat: s.lat, lon: s.lon }));
    this.byCode = new Map(this.stops.map((s, i) => [s.id, i]));
    this.grid = new Map();
    this.stops.forEach((s, i) => {
      const k = Math.floor(s.lat / CELL) * 1e5 + Math.floor(s.lon / CELL);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(i);
    });
    this.buildFootpaths();
    this.built = 0;
    this.midnight = 0;
    this.data = null;
  }

  near(lat, lon, radius) {
    const r = Math.ceil(radius / (CELL * M_LON));
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    const out = [];
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        for (const i of this.grid.get(y * 1e5 + x) || []) {
          const d = dist(lat, lon, this.stops[i].lat, this.stops[i].lon);
          if (d <= radius) out.push([i, d]);
        }
    return out.sort((a, b) => a[1] - b[1]);
  }

  buildFootpaths() {
    const N = this.stops.length;
    const lists = this.stops.map((s, i) => this.near(s.lat, s.lon, TRANSFER_RADIUS_M).filter(([j]) => j !== i));
    this.fpOff = new Int32Array(N + 1);
    lists.forEach((l, i) => (this.fpOff[i + 1] = this.fpOff[i] + l.length));
    this.fpTo = new Int32Array(this.fpOff[N]);
    this.fpSec = new Int32Array(this.fpOff[N]);
    lists.forEach((l, i) =>
      l.forEach(([j, d], k) => {
        this.fpTo[this.fpOff[i] + k] = j;
        this.fpSec[this.fpOff[i] + k] = walkSeconds(d) + 120; // cambio di stazione
      })
    );
  }

  /**
   * Corse del giorno con orari in secondi dalla mezzanotte `midnight` (ms).
   * Ogni treno è un pattern a sé con una sola corsa: niente da raggruppare.
   */
  day(midnight) {
    const now = Date.now();
    if (this.data && this.midnight === midnight && now - this.built < 60_000) return this.data;
    const patterns = [];
    const sec = (ms) => Math.round((ms - midnight) / 1000);
    for (const tracker of this.trackers) {
      for (const tr of tracker.trains.values()) {
        if (!tr.stops || tr.seg?.status === 'arrived') continue;
        const delayMs = (tr.delay || 0) * 60_000;
        const st = [];
        const arr = [];
        const dep = [];
        for (const s of tr.stops) {
          if (s.soppressa) continue;
          const i = this.byCode.get(s.code);
          if (i === undefined) continue;
          // Orario reale se già passato, altrimenti previsto + ritardo attuale.
          let a = s.realArr ?? (s.arr ? s.arr + delayMs : null);
          let d = s.realDep ?? (s.dep ? s.dep + delayMs : null);
          if (a == null) a = d;
          if (d == null) d = a;
          if (a == null) continue;
          // Sosta assurda (es. partenza con la data del giorno dopo, visto su Italo): si tiene l'arrivo.
          if (d < a || d - a > 3 * 3600_000) d = a;
          // Orari che tornano indietro: fermata scartata (prima il confronto era tra millisecondi e
          // secondi e non scattava mai: una corsa "nel passato" faceva sparire le soluzioni buone).
          if (st.length && (st[st.length - 1] === i || sec(a) < dep[dep.length - 1])) continue;
          st.push(i);
          arr.push(sec(a));
          dep.push(sec(d));
        }
        if (st.length < 2) continue;
        patterns.push({
          stops: Int32Array.from(st),
          trips: Int32Array.of(0),
          n: st.length,
          arr: Int32Array.from(arr),
          dep: Int32Array.from(dep),
          train: tr,
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
    this.midnight = midnight;
    this.built = now;
    return this.data;
  }
}
