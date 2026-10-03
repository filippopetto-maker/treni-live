// Prova di carico: utenti simulati che usano il sito come persone vere.
// Uso: node prova-carico.mjs [etichetta]   (BASE=https://... per cambiare server)
// Gradini da 2 minuti con 5, 10, 20, 40, 80 utenti; si ferma prima se il sito diventa inutilizzabile.
// Ogni utente: mappa aperta (treni ogni 15 s + stato), notizie ogni 60 s; metà zoomati su Roma
// (bus ogni 20 s, fermate) e di questi uno su tre cerca un percorso ogni ~3 minuti.
// Alla fine un gradino "misto": ricerche alternate Roma/Milano (il caso peggiore del server).
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://treni-live.onrender.com';
const LABEL = process.argv[2] || 'prova';
const STEPS = (process.env.STEPS || '5,10,20,40,80').split(',').map(Number);
const STEP_MS = Number(process.env.STEP_S || 120) * 1000;
const TIMEOUT = 30_000;
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const ROMA = [[41.9009, 12.5018], [41.8902, 12.4922], [41.896, 12.4823], [41.9029, 12.4534], [41.8719, 12.4789], [41.9227, 12.5131], [41.8583, 12.5544], [41.9339, 12.4663], [41.8846, 12.5143], [41.8676, 12.5113]];
const MILANO = [[45.4642, 9.19], [45.4781, 9.2273], [45.4855, 9.2041], [45.4520, 9.1770], [45.4735, 9.1736], [45.4380, 9.2140]];
const WORDS = ['termini', 'colosseo', 'piazza venezia', 'san pietro', 'tiburtina', 'trastevere', 'eur', 'piramide'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stats = new Map();
function rec(name, ms, ok) {
  if (!stats.has(name)) stats.set(name, { t: [], err: 0 });
  const s = stats.get(name);
  s.t.push(ms);
  if (!ok) s.err++;
}
async function get(name, path) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'Accept-Encoding': 'gzip' } });
    const body = await r.text();
    rec(name, performance.now() - t0, r.ok);
    return r.ok ? body : null;
  } catch {
    rec(name, performance.now() - t0, false);
    return null;
  }
}

let running = true;
const users = [];
function user(k, mix) {
  const city = k % 2 === 1; // metà zoomati su una città
  const planner = city && k % 3 === 1;
  const loops = [];
  // Mappa: treni + stato ogni 15 s (come app.js)
  loops.push((async () => {
    await sleep(Math.random() * 15000);
    while (running) {
      await get('treni', '/api/trains');
      await get('stato', '/api/status');
      await sleep(15000);
    }
  })());
  loops.push((async () => {
    await sleep(Math.random() * 60000);
    while (running) {
      await get('notizie', city ? '/api/news?bbox=12.45,41.86,12.55,41.93&zoom=13' : '/api/news?bbox=6,36,19,47&zoom=5.4');
      await sleep(60000);
    }
  })());
  if (city) loops.push((async () => {
    await sleep(Math.random() * 20000);
    while (running) {
      const [la, lo] = pick(ROMA);
      await get('bus_metro', `/api/transit?bbox=${lo - 0.03},${la - 0.02},${lo + 0.03},${la + 0.02}`);
      if (Math.random() < 0.3) await get('fermate', `/api/stops?bbox=${lo - 0.004},${la - 0.003},${lo + 0.004},${la + 0.003}`);
      await sleep(20000);
    }
  })());
  if (planner || mix) loops.push((async () => {
    await sleep(Math.random() * (mix ? 30000 : 90000));
    let n = 0;
    while (running) {
      const useMilano = mix && n++ % 2 === 1;
      const P = useMilano ? MILANO : ROMA;
      const a = pick(P);
      let b = pick(P);
      while (b === a) b = pick(P);
      const w = pick(WORDS);
      await get('cerca_indirizzo', `/api/geocode?q=${encodeURIComponent(w.slice(0, 4))}&near=${a[0]},${a[1]}`);
      await get('cerca_indirizzo', `/api/geocode?q=${encodeURIComponent(w)}&near=${a[0]},${a[1]}`);
      await get(useMilano ? 'percorso_milano' : 'percorso_roma', `/api/plan?from=${a[0]},${a[1]}&to=${b[0]},${b[1]}&time=${Date.now()}`);
      await sleep((mix ? 60000 : 180000) * (0.7 + Math.random() * 0.6));
    }
  })());
  return loops;
}

const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');

async function serverStatus() {
  try {
    const s = JSON.parse(await (await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(TIMEOUT) })).text());
    return s;
  } catch {
    return null;
  }
}

const st0 = await serverStatus();
say(`# Prova di carico "${LABEL}" — ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
say(`Server: ${BASE}`);
say(`Prima della prova: treni seguiti ${st0?.viaggiatreno?.seguiti ?? '?'} (visibili ${st0?.viaggiatreno?.visibili ?? '?'}), CPU ${st0?.cpu?.percentoUltimoMinuto ?? '?'}% , memoria ${st0?.memoriaMB?.rss ?? '?'} MB`);
say('');

async function step(n, mix = false) {
  stats = new Map();
  running = true;
  const loops = [];
  for (let k = 0; k < n; k++) loops.push(...user(k, mix));
  await sleep(STEP_MS);
  running = false;
  const s = await serverStatus();
  const rows = [...stats].map(([name, v]) => `  ${name.padEnd(16)} n=${String(v.t.length).padStart(4)}  mediana ${f(pct(v.t, 50)).padStart(7)}  95% ${f(pct(v.t, 95)).padStart(7)}  max ${f(Math.max(...v.t)).padStart(7)}  errori ${v.err}`);
  say(`## ${mix ? `Misto Roma/Milano, ${n} utenti che cercano percorsi` : `${n} utenti`} — CPU server ${s?.cpu?.percentoUltimoMinuto ?? '?'}% (quota piano gratuito ≈ 10%), blocco max ${s?.cpu?.bloccoMsMax ?? '?'} ms, memoria ${s?.memoriaMB?.rss ?? '?'} MB, treni ${s?.viaggiatreno?.visibili ?? '?'}`);
  rows.forEach(say);
  const tr = stats.get('treni');
  const all = [...stats.values()];
  const errRate = all.reduce((a, v) => a + v.err, 0) / Math.max(1, all.reduce((a, v) => a + v.t.length, 0));
  say('');
  await Promise.race([Promise.all(loops), sleep(TIMEOUT + 2000)]);
  // Se la mappa impiega più di 8 s al 95% o gli errori superano il 10% il sito è già inutilizzabile: stop.
  return !(pct(tr?.t || [], 95) > 8000 || errRate > 0.1 || !s);
}

for (const n of STEPS) {
  const ok = await step(n);
  if (!ok) {
    say(`Fermata qui: con ${n} utenti il sito non è più usabile.`);
    break;
  }
  await sleep(15000); // respiro tra un gradino e l'altro
}
await sleep(15000);
await step(Number(process.env.MIX || 6), true);

const dir = process.env.OUT_DIR || `${process.env.HOME}/Library/Logs/treni-carico`;
fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${LABEL}.txt`;
fs.writeFileSync(file, out.join('\n') + '\n');
console.log('Risultati in', file);
process.exit(0);
