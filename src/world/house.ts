import * as THREE from 'three';
import { Batch, type Glow, NO_GLOW, PATTERN, type Surface, glowOf, patternOf } from './monumentParts';
import type { LocalRoof, PlaceKit, PlaceSite, PlaceType } from './placeKit';

/**
 * Casas de Guayaquil a partir de su config (config/houses/*.json para las repetidas de una
 * urbanización, config/sites/*.json para una casa sola): volúmenes de uno o más pisos con sus
 * retranqueos y volados, techo a dos aguas (cumbrera paralela a la calle o hastial a la calle), a
 * una agua o losa, vanos contados con su moldura, derrame y relleno (ventana corrediza, puerta de
 * tableros, portón, marco alto con paños), paños de color o de piedra, bruñas, zócalo, tejadillos,
 * apliques, balcones, pisos, cerramiento del frente, jardineras, tanques y aires, y el cierre del
 * retiro lateral con el pilar del medidor. La casa de la próxima persona es solo config y fotos.
 *
 * Marcos:
 * - el de la config ("marco de la casa"): x a lo largo del frente desde la esquina izquierda vista
 *   desde la calle, z hacia el fondo desde la fachada más adelantada, y hacia arriba desde el suelo
 *   del jardín junto a la fachada (como en las plantas y las fotos de frente);
 * - el de la geometría: X a lo largo del frente con 0 en el medio de la casa, Y arriba y Z hacia la
 *   calle (Z = 0 en la fachada más adelantada). Es el que se instancia (espejado en X para la otra
 *   mano) y el marco local de una casa sola.
 */

/** Hacia dónde da un muro (visto desde la calle: el frente da a la calle). */
export type HouseSide = 'front' | 'back' | 'left' | 'right';

/** Los cuatro lados (para revisar la config). */
const SIDES: readonly HouseSide[] = ['front', 'back', 'left', 'right'];

/** Un volumen: uno o más pisos con la misma planta. */
export interface HouseVolume {
  /** Qué es (para leer la config: "PB sala", "PA máster"). */
  name: string;
  /** Planta (marco de la casa, m): rectilínea, en cualquier sentido. */
  outline: number[][];
  /** Pie del volumen sobre el suelo del jardín (m): 0 en planta baja. */
  base: number;
  /** Alto de su pie a su techo (m). Bajo el techo inclinado, los muros suben hasta las aguas. */
  height: number;
  /** Papel de color de sus muros (ver HouseModel.colors); sin él, `main`. */
  role?: string;
  /**
   * Qué muros llevan ese papel (sin él, todos): un paño de acento o de piedra que va solo en el
   * frente de su volumen; los demás muros del volumen van con `main`.
   */
  faces?: HouseSide[];
  /** Si lo cubre el techo de la casa (si no, lleva su losa encima). Sin él: si no hay otro volumen encima. */
  roofed?: boolean;
  source: string;
}

/** El techo de la casa (sobre los volúmenes que cubre). */
export interface HouseRoof {
  /** 'gable' a dos aguas, 'shed' a una agua, 'flat' losa. */
  kind: 'gable' | 'shed' | 'flat';
  /** Hacia dónde corre la cumbrera: 'x' paralela a la calle (hastiales a los lados), 'z' hacia el fondo (hastial a la calle). */
  ridge: 'x' | 'z';
  /** Pendiente de las aguas (grados). */
  pitch: number;
  /**
   * Alto del borde de abajo de la fascia (m): en 'gable', en el alero delantero (cumbrera 'x') o el
   * izquierdo ('z'); en 'shed', en el alero bajo; en 'flat', la cara de arriba de la losa.
   */
  eave: number;
  /**
   * Dónde va la cumbrera (m, en z si la cumbrera es 'x', en x si es 'z'); sin él, al medio. En
   * 'shed' es obligatorio: el muro del lado alto.
   */
  ridgeAt?: number;
  /** Vuelo más allá de los muros (m) hacia cada lado. */
  overhang: { front: number; back: number; left: number; right: number };
  source: string;
}

/** Una celda de un marco alto (de abajo arriba): vidrio o un paño de un papel de color. */
export interface HouseCell {
  /** Alto (m, desde el suelo) de la celda. */
  y: number[];
  /** 'glass' o el papel de color del paño. */
  fill: string;
  /** Hojas del vidrio [columnas, filas] (solo 'glass'). */
  panes?: number[];
}

/** Protección de un vano: tubos horizontales o baranda de barrotes (balcón francés). */
export interface HouseGuard {
  kind: 'tubes' | 'rail';
  /** Entre qué alturas (m). */
  y: number[];
  /** Tubos: cuántos. */
  count?: number;
}

/** Un vano de la fachada, con su medida contada en las fotos o los planos. */
export interface HouseOpening {
  /**
   * 'window' ventana corrediza con su vidrio; 'door' puerta de tableros; 'garage' portón
   * enrollable; 'frame' marco alto con celdas apiladas (vidrio o paño); 'void' vano abierto con el
   * interior a oscuras.
   */
  kind: 'window' | 'door' | 'garage' | 'frame' | 'void';
  /** El muro: 'front' (por defecto), 'back', 'left' o 'right'. */
  side?: HouseSide;
  /** Borde de afuera de la moldura a lo largo del muro (m): en x si es el frente o el fondo, en z si es un lado. */
  x: number[];
  /** Borde de afuera de la moldura en alto (m, desde el suelo). */
  y: number[];
  /** El plano del muro (z si es el frente o el fondo, x si es un lado) si hay más de uno; sin él, el de más afuera. */
  plane?: number;
  /** Hojas del vidrio [columnas, filas] ('window'). */
  panes?: number[];
  /** Las celdas ('frame'). */
  cells?: HouseCell[];
  guard?: HouseGuard;
  /** Si de noche tiene luz adentro. */
  lit?: boolean;
  /** Otra moldura que la común de su clase: papel de color y ancho (0 = sin moldura). */
  molding?: { role: string; width: number };
  source: string;
}

/** Un paño de color o de piedra, una bruña o una banda sobre un muro (a ras del muro). */
export interface HouseRegion {
  side?: HouseSide;
  /** A lo largo del muro (m, como en HouseOpening.x). */
  x: number[];
  /** En alto (m). */
  y: number[];
  plane?: number;
  /** Papel de color. */
  role: string;
  /** Más claro u oscuro que su papel (1 = igual): una bruña es el muro en sombra. */
  shade?: number;
  source: string;
}

/** Tejadillo sobre ménsulas: una plancha inclinada que sale del muro. */
export interface HouseCanopy {
  side?: HouseSide;
  x: number[];
  /** Alto (m) del borde de afuera y del arranque en el muro. */
  y: number[];
  /** Cuánto sale del muro (m). */
  depth: number;
  plane?: number;
  /** Papel de color de la plancha. */
  role: string;
  source: string;
}

/** Aplique de pared (un foco con su pantalla). */
export interface HouseLamp {
  side?: HouseSide;
  /** Centro a lo largo del muro y alto del centro (m). */
  x: number;
  y: number;
  plane?: number;
  source: string;
}

/** Un piso horizontal: el del porche, un caminito, una grada. */
export interface HouseFloor {
  /** Contorno (marco de la casa, m). */
  outline: number[][];
  /** Alto de la cara de arriba (m). */
  y: number;
  role: string;
  source: string;
}

/** Balcón con losa que sale del muro y baranda en sus tres bordes. */
export interface HouseBalcony {
  side?: HouseSide;
  x: number[];
  /** Alto del piso del balcón (m). */
  y: number;
  /** Cuánto sale (m). */
  depth: number;
  /** Grosor de la losa (m), bajo el piso del balcón. */
  slab: number;
  plane?: number;
  /** Alto de la baranda sobre el piso (m). */
  rail: number;
  /** Papel de color de la losa. */
  role: string;
  source: string;
}

/** Cerramiento del frente del lote: muro bajo, reja encima, pilares y portones. */
export interface HouseFence {
  /** A cuánto delante de la fachada más adelantada (m). */
  depth: number;
  /** Alto del muro bajo y alto total con la reja (m). */
  wall: number;
  height: number;
  /** Grosor del muro (m). */
  thickness: number;
  /** Pilares: cada cuánto (m) y su lado (m). */
  posts: number[];
  /** Tramos del frente (x, m) con portón (reja de piso a arriba). */
  gates: number[][];
  /** Papel del muro y los pilares, y el de la reja. */
  role: string;
  rail: string;
  source: string;
}

/** Jardinera: un borde bajo y tierra con hierba adentro. */
export interface HousePlanter {
  outline: number[][];
  /** Alto del borde (m). */
  height: number;
  /** Ancho del borde (m) y cuánto más abajo que su canto queda la tierra (m). */
  lip: number;
  drop: number;
  /** Papel del borde y el de la tierra. */
  role: string;
  soil: string;
  source: string;
}

/** Tanque de agua (un cilindro parado). */
export interface HouseTank {
  /** Centro del pie (marco de la casa: x, y, z; m). */
  at: number[];
  /** Diámetro y alto (m). */
  size: number[];
  role: string;
  source: string;
}

/** Condensador de un aire acondicionado en un muro. */
export interface HouseUnit {
  side?: HouseSide;
  /** Centro a lo largo del muro y alto del pie (m). */
  x: number;
  y: number;
  plane?: number;
  /** Ancho, alto y fondo (m). */
  size: number[];
  role: string;
  source: string;
}

/** Un modelo de casa: su planta, su techo y su fachada, medidos. */
export interface HouseModel {
  name: string;
  /** De dónde salen la planta y las alturas (planos, fotos, con su fecha). */
  source: string;
  /** Lado del retiro lateral en la mano descrita (el otro muro va sobre el lindero). */
  setback: 'left' | 'right';
  volumes: HouseVolume[];
  roof: HouseRoof;
  /** Zócalo al pie de los muros de planta baja: alto (m), papel de color y su tono. */
  plinth?: { height: number; role: string; shade?: number };
  openings: HouseOpening[];
  /** Paños de color o de piedra. */
  panels?: HouseRegion[];
  /** Bruñas y bandas. */
  bands?: HouseRegion[];
  canopies?: HouseCanopy[];
  lamps?: HouseLamp[];
  floors?: HouseFloor[];
  balconies?: HouseBalcony[];
  fence?: HouseFence;
  planters?: HousePlanter[];
  tanks?: HouseTank[];
  units?: HouseUnit[];
  /** Color (hex) de cada papel según las fotos del modelo; un esquema de colores los reemplaza. */
  colors: Record<string, string>;
}

/** Acabado de un papel de color: su dibujo (PATTERN), cuántas unidades mide por metro y su tono. */
export interface HouseFinish {
  pattern: string;
  scale?: number[];
  tone?: number;
}

/** Las medidas comunes de las piezas (las de una urbanización, o las de una casa sola). */
export interface HouseParts {
  /** De dónde salen estas medidas (fotos, planos, catálogos) y cuáles son estimadas. */
  source: string;
  /** Cuánto bajan los muros de planta baja bajo el suelo (m): en pendiente no queda una rendija. */
  bury: number;
  /** Acabado de cada papel de color (los que no están van lisos). */
  finishes: Record<string, HouseFinish>;
  /** Moldura de las ventanas: ancho (m), cuánto sale del muro (m) y su papel. */
  molding: { width: number; out: number; role: string };
  /** Fondo del derrame, del muro al vidrio o a la puerta (m). */
  reveal: number;
  /** Vidrio: papel de color, tono del marco de aluminio respecto del vidrio (dibujo `glazing`) y su luz de noche. */
  glass: { role: string; tone: number; glow: Glow };
  /** Puerta: su papel y el ancho y papel de su marco (m). */
  door: { role: string; frame: number; frameRole: string };
  /** Portón enrollable: su papel. */
  garage: { role: string };
  /** Fondo de un vano abierto: su papel. */
  interior: { role: string };
  /** Tubos de protección: lado de su sección (m) y papel. */
  tube: { size: number; role: string };
  /** Baranda: separación y lado de los barrotes, lado del pasamanos, cuánto sale del muro (m) y papel. */
  rail: { spacing: number; bar: number; rail: number; out: number; role: string };
  /**
   * Techo: grosor de la plancha, alto de la fascia bajo su borde (m), a qué lados se ve el borde
   * ondulado (serrucho) de la plancha y la onda (paso, alto y puntos por onda; cuánto sale la
   * plancha más allá de la fascia, m); papeles del cielo bajo la plancha, de la fascia y del borde.
   */
  roof: {
    sheet: number;
    fascia: number;
    edges: HouseSide[];
    wave: { pitch: number; height: number; segments: number; out: number };
    soffit: string;
    fasciaRole: string;
    edge: string;
  };
  /** Tejadillo: grosor de la plancha (m), lado de las ménsulas (m), cuánto bajan bajo el arranque (m) y su papel. */
  canopy: { sheet: number; bracket: number; drop: number; bracketRole: string };
  /** Aplique: ancho, alto y fondo (m), papel y luz de noche. */
  lamp: { size: number[]; role: string; glow: Glow };
  /** Losas a la vista (el techo de un volumen sin techo inclinado, el cielo de un volado): su papel. */
  slab: { role: string };
  /** Oclusión ambiental: derrames, cielos de aleros, cielos de volados y porches, bajo los tejadillos. */
  ao: { reveal: number; soffit: number; porch: number; canopy: number };
  /**
   * El lote: retiro lateral (m); cierre del retiro junto a la fachada (alto, grosor, a cuánto detrás
   * de la fachada más adelantada, m; papel) y pilar del medidor en el lindero del retiro (ancho,
   * fondo y alto, m; capuchón: ancho, fondo y grosor, m; papeles).
   */
  lot: {
    setback: number;
    closure: { height: number; thickness: number; z: number; role: string };
    pillar: { size: number[]; cap: number[]; role: string; capRole: string };
  };
  /** Casa en obra: grosor de los muros de bloque (m) y papel del bloque. */
  obra: { thickness: number; role: string };
  /** Lados de los tanques (cilindros). */
  sides: number;
}

