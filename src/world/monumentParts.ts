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
 * metálica enrollable, un piso de terrazo, baldosas, la carpintería de una ventana (sus uv van en
 * hojas: una junta en cada entero), adoquines de vereda en hileras trabadas, y los barrotes o
 * balaustres de una baranda (solo con el material con recorte).
 */
export const PATTERN = { none: 0, stucco: 1, scales: 2, shutter: 3, terrazzo: 4, tiles: 5, glazing: 6, pavers: 7, bars: 8, balusters: 9 } as const;

/** El dibujo con ese nombre (de la config); un nombre que no existe es un error, no una pieza lisa. */
export function patternOf(name: string): number {
  const kind = PATTERN[name as keyof typeof PATTERN];
  if (kind === undefined) throw new Error(`Dibujo desconocido en la config: ${name} (hay: ${Object.keys(PATTERN).join(', ')})`);
  return kind;
}

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
  /** Un tono propio del dibujo (0…1): en la carpintería, qué tan clara es respecto del vidrio. */
  tone?: number;
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
    const tone = new Float32Array(n).fill(surface.tone ?? 0);
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
    geometry.setAttribute('aTone', new THREE.BufferAttribute(tone, 1));
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
 * en bytes, luz propia y reflectores en half float, y oclusión, LED, tipo de dibujo y su tono en un
 * solo vec4 de bytes (`aSurface`); las uv del dibujo quedan en float32 (las juntas de 8 mm lo piden).
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
  const tone = g.getAttribute('aTone').array;
  const detail = g.getAttribute('aDetail').array;
  const surface = new Uint8Array(n * 4);
  const uv = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    surface[k * 4] = Math.round(clamp(ao[k], 0, 1) * 255);
    surface[k * 4 + 1] = Math.round(clamp(led[k], 0, 1) * 255);
    surface[k * 4 + 2] = detail[k * 3 + 2];
    surface[k * 4 + 3] = Math.round(clamp(tone[k], 0, 1) * 255);
    uv[k * 2] = detail[k * 3];
    uv[k * 2 + 1] = detail[k * 3 + 1];
  }
  g.deleteAttribute('aAo');
  g.deleteAttribute('aLed');
  g.deleteAttribute('aTone');
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

/** Floats por vértice en el búfer de trabajo de `Batch` (ver `Batch.vertex`). */
const STRIDE = 21;
const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _bq = new THREE.Vector3();
const _bm = new THREE.Matrix3();
const BOX_FACES: readonly (readonly number[])[] = [
  // Normal (x, y, z) y los ejes u, v de la cara (en unidades de la caja) para cada una de las 6.
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
];

/**
 * Como `Parts`, pero sin armar una geometría de three.js por pieza: los cuadriláteros, cajas y
 * piezas sueltas van directo a un búfer que crece, y `build` entrega la geometría ya compacta
 * (los mismos atributos que `Parts.merge`). Es para lo que tiene miles de piezas chicas: una
 * calle entera de fachadas, veredas y portales.
 */
export class Batch {
  private v = new Float32Array(STRIDE * 4096);
  private count = 0;
  private index = new Uint32Array(3 * 4096);
  private indices = 0;
  /** Reflectores de lo que se agregue desde ahora: intensidad, base y alto (en el mundo). */
  readonly flood = [0, 0, 1];

  get empty(): boolean {
    return this.count === 0;
  }

  /** Vértices que lleva (para decidir cuándo cortar en otra malla). */
  get vertices(): number {
    return this.count;
  }

  private reserve(vertices: number, indices: number): void {
    if ((this.count + vertices) * STRIDE > this.v.length) {
      const next = new Float32Array(Math.max(this.v.length * 2, (this.count + vertices) * STRIDE));
      next.set(this.v);
      this.v = next;
    }
    if (this.indices + indices > this.index.length) {
      const next = new Uint32Array(Math.max(this.index.length * 2, this.indices + indices));
      next.set(this.index);
      this.index = next;
    }
  }

