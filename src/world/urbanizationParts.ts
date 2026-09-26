import * as THREE from 'three';
import type { SignFace, SignRect } from '../render/signAtlas';
import { deepMerge, seedOf } from './downtown';
import { type Batch, type Glow, PATTERN, type Surface, glowOf, patternOf } from './monumentParts';
import type { LocalRoof, PlaceLight, PlaceSite } from './placeKit';
import type { PavedStyle } from './street';

/**
 * Piezas genéricas de una urbanización (y de cualquier lugar de config/sites/): techos inclinados
 * de teja, pabellones sobre postes (aleros de garita, casas club abiertas, glorietas), casetas y
 * torres con sus vanos, portones corredizos, plumas, reductores y cebras, bolardos, letreros de
 * panel, pisos con bordillo pintado. Cada una se describe en la config con un estilo (por nombre)
 * y un lugar en su zona; los largos en m y las alturas sobre el terreno.
 */

const WHITE = new THREE.Color(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Un marco local dentro del lugar: su origen (marco del lugar) y el rumbo de su eje u (radianes,
 * desde el x del lugar hacia su z); v queda a la derecha de u. Las alturas no cambian.
 */
export class Frame {
  constructor(
    readonly x: number,
    readonly z: number,
    readonly angle: number,
  ) {}

  /** El marco de algo que está en `at` (u, v) de `parent` (o del lugar), girado `deg` grados. */
  static of(at: readonly number[], deg: number, parent?: Frame): Frame {
    const a = THREE.MathUtils.degToRad(deg);
    if (!parent) return new Frame(at[0], at[1], a);
    const p = parent.point(at[0], at[1]);
    return new Frame(p.x, p.z, parent.angle + a);
  }

  /** Un punto del marco en el marco del lugar. */
  point(u: number, v: number): { x: number; z: number } {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return { x: this.x + u * c - v * s, z: this.z + u * s + v * c };
  }

  /** Un contorno del marco en el marco del lugar. */
  ring(r: readonly (readonly number[])[]): number[][] {
    return r.map(([u, v]) => {
      const p = this.point(u, v);
      return [p.x, p.z];
    });
  }

  /** Matriz del marco (u, y, v) al lugar (x, y, z). */
  matrix(): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationY(-this.angle).setPosition(this.x, 0, this.z);
  }
}

/** Una entrada con nombre de una tabla de estilos de la config (falla si no existe). */
export function pick<T>(table: Record<string, T> | undefined, name: string, what: string): T {
  const v = table && Object.hasOwn(table, name) ? table[name] : undefined;
  if (v === undefined) throw new Error(`${what} desconocido en la config: ${name} (hay: ${Object.keys(table ?? {}).join(', ') || 'ninguno'})`);
  return v;
}

/** El estilo con nombre, con los retoques del lugar. */
export function styled<T>(table: Record<string, T> | undefined, name: string, what: string, set?: Record<string, unknown>): T {
  return deepMerge(pick(table, name, what), set);
}

/**
 * Cómo se asientan los pisos y los muros de un lugar en el terreno (config → ground):
 * - `tolerance` y `maxEdge`: un piso que sigue el terreno se parte solo donde el terreno se separa
 *   de la recta entre dos vértices más de `tolerance` m (a mitad de camino), y ningún lado pasa de
 *   `maxEdge` m (ver paveFit): en lo plano quedan pocos triángulos grandes;
 * - `lift`: cuánto sube la franja de un bordillo sobre su losa (m);
 * - `bury`: cuánto bajan muros y bordillos bajo el terreno (m);
 * - `wall`: el grosor mínimo de la física de un muro o una valla (m): uno más fino se atraviesa
 *   corriendo, porque el jugador prueba un solo punto por cuadro;
 * - `roofStep`: de a cuánto (m, hacia adentro) se escalona la física de un techo inclinado sobre
 *   postes (un pabellón: se pisan sus aguas y no una losa a la altura de la cumbrera).
 */
export interface UrbanGround {
  tolerance: number;
  maxEdge: number;
  lift: number;
  bury: number;
  wall: number;
  roofStep: number;
}

/**
 * Lo que las piezas necesitan de su zona para armarse: el terreno, su pedazo de la física y del
 * LOD, los búferes (stone: se ve siempre; detail: lo chico, solo de cerca; rails: calado; glass:
 * vidrio; water: agua) y los letreros. Todo en el marco del lugar.
 */
export interface PartsKit {
  terrain(x: number, z: number): number;
  site: PlaceSite;
  stone: Batch;
  detail: Batch;
  rails: Batch;
  glass: Batch;
  water: Batch;
  signRect(s: SignFace): SignRect;
  signOffset: number;
  ground: UrbanGround;
  /** Lados de lo redondo (bolardos, círculos pintados, aros) y de lo fino (caños, cadenas). */
  sides: number;
  thin: number;
  /** Cuánto sobre el terreno está el piso de la zona en (x, z): el más alto que lo contiene (0 si ninguno). */
  floorAt(x: number, z: number): number;
}

/** Los cinco búferes de una zona (para cambiarles juntos el suelo de los reflectores). */
function batchesOf(pk: PartsKit): Batch[] {
  return [pk.stone, pk.detail, pk.rails, pk.glass, pk.water];
}

/**
 * Arma una pieza con su suelo: `Batch.flood` guarda de dónde se mide lo que se agrega (la base de
 * los reflectores y del pie sucio del revoque, que se ve hasta `foot.height` sobre ese suelo).
 * `flood`, si viene, también cambia cuánto la alumbran de noche los reflectores y hasta qué alto.
 */
export function onGround(pk: PartsKit, base: number, draw: () => void, flood?: { intensity: number; height: number }): void {
  const batches = batchesOf(pk);
  const saved = batches.map((b) => [...b.flood]);
  for (const b of batches) {
    b.flood[1] = base;
    if (flood) {
      b.flood[0] = flood.intensity;
      b.flood[2] = flood.height;
    }
  }
  draw();
  batches.forEach((b, k) => saved[k].forEach((v, i) => (b.flood[i] = v)));
}

// ---------------------------------------------------------------------------------------------
// Pisos que siguen el terreno

/** ¿Hay que partir el lado a-b? Si pasa de `maxEdge` o el terreno a mitad de camino se separa de la recta más de `tolerance`. */
function splits(a: THREE.Vector2, b: THREE.Vector2, top: (x: number, z: number) => number, fit: UrbanGround): boolean {
  const len = a.distanceTo(b);
  // Lo más corto que la tolerancia no se parte (en un escalón del terreno el bucle no terminaría).
  if (len <= fit.tolerance) return false;
  if (len > fit.maxEdge) return true;
  const mx = (a.x + b.x) / 2;
  const mz = (a.y + b.y) / 2;
  return Math.abs(top(mx, mz) - (top(a.x, a.y) + top(b.x, b.y)) / 2) > fit.tolerance;
}

/**
 * Los puntos de un lado a-b partido como lo parte `paveFit` (de a a b, con las puntas): lo que va
 * pegado a un borde de un piso (un bordillo, su pintura) sigue la misma línea quebrada.
 */
export function fitEdge(a: THREE.Vector2, b: THREE.Vector2, top: (x: number, z: number) => number, fit: UrbanGround): THREE.Vector2[] {
  const out = [a.clone()];
  const cut = (p: THREE.Vector2, q: THREE.Vector2): void => {
    if (!splits(p, q, top, fit)) return;
    const m = new THREE.Vector2((p.x + q.x) / 2, (p.y + q.y) / 2);
    cut(p, m);
    out.push(m);
    cut(m, q);
  };
  cut(a, b);
  out.push(b.clone());
  return out;
}

/**
 * Una losa que sigue el terreno (a la altura `top` en cada vértice): el contorno y sus huecos
 * (marco del lugar) triangulados, y cada lado partido por la mitad mientras `splits` lo pida. La
 * decisión es del lado (no del triángulo): los dos triángulos que lo comparten lo parten igual, sin
 * grietas. En lo plano quedan pocos triángulos grandes; en pendiente, los que pida el relieve.
 * Devuelve la triangulación sin partir (marco del lugar): lo que pisa la física.
 */
export function paveFit(batch: Batch, ring: readonly (readonly number[])[], holes: readonly (readonly (readonly number[])[])[], top: (x: number, z: number) => number, fit: UrbanGround, color: THREE.Color, surface: Surface): number[][][] {
  const v2 = (r: readonly (readonly number[])[]): THREE.Vector2[] => r.map(([x, z]) => new THREE.Vector2(x, z));
  const outer = v2(ring);
  const inner = holes.map(v2);
  const all = [outer, ...inner].flat();
  const tris = THREE.ShapeUtils.triangulateShape(outer, inner);
  const put = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): void => {
    // El lado más largo de los que hay que partir.
    let cut: [THREE.Vector2, THREE.Vector2, THREE.Vector2] | null = null;
    let longest = -1;
    for (const [p, q, r] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as [THREE.Vector2, THREE.Vector2, THREE.Vector2][]) {
      const len = p.distanceTo(q);
      if (len > longest && splits(p, q, top, fit)) {
        longest = len;
        cut = [p, q, r];
      }
    }
    if (cut) {
      const [p, q, r] = cut;
      const m = new THREE.Vector2((p.x + q.x) / 2, (p.y + q.y) / 2);
      put(p, m, r);
      put(m, q, r);
      return;
    }
    const [pa, pb, pc] = [a, b, c].map((p) => new THREE.Vector3(p.x, top(p.x, p.y), p.y));
    facingTri(batch, true, [pa, pb, pc], color, surface, [pa.x, pa.z, pb.x, pb.z, pc.x, pc.z]);
  };
  for (const [a, b, c] of tris) put(all[a], all[b], all[c]);
  return tris.map((t) => t.map((k) => [all[k].x, all[k].y]));
}

