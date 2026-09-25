import * as THREE from 'three';
import { type Batch, PATTERN, type Surface, colorsOf, patternOf } from './monumentParts';

/**
 * El retiro frente a un edificio o un lote (config/streets → retiros): el piso entre la vereda y
 * la fachada, con los puestos en batería contra el edificio, sus topes de llanta, el borde con la
 * vereda y sus palmeras. Es lo que más distingue una avenida de ciudadela (la Alborada, Sauces,
 * la Garzota) del centro. Largos en m.
 */
export interface RetiroStyle {
  /** Alto del piso sobre el terreno. */
  height: number;
  /** Piso: color, dibujo (PATTERN) y cuántas unidades del dibujo mide cada metro. */
  surface: { color: string; pattern: string; scale: number[] };
  /**
   * Puestos contra el fondo (el edificio o el fondo del lote), con la trompa hacia él: ancho y
   * fondo de cada uno (0 de ancho = sin puestos), ancho, color y alto sobre el piso de las líneas
   * pintadas, qué parte está ocupada y cuánto se deja libre en las puntas.
   */
  stalls: { width: number; depth: number; line: number; color: string; lift: number; cars: number; margin: number };
  /** Topes de llanta: largo, alto y fondo, a cuánto de la cabecera del puesto, largo de cada franja y sus colores (alternados). */
  stops: { size: number[]; inset: number; stripe: number; colors: string[] };
  /**
   * Borde con la vereda: 'open' (nada), 'curb' (bordillo pintado en franjas), 'fence' (muro bajo
   * con reja y pilares) o 'planter' (jardinera). Alto del muro, bordillo o jardinera y su ancho,
   * alto de la reja sobre el muro, pilares (cada cuánto y su ancho), franja del bordillo y colores
   * (muro o bordillo, reja o segunda franja, pilares).
   */
  edge: { kind: string; height: number; width: number; fence: number; posts: number[]; stripe: number; colors: string[] };
  /**
   * Palmeras a lo largo del borde: cada cuánto (0 = sin), a cuánto de él hacia adentro, alto (mín.,
   * máx.). Si caen donde van los puestos, se corren a la línea entre dos puestos más cercana.
   */
  palms: { spacing: number; inset: number; height: number[] };
  /** Tramos (x del marco de la calle) sin puestos ni borde: las entradas. */
  gaps: number[][];
}

/** Un retiro de una cuadra (lo arma build_street.py). */
export interface Retiro {
  id: string;
  style: string;
  /** Contorno (marco de la calle). */
  ring: number[][];
  /** Su borde con la vereda (de x menor a mayor) y cuánto hay de ahí al edificio donde menos. */
  along: number[][];
  depth: number;
  /** Retoques del estilo (mismas claves). */
  set?: Record<string, unknown>;
}

/**
 * Carril de estacionamiento (config/streets → lane): entre la calzada de los datos y el bordillo
 * real, donde la avenida es más ancha que la que dibujan los datos. Autos en paralelo, en el
 * sentido del tránsito de su lado.
 */
export interface LaneStyle {
  /** Sobre el terreno: apenas, para no pelearse con la calzada de los datos. */
  lift: number;
  surface: { color: string; pattern: string; scale: number[] };
  /** Autos: cada cuánto, qué parte ocupada, a cuánto del bordillo va su centro y cuánto se deja libre en las puntas. */
  cars: { spacing: number; share: number; inset: number; margin: number };
}

/** El carril de una cuadra (lo arma build_street.py): contorno y el bordillo real (de x menor a mayor). */
export interface Lane {
  ring: number[][];
  along: number[][];
}

/** Lo que el retiro y el carril necesitan de la calle (world/street.ts). */
export interface LotKit {
  terrain(x: number, z: number): number;
  stone: Batch;
  detail: Batch;
  rails: Batch;
  /** Largo de los tramos con que lo que sigue el terreno (pisos, rejas) baja y sube con él. */
  step: number;
  /** Un piso que sigue el terreno a `lift` sobre él, con su dibujo. */
  pave(ring: number[][], lift: number, color: THREE.Color, surface: Surface): void;
  /** Un auto estacionado (marco de la calle): centro, hacia dónde mira la trompa (atan2(z, x)) y sobre qué piso. */
  car(x: number, z: number, angle: number, lift: number): void;
  /** Una palmera (marco de la calle; pie a la altura `y` del mundo). */
  palm(x: number, z: number, y: number, height: number): void;
  /** Una valla que ataja el paso (marco de la calle): de a a b, hasta `top` (mundo). */
  wall(a: THREE.Vector2, b: THREE.Vector2, top: number): void;
  /** Piso de la física a `offset` sobre el terreno. */
  ground(ring: number[][], offset: number): void;
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Semilla estable a partir de un id. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return (h >>> 0) % 100000;
}

