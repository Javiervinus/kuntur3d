import * as THREE from 'three';
import placesContent from '../../config/places.json';
import type { GameConfig, WorldManifest } from '../core/types';
import type { Heightmap } from '../world/heightmap';
import type { SearchLandmark } from './searchEngine';
import './places.css';

type PlacesConfig = GameConfig['places'];

/** Un lugar con ficha (config/places.json). */
export interface PlaceEntry {
  id: string;
  name: string;
  /** Categoría corta, arriba del nombre ("Noria · Malecón 2000"). */
  kicker: string;
  /** Grupo en la lista de lugares (id de `categories`); sin él va en el último. */
  category?: string;
  year: string;
  text: string;
  /** "¿Sabías que…?" (sin la pregunta). */
  fact?: string;
  /** De dónde salen los datos (enlaces al pie de la ficha). */
  sources?: string[];
  /**
   * Dónde está: un lugar del panel (por su nombre), un ícono de config/game.json (por su id) o
   * coordenadas. Lo resuelve el paso `places` del pipeline (con el punto de llegada).
   */
  anchor: { landmark?: string; monument?: string; lat?: number; lon?: number };
  /** Alto (m sobre el suelo) del marcador y radio (m) en el que se abre la ficha al llegar. */
  height: number;
  radius?: number;
  /**
   * Foto de Wikimedia Commons ("File:…"; la baja el paso `places` del pipeline) y, si el recorte
   * al centro corta lo importante, a qué punto apuntar el recorte (x %, y %).
   */
  photo?: { file: string; focus?: number[] };
}

/** Lema de una zona, para todos los barrios de OSM que la forman (por su nombre). */
interface ZoneNote {
  id: string;
  names: string[];
  text: string;
}

/** Grupo de la lista de lugares (en su orden). */
export interface PlaceCategory {
  id: string;
  label: string;
}

interface PlacesContent {
  categories: PlaceCategory[];
  /** Categoría de los lugares del panel que no tienen ficha (por su nombre). */
  landmarkCategories?: Record<string, string>;
  places: PlaceEntry[];
  zones?: ZoneNote[];
}

/** Un lugar de la lista de la pausa y de los mapas. */
export interface DirectoryEntry {
  name: string;
  /** Centro (el marcador) y punto de llegada ("Ir aquí"). */
  x: number;
  z: number;
  ax: number;
  az: number;
  /** Tiene ficha con su historia (se abre sola al llegar). */
  ficha: boolean;
  /** Id de su grupo (PlaceCategory). */
  category: string;
  kicker: string;
  year: string;
  /** Miniatura de su foto (URL), o null. */
  thumb: string | null;
}

/** Zona (barrio, parroquia o cantón) en la que está el jugador y las que la contienen. */
export interface ZoneInfo {
  name: string;
  kind: string;
  /** Las más grandes que la contienen, de la más chica a la más grande (sin repetir). */
  above: string[];
}

/** Dónde va el nombre de una zona en el mapa grande (y su área, m²: las grandes se escriben primero). */
export interface ZoneLabel {
  name: string;
  kind: string;
  x: number;
  z: number;
  area: number;
}

/** Zona (barrio, parroquia, cantón) del paso `places`: anillos x, z enteros en el marco local. */
interface Zone {
  name: string;
  kind: string;
  bbox: [number, number, number, number];
  rings: number[][];
}

interface Photo {
  url: string;
  artist: string;
  license: string;
  source: string;
}

interface Place extends PlaceEntry {
  /** Centro (marcador y cercanía) y punto de llegada del botón "Ir aquí". */
  cx: number;
  cz: number;
  ax: number;
  az: number;
  y: number;
  photoInfo: Photo | null;
  pin: HTMLElement;
  label: HTMLElement;
  /** Ancho del nombre y alto del marcador con su nombre, en px (se miden la primera vez que se ve). */
  labelSize: { width: number; height: number } | null;
  /** Ya se cerró su ficha en esta visita (no se vuelve a abrir sola hasta salir y volver). */
  dismissed: boolean;
}

/** Marcador en pantalla en este cuadro: dónde cae y qué tan lejos está. */
interface PinView {
  place: Place;
  x: number;
  y: number;
  distance: number;
}

