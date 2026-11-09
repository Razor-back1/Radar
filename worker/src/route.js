// Départ et destination d'un vol, d'après la base de routes d'adsb.lol (« standing data », une fiche par indicatif).
// Ce sont les routes programmées des compagnies : un vol dérouté ou un indicatif réutilisé peut s'en écarter,
// et les vols sans indicatif de compagnie (aviation légère, militaire) n'y figurent pas.

export const BASE_ROUTES = 'https://vrs-standing-data.adsb.lol/routes';

/** Indicatif d'appel plausible (lettres et chiffres, 3 à 8 caractères). */
export const indicatifValide = (c) => /^[A-Z0-9]{3,8}$/.test(c);

export const urlRoute = (c) => `${BASE_ROUTES}/${c.slice(0, 2)}/${c}.json`;

/** Fiche de la base → { c, codes, etapes: [{ icao, iata, nom, ville, pays, y, x }] } (au moins départ et arrivée), sinon null. */
export function normaliserRoute(json) {
  const aeroports = Array.isArray(json?._airports) ? json._airports : [];
  const etapes = aeroports
    .filter((a) => typeof a?.lat === 'number' && typeof a?.lon === 'number')
    .map((a) => ({ icao: a.icao ?? '', iata: a.iata ?? '', nom: a.name ?? '', ville: a.location ?? '', pays: a.countryiso2 ?? '', y: a.lat, x: a.lon }));
  if (etapes.length < 2) return null;
  return { c: json.callsign ?? '', codes: json.airport_codes ?? '', etapes };
}

/** null si le vol n'est pas dans la base ; erreur si la base ne répond pas. */
export async function chargerRoute(c, fetcher = fetch) {
  const rep = await fetcher(urlRoute(c), { headers: { accept: 'application/json', 'user-agent': 'carte-live (usage personnel)' }, signal: AbortSignal.timeout(6000) });
  // Le stockage de la base répond 403 ou 404 pour un indicatif absent.
  if (rep.status === 404 || rep.status === 403) return null;
  if (!rep.ok) throw new Error(`base de routes ${rep.status}`);
  return normaliserRoute(await rep.json());
}
