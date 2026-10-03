// Navigatore stile Moovit: percorsi da A a B con mezzi urbani (GTFS) e treni live,
// partenze in tempo reale dalle fermate, ricerca di indirizzi e fermate.

import { GtfsNetwork, dist, walkSeconds, titleCase } from './gtfs-net.js';
import { RailLiveNet } from './rail-net.js';
import { raptor, unwind, INF } from './raptor.js';
import { simplify } from '../rail.js';
import { fetchWithTimeout, normName, log } from '../util.js';
import { inSpan } from '../metro-status.js';

const ACCESS_M = 800;
const ACCESS_MAX_M = 1500;
const RAIL_ACCESS_M = 1500;
const CROSS_M = 400;
const WALK_ONLY_MAX_M = 2500;
// Su server piccoli (es. 512 MB): NAV_UNLOAD_MIN=10 e NAV_MAX_NETS=1 tengono in memoria una città alla volta.
const UNLOAD_AFTER = (Number(process.env.NAV_UNLOAD_MIN) || 30) * 60_000;
const MAX_NETS = Number(process.env.NAV_MAX_NETS) || 0;
const TZ = 'Europe/Rome';

// Colori ufficiali delle metropolitane (i GTFS di Roma e Milano non li indicano).
const METRO_COLORS = {
  roma: { A: '#d6202a', MEA: '#d6202a', B: '#0a5db4', MEB: '#0a5db4', B1: '#0a5db4', MEB1: '#0a5db4', C: '#2fa84f', MEC: '#2fa84f' },
  milano: { M1: '#e2231a', M2: '#00a650', M3: '#f9a800', M4: '#0072bc', M5: '#8c4fa3' },
};
const MODE_COLORS = { bus: '#e08a00', tram: '#2e8b57', metro: '#c0392b', treno: '#1565c0', filobus: '#b36b00', traghetto: '#0097a7' };
const RAIL_COLORS = { FR: '#c8102e', FA: '#1a6fb5', FB: '#7a3e9d', IC: '#1d3f8c', ICN: '#1d3f8c', EC: '#1d3f8c', ITA: '#8a1538', REG: '#1565c0', RV: '#1565c0', S: '#1565c0' };

/** Data e ora locali (Roma) di un istante: { ymd, sec, midnight }. */
export function localTime(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  const sec = +p.hour * 3600 + +p.minute * 60 + +p.second;
  return { ymd: p.year + p.month + p.day, sec, midnight: ms - sec * 1000 - (ms % 1000) };
}

const prevYmd = (ymd) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - 86400_000);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};

/** Nome linea come lo conosce la gente: "MEB1" → "B1" a Roma, "2" (metro) → "M2" a Milano. */
function lineInfo(netId, info) {
  let line = info.line;
  if (info.mode === 'metro') {
    if (netId === 'roma') line = line.replace(/^ME/, '');
    if (netId === 'milano' && /^\d$/.test(line)) line = 'M' + line;
  }
  const color = METRO_COLORS[netId]?.[line] || info.color || MODE_COLORS[info.mode] || MODE_COLORS.bus;
  return { line, color };
}

const inBbox = (bb, lat, lon) => lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];

export class Planner {
  constructor({ dataDir, transit, stations, trackers, rail }) {
    this.dataDir = dataDir;
    this.transit = transit;
    this.stations = stations;
    this.railPaths = rail;
    this.trackers = trackers;
    this.nets = new Map(); // id feed → GtfsNetwork
    this.railNet = null;
    this.crossCache = new Map();
    setInterval(() => {
      for (const n of this.nets.values()) if (n.loaded && Date.now() - n.lastUse > UNLOAD_AFTER) n.unload();
    }, 60_000).unref();
  }

  /** Feed urbani con orari statici (quelli dove il navigatore funziona). */
  get cityFeeds() {
    return this.transit.feeds.filter((f) => f.static);
  }

