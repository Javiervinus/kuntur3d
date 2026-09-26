import * as THREE from 'three';
import { type Batch, type Glow, PATTERN, type Surface, glowOf, patternOf } from './monumentParts';
import type { PlaceLight, PlaceSite } from './placeKit';

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
const DEG = Math.PI / 180;
const IDENTITY = new THREE.Matrix4();

/**
 * Planta de una torre (config/sites → shaft.plan): un rectángulo con las esquinas redondeadas de
 * una de dos maneras. Con `fillet`, un redondeo tangente a las caras (un rectángulo de esquinas
 * redondas: The Point, 32 × 32 m con esquinas de 10 m de radio). Con `radius`, un círculo
 * concéntrico que las recorta: con el radio mayor que la media diagonal quedan vivas; menor que la
 * media cara, un círculo; en el medio, caras rectas y esquinas en arco con un quiebre donde se
 * juntan. Largos en m.
 */
export interface TowerPlan {
  /** Lados del rectángulo, a lo largo de x y de z de la planta sin girar. */
  size: number[];
  /** Radio del círculo concéntrico que recorta las esquinas (0 = sin recorte; con `fillet` > 0, va en 0). */
  radius: number;
  /** Radio del redondeo tangente de las esquinas (0 = sin redondeo; a lo sumo la mitad del lado más corto). */
  fillet: number;
  /** Tramos de un cuarto de círculo (un arco más corto lleva menos, al menos uno). */
  segments: number;
}

/**
 * Un tramo del contorno de una planta (un lado recto o un arco): puntos (x, z del marco local) y la
 * normal hacia afuera en cada uno. Van en el sentido en que (siguiente − actual) × arriba apunta
 * hacia afuera, y el último punto de un tramo es el primero del siguiente (en el quiebre entre
 * un lado y un arco la normal cambia de golpe: las caras no se suavizan ahí).
 */
export interface PlanRun {
  points: THREE.Vector2[];
  normals: THREE.Vector2[];
}

/** Un lado recto (`arc` falso, en la cara `face`) o el arco que va de la cara `face` a la `next`, en `n` tramos. */
interface PlanPiece {
  arc: boolean;
  face: number;
  next: number;
  n: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const dir = (a: number): THREE.Vector2 => new THREE.Vector2(Math.cos(a), Math.sin(a));

/**
 * La planta de una torre con su eje en (x, z): su contorno corrido `o` m hacia afuera (negativo,
 * hacia adentro) y girado `angle` rad. Las caras de la planta corrida siguen siendo rectas y los
 * arcos, del círculo corrido (así se corre una figura convexa): los puntos de cada tramo se
 * corresponden de un corrimiento al otro, y un perfil barrido por el contorno no se abre en los
 * quiebres.
 */
export class PlanShape {
  /** Distancia del eje a cada cara: +x, +z, −x, −z de la planta sin girar. */
  private readonly faces: number[];
  private readonly radius: number;
  /** Radio del redondeo tangente de las esquinas (tipo `rounded`). */
  private readonly fillet: number;
  private readonly kind: 'rect' | 'circle' | 'clipped' | 'rounded';
  private readonly pieces: PlanPiece[] = [];
  /** Tramos de cada esquina redondeada (tipo `rounded`). */
  private readonly segments: number;

  constructor(
    plan: TowerPlan,
    readonly x: number,
    readonly z: number,
  ) {
    const [sx, sz] = plan.size;
    this.faces = [sx / 2, sz / 2, sx / 2, sz / 2];
    this.radius = plan.radius > 0 ? plan.radius : Infinity;
    this.fillet = Math.min(Math.max(plan.fillet, 0), sx / 2, sz / 2);
    this.segments = Math.max(1, plan.segments);
    const R = this.radius;
    if (this.fillet > 0) {
      this.kind = 'rounded';
      return;
    }
    if (R >= Math.hypot(sx / 2, sz / 2)) {
      this.kind = 'rect';
      return;
    }
    const faces = [0, 1, 2, 3].filter((i) => R > this.faces[i]);
    if (!faces.length) {
      this.kind = 'circle';
      this.pieces.push({ arc: true, face: 0, next: 0, n: 4 * plan.segments });
      return;
    }
    this.kind = 'clipped';
    faces.forEach((i, k) => {
      const j = faces[(k + 1) % faces.length];
      const a0 = i * QUARTER + Math.acos(this.faces[i] / R);
      let a1 = j * QUARTER - Math.acos(this.faces[j] / R);
      while (a1 <= a0) a1 += TAU;
      this.pieces.push({ arc: false, face: i, next: j, n: 1 });
      this.pieces.push({ arc: true, face: i, next: j, n: Math.max(1, Math.round(((a1 - a0) / QUARTER) * plan.segments)) });
    });
  }