/**
 * Una losa con bordillo que sigue el terreno (vereda, isla, parterre): la losa `S.height` sobre el
 * terreno en `slab`; en los lados `curbs` del contorno, el canto del bordillo (de `ground.bury` bajo
 * la calzada hasta la losa, mirando afuera) y su franja de arriba (`S.curb` m de ancho,
 * `ground.lift` sobre la losa) en `curb`, partidos donde se parte el borde de la losa; y su física
 * en `site` (sin él, no se pisa).
 */
export function curbed(s: { ring: readonly (readonly number[])[]; curbs: readonly number[] }, S: PavedStyle, ground: UrbanGround, terrain: (x: number, z: number) => number, slab: Batch, curb: Batch, site: PlaceSite | null): void {
  const top = (x: number, z: number): number => terrain(x, z) + S.height;
  paveFit(slab, s.ring, [], top, ground, new THREE.Color(S.color), { pattern: patternOf(S.pattern), scale: S.scale });
  curbEdges(curb, s.ring, s.curbs, top, S.curb, ground, S.height, new THREE.Color(S.curbColor));
  site?.ground(
    s.ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    S.height,
  );
}

/** Suelo de una pieza: la mediana del terreno en las esquinas y el centro de su rectángulo (u, v) del marco `f`. */
export function baseOf(f: Frame, w: number, d: number, terrain: (x: number, z: number) => number): { base: number; low: number } {
  const h = [
    [0, 0],
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([u, v]) => {
    const p = f.point(u, v);
    return terrain(p.x, p.z);
  });
  const low = Math.min(...h);
  h.sort((a, b) => a - b);
  return { base: h[Math.floor(h.length / 2)], low };
}

/** Cuadrilátero que mira hacia arriba (`up`) o hacia abajo: lo da vuelta si hace falta (uv por esquina). */
function facing(b: Batch, up: boolean, p: THREE.Vector3[], color: THREE.Color, surface: Surface, uv?: number[]): void {
  const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[0]));
  if (n.y >= 0 === up) b.quad(p[0], p[1], p[2], p[3], color, surface, uv);
  else b.quad(p[1], p[0], p[3], p[2], color, surface, uv && [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
}

/** Triángulo que mira hacia arriba (`up`) o hacia abajo. */
function facingTri(b: Batch, up: boolean, p: THREE.Vector3[], color: THREE.Color, surface: Surface, uv: number[]): void {
  const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
  if (n.y >= 0 === up) b.tri(p[0], p[1], p[2], color, surface, uv);
  else b.tri(p[1], p[0], p[2], color, surface, [uv[2], uv[3], uv[0], uv[1], uv[4], uv[5]]);
}

/** Cuadrilátero que mira hacia `dir` (lo da vuelta si hace falta). */
function toward(b: Batch, dir: THREE.Vector3, p: THREE.Vector3[], color: THREE.Color, surface: Surface, uv?: number[]): void {
  const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[0]));
  if (n.dot(dir) >= 0) b.quad(p[0], p[1], p[2], p[3], color, surface, uv);
  else b.quad(p[1], p[0], p[3], p[2], color, surface, uv && [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
}

// ---------------------------------------------------------------------------------------------
// Techos

/**
 * Techo inclinado de teja (o lámina): 'hip' (a cuatro aguas; con los dos lados iguales termina en
 * punta) o 'gable' (a dos aguas, la cumbrera a lo largo). Pendiente (grados), vuelo del alero, color
 * y dibujo de la teja con su escala y oclusión, y el cielo del alero (color y oclusión).
 */
export interface RoofStyle {
  kind: string;
  pitch: number;
  overhang: number;
  color: string;
  pattern: string;
  scale: number[];
  ao: number;
  soffit: string;
  soffitAo: number;
}

/** El acabado de los muros bajo un techo: su color y su superficie (dibujo, escala, oclusión), que lleva también el hastial. */
export interface WallFinish {
  color: THREE.Color;
  surface: Surface;
}

/**
 * Techo sobre el rectángulo de muros L × S (u a lo largo, v a lo ancho, centrado en el origen del
 * marco `m`), con el alero arrancando en y = 0 de ese marco. Con `under` lleva la cara de abajo de
 * los faldones (se ve desde abajo: un pabellón abierto); si no, solo el cielo del alero. Con `hole`
 * es un tronco: los faldones llegan hasta el rectángulo metido `hole` m desde los muros (el techo
 * de abajo de uno escalonado). Los hastiales de uno a dos aguas llevan el acabado de los muros
 * (`walls`). Devuelve cuánto sube sobre y = 0.
 */
export function roof(b: Batch, m: THREE.Matrix4, L: number, S: number, r: RoofStyle, walls: WallFinish, under: boolean, hole = 0): number {
  // Siempre a lo largo del lado más largo.
  if (S > L) return roof(b, m.clone().multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), S, L, r, walls, under, hole);
  const t = Math.tan(THREE.MathUtils.degToRad(r.pitch));
  const sin = Math.sin(Math.atan(t));
  const o = r.overhang;
  const lu = L / 2 + o;
  const lv = S / 2 + o;
  const yE = -o * t;
  const hip = r.kind === 'hip';
  const P = (u: number, v: number, y: number): THREE.Vector3 => new THREE.Vector3(u, y, v).applyMatrix4(m);
  const tile = new THREE.Color(r.color);
  const soffit = new THREE.Color(r.soffit);
  const tiles: Surface = { pattern: patternOf(r.pattern), scale: r.scale, ao: r.ao };
  const below: Surface = { ao: r.soffitAo };
  // Cada faldón con su cara de arriba (teja, uv: a lo largo del alero y bajando) y, con `under`, la de abajo.
  const slab = (p: THREE.Vector3[], uv: number[]): void => {
    facing(b, true, p, tile, tiles, uv);
    if (under) facing(b, false, p, soffit, below);
  };
  const tri = (p: THREE.Vector3[], uv: number[]): void => {
    facingTri(b, true, p, tile, tiles, uv);
    if (under) facingTri(b, false, p, soffit, below, uv);
  };
  if (hole > 0) {
    const iu = L / 2 - hole;
    const iv = S / 2 - hole;
    const yH = hole * t;
    const down = (yH - yE) / sin;
    for (const s of [1, -1]) {
      slab([P(-lu, s * lv, yE), P(lu, s * lv, yE), P(iu, s * iv, yH), P(-iu, s * iv, yH)], [-lu, down, lu, down, iu, 0, -iu, 0]);
      slab([P(s * lu, -lv, yE), P(s * lu, lv, yE), P(s * iu, iv, yH), P(s * iu, -iv, yH)], [-lv, down, lv, down, iv, 0, -iv, 0]);
    }
    if (!under) soffitRing(b, P, L, S, lu, lv, yE, soffit, below);
    return yH;
  }
  const hr = hip ? Math.max(0, L / 2 - S / 2) : lu;
  const yR = (S / 2) * t;
  const down = (yR - yE) / sin;
  for (const s of [1, -1]) slab([P(-lu, s * lv, yE), P(lu, s * lv, yE), P(hr, 0, yR), P(-hr, 0, yR)], [-lu, down, lu, down, hr, 0, -hr, 0]);
  if (hip) {
    for (const s of [1, -1]) tri([P(s * lu, -lv, yE), P(s * lu, lv, yE), P(s * hr, 0, yR)], [-lv, down, lv, down, 0, 0]);
    if (!under) soffitRing(b, P, L, S, lu, lv, yE, soffit, below);
    return yR;
  }
  // A dos aguas: hastiales en las puntas y, sin `under`, el cielo bajo cada faldón.
  for (const s of [1, -1]) {
    const out = new THREE.Vector3(s, 0, 0).transformDirection(m);
    const g = [P(s * (L / 2), -S / 2, 0), P(s * (L / 2), S / 2, 0), P(s * (L / 2), 0, yR)];
    const n = new THREE.Vector3().subVectors(g[1], g[0]).cross(new THREE.Vector3().subVectors(g[2], g[0]));
    if (n.dot(out) >= 0) b.tri(g[0], g[1], g[2], walls.color, walls.surface, [-S / 2, 0, S / 2, 0, 0, yR]);
    else b.tri(g[1], g[0], g[2], walls.color, walls.surface, [S / 2, 0, -S / 2, 0, 0, yR]);
    if (!under) facing(b, false, [P(-lu, s * (S / 2), 0), P(lu, s * (S / 2), 0), P(lu, s * lv, yE), P(-lu, s * lv, yE)], soffit, below);
  }
  return yR;
}

