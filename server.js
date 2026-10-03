// Treni Live Italia — server locale.
// Avvio: `node server.js`, poi apri http://localhost:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadStations } from './src/stations.js';
import { ViaggiaTrenoTracker } from './src/viaggiatreno.js';
import { ItaloTracker } from './src/italo.js';
import { TransitFeeds } from './src/transit.js';
import { RailNetwork } from './src/rail.js';
import { trainRoute } from './src/routes.js';
import { Planner } from './src/planner/index.js';
import { fixStations } from './src/station-fix.js';
import { log, activity } from './src/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
rail.start();
// Appena i binari sono pronti, corregge le stazioni con coordinate sbagliate (lontane dai binari).
const railWait = setInterval(() => {
  if (!rail.ready) return;
  clearInterval(railWait);
  fixStations({ dataDir: path.join(ROOT, 'data'), stations, rail }).catch((e) => log('Stazioni: correzione non riuscita:', e.message));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
        binari: rail.stats(),
        feeds: transit.list(),
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
    if (url.pathname === '/api/geocode') {
      return send(req, res, 200, await planner.geocode(url.searchParams.get('q'), ll(url.searchParams.get('near'))));
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
