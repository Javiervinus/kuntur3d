import * as THREE from 'three';
import type { SignFace, SignRect } from '../render/signAtlas';
import { polyBoxes } from './mallParts';
import { type Batch, type Glow, PATTERN, type Surface, glowOf, patternOf } from './monumentParts';
import type { PlaceLight, PlaceSite } from './placeKit';
import { pave } from './street';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Piezas a nivel de la calle de un lugar (config/sites): la terraza sobre su zócalo, escaleras y
 * rampas, la marquesina de un acceso, jardineras, bordillos pintados, pisos y letreros. Sirven
 * para cualquier edificio: todo sale de la config (marco local del lugar, largos en m, alturas
 * desde la base del lugar).
 */

/** Terraza (la planta baja sobre su zócalo): piso plano, muros de zócalo hasta el terreno y baranda. */
export interface Platform {
  id: string;
  /** Contorno (marco local); lo que queda bajo un edificio no se ve. */
  ring: number[][];
  /** Alto del piso sobre la base. */
  height: number;
  /** Lados (i = del punto i al i + 1) con muro de zócalo y baranda: los que dan a la calle o a la plaza. */
  edges: number[];
  /** Muro del zócalo y piso: color, dibujo y cuántas unidades del dibujo mide cada metro. */
  wall: { color: string; pattern: string; scale: number[] };
  floor: { color: string; pattern: string; scale: number[] };
  /**
   * Baranda calada: alto, a cuánto del borde hacia adentro, largo de cada paño (un parante al
   * arrancar cada uno), color, dibujo (uv: u = alto, v = a lo largo, en m, por `scale`: los
   * barrotes del dibujo quedan como tubos horizontales) y tramos sin baranda [lado, desde, hasta]
   * (m desde el primer punto del lado): donde llegan las escaleras y las rampas.
   */
  rail: { height: number; inset: number; post: number; color: string; pattern: string; scale: number[]; gaps: number[][] };
  source: string;
}

/** Escalera o rampa que baja de un piso elevado (una terraza) al terreno. */
export interface Flight {
  id: string;
  /** 'steps' (escalones) o 'ramp' (rampa). */
  kind: string;
  /** Centro del borde de arriba (marco local), hacia dónde baja (grados, atan2(z, x) local) y ancho. */
  at: number[];
  angle: number;
  width: number;
  /** Alto del borde de arriba sobre la base (el piso al que llega). */
  top: number;
  /**
   * Contrahuella: en una escalera, la buscada (la cantidad sale de lo que haya que bajar hasta el
   * terreno); en las dos, el escalón más alto de su física.
   */
  rise: number;
  /** Huella de cada escalón (solo escaleras). */
  run?: number;
  /** Cuánto baja por metro (solo rampas). */
  slope?: number;
  color: string;
  pattern: string;
  scale: number[];
  source: string;
}

/** Marquesina de un acceso: losa con canto sobre columnas, cielo con focos, que se camina por debajo. */
export interface Canopy {
  id: string;
  /** Planta (marco local). */
  ring: number[][];
  /** Alto del cielo sobre el piso de abajo (la mediana del terreno en la planta) y alto del canto. */
  soffit: number;
  fascia: number;
  /** Lados (i = del punto i al i + 1) pegados al edificio: sin canto. */
  attached: number[];
  /** Columnas: centros (marco local), lado, alto del zócalo, colores del fuste y del zócalo. */
  columns: { at: number[][]; size: number; plinth: number; color: string; plinthColor: string };
  colors: { fascia: string; soffit: string; top: string };
  /** Paneles del canto: dibujo y cuántas unidades del dibujo mide cada metro (uv: a lo largo, alto). */
  cladding: { pattern: string; scale: number[] };
  /** Oclusión del cielo. */
  ao: number;
  /**
   * Focos del cielo: uno cada `spacing` m en cuadrícula, a al menos `inset` de los bordes, de lado
   * `size`, colgados `drop` m, con su color y su luz; uno de cada `light.every` alumbra el piso.
   */
  spots: { spacing: number; inset: number; size: number; drop: number; color: string; glow: Glow; light: { every: number; power: number; led: boolean } };
  /** Ancho de las franjas en que se parte su física, a lo ancho del lado más largo (cajas que se pasan por debajo). */
  strip: number;
  /** Letreros en el canto. */
  signs: CanopySign[];
  source: string;
}

