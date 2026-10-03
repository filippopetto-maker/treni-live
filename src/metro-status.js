// Stato delle linee metro, dalle fonti ufficiali pubbliche:
//  - Milano: riquadro "Stato Metro" sulla home di atm.it (M1–M5: "Regolare" o descrizione del problema)
//  - Roma: notizie di infomobilità di Roma Mobilità (API pubblica del sito), es.
//    "Metro C: servizio bus sostitutivi lungo la tratta Malatesta – Giardinetti", poi "servizio regolare".
// Serve a non disegnare treni "da orario" su linee o tratte ferme.

import { fetchWithTimeout, normName, log } from './util.js';

const REFRESH_MS = 2 * 60_000;
const ROMA_URL = 'https://romamobilita.it/wp-json/wp/v2/infomobilita?per_page=30&search=metro&_fields=date,title,content';
const ATM_URL = 'https://www.atm.it/it/Pagine/default.aspx';
const ROMA_MAX_AGE = 8 * 3600_000; // un avviso di Roma vale al massimo 8 ore, se non arriva il "regolare"
const MONTHS = 'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';

const strip = (h) =>
  String(h || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Livello del problema: ok, station (stazione chiusa: i treni passano), warn (rallentamenti),
 * stop (circolazione interrotta, sull'intera linea o su una tratta), info (avviso futuro o generico).
 */
export function classify(text) {
  const t = text.toLowerCase();
  if (/(?<!ir)regolar|riapert|riattivat|ripres|ripristinat|tornat[ao] (?:attiv|regolar)/.test(t)) return 'ok';
  // Avvisi per giorni futuri ("domenica 4 ottobre chiusa…"): solo informativi.
  if (new RegExp(`\\b\\d{1,2}\\s+(${MONTHS})\\b|\\b(domani|luned|marted|mercoled|gioved|venerd|sabato|domenica)`).test(t) && !/\boggi\b|in corso|al momento|attualmente/.test(t)) return 'info';
  if (/stazion[ei]\s+[^.;]{1,40}?\s+chius|chius[ae]\s+(?:la|le)\s+stazion|non effettua(?:no)? fermata|transit[ao] senza fermar/.test(t)) return 'station';
  if (/interrott|sospes|chius|bus sostitutiv|navett|non attiv|ferm[ao] /.test(t)) return 'stop';
  if (/rallent|ritard|limitat|irregolar|frequenz|guasto|disservizi/.test(t)) return 'warn';
  return 'info';
}

/** Estremi di una tratta interrotta: "tra X e Y", "tratta X – Y", "da X a Y". */
export function spanOf(text) {
  const m =
    text.match(/tratta\s+([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)\s*[–-]\s*([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)(?=\s+(?:nelle|in|per|e\s|dalle|fino)|[.,;)]|$)/) ||
    text.match(/\btra\s+(?:le stazioni (?:di\s+)?)?([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)\s+e\s+([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)(?=\s+(?:nelle|in|per|dalle|fino)|[.,;)]|$)/) ||
    text.match(/\bda\s+([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)\s+a\s+([A-ZÀ-Ü][\w'’°.À-ü ]{1,40}?)(?=\s+(?:nelle|in|per|dalle|fino)|[.,;)]|$)/);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

// Linee a cui si riferisce un titolo di Roma Mobilità ("Metro B", "linea metro A", "Metro B1").
function romaLines(title) {
  const out = new Set();
  for (const m of title.matchAll(/(?:metro|linea)\s*(?:metro\s*)?(B1|A|B|C)\b/gi)) {
    const l = m[1].toUpperCase();
    out.add(l);
    if (l === 'B') out.add('B1'); // la B1 è una diramazione della B
  }
  return [...out];
}

export class MetroStatus {
  constructor() {
    this.status = { roma: {}, milano: {} }; // città → linea → { level, text, at, span }
    this.at = 0;
    this.inflight = null;
    this.errors = {};
  }

  /** Aggiorna al massimo ogni 2 minuti, solo quando qualcuno guarda la metro. */
  async refresh() {
    if (Date.now() - this.at < REFRESH_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = Promise.all([this.roma(), this.milano()]).finally(() => {
      this.at = Date.now();
      this.inflight = null;
    });
    return this.inflight;
  }

  async roma() {
    try {
      const res = await fetchWithTimeout(ROMA_URL, {}, 15_000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const posts = await res.json();
      const lines = {};
      // Dal più recente: per ogni linea conta l'ultima notizia.
      for (const p of posts) {
        const title = strip(p.title?.rendered);
        const body = strip(p.content?.rendered);
        const at = new Date(p.date).getTime(); // ora italiana, interpretata come locale
        for (const l of romaLines(title)) {
          if (lines[l]) continue;
          const level = classify(title + '. ' + body);
          const fresh = Date.now() - at < ROMA_MAX_AGE;
          lines[l] = {
            level: fresh || level === 'info' ? level : 'ok',
            text: title,
            at,
            span: level === 'stop' ? spanOf(title + '. ' + body) : null,
            stale: !fresh,
          };
        }
      }
      for (const l of ['A', 'B', 'B1', 'C']) lines[l] ||= { level: 'ok', text: 'Nessun avviso', at: null };
      this.status.roma = lines;
      delete this.errors.roma;
    } catch (e) {
      this.errors.roma = e.message;
      log('Stato metro Roma non disponibile:', e.message);
    }
  }

  async milano() {
    try {
      const res = await fetchWithTimeout(ATM_URL, {}, 15_000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const lines = {};
      for (const m of html.matchAll(/lb_(M\d)_Stato"[^>]*>([^<]*)/g)) {
        const text = strip(m[2]) || '—';
        const level = /^regolare$/i.test(text) ? 'ok' : classify(text);
        lines[m[1]] = { level, text, at: Date.now(), span: level === 'stop' ? spanOf(text) : null };
      }
      // Eventuale messaggio generale sotto la tabella (es. sciopero).
      const msg = strip(html.match(/StatusLinee_Messaggio">([\s\S]*?)<\/tr>/)?.[1]);
      if (!Object.keys(lines).length) throw new Error('riquadro "Stato Metro" non trovato');
      this.status.milano = lines;
      this.messageMilano = msg || null;
      delete this.errors.milano;
    } catch (e) {
      this.errors.milano = e.message;
      log('Stato metro Milano non disponibile:', e.message);
    }
  }

  get(feed, line) {
    return this.status[feed]?.[line] || null;
  }

  /** Riassunto per il browser: solo città richieste. */
  summary(feeds) {
    return feeds.map((f) => ({
      feed: f,
      lines: this.status[f] || {},
      message: f === 'milano' ? this.messageMilano : null,
      error: this.errors[f] || null,
      at: this.at,
    }));
  }
}

/** La tratta [A, B] (nomi) copre il tratto tra le fermate i e i+1 del percorso? */
export function inSpan(span, stops, i) {
  if (!span) return true; // interruzione senza tratta indicata: tutta la linea
  const find = (name) => {
    const n = normName(name);
    return stops.findIndex((s) => {
      const m = normName(s.name);
      return m === n || m.includes(n) || n.includes(m.replace(/\b(M\d|FS|MA|MB|MC)\b/g, '').trim());
    });
  };
  const a = find(span[0]);
  const b = find(span[1]);
  if (a < 0 || b < 0) return true; // nomi non riconosciuti: meglio prudenti
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return i >= lo && i + 1 <= hi;
}
