import { Color, ShapeUtils, Vector2 } from 'three';
import {
  BUILDING_STYLE,
  META_STRIDE,
  PORTAL_FLAG,
  ROOF_KIND,
  SEED_SPAN,
  SEED_STEPS,
  SHOP_FIELDS,
  SHOP_NAMED_FIELDS,
  SHOP_RECORDS,
  SHOP_TABLE,
  SURFACE,
  packShopMix,
} from './buildingFormat';

/** Lo mínimo del ámbito de un worker (el proyecto compila con la lib DOM, no WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<BuildRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/**
 * Worker: descarga un chunk de edificios (JSON del pipeline) y arma la geometría
 * (muros, losas planas con tanque de agua o techos de teja con alero) y los datos
 * de colisión, sin trabar el hilo principal.
 */

export interface BuildingStyle {
  highRiseThreshold: number;
  glassMinHeight: number;
  glassProbability: number;
  lowRisePalette: string[];
  highRisePalette: string[];
  /** Galpones: huella grande y baja (bodegas, fábricas, supermercados). */
  industrial: { minArea: number; maxHeight: number; palette: string[] };
  /** Filas de gradería de los estadios (lista "g" del chunk): color del concreto. */
  stands: { color: string };
  pitchedRoofs: { overhang: number; maxOverhangShare: number; thickness: number; minWall: number };
  waterTanks: {
    probability: number;
    maxBuildingHeight: number;
    minArea: number;
    radius: number[];
    height: number[];
    segments: number;
    margin: number;
    colors: string[];
  };
  /** Alto mínimo (m) para proyectar sombra en la cascada lejana (ver CityShadow.limitFar). */
  farShadowMinHeight: number;
  /** Barrios con su propia paleta (p. ej. Las Peñas), en el marco local. */
  zones: { x: number; z: number; radius: number; palette: string[] }[];
  /** Donde un monumento reemplaza al edificio de los datos (no se dibuja ni choca). */
  exclude: { x: number; z: number; radius: number }[];
  /**
   * Portales (galería en la planta baja): los edificios de al menos `minHeight` m y `minArea`
   * m² cuyo centro cae en el polígono (marco local), con esa probabilidad.
   */
  portales: { polygon: { x: number; z: number }[]; minHeight: number; minArea: number; probability: number };
  /**
   * Locales comerciales (listas "s" y "sn" del chunk, paso `shops`): ancho mínimo y máximo de una
   * crujía (m), cuántas crujías puede correrse un letrero si la suya ya está ocupada, letras de la
   * fuente de los letreros (en el orden de sus índices), tipo de la config del juego de cada tipo
   * del pipeline (el mismo índice que en manifest.shops.kinds; -1 si no está) y tipos de los
   * locales de los portales sin datos (empacados como en la tabla).
   */
  shops: { width: number[]; maxShift: number; letters: string[]; kinds: number[]; fallback: number };
}

export interface BuildRequest {
  id: number;
  url: string;
  style: BuildingStyle;
}

export interface BuildResult {
  id: number;
  ok: true;
  positions: Float32Array;
  facade: Float32Array;
  tint: Uint8Array;
  index: Uint32Array;
  /** Por edificio, META_STRIDE floats (ver buildingFormat.ts). */
  meta: Float32Array;
  /** Coordenadas x,z de todos los anillos de colisión, concatenadas. */
  ringCoords: Float32Array;
  /** Inicio (en floats) de cada anillo dentro de ringCoords, con centinela final. */
  ringStarts: Uint32Array;
  /** Primer anillo de cada edificio, con centinela final. */
  buildingRings: Uint32Array;
  /**
   * La geometría va de los edificios más altos a los más bajos: los primeros `farShadowCount`
   * índices son los de al menos `farShadowMinHeight` m (los que hacen sombra de lejos).
   */
  farShadowCount: number;
  /** Solo en el horizonte lejano: el "c" del edificio de cada vértice (2·chunk + nivel, ver el paso `skyline`). */
  chunk?: Uint16Array;
  /** Tabla de locales (RGBA16UI de SHOP_TABLE.width texels de ancho) o null si no hay locales. */
  shops: Uint16Array | null;
  /** Edificios con locales, con letrero y los que se quedaron sin lugar en la tabla (para el banco). */
  shopStats: { records: number; named: number; dropped: number };
}

export interface BuildError {
  id: number;
  ok: false;
  error: string;
}

type RawBuilding = [number, number, number, number[], ...number[][]];
/** Índice del edificio en el chunk, tipo (ROOF_KIND), ángulo de la cumbrera, pendiente (tangente), altura de la cumbrera. */
type RawRoof = [number, number, number, number, number];
type Vec3 = [number, number, number];
type Rgb = [number, number, number];