/** El cielo del alero alrededor de los muros (del muro al borde del alero, mirando abajo). */
function soffitRing(b: Batch, P: (u: number, v: number, y: number) => THREE.Vector3, L: number, S: number, lu: number, lv: number, yE: number, color: THREE.Color, surface: Surface): void {
  const wall = [P(-L / 2, -S / 2, 0), P(L / 2, -S / 2, 0), P(L / 2, S / 2, 0), P(-L / 2, S / 2, 0)];
  const eave = [P(-lu, -lv, yE), P(lu, -lv, yE), P(lu, lv, yE), P(-lu, lv, yE)];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    facing(b, false, [wall[k], wall[j], eave[j], eave[k]], color, surface);
  }
}

/** Cuánto sube un techo de muros L × S (sin armarlo): para la física y el alumbrado. */
export function roofRise(L: number, S: number, r: RoofStyle): number {
  return (Math.min(L, S) / 2) * Math.tan(THREE.MathUtils.degToRad(r.pitch));
}

/**
 * Alto de la superficie de un techo de muros L × S (sobre y = 0, el alero en los muros) en el
 * punto (u, v) de su marco: la más baja de sus aguas (a cuatro aguas, también las de las puntas).
 */
export function roofAt(L: number, S: number, r: RoofStyle, u: number, v: number): number {
  const t = Math.tan(THREE.MathUtils.degToRad(r.pitch));
  // Como `roof`: la cumbrera a lo largo del lado más largo.
  const [a, c] = L >= S ? [u, v] : [v, u];
  const lu = Math.max(L, S) / 2 + r.overhang;
  const lv = Math.min(L, S) / 2 + r.overhang;
  const run = r.kind === 'hip' ? Math.min(lv - Math.abs(c), lu - Math.abs(a)) : lv - Math.abs(c);
  return (run - r.overhang) * t;
}

/**
 * La física de un techo inclinado sobre postes (marco `f`, muros L × S, el alero en los muros a la
 * altura `eave` del mundo): rectángulos anidados que se achican `step` m por lado hacia adentro,
 * cada uno a la altura de las aguas en la mitad de su franja. Se pisa por sus aguas (el más alto
 * que contiene el punto manda) y se camina por debajo desde `bottom`. Con `hole`, un tronco: llega
 * hasta el rectángulo metido `hole` m desde los muros.
 */
function roofBoxes(site: PlaceSite, f: Frame, L: number, S: number, r: RoofStyle, eave: number, bottom: number, step: number, hole: number): void {
  const t = Math.tan(THREE.MathUtils.degToRad(r.pitch));
  // Un tronco baja por sus cuatro lados, como en `roof`.
  const hip = r.kind === 'hip' || hole > 0;
  const long = L >= S;
  const lu = Math.max(L, S) / 2 + r.overhang;
  const lv = Math.min(L, S) / 2 + r.overhang;
  // Hasta dónde llega hacia adentro (desde el borde del alero) y la altura más alta.
  const reach = hole > 0 ? r.overhang + hole : lv;
  const peak = eave + (reach - r.overhang) * t;
  for (let d = 0; d < reach - 1e-6; d += step) {
    const hv = lv - d;
    const hu = hip ? lu - d : lu;
    if (hv <= 0 || hu <= 0) break;
    const top = Math.min(peak, eave + (d + Math.min(step, reach - d) / 2 - r.overhang) * t);
    site.box(f.x, f.z, long ? hu : hv, long ? hv : hu, f.angle, top, true, bottom);
  }
}

/** El techo inclinado de un macizo para la física (se camina por sus aguas). */
export function localRoof(f: Frame, L: number, S: number, r: RoofStyle, eave: number): LocalRoof {
  const t = Math.tan(THREE.MathUtils.degToRad(r.pitch));
  const along = L >= S ? f.angle : f.angle + Math.PI / 2;
  return {
    hip: r.kind === 'hip',
    x: f.x,
    z: f.z,
    angle: along,
    halfWidth: Math.min(L, S) / 2 + r.overhang,
    halfLength: Math.max(L, S) / 2 + r.overhang,
    slope: t,
    edge: eave - r.overhang * t,
  };
}

// ---------------------------------------------------------------------------------------------
// Muros con vanos

/** Los lados de un rectángulo w × d centrado (u, v), cada uno con su normal hacia afuera a la derecha de a → b: 0 = frente (−v), 1 = +u, 2 = atrás (+v), 3 = −u. */
function sidesOf(w: number, d: number): { a: THREE.Vector2; b: THREE.Vector2 }[] {
  const V = (u: number, v: number): THREE.Vector2 => new THREE.Vector2(u, v);
  return [
    { a: V(w / 2, -d / 2), b: V(-w / 2, -d / 2) },
    { a: V(w / 2, d / 2), b: V(w / 2, -d / 2) },
    { a: V(-w / 2, d / 2), b: V(w / 2, d / 2) },
    { a: V(-w / 2, -d / 2), b: V(-w / 2, d / 2) },
  ];
}

/** Un vano en una cara: de x0 a x1 (desde el comienzo del lado) y de y0 a y1 (mundo), ventana o puerta, encendida o no. */
interface Hole {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  door: boolean;
  lit: boolean;
}

/**
 * Cómo son los vanos de un muro: fondo del vano, carpintería (tono respecto del vidrio, hojas a lo
 * ancho y a lo alto), colores del marco, del vidrio y de la puerta, su luz de noche, qué parte de
 * las ventanas se enciende y la oclusión del fondo del vano.
 */
export interface Glazing {
  reveal: number;
  tone: number;
  panes: number[];
  frame: string;
  glass: string;
  door: string;
  glow: Glow;
  lit: number;
  ao: number;
}

/** Un vano de un muro: en qué lado (0 = frente, 1 = derecha, 2 = atrás, 3 = izquierda), centrado a `at` m del medio del lado, su alto de antepecho y su tamaño; 'window' o 'door'. */
export interface Opening {
  side: number;
  at: number;
  sill: number;
  size: number[];
  kind: string;
}

/**
 * Una cara de muro vertical de a a b (marco `m`; hacia afuera a la derecha de a → b), de y0 a y1,
 * con sus vanos: el muro alrededor, el fondo de cada vano (antepecho, dintel y jambas) y el vidrio
 * (o la puerta) al fondo.
 */
function punched(pk: PartsKit, m: THREE.Matrix4, a: THREE.Vector2, b: THREE.Vector2, y0: number, y1: number, holes: readonly Hole[], color: THREE.Color, surface: Surface, G: Glazing): void {
  const len = a.distanceTo(b);
  if (len < 1e-3) return;
  const dir = b.clone().sub(a).divideScalar(len);
  const n = new THREE.Vector2(-dir.y, dir.x);
  const P = (x: number, y: number, depth = 0): THREE.Vector3 => {
    const q = a.clone().addScaledVector(dir, x).addScaledVector(n, -depth);
    return new THREE.Vector3(q.x, y, q.y).applyMatrix4(m);
  };
  // Muro: franjas horizontales entre los bordes de los vanos, y en cada una lo que no es vano.
  const ys = [...new Set([y0, y1, ...holes.flatMap((h) => [h.y0, h.y1])])].filter((y) => y >= y0 && y <= y1).sort((p, q) => p - q);
  for (let k = 0; k + 1 < ys.length; k++) {
    const ya = ys[k];
    const yb = ys[k + 1];
    if (yb - ya < 1e-4) continue;
    const cover = holes.filter((h) => h.y0 <= ya + 1e-4 && h.y1 >= yb - 1e-4).sort((p, q) => p.x0 - q.x0);
    let x = 0;
    for (const h of [...cover, { x0: len, x1: len }]) {
      if (h.x0 - x > 1e-3) pk.stone.quad(P(x, ya), P(h.x0, ya), P(h.x0, yb), P(x, yb), color, surface, [x, ya, h.x0, ya, h.x0, yb, x, yb]);
      x = Math.max(x, h.x1);
    }
  }
  const reveal: Surface = { ao: G.ao };
  const out3 = new THREE.Vector3(n.x, 0, n.y).transformDirection(m);
  const along3 = new THREE.Vector3(dir.x, 0, dir.y).transformDirection(m);
  const r = G.reveal;
  const frame = new THREE.Color(G.frame);
  for (const h of holes) {
    // Fondo del vano: antepecho (mira arriba), dintel (mira abajo) y jambas (miran al vano).
    facing(pk.stone, true, [P(h.x0, h.y0), P(h.x1, h.y0), P(h.x1, h.y0, r), P(h.x0, h.y0, r)], frame, reveal);
    facing(pk.stone, false, [P(h.x0, h.y1), P(h.x1, h.y1), P(h.x1, h.y1, r), P(h.x0, h.y1, r)], frame, reveal);
    toward(pk.stone, along3, [P(h.x0, h.y0), P(h.x0, h.y0, r), P(h.x0, h.y1, r), P(h.x0, h.y1)], frame, reveal);
    toward(pk.stone, along3.clone().negate(), [P(h.x1, h.y0), P(h.x1, h.y0, r), P(h.x1, h.y1, r), P(h.x1, h.y1)], frame, reveal);
    const pane = [P(h.x0, h.y0, r), P(h.x1, h.y0, r), P(h.x1, h.y1, r), P(h.x0, h.y1, r)];
    const glaze: Surface = { pattern: PATTERN.glazing, tone: G.tone, glow: h.lit ? glowOf(G.glow) : undefined };
    if (h.door) toward(pk.stone, out3, pane, new THREE.Color(G.door), { pattern: PATTERN.glazing, tone: G.tone }, [0, 0, G.panes[0], 0, G.panes[0], G.panes[1], 0, G.panes[1]]);
    else toward(pk.glass, out3, pane, new THREE.Color(G.glass), glaze, [0, 0, G.panes[0], 0, G.panes[0], G.panes[1], 0, G.panes[1]]);
  }
}

