// Guida con il telefono in tasca: il server segue il mezzo (posizione live, ritardo comunicato
// o orario) e manda le notifiche "arriva", "prossima fermata", "scendi".
// Non serve la posizione del telefono: funziona anche a schermo spento e in metropolitana.
import crypto from 'node:crypto';
import '../public/guide-core.js';
import { log } from './util.js';

const G = globalThis.GuideCore;
const MAX_SESSIONS = 100;
const TICK_MS = 15_000;

/** Dati dal vivo per una tratta: ritardo comunicato e/o posizione del mezzo. */
export async function liveForLeg(leg, { transit, findTrain }) {
  const out = { delaySec: null, vehicle: null };
  if (leg.trainId) {
    const tr = findTrain(leg.trainId);
    if (tr) out.delaySec = (tr.delay || 0) * 60;
    return out;
  }
  if (!leg.feed || !leg.tripId) return out;
  const feed = transit.feeds.find((f) => f.id === leg.feed);
  if (!feed) return out;
  const [vp, tu] = await Promise.all([
    feed.url ? transit.vehicles(feed).catch(() => null) : null,
    feed.tripUpdates ? transit.tripUpdates(feed.id).catch(() => null) : null,
  ]);
  const v = vp?.vehicles?.find((x) => x.trip === leg.tripId);
  if (v) out.vehicle = { lat: v.lat, lon: v.lon, ts: v.ts || Math.floor(Date.now() / 1000) };
  const e = tu?.trips?.get(leg.tripId);
  if (e) {
    if (e.cancelled) out.cancelled = true;
    const u = e.upd?.find((x) => x.delay !== undefined && !x.skipped);
    out.delaySec = (u ? u.delay : e.delay) || 0;
  }
  return out;
}

/** Solo i campi che servono a seguire il viaggio (il telefono manda il percorso scelto). */
function cleanJourney(j) {
  const num = (x) => (Number.isFinite(+x) ? +x : null);
  const stop = (s) => ({ name: String(s?.name || '').slice(0, 80), lat: num(s?.lat), lon: num(s?.lon), t: num(s?.t) });
  const legs = (j?.legs || []).slice(0, 12).map((l) => {
    const leg = { type: l.type === 'ride' ? 'ride' : 'walk', dep: num(l.dep), arr: num(l.arr), from: stop(l.from), to: stop(l.to) };
    if (leg.type === 'ride') {
      Object.assign(leg, {
        mode: String(l.mode || 'bus').slice(0, 12),
        line: String(l.line || '').slice(0, 20),
        lineName: l.lineName ? String(l.lineName).slice(0, 30) : undefined,
        headsign: String(l.headsign || '').slice(0, 60),
        delay: num(l.delay) || 0,
        feed: l.feed ? String(l.feed).slice(0, 20) : undefined,
        tripId: l.tripId ? String(l.tripId).slice(0, 80) : undefined,
        trainId: l.trainId ? String(l.trainId).slice(0, 40) : undefined,
        stops: (l.stops || []).slice(0, 120).map(stop),
        coords: (l.coords || []).slice(0, 4000).map((c) => [num(c[0]), num(c[1])]),
      });
      if (leg.stops.length < 2 || leg.stops.some((s) => s.t == null || s.lat == null)) throw new Error('tratta senza fermate');
    }
    return leg;
  });
  if (!legs.some((l) => l.type === 'ride')) throw new Error('percorso senza mezzi da seguire');
  return { legs, arr: num(j.arr) || legs[legs.length - 1].arr };
}

export class GuideService {
  constructor({ push, transit, findTrain }) {
    this.push = push;
    this.deps = { transit, findTrain };
    this.sessions = new Map();
    setInterval(() => this.tick().catch((e) => log('Guida:', e.message)), TICK_MS).unref();
  }