const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];

const paletteCache = new Map<string, Rgb[]>();
function palette(colors: string[]): Rgb[] {
  const key = colors.join(',');
  let bytes = paletteCache.get(key);
  if (!bytes) {
    bytes = colors.map((hex) => {
      const c = new Color(hex);
      return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)] as Rgb;
    });
    paletteCache.set(key, bytes);
  }
  return bytes;
}

function signedArea(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let k = 0; k < n; k++) {
    const m = (k + 1) % n;
    a += ring[k * 2] * ring[m * 2 + 1] - ring[m * 2] * ring[k * 2 + 1];
  }
  return a / 2;
}

function reversedRing(ring: number[]): number[] {
  const out: number[] = [];
  for (let k = ring.length / 2 - 1; k >= 0; k--) out.push(ring[k * 2], ring[k * 2 + 1]);
  return out;
}

function insideRing(ring: number[], x: number, z: number): boolean {
  let hit = false;
  const n = ring.length / 2;
  for (let k = 0, m = n - 1; k < n; m = k++) {
    const xk = ring[k * 2];
    const zk = ring[k * 2 + 1];
    const xm = ring[m * 2];
    const zm = ring[m * 2 + 1];
    if (zk > z !== zm > z && x < ((xm - xk) * (z - zk)) / (zm - zk) + xk) hit = !hit;
  }
  return hit;
}

function edgeDistance(ring: number[], x: number, z: number): number {
  let best = Infinity;
  const n = ring.length / 2;
  for (let k = 0, m = n - 1; k < n; m = k++) {
    const ax = ring[m * 2];
    const az = ring[m * 2 + 1];
    const ex = ring[k * 2] - ax;
    const ez = ring[k * 2 + 1] - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * ex, z - az - t * ez));
  }
  return best;
}

/** ¿(x, z) está dentro del polígono? (cruces de un rayo hacia +x). */
function inPolygon(x: number, z: number, polygon: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Pseudoaleatorio estable a partir de la semilla del edificio (0..1); cada `salt`, uno distinto. */
function rand(seed: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Salt de rand() para el ancho de las crujías de locales de un edificio. */
const SHOP_WIDTH_SALT = 12;

/** Array que crece sin copiar en cada push (se recorta al final). */
class Grow<T extends Float32Array | Uint32Array | Uint16Array | Uint8Array> {
  data: T;
  length = 0;
  constructor(private readonly make: (n: number) => T) {
    this.data = make(4096);
  }
  push(...values: number[]): void {
    if (this.length + values.length > this.data.length) {
      const next = this.make(Math.max(this.data.length * 2, this.length + values.length));
      next.set(this.data);
      this.data = next;
    }
    for (const v of values) this.data[this.length++] = v;
  }
  trimmed(): T {
    return this.data.slice(0, this.length) as T;
  }
}

/** Geometría del chunk: vértices con atributos de fachada y tinte de la pieza en curso. */
class MeshBuilder {
  readonly positions = new Grow((n) => new Float32Array(n));
  readonly facade = new Grow((n) => new Float32Array(n));
  readonly tint = new Grow((n) => new Uint8Array(n));
  readonly index = new Grow((n) => new Uint32Array(n));
  private count = 0;
  color: Rgb = [0, 0, 0];
  style = 0;
  /** Alto del muro de la pieza en curso (aFacade.z): las ventanas se dibujan solo debajo. */
  height = 0;
  /** Azar del edificio en curso, en [0, SEED_SPAN): va en la parte fraccionaria de aFacade.w. */
  seed = 0;
  /** Horizonte lejano: "c" del edificio en curso (2·chunk + nivel), en cada vértice (null = no se anota). */
  readonly chunks: Grow<Uint16Array> | null;
  chunk = 0;
  /** Muros exteriores del edificio en curso, con su u (para ubicar los locales); null = no se anotan. */
  segments: WallSegment[] | null = null;

  constructor(trackChunks: boolean) {
    this.chunks = trackChunks ? new Grow((n) => new Uint16Array(n)) : null;
  }

  vertex(x: number, y: number, z: number, u: number, v: number, surface: number): number {
    this.positions.push(x, y, z);
    this.facade.push(u, v, this.height, surface + this.seed);
    this.tint.push(this.color[0], this.color[1], this.color[2], this.style);
    this.chunks?.push(this.chunk);
    return this.count++;
  }

  /** Triángulo con la cara visible hacia `out` (se invierte el orden si hace falta). */
  tri(a: number, b: number, c: number, out: Vec3): void {
    const p = this.positions.data;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) this.index.push(a, b, c);
    else this.index.push(a, c, b);
  }

  /** Polígono convexo plano (en abanico) mirando hacia `out`. */
  polygon(points: Vec3[], surface: number, out: Vec3): void {
    const ids = points.map(([x, y, z]) => this.vertex(x, y, z, 0, 0, surface));
    for (let k = 1; k + 1 < ids.length; k++) this.tri(ids[0], ids[k], ids[k + 1], out);
  }

  /** Muro vertical de A a B, desde y0 hasta un tope que puede variar (hastial). */
  wall(a: [number, number], b: [number, number], y0: number, topA: number, topB: number, u0: number, u1: number, out: Vec3): void {
    this.segments?.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], u0, u1 });
    const a0 = this.vertex(a[0], y0, a[1], u0, 0, SURFACE.wall);
    const b0 = this.vertex(b[0], y0, b[1], u1, 0, SURFACE.wall);
    const b1 = this.vertex(b[0], topB, b[1], u1, topB - y0, SURFACE.wall);
    const a1 = this.vertex(a[0], topA, a[1], u0, topA - y0, SURFACE.wall);
    this.tri(a0, b0, b1, out);
    this.tri(a0, b1, a1, out);
  }
}