/** Los vanos de un lado de un rectángulo w × d, a partir de los `Opening` (alturas desde `floor` de cada nivel). */
function holesOf(openings: readonly Opening[], side: number, len: number, floorOf: (o: Opening) => number, lit: (k: number) => boolean): Hole[] {
  return openings
    .filter((o) => o.side === side)
    .map((o, k) => {
      const [w, h] = o.size;
      const y0 = floorOf(o) + o.sill;
      return { x0: len / 2 + o.at - w / 2, x1: len / 2 + o.at + w / 2, y0, y1: y0 + h, door: o.kind === 'door', lit: o.kind !== 'door' && lit(k) };
    });
}

// ---------------------------------------------------------------------------------------------
// Pabellones: un techo sobre postes (aleros de garita, casas club abiertas, glorietas, quioscos)

/**
 * Un pabellón: techo inclinado (de uno o más niveles) sobre postes, con su viga, el piso de abajo
 * y, si tiene, un cuarto cerrado bajo el mismo techo. Se camina por debajo.
 */
export interface PavilionStyle {
  /** Alto libre: del piso a la cara de abajo de la viga. */
  clear: number;
  /** Viga perimetral sobre los postes: alto, ancho y color. */
  beam: { height: number; width: number; color: string };
  /** Postes: ancho y fondo, separación máxima a lo largo de cada lado, cuánto se meten desde la línea del techo sin alero, color, dibujo y su escala. */
  posts: { size: number[]; spacing: number; inset: number; color: string; pattern: string; scale: number[] };
  roof: RoofStyle;
  /** Techos escalonados (de abajo arriba): cuánto se mete cada uno desde los muros del anterior, cuánto más arriba arranca, y el color de la franja vertical que los une. */
  tiers: { inset: number; rise: number; color: string }[];
  /** Piso bajo el techo: cuánto sobre el terreno, color, dibujo y escala (sin él, el piso de la zona). */
  floor?: { lift: number; color: string; pattern: string; scale: number[] };
  /**
   * Cuarto cerrado bajo el techo: rectángulo (u0, v0, u1, v1) desde el centro, muros (color,
   * dibujo, escala, oclusión), sus vanos y cómo son.
   */
  room?: { rect: number[]; color: string; pattern: string; scale: number[]; ao: number; openings: Opening[]; glazing: Glazing };
  /**
   * Plafón en el centro, contra la cara de abajo de las aguas: tamaño (ancho, fondo), cuánto queda
   * bajo el techo (m, para no pisarse con él), su luz propia y su luz para el alumbrado (potencia;
   * LED o sodio).
   */
  light?: { size: number[]; gap: number; glow: Glow; power: number; led: boolean };
}

/** Un pabellón en su zona: centro (u, v), largo y ancho del techo (el contorno del satélite, con su alero), giro (grados), estilo y retoques, y fuente. */
export interface PavilionPlace {
  id: string;
  at: number[];
  size: number[];
  angle: number;
  style: string;
  set?: Record<string, unknown>;
  source: string;
}

/** Postes repartidos parejos por el contorno de un rectángulo w × d (centrado), con uno en cada esquina. */
function perimeterPosts(w: number, d: number, spacing: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const { a, b } of sidesOf(w, d)) {
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k < n; k++) out.push(a.clone().lerp(b, k / n));
  }
  return out;
}

/**
 * Cuánto sobre el piso de un pabellón va su plafón (null si no tiene): en el centro, contra la cara
 * de abajo de las aguas del techo de arriba, con sus esquinas a `gap` del techo.
 */
function pavilionLamp(p: PavilionPlace, S: PavilionStyle): number | null {
  const lt = S.light;
  if (!lt) return null;
  const o = S.roof.overhang;
  let L = p.size[0] - 2 * o;
  let Sd = p.size[1] - 2 * o;
  let rise = 0;
  for (const t of S.tiers) {
    L -= 2 * t.inset;
    Sd -= 2 * t.inset;
    rise += t.rise;
  }
  const [lw, ld] = lt.size;
  const under = Math.min(...[-1, 1].flatMap((a) => [-1, 1].map((b) => roofAt(L, Sd, S.roof, (a * lw) / 2, (b * ld) / 2))));
  return S.clear + S.beam.height + rise + under - lt.gap;
}

/** Arma un pabellón en el marco de su zona. */
export function buildPavilion(p: PavilionPlace, S: PavilionStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(p.at, p.angle, zone);
  const ground = baseOf(f, p.size[0], p.size[1], pk.terrain);
  onGround(pk, ground.base, () => pavilion(p, S, f, pk, ground));
}

/** El pabellón, con su suelo (la mediana del terreno bajo su techo) y el más bajo (donde se entierran los postes). */
function pavilion(p: PavilionPlace, S: PavilionStyle, f: Frame, pk: PartsKit, { base, low }: { base: number; low: number }): void {
  const m = f.matrix();
  const [W, D] = p.size;
  const o = S.roof.overhang;
  const w = W - 2 * o;
  const d = D - 2 * o;
  const floor = base + (S.floor?.lift ?? 0);
  const eave = floor + S.clear + S.beam.height;
  const P = (u: number, y: number, v: number): THREE.Vector3 => new THREE.Vector3(u, y, v).applyMatrix4(m);
  const at = (u: number, y: number, v: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, y, v));
  if (S.floor) {
    const ring = f.ring([
      [-W / 2, -D / 2],
      [W / 2, -D / 2],
      [W / 2, D / 2],
      [-W / 2, D / 2],
    ]);
    paveFit(pk.stone, ring, [], (x, z) => pk.terrain(x, z) + S.floor!.lift, pk.ground, new THREE.Color(S.floor.color), { pattern: patternOf(S.floor.pattern), scale: S.floor.scale });
    pk.site.ground(
      ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      S.floor.lift,
    );
  }
  // Postes, del pie enterrado a la viga, con su física.
  const [pw, pd] = S.posts.size;
  const postColor = new THREE.Color(S.posts.color);
  const postSurface: Surface = { pattern: patternOf(S.posts.pattern), scale: S.posts.scale };
  const bottom = low - pk.ground.bury;
  for (const q of perimeterPosts(w - 2 * S.posts.inset, d - 2 * S.posts.inset, S.posts.spacing)) {
    const h = floor + S.clear - bottom;
    pk.stone.box(at(q.x, bottom + h / 2, q.y), pw, h, pd, postColor, postSurface);
    const c = f.point(q.x, q.y);
    pk.site.box(c.x, c.z, pw / 2, pd / 2, f.angle, floor + S.clear, false, -Infinity);
  }
  // Viga perimetral sobre los postes.
  const beamColor = new THREE.Color(S.beam.color);
  const bw = w - 2 * S.posts.inset;
  const bd = d - 2 * S.posts.inset;
  const yb = floor + S.clear + S.beam.height / 2;
  pk.stone.box(at(0, yb, -bd / 2), bw + S.beam.width, S.beam.height, S.beam.width, beamColor);
  pk.stone.box(at(0, yb, bd / 2), bw + S.beam.width, S.beam.height, S.beam.width, beamColor);
  pk.stone.box(at(-bw / 2, yb, 0), S.beam.width, S.beam.height, bd - S.beam.width, beamColor);
  pk.stone.box(at(bw / 2, yb, 0), S.beam.width, S.beam.height, bd - S.beam.width, beamColor);
  // Techos: el de abajo (tronco si hay otro encima) y los escalonados con su franja; los hastiales
  // (si es a dos aguas) con el acabado del cuarto, o el de la viga si es abierto. Su física, por
  // sus aguas, se camina por debajo.
  const R = S.room;
  const walls: WallFinish = R ? { color: new THREE.Color(R.color), surface: { pattern: patternOf(R.pattern), scale: R.scale, ao: R.ao } } : { color: beamColor, surface: {} };
  const under = floor + S.clear;
  let L = w;
  let Sd = d;
  let y = eave;
  for (let k = 0; k <= S.tiers.length; k++) {
    const next = S.tiers[k];
    const hole = next ? next.inset : 0;
    const rise = roof(pk.stone, at(0, y, 0), L, Sd, S.roof, walls, true, hole);
    roofBoxes(pk.site, f, L, Sd, S.roof, y, under, pk.ground.roofStep, hole);
    if (!next) break;
    // La franja vertical entre este techo y el de arriba, sobre el rectángulo metido.
    const iw = L - 2 * next.inset;
    const id = Sd - 2 * next.inset;
    const y0 = y + rise;
    const y1 = y + next.rise;
    const band = new THREE.Color(next.color);
    for (const side of sidesOf(iw, id)) {
      const A = P(side.a.x, y0, side.a.y);
      const B = P(side.b.x, y0, side.b.y);
      pk.stone.quad(A, B, B.clone().setY(y1), A.clone().setY(y1), band, { ao: S.roof.soffitAo });
    }
    L = iw;
    Sd = id;
    y = y1;
  }
  // Cuarto cerrado bajo el techo.
  if (R) {
    const [u0, v0, u1, v1] = R.rect;
    const rw = u1 - u0;
    const rd = v1 - v0;
    const rm = m.clone().multiply(new THREE.Matrix4().makeTranslation((u0 + u1) / 2, 0, (v0 + v1) / 2));
    const seed = seedOf(p.id);
    sidesOf(rw, rd).forEach((side, k) => {
      const len = side.a.distanceTo(side.b);
      const holes = holesOf(R.openings, k, len, () => floor, (j) => rand(seed + k * 7 + j, 3) < R.glazing.lit);
      punched(pk, rm, side.a, side.b, bottom, eave, holes, walls.color, walls.surface, R.glazing);
    });
    const rf = Frame.of([(u0 + u1) / 2, (v0 + v1) / 2], 0, f);
    pk.site.block(
      rf.ring(sidesOf(rw, rd).map((s) => [s.a.x, s.a.y])).map(([x, z]) => new THREE.Vector3(x, 0, z)),
      bottom,
      eave,
    );
  }
  // Plafón con su luz, contra la cara de abajo del techo en el centro.
  const lamp = pavilionLamp(p, S);
  if (S.light && lamp !== null) {
    const [lw, ld] = S.light.size;
    const yl = floor + lamp;
    facing(pk.stone, false, [P(-lw / 2, yl, -ld / 2), P(lw / 2, yl, -ld / 2), P(lw / 2, yl, ld / 2), P(-lw / 2, yl, ld / 2)], WHITE, { glow: glowOf(S.light.glow) });
  }
}

