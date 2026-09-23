import type { GeoFrame } from '../core/geo';
import { asUrl, parseMapLink, plusCodeOf, type MapLinkTarget } from '../core/mapLinks';
import { decodeNearest } from '../core/pluscode';
import type { GameConfig, Landmark, WorldManifest } from '../core/types';

export interface SearchHit {
  x: number;
  z: number;
  label: string;
}

/** Buscador local (índice del paso `search`, ver src/ui/placeSearch.ts): su mejor resultado. */
export interface LocalSearch {
  best(text: string): Promise<SearchHit | null>;
}

/** Lo que se resuelve sin el índice: un link de mapa, un Plus Code o coordenadas. */
export type DirectKind = 'link' | 'plusCode' | 'coords';

const COORDS = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** ¿Lo escrito es un link de mapa, un Plus Code o coordenadas? null si es texto para buscar. */
export function directKind(text: string, links: GameConfig['mapLinks']): DirectKind | null {
  const q = text.trim();
  if (!q) return null;
  if (parseMapLink(q, links) || (/^https?:\/\//i.test(q) && asUrl(q))) return 'link';
  if (plusCodeOf(q)) return 'plusCode';
  return COORDS.test(q) ? 'coords' : null;
}

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * Resuelve lo que se escribe o pega en el buscador: links de Google Maps (largos o
 * cortos), Plus Codes, coordenadas "lat, lon" y texto: primero en el buscador local
 * (calles, cruces, negocios, barrios) y, si ahí no está, en los lugares del manifest
 * y en Nominatim dentro del bbox.
 */
export class Search {
  private lastRequest = 0;
  private readonly km: Intl.NumberFormat;
  private local: LocalSearch | null = null;

  constructor(
    private readonly manifest: WorldManifest,
    private readonly geo: GeoFrame,
    private readonly links: GameConfig['mapLinks'],
    locale: string,
  ) {
    this.km = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  get landmarks(): Landmark[] {
    return this.manifest.landmarks;
  }

  /** Conecta el buscador local: el texto se busca ahí antes que en Nominatim. */
  useLocal(local: LocalSearch): void {
    this.local = local;
  }

  async resolve(query: string): Promise<SearchHit> {
    const q = query.trim();
    if (!q) throw new Error('Escribe un lugar, una dirección, coordenadas o pega un link de Google Maps');

    const link = parseMapLink(q, this.links);
    if (link) return this.fromLink(link, false);
    if (/^https?:\/\//i.test(q) && asUrl(q)) throw new Error('Ese link no es de Google Maps');

    const code = plusCodeOf(q);
    if (code) return this.fromLink({ kind: 'plusCode', code, label: q }, false);

    const coords = COORDS.exec(q);
    if (coords) {
      const lat = Number(coords[1]);
      const lon = Number(coords[2]);
      return this.inside(lat, lon, null);
    }

    return this.lookup(q);
  }

  /**
   * Texto libre: el buscador local y, si no encuentra nada (o no está), los lugares del panel y
   * Nominatim, que queda de respaldo para direcciones con número y lugares que solo están en OSM.
   */
  private async lookup(text: string): Promise<SearchHit> {
    const hit = this.local ? await this.local.best(text) : null;
    if (hit) return hit;
    const nq = normalize(text);
    const landmark =
      this.manifest.landmarks.find((lm) => normalize(lm.name) === nq) ??
      this.manifest.landmarks.find((lm) => normalize(lm.name).includes(nq));
    if (landmark) return { x: landmark.x, z: landmark.z, label: landmark.name };
    return this.geocode(text);
  }

  private async fromLink(link: MapLinkTarget, expanded: boolean): Promise<SearchHit> {
    switch (link.kind) {
      case 'coords':
        return this.inside(link.lat, link.lon, link.label);
      case 'plusCode': {
        const { lat, lon } = decodeNearest(link.code, this.manifest.origin);
        return this.inside(lat, lon, link.label ?? link.code);
      }
      case 'query':
        return this.lookup(link.text);
      case 'short': {
        if (expanded) throw new Error('No pude leer la ubicación de ese link');
        const long = await this.expand(link.url);
        const next = parseMapLink(long, this.links);
        if (!next) throw new Error('No pude leer la ubicación de ese link');
        return this.fromLink(next, true);
      }
    }
  }

  /** Los links cortos se expanden en el servidor de Vite (server/mapLinkResolver.ts). */
  private async expand(shortUrl: string): Promise<string> {
    const endpoint = new URL(this.links.resolverPath, document.baseURI);
    endpoint.searchParams.set('url', shortUrl);
    let res: Response;
    try {
      res = await fetch(endpoint);
    } catch {
      throw new Error('No pude abrir el link corto; pega el link largo de Google Maps');
    }
    const isJson = res.headers.get('content-type')?.includes('application/json');
    if (!isJson) throw new Error('Para links cortos abre la ciudad con npm run dev (o pega el link largo)');
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) throw new Error(data.error ?? `No pude expandir el link (HTTP ${res.status})`);
    return data.url;
  }

  private async geocode(text: string): Promise<SearchHit> {
    const g = this.manifest.geocoder;
    const wait = g.minIntervalMs - (Date.now() - this.lastRequest);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
    const b = this.manifest.bbox;
    const params = new URLSearchParams({
      q: text,
      format: 'jsonv2',
      limit: '1',
      viewbox: `${b.west},${b.north},${b.east},${b.south}`,
      bounded: '1',
    });
    const res = await fetch(`${g.url}?${params}`);
    if (!res.ok) throw new Error(`El buscador respondió ${res.status}`);
    const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    if (!hits.length) throw new Error(`No encontré "${text}" dentro de ${this.manifest.name}`);
    const [first] = hits;
    return this.inside(Number(first.lat), Number(first.lon), first.display_name.split(',').slice(0, 2).join(','));
  }

  /** Ubicación del dispositivo; si cae fuera de la zona, dice a qué distancia está. */
  fromDevice(lat: number, lon: number, accuracy: number): SearchHit {
    const { x, z } = this.geo.toLocal(lat, lon);
    if (!this.geo.contains(x, z)) {
      throw new Error(`Estás a ${this.kmOutside(x, z)} km de la zona cargada (${this.manifest.name})`);
    }
    return { x, z, label: `Tu ubicación (±${Math.round(accuracy)} m)` };
  }

  private kmOutside(x: number, z: number): string {
    return this.km.format(this.geo.distanceOutside(x, z) / 1000);
  }

  /** Punto dentro de la zona, o error que dice a cuántos km queda. `label` null = coordenadas. */
  private inside(lat: number, lon: number, label: string | null): SearchHit {
    const { x, z } = this.geo.toLocal(lat, lon);
    if (!this.geo.contains(x, z)) {
      const what = label ? `"${label}"` : `El punto ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      throw new Error(`${what} queda a ${this.kmOutside(x, z)} km de la zona cargada (${this.manifest.name})`);
    }
    return { x, z, label: label ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  }
}
