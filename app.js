/* Carte live : fond MapLibre + couche avions (via le Worker). D'autres couches viendront s'ajouter à côté. */
(() => {
  'use strict';
  const CFG = window.CARTE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const sombre = () => !window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches;

  const ZOOM_MIN_AVIONS = 4.2; // en dessous, la zone dépasserait la limite des sources
  const RAFRAICHIR_MS = 4000; // interrogation des sources
  const LISSAGE_MS = 1000; // entre deux réponses, les avions avancent selon leur vitesse et leur cap
  const SQUAWKS = { 7500: 'Détournement (7500)', 7600: 'Panne radio (7600)', 7700: 'Urgence générale (7700)' };

  // ── Mémoire de la dernière vue (silencieuse si le navigateur refuse le stockage dans le cadre du hub) ──
  const lire = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sans importance */ } };
  let vue = { centre: [4.88, 50.54], zoom: 5.2 };
  try { const v = JSON.parse(lire('carte.vue') || 'null'); if (v && Array.isArray(v.centre) && Number.isFinite(v.zoom)) vue = v; } catch { /* vue par défaut */ }

  // ── Carte ──
  const carte = new maplibregl.Map({
    container: 'carte',
    style: sombre() ? CFG.styleSombre : CFG.styleClair,
    center: vue.centre,
    zoom: vue.zoom,
    minZoom: 1.5,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false,
  });
  carte.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Avions : adsb.lol / airplanes.live' }));
  carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  carte.touchZoomRotate.disableRotation();

  // ── Icône d'avion (dessinée ici, teintée par altitude grâce au mode « SDF ») ──
  function iconeAvion() {
    const n = 64;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fill(new Path2D('M32 4C35 4 36 10 36 16L36 26L58 40L58 45L36 39L36 50L43 55L43 59L32 56L21 59L21 55L28 50L28 39L6 45L6 40L28 26L28 16C28 10 29 4 32 4Z'));
    return g.getImageData(0, 0, n, n);
  }

  const COULEUR_ALT = ['case', ['==', ['get', 'g'], 1], '#9aa5b1',
    ['interpolate', ['linear'], ['coalesce', ['get', 'a'], 0], 0, '#ffd23f', 10000, '#7ed957', 28000, '#27c4f5', 40000, '#b06cff']];

  let avionsGeo = { type: 'FeatureCollection', features: [] };
  let routeGeo = { type: 'FeatureCollection', features: [] }; // trajet de l'avion ouvert : départ → avion → arrivée
  let selection = null; // code OACI de l'avion ouvert
  let suivi = false;

  function installerCouches() {
    if (!carte.hasImage('avion')) carte.addImage('avion', iconeAvion(), { sdf: true });
    if (!carte.getSource('avions')) carte.addSource('avions', { type: 'geojson', data: avionsGeo, promoteId: 'h' });
    // Police : on reprend celle du fond de carte, sinon pas d'étiquettes (chaque style a ses propres polices).
    const police = (carte.getStyle().layers.find((l) => l.layout && l.layout['text-font']) || {}).layout?.['text-font'];
    const taille = ['interpolate', ['linear'], ['zoom'], 3, 0.32, 8, 0.5, 12, 0.7];
    if (!carte.getSource('route')) carte.addSource('route', { type: 'geojson', data: routeGeo });
    if (!carte.getLayer('route-fait'))
      carte.addLayer({ id: 'route-fait', type: 'line', source: 'route', filter: ['==', ['get', 'p'], 'fait'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#27c4f5', 'line-width': 2.5, 'line-opacity': 0.9 } });
    if (!carte.getLayer('route-reste'))
      carte.addLayer({ id: 'route-reste', type: 'line', source: 'route', filter: ['==', ['get', 'p'], 'reste'], paint: { 'line-color': '#27c4f5', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } });
    if (!carte.getLayer('route-aeroports'))
      carte.addLayer({ id: 'route-aeroports', type: 'circle', source: 'route', filter: ['==', ['get', 'p'], 'aeroport'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#27c4f5', 'circle-stroke-width': 2.5 } });
    if (!carte.getLayer('avions-urgence'))
      carte.addLayer({ id: 'avions-urgence', type: 'circle', source: 'avions', filter: ['==', ['get', 'u'], 1],
        paint: { 'circle-radius': 16, 'circle-color': '#ff4d4f', 'circle-opacity': 0.35, 'circle-stroke-color': '#ff4d4f', 'circle-stroke-width': 2 } });
    if (!carte.getLayer('avions-selection'))
      carte.addLayer({ id: 'avions-selection', type: 'circle', source: 'avions', filter: ['==', ['get', 'h'], ''],
        paint: { 'circle-radius': 18, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    if (!carte.getLayer('avions'))
      carte.addLayer({ id: 'avions', type: 'symbol', source: 'avions',
        layout: { 'icon-image': 'avion', 'icon-size': taille, 'icon-rotate': ['coalesce', ['get', 'k'], 0], 'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
          ...(police ? { 'text-field': ['step', ['zoom'], '', 7.5, ['get', 'c']], 'text-font': police, 'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true } : {}) },
        paint: { 'icon-color': COULEUR_ALT, 'icon-halo-color': 'rgba(0,0,0,.55)', 'icon-halo-width': 1,
          ...(police ? { 'text-color': sombre() ? '#e8edf3' : '#14202b', 'text-halo-color': sombre() ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.9)', 'text-halo-width': 1.2 } : {}) } });
    carte.setFilter('avions-selection', ['==', ['get', 'h'], selection || '']);
    carte.getSource('avions').setData(avionsGeo);
    carte.getSource('route').setData(routeGeo);
  }
  carte.on('style.load', installerCouches);

  // La carte suit le thème du téléphone ; le hub colore sa barre d'état avec la couleur annoncée ci-dessous.
  const annoncerCouleur = () => { try { window.parent !== window && window.parent.postMessage({ hubThemeColor: sombre() ? '#0e1116' : '#ffffff' }, '*'); } catch { /* hors hub */ } };
  annoncerCouleur();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    carte.setStyle(sombre() ? CFG.styleSombre : CFG.styleClair);
    annoncerCouleur();
  });

  // ── Messages ──
  function message(html, erreur) {
    const i = $('info');
    if (!html) { i.hidden = true; return; }
    i.innerHTML = html;
    i.classList.toggle('erreur', !!erreur);
    i.hidden = false;
  }
  const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── Chargement des avions ──
  let controleur = null;
  let derniereMaj = 0;
  let enCours = false;

  function zone() {
    const b = carte.getBounds();
    return { s: Math.max(-90, b.getSouth()), n: Math.min(90, b.getNorth()), w: b.getWest(), e: b.getEast() };
  }

  /** Liste compacte du Worker → GeoJSON. `dt` : secondes écoulées depuis la réponse ; chaque avion en vol est avancé de vitesse × dt. */
  function versGeo(liste, dt = 0) {
    return {
      type: 'FeatureCollection',
      features: liste.map((a) => {
        let x = a.x, y = a.y, alt = a.a;
        if (dt > 0 && !a.g && a.s > 30 && a.k != null) {
          const d = (a.s * dt) / 3600; // milles nautiques parcourus
          const r = (a.k * Math.PI) / 180;
          y += (d * Math.cos(r)) / 60;
          x += (d * Math.sin(r)) / (60 * Math.max(0.05, Math.cos((a.y * Math.PI) / 180)));
          if (alt != null && a.v) alt = Math.max(0, Math.round(alt + (a.v * dt) / 60));
        }
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [x, y] },
          properties: { h: a.h, c: a.c, r: a.r, t: a.t, a: alt, g: a.g, s: a.s, k: a.k, v: a.v, q: a.q, u: SQUAWKS[a.q] ? 1 : 0 },
        };
      }),
    };
  }

  let brut = []; // dernière réponse du Worker, telle quelle

  /** Place les avions là où ils sont maintenant (dernière réponse + temps écoulé). */
  function projeter() {
    avionsGeo = versGeo(brut, Math.min(40, (Date.now() - derniereMaj) / 1000));
    carte.getSource('avions')?.setData(avionsGeo);
    majFiche();
  }

  function vider(texte) {
    brut = [];
    avionsGeo = { type: 'FeatureCollection', features: [] };
    carte.getSource('avions')?.setData(avionsGeo);
    $('compteur').textContent = '✈ —';
    message(texte);
  }

  async function charger() {
    if (!CFG.worker) {
      message('Adresse du Worker manquante : renseigne <code>worker</code> dans <code>config.js</code> (voir le README).', true);
      return;
    }
    if (!carte.isStyleLoaded() && !carte.getSource('avions')) return;
    if (carte.getZoom() < ZOOM_MIN_AVIONS) { controleur?.abort(); vider('Zoome pour voir les avions'); return; }
    controleur?.abort();
    controleur = new AbortController();
    const { s, w, n, e } = zone();
    enCours = true;
    try {
      const rep = await fetch(`${CFG.worker.replace(/\/+$/, '')}/avions?s=${s.toFixed(3)}&w=${w.toFixed(3)}&n=${n.toFixed(3)}&e=${e.toFixed(3)}`, { signal: controleur.signal });
      const data = await rep.json().catch(() => ({}));
      if (!rep.ok) throw new Error(data.error || `Erreur ${rep.status}`);
      if (data.trop) { vider('Zone trop grande : zoome un peu'); return; }
      brut = data.avions;
      derniereMaj = Date.now();
      projeter();
      $('compteur').textContent = `✈ ${data.n.toLocaleString('fr-BE')}`;
      message(data.partiel ? 'Données partielles : une source ne répond pas' : '', false);
    } catch (err) {
      if (err.name === 'AbortError') return;
      message(`Avions indisponibles : ${echapper(err.message)}`, true);
    } finally {
      enCours = false;
    }
  }

  // Mouvement fluide : toutes les secondes (toutes les 2 s quand il y a beaucoup d'avions), on avance les avions de la dernière réponse.
  let dernierLissage = 0;
  setInterval(() => {
    if (document.hidden || !brut.length) return;
    if (brut.length > 1500 && Date.now() - dernierLissage < 2 * LISSAGE_MS - 100) return;
    dernierLissage = Date.now();
    projeter();
  }, LISSAGE_MS);

  let minuteur = null;
  const planifier = (delai) => { clearTimeout(minuteur); minuteur = setTimeout(async () => { if (!document.hidden) await charger(); planifier(RAFRAICHIR_MS); }, delai); };
  carte.on('moveend', () => { ecrire('carte.vue', JSON.stringify({ centre: carte.getCenter().toArray(), zoom: carte.getZoom() })); planifier(350); });
  carte.once('load', () => planifier(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - derniereMaj > RAFRAICHIR_MS) planifier(0); });

  // ── Trajet : grand cercle entre deux points, distance, base de routes ──
  const RAD = Math.PI / 180;
  const distanceNm = (y1, x1, y2, x2) => {
    const a = Math.sin(((y2 - y1) * RAD) / 2) ** 2 + Math.cos(y1 * RAD) * Math.cos(y2 * RAD) * Math.sin(((x2 - x1) * RAD) / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  /** Points du grand cercle de [x1,y1] à [x2,y2] (longitudes continues, pour ne pas faire le tour de la carte à l'antiméridien). */
  function arc([x1, y1], [x2, y2], n = 48) {
    const v = (x, y) => [Math.cos(y * RAD) * Math.cos(x * RAD), Math.cos(y * RAD) * Math.sin(x * RAD), Math.sin(y * RAD)];
    const a = v(x1, y1), b = v(x2, y2);
    const w = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    if (w < 1e-6) return [[x1, y1], [x2, y2]];
    const pts = [];
    let prev = x1;
    for (let i = 0; i <= n; i++) {
      const t = i / n, k1 = Math.sin((1 - t) * w) / Math.sin(w), k2 = Math.sin(t * w) / Math.sin(w);
      const p = [k1 * a[0] + k2 * b[0], k1 * a[1] + k2 * b[1], k1 * a[2] + k2 * b[2]];
      let x = Math.atan2(p[1], p[0]) / RAD;
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
      prev = x;
      pts.push([x, Math.asin(p[2]) / RAD]);
    }
    return pts;
  }

  const routes = new Map(); // indicatif → { route } | null (inconnu) ; absent = pas encore demandé
  async function demanderRoute(c) {
    if (!c || routes.has(c) || !CFG.worker) return;
    routes.set(c, null);
    try {
      const rep = await fetch(`${CFG.worker.replace(/\/+$/, '')}/route?c=${encodeURIComponent(c)}`);
      if (!rep.ok) { routes.delete(c); return; } // on réessaiera à la prochaine ouverture
      const data = await rep.json();
      routes.set(c, data.route || null);
    } catch { routes.delete(c); }
    if (selection && trouver(selection)?.properties.c === c) majFiche();
  }

  /** Trait départ → avion (plein) → arrivée (pointillé) et aéroports ; vide si pas de route connue. */
  function tracerRoute(r, avion) {
    const dep = r.etapes[0], arr = r.etapes[r.etapes.length - 1];
    const feats = [];
    if (avion) {
      feats.push({ type: 'Feature', properties: { p: 'fait' }, geometry: { type: 'LineString', coordinates: arc([dep.x, dep.y], avion) } });
      feats.push({ type: 'Feature', properties: { p: 'reste' }, geometry: { type: 'LineString', coordinates: arc(avion, [arr.x, arr.y]) } });
    }
    for (const e of [dep, arr]) feats.push({ type: 'Feature', properties: { p: 'aeroport' }, geometry: { type: 'Point', coordinates: [e.x, e.y] } });
    routeGeo = { type: 'FeatureCollection', features: feats };
    carte.getSource('route')?.setData(routeGeo);
  }
  function effacerRoute() {
    routeGeo = { type: 'FeatureCollection', features: [] };
    carte.getSource('route')?.setData(routeGeo);
  }

  // ── Fiche d'un avion ──
  const FL = (a) => (a >= 6000 ? `FL${String(Math.round(a / 100)).padStart(3, '0')}` : `${a.toLocaleString('fr-BE')} ft`);
  function trouver(h) { return avionsGeo.features.find((f) => f.properties.h === h); }

  function majFiche() {
    const f = selection && trouver(selection);
    if (!selection) return;
    if (!f) { $('f-sous').textContent = 'Hors de l’écran ou plus reçu'; return; }
    const p = f.properties;
    const [x, y] = f.geometry.coordinates;
    $('f-titre').textContent = p.c || p.r || p.h.toUpperCase();
    $('f-sous').textContent = [p.t, p.r].filter(Boolean).join(' · ') || 'Type inconnu';
    const r = routes.get(p.c);
    $('f-trajet').hidden = !r;
    if (r) {
      const dep = r.etapes[0], arr = r.etapes[r.etapes.length - 1];
      const code = (e) => e.iata || e.icao;
      const reste = Math.round(distanceNm(y, x, arr.y, arr.x));
      $('f-codes').textContent = `${code(dep)} → ${code(arr)}`;
      $('f-noms').textContent = `${dep.ville || dep.nom} → ${arr.ville || arr.nom}${p.g ? '' : ` · ${reste.toLocaleString('fr-BE')} NM restants`}`;
      tracerRoute(r, p.g ? null : [x, y]);
    } else if (routeGeo.features.length) effacerRoute();
    const al = $('f-alerte');
    al.hidden = !SQUAWKS[p.q];
    al.textContent = SQUAWKS[p.q] ? `⚠ Transpondeur : ${SQUAWKS[p.q]}` : '';
    const vs = p.v == null ? '—' : `${p.v > 0 ? '↑' : p.v < 0 ? '↓' : ''}${Math.abs(p.v).toLocaleString('fr-BE')}`;
    const cases = [
      ['Altitude', p.g ? 'Au sol' : p.a == null ? '—' : FL(p.a)],
      ['Vitesse sol', p.s == null ? '—' : `${p.s} kt`],
      ['Cap', p.k == null ? '—' : `${String(p.k).padStart(3, '0')}°`],
      ['V/S ft/min', vs],
      ['Squawk', p.q || '—'],
      ['OACI', p.h.toUpperCase()],
      ['Position', `${y.toFixed(3)}°, ${x.toFixed(3)}°`],
    ];
    $('f-grille').innerHTML = cases.map(([t, v]) => `<div${t === 'Position' ? ' class="large"' : ''}><dt>${t}</dt><dd>${echapper(v)}</dd></div>`).join('');
    $('f-lien').href = `https://adsb.lol/?icao=${encodeURIComponent(p.h)}`;
    if (suivi) carte.easeTo({ center: [x, y], duration: 900 });
  }

  function ouvrir(h) {
    selection = h;
    carte.getLayer('avions-selection') && carte.setFilter('avions-selection', ['==', ['get', 'h'], h]);
    $('fiche').hidden = false;
    effacerRoute();
    majFiche();
    demanderRoute(trouver(h)?.properties.c);
  }
  function fermer() {
    selection = null;
    suivi = false;
    $('suivre').classList.remove('actif');
    $('suivre').textContent = 'Suivre';
    $('fiche').hidden = true;
    effacerRoute();
    carte.getLayer('avions-selection') && carte.setFilter('avions-selection', ['==', ['get', 'h'], '']);
  }
  carte.on('click', (ev) => {
    // Clic dans le vide : on ferme. Le toucher d'un avion est élargi pour les doigts.
    const pt = [[ev.point.x - 14, ev.point.y - 14], [ev.point.x + 14, ev.point.y + 14]];
    const touche = carte.queryRenderedFeatures(pt, { layers: ['avions'] });
    if (touche.length) ouvrir(touche[0].properties.h);
    else if (selection) fermer();
  });
  carte.on('mouseenter', 'avions', () => { carte.getCanvas().style.cursor = 'pointer'; });
  carte.on('mouseleave', 'avions', () => { carte.getCanvas().style.cursor = ''; });
  $('fermer').addEventListener('click', fermer);
  $('suivre').addEventListener('click', () => {
    suivi = !suivi;
    $('suivre').classList.toggle('actif', suivi);
    $('suivre').textContent = suivi ? 'Suivi actif' : 'Suivre';
    if (suivi) majFiche();
  });
  carte.on('dragstart', () => { if (suivi) { suivi = false; $('suivre').classList.remove('actif'); $('suivre').textContent = 'Suivre'; } });

  // ── Localisation ──
  $('localiser').addEventListener('click', () => {
    if (!navigator.geolocation) return message('Localisation indisponible sur cet appareil', true);
    navigator.geolocation.getCurrentPosition(
      (p) => carte.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(carte.getZoom(), 7), duration: 1200 }),
      () => { message('Localisation refusée ou impossible', true); setTimeout(() => message(''), 3500); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  });

  window.__carte = carte; // pratique pour déboguer depuis la console
})();
