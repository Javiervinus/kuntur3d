import * as THREE from 'three';
import type { PavedStyle } from './street';

/**
 * Las veredas y los postes de luz de las calles internas de una urbanización (config/sites →
 * streets). Las calles mismas vienen de OSM y el juego ya las dibuja; aquí van sus veredas con el
 * bordillo, a los lados del eje medido de cada calle según su sección tipo, cortadas en los cruces
 * (la calle más larga sigue de corrido por la esquina; la otra llega hasta ella), y los postes de un
 * lado cada tanto. Todo sale del eje y la sección: nada se arma a mano.
 */

/** La sección tipo de un grupo de calles (medida en el satélite o en fotos). */
export interface StreetSection {
  /** Ancho de la calzada (de bordillo a bordillo) y de cada vereda desde el bordillo. */
  carriageway: number;
  sidewalk: number;
  /** La vereda: alto sobre la calzada, ancho del bordillo, colores, dibujo y escala (world/urbanizationParts.ts → curbed). */
  paved: PavedStyle;
  /**
   * La franja de detrás de la vereda hasta la fachada (el césped y los jardines del retiro), si la
   * lleva: ancho, cuánto sobre el terreno, color, dibujo y escala. Tapa lo que el satélite y las
   * calles de los datos pintan en el suelo donde no va.
   */
  verge?: { width: number; lift: number; color: string; pattern: string; scale: number[] };
  /**
   * Postes de luz de un solo lado: estilo (config → lamps), cada cuánto, de qué lado del eje (+1 =
   * a la derecha del recorrido, −1 = a la izquierda), a cuánto del bordillo hacia adentro de la
   * vereda y a cuánto del comienzo del eje va el primero.
   */
  lamps?: { style: string; spacing: number; side: number; inset: number; phase: number };
  source: string;
}

/**
 * Una calle: su eje medido (marco del lugar; si el primer y el último punto coinciden, es un anillo:
 * una rotonda, y lleva vereda solo por afuera), su sección, cuánto se corre el eje a la derecha del
 * recorrido (una calzada de una avenida cuyo eje medido va por el parterre), la otra calzada si es
 * un par con parterre (del lado que da a ella no va vereda), qué lados llevan vereda (+1 = a la
 * derecha del recorrido, −1 = a la izquierda; si no, los que correspondan), si lleva postes y de
 * dónde sale.
 */
export interface StreetAxis {
  id: string;
  section: string;
  axis: number[][];
  shift?: number;
  pair?: string;
  sides?: number[];
  lamps?: boolean;
  source: string;
}

/**
 * Las calles internas: cada cuánto se revisa el eje para encontrar los cruces, cuánto más allá del
 * borde de la calzada que cruza se corta una vereda, el largo mínimo de un tramo de vereda (lo más
 * corto no se arma), el lado de las celdas en que se reparten veredas y postes (cada celda es un
 * pedazo de la física y del LOD), las secciones y las calles.
 */
export interface UrbanStreets {
  sample: number;
  corner: number;
  minRun: number;
  cell: number;
  sections: Record<string, StreetSection>;
  list: StreetAxis[];
}

/** Una calle lista para consultar: su polilínea (ya corrida), largos acumulados, sección y sus lados con vereda. */
interface Axis {
  street: StreetAxis;
  section: StreetSection;
  pts: THREE.Vector2[];
  cum: number[];
  length: number;
  closed: boolean;
  sides: number[];
}

/** Un tramo de vereda: la calle, su contorno (marco del lugar), los lados con bordillo y el contorno de su franja de detrás (si la sección la lleva). */
export interface SidewalkRun {
  street: StreetAxis;
  section: StreetSection;
  ring: number[][];
  curbs: number[];
  verge: number[][] | null;
}

/** Un poste de luz de una calle: pie (marco del lugar), hacia dónde sale el brazo (atan2(z, x)), estilo y cuánto sobre el terreno. */
export interface StreetLamp {
  x: number;
  z: number;
  angle: number;
  style: string;
  lift: number;
}