/**
 * Un letrero en el canto de una marquesina: en el lado `edge` (i = del punto i al i + 1), con su
 * centro a `at` m del punto i y a media altura del canto; sin `glow` no se enciende de noche.
 */
export interface CanopySign extends SignFace {
  edge: number;
  at: number;
  glow?: Glow;
  source: string;
}

/** Jardinera: bordillo, seto encima y palmeras [x, z, alto]. */
export interface Bed {
  id: string;
  ring: number[][];
  curb: { height: number; color: string };
  hedge: { height: number; color: string; pattern: string; scale: number[] };
  palms: number[][];
  source: string;
}

/** Bordillo corrido por una línea (marco local), con su dibujo (las franjas amarillas y negras de un acceso). */
export interface Curb {
  id: string;
  line: number[][];
  /** Alto sobre el terreno y ancho. */
  height: number;
  width: number;
  color: string;
  /** Dibujo (uv: u = a lo largo, v = de través, en m, por `scale`). */
  pattern: string;
  scale: number[];
  source: string;
}

/** Piso que sigue el terreno (un carril, una acera): `lift` m sobre él. */
export interface Paved {
  id: string;
  ring: number[][];
  lift: number;
  color: string;
  pattern: string;
  scale: number[];
  source: string;
}

/**
 * Un letrero puesto donde diga la config: `at` es el punto de la superficie donde va (marco
 * local), `y` el alto de su centro sobre la base y `angle` hacia dónde mira (grados, atan2(z, x)
 * local). La caja (`depth`, 0 = letras sueltas) sale de la superficie; la cara va delante. Sin
 * `glow` no se enciende de noche.
 */
export interface PlacedSign extends SignFace {
  at: number[];
  y: number;
  angle: number;
  glow?: Glow;
  source: string;
}

/** Lo que las piezas de la calle necesitan para armarse. */
export interface BaseKit {
  /** Altura del mundo de la base del lugar (las alturas de la config se miden desde aquí). */
  base: number;
  terrain(x: number, z: number): number;
  /** Largo de los tramos que siguen el terreno, cuánto se entierran los muros y grosor de la física de las vallas. */
  step: number;
  bury: number;
  wall: number;
  /** Lo que se ve siempre; lo chico que solo se ve de cerca; lo calado (barandas). */
  stone: Batch;
  detail: Batch;
  rails: Batch;
  site: PlaceSite;
  palm(x: number, z: number, y: number, height: number): void;
  signRect(s: SignFace): SignRect;
  signOffset: number;
}