/** Un muro exterior del edificio en curso, de a a b, con la u (perímetro) de sus extremos. */
interface WallSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  u0: number;
  u1: number;
}

/**
 * Un edificio con locales, antes de empacar la tabla: ancho de sus crujías (cm), si todas son
 * locales, tipos de los genéricos (empacados) y sus crujías (4 valores cada una: código, índice
 * del letrero en "sn", 0 y variante), o null si todas son genéricas.
 */
interface ShopRecord {
  width: number;
  full: boolean;
  mix: number;
  bays: Uint16Array | null;
}

/** Variante de un letrero (16 bits, FNV-1a): el mismo nombre, el mismo color en toda la ciudad. */
function signVariant(text: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ (h >>> 16)) & 0xffff;
}

/**
 * Parte fraccionaria de aFacade.w de un edificio: su registro en la tabla de locales y su azar en
 * pasos de 1/SEED_STEPS (ver SURFACE en buildingFormat.ts: exacto en un float32).
 */
function facadeSeed(record: number, random: number): number {
  const q = Math.min(SEED_STEPS - 1, Math.floor(random * SEED_STEPS));
  return (SEED_SPAN * (record * SEED_STEPS + q)) / (SHOP_RECORDS * SEED_STEPS);
}

/** Índices de 16 bits de la tabla: hasta aquí llegan los texels que se pueden nombrar. */
const SHOP_TABLE_TEXELS = 1 << 16;

/** Tabla de locales de un chunk (formato en buildingFormat.ts → SHOP_TABLE). */
class ShopTable {
  private readonly records: ShopRecord[] = [];
  private readonly glyphOf: Map<string, number>;
  private readonly space: number;
  /** Negocios con letrero ubicados y edificios que se quedaron sin locales por falta de lugar. */
  named = 0;
  dropped = 0;

  constructor(
    private readonly style: BuildingStyle['shops'],
    private readonly signs: string[],
  ) {
    this.glyphOf = new Map(style.letters.map((ch, k) => [ch, k]));
    this.space = this.glyphOf.get(' ') ?? 0;
  }

  get size(): number {
    return this.records.length;
  }

  /** Registro para el próximo edificio con locales (0 si ya no caben: queda sin locales). */
  reserve(): number {
    if (this.records.length + 1 >= SHOP_RECORDS) {
      this.dropped++;
      return 0;
    }
    this.records.push({ width: 0, full: false, mix: 0, bays: null });
    return this.records.length;
  }

