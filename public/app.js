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
let metroOn = true;

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const map = new maplibregl.Map({
  container: 'map',
  style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
  center: [12.6, 42.1],
  zoom: 5.4,
  minZoom: 4,
  maxBounds: [[2, 33], [24, 50]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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
    renderTrains();
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

function trainFeatures() {
  const now = Date.now() + clockOffset;
  const features = [];
  for (const t of trains) {
    if (!enabled.has(t.cat)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position(t, now) },
      properties: { id: t.id, cat: t.cat, delay: t.delay, label: t.label, station: t.status === 'station' },
    });
  }
  return { type: 'FeatureCollection', features };
}

function renderTrains() {
  const src = map.getSource('trains');
  if (!src) return;
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
    renderMetro();
    $('#transitCount').textContent = transitOn ? 'zoom' : '–';
    $('#metroCount').textContent = metroOn ? 'zoom' : '–';
    $('#hint').textContent = '';
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(4)).join(',');
  try {
    const data = await (await fetch(`/api/transit?bbox=${bbox}`)).json();
    const surface = transitOn ? data.vehicles : [];
    src.setData({
      type: 'FeatureCollection',
      features: surface.map((v) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: { ...v, route: v.route || '' },
      })),
    });
    metroVehicles = metroOn ? data.metro || [] : [];
    renderMetro();
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

function renderMetro() {
  const src = map.getSource('metro');
  if (!src) return;
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
      properties: { id: v.id, feed: v.feed, trip: v.trip, route: v.route, rname: v.rname, dest: v.dest, color: v.color, mode: 'metro', next: v.next, scheduled: true },
    };
  });
  src.setData({ type: 'FeatureCollection', features });
  if (selected?.kind === 'vehicle' && selected.id?.startsWith('m:')) drawSelected();
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
         <dt>Posizione</dt><dd>stimata dall'orario <small>(la metro non trasmette la posizione)</small></dd>`
      : `<dt>Vettura</dt><dd>${esc(p.vlabel || p.vid || p.id)}</dd>
         ${p.speed ? `<dt>Velocità</dt><dd>${p.speed} km/h</dd>` : ''}
         ${age !== null ? `<dt>Posizione</dt><dd>${age <= 0 ? 'adesso' : `${age} min fa`}</dd>` : ''}`;
  openPopup = new maplibregl.Popup({ offset: 8 })
    .setLngLat(lngLat)
    .setHTML(
      `<div class="pop"><h3><i class="dot" style="background:${esc(color)}"></i>${MODE_NAMES[mode] || 'Linea'} ${esc(p.rname || p.route || '?')}</h3>
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
  map.addLayer({
    id: 'metro',
    type: 'circle',
    source: 'metro',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 15, 9],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
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
  setInterval(renderMetro, 1000);
  for (const layer of ['trains', 'transit', 'metro']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'trains', (e) => {
    const t = trains.find((x) => x.id === e.features[0].properties.id);
    if (t) showTrain(t, e.features[0].geometry.coordinates);
  });
  map.on('click', 'transit', (e) => showVehicle(e.features[0].properties, e.features[0].geometry.coordinates));
  map.on('moveend', pollTransit);

  pollTrains();
  setInterval(pollTrains, TRAIN_POLL_MS);
  // Tornando sulla scheda, aggiorna subito invece di aspettare il prossimo giro.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pollTrains();
      pollTransit();
    }
  });
  setInterval(renderTrains, 1000);
});

// ---------- controlli ----------

document.querySelectorAll('[data-cat]').forEach((cb) =>
  cb.addEventListener('change', () => {
    cb.checked ? enabled.add(cb.dataset.cat) : enabled.delete(cb.dataset.cat);
    renderTrains();
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
$('#collapse').addEventListener('click', () => {
  const p = $('#panel');
  p.classList.toggle('collapsed');
  $('#collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
});
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!q) return;
  const num = q.replace(/\D/g, '');
  const t =
    trains.find((x) => x.label.toUpperCase() === q) ||
    trains.find((x) => num && x.label.replace(/\D/g, '') === num);
  if (!t) {
    $('#hint').textContent = `Nessun treno "${q}" in circolazione sulla mappa adesso.`;
    return;
  }
  const pos = position(t, Date.now() + clockOffset);
  map.flyTo({ center: pos, zoom: Math.max(map.getZoom(), 10) });
  showTrain(t, pos);
});