const v2 = (ring: readonly (readonly number[])[]): THREE.Vector2[] => ring.map(([x, z]) => new THREE.Vector2(x, z));
const v3 = (ring: readonly THREE.Vector2[]): THREE.Vector3[] => ring.map((p) => new THREE.Vector3(p.x, 0, p.y));

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Área con signo en el plano x-z (positiva = antihoraria con x a la derecha y z hacia arriba). */
function signedArea(ring: readonly THREE.Vector2[]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Normal hacia afuera del lado a → b de un contorno de área `area`. */
function outward(a: THREE.Vector2, b: THREE.Vector2, area: number): THREE.Vector2 {
  const d = b.clone().sub(a).normalize();
  return area > 0 ? new THREE.Vector2(d.y, -d.x) : new THREE.Vector2(-d.y, d.x);
}

/**
 * Cara vertical de a a b (marco local) con el pie en ya0/yb0 y el tope en ya1/yb1, mirando hacia
 * `out`; uv (u0, v0) al pie de a y (u1, v1) al tope de b.
 */
function vwall(batch: Batch, a: THREE.Vector2, b: THREE.Vector2, ya0: number, yb0: number, ya1: number, yb1: number, out: THREE.Vector2, color: THREE.Color, surface: Surface, uv: readonly number[] = [0, 0, 1, 1]): void {
  const [u0, v0, u1, v1] = uv;
  const A0 = new THREE.Vector3(a.x, ya0, a.y);
  const B0 = new THREE.Vector3(b.x, yb0, b.y);
  const B1 = new THREE.Vector3(b.x, yb1, b.y);
  const A1 = new THREE.Vector3(a.x, ya1, a.y);
  // (b − a) × arriba = (−Δz, Δx): si mira hacia `out`, va así; si no, al revés.
  const facing = -(b.y - a.y) * out.x + (b.x - a.x) * out.y;
  if (facing >= 0) batch.quad(A0, B0, B1, A1, color, surface, [u0, v0, u1, v0, u1, v1, u0, v1]);
  else batch.quad(B0, A0, A1, B1, color, surface, [u1, v0, u0, v0, u0, v1, u1, v1]);
}

/** Polígono horizontal a la altura y, mirando hacia arriba (o hacia abajo), con uv en m del marco local. */
function flat(batch: Batch, ring: readonly THREE.Vector2[], y: number, up: boolean, color: THREE.Color, surface: Surface): void {
  const tris = THREE.ShapeUtils.triangulateShape([...ring], []);
  for (const [i, j, k] of tris) {
    const [a, b, c] = [ring[i], ring[j], ring[k]].map((p) => new THREE.Vector3(p.x, y, p.y));
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const [p0, p1, p2] = n.y > 0 === up ? [a, b, c] : [a, c, b];
    batch.tri(p0, p1, p2, color, surface, [p0.x, p0.z, p1.x, p1.z, p2.x, p2.z]);
  }
}

/**
 * Muro de a a b hasta el alto `top`, en tramos de `step`: desde el terreno (menos lo enterrado),
 * o desde el alto `from` si lo trae (el seto sobre su bordillo).
 */
function footWall(kit: BaseKit, batch: Batch, a: THREE.Vector2, b: THREE.Vector2, top: number, out: THREE.Vector2, color: THREE.Color, surface: Surface, from?: number): void {
  const len = a.distanceTo(b);
  const n = Math.max(1, Math.ceil(len / kit.step));
  for (let k = 0; k < n; k++) {
    const p = a.clone().lerp(b, k / n);
    const q = a.clone().lerp(b, (k + 1) / n);
    const yp0 = Math.min(from ?? kit.terrain(p.x, p.y) - kit.bury, top);
    const yq0 = Math.min(from ?? kit.terrain(q.x, q.y) - kit.bury, top);
    const u0 = (len * k) / n;
    vwall(batch, p, q, yp0, yq0, top, top, out, color, surface, [u0, Math.min(yp0, yq0), u0 + len / n, top]);
  }
}

/** La terraza: piso, zócalo, baranda y su física (el macizo se trepa; la baranda ataja). */
export function buildPlatform(p: Platform, kit: BaseKit): void {
  const ring = v2(p.ring);
  const top = kit.base + p.height;
  const area = signedArea(ring);
  flat(kit.stone, ring, top, true, new THREE.Color(p.floor.color), { pattern: patternOf(p.floor.pattern), scale: p.floor.scale });
  const wallColor = new THREE.Color(p.wall.color);
  const wallSurface: Surface = { pattern: patternOf(p.wall.pattern), scale: p.wall.scale };
  const R = p.rail;
  const railColor = new THREE.Color(R.color);
  const railSurface: Surface = { pattern: patternOf(R.pattern), scale: R.scale };
  for (const i of p.edges) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const out = outward(a, b, area);
    footWall(kit, kit.stone, a, b, top, out, wallColor, wallSurface);
    // Baranda: la línea corrida hacia adentro, sin los tramos de las escaleras y rampas.
    const len = a.distanceTo(b);
    const d = b.clone().sub(a).divideScalar(len);
    const inA = a.clone().addScaledVector(out, -R.inset);
    const cuts = R.gaps.filter((g) => g[0] === i).map((g) => [g[1], g[2]]).sort((x, y) => x[0] - y[0]);
    const pieces: number[][] = [];
    let s0 = 0;
    for (const [g0, g1] of cuts) {
      if (g0 > s0) pieces.push([s0, Math.min(g0, len)]);
      s0 = Math.max(s0, g1);
    }
    if (s0 < len) pieces.push([s0, len]);
    for (const [t0, t1] of pieces) {
      const n = Math.max(1, Math.round((t1 - t0) / R.post));
      for (let k = 0; k < n; k++) {
        const pa = inA.clone().addScaledVector(d, t0 + ((t1 - t0) * k) / n);
        const pb = inA.clone().addScaledVector(d, t0 + ((t1 - t0) * (k + 1)) / n);
        const w = pa.distanceTo(pb);
        kit.rails.quad(new THREE.Vector3(pa.x, top, pa.y), new THREE.Vector3(pb.x, top, pb.y), new THREE.Vector3(pb.x, top + R.height, pb.y), new THREE.Vector3(pa.x, top + R.height, pa.y), railColor, railSurface, [0, 0, 0, w, R.height, w, R.height, 0]);
      }
      const pa = inA.clone().addScaledVector(d, t0);
      const pb = inA.clone().addScaledVector(d, t1);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      kit.site.box(mid.x, mid.y, (t1 - t0) / 2, kit.wall / 2, Math.atan2(d.y, d.x), top + R.height, false, -Infinity);
    }
  }
  const low = Math.min(...ring.map((q) => kit.terrain(q.x, q.y)));
  kit.site.block(v3(ring), low - kit.bury, top);
}