/** La luz de un pabellón para el alumbrado (si tiene plafón). */
export function pavilionLight(p: PavilionPlace, S: PavilionStyle, zone: Frame): PlaceLight | null {
  const lamp = pavilionLamp(p, S);
  if (!S.light || lamp === null) return null;
  const f = Frame.of(p.at, p.angle, zone);
  return { x: f.x, z: f.z, lift: S.floor?.lift ?? 0, h: lamp, out: f.angle, power: S.light.power, led: S.light.led };
}

// ---------------------------------------------------------------------------------------------
// Casetas y torres (la torre de una garita, una torre de vigilancia)

/** Una caseta de uno o más niveles con sus vanos y su techo, sobre el suelo o sobre un fuste. */
export interface TowerStyle {
  /** Fuste bajo la caseta (torre de vigilancia): alto, ancho y fondo, color, dibujo y escala. Sin él, la caseta arranca del suelo. */
  shaft?: { height: number; size: number[]; color: string; pattern: string; scale: number[] };
  /** Alto de cada nivel, de abajo arriba. */
  levels: number[];
  /** Muros: color, dibujo, escala y oclusión. */
  walls: { color: string; pattern: string; scale: number[]; ao: number };
  /** Moldura entre niveles y zócalo: alto, vuelo y color. */
  trim?: { height: number; out: number; color: string };
  plinth?: { height: number; out: number; color: string };
  /** Vanos: cada uno en un nivel (desde 0 abajo). */
  openings: (Opening & { level: number })[];
  glazing: Glazing;
  /** Cuadros de color bajo el alero, en cada lado: cuántos (repartidos parejos), ancho y alto, a cuánto bajo el alero, vuelo y color. */
  tiles?: { count: number; size: number[]; below: number; out: number; color: string };
  roof: RoofStyle;
  /** Reflector en la cumbrera: tamaño (ancho, alto, fondo), color, luz propia y su luz para el alumbrado (potencia; LED o sodio). */
  lamp?: { size: number[]; color: string; glow: Glow; power: number; led: boolean };
}

/** Una caseta en su zona: centro (u, v), ancho y fondo de sus muros, giro (grados), estilo, retoques y fuente. */
export interface TowerPlace {
  id: string;
  at: number[];
  size: number[];
  angle: number;
  style: string;
  set?: Record<string, unknown>;
  source: string;
}

/** Arma una caseta o una torre en el marco de su zona. */
export function buildTower(p: TowerPlace, S: TowerStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(p.at, p.angle, zone);
  const ground = baseOf(f, p.size[0], p.size[1], pk.terrain);
  onGround(pk, ground.base, () => tower(p, S, f, pk, ground));
}

/** La caseta, con su suelo (la mediana del terreno bajo ella) y el más bajo (donde se entierran sus muros). */
function tower(p: TowerPlace, S: TowerStyle, f: Frame, pk: PartsKit, { base, low }: { base: number; low: number }): void {
  const m = f.matrix();
  const [w, d] = p.size;
  const bottom = low - pk.ground.bury;
  const at = (u: number, y: number, v: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, y, v));
  const sh = S.shaft;
  if (sh) {
    const h = base + sh.height - bottom;
    pk.stone.box(at(0, bottom + h / 2, 0), sh.size[0], h, sh.size[1], new THREE.Color(sh.color), { pattern: patternOf(sh.pattern), scale: sh.scale });
  }
  const y0 = base + (sh ? sh.height : 0);
  const floors = S.levels.reduce<number[]>((acc, h) => [...acc, acc[acc.length - 1] + h], [y0]);
  const top = floors[floors.length - 1];
  const wallColor = new THREE.Color(S.walls.color);
  const wallSurface: Surface = { pattern: patternOf(S.walls.pattern), scale: S.walls.scale, ao: S.walls.ao };
  const seed = seedOf(p.id);
  sidesOf(w, d).forEach((side, k) => {
    const len = side.a.distanceTo(side.b);
    const openings = S.openings.filter((o) => o.level < S.levels.length);
    const holes = holesOf(openings, k, len, (o) => floors[(o as Opening & { level: number }).level], (j) => rand(seed + k * 7 + j, 5) < S.glazing.lit);
    punched(pk, m, side.a, side.b, sh ? y0 : bottom, top, holes, wallColor, wallSurface, S.glazing);
  });
  // Molduras entre niveles y zócalo: un marco de cajas alrededor.
  const ring = (y: number, h: number, out: number, color: THREE.Color): void => {
    pk.stone.box(at(0, y + h / 2, -d / 2 - out / 2), w + 2 * out, h, out, color);
    pk.stone.box(at(0, y + h / 2, d / 2 + out / 2), w + 2 * out, h, out, color);
    pk.stone.box(at(-w / 2 - out / 2, y + h / 2, 0), out, h, d, color);
    pk.stone.box(at(w / 2 + out / 2, y + h / 2, 0), out, h, d, color);
  };
  if (S.trim) for (const y of floors.slice(1, -1)) ring(y - S.trim.height / 2, S.trim.height, S.trim.out, new THREE.Color(S.trim.color));
  if (S.plinth) ring(y0, S.plinth.height, S.plinth.out, new THREE.Color(S.plinth.color));
  // Cuadros bajo el alero.
  const T = S.tiles;
  if (T) {
    const color = new THREE.Color(T.color);
    const [tw, th] = T.size;
    const yt = top - T.below - th / 2;
    sidesOf(w, d).forEach((side) => {
      const len = side.a.distanceTo(side.b);
      const dir = side.b.clone().sub(side.a).divideScalar(len);
      const n = new THREE.Vector2(-dir.y, dir.x);
      for (let k = 0; k < T.count; k++) {
        const c = side.a.clone().addScaledVector(dir, (len * (k + 0.5)) / T.count).addScaledVector(n, T.out / 2);
        const mm = at(c.x, yt, c.y).multiply(new THREE.Matrix4().makeRotationY(-Math.atan2(dir.y, dir.x)));
        pk.stone.box(mm, tw, th, T.out, color);
      }
    });
  }
  const rise = roof(pk.stone, at(0, top, 0), w, d, S.roof, { color: wallColor, surface: wallSurface }, false);
  const L = S.lamp;
  if (L) {
    const [lw, lh, ld] = L.size;
    pk.stone.box(at(0, top + rise + lh / 2, 0), lw, lh, ld, new THREE.Color(L.color), { glow: glowOf(L.glow) });
  }
  // Física: el macizo hasta la cumbrera, con su techo (la de un fuste llega hasta el techo de la caseta).
  const outline = f.ring(sidesOf(w, d).map((s) => [s.a.x, s.a.y])).map(([x, z]) => new THREE.Vector3(x, 0, z));
  pk.site.block(outline, bottom, top + rise, localRoof(f, w, d, S.roof, top));
}

/** La luz del reflector de una caseta para el alumbrado (si tiene). */
export function towerLight(p: TowerPlace, S: TowerStyle, zone: Frame): PlaceLight | null {
  if (!S.lamp) return null;
  const f = Frame.of(p.at, p.angle, zone);
  const [w, d] = p.size;
  const h = (S.shaft?.height ?? 0) + S.levels.reduce((a, b) => a + b, 0) + roofRise(w, d, S.roof);
  return { x: f.x, z: f.z, lift: 0, h, out: f.angle, power: S.lamp.power, led: S.lamp.led };
}

// ---------------------------------------------------------------------------------------------
// Portones, plumas, reductores, bolardos

/** Portón corredizo de barrotes: alto, luz bajo él, dibujo calado y su escala, color, y el marco (perfil cuadrado: lado y color). */
export interface GateStyle {
  height: number;
  lift: number;
  pattern: string;
  scale: number[];
  color: string;
  frame: { size: number; color: string };
}

