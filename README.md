# Carte live

Carte du monde en direct, pensée pour s'afficher dans le hub familial (tuile « Carte live ») et sur téléphone.
Aujourd'hui : **avions** (ADS-B). À venir, une couche à la fois : navires (AIS), événements de conflit, caméras.

- `index.html`, `app.js`, `style.css` : l'app (MapLibre, sans étape de build, publiée par GitHub Pages)
- `vendor/` : MapLibre GL JS 5.24.0 (copié ici, rien n'est chargé depuis un CDN)
- `worker/` : Worker Cloudflare qui interroge les sources publiques (adsb.lol, avec airplanes.live en secours),
  gère le cache et le CORS. Une route par couche : `/avions`, et `/route` (départ et destination d'un vol, d'après la base de routes d'adsb.lol, par indicatif ; routes programmées, donc pas de trajet pour l'aviation légère).
- `config.js` : adresse du Worker et fonds de carte

## Mise en route

1. **Pages** : Réglages du dépôt → Pages → branche `main`, dossier `/ (root)`.
2. **Worker** : branché sur le dépôt dans Cloudflare (Workers & Pages → Import a repository, nom `carte-live`, dossier racine vide, commande `npx wrangler deploy`) ; il se redéploie à chaque push. Ou à la main : `npx wrangler login` puis `npx wrangler deploy` ; l'adresse affichée est du type
   `https://carte-live.<compte>.workers.dev`. Colle-la dans `config.js` (`worker`).
   Pour un déploiement automatique à chaque push : ajoute les secrets `CLOUDFLARE_API_TOKEN` et
   `CLOUDFLARE_ACCOUNT_ID` au dépôt (le workflow `worker.yml` s'en charge).
3. **Hub** : ajouter l'app dans Réglages → Autres apps avec l'adresse `https://<compte>.github.io/<dépôt>/`.

## Comment ça marche (avions)

Les sources gratuites répondent par cercle (250 mi nautiques max). Si la zone visible tient dans un cercle, le Worker fait un seul appel ;
sinon il la découpe en cases fixes de 5°, demandées 4 à la fois (les sources refusent les rafales). Chaque case reste 3 s en cache
(partagé entre tous les écrans), plus une copie de secours de 2 minutes servie si les sources refusent.
L'app interroge le Worker toutes les 4 s, et entre deux réponses avance chaque avion selon sa vitesse et son cap, chaque seconde.
Limite : 24 cases par requête, soit environ 25° × 25° ; en dessous du zoom 4,2 la carte demande de zoomer.
Le monde entier est couvert, une région à la fois.

## Tests

`cd worker && npm test`. Les sources ne sont pas appelées pendant les tests.

## Fonds de carte

Styles vectoriels CARTO (Dark Matter / Positron), gratuits avec mention de la source. Remplaçables dans `config.js`
par n'importe quel style MapLibre.
