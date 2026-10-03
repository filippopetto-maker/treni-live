// Treni Live Italia — server locale.
// Avvio: `node server.js`, poi apri http://localhost:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadStations } from './src/stations.js';
import { ViaggiaTrenoTracker } from './src/viaggiatreno.js';
import { ItaloTracker } from './src/italo.js';
import { TransitFeeds } from './src/transit.js';
import { RailNetwork } from './src/rail.js';
import { trainRoute } from './src/routes.js';
import { Planner } from './src/planner/index.js';
import { fixStations } from './src/station-fix.js';
import { ScheduledMetro } from './src/scheduled.js';
import { MetroStatus } from './src/metro-status.js';
import { NewsService } from './src/news.js';
import { AstralNet } from './src/astral.js';
import { WebPush } from './src/push.js';
import { GuideService, liveForLeg } from './src/guide.js';
import { log, activity } from './src/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Diagnostica per server piccoli: quanta CPU usa il processo e quanto resta bloccato il ciclo eventi.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
const cpuStat = { at: Date.now(), usage: process.cpuUsage(), pct: 0, lagP99: 0, lagMax: 0 };
setInterval(() => {
  const now = Date.now();
  const u = process.cpuUsage(cpuStat.usage);
  cpuStat.pct = Math.round(((u.user + u.system) / 1000 / (now - cpuStat.at)) * 100);
  cpuStat.lagP99 = Math.round(loopDelay.percentile(99) / 1e6);
  cpuStat.lagMax = Math.round(loopDelay.max / 1e6);
  loopDelay.reset();
  cpuStat.at = now;
  cpuStat.usage = process.cpuUsage();
}, 60_000).unref();

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const stations = await loadStations(path.join(ROOT, 'data'));
const rail = new RailNetwork({ dataDir: path.join(ROOT, 'data'), stations });
const vt = new ViaggiaTrenoTracker({
  stations,
  rail,
  rps: Number(process.env.VT_RPS) || 14,
  refreshMs: (Number(process.env.VT_REFRESH_S) || 150) * 1000,
});
const italo = new ItaloTracker({ stations, rail });
const transit = new TransitFeeds(path.join(ROOT, 'feeds.json'), path.join(ROOT, 'data'));
await transit.load();
const planner = new Planner({ dataDir: path.join(ROOT, 'data'), transit, stations, trackers: [vt, italo], rail });
const metroStatus = new MetroStatus();
planner.metroStatus = metroStatus;
transit.metro = new ScheduledMetro({ planner, status: metroStatus });
const astral = new AstralNet({ dataDir: path.join(ROOT, 'data'), rail });
transit.astral = astral;
planner.astral = astral;
const news = new NewsService({ astral,  stations, trackers: [vt, italo], metroStatus, cityFeeds: () => transit.feeds.filter((f) => f.static) });
rail.start();
// Appena i binari sono pronti, corregge le stazioni con coordinate sbagliate (lontane dai binari).
const railWait = setInterval(() => {
  if (!rail.ready) return;
  clearInterval(railWait);
  fixStations({ dataDir: path.join(ROOT, 'data'), stations, rail })
    .catch((e) => log('Stazioni: correzione non riuscita:', e.message))
    .then(() => astral.init())
    .catch((e) => log('ASTRAL non disponibile:', e.message));
}, 2000);
vt.start();
italo.start();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function send(req, res, status, body, type = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(data));
  } else {
    res.writeHead(status, headers);
    res.end(data);
  }
}

