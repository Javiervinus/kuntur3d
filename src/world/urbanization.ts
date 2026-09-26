import * as THREE from 'three';
import type { SignFace } from '../render/signAtlas';
import { type LampStyle, type MedianStyle, lampModel, lampLightsAt } from './medians';
import { weld } from './house';
import { Batch, patternOf } from './monumentParts';
import type { Finish } from './monuments';
import { buildHouses, houseSet } from './instances';
import type { PlaceKit, PlaceLight, PlaceSite, PlaceType } from './placeKit';
import { type CourtPlace, type CourtStyle, type PlayPlace, type PlayStyle, type PoolPlace, type PoolStyle, buildCourt, buildPlay, buildPool, poolRing } from './urbanSocial';
import { type StreetLamp, type UrbanStreets, checkStreets, sidewalkRuns, streetLamps } from './urbanStreets';
import {
  type BarrierPlace,
  type BarrierStyle,
  type BollardPlace,
  type BollardStyle,
  type FloorPlace,
  type FloorStyle,
  Frame,
  type GatePlace,
  type GateStyle,
  type PartsKit,
  type PavilionPlace,
  type PavilionStyle,
  type SignPanelPlace,
  type SignPanelStyle,
  type StripePlace,
  type StripeStyle,
  type TowerPlace,
  type TowerStyle,
  type UrbanGround,
  buildBarrier,
  buildBollards,
  buildFloor,
  buildGate,
  buildPavilion,
  buildSign,
  buildStripes,
  buildTower,
  checkMarks,
  curbed,
  floorRing,
  paveFit,
  pavilionLight,
  pick,
  signFace,
  styled,
  towerLight,
  turn,
} from './urbanizationParts';
import { WallBuilder, type WallRun, type WallStyle, checkWallRun, checkWallStyle } from './walls';

/** Árboles: alto y radio de copa (mínimo, máximo) y los verdes de la foto (sRGB), al azar estable. */
export interface TreeStyle {
  height: number[];
  radius: number[];
  colors: string[];
}

/**
 * Puntos de algo repetido en una zona (árboles, postes): sueltos (u, v) o a lo largo de una recta
 * (desde, hasta, cada cuánto; el primero en `from`).
 */
export interface Spread {
  at?: number[][];
  line?: { from: number[]; to: number[]; spacing: number };
}

/** Árboles en su zona (van a los árboles de la ciudad): dónde, estilo, cuánto sobre el terreno está su pie y de dónde sale. */
export interface TreeGroup extends Spread {
  style: string;
  lift: number;
  source: string;
}

/** Palmeras en su zona (van a las palmeras de la ciudad): dónde, alto (mínimo, máximo), pie sobre el terreno y fuente. */
export interface PalmGroup extends Spread {
  height: number[];
  lift: number;
  source: string;
}

/**
 * Un poste de luz (world/medians.ts → lampModel): fuste, brazos, luminaria, su luz para el alumbrado
 * y su luz propia; colores; los brazos (±1: hacia adelante y hacia atrás de su rumbo; [1] es el de
 * un brazo) y hasta qué distancia (del centro de su pedazo) se ve.
 */
export interface UrbanLampStyle extends LampStyle {
  colors: MedianStyle['colors'];
  sides: number[];
  near: number;
}

/** Postes de luz en su zona: dónde, hacia dónde sale el brazo (grados en la zona), pie sobre el terreno, estilo y fuente. */
export interface LampGroup extends Spread {
  style: string;
  angle: number;
  lift: number;
  source: string;
}

/**
 * Una zona de la urbanización: un pedazo con su propia física y su propio LOD (centro en su
 * origen), con su marco (origen en el marco del lugar y giro de su eje u, en grados) y lo que lleva,
 * cada cosa con su estilo (config → styles) y su lugar en la zona. Una garita, un tramo del bulevar,
 * un área social, una rotonda.
 */
export interface UrbanZone {
  id: string;
  at: number[];
  angle: number;
  source: string;
  floors?: FloorPlace[];
  pavilions?: PavilionPlace[];
  towers?: TowerPlace[];
  gates?: GatePlace[];
  barriers?: BarrierPlace[];
  stripes?: StripePlace[];
  bollards?: BollardPlace[];
  signs?: SignPanelPlace[];
  pools?: PoolPlace[];
  courts?: CourtPlace[];
  plays?: PlayPlace[];
  /** Vallas y muros de la zona (en su marco): cerramientos, muros bajos. */
  fences?: WallRun[];
  trees?: TreeGroup[];
  palms?: PalmGroup[];
  lamps?: LampGroup[];
}