  net(id) {
    let n = this.nets.get(id);
    if (!n) {
      const feed = this.cityFeeds.find((f) => f.id === id);
      const statics = this.transit.statics.get(id);
      if (!feed || !statics) return null;
      n = new GtfsNetwork({ dataDir: this.dataDir, feed, statics });
      this.nets.set(id, n);
    }
    return n;
  }

  /** Rete urbana pronta all'uso (orari caricati). Errore chiaro se il GTFS è ancora in preparazione. */
  async readyNet(id) {
    const n = this.net(id);
    if (!n) return null;
    if (!n.statics.ready) throw new Error(`orari di ${n.feed.name} ancora in preparazione, riprova tra poco`);
    if (MAX_NETS && !n.loaded) {
      const others = [...this.nets.values()].filter((x) => x !== n && x.loaded).sort((a, b) => a.lastUse - b.lastUse);
      while (others.length >= MAX_NETS) others.shift().unload();
    }
    await n.load();
    return n;
  }

  rail() {
    this.railNet ||= new RailLiveNet({ stations: this.stations, trackers: this.trackers });
    return this.railNet;
  }

  /** Stazioni (treni o ferrovie ASTRAL) vicine a fermate urbane: cambi a piedi tra le reti. */
  cross(net, other = this.rail()) {
    const key = `${other.id}>${net.id}`;
    if (this.crossCache.has(key)) return this.crossCache.get(key);
    const pairs = [];
    other.stops.forEach((s, i) => {
      if (!inBbox(net.feed.bbox, s.lat, s.lon)) return;
      for (const [j, d] of net.near(s.lat, s.lon, CROSS_M)) pairs.push([i, j, walkSeconds(d) + 60]);
    });
    this.crossCache.set(key, pairs);
    return pairs;
  }

  /**
   * Corse "fantasma": secondo l'orario sono partite da almeno 5 minuti e sono ancora in viaggio,
   * ma non compaiono nei dati in tempo reale, mentre altre corse della stessa linea sì.
   * Quasi sempre sono corse saltate (o vetture col localizzatore spento): non le proponiamo.
   */
  async ghostTrips(net, lt) {
    const feed = net.feed;
    if (!feed.url || !feed.tripUpdates) return new Set();
    const c = this.ghostCache?.get(net.id);
    if (c && Date.now() - c.at < 30_000) return c.set;
    const [vp, tu] = await Promise.all([this.transit.vehicles(feed), this.transit.tripUpdates(feed.id)]);
    const seen = new Set(vp?.vehicles?.map((v) => v.trip));
    for (const id of tu?.trips?.keys() || []) seen.add(id);
    const st = net.statics;
    const liveRoutes = new Set();
    for (const id of seen) {
      const r = st.trips.get(id)?.[0];
      if (r) liveRoutes.add(r);
    }
    const ghosts = new Set();
    const sets = [{ d: net.day(lt.ymd), shift: 0 }];
    if (lt.sec < 4 * 3600) sets.push({ d: net.day(prevYmd(lt.ymd)), shift: -86400 });
    for (const { d, shift } of sets) {
      for (const P of d.patterns) {
        const first = net.tripIds[P.trips[0]];
        const route = st.trips.get(first)?.[0];
        if (!liveRoutes.has(route)) continue; // linea senza dati live: non possiamo giudicare
        for (let j = 0; j < P.trips.length; j++) {
          const dep = P.dep[j * P.n] + shift;
          const arr = P.arr[j * P.n + P.n - 1] + shift;
          if (lt.sec < dep + 300 || lt.sec > arr) continue;
          const t = P.trips[j];
          if (!seen.has(net.tripIds[t])) ghosts.add(t);
        }
      }
    }
    (this.ghostCache ||= new Map()).set(net.id, { at: Date.now(), set: ghosts });
    return ghosts;
  }

