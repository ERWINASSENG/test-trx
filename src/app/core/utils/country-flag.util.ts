/**
 * Utilitaire de résolution des drapeaux officiels de pays au format vectoriel SVG.
 * Utilise le CDN mondial Flagcdn (ISO 3166-1 alpha-2).
 */

const COUNTRY_TO_ISO: Record<string, string> = {
  // Afrique
  cameroun: 'cm',
  cameroon: 'cm',
  "cote d'ivoire": 'ci',
  "côte d'ivoire": 'ci',
  ivory_coast: 'ci',
  senegal: 'sn',
  sénégal: 'sn',
  nigeria: 'ng',
  maroc: 'ma',
  morocco: 'ma',
  ghana: 'gh',
  gabon: 'ga',
  congo: 'cg',
  rdc: 'cd',
  'rd congo': 'cd',
  guinee: 'gn',
  guinée: 'gn',
  benin: 'bj',
  bénin: 'bj',
  togo: 'tg',
  tchad: 'td',
  centrafrique: 'cf',
  mali: 'ml',
  burkina: 'bf',
  'burkina faso': 'bf',
  niger: 'ne',
  algerie: 'dz',
  algérie: 'dz',
  tunisie: 'tn',
  egypte: 'eg',
  égypte: 'eg',
  kenya: 'ke',
  afrique_du_sud: 'za',
  'afrique du sud': 'za',

  // Europe & International
  france: 'fr',
  belgique: 'be',
  belgium: 'be',
  turquie: 'tr',
  turkey: 'tr',
  'emirats arabes unis': 'ae',
  'émirats arabes unis': 'ae',
  uae: 'ae',
  dubai: 'ae',
  chine: 'cn',
  china: 'cn',
  espagne: 'es',
  spain: 'es',
  allemagne: 'de',
  germany: 'de',
  italie: 'it',
  italy: 'it',
  royaume_uni: 'gb',
  'royaume-uni': 'gb',
  uk: 'gb',
  etats_unis: 'us',
  'états-unis': 'us',
  usa: 'us',
  suisse: 'ch',
  switzerland: 'ch',
  canada: 'ca',
  bresil: 'br',
  brésil: 'br',
  inde: 'in',
  india: 'in',
};

function normalizeCountry(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Renvoie l'URL du drapeau vectoriel SVG officiel pour un nom ou code de pays donné.
 */
export function getCountryFlagUrl(country: string | null | undefined): string | null {
  if (!country) return null;
  const raw = country.trim().toLowerCase();

  // Si c'est déjà un code ISO 2 lettres
  if (/^[a-z]{2}$/.test(raw)) {
    return `https://flagcdn.com/${raw}.svg`;
  }

  const normalized = normalizeCountry(country);
  const isoCode = COUNTRY_TO_ISO[normalized] || COUNTRY_TO_ISO[raw];

  if (isoCode) {
    return `https://flagcdn.com/${isoCode}.svg`;
  }

  // Recherche par inclusion partielle
  for (const [key, code] of Object.entries(COUNTRY_TO_ISO)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return `https://flagcdn.com/${code}.svg`;
    }
  }

  return null;
}