  /** Un vértice: posición, normal, color, luz propia, oclusión, dibujo con su tono y uv. */
  private vertex(p: THREE.Vector3, n: THREE.Vector3, color: THREE.Color, s: Surface, u: number, w: number): number {
    const o = this.count * STRIDE;
    const v = this.v;
    const glow = s.glow ?? NO_GLOW;
    const [su, sv] = s.scale ?? [1, 1];
    const ao = s.ao ?? 1;
    v[o] = p.x;
    v[o + 1] = p.y;
    v[o + 2] = p.z;
    v[o + 3] = n.x;
    v[o + 4] = n.y;
    v[o + 5] = n.z;
    v[o + 6] = color.r;
    v[o + 7] = color.g;
    v[o + 8] = color.b;
    v[o + 9] = glow.r;
    v[o + 10] = glow.g;
    v[o + 11] = glow.b;
    v[o + 12] = typeof ao === 'number' ? ao : ao(p, n);
    v[o + 13] = s.led ?? 0;
    v[o + 14] = s.pattern ?? PATTERN.none;
    v[o + 15] = s.tone ?? 0;
    v[o + 16] = u * su;
    v[o + 17] = w * sv;
    v[o + 18] = this.flood[0];
    v[o + 19] = this.flood[1];
    v[o + 20] = this.flood[2];
    return this.count++;
  }

