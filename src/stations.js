// Anagrafica stazioni RFI con coordinate, scaricata una volta da ViaggiaTreno
// e salvata in data/stations.json (si riaggiorna ogni 30 giorni).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout, normName, log } from './util.js';

const BASE = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const MAX_AGE = 30 * 24 * 3600 * 1000;

export async function loadStations(dataDir) {
  const file = path.join(dataDir, 'stations.json');
  let list = null;
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < MAX_AGE) {
      list = JSON.parse(await fs.readFile(file, 'utf8'));
    }
  } catch {}

  if (!list) {
    log('Scarico anagrafica stazioni da ViaggiaTreno (una tantum)…');
    const byCode = new Map();
    for (let reg = 1; reg <= 22; reg++) {
      try {
        const r = await fetchWithTimeout(`${BASE}/elencoStazioni/${reg}`);
        const arr = await r.json();
        for (const s of arr) {
          if (!s.lat || !s.lon || byCode.has(s.codiceStazione)) continue;
          const zooms = (s.dettZoomStaz || []).map((d) => d.zoomStartRange);
          byCode.set(s.codiceStazione, {
            code: s.codiceStazione,
            name: s.localita?.nomeLungo || s.codiceStazione,
            lat: s.lat,
            lon: s.lon,
            tipo: s.tipoStazione,
            zoom: zooms.length ? Math.min(...zooms) : 99,
          });
        }
      } catch (e) {
        log(`  regione ${reg}: errore ${e.message}`);
      }
    }
    list = [...byCode.values()];
    if (list.length < 1000) throw new Error(`Anagrafica incompleta (${list.length} stazioni)`);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(list));
    log(`  ${list.length} stazioni salvate`);
  }

  const byCode = new Map(list.map((s) => [s.code, s]));
  // Indice per nome: a parità di nome vince la stazione più importante.
  const byName = new Map();
  for (const s of [...list].sort((a, b) => a.zoom - b.zoom)) {
    const k = normName(s.name);
    if (!byName.has(k)) byName.set(k, s);
  }
  return { list, byCode, byName };
}

/** Stazioni usate per scoprire i treni: quelle visibili a zoom basso sulla mappa RFI. */
export function hubStations(st) {
  return st.list.filter((s) => s.zoom <= 9 || s.tipo <= 2);
}