const _v = new THREE.Vector3();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** ¿(x, z) cae dentro de los anillos? (par-impar: los huecos restan). */
function inside(rings: number[][], x: number, z: number): boolean {
  let hit = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let k = 0, m = n - 1; k < n; m = k++) {
      const xk = ring[k * 2];
      const zk = ring[k * 2 + 1];
      const xm = ring[m * 2];
      const zm = ring[m * 2 + 1];
      if (zk > z !== zm > z && x < ((xm - xk) * (z - zk)) / (zm - zk) + xk) hit = !hit;
    }
  }
  return hit;
}

/**
 * Lugares destacados del buscador: cada lugar con ficha (su nombre, con el del lugar del panel en
 * que se basa como alternativo, y su categoría de detalle) y los del panel que no tienen ficha.
 * Se llega al punto de llegada de la ficha, así que al llegar se abre sola.
 */
export function searchLandmarks(manifest: WorldManifest): SearchLandmark[] {
  const anchors = manifest.places?.anchors ?? {};
  const covered = new Set<string>();
  const out: SearchLandmark[] = [];
  for (const p of (placesContent as PlacesContent).places) {
    const anchor = anchors[p.id];
    if (!anchor) continue;
    const alt = p.anchor.landmark && p.anchor.landmark !== p.name ? [p.anchor.landmark] : [];
    if (p.anchor.landmark) covered.add(p.anchor.landmark);
    out.push({ name: p.name, x: anchor[2], z: anchor[3], alt, detail: p.kicker });
  }
  for (const lm of manifest.landmarks) if (!covered.has(lm.name)) out.push(lm);
  return out;
}

/**
 * Lugares de la lista de la pausa y de los mapas: cada lugar con ficha (config/places.json, con
 * su categoría) y los del panel que no tienen una (con la de `landmarkCategories`). El que no
 * dice categoría va en la última.
 */
export function placeDirectory(manifest: WorldManifest, baseUrl: string): { categories: PlaceCategory[]; entries: DirectoryEntry[] } {
  const content = placesContent as PlacesContent;
  const categories = content.categories;
  const fallback = categories[categories.length - 1]?.id ?? '';
  const anchors = manifest.places?.anchors ?? {};
  const photos = manifest.places?.photos ?? {};
  const covered = new Set<string>();
  const entries: DirectoryEntry[] = [];
  for (const p of content.places) {
    const anchor = anchors[p.id];
    if (!anchor) continue;
    if (p.anchor.landmark) covered.add(p.anchor.landmark);
    const thumb = photos[p.id]?.thumb;
    entries.push({
      name: p.name,
      x: anchor[0],
      z: anchor[1],
      ax: anchor[2],
      az: anchor[3],
      ficha: true,
      category: p.category ?? fallback,
      kicker: p.kicker,
      year: p.year,
      thumb: thumb ? new URL(thumb, baseUrl).href : null,
    });
  }
  const byLandmark = content.landmarkCategories ?? {};
  for (const lm of manifest.landmarks) {
    if (covered.has(lm.name)) continue;
    entries.push({
      name: lm.name,
      x: lm.cx ?? lm.x,
      z: lm.cz ?? lm.z,
      ax: lm.x,
      az: lm.z,
      ficha: false,
      category: byLandmark[lm.name] ?? fallback,
      kicker: '',
      year: '',
      thumb: null,
    });
  }
  return { categories, entries };
}

/** Centroide del anillo [x, z, …] (fórmula del área con signo); el promedio de sus puntos si es plano. */
function ringCentroid(ring: number[]): { x: number; z: number; area: number } {
  let area = 0;
  let cx = 0;
  let cz = 0;
  const n = ring.length / 2;
  for (let k = 0, m = n - 1; k < n; m = k++) {
    const cross = ring[m * 2] * ring[k * 2 + 1] - ring[k * 2] * ring[m * 2 + 1];
    area += cross;
    cx += (ring[m * 2] + ring[k * 2]) * cross;
    cz += (ring[m * 2 + 1] + ring[k * 2 + 1]) * cross;
  }
  if (Math.abs(area) < 1e-6) {
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < n; k++) {
      sx += ring[k * 2];
      sz += ring[k * 2 + 1];
    }
    return { x: sx / n, z: sz / n, area: 0 };
  }
  return { x: cx / (3 * area), z: cz / (3 * area), area: Math.abs(area) / 2 };
}