  /**
   * Cuadrilátero a-b-c-d (en sentido antihorario visto desde el lado que muestra). Sus uv: 4
   * números van de (u0, v0) en a a (u1, v1) en c; 8, una por esquina; sin ellas, en metros a lo
   * largo de a→b y a→d.
   */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, surface: Surface = {}, uv?: readonly number[]): void {
    _bp.subVectors(b, a);
    _bq.subVectors(d, a);
    _bn.crossVectors(_bp, _bq);
    if (_bn.lengthSq() < 1e-12) return;
    _bn.normalize();
    const [u0, v0, u1, v1] = uv ?? [0, 0, _bp.length(), _bq.length()];
    const corners = uv?.length === 8 ? uv : [u0, v0, u1, v0, u1, v1, u0, v1];
    this.reserve(4, 6);
    const i = this.vertex(a, _bn, color, surface, corners[0], corners[1]);
    this.vertex(b, _bn, color, surface, corners[2], corners[3]);
    this.vertex(c, _bn, color, surface, corners[4], corners[5]);
    this.vertex(d, _bn, color, surface, corners[6], corners[7]);
    this.index.set([i, i + 1, i + 2, i, i + 2, i + 3], this.indices);
    this.indices += 6;
  }

  /** Triángulo a-b-c (antihorario visto desde el lado que muestra), con uv por esquina (6 números). */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, surface: Surface = {}, uv: readonly number[] = [0, 0, 0, 0, 0, 0]): void {
    _bp.subVectors(b, a);
    _bq.subVectors(c, a);
    _bn.crossVectors(_bp, _bq);
    if (_bn.lengthSq() < 1e-12) return;
    _bn.normalize();
    this.reserve(3, 3);
    const i = this.vertex(a, _bn, color, surface, uv[0], uv[1]);
    this.vertex(b, _bn, color, surface, uv[2], uv[3]);
    this.vertex(c, _bn, color, surface, uv[4], uv[5]);
    this.index.set([i, i + 1, i + 2], this.indices);
    this.indices += 3;
  }

  /** Caja de w × h × d centrada en el origen del marco m (uv de cada cara en metros). */
  box(m: THREE.Matrix4, w: number, h: number, d: number, color: THREE.Color, surface: Surface = {}): void {
    const half = [w / 2, h / 2, d / 2];
    const size = [w, h, d];
    const corner = (f: readonly number[], su: number, sv: number): THREE.Vector3 => {
      // Centro de la cara + su·eje u + sv·eje v, cada eje escalado a la mitad de la caja.
      const p = new THREE.Vector3(f[0] * half[0], f[1] * half[1], f[2] * half[2]);
      p.x += (f[3] * su + f[6] * sv) * half[0];
      p.y += (f[4] * su + f[7] * sv) * half[1];
      p.z += (f[5] * su + f[8] * sv) * half[2];
      return p.applyMatrix4(m);
    };
    for (const f of BOX_FACES) {
      const du = Math.abs(f[3]) * size[0] + Math.abs(f[4]) * size[1] + Math.abs(f[5]) * size[2];
      const dv = Math.abs(f[6]) * size[0] + Math.abs(f[7]) * size[1] + Math.abs(f[8]) * size[2];
      this.quad(corner(f, -1, -1), corner(f, 1, -1), corner(f, 1, 1), corner(f, -1, 1), color, surface, [0, 0, du, dv]);
    }
  }

  /** Una pieza cualquiera (con o sin índice) ubicada con la matriz m; usa sus uv si tiene. */
  geometry(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}): void {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const n = pos.count;
    const idx = g.index;
    const tris = idx ? idx.count : n;
    this.reserve(n, tris);
    _bm.getNormalMatrix(m);
    const first = this.count;
    for (let k = 0; k < n; k++) {
      _bp.fromBufferAttribute(pos, k).applyMatrix4(m);
      _bn.fromBufferAttribute(nor, k).applyMatrix3(_bm).normalize();
      this.vertex(_bp, _bn, color, surface, uv ? uv.getX(k) : 0, uv ? uv.getY(k) : 0);
    }
    // Una matriz que espeja da vuelta las caras: se corrige el orden.
    const flip = m.determinant() < 0;
    for (let t = 0; t < tris; t += 3) {
      const a = idx ? idx.getX(t) : t;
      const b = idx ? idx.getX(t + 1) : t + 1;
      const c = idx ? idx.getX(t + 2) : t + 2;
      this.index[this.indices++] = first + a;
      this.index[this.indices++] = first + (flip ? c : b);
      this.index[this.indices++] = first + (flip ? b : c);
    }
  }

  /** La geometría compacta (ver `compact`); el búfer de trabajo queda vacío para reusar. */
  build(): THREE.BufferGeometry {
    const n = this.count;
    const v = this.v;
    const position = new Float32Array(n * 3);
    const normal = new Int8Array(n * 3);
    const color = new Uint8Array(n * 3);
    const glow = new Uint16Array(n * 3);
    const flood = new Uint16Array(n * 3);
    const surface = new Uint8Array(n * 4);
    const detail = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE;
      for (let c = 0; c < 3; c++) {
        position[k * 3 + c] = v[o + c];
        normal[k * 3 + c] = Math.round(clamp(v[o + 3 + c], -1, 1) * 127);
        color[k * 3 + c] = Math.round(clamp(v[o + 6 + c], 0, 1) * 255);
        glow[k * 3 + c] = THREE.DataUtils.toHalfFloat(v[o + 9 + c]);
        flood[k * 3 + c] = THREE.DataUtils.toHalfFloat(v[o + 18 + c]);
      }
      surface[k * 4] = Math.round(clamp(v[o + 12], 0, 1) * 255);
      surface[k * 4 + 1] = Math.round(clamp(v[o + 13], 0, 1) * 255);
      surface[k * 4 + 2] = v[o + 14];
      surface[k * 4 + 3] = Math.round(clamp(v[o + 15], 0, 1) * 255);
      detail[k * 2] = v[o + 16];
      detail[k * 2 + 1] = v[o + 17];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3, true));
    g.setAttribute('aGlow', new THREE.Float16BufferAttribute(glow, 3));
    g.setAttribute('aFlood', new THREE.Float16BufferAttribute(flood, 3));
    g.setAttribute('aSurface', new THREE.BufferAttribute(surface, 4, true));
    g.setAttribute('aDetail', new THREE.BufferAttribute(detail, 2));
    const index = this.index.subarray(0, this.indices);
    g.setIndex(new THREE.BufferAttribute(n > 0xffff ? index.slice() : Uint16Array.from(index), 1));
    g.computeBoundingSphere();
    this.count = 0;
    this.indices = 0;
    return g;
  }
}
