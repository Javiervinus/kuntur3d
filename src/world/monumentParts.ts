import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Luz propia de noche: color (sRGB) e intensidad. */
export interface Glow {
  color: string;
  intensity: number;
}

/** Lo común a todos los monumentos de config/game.json → monuments.list. */
export interface MonumentBase {
  id: string;
  type: string;
  lat: number;
  lon: number;
  /** Rumbo del frente (grados desde el norte, horario): el eje x local del monumento. */
  headingDeg?: number;
  /** Radio (m) en el que el monumento reemplaza a los edificios de los datos (0 = ninguno). */
  exclude: number;
  /** Cuánto lo alumbran de noche los reflectores (0…1). */
  flood: number;
}

export const NO_GLOW = new THREE.Color(0, 0, 0);

/**
 * Dibujos procedurales de la superficie (los pinta el material de los monumentos con las uv de la
 * pieza, en metros): el revoque con su mancha de humedad, las escamas de una cúpula, una cortina
 * metálica enrollable, un piso de terrazo y baldosas.
 */
export const PATTERN = { none: 0, stucco: 1, scales: 2, shutter: 3, terrazzo: 4, tiles: 5 } as const;

/** Cómo se ve una pieza además de su color. */
export interface Surface {
  /** Luz propia de noche (vidrios encendidos, faroles). */
  glow?: THREE.Color;
  /** Cuánto la tiñen los LED que lleva montados (solo las ruedas). */
  led?: number;
  /**
   * Oclusión ambiental: cuánto cielo y rebote le llega (1 = a la intemperie). Constante, o por
   * vértice según su posición y normal ya ubicadas (marco del monumento).
   */
  ao?: number | ((p: THREE.Vector3, n: THREE.Vector3) => number);
  /** Dibujo procedural (PATTERN) sobre las uv de la geometría... */
  pattern?: number;
  /** ...que miden (u, v) metros por unidad de uv. */
  scale?: readonly number[];
}

/**
 * Une los vértices repetidos (misma posición, normal y, si hace falta, uv; al milímetro) de una
 * geometría sin índice y le pone su índice.
 */
function weld(g: THREE.BufferGeometry, keepUv: boolean): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = keepUv ? g.getAttribute('uv') : undefined;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const index = new Uint32Array(p.count);
  for (let k = 0; k < p.count; k++) {
    const key = `${Math.round(p.getX(k) * 1000)},${Math.round(p.getY(k) * 1000)},${Math.round(p.getZ(k) * 1000)},${Math.round(n.getX(k) * 100)},${Math.round(n.getY(k) * 100)},${Math.round(n.getZ(k) * 100)}${uv ? `,${Math.round(uv.getX(k) * 1000)},${Math.round(uv.getY(k) * 1000)}` : ''}`;
    let v = map.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      map.set(key, v);
      pos.push(p.getX(k), p.getY(k), p.getZ(k));
      nor.push(n.getX(k), n.getY(k), n.getZ(k));
      if (uv) uvs.push(uv.getX(k), uv.getY(k));
    }
    index[k] = v;
  }
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const count = pos.length / 3;
  out.setIndex(new THREE.BufferAttribute(count > 0xffff ? index : Uint16Array.from(index), 1));
  return out;
}

const _pos = new THREE.Vector3();
const _nor = new THREE.Vector3();

/**
 * Piezas de un monumento, unidas en una sola geometría: color por vértice, luz propia de noche
 * (vidrios, relojes), cuánto lo alumbran los reflectores (se apagan con la altura desde su base:
 * `base` y `height`, en el mundo), cuánto lo tiñen los LED montados encima (solo las ruedas), su
 * oclusión ambiental y su dibujo procedural.
 */
export class Parts {
  private readonly list: THREE.BufferGeometry[] = [];

  constructor(
    private readonly flood: number,
    private readonly base: number,
    private readonly height: number,
  ) {}

  get empty(): boolean {
    return this.list.length === 0;
  }

  add(geometry: THREE.BufferGeometry, color: THREE.Color, matrix: THREE.Matrix4, glow: THREE.Color = NO_GLOW, led = 0): void {
    this.put(geometry, color, matrix, { glow, led });
  }