  /** Reti da usare per un viaggio: città toccate da partenza/arrivo + treni live. */
  async views(from, to, timeMs) {
    const lt = localTime(timeMs);
    const live = Math.abs(timeMs - Date.now()) < 3 * 3600_000;
    const early = lt.sec < 4 * 3600;
    const views = [];
    let off = 0;
    for (const f of this.cityFeeds) {
      if (!inBbox(f.bbox, from.lat, from.lon) && !inBbox(f.bbox, to.lat, to.lon)) continue;
      const net = await this.readyNet(f.id);
      if (!net) continue;
      let delay = null;
      if (live && f.tripUpdates) {
        const tu = await this.transit.tripUpdates(f.id);
        if (tu?.trips?.size) {
          net.applyDelays(tu.trips);
          delay = net.tripDelay;
        }
      }
      // Metro ferma (linea o tratta) secondo ATM / Roma Mobilità: quelle corse non si usano.
      if (live && this.metroStatus) {
        await this.metroStatus.refresh();
        const ban = [lt.ymd, prevYmd(lt.ymd)].flatMap((ymd) => this.bannedTrips(net, ymd));
        if (ban.length) {
          delay = delay ? Int32Array.from(delay) : new Int32Array(net.tripIds.length);
          for (const t of ban) delay[t] = 1e7;
        }
      }
      if (live && Math.abs(timeMs - Date.now()) < 15 * 60_000) {
        const ghosts = await this.ghostTrips(net, lt);
        if (ghosts.size) {
          delay = delay ? Int32Array.from(delay) : new Int32Array(net.tripIds.length);
          for (const t of ghosts) delay[t] = 1e7;
        }
      }
      const sets = [{ d: net.day(lt.ymd), shift: 0, delay: early ? null : delay }];
      if (early) sets.push({ d: net.day(prevYmd(lt.ymd)), shift: -86400, delay });
      views.push({ net, off, slack: 60, sets, kind: 'city' });
      off += net.stops.length;
      // Metromare e Roma–Viterbo insieme alla rete di Roma.
      if (f.id === 'roma' && this.astral && live) {
        try {
          await this.astral.refresh();
          views.push({ net: this.astral, off, slack: 120, sets: [{ d: this.astral.day(lt.midnight), shift: 0, delay: null }], kind: 'astral' });
          off += this.astral.stops.length;
        } catch (e) {
          log('ASTRAL non disponibile per il navigatore:', e.message);
        }
      }
    }
    if (timeMs > Date.now() - 3600_000 && timeMs < Date.now() + 6 * 3600_000) {
      const rail = this.rail();
      views.push({ net: rail, off, slack: 180, sets: [{ d: rail.day(lt.midnight), shift: 0, delay: null }], kind: 'rail' });
    }
    return { views, lt };
  }

  /** Corse di metro su linee/tratte dichiarate ferme (indici interni della rete). */
  bannedTrips(net, ymd) {
    const out = [];
    for (const P of net.day(ymd).patterns) {
      const info = net.tripInfo(P.trips[0]);
      if (info.mode !== 'metro') continue;
      const st = this.metroAlert(net.id, info);
      if (st?.level !== 'stop') continue;
      const stops = Array.from(P.stops, (s) => net.stops[s]);
      let hit = false;
      for (let i = 0; i < stops.length - 1 && !hit; i++) hit = inSpan(st.span, stops, i);
      if (hit) out.push(...P.trips);
    }
    return out;
  }

  metroAlert(netId, info) {
    if (info.mode !== 'metro' || !this.metroStatus) return null;
    const st = this.metroStatus.get(netId, lineInfo(netId, info).line);
    return st && st.level !== 'ok' ? st : null;
  }

  /** Fermate raggiungibili a piedi da un punto: [[fermataGlobale, secondi], …]. */
  walkable(views, p) {
    const out = [];
    let city = 0;
    for (const v of views) {
      if (v.kind !== 'city') continue;
      for (const [i, d] of v.net.near(p.lat, p.lon, ACCESS_M)) out.push([v.off + i, walkSeconds(d)]);
      city += out.length;
    }
    if (!city)
      for (const v of views)
        if (v.kind === 'city') for (const [i, d] of v.net.near(p.lat, p.lon, ACCESS_MAX_M)) out.push([v.off + i, walkSeconds(d)]);
    for (const v of views)
      if (v.kind === 'rail' || v.kind === 'astral') for (const [i, d] of v.net.near(p.lat, p.lon, RAIL_ACCESS_M)) out.push([v.off + i, walkSeconds(d)]);
    return out;
  }