/** Tres estrellas de la bandera de Guayaquil, para el marcador. */
const STARS = `<svg viewBox="0 0 14 6" aria-hidden="true"><circle cx="2" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/></svg>`;

/**
 * Lugares con historia:
 * - Título de zona: al entrar a un barrio (límites de OSM, paso `places`), su nombre arriba, con
 *   la parroquia y el cantón y, si lo tiene en config/places.json, su lema. Cambia recién cuando
 *   el jugador lleva `settleSeconds` s en la zona nueva (no parpadea al andar por el borde).
 * - Marcadores sobre cada lugar reconstruido (config/places.json), visibles de lejos; el nombre
 *   aparece de cerca o al pasar el cursor, y con un clic se abre su ficha. Si dos se montan en
 *   pantalla, queda el más cercano.
 * - Ficha: foto (Wikimedia Commons, con su crédito), categoría, nombre, año, historia, un
 *   "¿Sabías que…?" y sus fuentes. Se abre sola al llegar al lugar, se recoge a una píldora tras
 *   un rato y se cierra al irse.
 */
export class PlaceGuide {
  private readonly places: Place[];
  private readonly zones: Zone[];
  private readonly taglines: Map<string, string>;
  private readonly pins = element('div', 'place-pins');
  private readonly zoneTitle = element('div', 'zone-title');
  private readonly zoneKicker: HTMLElement;
  private readonly zoneName: HTMLElement;
  private readonly zoneTagline: HTMLElement;
  private readonly card = element('article', 'place-card');
  private readonly chip = element('button', 'place-chip');
  private readonly cardParts: {
    figure: HTMLElement;
    photo: HTMLImageElement;
    credit: HTMLElement;
    year: HTMLElement;
    kicker: HTMLElement;
    name: HTMLElement;
    text: HTMLElement;
    fact: HTMLElement;
    sources: HTMLElement;
    distance: HTMLElement;
    go: HTMLButtonElement;
  };
  /** Lugar de la ficha (abierta o recogida) y si se abrió a mano (no se recoge sola). */
  private current: Place | null = null;
  private manual = false;
  private openFor = 0;
  private collapsed = false;
  /** Pantallas chicas o táctiles: las fichas que se abren solas llegan recogidas en la píldora. */
  private compact = false;
  private zoneTimer = 0;
  private zoneShown = '';
  private zoneCandidate = '';
  private zoneSince = 0;
  private started = false;
  private zoneListener: ((zone: ZoneInfo | null) => void) | null = null;

