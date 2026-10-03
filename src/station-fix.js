// Corregge le coordinate sbagliate dell'anagrafica ViaggiaTreno.
//
// Alcune stazioni hanno coordinate lontane dai binari (es. Reggio Emilia AV Mediopadana
// è spostata di ~9 km): il treno viene disegnato nel posto sbagliato e il percorso sui binari
// non si trova, quindi resta una linea retta. Per queste stazioni si cerca su OpenStreetMap
// una stazione con lo stesso nome nei dintorni e si usano le sue coordinate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout, normName, sleep, log } from './util.js';

const SEARCH_KM = 40;
const M_LAT = 110_540;
const M_LON = 111_320 * Math.cos((42 * Math.PI) / 180);
const dist = (a, b) => Math.hypot((a.lon - b.lon) * M_LON, (a.lat - b.lat) * M_LAT);

// Abbreviazioni frequenti nei nomi RFI.
const EXPAND = [
  [/\bC LE\b/g, 'CENTRALE'],
  [/\bCLE\b/g, 'CENTRALE'],
  [/\bP TA\b/g, 'PORTA'],
  [/\bP ZA\b/g, 'PIAZZA'],
  [/\bS M N\b/g, 'SANTA MARIA NOVELLA'],
  [/\bSTAZ\b/g, ''],
];
const tokens = (name) => {
  let n = normName(name);
  for (const [re, s] of EXPAND) n = n.replace(re, s);
  return n.split(' ').filter((t) => t && !['DI', 'DEL', 'DELLA', 'DE', 'D', 'STAZIONE', 'FS'].includes(t));
};

/** Somiglianza tra nomi 0…1: parole uguali, o una abbreviazione dell'altra ("S" ~ "SANTA"). */
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const x of A) {
    const j = B.findIndex((y, k) => !used.has(k) && (x === y || (x.length >= 1 && y.startsWith(x)) || (y.length >= 1 && x.startsWith(y) && y.length >= 3)));
    if (j >= 0) {
      used.add(j);
      hit++;
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * Candidati OSM per una stazione, cercati per nome con Photon (geocoder di OpenStreetMap)
 * limitato agli oggetti ferroviari. I risultati restano in cache su disco.
 */
async function candidates(s, cache) {
  if (cache[s.code]) return cache[s.code];
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', s.name);
  u.searchParams.set('osm_tag', 'railway');
  u.searchParams.set('lat', s.lat);
  u.searchParams.set('lon', s.lon);
  u.searchParams.set('limit', '5');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(u, {}, 15_000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      cache[s.code] = (j.features || [])
        .filter((f) => f.properties.name)
        .map((f) => ({ name: f.properties.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
      return cache[s.code];
    } catch {
      await sleep(2000);
    }
  }
  return null; // riprovo al prossimo avvio
}

/**
 * Sposta sulle coordinate OSM le stazioni RFI senza binari vicini.
 * Modifica gli oggetti stazione in place (li usano tracker, binari e navigatore).
 */
export async function fixStations({ dataDir, stations, rail }) {
  const bad = stations.list.filter((s) => !rail.nearest(s.lat, s.lon, 700, 1).length);
  if (!bad.length) return [];
  const cacheFile = path.join(dataDir, 'osm-stations.json');
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}
  const fixes = [];
  for (const s of bad) {
    const fresh = !cache[s.code];
    const osm = await candidates(s, cache);
    if (fresh) await sleep(300); // gentilezza verso il servizio gratuito
    if (!osm) continue;
    let best = null;
    for (const o of osm) {
      const d = dist(s, o);
      if (d > SEARCH_KM * 1000) continue;
      const sim = similarity(s.name, o.name);
      if (sim < 0.75) continue;
      if (!rail.nearest(o.lat, o.lon, 300, 1).length) continue;
      if (!best || sim > best.sim || (sim === best.sim && d < best.d)) best = { o, sim, d };
    }
    if (!best) continue;
    fixes.push({ code: s.code, name: s.name, osm: best.o.name, km: Math.round(best.d / 100) / 10, from: [s.lat, s.lon], to: [best.o.lat, best.o.lon] });
    s.lat = best.o.lat;
    s.lon = best.o.lon;
    // I percorsi "non trovati" che toccano questa stazione vanno ricalcolati.
    for (const [k, v] of rail.paths) if (!v && k.split('>').includes(s.code)) rail.paths.delete(k);
  }
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  await fs.writeFile(path.join(dataDir, 'station-fixes.json'), JSON.stringify(fixes, null, 1));
  log(`Stazioni: ${bad.length} senza binari vicini, ${fixes.length} corrette con OpenStreetMap (dettagli in data/station-fixes.json)`);
  return fixes;
}
