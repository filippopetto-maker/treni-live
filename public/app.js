// Treni Live Italia — frontend.
// I treni arrivano dal server come tratti (da [lon,lat,t] a [lon,lat,t]);
// qui li si interpola ogni secondo per farli scorrere sulla mappa.

const TRAIN_POLL_MS = 15_000;
const TRANSIT_POLL_MS = 20_000;
const TRANSIT_MIN_ZOOM = 11;
const COLORS = {
  av: '#d6202a', italo: '#8a1538', ic: '#1f5fbf', reg: '#2e9e5b',
  bus: '#e08a00', tram: '#0f8b8d', filobus: '#b5179e', metro: '#c0392b',
};
const MODE_NAMES = { bus: 'Bus', tram: 'Tram', filobus: 'Filobus', metro: 'Metro' };
let metroVehicles = [];
// Linea cercata (es. il 64): sulla mappa restano solo i suoi mezzi e il suo percorso.
let lineFilter = null; // { feed, name, mode, color, live }
let metroOn = true;

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
// Telefono: schermo piccolo o dito come puntatore principale.
const mobile = window.matchMedia('(max-width: 700px), (pointer: coarse)').matches;
const map = new maplibregl.Map({
  // Sui telefoni con schermo 3x si disegna a 2x: 2,25 volte meno pixel, differenza invisibile.
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  fadeDuration: 0,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  container: 'map',
  style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
  center: [12.6, 42.1],
  zoom: 5.4,
  minZoom: 4,
  maxBounds: [[2, 33], [24, 50]],
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
if (!mobile) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

let trains = [];
let clockOffset = 0; // ora server − ora browser
const enabled = new Set(['av', 'italo', 'ic', 'reg']);
let transitOn = true;
let transitTimer = null;
let openPopup = null;
let followId = null;

const $ = (s) => document.querySelector(s);

// ---------- dati treni ----------

async function pollTrains() {
  // Scheda nascosta: niente richieste, così il server può andare in risparmio.
  if (document.hidden) return;
  try {
    const r = await fetch('/api/trains');
    const data = await r.json();
    clockOffset = data.now - Date.now();
    trains = data.trains;
    await loadPaths();
    updateCounts();
    renderTrains(true);
    refreshStatus();
  } catch (e) {
    $('#status').textContent = 'Server non raggiungibile: è avviato? (node server.js)';
  }
}

function position(t, now) {
  const [x0, y0, t0] = t.from;
  const [x1, y1, t1] = t.to;
  if (t1 <= t0) return [x1, y1];
  // Si ferma poco prima della prossima fermata se il treno è in ritardo sulla stima.
  const f = Math.max(0, Math.min(0.98, (now - t0) / (t1 - t0)));
  const p = t.path && pathCache.get(t.path);
  if (p && p.pts) return alongPath(p, f);
  return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
}

// ---------- percorsi sui binari ----------
// Il server manda per ogni treno l'id del percorso tra le due località (es. "S01700>S01820");
// le geometrie si scaricano una volta e restano in memoria.

const pathCache = new Map(); // id → { pts, cum, total } | 'pending'
const M_LON = 111320 * Math.cos((42 * Math.PI) / 180);
const M_LAT = 110540;

function preparePath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][0] - pts[i - 1][0]) * M_LON;
    const dy = (pts[i][1] - pts[i - 1][1]) * M_LAT;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

function alongPath(p, f) {
  const d = f * p.total;
  let lo = 0;
  let hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = p.cum[hi] - p.cum[lo] || 1;
  const k = (d - p.cum[lo]) / seg;
  const [ax, ay] = p.pts[lo];
  const [bx, by] = p.pts[hi];
  return [ax + (bx - ax) * k, ay + (by - ay) * k];
}

async function loadPaths() {
  const need = [...new Set(trains.map((t) => t.path).filter((id) => id && !pathCache.has(id)))];
  for (let i = 0; i < need.length; i += 200) {
    const batch = need.slice(i, i + 200);
    batch.forEach((id) => pathCache.set(id, 'pending'));
    try {
      const data = await (await fetch('/api/paths?ids=' + batch.map(encodeURIComponent).join(','))).json();
      for (const id of batch) data[id] ? pathCache.set(id, preparePath(data[id])) : pathCache.delete(id);
    } catch {
      batch.forEach((id) => pathCache.delete(id));
    }
  }
}