/** Falla al cargar si las calles traen algo que no cierra (un largo ≤ 0 dejaría un bucle sin fin). */
export function checkStreets(S: UrbanStreets, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`Calles de ${where}: ${what}`);
  };
  if (!(S.sample > 0)) bad('sample tiene que ser mayor que 0');
  if (!(S.cell > 0)) bad('cell tiene que ser mayor que 0');
  for (const [name, s] of Object.entries(S.sections)) {
    if (!(s.carriageway > 0) || !(s.sidewalk > 0)) bad(`la sección ${name} necesita calzada y vereda mayores que 0`);
    if (s.verge && !(s.verge.width > 0)) bad(`la sección ${name}: verge.width tiene que ser mayor que 0`);
    if (s.lamps && !(s.lamps.spacing > 0)) bad(`la sección ${name}: lamps.spacing tiene que ser mayor que 0`);
  }
  const ids = new Set(S.list.map((st) => st.id));
  for (const st of S.list) {
    if (!Object.hasOwn(S.sections, st.section)) bad(`la calle ${st.id} tiene una sección que no existe: ${st.section}`);
    if (st.pair !== undefined && (!ids.has(st.pair) || st.pair === st.id)) bad(`la calle ${st.id} tiene un par que no existe: ${st.pair}`);
    if (st.axis.length < 2) bad(`la calle ${st.id} necesita al menos dos puntos`);
    for (const s of st.sides ?? []) if (s !== 1 && s !== -1) bad(`la calle ${st.id}: sides lleva 1 o -1`);
  }
}

/** Una polilínea corrida `d` a la derecha del recorrido (esquinas a inglete). */
function shifted(pts: readonly THREE.Vector2[], d: number, closed: boolean): THREE.Vector2[] {
  if (!d) return pts.map((p) => p.clone());
  const n = pts.length;
  const normal = (a: THREE.Vector2, b: THREE.Vector2): THREE.Vector2 => {
    const e = b.clone().sub(a).normalize();
    return new THREE.Vector2(-e.y, e.x);
  };
  return pts.map((p, k) => {
    const prev = k > 0 ? pts[k - 1] : closed ? pts[n - 2] : null;
    const next = k < n - 1 ? pts[k + 1] : closed ? pts[1] : null;
    const n0 = prev ? normal(prev, p) : null;
    const n1 = next ? normal(p, next) : null;
    const m = (n0 && n1 ? n0.clone().add(n1) : (n0 ?? n1 ?? new THREE.Vector2())).normalize();
    const cos = n0 ? Math.max(MITER, m.dot(n0)) : 1;
    return p.clone().addScaledVector(m, d / cos);
  });
}

/** Área con signo de un anillo (en el sentido del recorrido; > 0: el adentro queda a la derecha). */
function signedArea(pts: readonly THREE.Vector2[]): number {
  let a = 0;
  for (let k = 0; k + 1 < pts.length; k++) a += pts[k].x * pts[k + 1].y - pts[k + 1].x * pts[k].y;
  return a / 2;
}

/** Las calles con sus largos y sus lados con vereda (se arman una vez por config). */
function axesOf(S: UrbanStreets): Axis[] {
  const axes = S.list.map((street) => {
    const raw = street.axis.map(([x, z]) => new THREE.Vector2(x, z));
    const closed = raw.length > 2 && raw[0].distanceTo(raw[raw.length - 1]) < 1e-3;
    const pts = shifted(raw, street.shift ?? 0, closed);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + pts[k].distanceTo(pts[k - 1]));
    // Un anillo, solo por afuera: con área positiva el adentro queda a la derecha.
    const sides = street.sides ?? (closed ? [signedArea(pts) > 0 ? -1 : 1] : [-1, 1]);
    return { street, section: S.sections[street.section], pts, cum, length: cum[cum.length - 1], closed, sides };
  });
  // Un par con parterre: sin vereda del lado que da a la otra calzada.
  for (const a of axes) {
    const other = a.street.pair === undefined || a.street.sides ? undefined : axes.find((b) => b.street.id === a.street.pair);
    if (!other) continue;
    const f = frameAt(a, a.length / 2);
    const reach = a.section.carriageway / 2 + a.section.sidewalk;
    const right = distanceTo(f.p.clone().addScaledVector(f.n, reach), other);
    const left = distanceTo(f.p.clone().addScaledVector(f.n, -reach), other);
    a.sides = [right < left ? -1 : 1];
  }
  return axes;
}

