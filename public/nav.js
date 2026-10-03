// Navigatore stile Moovit: percorso da A a B, fermate con le prossime partenze.
// Usa le variabili globali di app.js (map, $, esc, fmtTime, clockOffset, openPopup).

const STOPS_MIN_ZOOM = 15;
const ICONS = { bus: '🚌', tram: '🚋', metro: 'Ⓜ', treno: '🚆', filobus: '🚎', traghetto: '⛴', funicolare: '🚞', funivia: '🚡' };
const nav = { from: null, to: null, journeys: [], active: -1, markers: {}, stopTimer: null, seq: 0 };
const now = () => Date.now() + clockOffset;
const mins = (ms) => Math.max(0, Math.round(ms / 60000));

const chip = (l) =>
  `<span class="chip" style="background:${esc(l.color || '#666')}">${ICONS[l.mode] || '🚌'} ${esc(l.line)}</span>`;

function liveText(l) {
  if (!l.live || l.delay == null) return `<span class="sched">orario programmato${l.mode === 'metro' ? ' (stato linea controllato)' : ''}</span>`;
  const m = Math.round(l.delay / 60);
  if (m >= 1) return `<span class="live late">live · +${m}′</span>`;
  if (m <= -1) return `<span class="live">live · ${-m}′ in anticipo</span>`;
  return '<span class="live">live · in orario</span>';
}

// ---------- schede del pannello ----------

document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== b.dataset.tab));
    setPanel(true);
    // Sul telefono niente tastiera che si apre da sola: copre metà schermo.
    if (b.dataset.tab === 'tab-nav' && !mobile) $('#navFrom').focus();
  })
);

function openNavTab() {
  document.querySelector('.tabs [data-tab="tab-nav"]').click();
  setPanel(true);
}

// ---------- ricerca luoghi ----------

