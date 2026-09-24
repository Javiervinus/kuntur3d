import * as THREE from 'three';
import {
  type Arch,
  type ColumnShape,
  type Profile,
  arc,
  archHole,
  baluster,
  balusterFar,
  bend,
  bracket,
  condor,
  corinthianColumn,
  domeProfile,
  lathe,
  profileLength,
  rectHole,
  rib,
  slab,
  sweep,
  urn,
  wall,
  wreath,
} from './classical';
import { type Glow, type MonumentBase, PATTERN, Parts, type Surface, colorsOf, glowOf } from './monumentParts';

const UP = new THREE.Vector3(0, 1, 0);

/** Bandera colgada de un asta inclinada que sale de la logia. */
interface PalaceFlag {
  /** Fachada (0 norte, 1 oeste, 2 sur, 3 este) y a qué distancia de su esquina izquierda (m). */
  facade: number;
  at: number;
  stripes: string[];
}

/**
 * Palacio ecléctico de manzana entera (el Palacio Municipal de Guayaquil, de Francesco
 * Maccaferri, 1924-1929), en config/game.json → monuments.list. Alturas (`levels`) sobre la
 * vereda; largos en m.
 */
export interface Palace extends MonumentBase {
  /** Largo (eje x local: fachadas norte y sur) y fondo (eje z: fachadas oeste y este). */
  size: number[];
  /** Radio de las esquinas redondeadas (en la línea de fachada). */
  corner: number;
  /** Ancho buscado de cada vano. */
  bay: number;
  /** Tramos de los arcos de las esquinas en planta, y largo máximo de un trozo al curvar un muro. */
  curve: number;
  tessellate: number;
  levels: { impost: number; portal: number; band: number; balcony: number; capital: number; cornice: number };
  arcade: { thickness: number; pier: number; cornerPier: number; cornerSpan: number; archivolt: number[]; keystone: number[]; mezzanine: number[] };
  portal: { depth: number; wall: number; beam: number[]; door: number[]; glassDoors: number; transom: number[]; lamp: number[] };
  balcony: { projection: number; inset: number; rail: number; spacing: number; baluster: number[]; post: number[]; ball: number; plinth: Profile; handrail: Profile; edge: Profile };
  order: { diameter: number; pair: number; setback: number; loggia: number; wall: number; pilaster: number[]; beam: number[] };
  column: ColumnShape;
  windows: { lower: number[]; upper: number[]; frame: number[]; mullion: number; sill: number[]; head: number[] };
  entablature: { architrave: Profile; frieze: number; cornice: Profile; modillion: number[]; dentil: number[] };
  attic: { inset: number; rail: number; spacing: number; pedestal: number[]; urn: number };
  pavilion: {
    width: number;
    projection: number;
    pedestal: number[];
    diameter: number;
    pair: number;
    wall: number[];
    arch: number[];
    archivolt: number[];
    keystone: number[];
    rosettes: number[];
    medallion: number[];
    pitchDeg: number;
    tympanum: number[];
    rake: Profile;
    gate: number[];
    wreath: number[];
    condor: number[];
    acroterion: number[];
  };
  dome: {
    drum: number[];
    rise: number;
    bulge: number;
    top: number;
    steps: number;
    ribs: number;
    rib: number[];
    trim: Profile;
    balcony: number[];
    dormer: number[];
    oculus: number[];
    lantern: number[];
  };
  passage: {
    width: number;
    springing: number;
    wall: number;
    bay: number;
    shop: number[];
    floors: number[];
    window: number[];
    balcony: number[];
    pilaster: number[];
    cornice: Profile;
    ribs: number;
    rib: number[];
    purlins: number;
    crossing: number[];
    lamp: number[];
  };
  roof: number;
  flags: { pole: number[]; size: number[]; list: PalaceFlag[] };
  ao: { portal: number; ceiling: number; arch: number; loggia: number; soffit: number; floor: number; passage: number[]; shutter: number };
  colors: {
    wall: string;
    trim: string;
    ceiling: string;
    column: string;
    dome: string;
    roof: string;
    frame: string;
    iron: string;
    shutter: string;
    door: string;
    floor: string;
    terrazzo: string;
    glass: string;
    vault: string;
    grille: string;
  };
  glass: { roughness: number; metalness: number };
  vault: { roughness: number; metalness: number; opacity: number };
  lights: { share: number; window: Glow; lamp: Glow; dome: Glow };
  /**
   * Distancias (m) hasta las que se ven los capiteles con hojas, los balaustres torneados y los
   * modillones y dentículos (más lejos, su versión simple o nada), y lados de las piezas torneadas.
   */
  detail: { capitals: number; balusters: number; cornice: number; column: number; baluster: number; urn: number; dome: number; condor: number };
}

/** Lo que el palacio necesita de Monuments (world/monuments.ts) para armarse y entrar en la física. */
export interface PalaceKit {
  root: THREE.Group;
  materials: { stone: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; vault: THREE.MeshStandardMaterial };
  /** Altura del suelo del mundo bajo un punto del marco local. */
  terrain(lx: number, lz: number): number;
  /** Rectángulo (marco local, largo en el ángulo `angle` = atan2(z, x) local) que ocupa de `bottom` a `top`. */
  box(lx: number, lz: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  circle(lx: number, lz: number, r: number, top: number, floor: boolean, bottom: number): void;
  /** Sector de anillo con centro propio (ángulos locales). */
  ring(cx: number, cz: number, inner: number, outer: number, angle: number, halfArc: number, top: number, floor: boolean, bottom: number): void;
  /** Bloque macizo (planta local) hasta `top`: entra como edificio (se trepa y se camina encima). */
  block(outline: THREE.Vector3[], top: number): void;
  /** Detalle que solo se ve a menos de `distance` m / su versión de lejos (a partir de ahí). */
  near(o: THREE.Object3D, distance: number): void;
  far(o: THREE.Object3D, distance: number): void;
}

/** Una fachada recta: de su punta izquierda (vista desde afuera) a la derecha, y su esquina. */
interface Facade {
  index: number;
  origin: THREE.Vector3;
  /** A lo largo (izquierda → derecha vista desde afuera) y hacia afuera. */
  x: THREE.Vector3;
  n: THREE.Vector3;
  length: number;
  /** Tiene el pasaje detrás del arco central. */
  passage: boolean;
  /** Esquina a su derecha: centro del redondeo y ángulo (atan2(z, x)) de su normal. */
  center: THREE.Vector3;
  a0: number;
}

/** Posiciones de la arcada en un tramo de fachada: pilar de esquina, vanos y columnas. */
interface Run {
  from: number;
  to: number;
  /** Centros de los vanos y luz de sus arcos. */
  bays: number[];
  width: number;
  /** Columnas de la logia (u) y los pilares que las cargan. */
  columns: number[];
  piers: number[];
  /** Dónde está el pilar de esquina (u de su centro). */
  cornerPier: number;
}

/** Alto de un perfil (de su punto más bajo al más alto). */
const heightOf = (profile: Profile): number => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const q of profile) {
    lo = Math.min(lo, q[1]);
    hi = Math.max(hi, q[1]);
  }
  return hi - lo;
};

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * El macizo en cinco mallas (los cuatro cuadrantes y el pasaje) para que la cámara y las sombras
 * descarten lo que no ven: cada pieza va a la del centro de su caja.
 */
class Quadrants {
  readonly parts: Parts[];
  private readonly box = new THREE.Box3();
  private readonly center = new THREE.Vector3();

  constructor(
    flood: number,
    base: number,
    top: number,
    private readonly passage: { x: number; z: number },
  ) {
    this.parts = Array.from({ length: 5 }, () => new Parts(flood, base, top));
  }

  put(geometry: THREE.BufferGeometry, color: THREE.Color, matrix: THREE.Matrix4, surface: Surface = {}): void {
    geometry.computeBoundingBox();
    this.box.copy(geometry.boundingBox as THREE.Box3).applyMatrix4(matrix).getCenter(this.center);
    const { x, z } = this.center;
    const k = Math.abs(x) < this.passage.x && Math.abs(z) < this.passage.z ? 4 : (x < 0 ? 0 : 1) + (z < 0 ? 0 : 2);
    this.parts[k].put(geometry, color, matrix, surface);
  }
}

/** Matrices de un tipo de pieza repetida (columna, balaustre, jarrón…): una InstancedMesh. */
class Repeats {
  readonly list: THREE.Matrix4[] = [];
  add(m: THREE.Matrix4): void {
    this.list.push(m);
  }
}

/**
 * Arma el Palacio Municipal en `kit.root` (marco local: x al este, z al sur, y desde la vereda):
 * portales en arcada, logia de columnas corintias de dos pisos sobre un balcón corrido,
 * entablamento con modillones y dentículos, ático con balaustrada, jarrones y cóndores, un
 * pabellón con frontón y gran arco al centro de cada fachada, esquinas redondeadas con sus
 * cúpulas de escamas, y el pasaje techado de vidrio que lo cruza de Malecón a Pichincha.
 */
export class PalaceBuilder {
  private readonly col: ReturnType<typeof colorsOf<keyof Palace['colors']>>;
  private readonly facades: Facade[];
  private readonly runs: Run[][] = [];
  private readonly hx: number;
  private readonly hz: number;
  private readonly R: number;
  private base = 0;
  private sink = 0;
  private stone!: Quadrants;
  private glass!: Parts;
  private vault!: Parts;
  private readonly columns = new Repeats();
  private readonly bigColumns = new Repeats();
  private readonly balusters = new Repeats();
  private readonly urns = new Repeats();
  private readonly modillions = new Repeats();
  private readonly dentils = new Repeats();
  private windowCount = 0;
  private top = 0;