/** Distancia de un punto a una polilínea. */
function distanceTo(p: THREE.Vector2, a: Axis): number {
  let best = Infinity;
  for (let k = 0; k + 1 < a.pts.length; k++) {
    const s = a.pts[k];
    const e = a.pts[k + 1];
    const dx = e.x - s.x;
    const dz = e.y - s.y;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? THREE.MathUtils.clamp(((p.x - s.x) * dx + (p.y - s.y) * dz) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dz)));
  }
  return best;
}

/** El punto del eje a `s` m y la normal a la derecha del recorrido (en los vértices, a inglete). */
function frameAt(a: Axis, s: number, vertex = -1): { p: THREE.Vector2; n: THREE.Vector2; miter: number } {
  const L = a.length;
  const t = a.closed ? ((s % L) + L) % L : THREE.MathUtils.clamp(s, 0, L);
  let k = 0;
  while (k + 2 < a.pts.length && a.cum[k + 1] < t) k++;
  const p0 = a.pts[k];
  const p1 = a.pts[k + 1];
  const len = a.cum[k + 1] - a.cum[k];
  const p = len > 0 ? p0.clone().lerp(p1, (t - a.cum[k]) / len) : p0.clone();
  const normal = (i: number): THREE.Vector2 => {
    const q0 = a.pts[i];
    const q1 = a.pts[i + 1];
    const d = q1.clone().sub(q0).normalize();
    return new THREE.Vector2(-d.y, d.x);
  };
  if (vertex < 0) return { p, n: normal(k), miter: 1 };
  // En un vértice: la normal media de los dos lados y cuánto se alarga para no angostar la vereda.
  const last = a.pts.length - 2;
  const before = vertex > 0 ? vertex - 1 : a.closed ? last : 0;
  const after = vertex <= last ? vertex : a.closed ? 0 : last;
  const n0 = normal(before);
  const n1 = normal(after);
  const n = n0.clone().add(n1);
  if (n.lengthSq() < 1e-8) return { p: a.pts[vertex].clone(), n: n0, miter: 1 };
  n.normalize();
  return { p: a.pts[vertex].clone(), n, miter: 1 / Math.max(MITER, n.dot(n0)) };
}

/** Coseno mínimo del inglete en un vértice del eje (una vuelta muy cerrada no estira la vereda más de 1 / MITER veces). */
const MITER = 0.5;

/**
 * Quién corta una vereda en un punto: 'road' si cae en la calzada de otra calle (más `corner`),
 * 'walk' si cae en la vereda de una calle más larga (que sigue de corrido), o nada.
 */
function blockerAt(p: THREE.Vector2, self: Axis, axes: readonly Axis[], corner: number): 'road' | 'walk' | null {
  let walk = false;
  for (const a of axes) {
    if (a === self) continue;
    const half = a.section.carriageway / 2;
    const d = distanceTo(p, a);
    if (d < half + corner) return 'road';
    if (a.length > self.length && d < half + a.section.sidewalk) walk = true;
  }
  return walk ? 'walk' : null;
}

