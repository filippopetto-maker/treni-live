// Barra delle notizie in alto a destra, stile notiziario: le notizie scorrono da destra a sinistra.
// Lontano: tutta Italia. Zoomando: solo la zona (e la città, se Roma o Milano).

const TICKER_POLL_MS = 60_000;
const TICKER_SPEED = 70; // pixel al secondo
const SRC_LABEL = { calcolato: 'Treni Live', RFI: 'RFI' };
let tickerKey = '';
let tickerTimer = null;

function tickerHtml(items) {
  const one = items
    .map(
      (it) =>
        `<span class="tk-item lvl-${esc(it.level)}"><i></i><b>${esc(SRC_LABEL[it.src] || it.src)}</b>${esc(it.text)}</span>`
    )
    .join('<span class="tk-sep">•</span>');
  // Il contenuto è ripetuto due volte: l'animazione scorre di metà e ricomincia senza salti.
  return `<div class="tk-run">${one}<span class="tk-sep">•</span></div><div class="tk-run" aria-hidden="true">${one}<span class="tk-sep">•</span></div>`;
}

async function pollTicker() {
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(pollTicker, TICKER_POLL_MS);
  if (document.hidden) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(3)).join(',');
  try {
    const d = await (await fetch(`/api/news?bbox=${bbox}&zoom=${map.getZoom().toFixed(1)}`)).json();
    const key = d.scope + '|' + d.items.map((i) => i.text).join('|');
    $('#tkScope').textContent = d.scope;
    if (key === tickerKey) return;
    tickerKey = key;
    const track = $('#tkTrack');
    track.innerHTML = tickerHtml(d.items);
    // Riparte da capo con le notizie nuove, a velocità costante qualunque sia la lunghezza.
    track.style.animation = 'none';
    void track.offsetWidth;
    track.style.animation = '';
    const w = track.firstElementChild.offsetWidth;
    track.style.animationDuration = `${Math.max(12, w / TICKER_SPEED)}s`;
  } catch {}
}

let tickerMove = null;
map.on('moveend', () => {
  clearTimeout(tickerMove);
  tickerMove = setTimeout(pollTicker, 1200);
});
map.on('load', pollTicker);
document.addEventListener('visibilitychange', () => !document.hidden && pollTicker());
