// Adresse du Worker (voir README). Après « wrangler deploy », colle ici l'adresse affichée,
// du type https://carte-live.<ton-compte>.workers.dev (sans « / » à la fin).
window.CARTE_CONFIG = {
  worker: '',
  // Fond de carte : style vectoriel gratuit (sombre). Remplaçable par n'importe quel style MapLibre.
  styleSombre: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  styleClair: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};