/** Una escalera o una rampa: la pieza, su cara de abajo hasta el terreno y su física en escalones. */
export function buildFlight(f: Flight, kit: BaseKit): void {
  const d = new THREE.Vector2(Math.cos(f.angle * DEG), Math.sin(f.angle * DEG));
  const side = new THREE.Vector2(-d.y, d.x);
  const at = new THREE.Vector2(f.at[0], f.at[1]);
  const yTop = kit.base + f.top;
  const color = new THREE.Color(f.color);
  const surface: Surface = { pattern: patternOf(f.pattern), scale: f.scale };
  const angle = Math.atan2(d.y, d.x);
  if (f.kind === 'steps') {
    // Cuántos escalones: lo que baja hasta el terreno al pie (se mide dos veces: el pie se corre).
    const run = f.run ?? 0;
    let n = Math.max(1, Math.ceil((yTop - kit.terrain(at.x, at.y)) / f.rise));
    for (let pass = 0; pass < 2; pass++) {
      const foot = at.clone().addScaledVector(d, (n - 1) * run);
      n = Math.max(1, Math.ceil((yTop - kit.terrain(foot.x, foot.y)) / f.rise));
    }
    const foot = at.clone().addScaledVector(d, (n - 1) * run);
    const riser = (yTop - kit.terrain(foot.x, foot.y)) / n;
    if (riser <= 0) return;
    for (let j = 1; j < n; j++) {
      const c = at.clone().addScaledVector(d, (j - 0.5) * run);
      const y1 = yTop - j * riser;
      const y0 = kit.terrain(c.x, c.y) - kit.bury;
      if (y1 > y0) {
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(d.x, 0, d.y), UP, new THREE.Vector3(-d.y, 0, d.x)).setPosition(c.x, (y0 + y1) / 2, c.y);
        kit.stone.box(m, run, y1 - y0, f.width, color, surface);
      }
      kit.site.box(c.x, c.y, run / 2, f.width / 2, angle, y1, true, -Infinity);
    }
    return;
  }
  // Rampa: del borde de arriba hasta donde toca el terreno, con sus dos costados.
  const slope = f.slope ?? 0;
  if (slope <= 0) return;
  let len = (yTop - kit.terrain(at.x, at.y)) / slope;
  for (let pass = 0; pass < 2; pass++) {
    const foot = at.clone().addScaledVector(d, len);
    len = Math.max(0, (yTop - kit.terrain(foot.x, foot.y)) / slope);
  }
  if (len <= 0) return;
  const foot = at.clone().addScaledVector(d, len);
  const yFoot = yTop - len * slope;
  const w = f.width / 2;
  const P = (v: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(v.x, y, v.y);
  const a = at.clone().addScaledVector(side, -w);
  const b = at.clone().addScaledVector(side, w);
  const c = foot.clone().addScaledVector(side, w);
  const e = foot.clone().addScaledVector(side, -w);
  const deck = [P(a, yTop), P(e, yFoot), P(c, yFoot), P(b, yTop)];
  const n = new THREE.Vector3().subVectors(deck[1], deck[0]).cross(new THREE.Vector3().subVectors(deck[3], deck[0]));
  if (n.y > 0) kit.stone.quad(deck[0], deck[1], deck[2], deck[3], color, surface, [a.x, a.y, e.x, e.y, c.x, c.y, b.x, b.y]);
  else kit.stone.quad(deck[3], deck[2], deck[1], deck[0], color, surface, [b.x, b.y, c.x, c.y, e.x, e.y, a.x, a.y]);
  for (const [p, q, out] of [
    [a, e, side.clone().negate()],
    [b, c, side],
  ] as const) {
    vwall(kit.stone, p, q, kit.terrain(p.x, p.y) - kit.bury, kit.terrain(q.x, q.y) - kit.bury, yTop, yFoot, out, color, surface, [0, 0, len, yTop - yFoot]);
  }
  const steps = Math.max(1, Math.ceil((yTop - yFoot) / f.rise));
  for (let j = 0; j < steps; j++) {
    const c0 = (len * j) / steps;
    const c1 = (len * (j + 1)) / steps;
    const mid = at.clone().addScaledVector(d, (c0 + c1) / 2);
    kit.site.box(mid.x, mid.y, (c1 - c0) / 2, w, angle, yTop - c0 * slope, true, -Infinity);
  }
}