// Password opzionale (variabile TRENI_PASSWORD): il browser la chiede una volta e la ricorda.
// Il nome utente è indifferente.
const PASSWORD = process.env.TRENI_PASSWORD || '';
function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function findTrain(id) {
  const [src, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  return src === 'vt' ? vt.trains.get(key) : src === 'italo' ? italo.trains.get(key) : null;
}

// Guida passo passo: notifiche push che seguono il mezzo.
const webPush = new WebPush({ dataDir: path.join(ROOT, 'data') });
const guide = new GuideService({ push: webPush, transit, findTrain });

/** Corpo JSON di una richiesta POST (massimo 1 MB). */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('richiesta troppo grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON non valido'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Controllo di salute per l'hosting e per il "tienilo sveglio": niente password, nessun dato.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Treni Live", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Password richiesta');
  }
  try {
    if (url.pathname === '/api/trains') {
      activity.touch();
      return send(req, res, 200, { now: Date.now(), trains: [...vt.visible(), ...italo.visible()] });
    }
    if (url.pathname === '/api/train') {
      const tr = findTrain(url.searchParams.get('id') || '');
      if (!tr) return send(req, res, 404, { error: 'treno non trovato' });
      return send(req, res, 200, {
        id: tr.id,
        label: tr.label,
        op: tr.op,
        orig: tr.orig,
        dest: tr.dest,
        delay: tr.delay,
        det: tr.det,
        detT: tr.detT,
        note: tr.note,
        stops: tr.stops || [],
        upd: tr.upd,
      });
    }
    if (url.pathname === '/api/status') {
      return send(req, res, 200, {
        modalita: activity.mode,
        viaggiatreno: vt.stats(),
        italo: italo.stats(),
        cpu: { percentoUltimoMinuto: cpuStat.pct, bloccoMsP99: cpuStat.lagP99, bloccoMsMax: cpuStat.lagMax },
        memoriaMB: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1e6)])),
        binari: rail.stats(),
        corseFantasma: Object.fromEntries([...(planner.ghostCache || new Map())].map(([k, v]) => [k, v.set.size])),
        feeds: transit.list(),
        guida: guide.stats(),
      });
    }
    if (url.pathname === '/api/paths') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 300);
      return send(req, res, 200, rail.get(ids));
    }
    if (url.pathname === '/api/train/route') {
      const tr = findTrain(url.searchParams.get('id') || '');
      const r = tr && trainRoute(tr, rail, stations);
      return r ? send(req, res, 200, r) : send(req, res, 404, { error: 'percorso non disponibile' });
    }
    if (url.pathname === '/api/vehicle/route') {
      const p = url.searchParams;
      const r = transit.vehicleRoute(p.get('feed'), p.get('trip'), p.get('route'));
      return r ? send(req, res, 200, r) : send(req, res, 404, { error: 'percorso non disponibile' });
    }
    if (url.pathname === '/api/debug') {
      // Treni seguiti ma non disegnati, con il motivo: utile per migliorare la copertura.
      const out = [...vt.trains.values()]
        .filter((t) => !(t.seg?.status === 'running' || t.seg?.status === 'station'))
        .map((t) => ({ key: t.key, label: t.label, upd: !!t.upd, seg: t.seg, stops: t.stops?.length }));
      return send(req, res, 200, out);
    }
    if (url.pathname === '/api/feeds') {
      return send(req, res, 200, transit.list());
    }
    // ---------- navigatore ----------
    const ll = (s) => {
      const [lat, lon] = (s || '').split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    };
    if (url.pathname === '/api/plan') {
      activity.touch();
      const p = url.searchParams;
      const from = ll(p.get('from'));
      const to = ll(p.get('to'));
      if (!from || !to) return send(req, res, 400, { error: 'partenza o arrivo mancante' });
      from.name = p.get('fromName') || '';
      to.name = p.get('toName') || '';
      const time = Number(p.get('time')) || Date.now();
      return send(req, res, 200, await planner.plan(from, to, time));
    }
    if (url.pathname === '/api/stops') {
      const bb = (url.searchParams.get('bbox') || '').split(',').map(Number);
      if (bb.length !== 4 || bb.some(Number.isNaN)) return send(req, res, 400, { error: 'bbox non valido' });
      return send(req, res, 200, await planner.stopsInBbox(bb));
    }
    if (url.pathname === '/api/stop/arrivals') {
      activity.touch();
      const r = await planner.arrivals(url.searchParams.get('id') || '');
      return r ? send(req, res, 200, r) : send(req, res, 404, { error: 'fermata non trovata' });
    }
    if (url.pathname === '/api/news') {
      const bb = (url.searchParams.get('bbox') || '').split(',').map(Number);
      const zoom = Number(url.searchParams.get('zoom')) || 5;
      return send(req, res, 200, await news.get(bb.length === 4 && !bb.some(Number.isNaN) ? bb : null, zoom));
    }
    if (url.pathname === '/api/geocode') {
      return send(req, res, 200, await planner.geocode(url.searchParams.get('q'), ll(url.searchParams.get('near'))));
    }

    if (url.pathname === '/api/push/key') {
      return send(req, res, 200, { key: webPush.publicKey });
    }
    if (url.pathname === '/api/guide/start' && req.method === 'POST') {
      activity.touch();
      try {
        return send(req, res, 200, await guide.start(await readJson(req)));
      } catch (e) {
        return send(req, res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/api/guide/stop' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({}));
      return send(req, res, 200, { ok: guide.stop(String(b.id || '')) });
    }
    if (url.pathname === '/api/guide/live') {
      activity.touch();
      const q = url.searchParams;
      const leg = { feed: q.get('feed') || undefined, tripId: q.get('trip') || undefined, trainId: q.get('train') || undefined };
      return send(req, res, 200, await liveForLeg(leg, { transit, findTrain }));
    }

    if (url.pathname === '/api/transit') {
      const bb = (url.searchParams.get('bbox') || '').split(',').map(Number);
      if (bb.length !== 4 || bb.some(Number.isNaN)) return send(req, res, 400, { error: 'bbox non valido' });
      return send(req, res, 200, await transit.inBbox(bb));
    }

    // File statici da public/
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(req, res, 403, 'vietato', 'text/plain');
    const body = await fs.readFile(file).catch(() => null);
    if (!body) return send(req, res, 404, 'non trovato', 'text/plain');
    return send(req, res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    log('Errore richiesta', url.pathname, e.message);
    return send(req, res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => log(`Mappa pronta su http://localhost:${PORT}`));

// Salva la cache dei percorsi quando il server viene fermato (Ctrl+C).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await rail.savePaths();
    process.exit(0);
  });
}