/** Las calles cercanas a cada una (las que pueden cortar sus veredas). */
function neighbours(axes: readonly Axis[], reach: number): Map<Axis, Axis[]> {
  const box = axes.map((a) => {
    const xs = a.pts.map((p) => p.x);
    const zs = a.pts.map((p) => p.y);
    return { x0: Math.min(...xs) - reach, x1: Math.max(...xs) + reach, z0: Math.min(...zs) - reach, z1: Math.max(...zs) + reach };
  });
  const out = new Map<Axis, Axis[]>();
  axes.forEach((a, i) => {
    out.set(
      a,
      axes.filter((_, j) => j !== i && box[i].x0 <= box[j].x1 && box[j].x0 <= box[i].x1 && box[i].z0 <= box[j].z1 && box[j].z0 <= box[i].z1),
    );
  });
  return out;
}

/**
 * Los tramos de vereda de todas las calles: a cada lado del eje, de la calzada a la vereda, sin lo
 * que cae en la calzada de otra (o en la vereda de una más larga). El borde exacto de cada corte se
 * busca por bisección; el lado del tramo que da a una calzada lleva bordillo.
 */
export function sidewalkRuns(S: UrbanStreets): SidewalkRun[] {
  const axes = axesOf(S);
  const reach = Math.max(...axes.map((a) => a.section.carriageway / 2 + a.section.sidewalk)) * 2 + S.corner;
  const near = neighbours(axes, reach);
  const out: SidewalkRun[] = [];
  for (const a of axes) {
    const w = a.section.carriageway / 2;
    const sw = a.section.sidewalk;
    const others = near.get(a) ?? [];
    for (const side of a.sides) {
      const mid = (s: number): THREE.Vector2 => {
        const f = frameAt(a, s);
        return f.p.addScaledVector(f.n, side * (w + sw / 2));
      };
      const blocked = (s: number): 'road' | 'walk' | null => blockerAt(mid(s), a, others, S.corner);
      const n = Math.max(2, Math.ceil(a.length / S.sample));
      const at = (k: number): number => (a.length * k) / n;
      const edge = (free: number, cut: number): number => {
        // Bisección entre un punto libre y uno cortado: el borde del corte.
        let lo = free;
        let hi = cut;
        for (let i = 0; i < BISECTIONS; i++) {
          const m = (lo + hi) / 2;
          if (blocked(m) === null) lo = m;
          else hi = m;
        }
        return lo;
      };
      // Muestras del eje (en un anillo, la última es la primera) y lo que las corta.
      const count = a.closed ? n : n + 1;
      const state = Array.from({ length: count }, (_, k) => blocked(at(k)));
      const runs: { s0: number; s1: number; cap0: boolean; cap1: boolean }[] = [];
      if (a.closed && state.every((v) => v === null)) {
        // Un anillo sin cortes: dos mitades (un contorno no puede tener agujero).
        runs.push({ s0: 0, s1: a.length / 2, cap0: false, cap1: false }, { s0: a.length / 2, s1: a.length, cap0: false, cap1: false });
      } else {
        // En un anillo se arranca en una muestra cortada, para no partir un tramo en dos; las
        // muestras siguen corridas (s puede pasar del largo: frameAt da la vuelta).
        const first = a.closed ? state.findIndex((v) => v !== null) : 0;
        const stateAt = (j: number): 'road' | 'walk' | null => (a.closed ? state[(first + j) % n] : state[j]);
        const total = a.closed ? n : n + 1;
        let j = 0;
        while (j < total) {
          if (stateAt(j) !== null) {
            j++;
            continue;
          }
          const j0 = j;
          while (j + 1 < total && stateAt(j + 1) === null) j++;
          const j1 = j;
          const before = a.closed || j0 > 0 ? stateAt((j0 - 1 + total) % total) : null;
          const after = a.closed || j1 < total - 1 ? stateAt((j1 + 1) % total) : null;
          const s0 = before !== null ? edge(at(first + j0), at(first + j0 - 1)) : at(first + j0);
          const s1 = after !== null ? edge(at(first + j1), at(first + j1 + 1)) : at(first + j1);
          runs.push({ s0, s1, cap0: before === 'road', cap1: after === 'road' });
          j++;
        }
      }
      const verge = a.section.verge;
      for (const r of runs) {
        if (r.s1 - r.s0 < S.minRun) continue;
        const run = ringOf(a, r.s0, r.s1, side, w, w + sw, r.cap0, r.cap1);
        // La franja de detrás, en el mismo tramo que su vereda (sin bordillos).
        if (verge) run.verge = ringOf(a, r.s0, r.s1, side, w + sw, w + sw + verge.width, false, false).ring;
        out.push(run);
      }
    }
  }
  return out;
}