// ---------- percorso del mezzo selezionato ----------
// Treni: tratte dalla prima all'ultima fermata. Bus/tram: forma della corsa dal GTFS statico.
// La parte già percorsa è sfumata, quella da fare è a colore pieno; il punto di divisione
// è la posizione attuale del mezzo e si aggiorna mentre si muove.

let selected = null; // { kind: 'train'|'vehicle', id, color, legs?, coords?, pos? }

/** Punto della polilinea più vicino a p: indice del segmento e punto proiettato. */
function project(pts, p) {
  let best = { i: 0, q: pts[0], d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * M_LON, ay = pts[i][1] * M_LAT;
    const bx = pts[i + 1][0] * M_LON, by = pts[i + 1][1] * M_LAT;
    const px = p[0] * M_LON, py = p[1] * M_LAT;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.d) {
      best = { i, d, q: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] };
    }
  }
  return best;
}

function splitAt(pts, p) {
  const { i, q } = project(pts, p);
  return [[...pts.slice(0, i + 1), q], [q, ...pts.slice(i + 1)]];
}

function drawSelected() {
  const doneSrc = map.getSource('route-done');
  const todoSrc = map.getSource('route-todo');
  if (!doneSrc) return;
  const done = [];
  const todo = [];
  if (selected?.kind === 'train' && selected.legs) {
    const t = trains.find((x) => x.id === selected.id);
    const pos = t && position(t, Date.now() + clockOffset);
    for (const leg of selected.legs) {
      if (leg.state === 'done') done.push(leg.coords);
      else if (leg.state === 'current' && pos) {
        const [a, b] = splitAt(leg.coords, pos);
        done.push(a);
        todo.push(b);
      } else todo.push(leg.coords);
    }
  } else if (selected?.kind === 'vehicle' && selected.coords) {
    const [a, b] = splitAt(selected.coords, selected.pos);
    done.push(a);
    todo.push(b);
  }
  const fc = (parts) => ({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: parts },
    properties: { color: selected?.color || '#888' },
  });
  doneSrc.setData(fc(done));
  todoSrc.setData(fc(todo));
}

function clearSelected() {
  selected = null;
  drawSelected();
}

/** Area visibile allargata di metà schermo per lato: i treni appena fuori entrano già pronti. */
function viewBox() {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) / 2;
  const dy = (b.getNorth() - b.getSouth()) / 2;
  return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
}

function trainFeatures() {
  const now = Date.now() + clockOffset;
  const features = [];
  const [w, s, e, n] = viewBox();
  for (const t of trains) {
    if (!enabled.has(t.cat)) continue;
    // Scarto veloce: entrambi gli estremi del tratto fuori dallo stesso lato.
    if ((t.from[0] < w && t.to[0] < w) || (t.from[0] > e && t.to[0] > e) || (t.from[1] < s && t.to[1] < s) || (t.from[1] > n && t.to[1] > n)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position(t, now) },
      properties: { id: t.id, cat: t.cat, delay: t.delay, label: t.label, station: t.status === 'station' },
    });
  }
  return { type: 'FeatureCollection', features };
}

// Mentre la mappa si muove non si ricalcola niente: è lì che il telefono andava a scatti.
const busy = () => document.hidden || map.isMoving() || map.isZooming();

function renderTrains(force) {
  const src = map.getSource('trains');
  if (!src || (force !== true && busy())) return;
  src.setData(trainFeatures());
  if (selected?.kind === 'train') drawSelected();
  if (followId) {
    const t = trains.find((x) => x.id === followId);
    if (t && openPopup) openPopup.setLngLat(position(t, Date.now() + clockOffset));
  }
}

