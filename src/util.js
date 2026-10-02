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
 * e 'lo' (scoperta di nuovi treni dai tabelloni). 'lo' riceve comunque una
 * quota garantita (`loShare`) così la scoperta non resta mai ferma.
 */
export class Limiter {
  constructor({ concurrency = 4, rps = 8, loShare = 0.35 } = {}) {
    this.concurrency = concurrency;
    this.gap = 1000 / rps;
    this.loShare = loShare;
    this.credit = 0;
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
      let job;
      this.credit += this.loShare;
      if (this.lo.length && (this.credit >= 1 || !this.hi.length)) {
        job = this.lo.shift();
        this.credit = Math.max(0, this.credit - 1);
      } else {
        job = this.hi.shift();
      }
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

/**
 * Modalità del server in base a quanto tempo è passato dall'ultima volta che qualcuno
 * ha guardato la mappa (batteria, rete, cortesia verso ViaggiaTreno):
 *   attivo     mappa aperta: frequenza normale
 *   risparmio  dopo 3 minuti: ogni treno al massimo ogni 10 min, tabelloni ogni 30
 *   standby    dopo 10 minuti: ogni treno al massimo ogni 30 min, tabelloni ogni 60
 * L'elenco dei treni resta caldo, così la mappa riaperta è subito quasi completa.
 */
export const MODES = {
  attivo: { refresh: 0, sweep: 0 },
  risparmio: { after: 3 * 60_000, refresh: 10 * 60_000, sweep: 30 * 60_000 },
  standby: { after: 10 * 60_000, refresh: 30 * 60_000, sweep: 60 * 60_000 },
};

export const activity = {
  last: Date.now(),
  current: 'attivo',
  touch() {
    this.last = Date.now();
    if (this.current !== 'attivo') {
      log(`Mappa aperta: da ${this.current} torno alla frequenza normale`);
      this.current = 'attivo';
    }
  },
  get mode() {
    const away = Date.now() - this.last;
    const m = away > MODES.standby.after ? 'standby' : away > MODES.risparmio.after ? 'risparmio' : 'attivo';
    if (m !== this.current) {
      this.current = m;
      log(
        m === 'standby'
          ? 'Nessuno guarda la mappa da 10 minuti: modalità standby'
          : 'Nessuno guarda la mappa da 3 minuti: modalità risparmio'
      );
    }
    return m;
  },
  get idle() {
    return this.mode !== 'attivo';
  },
};

/** Aspetta `ms`, ma si sveglia prima se la mappa viene riaperta durante il risparmio. */
export async function idleAwareSleep(ms) {
  const end = Date.now() + ms;
  const startedIdle = activity.idle;
  while (Date.now() < end) {
    await sleep(Math.min(5000, end - Date.now()));
    if (startedIdle && !activity.idle) return;
  }
}
