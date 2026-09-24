import * as THREE from 'three';
import { type ColumnShape, type FigureShape, type Profile, condor, corinthianColumn, faceted, figure, lathe, sweep } from './classical';
import { Batch, type Glow, type MonumentBase, PATTERN, type Surface, colorsOf, glowOf } from './monumentParts';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

/**
 * Columna conmemorativa sobre su pedestal (config/game.json → monuments.list, tipo `column`),
 * como la Columna de los Próceres del 9 de Octubre (Agustín Querol, 1918): plataforma con una
 * escalinata en cada cara, zócalo de granito con alas en talud, pedestal de dos cuerpos con
 * cornisas, friso, medallones y placas, próceres de bronce de pie y alegorías sentadas en las
 * esquinas, fuste de bronce con grupos de figuras que suben en espiral, capitel de mármol y en la
 * cima la Libertad con la antorcha sobre un cóndor. Alrededor, su círculo de césped con reja baja.
 * Marco local: origen al pie del eje, a nivel del piso; x y z a lo largo de las caras. Largos en m.
 */
export interface VictoryColumn extends MonumentBase {
  /** Polígonos (marco local) donde no quedan edificios ni árboles de los datos. */
  clear: number[][][];
  /** Puntos (marco local) donde se mide el suelo (la base es su mediana), cuánto se entierra y cuánto sube el piso. */
  ground: { samples: number[][]; bury: number; lift: number };
  /** Hasta dónde se ve el detalle, lados de lo torneado y cuánto sale un relieve pegado a su cara. */
  detail: { near: number; sides: number; inset: number };
  rails: { roughness: number; metalness: number };
  colors: { platform: string; granite: string; pedestal: string; bronze: string; gold: string; marble: string; lawn: string; curb: string; fence: string; torch: string };
  torchGlow: Glow;
  /** Plataforma cuadrada (lado, alto) con una escalinata al centro de cada cara: ancho, gradas, huella. */
  platform: { size: number; height: number; stairs: number[] };
  /**
   * Zócalo de granito: lado abajo y arriba (sus caras en talud son las alas), alto; bloque al centro
   * de cada cara donde se para un prócer: ancho, vuelo, alto; su relieve de bronce: ancho, alto,
   * altura y cuánto sale.
   */
  base: { size: number[]; height: number; front: number[]; relief: number[] };
  /**
   * Pedestal: cuerpo bajo y alto (lado, alto), cornisa (perfil), faja del friso (alto, vuelo),
   * medallones (radio, altura, separación, relieve), ático (lado, alto) y su placa (ancho, alto,
   * altura, cuánto sale).
   */
  pedestal: { lower: number[]; upper: number[]; cornice: Profile; frieze: number[]; medallions: number[]; attic: number[]; plaque: number[] };
  /**
   * Fuste: diámetro y alto; basa de anillos (perfil de torno, radio y alto); grupos en espiral
   * (vueltas, desde y hasta qué fracción del fuste, bultos por vuelta, radio mínimo y máximo de
   * cada bulto, cuánto salen, cuánto se abren en altura, cuánto se estiran hacia arriba); panel
   * dorado (ancho, alto, altura en fracción) y sol dorado (radio, altura en fracción, relieve).
   */
  shaft: { diameter: number; height: number; base: number[][]; spiral: number[]; lumps: number[]; panel: number[]; sun: number[] };
  capital: ColumnShape;
  /**
   * La Libertad (alto, figura), su antorcha (radio arriba, radio abajo, alto) y el cóndor a sus pies
   * (envergadura, alas en grados).
   */
  crown: { height: number; shape: FigureShape; torch: number[]; condor: number[] };
  /**
   * Próceres de pie (alto, figura); alegorías sentadas en las esquinas: escala, inclinación (rad),
   * dónde (distancia al eje en x y z, altura), y la roca en la que se apoyan (largo, alto, ancho).
   */
  statues: { height: number; shape: FigureShape; seated: number[]; rock: number[] };
  /** Círculo de césped: radio; bordillo (ancho, alto); reja (alto, lado de los postes, separación de postes). */
  lawn: { radius: number; curb: number[]; fence: number[] };
}