function updateCounts() {
  const c = { av: 0, italo: 0, ic: 0, reg: 0 };
  for (const t of trains) c[t.cat]++;
  for (const k in c) $(`[data-count="${k}"]`).textContent = c[k].toLocaleString('it-IT');
}

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const v = s.viaggiatreno;
    const total = trains.length.toLocaleString('it-IT');
    const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    let txt = `${total} treni sulla mappa · aggiornato alle ${time}`;
    if (v.rfiCircolanti) txt += ` · RFI ne conta ${v.rfiCircolanti.toLocaleString('it-IT')} in circolazione (Italo escluso)`;
    if (v.giriTabelloni === 0) txt += ' · primo giro dei tabelloni in corso, i treni compaiono man mano';
    $('#status').textContent = txt;
  } catch {}
}

// ---------- mezzi urbani ----------

async function pollTransit() {
  clearTimeout(transitTimer);
  const src = map.getSource('transit');
  if (!src) return;
  if ((!transitOn && !metroOn) || map.getZoom() < TRANSIT_MIN_ZOOM) {
    src.setData({ type: 'FeatureCollection', features: [] });
    metroVehicles = [];
    renderMetro(true);
    renderMetroStatus([]);
    $('#transitCount').textContent = transitOn ? 'zoom' : '–';
    $('#metroCount').textContent = metroOn ? 'zoom' : '–';
    $('#hint').textContent = '';
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(4)).join(',');
  try {
    const data = await (await fetch(`/api/transit?bbox=${bbox}`)).json();
    // Bus e tram si riconoscono dal nome GTFS ("64"), la metro dal nome comune ("A", "M1").
    const onLine = (v) =>
      !lineFilter ||
      (v.feed === lineFilter.feed &&
        String(v.rname ?? v.route) === (v.mode === 'metro' || v.scheduled ? lineFilter.name : lineFilter.short) &&
        // direzione scelta nel tabellone (se il mezzo dice dove va)
        (!lineFilter.dirKey || !v.dest || normKey(v.dest) === lineFilter.dirKey));
    const surface = transitOn ? data.vehicles.filter(onLine) : [];
    src.setData({
      type: 'FeatureCollection',
      features: surface.map((v) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: { ...v, route: v.route || '' },
      })),
    });
    metroVehicles = metroOn ? (data.metro || []).filter((v) => !lineFilter || onLine(v)) : [];
    renderMetro(true);
    renderMetroStatus(metroOn ? data.metroStatus || [] : []);
    $('#transitCount').textContent = surface.length.toLocaleString('it-IT');
    $('#metroCount').textContent = metroVehicles.length.toLocaleString('it-IT');
    if (selected?.kind === 'vehicle') {
      const v = data.vehicles.find((x) => x.id === selected.id && x.feed === selected.feed);
      if (v) {
        selected.pos = [v.lon, v.lat];
        if (openPopup) openPopup.setLngLat(selected.pos);
        drawSelected();
      }
    }
    const errors = data.feeds.filter((f) => f.error);
    if (lineFilter) {
      showLineHint(surface.length + metroVehicles.length);
      transitTimer = setTimeout(pollTransit, TRANSIT_POLL_MS);
      return;
    }
    $('#hint').textContent = !data.feeds.length
      ? 'Nessun feed bus/tram in tempo reale configurato per questa zona (vedi feeds.json).'
      : errors.length
        ? `Feed non disponibile: ${errors.map((f) => f.name).join(', ')}`
        : `Mezzi urbani: ${data.feeds.map((f) => f.name).join(', ')}. Metro: posizione stimata dagli orari.`;
  } catch {}
  transitTimer = setTimeout(pollTransit, TRANSIT_POLL_MS);
}

// ---------- metro da orario ----------
// Ogni treno della metro arriva con i prossimi tratti { c, t0, t1 } (forma reale della linea
// tra due stazioni, oppure un punto se è in sosta): qui lo si fa scorrere ogni secondo.

function metroPosition(v, now) {
  const legs = v.legs;
  let leg = legs.find((l) => now < l.t1) || legs[legs.length - 1];
  if (now < legs[0].t0) leg = legs[0];
  if (leg.c.length === 1) return leg.c[0];
  leg._p ||= preparePath(leg.c);
  // Gli orari GTFS della metro non hanno la sosta: ne simulo ~25 s per stazione
  // (metà a inizio tratta, metà alla fine), così il treno si ferma davvero in banchina.
  const dur = leg.t1 - leg.t0 || 1;
  const d = Math.min(12_000, dur * 0.15);
  const f = Math.max(0, Math.min(1, (now - leg.t0 - d) / (dur - 2 * d)));
  return alongPath(leg._p, f);
}

