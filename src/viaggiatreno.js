// Treni Trenitalia, Trenord, TILO, Tper, FSE via ViaggiaTreno.
//
// ViaggiaTreno non ha un elenco "tutti i treni in circolazione", quindi:
//  1. SCOPERTA: si leggono a rotazione partenze e arrivi delle stazioni principali;
//     ogni treno incontrato viene aggiunto all'elenco dei treni da seguire.
//  2. AGGIORNAMENTO: per ogni treno seguito si chiama andamentoTreno
//     (ritardo, fermate, ultimo rilevamento) e si calcola il tratto che sta
//     percorrendo: da [lon, lat, ora] a [lon, lat, ora]. Il browser interpola.

import { Limiter, fetchWithTimeout, normName, distKm, pt, sleep, log, activity, idleAwareSleep, MODES } from './util.js';
import { hubStations } from './stations.js';

const BASE = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';

const OPERATORS = {
  1: 'Trenitalia',
  2: 'Trenitalia',
  4: 'Trenitalia',
  18: 'Trenitalia Tper',
  63: 'Trenord',
  64: 'TILO',
  910: 'Ferrovie del Sud Est',
};

export function categoryOf(label) {
  const p = (label || '').trim().split(/\s+/)[0].toUpperCase();
  if (['FR', 'FA', 'FB', 'ES'].includes(p)) return 'av';
  if (['IC', 'ICN', 'EC', 'EN', 'EXP'].includes(p)) return 'ic';
  return 'reg';
}

/** Data nel formato accettato da partenze/arrivi: "Fri Oct 02 2026 17:50:00 GMT+0200". */
function vtDate(d = new Date()) {
  return encodeURIComponent(d.toString().replace(/\s*\(.*\)$/, ''));
}

export class ViaggiaTrenoTracker {
  constructor({ stations, rail = null, rps = 8, refreshMs = 150_000, sweepMs = 8 * 60_000 }) {
    this.st = stations;
    this.rail = rail;
    this.hubs = hubStations(stations);
    // Le altre stazioni (tra cui Roma Tiburtina, Milano Lambrate, Torino Porta Susa: l'anagrafica
    // non le segna come principali) si leggono a rotazione, un terzo per giro, solo le partenze:
    // così si trovano anche i treni che non passano da nessuna stazione principale.
    const hubSet = new Set(this.hubs.map((h) => h.code));
    this.others = stations.list.filter((s) => !hubSet.has(s.code)).sort(() => Math.random() - 0.5);
    this.othersPos = 0;
    this.limiter = new Limiter({ concurrency: 14, rps });
    this.refreshMs = refreshMs;
    this.sweepMs = sweepMs;
    this.trains = new Map(); // key "S01700/9651/1790892000000" → stato
    this.rfiCircolanti = null;
    this.sweeps = 0;
    this.lastSweepMs = null;
  }

  start() {
    log(`ViaggiaTreno: ${this.hubs.length} stazioni principali a ogni giro + ${this.others.length} a rotazione (1/3 per giro), ${this.st.list.length} in anagrafica`);
    this.sweepLoop();
    this.statsLoop();
    setInterval(() => this.scheduleRefresh(), 1000);
    setInterval(() => this.cleanup(), 60_000);
  }

