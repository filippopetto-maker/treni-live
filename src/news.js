// Notiziario della mobilità per la barra che scorre in alto a destra.
//
// Fonti ufficiali:
//  - Trenitalia/RFI: infomobilità di ViaggiaTreno (eventi in corso, treni Frecce/IC con ritardi
//    sopra i 60', informazioni sul trasporto regionale)
//  - Italo: pagina "Italo Informa" (news sulla circolazione)
//  - Roma Mobilità (notizie di infomobilità) e ATM (stato metro) quando si guarda una città
// Più notizie calcolate dal software: tratte con molti treni in ritardo.

import { fetchWithTimeout, normName, distKm, log } from './util.js';
import { classify } from './metro-status.js';

const VT_URL = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/infomobilitaRSS/false';
const ITALO_URL = 'https://italoinviaggio.italotreno.com/it/italo-informa';
const ROMA_URL = 'https://romamobilita.it/wp-json/wp/v2/infomobilita?per_page=20&_fields=date,title';
const REFRESH_MS = 2 * 60_000;
const DELAY_MIN = 15; // "in ritardo" = oltre 15 minuti
const CLUSTER_MIN = 3; // da quanti treni in ritardo su una tratta vale la pena dirlo

const decode = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&agrave;/g, 'à').replace(/&egrave;/g, 'è').replace(/&eacute;/g, 'é').replace(/&igrave;/g, 'ì').replace(/&ograve;/g, 'ò').replace(/&ugrave;/g, 'ù')
    .replace(/\s+/g, ' ')
    .trim();
const short = (s, n = 190) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

// Grandi direttrici per raggruppare i ritardi: coppie di città (stazione di riferimento).
const NODES = {
  Torino: 'TORINO PORTA NUOVA', Milano: 'MILANO CENTRALE', Brescia: 'BRESCIA', Verona: 'VERONA PORTA NUOVA',
  Padova: 'PADOVA', Venezia: 'VENEZIA S LUCIA', Trieste: 'TRIESTE CENTRALE', Udine: 'UDINE', Trento: 'TRENTO',
  Bolzano: 'BOLZANO', Brennero: 'BRENNERO', Bologna: 'BOLOGNA CENTRALE', Firenze: 'FIRENZE SANTA MARIA NOVELLA',
  Roma: 'ROMA TERMINI', Napoli: 'NAPOLI CENTRALE', Salerno: 'SALERNO', Paola: 'PAOLA', 'Reggio Calabria': 'REGGIO DI CALABRIA CENTRALE',
  Messina: 'MESSINA CENTRALE', Palermo: 'PALERMO CENTRALE', Catania: 'CATANIA CENTRALE', Siracusa: 'SIRACUSA',
  Genova: 'GENOVA PIAZZA PRINCIPE', 'La Spezia': 'LA SPEZIA CENTRALE', Pisa: 'PISA CENTRALE', Grosseto: 'GROSSETO',
  Rimini: 'RIMINI', Ancona: 'ANCONA', Pescara: 'PESCARA', Foggia: 'FOGGIA', Bari: 'BARI CENTRALE', Lecce: 'LECCE',
  Taranto: 'TARANTO', Caserta: 'CASERTA', Benevento: 'BENEVENTO', Foligno: 'FOLIGNO', Sulmona: 'SULMONA',
  Cagliari: 'CAGLIARI', Sassari: 'SASSARI', Potenza: 'POTENZA CENTRALE',
};
const EDGES = [
  ['Torino', 'Milano'], ['Milano', 'Brescia'], ['Brescia', 'Verona'], ['Verona', 'Padova'], ['Padova', 'Venezia'],
  ['Venezia', 'Trieste'], ['Venezia', 'Udine'], ['Udine', 'Trieste'], ['Verona', 'Trento'], ['Trento', 'Bolzano'],
  ['Bolzano', 'Brennero'], ['Milano', 'Bologna'], ['Verona', 'Bologna'], ['Padova', 'Bologna'], ['Bologna', 'Firenze'],
  ['Firenze', 'Roma'], ['Roma', 'Napoli'], ['Napoli', 'Salerno'], ['Salerno', 'Paola'], ['Paola', 'Reggio Calabria'],
  ['Salerno', 'Potenza'], ['Potenza', 'Taranto'], ['Messina', 'Palermo'], ['Messina', 'Catania'], ['Catania', 'Siracusa'],
  ['Palermo', 'Catania'], ['Milano', 'Genova'], ['Torino', 'Genova'], ['Genova', 'La Spezia'], ['La Spezia', 'Pisa'],
  ['Pisa', 'Firenze'], ['Pisa', 'Grosseto'], ['Grosseto', 'Roma'], ['Bologna', 'Rimini'], ['Rimini', 'Ancona'],
  ['Ancona', 'Pescara'], ['Pescara', 'Foggia'], ['Foggia', 'Bari'], ['Bari', 'Lecce'], ['Bari', 'Taranto'],
  ['Roma', 'Sulmona'], ['Sulmona', 'Pescara'], ['Napoli', 'Caserta'], ['Caserta', 'Benevento'], ['Benevento', 'Foggia'],
  ['Roma', 'Foligno'], ['Foligno', 'Ancona'], ['Cagliari', 'Sassari'],
];