/** Focos del cielo de una marquesina (marco local): en cuadrícula, dentro de la planta y lejos de los bordes. */
export function canopySpots(c: Canopy): THREE.Vector2[] {
  const ring = v2(c.ring);
  const S = c.spots;
  const xs = ring.map((p) => p.x);
  const zs = ring.map((p) => p.y);
  const out: THREE.Vector2[] = [];
  const inside = (p: THREE.Vector2): boolean => {
    let hit = false;
    for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
      const a = ring[k];
      const b = ring[m];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const edgeDistance = (p: THREE.Vector2): number => {
    let d = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
      d = Math.min(d, p.distanceTo(a.clone().addScaledVector(ab, t)));
    }
    return d;
  };
  for (let x = Math.min(...xs) + S.spacing / 2; x < Math.max(...xs); x += S.spacing) {
    for (let z = Math.min(...zs) + S.spacing / 2; z < Math.max(...zs); z += S.spacing) {
      const p = new THREE.Vector2(x, z);
      if (inside(p) && edgeDistance(p) >= S.inset) out.push(p);
    }
  }
  return out;
}

/** Las luces de una marquesina para el alumbrado (una de cada `spots.light.every` focos). */
export function canopyLights(c: Canopy): PlaceLight[] {
  const L = c.spots.light;
  return canopySpots(c)
    .filter((_, k) => k % L.every === 0)
    .map((p) => ({ x: p.x, z: p.y, lift: 0, h: c.soffit, out: 0, power: L.power, led: L.led }));
}