/** Pasos de la bisección que busca el borde de un corte (cada paso parte el error a la mitad). */
const BISECTIONS = 8;

/** El contorno de un tramo de vereda entre s0 y s1: la línea del bordillo y, de vuelta, la de adentro. */
function ringOf(a: Axis, s0: number, s1: number, side: number, d0: number, d1: number, cap0: boolean, cap1: boolean): SidewalkRun {
  // Los puntos del tramo: sus puntas y los vértices del eje que quedan adentro (con su inglete).
  const stops: { s: number; vertex: number }[] = [{ s: s0, vertex: -1 }];
  const L = a.length;
  // En un anillo el punto de cierre también es un vértice, y el tramo puede dar la vuelta.
  const lastVertex = a.closed ? a.pts.length - 1 : a.pts.length - 2;
  for (let turn = 0; turn <= (a.closed ? 1 : 0); turn++) {
    for (let k = 1; k <= lastVertex; k++) {
      const s = a.cum[k] + turn * L;
      if (s > s0 + 1e-3 && s < s1 - 1e-3) stops.push({ s, vertex: k });
    }
  }
  stops.push({ s: s1, vertex: -1 });
  stops.sort((p, q) => p.s - q.s);
  const inner: number[][] = [];
  const outer: number[][] = [];
  for (const st of stops) {
    const f = frameAt(a, st.s, st.vertex);
    const pi = f.p.clone().addScaledVector(f.n, side * d0 * f.miter);
    const po = f.p.clone().addScaledVector(f.n, side * d1 * f.miter);
    inner.push([pi.x, pi.y]);
    outer.push([po.x, po.y]);
  }
  const n = inner.length;
  const ring = [...inner, ...outer.reverse()];
  // Lados: el bordillo (de la calzada propia) y las puntas que dan a otra calzada.
  const curbs = Array.from({ length: n - 1 }, (_, k) => k);
  if (cap1) curbs.push(n - 1);
  if (cap0) curbs.push(2 * n - 1);
  return { street: a.street, section: a.section, ring, curbs, verge: null };
}

/** Los postes de luz de las calles: de un lado, cada tanto, sin caer en un cruce; el brazo hacia la calzada. */
export function streetLamps(S: UrbanStreets): StreetLamp[] {
  const axes = axesOf(S);
  const reach = Math.max(...axes.map((a) => a.section.carriageway / 2 + a.section.sidewalk)) * 2 + S.corner;
  const near = neighbours(axes, reach);
  const out: StreetLamp[] = [];
  for (const a of axes) {
    const Lp = a.section.lamps;
    if (!Lp || a.street.lamps === false) continue;
    const others = near.get(a) ?? [];
    const off = a.section.carriageway / 2 + Lp.inset;
    // Del lado de la sección, si ahí hay vereda; si no, del otro.
    const side = a.sides.includes(Lp.side) ? Lp.side : a.sides[0];
    for (let s = Lp.phase; s <= a.length; s += Lp.spacing) {
      const f = frameAt(a, s);
      const mid = f.p.clone().addScaledVector(f.n, side * (a.section.carriageway / 2 + a.section.sidewalk / 2));
      if (blockerAt(mid, a, others, S.corner) !== null) continue;
      const foot = f.p.clone().addScaledVector(f.n, side * off);
      out.push({ x: foot.x, z: foot.y, angle: Math.atan2(-side * f.n.y, -side * f.n.x), style: Lp.style, lift: a.section.paved.height });
    }
  }
  return out;
}
