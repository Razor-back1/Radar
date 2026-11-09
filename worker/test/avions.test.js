import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avions } from '../src/index.js';
import { cases, chargerCase, distanceNm, fusionner, grille, normaliser, parLots, pasLon, zones } from '../src/avions.js';

test('la grille d\'une petite zone (Belgique) tient en peu de cases, avec des rayons permis par les sources', () => {
  const liste = grille(49.4, 2.5, 51.6, 6.5);
  assert.ok(liste && liste.length >= 1 && liste.length <= 6, `cases: ${liste?.length}`);
  for (const c of liste) {
    assert.ok(c.rayon > 0 && c.rayon <= 250, `rayon ${c.rayon}`);
    assert.ok(c.lon >= -180 && c.lon < 180);
  }
});

test('une zone qui tient dans un cercle = un seul appel, centré sur la zone et assez large pour la couvrir', () => {
  const liste = cases(49.4, 2.5, 51.6, 6.5);
  assert.equal(liste.length, 1);
  const [c] = liste;
  assert.ok(Math.abs(c.lat - 50.5) <= 0.13 && Math.abs(c.lon - 4.5) <= 0.13);
  for (const [y, x] of [[49.4, 2.5], [49.4, 6.5], [51.6, 2.5], [51.6, 6.5]]) assert.ok(distanceNm(c.lat, c.lon, y, x) <= c.rayon, 'un coin dépasse le cercle');
  assert.ok(c.rayon <= 250);
});

test('une zone plus grande qu\'un cercle passe à la grille', () => {
  const liste = cases(44, -4, 56, 14);
  assert.ok(liste && liste.length > 1 && liste.length <= 24, `cases: ${liste?.length}`);
});

test('la grille est fixe : la même case garde la même clé d\'un écran à l\'autre', () => {
  const a = grille(50.1, 4.1, 50.9, 4.9);
  const b = grille(49.0, 3.0, 51.9, 5.9);
  const clesB = new Set(b.map((c) => c.cle));
  for (const c of a) assert.ok(clesB.has(c.cle));
});

test('les cases font un nombre entier de colonnes autour du monde, à toutes les latitudes', () => {
  for (let rang = -18; rang < 18; rang++) assert.ok(Math.abs(360 / pasLon(rang) - Math.round(360 / pasLon(rang))) < 1e-9);
});

test('le monde entier dépasse la limite : on demande de zoomer', () => {
  assert.equal(cases(-60, -180, 80, 180), null);
  assert.equal(grille(-60, -180, 80, 180), null);
});

test('une zone à cheval sur l\'antiméridien est coupée en deux', () => {
  assert.deepEqual(zones(-10, 170, 10, -170), [
    [-10, 170, 10, 180],
    [-10, -180, 10, -170],
  ]);
  assert.deepEqual(zones(-10, -10, 10, 10), [[-10, -10, 10, 10]]);
  assert.deepEqual(zones(-10, -400, 10, 400), [[-10, -180, 10, 180]]);
});

test('normaliser : au sol, altitude absente, sans position', () => {
  assert.equal(normaliser({ hex: 'ABC123', lat: 50, lon: 4, alt_baro: 'ground', flight: 'SN123  ', gs: 12.4 }).g, 1);
  assert.equal(normaliser({ hex: 'ABC123', lat: 50, lon: 4, alt_baro: 'ground' }).a, 0);
  const a = normaliser({ hex: 'ABC123', lat: 50, lon: 4, alt_baro: 36000, flight: 'SN123  ', gs: 451.6, track: 270.4, t: 'B738', r: 'OO-ABC', squawk: '7700' });
  assert.deepEqual([a.c, a.a, a.s, a.k, a.t, a.q], ['SN123', 36000, 452, 270, 'B738', '7700']);
  assert.equal(normaliser({ hex: 'x', alt_baro: 100 }), null);
});

test('chargerCase : bascule sur la deuxième source si la première échoue', async () => {
  const appels = [];
  const fetcher = async (u) => {
    appels.push(u);
    if (u.startsWith('https://api.adsb.lol')) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify({ ac: [{ hex: 'aa', lat: 1, lon: 2, alt_baro: 1000 }, { hex: 'bb' }] }));
  };
  const liste = await chargerCase({ lat: 50, lon: 4, rayon: 200 }, fetcher);
  assert.equal(liste.length, 1);
  assert.equal(appels.length, 2);
  assert.match(appels[1], /api\.airplanes\.live\/v2\/point\/50\.000\/4\.000\/200$/);
});

test('chargerCase : l\'erreur nomme chaque source et son code', async () => {
  const fetcher = async (u) => new Response('x', { status: u.includes('adsb.lol') ? 403 : 429 });
  await assert.rejects(chargerCase({ lat: 0, lon: 0, rayon: 100 }, fetcher), /adsb\.lol 403, airplanes\.live 429/);
});

test('parLots : jamais plus de n tâches à la fois, et une tâche en erreur ne bloque pas les autres', async () => {
  let enCours = 0;
  let max = 0;
  const tache = (i) => async () => {
    enCours++;
    max = Math.max(max, enCours);
    await new Promise((r) => setTimeout(r, 5));
    enCours--;
    if (i === 3) throw new Error('raté');
    return i;
  };
  const res = await parLots(Array.from({ length: 10 }, (_, i) => tache(i)), 4);
  assert.equal(max, 4);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 9);
  assert.equal(res[3].status, 'rejected');
  assert.equal(res[9].value, 9);
});

test('fusionner : pas de doublon, hors zone écarté', () => {
  const a = { h: 'aa', y: 50, x: 4 };
  const b = { h: 'bb', y: 80, x: 4 };
  const liste = fusionner([[a, b], [a]], [[40, 0, 60, 10]]);
  assert.deepEqual(liste.map((x) => x.h), ['aa']);
});

test('route /avions : paramètres invalides, zone trop grande, et réponse normale', async () => {
  const get = async (qs, fetcher) => {
    const rep = await avions(new URL(`https://x/avions?${qs}`), undefined, fetcher);
    return { status: rep.status, corps: await rep.json() };
  };
  assert.equal((await get('s=1&w=2')).status, 400);
  assert.equal((await get('s=10&w=0&n=5&e=5')).status, 400);
  assert.equal((await get('s=-60&w=-180&n=80&e=180')).corps.trop, true);

  const fetcher = async () => new Response(JSON.stringify({ ac: [{ hex: 'aa', lat: 50.5, lon: 4.5, alt_baro: 30000, flight: 'TEST1' }] }));
  const ok = await get('s=50&w=4&n=51&e=5', fetcher);
  assert.equal(ok.status, 200);
  assert.equal(ok.corps.n, 1);
  assert.equal(ok.corps.avions[0].c, 'TEST1');

  const panne = await get('s=50&w=4&n=51&e=5', async () => new Response('x', { status: 500 }));
  assert.equal(panne.status, 502);
});
