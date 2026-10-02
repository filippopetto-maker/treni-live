// Percorso completo di un treno, dalla prima all'ultima fermata, diviso in tratte
// già fatte, in corso e da fare. Il browser divide la tratta in corso nel punto esatto
// in cui si trova il treno.

/**
 * @returns {{ legs: { coords: number[][], state: 'done'|'current'|'todo' }[] } | null}
 */
export function trainRoute(tr, rail, st) {
  const stops = (tr.stops || []).filter((s) => !s.soppressa && s.code && st.byCode.has(s.code));
  if (stops.length < 2) return null;
  const seg = tr.seg || {};

  // Quante fermate sono già state raggiunte.
  let reached = -1;
  let running = seg.status === 'running';
  if (running) {
    const next = stops.findIndex((s) => s.code === seg.b);
    if (next > 0) reached = next;
  } else if (seg.status === 'station') {
    const at = stops.findIndex((s) => s.code === seg.a);
    if (at >= 0) reached = at + 1;
  }
  if (reached < 0) {
    // Ripiego: ultima fermata con un orario reale.
    stops.forEach((s, i) => {
      if (s.realArr || s.realDep) reached = i + 1;
    });
    if (reached < 0) reached = 0;
    running = reached > 0 && reached < stops.length;
  }

  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = st.byCode.get(stops[i].code);
    const b = st.byCode.get(stops[i + 1].code);
    const coords = (rail && rail.pathSync(a.code, b.code)) || [
      [a.lon, a.lat],
      [b.lon, b.lat],
    ];
    const state = i + 1 < reached ? 'done' : running && i + 1 === reached ? 'current' : 'todo';
    legs.push({ coords, state });
  }
  for (let i = 1; i < legs.length; i++) {
    const end = legs[i - 1].coords[legs[i - 1].coords.length - 1];
    const start = legs[i].coords[0];
    if (end[0] !== start[0] || end[1] !== start[1]) legs[i - 1].coords = [...legs[i - 1].coords, start];
  }
  return { legs };
}