  /**
   * Llena el registro `record`: crujías de `width` m a lo largo de los muros (`perimeter` m en
   * total, u continua); cada negocio de `entry` (lista "s") en la crujía más cercana a su punto
   * sobre `segments` (sus muros exteriores), en ese mismo muro si cabe entera, o hasta `maxShift`
   * crujías más allá si ya está ocupada; el resto, locales genéricos si `full` o sin local.
   */
  fill(
    record: number,
    width: number,
    perimeter: number,
    full: boolean,
    mix: number,
    entry: number[] | undefined,
    segments: WallSegment[],
  ): void {
    const r = this.records[record - 1];
    r.width = Math.round(width * 100);
    r.full = full;
    r.mix = mix;
    // El mismo ancho (redondeado a cm) que usa el shader.
    const w = r.width / 100;
    const count = Math.max(1, Math.ceil(perimeter / w));
    const named = entry ? (entry.length - SHOP_FIELDS) / SHOP_NAMED_FIELDS : 0;
    if (named === 0 && full) return;
    if (count >= SHOP_TABLE.full) {
      this.dropped++;
      return;
    }
    const bays = new Uint16Array(count * 4);
    if (full) for (let b = 0; b < count; b++) bays[b * 4] = SHOP_TABLE.bay.generic;
    const free = (b: number): boolean => bays[b * 4] < SHOP_TABLE.bay.named;
    const shift = this.style.maxShift;
    const search = (start: number, lo: number, hi: number): number => {
      for (let d = 0; d <= shift; d++) {
        if (start + d <= hi && free(start + d)) return start + d;
        if (d > 0 && start - d >= lo && free(start - d)) return start - d;
      }
      return -1;
    };
    for (let k = 0; entry && k < named; k++) {
      const f = SHOP_FIELDS + k * SHOP_NAMED_FIELDS;
      const kind = this.style.kinds[entry[f + 2]] ?? -1;
      const text = this.signs[entry[f + 3]];
      if (kind < 0 || !text) continue;
      // El muro más cercano al negocio y dónde cae sobre él.
      let best: WallSegment | null = null;
      let bestD = Infinity;
      let bestU = 0;
      for (const s of segments) {
        const ex = s.bx - s.ax;
        const ez = s.bz - s.az;
        const len2 = ex * ex + ez * ez;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((entry[f] - s.ax) * ex + (entry[f + 1] - s.az) * ez) / len2)) : 0;
        const d = Math.hypot(entry[f] - s.ax - t * ex, entry[f + 1] - s.az - t * ez);
        if (d < bestD) {
          bestD = d;
          best = s;
          bestU = s.u0 + t * (s.u1 - s.u0);
        }
      }
      if (!best) continue;
      const at = Math.floor(bestU / w);
      const lo = Math.max(0, Math.ceil(best.u0 / w - 1e-6));
      const hi = Math.min(count - 1, Math.floor(best.u1 / w + 1e-6) - 1);
      let bay = lo <= hi ? search(Math.min(hi, Math.max(lo, at)), lo, hi) : -1;
      if (bay < 0) bay = search(Math.min(count - 1, Math.max(0, at)), 0, count - 1);
      if (bay < 0) continue;
      bays.set([SHOP_TABLE.bay.named + kind, entry[f + 3], 0, signVariant(text)], bay * 4);
      this.named++;
    }
    r.bays = bays;
  }

  /** Letras de un letrero como índices de la fuente (lo que no está, espacio). */
  private glyphs(text: string): number[] {
    return [...text].map((ch) => this.glyphOf.get(ch) ?? this.space);
  }

  /**
   * La tabla como datos de una textura RGBA16UI (null si no hay locales). Si los índices de 16
   * bits no alcanzan, los edificios que ya no caben se quedan sin locales.
   */
  pack(): Uint16Array | null {
    if (!this.records.length) return null;
    const names = new Map<number, number>();
    const start: number[] = [];
    let texel = 1 + this.records.length;
    for (const r of this.records) {
      if (!r.bays) {
        start.push(0);
        continue;
      }
      const count = r.bays.length / 4;
      const fresh = new Map<number, number>();
      let need = count;
      for (let b = 0; b < count; b++) {
        const sign = r.bays[b * 4 + 1];
        if (r.bays[b * 4] >= SHOP_TABLE.bay.named && !names.has(sign) && !fresh.has(sign)) {
          const size = Math.ceil(this.glyphs(this.signs[sign]).length / SHOP_TABLE.glyphs);
          fresh.set(sign, need);
          need += size;
        }
      }
      if (texel + need > SHOP_TABLE_TEXELS) {
        // Sin lugar: una sola crujía, el texel 0 (sin local).
        r.bays = null;
        start.push(-1);
        this.dropped++;
        continue;
      }
      start.push(texel);
      for (const [sign, offset] of fresh) names.set(sign, texel + offset);
      texel += need;
    }
    const width = SHOP_TABLE.width;
    const data = new Uint16Array(Math.ceil(texel / width) * width * 4);
    this.records.forEach((r, i) => {
      const header = (1 + i) * 4;
      if (start[i] < 0) {
        data.set([0, 1, r.width, r.mix], header);
        return;
      }
      const count = r.bays ? r.bays.length / 4 : 0;
      data.set([start[i], count | (r.full && count ? SHOP_TABLE.full : 0), r.width, r.mix], header);
      for (let b = 0; r.bays && b < count; b++) {
        const o = (start[i] + b) * 4;
        const code = r.bays[b * 4];
        data[o] = code;
        if (code < SHOP_TABLE.bay.named) continue;
        const sign = r.bays[b * 4 + 1];
        data[o + 1] = names.get(sign) ?? 0;
        data[o + 2] = [...this.signs[sign]].length;
        data[o + 3] = r.bays[b * 4 + 3];
      }
    });
    // Letreros: SHOP_TABLE.glyphs letras por texel, dos por canal (la primera en el byte bajo).
    for (const [sign, first] of names) {
      this.glyphs(this.signs[sign]).forEach((g, k) => {
        const channel = (first + Math.floor(k / SHOP_TABLE.glyphs)) * 4 + ((k % SHOP_TABLE.glyphs) >> 1);
        data[channel] |= g << (8 * (k & 1));
      });
    }
    return data;
  }
}