  async get(path, prio) {
    const res = await this.limiter.run(() => fetchWithTimeout(BASE + path), prio);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------- 1. scoperta ----------

  async sweepLoop() {
    for (;;) {
      const t0 = Date.now();
      const date = vtDate();
      const before = this.trains.size;
      const n = Math.ceil(this.others.length / 3);
      const chunk = [];
      for (let i = 0; i < n && this.others.length; i++) chunk.push(this.others[(this.othersPos + i) % this.others.length]);
      this.othersPos = (this.othersPos + n) % Math.max(1, this.others.length);
      await Promise.all([
        ...this.hubs.flatMap((h) => [this.readBoard('partenze', h, date), this.readBoard('arrivi', h, date)]),
        ...chunk.map((s) => this.readBoard('partenze', s, date)),
      ]);
      this.sweeps++;
      this.lastSweepMs = Date.now() - t0;
      log(
        `ViaggiaTreno: giro tabelloni #${this.sweeps} in ${Math.round(this.lastSweepMs / 1000)}s, ` +
          `+${this.trains.size - before} treni (seguiti: ${this.trains.size})`
      );
      await idleAwareSleep(Math.max(10_000, (MODES[activity.mode].sweep || this.sweepMs) - (Date.now() - t0)));
    }
  }

  async readBoard(kind, hub, date) {
    let list;
    try {
      list = await this.get(`/${kind}/${hub.code}/${date}`, 'lo');
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const t of list) {
      if (!t.codOrigine || !t.numeroTreno || t.provvedimento === 1) continue;
      const key = `${t.codOrigine}/${t.numeroTreno}/${t.dataPartenzaTreno}`;
      if (this.trains.has(key)) continue;
      const label = (t.compNumeroTreno || `${t.categoria} ${t.numeroTreno}`).trim();
      // Treno non ancora partito dall'origine: inutile interrogarlo subito.
      // Se parte da qui lo controllo 2 minuti prima, altrimenti 45 minuti prima del passaggio qui.
      let nextRefresh = now;
      if (kind === 'partenze' && t.nonPartito && t.orarioPartenza > now) {
        nextRefresh = t.codOrigine === hub.code ? t.orarioPartenza - 2 * 60_000 : t.orarioPartenza - 45 * 60_000;
        nextRefresh = Math.max(now, nextRefresh);
      }
      this.trains.set(key, {
        id: 'vt:' + key,
        key,
        src: 'vt',
        label,
        cat: categoryOf(label),
        op: OPERATORS[t.codiceCliente] || 'Trenitalia',
        dest: t.destinazione,
        nextRefresh,
        inflight: false,
        misses: 0,
        seg: null,
      });
    }
  }

  // ---------- 2. aggiornamento ----------

  scheduleRefresh() {
    if (this.limiter.queuedHi > 30) return;
    const now = Date.now();
    const minAge = MODES[activity.mode].refresh;
    const due = [];
    for (const tr of this.trains.values()) {
      if (tr.inflight || tr.nextRefresh > now) continue;
      if (minAge && tr.upd && now - tr.upd < minAge) continue;
      due.push(tr);
    }
    due.sort((a, b) => a.nextRefresh - b.nextRefresh);
    for (const tr of due.slice(0, 40 - this.limiter.queuedHi)) {
      tr.inflight = true;
      this.refresh(tr).finally(() => (tr.inflight = false));
    }
  }

  async refresh(tr) {
    let a;
    try {
      a = await this.get(`/andamentoTreno/${tr.key}`, 'hi');
    } catch {
      a = undefined;
    }
    const now = Date.now();
    if (!a) {
      if (++tr.misses >= 3) this.trains.delete(tr.key);
      else tr.nextRefresh = now + 60_000;
      return;
    }
    tr.misses = 0;
    if (a.provvedimento === 1 || a.arrivato) {
      this.trains.delete(tr.key);
      return;
    }
    const seg = this.segment(a, now);
    if (seg?.status === 'arrived') {
      this.trains.delete(tr.key);
      return;
    }
    Object.assign(tr, {
      label: (a.compNumeroTreno || tr.label).trim(),
      delay: a.ritardo ?? 0,
      orig: a.origine,
      dest: a.destinazione,
      det: a.stazioneUltimoRilevamento && a.stazioneUltimoRilevamento !== '--' ? a.stazioneUltimoRilevamento : null,
      detT: a.oraUltimoRilevamento || null,
      note: a.subTitle || null,
      seg,
      stops: compactStops(a),
      upd: now,
    });
    tr.cat = categoryOf(tr.label);
    if (seg?.status === 'notstarted' && seg.departure) {
      // Non ancora partito: ricontrollo subito dopo l'orario di partenza (prima è inutile),
      // poi ogni 90 s finché non risulta partito (treni in ritardo alla partenza).
      tr.nextRefresh = seg.departure > now ? seg.departure + 30_000 : now + 90_000;
    } else if (seg?.status === 'running' && seg.to && seg.to[2] - now > 10 * 60_000) {
      // Lunga tratta senza fermate (es. Frecce Milano–Bologna): la posizione si interpola bene,
      // basta aggiornare un po' meno spesso.
      tr.nextRefresh = now + this.refreshMs * (1.4 + Math.random() * 0.3);
    } else {
      // Un po' di jitter per spalmare le richieste nel tempo.
      tr.nextRefresh = now + this.refreshMs * (0.85 + Math.random() * 0.3);
    }
  }

  /** Calcola il tratto attuale del treno a partire dalla risposta di andamentoTreno. */
  segment(a, now) {
    const F = (a.fermate || []).filter((f) => f.actualFermataType !== 3);
    if (F.length < 2) return null;
    const coord = (f) => this.st.byCode.get(f.id);
    const realDep = (f) => f.partenzaReale ?? (f.tipoFermata === 'P' ? f.effettiva : null);
    const realArr = (f) => f.arrivoReale ?? (f.tipoFermata === 'A' ? f.effettiva : null);
    const delayMs = (a.ritardo || 0) * 60_000;

    let k = -1;
    F.forEach((f, i) => {
      if (realDep(f) || realArr(f)) k = i;
    });

    if (k === -1) {
      return { status: 'notstarted', departure: F[0].partenza_teorica ?? F[0].programmata };
    }
    if (k === F.length - 1) return { status: 'arrived' };

    const fk = F[k];
    if (realArr(fk) && !realDep(fk) && k > 0 && coord(fk)) {
      const c = coord(fk);
      return { status: 'station', from: pt(c, now), to: pt(c, now), a: fk.id, prev: fk.stazione, next: F[k + 1].stazione };
    }

    let i = k;
    while (i >= 0 && !coord(F[i])) i--;
    let j = k + 1;
    while (j < F.length && !coord(F[j])) j++;
    if (i < 0 || j >= F.length) return null;

    const t0 = realDep(fk) ?? realArr(fk);
    const sched = F[j].arrivo_teorico ?? F[j].programmata;
    if (!sched) return null;
    let from = pt(coord(F[i]), t0);
    let fromCode = F[i].id;
    let t1 = sched + delayMs;

    // Se l'ultimo rilevamento è una località nota tra le due fermate, si riparte da lì:
    // molto utile per le Frecce senza fermate intermedie (es. Milano–Roma).
    const det = this.st.byName.get(normName(a.stazioneUltimoRilevamento));
    if (det && a.oraUltimoRilevamento > t0 && det.code !== F[i].id && det.code !== F[j].id) {
      const A = coord(F[i]);
      const B = coord(F[j]);
      const total = distKm(A, B);
      if (distKm(det, B) < total && distKm(A, det) < total * 1.15) {
        from = pt(det, a.oraUltimoRilevamento);
        fromCode = det.code;
      }
    }
    if (t1 <= from[2]) t1 = from[2] + 60_000;
    return {
      status: 'running',
      from,
      to: pt(coord(F[j]), t1),
      a: fromCode,
      pa: F[i].id, // fermata precedente: la linea disegnata sulla mappa va da qui a b
      b: F[j].id,
      prev: F[i].stazione,
      next: F[j].stazione,
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, tr] of this.trains) {
      // Treni mai aggiornati con successo da oltre un'ora, o fermi senza notizie da 4 ore.
      if (!tr.upd && now - tr.nextRefresh > 3600_000) this.trains.delete(key);
      else if (tr.upd && tr.detT && now - tr.detT > 4 * 3600_000) this.trains.delete(key);
    }
  }