/** Notizie di ViaggiaTreno (HTML a fisarmonica) → [{ src, text, level }]. */
export function parseVT(html) {
  const out = [];
  let regular = false;
  for (const li of html.match(/<li class="editModeCollapsibleElement">[\s\S]*?<\/li>/g) || []) {
    const title = decode(li.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const body = decode(li.match(/class="info-text[^"]*">([\s\S]*?)<\/div>/)?.[1]);
    if (!title) continue;
    if (/^CIRCOLAZIONE REGOLARE$/i.test(title)) {
      regular = true;
      continue;
    }
    if (/^INFOTRENI/i.test(title)) {
      // "I treni indicati viaggiano con un ritardo superiore a 60 minuti…" + un treno per frase.
      const parts = body.split(/(?=\b(?:Frecciarossa|Frecciargento|Frecciabianca|Intercity Notte|Intercity|Eurocity|Euronight|EuroCity|Railjet|Italo)\s+\d{2,5}\b)/);
      for (const p of parts.slice(1)) out.push({ src: 'Trenitalia', text: short(p.trim(), 170), level: 'warn' });
      continue;
    }
    if (/TRASPORTO REGIONALE/i.test(title)) {
      for (const p of body.split(/(?=REGIONE [A-Z])/).filter((x) => x.startsWith('REGIONE'))) {
        const t = p.replace(/^REGIONE ([A-Z' ]+?)\s+(?=Lin|Tra|Da|Dal|Per|Fino|Sospes)/, (m, r) => `${r[0]}${r.slice(1).toLowerCase()}: `);
        out.push({ src: 'Trenitalia', text: short(t, 170), level: 'info', regional: true });
      }
      continue;
    }
    out.push({ src: 'RFI/Trenitalia', text: short(title, 200), level: classify(title) });
  }
  return { items: out, regular };
}

/** Pagina "Italo Informa": vuota se non ci sono notizie (componente "italo-informa-empty"). */
export function parseItalo(html) {
  const sec = html.match(/<!-- ITALO INFORMA -->([\s\S]*?)<\/section>/)?.[1] || '';
  if (!sec || /italo-informa-empty/.test(sec)) return [];
  const items = [];
  // Titoli e testi delle notizie (struttura a componenti: si prendono i testi "title"/"text").
  for (const m of sec.matchAll(/data-ntv-name="(?:title|text|description|news-title)"[^>]*>([\s\S]*?)<\/span>/g)) {
    const t = decode(m[1]);
    if (t.length > 20) items.push({ src: 'Italo', text: short(t, 190), level: classify(t) });
  }
  if (!items.length) {
    for (const h of sec.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
      const t = decode(h[1]);
      if (t.length > 15) items.push({ src: 'Italo', text: short(t, 190), level: classify(t) });
    }
  }
  return items;
}

export class NewsService {
  constructor({ stations, trackers, metroStatus, cityFeeds }) {
    this.st = stations;
    this.trackers = trackers;
    this.metroStatus = metroStatus;
    this.cityFeeds = cityFeeds; // () => feed urbani con bbox
    this.vt = { items: [], regular: false };
    this.italo = [];
    this.roma = [];
    this.at = 0;
    this.errors = {};
    this.nodes = {};
    for (const [label, name] of Object.entries(NODES)) {
      const n = normName(name);
      const s = this.st.list.find((x) => normName(x.name) === n) || this.st.list.find((x) => normName(x.name).startsWith(n));
      if (s) this.nodes[label] = s;
    }
  }

  async refresh() {
    if (Date.now() - this.at < REFRESH_MS) return;
    if (this.inflight) return this.inflight;
    const get = async (key, url, fn) => {
      try {
        const res = await fetchWithTimeout(url, {}, 15_000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        fn(await res.text());
        delete this.errors[key];
      } catch (e) {
        this.errors[key] = e.message;
        log(`Notizie ${key} non disponibili: ${e.message}`);
      }
    };
    this.inflight = Promise.all([
      get('trenitalia', VT_URL, (t) => (this.vt = parseVT(t))),
      get('italo', ITALO_URL, (t) => (this.italo = parseItalo(t))),
      get('roma', ROMA_URL, (t) => {
        this.roma = JSON.parse(t).map((p) => ({ at: new Date(p.date).getTime(), title: decode(p.title?.rendered) }));
      }),
      this.metroStatus?.refresh(),
    ]).finally(() => {
      this.at = Date.now();
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Treni in viaggio con posizione stimata adesso: [{ label, delay, lat, lon }]. */
  positions() {
    const now = Date.now();
    const out = [];
    for (const tk of this.trackers) {
      for (const tr of tk.trains.values()) {
        const s = tr.seg;
        if (!s || (s.status !== 'running' && s.status !== 'station') || !s.from) continue;
        const f = s.to[2] > s.from[2] ? Math.max(0, Math.min(1, (now - s.from[2]) / (s.to[2] - s.from[2]))) : 0;
        out.push({
          label: tr.label,
          delay: tr.delay || 0,
          lon: s.from[0] + (s.to[0] - s.from[0]) * f,
          lat: s.from[1] + (s.to[1] - s.from[1]) * f,
        });
      }
    }
    return out;
  }

  /** Direttrice più vicina a un punto (entro una fascia attorno alla linea), es. "Roma–Firenze". */
  corridorOf(p) {
    const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const ky = 110.54;
    let best = null;
    for (const [a, b] of EDGES) {
      const A = this.nodes[a];
      const B = this.nodes[b];
      if (!A || !B) continue;
      const ax = A.lon * kx, ay = A.lat * ky, bx = B.lon * kx, by = B.lat * ky, px = p.lon * kx, py = p.lat * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      const tol = 8 + 0.15 * Math.sqrt(len2);
      if (d <= tol && (!best || d < best.d)) best = { d, name: `${a}–${b}` };
    }
    return best?.name || null;
  }

  /** Raggruppa i treni in ritardo per direttrice (o nella zona, se si guarda una zona). */
  delayItems(bb) {
    const late = this.positions().filter((t) => t.delay >= DELAY_MIN);
    const items = [];
    if (bb) {
      const inBox = late.filter((t) => t.lon >= bb[0] && t.lon <= bb[2] && t.lat >= bb[1] && t.lat <= bb[3]);
      if (inBox.length) {
        const worst = inBox.reduce((a, b) => (b.delay > a.delay ? b : a));
        items.push({
          src: 'calcolato',
          level: inBox.length >= CLUSTER_MIN ? 'warn' : 'info',
          text: `${inBox.length} ${inBox.length === 1 ? 'treno' : 'treni'} in ritardo di oltre ${DELAY_MIN}' in questa zona (il più in ritardo: ${worst.label} +${worst.delay}')`,
        });
      }
      return items;
    }
    const groups = new Map();
    for (const t of late) {
      const c = this.corridorOf(t);
      if (!c) continue;
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(t);
    }
    for (const [c, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      if (list.length < CLUSTER_MIN) continue;
      const max = Math.max(...list.map((t) => t.delay));
      items.push({
        src: 'calcolato',
        level: list.length >= 6 || max >= 60 ? 'stop' : 'warn',
        text: `${list.length} treni in ritardo di oltre ${DELAY_MIN}' sulla ${c} (fino a +${max}')`,
      });
    }
    return items;
  }

  /** Nomi di località nel riquadro, per capire quali notizie riguardano la zona guardata. */
  placesIn(bb) {
    const toks = new Set();
    for (const s of this.st.list) {
      if (s.lon < bb[0] || s.lon > bb[2] || s.lat < bb[1] || s.lat > bb[3]) continue;
      const n = normName(s.name);
      if (n.length >= 4) toks.add(n);
      const first = n.split(' ')[0];
      if ((s.zoom <= 9 || s.tipo <= 2) && first.length >= 4) toks.add(first);
    }
    return toks;
  }

  /**
   * Notizie per la barra: tutta Italia se la mappa è lontana, altrimenti solo la zona
   * (e la città, con metro e mezzi urbani, se si è zoomato su Roma o Milano).
   */
  async get(bb, zoom) {
    const p = this.refresh();
    if (!this.at) await p;
    const national = !bb || zoom < 7.5;
    const center = bb && [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    let scope = 'Italia';
    let city = null;
    if (!national) {
      const f = zoom >= 10 && this.cityFeeds().find((x) => center[0] >= x.bbox[0] && center[0] <= x.bbox[2] && center[1] >= x.bbox[1] && center[1] <= x.bbox[3]);
      city = f?.id || null;
      if (city) scope = city[0].toUpperCase() + city.slice(1);
      else {
        let best = null;
        for (const [label, s] of Object.entries(this.nodes)) {
          const d = distKm({ lat: center[1], lon: center[0] }, s);
          if (!best || d < best.d) best = { d, label };
        }
        scope = best && best.d < 60 ? `zona di ${best.label}` : 'questa zona';
      }
    }

    let rail = [...this.vt.items, ...this.italo];
    if (!national) {
      const toks = this.placesIn(bb);
      rail = rail.filter((it) => {
        const t = ` ${normName(it.text)} `;
        for (const k of toks) if (t.includes(` ${k} `)) return true;
        return false;
      });
    }

    const urban = [];
    if (city === 'roma') {
      for (const p of this.roma) {
        if (Date.now() - p.at > 12 * 3600_000) continue;
        urban.push({ src: 'Roma Mobilità', text: short(p.title, 190), level: classify(p.title) });
      }
    }
    if (city === 'milano' && this.metroStatus) {
      const lines = this.metroStatus.status.milano || {};
      const bad = Object.entries(lines).filter(([, s]) => s.level !== 'ok');
      for (const [l, s] of bad) urban.push({ src: 'ATM', text: `Metro ${l}: ${s.text}`, level: s.level });
      if (this.metroStatus.messageMilano) urban.push({ src: 'ATM', text: short(this.metroStatus.messageMilano), level: 'info' });
      if (Object.keys(lines).length && !bad.length) urban.push({ src: 'ATM', text: 'Metro M1–M5: circolazione regolare', level: 'ok' });
    }

    const calc = this.delayItems(national ? null : bb);
    const ORDER = { stop: 0, warn: 1, station: 2, info: 3, ok: 4 };
    const items = [...urban, ...calc, ...rail].sort(
      (a, b) => (ORDER[a.level] ?? 3) + (a.regional ? 0.5 : 0) - ((ORDER[b.level] ?? 3) + (b.regional ? 0.5 : 0))
    );
    const problems = items.some((i) => i.level === 'stop' || i.level === 'warn' || i.src === 'calcolato');
    if (!problems) {
      items.unshift({
        src: national ? (this.vt.regular ? 'RFI' : 'calcolato') : 'calcolato',
        level: 'ok',
        text: national
          ? 'Traffico regolare su tutta la linea'
          : `Traffico ferroviario regolare nella ${scope.startsWith('zona') ? scope : scope === 'questa zona' ? 'zona' : 'zona di ' + scope}`,
      });
    }
    return { scope, city, items: items.slice(0, 40), at: this.at, errors: this.errors };
  }
}