/** Un portón en su zona: centro de la hoja cerrada (u, v), largo, giro (grados), cuánto está corrido a lo largo de su eje (abierto), estilo y fuente. */
export interface GatePlace {
  id: string;
  at: number[];
  width: number;
  angle: number;
  open: number;
  style: string;
  source: string;
}

/** Arma un portón (donde quedó corrido) con su física. */
export function buildGate(g: GatePlace, S: GateStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of([g.at[0], g.at[1]], g.angle, zone);
  const c = Frame.of([g.open, 0], 0, f);
  const m = c.matrix();
  const base = pk.terrain(c.x, c.z);
  const W = g.width;
  const s = S.frame.size;
  const frame = new THREE.Color(S.frame.color);
  const at = (u: number, y: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, y, 0));
  const y0 = base + S.lift;
  const y1 = base + S.height;
  pk.stone.box(at(0, y0 + s / 2), W, s, s, frame);
  pk.stone.box(at(0, y1 - s / 2), W, s, s, frame);
  for (const e of [-1, 1]) pk.stone.box(at((e * (W - s)) / 2, (y0 + y1) / 2), s, y1 - y0, s, frame);
  const P = (u: number, y: number): THREE.Vector3 => new THREE.Vector3(u, y, 0).applyMatrix4(m);
  const h = y1 - y0 - 2 * s;
  pk.rails.quad(P(-W / 2 + s, y0 + s), P(W / 2 - s, y0 + s), P(W / 2 - s, y1 - s), P(-W / 2 + s, y1 - s), new THREE.Color(S.color), { pattern: patternOf(S.pattern), scale: S.scale }, [0, 0, W - 2 * s, 0, W - 2 * s, h, 0, h]);
  pk.site.box(c.x, c.z, W / 2, s / 2, c.angle, y1, false, -Infinity);
}

/** Pluma de una garita: el pedestal (ancho, fondo, alto; color) y el brazo (largo, alto y fondo, cuánto está levantado en grados, franjas de colores y su largo). */
export interface BarrierStyle {
  pedestal: { size: number[]; color: string };
  boom: { length: number; size: number[]; raised: number; colors: string[]; stripe: number };
}

/** Una pluma en su zona: el pedestal (u, v), hacia dónde sale el brazo bajado (grados), estilo y fuente. */
export interface BarrierPlace {
  id: string;
  at: number[];
  angle: number;
  style: string;
  source: string;
}

/**
 * Arma una pluma levantada. El brazo no tiene física (el tránsito de los datos no la ve y pasa
 * igual): solo el pedestal ataja.
 */
export function buildBarrier(bp: BarrierPlace, S: BarrierStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(bp.at, bp.angle, zone);
  const m = f.matrix();
  const base = pk.terrain(f.x, f.z);
  const [pw, pd, ph] = S.pedestal.size;
  pk.detail.box(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, base + ph / 2, 0)), pw, ph, pd, new THREE.Color(S.pedestal.color));
  pk.site.box(f.x, f.z, pw / 2, pd / 2, f.angle, base + ph, false, -Infinity);
  const B = S.boom;
  const [bh, bd] = B.size;
  const colors = B.colors.map((c) => new THREE.Color(c));
  const n = Math.max(1, Math.round(B.length / B.stripe));
  const tilt = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(B.raised));
  const pivot = m.clone().multiply(new THREE.Matrix4().makeTranslation(0, base + ph, 0)).multiply(tilt);
  for (let k = 0; k < n; k++) {
    const l = B.length / n;
    pk.detail.box(pivot.clone().multiply(new THREE.Matrix4().makeTranslation(l * (k + 0.5), 0, 0)), l, bh, bd, colors[k % colors.length]);
  }
}

/** Franjas en el piso: reductor de velocidad (con alto) o cebra (pintura: alto 0). Fondo (a lo largo del tránsito), alto, largo de cada franja y el hueco entre ellas (0 = seguidas, alternando colores), colores y cuánto sobre el piso de la zona (el adoquín, la isla) o, si no hay, sobre el terreno. */
export interface StripeStyle {
  width: number;
  height: number;
  stripe: number;
  gap: number;
  colors: string[];
  lift: number;
}

/** Unas franjas en su zona: centro (u, v), giro de su eje a lo ancho de la calle (grados), largo total, estilo y fuente. */
export interface StripePlace {
  id: string;
  at: number[];
  angle: number;
  length: number;
  style: string;
  source: string;
}

/** Arma un reductor o una cebra (lo chico, solo de cerca), sobre el piso de la zona donde cae cada franja. */
export function buildStripes(sp: StripePlace, S: StripeStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(sp.at, sp.angle, zone);
  const m = f.matrix();
  const colors = S.colors.map((c) => new THREE.Color(c));
  const pitch = S.stripe + S.gap;
  const n = Math.max(1, Math.floor((sp.length + S.gap) / pitch));
  const u0 = -(n * pitch - S.gap) / 2;
  for (let k = 0; k < n; k++) {
    const a = u0 + k * pitch;
    const b = a + S.stripe;
    const c = colors[k % colors.length];
    const pa = f.point((a + b) / 2, 0);
    const y = pk.terrain(pa.x, pa.z) + pk.floorAt(pa.x, pa.z) + S.lift;
    const P = (u: number, h: number, v: number): THREE.Vector3 => new THREE.Vector3(u, y + h, v).applyMatrix4(m);
    const w = S.width / 2;
    facing(pk.detail, true, [P(a, S.height, -w), P(b, S.height, -w), P(b, S.height, w), P(a, S.height, w)], c, {});
    if (S.height > 0) {
      for (const s of [-1, 1]) {
        const out = new THREE.Vector3(0, 0, s).transformDirection(m);
        toward(pk.detail, out, [P(a, 0, s * w), P(b, 0, s * w), P(b, S.height, s * w), P(a, S.height, s * w)], c, {});
      }
    }
  }
}

/** Bolardo: radio, alto, alto de cada franja, colores que se alternan. */
export interface BollardStyle {
  radius: number;
  height: number;
  band: number;
  colors: string[];
}

/** Bolardos en su zona: dónde (u, v), estilo y fuente. */
export interface BollardPlace {
  at: number[][];
  style: string;
  source: string;
}

/** Arma unos bolardos (solo de cerca) con su física. */
export function buildBollards(bp: BollardPlace, S: BollardStyle, zone: Frame, pk: PartsKit): void {
  const colors = S.colors.map((c) => new THREE.Color(c));
  const n = Math.max(1, Math.round(S.height / S.band));
  const band = S.height / n;
  for (const [u, v] of bp.at) {
    const p = zone.point(u, v);
    const y = pk.terrain(p.x, p.z);
    for (let k = 0; k < n; k++) {
      const g = new THREE.CylinderGeometry(S.radius, S.radius, band, pk.sides, 1, k < n - 1);
      pk.detail.geometry(g, new THREE.Matrix4().makeTranslation(p.x, y + band * (k + 0.5), p.z), colors[k % colors.length]);
      g.dispose();
    }
    pk.site.circle(p.x, p.z, S.radius, y + S.height, false, -Infinity);
  }
}

// ---------------------------------------------------------------------------------------------
// Letreros de panel (monolitos, letreros reglamentarios)

/** Un texto de un panel: su cara del atlas de letreros y dónde va su centro en la cara (u desde el medio, y desde el pie del panel). */
export interface SignText {
  text: string;
  at: number[];
  size: number[];
  color: string;
  background: string;
  font?: string;
  weight?: number;
  italic?: boolean;
  fill?: number;
}

/**
 * Una figura pintada en la cara: un octágono de pare, un círculo de prohibido o el chevrón de una
 * curva. Forma ('circle', 'octagon', 'chevronLeft' o 'chevronRight': hacia dónde apunta, visto de
 * frente), centro (u, y), radio (en el chevrón, medio alto), color, su aro (ancho y color; ancho 0 =
 * sin aro) y, en el chevrón, el grosor de su trazo (m, a lo ancho).
 */
export interface SignMark {
  shape: string;
  at: number[];
  radius: number;
  color: string;
  ring: { width: number; color: string };
  stroke?: number;
}

/** Las formas de SignMark. */
const MARKS = ['circle', 'octagon', 'chevronLeft', 'chevronRight'];

/** Revisa las figuras de un letrero (una forma que no existe, un chevrón sin trazo). */
export function checkMarks(marks: readonly SignMark[], where: string): void {
  for (const mk of marks) {
    if (!MARKS.includes(mk.shape)) throw new Error(`${where}: la figura "${mk.shape}" no existe (${MARKS.join(', ')})`);
    if (mk.shape.startsWith('chevron') && !((mk.stroke ?? 0) > 0)) throw new Error(`${where}: el chevrón necesita "stroke" mayor que 0`);
  }
}

/**
 * Un letrero de panel: el panel (ancho, alto, fondo) a `lift` sobre el suelo, del color de su canto;
 * la cara clara metida desde cada borde del panel (izquierda, derecha, abajo, arriba) y franjas de
 * color sobre ella (rectángulos u0, y0, u1, y1 desde la esquina de abajo a la izquierda del panel);
 * un plinto abajo (ancho, alto, fondo; color, dibujo y escala) o postes (ancho, color y su u);
 * si la cara de atrás repite las letras; su luz propia (sin ella, no se enciende) y reflectores de
 * piso delante (cuántos, a qué distancia de la cara, tamaño, color, su luz propia y cuánto bañan de
 * noche el letrero: `flood`, de 0 a 1, como el de los monumentos). Los reflectores no van al
 * alumbrado de la ciudad: ese solo sabe de luminarias altas que alumbran el suelo.
 */