  async statsLoop() {
    for (;;) {
      try {
        const s = await this.get(`/statistiche/${Date.now()}`, 'hi');
        if (s?.treniCircolanti) this.rfiCircolanti = s.treniCircolanti;
      } catch {}
      await sleep(120_000);
    }
  }

  visible() {
    const out = [];
    for (const tr of this.trains.values()) {
      if (tr.seg && (tr.seg.status === 'running' || tr.seg.status === 'station')) out.push(publicTrain(tr, this.rail));
    }
    return out;
  }

  stats() {
    const perStato = {};
    const now = Date.now();
    for (const t of this.trains.values()) {
      const k = !t.upd
        ? t.nextRefresh > now
          ? 'partenza_successiva'
          : 'in_attesa_di_aggiornamento'
        : t.seg?.status || 'posizione_non_calcolabile';
      perStato[k] = (perStato[k] || 0) + 1;
    }
    return {
      seguiti: this.trains.size,
      visibili: (perStato.running || 0) + (perStato.station || 0),
      perStato,
      rfiCircolanti: this.rfiCircolanti,
      giriTabelloni: this.sweeps,
      durataGiroS: this.lastSweepMs && Math.round(this.lastSweepMs / 1000),
      richiesteOk: this.limiter.done,
      richiesteErrore: this.limiter.errors,
      codaScoperta: this.limiter.queuedLo,
    };
  }
}

