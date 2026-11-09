// Worker Cloudflare de la carte live : relais vers les sources publiques (CORS, cache, clés cachées).
// Une route par couche : /avions aujourd'hui ; navires, conflits et caméras viendront s'ajouter dans `routes`.

import { cases, chargerCase, fusionner, zones } from './avions.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });

const nombre = (v) => (v === null || v === '' ? NaN : Number(v));

/** Une case, avec le cache de bord (Cloudflare) : 6 s, partagé entre tous les écrans. */
async function caseAvecCache(c, ctx, fetcher) {
  const cache = globalThis.caches?.default;
  const cleCache = new Request(`https://cache.carte.invalid/avions/${c.cle}`);
  if (cache) {
    const hit = await cache.match(cleCache);
    if (hit) return hit.json();
  }
  const liste = await chargerCase(c, fetcher);
  if (cache) {
    const rep = new Response(JSON.stringify(liste), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=6' } });
    ctx?.waitUntil?.(cache.put(cleCache, rep));
  }
  return liste;
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

  const resultats = await Promise.allSettled(uniques.map((c) => caseAvecCache(c, ctx, fetcher)));
  const ok = resultats.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length === 0) {
    const raison = resultats[0]?.status === 'rejected' ? String(resultats[0].reason?.message ?? resultats[0].reason) : 'inconnue';
    return json({ error: `Sources indisponibles (${raison})` }, 502);
  }
  const liste = fusionner(ok, boites);
  return json({ t: Date.now(), n: liste.length, partiel: ok.length < resultats.length, avions: liste }, 200, { 'cache-control': 'no-store' });
}

const routes = {
  '/avions': avions,
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