/** Los estilos con nombre de una urbanización, por tipo de pieza. */
export interface UrbanStyles {
  walls: Record<string, WallStyle>;
  pavilions: Record<string, PavilionStyle>;
  towers: Record<string, TowerStyle>;
  gates: Record<string, GateStyle>;
  barriers: Record<string, BarrierStyle>;
  stripes: Record<string, StripeStyle>;
  bollards: Record<string, BollardStyle>;
  signs: Record<string, SignPanelStyle>;
  floors: Record<string, FloorStyle>;
  pools: Record<string, PoolStyle>;
  courts: Record<string, CourtStyle>;
  plays: Record<string, PlayStyle>;
  trees: Record<string, TreeStyle>;
  lamps: Record<string, UrbanLampStyle>;
}

/**
 * Una urbanización cerrada (tipo `urbanization`, config/sites/<archivo>.json): el muro perimetral,
 * las veredas y postes de las calles internas, las zonas (garitas, bulevar, áreas sociales,
 * rotondas) y sus casas (un conjunto de config/houses/, ver world/instances.ts). Todo en el marco
 * local del lugar (config/game.json → su entrada: x al rumbo, z a la derecha); largos en m.
 */
export interface UrbanizationFile {
  name: string;
  /** De dónde salió cada dato (fotos, satélite, planos), con su fecha. */
  sources: string[];
  /** Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos. */
  clear: number[][][];
  /** El conjunto de casas (config/houses/<nombre>.json); sin él, la urbanización va sin casas. */
  houses?: string;
  /** Cómo se asientan pisos y muros en el terreno, y la física de muros y techos (ver UrbanGround). */
  ground: UrbanGround;
  /** Hasta qué distancia (del centro de su pedazo) se ve lo chico de cada zona; lados de lo redondo y de lo fino. */
  detail: { near: number; sides: number; thin: number };
  /** Acabados: vidrio (ventanas), agua (piscinas; transparente) y calado (rejas, mallas, redes, cerco). */
  finishes: { glass: Finish; water: Finish; rails: Finish };
  styles: UrbanStyles;
  /** El muro perimetral: largo de sus celdas (cada una, un pedazo de física y LOD) y sus tramos. */
  perimeter: { cell: number; runs: WallRun[] };
  streets: UrbanStreets;
  zones: UrbanZone[];
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** Los puntos (u, v) de algo repetido en su zona. */
function spread(s: Spread): number[][] {
  const out = [...(s.at ?? [])];
  const L = s.line;
  if (L) {
    const [u0, v0] = L.from;
    const [u1, v1] = L.to;
    const len = Math.hypot(u1 - u0, v1 - v0);
    for (let d = 0; d <= len + 1e-6; d += L.spacing) out.push([u0 + ((u1 - u0) * d) / Math.max(len, 1e-6), v0 + ((v1 - v0) * d) / Math.max(len, 1e-6)]);
  }
  return out;
}

/** ¿El punto (x, z) cae dentro del contorno? */
function inside(ring: readonly (readonly number[])[], x: number, z: number): boolean {
  let hit = false;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
    const [xk, zk] = ring[k];
    const [xj, zj] = ring[j];
    if (zk > z !== zj > z && x < ((xj - xk) * (z - zk)) / (zj - zk) + xk) hit = !hit;
  }
  return hit;
}

/** Semilla estable de un texto (para el azar de árboles y ventanas). */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return (h >>> 0) % 100000;
}

/** Un tramo de muro de una zona, llevado al marco del lugar. */
function inPlace(run: WallRun, zone: Frame): WallRun {
  return { ...run, line: zone.ring(run.line) };
}

