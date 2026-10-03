// Prepara gli orari di bus/tram/metro già durante la costruzione dell'immagine Docker.
// Sul server gratuito (0,1 CPU) la stessa preparazione richiede minuti e blocca tutto il resto:
// fatta qui, al primo avvio il navigatore deve solo leggere i file pronti.
// Se un download non riesce la costruzione prosegue: il server li preparerà da solo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GtfsStatic } from '../src/gtfs-static.js';
import { GtfsNetwork } from '../src/planner/gtfs-net.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'feeds.json'), 'utf8'));
const feeds = (Array.isArray(conf) ? conf : conf.feeds).filter((f) => f.static);

for (const feed of feeds) {
  const t0 = Date.now();
  try {
    const statics = new GtfsStatic({ dataDir, feed });
    await statics.ensureFiles();
    const net = new GtfsNetwork({ dataDir, feed, statics });
    await net.ensureStops();
    console.log(`prebuild ${feed.id}: pronto in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e) {
    console.log(`prebuild ${feed.id}: saltato (${e.message})`);
  }
}