function compactStops(a) {
  return (a.fermate || []).map((f) => ({
    name: f.stazione,
    code: f.id,
    arr: f.arrivo_teorico,
    dep: f.partenza_teorica,
    realArr: f.arrivoReale,
    realDep: f.partenzaReale,
    delay: f.ritardo,
    soppressa: f.actualFermataType === 3,
  }));
}

const M_LON = 111320 * Math.cos((42 * Math.PI) / 180);
const M_LAT = 110540;

/** Punto di una polilinea più vicino a (lon, lat): frazione lungo il percorso (0–1) e distanza in metri. */
function projectFrac(coords, lon, lat) {
  let cum = 0;
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - lon) * M_LON, ay = (coords[i - 1][1] - lat) * M_LAT;
    const bx = (coords[i][0] - lon) * M_LON, by = (coords[i][1] - lat) * M_LAT;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len || 1)));
    const d = Math.hypot(ax + u * dx, ay + u * dy);
    if (!best || d < best.d) best = { d, s: cum + u * len };
    cum += len;
  }
  return best && cum > 0 ? { d: best.d, f: best.s / cum } : null;
}

export function publicTrain(tr, rail) {
  const s = tr.seg;
  // Il percorso tra la stazione di rilevamento e la fermata successiva, calcolato a sé, può scegliere un
  // altro binario rispetto alla linea disegnata (fermata precedente → successiva): il pallino finiva
  // fuori tracciato. Si usa quindi la stessa linea e si dice al browser da che punto (s0) partire.
  let path = s.status === 'running' && rail ? rail.pathFor(s.a, s.b) : null;
  let s0;
  if (s.status === 'running' && rail && s.pa && s.pa !== s.a) {
    const key = rail.pathFor(s.pa, s.b);
    const c = key && rail.paths.get(key)?.coords;
    const pr = c && projectFrac(c, s.from[0], s.from[1]);
    if (pr && pr.d < 2500) {
      path = key;
      s0 = Math.round(pr.f * 1e5) / 1e5;
    }
  }
  return {
    id: tr.id,
    src: tr.src,
    label: tr.label,
    cat: tr.cat,
    op: tr.op,
    delay: tr.delay ?? 0,
    orig: tr.orig,
    dest: tr.dest,
    status: s.status,
    from: s.from,
    to: s.to,
    // Id del percorso sui binari (null finché non è calcolato: il browser usa la linea retta).
    path,
    s0,
    prev: s.prev,
    next: s.next,
    det: tr.det,
    detT: tr.detT,
    note: tr.note || undefined,
    upd: tr.upd,
  };
}