let metroShown = 0;
function renderMetro(force) {
  const src = map.getSource('metro');
  if (!src || (force !== true && busy())) return;
  // Niente metro in vista: non si riscrive la sorgente vuota ogni secondo.
  if (!metroVehicles.length && !metroShown) return;
  metroShown = metroVehicles.length;
  const now = Date.now() + clockOffset;
  const features = metroVehicles.map((v) => {
    const pos = metroPosition(v, now);
    if (selected?.kind === 'vehicle' && selected.id === v.id) {
      selected.pos = pos;
      openPopup?.setLngLat(pos);
    }
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: { id: v.id, feed: v.feed, trip: v.trip, route: v.route, rname: v.rname, lineName: v.lineName || '', dest: v.dest, color: v.color, mode: 'metro', next: v.next, scheduled: true, alert: v.alert?.level || 'ok', alertText: v.alert?.text || '' },
    };
  });
  src.setData({ type: 'FeatureCollection', features });
  if (selected?.kind === 'vehicle' && selected.id?.startsWith('m:')) drawSelected();
}

// Stato delle linee (ATM per Milano, Roma Mobilità per Roma).
const LINE_COLORS = {
  A: '#d6202a', B: '#0a5db4', B1: '#0a5db4', C: '#2fa84f',
  M1: '#e2231a', M2: '#00a650', M3: '#f9a800', M4: '#0072bc', M5: '#8c4fa3',
  ML: '#0096c7', RV: '#8e44ad',
};
const LEVEL_TEXT = { ok: 'regolare', warn: 'rallentata', station: 'stazione chiusa', stop: 'interrotta', info: 'avviso' };
let metroStatusByLine = {};

function renderMetroStatus(list) {
  const el = $('#metroStatus');
  metroStatusByLine = {};
  if (!list.length) return (el.innerHTML = '');
  const rows = [];
  const chips = [];
  for (const city of list) {
    for (const [line, st] of Object.entries(city.lines)) {
      metroStatusByLine[`${city.feed}/${line}`] = st;
      chips.push(`<span class="mchip lvl-${st.level}" style="--c:${LINE_COLORS[line] || '#888'}" title="${esc(st.text)}">${esc(line)}</span>`);
      if (st.level !== 'ok') rows.push(`<li class="lvl-${st.level}"><b>${esc(line)}</b> ${esc(st.text)}</li>`);
    }
    if (city.message) rows.push(`<li class="lvl-info">${esc(city.message)}</li>`);
    if (city.error) rows.push(`<li class="lvl-info">Stato linee di ${esc(city.feed)} non disponibile (${esc(city.error)})</li>`);
  }
  const src = list.map((c) => (c.feed === 'milano' ? 'ATM' : 'Roma Mobilità')).join(' e ');
  el.innerHTML = `<div class="mhead">Stato metro <small>(fonte ${src})</small></div>
    <div class="mchips">${chips.join('')}</div>
    ${rows.length ? `<ul class="malerts">${rows.join('')}</ul>` : '<div class="muted">Tutte le linee regolari.</div>'}`;
}

// ---------- popup ----------

const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const delayClass = (d) => (d > 15 ? 'bad' : d >= 5 ? 'warn' : 'ok');
const delayText = (d) => (d > 0 ? `+${d} min` : d < 0 ? `${d} min (anticipo)` : 'in orario');