let suggTimer = null;
function setupPlaceInput(input, which) {
  const list = input.parentElement.querySelector('.sugg');
  input.addEventListener('input', () => {
    clearTimeout(suggTimer);
    nav[which] = null;
    const q = input.value.trim();
    if (q.length < 2) return (list.innerHTML = '');
    suggTimer = setTimeout(async () => {
      const c = map.getCenter();
      try {
        const res = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}&near=${c.lat.toFixed(4)},${c.lng.toFixed(4)}`)).json();
        if (input.value.trim() !== q) return;
        list.innerHTML = res
          .map(
            (r, i) =>
              `<li data-i="${i}"><span class="ico">${r.kind === 'luogo' ? '📍' : r.kind === 'stazione' ? '🚉' : '🚏'}</span>` +
              `<span><b>${esc(r.name)}</b><small>${esc(r.sub || '')}</small></span></li>`
          )
          .join('');
        list.querySelectorAll('li').forEach((li) =>
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const r = res[+li.dataset.i];
            setPlace(which, { lat: r.lat, lon: r.lon, name: r.name });
            list.innerHTML = '';
          })
        );
      } catch {}
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(() => (list.innerHTML = ''), 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector('li')?.dispatchEvent(new MouseEvent('mousedown'));
    }
  });
}
setupPlaceInput($('#navFrom'), 'from');
setupPlaceInput($('#navTo'), 'to');

function setPlace(which, p) {
  nav[which] = p;
  $(which === 'from' ? '#navFrom' : '#navTo').value = p ? p.name : '';
  nav.markers[which]?.remove();
  if (p) {
    const el = document.createElement('div');
    el.className = `pin ${which}`;
    nav.markers[which] = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
  }
  if (nav.from && nav.to) {
    if (mobile) document.activeElement?.blur?.();
    plan();
  }
}

$('#navHere').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  $('#navFrom').value = 'Cerco la tua posizione…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setPlace('from', { lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'La mia posizione' }),
    () => ($('#navFrom').value = ''),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$('#navSwap').addEventListener('click', () => {
  const f = nav.from;
  const t = nav.to;
  nav.from = nav.to = null;
  setPlace('from', t);
  setPlace('to', f);
});

$('#navWhen').addEventListener('change', () => {
  $('#navTime').classList.toggle('hidden', $('#navWhen').value === 'now');
  if ($('#navWhen').value !== 'now' && !$('#navTime').value) {
    const d = new Date(now() + 30 * 60000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $('#navTime').value = d.toISOString().slice(0, 16);
  }
  plan();
});
$('#navTime').addEventListener('change', plan);

$('#navClear').addEventListener('click', () => {
  nav.from = nav.to = null;
  setPlace('from', null);
  setPlace('to', null);
  nav.journeys = [];
  nav.active = -1;
  $('#navResults').innerHTML = '';
  $('#navMsg').textContent = '';
  drawJourney();
});

async function plan() {
  if (!nav.from || !nav.to) return;
  const seq = ++nav.seq;
  const time = $('#navWhen').value === 'now' ? now() : new Date($('#navTime').value).getTime() || now();
  $('#navMsg').textContent = 'Calcolo i percorsi…';
  // La prima ricerca in una città carica gli orari: sul server gratuito ci vogliono ~10 secondi.
  setTimeout(() => {
    if (seq === nav.seq && $('#navMsg').textContent === 'Calcolo i percorsi…')
      $('#navMsg').textContent = 'Calcolo i percorsi… (la prima ricerca in una città carica gli orari, circa 10 secondi)';
  }, 2500);
  $('#navResults').innerHTML = '';
  const q = new URLSearchParams({
    from: `${nav.from.lat},${nav.from.lon}`,
    to: `${nav.to.lat},${nav.to.lon}`,
    fromName: nav.from.name,
    toName: nav.to.name,
    time: String(Math.round(time)),
  });
  try {
    const r = await fetch(`/api/plan?${q}`);
    const d = await r.json();
    if (seq !== nav.seq) return;
    if (!r.ok) throw new Error(d.error || 'errore');
    nav.journeys = d.journeys || [];
    $('#navMsg').textContent = nav.journeys.length ? d.note || '' : d.note || 'Nessun percorso trovato in questo orario.';
    renderJourneys();
    if (nav.journeys.length) selectJourney(0);
  } catch (e) {
    if (seq === nav.seq) $('#navMsg').textContent = 'Non riesco a calcolare il percorso: ' + e.message;
  }
}

// ---------- risultati ----------

function renderJourneys() {
  $('#navResults').innerHTML = nav.journeys
    .map((j, i) => {
      const parts = j.legs.map((l) =>
        l.type === 'walk' ? `<span class="walk">🚶${mins(l.arr - l.dep) || ''}</span>` : chip(l)
      );
      const firstRide = j.legs.find((l) => l.type === 'ride');
      const leaveIn = mins(j.dep - now());
      const anyLive = j.legs.some((l) => l.type === 'ride' && l.live);
      const sub = [
        firstRide ? `${firstRide.mode === 'treno' ? 'Treno' : 'Passa'} alle ${fmtTime(firstRide.dep)} da ${esc(firstRide.from.name)}` : 'Tutto a piedi',
        j.changes ? `${j.changes} ${j.changes === 1 ? 'cambio' : 'cambi'}` : firstRide ? 'diretto' : '',
        `${j.walkM.toLocaleString('it-IT')} m a piedi`,
      ].filter(Boolean);
      return `<li class="jr${i === nav.active ? ' on' : ''}" data-i="${i}">
        <div class="jr-top"><b>${fmtTime(j.dep)} – ${fmtTime(j.arr)}</b><span>${j.min} min</span></div>
        <div class="chips">${parts.join('<i class="sep">›</i>')}</div>
        <div class="jr-sub">${anyLive ? '<i class="pulse"></i>' : ''}${leaveIn > 0 ? `esci tra ${leaveIn} min · ` : ''}${sub.join(' · ')}</div>
        ${i === nav.active ? steps(j) : ''}
      </li>`;
    })
    .join('');
  document.querySelectorAll('#navResults .jr').forEach((li) =>
    li.addEventListener('click', (e) => {
      if (e.target.closest('.steps')) return;
      selectJourney(+li.dataset.i);
    })
  );
}

function steps(j) {
  const out = j.legs.map((l, k) => {
    if (l.type === 'walk') {
      const dest = k === j.legs.length - 1 ? 'a destinazione' : `fino a <b>${esc(l.to.name)}</b>`;
      return `<li class="st walk"><span class="ico">🚶</span><div>Cammina ${mins(l.arr - l.dep)} min (${l.m.toLocaleString('it-IT')} m) ${dest}</div></li>`;
    }
    const n = l.stops.length - 1;
    const mid = l.stops
      .slice(1, -1)
      .map((s) => `<li><span>${esc(s.name)}</span><time>${fmtTime(s.t)}</time></li>`)
      .join('');
    return `<li class="st ride" style="--c:${esc(l.color)}"><span class="ico">${chip(l)}</span><div>
      <div class="dir">→ ${esc(l.headsign || l.to.name)}</div>
      <div><time>${fmtTime(l.dep)}</time> Sali a <b>${esc(l.from.name)}</b> ${liveText(l)}</div>
      ${l.alert ? `<div class="st-alert">⚠ ${esc(l.alert)}</div>` : ''}
      ${n > 1 ? `<details><summary>${n} fermate · ${mins(l.arr - l.dep)} min</summary><ul class="stops">${mid}</ul></details>` : `<div class="muted">1 fermata · ${mins(l.arr - l.dep)} min</div>`}
      <div><time>${fmtTime(l.arr)}</time> Scendi a <b>${esc(l.to.name)}</b></div>
    </div></li>`;
  });
  return `<ol class="steps">${out.join('')}</ol>`;
}

function selectJourney(i) {
  nav.active = i;
  renderJourneys();
  drawJourney(true);
}

function drawJourney(fit) {
  const src = map.getSource('plan');
  if (!src) return;
  const j = nav.journeys[nav.active];
  const features = [];
  if (j) {
    for (const l of j.legs) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: l.coords },
        properties: { kind: l.type, color: l.color || '#888' },
      });
      if (l.type === 'ride')
        for (const s of [l.from, l.to])
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: { kind: 'stop', color: l.color, name: s.name },
          });
    }
  }
  src.setData({ type: 'FeatureCollection', features });
  if (fit && j) {
    const b = new maplibregl.LngLatBounds();
    for (const l of j.legs) for (const c of l.coords) b.extend(c);
    // Telefono: il cassetto copre il fondo dello schermo, il percorso va nella parte libera sopra.
    const pad = mobile
      ? { top: 50, bottom: Math.min($('#panel').offsetHeight, window.innerHeight * 0.65) + 20, left: 30, right: 30 }
      : { top: 60, bottom: 60, left: window.innerWidth > 600 ? 360 : 40, right: 60 };
    map.fitBounds(b, { padding: pad, maxZoom: 16, duration: 600 });
  }
}

// ---------- fermate e prossime partenze ----------

async function loadStops() {
  const src = map.getSource('stops');
  if (!src) return;
  if (map.getZoom() < STOPS_MIN_ZOOM) return src.setData({ type: 'FeatureCollection', features: [] });
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(4)).join(',');
  try {
    const stops = await (await fetch(`/api/stops?bbox=${bbox}`)).json();
    src.setData({
      type: 'FeatureCollection',
      features: stops.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { id: s.id, name: s.name, rail: !!s.rail },
      })),
    });
  } catch {}
}

async function showStop(p, lngLat) {
  openPopup?.remove();
  clearInterval(nav.stopTimer);
  const html = (body) => `<div class="pop stop-pop">
    <h3>${p.rail ? '🚉' : '🚏'} ${esc(p.name)}</h3>
    <div class="deps">${body}</div>
    <div class="pop-actions"><button data-act="from">Parti da qui</button><button data-act="to">Arriva qui</button></div>
  </div>`;
  openPopup = new maplibregl.Popup({ offset: 8, maxWidth: '320px' }).setLngLat(lngLat).setHTML(html('Carico le partenze…')).addTo(map);
  const pop = openPopup;
  pop.getElement().querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      setPlace(b.dataset.act, { lat: lngLat[1], lon: lngLat[0], name: p.name });
      openNavTab();
      pop.remove();
    })
  );
  const refresh = async () => {
    try {
      const d = await (await fetch(`/api/stop/arrivals?id=${encodeURIComponent(p.id)}`)).json();
      const el = pop.getElement()?.querySelector('.deps');
      if (el) el.innerHTML = departuresHtml(d.departures || []);
    } catch {}
  };
  refresh();
  nav.stopTimer = setInterval(refresh, 30_000);
  pop.on('close', () => clearInterval(nav.stopTimer));
}

/** Partenze raggruppate per linea e direzione, come le paline elettroniche. */
function departuresHtml(deps) {
  if (!deps.length) return '<div class="muted">Nessuna partenza nei prossimi 90 minuti.</div>';
  const groups = new Map();
  for (const d of deps) {
    const k = `${d.line}|${d.headsign}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const rows = [...groups.values()].slice(0, 12).map((g) => {
    const times = g
      .slice(0, 3)
      .map((d) => {
        const m = Math.round((d.t - now()) / 60000);
        const txt = m <= 0 ? 'ora' : m < 60 ? `${m}′` : fmtTime(d.t);
        if (d.cancelled) return `<span class="cancelled" title="Corsa soppressa">${txt}</span>`;
        if (d.ghost) return `<span class="ghost" title="Doveva essere già partita ma non risulta in viaggio: probabilmente saltata">${txt}</span>`;
        const late = d.live && d.delay > 90 ? ` title="ritardo ${Math.round(d.delay / 60)} min"` : '';
        return `<span class="${d.live ? 'live' : ''}"${late}>${txt}</span>`;
      })
      .join('');
    const warn = g[0].alert ? ` <span class="st-alert" title="${esc(g[0].alert)}">⚠</span>` : '';
    return `<li>${chip(g[0])}<span class="hs">${esc(g[0].headsign)}${warn}</span><span class="times">${times}</span></li>`;
  });
  const extra = [
    deps.some((d) => d.ghost) ? '<span class="ghost">barrato</span> = non rilevata, probabilmente saltata' : '',
    deps.some((d) => d.cancelled) ? '<span class="cancelled">rosso barrato</span> = soppressa' : '',
  ].filter(Boolean);
  return `<ul class="deplist">${rows.join('')}</ul><div class="legend-live"><span class="live">verde</span> = in tempo reale${extra.length ? ' · ' + extra.join(' · ') : ''}</div>`;
}

// Tasto destro (o pressione lunga col dito) sulla mappa: scegli partenza o arrivo.
// Su iPhone il browser non genera il tasto destro: la pressione lunga la si riconosce a mano.
let pressTimer = null;
let pressAt = null;
map.on('touchstart', (e) => {
  clearTimeout(pressTimer);
  if (e.originalEvent.touches.length !== 1) return;
  pressAt = e.point;
  pressTimer = setTimeout(() => pickPoint(e), 550);
});
map.on('touchmove', (e) => {
  if (pressAt && (Math.abs(e.point.x - pressAt.x) > 8 || Math.abs(e.point.y - pressAt.y) > 8)) clearTimeout(pressTimer);
});
for (const ev of ['touchend', 'touchcancel', 'movestart']) map.on(ev, () => clearTimeout(pressTimer));
map.on('contextmenu', (e) => {
  clearTimeout(pressTimer);
  pickPoint(e);
});
function pickPoint(e) {
  openPopup?.remove();
  const p = { lat: e.lngLat.lat, lon: e.lngLat.lng, name: `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}` };
  openPopup = new maplibregl.Popup({ offset: 4 })
    .setLngLat(e.lngLat)
    .setHTML('<div class="pop-actions"><button data-act="from">Parti da qui</button><button data-act="to">Arriva qui</button></div>')
    .addTo(map);
  const pop = openPopup;
  pop.getElement().querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      setPlace(b.dataset.act, { ...p, name: 'Punto sulla mappa' });
      openNavTab();
      pop.remove();
    })
  );
}

// ---------- livelli sulla mappa ----------

map.on('load', () => {
  const below = map.getLayer('transit') ? 'transit' : undefined;
  map.addSource('plan', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer(
    {
      id: 'stops',
      type: 'circle',
      source: 'stops',
      minzoom: STOPS_MIN_ZOOM,
      paint: {
        'circle-radius': ['case', ['get', 'rail'], 6, 4],
        'circle-color': dark ? '#181b22' : '#ffffff',
        'circle-stroke-color': ['case', ['get', 'rail'], '#1565c0', '#5b6475'],
        'circle-stroke-width': ['case', ['get', 'rail'], 2.5, 1.6],
      },
    },
    below
  );
  map.addLayer(
    {
      id: 'stops-label',
      type: 'symbol',
      source: 'stops',
      minzoom: 16.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': dark ? '#c9cfdb' : '#4a5263', 'text-halo-color': dark ? '#181b22' : '#fff', 'text-halo-width': 1.2 },
    },
    below
  );

  map.addLayer(
    {
      id: 'plan-walk',
      type: 'line',
      source: 'plan',
      filter: ['==', ['get', 'kind'], 'walk'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#c9cfdb' : '#5b6475', 'line-width': 3.5, 'line-dasharray': [0.1, 1.8] },
    },
    below
  );
  map.addLayer(
    {
      id: 'plan-ride-casing',
      type: 'line',
      source: 'plan',
      filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#181b22' : '#ffffff', 'line-width': 9 },
    },
    below
  );
  map.addLayer(
    {
      id: 'plan-ride',
      type: 'line',
      source: 'plan',
      filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5.5 },
    },
    below
  );
  map.addLayer(
    {
      id: 'plan-stops',
      type: 'circle',
      source: 'plan',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: { 'circle-radius': 5.5, 'circle-color': '#fff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 },
    },
    below
  );

  map.on('mouseenter', 'stops', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'stops', () => (map.getCanvas().style.cursor = ''));
  map.on('click', 'stops', (e) => {
    // Un mezzo sopra la fermata ha la precedenza.
    if (map.queryRenderedFeatures(e.point, { layers: ['transit', 'trains', 'metro'] }).length) return;
    showStop(e.features[0].properties, e.features[0].geometry.coordinates);
  });
  map.on('moveend', loadStops);
  loadStops();
});
