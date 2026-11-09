/* Carte live : fond MapLibre + couche avions (via le Worker). D'autres couches viendront s'ajouter à côté. */
(() => {
  'use strict';
  const CFG = window.CARTE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const sombre = () => !window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches;

  const ZOOM_MIN_AVIONS = 4.2; // en dessous, la zone dépasserait la limite des sources
  const RAFRAICHIR_MS = 8000;
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
  let selection = null; // code OACI de l'avion ouvert
  let suivi = false;

  function installerCouches() {
    if (!carte.hasImage('avion')) carte.addImage('avion', iconeAvion(), { sdf: true });
    if (!carte.getSource('avions')) carte.addSource('avions', { type: 'geojson', data: avionsGeo, promoteId: 'h' });
    // Police : on reprend celle du fond de carte, sinon pas d'étiquettes (chaque style a ses propres polices).
    const police = (carte.getStyle().layers.find((l) => l.layout && l.layout['text-font']) || {}).layout?.['text-font'];
    const taille = ['interpolate', ['linear'], ['zoom'], 3, 0.32, 8, 0.5, 12, 0.7];
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

  function versGeo(liste) {
    return {
      type: 'FeatureCollection',
      features: liste.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.x, a.y] },
        properties: { h: a.h, c: a.c, r: a.r, t: a.t, a: a.a, g: a.g, s: a.s, k: a.k, v: a.v, q: a.q, u: SQUAWKS[a.q] ? 1 : 0 },
      })),
    };
  }

  function vider(texte) {
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
      avionsGeo = versGeo(data.avions);
      carte.getSource('avions')?.setData(avionsGeo);
      derniereMaj = Date.now();
      $('compteur').textContent = `✈ ${data.n.toLocaleString('fr-BE')}`;
      message(data.partiel ? 'Données partielles : une source ne répond pas' : '', false);
      majFiche();
    } catch (err) {
      if (err.name === 'AbortError') return;
      message(`Avions indisponibles : ${echapper(err.message)}`, true);
    } finally {
      enCours = false;
    }
  }

  let minuteur = null;
  const planifier = (delai) => { clearTimeout(minuteur); minuteur = setTimeout(async () => { if (!document.hidden) await charger(); planifier(RAFRAICHIR_MS); }, delai); };
  carte.on('moveend', () => { ecrire('carte.vue', JSON.stringify({ centre: carte.getCenter().toArray(), zoom: carte.getZoom() })); planifier(350); });
  carte.once('load', () => planifier(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - derniereMaj > RAFRAICHIR_MS) planifier(0); });

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
    majFiche();
  }
  function fermer() {
    selection = null;
    suivi = false;
    $('suivre').classList.remove('actif');
    $('suivre').textContent = 'Suivre';
    $('fiche').hidden = true;
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
