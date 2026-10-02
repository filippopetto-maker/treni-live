// Treni Italo via "Italo in viaggio" (stesso schema: scoperta dai tabelloni + aggiornamento per treno).

import { Limiter, fetchWithTimeout, normName, pt, sleep, log } from './util.js';
import { publicTrain } from './viaggiatreno.js';

const BASE = 'https://italoinviaggio.italotreno.com';

// Nomi Italo → nomi RFI quando non coincidono. Si allunga man mano che compaiono
// nel log righe "Italo: stazione non riconosciuta".
const ALIAS = {
  NAPOLI: 'NAPOLI CENTRALE',
  'MEDIOPADANA R EMILIA': 'REGGIO EMILIA AV MEDIOPADANA',
  'REGGIO EMILIA AV': 'REGGIO EMILIA AV MEDIOPADANA',
  'MILANO EXPO RHO': 'RHO FIERA',
  'MILANO RHO FIERA': 'RHO FIERA',
  'TREVISO C LE': 'TREVISO CENTRALE',
  PESCHIERA: 'PESCHIERA DEL GARDA',
  'VENEZIA SANTA LUCIA': 'VENEZIA S LUCIA',
  'REGGIO CALABRIA': 'REGGIO DI CALABRIA CENTRALE',
  'REGGIO CALABRIA CENTRALE': 'REGGIO DI CALABRIA CENTRALE',
  'VIBO PIZZO': 'VIBO VALENTIA PIZZO',
  'LAMEZIA TERME': 'LAMEZIA TERME CENTRALE',
  'VALLO D LUCANIA': 'VALLO DELLA LUCANIA CASTELNUOVO',
  'VILLA S GIOVANNI': 'VILLA S GIOVANNI',
  TRIESTE: 'TRIESTE CENTRALE',
};

/** "17:08" → timestamp di oggi (gestendo i treni a cavallo della mezzanotte). */
function parseHM(hm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m) return null;
  const d = new Date(now);
  d.setHours(+m[1], +m[2], 0, 0);
  let t = d.getTime();
  if (t - now > 12 * 3600_000) t -= 24 * 3600_000;
  if (now - t > 12 * 3600_000) t += 24 * 3600_000;
  return t;
}

export class ItaloTracker {
  constructor({ stations, rps = 3, refreshMs = 90_000, sweepMs = 4 * 60_000 }) {
    this.st = stations;
    this.limiter = new Limiter({ concurrency: 3, rps });
    this.refreshMs = refreshMs;
    this.sweepMs = sweepMs;
    this.codes = [];
    this.trains = new Map(); // numero treno → stato
    this.unresolved = new Set();
    this.resolveCache = new Map();
  }

  async start() {
    try {
      const html = await (await fetchWithTimeout(BASE + '/it/stazione')).text();
      const codes = new Set();
      for (const m of html.matchAll(/\{"code":"([^"]+)","urlCoding":"([^"]+)"\}/g)) codes.add(m[1]);
      this.codes = [...codes];
    } catch (e) {
      log('Italo: impossibile leggere l\'elenco stazioni:', e.message);
    }
    if (!this.codes.length) {
      log('Italo: nessuna stazione trovata, modulo disattivato');
      return;
    }
    log(`Italo: ${this.codes.length} stazioni`);
    this.sweepLoop();
    setInterval(() => this.scheduleRefresh(), 1000);
  }