// ============================================================================================
// Lo que devuelve el armado
// ============================================================================================

/**
 * Un faldón del techo (marco de la geometría): la cara de abajo de la plancha va de la línea
 * p0-p1 (arriba, a la altura de p0.y) bajando `run` m en planta hacia `down` con pendiente `slope`.
 */
export interface Faldon {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  down: THREE.Vector3;
  run: number;
  slope: number;
}

/** Una caja de la casa en obra (marco de la geometría): centro, dirección de su largo y medidas. */
export interface ObraBox {
  center: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  height: number;
  thickness: number;
}

/** Un rectángulo de física (marco de la geometría), como PlaceSite.box. */
export interface HouseBox {
  x: number;
  z: number;
  halfU: number;
  halfV: number;
  angle: number;
  top: number;
  floor: boolean;
  bottom: number;
}

/** Una casa armada (marco de la geometría, pie en y = 0). */
export interface HouseShape {
  /**
   * Geometría de cerca (sin color: `paintHouse` le pone el de cada papel), con los vértices iguales
   * unidos y su índice ordenado: primero lo que se ve a toda distancia y al final lo fino (cantos de
   * molduras, onda del borde del techo, tubos, barandas, ménsulas).
   */
  body: THREE.BufferGeometry;
  /** Cuántos índices de `body` van antes de lo fino (el `drawRange` de la versión de media distancia). */
  coarse: number;
  /** Lo chico (apliques, tubos, barrotes, ménsulas), si se pidió aparte. */
  detail: THREE.BufferGeometry | null;
  /** Papel (índice en `roles`) y tono de cada vértice de `body` y de `detail`. */
  roles: string[];
  role: Uint8Array;
  shade: Float32Array;
  detailRole: Uint8Array;
  detailShade: Float32Array;
  roof: Faldon[];
  /** Planta baja (X, Z) para la física. */
  outline: THREE.Vector2[];
  /** Techo para caminarlo (marco de la geometría), sin él si es losa. */
  walk: LocalRoof | null;
  /** Punto más alto (m). */
  top: number;
  /** Ancho (X) y fondo (de Z = 0 hacia −Z) de los muros (m). */
  width: number;
  depth: number;
  /**
   * Para la versión de lejos (m): alto de los muros (donde arrancan los hastiales), de la cara de
   * abajo de la plancha en el alero y en la cumbrera, y hacia dónde corre la cumbrera.
   */
  far: { walls: number; eave: number; ridge: number; axis: 'x' | 'z' };
  /** Alto de los muros de la casa en obra (m). */
  obraTop: number;
  /** Medio ancho y fondo del techo con sus vuelos (X: de −a a +a; Z: de front a −back). */
  roofSpan: { half: number; front: number; back: number };
  obra: ObraBox[];
  /** La física de la casa en obra: un rectángulo por tramo de muro, cortado en las puertas (se entra y no hay losa encima). */
  obraWalls: HouseBox[];
  boxes: HouseBox[];
  /**
   * Luz propia de noche de cada cara, repartida en toda la cara de la versión de lejos: lo que
   * suman sus vidrios encendidos y sus apliques (color × área) sobre el área de la cara (el ancho o
   * el fondo por el alto de los muros de lejos).
   */
  glow: Record<HouseSide, THREE.Color>;
}

// ============================================================================================
// Ayudantes de geometría
// ============================================================================================

/** Dos cotas que difieren menos (m) son la misma (planos y extremos de los muros). */
const EPS = 1e-4;
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
/** Las uv de una cara con el dibujo de bloque (se mide en el mundo: la escala de la pieza va en ellas). */
const ONES: readonly number[] = [1, 1, 1, 1, 1, 1, 1, 1];
const _ab = new THREE.Vector3();
const _ad = new THREE.Vector3();
const _nn = new THREE.Vector3();

/** Cuadrilátero con su normal hacia `out` (da vuelta el orden si hace falta); uv por esquina (8 números). */
function faced(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3, color: THREE.Color, s: Surface, uv: readonly number[] = [0, 0, 1, 0, 1, 1, 0, 1]): void {
  _ab.subVectors(b, a);
  _ad.subVectors(d, a);
  _nn.crossVectors(_ab, _ad);
  if (_nn.dot(out) >= 0) batch.quad(a, b, c, d, color, s, uv);
  else batch.quad(a, d, c, b, color, s, [uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3]]);
}

/** Triángulo con su normal hacia `out`. */
function facedTri(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3, color: THREE.Color, s: Surface, uv: readonly number[] = [0, 0, 1, 0, 0, 1]): void {
  _ab.subVectors(b, a);
  _ad.subVectors(c, a);
  _nn.crossVectors(_ab, _ad);
  if (_nn.dot(out) >= 0) batch.tri(a, b, c, color, s, uv);
  else batch.tri(a, c, b, color, s, [uv[0], uv[1], uv[4], uv[5], uv[2], uv[3]]);
}

/** Matriz de una caja centrada en `c` con su ancho a lo largo de UP × n, su alto en y y su fondo a lo largo de n (sin espejar). */
function boxFrame(c: THREE.Vector3, n: THREE.Vector3): THREE.Matrix4 {
  const t = new THREE.Vector3().crossVectors(UP, n).normalize();
  return new THREE.Matrix4().makeBasis(t, UP, n).setPosition(c);
}

/** Caja de sección cuadrada `side` entre dos puntos. */
function strutBox(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, side: number, color: THREE.Color, s: Surface): void {
  const x = new THREE.Vector3().subVectors(b, a);
  const len = x.length();
  if (len < EPS) return;
  x.divideScalar(len);
  const ref = Math.abs(x.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const z = new THREE.Vector3().crossVectors(x, ref).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
  batch.box(m, len, side, side, color, s);
}

/** Área con signo de un contorno (x, z): positiva si va en sentido antihorario con z hacia abajo en el plano (x a la derecha, z abajo). */
function signedArea(ring: readonly number[][]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** ¿El punto (x, z) cae dentro del contorno? */
function inside(ring: readonly number[][], x: number, z: number): boolean {
  let hit = false;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
    const [xk, zk] = ring[k];
    const [xj, zj] = ring[j];
    if (zk > z !== zj > z && x < ((xj - xk) * (z - zk)) / (zj - zk) + xk) hit = !hit;
  }
  return hit;
}

/** Los tramos de la recta `c` = v (x = v si `alongZ`, si no z = v) dentro del contorno: pares [desde, hasta]. */
function slice(ring: readonly number[][], v: number, alongZ: boolean): number[][] {
  const hits: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    const [pc, pa] = alongZ ? [p[0], p[1]] : [p[1], p[0]];
    const [qc, qa] = alongZ ? [q[0], q[1]] : [q[1], q[0]];
    if (pc > v === qc > v) continue;
    hits.push(pa + ((qa - pa) * (v - pc)) / (qc - pc));
  }
  hits.sort((a, b) => a - b);
  const out: number[][] = [];
  for (let k = 0; k + 1 < hits.length; k += 2) out.push([hits[k], hits[k + 1]]);
  return out;
}

/** Valores ordenados sin repetir (al EPS). */
function uniq(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
  return out;
}

/**
 * La unión de contornos rectilíneos (una grilla con sus cotas), recorrida por su borde: el
 * contorno de afuera de la planta baja, para la física.
 */
function union(rings: readonly number[][][]): number[][] {
  const xs = uniq(rings.flatMap((r) => r.map((p) => p[0])));
  const zs = uniq(rings.flatMap((r) => r.map((p) => p[1])));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const full = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
    const x = (xs[i] + xs[i + 1]) / 2;
    const z = (zs[j] + zs[j + 1]) / 2;
    return rings.some((r) => inside(r, x, z));
  };
  // Bordes dirigidos entre una celda llena y una vacía, con la llena a la izquierda (x a la derecha, z abajo: sentido de las agujas).
  const next = new Map<string, number[]>();
  const key = (i: number, j: number): string => `${i},${j}`;
  let start: number[] | null = null;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!full(i, j)) continue;
      if (!full(i, j - 1)) next.set(key(i, j), [i + 1, j]);
      if (!full(i + 1, j)) next.set(key(i + 1, j), [i + 1, j + 1]);
      if (!full(i, j + 1)) next.set(key(i + 1, j + 1), [i, j + 1]);
      if (!full(i - 1, j)) next.set(key(i, j + 1), [i, j]);
      start ??= [i, j];
    }
  }
  if (!start) return [];
  const out: number[][] = [];
  let at = start;
  for (let guard = 0; guard <= next.size; guard++) {
    out.push([xs[at[0]], zs[at[1]]]);
    const n = next.get(key(at[0], at[1]));
    if (!n || (n[0] === start[0] && n[1] === start[1])) break;
    at = n;
  }
  // Sin los puntos del medio de un lado recto.
  return out.filter((p, k) => {
    const a = out[(k + out.length - 1) % out.length];
    const b = out[(k + 1) % out.length];
    return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > EPS;
  });
}

/**
 * Une los vértices iguales en todo (cada atributo, valor a valor) de una geometría con índice, como
 * la que entrega `Batch.build` (que no los une: cada cara trae los suyos). Así cada vértice se
 * transforma una sola vez y la geometría pesa menos. `extra` son otras marcas por vértice que
 * también tienen que coincidir (el papel y el tono de una casa, que se pintan después). Devuelve la
 * geometría nueva y, por cada vértice suyo, uno de los de antes (`from`); el orden de los
 * triángulos no cambia. Busca con una tabla hash de direccionamiento abierto: es lineal.
 */
export function weld(g: THREE.BufferGeometry, extra: readonly ArrayLike<number>[] = []): { geometry: THREE.BufferGeometry; from: Uint32Array } {
  const names = Object.keys(g.attributes);
  const attrs = names.map((name) => {
    const a = g.getAttribute(name);
    if (!(a instanceof THREE.BufferAttribute)) throw new Error(`weld: el atributo ${name} va intercalado`);
    return a;
  });
  // Cada atributo como enteros (los float32, por sus bits: dos iguales tienen los mismos).
  const cols = attrs.map((a) => {
    const arr = a.array;
    const ints: ArrayLike<number> = arr instanceof Float32Array ? new Uint32Array(arr.buffer, arr.byteOffset, arr.length) : (arr as ArrayLike<number>);
    return { ints, size: a.itemSize };
  });
  const n = g.getAttribute('position').count;
  const hash = (k: number): number => {
    let h = 0x811c9dc5;
    for (const c of cols) for (let i = k * c.size, end = i + c.size; i < end; i++) h = Math.imul(h ^ c.ints[i], 0x01000193);
    for (const e of extra) h = Math.imul(h ^ Math.round(e[k] * 0x10000), 0x01000193);
    return h >>> 0;
  };
  const same = (p: number, q: number): boolean => {
    for (const c of cols) for (let i = 0; i < c.size; i++) if (c.ints[p * c.size + i] !== c.ints[q * c.size + i]) return false;
    for (const e of extra) if (e[p] !== e[q]) return false;
    return true;
  };
  let cap = 1;
  while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(n);
  const from: number[] = [];
  for (let k = 0; k < n; k++) {
    let h = hash(k) & (cap - 1);
    let id = -1;
    while (table[h] !== -1) {
      if (same(from[table[h]], k)) {
        id = table[h];
        break;
      }
      h = (h + 1) & (cap - 1);
    }
    if (id < 0) {
      id = from.length;
      from.push(k);
      table[h] = id;
    }
    remap[k] = id;
  }
  const out = new THREE.BufferGeometry();
  attrs.forEach((a, i) => {
    const src = a.array as unknown as ArrayLike<number> & { constructor: new (n: number) => ArrayLike<number> & { [i: number]: number } };
    const dst = new src.constructor(from.length * a.itemSize);
    for (let j = 0; j < from.length; j++) for (let c = 0; c < a.itemSize; c++) dst[j * a.itemSize + c] = src[from[j] * a.itemSize + c];
    const Attr = a.constructor as new (array: ArrayLike<number>, itemSize: number, normalized: boolean) => THREE.BufferAttribute;
    out.setAttribute(names[i], new Attr(dst, a.itemSize, a.normalized));
  });
  const index = g.index ? g.index.array : Uint32Array.from({ length: n }, (_, k) => k);
  const idx = from.length > 0xffff ? new Uint32Array(index.length) : new Uint16Array(index.length);
  for (let k = 0; k < index.length; k++) idx[k] = remap[index[k]];
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return { geometry: out, from: Uint32Array.from(from) };
}

// ============================================================================================
// El armado
// ============================================================================================

/** Un rectángulo en el plano de un muro: a lo largo (u) y en alto (y). */
interface Rect {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  /** Un hueco que arranca en el piso de su muro (una puerta, un portón): por ahí se entra. */
  door?: boolean;
}

/** Las marcas de cada vértice de un Batch de la casa: su papel, su tono y si es de lo fino (1). */
interface Marks {
  role: number[];
  shade: number[];
  fine: number[];
}

/** Un paño sobre un muro. */
interface Region extends Rect {
  role: string;
  shade: number;
}

