// Metro "da orario": le metropolitane di Roma e Milano non pubblicano posizioni in tempo reale,
// quindi i treni della metro si ricavano dagli orari GTFS. Per ogni corsa in viaggio adesso
// si manda al browser il tratto tra due stazioni (con la forma reale della linea) e gli orari
// di partenza e arrivo: il browser lo fa scorrere ogni secondo, come per i treni.

import { localTime } from './planner/index.js';
import { dist } from './planner/gtfs-net.js';
import { log } from './util.js';

const MODES = new Set(['metro']);
const METRO_COLORS = {
  roma: { MEA: '#f7931d', MEB: '#0a5db4', MEB1: '#0a5db4', MEC: '#2fa84f' },
  milano: { 1: '#e2231a', 2: '#00a650', 3: '#f9a800', 4: '#0072bc', 5: '#8c4fa3' },
};
const lineName = (feed, short) => (feed === 'roma' ? short.replace(/^ME/, '') : 'M' + short);

/** Divide la forma della linea in tratti tra fermate consecutive. */
function cutShape(shape, stops) {
  const straight = () => stops.slice(1).map((s, i) => [[stops[i].lon, stops[i].lat], [s.lon, s.lat]]);
  if (!shape) return straight();
  const n = shape.length / 2;
  const idx = [];
  let from = 0;
  for (const s of stops) {
    let bi = from;
    let bd = Infinity;
    for (let i = from; i < n; i++) {
      const d = dist(s.lat, s.lon, shape[2 * i + 1], shape[2 * i]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bd > 400) return straight();
    idx.push(bi);
    from = bi;
  }
  const segs = [];
  for (let k = 0; k < stops.length - 1; k++) {
    const pts = [[stops[k].lon, stops[k].lat]];
    for (let i = idx[k] + 1; i < idx[k + 1]; i++) pts.push([shape[2 * i], shape[2 * i + 1]]);
    pts.push([stops[k + 1].lon, stops[k + 1].lat]);
    segs.push(pts);
  }
  return segs;
}

export class ScheduledMetro {
  constructor({ planner }) {
    this.planner = planner;
    this.days = new Map(); // "roma/20261003" → { patterns } | Promise
  }

  /** Corse della metro di un giorno di servizio (estratte una volta, poi la rete può uscire dalla memoria). */
  async day(feedId, ymd) {
    const key = `${feedId}/${ymd}`;
    if (this.days.has(key)) return this.days.get(key);
    const p = (async () => {
      const net = await this.planner.readyNet(feedId);
      if (!net) return { patterns: [] };
      const d = net.day(ymd);
      const patterns = [];
      for (const P of d.patterns) {
        const info = net.tripInfo(P.trips[0]);
        if (!MODES.has(info.mode)) continue;
        const stops = Array.from(P.stops, (s) => net.stops[s]);
        patterns.push({
          n: P.n,
          arr: P.arr,
          dep: P.dep,
          trips: Array.from(P.trips, (t) => net.tripInfo(t)),
          stops: stops.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })),
          segs: cutShape(net.statics.shapes.get(info.shape), stops),
          line: lineName(feedId, info.line),
          route: net.statics.trips.get(info.tripId)?.[0],
          color: METRO_COLORS[feedId]?.[info.line] || info.color || '#c0392b',
        });
      }
      log(`Metro ${feedId}: ${patterns.reduce((a, p) => a + p.trips.length, 0)} corse il ${ymd}`);
      return { patterns };
    })();
    this.days.set(key, p);
    p.then((v) => this.days.set(key, v)).catch(() => this.days.delete(key));
    // Tiene solo gli ultimi giorni.
    while (this.days.size > 6) this.days.delete(this.days.keys().next().value);
    return p;
  }

  /**
   * Treni della metro in viaggio adesso nel riquadro. Ognuno ha i prossimi tratti
   * { c: coordinate, t0, t1 } (sosta in stazione = un solo punto) da far scorrere nel browser.
   */
  async vehicles(feedId, bb, now = Date.now()) {
    const lt = localTime(now);
    const sets = [{ d: await this.day(feedId, lt.ymd), shift: 0 }];
    if (lt.sec < 4 * 3600) {
      const y = new Date(Date.UTC(+lt.ymd.slice(0, 4), +lt.ymd.slice(4, 6) - 1, +lt.ymd.slice(6, 8)) - 86400_000);
      sets.push({ d: await this.day(feedId, y.toISOString().slice(0, 10).replaceAll('-', '')), shift: -86400 });
    }
    const ms = (s) => lt.midnight + s * 1000;
    const inside = (c) => c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3];
    const out = [];
    for (const { d, shift } of sets) {
      for (const P of d.patterns) {
        const n = P.n;
        for (let j = 0; j < P.trips.length; j++) {
          const o = j * n;
          const sec = lt.sec - shift;
          if (sec < P.dep[o] || sec >= P.arr[o + n - 1]) continue;
          // Prima fermata non ancora raggiunta.
          let k = 1;
          while (k < n && P.arr[o + k] <= sec) k++;
          const legs = [];
          // k-1 = ultima fermata raggiunta: se è ancora lì sosta, altrimenti è in viaggio verso k.
          let s = k - 1;
          if (sec < P.dep[o + s]) legs.push({ c: [[P.stops[s].lon, P.stops[s].lat]], t0: ms(P.arr[o + s] + shift), t1: ms(P.dep[o + s] + shift) });
          for (; s < n - 1 && legs.length < 4; s++) {
            legs.push({ c: P.segs[s], t0: ms(P.dep[o + s] + shift), t1: ms(P.arr[o + s + 1] + shift) });
            if (P.dep[o + s + 1] > P.arr[o + s + 1] && s + 1 < n - 1)
              legs.push({ c: [[P.stops[s + 1].lon, P.stops[s + 1].lat]], t0: ms(P.arr[o + s + 1] + shift), t1: ms(P.dep[o + s + 1] + shift) });
          }
          const cur = legs[0].c;
          if (!inside(cur[0]) && !inside(cur[cur.length - 1])) continue;
          const t = P.trips[j];
          out.push({
            feed: feedId,
            id: 'm:' + t.tripId,
            trip: t.tripId,
            route: P.route,
            mode: 'metro',
            rname: P.line,
            color: P.color,
            dest: t.headsign || P.stops[n - 1].name,
            next: P.stops[Math.min(k, n - 1)].name,
            legs,
            scheduled: true,
          });
        }
      }
    }
    return out;
  }
}