/** Lo que la columna necesita de Monuments (world/monuments.ts). */
export interface ColumnKit {
  root: THREE.Group;
  materials: { stone: THREE.Material; rails: THREE.Material };
  terrain(x: number, z: number): number;
  box(x: number, z: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  circle(x: number, z: number, r: number, top: number, floor: boolean, bottom: number): void;
  /** Anillo (la reja del césped): radios, alto; alturas del mundo. */
  ring(cx: number, cz: number, inner: number, outer: number, top: number, floor: boolean): void;
  block(outline: THREE.Vector3[], y0: number, top: number): void;
  near(o: THREE.Object3D, distance: number): void;
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Las cuatro caras: hacia dónde mira cada una (+x, +z, −x, −z) y su eje a lo largo. */
const FACES = [0, 1, 2, 3].map((k) => {
  const a = (k * Math.PI) / 2;
  return { n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), u: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), yaw: Math.PI / 2 - a };
});

/**
 * Arma la columna en `kit.root`: lo grande en una malla con sombra (plataforma, pedestal, fuste,
 * capitel sencillo, la Libertad), el detalle chico solo de cerca y la reja calada aparte.
 */
export class ColumnBuilder {
  private readonly col: ReturnType<typeof colorsOf<keyof VictoryColumn['colors']>>;
  private readonly stone = new Batch();
  private readonly detail = new Batch();
  private readonly rails = new Batch();
  private base = 0;

  constructor(
    private readonly c: VictoryColumn,
    private readonly kit: ColumnKit,
  ) {
    this.col = colorsOf(c.colors);
  }

  build(): void {
    const c = this.c;
    const heights = c.ground.samples.map(([x, z]) => this.kit.terrain(x, z)).sort((a, b) => a - b);
    this.base = heights[Math.floor(heights.length / 2)] + c.ground.lift;
    const top = this.shaftTop + c.capital.capital * c.shaft.diameter + c.crown.height;
    for (const b of [this.stone, this.detail, this.rails]) b.flood.splice(0, 3, c.flood, this.base, top);
    this.lawn();
    this.platform();
    this.pedestal();
    this.statues();
    this.column();
    this.crown();
    this.meshes();
  }

  /** Alturas sobre la base: tope del zócalo, del pedestal (con el ático) y del fuste. */
  private get baseTop(): number {
    return this.c.platform.height + this.c.base.height;
  }

  private get pedestalTop(): number {
    const P = this.c.pedestal;
    return this.baseTop + P.lower[1] + P.upper[1] + P.attic[1];
  }

  private get shaftTop(): number {
    const S = this.c.shaft;
    return this.pedestalTop + S.base[S.base.length - 1][1] + S.height;
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
    const near = add(this.detail, k.materials.stone, 'detail', true);
    if (near) k.near(near, this.c.detail.near);
    const fence = add(this.rails, k.materials.rails, 'fence', false);
    if (fence) k.near(fence, this.c.detail.near);
  }

  private at(x: number, y: number, z: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeTranslation(x, this.base + y, z);
  }