/** Un muro de un volumen (marco de la casa). */
interface Wall {
  side: HouseSide | null;
  /** Extremos (x, z) en el sentido en que crece u, y su largo. */
  a: number[];
  b: number[];
  /** Normal hacia afuera (x, z). */
  n: number[];
  /** Plano (z si es frente o fondo, x si es un lado). */
  plane: number;
  u0: number;
  u1: number;
  y0: number;
  /** Alto en u0 y en u1 (lineal entre ellos). */
  t0: number;
  t1: number;
  role: string;
  ground: boolean;
  holes: Rect[];
  regions: Region[];
}

/** El techo inclinado ya resuelto (marco de la casa). */
interface Pitched {
  /** p a lo largo de la cumbrera, q de través: la cumbrera 'x' tiene p = x, q = z. */
  alongX: boolean;
  qRidge: number;
  yRidge: number;
  slope: number;
  /** Faldones: tramo en p, de qTop (arriba) a qEave (el alero). */
  faldones: { p0: number; p1: number; qTop: number; qEave: number }[];
  pMin: number;
  pMax: number;
  qMin: number;
  qMax: number;
}

/**
 * Arma una casa. `split`: lo chico en su propia geometría (una casa sola) o todo junto (las
 * instancias). `flood`: cuánto la alumbran los reflectores y la base (del mundo) desde donde se
 * mide el pie del revoque: 0 si se instancia (el material `paint` lo mide desde cada instancia).
 */
export function buildHouse(model: HouseModel, parts: HouseParts, split: boolean, flood: { intensity: number; base: number }, where: string): HouseShape {
  return new HouseBuilder(model, parts, split, flood, where).shape;
}

class HouseBuilder {
  readonly shape: HouseShape;
  private readonly main = new Batch();
  private readonly small: Batch;
  private readonly roleIndex = new Map<string, number>();
  private readonly marks = new Map<Batch, Marks>();
  private readonly walls: Wall[] = [];
  /** Luz propia de cada cara (color × área de lo que se enciende de noche en ella). */
  private readonly lit: Record<HouseSide, THREE.Color> = { front: new THREE.Color(0, 0, 0), back: new THREE.Color(0, 0, 0), left: new THREE.Color(0, 0, 0), right: new THREE.Color(0, 0, 0) };
  private readonly cx: number;
  private readonly width: number;
  private readonly depth: number;
  private readonly pitched: Pitched | null;
  private readonly tan: number;

  constructor(
    private readonly m: HouseModel,
    private readonly P: HouseParts,
    split: boolean,
    flood: { intensity: number; base: number },
    private readonly where: string,
  ) {
    this.small = split ? new Batch() : this.main;
    for (const b of [this.main, this.small]) {
      b.flood[0] = flood.intensity;
      b.flood[1] = flood.base;
    }
    this.marks.set(this.main, { role: [], shade: [], fine: [] });
    if (split) this.marks.set(this.small, { role: [], shade: [], fine: [] });
    const xs = m.volumes.flatMap((v) => v.outline.map((p) => p[0]));
    const zs = m.volumes.flatMap((v) => v.outline.map((p) => p[1]));
    const x0 = Math.min(...xs);
    this.width = Math.max(...xs) - x0;
    this.cx = x0 + this.width / 2;
    this.depth = Math.max(...zs) - Math.min(...zs);
    this.tan = Math.tan(THREE.MathUtils.degToRad(m.roof.pitch));
    const roofed = this.roofed();
    this.pitched = m.roof.kind === 'flat' ? null : this.solveRoof(roofed);
    const top = this.pitched ? this.pitched.yRidge + P.roof.sheet : m.roof.eave;
    for (const b of [this.main, this.small]) b.flood[2] = top;
    this.makeWalls(roofed);
    this.placeOpenings();
    this.placeRegions();
    for (const w of this.walls) this.tessellate(w);
    m.openings.forEach((o, k) => this.opening(o, k));
    this.caps(roofed);
    this.roofEdges();
    for (const c of m.canopies ?? []) this.canopy(c);
    for (const l of m.lamps ?? []) this.lamp(l);
    for (const f of m.floors ?? []) this.floor(f);
    for (const b of m.balconies ?? []) this.balcony(b);
    if (m.fence) this.fence(m.fence);
    for (const p of m.planters ?? []) this.planter(p);
    for (const t of m.tanks ?? []) this.tank(t);
    for (const u of m.units ?? []) this.unit(u);
    const boxes: HouseBox[] = [];
    this.lot(boxes);
    const body = this.finish(this.main);
    const detail = split ? this.finish(this.small) : null;
    const roof = this.faldones();
    const obra = this.obraBoxes();
    const far = this.farSize();
    this.shape = {
      body: body.geometry,
      coarse: body.coarse,
      detail: detail?.geometry ?? null,
      roles: [...this.roleIndex.keys()],
      role: body.role,
      shade: body.shade,
      detailRole: detail?.role ?? new Uint8Array(0),
      detailShade: detail?.shade ?? new Float32Array(0),
      roof,
      outline: this.outline(),
      walk: this.walk(),
      top,
      width: this.width,
      depth: this.depth,
      far,
      roofSpan: this.roofSpan(),
      obra,
      obraTop: Math.max(0, ...obra.map((b) => b.center.y + b.height / 2)),
      obraWalls: this.obraPhysics(),
      boxes: [...boxes, ...this.canopyBoxes()],
      glow: this.faceGlow(far.walls),
    };
  }

  /**
   * La geometría de un Batch de la casa: sus vértices iguales unidos (con el mismo papel y tono) y
   * su índice con lo fino al final; el papel y el tono de cada vértice nuevo.
   */
  private finish(batch: Batch): { geometry: THREE.BufferGeometry; coarse: number; role: Uint8Array; shade: Float32Array } {
    const marks = this.marks.get(batch)!;
    const built = batch.build();
    // Cada pieza se marca entera: el primer vértice de un triángulo dice si es de lo fino.
    const first = built.index!.array;
    const fine = Array.from({ length: first.length / 3 }, (_, t) => marks.fine[first[t * 3]] === 1);
    const { geometry, from } = weld(built, [marks.role, marks.shade]);
    built.dispose();
    const src = geometry.index!.array;
    const dst = src instanceof Uint16Array ? new Uint16Array(src.length) : new Uint32Array(src.length);
    let j = 0;
    let coarse = 0;
    for (const pass of [false, true]) {
      for (let t = 0; t < fine.length; t++) {
        if (fine[t] !== pass) continue;
        dst[j++] = src[t * 3];
        dst[j++] = src[t * 3 + 1];
        dst[j++] = src[t * 3 + 2];
      }
      if (!pass) coarse = j;
    }
    geometry.setIndex(new THREE.BufferAttribute(dst, 1));
    return { geometry, coarse, role: Uint8Array.from(from, (k) => marks.role[k]), shade: Float32Array.from(from, (k) => marks.shade[k]) };
  }

  /** La luz propia de cada cara de la versión de lejos: la de sus vidrios encendidos y apliques, por metro cuadrado de la cara. */
  private faceGlow(walls: number): Record<HouseSide, THREE.Color> {
    const area: Record<HouseSide, number> = { front: this.width * walls, back: this.width * walls, left: this.depth * walls, right: this.depth * walls };
    const out = {} as Record<HouseSide, THREE.Color>;
    for (const side of SIDES) out[side] = area[side] > EPS ? this.lit[side].clone().multiplyScalar(1 / area[side]) : new THREE.Color(0, 0, 0);
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Colores por papel
  // ---------------------------------------------------------------------------------------

  /**
   * Agrega lo que dibuje `draw` en `batch` con su papel de color y su tono. `fine`: es de lo que a
   * media distancia mide menos de un pixel (cantos de molduras, onda del borde del techo, tubos,
   * barandas, ménsulas), que la versión de media distancia no dibuja.
   */
  private put(batch: Batch, role: string, shade: number, draw: () => void, fine = false): void {
    let r = this.roleIndex.get(role);
    if (r === undefined) {
      r = this.roleIndex.size;
      this.roleIndex.set(role, r);
    }
    const marks = this.marks.get(batch)!;
    const n0 = batch.vertices;
    draw();
    for (let k = n0; k < batch.vertices; k++) {
      marks.role.push(r);
      marks.shade.push(shade);
      marks.fine.push(fine ? 1 : 0);
    }
  }

  /** Las uv de una cara de un papel: en metros, o fijas si su dibujo es el bloque. */
  private uv(role: string, metric: readonly number[]): readonly number[] {
    const f = this.P.finishes[role];
    return f && patternOf(f.pattern) === PATTERN.blocks ? ONES : metric;
  }

  /** El acabado de un papel (dibujo, escala, tono) con la oclusión y la luz dadas. */
  private surface(role: string, ao = 1, glow: THREE.Color = NO_GLOW): Surface {
    const f = this.P.finishes[role];
    if (!f) return { ao, glow };
    return { ao, glow, pattern: patternOf(f.pattern), scale: f.scale, tone: f.tone };
  }

  // ---------------------------------------------------------------------------------------
  // Marcos
  // ---------------------------------------------------------------------------------------

  /** Del marco de la casa (x, y, z hacia el fondo) al de la geometría. */
  private g(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x - this.cx, y, -z);
  }

  /** Punto de un muro en (u, y), `out` m hacia afuera. */
  private at(w: Wall, u: number, y: number, out = 0): THREE.Vector3 {
    const t = w.u1 > w.u0 ? (u - w.u0) / (w.u1 - w.u0) : 0;
    const x = w.a[0] + (w.b[0] - w.a[0]) * t + w.n[0] * out;
    const z = w.a[1] + (w.b[1] - w.a[1]) * t + w.n[1] * out;
    return this.g(x, y, z);
  }

  /** Normal de un muro en el marco de la geometría. */
  private normal(w: Wall): THREE.Vector3 {
    return new THREE.Vector3(w.n[0], 0, -w.n[1]);
  }

  /** Alto del muro en u. */
  private topAt(w: Wall, u: number): number {
    return w.u1 > w.u0 ? w.t0 + ((w.t1 - w.t0) * (u - w.u0)) / (w.u1 - w.u0) : w.t0;
  }

  // ---------------------------------------------------------------------------------------
  // Techo
  // ---------------------------------------------------------------------------------------

  /** Qué volúmenes cubre el techo: los que lo dicen, o los que no tienen otro encima. */
  private roofed(): boolean[] {
    const V = this.m.volumes;
    return V.map((v, k) => {
      if (v.roofed !== undefined) return v.roofed;
      const top = v.base + v.height;
      const box = (u: HouseVolume): number[] => {
        const xs = u.outline.map((p) => p[0]);
        const zs = u.outline.map((p) => p[1]);
        return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      };
      const [ax0, ax1, az0, az1] = box(v);
      return !V.some((u, j) => {
        if (j === k || u.base < top - EPS) return false;
        const [bx0, bx1, bz0, bz1] = box(u);
        return bx0 < ax1 - EPS && bx1 > ax0 + EPS && bz0 < az1 - EPS && bz1 > az0 + EPS;
      });
    });
  }

