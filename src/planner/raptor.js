// RAPTOR (Round-bAsed Public Transit Optimized Router, Delling et al.):
// ogni "round" aggiunge una corsa in più, così si ottengono insieme il percorso più veloce
// e quelli con meno cambi. Lavora su più reti insieme (città + treni) con fermate globali:
// fermata globale = offset della rete + indice locale.

export const INF = 0x3fffffff;
const MAX_LATE = 1800; // un mezzo in ritardo fino a 30' può ancora passare "prima" del previsto

/**
 * @param {object} o
 * @param {Array}  o.views   [{ net, off, slack, sets: [{ d, shift, delay }] }] ordinate per off
 * @param {Array}  o.access  [[fermataGlobale, secondi a piedi], …]
 * @param {Map}    o.egress  fermataGlobale → secondi a piedi fino alla destinazione
 * @param {number} o.t0      partenza, secondi dalla mezzanotte
 * @param {Map}    o.cross   fermataGlobale → [[fermataGlobale, secondi], …] (cambi tra reti)
 */
export function raptor({ views, access, egress, t0, rounds = 5, cross }) {
  const last = views[views.length - 1];
  const N = last.off + last.net.stops.length;
  const viewOf = (g) => {
    for (let i = views.length - 1; i >= 0; i--) if (g >= views[i].off) return i;
    return -1;
  };
  const R = [];
  const newRound = () => ({
    tau: new Int32Array(N).fill(INF),
    kind: new Int8Array(N), // 0 = invariato, 1 = corsa, 2 = a piedi, 3 = partenza
    a: new Int32Array(N), // corsa: set; a piedi: fermata di provenienza; partenza: secondi
    p: new Int32Array(N), // pattern
    j: new Int32Array(N), // corsa nel pattern
    b: new Int32Array(N), // posizione di salita
    e: new Int32Array(N), // posizione di discesa
  });
  const best = new Int32Array(N).fill(INF);
  let marked = [];
  const isMarked = new Uint8Array(N);
  const mark = (g) => {
    if (!isMarked[g]) {
      isMarked[g] = 1;
      marked.push(g);
    }
  };

  const r0 = newRound();
  for (const [g, s] of access) {
    const t = t0 + s;
    if (t < r0.tau[g]) {
      r0.tau[g] = best[g] = t;
      r0.kind[g] = 3;
      r0.a[g] = s;
      mark(g);
    }
  }
  R.push(r0);

  let destBest = INF;
  const results = [];
  const checkDest = (k) => {
    let bestG = -1;
    for (const [g, s] of egress) {
      const t = R[k].tau[g];
      if (t < INF && t + s < destBest) {
        destBest = t + s;
        bestG = g;
      }
    }
    if (bestG >= 0) results.push({ k, g: bestG, arr: destBest });
  };
  // (nessun controllo al round 0: "solo a piedi" lo valuta il chiamante)

  for (let k = 1; k <= rounds && marked.length; k++) {
    const prev = R[k - 1];
    const cur = newRound();
    cur.tau.set(prev.tau);
    R.push(cur);

    // Pattern da esaminare, ciascuno dalla prima fermata migliorata.
    const queue = new Map();
    for (const g of marked) {
      isMarked[g] = 0;
      const vi = viewOf(g);
      const v = views[vi];
      const s = g - v.off;
      v.sets.forEach((set, si) => {
        const d = set.d;
        for (let e = d.spOff[s]; e < d.spOff[s + 1]; e++) {
          const key = (vi * 4 + si) * 1e7 + d.spP[e];
          const pos = d.spPos[e];
          const q = queue.get(key);
          if (q === undefined || pos < q) queue.set(key, pos);
        }
      });
    }
    marked = [];

    const rode = [];
    for (const [key, pos0] of queue) {
      const vs = Math.floor(key / 1e7);
      const vi = vs >> 2;
      const si = vs & 3;
      const v = views[vi];
      const set = v.sets[si];
      const pi = key - vs * 1e7;
      const P = set.d.patterns[pi];
      const n = P.n;
      const m = P.trips.length;
      const shift = set.shift;
      const dl = set.delay;
      const delayOf = (jj) => (dl ? dl[P.trips[jj]] : 0);
      const slack = k === 1 ? 0 : v.slack;
      let j = -1;
      let jDelay = 0;
      let board = -1;
      for (let pos = pos0; pos < n; pos++) {
        const g = v.off + P.stops[pos];
        if (j >= 0) {
          const t = P.arr[j * n + pos] + shift + jDelay;
          if (t < best[g] && t < destBest) {
            cur.tau[g] = best[g] = t;
            cur.kind[g] = 1;
            cur.a[g] = vs;
            cur.p[g] = pi;
            cur.j[g] = j;
            cur.b[g] = board;
            cur.e[g] = pos;
            if (!isMarked[g]) rode.push(g);
            mark(g);
          }
        }
        const ready = prev.tau[g];
        if (ready >= INF || pos === n - 1) continue;
        const need = ready + slack - shift;
        if (j >= 0 && P.dep[j * n + pos] + jDelay < need) continue;
        // Prima corsa che parte da qui dopo `need` (ritardi compresi).
        let lo = 0;
        let hi = m;
        const from = need - (dl ? MAX_LATE : 0);
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (P.dep[mid * n + pos] < from) lo = mid + 1;
          else hi = mid;
        }
        let bj = -1;
        let bt = INF;
        let bd = 0;
        for (let jj = lo; jj < m; jj++) {
          const sched = P.dep[jj * n + pos];
          if (sched > bt + MAX_LATE) break;
          const dd = delayOf(jj);
          const t = sched + dd;
          if (t >= need && t < bt) {
            bt = t;
            bj = jj;
            bd = dd;
          }
        }
        if (bj >= 0 && (j < 0 || bt < P.dep[j * n + pos] + jDelay)) {
          j = bj;
          jDelay = bd;
          board = pos;
        }
      }
    }

    // Cambi a piedi dalle fermate appena raggiunte con un mezzo.
    for (const g of rode) {
      const v = views[viewOf(g)];
      const s = g - v.off;
      const net = v.net;
      const base = cur.tau[g];
      const relax = (h, sec) => {
        const t = base + sec;
        if (t < best[h] && t < destBest) {
          cur.tau[h] = best[h] = t;
          cur.kind[h] = 2;
          cur.a[h] = g;
          mark(h);
        }
      };
      for (let e = net.fpOff[s]; e < net.fpOff[s + 1]; e++) relax(v.off + net.fpTo[e], net.fpSec[e]);
      for (const [h, sec] of cross.get(g) || []) relax(h, sec);
    }
    checkDest(k);
  }
  return { R, results, viewOf };
}