async function showTrain(t, lngLat) {
  openPopup?.remove();
  followId = t.id;
  const head = `
    <h3><i class="dot ${t.cat}"></i>${esc(t.label)}</h3>
    <div class="route">${esc(t.orig || '')} → ${esc(t.dest || '')}</div>
    <dl>
      <dt>Ritardo</dt><dd class="delay ${delayClass(t.delay)}">${delayText(t.delay)}</dd>
      <dt>${t.status === 'station' ? 'In stazione' : 'Tra'}</dt>
      <dd>${t.status === 'station' ? esc(t.prev) : `${esc(t.prev)} → ${esc(t.next)}`}</dd>
      ${t.det ? `<dt>Rilevato</dt><dd>${esc(t.det)} ${fmtTime(t.detT)}</dd>` : ''}
      <dt>Impresa</dt><dd>${esc(t.op)}</dd>
    </dl>
    ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}`;
  openPopup = new maplibregl.Popup({ offset: 10, maxWidth: '300px' })
    .setLngLat(lngLat)
    .setHTML(`<div class="pop">${head}<ul class="stops"><li>Carico le fermate…</li></ul></div>`)
    .addTo(map);
  openPopup.on('close', () => {
    followId = null;
    clearSelected();
  });
  selected = { kind: 'train', id: t.id, color: COLORS[t.cat] };
  drawSelected();
  fetch(`/api/train/route?id=${encodeURIComponent(t.id)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => {
      if (r && selected?.id === t.id) {
        selected.legs = r.legs;
        drawSelected();
      }
    })
    .catch(() => {});

  try {
    const d = await (await fetch(`/api/train?id=${encodeURIComponent(t.id)}`)).json();
    const now = Date.now() + clockOffset;
    const stops = (d.stops || [])
      .map((s) => {
        const sched = s.arr || s.dep;
        const real = s.realArr || s.realDep;
        const done = real && real <= now;
        const cls = s.soppressa ? 'soppressa' : done ? 'done' : '';
        const when = real ? fmtTime(real) : fmtTime(sched);
        const late = real && sched && real - sched >= 60_000 ? ` <small>(${fmtTime(sched)})</small>` : '';
        return `<li class="${cls}"><span>${esc(s.name)}</span><time>${when}${late}</time></li>`;
      })
      .join('');
    const el = openPopup?.getElement()?.querySelector('.stops');
    if (el) el.innerHTML = stops || '<li>Fermate non disponibili</li>';
  } catch {}
}

function showVehicle(p, lngLat) {
  followId = null;
  openPopup?.remove();
  const age = p.ts ? Math.round((Date.now() / 1000 - p.ts) / 60) : null;
  const mode = p.mode || 'bus';
  const color = p.color || COLORS[mode] || COLORS.bus;
  const body =
    mode === 'metro'
      ? `<dt>Prossima</dt><dd>${esc(p.next || '')}</dd>
         <dt>Linea</dt><dd class="${p.alert && p.alert !== 'ok' ? 'warnline' : ''}">${esc(p.alertText || (metroStatusByLine[`${p.feed}/${p.rname}`] ? 'regolare (nessun avviso in corso)' : 'stato non disponibile'))}</dd>
         <dt>Posizione</dt><dd>${p.feed === 'astral'
           ? "orario + ritardo comunicato da ASTRAL <small>(le corse soppresse non compaiono)</small>"
           : "stimata dall'orario <small>(la metro non trasmette la posizione; le tratte dichiarate ferme vengono tolte)</small>"}</dd>`
      : `<dt>Vettura</dt><dd>${esc(p.vlabel || p.vid || p.id)}</dd>
         ${p.speed ? `<dt>Velocità</dt><dd>${p.speed} km/h</dd>` : ''}
         ${age !== null ? `<dt>Posizione</dt><dd>${age <= 0 ? 'adesso' : `${age} min fa`}</dd>` : ''}`;
  openPopup = new maplibregl.Popup({ offset: 8 })
    .setLngLat(lngLat)
    .setHTML(
      `<div class="pop"><h3><i class="dot" style="background:${esc(color)}"></i>${p.lineName ? esc(p.lineName) : `${MODE_NAMES[mode] || 'Linea'} ${esc(p.rname || p.route || '?')}`}</h3>
       ${p.dest ? `<div class="route">→ ${esc(p.dest)}</div>` : ''}
       <dl>${body}</dl></div>`
    )
    .addTo(map);
  openPopup.on('close', clearSelected);
  selected = { kind: 'vehicle', id: p.id, feed: p.feed, color, pos: lngLat };
  drawSelected();
  const q = new URLSearchParams({ feed: p.feed, trip: p.trip || '', route: p.route || '' });
  fetch(`/api/vehicle/route?${q}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => {
      if (r && selected?.id === p.id) {
        selected.coords = r.coords;
        drawSelected();
      }
    })
    .catch(() => {});
}