/** Una marquesina: losa con su canto y sus letreros, cielo con focos, columnas y su física. */
export function buildCanopy(c: Canopy, kit: BaseKit): void {
  const ring = v2(c.ring);
  const area = signedArea(ring);
  const floor = median(ring.map((p) => kit.terrain(p.x, p.y)));
  const y0 = floor + c.soffit;
  const y1 = y0 + c.fascia;
  flat(kit.stone, ring, y0, false, new THREE.Color(c.colors.soffit), { ao: c.ao });
  flat(kit.stone, ring, y1, true, new THREE.Color(c.colors.top), {});
  const fascia = new THREE.Color(c.colors.fascia);
  const cladding: Surface = { pattern: patternOf(c.cladding.pattern), scale: c.cladding.scale };
  ring.forEach((a, i) => {
    if (c.attached.includes(i)) return;
    const b = ring[(i + 1) % ring.length];
    vwall(kit.stone, a, b, y0, y0, y1, y1, outward(a, b, area), fascia, cladding, [0, 0, a.distanceTo(b), c.fascia]);
  });
  for (const sg of c.signs) {
    const a = ring[sg.edge];
    const b = ring[(sg.edge + 1) % ring.length];
    const at = a.clone().lerp(b, sg.at / a.distanceTo(b));
    const out = outward(a, b, area);
    buildSign({ ...sg, at: [at.x, at.y], y: (y0 + y1) / 2 - kit.base, angle: Math.atan2(out.y, out.x) / DEG }, kit);
  }
  const C = c.columns;
  const shaft = new THREE.Color(C.color);
  const plinth = new THREE.Color(C.plinthColor);
  for (const [x, z] of C.at) {
    const ground = kit.terrain(x, z);
    const foot = ground - kit.bury;
    kit.stone.box(new THREE.Matrix4().makeTranslation(x, (foot + ground + C.plinth) / 2, z), C.size, ground + C.plinth - foot, C.size, plinth);
    kit.stone.box(new THREE.Matrix4().makeTranslation(x, (ground + C.plinth + y0) / 2, z), C.size, y0 - ground - C.plinth, C.size, shaft);
    kit.site.box(x, z, C.size / 2, C.size / 2, 0, y0, false, -Infinity);
  }
  const S = c.spots;
  const h = S.size / 2;
  const color = new THREE.Color(S.color);
  const glow = glowOf(S.glow);
  for (const p of canopySpots(c)) {
    const y = y0 - S.drop;
    // Mirando hacia abajo.
    kit.detail.quad(new THREE.Vector3(p.x - h, y, p.y - h), new THREE.Vector3(p.x + h, y, p.y - h), new THREE.Vector3(p.x + h, y, p.y + h), new THREE.Vector3(p.x - h, y, p.y + h), color, { glow });
  }
  // Física: franjas de `strip` m a lo ancho del lado más largo, cada una del largo de la planta en
  // su línea media (así los lados inclinados no dejan techo fantasma); debajo se pasa, encima se pisa.
  for (const bx of polyBoxes(ring, c.strip)) kit.site.box(bx.x, bx.z, bx.halfU, bx.halfV, bx.angle, y1, true, y0);
}

/** Una jardinera: bordillo, seto con su dibujo, palmeras (las de la ciudad) y su física. */
export function buildBed(b: Bed, kit: BaseKit): void {
  const ring = v2(b.ring);
  const area = signedArea(ring);
  const floor = median(ring.map((p) => kit.terrain(p.x, p.y)));
  const curbTop = floor + b.curb.height;
  const top = curbTop + b.hedge.height;
  const curb = new THREE.Color(b.curb.color);
  const hedge = new THREE.Color(b.hedge.color);
  const leaves: Surface = { pattern: patternOf(b.hedge.pattern), scale: b.hedge.scale };
  ring.forEach((a, i) => {
    const q = ring[(i + 1) % ring.length];
    const out = outward(a, q, area);
    footWall(kit, kit.stone, a, q, curbTop, out, curb, {});
    footWall(kit, kit.stone, a, q, top, out, hedge, leaves, curbTop);
  });
  flat(kit.stone, ring, top, true, hedge, leaves);
  for (const [x, z, height] of b.palms) kit.palm(x, z, curbTop, height);
  kit.site.block(v3(ring), floor - kit.bury, top);
}

