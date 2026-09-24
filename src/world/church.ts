import * as THREE from 'three';
import {
  type FigureShape,
  type Profile,
  arc,
  archHole,
  archPath,
  baluster,
  bracket,
  domeProfile,
  faceted,
  figure,
  gableTop,
  lathe,
  pointedHole,
  profileLength,
  rectHole,
  rib,
  roundHole,
  shield,
  sweep,
  wall,
} from './classical';
import { Batch, type Glow, type MonumentBase, PATTERN, type Surface, colorsOf, glowOf, patternOf } from './monumentParts';
import { pave } from './street';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

/** Un cuerpo de una torre: alto, ancho, su vano en cada cara (arco, ventana con frontón o reloj) y su cornisa. */
export interface ChurchBody {
  height: number;
  width: number;
  /** 'arch': [ancho, antepecho, arranque del arco]; 'rect': [ancho, antepecho, dintel]; 'clock': [radio, altura del centro]. */
  opening: string;
  size: number[];
  /** Frontón sobre el vano: alto (0 = sin). */
  pediment: number;
  cornice: number;
}

/** Un ala del convento: su planta (x0, x1, z0, z1), pisos y alto de cada uno, ventanas y qué caras las llevan. */
export interface ChurchWing {
  rect: number[];
  floors: number;
  floor: number;
  /**
   * Caras con ventanas (0 frente −x, 1 norte, 2 fondo +x, 3 sur) y la arcada de la planta baja:
   * [cara (−1 = ninguna), ancho del pilar, luz entre el arco y el piso de arriba, hondura del
   * portal].
   */
  faces: number[];
  arcade: number[];
  /** Ventana: ancho, alto, antepecho; tramo de cada vano. */
  window: number[];
  bay: number;
}

/**
 * Una iglesia del centro (config/game.json → monuments.list, tipo `church`): fachada de dos
 * cuerpos con dos torres de campanario rematadas en cúpulas, nave, crucero con su cúpula,
 * ábside, el costado que da a la calle (con locales, ventanales apuntados, pretil calado,
 * pináculos y un hastial) y las alas del convento; delante, su plaza con una pila y una estatua.
 * Marco local: origen en el centro de la fachada a nivel de la plaza, x hacia adentro de la nave
 * (la fachada mira a −x) y z a la derecha de quien entra. Largos en m.
 */
export interface Church extends MonumentBase {
  /** Polígonos (marco local) donde no quedan edificios ni árboles de los datos. */
  clear: number[][][];
  /** Puntos (marco local) donde se mide el suelo (la base es su mediana) y cuánto bajan los muros bajo ella. */
  ground: { samples: number[][]; bury: number; step: number };
  /** Hasta dónde se ve el detalle chico, lados de lo torneado, tramos de los arcos y cuánto se separa un vidrio de su muro. */
  detail: { near: number; sides: number; curve: number; inset: number };
  glass: { roughness: number; metalness: number; opacity?: number };
  /** El agua de la pila (translúcida). */
  water: { roughness: number; metalness: number; opacity: number };
  /** Hojas de los ventanales (ancho y alto de cada vidrio). */
  pane: number[];
  /** Oclusión ambiental de lo que queda al fondo de un vano: puertas, cortinas de los locales y el fondo de la arcada. */
  ao: { door: number; shutter: number; arcade: number };
  /** Luz de noche de los ventanales, de los relojes y de los locales. */
  glow: Glow;
  clockGlow: Glow;
  shopGlow: Glow;
  colors: {
    wall: string;
    trim: string;
    column: string;
    plinth: string;
    door: string;
    glass: string;
    void: string;
    dome: string;
    rib: string;
    roof: string;
    shop: string;
    shutter: string;
    bronze: string;
    basin: string;
    pool: string;
    water: string;
    jet: string;
    cross: string;
    clock: string;
    bollard: string;
  };
  signs: string[];
  /** Grosor de los muros con vanos; escala del revoque (m por unidad del dibujo). */
  thickness: number;
  stucco: number[];
  /** Molduras: cornisa principal, faja entre cuerpos, zócalo, marco de vanos y cornisa de las torres. */
  profiles: { cornice: Profile; band: Profile; base: Profile; frame: Profile; tower: Profile; coping: Profile };
  front: {
    /** Fondo del cuerpo de la fachada (x) y ancho (z). */
    size: number[];
    /** Zócalo, arranque del entablamento, fin del entablamento, arranque de la cornisa y fin de la cornisa. */
    levels: number[];
    /** Ancho de las calles de las torres a cada lado y cuánto salen de la fachada. */
    tower: number[];
    /** Puerta central: luz, arranque del arco; laterales: ancho y alto. */
    door: number[];
    sideDoor: number[];
    /** Frontón central: ancho, alto; de las puertas laterales: ancho, separación sobre la puerta, alto. */
    pediment: number[];
    sidePediment: number[];
    /** Cuánto salen los frontones de su muro y cuánto más ancho que las ventanas pareadas es el arco que las abraza. */
    trim: number[];
    /** Ventana central en arco: ancho, antepecho, arranque; ventanas pareadas de las torres: ancho de cada una, separación, antepecho, arranque. */
    window: number[];
    twin: number[];
    /**
     * Columnas del primer cuerpo (distancias al centro, a cada lado): diámetro, basa y capitel
     * (lado y alto de cada dado); pilastras del segundo: ancho y vuelo.
     */
    columns: number[];
    column: number;
    capital: number[];
    pilaster: number[];
    /** Modillones de la cornisa: ancho, alto, vuelo, separación. */
    modillion: number[];
    /** Baranda entre las torres: alto, ancho del balaustre, separación, ancho del pilar. */
    rail: number[];
  };
  tower: {
    bodies: ChurchBody[];
    /** Pilastras de las esquinas: ancho y vuelo. */
    pilaster: number[];
    /** Grueso del aro del reloj, separación y vuelo del frontón sobre la ventana, grueso del techo del último cuerpo. */
    trim: number[];
    /** Cúpula: radio, alto, panza, radio de la linterna, tramos; nervios: cantidad, ancho, resalte. */
    dome: number[];
    ribs: number[];
    /**
     * Linterna (su radio es el de la boca de la cúpula): alto, alto del capuchón y cuánto vuela;
     * cruz: alto, brazo, grosor y a qué altura (fracción) va el brazo, de frente a la fachada.
     */
    lantern: number[];
    cross: number[];
  };
  nave: { length: number; height: number; roof: number };
  transept: { x: number[]; z: number[]; height: number; roof: number };
  apse: { x: number[]; z: number[]; height: number };
  /** Cúpula del crucero: centro; tambor (radio, alto, ventanas, ancho y alto de cada una); cúpula, nervios y linterna como las de las torres. */
  crossing: { center: number[]; drum: number[]; dome: number[]; ribs: number[]; lantern: number[]; cross: number[] };
  /**
   * Costado sobre la calle (mira a +z en `z`, de x0 a x1): pisos (zócalo, tope de los locales,
   * arranque de la cornisa, fin de la cornisa, tope del pretil), pilastras (posiciones en x,
   * ancho, vuelo), el vano de cada tramo ('lancet' o 'rect'), lancetas (ancho, antepecho, arranque,
   * agudeza), ventanas rectas (ancho, alto, antepecho), locales (margen a cada pilastra, alto del
   * letrero, cuánto baja la cortina, luz sobre el letrero), pretil calado (radio y separación de los
   * óculos, grosor), pináculos (lado del dado, alto del dado, radio y alto de la aguja), el hastial
   * (tramo, alto sobre la cornisa, alto de la curva, ancho de su lanceta), el escudo (ancho, alto,
   * altura sobre la cornisa, relieve), su emblema en relieve (largo del palo, largo del brazo, a qué
   * altura del escudo va el brazo, grosor) y la cara del extremo que da a la plaza (ventanas
   * pareadas: ancho, separación, antepecho, arranque; puerta: ancho).
   */
  flank: {
    z: number;
    x: number[];
    levels: number[];
    pilasters: number[];
    pilaster: number[];
    bays: string[];
    lancet: number[];
    rect: number[];
    shop: number[];
    parapet: number[];
    pinnacle: number[];
    gable: number[];
    shield: number[];
    emblem: number[];
    end: number[];
  };
  wings: ChurchWing[];
  plaza: {
    /** Contornos (marco local) y el dibujo de cada piso: la plaza de piedra y la vereda del costado. */
    floors: { ring: number[][]; color: string; pattern: string; scale: number[] }[];
    /** Cuánto queda el piso sobre el terreno. */
    lift: number;
    /**
     * Pila: centro, radio, ancho y alto del borde, cuánto baja el agua del borde y a qué altura del
     * piso queda el fondo; surtidores: cantidad, radio del anillo, grosor abajo y arriba, altos.
     */
    fountain: { center: number[]; radius: number; rim: number[]; water: number; depth: number; jets: number[]; heights: number[] };
    /** Pedestal escalonado: gradas (ancho, alto), dado (ancho, alto), cornisa (ancho, alto), plinto (ancho, alto). */
    pedestal: { steps: number[][]; die: number[]; cap: number[]; plinth: number[] };
    /** Estatua: alto, hacia dónde mira (rad, atan2(z, x) local) y su figura. */
    statue: { height: number; facing: number; shape: FigureShape };
    /** Bolardos del borde con la avenida: de dónde a dónde (x, z), separación, radio y alto. */
    bollards: { from: number[]; to: number[]; spacing: number; radius: number; height: number };
  };
}