// ---------- mappa ----------

map.on('load', () => {
  // Sul telefono la scritta dei crediti parte chiusa (resta il tasto ⓘ).
  if (mobile) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  // Etichette della mappa in italiano dove disponibili.
  for (const layer of map.getStyle().layers) {
    const tf = layer.type === 'symbol' && map.getLayoutProperty(layer.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) {
      map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:it'], ['get', 'name']]);
    }
  }

  map.addSource('transit', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('route-done', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('route-todo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  // Percorso del mezzo selezionato: già fatto (sfumato) e da fare (pieno, con bordo chiaro).
  map.addLayer({
    id: 'route-done',
    type: 'line',
    source: 'route-done',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.3 },
  });
  map.addLayer({
    id: 'route-todo-casing',
    type: 'line',
    source: 'route-todo',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#181b22' : '#ffffff', 'line-width': 7.5, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'route-todo',
    type: 'line',
    source: 'route-todo',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
  });

  // Percorso della linea cercata (sotto i mezzi).
  map.addSource('line-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'line-hl-casing',
    type: 'line',
    source: 'line-hl',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#181b22' : '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'line-hl',
    type: 'line',
    source: 'line-hl',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': 0.85 },
  });

  map.addLayer({
    id: 'transit',
    type: 'circle',
    source: 'transit',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 6],
      'circle-color': ['match', ['get', 'mode'], 'tram', COLORS.tram, 'filobus', COLORS.filobus, COLORS.bus],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'transit-label',
    type: 'symbol',
    source: 'transit',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'route'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 10,
      'text-offset': [0, 1.1],
    },
    paint: {
      'text-color': ['match', ['get', 'mode'], 'tram', COLORS.tram, 'filobus', COLORS.filobus, '#a35f00'],
      'text-halo-color': '#fff',
      'text-halo-width': 1.2,
    },
  });

  // Metro (posizione stimata dagli orari): pallino più grande col colore della linea.
  map.addSource('metro', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // Anello scuro attorno ai treni della metro: non si confondono con i bus (la A di Roma è arancione).
  map.addLayer({
    id: 'metro-halo',
    type: 'circle',
    source: 'metro',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6.5, 15, 12.5],
      'circle-color': dark ? '#eef0f4' : '#1d2330',
    },
  });
  map.addLayer({
    id: 'metro',
    type: 'circle',
    source: 'metro',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 15, 9],
      'circle-color': ['get', 'color'],
      // Bordo giallo se la linea ha problemi segnalati (rallentamenti, stazioni chiuse, tratte ferme).
      'circle-stroke-color': ['match', ['get', 'alert'], 'ok', '#fff', 'info', '#fff', '#f0a202'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 15, 2.2],
    },
  });
  map.addLayer({
    id: 'metro-label',
    type: 'symbol',
    source: 'metro',
    minzoom: 13,
    layout: { 'text-field': ['get', 'rname'], 'text-font': ['Noto Sans Bold'], 'text-size': 9, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' },
  });

  map.addLayer({
    id: 'trains',
    type: 'circle',
    source: 'trains',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.6, 8, 4, 12, 7],
      'circle-color': ['match', ['get', 'cat'], 'av', COLORS.av, 'italo', COLORS.italo, 'ic', COLORS.ic, COLORS.reg],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 2],
      'circle-stroke-color': ['step', ['get', 'delay'], '#ffffff', 5, '#f0a202', 16, '#d6202a'],
      'circle-opacity': ['case', ['get', 'station'], 0.75, 1],
    },
  });
  map.addLayer({
    id: 'trains-label',
    type: 'symbol',
    source: 'trains',
    minzoom: 9.5,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': dark ? '#eef0f4' : '#1d2330', 'text-halo-color': dark ? '#181b22' : '#ffffff', 'text-halo-width': 1.4 },
  });

  map.on('click', 'metro', (e) => showVehicle(e.features[0].properties, e.features[0].geometry.coordinates));
  setInterval(renderMetro, mobile ? 2000 : 1000);
  for (const layer of ['trains', 'transit', 'metro']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'trains', (e) => {
    const t = trains.find((x) => x.id === e.features[0].properties.id);
    if (t) showTrain(t, e.features[0].geometry.coordinates);
  });
  map.on('click', 'transit', (e) => showVehicle(e.features[0].properties, e.features[0].geometry.coordinates));
  // A fine spostamento: subito i treni nella nuova area, i mezzi urbani dopo una breve pausa
  // (chi trascina a scatti non fa partire una richiesta per ogni scatto).
  let moveTimer = null;
  map.on('moveend', () => {
    renderTrains(true);
    renderMetro(true);
    clearTimeout(moveTimer);
    moveTimer = setTimeout(pollTransit, 400);
  });

  pollTrains();
  setInterval(pollTrains, TRAIN_POLL_MS);
  // Tornando sulla scheda, aggiorna subito invece di aspettare il prossimo giro.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pollTrains();
      pollTransit();
    }
  });
  setInterval(renderTrains, mobile ? 2000 : 1000);
});