/** Falla al cargar si el archivo trae algo que no cierra: un estilo que no existe, un largo ≤ 0 que dejaría un bucle sin fin. */
function check(f: UrbanizationFile, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  const positive = (v: number, what: string): void => {
    if (!(v > 0)) bad(`${what} tiene que ser mayor que 0`);
  };
  const G = f.ground;
  positive(G.tolerance, 'ground.tolerance');
  positive(G.maxEdge, 'ground.maxEdge');
  positive(G.wall, 'ground.wall');
  positive(G.roofStep, 'ground.roofStep');
  if (!(G.lift >= 0) || !(G.bury >= 0)) bad('ground.lift y ground.bury no pueden ser negativos');
  positive(f.perimeter.cell, 'perimeter.cell');
  positive(f.detail.near, 'detail.near');
  if (!(f.detail.sides >= 3) || !(f.detail.thin >= 3)) bad('detail.sides y detail.thin: al menos 3 lados');
  const S = f.styles;
  for (const [name, w] of Object.entries(S.walls)) checkWallStyle(w, `${name} (${where})`);
  for (const run of f.perimeter.runs) {
    pick(S.walls, run.style, `Muro (${run.id})`);
    checkWallRun(run, where);
  }
  checkStreets(f.streets, where);
  for (const sec of Object.values(f.streets.sections)) {
    if (sec.lamps) pick(S.lamps, sec.lamps.style, 'Poste de luz');
    if (sec.verge) patternOf(sec.verge.pattern);
  }
  for (const [name, p] of Object.entries(S.pavilions)) {
    positive(p.posts.spacing, `pavilions.${name}.posts.spacing`);
    patternOf(p.posts.pattern);
    patternOf(p.roof.pattern);
    for (const t of p.tiers) {
      if (!(t.inset > 0)) bad(`pavilions.${name}.tiers: inset tiene que ser mayor que 0`);
      if (t.rise <= t.inset * Math.tan(THREE.MathUtils.degToRad(p.roof.pitch))) bad(`pavilions.${name}.tiers: rise tiene que pasar lo que sube el techo de abajo hasta el metido`);
    }
    if (p.room) patternOf(p.room.pattern);
    if (p.light && !(p.light.gap >= 0)) bad(`pavilions.${name}.light.gap no puede ser negativo`);
  }
  for (const [name, t] of Object.entries(S.towers)) {
    if (!t.levels.length) bad(`towers.${name}.levels está vacío`);
    patternOf(t.walls.pattern);
    patternOf(t.roof.pattern);
    for (const o of t.openings) if (o.level >= t.levels.length) bad(`towers.${name}: un vano en el nivel ${o.level}, que no existe`);
  }
  for (const [name, s] of Object.entries(S.stripes)) if (!(s.stripe + s.gap > 0) || !(s.stripe > 0)) bad(`stripes.${name}: stripe tiene que ser mayor que 0`);
  for (const [name, b] of Object.entries(S.bollards)) positive(b.band, `bollards.${name}.band`);
  for (const [name, b] of Object.entries(S.barriers)) positive(b.boom.stripe, `barriers.${name}.boom.stripe`);
  for (const [name, fl] of Object.entries(S.floors)) {
    patternOf(fl.pattern);
    if (fl.curb && fl.curb.paint.colors.length) {
      positive(fl.curb.paint.dash, `floors.${name}.curb.paint.dash`);
      positive(fl.curb.paint.film, `floors.${name}.curb.paint.film`);
    }
  }
  for (const [name, c] of Object.entries(S.courts)) {
    patternOf(c.surface.pattern);
    if (c.fence) pick(S.walls, c.fence.style, `Cerramiento de la cancha ${name}`);
    if (!(c.zonesLift > 0) || !(c.lines.lift > c.zonesLift)) bad(`courts.${name}: zonesLift tiene que ser mayor que 0 y lines.lift, mayor que zonesLift (las líneas van sobre las zonas pintadas)`);
  }
  for (const [name, sg] of Object.entries(S.signs)) {
    const fl = sg.floodlights;
    if (fl && !(fl.flood >= 0 && fl.flood <= 1)) bad(`signs.${name}.floodlights.flood va de 0 a 1`);
  }
  for (const [name, t] of Object.entries(S.trees)) if (!t.colors.length) bad(`trees.${name}.colors está vacío`);
  const spreadOk = (s: Spread, what: string): void => {
    if (s.line) positive(s.line.spacing, `${what}.line.spacing`);
  };
  for (const z of f.zones) {
    const w = `zona ${z.id}`;
    const poolIds = new Set((z.pools ?? []).map((p) => p.id));
    for (const p of z.floors ?? []) {
      pick(S.floors, p.style, `Piso (${w})`);
      if (!p.ring && !p.circle) bad(`${w}: el piso ${p.id} necesita ring o circle`);
      for (const h of p.holes ?? []) if (!poolIds.has(h)) bad(`${w}: el piso ${p.id} tiene de hueco la piscina ${h}, que no está en la zona`);
    }
    for (const p of z.pavilions ?? []) pick(S.pavilions, p.style, `Pabellón (${w})`);
    for (const p of z.towers ?? []) pick(S.towers, p.style, `Caseta (${w})`);
    for (const p of z.gates ?? []) pick(S.gates, p.style, `Portón (${w})`);
    for (const p of z.barriers ?? []) pick(S.barriers, p.style, `Pluma (${w})`);
    for (const p of z.stripes ?? []) pick(S.stripes, p.style, `Franjas (${w})`);
    for (const p of z.bollards ?? []) pick(S.bollards, p.style, `Bolardo (${w})`);
    for (const p of z.signs ?? []) {
      pick(S.signs, p.style, `Letrero (${w})`);
      checkMarks(p.marks ?? [], `${w}: letrero ${p.id}`);
    }
    for (const p of z.pools ?? []) {
      pick(S.pools, p.style, `Piscina (${w})`);
      if (!p.ring && !p.ellipse) bad(`${w}: la piscina ${p.id} necesita ring o ellipse`);
    }
    for (const p of z.courts ?? []) pick(S.courts, p.style, `Cancha (${w})`);
    for (const p of z.plays ?? []) pick(S.plays, p.style, `Juego (${w})`);
    for (const r of z.fences ?? []) {
      pick(S.walls, r.style, `Valla (${w})`);
      checkWallRun(r, w);
    }
    for (const t of z.trees ?? []) {
      pick(S.trees, t.style, `Árbol (${w})`);
      spreadOk(t, `${w}: árboles`);
    }
    for (const p of z.palms ?? []) spreadOk(p, `${w}: palmeras`);
    for (const l of z.lamps ?? []) {
      pick(S.lamps, l.style, `Poste de luz (${w})`);
      spreadOk(l, `${w}: postes`);
    }
  }
}