/** Lo que la iglesia necesita de Monuments (world/monuments.ts) para armarse y entrar en la física. */
export interface ChurchKit {
  root: THREE.Group;
  materials: { stone: THREE.Material; glass: THREE.Material; water: THREE.Material };
  /** Altura del suelo del mundo bajo un punto del marco local. */
  terrain(x: number, z: number): number;
  /** Rectángulo (largo en el ángulo `angle` = atan2(z, x) local) y círculo de la física; alturas del mundo. */
  box(x: number, z: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  circle(x: number, z: number, r: number, top: number, floor: boolean, bottom: number): void;
  /** Anillo (la pila): radios, alto; alturas del mundo. */
  ring(cx: number, cz: number, inner: number, outer: number, top: number, floor: boolean): void;
  /** Macizo que se trepa (planta local) del pie `y0` al techo `top` (alturas del mundo). */
  block(outline: THREE.Vector3[], y0: number, top: number): void;
  /** Piso a `offset` sobre el terreno dentro del polígono (la plaza). */
  ground(outline: THREE.Vector3[], offset: number): void;
  /** Detalle que solo se ve a menos de `distance` m. */
  near(o: THREE.Object3D, distance: number): void;
}

/** Una cara de muro: origen, a lo largo (de izquierda a derecha vista desde afuera) y hacia afuera. */
class Face {
  private readonly basis: THREE.Matrix4;

  constructor(
    readonly origin: THREE.Vector3,
    readonly u: THREE.Vector3,
    readonly n: THREE.Vector3,
    readonly length: number,
  ) {
    this.basis = new THREE.Matrix4().makeBasis(u, UP, n);
  }

  /** Punto a `u` de su punta izquierda, a la altura `y` sobre su origen y `o` hacia afuera. */
  at(u: number, y: number, o = 0): THREE.Vector3 {
    return this.origin.clone().addScaledVector(this.u, u).addScaledVector(this.n, o).setY(this.origin.y + y);
  }

  /** Marco de la cara (x a lo largo, y arriba, z hacia afuera) en (u, y, o). */
  m(u: number, y: number, o = 0): THREE.Matrix4 {
    return this.basis.clone().setPosition(this.at(u, y, o));
  }
}

/** Las cuatro caras de un rectángulo en planta (−x, +z, +x, −z), con su pie a la altura `y`. */
function facesOf(x0: number, x1: number, z0: number, z1: number, y: number): Face[] {
  return [
    new Face(new THREE.Vector3(x0, y, z0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), z1 - z0),
    new Face(new THREE.Vector3(x0, y, z1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), x1 - x0),
    new Face(new THREE.Vector3(x1, y, z1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), z1 - z0),
    new Face(new THREE.Vector3(x1, y, z0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), x1 - x0),
  ];
}

/**
 * Recorrido cerrado alrededor de un rectángulo a la altura y. `sweep` saca la moldura hacia
 * arriba × tramo: cada lado se recorre de derecha a izquierda visto desde afuera.
 */
function loop(x0: number, x1: number, z0: number, z1: number, y: number): THREE.Vector3[] {
  return [new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1)];
}

/**
 * Arma la iglesia en `kit.root`: los macizos y lo grande en una malla (con sombra), el detalle
 * chico (modillones, balaustres, pináculos, marcos) solo de cerca, los vidrios y el agua aparte.
 */
export class ChurchBuilder {
  private readonly col: ReturnType<typeof colorsOf<keyof Church['colors']>>;
  private readonly stone = new Batch();
  private readonly detail = new Batch();
  private readonly glass = new Batch();
  private readonly paving = new Batch();
  private readonly water = new Batch();
  private readonly glow: THREE.Color;
  private readonly stucco: Surface;
  private base = 0;

  constructor(
    private readonly c: Church,
    private readonly kit: ChurchKit,
  ) {
    this.col = colorsOf(c.colors);
    this.glow = glowOf(c.glow);
    this.stucco = { pattern: PATTERN.stucco, scale: c.stucco };
  }

