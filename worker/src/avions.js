// Avions (ADS-B) : découpage d'une zone en cases fixes, appel des sources publiques, normalisation.
//
// Les sources gratuites (adsb.lol, airplanes.live) répondent par « cercle » (centre + rayon, 250 mi nautiques max).
// On découpe donc la zone demandée en cases de 5° sur une grille FIXE : deux écrans qui se chevauchent
// réutilisent les mêmes cases, donc le même cache.

export const SOURCES = ['https://api.adsb.lol', 'https://api.airplanes.live'];
export const CASE_DEG = 5;
export const MAX_CASES = 24;
export const MAX_AVIONS = 4000;

const NM_PAR_DEG = 60;

/** Longitude ramenée dans [-180, 180). */
export function lon180(x) {
  return ((((x + 180) % 360) + 360) % 360) - 180;
}

/** Pas de longitude (en degrés) d'une rangée de cases : ~5° d'arc à la latitude la plus large de la rangée. */
export function pasLon(rang) {
  const latMin = rang * CASE_DEG;
  const latMax = latMin + CASE_DEG;
  const plusLarge = latMin <= 0 && latMax >= 0 ? 0 : Math.min(Math.abs(latMin), Math.abs(latMax));
  const ideal = Math.min(60, CASE_DEG / Math.cos((plusLarge * Math.PI) / 180));
  return 360 / Math.ceil(360 / ideal); // un nombre entier de colonnes fait le tour du monde
}

/** Distance entre deux points, en milles nautiques (haversine). */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Le moins de requêtes possible : si la zone tient dans un seul cercle (≤ 240 mi nautiques de rayon), un seul appel,
 * centré sur la zone (centre arrondi à 0,25° et rayon à la dizaine supérieure, pour que des écrans voisins partagent le cache).
 * Sinon, la grille fixe de cases de 5°. Renvoie null si la zone est trop grande.
 */
export function cases(s, w, n, e, max = MAX_CASES) {
  s = Math.max(-90, s);
  n = Math.min(90, n);
  if (!(s < n) || !(w <= e)) return [];
  const lat = Math.round(((s + n) / 2) * 4) / 4;
  const lon = Math.round((w + e) * 2) / 4; // (w+e)/2 arrondi à 0,25°
  const rayonBrut = Math.max(...[[s, w], [s, e], [n, w], [n, e]].map(([y, x]) => distanceNm(lat, lon, y, x)));
  const rayon = Math.ceil((rayonBrut + 5) / 10) * 10;
  if (rayon <= 240) return [{ cle: `z:${lat}:${lon}:${rayon}`, lat, lon: lon180(lon), rayon }];
  return grille(s, w, n, e, max);
}

/**
 * Cases couvrant [s,n] × [w,e] (w ≤ e, en degrés ; e peut dépasser 180 si la zone passe l'antiméridien).
 * Chaque case : { cle, lat, lon, rayon } (centre, rayon en mi nautiques).
 * Renvoie null si la zone demande plus de MAX_CASES cases.
 */
export function grille(s, w, n, e, max = MAX_CASES) {
  s = Math.max(-90, s);
  n = Math.min(90, n);
  if (!(s < n) || !(w <= e)) return [];
  const sortie = [];
  const seen = new Set();
  for (let rang = Math.floor(s / CASE_DEG); rang <= Math.floor((n - 1e-9) / CASE_DEG); rang++) {
    const latMin = rang * CASE_DEG;
    const lat = latMin + CASE_DEG / 2;
    const pas = pasLon(rang);
    for (let col = Math.floor(w / pas); col <= Math.floor((e - 1e-9) / pas); col++) {
      // Colonnes ramenées sur le tour du monde, pour que la case ait toujours la même clé.
      const nbCol = Math.ceil(360 / pas);
      const c = ((col % nbCol) + nbCol) % nbCol;
      const cle = `${rang}:${c}`;
      if (seen.has(cle)) continue;
      seen.add(cle);
      // La grille démarre à 0° de longitude ; lon180 ramène le centre dans [-180, 180).
      const centreLon = lon180(c * pas + pas / 2);
      const demiLargeNm = (pas / 2) * Math.cos(((Math.min(Math.abs(latMin), Math.abs(latMin + CASE_DEG)) * Math.PI) / 180)) * NM_PAR_DEG;
      const demiHautNm = (CASE_DEG / 2) * NM_PAR_DEG;
      const rayon = Math.min(250, Math.ceil(Math.hypot(demiLargeNm, demiHautNm)) + 5);
      sortie.push({ cle, lat, lon: centreLon, rayon });
      if (sortie.length > max) return null;
    }
  }
  return sortie;
}