interface Collision {
  rings: number[][];
  meta: number[];
}

/**
 * Casa con techo de teja: muros en un rectángulo metido bajo el alero y techo a dos
 * aguas (hastiales en los extremos) o a cuatro aguas, con canto y cara inferior.
 * El rectángulo sale de proyectar la huella sobre la dirección de la cumbrera.
 */
function pitchedHouse(m: MeshBuilder, y0: number, ring: number[], roof: RawRoof, color: Rgb, style: BuildingStyle): Collision | null {
  const [, kind, angle, slope, ridge] = roof;
  const ax = Math.cos(angle);
  const az = Math.sin(angle);
  const nx = -az;
  const nz = ax;
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    const u = ring[k] * nx + ring[k + 1] * nz;
    const v = ring[k] * ax + ring[k + 1] * az;
    umin = Math.min(umin, u);
    umax = Math.max(umax, u);
    vmin = Math.min(vmin, v);
    vmax = Math.max(vmax, v);
  }
  const W = (umax - umin) / 2;
  const L = (vmax - vmin) / 2;
  if (!(W > 0 && L > 0)) return null;
  const cu = (umin + umax) / 2;
  const cv = (vmin + vmax) / 2;
  const cx = cu * nx + cv * ax;
  const cz = cu * nz + cv * az;
  const pr = style.pitchedRoofs;
  const overhang = Math.min(pr.overhang, W * pr.maxOverhangShare);
  let edge = ridge - slope * W;
  edge += Math.max(0, y0 + pr.minWall - (edge + slope * overhang));
  const top = edge + slope * W;
  const eave = edge + slope * overhang;
  const hip = kind === ROOF_KIND.hip;
  const halfRidge = hip ? Math.max(0, L - W) : L;
  const roofY = (u: number, v: number): number =>
    edge + slope * (hip ? Math.min(W - Math.abs(u), L - Math.abs(v)) : W - Math.abs(u));
  const world = (u: number, v: number): [number, number] => [cx + u * nx + v * ax, cz + u * nz + v * az];
  const at = (u: number, v: number, y: number): Vec3 => [cx + u * nx + v * ax, y, cz + u * nz + v * az];
  const dir = (u: number, v: number): Vec3 => [u * nx + v * ax, 0, u * nz + v * az];

  m.color = color;
  m.style = BUILDING_STYLE.house;
  m.height = eave - y0;

  // Muros: rectángulo metido bajo el alero; en los testeros de dos aguas el tope sube hasta la cumbrera.
  const wi = W - overhang;
  const li = L - overhang;
  const corners: [number, number][] = [
    [-wi, -li],
    [wi, -li],
    [wi, li],
    [-wi, li],
  ];
  let perimeter = 0;
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = corners[k];
    const [u1, v1] = corners[(k + 1) % 4];
    const pts: [number, number][] = !hip && v0 === v1 ? [[u0, v0], [0, v0], [u1, v1]] : [[u0, v0], [u1, v1]];
    const out = dir((u0 + u1) / 2, (v0 + v1) / 2);
    for (let s = 0; s + 1 < pts.length; s++) {
      const [pu, pv] = pts[s];
      const [qu, qv] = pts[s + 1];
      const len = Math.hypot(qu - pu, qv - pv);
      m.wall(world(pu, pv), world(qu, qv), y0, roofY(pu, pv), roofY(qu, qv), perimeter, perimeter + len, out);
      perimeter += len;
    }
  }

  // Techo: las aguas miran hacia arriba (foto satelital); la cara inferior, un poco más abajo.
  const faces: [number, number][][] = [
    [
      [0, -halfRidge],
      [0, halfRidge],
      [W, L],
      [W, -L],
    ],
    [
      [0, halfRidge],
      [0, -halfRidge],
      [-W, -L],
      [-W, L],
    ],
  ];
  if (hip) {
    faces.push(
      [
        [0, halfRidge],
        [-W, L],
        [W, L],
      ],
      [
        [0, -halfRidge],
        [W, -L],
        [-W, -L],
      ],
    );
  }
  for (const face of faces) {
    m.polygon(
      face.map(([u, v]) => at(u, v, roofY(u, v))),
      SURFACE.roof,
      UP,
    );
    m.polygon(
      face.map(([u, v]) => at(u, v, roofY(u, v) - pr.thickness)),
      SURFACE.trim,
      DOWN,
    );
  }

  // Canto del techo alrededor del borde (en dos aguas sigue la pendiente del testero).
  const outline: [number, number][] = hip
    ? [
        [-W, -L],
        [W, -L],
        [W, L],
        [-W, L],
      ]
    : [
        [-W, -L],
        [0, -L],
        [W, -L],
        [W, L],
        [0, L],
        [-W, L],
      ];
  for (let k = 0; k < outline.length; k++) {
    const [pu, pv] = outline[k];
    const [qu, qv] = outline[(k + 1) % outline.length];
    const yp = roofY(pu, pv);
    const yq = roofY(qu, qv);
    m.polygon(
      [at(pu, pv, yp), at(qu, qv, yq), at(qu, qv, yq - pr.thickness), at(pu, pv, yp - pr.thickness)],
      SURFACE.trim,
      dir((pu + qu) / 2, (pv + qv) / 2),
    );
  }

  const inset = corners.flatMap(([u, v]) => world(u, v));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < inset.length; k += 2) {
    minX = Math.min(minX, inset[k]);
    maxX = Math.max(maxX, inset[k]);
    minZ = Math.min(minZ, inset[k + 1]);
    maxZ = Math.max(maxZ, inset[k + 1]);
  }
  return {
    rings: [inset],
    meta: [y0, top, minX, maxX, minZ, maxZ, kind, cx, cz, ax, az, W, L, slope, edge],
  };
}