  private constructor(
    private readonly cfg: PlacesConfig,
    entries: PlaceEntry[],
    notes: ZoneNote[],
    zones: Zone[],
    info: NonNullable<WorldManifest['places']>,
    heightmap: Heightmap,
    private readonly baseUrl: string,
    private readonly goTo: (x: number, z: number, label: string) => void,
  ) {
    this.zones = zones;
    this.taglines = new Map(notes.flatMap((note) => note.names.map((name) => [name, note.text] as const)));
    this.pins.style.setProperty('--pin-size', `${cfg.markers.pinSize}px`);
    this.zoneTitle.style.setProperty('--zone-total', `${cfg.zones.totalSeconds}s`);
    this.zoneKicker = element('div', 'zone-kicker', this.zoneTitle);
    const nameRow = element('div', 'zone-name', this.zoneTitle);
    element('span', 'zone-rule', nameRow);
    this.zoneName = element('h2', '', nameRow);
    element('span', 'zone-rule after', nameRow);
    this.zoneTagline = element('p', 'zone-tagline', this.zoneTitle);

    // Ficha.
    const figure = element('figure', 'pc-photo', this.card);
    const photo = element('img', '', figure);
    photo.alt = '';
    photo.decoding = 'async';
    photo.addEventListener('load', () => photo.classList.add('ready'));
    const credit = element('figcaption', '', figure);
    const year = element('div', 'pc-year', figure);
    const close = element('button', 'pc-close', figure);
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', cfg.card.closeLabel);
    const body = element('div', 'pc-body', this.card);
    const kicker = element('div', 'pc-kicker', body);
    const name = element('h3', 'pc-name', body);
    const text = element('p', 'pc-text', body);
    const fact = element('p', 'pc-fact', body);
    const sources = element('p', 'pc-sources', body);
    const foot = element('div', 'pc-foot', body);
    const distance = element('span', '', foot);
    const go = element('button', 'pc-go', foot);
    go.type = 'button';
    go.textContent = cfg.card.goLabel;
    this.cardParts = { figure, photo, credit, year, kicker, name, text, fact, sources, distance, go };
    close.addEventListener('click', () => this.close(true));
    go.addEventListener('click', () => {
      const p = this.current;
      if (p) this.goTo(p.ax, p.az, p.name);
    });
    this.chip.type = 'button';
    this.chip.addEventListener('click', () => {
      if (this.current) this.open(this.current, true);
    });
    // Que los clics en la interfaz no lleguen al mundo (arrastrar para mirar).
    for (const node of [this.card, this.chip, this.pins]) node.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.places = [];
    for (const entry of entries) {
      const anchor = info.anchors[entry.id];
      if (!anchor) throw new Error(`config/places.json: "${entry.id}" no está en el manifest (corre el paso places del pipeline)`);
      const [cx, cz, ax, az] = anchor;
      const pin = element('div', 'place-pin', this.pins);
      pin.innerHTML = `<span class="pin-mark">${STARS}</span>`;
      const label = element('span', 'pin-label', pin);
      label.textContent = entry.name;
      const place: Place = {
        ...entry,
        cx,
        cz,
        ax,
        az,
        y: heightmap.sample(cx, cz) + entry.height,
        photoInfo: info.photos[entry.id] ?? null,
        pin,
        label,
        labelSize: null,
        dismissed: false,
      };
      pin.addEventListener('click', () => this.open(place, true));
      this.places.push(place);
    }
    document.body.append(this.pins, this.zoneTitle, this.card, this.chip);
  }

  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    cfg: PlacesConfig,
    heightmap: Heightmap,
    goTo: (x: number, z: number, label: string) => void,
  ): Promise<PlaceGuide> {
    const content = placesContent as PlacesContent;
    const info = manifest.places;
    if (!info) throw new Error('El manifest no trae lugares: corre el paso places del pipeline');
    const res = await fetch(new URL(info.zones, baseUrl));
    if (!res.ok) throw new Error(`HTTP ${res.status} (${info.zones})`);
    const zones = ((await res.json()) as { zones: Zone[] }).zones;
    return new PlaceGuide(cfg, content.places, content.zones ?? [], zones, info, heightmap, baseUrl, goTo);
  }

  /** Desde aquí se muestran los títulos de zona (después de la pantalla de carga). */
  start(): void {
    this.started = true;
  }

  /** Avisa cada vez que el jugador cambia de zona (null = fuera de todas, p. ej. en el río). */
  onZone(listener: (zone: ZoneInfo | null) => void): void {
    this.zoneListener = listener;
  }

  /**
   * Dónde escribir el nombre de cada zona en el mapa grande: el centro de su anillo más grande.
   * Una por nombre (la más grande: Guayaquil es parroquia y también cantón).
   */
  zoneLabels(): ZoneLabel[] {
    const best = new Map<string, ZoneLabel>();
    for (const zone of this.zones) {
      for (const ring of zone.rings) {
        const c = ringCentroid(ring);
        const known = best.get(zone.name);
        if (!known || c.area > known.area) best.set(zone.name, { name: zone.name, kind: zone.kind, x: c.x, z: c.z, area: c.area });
      }
    }
    return [...best.values()];
  }

  update(dt: number, player: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    if (!this.started) return;
    this.updateZone(dt, player.x, player.z);
    this.updateNearby(dt, player.x, player.z);
    this.updatePins(camera);
  }

  private updateZone(dt: number, x: number, z: number): void {
    const zc = this.cfg.zones;
    this.zoneTimer -= dt;
    this.zoneSince += dt;
    if (this.zoneTimer > 0) return;
    this.zoneTimer = zc.checkSeconds;
    // De la más chica a la más grande (el pipeline las ordena así).
    const here: Zone[] = [];
    for (const zone of this.zones) {
      const [x0, z0, x1, z1] = zone.bbox;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (inside(zone.rings, x, z)) here.push(zone);
    }
    const name = here.length ? here[0].name : '';
    if (name !== this.zoneCandidate) {
      this.zoneCandidate = name;
      this.zoneSince = 0;
    }
    if (name === this.zoneShown || this.zoneSince < zc.settleSeconds) return;
    this.zoneShown = name;
    const above = [...new Set(here.slice(1).map((zone) => zone.name))].filter((n) => n !== name);
    // Fuera de toda zona (el río) solo se avisa: no hay título que mostrar.
    this.zoneListener?.(name ? { name, kind: here[0].kind, above } : null);
    if (!name) return;
    const labels = zc.kindLabel as Record<string, string>;
    this.zoneKicker.replaceChildren();
    [labels[here[0].kind] ?? here[0].kind, ...above].forEach((part, k) => {
      if (k > 0) element('i', '', this.zoneKicker).textContent = '·';
      this.zoneKicker.append(part.toUpperCase());
    });
    this.zoneName.textContent = name;
    // El lema de la zona o, si no tiene, el de la más chica que la contiene (Lomas de Urdesa → Urdesa).
    this.zoneTagline.textContent = here.map((zone) => this.taglines.get(zone.name)).find(Boolean) ?? '';
    // Reinicia la animación.
    this.zoneTitle.classList.remove('show');
    void this.zoneTitle.offsetWidth;
    this.zoneTitle.classList.add('show');
  }

  private updateNearby(dt: number, x: number, z: number): void {
    const cc = this.cfg.card;
    // El más cercano en proporción a su radio (dos lugares vecinos no se turnan la ficha).
    let best: Place | null = null;
    let bestShare = Infinity;
    for (const p of this.places) {
      const d = Math.hypot(x - p.cx, z - p.cz);
      const radius = p.radius ?? cc.defaultRadius;
      if (d > radius + cc.leaveMargin) {
        p.dismissed = false;
        if (this.current === p && !this.manual) this.close(false);
      } else if (d <= radius && !p.dismissed && d / radius < bestShare) {
        best = p;
        bestShare = d / radius;
      }
    }
    // Se abre sola si no hay otra ficha a la vista, o si la que hay es de un lugar que ya quedó atrás.
    if (best && best !== this.current) {
      const cur = this.current;
      const stay = cur !== null && (this.manual || Math.hypot(x - cur.cx, z - cur.cz) <= (cur.radius ?? cc.defaultRadius));
      if (!stay) this.open(best, false);
    }
    const p = this.current;
    if (!p) return;
    const d = Math.hypot(x - p.cx, z - p.cz);
    const here = d <= (p.radius ?? cc.defaultRadius);
    this.cardParts.distance.textContent = here ? cc.hereLabel : cc.distanceFormat.replace('{m}', formatDistance(d));
    this.cardParts.go.hidden = here;
    if (!this.manual && !this.collapsed) {
      this.openFor += dt;
      if (this.openFor >= cc.autoCollapseSeconds && !this.card.matches(':hover')) this.collapse();
    }
  }

  private updatePins(camera: THREE.PerspectiveCamera): void {
    const mc = this.cfg.markers;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const views: PinView[] = [];
    for (const p of this.places) {
      const distance = camera.position.distanceTo(_v.set(p.cx, p.y, p.cz));
      _v.project(camera);
      if (distance <= mc.maxDistance && _v.z < 1 && Math.abs(_v.x) <= 1.1 && Math.abs(_v.y) <= 1.1) {
        views.push({ place: p, x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, distance });
      } else {
        p.pin.hidden = true;
      }
    }
    // Sin amontonar: el de la ficha abierta y luego los más cercanos; el que se montaría sobre
    // otro ya puesto (su rombo o su nombre) no se muestra.
    views.sort((a, b) => Number(b.place === this.current) - Number(a.place === this.current) || a.distance - b.distance);
    const taken: [number, number, number, number][] = [];
    const half = mc.pinSize / 2;
    for (const { place: p, x, y, distance } of views) {
      const scale = THREE.MathUtils.lerp(1, mc.minScale, smoothstep(mc.labelDistance, mc.maxDistance, distance));
      const named = distance <= mc.labelDistance;
      if (!p.labelSize && !p.pin.hidden) p.labelSize = { width: p.label.offsetWidth, height: p.pin.offsetHeight };
      const across = Math.max(half, named && p.labelSize ? p.labelSize.width / 2 : 0) * scale + mc.declutterMargin;
      const below = named && p.labelSize ? p.labelSize.height - half : half;
      const box: [number, number, number, number] = [
        x - across,
        y - half * scale - mc.declutterMargin,
        x + across,
        y + below * scale + mc.declutterMargin,
      ];
      const crowded = taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1]);
      p.pin.hidden = crowded;
      if (crowded) continue;
      taken.push(box);
      p.pin.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -${half}px) scale(${scale.toFixed(3)})`;
      p.pin.style.opacity = (1 - smoothstep(mc.fadeStart, mc.maxDistance, distance)).toFixed(3);
      p.pin.style.setProperty('--label', named ? '1' : '0');
      p.pin.classList.toggle('active', this.current === p);
    }
  }

  private open(p: Place, manual: boolean): void {
    const parts = this.cardParts;
    if (this.current !== p) {
      parts.photo.classList.remove('ready');
      const photo = p.photoInfo;
      parts.photo.hidden = !photo;
      parts.figure.classList.toggle('empty', !photo);
      parts.credit.replaceChildren();
      if (photo) {
        // El recorte y el zoom lento de la foto, centrados en lo importante.
        const focus = p.photo?.focus;
        parts.photo.style.objectPosition = focus ? `${focus[0]}% ${focus[1]}%` : '';
        parts.photo.style.transformOrigin = parts.photo.style.objectPosition;
        parts.photo.src = new URL(photo.url, this.baseUrl).href;
        const link = document.createElement('a');
        link.href = photo.source;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = [this.cfg.card.photoLabel, photo.artist, photo.license].filter(Boolean).join(' · ');
        parts.credit.append(link);
      } else {
        parts.photo.removeAttribute('src');
      }
      parts.year.textContent = p.year;
      parts.kicker.textContent = p.kicker;
      parts.name.textContent = p.name;
      parts.text.textContent = p.text;
      parts.fact.replaceChildren();
      if (p.fact) {
        const label = document.createElement('b');
        label.textContent = this.cfg.card.factLabel;
        parts.fact.append(label, p.fact);
      }
      // Fuentes: el dominio de cada una, enlazado.
      parts.sources.replaceChildren();
      if (p.sources?.length) {
        parts.sources.append(`${this.cfg.card.sourcesLabel} `);
        p.sources.forEach((source, k) => {
          if (k > 0) parts.sources.append(' · ');
          const link = document.createElement('a');
          link.href = source;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = new URL(source).hostname.replace(/^www\./, '');
          parts.sources.append(link);
        });
      }
      this.card.scrollTop = 0;
    }
    this.current = p;
    this.manual = manual;
    this.openFor = 0;
    this.collapsed = false;
    this.card.classList.add('open');
    this.chip.classList.remove('show');
    if (this.compact && !manual) this.collapse();
  }

  /** Con controles táctiles la ficha taparía la ciudad y los controles: se abre al tocar la píldora. */
  setCompact(on: boolean): void {
    this.compact = on;
  }

  /** Recoge la ficha a la píldora (sigue a mano para volver a abrirla). */
  private collapse(): void {
    const p = this.current;
    if (!p) return;
    this.collapsed = true;
    this.card.classList.remove('open');
    this.chip.innerHTML = '<i>i</i>';
    this.chip.append(p.name);
    this.chip.classList.add('show');
  }

  private close(byUser: boolean): void {
    if (this.current && byUser) this.current.dismissed = true;
    this.current = null;
    this.manual = false;
    this.collapsed = false;
    this.card.classList.remove('open');
    this.chip.classList.remove('show');
  }
}

/** "850 m" o "2,4 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