  private put(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}, batch = this.stone): void {
    batch.geometry(g, m, color, surface);
    g.dispose();
  }

  /** Caja cuadrada centrada en el eje, de `size` de lado, de y0 a y1 (sobre la base). */
  private slab(size: number, y0: number, y1: number, color: THREE.Color, batch = this.stone): void {
    batch.box(this.at(0, (y0 + y1) / 2, 0), size, y1 - y0, size, color);
    const h = size / 2;
    this.kit.block(
      [new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h), new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h)],
      this.base + y0,
      this.base + y1,
    );
  }

  /** Cornisa alrededor de un cuadrado de lado `size` a la altura y (el perfil sale hacia afuera). */
  private cornice(size: number, y: number, profile: Profile, color: THREE.Color): void {
    const h = size / 2;
    const Y = this.base + y;
    // `sweep` saca el perfil hacia arriba × tramo: cada lado de derecha a izquierda visto desde afuera.
    const loop = [new THREE.Vector3(-h, Y, -h), new THREE.Vector3(h, Y, -h), new THREE.Vector3(h, Y, h), new THREE.Vector3(-h, Y, h)];
    this.put(sweep(loop, UP, profile, { closed: true }), new THREE.Matrix4(), color);
  }

  // ------------------------------------------------------------ césped y reja

  private lawn(): void {
    const c = this.c;
    const r = c.lawn.radius;
    const [curbW, curbH] = c.lawn.curb;
    const [fenceH, postW, postS] = c.lawn.fence;
    const sides = c.detail.sides * 6;
    const disc = new THREE.CircleGeometry(r, sides).rotateX(-Math.PI / 2);
    this.put(disc, this.at(0, curbH / 2, 0), this.col.lawn);
    const ring = lathe(
      [
        [r, -c.ground.bury],
        [r, curbH],
        [r - curbW, curbH],
        [r - curbW, curbH / 2],
      ],
      sides,
    );
    this.put(ring, this.at(0, 0, 0), this.col.curb);
    // Se pisa el césped y la reja (sobre el bordillo) ataja; se trepa, como en la calle.
    this.kit.circle(0, 0, r - curbW, this.base + curbH / 2, true, -Infinity);
    this.kit.ring(0, 0, r - curbW, r, this.base + curbH + fenceH, false);
    // Reja baja calada sobre el bordillo: una banda con barrotes (el dibujo, que se ve por los dos
    // lados) y postes cada tanto.
    const fr = r - curbW / 2;
    const posts = Math.max(4, Math.round((TAU * fr) / postS));
    const up = new THREE.Vector3(0, fenceH, 0);
    let u = 0;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * TAU;
      const a1 = ((k + 1) / sides) * TAU;
      const p0 = new THREE.Vector3(Math.cos(a0) * fr, this.base + curbH, Math.sin(a0) * fr);
      const p1 = new THREE.Vector3(Math.cos(a1) * fr, this.base + curbH, Math.sin(a1) * fr);
      const len = p0.distanceTo(p1);
      this.rails.quad(p0, p1, p1.clone().add(up), p0.clone().add(up), this.col.fence, { pattern: PATTERN.bars }, [u, 0, u + len, fenceH]);
      u += len;
    }
    for (let k = 0; k < posts; k++) {
      const a = (k / posts) * TAU;
      this.detail.box(this.at(Math.cos(a) * fr, curbH + fenceH / 2, Math.sin(a) * fr), postW, fenceH, postW, this.col.fence);
    }
  }

  // ------------------------------------------------------------ plataforma, zócalo y pedestal

  private platform(): void {
    const c = this.c;
    const P = c.platform;
    const bury = c.ground.bury;
    this.slab(P.size, -bury, P.height, this.col.platform);
    // Escalinata al centro de cada cara: gradas de afuera hacia adentro.
    const [width, steps, tread] = P.stairs;
    const rise = P.height / steps;
    for (const f of FACES) {
      for (let s = 0; s < steps; s++) {
        const out = P.size / 2 + tread * (steps - s - 0.5);
        const y1 = rise * (s + 1);
        const m = this.at(f.n.x * out, (y1 - bury) / 2, f.n.z * out).multiply(new THREE.Matrix4().makeRotationY(f.yaw));
        this.stone.box(m, width, y1 + bury, tread, this.col.platform);
        this.kit.box(f.n.x * out, f.n.z * out, tread / 2, width / 2, Math.atan2(f.n.z, f.n.x), this.base + y1, true, -Infinity);
      }
    }
  }

  private pedestal(): void {
    const c = this.c;
    const B = c.base;
    const P = c.pedestal;
    const y0 = c.platform.height;
    // Zócalo en talud (tronco de pirámide de cuatro caras: las alas).
    const [bottom, top] = B.size;
    const frustum = faceted(new THREE.CylinderGeometry(top / Math.SQRT2, bottom / Math.SQRT2, B.height, 4, 1).rotateY(Math.PI / 4));
    this.put(frustum, this.at(0, y0 + B.height / 2, 0), this.col.granite);
    this.kit.block(
      [new THREE.Vector3(-top / 2, 0, -top / 2), new THREE.Vector3(top / 2, 0, -top / 2), new THREE.Vector3(top / 2, 0, top / 2), new THREE.Vector3(-top / 2, 0, top / 2)],
      this.base + y0,
      this.base + this.baseTop,
    );
    // Bloques delanteros con su relieve de bronce (donde se para cada prócer).
    const [fw, fd, fh] = B.front;
    const [rw, rh, ry, rOut] = B.relief;
    for (const f of FACES) {
      const d = top / 2 + fd / 2;
      const m = this.at(f.n.x * d, y0 + fh / 2, f.n.z * d).multiply(new THREE.Matrix4().makeRotationY(f.yaw));
      this.stone.box(m, fw, fh, fd, this.col.granite);
      const face = top / 2 + fd + c.detail.inset;
      const r = this.at(f.n.x * face, y0 + ry, f.n.z * face).multiply(new THREE.Matrix4().makeRotationY(f.yaw));
      this.detail.box(r, rw, rh, rOut, this.col.bronze);
      this.kit.box(f.n.x * d, f.n.z * d, fd / 2, fw / 2, Math.atan2(f.n.z, f.n.x), this.base + y0 + fh, true, -Infinity);
    }
    // Cuerpo bajo, cuerpo alto con su friso y medallones, ático con la placa.
    let y = this.baseTop;
    const [lowSize, lowH] = P.lower;
    this.slab(lowSize, y, y + lowH, this.col.pedestal);
    y += lowH;
    this.cornice(lowSize, y - heightOf(P.cornice), P.cornice, this.col.pedestal);
    const [upSize, upH] = P.upper;
    this.slab(upSize, y, y + upH, this.col.pedestal);
    const [friezeH, friezeOut] = P.frieze;
    this.detail.box(this.at(0, y + upH - heightOf(P.cornice) - friezeH / 2, 0), upSize + friezeOut * 2, friezeH, upSize + friezeOut * 2, this.col.pedestal);
    const [mr, my, ms, mRelief] = P.medallions;
    for (const f of FACES) {
      for (const side of [-1, 1]) {
        const p = f.n.clone().multiplyScalar(upSize / 2).addScaledVector(f.u, (side * ms) / 2);
        const m = this.at(p.x, y + my, p.z).multiply(new THREE.Matrix4().makeRotationY(f.yaw)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        this.put(new THREE.CylinderGeometry(mr, mr, mRelief * 2, c.detail.sides * 2), m, this.col.bronze, {}, this.detail);
      }
    }
    y += upH;
    this.cornice(upSize, y - heightOf(P.cornice), P.cornice, this.col.pedestal);
    const [atticSize, atticH] = P.attic;
    this.slab(atticSize, y, y + atticH, this.col.pedestal);
    const [pw, ph, py, pOut] = P.plaque;
    for (const f of FACES) {
      const d = atticSize / 2;
      this.detail.box(this.at(f.n.x * d, y + py, f.n.z * d).multiply(new THREE.Matrix4().makeRotationY(f.yaw)), pw, ph, pOut, this.col.bronze);
    }
  }

  // ------------------------------------------------------------ estatuas

  private statues(): void {
    const c = this.c;
    const S = c.statues;
    const B = c.base;
    const y = c.platform.height + B.front[2];
    const prócer = figure(S.height, S.shape, c.detail.sides).geometry;
    for (const f of FACES) {
      const d = B.size[1] / 2 + B.front[1] / 2;
      this.detail.geometry(prócer, this.at(f.n.x * d, y, f.n.z * d).multiply(new THREE.Matrix4().makeRotationY(f.yaw)), this.col.bronze);
    }
    prócer.dispose();
    // Alegorías sentadas en las esquinas del zócalo: la misma figura, más chica y reclinada.
    const [scale, tilt, dx, dz, sy] = S.seated;
    const [rl, rh, rw] = S.rock;
    const seated = figure(S.height * scale, S.shape, c.detail.sides).geometry;
    const rock = new THREE.SphereGeometry(1, c.detail.sides, c.detail.sides / 2).scale(rl / 2, rh / 2, rw / 2);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const facing = Math.atan2(sz, sx);
        const corner = this.at(sx * dx, c.platform.height + sy, sz * dz).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2 - facing));
        this.detail.geometry(rock, corner.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -rw / 2)), this.col.bronze);
        this.detail.geometry(seated, corner.multiply(new THREE.Matrix4().makeRotationX(-tilt)), this.col.bronze);
      }
    }
    seated.dispose();
    rock.dispose();
  }

  // ------------------------------------------------------------ fuste y capitel

  private column(): void {
    const c = this.c;
    const S = c.shaft;
    const r = S.diameter / 2;
    const sides = c.detail.sides * 2;
    let y = this.pedestalTop;
    // Basa de anillos de bronce.
    this.put(lathe(S.base, sides), this.at(0, y, 0), this.col.bronze);
    y += S.base[S.base.length - 1][1];
    const y0 = y;
    this.put(new THREE.CylinderGeometry(r, r, S.height, sides, 1, true), this.at(0, y0 + S.height / 2, 0), this.col.bronze);
    this.kit.circle(0, 0, r, this.base + y0 + S.height, false, -Infinity);
    // Grupos de figuras que suben en espiral: bultos de bronce pegados al fuste.
    const [turns, from, to, perTurn] = S.spiral;
    const [rMin, rMax, out, spread, stretch] = S.lumps;
    const count = Math.round(turns * perTurn);
    const lump = new THREE.SphereGeometry(1, c.detail.sides, c.detail.sides / 2);
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const a = t * turns * TAU + (rand(k, 1) - 0.5) * (TAU / perTurn);
      const h = y0 + S.height * (from + (to - from) * t) + (rand(k, 2) - 0.5) * spread;
      const size = rMin + (rMax - rMin) * rand(k, 3);
      const d = r + size * out;
      const m = this.at(Math.cos(a) * d, h, Math.sin(a) * d)
        .multiply(new THREE.Matrix4().makeRotationY(-a))
        .multiply(new THREE.Matrix4().makeScale(size * out, size * (1 + stretch * rand(k, 4)), size));
      this.detail.geometry(lump, m, this.col.bronze);
    }
    lump.dispose();
    // Panel dorado de la inscripción y el sol en lo alto, de frente a −x (la avenida, hacia el río).
    const [pw, ph, pAt] = S.panel;
    const face = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
    const skin = r + c.detail.inset;
    this.put(new THREE.CylinderGeometry(skin, skin, ph, sides, 1, true, -pw / (2 * r), pw / r), this.at(0, y0 + S.height * pAt, 0).multiply(face), this.col.gold, {}, this.detail);
    const [sunR, sunAt, sunRelief] = S.sun;
    this.put(
      new THREE.CylinderGeometry(sunR, sunR, sunRelief, sides).rotateZ(Math.PI / 2),
      this.at(-(r + sunRelief / 2), y0 + S.height * sunAt, 0),
      this.col.gold,
      {},
      this.detail,
    );
    // Capitel de mármol: el corintio del kit (el detallado de cerca, el sencillo siempre).
    const capH = c.capital.capital * S.diameter;
    const order = corinthianColumn(S.diameter, capH, c.capital, c.detail.sides);
    order.shaft.dispose();
    const cap = this.at(0, this.shaftTop, 0);
    this.put(order.plain, cap, this.col.marble);
    this.put(order.capital, cap, this.col.marble, {}, this.detail);
  }

  /** La Libertad con la antorcha en alto, sobre el cóndor de alas abiertas. */
  private crown(): void {
    const c = this.c;
    const C = c.crown;
    const y = this.shaftTop + c.capital.capital * c.shaft.diameter;
    const [span, raise] = C.condor;
    // Mirando a −x, hacia la avenida y el río.
    const facing = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
    this.put(condor(span, raise, c.detail.sides), this.at(0, y, 0).multiply(facing), this.col.bronze);
    const lib = figure(C.height, C.shape, c.detail.sides);
    const foot = this.at(0, y, 0).multiply(facing);
    this.put(lib.geometry, foot, this.col.bronze);
    const [tTop, tBottom, th] = C.torch;
    const hand = lib.hands[0].clone().applyMatrix4(foot);
    this.put(new THREE.CylinderGeometry(tTop, tBottom, th, c.detail.sides), new THREE.Matrix4().makeTranslation(hand.x, hand.y + th / 2, hand.z), this.col.torch, { glow: glowOf(c.torchGlow) });
  }
}

/** Alto de un perfil de moldura. */
function heightOf(profile: Profile): number {
  return Math.max(...profile.map((q) => q[1])) - Math.min(...profile.map((q) => q[1]));
}