/** Los letreros de todas las zonas (para el atlas compartido). */
function signs(f: UrbanizationFile): SignFace[] {
  return f.zones.flatMap((z) => (z.signs ?? []).flatMap((s) => s.texts.map(signFace)));
}

/** Las luces de un poste (su pie en `foot`, marco del lugar, con el brazo hacia `angle`). */
function lampLights(style: UrbanLampStyle, foot: { x: number; z: number }, angle: number, lift: number): PlaceLight[] {
  // lampLightsAt da las luces de un poste sin girar (brazos hacia ±z); se giran al rumbo del poste.
  return lampLightsAt(style, 0, 0, style.sides).map((l) => {
    const a = angle - Math.PI / 2 + l.out;
    const r = Math.hypot(l.x, l.z);
    return { x: foot.x + Math.cos(a) * r, z: foot.z + Math.sin(a) * r, lift, h: l.h, out: a, power: style.light.power, led: style.light.led };
  });
}

/**
 * Las luces de la urbanización para el alumbrado: postes de las calles y de las zonas, plafones y
 * los reflectores de las casetas (en la cumbrera). Los reflectores de piso de un letrero no van: el
 * alumbrado solo sabe de luminarias altas que alumbran el suelo; el letrero va bañado por ellos.
 */
function lights(f: UrbanizationFile): PlaceLight[] {
  const S = f.styles;
  const out: PlaceLight[] = [];
  for (const l of streetLamps(f.streets)) out.push(...lampLights(pick(S.lamps, l.style, 'Poste de luz'), l, l.angle, l.lift));
  for (const z of f.zones) {
    const frame = Frame.of(z.at, z.angle);
    for (const g of z.lamps ?? []) {
      const style = pick(S.lamps, g.style, 'Poste de luz');
      for (const [u, v] of spread(g)) out.push(...lampLights(style, frame.point(u, v), frame.angle + THREE.MathUtils.degToRad(g.angle), g.lift));
    }
    for (const p of z.pavilions ?? []) {
      const l = pavilionLight(p, styled(S.pavilions, p.style, 'Pabellón', p.set), frame);
      if (l) out.push(l);
    }
    for (const t of z.towers ?? []) {
      const l = towerLight(t, styled(S.towers, t.style, 'Caseta', t.set), frame);
      if (l) out.push(l);
    }
  }
  return out;
}