  async start({ subscription, journey }) {
    if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys) throw new Error('abbonamento notifiche mancante');
    const j = cleanJourney(journey);
    // Un viaggio alla volta per telefono.
    for (const [id, s] of this.sessions) if (s.sub.endpoint === subscription.endpoint) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('troppe guide attive, riprova più tardi');
    const id = crypto.randomBytes(9).toString('base64url');
    const s = { id, sub: { endpoint: subscription.endpoint, keys: subscription.keys }, legs: j.legs, sent: new Set(), until: j.arr + 45 * 60_000, offsets: [] };
    this.sessions.set(id, s);
    const first = j.legs.find((l) => l.type === 'ride');
    const status = await this.push.send(s.sub, {
      title: '🧭 Guida attiva',
      body: `Ti avviso quando arriva ${G.art(first)} ${G.lineName(first)} e quando devi scendere.`,
      tag: 'guida',
    });
    if (status === 404 || status === 410) {
      this.sessions.delete(id);
      throw new Error('abbonamento notifiche scaduto');
    }
    if (status < 200 || status >= 300) log(`Guida ${id}: prima notifica non consegnata (${status})`);
    setTimeout(() => this.check(s).catch(() => {}), 1000);
    return { id, notifica: status };
  }

  /** Ferma la sessione con questo id e tutte quelle dello stesso telefono (abbonamento). */
  stop(id, endpoint) {
    let n = this.sessions.delete(id) ? 1 : 0;
    if (endpoint) for (const [k, s] of this.sessions) if (s.sub.endpoint === endpoint && this.sessions.delete(k)) n++;
    return n;
  }

  async tick() {
    for (const s of [...this.sessions.values()]) {
      if (Date.now() > s.until) this.sessions.delete(s.id);
      else await this.check(s);
    }
  }

  async check(s) {
    const now = Date.now();
    const legs = s.legs;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.type !== 'ride' || s.sent.has(`${i}:scendi`)) continue;
      // Si guardano i dati dal vivo solo per le tratte vicine nel tempo.
      if (leg.stops[0].t - now > 20 * 60_000) break;
      const live = await liveForLeg(leg, this.deps).catch(() => null);
      const off = G.offsetFrom(leg, live, now);
      s.offsets[i] = off;
      const { events, pr } = G.dueEvents(leg, off, now);
      // Prima "arriva", poi "prossima", poi "scendi": se il server è rimasto indietro si salta ai fatti.
      const kind = events.includes('scendi') ? 'scendi' : events.includes('prossima') ? 'prossima' : events[0];
      if (kind && !s.sent.has(`${i}:${kind}`)) {
        if (kind === 'arriva' && live?.cancelled) {
          await this.send(s, { title: `⚠️ ${G.lineName(leg)} soppresso`, body: 'La corsa risulta soppressa: apri la mappa per ricalcolare.', tag: 'guida' });
        } else {
          const m = G.message(kind, leg, pr, legs[i + 1], now);
          await this.send(s, { title: m.title, body: m.body, tag: 'guida', kind, leg: i });
        }
        for (const k of ['arriva', 'prossima', 'scendi']) {
          s.sent.add(`${i}:${k}`);
          if (k === kind) break;
        }
      }
      break; // una tratta alla volta: la prossima si guarda quando questa è finita
    }
    if (legs.every((l, i) => l.type !== 'ride' || s.sent.has(`${i}:scendi`))) {
      // Viaggio finito: resta in ascolto ancora un po' nel caso serva, poi si chiude.
      s.until = Math.min(s.until, now + 10 * 60_000);
    }
  }

  async send(s, msg) {
    // Fermata mentre si leggevano i dati dal vivo ("Termina" premuto in quel momento): niente invio.
    if (!this.sessions.has(s.id)) return;
    const st = await this.push.send(s.sub, msg);
    if (st === 404 || st === 410) this.sessions.delete(s.id);
  }

  stats() {
    return { guideAttive: this.sessions.size, ...this.push.stats };
  }
}