  /** El contorno corrido `o` m hacia afuera y girado `angle` rad, en tramos (ver PlanRun). */
  runs(o: number, angle: number): PlanRun[] {
    const R = this.radius + o;
    const h = this.faces.map((f) => f + o);
    const out: PlanRun[] = [];
    if (this.kind === 'rounded') {
      // Esquina k (entre la cara k y la k + 1): el centro de su arco y el radio corrido.
      const f = this.fillet;
      const rf = Math.max(0, f + o);
      const center = (k: number): THREE.Vector2 =>
        new THREE.Vector2(k === 0 || k === 3 ? this.faces[0] - f : -(this.faces[2] - f), k < 2 ? this.faces[1] - f : -(this.faces[3] - f));
      for (let i = 0; i < 4; i++) {
        const n = dir(i * QUARTER);
        out.push({ points: [center((i + 3) % 4).addScaledVector(n, rf), center(i).addScaledVector(n, rf)], normals: [n, n.clone()] });
        const c = center(i);
        const pts: THREE.Vector2[] = [];
        const nor: THREE.Vector2[] = [];
        for (let k = 0; k <= this.segments; k++) {
          const a = (i + k / this.segments) * QUARTER;
          pts.push(c.clone().addScaledVector(dir(a), rf));
          nor.push(dir(a));
        }
        out.push({ points: pts, normals: nor });
      }
    } else if (this.kind === 'rect') {
      // Esquina k: entre la cara k y la k + 1 (+x+z, −x+z, −x−z, +x−z).
      const corner = (k: number): THREE.Vector2 => new THREE.Vector2(k === 0 || k === 3 ? h[0] : -h[2], k < 2 ? h[1] : -h[3]);
      for (let i = 0; i < 4; i++) {
        const n = dir(i * QUARTER);
        out.push({ points: [corner((i + 3) % 4), corner(i)], normals: [n, n.clone()] });
      }
    } else {
      for (const p of this.pieces) {
        if (this.kind === 'circle') {
          const pts: THREE.Vector2[] = [];
          const nor: THREE.Vector2[] = [];
          for (let k = 0; k <= p.n; k++) {
            const a = (k / p.n) * TAU;
            pts.push(dir(a).multiplyScalar(R));
            nor.push(dir(a));
          }
          out.push({ points: pts, normals: nor });
          continue;
        }
        const ai = Math.acos(clamp(h[p.face] / R, -1, 1));
        const c = p.face * QUARTER;
        if (!p.arc) {
          out.push({ points: [dir(c - ai).multiplyScalar(R), dir(c + ai).multiplyScalar(R)], normals: [dir(c), dir(c)] });
          continue;
        }
        const aj = Math.acos(clamp(h[p.next] / R, -1, 1));
        const a0 = c + ai;
        let a1 = p.next * QUARTER - aj;
        while (a1 <= a0) a1 += TAU;
        const pts: THREE.Vector2[] = [];
        const nor: THREE.Vector2[] = [];
        for (let k = 0; k <= p.n; k++) {
          const a = a0 + ((a1 - a0) * k) / p.n;
          pts.push(dir(a).multiplyScalar(R));
          nor.push(dir(a));
        }
        out.push({ points: pts, normals: nor });
      }
    }
    // Al marco local (girada y en su eje) y en el sentido que deja las caras hacia afuera.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const turn = (v: THREE.Vector2, shift: boolean): THREE.Vector2 =>
      new THREE.Vector2(v.x * c - v.y * s + (shift ? this.x : 0), v.x * s + v.y * c + (shift ? this.z : 0));
    return out.reverse().map((r) => ({ points: r.points.map((q) => turn(q, true)).reverse(), normals: r.normals.map((q) => turn(q, false)).reverse() }));
  }