  async getJson(path, prio) {
    const res = await this.limiter.run(() => fetchWithTimeout(BASE + path), prio);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  resolve(name) {
    if (this.resolveCache.has(name)) return this.resolveCache.get(name);
    const n = normName(name);
    const byName = this.st.byName;
    let s = byName.get(ALIAS[n] || n) || byName.get(n + ' CENTRALE');
    if (!s) {
      // Ultimo tentativo: stazione (preferibilmente importante) il cui nome inizia come quello cercato.
      s = [...this.st.list]
        .sort((a, b) => a.zoom - b.zoom)
        .find((x) => normName(x.name).startsWith(n + ' ') || n.startsWith(normName(x.name) + ' '));
    }
    if (!s && !this.unresolved.has(name)) {
      this.unresolved.add(name);
      log(`Italo: stazione non riconosciuta "${name}" (aggiungila ad ALIAS in src/italo.js)`);
    }
    this.resolveCache.set(name, s || null);
    return s || null;
  }

  async sweepLoop() {
    for (;;) {
      const t0 = Date.now();
      await Promise.all(this.codes.map((c) => this.readBoard(c)));
      await sleep(Math.max(10_000, this.sweepMs - (Date.now() - t0)));
    }
  }

  async readBoard(code) {
    let b;
    try {
      b = await this.getJson(`/api/RicercaStazioneService?&CodiceStazione=${code}`, 'lo');
    } catch {
      return;
    }
    for (const t of [...(b.ListaTreniArrivo || []), ...(b.ListaTreniPartenza || [])]) {
      if (!t.Numero || this.trains.has(t.Numero)) continue;
      this.trains.set(t.Numero, {
        id: 'italo:' + t.Numero,
        num: t.Numero,
        src: 'italo',
        label: 'Italo ' + t.Numero,
        cat: 'italo',
        op: 'Italo',
        nextRefresh: Date.now(),
        inflight: false,
        misses: 0,
        seg: null,
      });
    }
  }

  scheduleRefresh() {
    if (this.limiter.queuedHi > 6) return;
    const now = Date.now();
    for (const tr of this.trains.values()) {
      if (this.limiter.queuedHi > 10) break;
      if (tr.inflight || tr.nextRefresh > now) continue;
      tr.inflight = true;
      this.refresh(tr).finally(() => (tr.inflight = false));
    }
  }

  async refresh(tr) {
    const now = Date.now();
    let r;
    try {
      r = await this.getJson(`/api/RicercaTrenoService?&TrainNumber=${tr.num}`, 'hi');
    } catch {}
    const ts = r?.TrainSchedule;
    if (!ts) {
      if (++tr.misses >= 3) this.trains.delete(tr.num);
      else tr.nextRefresh = now + 120_000;
      return;
    }
    tr.misses = 0;
    const seg = this.segment(ts, now);
    if (seg?.status === 'arrived') {
      this.trains.delete(tr.num);
      return;
    }
    const all = [ts.StazionePartenza, ...(ts.StazioniFerme || []), ...(ts.StazioniNonFerme || [])].filter(Boolean);
    Object.assign(tr, {
      delay: ts.Distruption?.DelayAmount ?? 0,
      orig: ts.DepartureStationDescription,
      dest: ts.ArrivalStationDescription,
      det: null,
      detT: null,
      seg,
      stops: all.map((s, idx) => ({
        name: s.LocationDescription,
        arr: idx === 0 ? null : parseHM(s.EstimatedArrivalTime, now),
        dep: idx === all.length - 1 ? null : parseHM(s.EstimatedDepartureTime, now),
        realArr: idx === 0 ? null : parseHM(s.ActualArrivalTime, now),
        realDep: idx === all.length - 1 ? null : parseHM(s.ActualDepartureTime, now),
        delay: null,
      })),
      upd: now,
    });
    tr.nextRefresh =
      seg?.status === 'notstarted' && seg.departure
        ? Math.max(now + this.refreshMs, seg.departure - 3 * 60_000)
        : now + this.refreshMs * (0.85 + Math.random() * 0.3);
  }

  segment(ts, now) {
    const done = ts.StazioniFerme || [];
    const todo = ts.StazioniNonFerme || [];
    if (!todo.length) return { status: 'arrived' };
    const last = done.length ? done[done.length - 1] : ts.StazionePartenza;
    if (!last) return null;
    const depT = parseHM(last.ActualDepartureTime || last.EstimatedDepartureTime, now);
    if (!done.length && depT && depT > now + 60_000) return { status: 'notstarted', departure: depT };

    const next = todo[0];
    const delayMs = (ts.Distruption?.DelayAmount || 0) * 60_000;
    const est = parseHM(next.EstimatedArrivalTime, now);
    const act = parseHM(next.ActualArrivalTime, now);
    let arrT = Math.max(act ?? 0, (est ?? 0) + delayMs);

    const A = this.resolve(last.LocationDescription);
    const B = this.resolve(next.LocationDescription);
    if (!A || !B || !depT || !arrT) return null;
    if (depT > now) {
      return { status: 'station', from: pt(A, now), to: pt(A, now), prev: last.LocationDescription, next: next.LocationDescription };
    }
    if (arrT <= depT) arrT = depT + 60_000;
    return { status: 'running', from: pt(A, depT), to: pt(B, arrT), prev: last.LocationDescription, next: next.LocationDescription };
  }

  visible() {
    const out = [];
    for (const tr of this.trains.values()) {
      if (tr.seg && (tr.seg.status === 'running' || tr.seg.status === 'station')) out.push(publicTrain(tr));
    }
    return out;
  }

  stats() {
    return {
      seguiti: this.trains.size,
      visibili: this.visible().length,
      stazioniNonRiconosciute: [...this.unresolved],
    };
  }
}