export interface SignPanelStyle {
  size: number[];
  depth: number;
  lift: number;
  color: string;
  face: { color: string; inset: number[] };
  bands: { rect: number[]; color: string }[];
  plinth?: { size: number[]; color: string; pattern: string; scale: number[] };
  posts?: { width: number; color: string; at: number[] };
  back: boolean;
  glow?: Glow;
  floodlights?: { count: number; distance: number; size: number[]; color: string; glow: Glow; flood: number };
}

/** Un letrero en su zona: dónde (u, v), su giro (grados; la cara mira hacia −v de su marco, como el frente de una caseta), estilo y retoques, textos, figuras y fuente. */
export interface SignPanelPlace {
  id: string;
  at: number[];
  angle: number;
  style: string;
  set?: Record<string, unknown>;
  texts: SignText[];
  marks?: SignMark[];
  source: string;
}

/** La cara del atlas de un texto de un panel (letras sueltas sobre la cara: su fondo no se enciende). */
export function signFace(t: SignText): SignFace {
  return { text: t.text, size: t.size, background: t.background, color: t.color, font: t.font, weight: t.weight, italic: t.italic, fill: t.fill, depth: 0 };
}

/**
 * Arma un letrero de panel con su plinto o sus postes, sus textos, figuras y reflectores: con
 * reflectores, el panel y su plinto van bañados por ellos de noche (desde su pie hasta su tope).
 */
export function buildSign(sp: SignPanelPlace, S: SignPanelStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(sp.at, sp.angle, zone);
  const base = pk.terrain(f.x, f.z);
  const fl = S.floodlights;
  onGround(pk, base, () => panel(sp, S, f, pk, base), fl ? { intensity: fl.flood, height: S.lift + S.size[1] } : undefined);
  if (!fl) return;
  const m = f.matrix();
  const W = S.size[0];
  const [lw, lh, ld] = fl.size;
  onGround(pk, base, () => {
    for (let k = 0; k < fl.count; k++) {
      const u = -W / 2 + (W * (k + 0.5)) / fl.count;
      const c = f.point(u, -S.depth / 2 - fl.distance);
      pk.detail.box(m.clone().multiply(new THREE.Matrix4().makeTranslation(u, pk.terrain(c.x, c.z) + lh / 2, -S.depth / 2 - fl.distance)), lw, lh, ld, new THREE.Color(fl.color), { glow: glowOf(fl.glow) });
    }
  });
}

/** El panel de un letrero (con su plinto o sus postes, sus textos y figuras) y su física. */
function panel(sp: SignPanelPlace, S: SignPanelStyle, f: Frame, pk: PartsKit, base: number): void {
  const m = f.matrix();
  const [W, H] = S.size;
  const y0 = base + S.lift;
  const at = (u: number, y: number, v: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, y, v));
  const P = (u: number, y: number, v: number): THREE.Vector3 => new THREE.Vector3(u, y, v).applyMatrix4(m);
  const front = new THREE.Vector3(0, 0, -1).transformDirection(m);
  const back = front.clone().negate();
  pk.stone.box(at(0, y0 + H / 2, 0), W, H, S.depth, new THREE.Color(S.color));
  const gap = pk.signOffset;
  // Quien mira el frente (desde −v) tiene su derecha hacia −u; quien mira el dorso, hacia +u. `a`
  // se mide desde el borde izquierdo de quien mira.
  const across = (a: number, onBack: boolean): number => (onBack ? a - W / 2 : W / 2 - a);
  // Una cara plana sobre el frente (o el dorso), a `off` del panel: rectángulo (a0, y0, a1, y1)
  // desde la esquina de abajo a la izquierda de quien la mira; la primera esquina es esa.
  const plate = (rect: readonly number[], off: number, color: THREE.Color, surface: Surface, uv: number[] | undefined, onBack: boolean): void => {
    const [a0, b0, a1, b1] = rect;
    const v = onBack ? S.depth / 2 + off : -S.depth / 2 - off;
    const u0 = across(a0, onBack);
    const u1 = across(a1, onBack);
    const q = [P(u0, y0 + b0, v), P(u1, y0 + b0, v), P(u1, y0 + b1, v), P(u0, y0 + b1, v)];
    toward(pk.stone, onBack ? back : front, q, color, surface, uv);
  };
  const faces = S.back ? [false, true] : [false];
  const [il, ir, ib, it] = S.face.inset;
  for (const onBack of faces) {
    plate([il, ib, W - ir, H - it], gap, new THREE.Color(S.face.color), {}, undefined, onBack);
    for (const band of S.bands) plate(band.rect, gap * 2, new THREE.Color(band.color), {}, undefined, onBack);
    for (const t of sp.texts) {
      const [w, h] = t.size;
      const cx = W / 2 + t.at[0];
      const [r0, r1, r2, r3] = pk.signRect(signFace(t));
      const uv = [r0, r1, r2, r1, r2, r3, r0, r3];
      plate([cx - w / 2, t.at[1] - h / 2, cx + w / 2, t.at[1] + h / 2], gap * 3, WHITE, { pattern: PATTERN.sign, glow: S.glow ? glowOf(S.glow) : undefined }, uv, onBack);
    }
    for (const mk of sp.marks ?? []) {
      if (mk.shape === 'chevronLeft' || mk.shape === 'chevronRight') {
        // Chevrón: dos trazos a 45° que se juntan en la punta (visto de frente: a hacia la derecha).
        const r = mk.radius;
        const t = mk.stroke!;
        const cx = W / 2 + mk.at[0];
        const cy = mk.at[1];
        const x0 = -(r + t) / 2;
        const pts: [number, number][] = [
          [x0, 0],
          [x0 + r, -r],
          [x0 + r + t, -r],
          [x0 + t, 0],
          [x0 + r + t, r],
          [x0 + r, r],
        ];
        const flip = mk.shape === 'chevronRight' ? -1 : 1;
        const v = onBack ? S.depth / 2 + gap * 3 : -S.depth / 2 - gap * 3;
        const P3 = ([a, y]: [number, number]): THREE.Vector3 => P(across(cx + a * flip, onBack), y0 + cy + y, v);
        const color = new THREE.Color(mk.color);
        const tris = THREE.ShapeUtils.triangulateShape(
          pts.map(([a, y]) => new THREE.Vector2(a, y)),
          [],
        );
        for (const [i, j, k] of tris) {
          const [a, b, c] = [pts[i], pts[j], pts[k]].map(P3);
          const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
          if (n.dot(onBack ? back : front) >= 0) pk.stone.tri(a, b, c, color);
          else pk.stone.tri(a, c, b, color);
        }
        continue;
      }
      const sides = mk.shape === 'octagon' ? 8 : pk.sides;
      const phase = mk.shape === 'octagon' ? Math.PI / 8 : 0;
      const disc = (r: number, off: number, color: THREE.Color): void => {
        const v = onBack ? S.depth / 2 + off : -S.depth / 2 - off;
        const cu = across(W / 2 + mk.at[0], onBack);
        const c = P(cu, y0 + mk.at[1], v);
        for (let k = 0; k < sides; k++) {
          const a0 = phase + (k / sides) * Math.PI * 2;
          const a1 = phase + ((k + 1) / sides) * Math.PI * 2;
          const p0 = P(cu + Math.cos(a0) * r, y0 + mk.at[1] + Math.sin(a0) * r, v);
          const p1 = P(cu + Math.cos(a1) * r, y0 + mk.at[1] + Math.sin(a1) * r, v);
          const n = new THREE.Vector3().subVectors(p0, c).cross(new THREE.Vector3().subVectors(p1, c));
          if (n.dot(onBack ? back : front) >= 0) pk.stone.tri(c, p0, p1, color);
          else pk.stone.tri(c, p1, p0, color);
        }
      };
      if (mk.ring.width > 0) disc(mk.radius, gap * 2, new THREE.Color(mk.ring.color));
      disc(mk.radius - mk.ring.width, gap * 3, new THREE.Color(mk.color));
    }
  }
  const pl = S.plinth;
  const bottom = base - pk.ground.bury;
  if (pl) {
    const [w, h, d] = pl.size;
    pk.stone.box(at(0, (bottom + base + h) / 2, 0), w, base + h - bottom, d, new THREE.Color(pl.color), { pattern: patternOf(pl.pattern), scale: pl.scale });
    pk.site.box(f.x, f.z, Math.max(w, W) / 2, Math.max(d, S.depth) / 2, f.angle, y0 + H, false, -Infinity);
  } else pk.site.box(f.x, f.z, W / 2, S.depth / 2, f.angle, y0 + H, false, y0);
  const po = S.posts;
  if (po) {
    for (const u of po.at) {
      const h = y0 + H - bottom;
      pk.stone.box(at(u, bottom + h / 2, S.depth / 2 + po.width / 2), po.width, h, po.width, new THREE.Color(po.color));
      const c = f.point(u, S.depth / 2 + po.width / 2);
      pk.site.box(c.x, c.z, po.width / 2, po.width / 2, f.angle, y0 + H, false, -Infinity);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Pisos (plazas, islas, parterres, círculos pintados)

/**
 * Un piso: cuánto sobre el terreno, color, dibujo y escala, si se camina encima (física: un piso que
 * pasa del alto de un escalón ataja como muro y se puede estar encima) y, si tiene, su bordillo
 * (ancho, color y la pintura que se alterna a lo largo: colores, largo de cada trazo y cuánto se
 * separa la película de pintura del bordillo, para no pisarse con él; sin colores, sin pintar).
 */
export interface FloorStyle {
  lift: number;
  color: string;
  pattern: string;
  scale: number[];
  walk: boolean;
  curb?: { width: number; color: string; paint: { colors: string[]; dash: number; film: number } };
}

/**
 * Un piso en su zona: contorno (u, v) o círculo (u, v, radio), qué lados llevan bordillo (índices o
 * todos), las piscinas de su zona que quedan como hueco (por id: el deck alrededor del agua), estilo
 * y fuente.
 */
export interface FloorPlace {
  id: string;
  ring?: number[][];
  circle?: number[];
  curbs?: number[] | string;
  holes?: string[];
  style: string;
  source: string;
}

/** El contorno de un piso (marco de su zona). */
export function floorRing(fl: FloorPlace, sides: number): number[][] {
  if (fl.ring) return fl.ring;
  if (!fl.circle) throw new Error(`Piso ${fl.id}: necesita ring o circle`);
  const [cu, cv, r] = fl.circle;
  return Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2;
    return [cu + Math.cos(a) * r, cv + Math.sin(a) * r];
  });
}