/** Ricostruisce le tratte di un risultato, dall'origine alla destinazione. */
export function unwind(run, views, res) {
  const { R, viewOf } = run;
  const legs = [];
  let g = res.g;
  let k = res.k;
  for (let guard = 0; guard < 50; guard++) {
    while (k > 0 && R[k].kind[g] === 0) k--;
    const r = R[k];
    const kd = r.kind[g];
    if (kd === 3) {
      legs.unshift({ type: 'access', to: g, sec: r.a[g], arr: r.tau[g] });
      return legs;
    }
    if (kd === 2) {
      const from = r.a[g];
      legs.unshift({ type: 'walk', from, to: g, dep: r.tau[from], arr: r.tau[g] });
      g = from;
      continue;
    }
    if (kd === 1) {
      const vs = r.a[g];
      const v = views[vs >> 2];
      const set = v.sets[vs & 3];
      const P = set.d.patterns[r.p[g]];
      const j = r.j[g];
      const delay = set.delay ? set.delay[P.trips[j]] : 0;
      legs.unshift({
        type: 'ride', view: vs >> 2, set: vs & 3, pattern: P, j,
        b: r.b[g], e: r.e[g],
        dep: P.dep[j * P.n + r.b[g]] + set.shift + delay,
        arr: P.arr[j * P.n + r.e[g]] + set.shift + delay,
        delay, live: !!set.delay,
      });
      g = v.off + P.stops[r.b[g]];
      k--;
      continue;
    }
    return null; // non dovrebbe succedere
  }
  return null;
}
