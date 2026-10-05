// Guida passo passo (telefono): segue la posizione, tiene lo schermo acceso, avvisa a voce
// quando arriva il mezzo e dove scendere. Con "Avvisi a schermo spento" il server manda anche
// le notifiche push (funzionano col telefono in tasca; su iPhone serve il sito aggiunto alla Home).
// Usa le variabili globali di app.js e nav.js (map, $, esc, nav, now, mobile, setPanel, plan, setPlace).

const GC = window.GuideCore;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/Android/.test(navigator.userAgent));
const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const can = {
  gps: 'geolocation' in navigator,
  wake: 'wakeLock' in navigator,
  voice: 'speechSynthesis' in window,
  vibrate: typeof navigator.vibrate === 'function',
  push: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- interruttori ----------

const prefs = { guide: store.get('tl.guide', false), push: store.get('tl.push', false) };

function noteFor() {
  const out = [];
  if (prefs.push) {
    if (isIOS && !standalone) out.push('📲 Su iPhone le notifiche arrivano solo dall’app: tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi apri Treni Live da lì.');
    else if (!can.push) out.push('Questo browser non supporta le notifiche push.');
    else if (Notification.permission === 'denied') out.push('Le notifiche sono bloccate: riattivale nelle impostazioni del browser per questo sito.');
  }
  if (prefs.guide && !can.gps) out.push('Questo browser non dà la posizione: la guida andrà solo a orario.');
  if (prefs.guide || prefs.push) out.push('Scegli un percorso e tocca <b>▶ Inizia il viaggio</b>.');
  return out.join('<br>');
}

function renderSwitches() {
  $('#swGuide').checked = prefs.guide;
  $('#swPush').checked = prefs.push;
  $('#guideNote').innerHTML = noteFor();
  updateStopButton();
  if (nav.journeys?.length) renderJourneys();
}

/** Il tasto "Termina" nella scheda Percorso compare quando c'è una guida o ci sono notifiche attive. */
function updateStopButton() {
  let active = false;
  try {
    active = G.on || !!G.pushId || !!store.get('tl.trip', null);
  } catch {}
  $('#guideStop')?.classList.toggle('hidden', !active);
}

/**
 * Dice al server di smettere con le notifiche di questo telefono: per identificativo E per indirizzo
 * dell'abbonamento (così si fermano anche sessioni "orfane" di cui il telefono ha perso l'id), con
 * keepalive (arriva anche se la pagina si chiude subito) e un secondo tentativo se la rete manca.
 * Con `unsubscribe` si cancella anche l'abbonamento: da quel momento nessun messaggio può più
 * arrivare a questo telefono; al prossimo viaggio ci si riabbona da soli (il permesso resta).
 */
async function stopServerGuide(id, { unsubscribe = false } = {}) {
  let sub = null;
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    sub = (await reg?.pushManager?.getSubscription()) || null;
  } catch {}
  if (!id && !sub) return;
  const body = JSON.stringify({ id: id || '', endpoint: sub?.endpoint || '' });
  const post = () => fetch('/api/guide/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  post().catch(() => setTimeout(() => post().catch(() => {}), 5000));
  if (unsubscribe && sub) {
    try {
      await sub.unsubscribe();
    } catch {}
  }
}

/** Ferma tutto: guida, GPS, voce, schermo acceso e le notifiche del server (anche dopo una riapertura). */
async function endEverything() {
  const saved = store.get('tl.trip', null);
  const id = G.pushId || saved?.pushId;
  G.pushId = null; // la chiamata al server la fa questa funzione, una volta sola
  clearTimeout(resumeTimer); // un ripristino in arrivo dopo una riapertura non deve ripartire
  stopGuide(true);
  stopServerGuide(id, { unsubscribe: true });
  G.pushId = null;
  store.set('tl.trip', null);
  updateStopButton();
  $('#guideNote').innerHTML = 'Guida e notifiche terminate.' + (prefs.guide || prefs.push ? '<br>' + noteFor() : '');
}

$('#swGuide').addEventListener('change', (e) => {
  prefs.guide = e.target.checked;
  store.set('tl.guide', prefs.guide);
  // Spenta durante un viaggio: si fermano GPS, voce e schermo acceso (le notifiche, se attive, restano).
  if (!prefs.guide && G.on) {
    if (G.watch != null) navigator.geolocation.clearWatch(G.watch);
    G.watch = null;
    G.wake?.release?.().catch(() => {});
    G.voice = false;
    if (can.voice) speechSynthesis.cancel();
    if (!G.pushId) stopGuide(true);
  } else if (prefs.guide && G.on) {
    // Riaccesa durante il viaggio: tornano GPS, schermo acceso e voce (il tocco sblocca la voce su iPhone).
    if (can.gps && G.watch == null) G.watch = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    keepAwake();
    G.voice = can.voice;
  }
  renderSwitches();
});
$('#swPush').addEventListener('change', async (e) => {
  prefs.push = e.target.checked;
  store.set('tl.push', prefs.push);
  // Spento durante un viaggio: il server smette di mandare notifiche.
  if (!prefs.push) {
    // Anche senza id noto: lo stop per abbonamento ferma eventuali sessioni rimaste sul server.
    stopServerGuide(G.pushId || store.get('tl.trip', null)?.pushId, { unsubscribe: true });
    G.pushId = null;
    saveState();
    if (G.on && !prefs.guide) stopGuide(true);
    render();
  }
  renderSwitches();
});
$('#guideStop').addEventListener('click', endEverything);
renderSwitches();

function guideStartHtml() {
  if (!prefs.guide && !prefs.push) return '';
  return `<button class="g-start" type="button">▶ Inizia il viaggio</button>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.g-start')) startGuide(nav.journeys[nav.active]);
});

// ---------- avvisi ----------

let voiceIt = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voiceIt = vs.find((v) => v.lang === 'it-IT' && v.localService) || vs.find((v) => v.lang?.startsWith('it')) || null;
}
if (can.voice) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

function speak(text) {
  if (!can.voice || !G.voice) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT';
    if (voiceIt) u.voice = voiceIt;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  } catch {}
}

/** Avviso: voce + vibrazione + banner; se la pagina è in secondo piano anche una notifica locale. */
async function announce(key, m) {
  if (G.said.has(key)) return;
  G.said.add(key);
  saveState();
  speak(m.say || `${m.title}. ${m.body}`);
  if (can.vibrate) navigator.vibrate([250, 120, 250]);
  const el = $('#guide');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  // Notifica locale solo se l'app non è in vista e il server non sta già mandando le sue.
  if (document.hidden && !G.pushId && can.push && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(m.title, { body: m.body, tag: 'guida', renotify: true, icon: '/icon-192.png' });
    } catch {}
  }
}

// ---------- stato della guida ----------

const G = {
  on: false,
  j: null,
  i: 0, // tratta attuale
  aboard: {}, // tratta → true quando sei a bordo
  aboardAt: {},
  said: new Set(),
  pos: null, // { lon, lat, acc, t, speed }
  live: {}, // tratta → { off, at, source }
  watch: null,
  timer: null,
  liveTimer: null,
  wake: null,
  voice: false,
  pushId: null,
  follow: true,
  marker: null,
};

function saveState() {
  if (!G.on) return store.set('tl.trip', null);
  store.set('tl.trip', { j: G.j, i: G.i, aboard: G.aboard, aboardAt: G.aboardAt, said: [...G.said], pushId: G.pushId });
}

async function startGuide(j, resume = null) {
  if (!j) return;
  stopGuide(false);
  G.on = true;
  G.j = j;
  G.i = resume?.i ?? 0;
  G.aboard = resume?.aboard || {};
  G.aboardAt = resume?.aboardAt || {};
  G.said = new Set(resume?.said || []);
  G.pushId = resume?.pushId || null;
  G.live = {};
  G.follow = true;
  G.finishing = false;
  G.posDenied = false;
  G.pos = null;
  j.legs.forEach((l) => l.type === 'ride' && GC.prepLeg(l));
  // La voce su iPhone va "sbloccata" dentro il tocco dell'utente.
  if (!resume && can.voice && prefs.guide) {
    G.voice = true;
    const u = new SpeechSynthesisUtterance('Guida avviata');
    u.lang = 'it-IT';
    u.volume = 0.6;
    try {
      speechSynthesis.speak(u);
    } catch {}
  } else if (resume) G.voice = false; // dopo una riapertura serve un tocco (vedi banner)
  $('#guide').classList.remove('hidden');
  document.body.classList.add('guiding');
  if (mobile) setPanel(false);
  if (prefs.guide && can.gps) {
    G.watch = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  if (prefs.guide) await keepAwake();
  if (prefs.push && !resume) startPush(j);
  G.timer = setInterval(render, 1000);
  G.liveTimer = setInterval(refreshLive, 20_000);
  refreshLive();
  saveState();
  render();
  updateStopButton();
}

function stopGuide(user = true) {
  if (G.watch != null) navigator.geolocation.clearWatch(G.watch);
  clearInterval(G.timer);
  clearInterval(G.liveTimer);
  G.watch = G.timer = G.liveTimer = null;
  G.wake?.release?.().catch(() => {});
  G.wake = null;
  if (user && G.pushId) {
    stopServerGuide(G.pushId);
    G.pushId = null;
  }
  G.on = false;
  G.marker?.remove();
  G.marker = null;
  if (can.voice) speechSynthesis.cancel();
  $('#guide').classList.add('hidden');
  document.body.classList.remove('guiding');
  if (user) saveState();
  updateStopButton();
}

// ---------- schermo acceso ----------

async function keepAwake() {
  if (!can.wake || document.hidden) return;
  try {
    G.wake = await navigator.wakeLock.request('screen');
    G.wake.addEventListener('release', () => (G.wake = null));
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && G.on) {
    if (prefs.guide && !G.wake) keepAwake();
    refreshLive();
    render();
  }
});

// ---------- posizione ----------

function onPos(p) {
  const c = p.coords;
  const prev = G.pos;
  G.pos = { lon: c.longitude, lat: c.latitude, acc: c.accuracy, t: p.timestamp || Date.now(), speed: c.speed };
  // Velocità calcolata se il telefono non la dà (molti Android/iPhone a volte mandano null).
  if ((G.pos.speed == null || isNaN(G.pos.speed)) && prev && G.pos.t > prev.t) {
    G.pos.speed = GC.dist([prev.lon, prev.lat], [G.pos.lon, G.pos.lat]) / ((G.pos.t - prev.t) / 1000);
  }
  drawMe();
  render();
}
function onPosErr(e) {
  if (e.code === 1) {
    G.posDenied = true;
    render();
  }
}

/** Posizione affidabile: precisa e recente (in galleria e in metro non c'è). */
function goodPos() {
  const p = G.pos;
  return p && p.acc <= 80 && now() - p.t < 25_000 ? p : null;
}

function drawMe() {
  if (!G.pos) return;
  if (!G.marker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    G.marker = new maplibregl.Marker({ element: el }).setLngLat([G.pos.lon, G.pos.lat]).addTo(map);
  } else G.marker.setLngLat([G.pos.lon, G.pos.lat]);
  G.marker.getElement().classList.toggle('weak', !goodPos());
  if (G.follow) map.easeTo({ center: [G.pos.lon, G.pos.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
}
// Se sposti la mappa a mano smette di seguirti; il tasto ◎ della guida la riaggancia.
map.on('dragstart', () => G.on && (G.follow = false));

// ---------- dati dal vivo ----------

async function refreshLive() {
  if (!G.on) return;
  const legs = G.j.legs;
  // Tratta in corso o la prossima con un mezzo.
  for (let i = G.i; i < legs.length; i++) {
    const l = legs[i];
    if (l.type !== 'ride') continue;
    const q = new URLSearchParams();
    if (l.trainId) q.set('train', l.trainId);
    else if (l.feed && l.tripId) {
      q.set('feed', l.feed);
      q.set('trip', l.tripId);
    } else break;
    try {
      const live = await (await fetch(`/api/guide/live?${q}`)).json();
      G.live[i] = { off: GC.offsetFrom(l, live, now()), at: now(), source: live.vehicle ? 'posizione del mezzo' : live.delaySec != null ? 'ritardo comunicato' : null, cancelled: live.cancelled };
    } catch {}
    break;
  }
  render();
}
const offOf = (i) => G.live[i]?.off ?? 0;

// ---------- motore ----------

function render() {
  if (!G.on) return;
  const legs = G.j.legs;
  const t = now();
  let leg = legs[G.i];
  if (!leg) return finish();
  const pos = goodPos();
  const here = pos ? [pos.lon, pos.lat] : null;
  let ico = '🚶';
  let title = '';
  let sub = '';
  let warn = '';
  let stops = null; // a bordo: striscia con le prossime fermate

  if (leg.type === 'walk') {
    const next = legs[G.i + 1];
    const last = G.i === legs.length - 1;
    const target = [leg.to.lon, leg.to.lat];
    const d = here ? GC.dist(here, target) : null;
    title = last ? `Cammina fino a destinazione` : `Cammina fino a ${leg.to.name}`;
    const parts = [];
    if (d != null) parts.push(`${d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km'}`);
    if (next?.type === 'ride') {
      const dep = next.stops[0].t + offOf(G.i + 1);
      const m = Math.round((dep - t) / 60_000);
      parts.push(`${GC.lineName(next)} ${m > 0 ? `tra ${m} min` : m === 0 ? 'in arrivo' : `previsto ${-m} min fa`} (${GC.hhmm(dep)})`);
      // Ce la fai a piedi? (1,2 m/s con le deviazioni delle strade)
      if (t > dep + 90_000) warn = 'Probabilmente l’hai perso: tocca Ricalcola';
      else if (d != null && d > 60 && (d * 1.3) / 1.2 > (dep - t) / 1000 + 30) warn = 'Affrettati: rischi di perderlo';
    }
    sub = parts.join(' · ');
    const arrived = d != null ? d < 35 : t >= leg.arr;
    if (last && arrived) return finish();
    if (!last && (arrived || (next?.type === 'ride' && G.aboard[G.i + 1]))) {
      G.i++;
      saveState();
      return render();
    }
    // Il prossimo mezzo può già essere preso mentre si "cammina" (fermata a pochi metri).
    if (next?.type === 'ride') detectBoarding(G.i + 1, next, here, t);
  } else {
    const i = G.i;
    const off = offOf(i);
    ico = GC.ICON[leg.mode] || '🚌';
    if (!G.aboard[i]) {
      const pr = GC.progress(leg, off, t);
      const m = Math.round((pr.dep - t) / 60_000);
      title = `Aspetta ${leg.mode === 'treno' ? 'il treno' : GC.art(leg)} ${GC.lineName(leg)}${leg.headsign ? ' → ' + leg.headsign : ''}`;
      sub = `a ${leg.from.name} · ${m > 0 ? `tra ${m} min` : m === 0 ? 'in arrivo' : `previsto ${-m} min fa`} (${GC.hhmm(pr.dep)})${G.live[i]?.source ? ' · live' : ''}`;
      if (G.live[i]?.cancelled) warn = 'Corsa soppressa: tocca Ricalcola';
      if (t >= pr.dep - 2 * 60_000 && t < pr.dep + 60_000) announce(`${i}:arriva`, GC.message('arriva', leg, pr, legs[i + 1], t));
      detectBoarding(i, leg, here, t);
      // Corsa persa: sei ancora alla fermata ben dopo la partenza.
      if (!G.aboard[i] && t > pr.dep + 2 * 60_000) {
        warn = here && GC.dist(here, [leg.from.lon, leg.from.lat]) < 120 ? 'Sembra che il mezzo sia passato: tocca Ricalcola' : warn || 'Sei salito? Tocca «Sono salito» oppure Ricalcola';
      }
    } else {
      // A bordo: fermate contate col GPS se c'è, altrimenti con l'orario (metro, gallerie).
      const p = GC.prepLeg(leg);
      let userS = null;
      if (here) {
        const r = GC.project(p, here);
        if (r.d < 120) userS = r.s;
      }
      const pr = GC.progress(leg, off, t, userS);
      const viaGps = userS != null;
      // In diretta: la prossima fermata intermedia (distanza lungo la linea col GPS, minuti a orario senza).
      const nk = Math.min(pr.passed + 1, leg.stops.length - 1);
      const toNext = viaGps ? Math.max(0, p.stopS[nk] - userS) : null;
      const nextMin = Math.round((leg.stops[nk].t + off - t) / 60_000);
      const howFar = toNext != null ? (toNext < 1000 ? `${Math.round(toNext / 10) * 10} m` : `${(toNext / 1000).toFixed(1)} km`) : nextMin > 0 ? `tra ${nextMin} min` : 'ora';
      if (pr.remaining > 1) {
        title = toNext != null && toNext < 150 ? `In arrivo a ${pr.next.name}` : `Prossima fermata: ${pr.next.name}`;
        sub = `${howFar} · scendi a ${leg.to.name} tra ${pr.remaining} fermate · arrivo ${GC.hhmm(pr.arr)}${viaGps ? ' · GPS' : ' · stima a orario'}`;
      } else if (pr.remaining === 1) {
        title = `Scendi alla prossima: ${leg.to.name}`;
        sub = `${howFar} · arrivo ${GC.hhmm(pr.arr)}${viaGps ? ' · GPS' : ' · stima a orario'}`;
      } else {
        title = `Scendi ora: ${leg.to.name}`;
        sub = `arrivo ${GC.hhmm(pr.arr)}`;
      }
      stops = { leg, pr, off };
      const dDest = here ? GC.dist(here, [leg.to.lon, leg.to.lat]) : null;
      if (pr.remaining <= 1 && leg.stops.length >= 2 && (pr.remaining === 1 || pr.passed > 0)) announce(`${i}:prossima`, GC.message('prossima', leg, pr, legs[i + 1], t));
      const atDest = viaGps ? pr.remaining === 0 || (dDest != null && dDest < 150 && pr.remaining <= 1) : t >= pr.arr - 30_000;
      if (atDest) {
        title = `Scendi ora: ${leg.to.name}`;
        if (!G.said.has(`${i}:prossima`)) G.said.add(`${i}:prossima`);
        announce(`${i}:scendi`, GC.message('scendi', leg, pr, legs[i + 1], t));
        G.aboardAt[`${i}:off`] ||= t;
      }
      // Dopo l'avviso "scendi" si passa al pezzo successivo (a piedi o il prossimo mezzo).
      if (G.aboardAt[`${i}:off`] && t - G.aboardAt[`${i}:off`] > 45_000) {
        G.i++;
        saveState();
        return render();
      }
    }
  }

  $('#gIco').textContent = ico;
  $('#gTitle').textContent = title;
  $('#gSub').textContent = sub;
  renderStops(stops, t);
  $('#gWarn').textContent = warn || (G.posDenied ? 'Posizione non permessa: guida solo a orario' : '');
  $('#gVoice').classList.toggle('hidden', G.voice || !can.voice || !prefs.guide);
  $('#gBoard').classList.toggle('hidden', !(leg.type === 'ride' && !G.aboard[G.i]) && !(leg.type === 'walk' && legs[G.i + 1]?.type === 'ride'));
  $('#gFollow').classList.toggle('hidden', G.follow || !G.pos);
  $('#gPush').textContent = G.pushId ? '🔔' : '';
}

/** Striscia "a bordo": le prossime 3 fermate intermedie e quella dove scendere, con l'orario stimato. */
function renderStops(s, t) {
  const el = $('#gStops');
  if (!s) {
    if (!el.classList.contains('hidden')) {
      el.classList.add('hidden');
      el.innerHTML = '';
    }
    return;
  }
  const st = s.leg.stops;
  const last = st.length - 1;
  const from = Math.min(s.pr.passed + 1, last);
  const ks = [];
  for (let k = from; k < last && ks.length < 3; k++) ks.push(k);
  const skipped = last - from - ks.length; // fermate non mostrate prima di quella dove scendere
  ks.push(last);
  const html = ks
    .map((k, j) => {
      const cls = [k === from ? 'next' : '', k === last ? 'dest' : ''].filter(Boolean).join(' ');
      const gap = k === last && skipped > 0 ? `<li class="gap">… ${skipped} ${skipped === 1 ? 'fermata' : 'fermate'}</li>` : '';
      const name = String(st[k].name).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      return `${gap}<li class="${cls}"><span class="n">${name}</span><span class="t">${GC.hhmm(st[k].t + s.off)}</span></li>`;
    })
    .join('');
  if (el.innerHTML !== html) el.innerHTML = html;
  el.classList.remove('hidden');
}

/** Salita a bordo: dopo l'orario di passaggio ti muovi lungo la linea, lontano dalla fermata. */
function detectBoarding(i, leg, here, t) {
  if (G.aboard[i]) return;
  const dep = leg.stops[0].t + offOf(i);
  if (t < dep - 90_000) return;
  let on = false;
  if (here) {
    const p = GC.prepLeg(leg);
    const r = GC.project(p, here);
    const fromStop = GC.dist(here, [leg.from.lon, leg.from.lat]);
    const speed = G.pos.speed || 0;
    on = r.d < 60 && ((r.s > p.stopS[0] + 150 && fromStop > 120) || (speed > 3.5 && fromStop > 60 && r.s > p.stopS[0]));
  } else if (!G.pos || now() - G.pos.t > 60_000) {
    // Niente GPS (metro sotterranea, posizione negata): si assume la salita all'orario.
    on = t > dep + 30_000;
  }
  if (on) boarded(i);
}

function boarded(i) {
  G.aboard[i] = true;
  G.aboardAt[i] = now();
  // Se eri ancora nel tratto a piedi prima del mezzo, si salta avanti.
  if (G.i < i) G.i = i;
  G.said.add(`${i}:arriva`);
  saveState();
  render();
}

function finish() {
  if (G.finishing) return;
  G.finishing = true;
  const key = 'fine';
  if (!G.said.has(key)) announce(key, { title: 'Sei arrivato', body: '', say: 'Sei arrivato a destinazione.' });
  $('#gIco').textContent = '🏁';
  $('#gTitle').textContent = 'Sei arrivato';
  $('#gSub').textContent = '';
  $('#gWarn').textContent = '';
  setTimeout(() => {
    G.finishing = false;
    if (G.on) stopGuide(true);
  }, 8000);
}

// ---------- pulsanti della guida ----------

$('#gBoard').addEventListener('click', () => {
  const i = G.j.legs[G.i].type === 'ride' ? G.i : G.i + 1;
  boarded(i);
});
$('#gEnd').addEventListener('click', endEverything);
$('#gFollow').addEventListener('click', () => {
  G.follow = true;
  drawMe();
  render();
});
$('#gVoice').addEventListener('click', () => {
  G.voice = true;
  speak('Voce attiva');
  render();
});
$('#gReplan').addEventListener('click', () => {
  // Nuovo percorso da dove sei (o dalla fermata attuale) alla stessa destinazione.
  const last = G.j.legs[G.j.legs.length - 1];
  const pos = G.pos;
  const from = pos ? { lat: pos.lat, lon: pos.lon, name: 'La mia posizione' } : { lat: G.j.legs[G.i].from.lat, lon: G.j.legs[G.i].from.lon, name: G.j.legs[G.i].from.name || 'Qui' };
  const to = nav.to || { lat: last.to.lat, lon: last.to.lon, name: last.to.name || 'Destinazione' };
  stopGuide(true);
  if (mobile) setPanel(true);
  $('#navWhen').value = 'now';
  nav.from = nav.to = null;
  setPlace('to', to);
  setPlace('from', from);
});

// ---------- notifiche push (fase 2) ----------

async function swReg() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function startPush(j) {
  const say = (txt) => ($('#gWarn').textContent = txt);
  if (isIOS && !standalone) return say('Notifiche: aggiungi il sito alla schermata Home e apri da lì');
  if (!can.push) return say('Notifiche non supportate da questo browser');
  try {
    // Il permesso va chiesto subito, dentro il tocco su "Inizia" (Safari lo pretende).
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') return say('Notifiche non permesse');
    const reg = await swReg();
    await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/push/key')).json();
    let sub = await reg.pushManager.getSubscription();
    // Il server può aver cambiato chiave (nuova versione): ci si riabbona.
    const cur = sub?.options?.applicationServerKey;
    if (sub && cur && b64u(new Uint8Array(cur)) !== key) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
    const r = await fetch('/api/guide/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), journey: slim(j) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    // Spenti nel frattempo (interruttore o "Termina"): si annulla subito sul server.
    if (!prefs.push || !G.on) {
      stopServerGuide(d.id);
      return;
    }
    G.pushId = d.id;
    saveState();
    render();
  } catch (e) {
    say('Notifiche non attivate: ' + e.message);
  }
}

function slim(j) {
  return {
    arr: j.arr,
    legs: j.legs.map((l) => {
      const o = { ...l };
      // Meno punti: alla guida bastano ~1 ogni 20 m.
      if (o.coords?.length > 1500) o.coords = o.coords.filter((_, k) => k % Math.ceil(o.coords.length / 1500) === 0 || k === o.coords.length - 1);
      return o;
    }),
  };
}
const b64u = (a) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// Dal service worker: notifica arrivata mentre l'app è aperta (la voce la legge solo se la guida non l'ha già detto).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'guide-push' || !G.on) return;
    if (d.kind && d.leg != null) {
      const key = `${d.leg}:${d.kind}`;
      if (!G.said.has(key)) announce(key, { title: d.title, body: d.body });
    }
  });
  // Registrazione anticipata: serve anche per "Aggiungi a Home" su Android.
  if (prefs.push) swReg().catch(() => {});
}

let resumeTimer = null;

// ---------- ripresa dopo una chiusura (iPhone ricarica spesso le app in secondo piano) ----------

(function resume() {
  const s = store.get('tl.trip', null);
  if (!s?.j?.legs?.length) return;
  const end = s.j.arr + 30 * 60_000;
  if (Date.now() > end) {
    // Viaggio finito da tempo: si avvisa anche il server di smettere con le notifiche.
    if (s.pushId) stopServerGuide(s.pushId);
    return store.set('tl.trip', null);
  }
  // Subito, senza aspettare la mappa (che sul telefono può metterci qualche secondo).
  resumeTimer = setTimeout(() => store.get('tl.trip', null) && startGuide(s.j, s), 0);
})();