/** Cuadrilátero plano a-b-c-d mirando hacia arriba (lo da vuelta si hace falta). */
function upQuad(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color): void {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
  if (n.y >= 0) batch.quad(a, b, c, d, color);
  else batch.quad(b, a, d, c, color);
}

/** Tramos libres de [a, b] (en x de la calle, sobre la recta de `along`) sin los `gaps`. */
function freeRuns(a: number, b: number, gaps: readonly number[][]): number[][] {
  let runs = [[a, b]];
  for (const [g0, g1] of gaps) {
    runs = runs.flatMap(([r0, r1]) => {
      if (g1 <= r0 || g0 >= r1) return [[r0, r1]];
      return [
        [r0, Math.max(r0, g0)],
        [Math.min(r1, g1), r1],
      ].filter(([p, q]) => q - p > 1e-3);
    });
  }
  return runs;
}

/** Falla al cargar si un estilo de retiro trae un largo que dejaría un bucle sin fin (0 o negativo). */
export function checkRetiro(style: RetiroStyle, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`Retiro ${where}: ${what} tiene que ser mayor que 0`);
  };
  if (style.stalls.width > 0 && style.stops.stripe <= 0) bad('stops.stripe');
  if (style.edge.kind === 'curb' && style.edge.stripe <= 0) bad('edge.stripe');
  if (style.edge.kind === 'fence' && (style.edge.posts[0] <= 0 || style.edge.posts[1] <= 0)) bad('edge.posts');
}

/** Falla al cargar si el carril no dice cada cuánto van sus autos. */
export function checkLane(style: LaneStyle, where: string): void {
  if (style.cars.spacing <= 0) throw new Error(`Carril ${where}: cars.spacing tiene que ser mayor que 0`);
}

/**
 * Arma un retiro: su piso, los puestos (líneas, topes y los autos que están), el borde con la
 * vereda (con sus entradas) y las palmeras.
 */
