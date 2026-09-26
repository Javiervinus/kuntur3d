import * as THREE from 'three';
import { Batch, type Glow, type Surface, colorsOf, glowOf, patternOf } from './monumentParts';

/**
 * El parterre de una avenida de doble calzada (config/streets → median): el piso con su
 * bordillo, la cerca baja que lo bordea, los postes de luz de dos brazos (uno para cada
 * calzada) y los árboles. Largos en m.
 */
export interface MedianStyle {
  /** Alto del piso sobre la calzada, ancho del bordillo y su color. */
  height: number;
  curb: number;
  curbColor: string;
  /** Piso: color, dibujo (PATTERN) y cuántas unidades del dibujo mide cada metro. */
  surface: { color: string; pattern: string; scale: number[] };
  /** Cerca a lo largo de los dos bordes: a cuánto del bordillo, su alto, su dibujo (calado) y color. */
  fence: { inset: number; height: number; pattern: string; color: string };
  /**
   * Postes de dos brazos por el medio del parterre: cada cuánto como máximo y a cuánto de las
   * puntas van el primero y el último, hasta qué distancia se ven; el poste (alto, radio abajo y
   * arriba, lados, placa de la base: radio y alto), cada brazo (alcance hacia su calzada, cuánto
   * sube, radio, tramos de la curva), la luminaria LED (largo, alto, ancho, inclinación en grados;
   * su lente abajo: qué parte de la luminaria cubre y su grosor), su luz para el alumbrado
   * (potencia, 1 = un poste de la calle; LED o sodio) y la luz propia.
   */
  lamps: {
    spacing: number;
    margin: number;
    near: number;
    pole: { height: number; radius: number[]; sides: number; base: number[] };
    arm: { reach: number; rise: number; radius: number; segments: number };
    head: { size: number[]; tilt: number; lens: { share: number; thickness: number } };
    light: { power: number; led: boolean };
    glow: Glow;
  };
  /** Árboles: cada cuánto, desde dónde, a cuánto de las puntas y de un poste, alto y radio de copa (mín., máx.) y verdes. */
  trees: { spacing: number; phase: number; margin: number; clearance: number; height: number[]; radius: number[]; colors: string[] };
  colors: { pole: string; head: string; lens: string };
}

/** Un parterre de config/streets (lo arma build_street.py): su contorno, el borde sur y después el norte al revés. */
export interface Median {
  id: string;
  ring: number[][];
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Los dos bordes de un parterre (cada uno con x creciente) y su línea media. */
function edges(m: Median): { south: THREE.Vector2[]; north: THREE.Vector2[]; middle: THREE.Vector2[] } {
  const n = m.ring.length / 2;
  const south = m.ring.slice(0, n).map(([x, z]) => new THREE.Vector2(x, z));
  const north = m.ring
    .slice(n)
    .reverse()
    .map(([x, z]) => new THREE.Vector2(x, z));
  const middle = south.map((p, k) => p.clone().add(north[k]).multiplyScalar(0.5));
  return { south, north, middle };
}

/** Punto a `s` m a lo largo de una polilínea (y su largo total). */
function along(line: readonly THREE.Vector2[], s: number): THREE.Vector2 {
  let acc = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const d = line[k].distanceTo(line[k + 1]);
    if (acc + d >= s) return line[k].clone().lerp(line[k + 1], d > 0 ? (s - acc) / d : 0);
    acc += d;
  }
  return line[line.length - 1].clone();
}

function lengthOf(line: readonly THREE.Vector2[]): number {
  let acc = 0;
  for (let k = 0; k + 1 < line.length; k++) acc += line[k].distanceTo(line[k + 1]);
  return acc;
}

