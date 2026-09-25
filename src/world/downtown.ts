import * as THREE from 'three';
import type { SignFace, SignRect } from '../render/signAtlas';
import { type Profile, archHole, rectHole, sweep, wall } from './classical';
import { type Batch, type Glow, PATTERN, type Surface, colorsOf, glowOf, patternOf } from './monumentParts';

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Cómo es un edificio del centro de Guayaquil (config/streets/*.json → defaults y styles): planta
 * baja con portal (la galería techada sobre la vereda) o con locales a la calle, pisos con una
 * fachada de cierto tipo, remate, oclusión y colores. Cada edificio toma un estilo y lo retoca con
 * `set`. Largos en m.
 */
export interface DowntownStyle {
  /** Alto de la planta baja (del piso del portal a la losa del primer piso; 0 = sin planta baja) y de cada piso. */
  ground: number;
  floor: number;
  /** Tramos de cada esquina redondeada. */
  curve: number;
  portal: {
    /** Fondo del portal; 0 = sin portal, los locales dan a la vereda. */
    depth: number;
    /** 'round' (redondas), 'square' (cuadradas), 'arches' (arcada de medio punto) o 'none'. */
    columns: string;
    /** Ancho (o diámetro) y fondo de cada columna, y lados de las redondas. */
    size: number[];
    sides: number;
    /** Separación buscada entre columnas. */
    bay: number;
    /** Cuánto baja la viga del frente desde la losa (el cielo raso del portal queda ahí). */
    beam: number;
    /** Ancho del pilar medianero (en la punta que da al vecino). */
    pier: number;
    /** Piso del portal: 'tiles' (baldosas) o 'pavers' (adoquín, como la vereda). */
    floor: string;
  };
  shops: {
    /** Alto de las vidrieras y cortinas desde el piso. */
    height: number;
    /** Parte de los locales con la cortina metálica bajada (el resto, vidriera). */
    shutter: number;
    /** Parte de las vidrieras encendidas de noche. */
    lit: number;
    /** Alto del montante de vidrio sobre la puerta; fondo de la vidriera; macizo entre locales. */
    transom: number;
    inset: number;
    pier: number;
    /** Ancho de una hoja de vidriera; travesaño sobre la puerta: alto y fondo. */
    pane: number;
    mullion: number[];
    /** Letrero sobre cada local: alto, vuelo y qué parte de los locales lo tiene. */
    sign: number[];
  };
  facade: {
    /**
     * 'punched' (ventanas en un muro), 'ribbon' (ventanas corridas entre antepechos), 'grid'
     * (retícula de hormigón a la vista con el cerramiento atrás), 'balconies' (losas de balcón
     * corridas con baranda), 'curtain' (muro cortina de vidrio), 'fins' (parteluces verticales),
     * 'classical' (muro con ventanas en arco o rectas, marcos y pilastras) o 'blank' (caja ciega
     * de paneles, sin ventanas).
     */
    kind: string;
    /** Ancho buscado de cada vano; macizo en las puntas de cada fachada; macizo mínimo entre ventanas. */
    bay: number;
    margin: number;
    pier: number;
    /** Ventana: ancho, alto y antepecho; el ancho se recorta si el vano es más chico. */
    window: number[];
    /** Fondo del vano (dónde queda el vidrio detrás del muro). */
    reveal: number;
    /** Hojas de cada ventana, a lo ancho y a lo alto. */
    panes: number[];
    /** Alféizar: alto, vuelo y cuánto sobresale a cada lado del hueco (alto 0 = sin). */
    sill: number[];
    /** Visera corrida en cada losa: alto y vuelo (0 = sin). */
    ledge: number[];
    /** Retícula o parteluces: ancho, vuelo y alto del canto de losa. */
    frame: number[];
    /** Parteluces cada cuántos vanos. */
    every: number;
    /** Balcón: vuelo, grosor de la losa y alto de la baranda. */
    balcony: number[];
    /** Baranda: 'bars' (barrotes), 'solid' (antepecho lleno) o 'glass'; su pasamanos: ancho y alto. */
    rail: string;
    railBar: number[];
    /** Muro cortina: ancho del módulo y alto de la franja opaca de cada losa. */
    module: number[];
    /** Clásico: pisos (desde 0) con ventanas en arco; marco de las ventanas y pilastras (ancho y vuelo; 0 = sin). */
    arches: number[];
    surround: number[];
    pilaster: number[];
    /** Clásico: pisos con balconcito en cada ventana (vuelo y cuánto más ancho que la ventana). */
    balconettes: number[];
    balconette: number[];
    /**
     * Revestimiento del muro de los pisos: un dibujo (PATTERN) y cuántas unidades del dibujo mide
     * cada metro (las losas de un revestimiento de paneles). Sin él, revoque.
     */
    cladding?: { pattern: string; scale: number[] };
  };
  crown: {
    /** Antepecho de la azotea: alto y grosor; 'balustrade' lo hace de balaustres en las fachadas. */
    parapet: number[];
    balustrade: boolean;
    /** Cornisa: alto y vuelo de la faja (alto 0 = sin), o perfil moldurado (vacío = sin). */
    cap: number[];
    profile: Profile;
    /** Cuarto de máquinas: ancho, fondo, alto y cuánto se corre al azar; desde cuántos pisos. */
    machine: number[];
    machineFloors: number;
  };
  /** Aires acondicionados colgados: qué parte de las ventanas, y su ancho, alto y fondo. */
  ac: { share: number; size: number[] };
  /** Oclusión ambiental: cielo raso del portal, piso (junto a los locales), locales, vanos, balcones, azotea, franjas. */
  ao: { soffit: number; floor: number; shop: number; reveal: number; balcony: number; roof: number; band: number };
  colors: {
    wall: string;
    trim: string;
    frame: string;
    glass: string;
    spandrel: string;
    column: string;
    soffit: string;
    floor: string;
    shutter: string;
    rail: string;
    ac: string;
    roof: string;
  };
  /** Tono de la carpintería respecto del vidrio (0…1, ver PATTERN.glazing). */
  frameTone: number;
  /**
   * Techo: 'flat' (azotea con su antepecho), 'gables' (un tejado a dos aguas por tramo de
   * fachada, con el hastial al frente y la cumbrera hacia el fondo `depth` m: las galerías
   * comerciales de la Alborada), 'gable' (a dos aguas sobre toda la huella, la cumbrera a lo
   * largo) o 'hip' (a cuatro aguas sobre toda la huella). Los inclinados son de teja y valen
   * para huellas de cuatro lados. Pendiente (grados), alero (m), `bays` vanos de fachada por
   * tejado (gables) y color de la teja. Sin él, azotea.
   */
  roof?: { kind: string; pitch: number; eave: number; depth: number; bays: number; color: string };
  /** Alero de teja sobre la planta baja, en los frentes: alto de su arranque sobre la base, vuelo, pendiente (grados), color y el de abajo. */
  awning?: { height: number; depth: number; pitch: number; color: string; soffit: string };
  /**
   * Franjas corridas por los frentes (la faja de un letrero, una marquesina): desde y hasta qué
   * alto sobre la base, cuánto vuelan de la fachada y su color.
   */
  bands?: { y: number[]; out: number; color: string }[];
}

/**
 * Un letrero de un edificio (el `signs` de cada edificio del inventario): la cara con su texto
 * (render/signAtlas.ts) sobre el lado `edge` de la huella (su índice en `ring`; build_street.py
 * pone el frente a la avenida), centrado en `x` (del marco de la calle; si no, el medio del lado)
 * y a `y` m sobre la base. La cara vuela `out` m de la fachada; detrás, una caja de `depth` m del
 * color del fondo (0 = letras pegadas al muro). Con `pole`, un tótem: un poste (ancho y color)
 * desde el suelo; con `back`, se lee también de atrás. `glow`: su luz de noche (si no, la de la
 * calle).
 */
export interface DowntownSign extends SignFace {
  edge: number;
  x?: number;
  y: number;
  out: number;
  depth: number;
  pole?: { width: number; color: string };
  back?: boolean;
  glow?: Glow;
}

/** Torre retranqueada sobre un edificio (su podio): otra fachada, otros pisos. */
export interface DowntownTower {
  /** Cuánto se mete desde cada lado del podio (si no trae su propia huella). */
  inset: number;
  floors: number;
  /** Estilo (si no, el del podio) y retoques. */
  style?: string;
  set?: Record<string, unknown>;
  /** Huella propia (marco de la calle) y sus fachadas (si no, todos sus lados). */
  ring?: number[][];
  fronts?: number[];
}

/** Un edificio de la calle: su huella en el marco local de la calle y lo que retoca de su estilo. */
export interface DowntownBuilding {
  id: string;
  name?: string;
  /** Huella (x a lo largo de la calle, z a su derecha), en m. */
  ring: number[][];
  /** Lados (i = del punto i al i+1) que dan a una calle: llevan fachada y portal. */
  fronts: number[];
  /** Pisos sobre la planta baja. */
  floors: number;
  style: string;
  /** Retoques del estilo (mismas claves, se mezclan en profundidad). */
  set?: Record<string, unknown>;
  /**
   * Franjas de otro color en la fachada: lado, del vano al vano (desde 0, inclusive; negativos
   * cuentan desde el último) y color.
   */
  accents?: { front: number; bays: number[]; color: string }[];
  /** Esquinas redondeadas (streamline): vértice de la huella y radio. */
  round?: { vertex: number; radius: number }[];
  tower?: DowntownTower;
  signs?: DowntownSign[];
}

/** Luces de noche de los edificios. */
export interface DowntownLights {
  /** Parte de las ventanas encendidas. */
  share: number;
  window: Glow;
  shop: Glow;
  lamp: Glow;
  /** Plafón del portal: ancho y alto. */
  lampSize: number[];
  /** Letreros (si el letrero no trae la suya). */
  sign?: Glow;
}

/** Lo que el constructor necesita de la calle (world/street.ts): dónde poner cada cosa. */
export interface DowntownKit {
  /** Altura del suelo en un punto del marco local. */
  terrain(x: number, z: number): number;
  /** Muros, losas y columnas (se ven siempre). */
  stone: Batch;
  /** Vidrios (su propio material). */
  glass: Batch;
  /** Lo chico que solo se ve de cerca: alféizares, travesaños, aires, plafones, letreros. */
  detail: Batch;
  /** Barandas caladas (material con recorte). */
  rails: Batch;
  lights: DowntownLights;
  /** Colores de los letreros de los locales. */
  signs: THREE.Color[];
  /** Pisos que siguen el terreno: largo de cada tramo y cuánto quedan sobre el suelo. */
  groundStep: number;
  lift: number;
  /** Cuánto se entierran los muros bajo el punto más bajo del terreno en la huella. */
  bury: number;
  /** Macizo que se trepa (planta local, del pie `y0` al techo `top`, alturas en el mundo). */
  block(outline: THREE.Vector3[], y0: number, top: number): void;
  /** Rectángulo de física (marco local; largo en el ángulo `angle` = atan2(z, x) local). */
  box(x: number, z: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  /** Dónde está un letrero en el atlas de letreros (sus uv), y cuánto se separa su cara de lo que tiene detrás (m). */
  signRect(s: SignFace): SignRect;
  signOffset: number;
}

/**
 * Un lado de la huella: de a a b, con su dirección, su normal hacia afuera (x × arriba: el marco
 * del lado no espeja), su índice en la huella de la config (−1 en una esquina redondeada), su
 * lugar en la esquina redondeada (−1 si no es) y si es fachada.
 */
interface Edge {
  i: number;
  orig: number;
  arc: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  len: number;
  x: THREE.Vector3;
  n: THREE.Vector3;
  front: boolean;
}

/** Mezcla en profundidad (los arreglos se reemplazan enteros). */
export function deepMerge<T>(base: T, over: Record<string, unknown> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out as T;
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Semilla estable a partir del id de un edificio. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return (h >>> 0) % 100000;
}

/** Un hueco en una fachada (marco de la fachada: x a lo largo, y en el mundo). */
interface Opening {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  arch: boolean;
}

/** Punto de cruce de dos rectas (p + d·t) en el plano x-z, o null si son paralelas. */
function cross(p: THREE.Vector3, d: THREE.Vector3, q: THREE.Vector3, e: THREE.Vector3): THREE.Vector3 | null {
  const det = d.x * e.z - d.z * e.x;
  if (Math.abs(det) < 1e-4) return null;
  const t = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / det;
  return p.clone().addScaledVector(d, t);
}

/**
 * Arma un edificio del centro sobre su huella: la planta baja con portal (columnas o arcada, viga,
 * cielo raso con plafones, locales al fondo con cortinas o vidrieras y letreros, y el piso) o con
 * los locales a la vereda, los pisos con la fachada de su tipo en cada lado que da a la calle (los
 * balcones, viseras y cornisas siguen de corrido por las esquinas, rectas o redondeadas), los muros
 * ciegos hacia los vecinos, la azotea con su antepecho y la física (el macizo se trepa; bajo el
 * portal se camina). Con `base` arma una torre sobre un podio (sin planta baja propia).
 */
export class DowntownBuilder {
  private readonly col: Record<keyof DowntownStyle['colors'], THREE.Color>;
  private readonly edges: Edge[];
  private readonly inner: THREE.Vector3[];
  private readonly seed: number;
  private base = 0;
  private sink = 0;
  private top = 0;
  private windows = 0;

  constructor(
    private readonly b: DowntownBuilding,
    private readonly s: DowntownStyle,
    private readonly kit: DowntownKit,
    private readonly fixedBase?: number,
  ) {
    this.col = colorsOf(s.colors);
    this.seed = seedOf(b.id);
    this.edges = this.makeEdges();
    this.inner = this.shrink((e) => (e.front ? this.s.portal.depth : 0));
  }

  /**
   * Los lados de la huella (con sus esquinas redondeadas ya en tramos), siempre en el sentido en
   * que x × arriba apunta hacia afuera: si la huella viene al revés se da vuelta y cada lado
   * recuerda su índice en la config.
   */
  private makeEdges(): Edge[] {
    const pts = this.b.ring.map(([x, z]) => new THREE.Vector3(x, 0, z));
    if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-3) pts.pop();
    const n = pts.length;
    const fronts = new Set(this.b.fronts);
    const round = new Map((this.b.round ?? []).map((r) => [r.vertex, r.radius]));
    // Vértices con el lado que arranca en cada uno: su índice en la config y su lugar en el arco.
    const verts: { p: THREE.Vector3; orig: number; arc: number; front: boolean }[] = [];
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      const r = round.get(k);
      const prev = pts[(k + n - 1) % n];
      const next = pts[(k + 1) % n];
      const d1 = p.clone().sub(prev).normalize();
      const d2 = next.clone().sub(p).normalize();
      const turn = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
      if (!r || turn < 1e-3) {
        verts.push({ p, orig: k, arc: -1, front: fronts.has(k) });
        continue;
      }
      // Tangente a los dos lados (sin comerse más de lo que miden).
      const t = Math.min(r * Math.tan(turn / 2), p.distanceTo(prev) * 0.5, p.distanceTo(next) * 0.5);
      const radius = t / Math.tan(turn / 2);
      const start = p.clone().addScaledVector(d1, -t);
      const side = d1.x * d2.z - d1.z * d2.x > 0 ? 1 : -1;
      const center = start.clone().add(new THREE.Vector3(-d1.z * side, 0, d1.x * side).multiplyScalar(radius));
      const a0 = Math.atan2(start.z - center.z, start.x - center.x);
      const arcFront = fronts.has(k) && fronts.has((k + n - 1) % n);
      const segments = Math.max(1, this.s.curve);
      for (let j = 0; j < segments; j++) {
        const a = a0 + side * turn * (j / segments);
        verts.push({ p: new THREE.Vector3(center.x + Math.cos(a) * radius, 0, center.z + Math.sin(a) * radius), orig: -1, arc: j, front: arcFront });
      }
      verts.push({ p: p.clone().addScaledVector(d2, t), orig: k, arc: -1, front: fronts.has(k) });
    }
    const m = verts.length;
    let area = 0;
    for (let k = 0; k < m; k++) {
      const p = verts[k].p;
      const q = verts[(k + 1) % m].p;
      area += p.x * q.z - q.x * p.z;
    }
    // Dado vuelta, el lado j va de v[m−1−j] a v[m−2−j]: es el lado que arranca en v[m−2−j].
    const list = area > 0 ? verts.map((_, j) => ({ ...verts[(2 * m - 2 - j) % m], p: verts[m - 1 - j].p })) : verts;
    return list.map((v, i) => {
      const a = v.p;
      const b = list[(i + 1) % m].p;
      const x = new THREE.Vector3().subVectors(b, a);
      const len = x.length();
      x.divideScalar(len || 1);
      return { i, orig: v.orig, arc: v.arc, a, b, len, x, n: new THREE.Vector3(-x.z, 0, x.x), front: v.front };
    });
  }

  /**
   * La huella con cada lado corrido hacia adentro lo que diga `depth` (el fondo del portal: la
   * línea de los locales; o el retiro de una torre). Cada punto es el cruce de sus dos lados.
   */
  private shrink(depth: (e: Edge) => number): THREE.Vector3[] {
    const E = this.edges;
    return E.map((e, i) => {
      const prev = E[(i + E.length - 1) % E.length];
      const pa = prev.a.clone().addScaledVector(prev.n, -depth(prev));
      const ea = e.a.clone().addScaledVector(e.n, -depth(e));
      return cross(pa, prev.x, ea, e.x) ?? ea;
    });
  }

  /** La huella corrida `d` hacia adentro en todos sus lados (marco de la calle), para una torre. */
  towerRing(d: number): number[][] {
    return this.shrink(() => d).map((q) => [q.x, q.z]);
  }

  /** Marco de un lado: x a lo largo (de a a b), y arriba (alturas del mundo), z hacia afuera. */
  private frame(e: Edge, u = 0, o = 0): THREE.Matrix4 {
    return new THREE.Matrix4().makeBasis(e.x, UP, e.n).setPosition(e.a.x + e.x.x * u + e.n.x * o, 0, e.a.z + e.x.z * u + e.n.z * o);
  }

  /** Punto (x, y, z del marco del lado) en el marco local de la calle. */
  private p(m: THREE.Matrix4, x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(m);
  }

  /** Cuadrilátero en el plano z del marco m, de (x0, y0) a (x1, y1), mirando a +z (o a −z). */
  private face(batch: Batch, m: THREE.Matrix4, x0: number, y0: number, x1: number, y1: number, z: number, color: THREE.Color, surface: Surface = {}, back = false, uv?: number[]): void {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
    const a = this.p(m, back ? x1 : x0, y0, z);
    const b = this.p(m, back ? x0 : x1, y0, z);
    const c = this.p(m, back ? x0 : x1, y1, z);
    const d = this.p(m, back ? x1 : x0, y1, z);
    batch.quad(a, b, c, d, color, surface, uv);
  }

  /** Caja de w × h × d con su centro en (x, y, z) del marco m. */
  private box(batch: Batch, m: THREE.Matrix4, w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color, surface: Surface = {}): void {
    if (w <= 0 || h <= 0 || d <= 0) return;
    batch.box(m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)), w, h, d, color, surface);
  }

  /** Repisa pegada al muro (alféizar): frente, arriba y abajo; la cara de atrás y las puntas no se ven. */
  private shelf(batch: Batch, m: THREE.Matrix4, x0: number, x1: number, y0: number, y1: number, out: number, color: THREE.Color): void {
    const P = (x: number, y: number, z: number): THREE.Vector3 => this.p(m, x, y, z);
    batch.quad(P(x0, y0, out), P(x1, y0, out), P(x1, y1, out), P(x0, y1, out), color);
    batch.quad(P(x0, y1, out), P(x1, y1, out), P(x1, y1, 0), P(x0, y1, 0), color);
    batch.quad(P(x0, y0, 0), P(x1, y0, 0), P(x1, y0, out), P(x0, y0, out), color);
  }

  private lit(): boolean {
    return rand(this.seed + this.windows++, 7) < this.kit.lights.share;
  }

  build(): { base: number; top: number } {
    const s = this.s;
    if (this.fixedBase !== undefined) {
      this.base = this.fixedBase;
      this.sink = 0;
    } else {
      // Base: la vereda a lo largo de las fachadas (mediana); lo que baja de ahí se entierra.
      const samples: number[] = [];
      let low = Infinity;
      for (const e of this.edges) {
        const n = Math.max(1, Math.ceil(e.len / this.kit.groundStep));
        for (let k = 0; k <= n; k++) {
          const q = e.a.clone().addScaledVector(e.x, (e.len * k) / n);
          const h = this.kit.terrain(q.x, q.z);
          if (e.front) samples.push(h);
          low = Math.min(low, h);
        }
      }
      if (!samples.length) samples.push(low);
      samples.sort((a, b) => a - b);
      this.base = samples[Math.floor(samples.length / 2)];
      this.sink = this.base - low + this.kit.bury;
    }
    this.top = this.base + s.ground + this.b.floors * s.floor;

    for (const e of this.edges) {
      if (!e.front) continue;
      if (s.ground > 0) {
        if (s.portal.depth > 0) this.portal(e);
        else this.shopfront(e);
      }
      this.facade(e);
      if (e.arc < 0) {
        this.bands(e);
        this.awning(e);
      }
    }
    for (const chain of this.chains()) this.chainParts(chain);
    this.sides();
    this.roof();
    this.pitched();
    this.signs();
    this.physics();
    return { base: this.base, top: this.top };
  }

  /** Cuadrilátero a-b-c-d mirando hacia arriba (`up`) o hacia abajo: lo da vuelta si hace falta. */
  private facing(up: boolean, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, surface: Surface, uv?: number[]): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    if (n.y >= 0 === up) this.kit.stone.quad(a, b, c, d, color, surface, uv);
    else this.kit.stone.quad(b, a, d, c, color, surface, uv && [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
  }

  /** Franjas de color corridas por un frente (DowntownStyle.bands). */
  private bands(e: Edge): void {
    const m = this.frame(e);
    for (const b of this.s.bands ?? []) {
      const [y0, y1] = b.y;
      this.box(this.kit.stone, m, e.len, y1 - y0, b.out, e.len / 2, this.base + (y0 + y1) / 2, b.out / 2, new THREE.Color(b.color), { ao: this.s.ao.band });
    }
  }

  /** Alero de teja sobre la planta baja de un frente (DowntownStyle.awning): el faldón y su cielo. */
  private awning(e: Edge): void {
    const a = this.s.awning;
    if (!a || this.s.ground <= 0) return;
    const m = this.frame(e);
    const P = (x: number, y: number, z: number): THREE.Vector3 => this.p(m, x, y, z);
    const y0 = this.base + a.height;
    const drop = a.depth * Math.tan(THREE.MathUtils.degToRad(a.pitch));
    const slope = Math.hypot(a.depth, drop);
    // Faldón: del muro (arriba) al borde (abajo), con la teja bajando por la pendiente.
    this.kit.stone.quad(P(0, y0 - drop, a.depth), P(e.len, y0 - drop, a.depth), P(e.len, y0, 0), P(0, y0, 0), new THREE.Color(a.color), { pattern: PATTERN.roofTiles }, [0, slope, e.len, slope, e.len, 0, 0, 0]);
    this.kit.stone.quad(P(0, y0, 0), P(e.len, y0, 0), P(e.len, y0 - drop, a.depth), P(0, y0 - drop, a.depth), new THREE.Color(a.soffit), { ao: this.s.ao.soffit });
  }

  /**
   * Tejados de teja (DowntownStyle.roof), sobre la azotea: una hilera de hastiales al frente
   * ('gables') o un techo a dos o cuatro aguas sobre toda la huella de cuatro lados ('gable',
   * 'hip'), con su alero y el cielo del alero.
   */
  private pitched(): void {
    const r = this.s.roof;
    if (!r || r.kind === 'flat') return;
    const tile = new THREE.Color(r.color);
    const t = Math.tan(THREE.MathUtils.degToRad(r.pitch));
    const tiles: Surface = { pattern: PATTERN.roofTiles, ao: this.s.ao.roof };
    const wall: Surface = { pattern: PATTERN.stucco };
    const soffit: Surface = { ao: this.s.ao.soffit };
    const top = this.top;
    if (r.kind === 'gables') {
      for (const e of this.edges) {
        if (!e.front || e.arc >= 0) continue;
        const m = this.frame(e);
        const P = (x: number, y: number, z: number): THREE.Vector3 => this.p(m, x, y, z);
        const n = Math.max(1, Math.round(e.len / (this.s.facade.bay * r.bays)));
        const w = e.len / n;
        const rise = (w / 2) * t;
        const slope = Math.hypot(w / 2, rise);
        const run = r.depth + r.eave;
        for (let k = 0; k < n; k++) {
          const u0 = k * w;
          const um = u0 + w / 2;
          const u1 = u0 + w;
          const ridge = top + rise;
          // Hastiales: el del frente mira a la calle; el de atrás, al fondo.
          this.kit.stone.tri(P(u0, top, 0), P(u1, top, 0), P(um, ridge, 0), this.col.wall, wall, [u0, top, u1, top, um, ridge]);
          this.kit.stone.tri(P(u1, top, -r.depth), P(u0, top, -r.depth), P(um, ridge, -r.depth), this.col.wall, wall, [u1, top, u0, top, um, ridge]);
          // Faldones (uv: a lo largo de la cumbrera y bajando), con el alero hacia la calle.
          this.facing(true, P(u0, top, r.eave), P(um, ridge, r.eave), P(um, ridge, -r.depth), P(u0, top, -r.depth), tile, tiles, [0, slope, 0, 0, run, 0, run, slope]);
          this.facing(true, P(um, ridge, r.eave), P(u1, top, r.eave), P(u1, top, -r.depth), P(um, ridge, -r.depth), tile, tiles, [0, 0, 0, slope, run, slope, run, 0]);
          // Cielo del alero (se ve desde la vereda).
          this.facing(false, P(u0, top, 0), P(um, ridge, 0), P(um, ridge, r.eave), P(u0, top, r.eave), this.col.soffit, soffit);
          this.facing(false, P(um, ridge, 0), P(u1, top, 0), P(u1, top, r.eave), P(um, ridge, r.eave), this.col.soffit, soffit);
        }
      }
      return;
    }
    const E = this.edges;
    if (E.length !== 4) return;
    // Marco del techo: a lo largo del lado más largo, con el centro de la huella.
    const k0 = E[0].len >= E[1].len ? 0 : 1;
    const ux = E[k0].x;
    const uz = E[k0].n;
    const L = (E[k0].len + E[k0 + 2].len) / 2;
    const S = (E[k0 + 1].len + E[(k0 + 3) % 4].len) / 2;
    const c = E.reduce((acc, e) => acc.add(e.a), new THREE.Vector3()).divideScalar(4);
    const P = (u: number, v: number, y: number): THREE.Vector3 => c.clone().addScaledVector(ux, u).addScaledVector(uz, v).setY(y);
    const e = r.eave;
    const yE = top - e * t;
    const yR = top + (S / 2) * t;
    const hr = r.kind === 'hip' ? Math.max(0, L / 2 - S / 2) : L / 2 + e;
    const lu = L / 2 + e;
    const lv = S / 2 + e;
    const down = lv / Math.cos(Math.atan(t));
    // Faldones largos (a los dos lados de la cumbrera).
    for (const sv of [1, -1]) {
      this.facing(true, P(-lu, sv * lv, yE), P(lu, sv * lv, yE), P(hr, 0, yR), P(-hr, 0, yR), tile, tiles, [-lu, down, lu, down, hr, 0, -hr, 0]);
    }
    if (r.kind === 'hip') {
      // Cabeceras: los triángulos de las puntas (con la misma pendiente: bajan lo mismo).
      const downU = down;
      for (const su of [1, -1]) {
        const a = P(su * lu, -lv, yE);
        const b = P(su * lu, lv, yE);
        const tip = P(su * hr, 0, yR);
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(tip, a));
        if (n.y >= 0) this.kit.stone.tri(a, b, tip, tile, tiles, [-lv, downU, lv, downU, 0, 0]);
        else this.kit.stone.tri(b, a, tip, tile, tiles, [lv, downU, -lv, downU, 0, 0]);
      }
    } else {
      // Hastiales en las puntas.
      for (const su of [1, -1]) {
        const a = P(su * (L / 2), -S / 2, top);
        const b = P(su * (L / 2), S / 2, top);
        const tip = P(su * (L / 2), 0, yR);
        const out = ux.clone().multiplyScalar(su);
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(tip, a));
        if (n.dot(out) >= 0) this.kit.stone.tri(a, b, tip, this.col.wall, wall, [-S / 2, top, S / 2, top, 0, yR]);
        else this.kit.stone.tri(b, a, tip, this.col.wall, wall, [S / 2, top, -S / 2, top, 0, yR]);
      }
    }
    if (r.kind === 'hip') {
      // Cielo del alero: del muro al borde, alrededor (a cuatro aguas, el borde va parejo).
      const wallC = [P(-L / 2, -S / 2, top), P(L / 2, -S / 2, top), P(L / 2, S / 2, top), P(-L / 2, S / 2, top)];
      const eaveC = [P(-lu, -lv, yE), P(lu, -lv, yE), P(lu, lv, yE), P(-lu, lv, yE)];
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) % 4;
        this.facing(false, wallC[k], wallC[j], eaveC[j], eaveC[k], this.col.soffit, soffit);
      }
      return;
    }
    // A dos aguas: bajo cada faldón, el alero a lo largo (del muro al borde) y, pasando cada hastial,
    // el vuelo que sube con la pendiente hasta la cumbrera.
    for (const sv of [1, -1]) {
      this.facing(false, P(-lu, sv * (S / 2), top), P(lu, sv * (S / 2), top), P(lu, sv * lv, yE), P(-lu, sv * lv, yE), this.col.soffit, soffit);
      for (const su of [1, -1]) {
        this.facing(false, P(su * (L / 2), 0, yR), P(su * lu, 0, yR), P(su * lu, sv * (S / 2), top), P(su * (L / 2), sv * (S / 2), top), this.col.soffit, soffit);
      }
    }
  }

  /** Los letreros del edificio (DowntownBuilding.signs), con su caja, su tótem y su luz. */
  private signs(): void {
    for (const sg of this.b.signs ?? []) {
      const e = this.edges.find((q) => q.orig === sg.edge && q.arc < 0);
      if (!e) throw new Error(`Letrero "${sg.text}" de ${this.b.id}: la huella no tiene el lado ${sg.edge}`);
      const [w, h] = sg.size;
      // A lo largo: la x de la calle llevada al lado (si el lado no va a lo largo, al medio).
      const dx = e.b.x - e.a.x;
      const u = sg.x === undefined || Math.abs(dx) < 1e-3 ? e.len / 2 : ((sg.x - e.a.x) / dx) * e.len;
      const m = this.frame(e, u - w / 2, 0);
      const y0 = this.base + sg.y - h / 2;
      const glow = sg.glow ?? this.kit.lights.sign;
      const face: Surface = { pattern: PATTERN.sign, glow: glow ? glowOf(glow) : undefined };
      const rect = this.kit.signRect(sg);
      const gap = this.kit.signOffset;
      this.face(this.kit.stone, m, 0, y0, w, y0 + h, sg.out + gap, WHITE, face, false, rect);
      const back = new THREE.Color(sg.background);
      if (sg.depth > 0) this.box(this.kit.stone, m, w, h, sg.depth, w / 2, y0 + h / 2, sg.out - sg.depth / 2, back);
      if (sg.back) this.face(this.kit.stone, m, 0, y0, w, y0 + h, sg.out - sg.depth - gap, WHITE, face, true, rect);
      if (sg.pole) {
        const [px, pz] = this.at(e, u, sg.out - sg.depth / 2);
        const foot = this.kit.terrain(px, pz) - this.kit.bury;
        const pw = sg.pole.width;
        this.box(this.kit.stone, m, pw, y0 - foot, pw, w / 2, (foot + y0) / 2, sg.out - sg.depth / 2, new THREE.Color(sg.pole.color));
        const angle = Math.atan2(e.x.z, e.x.x);
        this.kit.box(px, pz, pw / 2, pw / 2, angle, y0, false, -Infinity);
        // La caja del letrero también ataja (a la altura de la cabeza se choca, no se atraviesa).
        this.kit.box(px, pz, w / 2, Math.max(sg.depth, pw) / 2, angle, y0 + h, false, y0);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tramos corridos de fachada (para balcones, viseras y cornisas que doblan las esquinas)

  /** Lados de fachada seguidos (una esquina, recta o redondeada, no los corta). */
  private chains(): { edges: Edge[]; closed: boolean }[] {
    const E = this.edges;
    if (E.every((e) => e.front)) return [{ edges: E, closed: true }];
    const out: { edges: Edge[]; closed: boolean }[] = [];
    // Arranca en un lado de fachada cuyo anterior no lo es.
    for (let i = 0; i < E.length; i++) {
      if (!E[i].front || E[(i + E.length - 1) % E.length].front) continue;
      const edges: Edge[] = [];
      for (let k = i; E[k % E.length].front && edges.length < E.length; k++) edges.push(E[k % E.length]);
      out.push({ edges, closed: false });
    }
    return out;
  }

  /** La línea del tramo corrida `o` hacia afuera, con inglete en cada quiebre (y a la altura y). */
  private offset(chain: { edges: Edge[]; closed: boolean }, o: number, y: number): THREE.Vector3[] {
    const E = chain.edges;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < E.length; k++) {
      const e = E[k];
      const pe = e.a.clone().addScaledVector(e.n, o);
      if (k === 0 && !chain.closed) {
        pts.push(pe);
        continue;
      }
      const prev = E[(k + E.length - 1) % E.length];
      pts.push(cross(prev.a.clone().addScaledVector(prev.n, o), prev.x, pe, e.x) ?? pe);
    }
    const last = E[E.length - 1];
    if (!chain.closed) pts.push(last.b.clone().addScaledVector(last.n, o));
    return pts.map((q) => q.setY(y));
  }

  /**
   * Losa a lo largo del tramo, de `inner` a `outer` hacia afuera de la línea de fachada, entre y0 e
   * y1: arriba, abajo, el canto y las puntas (si el tramo no da la vuelta entera).
   */
  private chainSlab(batch: Batch, chain: { edges: Edge[]; closed: boolean }, y0: number, y1: number, inner: number, outer: number, color: THREE.Color, surface: Surface = {}): void {
    const i0 = this.offset(chain, inner, y0);
    const i1 = this.offset(chain, inner, y1);
    const o0 = this.offset(chain, outer, y0);
    const o1 = this.offset(chain, outer, y1);
    const n = i0.length;
    const segs = chain.closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const j = (k + 1) % n;
      batch.quad(i1[k], i1[j], o1[j], o1[k], color, surface);
      batch.quad(i0[j], i0[k], o0[k], o0[j], color, surface);
      batch.quad(o0[j], o0[k], o1[k], o1[j], color, surface);
    }
    if (!chain.closed) {
      batch.quad(i0[0], o0[0], o1[0], i1[0], color, surface);
      batch.quad(o0[n - 1], i0[n - 1], i1[n - 1], o1[n - 1], color, surface);
    }
  }

  /** Paño vertical a lo largo del tramo (una baranda), a `o` de la línea de fachada, de y0 a y1. */
  private chainPanel(batch: Batch, chain: { edges: Edge[]; closed: boolean }, o: number, y0: number, y1: number, color: THREE.Color, surface: Surface, uvScale = 1): void {
    const a = this.offset(chain, o, y0);
    const n = a.length;
    const segs = chain.closed ? n : n - 1;
    let u = 0;
    for (let k = 0; k < segs; k++) {
      const p = a[k];
      const q = a[(k + 1) % n];
      const len = p.distanceTo(q);
      // Mirando hacia afuera; las uv siguen de un tramo al otro (los barrotes no se cortan).
      batch.quad(p, q, q.clone().setY(y1), p.clone().setY(y1), color, surface, [u * uvScale, 0, (u + len) * uvScale, 0, (u + len) * uvScale, y1 - y0, u * uvScale, y1 - y0]);
      u += len;
    }
  }

  /** Balcones, viseras y cornisa de un tramo de fachada. */
  private chainParts(chain: { edges: Edge[]; closed: boolean }): void {
    const s = this.s;
    const f = s.facade;
    const c = this.col;
    const F = s.floor;
    const y0 = this.base + s.ground;
    const floors = this.b.floors;
    const [ledgeH, ledgeOut] = f.ledge;
    if (ledgeH > 0) {
      for (let fl = 1; fl <= floors; fl++) this.chainSlab(this.kit.stone, chain, y0 + fl * F - ledgeH, y0 + fl * F, 0, ledgeOut, c.trim, { ao: s.ao.balcony });
    }
    if (f.kind === 'balconies') {
      const [out, thick, railH] = f.balcony;
      const [barW, barH] = f.railBar;
      for (let fl = 0; fl < floors; fl++) {
        const y = y0 + fl * F;
        this.chainSlab(this.kit.stone, chain, y, y + thick, 0, out, c.trim, { ao: s.ao.balcony });
        const ry = y + thick;
        if (f.rail === 'solid') {
          this.chainSlab(this.kit.stone, chain, ry, ry + railH, out - barW, out, c.trim, { pattern: PATTERN.stucco });
          continue;
        }
        this.chainSlab(this.kit.detail, chain, ry + railH - barH, ry + railH, out - barW, out, c.rail);
        if (f.rail === 'glass') this.chainPanel(this.kit.glass, chain, out - barW / 2, ry, ry + railH - barH, c.glass, { pattern: PATTERN.glazing, tone: s.frameTone }, 1 / f.module[0]);
        else this.chainPanel(this.kit.rails, chain, out - barW / 2, ry, ry + railH - barH, c.rail, { pattern: PATTERN.bars });
      }
    }
    // Cornisa: faja simple o perfil moldurado, sobre el antepecho.
    const [parapet] = s.crown.parapet;
    const [capH, capOut] = s.crown.cap;
    const top = this.top + parapet;
    if (capH > 0) this.chainSlab(this.kit.stone, chain, top - capH, top, 0, capOut, c.trim, { ao: s.ao.balcony });
    if (s.crown.profile.length) {
      let hi = 0;
      for (const q of s.crown.profile) hi = Math.max(hi, q[1]);
      const pts = this.offset(chain, 0, top - hi).reverse();
      this.kit.stone.geometry(sweep(pts, UP, s.crown.profile, { closed: chain.closed }), new THREE.Matrix4(), c.trim, { pattern: PATTERN.stucco });
    }
    if (s.crown.balustrade && parapet > 0) {
      const [barW, barH] = f.railBar;
      this.chainPanel(this.kit.rails, chain, -barW / 2, this.top, top - barH, c.trim, { pattern: PATTERN.balusters });
      this.chainSlab(this.kit.stone, chain, top - barH, top, -barW, 0, c.trim);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Planta baja

  /** El portal de un lado: columnas o arcada, viga, cielo raso, plafones, locales y el piso. */
  private portal(e: Edge): void {
    const s = this.s;
    const P = s.portal;
    const c = this.col;
    const D = P.depth;
    const base = this.base;
    const ceiling = base + s.ground - P.beam;
    const m = this.frame(e);
    const E = this.edges;
    const prev = E[(e.i + E.length - 1) % E.length];
    const next = E[(e.i + 1) % E.length];
    const ia = this.inner[e.i];
    const ib = this.inner[(e.i + 1) % E.length];
    const ua = new THREE.Vector3().subVectors(ia, e.a).dot(e.x);
    const ub = new THREE.Vector3().subVectors(ib, e.a).dot(e.x);
    const foot = base - this.sink;
    const bays = e.arc >= 0 ? 1 : Math.max(1, Math.round(e.len / P.bay));
    const [cw, cd] = P.size;
    const angle = Math.atan2(e.x.z, e.x.x);
    const solid = (u: number, width: number, depth: number): void => {
      const [x, z] = this.at(e, u, -depth / 2);
      this.kit.box(x, z, width / 2, depth / 2, angle, ceiling, false, -Infinity);
    };

    const soffit = [e.a, e.b, ib, ia].map((q) => q.clone().setY(ceiling));
    this.kit.stone.quad(soffit[0], soffit[3], soffit[2], soffit[1], c.soffit, { ao: s.ao.soffit });
    if (P.columns === 'arches') {
      // Arcada: el muro del frente con un arco de medio punto por vano, que llega al cielo raso.
      const bw = e.len / bays;
      const span = bw - cw;
      const arches = Array.from({ length: bays }, (_, k) => ({ center: (k + 0.5) * bw, span, impost: ceiling - span / 2 }));
      const g = wall(0, e.len, foot, base + s.ground, cd, arches, [], this.s.curve * 2);
      this.kit.stone.geometry(g, m, c.wall, { pattern: PATTERN.stucco, ao: (_q, n) => (n.dot(e.n) > 0.5 ? 1 : s.ao.soffit) });
      g.dispose();
      for (let k = 0; k <= bays; k++) solid(THREE.MathUtils.clamp(k * bw, cw / 2, e.len - cw / 2), cw, cd);
    } else {
      // Viga del frente (la franja bajo el primer piso) y columnas: una entre cada vano; en la
      // punta de inicio, la de esquina (si el lado anterior también es fachada; la del final la
      // pone el lado siguiente) o el pilar medianero.
      this.face(this.kit.stone, m, 0, ceiling, e.len, base + s.ground, 0, c.wall, { pattern: PATTERN.stucco });
      const column = (u: number, width: number, depth: number, round: boolean): void => {
        const cm = this.frame(e, u, -depth / 2);
        const y = (ceiling + foot) / 2;
        if (round) {
          const cyl = new THREE.CylinderGeometry(width / 2, width / 2, ceiling - foot, P.sides, 1, true);
          this.kit.stone.geometry(cyl, cm.multiply(new THREE.Matrix4().makeTranslation(0, y, 0)), c.column, { pattern: PATTERN.stucco });
          cyl.dispose();
        } else {
          this.box(this.kit.stone, cm, width, ceiling - foot, depth, 0, y, 0, c.column, { pattern: PATTERN.stucco });
        }
        solid(u, width, depth);
      };
      const round = P.columns === 'round' || e.arc >= 0;
      if (P.columns !== 'none') for (let k = 1; k < bays; k++) column((k * e.len) / bays, cw, cd, round);
      // En una esquina redondeada, una columna cada tanto (no en cada tramo).
      const every = Math.max(1, Math.round(P.bay / Math.max(e.len, 1e-3)));
      if (prev.front && (e.arc < 0 || e.arc % every === 0)) column(e.arc >= 0 ? 0 : cd / 2, cd, cd, e.arc >= 0 || P.columns === 'round');
      else if (!prev.front) column(P.pier / 2, P.pier, cd, false);
      if (!next.front) column(e.len - P.pier / 2, P.pier, cd, false);
    }

    // Muro del fondo con los locales, uno por vano.
    this.storefronts(this.frame(e, 0, -D), ua, ub, bays, e.len, base, ceiling, e.orig);

    // Plafones del cielo raso, uno por vano.
    const [lw, lh] = this.kit.lights.lampSize;
    for (let k = 0; k < bays; k++) {
      this.box(this.kit.detail, m, lw, lh, lw, ((k + 0.5) * e.len) / bays, ceiling - lh / 2, -D / 2, c.trim, { glow: glowOf(this.kit.lights.lamp) });
    }

    // Piso del portal: sigue el terreno, más oscuro junto a los locales.
    const surface: Surface = { pattern: P.floor === 'pavers' ? PATTERN.pavers : PATTERN.tiles };
    this.ground(e, [e.a, e.b, ib, ia], c.floor, surface, (q) => {
      const o = new THREE.Vector3().subVectors(q, e.a).dot(e.n);
      return THREE.MathUtils.lerp(s.ao.floor, 1, THREE.MathUtils.clamp((o + D) / D, 0, 1));
    });
  }

  /** Planta baja sin portal: los locales en la línea de fachada. */
  private shopfront(e: Edge): void {
    const bays = e.arc >= 0 ? 1 : Math.max(1, Math.round(e.len / this.s.portal.bay));
    this.storefronts(this.frame(e), 0, e.len, bays, e.len, this.base, this.base + this.s.ground, e.orig);
  }

  /**
   * Muro de locales en el marco m (cara en z = 0), de u0 a u1, con un local por vano (los vanos
   * del lado, de largo `len`): cortina metálica o vidriera con su montante y letrero encima.
   */
  private storefronts(m: THREE.Matrix4, u0: number, u1: number, bays: number, len: number, base: number, top: number, salt: number): void {
    const S = this.s.shops;
    const c = this.col;
    const foot = base - this.sink;
    const shopTop = Math.min(base + S.height, top);
    const openings: Opening[] = [];
    for (let k = 0; k < bays; k++) {
      const a = Math.max(u0, (k * len) / bays) + S.pier / 2;
      const b = Math.min(u1, ((k + 1) * len) / bays) - S.pier / 2;
      if (b - a >= S.pane) openings.push({ x0: a, x1: b, y0: foot, y1: shopTop, arch: false });
    }
    // Muro: la franja de arriba entera y los pilares entre locales.
    const wall: Surface = { pattern: PATTERN.stucco, ao: this.s.ao.shop };
    this.face(this.kit.stone, m, u0, shopTop, u1, top, 0, c.wall, wall);
    let x = u0;
    for (const o of openings) {
      this.face(this.kit.stone, m, x, foot, o.x0, shopTop, 0, c.wall, wall);
      x = o.x1;
    }
    this.face(this.kit.stone, m, x, foot, u1, shopTop, 0, c.wall, wall);
    const [signH, signOut, signShare] = S.sign;
    const [mullH, mullD] = S.mullion;
    openings.forEach((o, k) => {
      const w = o.x1 - o.x0;
      const panes = Math.max(1, Math.round(w / S.pane));
      this.reveal(this.kit.stone, m, o, S.inset, c.wall, false);
      // Cada local arranca de su propio suelo (la vereda no es pareja).
      const q = this.p(m, (o.x0 + o.x1) / 2, 0, -S.inset);
      const doorTop = o.y1 - S.transom;
      const y0 = Math.min(this.kit.terrain(q.x, q.z), doorTop - mullH);
      if (rand(this.seed + salt * 31 + k, 3) < S.shutter) {
        this.face(this.kit.stone, m, o.x0, y0, o.x1, doorTop, -S.inset, c.shutter, { pattern: PATTERN.shutter, ao: this.s.ao.shop }, false, [0, 0, w, doorTop - y0]);
      } else {
        this.face(this.kit.glass, m, o.x0, y0, o.x1, doorTop, -S.inset, c.glass, {
          pattern: PATTERN.glazing,
          tone: this.s.frameTone,
          glow: rand(this.seed + salt * 17 + k, 5) < S.lit ? glowOf(this.kit.lights.shop) : undefined,
        }, false, [0, 0, panes, 1]);
      }
      this.face(this.kit.glass, m, o.x0, doorTop, o.x1, o.y1, -S.inset, c.glass, { pattern: PATTERN.glazing, tone: this.s.frameTone }, false, [0, 0, panes, 1]);
      this.box(this.kit.detail, m, w, mullH, mullD, (o.x0 + o.x1) / 2, doorTop, -S.inset + mullD / 2, c.frame);
      if (signH > 0 && rand(this.seed + salt * 13 + k, 9) < signShare) {
        const tint = this.kit.signs[Math.floor(rand(this.seed + salt + k, 21) * this.kit.signs.length) % this.kit.signs.length];
        this.box(this.kit.detail, m, w + S.pier, signH, signOut, (o.x0 + o.x1) / 2, Math.min(o.y1 + signH / 2, top - signH / 2), signOut / 2, tint);
      }
    });
  }

  /** Jambas, dintel y (si `sill`) antepecho de un hueco de fondo `depth` (marco m, cara en z = 0). */
  private reveal(batch: Batch, m: THREE.Matrix4, o: Opening, depth: number, color: THREE.Color, sill = true): void {
    const P = (x: number, y: number, z: number): THREE.Vector3 => this.p(m, x, y, z);
    const surface: Surface = { ao: this.s.ao.reveal };
    // Jamba izquierda (mira a +x) y derecha (a −x); dintel (hacia abajo) y antepecho (hacia arriba).
    batch.quad(P(o.x0, o.y0, 0), P(o.x0, o.y0, -depth), P(o.x0, o.y1, -depth), P(o.x0, o.y1, 0), color, surface);
    batch.quad(P(o.x1, o.y0, -depth), P(o.x1, o.y0, 0), P(o.x1, o.y1, 0), P(o.x1, o.y1, -depth), color, surface);
    batch.quad(P(o.x0, o.y1, 0), P(o.x0, o.y1, -depth), P(o.x1, o.y1, -depth), P(o.x1, o.y1, 0), color, surface);
    if (sill) batch.quad(P(o.x0, o.y0, -depth), P(o.x0, o.y0, 0), P(o.x1, o.y0, 0), P(o.x1, o.y0, -depth), color, surface);
  }

  /**
   * Piso que sigue el terreno sobre el cuadrilátero q (a lo largo del lado e, en tramos), con uv
   * en metros del marco de la calle: el dibujo sigue de una pieza a la otra.
   */
  private ground(e: Edge, q: THREE.Vector3[], color: THREE.Color, surface: Surface, ao: (p: THREE.Vector3) => number): void {
    const [a, b, c, d] = q;
    const n = Math.max(1, Math.ceil(e.len / this.kit.groundStep));
    const at = (t: number, v: number): THREE.Vector3 => {
      const pt = a.clone().lerp(b, t).lerp(d.clone().lerp(c, t), v);
      return pt.setY(this.kit.terrain(pt.x, pt.z) + this.kit.lift);
    };
    const surf: Surface = { ...surface, ao: (pp) => ao(pp) };
    for (let k = 0; k < n; k++) {
      const p0 = at(k / n, 0);
      const p1 = at((k + 1) / n, 0);
      const p2 = at((k + 1) / n, 1);
      const p3 = at(k / n, 1);
      this.kit.stone.quad(p0, p1, p2, p3, color, surf, [p0.x, p0.z, p1.x, p1.z, p2.x, p2.z, p3.x, p3.z]);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Pisos

  /** Posiciones de los vanos de un lado: centros, ancho y macizo de las puntas (un tramo de esquina es un vano). */
  private bays(e: Edge): { centers: number[]; width: number; margin: number } {
    const f = this.s.facade;
    if (e.arc >= 0) return { centers: [e.len / 2], width: e.len, margin: 0 };
    // Sin lugar para los macizos de las puntas, la fachada va de punta a punta.
    const margin = e.len > 2 * f.margin + f.bay ? f.margin : 0;
    const n = Math.max(1, Math.round((e.len - 2 * margin) / f.bay));
    const width = (e.len - 2 * margin) / n;
    return { centers: Array.from({ length: n }, (_, k) => margin + (k + 0.5) * width), width, margin };
  }

  private facade(e: Edge): void {
    const y0 = this.base + this.s.ground;
    const kind = this.s.facade.kind;
    if (kind === 'curtain') this.curtain(e, y0);
    else if (kind === 'classical') this.classical(e, y0);
    else this.openings(e, y0);
  }

  /** Huecos de cada piso de un lado (ventanas, en arco en los pisos que diga la config). */
  private rows(e: Edge, y0: number, ribbon: boolean): { rows: Opening[][]; centers: number[]; width: number; margin: number } {
    const f = this.s.facade;
    const F = this.s.floor;
    const { centers, width, margin } = this.bays(e);
    const [wwMax, whMax, sillH] = f.window;
    const ww = ribbon || e.arc >= 0 ? width - f.pier : Math.min(wwMax, width - f.pier);
    const wh = Math.min(whMax, F - sillH - f.pier);
    const rows: Opening[][] = [];
    for (let fl = 0; fl < this.b.floors && f.kind !== 'blank'; fl++) {
      const fy = y0 + fl * F;
      const arch = f.arches.includes(fl) && e.arc < 0;
      rows.push(centers.map((cx) => ({ x0: cx - ww / 2, x1: cx + ww / 2, y0: fy + sillH, y1: fy + sillH + wh, arch })));
    }
    return { rows, centers, width, margin };
  }

  /** Vidrio de un hueco (recto o en arco) con su carpintería, a `depth` detrás del muro. */
  private pane(m: THREE.Matrix4, o: Opening, depth: number): void {
    const s = this.s;
    const [panesX, panesY] = s.facade.panes;
    const surface: Surface = { pattern: PATTERN.glazing, tone: s.frameTone, glow: this.lit() ? glowOf(this.kit.lights.window) : undefined };
    if (!o.arch) {
      this.face(this.kit.glass, m, o.x0, o.y0, o.x1, o.y1, -depth, this.col.glass, surface, false, [0, 0, panesX, panesY]);
      return;
    }
    const w = o.x1 - o.x0;
    const h = o.y1 - o.y0;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(w, 0);
    shape.lineTo(w, h - w / 2);
    shape.absarc(w / 2, h - w / 2, w / 2, 0, Math.PI, false);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape, this.s.curve * 2);
    this.kit.glass.geometry(g, m.clone().multiply(new THREE.Matrix4().makeTranslation(o.x0, o.y0, -depth)), this.col.glass, { ...surface, scale: [panesX / w, panesY / h] });
    g.dispose();
  }

  /**
   * Fachada de huecos, piso por piso: muro (con sus franjas de color) con una ventana por vano, su
   * fondo, el vidrio con su carpintería y, según el tipo, alféizares, aires, retícula o parteluces
   * (los balcones y viseras van por tramo, en `chainParts`).
   */
  private openings(e: Edge, y0: number): void {
    const s = this.s;
    const f = s.facade;
    const c = this.col;
    const kind = f.kind;
    const [frameW, frameOut, slabH] = f.frame;
    // En la retícula el cerramiento queda detrás del plano de la retícula (la línea de fachada).
    const setback = kind === 'grid' ? frameOut : 0;
    const m = this.frame(e, 0, -setback);
    const { rows, centers, width, margin } = this.rows(e, y0, kind === 'ribbon');

    // Muro entre huecos: franjas horizontales enteras y pilares a la altura de las ventanas, cada
    // tramo con el color de su vano (las franjas de acento).
    const accents = (this.b.accents ?? []).filter((a) => a.front === e.orig);
    const cuts = accents.length ? [margin, ...centers.map((_, k) => margin + (k + 1) * width)] : [];
    const n = centers.length;
    const colorAt = (x: number): THREE.Color => {
      if (x < margin || x > e.len - margin) return c.wall;
      const k = Math.floor((x - margin) / width);
      const a = accents.find((q) => k >= (q.bays[0] + n) % n && k <= (q.bays[1] + n) % n);
      return a ? new THREE.Color(a.color) : c.wall;
    };
    const wall: Surface = f.cladding ? { pattern: patternOf(f.cladding.pattern), scale: f.cladding.scale } : { pattern: PATTERN.stucco };
    const strip = (x0: number, x1: number, ya: number, yb: number): void => {
      const xs = [x0, ...cuts.filter((q) => q > x0 + 1e-4 && q < x1 - 1e-4), x1];
      for (let k = 0; k + 1 < xs.length; k++) this.face(this.kit.stone, m, xs[k], ya, xs[k + 1], yb, 0, colorAt((xs[k] + xs[k + 1]) / 2), wall);
    };
    let y = y0;
    for (const row of rows) {
      if (!row.length) continue;
      strip(0, e.len, y, row[0].y0);
      let x = 0;
      for (const o of row) {
        strip(x, o.x0, o.y0, o.y1);
        x = o.x1;
      }
      strip(x, e.len, row[0].y0, row[0].y1);
      y = row[0].y1;
    }
    strip(0, e.len, y, this.top);

    // Huecos: fondo, vidrio con carpintería, alféizar y, a veces, un aire acondicionado.
    const [sh, sOut, sWide] = f.sill;
    const [acW, acH, acD] = s.ac.size;
    for (const row of rows) {
      for (const o of row) {
        this.reveal(this.kit.stone, m, o, f.reveal, c.wall, sh <= 0);
        this.pane(m, o, f.reveal);
        if (sh > 0) this.shelf(this.kit.detail, m, o.x0 - sWide, o.x1 + sWide, o.y0 - sh, o.y0, sOut, c.trim);
        if (rand(this.seed + this.windows * 3, 13) < s.ac.share) {
          const ax = rand(this.seed + this.windows, 17) < 0.5 ? o.x0 + acW / 2 : o.x1 - acW / 2;
          this.box(this.kit.detail, m, acW, acH, acD, ax, o.y0 - acH / 2 - sh, acD / 2, c.ac);
        }
      }
    }

    const height = this.top - y0;
    if (kind === 'grid') {
      const fm = this.frame(e);
      for (let k = 0; k <= centers.length; k++) {
        const x = THREE.MathUtils.clamp(margin + k * width, frameW / 2, e.len - frameW / 2);
        this.box(this.kit.stone, fm, frameW, height, frameOut, x, y0 + height / 2, -frameOut / 2, c.trim, { pattern: PATTERN.stucco });
      }
      for (let fl = 0; fl <= this.b.floors; fl++) {
        const fy = Math.min(y0 + fl * s.floor, this.top - slabH / 2);
        this.box(this.kit.stone, fm, e.len, slabH, frameOut, e.len / 2, fy, -frameOut / 2, c.trim, { pattern: PATTERN.stucco });
      }
    }
    if (kind === 'fins') {
      const every = Math.max(1, Math.round(f.every));
      for (let k = 0; k <= centers.length; k += every) {
        const x = THREE.MathUtils.clamp(margin + k * width, frameW / 2, e.len - frameW / 2);
        this.box(this.kit.stone, m, frameW, height, frameOut, x, y0 + height / 2, frameOut / 2, c.trim, { pattern: PATTERN.stucco });
      }
    }
  }

  /**
   * Fachada clásica: el muro de todos los pisos con sus huecos (rectos o en arco; el grosor del
   * muro hace de vano), vidrios, marcos moldurados, pilastras entre vanos, alféizares y
   * balconcitos de hierro en los pisos que diga la config.
   */
  private classical(e: Edge, y0: number): void {
    const s = this.s;
    const f = s.facade;
    const c = this.col;
    const m = this.frame(e);
    const { rows, centers, width, margin } = this.rows(e, y0, false);
    const holes = rows.flat().map((o) => (o.arch ? archHole((o.x0 + o.x1) / 2, o.y0, o.x1 - o.x0, o.y1 - (o.x1 - o.x0) / 2) : rectHole(o.x0, o.y0, o.x1, o.y1)));
    const g = wall(0, e.len, y0, this.top, f.reveal, [], holes, this.s.curve * 2);
    this.kit.stone.geometry(g, m, c.wall, { pattern: PATTERN.stucco, ao: (_q, n) => (n.dot(e.n) > 0.5 ? 1 : s.ao.reveal) });
    g.dispose();
    const [sw, so] = f.surround;
    const [sh, sOut, sWide] = f.sill;
    const [bOut, bWide] = f.balconette;
    const [barW, barH] = f.railBar;
    const railH = f.balcony[2];
    rows.forEach((row, fl) => {
      for (const o of row) {
        this.pane(m, o, f.reveal);
        const w = o.x1 - o.x0;
        if (sw > 0) {
          // Marco: jambas y, arriba, dintel o arquivolta.
          const spring = o.arch ? o.y1 - w / 2 : o.y1;
          for (const x of [o.x0 - sw / 2, o.x1 + sw / 2]) this.box(this.kit.detail, m, sw, spring - o.y0, so, x, (o.y0 + spring) / 2, so / 2, c.trim);
          if (o.arch) {
            const ring = new THREE.Shape();
            ring.absarc(0, 0, w / 2 + sw, 0, Math.PI, false);
            ring.lineTo(-w / 2, 0);
            ring.absarc(0, 0, w / 2, Math.PI, 0, true);
            ring.closePath();
            const ag = new THREE.ExtrudeGeometry(ring, { depth: so, bevelEnabled: false, curveSegments: this.s.curve * 2 });
            this.kit.detail.geometry(ag, m.clone().multiply(new THREE.Matrix4().makeTranslation((o.x0 + o.x1) / 2, spring, 0)), c.trim);
            ag.dispose();
          } else {
            this.box(this.kit.detail, m, w + sw * 2, sw, so, (o.x0 + o.x1) / 2, o.y1 + sw / 2, so / 2, c.trim);
          }
        }
        if (f.balconettes.includes(fl)) {
          // Balconcito: losa y baranda de hierro al frente.
          const bw = w + bWide * 2;
          const x0 = (o.x0 + o.x1) / 2 - bw / 2;
          this.box(this.kit.stone, m, bw, f.balcony[1], bOut, x0 + bw / 2, o.y0 - f.balcony[1] / 2, bOut / 2, c.trim, { ao: s.ao.balcony });
          this.box(this.kit.detail, m, bw, barH, barW, x0 + bw / 2, o.y0 + railH - barH / 2, bOut - barW / 2, c.rail);
          this.face(this.kit.rails, m, x0, o.y0, x0 + bw, o.y0 + railH - barH, bOut - barW / 2, c.rail, { pattern: PATTERN.bars }, false, [0, 0, bw, railH - barH]);
        } else if (sh > 0) {
          this.shelf(this.kit.detail, m, o.x0 - sWide, o.x1 + sWide, o.y0 - sh, o.y0, sOut, c.trim);
        }
      }
    });
    const [pw, pp] = f.pilaster;
    if (pw > 0) {
      const height = this.top - y0;
      for (let k = 0; k <= centers.length; k++) {
        const x = THREE.MathUtils.clamp(margin + k * width, pw / 2, e.len - pw / 2);
        this.box(this.kit.stone, m, pw, height, pp, x, y0 + height / 2, pp / 2, c.trim, { pattern: PATTERN.stucco });
      }
    }
  }

  /** Muro cortina: vidrio por módulo y piso, con la franja opaca en cada losa. */
  private curtain(e: Edge, y0: number): void {
    const s = this.s;
    const c = this.col;
    const [moduleW, band] = s.facade.module;
    const m = this.frame(e);
    const F = s.floor;
    const n = Math.max(1, Math.round(e.len / moduleW));
    const mw = e.len / n;
    for (let fl = 0; fl < this.b.floors; fl++) {
      const fy = y0 + fl * F;
      this.face(this.kit.glass, m, 0, fy, e.len, fy + band, 0, c.spandrel, { pattern: PATTERN.glazing, tone: s.frameTone }, false, [0, 0, n, 1]);
      for (let k = 0; k < n; k++) {
        this.face(this.kit.glass, m, k * mw, fy + band, (k + 1) * mw, fy + F, 0, c.glass, {
          pattern: PATTERN.glazing,
          tone: s.frameTone,
          glow: this.lit() ? glowOf(this.kit.lights.window) : undefined,
        }, false, [0, 0, 1, s.facade.panes[1]]);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Muros ciegos, azotea y física

  /**
   * Los lados que no son fachada: muro ciego del pie al antepecho. En la planta baja arranca en la
   * línea de los locales: no cierra el portal hacia el vecino.
   */
  private sides(): void {
    const c = this.col;
    const foot = this.base - this.sink;
    const upper = this.base + this.s.ground;
    const E = this.edges;
    const wall: Surface = { pattern: PATTERN.stucco };
    for (const e of E) {
      if (e.front) continue;
      const m = this.frame(e);
      if (this.s.ground > 0) {
        const ua = new THREE.Vector3().subVectors(this.inner[e.i], e.a).dot(e.x);
        const ub = new THREE.Vector3().subVectors(this.inner[(e.i + 1) % E.length], e.a).dot(e.x);
        this.face(this.kit.stone, m, Math.max(0, ua), foot, Math.min(e.len, ub), upper, 0, c.wall, wall);
      }
      this.face(this.kit.stone, m, 0, upper, e.len, this.top + this.s.crown.parapet[0], 0, c.wall, wall);
    }
  }

  /** Azotea: la losa, el antepecho alrededor (cara de adentro y tope) y el cuarto de máquinas. */
  private roof(): void {
    const c = this.col;
    const s = this.s;
    const top = this.top;
    const [P, t] = s.crown.parapet;
    const E = this.edges;
    const pts = E.map((e) => e.a.clone().setY(top));
    const tris = THREE.ShapeUtils.triangulateShape(
      pts.map((q) => new THREE.Vector2(q.x, q.z)),
      [],
    );
    const roof: Surface = { ao: s.ao.roof };
    for (const [a, b, d] of tris) {
      const [p0, p1, p2] = [pts[a], pts[b], pts[d]];
      const up = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).y > 0;
      if (up) this.kit.stone.tri(p0, p1, p2, c.roof, roof);
      else this.kit.stone.tri(p0, p2, p1, c.roof, roof);
    }
    if (P > 0) {
      for (const e of E) {
        // Las fachadas con balaustrada ya tienen su antepecho calado (en `chainParts`).
        if (e.front && s.crown.balustrade) continue;
        const m = this.frame(e);
        this.face(this.kit.stone, m, t, top, e.len - t, top + P, -t, c.wall, roof, true);
        this.kit.stone.quad(this.p(m, 0, top + P, 0), this.p(m, e.len, top + P, 0), this.p(m, e.len - t, top + P, -t), this.p(m, t, top + P, -t), c.trim);
        // En las fachadas, el muro sube hasta el tope del antepecho (los ciegos ya llegan).
        if (e.front) this.face(this.kit.stone, m, 0, top, e.len, top + P, 0, c.wall, { pattern: PATTERN.stucco });
      }
    }
    const [mw, md, mh, jitter] = s.crown.machine;
    if (mh > 0 && this.b.floors >= s.crown.machineFloors) {
      const cx = pts.reduce((acc, q) => acc + q.x, 0) / pts.length + (rand(this.seed, 31) - 0.5) * jitter;
      const cz = pts.reduce((acc, q) => acc + q.z, 0) / pts.length + (rand(this.seed, 37) - 0.5) * jitter;
      const e = E.find((q) => q.front) ?? E[0];
      const mm = new THREE.Matrix4().makeBasis(e.x, UP, e.n).setPosition(cx, 0, cz);
      this.box(this.kit.stone, mm, mw, mh, md, 0, top + mh / 2, 0, c.wall, { pattern: PATTERN.stucco });
    }
  }

  /** Punto (x, z) del marco local de la calle a `u` a lo largo del lado y `o` hacia afuera. */
  private at(e: Edge, u: number, o: number): [number, number] {
    return [e.a.x + e.x.x * u + e.n.x * o, e.a.z + e.x.z * u + e.n.z * o];
  }

  private physics(): void {
    const s = this.s;
    const top = this.top;
    // El macizo (hasta la línea de los locales) se trepa y su azotea se camina.
    this.kit.block(this.inner.map((q) => q.clone()), this.base - this.sink, top);
    if (s.portal.depth <= 0 || s.ground <= 0) return;
    const ceiling = this.base + s.ground - s.portal.beam;
    for (const e of this.edges) {
      if (!e.front) continue;
      // Sobre el portal: de la viga a la azotea (debajo se camina).
      const [x, z] = this.at(e, e.len / 2, -s.portal.depth / 2);
      this.kit.box(x, z, e.len / 2, s.portal.depth / 2, Math.atan2(e.x.z, e.x.x), top, true, ceiling);
    }
  }
}