  /** Las aguas: tramos del techo sobre los volúmenes cubiertos, cumbrera y faldones. */
  private solveRoof(roofed: boolean[]): Pitched {
    const R = this.m.roof;
    const alongX = R.ridge === 'x';
    const rings = this.m.volumes.filter((_, k) => roofed[k]).map((v) => v.outline);
    if (!rings.length) throw new Error(`${this.where}: el techo no cubre ningún volumen`);
    // p a lo largo de la cumbrera, q de través (en la cumbrera 'x': p = x, q = z).
    const pOf = (p: number[]): number => (alongX ? p[0] : p[1]);
    const cuts = uniq(rings.flatMap((r) => r.map(pOf)));
    const strips: { p0: number; p1: number; q0: number; q1: number }[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const mid = (cuts[k] + cuts[k + 1]) / 2;
      const spans = rings.flatMap((r) => slice(r, mid, alongX));
      if (!spans.length) continue;
      const q0 = Math.min(...spans.map((s) => s[0]));
      const q1 = Math.max(...spans.map((s) => s[1]));
      const last = strips[strips.length - 1];
      if (last && Math.abs(last.p1 - cuts[k]) < EPS && Math.abs(last.q0 - q0) < EPS && Math.abs(last.q1 - q1) < EPS) last.p1 = cuts[k + 1];
      else strips.push({ p0: cuts[k], p1: cuts[k + 1], q0, q1 });
    }
    const O = R.overhang;
    const [ohLo, ohHi, ohP0, ohP1] = alongX ? [O.front, O.back, O.left, O.right] : [O.left, O.right, O.front, O.back];
    const qLo = Math.min(...strips.map((s) => s.q0)) - ohLo;
    const qHi = Math.max(...strips.map((s) => s.q1)) + ohHi;
    const pMin = Math.min(...strips.map((s) => s.p0));
    const pMax = Math.max(...strips.map((s) => s.p1));
    const sheet = R.eave + this.P.roof.fascia;
    let qRidge: number;
    let yRidge: number;
    if (R.kind === 'shed') {
      if (R.ridgeAt === undefined) throw new Error(`${this.where}: un techo a una agua necesita ridgeAt (el muro del lado alto)`);
      const highLo = R.ridgeAt <= (qLo + qHi) / 2;
      qRidge = highLo ? R.ridgeAt - ohLo : R.ridgeAt + ohHi;
      yRidge = sheet + Math.abs(qRidge - (highLo ? qHi : qLo)) * this.tan;
    } else {
      qRidge = R.ridgeAt ?? (qLo + qHi) / 2;
      yRidge = sheet + (qRidge - qLo) * this.tan;
    }
    const faldones: Pitched['faldones'] = [];
    for (const s of strips) {
      const p0 = s.p0 - (Math.abs(s.p0 - pMin) < EPS ? ohP0 : 0);
      const p1 = s.p1 + (Math.abs(s.p1 - pMax) < EPS ? ohP1 : 0);
      const lo = s.q0 - ohLo;
      const hi = s.q1 + ohHi;
      // Del lado de adelante de la cumbrera, bajando hasta su alero; del de atrás, igual hacia atrás.
      if (lo < qRidge - EPS) faldones.push({ p0, p1, qTop: Math.min(qRidge, hi), qEave: lo });
      if (hi > qRidge + EPS) faldones.push({ p0, p1, qTop: Math.max(qRidge, lo), qEave: hi });
    }
    // Faldones vecinos iguales van en una sola pieza.
    faldones.sort((a, b) => a.qEave - b.qEave || a.qTop - b.qTop || a.p0 - b.p0);
    const merged: Pitched['faldones'] = [];
    for (const f of faldones) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.qTop - f.qTop) < EPS && Math.abs(last.qEave - f.qEave) < EPS && Math.abs(last.p1 - f.p0) < EPS) last.p1 = f.p1;
      else merged.push({ ...f });
    }
    return { alongX, qRidge, yRidge, slope: this.tan, faldones: merged, pMin: pMin - ohP0, pMax: pMax + ohP1, qMin: qLo, qMax: qHi };
  }

  /** Alto de la cara de abajo de la plancha sobre el punto (x, z) (marco de la casa). */
  private tent(x: number, z: number): number {
    const r = this.pitched!;
    const q = r.alongX ? z : x;
    return r.yRidge - Math.abs(q - r.qRidge) * r.slope;
  }

  /** Los faldones en el marco de la geometría. */
  private faldones(): Faldon[] {
    const r = this.pitched;
    if (!r) return [];
    return r.faldones.map((f) => {
      const pt = (p: number, q: number): THREE.Vector3 => (r.alongX ? this.g(p, 0, q) : this.g(q, 0, p));
      const a = pt(f.p0, f.qTop);
      const b = pt(f.p1, f.qTop);
      const y = r.yRidge - Math.abs(f.qTop - r.qRidge) * r.slope;
      a.y = y;
      b.y = y;
      const e = pt(f.p0, f.qEave);
      const down = new THREE.Vector3(e.x - a.x, 0, e.z - a.z).normalize();
      return { p0: a, p1: b, down, run: Math.abs(f.qEave - f.qTop), slope: r.slope };
    });
  }

  /** El borde ondulado de la plancha en los aleros que se ven (serrucho). */
  private roofEdges(): void {
    const r = this.pitched;
    if (!r) return;
    const R = this.P.roof;
    for (const f of r.faldones) {
      const pt = (p: number): THREE.Vector3 => (r.alongX ? this.g(p, 0, f.qEave) : this.g(f.qEave, 0, p));
      const a = pt(f.p0);
      const b = pt(f.p1);
      const top = r.alongX ? this.g(f.p0, 0, f.qTop) : this.g(f.qTop, 0, f.p0);
      const out = new THREE.Vector3(a.x - top.x, 0, a.z - top.z).normalize();
      if (!R.edges.includes(this.sideOf(out))) continue;
      const y = r.yRidge - Math.abs(f.qEave - r.qRidge) * r.slope;
      this.wave(this.main, a, b, y, out, R.edge, R.wave);
    }
  }

  /** De qué lado mira una dirección horizontal del marco de la geometría. */
  private sideOf(d: THREE.Vector3): HouseSide {
    if (Math.abs(d.z) >= Math.abs(d.x)) return d.z > 0 ? 'front' : 'back';
    return d.x > 0 ? 'right' : 'left';
  }

  /**
   * El canto de una plancha ondulada visto de frente: de a a b, con la cara de abajo de la
   * plancha a la altura y; los valles abajo y las crestas arriba.
   */
  private wave(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, y: number, out: THREE.Vector3, role: string, W: HouseParts['roof']['wave']): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < EPS) return;
    const n = Math.max(1, Math.round((len / W.pitch) * W.segments));
    const pos = new Float32Array((n + 1) * 6);
    const nor = new Float32Array((n + 1) * 6);
    const idx: number[] = [];
    const base = y + this.P.roof.sheet / 2 - W.height / 2;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t + out.x * W.out;
      const z = a.z + (b.z - a.z) * t + out.z * W.out;
      const crest = W.height * (0.5 + 0.5 * Math.cos((2 * Math.PI * t * len) / W.pitch));
      pos.set([x, base, z, x, base + crest, z], k * 6);
      nor.set([out.x, 0, out.z, out.x, 0, out.z], k * 6);
      if (k < n) {
        const i = k * 2;
        // Visto desde afuera: abajo-izquierda, abajo-derecha, arriba-derecha (según hacia dónde corre a→b).
        idx.push(i, i + 2, i + 3, i, i + 3, i + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    // Si a→b corre al revés de como se ve desde afuera, se da vuelta el orden.
    const along = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (new THREE.Vector3().crossVectors(along, UP).dot(out) < 0) {
      for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    }
    g.setIndex(idx);
    this.put(batch, role, 1, () => batch.geometry(g, new THREE.Matrix4(), WHITE, this.surface(role)), true);
    g.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Muros
  // ---------------------------------------------------------------------------------------

  /** Los muros de cada volumen, partidos en la cumbrera y sin los tramos pegados a otro volumen. */
  private makeWalls(roofed: boolean[]): void {
    const V = this.m.volumes;
    const bury = this.P.bury;
    const edges: { v: number; a: number[]; b: number[]; n: number[]; y0: number; y1: number }[] = [];
    V.forEach((v, k) => {
      if (v.outline.length < 3) throw new Error(`${this.where}: el volumen "${v.name}" tiene menos de 3 puntos`);
      const ccw = signedArea(v.outline) > 0;
      for (let i = 0; i < v.outline.length; i++) {
        const a = v.outline[i];
        const b = v.outline[(i + 1) % v.outline.length];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < EPS) continue;
        // Con x a la derecha y z hacia el fondo, un contorno de área positiva (a→b: (x0,z0)→(x1,z0)→(x1,z1)…)
        // deja el afuera a la izquierda de cada lado, mirando desde arriba con z hacia abajo: (dz, −dx).
        const n = ccw ? [dz / len, -dx / len] : [-dz / len, dx / len];
        edges.push({ v: k, a, b, n, y0: v.base, y1: v.base + v.height });
      }
    });
    for (const e of edges) {
      const v = V[e.v];
      const side: HouseSide | null = Math.abs(e.n[0]) < EPS ? (e.n[1] < 0 ? 'front' : 'back') : Math.abs(e.n[1]) < EPS ? (e.n[0] < 0 ? 'left' : 'right') : null;
      const alongZ = side === 'left' || side === 'right';
      // u crece con x (frente y fondo) o con z (lados); si es oblicuo, con el largo desde a.
      let [a, b] = [e.a, e.b];
      if (side && (alongZ ? a[1] > b[1] : a[0] > b[0])) [a, b] = [b, a];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u0 = side ? (alongZ ? a[1] : a[0]) : 0;
      const u1 = side ? (alongZ ? b[1] : b[0]) : len;
      const plane = side ? (alongZ ? a[0] : a[1]) : 0;
      // Tramos cubiertos por un muro de otro volumen pegado de espaldas (mismo plano, normal opuesta).
      const covered: number[][] = [];
      if (side) {
        for (const o of edges) {
          if (o.v === e.v || o.n[0] * e.n[0] + o.n[1] * e.n[1] > -1 + EPS) continue;
          const op = alongZ ? o.a[0] : o.a[1];
          if (Math.abs(op - plane) > EPS || Math.abs((alongZ ? o.b[0] : o.b[1]) - plane) > EPS) continue;
          if (o.y0 > e.y0 + EPS || o.y1 < e.y1 - EPS) continue;
          const oa = alongZ ? o.a[1] : o.a[0];
          const ob = alongZ ? o.b[1] : o.b[0];
          covered.push([Math.min(oa, ob), Math.max(oa, ob)]);
        }
      }
      // Cortes: la cumbrera (si el muro la cruza) y los bordes de lo cubierto.
      const cuts = [u0, u1];
      const r = this.pitched;
      if (r && roofed[e.v] && side) {
        const q0 = r.alongX ? a[1] : a[0];
        const q1 = r.alongX ? b[1] : b[0];
        if ((q0 - r.qRidge) * (q1 - r.qRidge) < -EPS) {
          // El muro va a lo largo de q: su u es q.
          cuts.push(r.qRidge);
        }
      }
      for (const c of covered) cuts.push(Math.max(u0, Math.min(u1, c[0])), Math.max(u0, Math.min(u1, c[1])));
      const us = uniq(cuts).filter((u) => u >= u0 - EPS && u <= u1 + EPS);
      for (let k = 0; k + 1 < us.length; k++) {
        const s0 = us[k];
        const s1 = us[k + 1];
        const mid = (s0 + s1) / 2;
        if (covered.some((c) => mid > c[0] + EPS && mid < c[1] - EPS)) continue;
        const pt = (u: number): number[] => {
          const t = u1 > u0 ? (u - u0) / (u1 - u0) : 0;
          return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        };
        const pa = pt(s0);
        const pb = pt(s1);
        const flat = e.y1;
        const top = (p: number[]): number => (!roofed[e.v] ? flat : r ? this.tent(p[0], p[1]) : this.m.roof.eave);
        const t0 = top(pa);
        const t1 = top(pb);
        const y0 = v.base > EPS ? v.base : -bury;
        if (t0 <= y0 + EPS && t1 <= y0 + EPS) continue;
        this.walls.push({
          side,
          a: pa,
          b: pb,
          n: e.n,
          plane,
          u0: side ? s0 : 0,
          u1: side ? s1 : Math.hypot(pb[0] - pa[0], pb[1] - pa[1]),
          y0,
          t0,
          t1,
          role: v.role && (!v.faces || (side !== null && v.faces.includes(side))) ? v.role : 'main',
          ground: v.base <= EPS,
          holes: [],
          regions: [],
        });
      }
    }
  }

  /** El muro de más afuera de un lado que cubre (u, y), o el del plano pedido. */
  private locate(side: HouseSide, u: number, y: number, plane?: number): Wall | undefined {
    let best: Wall | undefined;
    for (const w of this.walls) {
      if (w.side !== side || u < w.u0 - EPS || u > w.u1 + EPS) continue;
      if (y < w.y0 - EPS || y > this.topAt(w, u) + EPS) continue;
      if (plane !== undefined && Math.abs(w.plane - plane) > EPS * 10) continue;
      const outer = side === 'front' || side === 'left' ? -w.plane : w.plane;
      if (!best || outer > (side === 'front' || side === 'left' ? -best.plane : best.plane) + EPS) best = w;
    }
    return best;
  }

  /** Los muros de un lado y un plano que tocan un rectángulo (con el tramo que toca). */
  private covering(side: HouseSide, plane: number, r: Rect): { w: Wall; r: Rect }[] {
    const out: { w: Wall; r: Rect }[] = [];
    for (const w of this.walls) {
      if (w.side !== side || Math.abs(w.plane - plane) > EPS * 10) continue;
      const u0 = Math.max(r.u0, w.u0);
      const u1 = Math.min(r.u1, w.u1);
      const y0 = Math.max(r.y0, w.y0);
      const y1 = Math.min(r.y1, Math.max(w.t0, w.t1));
      if (u1 - u0 > EPS && y1 - y0 > EPS) out.push({ w, r: { u0, u1, y0, y1 } });
    }
    return out;
  }

  /** El muro donde va un vano, un paño, un tejadillo o un aplique (falla si no hay). */
  private wallAt(what: string, side: HouseSide, u: number, y: number, plane?: number): Wall {
    const w = this.locate(side, u, y, plane);
    if (!w) throw new Error(`${this.where}: ${what} (${side}, ${u.toFixed(2)} m a lo largo, ${y.toFixed(2)} m de alto) no cae en ningún muro`);
    return w;
  }

  /** Los huecos de los vanos en sus muros (en todos los del mismo plano que toquen: un marco alto cruza dos pisos). */
  private placeOpenings(): void {
    this.m.openings.forEach((o, k) => {
      const side = o.side ?? 'front';
      const w = this.wallAt(`el vano ${k} (${o.kind})`, side, (o.x[0] + o.x[1]) / 2, (o.y[0] + o.y[1]) / 2, o.plane);
      const inner = this.inner(o);
      // Arranca en el piso de su muro (el suelo del jardín en planta baja): una puerta por donde se entra.
      for (const c of this.covering(side, w.plane, inner)) c.w.holes.push({ ...c.r, door: o.y[0] <= (c.w.ground ? 0 : c.w.y0) + EPS });
    });
  }

  /** Los paños, bandas y el zócalo, cada uno en los muros de más afuera que toca. */
  private placeRegions(): void {
    const list = [...(this.m.panels ?? []), ...(this.m.bands ?? [])];
    for (const r of list) {
      const side = r.side ?? 'front';
      for (const w of this.walls) {
        if (w.side !== side) continue;
        if (r.plane !== undefined && Math.abs(w.plane - r.plane) > EPS * 10) continue;
        const u0 = Math.max(r.x[0], w.u0);
        const u1 = Math.min(r.x[1], w.u1);
        const y0 = Math.max(r.y[0], w.y0);
        const y1 = Math.min(r.y[1], Math.max(w.t0, w.t1));
        if (u1 - u0 <= EPS || y1 - y0 <= EPS) continue;
        if (r.plane === undefined && this.locate(side, (u0 + u1) / 2, (y0 + y1) / 2) !== w) continue;
        w.regions.push({ u0, u1, y0, y1, role: r.role, shade: r.shade ?? 1 });
      }
    }
  }

  /**
   * Un muro en cuadriláteros: una grilla con las cotas de sus huecos, paños y zócalo, sin las
   * celdas de los huecos, con el techo inclinado recortando la fila de arriba; las celdas vecinas
   * iguales de una fila van juntas.
   */
  private tessellate(w: Wall): void {
    const plinth = w.ground ? this.m.plinth : undefined;
    const rects: Rect[] = [...w.holes, ...w.regions];
    const top = Math.max(w.t0, w.t1);
    let us = [w.u0, w.u1, ...rects.flatMap((r) => [r.u0, r.u1])];
    const ys = uniq([w.y0, top, ...rects.flatMap((r) => [r.y0, r.y1]), ...(plinth ? [plinth.height] : [])].filter((y) => y >= w.y0 - EPS && y <= top + EPS));
    // Donde el borde de arriba inclinado cruza una cota, otra columna: así cada celda queda entera por debajo o recortada.
    if (Math.abs(w.t1 - w.t0) > EPS) {
      for (const y of ys) {
        const t = (y - w.t0) / (w.t1 - w.t0);
        if (t > 0 && t < 1) us.push(w.u0 + (w.u1 - w.u0) * t);
      }
    }
    us = uniq(us).filter((u) => u >= w.u0 - EPS && u <= w.u1 + EPS);
    const out = this.normal(w);
    type Cell = { u0: number; u1: number; role: string; shade: number; clip: boolean };
    for (let j = 0; j + 1 < ys.length; j++) {
      const y0 = ys[j];
      const y1 = ys[j + 1];
      const row: Cell[] = [];
      for (let i = 0; i + 1 < us.length; i++) {
        const u0 = us[i];
        const u1 = us[i + 1];
        const um = (u0 + u1) / 2;
        const ym = (y0 + y1) / 2;
        const ta = this.topAt(w, u0);
        const tb = this.topAt(w, u1);
        if (ta <= y0 + EPS && tb <= y0 + EPS) continue;
        if (w.holes.some((h) => um > h.u0 && um < h.u1 && ym > h.y0 && ym < h.y1)) continue;
        let role = w.role;
        let shade = 1;
        if (plinth && ym < plinth.height) {
          role = plinth.role;
          shade = plinth.shade ?? 1;
        }
        for (const r of w.regions) {
          if (um > r.u0 && um < r.u1 && ym > r.y0 && ym < r.y1) {
            role = r.role;
            shade = r.shade;
          }
        }
        const clip = ta < y1 - EPS || tb < y1 - EPS;
        const last = row[row.length - 1];
        if (last && Math.abs(last.u1 - u0) < EPS && last.role === role && last.shade === shade && last.clip === clip) last.u1 = u1;
        else row.push({ u0, u1, role, shade, clip });
      }
      for (const c of row) {
        const ya = c.clip ? Math.min(y1, this.topAt(w, c.u0)) : y1;
        const yb = c.clip ? Math.min(y1, this.topAt(w, c.u1)) : y1;
        const p00 = this.at(w, c.u0, y0);
        const p10 = this.at(w, c.u1, y0);
        const p11 = this.at(w, c.u1, yb);
        const p01 = this.at(w, c.u0, ya);
        this.put(this.main, c.role, c.shade, () => faced(this.main, p00, p10, p11, p01, out, WHITE, this.surface(c.role), this.uv(c.role, [c.u0, y0, c.u1, y0, c.u1, yb, c.u0, ya])));
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Vanos
  // ---------------------------------------------------------------------------------------

  /** El hueco de un vano: su borde de afuera menos la moldura. */
  private inner(o: HouseOpening): Rect {
    const m = this.moldingOf(o).width;
    return { u0: o.x[0] + m, u1: o.x[1] - m, y0: o.y[0] + m, y1: o.y[1] - m };
  }

  private moldingOf(o: HouseOpening): { role: string; width: number } {
    if (o.molding) return o.molding;
    if (o.kind === 'door') return { role: this.P.door.frameRole, width: this.P.door.frame };
    if (o.kind === 'garage' || o.kind === 'void') return { role: this.P.molding.role, width: 0 };
    return { role: this.P.molding.role, width: this.P.molding.width };
  }

  private opening(o: HouseOpening, k: number): void {
    const side = o.side ?? 'front';
    const w = this.wallAt(`el vano ${k} (${o.kind})`, side, (o.x[0] + o.x[1]) / 2, (o.y[0] + o.y[1]) / 2, o.plane);
    const h = this.inner(o);
    const out = this.normal(w);
    const P = this.P;
    const mold = this.moldingOf(o);
    // Moldura: el marco que sale del muro alrededor del hueco (frente, cantos de afuera y de adentro).
    if (mold.width > 0) {
      const O: Rect = { u0: o.x[0], u1: o.x[1], y0: o.y[0], y1: o.y[1] };
      const d = P.molding.out;
      const s = this.surface(mold.role);
      const bars: Rect[] = [
        { u0: O.u0, u1: h.u0, y0: O.y0, y1: O.y1 },
        { u0: h.u1, u1: O.u1, y0: O.y0, y1: O.y1 },
        { u0: h.u0, u1: h.u1, y0: O.y0, y1: h.y0 },
        { u0: h.u0, u1: h.u1, y0: h.y1, y1: O.y1 },
      ];
      this.put(this.main, mold.role, 1, () => {
        for (const b of bars) faced(this.main, this.at(w, b.u0, b.y0, d), this.at(w, b.u1, b.y0, d), this.at(w, b.u1, b.y1, d), this.at(w, b.u0, b.y1, d), out, WHITE, s, this.uv(mold.role, [b.u0, b.y0, b.u1, b.y0, b.u1, b.y1, b.u0, b.y1]));
      });
      // Sus cantos (lo que sale del muro): de lo fino.
      this.put(
        this.main,
        mold.role,
        1,
        () => {
          this.ring(w, O, 0, d, false, mold.role, s);
          this.ring(w, h, 0, d, true, mold.role, s);
        },
        true,
      );
    }
    // Derrame: del muro hacia adentro hasta el relleno.
    const rv = P.reveal;
    this.put(this.main, w.role, 1, () => this.ring(w, h, -rv, 0, true, w.role, this.surface(w.role, P.ao.reveal)));
    // Relleno.
    const fill = (r: Rect, role: string, s: Surface, uv: readonly number[]): void => {
      this.put(this.main, role, 1, () => faced(this.main, this.at(w, r.u0, r.y0, -rv), this.at(w, r.u1, r.y0, -rv), this.at(w, r.u1, r.y1, -rv), this.at(w, r.u0, r.y1, -rv), out, WHITE, s, this.uv(role, uv)));
    };
    const metric = (r: Rect): number[] => [0, 0, r.u1 - r.u0, 0, r.u1 - r.u0, r.y1 - r.y0, 0, r.y1 - r.y0];
    const glass = (r: Rect, panes: readonly number[]): void => {
      const [c, n] = panes;
      const glow = o.lit ? glowOf(P.glass.glow) : NO_GLOW;
      if (w.side) this.lit[w.side].add(glow.clone().multiplyScalar((r.u1 - r.u0) * (r.y1 - r.y0)));
      fill(r, P.glass.role, { ...this.surface(P.glass.role, 1, glow), tone: P.glass.tone }, [0, 0, c, 0, c, n, 0, n]);
    };
    if (o.kind === 'window') {
      if (!o.panes) throw new Error(`${this.where}: la ventana ${k} no tiene "panes"`);
      glass(h, o.panes);
    } else if (o.kind === 'door') fill(h, P.door.role, this.surface(P.door.role), metric(h));
    else if (o.kind === 'garage') fill(h, P.garage.role, this.surface(P.garage.role), metric(h));
    else if (o.kind === 'void') fill(h, P.interior.role, this.surface(P.interior.role, P.ao.reveal), metric(h));
    else {
      if (!o.cells?.length) throw new Error(`${this.where}: el marco ${k} no tiene "cells"`);
      for (const c of o.cells) {
        const r: Rect = { u0: h.u0, u1: h.u1, y0: Math.max(h.y0, c.y[0]), y1: Math.min(h.y1, c.y[1]) };
        if (r.y1 - r.y0 <= EPS) continue;
        if (c.fill === 'glass') glass(r, c.panes ?? [1, 1]);
        else fill(r, c.fill, this.surface(c.fill), metric(r));
      }
    }
    if (o.guard) this.guard(w, h, o.guard);
  }

  /**
   * Los cuatro cantos de un rectángulo del muro entre las profundidades d0 y d1 (hacia afuera):
   * mirando al centro del rectángulo (un derrame) o hacia afuera de él (el canto de una moldura).
   */
  private ring(w: Wall, r: Rect, d0: number, d1: number, toCenter: boolean, role: string, s: Surface): void {
    const tangent = new THREE.Vector3().subVectors(this.at(w, r.u1, 0), this.at(w, r.u0, 0)).normalize();
    const sgn = toCenter ? 1 : -1;
    const sides: [number, number, number, number, THREE.Vector3][] = [
      [r.u0, r.y0, r.u0, r.y1, tangent.clone().multiplyScalar(sgn)],
      [r.u1, r.y0, r.u1, r.y1, tangent.clone().multiplyScalar(-sgn)],
      [r.u0, r.y0, r.u1, r.y0, UP.clone().multiplyScalar(sgn)],
      [r.u0, r.y1, r.u1, r.y1, UP.clone().multiplyScalar(-sgn)],
    ];
    for (const [ua, ya, ub, yb, n] of sides) {
      const len = Math.hypot(ub - ua, yb - ya);
      faced(this.main, this.at(w, ua, ya, d0), this.at(w, ub, yb, d0), this.at(w, ub, yb, d1), this.at(w, ua, ya, d1), n, WHITE, s, this.uv(role, [0, 0, len, 0, len, d1 - d0, 0, d1 - d0]));
    }
  }

  /** Tubos de protección o baranda de un vano. */
  private guard(w: Wall, h: Rect, g: HouseGuard): void {
    const P = this.P;
    if (g.kind === 'tubes') {
      const n = g.count ?? 0;
      if (n < 1) throw new Error(`${this.where}: tubos de protección sin "count"`);
      const s = this.surface(P.tube.role);
      this.put(
        this.small,
        P.tube.role,
        1,
        () => {
          for (let k = 0; k < n; k++) {
            const y = n === 1 ? (g.y[0] + g.y[1]) / 2 : g.y[0] + ((g.y[1] - g.y[0]) * k) / (n - 1);
            const a = this.at(w, h.u0, y, -P.tube.size / 2);
            const b = this.at(w, h.u1, y, -P.tube.size / 2);
            strutBox(this.small, a, b, P.tube.size, WHITE, s);
          }
        },
        true,
      );
      return;
    }
    // Baranda: barrotes, pasamanos y pletina de abajo, saliendo del muro.
    const R = P.rail;
    const s = this.surface(R.role);
    this.put(
      this.small,
      R.role,
      1,
      () => {
        const span = h.u1 - h.u0;
        const bars = Math.max(1, Math.round(span / R.spacing));
        for (let k = 1; k < bars; k++) {
          const u = h.u0 + (span * k) / bars;
          strutBox(this.small, this.at(w, u, g.y[0], R.out), this.at(w, u, g.y[1], R.out), R.bar, WHITE, s);
        }
        for (const y of g.y) strutBox(this.small, this.at(w, h.u0, y, R.out), this.at(w, h.u1, y, R.out), R.rail, WHITE, s);
        for (const u of [h.u0, h.u1]) strutBox(this.small, this.at(w, u, g.y[0], R.out), this.at(w, u, g.y[1], R.out), R.rail, WHITE, s);
      },
      true,
    );
  }

  // ---------------------------------------------------------------------------------------
  // Losas, techos planos y cielos
  // ---------------------------------------------------------------------------------------

  /** Tapa de arriba de los volúmenes sin techo inclinado, cielo de los que vuelan y la losa de un techo plano. */
  private caps(roofed: boolean[]): void {
    const P = this.P;
    this.m.volumes.forEach((v, k) => {
      const ring = v.outline.map((p) => new THREE.Vector2(p[0], p[1]));
      const tris = THREE.ShapeUtils.triangulateShape(ring, []);
      const flatRoof = roofed[k] && !this.pitched;
      const capRole = flatRoof ? 'roof' : P.slab.role;
      const top = roofed[k] ? (this.pitched ? null : this.m.roof.eave) : v.base + v.height;
      if (top !== null) {
        this.put(this.main, capRole, 1, () => {
          for (const t of tris) {
            const [a, b, c] = t.map((i) => this.g(ring[i].x, top, ring[i].y));
            facedTri(this.main, a, b, c, UP, WHITE, this.surface(capRole), [a.x, a.z, b.x, b.z, c.x, c.z]);
          }
        });
      }
      if (v.base > EPS) {
        const down = UP.clone().negate();
        this.put(this.main, P.slab.role, 1, () => {
          for (const t of tris) {
            const [a, b, c] = t.map((i) => this.g(ring[i].x, v.base, ring[i].y));
            facedTri(this.main, a, b, c, down, WHITE, this.surface(P.slab.role, P.ao.porch));
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------------------------------
  // Piezas de la fachada
  // ---------------------------------------------------------------------------------------

  /** Tejadillo: la plancha inclinada con su canto ondulado, su cielo y dos ménsulas. */
  private canopy(c: HouseCanopy): void {
    const side = c.side ?? 'front';
    const w = this.wallAt('un tejadillo', side, (c.x[0] + c.x[1]) / 2, c.y[1] - EPS * 10, c.plane);
    const out = this.normal(w);
    const P = this.P;
    const [yLow, yHigh] = c.y;
    const t = P.canopy.sheet;
    const run = c.depth;
    const corner = (u: number, d: number, dy: number): THREE.Vector3 => {
      const y = yHigh + ((yLow - yHigh) * d) / run + dy;
      return this.at(w, u, y, d);
    };
    const [u0, u1] = c.x;
    const slopeN = new THREE.Vector3().copy(out).multiplyScalar(yHigh - yLow).add(UP.clone().multiplyScalar(run)).normalize();
    const role = c.role;
    this.put(this.main, role, 1, () => {
      faced(this.main, corner(u0, 0, t), corner(u1, 0, t), corner(u1, run, t), corner(u0, run, t), slopeN, WHITE, this.surface(role, 1), [u0, 0, u1, 0, u1, run, u0, run]);
      // Cantos de los lados.
      const tangent = new THREE.Vector3().subVectors(this.at(w, u1, 0), this.at(w, u0, 0)).normalize();
      faced(this.main, corner(u0, 0, 0), corner(u0, run, 0), corner(u0, run, t), corner(u0, 0, t), tangent.clone().negate(), WHITE, this.surface(role));
      faced(this.main, corner(u1, 0, 0), corner(u1, run, 0), corner(u1, run, t), corner(u1, 0, t), tangent, WHITE, this.surface(role));
    });
    this.put(this.main, P.roof.soffit, 1, () => {
      faced(this.main, corner(u0, 0, 0), corner(u1, 0, 0), corner(u1, run, 0), corner(u0, run, 0), slopeN.clone().negate(), WHITE, this.surface(P.roof.soffit, P.ao.canopy));
    });
    const a = corner(u0, run, 0);
    const b = corner(u1, run, 0);
    this.wave(this.main, a, b, a.y, out, P.roof.edge, P.roof.wave);
    // Ménsulas: de más abajo en el muro a la plancha cerca de su borde.
    const inset = P.canopy.bracket;
    this.put(
      this.small,
      P.canopy.bracketRole,
      1,
      () => {
        for (const u of [u0 + inset, u1 - inset]) {
          strutBox(this.small, this.at(w, u, yHigh - P.canopy.drop, 0), corner(u, run - inset, -inset / 2), P.canopy.bracket, WHITE, this.surface(P.canopy.bracketRole));
        }
      },
      true,
    );
  }

  /** Cajas de física de los tejadillos (se camina por debajo). */
  private canopyBoxes(): HouseBox[] {
    return (this.m.canopies ?? []).map((c) => {
      const side = c.side ?? 'front';
      const w = this.wallAt('un tejadillo', side, (c.x[0] + c.x[1]) / 2, c.y[1] - EPS * 10, c.plane);
      const mid = this.at(w, (c.x[0] + c.x[1]) / 2, 0, c.depth / 2);
      const n = this.normal(w);
      return { x: mid.x, z: mid.z, halfU: (c.x[1] - c.x[0]) / 2, halfV: c.depth / 2, angle: Math.atan2(-n.x, n.z), top: c.y[1] + this.P.canopy.sheet, floor: false, bottom: c.y[0] };
    });
  }

  /** Aplique con su pantalla encendida de noche. */
  private lamp(l: HouseLamp): void {
    const side = l.side ?? 'front';
    const w = this.wallAt('un aplique', side, l.x, l.y, l.plane);
    const [sw, sh, sd] = this.P.lamp.size;
    const c = this.at(w, l.x, l.y, sd / 2);
    const role = this.P.lamp.role;
    const glow = glowOf(this.P.lamp.glow);
    if (w.side) this.lit[w.side].add(glow.clone().multiplyScalar(sw * sh));
    this.put(this.small, role, 1, () => this.small.box(boxFrame(c, this.normal(w)), sw, sh, sd, WHITE, this.surface(role, 1, glow)));
  }

  /** Piso horizontal (porche, caminito). */
  private floor(f: HouseFloor): void {
    const ring = f.outline.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(ring, []);
    this.put(this.main, f.role, 1, () => {
      for (const t of tris) {
        const [a, b, c] = t.map((i) => this.g(ring[i].x, f.y, ring[i].y));
        facedTri(this.main, a, b, c, UP, WHITE, this.surface(f.role), [a.x, -a.z, b.x, -b.z, c.x, -c.z]);
      }
    });
  }

  /** Balcón: losa que sale del muro y baranda en sus tres bordes. */
  private balcony(b: HouseBalcony): void {
    const side = b.side ?? 'front';
    const w = this.wallAt('un balcón', side, (b.x[0] + b.x[1]) / 2, b.y + EPS * 10, b.plane);
    const n = this.normal(w);
    const [u0, u1] = b.x;
    const c = this.at(w, (u0 + u1) / 2, b.y - b.slab / 2, b.depth / 2);
    // La losa es un volado: su cielo lleva la oclusión de los volados y porches.
    this.put(this.main, b.role, 1, () => this.main.box(boxFrame(c, n), u1 - u0, b.slab, b.depth, WHITE, this.surface(b.role, this.P.ao.porch)));
    const R = this.P.rail;
    const s = this.surface(R.role);
    const corners = [this.at(w, u0, b.y, 0), this.at(w, u0, b.y, b.depth), this.at(w, u1, b.y, b.depth), this.at(w, u1, b.y, 0)];
    this.put(
      this.small,
      R.role,
      1,
      () => {
        for (let k = 0; k < 3; k++) {
          const a = corners[k];
          const e = corners[k + 1];
          const len = a.distanceTo(e);
          const bars = Math.max(1, Math.round(len / R.spacing));
          for (let j = 0; j <= bars; j++) {
            const p = a.clone().lerp(e, j / bars);
            strutBox(this.small, p, p.clone().setY(p.y + b.rail), R.bar, WHITE, s);
          }
          strutBox(this.small, a.clone().setY(a.y + b.rail), e.clone().setY(e.y + b.rail), R.rail, WHITE, s);
        }
      },
      true,
    );
  }

  /** Cerramiento del frente del lote. */
  private fence(f: HouseFence): void {
    const P = this.P;
    const sb = P.lot.setback;
    const right = this.m.setback === 'right';
    const x0 = this.cx - this.width / 2 - (right ? 0 : sb);
    const x1 = this.cx + this.width / 2 + (right ? sb : 0);
    const z = -f.depth;
    const inGate = (x: number): boolean => f.gates.some((g) => x > g[0] && x < g[1]);
    const cuts = uniq([x0, x1, ...f.gates.flat().filter((x) => x > x0 && x < x1)]);
    const out = new THREE.Vector3(0, 0, 1);
    const R = P.rail;
    const [spacing, post] = f.posts;
    this.put(this.main, f.role, 1, () => {
      for (let k = 0; k + 1 < cuts.length; k++) {
        const a = cuts[k];
        const b = cuts[k + 1];
        if (inGate((a + b) / 2)) continue;
        this.main.box(boxFrame(this.g((a + b) / 2, f.wall / 2, z), out), b - a, f.wall, f.thickness, WHITE, this.surface(f.role));
      }
      const n = Math.max(1, Math.round((x1 - x0) / spacing));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        this.main.box(boxFrame(this.g(x, f.height / 2, z), out), post, f.height, post, WHITE, this.surface(f.role));
      }
    });
    this.put(
      this.small,
      f.rail,
      1,
      () => {
        const bars = Math.max(1, Math.round((x1 - x0) / R.spacing));
        for (let k = 0; k <= bars; k++) {
          const x = x0 + ((x1 - x0) * k) / bars;
          const y0 = inGate(x) ? 0 : f.wall;
          strutBox(this.small, this.g(x, y0, z), this.g(x, f.height, z), R.bar, WHITE, this.surface(f.rail));
        }
        strutBox(this.small, this.g(x0, f.height, z), this.g(x1, f.height, z), R.rail, WHITE, this.surface(f.rail));
      },
      true,
    );
  }

  /** Jardinera: borde bajo y tierra con hierba. */
  private planter(p: HousePlanter): void {
    const ring = p.outline;
    this.put(this.main, p.role, 1, () => {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const c = this.g((a[0] + b[0]) / 2, p.height / 2, (a[1] + b[1]) / 2);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = new THREE.Vector3(b[1] - a[1], 0, b[0] - a[0]).normalize();
        this.main.box(boxFrame(c, n), len + p.lip, p.height, p.lip, WHITE, this.surface(p.role));
      }
    });
    this.floor({ outline: ring, y: p.height - p.drop, role: p.soil, source: p.source });
  }

  /** Tanque de agua. */
  private tank(t: HouseTank): void {
    const [d, h] = t.size;
    const g = new THREE.CylinderGeometry(d / 2, d / 2, h, this.P.sides);
    const m = new THREE.Matrix4().setPosition(this.g(t.at[0], t.at[1] + h / 2, t.at[2]));
    this.put(this.main, t.role, 1, () => this.main.geometry(g, m, WHITE, this.surface(t.role)));
    g.dispose();
  }

  /** Condensador de un aire en un muro. */
  private unit(u: HouseUnit): void {
    const side = u.side ?? 'front';
    const [sw, sh, sd] = u.size;
    const w = this.wallAt('un aire', side, u.x, u.y + sh / 2, u.plane);
    const c = this.at(w, u.x, u.y + sh / 2, sd / 2);
    this.put(this.small, u.role, 1, () => this.small.box(boxFrame(c, this.normal(w)), sw, sh, sd, WHITE, this.surface(u.role)));
  }

  /** El cierre del retiro lateral junto a la fachada y el pilar del medidor en el lindero. */
  private lot(boxes: HouseBox[]): void {
    const L = this.P.lot;
    const right = this.m.setback === 'right';
    const s = right ? 1 : -1;
    const edge = (s * this.width) / 2;
    const line = edge + s * L.setback;
    const C = L.closure;
    const cz = -C.z;
    const out = new THREE.Vector3(0, 0, 1);
    const len = L.setback;
    const cx = (edge + line) / 2;
    this.put(this.main, C.role, 1, () => this.main.box(boxFrame(new THREE.Vector3(cx, C.height / 2, cz), out), len, C.height, C.thickness, WHITE, this.surface(C.role)));
    boxes.push({ x: cx, z: cz, halfU: len / 2, halfV: C.thickness / 2, angle: 0, top: C.height, floor: false, bottom: -Infinity });
    const [pw, pd, ph] = L.pillar.size;
    const [cw, cd, ct] = L.pillar.cap;
    const px = line - (s * pw) / 2;
    this.put(this.main, L.pillar.role, 1, () => this.main.box(boxFrame(new THREE.Vector3(px, ph / 2, cz), out), pw, ph, pd, WHITE, this.surface(L.pillar.role)));
    this.put(this.main, L.pillar.capRole, 1, () => this.main.box(boxFrame(new THREE.Vector3(px, ph + ct / 2, cz), out), cw, ct, cd, WHITE, this.surface(L.pillar.capRole)));
    boxes.push({ x: px, z: cz, halfU: pw / 2, halfV: pd / 2, angle: 0, top: ph + ct, floor: false, bottom: -Infinity });
  }

  // ---------------------------------------------------------------------------------------
  // Física, lejos y obra
  // ---------------------------------------------------------------------------------------

  /** Contorno de la planta baja en el marco de la geometría (X, Z). */
  private outline(): THREE.Vector2[] {
    const ground = this.m.volumes.filter((v) => v.base <= EPS).map((v) => v.outline);
    return union(ground).map((p) => new THREE.Vector2(p[0] - this.cx, -p[1]));
  }

  /** El techo para caminarlo (marco de la geometría). */
  private walk(): LocalRoof | null {
    const r = this.pitched;
    if (!r) return null;
    const pMid = (r.pMin + r.pMax) / 2;
    const c = r.alongX ? this.g(pMid, 0, r.qRidge) : this.g(r.qRidge, 0, pMid);
    const half = Math.max(r.qRidge - r.qMin, r.qMax - r.qRidge);
    const top = r.yRidge + this.P.roof.sheet;
    return { hip: false, x: c.x, z: c.z, angle: r.alongX ? 0 : Math.PI / 2, halfWidth: half, halfLength: (r.pMax - r.pMin) / 2, slope: r.slope, edge: top - half * r.slope };
  }

  /** Las alturas de la versión de lejos. */
  private farSize(): HouseShape['far'] {
    const R = this.m.roof;
    const r = this.pitched;
    if (!r) return { walls: R.eave, eave: R.eave, ridge: R.eave, axis: R.ridge };
    const eave = R.eave + this.P.roof.fascia;
    const O = R.overhang;
    const oh = r.alongX ? Math.min(O.front, O.back) : Math.min(O.left, O.right);
    return { walls: eave + oh * r.slope, eave, ridge: r.yRidge, axis: R.ridge };
  }

  /** Medio ancho y fondo del techo con sus vuelos. */
  private roofSpan(): HouseShape['roofSpan'] {
    const r = this.pitched;
    if (!r) return { half: this.width / 2, front: 0, back: this.depth };
    const xs = r.alongX ? [r.pMin, r.pMax] : [r.qMin, r.qMax];
    const zs = r.alongX ? [r.qMin, r.qMax] : [r.pMin, r.pMax];
    const half = Math.max(Math.abs(xs[0] - this.cx), Math.abs(xs[1] - this.cx));
    return { half, front: -zs[0], back: zs[1] };
  }

  /**
   * La casa en obra: sus muros de bloque en cajas (sin moldura, derrame ni relleno; los vanos del
   * frente quedan abiertos), hasta el techo de cada volumen, sin hastiales ni techo.
   */
  private obraBoxes(): ObraBox[] {
    const T = this.P.obra.thickness;
    const out: ObraBox[] = [];
    for (const w of this.walls) {
      // Sin hastial: hasta el más bajo de sus dos extremos.
      const y1 = Math.min(w.t0, w.t1);
      const us = uniq([w.u0, w.u1, ...w.holes.flatMap((h) => [h.u0, h.u1])]);
      const ys = uniq([w.y0, y1, ...w.holes.flatMap((h) => [h.y0, h.y1])].filter((y) => y >= w.y0 - EPS && y <= y1 + EPS));
      const dir = new THREE.Vector3().subVectors(this.at(w, w.u1, 0), this.at(w, w.u0, 0)).normalize();
      for (let i = 0; i + 1 < us.length; i++) {
        const um = (us[i] + us[i + 1]) / 2;
        // Cada columna en tramos macizos de alto (los huecos quedan fuera).
        let from: number | null = null;
        const flush = (to: number): void => {
          if (from === null) return;
          out.push({ center: this.at(w, um, (from + to) / 2, -T / 2), dir, length: us[i + 1] - us[i], height: to - from, thickness: T });
          from = null;
        };
        for (let j = 0; j + 1 < ys.length; j++) {
          const ym = (ys[j] + ys[j + 1]) / 2;
          if (w.holes.some((h) => um > h.u0 && um < h.u1 && ym > h.y0 && ym < h.y1)) flush(ys[j]);
          else from ??= ys[j];
        }
        flush(ys[ys.length - 1]);
      }
    }
    return out;
  }

  /**
   * La física de la casa en obra: cada tramo de muro hasta donde llega su bloque, cortado en sus
   * puertas (por ahí se entra; encima de cada una, el dintel, que se pasa por debajo). Sin losa
   * arriba: adentro se camina.
   */
  private obraPhysics(): HouseBox[] {
    const T = this.P.obra.thickness;
    const out: HouseBox[] = [];
    for (const w of this.walls) {
      const top = Math.min(w.t0, w.t1);
      if (top <= w.y0 + EPS) continue;
      const a = this.at(w, w.u0, 0);
      const b = this.at(w, w.u1, 0);
      const angle = Math.atan2(b.z - a.z, b.x - a.x);
      // Los muros de planta baja atajan desde abajo; los de arriba, desde su piso.
      const bottom = w.ground ? -Infinity : w.y0;
      const push = (u0: number, u1: number, from: number): void => {
        if (u1 - u0 <= EPS) return;
        const c = this.at(w, (u0 + u1) / 2, 0, -T / 2);
        out.push({ x: c.x, z: c.z, halfU: (u1 - u0) / 2, halfV: T / 2, angle, top, floor: false, bottom: from });
      };
      let u = w.u0;
      for (const d of w.holes.filter((h) => h.door).sort((p, q) => p.u0 - q.u0)) {
        push(u, d.u0, bottom);
        if (d.y1 < top - EPS) push(d.u0, d.u1, d.y1);
        u = Math.max(u, d.u1);
      }
      push(u, w.u1, bottom);
    }
    return out;
  }
}

// ============================================================================================
// Techo, colores y versión de lejos (lo usan la casa sola y las instancias)
// ============================================================================================

/** Colores de los faldones: su cara de arriba (con su pintura), el cielo y la fascia. */
export interface FaldonColors {
  top: THREE.Color;
  /** 1 = la cara de arriba toma el color de cada instancia. */
  paint: number;
  soffit: THREE.Color;
  fascia: THREE.Color;
}

/**
 * Un faldón en un Batch: con `m` la identidad, la pieza unitaria (x de 0 a 1 a lo largo de la
 * cumbrera, z de 0 a 1 bajando, y el grosor de la plancha en m) que se instancia con
 * `faldonMatrix`; con otra matriz, ya ubicado. Cara de arriba ondulada, cielo, fascia bajo el
 * alero y los cantos.
 */
export function faldonPiece(batch: Batch, m: THREE.Matrix4, parts: HouseParts, c: FaldonColors): void {
  const t = parts.roof.sheet;
  const f = parts.roof.fascia;
  const P = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const N = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix3(nm).normalize();
  const sheet = parts.finishes.roof;
  const roofSurface: Surface = sheet ? { pattern: patternOf(sheet.pattern), scale: sheet.scale, tone: sheet.tone, paint: c.paint } : { paint: c.paint };
  faced(batch, P(0, t, 0), P(1, t, 0), P(1, t, 1), P(0, t, 1), N(0, 1, 0), c.top, roofSurface);
  faced(batch, P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1), N(0, -1, 0), c.soffit, { ao: parts.ao.soffit });
  faced(batch, P(0, -f, 1), P(1, -f, 1), P(1, t, 1), P(0, t, 1), N(0, 0, 1), c.fascia, {});
  faced(batch, P(0, 0, 0), P(1, 0, 0), P(1, t, 0), P(0, t, 0), N(0, 0, -1), c.fascia, {});
  faced(batch, P(0, 0, 0), P(0, 0, 1), P(0, t, 1), P(0, t, 0), N(-1, 0, 0), c.fascia, {});
  faced(batch, P(1, 0, 0), P(1, 0, 1), P(1, t, 1), P(1, t, 0), N(1, 0, 0), c.fascia, {});
}

/** La matriz que lleva la pieza unitaria de `faldonPiece` a un faldón (ya transformado al marco que se quiera). */
export function faldonMatrix(f: Faldon, out = new THREE.Matrix4()): THREE.Matrix4 {
  const along = new THREE.Vector3().crossVectors(UP, f.down).normalize();
  const [o, e] = f.p0.dot(along) <= f.p1.dot(along) ? [f.p0, f.p1] : [f.p1, f.p0];
  const width = Math.hypot(e.x - o.x, e.z - o.z);
  const ex = along.clone().multiplyScalar(width);
  const ez = f.down.clone().multiplyScalar(f.run).setY(-f.run * f.slope);
  const ey = new THREE.Vector3().crossVectors(ez.clone().normalize(), along);
  return out.makeBasis(ex, ey, ez).setPosition(o);
}

/** Un faldón llevado por una matriz (posición, giro y espejo de una casa). */
export function moveFaldon(f: Faldon, m: THREE.Matrix4): Faldon {
  const down = f.down.clone().transformDirection(m);
  down.y = 0;
  return { p0: f.p0.clone().applyMatrix4(m), p1: f.p1.clone().applyMatrix4(m), down: down.normalize(), run: f.run, slope: f.slope };
}

/** El color de cada papel de una casa: los de su modelo, con los de un esquema encima. */
export function roleColors(model: HouseModel, ...over: (Record<string, string> | undefined)[]): Record<string, string> {
  return Object.assign({}, model.colors, ...over.filter(Boolean));
}

/**
 * Color y máscara de pintura de una casa armada: cada vértice con el color de su papel por su
 * tono; los papeles de `painted` quedan blancos (por su tono) y pintables, para que los tiña el
 * color de cada instancia, salvo que venga `paint` (una casa sola): entonces se hornean con él.
 */
export function paintHouse(
  g: THREE.BufferGeometry,
  roles: readonly string[],
  role: Uint8Array,
  shade: Float32Array,
  colors: Record<string, string>,
  painted: ReadonlySet<string>,
  paint?: THREE.Color,
): { color: THREE.BufferAttribute; surface: THREE.BufferAttribute } {
  const n = role.length;
  const lin = roles.map((r) => {
    if (painted.has(r)) return paint ? paint.clone() : WHITE.clone();
    const hex = colors[r];
    if (hex === undefined) throw new Error(`Falta el color del papel "${r}"`);
    return new THREE.Color(hex);
  });
  const src = g.getAttribute('aSurface').array as Uint8Array;
  const color = new Uint8Array(n * 3);
  const surface = new Uint8Array(src);
  for (let k = 0; k < n; k++) {
    const c = lin[role[k]];
    const s = shade[k];
    color[k * 3] = Math.round(Math.min(1, c.r * s) * 255);
    color[k * 3 + 1] = Math.round(Math.min(1, c.g * s) * 255);
    color[k * 3 + 2] = Math.round(Math.min(1, c.b * s) * 255);
    surface[k * 4 + 1] = painted.has(roles[role[k]]) && !paint ? 255 : 0;
  }
  return { color: new THREE.BufferAttribute(color, 3, true), surface: new THREE.BufferAttribute(surface, 4, true) };
}

/**
 * Una variante de la geometría de cerca con otro color y otra máscara, que comparte todo lo demás
 * (posición, normales, dibujos, luz, reflectores, índice) con la original. Con `mirror`, además, el
 * índice al revés: con una matriz de instancia que espeja en X, las caras vuelven a mirar afuera.
 */
export function houseVariant(g: THREE.BufferGeometry, paint: { color: THREE.BufferAttribute; surface: THREE.BufferAttribute }, mirror: THREE.BufferAttribute | null): THREE.BufferGeometry {
  const v = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) v.setAttribute(name, g.getAttribute(name));
  v.setAttribute('color', paint.color);
  v.setAttribute('aSurface', paint.surface);
  v.setIndex(mirror ?? g.index);
  v.boundingSphere = g.boundingSphere;
  return v;
}

/** El índice de una geometría con cada triángulo al revés (para la mano espejada). */
export function mirroredIndex(g: THREE.BufferGeometry): THREE.BufferAttribute {
  const src = g.index!.array;
  const dst = src instanceof Uint16Array ? new Uint16Array(src.length) : new Uint32Array(src.length);
  for (let k = 0; k < src.length; k += 3) {
    dst[k] = src[k];
    dst[k + 1] = src[k + 2];
    dst[k + 2] = src[k + 1];
  }
  return new THREE.BufferAttribute(dst, 1);
}

/** Colores fijos de las piezas de lejos que no se pintan. */
export interface FarColors {
  soffit: THREE.Color;
}

/** Luz propia de noche de las caras de la caja de lejos (por m²): el frente, el fondo y los dos costados. */
export interface FarGlow {
  front: THREE.Color;
  back: THREE.Color;
  sides: THREE.Color;
}

/**
 * Las piezas de lejos, unitarias y pintables, para escalar por instancia (centradas en X y Z):
 * - `walls`: la caja de los muros (de −0,5 a 0,5 en X y Z, de 0 a 1 en Y), sin tapas, con la luz
 *   de noche de sus caras (`glow`: la de las ventanas y apliques de cerca, repartida en la cara);
 * - `bare`: la misma caja sin luz (las casas en obra);
 * - `gables`: los dos hastiales (triángulos en X = ±0,5, de Y 0 a 1 con la punta en Z = 0);
 * - `roof`: las dos aguas (de los aleros en Y = 0, Z = ±0,5, a la cumbrera en Y = 1, Z = 0) con su cielo.
 * Un techo con la cumbrera hacia el fondo usa las mismas, giradas un cuarto de vuelta.
 */
export function farPieces(flood: number, c: FarColors, glow: FarGlow): { walls: THREE.BufferGeometry; bare: THREE.BufferGeometry; gables: THREE.BufferGeometry; roof: THREE.BufferGeometry } {
  const paint: Surface = { paint: 1 };
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const box = (lit: FarGlow | null): THREE.BufferGeometry => {
    const b = new Batch();
    b.flood[0] = flood;
    for (const s of [1, -1]) {
      faced(b, V(-0.5, 0, s / 2), V(0.5, 0, s / 2), V(0.5, 1, s / 2), V(-0.5, 1, s / 2), V(0, 0, s), WHITE, { ...paint, glow: lit ? (s > 0 ? lit.front : lit.back) : undefined });
      faced(b, V(s / 2, 0, 0.5), V(s / 2, 0, -0.5), V(s / 2, 1, -0.5), V(s / 2, 1, 0.5), V(s, 0, 0), WHITE, { ...paint, glow: lit?.sides });
    }
    return b.build();
  };
  const walls = box(glow);
  const bare = box(null);
  const gables = new Batch();
  gables.flood[0] = flood;
  for (const s of [1, -1]) facedTri(gables, V(s / 2, 0, 0.5), V(s / 2, 0, -0.5), V(s / 2, 1, 0), V(s, 0, 0), WHITE, paint);
  const roof = new Batch();
  roof.flood[0] = flood;
  for (const s of [1, -1]) {
    const n = V(0, 0.5, s).normalize();
    faced(roof, V(-0.5, 0, s / 2), V(0.5, 0, s / 2), V(0.5, 1, 0), V(-0.5, 1, 0), n, WHITE, paint);
    faced(roof, V(-0.5, 0, s / 2), V(0.5, 0, s / 2), V(0.5, 1, 0), V(-0.5, 1, 0), n.clone().negate(), c.soffit, {});
  }
  return { walls, bare, gables: gables.build(), roof: roof.build() };
}

/** La caja unitaria de la casa en obra (de −0,5 a 0,5 en los tres ejes): de bloque y pintable (su color va por instancia). */
export function obraPiece(parts: HouseParts, flood: number): THREE.BufferGeometry {
  const b = new Batch();
  b.flood[0] = flood;
  const f = parts.finishes[parts.obra.role];
  const s: Surface = f ? { paint: 1, pattern: patternOf(f.pattern), scale: f.scale, tone: f.tone } : { paint: 1 };
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  for (const k of [1, -1]) {
    const h = k / 2;
    faced(b, V(h, -0.5, -0.5), V(h, -0.5, 0.5), V(h, 0.5, 0.5), V(h, 0.5, -0.5), V(k, 0, 0), WHITE, s, ONES);
    faced(b, V(-0.5, h, -0.5), V(0.5, h, -0.5), V(0.5, h, 0.5), V(-0.5, h, 0.5), V(0, k, 0), WHITE, s, ONES);
    faced(b, V(-0.5, -0.5, h), V(0.5, -0.5, h), V(0.5, 0.5, h), V(-0.5, 0.5, h), V(0, 0, k), WHITE, s, ONES);
  }
  return b.build();
}

// ============================================================================================
// Revisión de la config
// ============================================================================================

/** Falla con un mensaje claro si un número no es positivo (un largo ≤ 0 daría un bucle sin fin o una pieza vacía). */
export function positive(where: string, what: string, v: unknown): void {
  if (typeof v !== 'number' || !(v > 0)) throw new Error(`${where}: ${what} tiene que ser un número mayor que 0 (es ${String(v)})`);
}

/** Falla si un rango [desde, hasta] no va hacia adelante. */
function range(where: string, what: string, r: unknown): void {
  if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== 'number' || typeof r[1] !== 'number' || !(r[1] > r[0])) throw new Error(`${where}: ${what} tiene que ser [desde, hasta] con hasta > desde (es ${JSON.stringify(r)})`);
}

/** Revisa las piezas comunes. */
export function checkParts(p: HouseParts, where: string): void {
  if (!p || typeof p !== 'object') throw new Error(`${where}: faltan las piezas ("parts")`);
  for (const [what, v] of [
    ['molding.out', p.molding?.out],
    ['reveal', p.reveal],
    ['tube.size', p.tube?.size],
    ['rail.spacing', p.rail?.spacing],
    ['rail.bar', p.rail?.bar],
    ['rail.rail', p.rail?.rail],
    ['roof.sheet', p.roof?.sheet],
    ['roof.wave.pitch', p.roof?.wave?.pitch],
    ['roof.wave.segments', p.roof?.wave?.segments],
    ['canopy.sheet', p.canopy?.sheet],
    ['canopy.bracket', p.canopy?.bracket],
    ['lot.setback', p.lot?.setback],
    ['lot.closure.height', p.lot?.closure?.height],
    ['lot.closure.thickness', p.lot?.closure?.thickness],
    ['obra.thickness', p.obra?.thickness],
    ['sides', p.sides],
  ] as [string, unknown][]) {
    positive(where, what, v);
  }
  if (!(p.molding.width >= 0) || !(p.door?.frame >= 0) || !(p.bury >= 0) || !(p.roof.fascia >= 0) || !(p.roof.wave.height >= 0) || !(p.roof.wave.out >= 0)) throw new Error(`${where}: molding.width, door.frame, bury, roof.fascia, roof.wave.height y roof.wave.out no pueden ser negativos`);
  for (const f of Object.values(p.finishes ?? {})) patternOf(f.pattern);
  if (p.lamp?.size?.length !== 3 || p.lamp.size.some((v) => !(v > 0))) throw new Error(`${where}: lamp.size tiene que ser [ancho, alto, fondo] positivos`);
  if (p.lot.pillar?.size?.length !== 3 || p.lot.pillar.cap?.length !== 3) throw new Error(`${where}: lot.pillar.size y lot.pillar.cap son [ancho, fondo, alto]`);
}

/** Revisa un modelo (y que se pueda armar: los vanos caen en sus muros). */
export function checkModel(m: HouseModel, parts: HouseParts, where: string): void {
  if (!m.volumes?.length) throw new Error(`${where}: el modelo no tiene volúmenes`);
  for (const v of m.volumes) {
    positive(where, `el alto del volumen "${v.name}"`, v.height);
    if (!(v.base >= 0)) throw new Error(`${where}: el pie del volumen "${v.name}" no puede ser negativo`);
    for (const f of v.faces ?? []) if (!SIDES.includes(f)) throw new Error(`${where}: el volumen "${v.name}" tiene en faces "${String(f)}" (front, back, left o right)`);
  }
  const R = m.roof;
  if (!R || !['gable', 'shed', 'flat'].includes(R.kind) || !['x', 'z'].includes(R.ridge)) throw new Error(`${where}: roof.kind es gable, shed o flat y roof.ridge es x o z`);
  positive(where, 'roof.eave', R.eave);
  if (R.kind !== 'flat') positive(where, 'roof.pitch', R.pitch);
  if (m.setback !== 'left' && m.setback !== 'right') throw new Error(`${where}: setback es "left" o "right"`);
  m.openings.forEach((o, k) => {
    range(where, `el vano ${k}: x`, o.x);
    range(where, `el vano ${k}: y`, o.y);
    if (o.kind === 'window' && (!o.panes || o.panes.some((v) => !(v > 0)))) throw new Error(`${where}: la ventana ${k} necesita "panes" [columnas, filas] positivos`);
    if (o.guard?.kind === 'tubes') positive(where, `los tubos del vano ${k}: count`, o.guard.count);
  });
  for (const r of [...(m.panels ?? []), ...(m.bands ?? [])]) {
    range(where, `el paño "${r.role}": x`, r.x);
    range(where, `el paño "${r.role}": y`, r.y);
  }
  for (const c of m.canopies ?? []) positive(where, 'el vuelo de un tejadillo', c.depth);
  for (const b of m.balconies ?? []) {
    positive(where, 'el vuelo de un balcón (depth)', b.depth);
    positive(where, 'el grosor de la losa de un balcón (slab)', b.slab);
  }
  for (const p of m.planters ?? []) {
    positive(where, 'el alto de una jardinera (height)', p.height);
    positive(where, 'el ancho del borde de una jardinera (lip)', p.lip);
    if (!(p.drop >= 0 && p.drop < p.height)) throw new Error(`${where}: drop de una jardinera (cuánto baja la tierra bajo su canto) va de 0 a su alto (es ${String(p.drop)})`);
  }
  if (m.fence) {
    positive(where, 'fence.posts[0]', m.fence.posts[0]);
    positive(where, 'fence.posts[1]', m.fence.posts[1]);
  }
  // Si un vano, un paño o un tejadillo no cae en ningún muro, lo dice el armado.
  void parts;
}

// ============================================================================================
// Una casa sola (tipo `house`)
// ============================================================================================

/**
 * Una casa sola con todo el detalle (tipo `house`, config/sites/<archivo>.json). En
 * config/game.json → monuments.list van su lat/lon (el medio de la fachada más adelantada, al pie)
 * y `headingDeg`: el rumbo del frente de izquierda a derecha visto desde la calle. Sin ficha ni
 * nombre en la interfaz (una casa entra al mundo como cualquier edificio).
 */
export interface HouseFile {
  name: string;
  /** De dónde salió cada dato (fotos propias, planos, cinta), con su fecha. */
  sources: string[];
  /** Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos. */
  clear: number[][][];
  model: HouseModel;
  parts: HouseParts;
  /** Color de cada papel que no trae el modelo (o que cambia). */
  colors: Record<string, string>;
  /** Color de las paredes pintadas (los papeles de `painted`). */
  wall: string;
  /** Papeles que llevan el color de las paredes. */
  painted: string[];
  /** Color del techo (la cara de arriba de la plancha). */
  roof: string;
  /** Si es la otra mano (espejada) de la descrita. */
  mirror: boolean;
  /** Puntos (marco local: x, z) donde se mide el suelo; la casa se asienta en su mediana. */
  ground: number[][];
  /** A cuántos m del centro deja de verse lo chico (apliques, tubos, barrotes, ménsulas). */
  detail: { near: number };
}

/** Revisa el archivo de una casa sola. */
function checkHouseFile(f: HouseFile, where: string): void {
  checkParts(f.parts, where);
  checkModel(f.model, f.parts, where);
  positive(where, 'detail.near', f.detail?.near);
  if (!f.ground?.length) throw new Error(`${where}: faltan los puntos donde se mide el suelo ("ground")`);
  for (const r of f.painted ?? []) if (f.wall === undefined) throw new Error(`${where}: el papel "${r}" va pintado y falta "wall"`);
  if (typeof f.roof !== 'string') throw new Error(`${where}: falta el color del techo ("roof")`);
  const colors = roleColors(f.model, f.colors);
  for (const r of [f.parts.roof.soffit, f.parts.roof.fasciaRole]) if (typeof colors[r] !== 'string') throw new Error(`${where}: falta el color del papel "${r}" (el cielo o la fascia del techo)`);
}

export const HOUSE: PlaceType<HouseFile> = {
  check: checkHouseFile,
  signs: () => [],
  lights: () => [],
  clear: (f) => f.clear,
  build: (f, kit) => buildOne(f, kit),
};

/** Arma una casa sola en el marco del lugar (la casa en su propio marco, espejada si toca). */
function buildOne(f: HouseFile, kit: PlaceKit): void {
  const id = f.name;
  const hs = f.ground.map(([x, z]) => kit.terrain(x, z)).sort((a, b) => a - b);
  const base = hs[Math.floor(hs.length / 2)];
  const shape = buildHouse(f.model, f.parts, true, { intensity: kit.flood, base }, `config/sites (${f.name})`);
  const colors = roleColors(f.model, f.colors);
  const painted = new Set(f.painted);
  const wall = new THREE.Color(f.wall);
  const mirror = new THREE.Matrix4().makeScale(f.mirror ? -1 : 1, 1, 1);
  const place = new THREE.Matrix4().makeTranslation(0, base, 0).multiply(mirror);
  // Lo de cerca, ya pintado, con la plancha del techo horneada encima.
  const bake = (g: THREE.BufferGeometry, role: Uint8Array, shade: Float32Array): THREE.BufferGeometry => {
    const p = paintHouse(g, shape.roles, role, shade, colors, painted, wall);
    g.setAttribute('color', p.color);
    g.setAttribute('aSurface', p.surface);
    // Espejada, three da vuelta las caras por su matriz (determinante negativo): el índice queda igual.
    return g;
  };
  const group = new THREE.Group();
  group.name = `${id}-casa`;
  const body = new THREE.Mesh(bake(shape.body, shape.role, shape.shade), kit.materials.stone);
  body.name = `${id}-muros`;
  body.applyMatrix4(place);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const roofBatch = new Batch();
  roofBatch.flood[0] = kit.flood;
  roofBatch.flood[1] = base;
  roofBatch.flood[2] = shape.top;
  const R = f.parts.roof;
  const fc: FaldonColors = { top: new THREE.Color(f.roof), paint: 0, soffit: new THREE.Color(colors[R.soffit]), fascia: new THREE.Color(colors[R.fasciaRole]) };
  const mm = new THREE.Matrix4();
  for (const fal of shape.roof) faldonPiece(roofBatch, faldonMatrix(moveFaldon(fal, place), mm), f.parts, fc);
  if (!roofBatch.empty) {
    const roof = new THREE.Mesh(roofBatch.build(), kit.materials.stone);
    roof.name = `${id}-techo`;
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);
  }
  if (shape.detail && shape.detailRole.length) {
    const detail = new THREE.Mesh(bake(shape.detail, shape.detailRole, shape.detailShade), kit.materials.stone);
    detail.name = `${id}-detalle`;
    detail.applyMatrix4(place);
    group.add(detail);
    kit.near(detail, f.detail.near);
  }
  kit.root.add(group);
  housePhysics(kit, shape, place, true);
}

/**
 * La física de una casa ubicada con `m` (marco de la geometría → marco del lugar): su macizo con
 * el techo y, con `boxes`, sus cajas (el cierre del retiro, el pilar, los tejadillos).
 */
export function housePhysics(site: PlaceSite, shape: HouseShape, m: THREE.Matrix4, boxes: boolean): void {
  const base = m.elements[13];
  const outline = shape.outline.map((p) => new THREE.Vector3(p.x, 0, p.y).applyMatrix4(m).setY(0));
  let roof: LocalRoof | undefined;
  if (shape.walk) {
    const c = new THREE.Vector3(shape.walk.x, 0, shape.walk.z).applyMatrix4(m);
    const d = new THREE.Vector3(Math.cos(shape.walk.angle), 0, Math.sin(shape.walk.angle)).transformDirection(m);
    roof = { ...shape.walk, x: c.x, z: c.z, angle: Math.atan2(d.z, d.x), edge: shape.walk.edge + base };
  }
  site.block(outline, base, base + shape.top, roof);
  if (boxes) placeBoxes(site, shape.boxes, m);
}

/** Rectángulos de física de una casa (marco de la geometría, alturas desde su pie) ubicados con `m`. */
export function placeBoxes(site: PlaceSite, list: readonly HouseBox[], m: THREE.Matrix4): void {
  const base = m.elements[13];
  for (const b of list) {
    const c = new THREE.Vector3(b.x, 0, b.z).applyMatrix4(m);
    const d = new THREE.Vector3(Math.cos(b.angle), 0, Math.sin(b.angle)).transformDirection(m);
    site.box(c.x, c.z, b.halfU, b.halfV, Math.atan2(d.z, d.x), base + b.top, b.floor, b.bottom === -Infinity ? -Infinity : base + b.bottom);
  }
}
