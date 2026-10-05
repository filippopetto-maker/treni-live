// Tabellone di una linea cercata (bus, tram, metro): scegli la direzione e la fermata, e vedi
// tra quanto arriva ogni mezzo, se trasmette il GPS e quali corse rischiano di saltare.
// Usa le variabili globali di app.js (map, $, esc, fmtTime, mobile, lineFilter, pollTransit, normKey).

const LB_POLL_MS = 20_000;
const LB_MODE = { bus: 'Bus', tram: 'Tram', filobus: 'Filobus', metro: 'Metro' };
const lb = { line: null, dir: '', stop: null, pos: null, data: null, timer: null, marker: null, open: 0, req: 0 };

function boardEl() {
  let el = $('#lineBoard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lineBoard';
    el.className = 'hidden';
    document.body.appendChild(el);
  }
  return el;
}

/** Posizione per scegliere la fermata: GPS se concesso (pochi secondi), altrimenti il punto dato. */
function lbPosition(fallback) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(fallback);
    const done = (p) => resolve(p);
    const t = setTimeout(() => done(fallback), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(t);
        done({ lat: p.coords.latitude, lon: p.coords.longitude, gps: true });
      },
      () => {
        clearTimeout(t);
        done(fallback);
      },
      { maximumAge: 60_000, timeout: 4000 }
    );
  });
}

async function openBoard(line, fallbackPos) {
  closeBoard(true);
  const open = ++lb.open; // apertura corrente: quelle superate non fanno più niente
  lb.line = line;
  lb.dir = '';
  lb.stop = null;
  lb.pos = fallbackPos;
  const el = boardEl();
  el.classList.remove('hidden', 'min');
  el.innerHTML = `<div class="lb-head">${pillHtml()}<span class="lb-sum">carico gli arrivi…</span></div>`;
  const pos = await lbPosition(fallbackPos);
  if (open !== lb.open || !lb.line) return; // chiuso o un'altra linea nel frattempo
  lb.pos = pos;
  await loadBoard();
  if (open !== lb.open || !lb.line) return;
  clearInterval(lb.timer);
  lb.timer = setInterval(() => !document.hidden && loadBoard(), LB_POLL_MS);
}

function closeBoard(silent) {
  lb.open++;
  clearInterval(lb.timer);
  lb.timer = null;
  lb.data = null;
  lb.marker?.remove();
  lb.marker = null;
  const el = $('#lineBoard');
  if (el) el.classList.add('hidden');
  if (!silent) lb.line = null;
}

const pillHtml = () => `<span class="line-pill" style="background:${esc(lb.line.color)}">${esc(LB_MODE[lb.line.mode] || 'Linea')} ${esc(lb.line.name)}</span>`;

async function loadBoard() {
  if (!lb.line) return;
  const req = ++lb.req; // conta solo la risposta più recente
  const q = new URLSearchParams({ feed: lb.line.feed, q: lb.line.q, dir: lb.dir });
  if (lb.stop != null) q.set('stop', lb.stop);
  else if (lb.pos) {
    q.set('lat', lb.pos.lat.toFixed(5));
    q.set('lon', lb.pos.lon.toFixed(5));
  }
  try {
    const r = await fetch(`/api/line/board?${q}`);
    const d = await r.json();
    if (!lb.line || req !== lb.req) return;
    if (!r.ok) throw new Error(d.error || 'errore');
    lb.data = d;
    lb.dir = d.dir || '';
    if (d.stop) lb.stop = d.stop.id;
    // Sulla mappa solo i mezzi della direzione scelta.
    if (lineFilter) {
      lineFilter.dirKey = d.dir || null;
      pollTransit();
    }
    renderBoard();
  } catch (e) {
    const sum = $('#lineBoard .lb-sum');
    if (sum) sum.textContent = /preparando/.test(e.message) ? 'sto preparando gli orari, riprovo…' : 'arrivi non disponibili: ' + e.message;
  }
}

function etaText(ms) {
  const m = Math.round((ms - (Date.now() + clockOffset)) / 60000);
  return m <= 0 ? 'ora' : m < 100 ? `${m}′` : fmtTime(ms);
}

function ageText(s) {
  if (s == null) return '';
  return s < 60 ? `${s} s fa` : `${Math.round(s / 60)} min fa`;
}

