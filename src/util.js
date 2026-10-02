// Utility condivise: rete, rate limiting, nomi, geometria.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

export async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Limita le richieste verso un host: massimo `rps` richieste al secondo e
 * `concurrency` in parallelo. Due code: 'hi' (aggiornamento treni già noti)
 * ha sempre la precedenza su 'lo' (scoperta di nuovi treni dai tabelloni).
 */
export class Limiter {
  constructor({ concurrency = 4, rps = 8 } = {}) {
    this.concurrency = concurrency;
    this.gap = 1000 / rps;
    this.active = 0;
    this.hi = [];
    this.lo = [];
    this.last = 0;
    this.timer = null;
    this.done = 0;
    this.errors = 0;
  }

  run(fn, prio = 'lo') {
    return new Promise((resolve, reject) => {
      (prio === 'hi' ? this.hi : this.lo).push({ fn, resolve, reject });
      this._pump();
    });
  }

  get queuedHi() {
    return this.hi.length;
  }

  get queuedLo() {
    return this.lo.length;
  }

  _pump() {
    if (this.timer) return;
    while (this.active < this.concurrency && (this.hi.length || this.lo.length)) {
      const wait = this.last + this.gap - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this._pump();
        }, wait);
        return;
      }
      this.last = Date.now();
      const job = this.hi.length ? this.hi.shift() : this.lo.shift();
      this.active++;
      Promise.resolve()
        .then(job.fn)
        .then(
          (v) => {
            this.done++;
            job.resolve(v);
          },
          (e) => {
            this.errors++;
            job.reject(e);
          }
        )
        .finally(() => {
          this.active--;
          this._pump();
        });
    }
  }
}

/** Normalizza un nome di stazione per i confronti ("Venezia S.Lucia" → "VENEZIA S LUCIA"). */
export function normName(s) {
  return (s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Distanza approssimata in km tra due punti {lat, lon}. */
export function distKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Punto nel formato inviato al browser: [lon, lat, timestamp]. */
export const pt = (s, t) => [round6(s.lon), round6(s.lat), t];
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export const log = (...a) =>
  console.log(new Date().toLocaleTimeString('it-IT'), ...a);
