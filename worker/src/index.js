// Worker Cloudflare de la carte live : relais vers les sources publiques (CORS, cache, clés cachées).
// Une route par couche : /avions aujourd'hui ; navires, conflits et caméras viendront s'ajouter dans `routes`.

import { cases, chargerCase, fusionner, parLots, zones } from './avions.js';
import { chargerRoute, indicatifValide } from './route.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });

const nombre = (v) => (v === null || v === '' ? NaN : Number(v));

/**
 * Une case, avec le cache de bord (Cloudflare) : 3 s partagées entre tous les écrans, et une copie de secours de 2 minutes
 * servie si les sources refusent (limites de débit) : mieux vaut un avion vieux de 20 s que pas d'avion.
 */
async function caseAvecCache(c, ctx, fetcher) {
  const cache = globalThis.caches?.default;
  const cleFrais = new Request(`https://cache.carte.invalid/avions/${c.cle}`);
  const cleSecours = new Request(`https://cache.carte.invalid/avions-secours/${c.cle}`);
  if (cache) {
    const hit = await cache.match(cleFrais);
    if (hit) return hit.json();
  }
  try {
    const liste = await chargerCase(c, fetcher);
    if (cache) {
      const corps = JSON.stringify(liste);
      const entetes = (age) => ({ 'content-type': 'application/json', 'cache-control': `public, max-age=${age}` });
      ctx?.waitUntil?.(Promise.all([cache.put(cleFrais, new Response(corps, { headers: entetes(3) })), cache.put(cleSecours, new Response(corps, { headers: entetes(120) }))]));
    }
    return liste;
  } catch (err) {
    const secours = cache && (await cache.match(cleSecours));
    if (secours) return secours.json();
    throw err;
  }
}

export async function avions(url, ctx, fetcher = fetch) {
  const [s, w, n, e] = ['s', 'w', 'n', 'e'].map((k) => nombre(url.searchParams.get(k)));
  if ([s, w, n, e].some((x) => !Number.isFinite(x))) return json({ error: 'Paramètres s, w, n, e attendus (degrés)' }, 400);
  if (s >= n) return json({ error: 'Zone vide' }, 400);

  const boites = zones(s, w, n, e);
  const toutes = [];
  for (const [bs, bw, bn, be] of boites) {
    const liste = cases(bs, bw, bn, be);
    if (liste === null) return json({ trop: true, avions: [], n: 0 });
    toutes.push(...liste);
  }
  // Une case peut être demandée par deux boîtes (antiméridien) : une seule fois.
  const uniques = [...new Map(toutes.map((c) => [c.cle, c])).values()];
  if (uniques.length > 24) return json({ trop: true, avions: [], n: 0 });

  const resultats = await parLots(uniques.map((c) => () => caseAvecCache(c, ctx, fetcher)), 4);
  const ok = resultats.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length === 0) {
    const raison = [...new Set(resultats.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason)))].join(' ; ') || 'inconnue';
    return json({ error: `Sources indisponibles (${raison})` }, 502);
  }
  const liste = fusionner(ok, boites);
  return json({ t: Date.now(), n: liste.length, partiel: ok.length < resultats.length, avions: liste }, 200, { 'cache-control': 'no-store' });
}

/** Départ et destination d'un vol (par indicatif) : une route change rarement, donc 6 h de cache (30 min si le vol est inconnu). */
export async function route(url, ctx, fetcher = fetch) {
  const c = (url.searchParams.get('c') || '').trim().toUpperCase();
  if (!indicatifValide(c)) return json({ error: 'Indicatif attendu (ex. BEL1ZT)' }, 400);
  const cache = globalThis.caches?.default;
  const cle = new Request(`https://cache.carte.invalid/route/${c}`);
  if (cache) {
    const hit = await cache.match(cle);
    if (hit) return json(await hit.json(), 200, { 'cache-control': 'public, max-age=3600' });
  }
  const r = await chargerRoute(c, fetcher);
  const corps = { route: r };
  if (cache) ctx?.waitUntil?.(cache.put(cle, new Response(JSON.stringify(corps), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${r ? 21600 : 1800}` } })));
  return json(corps, 200, { 'cache-control': 'public, max-age=3600' });
}

const routes = {
  '/avions': avions,
  '/route': route,
};

export default {
  async fetch(request, _env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'GET seulement' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/sante') return json({ ok: true, routes: Object.keys(routes) });
    const route = routes[url.pathname];
    if (!route) return json({ error: 'Introuvable' }, 404);
    try {
      return await route(url, ctx);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Erreur interne' }, 500);
    }
  },
};