  constructor(
    private readonly p: Palace,
    private readonly kit: PalaceKit,
  ) {
    this.col = colorsOf(p.colors);
    this.hx = p.size[0] / 2;
    this.hz = p.size[1] / 2;
    this.R = p.corner;
    const { hx, hz, R } = this;
    const specs: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number, boolean][] = [
      [new THREE.Vector3(hx - R, 0, -hz), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), p.size[0] - 2 * R, false],
      [new THREE.Vector3(-hx, 0, -hz + R), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), p.size[1] - 2 * R, true],
      [new THREE.Vector3(-hx + R, 0, hz), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), p.size[0] - 2 * R, false],
      [new THREE.Vector3(hx, 0, hz - R), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), p.size[1] - 2 * R, true],
    ];
    this.facades = specs.map(([origin, x, n, length, passage], index) => ({
      index,
      origin,
      x,
      n,
      length,
      passage,
      center: origin.clone().addScaledVector(x, length).addScaledVector(n, -R),
      a0: Math.atan2(n.z, n.x),
    }));
    for (const f of this.facades) this.runs.push(this.layout(f));
  }

  /** Punto de la fachada f a `u` de su punta izquierda, `o` hacia afuera de la línea de fachada. */
  private at(f: Facade, u: number, o: number, y = 0): THREE.Vector3 {
    return f.origin.clone().addScaledVector(f.x, u).addScaledVector(f.n, o).setY(y);
  }

  /** Punto de la esquina a la derecha de f, a `s` m de arco (en el radio R) y `o` hacia afuera. */
  private around(f: Facade, s: number, o: number, y = 0): THREE.Vector3 {
    const phi = f.a0 - s / this.R;
    return new THREE.Vector3(f.center.x + (this.R + o) * Math.cos(phi), y, f.center.z + (this.R + o) * Math.sin(phi));
  }

  /** Marco de la fachada (x a lo largo, y arriba, z hacia afuera) en (u, o, y). */
  private frame(f: Facade, u: number, o: number, y = 0): THREE.Matrix4 {
    return new THREE.Matrix4().makeBasis(f.x, UP, f.n).setPosition(this.at(f, u, o, y));
  }

  /** Marco en la esquina (x tangente en el sentido de la fachada, z radial hacia afuera). */
  private frameAround(f: Facade, s: number, o: number, y = 0): THREE.Matrix4 {
    const phi = f.a0 - s / this.R;
    const n = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
    const t = new THREE.Vector3(Math.sin(phi), 0, -Math.cos(phi));
    return new THREE.Matrix4().makeBasis(t, UP, n).setPosition(this.around(f, s, o, y));
  }

  /** Largo del arco de una esquina (en la línea de fachada). */
  private get cornerLength(): number {
    return (Math.PI / 2) * this.R;
  }

  /** Dónde empieza y termina el pabellón central de una fachada. */
  private pavilion(f: Facade): [number, number] {
    const w = this.p.pavilion.width;
    return [f.length / 2 - w / 2, f.length / 2 + w / 2];
  }

  /**
   * Vanos de la fachada: a cada lado del pabellón, el pilar de esquina (con su par de columnas)
   * y los vanos parejos hasta el pabellón, con una columna sobre cada pilar entre vanos.
   */
  private layout(f: Facade): Run[] {
    const a = this.p.arcade;
    const [u0, u1] = this.pavilion(f);
    const make = (from: number, to: number, cornerAtStart: boolean): Run => {
      const bayFrom = cornerAtStart ? from + a.cornerPier : from;
      const bayTo = cornerAtStart ? to : to - a.cornerPier;
      const count = Math.max(1, Math.round((bayTo - bayFrom) / this.p.bay));
      const w = (bayTo - bayFrom) / count;
      const bays = Array.from({ length: count }, (_, k) => bayFrom + (k + 0.5) * w);
      const piers = Array.from({ length: count - 1 }, (_, k) => bayFrom + (k + 1) * w);
      const cornerPier = cornerAtStart ? from + a.cornerPier / 2 : to - a.cornerPier / 2;
      const pair = this.p.order.pair / 2;
      const columns = [...piers, cornerPier - pair, cornerPier + pair].sort((p, q) => p - q);
      return { from, to, bays, width: w, columns, piers, cornerPier };
    };
    return [make(0, u0, true), make(u1, f.length, false)];
  }

  build(): { top: number } {
    const p = this.p;
    const L = p.levels;
    // Base: la vereda a lo largo de la fachada (mediana); lo que baja de ahí se entierra.
    const samples: number[] = [];
    let low = Infinity;
    for (const f of this.facades) {
      for (let u = 0; u <= f.length; u += 2) {
        const q = this.at(f, u, 0);
        const h = this.kit.terrain(q.x, q.z);
        samples.push(h);
        low = Math.min(low, h, this.kit.terrain(q.x - f.n.x * p.portal.depth, q.z - f.n.z * p.portal.depth));
      }
    }
    samples.sort((x, y) => x - y);
    this.base = samples[Math.floor(samples.length / 2)];
    this.sink = this.base - low + 0.3;
    this.kit.root.position.y = this.base;
    const D = p.dome;
    this.top = L.cornice + D.drum[1] + D.rise + D.lantern[1] + D.lantern[2];
    this.stone = new Quadrants(p.flood, this.base, this.top, { x: this.passageEnd(), z: p.passage.width / 2 + p.passage.wall });
    this.glass = new Parts(p.flood, this.base, this.top);
    this.vault = new Parts(0, this.base, this.top);

    for (const f of this.facades) {
      this.arcade(f);
      this.portal(f);
      this.balcony(f);
      this.loggia(f);
      this.attic(f);
      this.pavilionFront(f);
      this.dome(f);
    }
    this.entablature();
    this.roof();
    this.passage();
    this.flags();
    this.physics();
    this.meshes();
    return { top: this.top };
  }

  // ---------------------------------------------------------------------------------------------
  // Ayudas

  /** Oclusión según hacia dónde mira la cara: afuera, adentro o de costado (intradós, jambas). */
  private facing(out: (p: THREE.Vector3) => THREE.Vector3, front: number, back: number, side: number): Surface['ao'] {
    return (q, n) => {
      const d = n.dot(out(q));
      return d > 0.5 ? front : d < -0.5 ? back : side;
    };
  }

  private outward(f: Facade): (q: THREE.Vector3) => THREE.Vector3 {
    return () => f.n;
  }

  private radial(f: Facade): (q: THREE.Vector3) => THREE.Vector3 {
    return (q) => new THREE.Vector3(q.x - f.center.x, 0, q.z - f.center.z).normalize();
  }

  /** Caja de w × h × d con su centro en (x, y, z) del marco `m`. */
  private box(w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}): void {
    this.stone.put(new THREE.BoxGeometry(w, h, d), color, m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)), surface);
  }

  /** Recorrido en planta (y = 0) por el perímetro, a `o` de la línea de fachada, con los pabellones salientes `bump`. */
  private perimeter(o: number, bump: number): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (const f of this.facades) {
      const [u0, u1] = this.pavilion(f);
      pts.push(this.at(f, 0, o));
      if (bump > 0) pts.push(this.at(f, u0, o), this.at(f, u0, o + bump), this.at(f, u1, o + bump), this.at(f, u1, o));
      for (let i = 0; i < this.p.curve; i++) pts.push(this.around(f, (this.cornerLength * i) / this.p.curve, o));
    }
    return pts;
  }

  /** Tramo de la fachada f de u = a a u = b, a `o` de la línea (y = 0). */
  private straight(f: Facade, a: number, b: number, o: number): THREE.Vector3[] {
    return [this.at(f, a, o), this.at(f, b, o)];
  }

  /** Arco de la esquina a la derecha de f a `o` de la línea (incluye las dos puntas). */
  private cornerArc(f: Facade, o: number): THREE.Vector3[] {
    return Array.from({ length: this.p.curve + 1 }, (_, i) => this.around(f, (this.cornerLength * i) / this.p.curve, o));
  }

  /** Moldura a lo largo de un recorrido en el sentido de las fachadas (se da vuelta: afuera queda a la derecha). */
  private molding(points: THREE.Vector3[], y: number, profile: Profile, color: THREE.Color, closed: boolean, surface: Surface = {}): void {
    const pts = points.map((q) => q.clone().setY(y)).reverse();
    this.stone.put(sweep(pts, UP, profile, { closed }), color, new THREE.Matrix4(), surface);
  }

  /** Zócalo y pasamanos de una baranda de alto `height` que arranca en y. */
  private rails(points: THREE.Vector3[], y: number, height: number): void {
    const B = this.p.balcony;
    this.molding(points, y, B.plinth, this.col.trim, false);
    this.molding(points, y + height - heightOf(B.handrail), B.handrail, this.col.trim, false);
  }

  /**
   * Balaustres cada `spacing` entre el zócalo y el pasamanos de una baranda de alto `height` que
   * arranca en y, sin pisar los postes (a `posts` m del inicio del recorrido).
   */
  private balustrade(points: THREE.Vector3[], y0: number, railHeight: number, spacing: number, posts: number[], postWidth: number): void {
    const B = this.p.balcony;
    const [bw] = B.baluster;
    const y = y0 + heightOf(B.plinth);
    const height = railHeight - heightOf(B.plinth) - heightOf(B.handrail);
    let acc = 0;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const len = a.distanceTo(b);
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      const start = Math.ceil((acc + spacing / 2) / spacing) * spacing - acc - spacing / 2;
      for (let s = Math.max(start, 0); s < len; s += spacing) {
        const along = acc + s;
        if (posts.some((q) => Math.abs(q - along) < postWidth / 2 + bw * 0.7)) continue;
        const q = a.clone().addScaledVector(dir, s).setY(y);
        const m = new THREE.Matrix4().makeBasis(dir, UP, new THREE.Vector3().crossVectors(dir, UP)).setPosition(q);
        this.balusters.add(m.multiply(new THREE.Matrix4().makeScale(1, height / this.p.balcony.baluster[1], 1)));
      }
      acc += len;
    }
  }

  /** Largo acumulado de un recorrido hasta cada punto (para ubicar postes por distancia). */
  private static lengths(points: THREE.Vector3[]): number[] {
    const out = [0];
    for (let k = 1; k < points.length; k++) out.push(out[k - 1] + points[k - 1].distanceTo(points[k]));
    return out;
  }

  /** Punto a `s` m a lo largo de un recorrido. */
  private static along(points: THREE.Vector3[], s: number): { at: THREE.Vector3; dir: THREE.Vector3 } {
    let acc = 0;
    for (let k = 1; k < points.length; k++) {
      const len = points[k - 1].distanceTo(points[k]);
      if (acc + len >= s || k === points.length - 1) {
        const dir = new THREE.Vector3().subVectors(points[k], points[k - 1]).normalize();
        return { at: points[k - 1].clone().addScaledVector(dir, Math.min(s - acc, len)), dir };
      }
      acc += len;
    }
    return { at: points[0].clone(), dir: new THREE.Vector3(1, 0, 0) };
  }

  /** Ventana en el hueco (x0…x1, y0…y1) de un muro de grosor `depth` (marco m, cara en z = 0). */
  private window(m: THREE.Matrix4, x0: number, x1: number, y0: number, y1: number, depth: number, lit: boolean, sill = true, head = true): void {
    const W = this.p.windows;
    const c = this.col;
    const [frame, frameDepth] = W.frame;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const h = y1 - y0;
    const z = -depth * 0.55;
    // Marco, parteluz y travesaño, y el vidrio detrás.
    this.box(w, frame, frameDepth, cx, y0 + frame / 2, z, m, c.frame);
    this.box(w, frame, frameDepth, cx, y1 - frame / 2, z, m, c.frame);
    this.box(frame, h, frameDepth, x0 + frame / 2, (y0 + y1) / 2, z, m, c.frame);
    this.box(frame, h, frameDepth, x1 - frame / 2, (y0 + y1) / 2, z, m, c.frame);
    this.box(W.mullion, h, frameDepth * 0.8, cx, (y0 + y1) / 2, z, m, c.frame);
    this.box(w, W.mullion, frameDepth * 0.8, cx, y1 - h * 0.28, z, m, c.frame);
    const glow = lit ? glowOf(this.p.lights.window) : undefined;
    this.glass.put(new THREE.PlaneGeometry(w, h), c.glass, m.clone().multiply(new THREE.Matrix4().makeTranslation(cx, (y0 + y1) / 2, z - frameDepth * 0.3)), { glow });
    const [sillH, sillOut] = W.sill;
    if (sill) this.box(w + 0.2, sillH, depth * 0.5 + sillOut, cx, y0 - sillH / 2, sillOut - depth * 0.25, m, c.trim);
    const [headH, headOut] = W.head;
    if (head) this.box(w + 0.3, headH, headOut * 2, cx, y1 + headH / 2 + 0.05, 0, m, c.trim);
    this.windowCount++;
  }

  /** ¿Se enciende de noche la ventana número k? */
  private lit(): boolean {
    return rand(this.windowCount, 7) < this.p.lights.share;
  }

  /** Piso que sigue el terreno (marco local) en una grilla de puntos por (i, j): uv en metros. */
  private floor(grid: (i: number, j: number) => THREE.Vector3, ni: number, nj: number, uvOf: (q: THREE.Vector3) => number[], color: THREE.Color, pattern: number, ao: Surface['ao']): void {
    const pos: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= nj; j++) {
      for (let i = 0; i <= ni; i++) {
        const q = grid(i, j);
        const y = this.kit.terrain(q.x, q.z) - this.base + 0.03;
        pos.push(q.x, y, q.z);
        uv.push(...uvOf(q));
      }
    }
    const row = ni + 1;
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const a = j * row + i;
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    // Que mire hacia arriba aunque la grilla haya salido al revés.
    const n = g.getAttribute('normal');
    if (n.getY(0) < 0) {
      const idx = g.getIndex() as THREE.BufferAttribute;
      for (let t = 0; t < idx.count; t += 3) {
        const b = idx.getX(t + 1);
        idx.setX(t + 1, idx.getX(t + 2));
        idx.setX(t + 2, b);
      }
      g.computeVertexNormals();
    }
    this.stone.put(g, color, new THREE.Matrix4(), { pattern, ao });
  }

  // ---------------------------------------------------------------------------------------------
  // Planta baja: arcada, portal y su piso

  private arcade(f: Facade): void {
    const p = this.p;
    const A = p.arcade;
    const L = p.levels;
    const c = this.col;
    const out = this.outward(f);
    const [mw, mh, off, my] = A.mezzanine;
    const [avWidth, avDepth] = A.archivolt;
    const [kw, kd] = A.keystone;
    const stucco: Surface = { pattern: PATTERN.stucco, ao: this.facing(out, 1, p.ao.portal, p.ao.arch) };
    for (const run of this.runs[f.index]) {
      const span = run.width - A.pier;
      const arches: Arch[] = run.bays.map((center) => ({ center, span, impost: L.impost }));
      const holes = run.bays.flatMap((b) => [-1, 1].map((s) => rectHole(b + s * off - mw / 2, my - mh / 2, b + s * off + mw / 2, my + mh / 2)));
      const m = this.frame(f, 0, 0);
      this.stone.put(wall(run.from, run.to, -this.sink, L.band, A.thickness, arches, holes, 12), c.wall, m, { ...stucco, pattern: PATTERN.stucco });
      for (const b of run.bays) {
        // Rejillas del entresuelo, arquivolta y la ménsula de la clave (que carga el balcón).
        for (const s of [-1, 1]) this.box(mw, mh, 0.05, b + s * off, my, -A.thickness * 0.5, m, c.grille, { ao: p.ao.arch });
        this.archivolt(m, b, L.impost, span / 2, avWidth, avDepth);
        const crown = L.impost + span / 2;
        this.stone.put(bracket(kw, L.band - crown + 0.15, kd), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(b, crown - 0.15, 0)));
      }
    }
    // Esquina: el muro curvo con su arco grande al medio.
    const Lc = this.cornerLength;
    const span = A.cornerSpan;
    const flat = wall(0, Lc, -this.sink, L.band, A.thickness, [{ center: Lc / 2, span, impost: L.impost }], [], 16);
    this.stone.put(bend(flat, this.R, f.center.x, f.center.z, f.a0, p.tessellate), c.wall, new THREE.Matrix4(), {
      pattern: PATTERN.stucco,
      ao: this.facing(this.radial(f), 1, p.ao.portal, p.ao.arch),
    });
    const ring = this.archivolt(null, Lc / 2, L.impost, span / 2, avWidth, avDepth);
    this.stone.put(bend(ring, this.R, f.center.x, f.center.z, f.a0, p.tessellate), c.trim, new THREE.Matrix4());
    const crown = L.impost + span / 2;
    this.stone.put(bracket(kw, L.band - crown + 0.15, kd), c.trim, this.frameAround(f, Lc / 2, 0, crown - 0.15));
  }

  /** Arquivolta: media corona moldurada alrededor de un arco (en el marco m, o suelta si m es null). */
  private archivolt(m: THREE.Matrix4 | null, cx: number, impost: number, r: number, width: number, depth: number): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, r + width, 0, Math.PI, false);
    shape.lineTo(-r, 0);
    shape.absarc(0, 0, r, Math.PI, 0, true);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 });
    g.translate(cx, impost, 0);
    if (m) this.stone.put(g, this.col.trim, m);
    return g;
  }

  private portal(f: Facade): void {
    const p = this.p;
    const P = p.portal;
    const L = p.levels;
    const A = p.arcade;
    const c = this.col;
    const g = p.passage.width;
    const mid = f.length / 2;
    // Tramos del portal: toda la fachada, menos el cruce del pasaje en las de Malecón y Pichincha.
    const spans: [number, number][] = f.passage ? [[0, mid - g / 2], [mid + g / 2, f.length]] : [[0, f.length]];
    const [beamW, beamH] = P.beam;
    for (const [a, b] of spans) {
      const strip = [this.at(f, a, -A.thickness), this.at(f, b, -A.thickness), this.at(f, b, -P.depth), this.at(f, a, -P.depth)];
      this.stone.put(slab(strip, L.portal, L.portal + 0.3), c.ceiling, new THREE.Matrix4(), { ao: p.ao.ceiling });
    }
    // Esquina del cielo raso.
    const outer = this.cornerArc(f, -A.thickness);
    const inner = this.cornerArc(f, -P.depth).reverse();
    this.stone.put(slab([...outer, ...inner], L.portal, L.portal + 0.3), c.ceiling, new THREE.Matrix4(), { ao: p.ao.ceiling });
    // Vigas del cielo raso sobre cada pilar.
    for (const run of this.runs[f.index]) {
      for (const u of run.piers) {
        const m = this.frame(f, u, -(A.thickness + P.depth) / 2);
        this.box(beamW, beamH, P.depth - A.thickness, 0, L.portal - beamH / 2, 0, m, c.ceiling, { ao: p.ao.ceiling });
      }
    }
    // Muro del fondo: una puerta por vano (cortina metálica o vidriera) y el portón bajo el arco.
    const wallFront = -P.depth;
    const m = this.frame(f, 0, wallFront);
    const [dw, dh] = P.door;
    const doors: { center: number; w: number; h: number; gate: boolean }[] = [];
    for (const run of this.runs[f.index]) for (const b of run.bays) doors.push({ center: b, w: dw, h: dh, gate: false });
    if (!f.passage) doors.push({ center: mid, w: p.pavilion.gate[0], h: p.pavilion.gate[1], gate: true });
    const pieces: [number, number][] = f.passage ? [[-0.01, mid - g / 2], [mid + g / 2, f.length + 0.01]] : [[-0.01, f.length + 0.01]];
    const ao = this.facing(this.outward(f), p.ao.portal, 1, p.ao.arch);
    for (const [a, b] of pieces) {
      // Las puertas llegan hasta el suelo (vanos abiertos desde abajo del muro).
      const openings = doors.filter((d) => d.center > a && d.center < b).map((d) => ({ center: d.center, span: d.w, impost: d.h, flat: true }));
      this.stone.put(wall(a, b, -this.sink, L.portal, P.wall, openings, [], 4), c.wall, m, { pattern: PATTERN.stucco, ao });
    }
    const [transomH, transomGap] = P.transom;
    for (const [k, d] of doors.entries()) {
      if (f.passage && Math.abs(d.center - mid) < g / 2) continue;
      const inset = P.wall * 0.6;
      // El suelo no es parejo (la vereda baja hacia el Malecón): cada puerta arranca del suyo.
      const foot = this.at(f, d.center, wallFront + inset);
      const y0 = Math.min(this.kit.terrain(foot.x, foot.z) - this.base, d.h - 1);
      if (d.gate) {
        // Portón de hierro: rejas verticales sobre vidrio oscuro.
        const gh = d.h - y0;
        this.glass.put(new THREE.PlaneGeometry(d.w, gh), c.glass, m.clone().multiply(new THREE.Matrix4().makeTranslation(d.center, y0 + gh / 2, -inset - 0.05)));
        for (let x = -d.w / 2; x <= d.w / 2 + 1e-6; x += d.w / 12) this.box(0.05, gh, 0.06, d.center + x, y0 + gh / 2, -inset, m, c.iron);
        for (const y of [y0 + gh * 0.25, y0 + gh * 0.62, d.h - 0.05]) this.box(d.w, 0.08, 0.07, d.center, y, -inset, m, c.iron);
        continue;
      }
      const shutter = rand(k + f.index * 50, 3) >= P.glassDoors;
      const doorTop = d.h - transomH - transomGap;
      const doorH = doorTop - y0;
      if (shutter) {
        const s = new THREE.BoxGeometry(d.w, doorH, 0.04);
        this.stone.put(s, c.shutter, m.clone().multiply(new THREE.Matrix4().makeTranslation(d.center, y0 + doorH / 2, -inset)), {
          pattern: PATTERN.shutter,
          scale: [d.w, doorH],
          ao: p.ao.shutter,
        });
      } else {
        this.glass.put(new THREE.PlaneGeometry(d.w, doorH), c.glass, m.clone().multiply(new THREE.Matrix4().makeTranslation(d.center, y0 + doorH / 2, -inset)), {
          glow: this.lit() ? glowOf(p.lights.window) : undefined,
        });
        this.box(0.06, doorH, 0.08, d.center, y0 + doorH / 2, -inset + 0.02, m, c.frame);
      }
      // Montante de vidrio sobre la puerta.
      this.glass.put(new THREE.PlaneGeometry(d.w, transomH), c.glass, m.clone().multiply(new THREE.Matrix4().makeTranslation(d.center, d.h - transomH / 2, -inset)));
      this.box(d.w, transomGap, 0.1, d.center, doorTop + transomGap / 2, -inset + 0.02, m, c.frame);
    }
    // Rincón del fondo en la esquina (curvo, sin puertas).
    const rIn = this.R - P.depth;
    if (rIn > 0.05) {
      const len = (Math.PI / 2) * rIn;
      const flat = wall(0, len, -this.sink, L.portal, P.wall, [], [], 2);
      this.stone.put(bend(flat, rIn, f.center.x, f.center.z, f.a0, p.tessellate), c.wall, new THREE.Matrix4(), { pattern: PATTERN.stucco, ao: p.ao.portal });
    }
    // Faroles colgados en el centro de cada vano.
    const [lampR, lampDrop] = P.lamp;
    for (const run of this.runs[f.index]) {
      for (const b of run.bays) {
        const lm = this.frame(f, b, -(A.thickness + P.depth) / 2);
        this.box(0.03, lampDrop, 0.03, 0, L.portal - lampDrop / 2, 0, lm, c.iron);
        this.stone.put(new THREE.SphereGeometry(lampR, 10, 6), c.trim, lm.clone().multiply(new THREE.Matrix4().makeTranslation(0, L.portal - lampDrop - lampR, 0)), {
          glow: glowOf(p.lights.lamp),
        });
      }
    }
    // Piso de baldosas del portal (sigue el terreno), de la línea de fachada al muro del fondo.
    const floorAo: Surface['ao'] = (q) => {
      const o = new THREE.Vector3().subVectors(q, f.origin).dot(f.n);
      return THREE.MathUtils.lerp(p.ao.floor, 1, THREE.MathUtils.clamp((o + P.depth) / P.depth, 0, 1));
    };
    for (const [a, b] of spans) {
      const ni = Math.max(1, Math.ceil(b - a));
      this.floor(
        (i, j) => this.at(f, a + ((b - a) * i) / ni, -(P.depth * j) / 2),
        ni,
        2,
        (q) => [q.x, q.z],
        c.floor,
        PATTERN.tiles,
        floorAo,
      );
    }
    this.floor(
      (i, j) => this.around(f, (this.cornerLength * i) / this.p.curve, -(P.depth * j) / 2),
      this.p.curve,
      2,
      (q) => [q.x, q.z],
      c.floor,
      PATTERN.tiles,
      p.ao.floor,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Balcón corrido y logia

  private balcony(f: Facade): void {
    const p = this.p;
    const B = p.balcony;
    const L = p.levels;
    const O = p.order;
    const c = this.col;
    const [postW, postH] = B.post;
    const railO = B.projection - B.inset;
    const [, u1] = this.pavilion(f);
    const next = this.facades[(f.index + 1) % 4];
    const [n0] = this.pavilion(next);
    // Losa: de la pared de la logia al borde del balcón, por el tramo derecho de f, la esquina y
    // el tramo izquierdo de la fachada siguiente.
    const outline = (o: number): THREE.Vector3[] => [this.at(f, u1, o), ...this.cornerArc(f, o), this.at(next, n0, o)];
    const front = outline(B.projection);
    const back = outline(-O.loggia).reverse();
    this.stone.put(slab([...front, ...back], L.band, L.balcony), c.wall, new THREE.Matrix4(), { ao: p.ao.soffit });
    this.molding(outline(0), L.balcony + 0.02 - heightOf(B.edge), B.edge, c.trim, false);

    // Baranda: zócalo, balaustres y pasamanos entre postes; postes frente a cada columna, con su bola.
    const rail = outline(railO);
    const lengths = PalaceBuilder.lengths(rail);
    const total = lengths[lengths.length - 1];
    const posts: number[] = [0, total];
    // Postes frente a las columnas del tramo derecho de f y el izquierdo de next, y cada ~3 m en la esquina.
    const rightRun = this.runs[f.index][1];
    for (const u of rightRun.columns) posts.push(u - u1);
    const cornerStart = f.length - u1;
    const arcLen = lengths[lengths.length - 1] - cornerStart - n0;
    const cornerPosts = Math.max(1, Math.round(arcLen / 3));
    for (let k = 1; k < cornerPosts; k++) posts.push(cornerStart + (arcLen * k) / cornerPosts);
    const leftRun = this.runs[next.index][0];
    for (const u of leftRun.columns) posts.push(total - (n0 - u));
    this.rails(rail, L.balcony, B.rail);
    for (const s of posts) {
      const { at, dir } = PalaceBuilder.along(rail, Math.min(Math.max(s, 0.01), total - 0.01));
      const m = new THREE.Matrix4().makeBasis(dir, UP, new THREE.Vector3().crossVectors(dir, UP)).setPosition(at.setY(L.balcony));
      this.box(postW, postH, postW, 0, postH / 2, 0, m, c.trim);
      this.stone.put(new THREE.SphereGeometry(B.ball, 10, 7), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, postH + B.ball * 0.9, 0)));
    }
    this.balustrade(rail, L.balcony, B.rail, B.spacing, posts, postW);
  }

  private loggia(f: Facade): void {
    const p = this.p;
    const O = p.order;
    const L = p.levels;
    const W = p.windows;
    const c = this.col;
    const [pw, pd] = O.pilaster;
    const [beamW, beamH] = O.beam;
    const height = L.capital - L.balcony;
    for (const run of this.runs[f.index]) {
      for (const u of run.columns) this.columns.add(this.frame(f, u, -O.setback, L.balcony));
      // Pared del fondo de la logia, con dos pisos de ventanas en cada vano.
      const m = this.frame(f, 0, -O.loggia);
      const holes: THREE.Path[] = [];
      const [lw, lh, ly] = W.lower;
      const [uw, uh, uy] = W.upper;
      for (const b of run.bays) holes.push(rectHole(b - lw / 2, ly, b + lw / 2, ly + lh), rectHole(b - uw / 2, uy, b + uw / 2, uy + uh));
      this.stone.put(wall(run.from, run.to, L.balcony, L.capital + 0.2, O.wall, [], holes, 4), c.wall, m, { pattern: PATTERN.stucco, ao: p.ao.loggia });
      for (const b of run.bays) {
        this.window(m, b - lw / 2, b + lw / 2, ly, ly + lh, O.wall, this.lit());
        this.window(m, b - uw / 2, b + uw / 2, uy, uy + uh, O.wall, this.lit());
      }
      // Pilastras detrás de cada columna y vigas del cielo raso de la logia.
      for (const u of run.columns) {
        this.box(pw, height, pd, u, L.balcony + height / 2, pd / 2, m, c.wall, { pattern: PATTERN.stucco, ao: p.ao.loggia });
        this.box(pw + 0.1, 0.35, pd + 0.06, u, L.capital - 0.175, pd / 2, m, c.trim, { ao: p.ao.loggia });
        const bm = this.frame(f, u, -O.loggia / 2);
        this.box(beamW, beamH, O.loggia, 0, L.capital - beamH / 2, 0, bm, c.wall, { ao: p.ao.soffit });
      }
      // Macizo del entablamento sobre la logia (su cara de abajo es el cielo raso).
      const strip = [this.at(f, run.from, 0), this.at(f, run.to, 0), this.at(f, run.to, -O.loggia), this.at(f, run.from, -O.loggia)];
      this.stone.put(slab(strip, L.capital, L.cornice - 0.2), c.wall, new THREE.Matrix4(), { ao: p.ao.soffit });
    }
    // Esquina: pared curva con una ventana por piso y su macizo arriba.
    const rIn = this.R - O.loggia;
    const len = (Math.PI / 2) * rIn;
    const [lw, lh, ly] = W.lower;
    const [uw, uh, uy] = W.upper;
    const holes = [rectHole(len / 2 - lw / 2, ly, len / 2 + lw / 2, ly + lh), rectHole(len / 2 - uw / 2, uy, len / 2 + uw / 2, uy + uh)];
    const flat = wall(0, len, L.balcony, L.capital + 0.2, O.wall, [], holes, 4);
    this.stone.put(bend(flat, rIn, f.center.x, f.center.z, f.a0, p.tessellate), c.wall, new THREE.Matrix4(), { pattern: PATTERN.stucco, ao: p.ao.loggia });
    const mid = f.a0 - Math.PI / 4;
    const mm = new THREE.Matrix4()
      .makeBasis(new THREE.Vector3(Math.sin(mid), 0, -Math.cos(mid)), UP, new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)))
      .setPosition(f.center.x + rIn * Math.cos(mid), 0, f.center.z + rIn * Math.sin(mid));
    this.window(mm, -lw / 2, lw / 2, ly, ly + lh, O.wall, this.lit());
    this.window(mm, -uw / 2, uw / 2, uy, uy + uh, O.wall, this.lit());
    const outer = this.cornerArc(f, 0);
    const inner = this.cornerArc(f, -O.loggia).reverse();
    this.stone.put(slab([...outer, ...inner], L.capital, L.cornice - 0.2), c.wall, new THREE.Matrix4(), { ao: p.ao.soffit });
  }

  // ---------------------------------------------------------------------------------------------
  // Entablamento, ático y terraza

  private entablature(): void {
    const p = this.p;
    const E = p.entablature;
    const L = p.levels;
    const c = this.col;
    const pp = p.pavilion.projection;
    const path = this.perimeter(0, pp);
    const archH = E.architrave[E.architrave.length - 1][1];
    const corniceH = E.cornice[E.cornice.length - 1][1];
    this.molding(path, L.capital, E.architrave, c.wall, true, { pattern: PATTERN.stucco });
    const friezeY = L.capital + archH;
    this.molding(
      path,
      friezeY,
      [
        [0, 0],
        [0.02, 0],
        [0.02, E.frieze],
        [0, E.frieze],
      ],
      c.wall,
      true,
      { pattern: PATTERN.stucco },
    );
    const corniceY = L.cornice - corniceH;
    this.molding(path, corniceY, E.cornice, c.trim, true, { pattern: PATTERN.stucco });
    // Modillones bajo la corona y dentículos, repartidos a lo largo del perímetro: [paso, ancho,
    // alto, vuelo, a qué distancia de la línea arrancan, altura de su tope en la cornisa].
    const [modSpacing, , modH, , modA, modY] = E.modillion;
    const [denSpacing, , denH, , denA, denY] = E.dentil;
    const outer = path.map((q) => q.clone()).reverse();
    const lengths = PalaceBuilder.lengths([...outer, outer[0]]);
    const total = lengths[lengths.length - 1];
    const loop = [...outer, outer[0]];
    for (const [spacing, repeats, a, y] of [
      [modSpacing, this.modillions, modA, corniceY + modY - modH],
      [denSpacing, this.dentils, denA, corniceY + denY - denH],
    ] as const) {
      for (let s = spacing / 2; s < total; s += spacing) {
        const { at, dir } = PalaceBuilder.along(loop, s);
        const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
        // Ni en los quiebres de los pabellones (el recorrido dobla ahí).
        repeats.add(new THREE.Matrix4().makeBasis(dir.clone().negate(), UP, side).setPosition(at.addScaledVector(side, a).setY(y)));
      }
    }
  }

  private attic(f: Facade): void {
    const p = this.p;
    const T = p.attic;
    const L = p.levels;
    const c = this.col;
    const [pedW, pedH] = T.pedestal;
    for (const run of this.runs[f.index]) {
      // De la esquina (donde está la cúpula) al pabellón; un pedestal con jarrón sobre cada columna.
      const from = run.from === 0 ? run.cornerPier : run.from;
      const to = run.from === 0 ? run.to : run.cornerPier;
      const rail = this.straight(f, from, to, -T.inset);
      const posts = [0, to - from];
      const singles = run.piers.filter((u) => u > from && u < to);
      for (const u of singles) posts.push(u - from);
      this.rails(rail, L.cornice, T.rail);
      this.balustrade(rail, L.cornice, T.rail, T.spacing, posts, pedW);
      for (const s of posts) {
        const m = this.frame(f, from + s, -T.inset, L.cornice);
        this.box(pedW, pedH, pedW, 0, pedH / 2, 0, m, c.trim, { pattern: PATTERN.stucco });
        this.urns.add(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, pedH, 0)));
      }
    }
  }

  private roof(): void {
    const p = this.p;
    const L = p.levels;
    const P = p.passage;
    const xp = this.passageEnd();
    const outline = this.perimeter(-0.05, p.pavilion.projection);
    const hole = [
      new THREE.Vector3(-xp, 0, -P.width / 2),
      new THREE.Vector3(xp, 0, -P.width / 2),
      new THREE.Vector3(xp, 0, P.width / 2),
      new THREE.Vector3(-xp, 0, P.width / 2),
    ];
    this.stone.put(slab(outline, L.cornice - p.roof, L.cornice, [hole]), this.col.roof, new THREE.Matrix4(), { ao: p.ao.floor });
  }

  // ---------------------------------------------------------------------------------------------
  // Pabellón central: pedestales, columnas pareadas, gran arco y frontón

  private pavilionFront(f: Facade): void {
    const p = this.p;
    const V = p.pavilion;
    const L = p.levels;
    const c = this.col;
    const mid = f.length / 2;
    const pp = V.projection;
    const [pedW, pedTop, pedD] = V.pedestal;
    const axisO = pp - pedD / 2;
    const [inset, depth] = V.wall;
    const wallFront = axisO - inset;
    const [span, impost] = V.arch;
    const stucco: Surface = { pattern: PATTERN.stucco, ao: this.facing(this.outward(f), 1, p.ao.portal, p.ao.arch) };
    for (const s of [-1, 1]) {
      const pu = mid + s * (V.width / 2 - pedW / 2);
      const m = this.frame(f, pu, axisO);
      this.box(pedW, pedTop + this.sink, pedD, 0, (pedTop - this.sink) / 2, 0, m, c.wall, stucco);
      this.box(pedW + 0.16, 0.3, pedD + 0.16, 0, pedTop - 0.15, 0, m, c.trim);
      this.box(pedW + 0.1, 0.35, pedD + 0.1, 0, 0.175, 0, m, c.wall, stucco);
      const [mr, mt] = V.medallion;
      this.stone.put(new THREE.CylinderGeometry(mr, mr, mt, 24).rotateX(Math.PI / 2), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, pedTop * 0.58, pedD / 2 + mt / 2)));
      for (const t of [-1, 1]) this.bigColumns.add(this.frame(f, pu + (t * V.pair) / 2, axisO, pedTop));
    }
    // Muro del arco (entre los pedestales, detrás de las columnas), con el gran arco abierto.
    const x0 = mid - V.width / 2 + pedW * 0.5;
    const x1 = mid + V.width / 2 - pedW * 0.5;
    const m = this.frame(f, 0, wallFront);
    this.stone.put(wall(x0, x1, -this.sink, L.capital, depth, [{ center: mid, span, impost }], [], 24), c.wall, m, stucco);
    // Macizo del pabellón sobre el muro del arco (detrás de su entablamento y frontón).
    const mass = [this.at(f, mid - V.width / 2, pp), this.at(f, mid + V.width / 2, pp), this.at(f, mid + V.width / 2, wallFront - depth), this.at(f, mid - V.width / 2, wallFront - depth)];
    this.stone.put(slab(mass, L.capital, L.cornice - 0.2), c.wall, new THREE.Matrix4(), { ao: p.ao.soffit });
    const [avW, avD] = V.archivolt;
    this.archivolt(m, mid, impost, span / 2, avW, avD);
    const [kw, kh, kd] = V.keystone;
    this.stone.put(bracket(kw, kh, kd), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(mid, impost + span / 2 - 0.1, 0)));
    // Impostas y rosetones en el intradós.
    for (const s of [-1, 1]) this.box(0.5, 0.3, depth + 0.1, mid + s * (span / 2 + 0.25), impost - 0.15, -depth / 2, m, c.trim);
    const [rr, rt, count] = V.rosettes;
    for (let k = 0; k < count; k++) {
      const a = (Math.PI * (k + 0.5)) / count;
      const q = new THREE.Vector3(mid + Math.cos(a) * (span / 2 - rt / 2), impost + Math.sin(a) * (span / 2 - rt / 2), -depth / 2);
      const look = new THREE.Matrix4().lookAt(q, new THREE.Vector3(mid, impost, -depth / 2), UP);
      look.setPosition(q);
      this.stone.put(new THREE.CylinderGeometry(rr, rr, rt, 12).rotateX(Math.PI / 2), c.trim, m.clone().multiply(look));
    }

    // Frontón sobre la cornisa: tímpano, cornisas inclinadas y remates.
    const corniceProj = p.entablature.cornice.reduce((mx, q) => Math.max(mx, q[0]), 0);
    const half = V.width / 2 + corniceProj;
    const pitch = THREE.MathUtils.degToRad(V.pitchDeg);
    const rise = half * Math.tan(pitch);
    const [tymInset, tymDepth] = V.tympanum;
    const tri = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
    const tym = new THREE.ExtrudeGeometry(tri, { depth: tymDepth, bevelEnabled: false });
    tym.translate(mid, L.cornice, -tymDepth);
    this.stone.put(tym, c.wall, this.frame(f, 0, pp - tymInset), { pattern: PATTERN.stucco });
    const rakePath = [this.at(f, mid - half, pp, L.cornice), this.at(f, mid, pp, L.cornice + rise), this.at(f, mid + half, pp, L.cornice)];
    this.stone.put(sweep(rakePath, f.n, V.rake), c.trim, new THREE.Matrix4());
    if (!f.passage) {
      // Escudo de Guayaquil (corona de laurel con la estrella) al centro del tímpano.
      const [wr, wd] = V.wreath;
      const { ring, star } = wreath(wr, wd, 12);
      const wm = this.frame(f, mid, pp - tymInset, L.cornice + rise * 0.42);
      this.stone.put(ring, c.trim, wm);
      this.stone.put(star, c.trim, wm);
    }
    const [condorSpan, raise, stand] = V.condor;
    const bird = condor(condorSpan, raise, this.p.detail.condor);
    for (const s of [-1, 1]) {
      const cm = this.frame(f, mid + s * (half - 0.4), pp - 0.5, L.cornice);
      this.box(0.8, stand, 0.8, 0, stand / 2, 0, cm, c.trim);
      this.stone.put(bird.clone(), c.trim, cm.clone().multiply(new THREE.Matrix4().makeTranslation(0, stand, 0)));
    }
    bird.dispose();
    const [acW, acH] = V.acroterion;
    const am = this.frame(f, mid, pp - 0.4, L.cornice + rise);
    this.box(acW, acH, acW, 0, acH / 2 - 0.2, 0, am, c.trim);
    this.urns.add(am.clone().multiply(new THREE.Matrix4().makeTranslation(0, acH - 0.2, 0)));
  }

  // ---------------------------------------------------------------------------------------------
  // Cúpula de esquina

  private dome(f: Facade): void {
    const p = this.p;
    const D = p.dome;
    const L = p.levels;
    const B = p.balcony;
    const c = this.col;
    const [rd, drumH] = D.drum;
    const cx = f.center.x;
    const cz = f.center.z;
    const diag = f.a0 - Math.PI / 4;
    const y0 = L.cornice - p.roof;
    const domeY = L.cornice + drumH;
    // Tambor, su cornisa y pilastras.
    this.stone.put(new THREE.CylinderGeometry(rd, rd, domeY - y0, p.detail.dome, 1, true).translate(cx, (y0 + domeY) / 2, cz), c.wall, new THREE.Matrix4(), {
      pattern: PATTERN.stucco,
    });
    const circle = arc(cx, cz, rd, 0, Math.PI * 2, p.detail.dome).slice(0, -1);
    this.molding(circle, domeY - D.trim[D.trim.length - 1][1], D.trim, c.trim, true);
    for (let k = 0; k < D.ribs; k++) {
      const a = diag + Math.PI / D.ribs + (k * Math.PI * 2) / D.ribs;
      const m = new THREE.Matrix4()
        .makeBasis(new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), UP, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
        .setPosition(cx + Math.cos(a) * rd, 0, cz + Math.sin(a) * rd);
      this.box(0.45, drumH, 0.12, 0, L.cornice + drumH / 2, 0.06, m, c.trim);
    }
    // Balcón redondo al pie de la cúpula, del lado de afuera.
    const [rb, arcDeg] = D.balcony;
    const half = THREE.MathUtils.degToRad(arcDeg) / 2;
    const segs = Math.max(4, Math.round(p.curve * (arcDeg / 90)));
    const rail = arc(cx, cz, rb, diag + half, diag - half, segs, 0);
    const total = PalaceBuilder.lengths(rail)[rail.length - 1];
    const [postW, postH] = B.post;
    const posts = [0, total * 0.25, total * 0.5, total * 0.75, total];
    this.rails(rail, L.cornice, B.rail);
    this.balustrade(rail, L.cornice, B.rail, B.spacing, posts, postW);
    for (const s of posts) {
      const { at, dir } = PalaceBuilder.along(rail, Math.min(Math.max(s, 0.01), total - 0.01));
      const m = new THREE.Matrix4().makeBasis(dir, UP, new THREE.Vector3().crossVectors(dir, UP)).setPosition(at.setY(L.cornice));
      this.box(postW, postH, postW, 0, postH / 2, 0, m, c.trim);
      this.stone.put(new THREE.SphereGeometry(B.ball, 10, 7), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, postH + B.ball * 0.9, 0)));
    }
    // Casco de escamas, nervios (con luz de noche) y lucarnas con su óculo.
    const profile = domeProfile(rd, D.rise, D.bulge, D.top, D.steps);
    const shell = lathe(profile, p.detail.dome);
    this.stone.put(shell, c.dome, new THREE.Matrix4().makeTranslation(cx, domeY, cz), {
      pattern: PATTERN.scales,
      scale: [Math.PI * 2 * rd, profileLength(profile)],
    });
    const [ribW, ribH] = D.rib;
    const domeGlow = glowOf(p.lights.dome);
    for (let k = 0; k < D.ribs; k++) {
      const a = diag + Math.PI / D.ribs + (k * Math.PI * 2) / D.ribs;
      this.stone.put(rib(profile, a, ribW, ribH), c.trim, new THREE.Matrix4().makeTranslation(cx, domeY, cz), { glow: domeGlow });
    }
    const [dw, dh, dd, hood] = D.dormer;
    const [or, oy, ot] = D.oculus;
    for (let k = 0; k < 4; k++) {
      const a = diag + (k * Math.PI) / 2;
      const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const t = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      const m = new THREE.Matrix4().makeBasis(t, UP, n).setPosition(cx + n.x * (rd + 0.15), domeY, cz + n.z * (rd + 0.15));
      // Frente de la lucarna: muro con una ventana de medio punto, capucha y marco blanco.
      const front = wall(-dw / 2, dw / 2, 0, dh, dd, [], [archHole(0, 0.25, dw * 0.62, dh - dw * 0.45)], 10);
      this.stone.put(front, c.trim, m);
      this.stone.put(new THREE.CylinderGeometry(dw / 2 + hood, dw / 2 + hood, dd + 0.2, 12, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, dh, -dd / 2 + 0.1), c.dome, m, {
        pattern: PATTERN.scales,
        scale: [Math.PI * (dw / 2 + hood), dd],
      });
      this.glass.put(new THREE.PlaneGeometry(dw * 0.62, dh - dw * 0.45 - 0.25 + dw * 0.31), c.glass, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, (dh - dw * 0.45 + 0.25 + dw * 0.31) / 2, -dd * 0.5)), {
        glow: this.lit() ? glowOf(p.lights.window) : undefined,
      });
      // Óculo sobre la lucarna, en la superficie de la cúpula.
      let r = rd;
      for (const [pr, py] of profile) if (py <= oy) r = pr;
      const om = new THREE.Matrix4().makeBasis(t, UP, n).setPosition(cx + n.x * r, domeY + oy, cz + n.z * r);
      om.multiply(new THREE.Matrix4().makeRotationX(-0.35));
      this.stone.put(new THREE.TorusGeometry(or, ot, 6, 20), c.trim, om);
      this.glass.put(new THREE.CircleGeometry(or, 20), c.glass, om.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.02)));
    }
    // Linterna, tapa y remate.
    const [lr, lh, spire] = D.lantern;
    const topY = domeY + profile[profile.length - 1][1];
    this.stone.put(new THREE.CylinderGeometry(lr, lr * 1.08, lh, 16).translate(cx, topY + lh / 2, cz), c.trim, new THREE.Matrix4());
    this.stone.put(lathe(domeProfile(lr * 1.15, lr * 1.1, 0, 0.02, 6), 16).translate(cx, topY + lh, cz), c.dome, new THREE.Matrix4());
    this.stone.put(new THREE.ConeGeometry(lr * 0.18, spire, 8).translate(cx, topY + lh + lr * 1.1 + spire / 2, cz), c.trim, new THREE.Matrix4(), { glow: domeGlow });
    this.stone.put(new THREE.SphereGeometry(lr * 0.22, 10, 6).translate(cx, topY + lh + lr * 1.1 + spire * 0.35, cz), c.trim, new THREE.Matrix4());
  }

  // ---------------------------------------------------------------------------------------------
  // Pasaje interior con bóveda de vidrio

  /** x del fin del pasaje (la cara de atrás del muro del gran arco en las fachadas de los extremos). */
  private passageEnd(): number {
    const V = this.p.pavilion;
    const axisO = V.projection - V.pedestal[2] / 2;
    return this.hx + axisO - V.wall[0] - V.wall[1];
  }

  private passage(): void {
    const p = this.p;
    const P = p.passage;
    const c = this.col;
    const g = P.width;
    const xp = this.passageEnd();
    const len = 2 * xp;
    const count = Math.max(1, Math.round(len / P.bay));
    const bw = len / count;
    const [shopW, shopH] = P.shop;
    const [winW, winH] = P.window;
    const [pilW, pilD] = P.pilaster;
    const [aoLow, aoHigh] = p.ao.passage;
    const wallAo: Surface['ao'] = (q) => THREE.MathUtils.lerp(aoLow, aoHigh, THREE.MathUtils.clamp(q.y / P.springing, 0, 1));
    const crossing = P.crossing[0];
    for (const side of [-1, 1]) {
      // Muro norte (mira a +z, arranca en −xp) y sur (mira a −z, arranca en +xp), con la x del muro de 0 a `len`.
      const n = new THREE.Vector3(0, 0, -side);
      const x = new THREE.Vector3().crossVectors(UP, n);
      const origin = new THREE.Vector3(side * xp, 0, (side * g) / 2);
      const m = new THREE.Matrix4().makeBasis(x, UP, n).setPosition(origin);
      const holes: THREE.Path[] = [];
      const shops: Arch[] = [];
      for (let k = 0; k < count; k++) {
        const cxw = (k + 0.5) * bw;
        if (Math.abs(cxw - xp) < crossing / 2) continue;
        shops.push({ center: cxw, span: shopW, impost: shopH, flat: true });
        for (const fy of P.floors) holes.push(rectHole(cxw - winW / 2, fy, cxw + winW / 2, fy + winH));
      }
      this.stone.put(wall(-0.01, len + 0.01, -this.sink, P.springing, P.wall, shops, holes, 4), c.wall, m, { pattern: PATTERN.stucco, ao: wallAo });
      for (let k = 0; k < count; k++) {
        const cxw = (k + 0.5) * bw;
        if (Math.abs(cxw - xp) < crossing / 2) continue;
        const foot = origin.clone().addScaledVector(x, cxw);
        const y0 = Math.min(this.kit.terrain(foot.x, foot.z) - this.base, shopH - 1);
        const s = new THREE.BoxGeometry(shopW, shopH - y0, 0.04);
        this.stone.put(s, c.shutter, m.clone().multiply(new THREE.Matrix4().makeTranslation(cxw, (shopH + y0) / 2, -P.wall * 0.6)), {
          pattern: PATTERN.shutter,
          scale: [shopW, shopH - y0],
          ao: p.ao.shutter,
        });
        for (const [fi, fy] of P.floors.entries()) {
          this.window(m, cxw - winW / 2, cxw + winW / 2, fy, fy + winH, P.wall, this.lit(), fi > 0, true);
          if (fi === 0) this.ironBalcony(m, cxw, fy, winW + P.balcony[2] * 2);
        }
      }
      // Pilastras entre vanos, con faroles, y la cornisa donde arranca la bóveda.
      const [lampR, lampY] = P.lamp;
      for (let k = 0; k <= count; k++) {
        const px = k * bw;
        this.box(pilW, P.springing + this.sink, pilD, px, (P.springing - this.sink) / 2, pilD / 2, m, c.wall, { pattern: PATTERN.stucco, ao: wallAo });
        this.box(pilW + 0.12, 0.4, pilD + 0.08, px, P.springing - 0.6, pilD / 2, m, c.trim, { ao: aoHigh });
        if (k > 0 && k < count) {
          this.box(0.05, 0.05, 0.45, px, lampY, pilD + 0.2, m, c.iron);
          this.stone.put(new THREE.SphereGeometry(lampR, 10, 6), c.trim, m.clone().multiply(new THREE.Matrix4().makeTranslation(px, lampY + lampR, pilD + 0.42)), {
            glow: glowOf(p.lights.lamp),
          });
        }
      }
      const cornice = [origin.clone().setY(0), origin.clone().addScaledVector(x, len)].reverse();
      this.stone.put(sweep(cornice.map((q) => q.clone().setY(P.springing - 0.3)), UP, P.cornice), c.trim, new THREE.Matrix4(), { ao: aoHigh });
    }

    // Bóveda de cañón (vidrio con costillas de hierro), cortada por el crucero del centro.
    const r = g / 2;
    const [ribSpacing] = [P.ribs];
    const [ribR, ribTube] = P.rib;
    for (const [a, b] of [
      [-xp, -crossing / 2],
      [crossing / 2, xp],
    ]) {
      this.vault.put(this.barrel(a, b, r, P.springing), c.vault, new THREE.Matrix4());
      const steps = Math.max(1, Math.round((b - a) / ribSpacing));
      for (let k = 0; k <= steps; k++) {
        const x = a + ((b - a) * k) / steps;
        this.stone.put(new THREE.TorusGeometry(r, ribTube, 4, 20, Math.PI).rotateY(Math.PI / 2).translate(x, P.springing, 0), c.iron, new THREE.Matrix4());
      }
      for (let k = 1; k < P.purlins; k++) {
        const th = (Math.PI * k) / P.purlins;
        this.box(b - a, ribR, ribR, (a + b) / 2, P.springing + Math.sin(th) * r, Math.cos(th) * r, new THREE.Matrix4(), c.iron);
      }
    }
    // Crucero: arcos, lunetos de vidrio a los lados, pechinas y cúpula octogonal.
    const [, drumH, domeRise] = P.crossing;
    for (const s of [-1, 1]) {
      this.stone.put(new THREE.TorusGeometry(r, ribTube * 2, 5, 20, Math.PI).rotateY(Math.PI / 2).translate((s * crossing) / 2, P.springing, 0), c.iron, new THREE.Matrix4());
      this.stone.put(new THREE.TorusGeometry(crossing / 2, ribTube * 2, 5, 20, Math.PI).translate(0, P.springing, (s * g) / 2), c.iron, new THREE.Matrix4());
      this.vault.put(new THREE.CircleGeometry(crossing / 2, 16, 0, Math.PI).translate(0, P.springing, (s * g) / 2), c.vault, new THREE.Matrix4());
    }
    const crown = P.springing + r;
    const apothem = crossing / 2;
    for (let k = 0; k < 4; k++) {
      const sx = k < 2 ? -1 : 1;
      const sz = k % 2 === 0 ? -1 : 1;
      const corner = new THREE.Vector3((sx * crossing) / 2, P.springing, (sz * g) / 2);
      const e1 = new THREE.Vector3((sx * apothem) / Math.SQRT2, crown, sz * apothem);
      const e2 = new THREE.Vector3(sx * apothem, crown, (sz * apothem) / Math.SQRT2);
      const pend = new THREE.BufferGeometry().setFromPoints([corner, e1, e2]);
      pend.computeVertexNormals();
      this.stone.put(pend, c.iron, new THREE.Matrix4(), { ao: aoHigh });
      this.stone.put(pend.clone().index ? pend.clone() : this.flip(pend), c.iron, new THREE.Matrix4(), { ao: aoHigh });
    }
    const drum = new THREE.CylinderGeometry(apothem / Math.cos(Math.PI / 8), apothem / Math.cos(Math.PI / 8), drumH, 8, 1, true, Math.PI / 8);
    this.vault.put(drum.translate(0, crown + drumH / 2, 0), c.vault, new THREE.Matrix4());
    const ro = apothem / Math.cos(Math.PI / 8);
    const cap = domeProfile(ro, domeRise, 0, 0.25, 8);
    this.vault.put(lathe(cap, 8, Math.PI / 8).translate(0, crown + drumH, 0), c.vault, new THREE.Matrix4());
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      this.stone.put(rib(cap, a, ribTube * 2, ribTube * 2), c.iron, new THREE.Matrix4().makeTranslation(0, crown + drumH, 0));
      this.box(ribTube * 2, drumH, ribTube * 2, Math.cos(a) * ro, crown + drumH / 2, Math.sin(a) * ro, new THREE.Matrix4(), c.iron);
    }
    this.stone.put(new THREE.CylinderGeometry(0.35, 0.4, 0.6, 8).translate(0, crown + drumH + domeRise + 0.2, 0), c.iron, new THREE.Matrix4());

    // Piso de terrazo, de fachada a fachada (entra por los arcos).
    const x0 = -this.hx - p.pavilion.projection;
    const x1 = this.hx + p.pavilion.projection;
    const ni = Math.ceil(x1 - x0);
    this.floor(
      (i, j) => new THREE.Vector3(x0 + ((x1 - x0) * i) / ni, 0, -g / 2 + (g * j) / 4),
      ni,
      4,
      (q) => [q.x, q.z],
      c.terrazzo,
      PATTERN.terrazzo,
      p.ao.floor,
    );
  }

  /**
   * Balcón de hierro (marco m, cara del muro en z = 0) de ancho w centrado en x, con el piso en y:
   * losa, pasamanos, travesaño bajo y barrotes que dejan ver a través.
   */
  private ironBalcony(m: THREE.Matrix4, x: number, y: number, w: number): void {
    const [depth, height, , bar, gap] = this.p.passage.balcony;
    const c = this.col.iron;
    this.box(w, 0.08, depth, x, y - 0.04, depth / 2, m, c);
    for (const h of [0.12, height - 0.03]) this.box(w, 0.05, 0.05, x, y + h, depth, m, c);
    for (const t of [-1, 1]) {
      this.box(0.05, 0.05, depth, x + (t * w) / 2, y + height - 0.03, depth / 2, m, c);
      for (let d = gap; d < depth; d += gap) this.box(bar, height, bar, x + (t * w) / 2, y + height / 2, d, m, c);
    }
    const count = Math.max(2, Math.round(w / gap));
    for (let k = 0; k <= count; k++) this.box(bar, height, bar, x - w / 2 + (w * k) / count, y + height / 2, depth, m, c);
  }

  /** Media caña de vidrio a lo largo de x (de a a b), de radio r, arrancando a la altura y. */
  private barrel(a: number, b: number, r: number, y: number): THREE.BufferGeometry {
    const around = 16;
    const alongN = Math.max(1, Math.ceil((b - a) / 2));
    const pos: number[] = [];
    const nor: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= alongN; j++) {
      const x = a + ((b - a) * j) / alongN;
      for (let i = 0; i <= around; i++) {
        const th = (Math.PI * i) / around;
        pos.push(x, y + Math.sin(th) * r, Math.cos(th) * r);
        nor.push(0, Math.sin(th), Math.cos(th));
      }
    }
    const row = around + 1;
    for (let j = 0; j < alongN; j++) {
      for (let i = 0; i < around; i++) {
        const q = j * row + i;
        index.push(q, q + 1, q + row, q + 1, q + row + 1, q + row);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(index);
    return g;
  }

  /** La misma geometría (sin índice) con las caras al revés (para verla de los dos lados). */
  private flip(g: THREE.BufferGeometry): THREE.BufferGeometry {
    const out = g.clone();
    const pos = out.getAttribute('position') as THREE.BufferAttribute;
    for (let t = 0; t < pos.count; t += 3) {
      const x = pos.getX(t + 1);
      const y = pos.getY(t + 1);
      const z = pos.getZ(t + 1);
      pos.setXYZ(t + 1, pos.getX(t + 2), pos.getY(t + 2), pos.getZ(t + 2));
      pos.setXYZ(t + 2, x, y, z);
    }
    out.computeVertexNormals();
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Banderas, física y mallas

  private flags(): void {
    const p = this.p;
    const F = p.flags;
    const [poleR, poleLen, angleDeg, poleY] = F.pole;
    const [fw, fh, thick] = F.size;
    const up = THREE.MathUtils.degToRad(angleDeg);
    for (const flag of F.list) {
      const f = this.facades[flag.facade];
      const base = this.at(f, flag.at, -p.order.setback, poleY);
      const dir = f.n.clone().multiplyScalar(Math.cos(up)).addScaledVector(UP, Math.sin(up));
      const tip = base.clone().addScaledVector(dir, poleLen);
      const pole = new THREE.CylinderGeometry(poleR, poleR, poleLen, 6);
      const m = new THREE.Matrix4().compose(
        base.clone().add(tip).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(UP, dir),
        new THREE.Vector3(1, 1, 1),
      );
      this.stone.put(pole, this.col.trim, m);
      // Paño colgando del extremo, sin viento: franjas horizontales hacia abajo.
      const n = flag.stripes.length;
      const fm = new THREE.Matrix4().makeBasis(f.n, UP, f.x.clone().negate()).setPosition(tip);
      flag.stripes.forEach((hex, k) => {
        this.box(fw, fh / n, thick, -fw / 2, -(fh / n) * (k + 0.5), 0, fm, new THREE.Color(hex));
      });
    }
  }

  private physics(): void {
    const p = this.p;
    const L = p.levels;
    const A = p.arcade;
    const P = p.portal;
    const V = p.pavilion;
    const k = this.kit;
    const top = L.cornice;
    const g = p.passage.width;
    const xp = this.passageEnd();
    // Bloques macizos (se trepan desde el portal y el pasaje): al norte y al sur del pasaje.
    const ix = this.hx - P.depth;
    const iz = this.hz - P.depth;
    for (const s of [-1, 1]) {
      const zA = (s * g) / 2;
      const zB = s * iz;
      k.block(
        [new THREE.Vector3(-ix, 0, zA), new THREE.Vector3(ix, 0, zA), new THREE.Vector3(ix, 0, zB), new THREE.Vector3(-ix, 0, zB)],
        top,
      );
    }
    for (const f of this.facades) {
      const angle = Math.atan2(f.x.z, f.x.x);
      const mid = f.length / 2;
      const [span, impost] = V.arch;
      // Sobre el portal: del cielo raso a la terraza (salvo bajo el gran arco).
      const halfDepth = (P.depth + V.projection) / 2;
      const centerO = (V.projection - P.depth) / 2;
      const openA = mid - span / 2;
      const openB = mid + span / 2;
      for (const [a, b, bottom] of [
        [0, openA, L.portal],
        [openA, openB, impost + span / 2],
        [openB, f.length, L.portal],
      ]) {
        const c = this.at(f, (a + b) / 2, centerO);
        k.box(c.x, c.z, (b - a) / 2, halfDepth, angle, top, true, bottom);
      }
      // Pilares de la arcada (hasta el cielo raso) y los pedestales del pabellón (hasta los capiteles).
      for (const run of this.runs[f.index]) {
        for (const u of run.piers) {
          const c = this.at(f, u, -A.thickness / 2);
          k.box(c.x, c.z, A.pier / 2, A.thickness / 2, angle, L.portal, false, -Infinity);
        }
        const cp = this.at(f, run.cornerPier, -A.thickness / 2);
        k.box(cp.x, cp.z, A.cornerPier / 2 + A.pier / 2, A.thickness / 2, angle, L.portal, false, -Infinity);
        const endU = run.from === 0 ? run.to : run.from;
        const e = this.at(f, endU, -A.thickness / 2);
        k.box(e.x, e.z, A.pier / 2, A.thickness / 2, angle, L.portal, false, -Infinity);
      }
      const [pedW, , pedD] = V.pedestal;
      for (const s of [-1, 1]) {
        const c = this.at(f, mid + s * (V.width / 2 - pedW / 2), V.projection - pedD / 2);
        k.box(c.x, c.z, pedW / 2, pedD / 2, angle, L.capital, false, -Infinity);
      }
      // Los macizos del muro del gran arco, a los lados del vano.
      const [inset, depth] = V.wall;
      const wallFront = V.projection - pedD / 2 - inset;
      const inner = V.width / 2 - pedW / 2;
      const jamb = (inner - span / 2) / 2;
      for (const s of [-1, 1]) {
        const c = this.at(f, mid + s * (span / 2 + jamb), wallFront - depth / 2);
        k.box(c.x, c.z, jamb, depth / 2, angle, L.capital, false, -Infinity);
      }
      // Esquina: techo sobre el portal curvo y los dos macizos a los lados de su arco.
      k.ring(f.center.x, f.center.z, this.R - P.depth, this.R + 0.2, f.a0 - Math.PI / 4, Math.PI / 4, top, true, L.portal);
      const pierArc = (this.cornerLength - A.cornerSpan) / 2;
      for (const s of [pierArc / 2, this.cornerLength - pierArc / 2]) {
        const c = this.around(f, s, -A.thickness / 2);
        const phi = f.a0 - s / this.R;
        k.box(c.x, c.z, pierArc / 2, A.thickness / 2, Math.atan2(-Math.cos(phi), Math.sin(phi)), L.portal, false, -Infinity);
      }
      // Balaustrada del ático (un muro bajo en el borde de la terraza) y la cúpula.
      const edgeO = -p.attic.inset;
      for (const run of this.runs[f.index]) {
        const c = this.at(f, (run.from + run.to) / 2, edgeO);
        k.box(c.x, c.z, (run.to - run.from) / 2, 0.3, angle, top + p.attic.rail, false, top - 1);
      }
      const D = p.dome;
      k.circle(f.center.x, f.center.z, D.drum[0] + 0.3, this.top - D.lantern[2], true, top - 1);
      // Frontón.
      const pc = this.at(f, mid, V.projection - 0.6);
      const rise = (V.width / 2) * Math.tan(THREE.MathUtils.degToRad(V.pitchDeg));
      k.box(pc.x, pc.z, V.width / 2, 0.6, angle, top + rise, false, top - 1);
    }
    // La bóveda del pasaje se puede pisar desde arriba; debajo se camina.
    k.box(0, 0, xp, g / 2, 0, p.passage.springing + g / 2, true, p.passage.springing);
    k.circle(0, 0, p.passage.crossing[0] / 2, p.passage.springing + g / 2 + p.passage.crossing[1] + p.passage.crossing[2], true, p.passage.springing);
  }

  /** Las mallas: el macizo, los vidrios, la bóveda y las piezas repetidas (con su versión de lejos). */
  private meshes(): void {
    const p = this.p;
    const k = this.kit;
    const root = k.root;
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string, shadow = true): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };
    this.stone.parts.forEach((parts, i) => {
      if (!parts.empty) add(parts.merge(), k.materials.stone, `palace-stone-${i}`);
    });
    add(this.glass.merge(), k.materials.glass, 'palace-glass', false);
    const vault = add(this.vault.merge(), k.materials.vault, 'palace-vault', false);
    vault.renderOrder = 1;

    const piece = (geometry: THREE.BufferGeometry, color: THREE.Color, surface: Surface = {}): THREE.BufferGeometry => {
      const parts = new Parts(p.flood, this.base, this.top);
      parts.put(geometry, color, new THREE.Matrix4(), surface);
      return parts.merge();
    };
    const instanced = (geometry: THREE.BufferGeometry, repeats: Repeats, name: string, shadow: boolean): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, k.materials.stone, repeats.list.length);
      repeats.list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.name = name;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      root.add(mesh);
      return mesh;
    };
    const c = this.col;
    const L = p.levels;
    const D = p.detail;
    for (const [repeats, d, height, name] of [
      [this.columns, p.order.diameter, L.capital - L.balcony, 'palace-columns'],
      [this.bigColumns, p.pavilion.diameter, L.capital - p.pavilion.pedestal[1], 'palace-big-columns'],
    ] as const) {
      const col = corinthianColumn(d, height, p.column, D.column);
      instanced(piece(col.shaft, c.column, { pattern: PATTERN.stucco }), repeats, `${name}-shaft`, true);
      // Los adornos chicos no proyectan sombra (medio píxel en el mapa de sombras).
      k.near(instanced(piece(col.capital, c.trim), repeats, `${name}-capital`, false), D.capitals);
      k.far(instanced(piece(col.plain, c.trim), repeats, `${name}-capital-far`, false), D.capitals);
    }
    const [bw, bh] = p.balcony.baluster;
    k.near(instanced(piece(baluster(bh, bw, D.baluster), c.trim), this.balusters, 'palace-balusters', false), D.balusters);
    k.far(instanced(piece(balusterFar(bh, bw), c.trim), this.balusters, 'palace-balusters-far', false), D.balusters);
    instanced(piece(urn(p.attic.urn, D.urn), c.trim), this.urns, 'palace-urns', false);
    const [, modW, modH, modD] = p.entablature.modillion;
    k.near(instanced(piece(bracket(modW, modH, modD), c.trim), this.modillions, 'palace-modillions', false), D.cornice);
    const [, denW, denH, denD] = p.entablature.dentil;
    k.near(instanced(piece(new THREE.BoxGeometry(denW, denH, denD).translate(0, denH / 2, denD / 2), c.trim), this.dentils, 'palace-dentils', false), D.cornice);
  }
}