function rowHtml(t, d, i) {
  const dm = t.delay != null ? Math.round(t.delay / 60) : 0;
  const delay = dm >= 1 ? ` · ${dm}′ di ritardo` : dm <= -1 ? ` · ${-dm}′ in anticipo` : t.delay != null && t.gps ? ' · in orario' : '';
  const stops = t.stopsAway != null ? ` · ${t.stopsAway === 0 ? 'in arrivo' : t.stopsAway === 1 ? '1 fermata' : `${t.stopsAway} fermate`}` : '';
  const est = t.estimated ? ' · orario stimato' : '';
  let cls, b, small;
  if (t.cancelled) {
    cls = 'ghost';
    b = `${fmtTime(t.sched)} · soppressa`;
    small = 'corsa cancellata dall’azienda';
  } else if (t.ghost) {
    cls = 'ghost';
    b = `${fmtTime(t.sched)} · probabilmente saltata`;
    small = 'doveva essere partita ma non trasmette il GPS';
  } else if (t.gps) {
    cls = 'gps';
    b = `${fmtTime(t.eta)}${stops}`;
    small = `GPS ${ageText(t.gps.age)}${t.gps.vehicle ? ' · vettura ' + esc(t.gps.vehicle) : ''}${delay}`;
  } else if (!t.started) {
    cls = 'notstarted';
    b = `${fmtTime(t.eta)} · parte dal capolinea`;
    small = `${esc(t.fromTerminus || '')}${est}`;
  } else {
    cls = 'nogps';
    b = `${fmtTime(t.eta)}${stops} · da orario`;
    small = d.hasLive ? `nessun GPS: potrebbe non passare${delay}${est}` : `orario (in questa città i mezzi non trasmettono la posizione)${est}`;
  }
  return `<li class="lb-row ${cls}" data-i="${i}"><span class="lb-eta">${t.cancelled || t.ghost ? '✕' : etaText(t.eta)}</span><span class="lb-info"><b>${b}</b><small>${small}</small></span></li>`;
}

function renderBoard() {
  const d = lb.data;
  const el = boardEl();
  const withGps = d.trips.filter((t) => t.gps).length;
  const risky = d.trips.filter((t) => t.ghost || t.cancelled).length;
  const sum = d.trips.length
    ? `${d.trips.length} in arrivo${d.hasLive ? ` · ${withGps} con GPS` : ''}${risky ? ` · ${risky} a rischio` : ''}`
    : 'nessun passaggio nei prossimi 75 min';
  const dirs = d.directions
    .filter((x) => x.trips >= 3 || x.key === d.dir)
    .slice(0, 3)
    .map((x) => `<button type="button" data-dir="${esc(x.key)}" class="${x.key === d.dir ? 'on' : ''}">→ ${esc(x.headsign)}</button>`)
    .join('');
  const opts = d.stops.map((s) => `<option value="${s.id}"${d.stop && s.id === d.stop.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const wasMin = el.classList.contains('min');
  el.innerHTML = `<div class="lb-head">${pillHtml()}<span class="lb-sum">${esc(sum)}</span>
      <button class="lb-min" type="button" aria-label="Riduci o espandi">${wasMin ? '▴' : '▾'}</button>
      <button class="lb-close" type="button" aria-label="Chiudi e mostra tutti i mezzi">✕</button></div>
    <div class="lb-body">
      <div class="lb-dirs">${dirs}</div>
      <div class="lb-stop"><span>Fermata</span><select aria-label="Fermata">${opts}</select>
        <button class="lb-near" type="button" title="Fermata più vicina a me" aria-label="Fermata più vicina a me">◎</button></div>
      <ol class="lb-list">${d.trips.map((t, i) => rowHtml(t, d, i)).join('') || '<li class="lb-row"><span class="lb-info"><small>Nessun passaggio previsto a questa fermata nei prossimi 75 minuti.</small></span></li>'}</ol>
      ${d.note ? `<p class="lb-note">⚠ ${esc(d.note)}</p>` : ''}
      ${d.trips.some((t) => t.ghost) ? '<p class="lb-note">✕ rosso = corsa che doveva essere già in viaggio ma non trasmette il GPS: spesso è saltata.</p>' : ''}
    </div>`;
  el.querySelector('.lb-close').onclick = () => clearLine();
  el.querySelector('.lb-min').onclick = () => {
    el.classList.toggle('min');
    el.querySelector('.lb-min').textContent = el.classList.contains('min') ? '▴' : '▾';
  };
  el.querySelectorAll('.lb-dirs button').forEach((b) =>
    b.addEventListener('click', () => {
      lb.dir = b.dataset.dir;
      lb.stop = null; // la fermata più vicina nella nuova direzione
      loadBoard();
    })
  );
  el.querySelector('select').addEventListener('change', (e) => {
    lb.stop = +e.target.value;
    loadBoard();
  });
  el.querySelector('.lb-near').onclick = async () => {
    const open = lb.open;
    const pos = await lbPosition(lb.pos);
    if (open !== lb.open) return;
    lb.pos = pos;
    lb.stop = null;
    loadBoard();
  };
  el.querySelectorAll('.lb-row.gps').forEach((li) =>
    li.addEventListener('click', () => {
      const t = d.trips[+li.dataset.i];
      if (t?.gps) map.flyTo({ center: [t.gps.lon, t.gps.lat], zoom: Math.max(map.getZoom(), 15) });
    })
  );
  // Segno sulla mappa per la fermata scelta.
  if (d.stop) {
    if (!lb.marker) {
      const m = document.createElement('div');
      m.className = 'lb-stopmark';
      lb.marker = new maplibregl.Marker({ element: m }).setLngLat([d.stop.lon, d.stop.lat]).addTo(map);
    } else lb.marker.setLngLat([d.stop.lon, d.stop.lat]);
    lb.marker.getElement().style.setProperty('--c', lb.line.color);
  }
}