// ---------- controlli ----------

document.querySelectorAll('[data-cat]').forEach((cb) =>
  cb.addEventListener('change', () => {
    cb.checked ? enabled.add(cb.dataset.cat) : enabled.delete(cb.dataset.cat);
    renderTrains(true);
  })
);
$('#transitToggle').addEventListener('change', (e) => {
  transitOn = e.target.checked;
  pollTransit();
});
$('#metroToggle').addEventListener('change', (e) => {
  metroOn = e.target.checked;
  pollTransit();
});
function setPanel(open) {
  const p = $('#panel');
  p.classList.toggle('collapsed', !open);
  $('#collapse').textContent = open ? '–' : '+';
}
$('#collapse').addEventListener('click', (e) => {
  e.stopPropagation();
  setPanel($('#panel').classList.contains('collapsed'));
});
// Sul telefono il pannello è un cassetto: si apre e si chiude toccando l'intestazione.
if (mobile) {
  setPanel(false);
  $('#panel header').addEventListener('click', () => setPanel($('#panel').classList.contains('collapsed')));
}
// ---------- linee bus/tram/metro (quando si è zoomati su una città) ----------

/** Come normName del server: maiuscole, senza accenti né punteggiatura. */
const normKey = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();

const MODE_LABEL = { bus: 'Bus', tram: 'Tram', filobus: 'Filobus', metro: 'Metro' };

function showLineHint(n) {
  const l = lineFilter;
  const live = l.live == null ? 'posizioni live non disponibili in questa città' : `${n} ${n === 1 ? 'mezzo' : 'mezzi'} in servizio nella zona`;
  const pill = `<span class="line-pill" style="background:${esc(l.color)}">${esc(MODE_LABEL[l.mode] || 'Linea')} ${esc(l.name)}</span>`;
  $('#hint').innerHTML = `${pill} ${l.long ? esc(l.long) + ' · ' : ''}${live}`;
}

function clearLine() {
  lineFilter = null;
  map.getSource('line-hl')?.setData({ type: 'FeatureCollection', features: [] });
  $('#hint').textContent = '';
  closeBoard();
  pollTransit();
}