export function buildRetiro(r: Retiro, style: RetiroStyle, kit: LotKit): void {
  const c = colorsOf({ surface: style.surface.color, line: style.stalls.color });
  const seed = seedOf(r.id);
  kit.pave(r.ring, style.height, c.surface, { pattern: patternOf(style.surface.pattern), scale: style.surface.scale });
  kit.ground(r.ring, style.height);
  const a = new THREE.Vector2(r.along[0][0], r.along[0][1]);
  const b = new THREE.Vector2(r.along[1][0], r.along[1][1]);
  const len = a.distanceTo(b);
  if (len < 1e-3) return;
  const d = b.clone().sub(a).divideScalar(len);
  // Hacia adentro (de la vereda al edificio): el lado de la normal donde queda el contorno.
  let n = new THREE.Vector2(-d.y, d.x);
  const mid = r.ring.reduce((acc, p) => acc.add(new THREE.Vector2(p[0], p[1])), new THREE.Vector2()).divideScalar(r.ring.length);
  if (mid.clone().sub(a).dot(n) < 0) n = n.negate();
  const angle = Math.atan2(n.y, n.x);
  const at = (u: number, o: number): THREE.Vector2 => a.clone().addScaledVector(d, u).addScaledVector(n, o);
  const top = (p: THREE.Vector2): number => kit.terrain(p.x, p.y) + style.height;
  const P = (u: number, o: number, y: number): THREE.Vector3 => {
    const p = at(u, o);
    return new THREE.Vector3(p.x, top(p) + y, p.y);
  };
  // Las entradas, pasadas de x de la calle a u sobre el borde (que va de x menor a mayor).
  const toU = (x: number): number => ((x - a.x) / Math.max(b.x - a.x, 1e-3)) * len;
  const gaps = style.gaps.map(([g0, g1]) => [toU(g0), toU(g1)]);

  // Puestos en batería contra el fondo.
  const S = style.stalls;
  const lift = S.lift;
  const o1 = r.depth;
  const o0 = r.depth - S.depth;
  /** Dónde quedaron las líneas entre puestos (u), para correr ahí las palmeras. */
  const lines: number[] = [];
  const stalls = S.width > 0 && o0 >= 0;
  if (stalls) {
    let k = 0;
    const [sw, sh, sd] = style.stops.size;
    const stops = style.stops.colors.map((col) => new THREE.Color(col));
    for (const [u0, u1] of freeRuns(S.margin, len - S.margin, gaps)) {
      const count = Math.floor((u1 - u0) / S.width);
      if (count < 1) continue;
      const start = (u0 + u1 - count * S.width) / 2;
      for (let j = 0; j <= count; j++) {
        // Línea de puesto: del frente del puesto a la cabecera.
        const u = start + j * S.width;
        lines.push(u);
        upQuad(kit.detail, P(u - S.line / 2, o0, lift), P(u + S.line / 2, o0, lift), P(u + S.line / 2, o1, lift), P(u - S.line / 2, o1, lift), c.line);
      }
      for (let j = 0; j < count; j++) {
        const u = start + (j + 0.5) * S.width;
        // Tope de llanta en franjas, a `inset` de la cabecera.
        const stripes = Math.max(1, Math.round(sw / style.stops.stripe));
        for (let q = 0; q < stripes; q++) {
          const us = u - sw / 2 + (q + 0.5) * (sw / stripes);
          const p = at(us, o1 - style.stops.inset);
          const m = new THREE.Matrix4().makeRotationY(-angle).setPosition(p.x, top(p) + sh / 2, p.y);
          kit.detail.box(m, sd, sh, sw / stripes, stops[q % stops.length]);
        }
        if (rand(seed + k++, 3) < S.cars) {
          const p = at(u, (o0 + o1) / 2);
          kit.car(p.x, p.y, angle, style.height);
        }
      }
    }
  }

  // El borde con la vereda, sin las entradas.
  const E = style.edge;
  const ec = E.colors.map((col) => new THREE.Color(col));
  for (const [u0, u1] of E.kind === 'open' ? [] : freeRuns(0, len, gaps)) {
    const w = E.width;
    const box = (ua: number, ub: number, h: number, color: THREE.Color, surface: Surface = {}, y0 = 0): void => {
      const p = at((ua + ub) / 2, w / 2);
      const m = new THREE.Matrix4().makeRotationY(-angle).setPosition(p.x, top(p) + y0 + h / 2, p.y);
      kit.stone.box(m, w, h, ub - ua, color, surface);
    };
    if (E.kind === 'curb') {
      const stripes = Math.max(1, Math.round((u1 - u0) / E.stripe));
      for (let q = 0; q < stripes; q++) box(u0 + ((u1 - u0) * q) / stripes, u0 + ((u1 - u0) * (q + 1)) / stripes, E.height, ec[q % 2]);
    } else if (E.kind === 'planter') {
      box(u0, u1, E.height, ec[0], { pattern: PATTERN.stucco });
      const p0 = at(u0, w / 2);
      const p1 = at(u1, w / 2);
      kit.wall(p0, p1, Math.max(top(p0), top(p1)) + E.height);
    } else if (E.kind === 'fence') {
      box(u0, u1, E.height, ec[0], { pattern: PATTERN.stucco });
      const posts = Math.max(1, Math.round((u1 - u0) / E.posts[0]));
      for (let q = 0; q <= posts; q++) {
        const u = THREE.MathUtils.clamp(u0 + ((u1 - u0) * q) / posts, u0 + E.posts[1] / 2, u1 - E.posts[1] / 2);
        const p = at(u, w / 2);
        const m = new THREE.Matrix4().makeRotationY(-angle).setPosition(p.x, top(p) + (E.height + E.fence) / 2, p.y);
        kit.stone.box(m, E.posts[1], E.height + E.fence, E.posts[1], ec[2], { pattern: PATTERN.stucco });
      }
      // La reja: barrotes calados sobre el muro, en el plano del medio del muro, por tramos que
      // siguen el terreno.
      let u = u0;
      const steps = Math.max(1, Math.ceil((u1 - u0) / kit.step));
      for (let q = 0; q < steps; q++) {
        const ua = u0 + ((u1 - u0) * q) / steps;
        const ub = u0 + ((u1 - u0) * (q + 1)) / steps;
        const A = P(ua, w / 2, E.height);
        const B = P(ub, w / 2, E.height);
        kit.rails.quad(A, B, B.clone().setY(B.y + E.fence), A.clone().setY(A.y + E.fence), ec[1], { pattern: PATTERN.bars }, [u, 0, u + (ub - ua), 0, u + (ub - ua), E.fence, u, E.fence]);
        u += ub - ua;
      }
      const p0 = at(u0, w / 2);
      const p1 = at(u1, w / 2);
      kit.wall(p0, p1, Math.max(top(p0), top(p1)) + E.height + E.fence);
    }
  }

  // Palmeras a lo largo del borde; dentro de la franja de los puestos, en la línea entre dos
  // (un tronco no puede quedar donde se estaciona un auto).
  const Pm = style.palms;
  if (Pm.spacing > 0) {
    const inStalls = stalls && Pm.inset > o0 && lines.length > 0;
    const used = new Set<number>();
    let k = 0;
    for (const [u0, u1] of freeRuns(0, len, gaps)) {
      const count = Math.floor((u1 - u0) / Pm.spacing);
      for (let j = 0; j < count; j++) {
        let u = u0 + (u1 - u0 - (count - 1) * Pm.spacing) / 2 + j * Pm.spacing;
        if (inStalls) {
          const q = lines.reduce((best, v, i) => (!used.has(i) && (best < 0 || Math.abs(v - u) < Math.abs(lines[best] - u)) ? i : best), -1);
          if (q < 0) continue;
          used.add(q);
          u = lines[q];
        }
        const p = at(u, Pm.inset);
        kit.palm(p.x, p.y, top(p), THREE.MathUtils.lerp(Pm.height[0], Pm.height[1], rand(seed + k++, 5)));
      }
    }
  }
}