/** Los materiales de la urbanización (del kit y sus acabados). */
interface Materials {
  stone: THREE.Material;
  glass: THREE.Material;
  water: THREE.Material;
  rails: THREE.Material;
  posts: THREE.Material;
}

/** Arma la urbanización: el muro, las veredas y postes de las calles, las zonas y las casas. */
class UrbanizationBuilder {
  private readonly id: string;
  private readonly materials: Materials;
  private readonly lampModels = new Map<string, THREE.BufferGeometry>();

  constructor(
    private readonly f: UrbanizationFile,
    private readonly kit: PlaceKit,
  ) {
    this.id = kit.root.name;
    this.materials = {
      stone: kit.materials.stone,
      glass: kit.finish(f.finishes.glass),
      water: kit.finish(f.finishes.water),
      rails: kit.finish({ ...f.finishes.rails, cutout: true }),
      posts: kit.materials.paint,
    };
  }

  build(): void {
    this.perimeter();
    this.streets();
    for (const z of this.f.zones) this.zone(z);
  }

  /** El muro perimetral, tramo por tramo, en celdas. */
  private perimeter(): void {
    const group = new THREE.Group();
    group.name = `${this.id}-muros`;
    const walls = new WallBuilder(this.f.styles.walls, { terrain: (x, z) => this.kit.terrain(x, z), site: (x, z) => this.kit.site(x, z), group, materials: this.materials, wall: this.f.ground.wall }, this.f.perimeter.cell);
    for (const run of this.f.perimeter.runs) walls.build(run, `${this.id}-muro-${run.id}`);
    walls.flush();
    this.kit.root.add(group);
  }

  /**
   * Veredas y postes de las calles internas, repartidos en celdas de una grilla. Las losas y las
   * franjas de detrás van en el suelo (su sombra caería debajo de ellas: no proyectan); los cantos
   * de los bordillos, sí.
   */
  private streets(): void {
    const S = this.f.streets;
    // La celda en el nombre de sus mallas, sin guiones (un −1 sale «m1») para no partir `<id>-<parte>`.
    const tag = (k: number): string => (k < 0 ? `m${-k}` : `${k}`);
    const cellOf = (x: number, z: number): string => `${tag(Math.floor(x / S.cell))}_${tag(Math.floor(z / S.cell))}`;
    const cells = new Map<string, { runs: ReturnType<typeof sidewalkRuns>; lamps: StreetLamp[]; x: number; z: number; n: number }>();
    const cell = (x: number, z: number) => {
      const key = cellOf(x, z);
      let c = cells.get(key);
      if (!c) {
        c = { runs: [], lamps: [], x: 0, z: 0, n: 0 };
        cells.set(key, c);
      }
      c.x += x;
      c.z += z;
      c.n++;
      return c;
    };
    for (const r of sidewalkRuns(S)) {
      const cx = r.ring.reduce((a, p) => a + p[0], 0) / r.ring.length;
      const cz = r.ring.reduce((a, p) => a + p[1], 0) / r.ring.length;
      cell(cx, cz).runs.push(r);
    }
    for (const l of streetLamps(S)) cell(l.x, l.z).lamps.push(l);
    const terrain = (x: number, z: number): number => this.kit.terrain(x, z);
    for (const [key, c] of cells) {
      const site = this.kit.site(c.x / c.n, c.z / c.n);
      const group = new THREE.Group();
      group.name = `${this.id}-veredas-${key}`;
      const flat = new Batch();
      const curbs = new Batch();
      for (const r of c.runs) {
        curbed({ ring: r.ring, curbs: r.curbs }, r.section.paved, this.f.ground, terrain, flat, curbs, site);
        const V = r.section.verge;
        if (V && r.verge) {
          paveFit(flat, r.verge, [], (x, z) => terrain(x, z) + V.lift, this.f.ground, new THREE.Color(V.color), { pattern: patternOf(V.pattern), scale: V.scale });
          site.ground(
            r.verge.map(([x, z]) => new THREE.Vector3(x, 0, z)),
            V.lift,
          );
        }
      }
      this.mesh(flat, this.materials.stone, `${group.name}-stone`, false, group);
      this.mesh(curbs, this.materials.stone, `${group.name}-bordillos`, true, group);
      this.lamps(c.lamps, group, site);
      this.kit.root.add(group);
    }
  }