/** Un bordillo corrido: tope y los dos costados siguiendo el terreno, y las puntas. */
export function buildCurb(c: Curb, kit: BaseKit): void {
  const line = v2(c.line);
  const color = new THREE.Color(c.color);
  const surface: Surface = { pattern: patternOf(c.pattern), scale: c.scale };
  const w = c.width / 2;
  let u = 0;
  const top = (p: THREE.Vector2): number => kit.terrain(p.x, p.y) + c.height;
  const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k];
    const b = line[k + 1];
    const len = a.distanceTo(b);
    if (len < 1e-6) continue;
    const d = b.clone().sub(a).divideScalar(len);
    const n = new THREE.Vector2(-d.y, d.x);
    const pieces = Math.max(1, Math.ceil(len / kit.step));
    for (let j = 0; j < pieces; j++) {
      const p = a.clone().addScaledVector(d, (len * j) / pieces);
      const q = a.clone().addScaledVector(d, (len * (j + 1)) / pieces);
      const l = len / pieces;
      const pl = p.clone().addScaledVector(n, w);
      const ql = q.clone().addScaledVector(n, w);
      const pr = p.clone().addScaledVector(n, -w);
      const qr = q.clone().addScaledVector(n, -w);
      const tp = top(p);
      const tq = top(q);
      // Tope (mirando hacia arriba: de la derecha a la izquierda, a lo largo).
      const deck = [P(pr, tp), P(qr, tq), P(ql, tq), P(pl, tp)];
      const up = new THREE.Vector3().subVectors(deck[1], deck[0]).cross(new THREE.Vector3().subVectors(deck[3], deck[0])).y > 0;
      const uv = [u, 0, u + l, 0, u + l, c.width, u, c.width];
      if (up) kit.stone.quad(deck[0], deck[1], deck[2], deck[3], color, surface, uv);
      else kit.stone.quad(deck[3], deck[2], deck[1], deck[0], color, surface, [uv[6], uv[7], uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]]);
      vwall(kit.stone, pl, ql, tp - c.height - kit.bury, tq - c.height - kit.bury, tp, tq, n, color, surface, [u, 0, u + l, c.height]);
      vwall(kit.stone, pr, qr, tp - c.height - kit.bury, tq - c.height - kit.bury, tp, tq, n.clone().negate(), color, surface, [u, 0, u + l, c.height]);
      u += l;
    }
  }
  // Puntas.
  for (const [p, q] of [
    [line[0], line[1]],
    [line[line.length - 1], line[line.length - 2]],
  ] as const) {
    const d = p.clone().sub(q).normalize();
    const n = new THREE.Vector2(-d.y, d.x);
    const t = top(p);
    vwall(kit.stone, p.clone().addScaledVector(n, -w), p.clone().addScaledVector(n, w), t - c.height - kit.bury, t - c.height - kit.bury, t, t, d, color, {});
  }
}

/** Un piso que sigue el terreno, con su física (un piso que no ocupa: los árboles crecen en él). */
export function buildPaved(p: Paved, kit: BaseKit): void {
  pave(kit.stone, p.ring, (x, z) => kit.terrain(x, z) + p.lift, kit.step, new THREE.Color(p.color), { pattern: patternOf(p.pattern), scale: p.scale });
  kit.site.ground(v3(v2(p.ring)), p.lift);
}

/** Un letrero en su lugar: la caja (si tiene fondo) y la cara con su pedazo del atlas. */
export function buildSign(s: PlacedSign, kit: BaseKit): void {
  const n = new THREE.Vector2(Math.cos(s.angle * DEG), Math.sin(s.angle * DEG));
  // A lo largo de las letras: con la cara mirando hacia n, (derecha) × arriba = n.
  const t = new THREE.Vector2(n.y, -n.x);
  const [w, h] = s.size;
  const depth = s.depth ?? 0;
  const at = new THREE.Vector2(s.at[0], s.at[1]);
  const yc = kit.base + s.y;
  if (depth > 0) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(t.x, 0, t.y), UP, new THREE.Vector3(n.x, 0, n.y)).setPosition(at.x + (n.x * depth) / 2, yc, at.y + (n.y * depth) / 2);
    kit.detail.box(m, w, h, depth, new THREE.Color(s.background));
  }
  const face = at.clone().addScaledVector(n, depth + kit.signOffset);
  const a = face.clone().addScaledVector(t, -w / 2);
  const b = face.clone().addScaledVector(t, w / 2);
  const surface: Surface = { pattern: PATTERN.sign, glow: s.glow ? glowOf(s.glow) : undefined };
  kit.detail.quad(new THREE.Vector3(a.x, yc - h / 2, a.y), new THREE.Vector3(b.x, yc - h / 2, b.y), new THREE.Vector3(b.x, yc + h / 2, b.y), new THREE.Vector3(a.x, yc + h / 2, a.y), WHITE, surface, kit.signRect(s));
}