/** Dónde va cada poste (marco de la calle), parejos entre las puntas del parterre. */
export function medianLamps(style: MedianStyle, medians: readonly Median[]): { x: number; z: number }[] {
  const L = style.lamps;
  const out: { x: number; z: number }[] = [];
  for (const m of medians) {
    const { middle } = edges(m);
    const len = lengthOf(middle);
    const run = len - 2 * L.margin;
    if (run <= 0) continue;
    const gaps = Math.max(1, Math.ceil(run / L.spacing));
    for (let k = 0; k <= gaps; k++) {
      const p = along(middle, L.margin + (run * k) / gaps);
      out.push({ x: p.x, z: p.y });
    }
  }
  return out;
}

/**
 * Luces de los postes del parterre para el alumbrado: una por luminaria, a cada lado del poste
 * (hacia su calzada), con su altura sobre el pie y hacia dónde sale el brazo (ángulo local).
 */
export function medianLights(style: MedianStyle, medians: readonly Median[]): { x: number; z: number; h: number; out: number }[] {
  return medianLamps(style, medians).flatMap((l) => lampLightsAt(style.lamps, l.x, l.z, TWO_ARMS));
}

/** Los brazos del poste del parterre: uno hacia cada calzada (−z y +z del poste). */
const TWO_ARMS = [-1, 1] as const;

/** Un poste de brazos: el fuste, los brazos y la luminaria (lo común del parterre y de los postes de un lugar). */
export type LampStyle = Pick<MedianStyle['lamps'], 'pole' | 'arm' | 'head' | 'light' | 'glow'>;

/**
 * Las luces de un poste con pie en (x, z) y un brazo hacia cada lado de `sides` (±1 = hacia ±z del
 * poste, sin girar): una por luminaria, en su punta, con su altura sobre el pie y hacia dónde sale
 * (atan2(z, x) del marco del poste).
 */
export function lampLightsAt(lamps: LampStyle, x: number, z: number, sides: readonly number[]): { x: number; z: number; h: number; out: number }[] {
  const { pole, arm } = lamps;
  return sides.map((s) => ({ x, z: z + s * arm.reach, h: pole.height + arm.rise, out: s > 0 ? Math.PI / 2 : -Math.PI / 2 }));
}

/** Dónde van los árboles (marco de la calle), por la línea media, sin pisar un poste. */
export function medianTrees(style: MedianStyle, medians: readonly Median[]): { x: number; z: number; height: number; radius: number; color: THREE.Color }[] {
  const T = style.trees;
  if (T.spacing <= 0) return [];
  const greens = T.colors.map((c) => new THREE.Color(c));
  const lamps = medianLamps(style, medians);
  const out: { x: number; z: number; height: number; radius: number; color: THREE.Color }[] = [];
  let serial = 0;
  for (const m of medians) {
    const { middle } = edges(m);
    const len = lengthOf(middle);
    for (let s = T.margin + T.phase; s <= len - T.margin; s += T.spacing) {
      const p = along(middle, s);
      if (lamps.some((l) => Math.hypot(l.x - p.x, l.z - p.y) < T.clearance)) continue;
      const k = serial++;
      out.push({
        x: p.x,
        z: p.y,
        height: THREE.MathUtils.lerp(T.height[0], T.height[1], rand(k, 1)),
        radius: THREE.MathUtils.lerp(T.radius[0], T.radius[1], rand(k, 2)),
        color: greens[Math.floor(rand(k, 3) * greens.length) % greens.length],
      });
    }
  }
  return out;
}

/**
 * El poste de dos brazos (para instanciar; pie en el origen, brazos a lo largo de ±z): base,
 * fuste que se afina, dos brazos que suben curvándose hacia cada calzada y la luminaria LED
 * plana en cada punta, un poco inclinada hacia la calzada (su lente brilla de noche).
 */
export function medianLampModel(style: MedianStyle): THREE.BufferGeometry {
  return lampModel(style.lamps, style.colors, TWO_ARMS);
}

/**
 * Un poste de brazos (para instanciar; pie en el origen): base, fuste que se afina y un brazo con
 * su luminaria LED hacia cada lado de `sides` (±1 = hacia ±z; [1] es el poste de un brazo).
 */