  build(): void {
    const c = this.c;
    // La base: la mediana del suelo alrededor (el relieve puede traer el bulto del techo).
    const heights = c.ground.samples.map(([x, z]) => this.kit.terrain(x, z)).sort((a, b) => a - b);
    this.base = heights[Math.floor(heights.length / 2)] + c.plaza.lift;
    const top = this.base + c.tower.bodies.reduce((h, b) => h + b.height, c.front.levels[4]);
    for (const b of [this.stone, this.detail, this.glass, this.paving, this.water]) b.flood.splice(0, 3, c.flood, this.base, top - this.base);
    this.plaza();
    this.front();
    for (const side of [-1, 1]) this.tower(side);
    this.body();
    this.crossing();
    this.flank();
    for (const w of c.wings) this.wing(w);
    this.meshes();
  }

  private meshes(): void {
    const k = this.kit;
    const add = (batch: Batch, material: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null => {
      if (batch.empty) return null;
      const mesh = new THREE.Mesh(batch.build(), material);
      mesh.name = `${this.c.id}-${name}`;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      k.root.add(mesh);
      return mesh;
    };
    add(this.stone, k.materials.stone, 'stone', true);
    add(this.paving, k.materials.stone, 'plaza', false);
    add(this.glass, k.materials.glass, 'glass', false);
    add(this.water, k.materials.water, 'water', false);
    const near = add(this.detail, k.materials.stone, 'detail', false);
    if (near) k.near(near, this.c.detail.near);
  }

  /**
   * Macizo de caja (en el marco local, pie en la base menos lo enterrado) que entra como edificio,
   * con su azotea del color del techo.
   */
  /** Macizo de `bottom` (por defecto, desde lo enterrado) a `height`, con su azotea; `solid` lo registra en la física. */
  private mass(x0: number, x1: number, z0: number, z1: number, height: number, color: THREE.Color, solid = true, bottom = -this.c.ground.bury): void {
    const m = new THREE.Matrix4().makeTranslation((x0 + x1) / 2, this.base + (height + bottom) / 2, (z0 + z1) / 2);
    this.stone.box(m, x1 - x0, height - bottom, z1 - z0, color, this.stucco);
    const y = this.base + height + this.c.detail.inset;
    this.stone.quad(new THREE.Vector3(x0, y, z1), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x0, y, z0), this.col.roof);
    if (solid) this.record(x0, x1, z0, z1, height);
  }