  /** Como `add`, con oclusión ambiental y dibujo procedural. */
  put(geometry: THREE.BufferGeometry, color: THREE.Color, matrix: THREE.Matrix4, surface: Surface = {}): void {
    const glow = surface.glow ?? NO_GLOW;
    const led = surface.led ?? 0;
    const pattern = surface.pattern ?? PATTERN.none;
    const withUv = pattern !== PATTERN.none && geometry.getAttribute('uv') !== undefined;
    const [su, sv] = surface.scale ?? [1, 1];
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    // Sin índice (extrusiones, molduras, piezas curvadas) cada triángulo trae sus 3 vértices:
    // soldar los repetidos deja ~la mitad.
    if (!geometry.index) geometry = weld(geometry, withUv);
    const uv = withUv ? geometry.getAttribute('uv') : undefined;
    geometry.applyMatrix4(matrix);
    const n = geometry.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    const glows = new Float32Array(n * 3);
    const floods = new Float32Array(n * 3);
    const ao = new Float32Array(n);
    const detail = new Float32Array(n * 3);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const aoOf = surface.ao ?? 1;
    for (let k = 0; k < n; k++) {
      color.toArray(colors, k * 3);
      glow.toArray(glows, k * 3);
      floods[k * 3] = this.flood;
      floods[k * 3 + 1] = this.base;
      floods[k * 3 + 2] = this.height;
      ao[k] = typeof aoOf === 'number' ? aoOf : aoOf(_pos.fromBufferAttribute(position, k), _nor.fromBufferAttribute(normal, k));
      if (uv) {
        detail[k * 3] = uv.getX(k) * su;
        detail[k * 3 + 1] = uv.getY(k) * sv;
        detail[k * 3 + 2] = pattern;
      }
    }
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aGlow', new THREE.BufferAttribute(glows, 3));
    geometry.setAttribute('aFlood', new THREE.BufferAttribute(floods, 3));
    geometry.setAttribute('aLed', new THREE.BufferAttribute(new Float32Array(n).fill(led), 1));
    geometry.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
    geometry.setAttribute('aDetail', new THREE.BufferAttribute(detail, 3));
    this.list.push(geometry);
  }

  merge(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list);
    if (!merged) throw new Error('No se pudo armar la geometría de un monumento');
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    compact(merged);
    merged.computeBoundingSphere();
    return merged;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Atributos compactos para la GPU (la mitad de memoria que en float32): normales en 8 bits, color
 * en bytes, luz propia y reflectores en half float, y oclusión, LED y tipo de dibujo en un solo
 * vec4 de bytes (`aSurface`); las uv del dibujo quedan en float32 (las juntas de 8 mm lo piden).
 */
function compact(g: THREE.BufferGeometry): void {
  const n = g.getAttribute('position').count;
  const normal = g.getAttribute('normal').array;
  const normals = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) normals[i] = Math.round(clamp(normal[i], -1, 1) * 127);
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
  const color = g.getAttribute('color').array;
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n * 3; i++) colors[i] = Math.round(clamp(color[i], 0, 1) * 255);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  for (const name of ['aGlow', 'aFlood']) {
    const src = g.getAttribute(name).array;
    const half = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    g.setAttribute(name, new THREE.Float16BufferAttribute(half, 3));
  }
  const ao = g.getAttribute('aAo').array;
  const led = g.getAttribute('aLed').array;
  const detail = g.getAttribute('aDetail').array;
  const surface = new Uint8Array(n * 4);
  const uv = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    surface[k * 4] = Math.round(clamp(ao[k], 0, 1) * 255);
    surface[k * 4 + 1] = Math.round(clamp(led[k], 0, 1) * 255);
    surface[k * 4 + 2] = detail[k * 3 + 2];
    uv[k * 2] = detail[k * 3];
    uv[k * 2 + 1] = detail[k * 3 + 1];
  }
  g.deleteAttribute('aAo');
  g.deleteAttribute('aLed');
  g.setAttribute('aSurface', new THREE.BufferAttribute(surface, 4, true));
  g.setAttribute('aDetail', new THREE.BufferAttribute(uv, 2));
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Matriz de posición, giro (radianes, en orden XYZ) y escala. */
export function place(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Barra cilíndrica de radio r entre dos puntos. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, sides: number): { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const d = new THREE.Vector3().subVectors(b, a);
  const length = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(length));
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return { geometry: new THREE.CylinderGeometry(r, r, length, sides, 1, true), matrix };
}

/** Prisma de `sides` lados con apotema `apothem` y una cara mirando a +x. */
export function prism(apothem: number, height: number, sides: number): THREE.CylinderGeometry {
  const r = apothem / Math.cos(Math.PI / sides);
  return new THREE.CylinderGeometry(r, r, height, sides, 1, false, Math.PI / sides);
}

/** Color de luz propia (lineal) de un `Glow` de la config. */
export function glowOf(g: Glow): THREE.Color {
  return new THREE.Color(g.color).multiplyScalar(g.intensity);
}

/** Todos los colores de un bloque `colors` de la config, como THREE.Color. */
export function colorsOf<K extends string>(colors: Record<K, string>): Record<K, THREE.Color> {
  const out = {} as Record<K, THREE.Color>;
  for (const key of Object.keys(colors) as K[]) out[key] = new THREE.Color(colors[key]);
  return out;
}