  /** Distancia del eje al contorno corrido `o` y girado `angle`, en la dirección `phi` (rad, marco local). */
  reach(phi: number, o: number, angle: number): number {
    const a = phi - angle;
    let r = this.kind === 'rect' || this.kind === 'rounded' ? Infinity : this.radius + o;
    if (this.kind !== 'circle') {
      for (let i = 0; i < 4; i++) {
        const cos = Math.cos(a - i * QUARTER);
        if (cos > 1e-9) r = Math.min(r, (this.faces[i] + o) / cos);
      }
    }
    if (this.kind === 'rounded') {
      // Si el rayo sale por una esquina (fuera de los tramos rectos), corta su arco.
      const d = dir(a);
      const f = this.fillet;
      const cx = this.faces[d.x >= 0 ? 0 : 2] - f;
      const cz = this.faces[d.y >= 0 ? 1 : 3] - f;
      if (Math.abs(d.x * r) > cx && Math.abs(d.y * r) > cz) {
        const c = new THREE.Vector2(Math.sign(d.x) * cx, Math.sign(d.y) * cz);
        const rf = Math.max(0, f + o);
        const b = d.dot(c);
        r = b + Math.sqrt(Math.max(0, b * b - c.lengthSq() + rf * rf));
      }
    }
    return r;
  }
}

/** Un punto del perfil que se barre por el contorno: cuánto sale de él (`o`), a qué alto (`y`, del mundo) y su normal (hacia afuera, hacia arriba). */
interface ProfilePoint {
  o: number;
  y: number;
  no: number;
  ny: number;
}

/**
 * Perfil de una franja de losa (o de un anillo, con `closed`): la cara de abajo desde `inner`
 * hasta el canto en `outer`, el canto redondeado (radio `round`, en `segments` tramos por
 * esquina) y la cara de arriba de vuelta hasta `inner`. Cerrado, suma la cara de adentro (un
 * anillo que se ve desde la terraza). Tiras separadas donde el perfil hace quiebre.
 */
function bandProfile(y0: number, y1: number, outer: number, inner: number, round: number, segments: number, closed: boolean): ProfilePoint[][] {
  const r = Math.max(0, Math.min(round, (y1 - y0) / 2, outer - inner));
  const strips: ProfilePoint[][] = [];
  if (r <= 0) {
    strips.push(
      [
        { o: inner, y: y0, no: 0, ny: -1 },
        { o: outer, y: y0, no: 0, ny: -1 },
      ],
      [
        { o: outer, y: y0, no: 1, ny: 0 },
        { o: outer, y: y1, no: 1, ny: 0 },
      ],
      [
        { o: outer, y: y1, no: 0, ny: 1 },
        { o: inner, y: y1, no: 0, ny: 1 },
      ],
    );
  } else {
    const strip: ProfilePoint[] = [{ o: inner, y: y0, no: 0, ny: -1 }];
    const n = Math.max(1, segments);
    for (let k = 0; k <= n; k++) {
      const a = -QUARTER + (QUARTER * k) / n;
      strip.push({ o: outer - r + r * Math.cos(a), y: y0 + r + r * Math.sin(a), no: Math.cos(a), ny: Math.sin(a) });
    }
    for (let k = 0; k <= n; k++) {
      const a = (QUARTER * k) / n;
      strip.push({ o: outer - r + r * Math.cos(a), y: y1 - r + r * Math.sin(a), no: Math.cos(a), ny: Math.sin(a) });
    }
    strip.push({ o: inner, y: y1, no: 0, ny: 1 });
    strips.push(strip);
  }
  if (closed) {
    strips.push([
      { o: inner, y: y1, no: -1, ny: 0 },
      { o: inner, y: y0, no: -1, ny: 0 },
    ]);
  }
  return strips;
}

/**
 * Barre las tiras de un perfil por el contorno de una planta girada `angle`: una geometría con
 * normales suaves a lo largo de cada tramo (los arcos se ven redondos) y en cada tira del perfil.
 */
function sweep(batch: Batch, plan: PlanShape, angle: number, strips: ProfilePoint[][], color: THREE.Color, surface: Surface): void {
  const cache = new Map<number, PlanRun[]>();
  const runsAt = (o: number): PlanRun[] => {
    let r = cache.get(o);
    if (!r) {
      r = plan.runs(o, angle);
      cache.set(o, r);
    }
    return r;
  };
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  for (const strip of strips) {
    const rings = strip.map((p) => runsAt(p.o));
    for (let r = 0; r < rings[0].length; r++) {
      const count = rings[0][r].points.length;
      const first = position.length / 3;
      strip.forEach((pp, j) => {
        const run = rings[j][r];
        for (let i = 0; i < count; i++) {
          const q = run.points[i];
          const n = run.normals[i];
          position.push(q.x, pp.y, q.y);
          normal.push(n.x * pp.no, pp.ny, n.y * pp.no);
        }
      });
      for (let j = 0; j + 1 < strip.length; j++) {
        for (let i = 0; i + 1 < count; i++) {
          const a = first + j * count + i;
          index.push(a, a + 1, a + count + 1, a, a + count + 1, a + count);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setIndex(index);
  batch.geometry(g, IDENTITY, color, surface);
  g.dispose();
}

/** Los tramos rectos de un contorno (de a a b, con su largo). */
function segmentsOf(runs: PlanRun[]): { a: THREE.Vector2; b: THREE.Vector2; na: THREE.Vector2; nb: THREE.Vector2; len: number }[] {
  const out: { a: THREE.Vector2; b: THREE.Vector2; na: THREE.Vector2; nb: THREE.Vector2; len: number }[] = [];
  for (const r of runs) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const len = r.points[i].distanceTo(r.points[i + 1]);
      if (len > 1e-6) out.push({ a: r.points[i], b: r.points[i + 1], na: r.normals[i], nb: r.normals[i + 1], len });
    }
  }
  return out;
}

/**
 * Puntos repartidos parejo por un contorno, uno cada ~`spacing` m (al medio de cada tramo de
 * reparto), con la normal hacia afuera en cada uno.
 */
export function along(runs: PlanRun[], spacing: number): { p: THREE.Vector2; n: THREE.Vector2 }[] {
  const segs = segmentsOf(runs);
  const total = segs.reduce((acc, s) => acc + s.len, 0);
  const count = Math.max(1, Math.round(total / spacing));
  const out: { p: THREE.Vector2; n: THREE.Vector2 }[] = [];
  let k = 0;
  let acc = 0;
  for (const s of segs) {
    while (k < count && ((k + 0.5) * total) / count <= acc + s.len) {
      const t = (((k + 0.5) * total) / count - acc) / s.len;
      out.push({ p: s.a.clone().lerp(s.b, t), n: s.na.clone().lerp(s.nb, t).normalize() });
      k++;
    }
    acc += s.len;
  }
  return out;
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Un vidrio con su carpintería (config/sites → shaft.glazings). */
export interface Glazing {
  /** Color del vidrio y tono de la carpintería respecto de él (0…1, ver PATTERN.glazing). */
  color: string;
  tone: number;
  /** Ancho buscado de cada paño entre parantes (m) y hojas de cada paño [a lo ancho, a lo alto]. */
  module: number;
  panes: number[];
  /** Parte de los paños encendidos de noche y su luz. */
  share: number;
  glow: Glow;
  /** Oclusión al pie del paño y arriba, bajo la franja que vuela (0…1). */
  ao: number[];
  /** Su acabado (una clave de `finishes` del archivo). */
  finish: string;
}

/** Pisos iguales seguidos del fuste, desde abajo (el primero es la planta baja). */
export interface ShaftFloors {
  /** Cuántos pisos así. */
  count: number;
  /** Alto de cada uno, de losa a losa (m). */
  height: number;
  /** Alto de la franja blanca que lo remata arriba: el canto de la losa de arriba con su antepecho (m). */
  band: number;
  /** Cuánto se mete su vidrio detrás del canto de las franjas (m; en la planta baja, el fondo del soportal). */
  inset: number;
  /** Su vidrio (una clave de `glazings`). */
  glazing: string;
}

/**
 * El fuste de una torre de planta repetida que gira (o no) piso a piso (config/sites → shaft):
 * cada piso es una franja de losa redondeada y una banda de vidrio metida detrás; la planta de
 * cada losa gira según la tabla `twist`. Largos en m; alturas desde la base del lugar.
 */
export interface ShaftStyle {
  /** Eje de la torre (marco local). */
  center: number[];
  plan: TowerPlan;
  /** Alto del piso de la planta baja (el nivel 0) sobre la base. */
  lift: number;
  floors: ShaftFloors[];
  glazings: Record<string, Glazing>;
  /**
   * Giro de la planta en cada nivel de losa (nivel 0 = el piso de la planta baja; nivel k = el
   * tope del piso k), en filas [nivel, grados] de nivel creciente. Grados como atan2(z, x) del
   * marco local: positivo = horario visto desde arriba. Entre filas se interpola; fuera de la
   * tabla queda el de la punta. El vidrio de un piso gira con la losa en que se apoya.
   */
  twist: number[][];
  band: {
    /** Radio del redondeo del canto y tramos de cada esquina del perfil. */
    round: number;
    segments: number;
    /**
     * Cuánto siguen la cara de arriba y la de abajo de cada franja por detrás del vidrio más
     * metido de los dos pisos que separa: tapan el quiebre entre dos plantas giradas.
     */
    overlap: number;
    color: string;
    /** Oclusión de la cara de arriba y de la de abajo (el cielo del soportal) de las franjas. */
    ao: { top: number; soffit: number };
  };
  /** El zócalo del contorno: del terreno (menos lo enterrado) al nivel 0, en la línea del vidrio de la planta baja. */
  skirt: { color: string; pattern: string; scale: number[] };
  /**
   * Líneas de LED en el canto de las franjas, de la del nivel `from` a la del `to` (inclusive):
   * dónde va la línea en el alto de la franja (0 = abajo, 1 = arriba), su alto, cuánto sale del
   * canto, su color de día y su luz de noche.
   */
  leds: { from: number; to: number; y: number; height: number; out: number; color: string; glow: Glow };
  /**
   * Focos en la cara de abajo de la franja del nivel `level` (el cielo del soportal): a `offset`
   * del canto (negativo, hacia adentro), uno cada `spacing` m, de lado `size`, con su luz propia,
   * solo en los tramos de ángulo `sides` (grados del marco local, [desde, hasta]), colgados `drop`
   * m bajo la cara (para que no se peleen con ella). Uno de cada `light.every` alumbra el piso de
   * noche (potencia: 1 = un poste de la calle).
   */
  spots: {
    level: number;
    offset: number;
    spacing: number;
    size: number;
    drop: number;
    color: string;
    glow: Glow;
    sides: number[][];
    light: { every: number; power: number; led: boolean };
  };
  /** Pisos por malla: cada grupo se descarta junto (y se mide por su nombre). */
  sections: number;
  /**
   * Física por tramos: un juego de cajas cada `every` pisos con la planta a media altura del tramo
   * (se pisa la losa que vuela), de `depth` m de fondo desde el canto hacia adentro, con los arcos
   * en `segments` tramos por cuarto de círculo. Arrancan en el cielo del soportal (debajo se
   * camina); el núcleo, un macizo en la línea del vidrio de la planta baja, va del suelo al techo.
   */
  physics: { every: number; depth: number; segments: number };
}

/** Un piso del fuste ya ubicado: alturas desde la base del lugar. */
export interface Storey {
  /** Pie del vidrio (el tope del nivel de abajo), pie de la franja y tope (el nivel del piso). */
  y0: number;
  band0: number;
  top: number;
  inset: number;
  glazing: Glazing;
}

/** Los pisos del fuste, del primero (la planta baja) al último, y la altura de cada nivel (0 = el piso de la planta baja). */
export function shaftStoreys(s: ShaftStyle): { storeys: Storey[]; levels: number[] } {
  const storeys: Storey[] = [];
  const levels = [s.lift];
  for (const f of s.floors) {
    for (let k = 0; k < f.count; k++) {
      const y0 = levels[levels.length - 1];
      const top = y0 + f.height;
      storeys.push({ y0, band0: top - f.band, top, inset: f.inset, glazing: s.glazings[f.glazing] });
      levels.push(top);
    }
  }
  return { storeys, levels };
}

/** Giro de la planta (rad) en un nivel (puede ser fraccionario), según la tabla `twist`. */
export function twistAt(s: ShaftStyle, level: number): number {
  const t = s.twist;
  if (level <= t[0][0]) return t[0][1] * DEG;
  for (let k = 0; k + 1 < t.length; k++) {
    const [l0, a0] = t[k];
    const [l1, a1] = t[k + 1];
    if (level <= l1) return (a0 + ((a1 - a0) * (level - l0)) / (l1 - l0)) * DEG;
  }
  return t[t.length - 1][1] * DEG;
}

/** Lo que el fuste necesita para armarse: dónde van sus piezas (por grupo de pisos y acabado) y el suelo. */
export interface ShaftKit {
  /** Altura del mundo de la base del lugar (las alturas de la config se miden desde aquí). */
  base: number;
  terrain(x: number, z: number): number;
  /** Cuánto se entierran los muros bajo el terreno y largo de los tramos que lo siguen. */
  bury: number;
  step: number;
  /** Franjas, zócalo y LED de un grupo de pisos. */
  stone(section: number): Batch;
  /** Vidrios de un grupo de pisos, por acabado. */
  glass(section: number, finish: string): Batch;
  /** Lo chico que solo se ve de cerca (los focos del soportal). */
  detail: Batch;
  /** Semilla de las ventanas encendidas. */
  seed: number;
}

/** Cuadrilátero vertical de a a b (marco local) entre y0 e y1, mirando hacia afuera del contorno. */
function wallQuad(batch: Batch, a: THREE.Vector2, b: THREE.Vector2, y0a: number, y0b: number, y1: number, color: THREE.Color, surface: Surface, uv?: readonly number[]): void {
  batch.quad(new THREE.Vector3(a.x, y0a, a.y), new THREE.Vector3(b.x, y0b, b.y), new THREE.Vector3(b.x, y1, b.y), new THREE.Vector3(a.x, y1, a.y), color, surface, uv);
}

/** Paños de vidrio por el contorno `runs`, entre y0 e y1 (del mundo), uno cada ~`g.module` m, algunos encendidos. */
function glazingBand(batch: Batch, runs: PlanRun[], y0: number, y1: number, g: Glazing, seed: number): void {
  const color = new THREE.Color(g.color);
  const glow = glowOf(g.glow);
  const [aoFoot, aoHead] = g.ao;
  const ao = (p: THREE.Vector3): number => THREE.MathUtils.lerp(aoFoot, aoHead, clamp((p.y - y0) / Math.max(y1 - y0, 1e-3), 0, 1));
  let k = 0;
  for (const s of segmentsOf(runs)) {
    const m = Math.max(1, Math.round(s.len / g.module));
    for (let i = 0; i < m; i++) {
      const a = s.a.clone().lerp(s.b, i / m);
      const b = s.a.clone().lerp(s.b, (i + 1) / m);
      const lit = rand(seed + k++, 5) < g.share;
      wallQuad(batch, a, b, y0, y0, y1, color, { pattern: PATTERN.glazing, tone: g.tone, glow: lit ? glow : undefined, ao }, [0, 0, g.panes[0], g.panes[1]]);
    }
  }
}

/** Una tira fina por el contorno (una línea de LED), de y0 a y1, con su color y su luz. */
function strip(batch: Batch, runs: PlanRun[], y0: number, y1: number, color: THREE.Color, glow: THREE.Color): void {
  for (const s of segmentsOf(runs)) wallQuad(batch, s.a, s.b, y0, y0, y1, color, { glow });
}

/** ¿Cae el ángulo (grados del marco local) del punto p, visto desde el eje, en alguno de los tramos `sides`? */
function inSides(sides: number[][], cx: number, cz: number, p: THREE.Vector2): boolean {
  const a = Math.atan2(p.y - cz, p.x - cx) / DEG;
  return sides.some(([a0, a1]) => {
    const span = (((a1 - a0) % 360) + 360) % 360;
    const d = (((a - a0) % 360) + 360) % 360;
    return d <= span;
  });
}

/** Dónde van los focos del soportal (marco local) y a qué alto sobre la base. */
export function shaftSpots(s: ShaftStyle): { p: THREE.Vector2; n: THREE.Vector2; y: number }[] {
  const S = s.spots;
  const plan = new PlanShape(s.plan, s.center[0], s.center[1]);
  const { storeys } = shaftStoreys(s);
  const st = storeys[S.level - 1];
  if (!st) return [];
  const runs = plan.runs(S.offset, twistAt(s, S.level));
  return along(runs, S.spacing)
    .filter((q) => inSides(S.sides, s.center[0], s.center[1], q.p))
    .map((q) => ({ ...q, y: st.band0 }));
}

/** Las luces del soportal para el alumbrado de la ciudad (una de cada `spots.light.every` focos). */
export function shaftLights(s: ShaftStyle): PlaceLight[] {
  const L = s.spots.light;
  return shaftSpots(s)
    .filter((_, k) => k % L.every === 0)
    .map((q) => ({ x: q.p.x, z: q.p.y, lift: s.lift, h: q.y - s.lift, out: Math.atan2(q.n.y, q.n.x), power: L.power, led: L.led }));
}

/**
 * Arma el fuste: por piso, su banda de vidrio (con la planta de la losa en que se apoya) y la
 * franja que lo remata (con la planta de su losa), las líneas de LED, el zócalo de la planta baja
 * y los focos del soportal.
 */
export function buildShaft(s: ShaftStyle, kit: ShaftKit): void {
  const plan = new PlanShape(s.plan, s.center[0], s.center[1]);
  const { storeys } = shaftStoreys(s);
  const B = s.band;
  const white = new THREE.Color(B.color);
  const bandSurface: Surface = { ao: (_p, n) => (n.y < 0 ? THREE.MathUtils.lerp(1, B.ao.soffit, -n.y) : THREE.MathUtils.lerp(1, B.ao.top, n.y)) };
  const L = s.leds;
  const ledColor = new THREE.Color(L.color);
  const ledGlow = glowOf(L.glow);
  const y = (v: number): number => kit.base + v;
  storeys.forEach((st, i) => {
    const level = i + 1;
    const section = Math.floor(i / s.sections);
    const stone = kit.stone(section);
    // Vidrio: la planta de la losa de abajo, metido `inset` del canto.
    const below = twistAt(s, level - 1);
    glazingBand(kit.glass(section, st.glazing.finish), plan.runs(-st.inset, below), y(st.y0), y(st.band0), st.glazing, kit.seed + level * 997);
    // Franja: su cara de arriba y la de abajo siguen detrás del vidrio más metido de los dos pisos.
    const above = storeys[i + 1];
    const inner = -(Math.max(st.inset, above ? above.inset : st.inset) + B.overlap);
    const angle = twistAt(s, level);
    sweep(stone, plan, angle, bandProfile(y(st.band0), y(st.top), 0, inner, B.round, B.segments, false), white, bandSurface);
    if (level >= L.from && level <= L.to) {
      const yc = y(st.band0 + (st.top - st.band0) * L.y);
      strip(stone, plan.runs(L.out, angle), yc - L.height / 2, yc + L.height / 2, ledColor, ledGlow);
    }
  });
  // Zócalo: del terreno al piso de la planta baja, en la línea del vidrio de la planta baja.
  const first = storeys[0];
  const skirt = new THREE.Color(s.skirt.color);
  const skirtSurface: Surface = { pattern: patternOf(s.skirt.pattern), scale: s.skirt.scale };
  for (const seg of segmentsOf(plan.runs(-first.inset, twistAt(s, 0)))) {
    const n = Math.max(1, Math.ceil(seg.len / kit.step));
    for (let k = 0; k < n; k++) {
      const a = seg.a.clone().lerp(seg.b, k / n);
      const b = seg.a.clone().lerp(seg.b, (k + 1) / n);
      const ya = Math.min(kit.terrain(a.x, a.y) - kit.bury, y(s.lift));
      const yb = Math.min(kit.terrain(b.x, b.y) - kit.bury, y(s.lift));
      const u0 = (seg.len * k) / n;
      wallQuad(kit.stone(0), a, b, ya, yb, y(s.lift), skirt, skirtSurface, [u0, ya, u0 + seg.len / n, ya, u0 + seg.len / n, y(s.lift), u0, y(s.lift)]);
    }
  }
  // Focos del cielo del soportal (mirando hacia abajo).
  const S = s.spots;
  const spotColor = new THREE.Color(S.color);
  const spotGlow = glowOf(S.glow);
  const h = S.size / 2;
  for (const q of shaftSpots(s)) {
    const t = new THREE.Vector2(-q.n.y, q.n.x).multiplyScalar(h);
    const n = q.n.clone().multiplyScalar(h);
    const yy = y(q.y) - S.drop;
    const P = (v: THREE.Vector2): THREE.Vector3 => new THREE.Vector3(v.x, yy, v.y);
    // Mirando hacia abajo: a, d, c, b en el sentido que la deja de cara al piso.
    const a = q.p.clone().sub(t).sub(n);
    const b = q.p.clone().add(t).sub(n);
    const c = q.p.clone().add(t).add(n);
    const d = q.p.clone().sub(t).add(n);
    kit.detail.quad(P(a), P(d), P(c), P(b), spotColor, { glow: spotGlow });
  }
}

/**
 * El remate de la torre (config/sites → crown): la terraza sobre la última losa, con su piso, su
 * baranda de vidrio, sus cuartos de máquinas y mástiles; encima, sostenido por aletas finas, el
 * anillo blanco con la planta de la torre (y su LED), y un anillo interior unido al de afuera por
 * costillas radiales (la pérgola que se ve desde el aire). Largos en m.
 */
export interface CrownStyle {
  /** Del piso de la terraza (el tope de la última franja) al tope del anillo. */
  height: number;
  /** Anillo: alto del canto, fondo hacia adentro, cuánto sale del canto de la última franja, redondeo y color. */
  ring: { height: number; depth: number; out: number; round: number; color: string };
  /** Aletas bajo el anillo: una cada ~`spacing` m, grosor y fondo, a `inset` del canto del anillo hacia adentro, y color. */
  fins: { spacing: number; size: number[]; inset: number; color: string };
  /** Anillo interior: a `inset` hacia adentro del canto de la última franja, ancho y alto, arriba (a ras del tope del anillo). */
  inner: { inset: number; size: number[]; color: string };
  /** Costillas radiales del anillo interior al de afuera: cuántas, ancho y alto (a ras del tope). */
  ribs: { count: number; size: number[]; color: string };
  /** LED del anillo: dónde va en su alto (0 = abajo, 1 = arriba), su alto, cuánto sale y su luz. */
  led: { y: number; height: number; out: number; color: string; glow: Glow };
  /** Baranda de la terraza: alto, a cuánto del canto de la última franja hacia adentro y su vidrio (una clave de `shaft.glazings`). */
  rail: { height: number; inset: number; glazing: string };
  /** Piso de la terraza: color, dibujo, cuántas unidades del dibujo mide cada metro y oclusión. */
  floor: { color: string; pattern: string; scale: number[]; ao: number };
  /** Cuartos de máquinas sobre la terraza: centro (marco local), ancho, fondo, alto, giro (grados) y color. */
  rooms: { at: number[]; size: number[]; angle: number; color: string }[];
  /** Mástiles de antena: pie (marco local) y a qué alto sobre el piso de la terraza, alto, radio, lados y color. */
  masts: { at: number[]; base: number; height: number; radius: number; sides: number; color: string }[];
}

/** Lo que el remate necesita para armarse. */
export interface CrownKit {
  base: number;
  /** El anillo, las aletas, la pérgola y el piso (se ven desde lejos). */
  stone: Batch;
  /** La baranda de vidrio, por acabado. */
  glass(finish: string): Batch;
  /** Cuartos de máquinas y mástiles (solo de cerca). */
  detail: Batch;
}

/** Alto (sobre la base) del piso de la terraza, del pie y del tope del anillo del remate. */
export function crownLevels(s: ShaftStyle, c: CrownStyle): { floor: number; ring0: number; top: number } {
  const { levels } = shaftStoreys(s);
  const floor = levels[levels.length - 1];
  const top = floor + c.height;
  return { floor, ring0: top - c.ring.height, top };
}

export function buildCrown(s: ShaftStyle, c: CrownStyle, kit: CrownKit): void {
  const plan = new PlanShape(s.plan, s.center[0], s.center[1]);
  const { storeys } = shaftStoreys(s);
  const N = storeys.length;
  const angle = twistAt(s, N);
  const lv = crownLevels(s, c);
  const y = (v: number): number => kit.base + v;
  const R = c.ring;
  // Anillo (con su cara de adentro: se ve desde la terraza) y su LED.
  sweep(kit.stone, plan, angle, bandProfile(y(lv.ring0), y(lv.top), R.out, R.out - R.depth, R.round, s.band.segments, true), new THREE.Color(R.color), {});
  const yc = y(lv.ring0 + R.height * c.led.y);
  strip(kit.stone, plan.runs(R.out + c.led.out, angle), yc - c.led.height / 2, yc + c.led.height / 2, new THREE.Color(c.led.color), glowOf(c.led.glow));
  // Aletas: del piso de la terraza al pie del anillo, de canto hacia afuera.
  const F = c.fins;
  const [fw, fd] = F.size;
  const finColor = new THREE.Color(F.color);
  const finH = lv.ring0 - lv.floor;
  for (const q of along(plan.runs(R.out - F.inset - fd / 2, angle), F.spacing)) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(q.n.x, 0, q.n.y), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-q.n.y, 0, q.n.x)).setPosition(q.p.x, y(lv.floor + finH / 2), q.p.y);
    kit.stone.box(m, fd, finH, fw, finColor);
  }
  // Anillo interior y costillas, a ras del tope.
  const I = c.inner;
  const [iw, ih] = I.size;
  sweep(kit.stone, plan, angle, bandProfile(y(lv.top - ih), y(lv.top), -I.inset, -I.inset - iw, 0, 1, true), new THREE.Color(I.color), {});
  const [rw, rh] = c.ribs.size;
  const ribColor = new THREE.Color(c.ribs.color);
  for (let k = 0; k < c.ribs.count; k++) {
    const phi = angle + (k / c.ribs.count) * TAU;
    const r0 = plan.reach(phi, -I.inset, angle);
    const r1 = plan.reach(phi, R.out - R.depth, angle);
    if (r1 <= r0) continue;
    const d = dir(phi);
    const mid = (r0 + r1) / 2;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(d.x, 0, d.y), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-d.y, 0, d.x)).setPosition(s.center[0] + d.x * mid, y(lv.top - rh / 2), s.center[1] + d.y * mid);
    kit.stone.box(m, r1 - r0, rh, rw, ribColor);
  }
  // Piso de la terraza: de la cara de arriba de la última franja hacia el eje.
  const last = storeys[N - 1];
  const floorColor = new THREE.Color(c.floor.color);
  const floorSurface: Surface = { pattern: patternOf(c.floor.pattern), scale: c.floor.scale, ao: c.floor.ao };
  const center = new THREE.Vector3(s.center[0], y(lv.floor), s.center[1]);
  const edge = -(last.inset + s.band.overlap);
  for (const seg of segmentsOf(plan.runs(edge, angle))) {
    const a = new THREE.Vector3(seg.a.x, y(lv.floor), seg.a.y);
    const b = new THREE.Vector3(seg.b.x, y(lv.floor), seg.b.y);
    kit.stone.tri(center, a, b, floorColor, floorSurface, [center.x, center.z, a.x, a.z, b.x, b.z]);
  }
  // Baranda de vidrio de la terraza.
  const G = s.glazings[c.rail.glazing];
  glazingBand(kit.glass(G.finish), plan.runs(-c.rail.inset, angle), y(lv.floor), y(lv.floor + c.rail.height), G, 0);
  // Cuartos de máquinas y mástiles.
  for (const r of c.rooms) {
    const [w, d, h] = r.size;
    const m = new THREE.Matrix4().makeRotationY(-r.angle * DEG).setPosition(r.at[0], y(lv.floor + h / 2), r.at[1]);
    kit.detail.box(m, w, h, d, new THREE.Color(r.color));
  }
  for (const mast of c.masts) {
    const g = new THREE.CylinderGeometry(mast.radius, mast.radius, mast.height, mast.sides, 1, true);
    kit.detail.geometry(g, new THREE.Matrix4().makeTranslation(mast.at[0], y(lv.floor + mast.base + mast.height / 2), mast.at[1]), new THREE.Color(mast.color));
    g.dispose();
  }
}