  /**
   * Macizo de la física (entra al índice de edificios): para el jugador es sólido desde el suelo
   * hasta `height`, empiece donde empiece. Lo que se camina por debajo va con `kit.box` y `bottom`.
   */
  private record(x0: number, x1: number, z0: number, z1: number, height: number): void {
    const outline = [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)];
    this.kit.block(outline, this.base - this.c.ground.bury, this.base + height);
  }

  /** Moldura a lo largo de un recorrido (marco local, alturas sobre la base). */
  private molding(points: THREE.Vector3[], profile: Profile, color: THREE.Color, closed = false, batch = this.stone): void {
    const lifted = points.map((p) => p.clone().setY(p.y + this.base));
    this.put(sweep(lifted, UP, profile, { closed }), new THREE.Matrix4(), color, {}, batch);
  }

  /** Una pieza cualquiera en el marco m (en el lote `batch`), liberando su geometría. */
  private put(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}, batch = this.stone): void {
    batch.geometry(g, m, color, surface);
    g.dispose();
  }

  /** Vidrio (o puerta) al fondo de un vano: un rectángulo en la cara, a `o` hacia afuera. */
  private pane(f: Face, u0: number, u1: number, y0: number, y1: number, o: number, color: THREE.Color, surface: Surface, batch: Batch, uv?: number[]): void {
    batch.quad(f.at(u0, y0, o), f.at(u1, y0, o), f.at(u1, y1, o), f.at(u0, y1, o), color, surface, uv);
  }

  /** Vidrio de un ventanal al fondo de su vano (en hojas de `pane`), con su luz de noche. */
  private window(f: Face, u: number, width: number, y0: number, y1: number, o: number): void {
    const [pw, ph] = this.c.pane;
    const cols = Math.max(1, Math.round(width / pw));
    const rows = Math.max(1, Math.round((y1 - y0) / ph));
    this.pane(f, u - width / 2, u + width / 2, y0, y1, o, this.col.glass, { glow: this.glow, pattern: PATTERN.glazing }, this.glass, [0, 0, cols, rows]);
  }

  /** Cruz de brazos (alto, brazo, grosor, altura del brazo en fracción) con el pie en el marco m, el brazo a lo largo de x. */
  private cross(m: THREE.Matrix4, cross: number[]): void {
    const [h, arm, t, at] = cross;
    this.stone.box(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0)), t, h, t, this.col.cross);
    this.stone.box(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, h * at, 0)), arm, t, t, this.col.cross);
  }

  /** Frontón triangular en la cara f: centro u, base y, ancho, alto y vuelo, con su moldura en los faldones. */
  private pediment(f: Face, u: number, y: number, width: number, rise: number, depth: number, batch = this.stone): void {
    const shape = new THREE.Shape([new THREE.Vector2(-width / 2, 0), new THREE.Vector2(width / 2, 0), new THREE.Vector2(0, rise)]);
    this.put(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), f.m(u, y, 0), this.col.wall, this.stucco, batch);
    // Los faldones de izquierda a derecha: con la normal de la cara como eje, la moldura sale hacia arriba.
    const rake = [new THREE.Vector3(-width / 2, 0, depth), new THREE.Vector3(0, rise, depth), new THREE.Vector3(width / 2, 0, depth)];
    this.put(sweep(rake, new THREE.Vector3(0, 0, 1), this.c.profiles.coping, { caps: true }), f.m(u, y, 0), this.col.trim, {}, batch);
  }


  private front(): void {
    const c = this.c;
    const F = c.front;
    const [depth, width] = F.size;
    const [plinth, entB, entT, corB, corT] = F.levels;
    const [pedDepth, hugMargin] = F.trim;
    const [towerW, project] = F.tower;
    const t = c.thickness;
    const inset = c.detail.inset;
    const half = width / 2;
    const inner = half - towerW;
    const bury = c.ground.bury;
    const curve = c.detail.curve;
    const out = new THREE.Vector3(0, 0, 1);
    // Cuerpo detrás de los muros de la fachada, hasta la cornisa.
    this.mass(t, depth, -half, half, corT, this.col.wall);
    const face = facesOf(0, depth, -half, half, this.base)[0];
    const [span, impost] = F.door;
    const [sideW, sideH] = F.sideDoor;
    const [winW, winSill, winImpost] = F.window;
    const [twinW, twinGap, twinSill, twinImpost] = F.twin;
    // Calle central (u desde la punta izquierda: `half` es el eje): la puerta en arco y el ventanal.
    const center = half;
    this.put(
      wall(center - inner, center + inner, -bury, corB, t, [{ center, span, impost }], [archHole(center, winSill, winW, winImpost)], curve),
      face.m(0, 0, 0),
      this.col.wall,
      this.stucco,
    );
    this.pane(face, center - span / 2, center + span / 2, 0, impost + span / 2, -t + inset, this.col.door, { ao: c.ao.door }, this.stone);
    this.window(face, center, winW, winSill, winImpost + winW / 2, -t + inset);
    this.put(sweep(archPath(center, 0, span, impost, 0.5, curve), out, c.profiles.frame), face.m(0, 0, 0), this.col.trim);
    this.put(sweep(archPath(center, winSill, winW, winImpost, 0.5, curve), out, c.profiles.frame), face.m(0, 0, 0), this.col.trim, {}, this.detail);
    // Calles de las torres (salen `project`): puerta lateral con frontón y ventanas pareadas bajo un arco.
    for (const side of [-1, 1]) {
      const mid = center + side * (inner + towerW / 2);
      const u0 = side < 0 ? 0 : center + inner;
      const u1 = side < 0 ? center - inner : width;
      const twins = [-1, 1].map((k) => mid + (k * (twinW + twinGap)) / 2);
      this.put(
        wall(u0, u1, -bury, corB, t + project, [{ center: mid, span: sideW, impost: sideH, flat: true }], twins.map((u) => archHole(u, twinSill, twinW, twinImpost)), curve),
        face.m(0, 0, project),
        this.col.wall,
        this.stucco,
      );
      this.pane(face, mid - sideW / 2, mid + sideW / 2, 0, sideH, -t + inset, this.col.door, { ao: c.ao.door }, this.stone);
      for (const u of twins) this.window(face, u, twinW, twinSill, twinImpost + twinW / 2, -t + inset);
      const [pw, gap, rise] = F.sidePediment;
      this.pediment(face, mid, sideH + gap, pw, rise, project + pedDepth);
      const hug = archPath(mid, twinSill, twinW * 2 + twinGap + hugMargin * 2, twinImpost, 0.5, curve);
      this.put(sweep(hug, out, c.profiles.frame), face.m(0, 0, project), this.col.trim, {}, this.detail);
    }
    // Frontón central sobre el entablamento.
    const [pedW, pedRise] = F.pediment;
    this.pediment(face, center, entT, pedW, pedRise, pedDepth);
    // Columnas del primer cuerpo (con basa y capitel) y pilastras del segundo.
    const [pilW, pilD] = F.pilaster;
    const [capW, capH] = F.capital;
    for (const d of F.columns) {
      for (const side of [-1, 1]) {
        const u = center + side * d;
        const o = d > inner ? project : 0;
        const r = F.column / 2;
        this.put(new THREE.CylinderGeometry(r, r, entB - plinth - capH, c.detail.sides), face.m(u, (entB + plinth - capH) / 2, o), this.col.column);
        this.stone.box(face.m(u, plinth / 2, o), capW, plinth, capW, this.col.plinth);
        this.stone.box(face.m(u, entB - capH / 2, o), capW, capH, capW, this.col.column);
        this.stone.box(face.m(u, (entT + corB) / 2, o + pilD / 2), pilW, corB - entT, pilD, this.col.column, this.stucco);
      }
    }
    // Zócalo, entablamento y cornisa: siguen el quiebre de las torres y doblan por los costados.
    const run = (y: number): THREE.Vector3[] => [
      new THREE.Vector3(depth, y, half),
      new THREE.Vector3(-project, y, half),
      new THREE.Vector3(-project, y, inner),
      new THREE.Vector3(0, y, inner),
      new THREE.Vector3(0, y, -inner),
      new THREE.Vector3(-project, y, -inner),
      new THREE.Vector3(-project, y, -half),
      new THREE.Vector3(depth, y, -half),
    ];
    this.molding(run(0), c.profiles.base, this.col.plinth);
    this.molding(run(entB), c.profiles.band, this.col.trim);
    this.molding(run(corB), c.profiles.cornice, this.col.trim);
    // Modillones bajo la cornisa, al frente.
    const [mw, mh, md, spacing] = F.modillion;
    const count = Math.floor(width / spacing);
    const g = bracket(mw, mh, md);
    for (let k = 0; k <= count; k++) {
      const u = (width - count * spacing) / 2 + k * spacing;
      this.detail.geometry(g, face.m(u, corB - mh, Math.abs(u - center) > inner ? project : 0), this.col.trim);
    }
    g.dispose();
    // Baranda entre las torres, sobre la cornisa: balaustres entre pilares y el pasamanos.
    const [railH, balW, balS, postW] = F.rail;
    const rail = new Face(new THREE.Vector3(0, this.base + corT, -inner), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), inner * 2);
    // Los balaustres llegan al pasamanos (que ocupa la mitad de arriba del alto de un pilar).
    const bal = baluster(railH - postW / 2, balW, c.detail.sides);
    for (let u = balS / 2; u < inner * 2; u += balS) this.detail.geometry(bal, rail.m(u, 0, -postW / 2), this.col.column);
    bal.dispose();
    for (const u of [postW / 2, inner, inner * 2 - postW / 2]) this.stone.box(rail.m(u, railH / 2, -postW / 2), postW, railH, postW, this.col.wall);
    this.stone.box(rail.m(inner, railH - postW / 4, -postW / 2), inner * 2, postW / 2, postW, this.col.wall);
    this.record(-project, t, -half, half, corT + railH);
  }

  // ---------------------------------------------------------------- torres

  private tower(side: number): void {
    const c = this.c;
    const F = c.front;
    const T = c.tower;
    const [towerW, project] = F.tower;
    const half = F.size[1] / 2;
    const t = c.thickness;
    const curve = c.detail.curve;
    const out = new THREE.Vector3(0, 0, 1);
    // Centro de la torre: su calle de la fachada (que sale `project`), con el mismo fondo que ancho.
    const cz = side * (half - towerW / 2);
    const cx = towerW / 2 - project;
    const [pw, pd] = T.pilaster;
    const [ringTube, pedGap, pedDepth, roofSlab] = T.trim;
    let y = F.levels[4];
    for (const body of T.bodies) {
      const w = body.width;
      const h = body.height;
      const x0 = cx - w / 2;
      const z0 = cz - w / 2;
      for (const f of facesOf(x0, x0 + w, z0, z0 + w, this.base + y)) {
        const mid = w / 2;
        const [ow, oy, otop] = body.size;
        const holes: Record<string, () => THREE.Path> = {
          arch: () => archHole(mid, oy, ow, otop),
          rect: () => rectHole(mid - ow / 2, oy, mid + ow / 2, otop),
          clock: () => roundHole(mid, oy, ow),
        };
        if (!holes[body.opening]) throw new Error(`Vano de torre desconocido en ${c.id}: ${body.opening}`);
        const hole = holes[body.opening]();
        this.put(wall(0, w, 0, h, t, [], [hole], curve), f.m(0, 0, 0), this.col.wall, this.stucco);
        if (body.opening === 'clock') {
          this.put(new THREE.CircleGeometry(ow, c.detail.sides * 2), f.m(mid, oy, -t / 2), this.col.clock, { glow: glowOf(c.clockGlow) });
          this.put(new THREE.TorusGeometry(ow, ringTube, c.detail.sides / 4, c.detail.sides * 2), f.m(mid, oy, 0), this.col.trim, {}, this.detail);
        } else {
          const top = body.opening === 'arch' ? otop + ow / 2 : otop;
          const frame =
            body.opening === 'arch'
              ? archPath(mid, oy, ow, otop, 0.5, curve)
              : [new THREE.Vector3(mid - ow / 2, oy, 0), new THREE.Vector3(mid - ow / 2, top, 0), new THREE.Vector3(mid + ow / 2, top, 0), new THREE.Vector3(mid + ow / 2, oy, 0)];
          this.put(sweep(frame, out, c.profiles.frame), f.m(0, 0, 0), this.col.trim, {}, this.detail);
          if (body.pediment > 0) this.pediment(f, mid, top + pedGap, ow + pw, body.pediment, pedDepth, this.detail);
        }
        for (const u of [pw / 2, w - pw / 2]) this.stone.box(f.m(u, h / 2, pd / 2), pw, h, pd, this.col.wall, this.stucco);
      }
      // Adentro, oscuro: lo que se ve por los vanos.
      this.stone.box(new THREE.Matrix4().makeTranslation(cx, this.base + y + h / 2, cz), w - t * 2, h, w - t * 2, this.col.void);
      y += h;
      this.molding(loop(x0 - pd, x0 + w + pd, z0 - pd, z0 + w + pd, y - body.cornice), c.profiles.tower, this.col.trim, true);
    }
    // Remate: techo del último cuerpo, cúpula con nervios, linterna y cruz.
    const last = T.bodies[T.bodies.length - 1];
    this.stone.box(new THREE.Matrix4().makeTranslation(cx, this.base + y - roofSlab / 2, cz), last.width, roofSlab, last.width, this.col.trim);
    this.dome(cx, y, cz, T.dome, T.ribs, T.lantern, T.cross);
    const w0 = T.bodies[0].width;
    this.kit.block(
      [new THREE.Vector3(cx - w0 / 2, 0, cz - w0 / 2), new THREE.Vector3(cx + w0 / 2, 0, cz - w0 / 2), new THREE.Vector3(cx + w0 / 2, 0, cz + w0 / 2), new THREE.Vector3(cx - w0 / 2, 0, cz + w0 / 2)],
      this.base + F.levels[4],
      this.base + y,
    );
  }

  /** Cúpula de nervios con su linterna y la cruz, desde (x, y sobre la base, z). */
  private dome(x: number, y: number, z: number, d: number[], ribs: number[], lantern: number[], cross: number[]): void {
    const c = this.c;
    const [r0, rise, bulge, topR, steps] = d;
    const profile = domeProfile(r0, rise, bulge, topR, steps);
    const at = new THREE.Matrix4().makeTranslation(x, this.base + y, z);
    this.put(lathe(profile, c.detail.sides * 2), at, this.col.dome, { pattern: PATTERN.scales, scale: [TAU * r0, profileLength(profile)] });
    const [count, rw, rh] = ribs;
    for (let k = 0; k < count; k++) this.put(rib(profile, (k / count) * TAU, rw, rh), at, this.col.rib, {}, this.detail);
    const [lh, cap, overhang] = lantern;
    const crown = this.base + y + profile[profile.length - 1][1];
    this.put(new THREE.CylinderGeometry(topR, topR, lh, c.detail.sides), new THREE.Matrix4().makeTranslation(x, crown + lh / 2, z), this.col.wall);
    this.put(new THREE.ConeGeometry(topR + overhang, cap, c.detail.sides), new THREE.Matrix4().makeTranslation(x, crown + lh + cap / 2, z), this.col.dome);
    // El brazo de la cruz a lo ancho de la fachada (a lo largo de z): se ve de frente desde la plaza.
    this.cross(new THREE.Matrix4().makeTranslation(x, crown + lh + cap, z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), cross);
  }

  // ---------------------------------------------------------------- nave, crucero y ábside

  private body(): void {
    const c = this.c;
    const [depth, width] = c.front.size;
    const half = width / 2;
    const N = c.nave;
    const X = c.transept;
    const A = c.apse;
    this.mass(depth, depth + N.length, -half, half, N.height, this.col.wall);
    this.roof(depth, depth + N.length, -half, half, N.height, N.roof, true);
    this.mass(X.x[0], X.x[1], X.z[0], X.z[1], X.height, this.col.wall);
    this.roof(X.x[0], X.x[1], X.z[0], X.z[1], X.height, X.roof, false);
    this.mass(A.x[0], A.x[1], A.z[0], A.z[1], A.height, this.col.wall);
    this.molding(loop(depth, depth + N.length, -half, half, N.height), c.profiles.band, this.col.trim, true);
    this.molding(loop(X.x[0], X.x[1], X.z[0], X.z[1], X.height), c.profiles.band, this.col.trim, true);
    this.molding(loop(A.x[0], A.x[1], A.z[0], A.z[1], A.height), c.profiles.band, this.col.trim, true);
  }

  /** Techo a dos aguas (cumbrera a lo largo de x o de z) sobre el rectángulo, desde `y`. */
  private roof(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, alongX: boolean): void {
    const b = this.base + y;
    const P = (x: number, h: number, z: number): THREE.Vector3 => new THREE.Vector3(x, b + h, z);
    const color = this.col.roof;
    // Cada cara en sentido antihorario visto desde afuera (hacia arriba y hacia su lado).
    if (alongX) {
      const zm = (z0 + z1) / 2;
      this.stone.quad(P(x1, 0, z1), P(x1, rise, zm), P(x0, rise, zm), P(x0, 0, z1), color);
      this.stone.quad(P(x0, 0, z0), P(x0, rise, zm), P(x1, rise, zm), P(x1, 0, z0), color);
      this.stone.tri(P(x0, 0, z1), P(x0, rise, zm), P(x0, 0, z0), this.col.wall);
      this.stone.tri(P(x1, 0, z0), P(x1, rise, zm), P(x1, 0, z1), this.col.wall);
    } else {
      const xm = (x0 + x1) / 2;
      this.stone.quad(P(x0, 0, z1), P(xm, rise, z1), P(xm, rise, z0), P(x0, 0, z0), color);
      this.stone.quad(P(x1, 0, z0), P(xm, rise, z0), P(xm, rise, z1), P(x1, 0, z1), color);
      this.stone.tri(P(x0, 0, z1), P(x1, 0, z1), P(xm, rise, z1), this.col.wall);
      this.stone.tri(P(x1, 0, z0), P(x0, 0, z0), P(xm, rise, z0), this.col.wall);
    }
  }

  /** Cúpula del crucero sobre su tambor con ventanas. */
  private crossing(): void {
    const c = this.c;
    const X = c.crossing;
    const [cx, cz] = X.center;
    const [r, h, windows, ww, wh] = X.drum;
    const y = c.transept.height;
    const curve = c.detail.curve;
    this.put(new THREE.CylinderGeometry(r, r, h, c.detail.sides * 2), new THREE.Matrix4().makeTranslation(cx, this.base + y + h / 2, cz), this.col.wall, this.stucco);
    const y0 = (h - wh) / 2;
    const impost = y0 + wh - ww / 2;
    for (let k = 0; k < windows; k++) {
      const a = (k / windows) * TAU;
      const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const f = new Face(new THREE.Vector3(cx, this.base + y, cz).addScaledVector(n, r), new THREE.Vector3().crossVectors(UP, n), n, 0);
      this.put(new THREE.ShapeGeometry(this.archShape(ww, y0, impost), curve), f.m(0, 0, c.detail.inset), this.col.void);
      this.put(sweep(archPath(0, y0, ww, impost, 0.5, curve), new THREE.Vector3(0, 0, 1), c.profiles.frame), f.m(0, 0, 0), this.col.trim, {}, this.detail);
    }
    // `arc` repite el primer punto al final; cerrado, ese tramo quedaría de largo cero.
    this.molding(arc(cx, cz, r, 0, TAU, c.detail.sides * 2).slice(0, -1).map((p) => p.setY(y + h)), c.profiles.tower, this.col.trim, true);
    this.dome(cx, y + h, cz, X.dome, X.ribs, X.lantern, X.cross);
  }

  /** Silueta de un vano en arco (para pintarlo sobre una superficie curva). */
  private archShape(width: number, y0: number, impost: number): THREE.Shape {
    const s = new THREE.Shape();
    s.moveTo(-width / 2, y0);
    s.lineTo(width / 2, y0);
    s.lineTo(width / 2, impost);
    s.absarc(0, impost, width / 2, 0, Math.PI, false);
    s.closePath();
    return s;
  }

  // ---------------------------------------------------------------- costado sobre la calle

  private flank(): void {
    const c = this.c;
    const L = c.flank;
    const [x0, x1] = L.x;
    const [plinth, shopTop, corB, corT, parapetT] = L.levels;
    const [pw, pd] = L.pilaster;
    const t = c.thickness;
    const inset = c.detail.inset;
    const bury = c.ground.bury;
    const curve = c.detail.curve;
    const out = new THREE.Vector3(0, 0, 1);
    const back = c.front.size[1] / 2;
    const length = x1 - x0;
    const face = facesOf(x0, x1, back, L.z, this.base)[1];
    // Macizo detrás del muro de la calle; en la física va hasta la cara de afuera (el muro no se atraviesa).
    this.mass(x0 + t, x1, back, L.z - t, corT, this.col.wall, false);
    this.record(x0, x1, back, L.z, corT);
    const [lw, lSill, lImpost, sharp] = L.lancet;
    const [rw, rh, rSill] = L.rect;
    const [margin, signH, shutter, signGap] = L.shop;
    const signs = c.signs.map((s) => new THREE.Color(s));
    const [gableBay, , , gableW] = L.gable;
    const shops: THREE.Path[] = [];
    const holes: THREE.Path[] = [];
    L.bays.forEach((kind, k) => {
      const a = L.pilasters[k] - x0;
      const b = L.pilasters[k + 1] - x0;
      const mid = (a + b) / 2;
      const s0 = a + pw / 2 + margin;
      const s1 = b - pw / 2 - margin;
      const doorTop = shopTop - signH;
      shops.push(rectHole(s0, plinth, s1, doorTop));
      // Local: cortina a medio bajar, vidriera debajo y el letrero encima.
      const drop = doorTop - (doorTop - plinth) * shutter;
      this.pane(face, s0, s1, drop, doorTop, -t + inset, this.col.shutter, { pattern: PATTERN.shutter, ao: c.ao.shutter }, this.stone, [0, 0, s1 - s0, doorTop - drop]);
      this.pane(face, s0, s1, plinth, drop, -t + inset, this.col.glass, { glow: glowOf(c.shopGlow) }, this.glass);
      this.pane(face, s0, s1, doorTop, shopTop - signGap, pd, signs[k % signs.length], {}, this.stone);
      if (kind !== 'lancet' && kind !== 'rect') throw new Error(`Vano desconocido en el costado de ${c.id}: ${kind}`);
      if (kind === 'lancet') {
        const wide = k === gableBay ? gableW : lw;
        const r = Math.max(wide * sharp, wide / 2);
        const apex = lImpost + Math.sqrt(r * r - (r - wide / 2) ** 2);
        holes.push(pointedHole(mid, lSill, wide, lImpost, sharp));
        this.window(face, mid, wide, lSill, apex, -t + inset);
        this.put(sweep(archPath(mid, lSill, wide, lImpost, sharp, curve), out, c.profiles.frame), face.m(0, 0, 0), this.col.trim, {}, this.detail);
      } else {
        holes.push(rectHole(mid - rw / 2, rSill, mid + rw / 2, rSill + rh));
        this.window(face, mid, rw, rSill, rSill + rh, -t + inset);
      }
    });
    // Los locales (sobre el zócalo, pintados) y el piso de los ventanales, en muros aparte.
    this.put(wall(0, length, -bury, shopTop, t, [], shops, curve), face.m(0, 0, 0), this.col.shop, this.stucco);
    this.put(wall(0, length, shopTop, corB, t, [], holes, curve), face.m(0, 0, 0), this.col.wall, this.stucco);
    this.stone.box(face.m(length / 2, (plinth - bury) / 2, pd / 2), length, plinth + bury, pd, this.col.plinth);
    for (const x of L.pilasters) this.stone.box(face.m(x - x0, corB / 2, pd / 2), pw, corB, pd, this.col.wall, this.stucco);
    // Molduras de derecha a izquierda (vistas desde la calle): la faja sobre los locales y la cornisa.
    const along = (y: number): THREE.Vector3[] => [new THREE.Vector3(x1, y, L.z), new THREE.Vector3(x0, y, L.z)];
    this.molding(along(shopTop), c.profiles.band, this.col.trim);
    this.molding(along(corB), c.profiles.band, this.col.trim);
    // Pretil calado de óculos entre los pináculos, con su albardilla.
    const [holeR, holeS, parapetW] = L.parapet;
    const pierced: THREE.Path[] = [];
    for (let k = 0; k + 1 < L.pilasters.length; k++) {
      if (k === gableBay) continue;
      const a = L.pilasters[k] - x0 + pw;
      const b = L.pilasters[k + 1] - x0 - pw;
      const n = Math.max(1, Math.floor((b - a) / holeS));
      for (let j = 0; j < n; j++) pierced.push(roundHole(a + (b - a) * ((j + 0.5) / n), (corT + parapetT) / 2, holeR));
    }
    this.put(wall(0, length, corT, parapetT, parapetW, [], pierced, curve), face.m(0, 0, 0), this.col.wall, this.stucco);
    this.molding(along(parapetT).map((p) => p.setZ(L.z)), c.profiles.coping, this.col.trim);
    // Pináculos sobre cada pilastra.
    const [pinW, pinH, spireR, spireH] = L.pinnacle;
    for (const x of L.pilasters) {
      this.detail.box(face.m(x - x0, parapetT + pinH / 2, -parapetW / 2), pinW, pinH, pinW, this.col.wall);
      this.put(faceted(new THREE.ConeGeometry(spireR, spireH, 4, 1).rotateY(Math.PI / 4)), face.m(x - x0, parapetT + pinH + spireH / 2, -parapetW / 2), this.col.wall, {}, this.detail);
    }
    this.gable(face, L.pilasters[gableBay] - x0, L.pilasters[gableBay + 1] - x0, corT);
    this.flankEnd(x0, back, L.z);
    // El pretil se trepa; la azotea detrás es la del macizo.
    this.record(x0, x1, L.z - parapetW, L.z, parapetT);
  }

  /** Hastial de contracurvas sobre el tramo [u0, u1] con el escudo en relieve y la cruz. */
  private gable(f: Face, u0: number, u1: number, y: number): void {
    const c = this.c;
    const [, rise, curveH] = c.flank.gable;
    const segments = c.detail.curve;
    const w = u1 - u0;
    const mid = (u0 + u1) / 2;
    const top = gableTop(w, rise, curveH, segments);
    const shape = new THREE.Shape([new THREE.Vector2(w / 2, 0), new THREE.Vector2(-w / 2, 0), ...top]);
    this.put(new THREE.ExtrudeGeometry(shape, { depth: c.thickness, bevelEnabled: false, curveSegments: segments }).translate(0, 0, -c.thickness), f.m(mid, y, 0), this.col.wall, this.stucco);
    // El borde de izquierda a derecha: con la normal de la cara como eje, la moldura sale hacia arriba.
    this.put(sweep(top.map((p) => new THREE.Vector3(p.x, p.y, 0)), new THREE.Vector3(0, 0, 1), c.profiles.coping, { caps: true }), f.m(mid, y, 0), this.col.trim);
    // Escudo franciscano: el blasón con su emblema en relieve.
    const [sw, sh, sy, relief] = c.flank.shield;
    this.put(new THREE.ExtrudeGeometry(shield(sw, sh), { depth: relief, bevelEnabled: false, curveSegments: segments }), f.m(mid, y + sy, 0), this.col.trim);
    const [bar, arm, armAt, thick] = c.flank.emblem;
    this.detail.box(f.m(mid, y + sy + (sh - bar) / 2 + bar / 2, relief + thick / 2), thick, bar, thick, this.col.wall);
    this.detail.box(f.m(mid, y + sy + sh * armAt, relief + thick / 2), arm, thick, thick, this.col.wall);
    this.cross(f.m(mid, y + rise, -c.thickness / 2), c.tower.cross);
  }

  /** La punta del costado que da a la plaza: una puerta abajo y dos pares de ventanas en arco arriba. */
  private flankEnd(x0: number, z0: number, z1: number): void {
    const c = this.c;
    const L = c.flank;
    const [, shopTop, corB] = L.levels;
    const [ew, gap, sill, impost, door] = L.end;
    const t = c.thickness;
    const face = facesOf(x0, x0 + t, z0, z1, this.base)[0];
    const w = z1 - z0;
    const centers = [w / 3, (2 * w) / 3];
    const holes: THREE.Path[] = [];
    for (const u of centers) for (const k of [-1, 1]) holes.push(archHole(u + (k * (ew + gap)) / 2, sill, ew, impost));
    this.put(wall(0, w, shopTop, corB, t, [], holes, c.detail.curve), face.m(0, 0, 0), this.col.wall, this.stucco);
    const doorImpost = shopTop - door;
    this.put(wall(0, w, -c.ground.bury, shopTop, t, [{ center: w / 2, span: door, impost: doorImpost }], [], c.detail.curve), face.m(0, 0, 0), this.col.shop, this.stucco);
    this.pane(face, w / 2 - door / 2, w / 2 + door / 2, 0, doorImpost + door / 2, -t + c.detail.inset, this.col.door, { ao: c.ao.door }, this.stone);
    for (const u of centers) for (const k of [-1, 1]) this.window(face, u + (k * (ew + gap)) / 2, ew, sill, impost + ew / 2, -t + c.detail.inset);
  }

  // ---------------------------------------------------------------- convento

  private wing(w: ChurchWing): void {
    const c = this.c;
    const [x0, x1, z0, z1] = w.rect;
    const height = w.floors * w.floor;
    const t = c.thickness;
    const [arcadeFace, pier, headroom, arcadeDepth] = w.arcade;
    // Con arcada, la planta baja se retira la hondura del portal en esa cara y los pisos de arriba
    // la techan. En la física, el núcleo es el macizo (de abajo hasta la azotea) y lo que vuela
    // sobre el portal es una caja con `bottom`: debajo se camina.
    const inset = [t, t, t, t];
    if (arcadeFace >= 0) inset[arcadeFace] = arcadeDepth;
    const [ix0, iz1, ix1, iz0] = inset;
    this.mass(x0 + ix0, x1 - ix1, z0 + iz0, z1 - iz1, w.floor, this.col.wall, false);
    this.mass(x0 + t, x1 - t, z0 + t, z1 - t, height, this.col.wall, false, w.floor);
    // En la física, el macizo llega a la cara de afuera (los muros no se atraviesan), menos en la
    // cara de la arcada, donde se queda en la planta baja retirada.
    const solid = [0, 0, 0, 0];
    if (arcadeFace >= 0) solid[arcadeFace] = arcadeDepth;
    const [sx0, sz1, sx1, sz0] = solid;
    this.record(x0 + sx0, x1 - sx1, z0 + sz0, z1 - sz1, height);
    if (arcadeFace >= 0) {
      // El portal, de la cara de afuera a la planta baja retirada: arriba, los pisos (una caja con
      // `bottom`: debajo se camina); en sus puntas, los muros de los lados.
      const [px0, px1, pz0, pz1] = [
        [x0, x0 + ix0, z0, z1],
        [x0, x1, z1 - iz1, z1],
        [x1 - ix1, x1, z0, z1],
        [x0, x1, z0, z0 + iz0],
      ][arcadeFace];
      this.kit.box((px0 + px1) / 2, (pz0 + pz1) / 2, (px1 - px0) / 2, (pz1 - pz0) / 2, 0, this.base + height, true, this.base + w.floor);
      // En las caras ±x el portal corre a lo largo de z y sus puntas quedan en z0 y z1; en las ±z, al revés.
      const endsInZ = arcadeFace % 2 === 0;
      for (const end of [-1, 1]) {
        const cx = endsInZ ? (px0 + px1) / 2 : end < 0 ? px0 + t / 2 : px1 - t / 2;
        const cz = endsInZ ? (end < 0 ? pz0 + t / 2 : pz1 - t / 2) : (pz0 + pz1) / 2;
        const [hu, hv] = endsInZ ? [(px1 - px0) / 2, t / 2] : [t / 2, (pz1 - pz0) / 2];
        this.kit.box(cx, cz, hu, hv, 0, this.base + height, false, -Infinity);
      }
    }
    const [ww, wh, sill] = w.window;
    facesOf(x0, x1, z0, z1, this.base).forEach((f, i) => {
      const lit = w.faces.includes(i);
      const bays = Math.max(1, Math.floor(f.length / w.bay));
      const step = f.length / bays;
      const holes: THREE.Path[] = [];
      const arcade = i === arcadeFace;
      const span = step - pier;
      const arches = arcade ? Array.from({ length: bays }, (_, k) => ({ center: step * (k + 0.5), span, impost: w.floor - headroom - span / 2 })) : [];
      for (let b = 0; lit && b < bays; b++) {
        const u = step * (b + 0.5);
        for (let fl = arcade ? 1 : 0; fl < w.floors; fl++) {
          const y0 = fl * w.floor + sill;
          holes.push(rectHole(u - ww / 2, y0, u + ww / 2, y0 + wh));
          this.window(f, u, ww, y0, y0 + wh, -t + c.detail.inset);
        }
      }
      this.put(wall(0, f.length, -c.ground.bury, height, t, arches, holes, c.detail.curve), f.m(0, 0, 0), this.col.wall, this.stucco);
      if (!arcade) return;
      this.pane(f, 0, f.length, 0, w.floor, -arcadeDepth + c.detail.inset, this.col.shop, { ao: c.ao.arcade }, this.stone);
      // Cada pilar con su caja: detrás de los arcos el portal se camina.
      const angle = Math.atan2(f.u.z, f.u.x);
      for (let k = 0; k <= bays; k++) {
        const u0 = Math.max(0, step * k - pier / 2);
        const u1 = Math.min(f.length, step * k + pier / 2);
        const p = f.at((u0 + u1) / 2, 0, -t / 2);
        this.kit.box(p.x, p.z, (u1 - u0) / 2, t / 2, angle, this.base + w.floor, false, -Infinity);
      }
    });
    this.molding(loop(x0, x1, z0, z1, height), c.profiles.band, this.col.trim, true);
    this.molding(loop(x0, x1, z0, z1, 0), c.profiles.base, this.col.plinth, true);
  }

  // ---------------------------------------------------------------- plaza

  private plaza(): void {
    const c = this.c;
    const P = c.plaza;
    const top = (x: number, z: number): number => this.kit.terrain(x, z) + P.lift;
    for (const f of P.floors) {
      pave(this.paving, f.ring, top, c.ground.step, new THREE.Color(f.color), { pattern: patternOf(f.pattern), scale: f.scale });
      this.kit.ground(
        f.ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        P.lift,
      );
    }
    // Pila: el borde de piedra, el fondo celeste, el agua y los surtidores en anillo (finos abajo, abiertos arriba).
    const F = P.fountain;
    const [fx, fz] = F.center;
    const [rimW, rimH] = F.rim;
    const y = top(fx, fz);
    const sides = c.detail.sides * 4;
    const inner = F.radius - rimW;
    // Perfil de afuera hacia adentro: el torno deja las caras mirando afuera, arriba y al centro.
    const rim = lathe(
      [
        [F.radius, -c.ground.bury],
        [F.radius, rimH],
        [inner, rimH],
        [inner, F.depth],
      ],
      sides,
    );
    this.put(rim, new THREE.Matrix4().makeTranslation(fx, y, fz), this.col.basin);
    const surface = y + rimH - F.water;
    this.put(new THREE.CircleGeometry(inner, sides).rotateX(-Math.PI / 2), new THREE.Matrix4().makeTranslation(fx, y + F.depth, fz), this.col.pool);
    this.put(new THREE.CircleGeometry(inner, sides).rotateX(-Math.PI / 2), new THREE.Matrix4().makeTranslation(fx, surface, fz), this.col.water, {}, this.water);
    const [jets, jr, jt, spray] = F.jets;
    for (let k = 0; k < jets; k++) {
      const a = (k / jets) * TAU;
      const h = F.heights[k % F.heights.length];
      this.put(new THREE.CylinderGeometry(spray, jt, h, c.detail.sides / 2, 1, true), new THREE.Matrix4().makeTranslation(fx + Math.cos(a) * jr, surface + h / 2, fz + Math.sin(a) * jr), this.col.jet, {}, this.water);
    }
    this.kit.ring(fx, fz, inner, F.radius, y + rimH, true);
    // Pedestal escalonado con su dado, cornisa y plinto, y la estatua encima.
    const D = P.pedestal;
    let h = y + F.depth;
    for (const [w, sh] of [...D.steps, D.die, D.cap, D.plinth]) {
      this.stone.box(new THREE.Matrix4().makeTranslation(fx, h + sh / 2, fz), w, sh, w, this.col.basin, this.stucco);
      h += sh;
    }
    this.kit.box(fx, fz, D.steps[0][0] / 2, D.steps[0][0] / 2, 0, h, true, -Infinity);
    const S = P.statue;
    // La figura mira a +z: girarla para que mire hacia `facing`.
    this.put(figure(S.height, S.shape, c.detail.sides).geometry, new THREE.Matrix4().makeTranslation(fx, h, fz).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2 - S.facing)), this.col.bronze);
    // Bolardos del borde con la avenida.
    const B = P.bollards;
    const from = new THREE.Vector2(B.from[0], B.from[1]);
    const to = new THREE.Vector2(B.to[0], B.to[1]);
    const n = Math.max(1, Math.floor(from.distanceTo(to) / B.spacing));
    const cap = new THREE.SphereGeometry(B.radius, c.detail.sides, c.detail.sides / 2, 0, TAU, 0, Math.PI / 2);
    const post = new THREE.CylinderGeometry(B.radius, B.radius, B.height - B.radius, c.detail.sides);
    for (let k = 0; k <= n; k++) {
      const p = from.clone().lerp(to, k / n);
      const yb = top(p.x, p.y);
      this.detail.geometry(post, new THREE.Matrix4().makeTranslation(p.x, yb + (B.height - B.radius) / 2, p.y), this.col.bollard);
      this.detail.geometry(cap, new THREE.Matrix4().makeTranslation(p.x, yb + B.height - B.radius, p.y), this.col.bollard);
    }
    cap.dispose();
    post.dispose();
  }
}