/**
 * Arma el carril de estacionamiento de una cuadra: su piso y los autos en paralelo, sin tapar las
 * entradas de los retiros (`entrances`: tramos en x de la calle).
 */
export function buildLane(l: Lane, style: LaneStyle, kit: LotKit, salt: string, entrances: readonly number[][]): void {
  kit.pave(l.ring, style.lift, new THREE.Color(style.surface.color), { pattern: patternOf(style.surface.pattern), scale: style.surface.scale });
  const a = new THREE.Vector2(l.along[0][0], l.along[0][1]);
  const b = new THREE.Vector2(l.along[1][0], l.along[1][1]);
  const len = a.distanceTo(b);
  if (len < 1e-3) return;
  const d = b.clone().sub(a).divideScalar(len);
  // Hacia la calzada: el lado de la normal donde queda el contorno.
  let n = new THREE.Vector2(-d.y, d.x);
  const mid = l.ring.reduce((acc, p) => acc.add(new THREE.Vector2(p[0], p[1])), new THREE.Vector2()).divideScalar(l.ring.length);
  if (mid.clone().sub(a).dot(n) < 0) n = n.negate();
  // Tránsito por la derecha: del lado norte (z > 0) se va hacia +x; del sur, hacia −x.
  const north = (a.y + b.y) / 2 > 0;
  const angle = Math.atan2(d.y, d.x) + (north ? 0 : Math.PI);
  const C = style.cars;
  const count = Math.floor((len - 2 * C.margin) / C.spacing);
  const seed = seedOf(salt);
  for (let k = 0; k < count; k++) {
    if (rand(seed + k, 7) >= C.share) continue;
    // El puesto entero, en x de la calle: si toca una entrada, queda libre.
    const xa = a.x + d.x * (C.margin + k * C.spacing);
    const xb = a.x + d.x * (C.margin + (k + 1) * C.spacing);
    if (entrances.some(([g0, g1]) => Math.min(xa, xb) < g1 && Math.max(xa, xb) > g0)) continue;
    const p = a.clone().addScaledVector(d, C.margin + (k + 0.5) * C.spacing).addScaledVector(n, C.inset);
    kit.car(p.x, p.y, angle, style.lift);
  }
}