/**
 * Física del fuste y del remate: el núcleo (un macizo en la línea del vidrio de la planta baja,
 * del suelo a la terraza), por tramos las cajas de la losa que vuela (desde el cielo del soportal
 * hasta el tope del tramo, pisables arriba), la baranda de la terraza y el anillo del remate
 * (se pasa por debajo, se pisa encima). `wall` = grosor de la física de las barandas.
 */
export function shaftPhysics(s: ShaftStyle, c: CrownStyle, site: PlaceSite, base: number, bury: number, wall: number): void {
  const { storeys, levels } = shaftStoreys(s);
  const N = storeys.length;
  const y = (v: number): number => base + v;
  const P = s.physics;
  const coarse = new PlanShape({ ...s.plan, segments: P.segments }, s.center[0], s.center[1]);
  const first = storeys[0];
  const core = coarse.runs(-first.inset, twistAt(s, 0)).flatMap((r) => r.points.slice(0, -1).map((q) => new THREE.Vector3(q.x, 0, q.y)));
  site.block(core, y(-bury), y(levels[N]));
  const ceiling = y(first.band0);
  const boxes = (runs: PlanRun[], depth: number, top: number, floor: boolean, bottom: number): void => {
    for (const seg of segmentsOf(runs)) {
      // El contorno va en el sentido en que (b − a) × arriba apunta hacia afuera: (−Δz, Δx).
      const n = new THREE.Vector2(-(seg.b.y - seg.a.y), seg.b.x - seg.a.x).normalize();
      const mid = seg.a.clone().add(seg.b).multiplyScalar(0.5).addScaledVector(n, -depth / 2);
      site.box(mid.x, mid.y, seg.len / 2, depth / 2, Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x), top, floor, bottom);
    }
  };
  for (let l0 = 0; l0 < N; l0 += P.every) {
    const l1 = Math.min(l0 + P.every, N);
    boxes(coarse.runs(0, twistAt(s, (l0 + l1) / 2)), P.depth, y(levels[l1]), true, ceiling);
  }
  const angle = twistAt(s, N);
  const lv = crownLevels(s, c);
  boxes(coarse.runs(-c.rail.inset, angle), wall, y(lv.floor + c.rail.height), false, -Infinity);
  boxes(coarse.runs(c.ring.out, angle), c.ring.depth, y(lv.top), true, y(lv.ring0));
}