export function lampModel(lamps: LampStyle, colors: MedianStyle['colors'], sides: readonly number[]): THREE.BufferGeometry {
  const c = colorsOf(colors);
  const { pole, arm, head } = lamps;
  const b = new Batch();
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}): void => {
    b.geometry(g, m, color, surface);
    g.dispose();
  };
  const at = (x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y, z);
  const [baseR, baseH] = pole.base;
  put(new THREE.CylinderGeometry(baseR, baseR, baseH, pole.sides), at(0, baseH / 2, 0), c.pole);
  const [r0, r1] = pole.radius;
  put(new THREE.CylinderGeometry(r1, r0, pole.height - baseH, pole.sides, 1, true), at(0, (pole.height + baseH) / 2, 0), c.pole);
  for (const s of sides) {
    // Brazo: un cuarto de elipse del fuste a la punta (sale horizontal, sube al principio).
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= arm.segments; k++) {
      const a = (k / arm.segments) * (Math.PI / 2);
      pts.push(new THREE.Vector3(0, pole.height - arm.radius + Math.sin(a) * arm.rise, s * (1 - Math.cos(a)) * arm.reach));
    }
    put(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), arm.segments * 2, arm.radius, pole.sides / 2), new THREE.Matrix4(), c.pole);
    const [hl, hh, hw] = head.size;
    const tip = pts[pts.length - 1];
    const tilt = new THREE.Matrix4().makeRotationX(s * THREE.MathUtils.degToRad(head.tilt));
    const m = at(0, tip.y, tip.z).multiply(tilt);
    b.box(m.clone().multiply(at(0, 0, 0)), hw, hh, hl, c.head);
    const { share, thickness } = head.lens;
    b.box(m.clone().multiply(at(0, -(hh + thickness) / 2, 0)), hw * share, thickness, hl * share, c.lens, { glow: glowOf(lamps.glow) });
  }
  return b.build();
}

/** Lo que el parterre necesita de la calle para armarse (world/street.ts). */
export interface MedianKit {
  terrain(x: number, z: number): number;
  stone: Batch;
  rails: Batch;
  /** Pisa el bordillo y el piso (lo mismo que una vereda, con el estilo del parterre). */
  pave(ring: number[][], curbs: number[], style: { height: number; curb: number; color: string; curbColor: string; pattern: string; scale: number[] }): void;
  /** Una valla baja que ataja el paso (marco de la calle): de a a b, hasta `top` (mundo). */
  wall(a: THREE.Vector2, b: THREE.Vector2, top: number): void;
}

/** Arma el piso, el bordillo y la cerca de un parterre (los postes y árboles van aparte). */
export function buildMedian(m: Median, style: MedianStyle, kit: MedianKit): void {
  kit.pave(
    m.ring,
    m.ring.map((_, k) => k),
    { height: style.height, curb: style.curb, color: style.surface.color, curbColor: style.curbColor, pattern: style.surface.pattern, scale: style.surface.scale },
  );
  const F = style.fence;
  const color = new THREE.Color(F.color);
  const surface: Surface = { pattern: patternOf(F.pattern) };
  const { south, north } = edges(m);
  // La cerca, `inset` hacia adentro de cada borde; uv en m (u a lo largo, v desde el pie).
  for (const [line, sign] of [
    [south, 1],
    [north, -1],
  ] as const) {
    let u = 0;
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k].clone().setY(line[k].y + sign * F.inset);
      const b = line[k + 1].clone().setY(line[k + 1].y + sign * F.inset);
      const len = a.distanceTo(b);
      if (len < 1e-3) continue;
      const ya = kit.terrain(a.x, a.y) + style.height;
      const yb = kit.terrain(b.x, b.y) + style.height;
      const A = new THREE.Vector3(a.x, ya, a.y);
      const B = new THREE.Vector3(b.x, yb, b.y);
      kit.rails.quad(A, B, B.clone().setY(yb + F.height), A.clone().setY(ya + F.height), color, surface, [u, 0, u + len, 0, u + len, F.height, u, F.height]);
      u += len;
      kit.wall(a, b, Math.max(ya, yb) + F.height);
    }
  }
}
