// Nucleo della guida passo passo, uguale nel telefono e nel server (nessuna dipendenza).
// Lavora su una tratta del navigatore: fermate { name, lat, lon, t } e forma della linea coords [[lon, lat]…].
(function () {
  const M_LAT = 110_540;
  const mLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

  function dist(a, b) {
    // a, b: [lon, lat]
    return Math.hypot((a[0] - b[0]) * mLon((a[1] + b[1]) / 2), (a[1] - b[1]) * M_LAT);
  }

  /** Forma della linea pronta per le proiezioni: distanze progressive e posizione di ogni fermata. */
  function prepLeg(leg) {
    if (leg._p) return leg._p;
    const pts = leg.coords && leg.coords.length > 1 ? leg.coords : leg.stops.map((s) => [s.lon, s.lat]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const p = { pts, cum, total: cum[cum.length - 1] };
    // Le fermate in ordine lungo la linea (mai all'indietro: le linee circolari ripassano vicino).
    let from = 0;
    p.stopS = leg.stops.map((s) => {
      const r = project(p, [s.lon, s.lat], from);
      from = r.i;
      return r.s;
    });
    Object.defineProperty(leg, '_p', { value: p, enumerable: false });
    return p;
  }

  /** Punto della linea più vicino a q: distanza lungo la linea (s) e dalla linea (d), in metri. */
  function project(p, q, fromSeg = 0) {
    let best = { s: 0, d: Infinity, i: 0 };
    const kx = mLon(q[1]);
    for (let i = fromSeg; i < p.pts.length - 1; i++) {
      const a = p.pts[i];
      const b = p.pts[i + 1];
      const ax = (a[0] - q[0]) * kx, ay = (a[1] - q[1]) * M_LAT;
      const bx = (b[0] - q[0]) * kx, by = (b[1] - q[1]) * M_LAT;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { s: p.cum[i] + t * (p.cum[i + 1] - p.cum[i]), d, i };
    }
    return best;
  }

  /** Orario previsto (ms, secondo l'orario del percorso) del passaggio al punto s della linea. */
  function schedAt(leg, s) {
    const p = prepLeg(leg);
    const st = leg.stops;
    if (s <= p.stopS[0]) return st[0].t;
    for (let k = 0; k < st.length - 1; k++) {
      if (s <= p.stopS[k + 1]) {
        const span = p.stopS[k + 1] - p.stopS[k] || 1;
        return st[k].t + ((s - p.stopS[k]) / span) * (st[k + 1].t - st[k].t);
      }
    }
    return st[st.length - 1].t;
  }

  /**
   * Scarto (ms) tra la realtà e gli orari della tratta.
   * live: { delaySec, vehicle: { lat, lon, ts } } dal server (ritardo comunicato e/o posizione del mezzo).
   * La posizione vale solo se il mezzo è già sulla tratta (oltre la fermata dove si sale).
   */
  function offsetFrom(leg, live, now = Date.now()) {
    if (!live) return 0;
    const v = live.vehicle;
    if (v && v.ts && now - v.ts * 1000 < 180_000) {
      const p = prepLeg(leg);
      const r = project(p, [v.lon, v.lat]);
      if (r.d < 120 && r.s > p.stopS[0] + 30 && r.s < p.total - 10) {
        const off = v.ts * 1000 - schedAt(leg, r.s);
        if (off > -15 * 60_000 && off < 90 * 60_000) return off;
      }
    }
    if (live.delaySec != null) return (live.delaySec - (leg.delay || 0)) * 1000;
    return 0;
  }

  /** A che punto è la tratta: ultima fermata superata (indice), fermate che mancano, orari stimati. */
  function progress(leg, off, now = Date.now(), userS = null) {
    const st = leg.stops;
    const n = st.length;
    let passed = 0;
    if (userS != null) {
      const p = prepLeg(leg);
      for (let k = 0; k < n; k++) if (p.stopS[k] <= userS + 25) passed = k;
    } else {
      for (let k = 0; k < n; k++) if (st[k].t + off <= now) passed = k;
    }
    return {
      passed,
      remaining: n - 1 - passed,
      next: st[Math.min(passed + 1, n - 1)],
      dep: st[0].t + off,
      arr: st[n - 1].t + off,
      pen: n >= 2 ? st[n - 2].t + off : st[0].t + off,
    };
  }

  /** Avvisi da dare per una tratta in base all'orario stimato (usato dal server per le notifiche). */
  function dueEvents(leg, off, now = Date.now()) {
    const pr = progress(leg, off, now);
    const out = [];
    if (now >= pr.dep - 3 * 60_000 && now < pr.dep + 60_000) out.push('arriva');
    if (leg.stops.length >= 3 && now >= pr.pen - 20_000 && now < pr.arr) out.push('prossima');
    if (leg.stops.length === 2 && now >= pr.dep + 30_000 && now < pr.arr - 45_000) out.push('prossima');
    if (now >= pr.arr - 45_000 && now < pr.arr + 5 * 60_000) out.push('scendi');
    return { events: out, pr };
  }

  const ICON = { bus: '🚌', tram: '🚋', metro: 'Ⓜ️', treno: '🚆', filobus: '🚎', traghetto: '⛴', funicolare: '🚞', funivia: '🚡' };
  const hhmm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  const lineName = (leg) => `${leg.mode === 'metro' && !leg.lineName ? 'metro ' : ''}${leg.lineName || leg.line}`;
  // "il 64", "il treno", ma "la metro B", "la Metromare"
  const art = (leg) => (leg.mode === 'metro' ? 'la' : 'il');
  const artDa = (leg) => (leg.mode === 'metro' ? 'dalla' : 'dal');

  /** Testi degli avvisi (stessi per voce, schermo e notifiche). */
  function message(kind, leg, pr, nextLeg, now = Date.now()) {
    const icon = ICON[leg.mode] || '🚌';
    const name = lineName(leg);
    const dir = leg.headsign ? ` → ${leg.headsign}` : '';
    if (kind === 'arriva') {
      const m = Math.max(0, Math.round((pr.dep - now) / 60_000));
      return {
        title: `${icon} ${name}${dir}`,
        body: `${m <= 0 ? 'Sta arrivando' : `Passa tra ${m} min`} a ${leg.from.name} (alle ${hhmm(pr.dep)})`,
        say: `${m <= 0 ? 'Sta arrivando' : `Tra ${m} minut${m === 1 ? 'o' : 'i'} passa`} ${art(leg)} ${name}${leg.headsign ? ` per ${leg.headsign}` : ''}`,
      };
    }
    if (kind === 'prossima') {
      return {
        title: `Prossima fermata: ${leg.to.name}`,
        body: `Preparati a scendere ${artDa(leg)} ${name} (arrivo alle ${hhmm(pr.arr)})`,
        say: `Prossima fermata ${leg.to.name}. Preparati a scendere.`,
      };
    }
    // scendi
    let then = 'Sei quasi arrivato a destinazione.';
    if (nextLeg?.type === 'ride') then = `Poi prendi ${art(nextLeg)} ${lineName(nextLeg)} alle ${hhmm(nextLeg.dep)}.`;
    else if (nextLeg?.type === 'walk') then = `Poi cammina ${Math.max(1, Math.round((nextLeg.arr - nextLeg.dep) / 60_000))} min${nextLeg.to?.name ? ` fino a ${nextLeg.to.name}` : ''}.`;
    return { title: `Scendi a ${leg.to.name}`, body: then, say: `Scendi ora: ${leg.to.name}. ${then}` };
  }

  const api = { art, artDa, dist, prepLeg, project, schedAt, offsetFrom, progress, dueEvents, message, hhmm, lineName, ICON };
  if (typeof window !== 'undefined') window.GuideCore = api;
  globalThis.GuideCore = api;
})();