/**
 * Découpe une zone éventuellement à cheval sur l'antiméridien (w > e) en zones simples.
 * Renvoie une liste de [s, w, n, e] avec w ≤ e.
 */
export function zones(s, w, n, e) {
  if (e - w >= 360) return [[s, -180, n, 180]];
  w = lon180(w);
  e = lon180(e);
  if (w <= e) return [[s, w, n, e]];
  return [
    [s, w, n, 180],
    [s, -180, n, e],
  ];
}

/** Un avion de la réponse des sources → forme compacte, ou null s'il n'a pas de position. */
export function normaliser(a) {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || !a.hex) return null;
  const sol = a.alt_baro === 'ground';
  const alt = sol ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : null;
  return {
    h: String(a.hex).toLowerCase(),
    c: typeof a.flight === 'string' ? a.flight.trim() : '',
    r: a.r ?? '',
    t: a.t ?? '',
    a: alt, // pieds
    g: sol ? 1 : 0,
    s: typeof a.gs === 'number' ? Math.round(a.gs) : null, // nœuds
    k: typeof a.track === 'number' ? Math.round(a.track) : typeof a.true_heading === 'number' ? Math.round(a.true_heading) : null,
    v: typeof a.baro_rate === 'number' ? a.baro_rate : null, // pieds/min
    q: a.squawk ?? '',
    y: a.lat,
    x: a.lon,
    cat: a.category ?? '',
  };
}

/** Récupère une case auprès des sources, la première qui répond. Renvoie une liste d'avions compacts. */
export async function chargerCase(c, fetcher = fetch) {
  const erreurs = [];
  const nom = (base) => base.replace(/^https:\/\/api\./, '');
  for (const base of SOURCES) {
    try {
      const rep = await fetcher(`${base}/v2/point/${c.lat.toFixed(3)}/${c.lon.toFixed(3)}/${c.rayon}`, {
        headers: { accept: 'application/json', 'user-agent': 'carte-live (usage personnel)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!rep.ok) {
        erreurs.push(`${nom(base)} ${rep.status}`);
        continue;
      }
      const json = await rep.json();
      const liste = Array.isArray(json.ac) ? json.ac : Array.isArray(json.aircraft) ? json.aircraft : [];
      return liste.map(normaliser).filter(Boolean);
    } catch (err) {
      erreurs.push(`${nom(base)} ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(erreurs.join(', ') || 'aucune source');
}

/** Fusionne des listes d'avions (sans doublon par code OACO), garde ceux qui sont dans la zone. */
export function fusionner(listes, boites) {
  const vus = new Map();
  for (const liste of listes) {
    for (const a of liste) {
      if (vus.has(a.h)) continue;
      if (!boites.some(([s, w, n, e]) => a.y >= s && a.y <= n && a.x >= w && a.x <= e)) continue;
      vus.set(a.h, a);
      if (vus.size >= MAX_AVIONS) return [...vus.values()];
    }
  }
  return [...vus.values()];
}

/** Exécute les tâches (fonctions async) en parallèle, `n` à la fois : les sources gratuites refusent les rafales. */
export async function parLots(taches, n = 4) {
  const resultats = new Array(taches.length);
  let suivant = 0;
  async function travailleur() {
    while (suivant < taches.length) {
      const i = suivant++;
      try {
        resultats[i] = { status: 'fulfilled', value: await taches[i]() };
      } catch (reason) {
        resultats[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, taches.length) }, travailleur));
  return resultats;
}