  crossMap(views) {
    const m = new Map();
    const add = (a, b, s) => {
      let l = m.get(a);
      if (!l) m.set(a, (l = []));
      l.push([b, s]);
    };
    for (const o of views) {
      if (o.kind === 'city') continue; // treni e ferrovie ASTRAL ↔ fermate urbane
      for (const v of views) {
        if (v.kind !== 'city') continue;
        for (const [i, j, s] of this.cross(v.net, o.net)) {
          add(o.off + i, v.off + j, s);
          add(v.off + j, o.off + i, s);
        }
      }
    }
    return m;
  }

  /** Percorsi da `from` a `to` ({lat, lon, name?}) partendo all'istante `timeMs`. */
  async plan(from, to, timeMs = Date.now()) {
    const t0ms = Date.now();
    const { views, lt } = await this.views(from, to, timeMs);
    const out = [];
    const straight = dist(from.lat, from.lon, to.lat, to.lon);
    if (straight <= WALK_ONLY_MAX_M) {
      const sec = walkSeconds(straight);
      out.push({
        dep: timeMs,
        arr: timeMs + sec * 1000,
        legs: [this.walkLeg(from, to, timeMs, timeMs + sec * 1000)],
      });
    }
    if (!views.length) return { journeys: out, note: 'Navigatore disponibile solo a Roma e Milano (più i treni).' };

    const access = this.walkable(views, from);
    const egress = new Map();
    for (const [g, s] of this.walkable(views, to)) if (!egress.has(g) || s < egress.get(g)) egress.set(g, s);
    const cross = this.crossMap(views);

    const seen = new Set();
    let t0 = lt.sec;
    for (let run = 0; run < 4; run++) {
      const res = raptor({ views, access, egress, t0, rounds: 5, cross });
      let nextT0 = INF;
      for (const r of res.results) {
        const raw = unwind(res, views, r);
        if (!raw) continue;
        const rides = raw.filter((l) => l.type === 'ride');
        if (!rides.length) continue;
        const sig = rides.map((l) => `${l.view}/${l.pattern.trips[l.j]}/${l.b}/${l.e}`).join('|');
        const accessSec = raw[0].type === 'access' ? raw[0].sec : 0;
        nextT0 = Math.min(nextT0, rides[0].dep - accessSec + 60);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(this.journey(raw, views, lt, from, to, egress.get(r.g)));
      }
      if (nextT0 >= INF || nextT0 > lt.sec + 3 * 3600) break;
      t0 = Math.max(t0 + 60, nextT0);
    }
    // Ordina per arrivo, togliendo le soluzioni chiaramente peggiori (più tardi E più cambi).
    for (const j of out) {
      j.min = Math.round((j.arr - j.dep) / 60000);
      j.rides = j.legs.filter((l) => l.type === 'ride').length;
      j.changes = Math.max(0, j.rides - 1);
      j.walkM = j.legs.filter((l) => l.type === 'walk').reduce((a, l) => a + l.m, 0);
    }
    // Tiene solo le soluzioni non battute da un'altra su tutti i fronti
    // (parti più tardi, arrivi prima, meno mezzi, meno strada a piedi).
    const beats = (o, j) =>
      o.dep >= j.dep && o.arr <= j.arr && o.rides <= j.rides && o.walkM <= j.walkM + 50 &&
      (o.dep > j.dep || o.arr < j.arr || o.rides < j.rides || o.walkM < j.walkM);
    const fastest = Math.min(...out.map((j) => j.min));
    const kept = out
      .filter((j) => !out.some((o) => o !== j && beats(o, j)))
      .filter((j) => j.min <= fastest * 2 + 30)
      .filter((j, _, all) => j.dep <= timeMs + 90 * 60_000 || all.every((o) => o.dep > timeMs + 90 * 60_000))
      .sort((a, b) => a.arr - b.arr || a.rides - b.rides);
    log(`Navigatore: ${kept.length} soluzioni in ${Date.now() - t0ms} ms`);
    return { journeys: kept.slice(0, 6) };
  }