/** Tanque de agua sobre una losa: cerca de una esquina, donde quepa entero. */
function waterTank(m: MeshBuilder, ring: number[], y1: number, seed: number, area: number, style: BuildingStyle): void {
  const t = style.waterTanks;
  if (area < t.minArea || rand(seed, 7) >= t.probability) return;
  const radius = lerp(t.radius[0], t.radius[1], rand(seed, 8));
  const height = lerp(t.height[0], t.height[1], rand(seed, 9));
  const n = ring.length / 2;
  const clear = radius + t.margin;
  const first = Math.floor(rand(seed, 10) * n);
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    const vx = ring[i * 2];
    const vz = ring[i * 2 + 1];
    const ax = ring[prev * 2] - vx;
    const az = ring[prev * 2 + 1] - vz;
    const bx = ring[next * 2] - vx;
    const bz = ring[next * 2 + 1] - vz;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    // Sobre la bisectriz de la esquina, a `clear` de los dos muros que la forman: t = clear / sen(ángulo).
    const sin = Math.abs(ax * bz - az * bx) / (la * lb);
    if (!(sin > 0)) continue;
    const step = clear / sin;
    const px = vx + (ax / la + bx / lb) * step;
    const pz = vz + (az / la + bz / lb) * step;
    if (!insideRing(ring, px, pz) || edgeDistance(ring, px, pz) < clear) continue;
    const colors = palette(t.colors);
    m.color = colors[seed % colors.length];
    m.style = BUILDING_STYLE.fixture;
    m.height = height;
    const rim: [number, number][] = [];
    for (let s = 0; s < t.segments; s++) {
      const a = (s / t.segments) * Math.PI * 2;
      rim.push([px + Math.cos(a) * radius, pz + Math.sin(a) * radius]);
    }
    for (let s = 0; s < t.segments; s++) {
      const a = rim[s];
      const b = rim[(s + 1) % t.segments];
      m.wall(a, b, y1, y1 + height, y1 + height, 0, 0, [(a[0] + b[0]) / 2 - px, 0, (a[1] + b[1]) / 2 - pz]);
    }
    m.polygon(
      rim.map(([x, z]) => [x, y1 + height, z]),
      SURFACE.wall,
      UP,
    );
    return;
  }
}

/**
 * `chunks`: el "c" de cada edificio (solo en los grupos del horizonte lejano); `shops` y `signs`:
 * listas "s" y "sn" del chunk (locales comerciales, ver buildingFormat.ts).
 */