/** Los lados con bordillo de un piso (índices del contorno). */
function curbsOf(fl: FloorPlace, ring: readonly unknown[]): number[] {
  return fl.curbs === undefined || fl.curbs === 'all' ? ring.map((_, k) => k) : (fl.curbs as number[]);
}

/** Área con signo de un contorno (x, z del lugar). */
function ringArea(ring: readonly (readonly number[])[]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const [px, pz] = ring[k];
    const [qx, qz] = ring[(k + 1) % ring.length];
    a += px * qz - qx * pz;
  }
  return a / 2;
}

/** La dirección de un lado de un contorno y su normal hacia afuera (según el sentido del contorno). */
function edgeFrame(ring: readonly (readonly number[])[], i: number, area: number): { a: THREE.Vector2; b: THREE.Vector2; len: number; dir: THREE.Vector2; n: THREE.Vector2 } {
  const a = new THREE.Vector2(ring[i][0], ring[i][1]);
  const j = (i + 1) % ring.length;
  const b = new THREE.Vector2(ring[j][0], ring[j][1]);
  const len = a.distanceTo(b);
  const dir = len > 0 ? b.clone().sub(a).divideScalar(len) : new THREE.Vector2(1, 0);
  const n = area > 0 ? new THREE.Vector2(dir.y, -dir.x) : new THREE.Vector2(-dir.y, dir.x);
  return { a, b, len, dir, n };
}

/**
 * El canto de un bordillo a lo largo de los lados `curbs` de un contorno (marco del lugar): de bajo
 * el terreno hasta la losa (`top`), hacia afuera, y su franja de arriba de `width` m a
 * `ground.lift` sobre la losa; partidos donde `paveFit` parte el borde de la losa.
 */
function curbEdges(batch: Batch, ring: readonly (readonly number[])[], curbs: readonly number[], top: (x: number, z: number) => number, width: number, ground: UrbanGround, height: number, color: THREE.Color): void {
  const area = ringArea(ring);
  for (const i of curbs) {
    const { a, b, len, n } = edgeFrame(ring, i, area);
    if (len < 1e-3) continue;
    const out3 = new THREE.Vector3(n.x, 0, n.y);
    const pts = fitEdge(a, b, top, ground);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      const yp = top(p.x, p.y);
      const yq = top(q.x, q.y);
      const face = [new THREE.Vector3(p.x, yp - height - ground.bury, p.y), new THREE.Vector3(q.x, yq - height - ground.bury, q.y), new THREE.Vector3(q.x, yq, q.y), new THREE.Vector3(p.x, yp, p.y)];
      toward(batch, out3, face, color, {});
      const pIn = p.clone().addScaledVector(n, -width);
      const qIn = q.clone().addScaledVector(n, -width);
      const band = [new THREE.Vector3(p.x, yp + ground.lift, p.y), new THREE.Vector3(q.x, yq + ground.lift, q.y), new THREE.Vector3(qIn.x, top(qIn.x, qIn.y) + ground.lift, qIn.y), new THREE.Vector3(pIn.x, top(pIn.x, pIn.y) + ground.lift, pIn.y)];
      facing(batch, true, band, color, {});
    }
  }
}

/**
 * La pintura de un bordillo: trazos que alternan sus colores a lo largo de los lados `curbs`
 * (seguidos de un lado al siguiente), cada uno una película `paint.film` m por fuera de su canto y
 * sobre su franja, partida también donde se parte el bordillo. Se cuenta con un entero y lo que
 * falta del trazo: con un largo de trazo cualquiera (0,3, 0,6…) el redondeo no traba el avance.
 */
function curbPaint(batch: Batch, ring: readonly (readonly number[])[], curbs: readonly number[], top: (x: number, z: number) => number, C: NonNullable<FloorStyle['curb']>, ground: UrbanGround, height: number): void {
  const colors = C.paint.colors.map((c) => new THREE.Color(c));
  const film = C.paint.film;
  const area = ringArea(ring);
  let k = 0;
  let left = C.paint.dash;
  for (const i of curbs) {
    const { a, b, len, dir, n } = edgeFrame(ring, i, area);
    if (len < 1e-3) continue;
    const out3 = new THREE.Vector3(n.x, 0, n.y);
    // Los cortes del bordillo (a lo largo del lado) y los de los trazos.
    const cuts = fitEdge(a, b, top, ground).map((p) => p.distanceTo(a));
    let s = 0;
    let c = 1;
    while (s < len - 1e-9) {
      const next = Math.min(len, s + left, cuts[Math.min(c, cuts.length - 1)]);
      if (next > s + 1e-9) {
        const color = colors[k % colors.length];
        const p = a.clone().addScaledVector(dir, s).addScaledVector(n, film);
        const q = a.clone().addScaledVector(dir, next).addScaledVector(n, film);
        const yp = top(p.x, p.y);
        const yq = top(q.x, q.y);
        const face = [new THREE.Vector3(p.x, yp - height, p.y), new THREE.Vector3(q.x, yq - height, q.y), new THREE.Vector3(q.x, yq + ground.lift + film, q.y), new THREE.Vector3(p.x, yp + ground.lift + film, p.y)];
        toward(batch, out3, face, color, {});
        const pIn = p.clone().addScaledVector(n, -C.width - film);
        const qIn = q.clone().addScaledVector(n, -C.width - film);
        facing(batch, true, [face[3], face[2], new THREE.Vector3(qIn.x, top(qIn.x, qIn.y) + ground.lift + film, qIn.y), new THREE.Vector3(pIn.x, top(pIn.x, pIn.y) + ground.lift + film, pIn.y)], color, {});
        left -= next - s;
        s = next;
      }
      if (c < cuts.length && s >= cuts[c] - 1e-9) c++;
      if (left <= 1e-9) {
        k++;
        left = C.paint.dash;
      }
    }
  }
}

/**
 * Arma un piso (con su bordillo y la pintura del bordillo si tiene) y su física. `holes`: los
 * contornos (marco del lugar) de lo que queda como hueco (las piscinas de su zona que nombra).
 */
export function buildFloor(fl: FloorPlace, S: FloorStyle, zone: Frame, pk: PartsKit, holes: readonly number[][][] = []): void {
  const ring = zone.ring(floorRing(fl, pk.sides));
  const color = new THREE.Color(S.color);
  const surface: Surface = { pattern: patternOf(S.pattern), scale: S.scale };
  const top = (x: number, z: number): number => pk.terrain(x, z) + S.lift;
  const C = S.curb;
  const curbs = C ? curbsOf(fl, ring) : [];
  if (C && !holes.length) {
    curbed({ ring, curbs }, { height: S.lift, curb: C.width, color: S.color, curbColor: C.color, pattern: S.pattern, scale: S.scale }, pk.ground, pk.terrain, pk.stone, pk.stone, S.walk ? pk.site : null);
  } else {
    const pieces = paveFit(pk.stone, ring, holes, top, pk.ground, color, surface);
    if (C) curbEdges(pk.stone, ring, curbs, top, C.width, pk.ground, S.lift, new THREE.Color(C.color));
    // La física: con huecos, triángulo por triángulo (sobre los huecos manda el piso de lo que va en ellos, el agua).
    if (S.walk) for (const tri of holes.length ? pieces : [ring]) pk.site.ground(tri.map(([x, z]) => new THREE.Vector3(x, 0, z)), S.lift);
  }
  if (C?.paint.colors.length) curbPaint(pk.detail, ring, curbs, top, C, pk.ground, S.lift);
}

/** El giro de y de una pieza instanciada con su eje x hacia `angle` (atan2(z, x) del lugar). */
export function turn(angle: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(UP, -angle);
}