  walkLeg(a, b, dep, arr) {
    return {
      type: 'walk',
      from: { name: a.name || '', lat: a.lat, lon: a.lon },
      to: { name: b.name || '', lat: b.lat, lon: b.lon },
      dep,
      arr,
      m: Math.round(dist(a.lat, a.lon, b.lat, b.lon) * 1.3),
      coords: [[a.lon, a.lat], [b.lon, b.lat]],
    };
  }

  stopOf(views, g) {
    for (let i = views.length - 1; i >= 0; i--) {
      if (g >= views[i].off) {
        const s = views[i].net.stops[g - views[i].off];
        return { name: views[i].kind === 'rail' ? titleCase(s.name) : s.name, lat: s.lat, lon: s.lon, id: s.id };
      }
    }
  }

  /** Converte le tratte grezze di RAPTOR in qualcosa di leggibile per il browser. */
  journey(raw, views, lt, from, to, egressSec) {
    const ms = (s) => lt.midnight + s * 1000;
    const legs = [];
    for (const l of raw) {
      if (l.type === 'access') {
        // Si esce di casa giusto in tempo per il primo mezzo.
        const s = this.stopOf(views, l.to);
        const next = raw[1];
        const at = next?.type === 'ride' ? next.dep : l.arr;
        legs.push(this.walkLeg(from, s, ms(at - l.sec), ms(at)));
      } else if (l.type === 'walk') {
        legs.push(this.walkLeg(this.stopOf(views, l.from), this.stopOf(views, l.to), ms(l.dep), ms(l.arr)));
      } else {
        legs.push(this.rideLeg(l, views, ms));
      }
    }
    // Fermate consecutive a piedi (es. arrivo a piedi sulla fermata) vanno unite.
    const lastRide = legs[legs.length - 1];
    const end = lastRide.to;
    const arr = lastRide.arr + (egressSec || 0) * 1000;
    if (egressSec > 0 || dist(end.lat, end.lon, to.lat, to.lon) > 30) legs.push(this.walkLeg(end, to, lastRide.arr, arr));
    // Due tratti a piedi di fila diventano uno solo.
    const merged = [];
    for (const l of legs) {
      const p = merged[merged.length - 1];
      if (p && p.type === 'walk' && l.type === 'walk') {
        p.to = l.to;
        p.arr = l.arr;
        p.m += l.m;
        p.coords = [...p.coords, ...l.coords.slice(1)];
      } else merged.push(l);
    }
    return { dep: merged[0].dep, arr, legs: merged };
  }

  rideLeg(l, views, ms) {
    const v = views[l.view];
    const P = l.pattern;
    const stops = [];
    for (let pos = l.b; pos <= l.e; pos++) {
      const s = v.net.stops[P.stops[pos]];
      const t = (pos === l.b ? P.dep : P.arr)[l.j * P.n + pos] + v.sets[l.set].shift + l.delay;
      stops.push({ name: v.kind === 'rail' ? titleCase(s.name) : s.name, lat: s.lat, lon: s.lon, t: ms(t) });
    }
    const leg = {
      type: 'ride',
      from: stops[0],
      to: stops[stops.length - 1],
      dep: ms(l.dep),
      arr: ms(l.arr),
      stops,
    };
    if (v.kind === 'rail') {
      const tr = P.train;
      Object.assign(leg, {
        mode: 'treno',
        line: tr.label,
        cat: tr.cat,
        color: RAIL_COLORS[tr.cat] || RAIL_COLORS[String(tr.label).split(' ')[0]] || MODE_COLORS.treno,
        headsign: tr.dest ? titleCase(tr.dest) : '',
        delay: (tr.delay || 0) * 60,
        live: true,
        trainId: tr.id,
        coords: this.railCoords(v.net, P, l.b, l.e),
      });
    } else if (v.kind === 'astral') {
      const i = P.info;
      Object.assign(leg, {
        mode: 'metro',
        line: i.line,
        lineName: i.name,
        color: i.color,
        headsign: i.dest,
        delay: i.delay * 60,
        live: true,
        alert: i.bus ? 'Corsa con bus sostitutivo' : undefined,
        coords: P.dir.segs.slice(l.b, l.e).flatMap((c, k) => (k ? c.slice(1) : c)),
      });
    } else {
      const t = P.trips[l.j];
      const info = v.net.tripInfo(t);
      const live = !!(l.live && v.net.tripLive?.[t]);
      Object.assign(leg, {
        mode: info.mode,
        ...lineInfo(v.net.id, info),
        headsign: info.headsign,
        delay: live ? l.delay : null,
        live,
        feed: v.net.id,
        tripId: info.tripId,
        alert: this.metroAlert(v.net.id, info)?.text,
        coords: this.shapeCoords(v.net, info.shape, stops),
      });
    }
    return leg;
  }

