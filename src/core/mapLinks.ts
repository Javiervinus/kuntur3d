import { PLUS_CODE_PATTERN } from './pluscode';

/** Lo que se puede sacar de un link de mapa, de lo más preciso a lo menos. */
export type MapLinkTarget =
  | { kind: 'coords'; lat: number; lon: number; label: string | null }
  | { kind: 'plusCode'; code: string; label: string | null }
  | { kind: 'query'; text: string }
  | { kind: 'short'; url: string };

export interface MapLinkConfig {
  shortHosts: string[];
  mapHostPatterns: string[];
  coordinateParams: string[];
  queryParams: string[];
}

const COORD_PAIR = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const PIN = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/;
const VIEWPORT = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/;

/** Decodifica un tramo de URL; en los links de Google '+' también es espacio. */
function clean(value: string): string {
  let text = value.replace(/\+/g, ' ');
  try {
    text = decodeURIComponent(text);
  } catch {
    // Se deja tal cual si trae un % suelto.
  }
  return text.replace(/\s+/g, ' ').trim();
}

function coordsOf(text: string): { lat: number; lon: number } | null {
  const m = COORD_PAIR.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** "RX6H+5PG, Guayaquil" → código "RX6H+5PG" (la localidad no hace falta: se usa la zona como referencia). */
export function plusCodeOf(text: string): string | null {
  const first = text.split(/[\s,]+/)[0] ?? '';
  return PLUS_CODE_PATTERN.test(first) ? first.toUpperCase() : null;
}

/**
 * Valor de un parámetro sin convertir '+' en espacio: Google escribe los Plus Codes
 * así (q=RX6H+5PG,+Guayaquil), y URLSearchParams los rompería.
 */
function rawParam(url: URL, key: string): string | null {
  for (const part of url.search.replace(/^\?/, '').split('&')) {
    const eq = part.indexOf('=');
    if ((eq >= 0 ? part.slice(0, eq) : part) !== key) continue;
    const value = eq >= 0 ? part.slice(eq + 1) : '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Nombre del lugar en rutas tipo /maps/place/<nombre>/@… o /maps/search/<texto>. */
function placeName(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  for (const marker of ['place', 'search']) {
    const k = parts.indexOf(marker);
    if (k >= 0 && parts[k + 1] && !parts[k + 1].startsWith('@')) return clean(parts[k + 1]);
  }
  const dir = parts.indexOf('dir');
  if (dir >= 0) {
    const stops = parts.slice(dir + 1).filter((p) => !p.startsWith('@') && !p.startsWith('data='));
    if (stops.length) return clean(stops[stops.length - 1]);
  }
  return null;
}

/** Intenta leer un texto como URL (acepta "maps.app.goo.gl/…" sin https://). */
export function asUrl(text: string): URL | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
}

function isMapHost(host: string, cfg: MapLinkConfig): boolean {
  return cfg.mapHostPatterns.some((p) => new RegExp(p, 'i').test(host));
}

export function isShortHost(host: string, cfg: MapLinkConfig): boolean {
  const h = host.toLowerCase();
  return cfg.shortHosts.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Interpreta links de Google Maps (y de otros mapas con los mismos parámetros).
 * Devuelve null si el texto no es un link de mapa.
 */
export function parseMapLink(text: string, cfg: MapLinkConfig): MapLinkTarget | null {
  const url = asUrl(text);
  if (!url || !url.hostname.includes('.')) return null;
  const host = url.hostname.toLowerCase();
  if (isShortHost(host, cfg)) return { kind: 'short', url: url.href };
  if (!isMapHost(host, cfg)) return null;

  const name = placeName(url);
  const decoded = clean(url.href);
  const isDirections = url.pathname.split('/').includes('dir');

  // 1) Pin exacto del lugar (!3d lat !4d lon).
  const pin = PIN.exec(decoded);
  if (pin) return { kind: 'coords', lat: Number(pin[1]), lon: Number(pin[2]), label: name };

  // 2) Coordenadas o Plus Code en parámetros (q, query, ll, destination…).
  let queryText: string | null = null;
  for (const key of [...cfg.coordinateParams, ...cfg.queryParams]) {
    const raw = rawParam(url, key);
    if (!raw) continue;
    const value = raw.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
    const c = coordsOf(value);
    if (c) return { kind: 'coords', ...c, label: name };
    const code = plusCodeOf(raw);
    if (code) {
      const locality = value.split(',').slice(1).join(',').trim();
      return { kind: 'plusCode', code, label: locality ? `${code}, ${locality}` : code };
    }
    if (!queryText && cfg.queryParams.includes(key)) queryText = value;
  }

  // 3) Coordenadas o Plus Code en la ruta (/maps/search/-2.13,+-79.93 o /maps/place/RX6H+5PG).
  const segments = url.pathname.split('/').filter(Boolean).map(clean);
  for (const segment of [...segments].reverse()) {
    const c = coordsOf(segment);
    if (c) return { kind: 'coords', ...c, label: null };
    const code = plusCodeOf(segment);
    if (code) return { kind: 'plusCode', code, label: segment };
  }

  // 4) Centro de la vista (@lat,lon): cerca del lugar, aunque no es el pin.
  const view = VIEWPORT.exec(decoded);
  // En rutas (/maps/dir/A/B/@…) la vista queda entre origen y destino: mejor buscar el destino.
  if (view && !queryText && !(isDirections && name)) {
    return { kind: 'coords', lat: Number(view[1]), lon: Number(view[2]), label: name };
  }

  // 5) Solo nombre o dirección: hay que geocodificarlo.
  const fallbackText = queryText ?? name;
  if (fallbackText) return { kind: 'query', text: fallbackText };
  if (view) return { kind: 'coords', lat: Number(view[1]), lon: Number(view[2]), label: name };
  return null;
}