function build(
  raw: RawBuilding[],
  roofs: RawRoof[],
  style: BuildingStyle,
  chunks?: number[],
  stands: number[] = [],
  shops: number[][] = [],
  signs: string[] = [],
): Omit<BuildResult, 'id' | 'ok'> {
  const m = new MeshBuilder(chunks !== undefined);
  const shopOf = new Map(shops.map((s) => [s[0], s]));
  const table = new ShopTable(style.shops, signs);
  const kindOf = (k: number): number => style.shops.kinds[k] ?? -1;
  const standRows = new Set(stands);
  const concrete = palette([style.stands.color]);
  const meta = new Float32Array(raw.length * META_STRIDE);
  const ringCoords = new Grow((n) => new Float32Array(n));
  const ringStarts = new Grow((n) => new Uint32Array(n));
  const buildingRings = new Uint32Array(raw.length + 1);
  const low = palette(style.lowRisePalette);
  const high = palette(style.highRisePalette);
  const shed = palette(style.industrial.palette);
  const zonePalettes = style.zones.map((zone) => palette(zone.palette));
  const roofOf = new Map(roofs.map((r) => [r[0], r]));
  const collisions: Collision[] = new Array(raw.length);
  // Geometría de los más altos a los más bajos (sombra lejana solo de los altos); los datos
  // de colisión siguen el orden original (los techos inclinados se refieren a ese índice).
  const order = raw.map((_, b) => b).sort((a, b) => raw[b][1] - raw[b][0] - (raw[a][1] - raw[a][0]));
  let farShadowCount = -1;

  for (const b of order) {
    const [y0, y1, seed, ...rawRings] = raw[b];
    if (chunks) m.chunk = chunks[b];
    // Centro de la huella: para las zonas de paleta y los monumentos que lo reemplazan.
    const outer = rawRings[0];
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < outer.length; k += 2) {
      cx += outer[k];
      cz += outer[k + 1];
    }
    cx /= outer.length / 2;
    cz /= outer.length / 2;
    if (style.exclude.some((e) => Math.hypot(cx - e.x, cz - e.z) <= e.radius)) {
      // Sin geometría ni colisión: un recuadro vacío no entra en el índice.
      const empty = new Array<number>(META_STRIDE).fill(0);
      empty[2] = 1;
      empty[4] = 1;
      collisions[b] = { rings: [], meta: empty };
      continue;
    }
    if (farShadowCount < 0 && y1 - y0 < style.farShadowMinHeight) farShadowCount = m.index.length;
    // Muros hacia afuera: anillo exterior horario y huecos antihorarios (en el plano x-z).
    const rings = rawRings.map((ring, k) => ((k === 0 ? signedArea(ring) > 0 : signedArea(ring) < 0) ? reversedRing(ring) : ring));
    const height = y1 - y0;
    const area = Math.abs(signedArea(rings[0]));
    const stand = standRows.has(b);
    const kind = stand
      ? BUILDING_STYLE.stand
      : area >= style.industrial.minArea && height <= style.industrial.maxHeight
        ? BUILDING_STYLE.industrial
        : height >= style.glassMinHeight && rand(seed, 1) < style.glassProbability
          ? BUILDING_STYLE.glass
          : height >= style.highRiseThreshold
            ? BUILDING_STYLE.high
            : BUILDING_STYLE.low;
    const pz = style.portales;
    const portal =
      (kind === BUILDING_STYLE.low || kind === BUILDING_STYLE.high) &&
      height >= pz.minHeight &&
      area >= pz.minArea &&
      rand(seed, 11) < pz.probability &&
      inPolygon(cx, cz, pz.polygon);
    const zone = style.zones.findIndex((z) => Math.hypot(cx - z.x, cz - z.z) <= z.radius);
    const colors = stand
      ? concrete
      : zone >= 0 && kind !== BUILDING_STYLE.industrial
        ? zonePalettes[zone]
        : kind === BUILDING_STYLE.low
          ? low
          : kind === BUILDING_STYLE.industrial
            ? shed
            : high;
    const color = colors[seed % colors.length];
    const roof = rings.length === 1 && !stand ? roofOf.get(b) : undefined;

    // Locales (paso `shops`): los negocios con letrero de la lista "s" en cualquier edificio que no
    // sea galpón ni gradería; los genéricos (todas las crujías locales) solo en edificios bajos o
    // altos de una zona o calle comercial y en los portales, donde el centro siempre tiene tiendas.
    const entry = shopOf.get(b);
    const named = entry ? (entry.length - SHOP_FIELDS) / SHOP_NAMED_FIELDS : 0;
    const street = !roof && (kind === BUILDING_STYLE.low || kind === BUILDING_STYLE.high);
    const full = street && (entry ? entry[1] === 1 : portal);
    const record = kind !== BUILDING_STYLE.industrial && !stand && (full || named > 0) ? table.reserve() : 0;
    m.seed = facadeSeed(record, rand(seed, 7));
    const segments: WallSegment[] = [];
    m.segments = record ? segments : null;
    let perimeter = 0;

    const pitched = roof ? pitchedHouse(m, y0, rings[0], roof, color, style) : null;
    let collision: Collision;
    if (pitched) {
      collision = pitched;
      perimeter = segments.length ? segments[segments.length - 1].u1 : 0;
    } else {
      m.color = color;
      m.style = kind + (portal ? PORTAL_FLAG : 0);
      m.height = height;
      // u sigue de un anillo al siguiente: cada crujía de locales tiene una sola u en el edificio.
      rings.forEach((ring, r) => {
        const n = ring.length / 2;
        // Los locales con nombre van en el anillo exterior (los huecos son patios).
        if (r > 0) m.segments = null;
        for (let k = 0; k < n; k++) {
          const next = (k + 1) % n;
          const a: [number, number] = [ring[k * 2], ring[k * 2 + 1]];
          const c: [number, number] = [ring[next * 2], ring[next * 2 + 1]];
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (len < 1e-3) continue;
          // Exterior de área negativa y huecos al revés: la normal hacia afuera es (za − zc, 0, xc − xa).
          m.wall(a, c, y0, y1, y1, perimeter, perimeter + len, [a[1] - c[1], 0, c[0] - a[0]]);
          perimeter += len;
        }
      });
      m.segments = null;

      const toPoints = (ring: number[]): Vector2[] => {
        const pts: Vector2[] = [];
        for (let k = 0; k < ring.length; k += 2) pts.push(new Vector2(ring[k], ring[k + 1]));
        return pts;
      };
      const contour = toPoints(rings[0]);
      const holes = rings.slice(1).map(toPoints);
      const all = [contour, ...holes].flat();
      const ids = all.map((p) => m.vertex(p.x, y1, p.y, 0, 0, SURFACE.roof));
      for (const [a, bb, c] of ShapeUtils.triangulateShape(contour, holes)) m.tri(ids[a], ids[bb], ids[c], UP);

      if (kind === BUILDING_STYLE.low && height <= style.waterTanks.maxBuildingHeight) {
        waterTank(m, rings[0], y1, seed, area, style);
      }

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of contour) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.y);
        maxZ = Math.max(maxZ, p.y);
      }
      const flat = new Array<number>(META_STRIDE).fill(0);
      flat.splice(0, 7, y0, y1, minX, maxX, minZ, maxZ, ROOF_KIND.flat);
      collision = { rings, meta: flat };
    }
    collisions[b] = collision;
    m.segments = null;
    if (record) {
      const own = entry ? kindOf(entry[2]) : -1;
      const mix = entry && own >= 0 ? packShopMix(own, Math.max(kindOf(entry[3]), 0), entry[4] / 100) : style.shops.fallback;
      const width = lerp(style.shops.width[0], style.shops.width[1], rand(seed, SHOP_WIDTH_SALT));
      table.fill(record, width, perimeter, full, mix, entry, segments);
    }
  }
  if (farShadowCount < 0) farShadowCount = m.index.length;

  collisions.forEach((collision, b) => {
    meta.set(collision.meta, b * META_STRIDE);
    buildingRings[b] = ringStarts.length;
    for (const ring of collision.rings) {
      ringStarts.push(ringCoords.length);
      ringCoords.push(...ring);
    }
  });
  buildingRings[raw.length] = ringStarts.length;
  ringStarts.push(ringCoords.length);

  return {
    positions: m.positions.trimmed(),
    facade: m.facade.trimmed(),
    tint: m.tint.trimmed(),
    index: m.index.trimmed(),
    meta,
    ringCoords: ringCoords.trimmed(),
    ringStarts: ringStarts.trimmed(),
    buildingRings,
    farShadowCount,
    chunk: m.chunks?.trimmed(),
    shops: table.pack(),
    shopStats: { records: table.size, named: table.named, dropped: table.dropped },
  };
}

scope.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { id, url, style } = event.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // `c`: 2·chunk + nivel de cada edificio, solo en los grupos del horizonte lejano; `g`: filas
    // de gradería de los estadios; `s` y `sn`: locales comerciales y sus letreros.
    const data = (await res.json()) as {
      b: RawBuilding[];
      r?: RawRoof[];
      c?: number[];
      g?: number[];
      s?: number[][];
      sn?: string[];
    };
    const result: BuildResult = { id, ok: true, ...build(data.b, data.r ?? [], style, data.c, data.g, data.s, data.sn) };
    const transfer: Transferable[] = [
      result.positions.buffer,
      result.facade.buffer,
      result.tint.buffer,
      result.index.buffer,
      result.meta.buffer,
      result.ringCoords.buffer,
      result.ringStarts.buffer,
      result.buildingRings.buffer,
    ];
    if (result.chunk) transfer.push(result.chunk.buffer);
    if (result.shops) transfer.push(result.shops.buffer);
    scope.postMessage(result, transfer);
  } catch (err) {
    const error: BuildError = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(error);
  }
};