  railCoords(rail, P, b, e) {
    const out = [];
    for (let pos = b; pos < e; pos++) {
      const A = rail.stops[P.stops[pos]];
      const B = rail.stops[P.stops[pos + 1]];
      const c = this.railPaths?.pathSync(A.id, B.id) || [[A.lon, A.lat], [B.lon, B.lat]];
      out.push(...(out.length ? c.slice(1) : c));
    }
    return out;
  }

  /** Taglia la forma della linea tra la fermata di salita e quella di discesa. */
  shapeCoords(net, shapeId, stops) {
    const f = shapeId && net.statics.shapes.get(shapeId);
    const fallback = stops.map((s) => [s.lon, s.lat]);
    if (!f) return fallback;
    const nearest = (s, from) => {
      let bi = from;
      let bd = Infinity;
      for (let i = from; i < f.length / 2; i++) {
        const d = dist(s.lat, s.lon, f[2 * i + 1], f[2 * i]);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return [bi, bd];
    };
    // Avanza fermata per fermata, così le linee circolari non si tagliano nel punto sbagliato.
    let i = 0;
    const idx = [];
    for (const s of stops) {
      const [k, d] = nearest(s, i);
      if (d > 300) return fallback;
      idx.push(k);
      i = k;
    }
    const pts = [];
    for (let k = idx[0]; k <= idx[idx.length - 1]; k++) pts.push([f[2 * k], f[2 * k + 1]]);
    return pts.length >= 2 ? simplify(pts, 3) : fallback;
  }

  // ---------- fermate e partenze ----------

  /** Fermate dentro il riquadro (solo quando si è molto vicini: sono tante). */
  async stopsInBbox(bb) {
    const [x0, y0, x1, y1] = bb;
    const out = [];
    for (const f of this.cityFeeds) {
      if (f.bbox[2] < x0 || f.bbox[0] > x1 || f.bbox[3] < y0 || f.bbox[1] > y1) continue;
      const net = this.net(f.id);
      if (!net) continue;
      const stops = await net.ensureStops().catch(() => null);
      if (!stops) continue;
      stops.forEach((s, i) => {
        if (s.lon >= x0 && s.lon <= x1 && s.lat >= y0 && s.lat <= y1) out.push({ id: `${f.id}:${i}`, name: s.name, lat: s.lat, lon: s.lon });
      });
    }
    for (const s of this.rail().stops) {
      if (s.lon >= x0 && s.lon <= x1 && s.lat >= y0 && s.lat <= y1)
        out.push({ id: `rail:${s.id}`, name: titleCase(s.name), lat: s.lat, lon: s.lon, rail: true });
    }
    if (this.astral?.ready)
      this.astral.stops.forEach((s, i) => {
        if (s.lon >= x0 && s.lon <= x1 && s.lat >= y0 && s.lat <= y1) out.push({ id: `astral:${i}`, name: s.name, lat: s.lat, lon: s.lon, rail: true });
      });
    return out.slice(0, 4000);
  }

  /** Prossime partenze da una fermata ("roma:123" o "rail:S01700"), ritardi compresi. */
  async arrivals(id, minutes = 90) {
    const [src, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const now = Date.now();
    const lt = localTime(now);
    const out = [];
    let stop;
    if (src === 'astral') {
      if (!this.astral) return null;
      await this.astral.refresh();
      const s = +key;
      stop = this.astral.stops[s];
      if (!stop) return null;
      const d = this.astral.day(lt.midnight);
      for (let e = d.spOff[s]; e < d.spOff[s + 1]; e++) {
        const P = d.patterns[d.spP[e]];
        const pos = d.spPos[e];
        if (pos === P.n - 1) continue;
        const t = lt.midnight + P.dep[pos] * 1000;
        if (t < now - 60_000 || t > now + minutes * 60_000) continue;
        const i = P.info;
        out.push({ t, line: i.line, mode: 'metro', headsign: i.dest, color: i.color, delay: i.delay * 60, live: true, alert: i.bus ? 'bus sostitutivo' : undefined });
      }
      // Corse soppresse: si mostrano barrate, così si sa che non passano.
      for (const dir of this.astral.dirs) {
        const pos = dir.stations.indexOf(s);
        if (pos < 0 || pos === dir.stations.length - 1) continue;
        for (const tr of this.astral.trips.get(dir.code) || []) {
          if (!tr.soppressa) continue;
          const t = lt.midnight + (tr.start + dir.cum[pos]) * 1000;
          if (t < now - 60_000 || t > now + minutes * 60_000) continue;
          out.push({ t, line: dir.line.short, mode: 'metro', headsign: tr.dest.replace(/ Stazione$/i, ''), color: dir.line.color, cancelled: true });
        }
      }
      stop = { name: stop.name, lat: stop.lat, lon: stop.lon };
    } else if (src === 'rail') {
      const rail = this.rail();
      const s = rail.byCode.get(key);
      if (s === undefined) return null;
      stop = rail.stops[s];
      const d = rail.day(lt.midnight);
      for (let e = d.spOff[s]; e < d.spOff[s + 1]; e++) {
        const P = d.patterns[d.spP[e]];
        const pos = d.spPos[e];
        if (pos === P.n - 1) continue;
        const t = lt.midnight + P.dep[pos] * 1000;
        if (t < now - 60_000 || t > now + minutes * 60_000) continue;
        const tr = P.train;
        out.push({
          t, line: tr.label, mode: 'treno', cat: tr.cat, headsign: tr.dest ? titleCase(tr.dest) : '',
          color: RAIL_COLORS[tr.cat] || MODE_COLORS.treno, delay: (tr.delay || 0) * 60, live: true, trainId: tr.id,
        });
      }
      stop = { name: titleCase(stop.name), lat: stop.lat, lon: stop.lon };
    } else {
      const net = await this.readyNet(src);
      if (!net) return null;
      await this.metroStatus?.refresh();
      const s = +key;
      stop = net.stops[s];
      if (!stop) return null;
      const feed = net.feed;
      if (feed.tripUpdates) {
        const tu = await this.transit.tripUpdates(feed.id);
        if (tu?.trips?.size) net.applyDelays(tu.trips);
      }
      const ghosts = await this.ghostTrips(net, lt).catch(() => new Set());
      const sets = [{ d: net.day(lt.ymd), shift: 0 }];
      if (lt.sec < 4 * 3600) sets.push({ d: net.day(prevYmd(lt.ymd)), shift: -86400 });
      for (const { d, shift } of sets) {
        for (let e = d.spOff[s]; e < d.spOff[s + 1]; e++) {
          const P = d.patterns[d.spP[e]];
          const pos = d.spPos[e];
          if (pos === P.n - 1) continue;
          for (let j = 0; j < P.trips.length; j++) {
            const ti = P.trips[j];
            const live = !!net.tripLive?.[ti];
            const delay = live ? net.tripDelay[ti] : 0;
            if (delay >= 1e7) continue; // soppressa
            const sec = P.dep[j * P.n + pos] + shift + delay;
            const t = lt.midnight + sec * 1000;
            if (t < now - 60_000 || t > now + minutes * 60_000) continue;
            const info = net.tripInfo(ti);
            const alert = this.metroAlert(net.id, info);
            // Linea metro ferma per intero: niente partenze "da orario".
            if (alert?.level === 'stop' && !alert.span) continue;
            out.push({
              t, mode: info.mode, headsign: info.headsign, ...lineInfo(net.id, info),
              delay: live ? delay : null, live, feed: net.id, tripId: info.tripId, alert: alert?.text,
              ghost: ghosts.has(ti) || undefined,
            });
          }
        }
      }
    }
    out.sort((a, b) => a.t - b.t);
    // Alcuni GTFS ripetono la stessa corsa con id diversi.
    const seen = new Set();
    const deps = out.filter((d) => {
      const k = `${d.line}|${d.headsign}|${Math.round(d.t / 60000)}`;
      return !seen.has(k) && seen.add(k);
    });
    return { stop: { name: stop.name, lat: stop.lat, lon: stop.lon }, now, departures: deps.slice(0, 60) };
  }

  // ---------- ricerca luoghi ----------

  /** Indirizzi e luoghi (Photon/OpenStreetMap) + fermate e stazioni con quel nome. */
  async geocode(q, near) {
    q = (q || '').trim();
    if (q.length < 2) return [];
    const nq = normName(q);
    const stops = [];
    const addStops = (list, prefix, kind) => {
      const seen = new Set();
      for (let i = 0; i < list.length && stops.length < 40; i++) {
        const s = list[i];
        const n = normName(s.name);
        if (!n.includes(nq) || seen.has(n)) continue;
        seen.add(n); // le due direzioni hanno lo stesso nome: basta una
        stops.push({
          kind, name: kind === 'stazione' ? titleCase(s.name) : s.name, sub: prefix,
          lat: s.lat, lon: s.lon, score: (n.startsWith(nq) ? 0 : 1) + (near ? dist(near.lat, near.lon, s.lat, s.lon) / 50_000 : 0),
        });
      }
    };
    for (const f of this.cityFeeds) {
      const net = this.net(f.id);
      const list = net && (await net.ensureStops().catch(() => null));
      if (list) addStops(list, `Fermata · ${f.id === 'roma' ? 'Roma' : f.id === 'milano' ? 'Milano' : f.id}`, 'fermata');
    }
    addStops(this.rail().stops, 'Stazione', 'stazione');
    stops.sort((a, b) => a.score - b.score);

    let places = [];
    try {
      const u = new URL('https://photon.komoot.io/api/');
      u.searchParams.set('q', q);
      u.searchParams.set('limit', '7');
      u.searchParams.set('bbox', '6.6,36.6,18.6,47.1'); // Italia
      if (near) {
        u.searchParams.set('lat', near.lat);
        u.searchParams.set('lon', near.lon);
      }
      const res = await fetchWithTimeout(u, {}, 8000);
      const js = await res.json();
      places = (js.features || []).map((f) => {
        const p = f.properties;
        const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
        const name = p.name || street || p.city;
        const sub = [p.name && street, p.city || p.county, p.state].filter(Boolean).join(', ');
        return { kind: 'luogo', name, sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      });
    } catch (e) {
      log('Ricerca luoghi non riuscita:', e.message);
    }
    const seen = new Set();
    // Per un indirizzo ("via Padova 12") contano i luoghi, non le fermate con quel nome.
    const isAddress = /^(via|viale|v\.le|piazza|p\.za|piazzale|corso|largo|vicolo|lungo\w*)\b/i.test(q);
    return [...stops.slice(0, isAddress && places.length ? 1 : 4), ...places]
      .filter((r) => {
        const k = `${r.name}|${r.sub}`;
        return !seen.has(k) && seen.add(k);
      })
      .slice(0, 8)
      .map(({ score, ...r }) => r);
  }
}