async function searchLine(q) {
  const c = map.getCenter();
  const r = await fetch(`/api/line?q=${encodeURIComponent(q)}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`);
  if (!r.ok) return false;
  const l = await r.json();
  const color = l.mode === 'metro' && LINE_COLORS[l.name] ? LINE_COLORS[l.name] : l.color || COLORS[l.mode] || COLORS.bus;
  lineFilter = { feed: l.feed, name: l.name, short: l.short, mode: l.mode, color, live: l.mode === 'metro' ? 0 : l.live, long: l.long, dirKey: null };
  // Tabellone della linea: arrivi alla fermata più vicina a te (o al centro della mappa).
  openBoard({ feed: l.feed, q, name: l.name, mode: l.mode, color }, { lat: c.lat, lon: c.lng });
  map.getSource('line-hl')?.setData({
    type: 'FeatureCollection',
    features: l.dirs.map((d) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: d.coords }, properties: { color, headsign: d.headsign } })),
  });
  const b = new maplibregl.LngLatBounds();
  l.dirs.forEach((d) => d.coords.forEach((p) => b.extend(p)));
  if (mobile) {
    $('#q').blur();
    setPanel(false);
  }
  if (!b.isEmpty()) map.fitBounds(b, { padding: mobile ? { top: 60, bottom: 140, left: 30, right: 30 } : { top: 60, bottom: 60, left: 340, right: 60 }, maxZoom: 15, duration: 700 });
  // Lo zoom minimo per vedere i mezzi urbani resta 11: se la linea è lunga si resta a 11.
  map.once('moveend', () => {
    if (map.getZoom() < TRANSIT_MIN_ZOOM) map.easeTo({ zoom: TRANSIT_MIN_ZOOM, duration: 300 });
  });
  showLineHint(0);
  pollTransit();
  return true;
}

// ---------- stazioni (treni ovunque; metro, Metromare e Roma–Viterbo quando si è in città) ----------

async function findStations(q) {
  const c = map.getCenter();
  const r = await fetch(`/api/stations?q=${encodeURIComponent(q)}&near=${c.lat.toFixed(4)},${c.lng.toFixed(4)}&zoom=${map.getZoom().toFixed(1)}`);
  return r.ok ? r.json() : [];
}

function goStation(s) {
  $('#qSugg').innerHTML = '';
  if (mobile) {
    $('#q').blur();
    setPanel(false);
  }
  if (lineFilter) clearLine();
  map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), s.metro ? 16 : 15), duration: 900 });
  map.once('moveend', () => showStop({ id: s.id, name: s.name, rail: true }, [s.lon, s.lat]));
}

// Suggerimenti mentre si scrive il nome di una stazione (non per numeri di treno o linee).
let qTimer = null;
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer);
  const q = $('#q').value.trim();
  const list = $('#qSugg');
  if (q.length < 3 || /^\d/.test(q)) return (list.innerHTML = '');
  qTimer = setTimeout(async () => {
    const res = await findStations(q).catch(() => []);
    if ($('#q').value.trim() !== q) return;
    list.innerHTML = res
      .map((s, i) => `<li data-i="${i}"><span class="ico">${s.metro ? 'Ⓜ️' : '🚉'}</span><span><b>${esc(s.name)}</b><small>${esc(s.sub || '')}</small></span></li>`)
      .join('');
    list.querySelectorAll('li').forEach((li) =>
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        goStation(res[+li.dataset.i]);
      })
    );
  }, 250);
});
$('#q').addEventListener('blur', () => setTimeout(() => ($('#qSugg').innerHTML = ''), 150));

// Il suggerimento nella casella cambia quando si è dentro una città.
function updateSearchHint() {
  $('#q').placeholder = map.getZoom() >= 10 ? 'Cerca treno, linea o stazione (es. 64, Termini)' : 'Cerca treno o stazione (es. 9651, Bologna)';
}
map.on('zoomend', updateSearchHint);
$('#q').addEventListener('input', () => !$('#q').value && lineFilter && clearLine());

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!q) return;
  // Zoomati su una città: prima si cerca una linea urbana, poi un treno.
  if (map.getZoom() >= 10 && q.length <= 12) {
    try {
      if (await searchLine(q)) return;
    } catch {}
  }
  if (lineFilter) clearLine();
  const num = q.replace(/\D/g, '');
  const t =
    trains.find((x) => x.label.toUpperCase() === q) ||
    trains.find((x) => num && x.label.replace(/\D/g, '') === num);
  if (!t) {
    try {
      const list = await findStations($('#q').value.trim());
      if (list.length) return goStation(list[0]);
    } catch {}
    $('#hint').textContent = `Nessun treno, linea o stazione "${q}" trovati.`;
    return;
  }
  const pos = position(t, Date.now() + clockOffset);
  if (mobile) {
    $('#q').blur();
    setPanel(false);
  }
  map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
  showTrain(t, pos);
});