  /** Postes de luz instanciados (uno por estilo), con su física; solo de cerca. */
  private lamps(list: readonly StreetLamp[], group: THREE.Group, site: PlaceSite): void {
    const byStyle = new Map<string, StreetLamp[]>();
    for (const l of list) byStyle.set(l.style, [...(byStyle.get(l.style) ?? []), l]);
    for (const [name, items] of byStyle) {
      const style = pick(this.f.styles.lamps, name, 'Poste de luz');
      let geometry = this.lampModels.get(name);
      if (!geometry) {
        geometry = lampModel(style, style.colors, style.sides);
        this.lampModels.set(name, geometry);
      }
      const mesh = new THREE.InstancedMesh(geometry, this.materials.stone, items.length);
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      // El brazo del modelo va hacia +z: girarlo al rumbo `angle` es girar π/2 − angle alrededor de y.
      items.forEach((l, k) => mesh.setMatrixAt(k, m.compose(p.set(l.x, this.kit.terrain(l.x, l.z) + l.lift, l.z), turn(l.angle - Math.PI / 2), one)));
      mesh.computeBoundingSphere();
      mesh.name = `${group.name}-postes-${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      site.near(mesh, style.near);
      const [baseR] = style.pole.base;
      for (const l of items) site.circle(l.x, l.z, baseR, this.kit.terrain(l.x, l.z) + l.lift + style.pole.height, false, -Infinity);
    }
  }

  /** Una zona: su pedazo de la física y del LOD, sus piezas y sus mallas. */
  private zone(z: UrbanZone): void {
    const f = this.f;
    const S = f.styles;
    const frame = Frame.of(z.at, z.angle);
    const site = this.kit.site(frame.x, frame.z);
    const group = new THREE.Group();
    group.name = `${this.id}-${z.id}`;
    // Los huecos de los pisos: las piscinas de la zona que nombran (el deck alrededor del agua).
    const pools = new Map((z.pools ?? []).map((p) => [p.id, frame.ring(poolRing(p, f.detail.sides))]));
    // Los pisos de la zona (marco del lugar), para asentar encima lo que va sobre ellos (las franjas).
    const floors = (z.floors ?? []).map((p) => ({ ring: frame.ring(floorRing(p, f.detail.sides)), lift: pick(S.floors, p.style, 'Piso').lift, holes: (p.holes ?? []).map((id) => pools.get(id) ?? []) }));
    const pk: PartsKit = {
      terrain: (x, zz) => this.kit.terrain(x, zz),
      site,
      stone: new Batch(),
      detail: new Batch(),
      rails: new Batch(),
      glass: new Batch(),
      water: new Batch(),
      signRect: (s) => this.kit.signRect(s),
      signOffset: this.kit.signOffset,
      ground: f.ground,
      sides: f.detail.sides,
      thin: f.detail.thin,
      floorAt: (x, zz) => floors.reduce((top, fl) => (fl.lift > top && inside(fl.ring, x, zz) && !fl.holes.some((h) => inside(h, x, zz)) ? fl.lift : top), 0),
    };
    // Lo que se arme sin su propio suelo se mide desde el de la zona (el pie sucio del revoque).
    const ground = pk.terrain(frame.x, frame.z);
    for (const b of [pk.stone, pk.detail, pk.rails, pk.glass, pk.water]) b.flood[1] = ground;
    const walls = new WallBuilder(S.walls, { terrain: pk.terrain, site: () => site, group, materials: this.materials, wall: f.ground.wall }, f.perimeter.cell);
    const wall = (run: WallRun): void => walls.build(run, `${group.name}-vallas`);
    for (const p of z.floors ?? []) buildFloor(p, pick(S.floors, p.style, 'Piso'), frame, pk, (p.holes ?? []).map((id) => pick(Object.fromEntries(pools), id, `Hueco del piso ${p.id}`)));
    for (const p of z.pools ?? []) buildPool(p, pick(S.pools, p.style, 'Piscina'), frame, pk);
    for (const c of z.courts ?? []) buildCourt(c, pick(S.courts, c.style, 'Cancha'), frame, pk, wall);
    for (const p of z.pavilions ?? []) buildPavilion(p, styled(S.pavilions, p.style, 'Pabellón', p.set), frame, pk);
    for (const t of z.towers ?? []) buildTower(t, styled(S.towers, t.style, 'Caseta', t.set), frame, pk);
    for (const g of z.gates ?? []) buildGate(g, pick(S.gates, g.style, 'Portón'), frame, pk);
    for (const b of z.barriers ?? []) buildBarrier(b, pick(S.barriers, b.style, 'Pluma'), frame, pk);
    for (const s of z.stripes ?? []) buildStripes(s, pick(S.stripes, s.style, 'Franjas'), frame, pk);
    for (const b of z.bollards ?? []) buildBollards(b, pick(S.bollards, b.style, 'Bolardo'), frame, pk);
    for (const s of z.signs ?? []) buildSign(s, styled(S.signs, s.style, 'Letrero', s.set), frame, pk);
    for (const p of z.plays ?? []) buildPlay(p, pick(S.plays, p.style, 'Juego'), frame, pk);
    for (const r of z.fences ?? []) wall(inPlace(r, frame));
    // Árboles y palmeras: a los de la ciudad, con su azar estable.
    const seed = seedOf(`${this.id}-${z.id}`);
    let k = 0;
    for (const t of z.trees ?? []) {
      const T = pick(S.trees, t.style, 'Árbol');
      const greens = T.colors.map((c) => new THREE.Color(c));
      for (const [u, v] of spread(t)) {
        const p = frame.point(u, v);
        const n = seed + k++;
        const height = THREE.MathUtils.lerp(T.height[0], T.height[1], rand(n, 1));
        const radius = THREE.MathUtils.lerp(T.radius[0], T.radius[1], rand(n, 2));
        this.kit.tree(p.x, p.z, this.kit.terrain(p.x, p.z) + t.lift, height, radius, greens[Math.floor(rand(n, 3) * greens.length) % greens.length]);
      }
    }
    for (const g of z.palms ?? []) {
      for (const [u, v] of spread(g)) {
        const p = frame.point(u, v);
        this.kit.palm(p.x, p.z, this.kit.terrain(p.x, p.z) + g.lift, THREE.MathUtils.lerp(g.height[0], g.height[1], rand(seed + k++, 4)));
      }
    }
    const lamps: StreetLamp[] = [];
    for (const g of z.lamps ?? []) {
      for (const [u, v] of spread(g)) {
        const p = frame.point(u, v);
        lamps.push({ x: p.x, z: p.z, angle: frame.angle + THREE.MathUtils.degToRad(g.angle), style: g.style, lift: g.lift });
      }
    }
    this.lamps(lamps, group, site);
    walls.flush();
    // Mallas: lo que se ve siempre (con sombra), lo chico y lo calado solo de cerca, vidrio y agua.
    const near = f.detail.near;
    this.mesh(pk.stone, this.materials.stone, `${group.name}-stone`, true, group);
    const detail = this.mesh(pk.detail, this.materials.stone, `${group.name}-detail`, false, group);
    if (detail) site.near(detail, near);
    const rails = this.mesh(pk.rails, this.materials.rails, `${group.name}-rails`, false, group);
    if (rails) site.near(rails, near);
    this.mesh(pk.glass, this.materials.glass, `${group.name}-glass`, false, group);
    this.mesh(pk.water, this.materials.water, `${group.name}-water`, false, group);
    this.kit.root.add(group);
  }

  /** Una malla de un Batch, con sus vértices iguales unidos (Batch no los une). */
  private mesh(batch: Batch, material: THREE.Material, name: string, shadow: boolean, group: THREE.Group): THREE.Mesh | null {
    if (batch.empty) return null;
    const built = batch.build();
    const mesh = new THREE.Mesh(weld(built).geometry, material);
    built.dispose();
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }
}

export const URBANIZATION: PlaceType<UrbanizationFile> = {
  check,
  signs,
  lights,
  clear: (f) => f.clear,
  build: (f, kit) => {
    new UrbanizationBuilder(f, kit).build();
    if (f.houses) buildHouses(houseSet(f.houses), kit);
  },
};
