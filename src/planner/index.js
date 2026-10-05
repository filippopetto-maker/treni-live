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
// Ogni notte alle 3 (ora italiana) si controllano gli orari nuovi e si preparano i giorni.
const NIGHTLY_AT = process.env.NAV_NIGHTLY_AT || '03:00';
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

const shiftYmd = (ymd, days) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86400_000);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};
const nextYmd = (ymd) => shiftYmd(ymd, 1);
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
    this.prep = Promise.resolve(); // una città alla volta legge le tabelle complete (picco di memoria)
    this.nightlyReport = null;
    this.scheduleNightly();
    // ATAC ripubblica gli orari ogni mattina (con nuovi identificativi delle corse): oltre al rinnovo
    // delle 3 c'è un controllo leggero ogni ora tra le 5 e le 23, che ricostruisce solo se il file è cambiato.
    this.hourly = setInterval(() => {
      const h = Math.floor(localTime(Date.now()).sec / 3600);
      if (h < 5 || h > 23 || this.nightlyRunning) return;
      this.nightlyRunning = true;
      this.nightly({ onlyIfChanged: true })
        .catch((e) => log('Controllo orari:', e.message))
        .finally(() => (this.nightlyRunning = false));
    }, 3600_000);
    this.hourly.unref?.();
  }

  /** Giorni da tenere pronti: ieri (notturni dopo mezzanotte), oggi, domani. */
  windowDays(ms = Date.now()) {
    const today = localTime(ms).ymd;
    return [prevYmd(today), today, nextYmd(today)];
  }

  /** Esegue fn quando nessun'altra città sta leggendo le tabelle complete. */
  serial(fn) {
    const p = this.prep.then(fn, fn);
    this.prep = p.catch(() => {});
    return p;
  }

  /** Prepara tutte le città (all'avvio, appena gli orari della mappa sono pronti). */
  async warmup() {
    for (const f of this.cityFeeds) {
      const st = this.transit.statics.get(f.id);
      while (!st?.ready) {
        if (st?.state?.startsWith('errore')) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!st?.ready) continue;
      await this.serial(() => this.net(f.id).ensureDays(this.windowDays())).catch(() => {});
    }
  }

  // ---------- rinnovo notturno ----------

  scheduleNightly() {
    const [h, m] = NIGHTLY_AT.split(':').map(Number);
    const lt = localTime(Date.now());
    let wait = (h * 3600 + m * 60 - lt.sec) * 1000;
    if (wait <= 60_000) wait += 86400_000;
    clearTimeout(this.nightlyTimer);
    this.nightlyTimer = setTimeout(async () => {
      while (this.nightlyRunning) await new Promise((r) => setTimeout(r, 10_000));
      this.nightlyRunning = true;
      await this.nightly().catch((e) => log('Rinnovo notturno:', e.message));
      this.nightlyRunning = false;
      this.scheduleNightly();
    }, wait);
    this.nightlyTimer.unref?.();
    this.nightlyNext = Date.now() + wait;
  }

  /**
   * Ogni notte: per ogni città si controlla se il sito pubblica orari nuovi (si scaricano solo
   * se cambiati o se quelli in uso stanno per scadere), poi si preparano ieri/oggi/domani.
   * Un errore su una città non ferma l'altra; se il download fallisce restano gli orari vecchi.
   */
  async nightly({ forceDownload = false, onlyIfChanged = false } = {}) {
    const rep = { inizio: new Date().toISOString(), tipo: onlyIfChanged ? 'controllo orario' : 'rinnovo completo', citta: {} };
    if (!onlyIfChanged) this.nightlyReport = rep;
    else this.lastCheck = rep;
    log(onlyIfChanged ? 'Controllo orari nuovi' : 'Rinnovo notturno degli orari: inizio');
    for (const f of this.cityFeeds) {
      const r = (rep.citta[f.id] = {});
      const t0 = Date.now();
      try {
        const st = this.transit.statics.get(f.id);
        const net = this.net(f.id);
        if (!st || !net) throw new Error('orari della città non disponibili');
        const today = localTime(Date.now()).ymd;
        const end = net.dataEnd?.() || net.calendarEnd?.() || null;
        const expiring = end && end < shiftYmd(today, 5);
        let changed = false;
        try {
          const u = await st.checkUpdate({ force: forceDownload || expiring });
          r.download = u.changed ? 'orari nuovi scaricati' : u.reason || 'nessuna novità';
          changed = u.changed;
        } catch (e) {
          r.download = 'non riuscito: ' + e.message + ' (restano gli orari in uso)';
        }
        if (changed) {
          // Orari nuovi: la mappa si reindicizza e la rete del navigatore si ricostruisce.
          await this.serial(async () => {
            // Per qualche secondo si libera anche l'altra città: la ricostruzione è il momento
            // di massima memoria (alle 3 di notte nessuno se ne accorge, poi si ripreparano tutte).
            for (const other of this.nets.values()) if (other !== net) other.unload();
            net.reset();
            this.dropCaches(f.id);
            globalThis.gc?.();
            await st.reindex();
            globalThis.gc?.();
            await net.ensureDays(this.windowDays());
          });
        } else if (!onlyIfChanged) {
          await this.serial(() => net.ensureDays(this.windowDays()));
        }
        if (changed && onlyIfChanged) this.nightlyReport = rep;
        r.giorni = [...net.dates.keys()];
        r.corse = net.tripIds?.length || 0;
        r.orariFinoAl = net.calendarEnd();
        if (r.orariFinoAl && r.orariFinoAl < shiftYmd(today, 5)) r.avviso = `gli orari pubblicati finiscono il ${r.orariFinoAl}`;
      } catch (e) {
        r.errore = e.message;
      }
      r.secondi = Math.round((Date.now() - t0) / 1000);
      if (!onlyIfChanged || r.download !== 'nessuna novità sul sito') log(`Orari ${f.id}: ${JSON.stringify(r)}`);
    }
    // Città liberate durante la ricostruzione di un'altra: si ripreparano.
    for (const f of this.cityFeeds) {
      const net = this.net(f.id);
      if (net && this.transit.statics.get(f.id)?.ready && !net.hasDays(this.windowDays())) {
        await this.serial(() => net.ensureDays(this.windowDays())).catch((e) => (rep.citta[f.id].errore ||= e.message));
        rep.citta[f.id].giorni = [...net.dates.keys()];
        rep.citta[f.id].corse = net.tripIds?.length || 0;
      }
    }
    rep.fine = new Date().toISOString();
    return rep;
  }

  /** Dati calcolati su una versione precedente della rete. */
  dropCaches(id) {
    for (const k of [...this.crossCache.keys()]) if (k.endsWith('>' + id)) this.crossCache.delete(k);
    this.ghostCache?.delete(id);
    this.transit.metro?.days?.clear?.();
  }

  status() {
    const out = { citta: {}, rinnovoNotturno: this.nightlyReport, ultimoControllo: this.lastCheck ? { alle: this.lastCheck.inizio, esito: Object.fromEntries(Object.entries(this.lastCheck.citta).map(([k, v]) => [k, v.download || v.errore])) } : null, prossimoRinnovo: this.nightlyNext ? new Date(this.nightlyNext).toISOString() : null };
    for (const [id, n] of this.nets) {
      out.citta[id] = {
        pronta: n.loaded,
        inPreparazione: !!n.preparing,
        giorni: [...n.dates.keys()],
        corse: n.tripIds?.length || 0,
        preparataAlle: n.preparedAt ? new Date(n.preparedAt).toISOString() : null,
        orariFinoAl: n.calendarEnd?.() || null,
        datiDichiarati: n.feedInfo ? { versione: n.feedInfo.version, superficieFinoAl: n.feedInfo.surfaceEnd, metroFinoAl: n.feedInfo.metroEnd } : null,
        giorniStimati: [...n.dates.values()].filter((d) => d.estimated).map((d) => `${d.ymd} (da ${d.estimated.surface || d.estimated.metro})`),
      };
    }
    return out;
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

  /**
   * Rete urbana pronta per i giorni richiesti (oltre a ieri/oggi/domani, sempre in memoria).
   * Errore chiaro se gli orari sono ancora in preparazione.
   */
  async readyNet(id, extraDays = []) {
    const n = this.net(id);
    if (!n) return null;
    if (!n.statics.ready) throw new Error(`orari di ${n.feed.name} ancora in preparazione, riprova tra poco`);
    const win = this.windowDays();
    const want = [...new Set([...win, ...extraDays])];
    if (n.hasDays(want)) {
      n.lastUse = Date.now();
      return n;
    }
    // Un giorno fuori da ieri/oggi/domani si aggiunge a quelli in memoria (fino al prossimo rinnovo).
    const keep = extraDays.length ? [...new Set([...win, ...n.dates.keys(), ...extraDays])].filter((y) => y >= win[0]).sort().slice(0, 6) : win;
    // La preparazione può richiedere qualche secondo su un server lento:
    // si risponde subito e il lavoro continua in sottofondo.
    const p = this.serial(() => n.ensureDays(keep));
    const wait = await Promise.race([p.then(() => 'ok'), new Promise((r) => setTimeout(() => r('lento'), 20_000))]);
    if (wait === 'lento') {
      p.catch(() => {});
      throw new Error(`sto preparando gli orari di ${n.feed.name.split(' —')[0]} (succede una volta al giorno): riprova tra un paio di minuti`);
    }
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
    if (c && c.version === net.version && Date.now() - c.at < 30_000) return c.set;
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
    (this.ghostCache ||= new Map()).set(net.id, { at: Date.now(), set: ghosts, version: net.version });
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
      const net = await this.readyNet(f.id, [lt.ymd, prevYmd(lt.ymd)]);
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
    const notes = views.filter((v) => v.kind === 'city').map((v) => this.estimatedNote(v.net, v.sets.map((x) => x.d.estimated))).filter(Boolean);
    return notes.length ? { journeys: kept.slice(0, 6), note: notes.join(' ') } : { journeys: kept.slice(0, 6) };
  }

  /** Avviso per le città i cui orari pubblicati sono scaduti (si usano quelli della settimana prima). */
  estimatedNote(net, days) {
    const est = days.filter(Boolean);
    if (!est.length) return null;
    const fi = net.feedInfo || {};
    const f = (y) => (y ? `${+y.slice(6, 8)}/${+y.slice(4, 6)}` : '');
    const city = net.id === 'milano' ? 'Milano' : net.id === 'roma' ? 'Roma' : net.id;
    const what = [est.some((e) => e.surface) && `bus e tram scaduti il ${f(fi.surfaceEnd)}`, est.some((e) => e.metro) && `metro scaduta il ${f(fi.metroEnd)}`].filter(Boolean).join(', ');
    return `${city}: gli orari pubblicati da ${net.id === 'milano' ? 'ATM/Comune' : "l'azienda"} non sono aggiornati (${what}). Uso quelli della settimana precedente: possono esserci differenze.`;
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
      const est = v.sets[l.set]?.d?.estimated;
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
        estimated: !!(est && (info.mode === 'metro' ? est.metro : est.surface)) || undefined,
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
  /**
   * Linee che passano vicino a un punto (fermate entro `radius` metri), con la fermata più vicina,
   * le destinazioni e il prossimo passaggio. null se il punto non è in una città col navigatore.
   */
  async linesNear(lat, lon, radius = 450) {
    const feed = this.cityFeeds.find((f) => inBbox(f.bbox, lat, lon));
    if (!feed) return null;
    const net = await this.readyNet(feed.id);
    if (!net) return null;
    const now = Date.now();
    const lt = localTime(now);
    const d = net.day(lt.ymd);
    const lines = new Map();
    for (const [i, m] of net.near(lat, lon, radius)) {
      for (let e = d.spOff[i]; e < d.spOff[i + 1]; e++) {
        const P = d.patterns[d.spP[e]];
        const pos = d.spPos[e];
        if (pos === P.n - 1) continue; // capolinea d'arrivo: da qui non si parte
        const info = net.tripInfo(P.trips[0]);
        const li = lineInfo(net.id, info);
        const key = `${info.mode}|${li.line}`;
        let next = null;
        for (let j = 0; j < P.trips.length; j++) {
          const t = P.dep[j * P.n + pos];
          if (t >= lt.sec - 60 && (next == null || t < next)) next = t;
        }
        let L = lines.get(key);
        if (!L) {
          L = { q: info.mode === 'metro' ? li.line : `${info.mode} ${li.line}`, name: li.line, mode: info.mode, color: li.color, dist: m, stop: { id: i, name: net.stops[i].name }, heads: new Set(), next: null };
          lines.set(key, L);
        }
        if (m < L.dist) Object.assign(L, { dist: m, stop: { id: i, name: net.stops[i].name } });
        if (info.headsign) L.heads.add(info.headsign);
        if (next != null && (L.next == null || next < L.next)) L.next = next;
      }
    }
    return {
      city: feed.id,
      lines: [...lines.values()]
        .filter((L) => L.next != null)
        .sort((a, b) => Math.round(a.dist / 100) - Math.round(b.dist / 100) || a.next - b.next)
        .slice(0, 18)
        .map((L) => ({ ...L, dist: Math.round(L.dist), heads: [...L.heads].slice(0, 3), next: lt.midnight + L.next * 1000 })),
    };
  }

  /**
   * Tabellone di una linea bus/tram/metro in una direzione: per ogni corsa che deve ancora passare
   * dalla fermata scelta (o la più vicina al punto dato), tra quanto arriva, se il mezzo trasmette
   * la posizione GPS, quante fermate mancano, e se è una corsa "fantasma" (doveva essere partita
   * ma non si vede: probabilmente salta).
   */
  async lineBoard({ feed, routeIds, dir = '', lat = null, lon = null, stop = null, minutes = 75 }) {
    const net = await this.readyNet(feed);
    if (!net) return null;
    const now = Date.now();
    const lt = localTime(now);
    const want = new Set(routeIds);
    const st = net.statics;
    const sets = [{ d: net.day(lt.ymd), shift: 0 }];
    if (lt.sec < 4 * 3600) sets.push({ d: net.day(prevYmd(lt.ymd)), shift: -86400 });
    // Direzioni (destinazioni) della linea oggi, con le loro sequenze di fermate.
    const dirs = new Map(); // destinazione normalizzata → { headsign, pats: [{P, shift}], trips }
    for (const { d, shift } of sets) {
      for (const P of d.patterns) {
        const tid = net.tripIds[P.trips[0]];
        const tr = st.trips.get(tid);
        if (!tr || !want.has(tr[0])) continue;
        const key = normName(tr[2] || '?');
        if (!dirs.has(key)) dirs.set(key, { headsign: titleCase(tr[2] || '?'), pats: [], trips: 0 });
        const e = dirs.get(key);
        e.pats.push({ P, shift, est: d.estimated });
        e.trips += P.trips.length;
      }
    }
    const list = [...dirs.entries()].sort((a, b) => b[1].trips - a[1].trips);
    if (!list.length) return { directions: [], dir: null, stops: [], stop: null, trips: [], note: 'Nessuna corsa oggi per questa linea.' };
    const chosen = list.find(([k]) => k === normName(dir)) || list[0];
    const D = chosen[1];
    // Fermate della direzione: quelle della sequenza con più corse, nell'ordine di percorrenza.
    const main = D.pats.reduce((a, b) => (b.P.trips.length > a.P.trips.length ? b : a)).P;
    const stops = Array.from(main.stops, (i) => ({ id: i, name: net.stops[i].name, lat: net.stops[i].lat, lon: net.stops[i].lon }));
    let target = stop != null && stops.some((x) => x.id === +stop) ? +stop : null;
    if (target == null && lat != null && lon != null) {
      let best = Infinity;
      for (const x of stops) {
        const m = dist(lat, lon, x.lat, x.lon);
        if (m < best) [best, target] = [m, x.id];
      }
    }
    if (target == null) target = stops[Math.max(0, stops.length - 2)]?.id ?? null;
    // Dati dal vivo: ritardi (TripUpdates), posizioni (GPS) e corse fantasma.
    const fobj = net.feed;
    const vp = fobj.url ? await this.transit.vehicles(fobj).catch(() => null) : null;
    const byTrip = new Map((vp?.vehicles || []).map((v) => [v.trip, v]));
    if (fobj.tripUpdates) {
      const tu = await this.transit.tripUpdates(fobj.id).catch(() => null);
      if (tu?.trips?.size) net.applyDelays(tu.trips);
    }
    const ghosts = await this.ghostTrips(net, lt).catch(() => new Set());
    const hasLive = !!fobj.url;
    const out = [];
    for (const { P, shift, est } of D.pats) {
      const k = Array.prototype.indexOf.call(P.stops, target);
      if (k < 0) continue;
      const n = P.n;
      for (let j = 0; j < P.trips.length; j++) {
        const ti = P.trips[j];
        const tid = net.tripIds[ti];
        const live = !!net.tripLive?.[ti];
        const delay = live ? net.tripDelay[ti] : 0;
        const cancelled = delay >= 1e7;
        const sched = P.arr[j * n + k] + shift;
        const first = P.dep[j * n] + shift;
        const v = byTrip.get(tid);
        // Dove si trova il mezzo: fermata della sequenza più vicina alla posizione GPS.
        let at = null;
        if (v) {
          let best = Infinity;
          for (let i = 0; i < n; i++) {
            const s2 = net.stops[P.stops[i]];
            const m = dist(v.lat, v.lon, s2.lat, s2.lon);
            if (m < best) [best, at] = [m, i];
          }
        }
        let eta = sched + (cancelled ? 0 : delay);
        let shown = live && !cancelled ? delay : null;
        // Con un GPS recente l'arrivo si stima dalla posizione vera (i ritardi dichiarati a volte sono strani);
        // una posizione vecchia (oltre 3 minuti) non si usa per decidere niente.
        const fresh = v && (!v.ts || now / 1000 - v.ts < 180);
        if (fresh && at != null && at > k) continue; // già passato dalla fermata
        if (fresh && at != null) {
          eta = lt.sec + Math.max(0, P.arr[j * n + k] - P.arr[j * n + at]);
          if (lt.sec >= first) shown = eta - sched; // prima della partenza dal capolinea non ha senso
        }
        if (!v && eta < lt.sec - 60) continue;
        if (eta > lt.sec + minutes * 60) continue;
        const started = lt.sec >= first + (cancelled ? 0 : delay);
        let stopsAway = null;
        if (at != null) stopsAway = Math.max(0, k - at);
        else if (started) {
          let passed = 0;
          for (let i = 0; i < n; i++) if (P.arr[j * n + i] + shift + delay <= lt.sec) passed = i;
          stopsAway = Math.max(0, k - passed);
        }
        out.push({
          tripId: tid,
          eta: lt.midnight + eta * 1000,
          sched: lt.midnight + sched * 1000,
          delay: shown,
          gps: v ? { lat: v.lat, lon: v.lon, age: v.ts ? Math.max(0, Math.round(now / 1000 - v.ts)) : null, vehicle: v.vlabel || v.vid || v.id } : null,
          started,
          stopsAway,
          ghost: ghosts.has(ti) || undefined,
          cancelled: cancelled || undefined,
          estimated: !!(est && est.surface) || undefined,
          fromTerminus: !started ? `${net.stops[P.stops[0]].name} alle ${new Date(lt.midnight + first * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: TZ })}` : undefined,
        });
      }
    }
    out.sort((a, b) => a.eta - b.eta);
    const seen = new Set();
    const trips = out.filter((x) => !seen.has(x.tripId) && seen.add(x.tripId)).slice(0, 10);
    return {
      directions: list.map(([k, e]) => ({ key: k, headsign: e.headsign, trips: e.trips })),
      dir: chosen[0],
      stops,
      stop: stops.find((x) => x.id === target) || null,
      hasLive,
      trips,
      note: this.estimatedNote(net, sets.map((x) => x.d.estimated)) || undefined,
    };
  }

  async arrivals(id, minutes = 90) {
    const [src, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const now = Date.now();
    const lt = localTime(now);
    const out = [];
    let stop;
    let note = null;
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
      note = this.estimatedNote(net, sets.map((x) => x.d.estimated));
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
              estimated: !!(d.estimated && (info.mode === 'metro' ? d.estimated.metro : d.estimated.surface)) || undefined,
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
    return { stop: { name: stop.name, lat: stop.lat, lon: stop.lon }, now, departures: deps.slice(0, 60), ...(note ? { note } : {}) };
  }

  // ---------- ricerca luoghi ----------

  /** Indirizzi e luoghi (Photon/OpenStreetMap) + fermate e stazioni con quel nome. */
  /** Quanti treni seguiti passano da ogni stazione (codice → numero), ricalcolato ogni 10 minuti. */
  stationWeight() {
    if (this._weight && Date.now() - this._weight.at < 600_000) return this._weight.map;
    const map = new Map();
    for (const tracker of this.trackers || []) {
      for (const tr of tracker.trains.values()) for (const s of tr.stops || []) if (s.code) map.set(s.code, (map.get(s.code) || 0) + 1);
    }
    this._weight = { at: Date.now(), map };
    return map;
  }

  /** Fermate della metro di una città (indice fermata → linee), dagli orari di oggi. */
  metroStops(net) {
    if (net._metro?.version === net.version) return net._metro.map;
    const map = new Map();
    for (const d of net.dates.values()) {
      for (const P of d.patterns) {
        const info = net.tripInfo(P.trips[0]);
        if (info.mode !== 'metro') continue;
        const line = lineInfo(net.id, info).line;
        for (const st of P.stops) {
          if (!map.has(st)) map.set(st, new Set());
          map.get(st).add(line);
        }
      }
    }
    net._metro = { version: net.version, map };
    return map;
  }

  /**
   * Stazioni per nome: ferroviarie in tutta Italia; se il punto è dentro una città (mappa zoomata)
   * anche le stazioni della metro e di Metromare/Roma–Viterbo. Le più vicine al punto vengono prima.
   */
  async findStations(q, near, city = false) {
    const nq = normName(q || '');
    if (nq.length < 2) return [];
    const out = [];
    // Nome che inizia con la ricerca > parola che inizia > contiene; poi le stazioni con più treni e le più vicine.
    const match = (name) => {
      const n = normName(name);
      return n.startsWith(nq) ? 0 : (' ' + n).includes(' ' + nq) ? 0.4 : 1;
    };
    const score = (name, lat, lon) => match(name) + (near ? dist(near.lat, near.lon, lat, lon) / 300_000 : 0);
    const weight = this.stationWeight();
    for (const s of this.rail().stops) {
      if (!normName(s.name).includes(nq)) continue;
      const imp = Math.log10(1 + (weight.get(s.id) || 0)) / 4;
      out.push({ id: `rail:${s.id}`, name: titleCase(s.name), sub: 'Stazione ferroviaria', lat: s.lat, lon: s.lon, rail: true, score: score(s.name, s.lat, s.lon) - imp });
    }
    if (city && near) {
      for (const f of this.cityFeeds) {
        if (!inBbox(f.bbox, near.lat, near.lon)) continue;
        const net = this.net(f.id);
        if (!net?.loaded) continue;
        const seen = new Set();
        for (const [i, lines] of this.metroStops(net)) {
          const s = net.stops[i];
          const n = normName(s.name);
          if (!n.includes(nq) || seen.has(n)) continue;
          seen.add(n);
          const ls = [...lines].sort();
          out.push({ id: `${f.id}:${i}`, name: s.name, sub: `Metro ${ls.join(', ')}`, lat: s.lat, lon: s.lon, metro: ls, score: score(s.name, s.lat, s.lon) - 0.05 });
        }
        if (f.id === 'roma' && this.astral?.ready) {
          this.astral.stops.forEach((s, i) => {
            if (normName(s.name).includes(nq)) out.push({ id: `astral:${i}`, name: s.name, sub: 'Metromare / Roma–Viterbo', lat: s.lat, lon: s.lon, rail: true, score: score(s.name, s.lat, s.lon) });
          });
        }
      }
    }
    out.sort((a, b) => a.score - b.score);
    return out.slice(0, 8).map(({ score, ...r }) => r);
  }

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
