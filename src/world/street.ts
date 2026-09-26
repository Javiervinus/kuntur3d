import * as THREE from 'three';
import type { SignFace, SignRect } from '../render/signAtlas';
import { type DowntownBuilding, DowntownBuilder, type DowntownKit, type DowntownLights, type DowntownStyle, deepMerge } from './downtown';
import { type Median, type MedianStyle, buildMedian, medianLampModel, medianLamps, medianTrees } from './medians';
import { Batch, type MonumentBase, type Surface, patternOf } from './monumentParts';
import type { PlaceSite } from './placeKit';
import { type FurnitureItem, type StreetFurniture, furnitureModels, layoutFurniture } from './streetFurniture';
import { type Lane, type LaneStyle, type LotKit, type Retiro, type RetiroStyle, buildLane, buildRetiro, checkLane, checkRetiro } from './streetLots';

/**
 * Una calle con sus edificios, en config/game.json → monuments.list (tipo `street`): dónde está su
 * marco local (lat/lon del origen y rumbo del eje x) y el archivo de config/streets/ con todo lo
 * demás.
 */
export interface Street extends MonumentBase {
  file: string;
}

/** Vereda: su contorno (marco local de la calle) y qué lados llevan bordillo (dan a la calzada). */
export interface Sidewalk {
  ring: number[][];
  curbs: number[];
}

/**
 * Una cuadra (un lado de una manzana): sus veredas, sus edificios, los retiros frente a ellos y
 * el carril de estacionamiento junto a la calzada. Se ve y se descarta junta.
 */
export interface StreetBlock {
  id: string;
  name?: string;
  sidewalks: Sidewalk[];
  buildings: DowntownBuilding[];
  retiros?: Retiro[];
  lane?: Lane;
}

/** Un piso con bordillo: alto sobre la calzada, ancho del bordillo, colores y dibujo (y cuántas unidades mide cada metro). */
export interface PavedStyle {
  height: number;
  curb: number;
  color: string;
  curbColor: string;
  pattern: string;
  scale: number[];
}

/**
 * config/streets/<archivo>.json: la calle entera en el marco local (x a lo largo, z a la derecha).
 * `clear` y `blocks` los arma build_street.py (skill model-place) desde config/streets/<archivo>/;
 * el resto se edita a mano en el archivo.
 */
export interface StreetFile {
  name: string;
  /** De dónde salió cada dato (huellas, fotos, medidas). */
  sources: string[];
  /** Estilo base de los edificios, los estilos con nombre (retoques del base) y las luces. */
  defaults: DowntownStyle;
  styles: Record<string, Record<string, unknown>>;
  lights: DowntownLights;
  /** Colores de los letreros de los locales. */
  signs: string[];
  /**
   * Pisos que siguen el terreno: largo de cada tramo, cuánto quedan sobre el suelo y cuánto se
   * entierran los muros; y el grosor de la física de las vallas (rejas de los retiros, la cerca
   * del parterre), que hace falta si la calle las tiene.
   */
  ground: { step: number; lift: number; bury: number; wall?: number };
  /** Distancia (m) al centro de una cuadra hasta la que se ven sus detalles. */
  detail: { near: number };
  sidewalks: {
    /** Alto de la vereda sobre la calzada; bordillo: ancho. */
    height: number;
    curb: number;
    color: string;
    curbColor: string;
    /** Dibujo de la losa (un nombre de PATTERN) y cuántas unidades del dibujo mide cada metro. */
    pattern: string;
    scale: number[];
  };
  /** Faroles, árboles y bancas de las veredas (world/streetFurniture.ts). */
  furniture: StreetFurniture;
  /** Estilos de los retiros (world/streetLots.ts), por nombre. */
  retiros?: Record<string, RetiroStyle>;
  /** El carril de estacionamiento (world/streetLots.ts). */
  lane?: LaneStyle;
  /** El parterre de una avenida de doble calzada (world/medians.ts) y los de esta calle (los arma el script). */
  median?: MedianStyle;
  medians?: Median[];
  /**
   * Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos: la calle
   * con sus veredas y las huellas de los edificios que se reemplazan.
   */
  clear: number[][][];
  blocks: StreetBlock[];
}

const FILES = import.meta.glob<StreetFile>('../../config/streets/*.json', { eager: true, import: 'default' });

/** El archivo de config/streets/ de una calle (por nombre, sin extensión). */
export function streetFile(name: string): StreetFile {
  const key = Object.keys(FILES).find((k) => k.endsWith(`/${name}.json`));
  if (!key) throw new Error(`No existe config/streets/${name}.json (monuments.list → file)`);
  return FILES[key];
}

/** Lo que la calle necesita de Monuments (world/monuments.ts) para armarse. */
export interface StreetKit {
  root: THREE.Group;
  materials: { stone: THREE.Material; glass: THREE.Material; rails: THREE.Material };
  /** Altura del suelo en un punto del marco local. */
  terrain(x: number, z: number): number;
  /**
   * Un lugar de la física y del LOD con centro (x, z) del marco local: una cuadra o un parterre
   * (el mismo pedazo que el de un lugar de config/sites/, world/placeKit.ts).
   */
  site(x: number, z: number): PlaceSite;
  /** Un árbol de la vereda (marco local, pie a la altura `y` del mundo) para los árboles de la ciudad. */
  tree(x: number, z: number, y: number, height: number, radius: number, color: THREE.Color): void;
  /** Una palmera (marco local, pie a la altura `y` del mundo) para las palmeras de la ciudad. */
  palm(x: number, z: number, y: number, height: number): void;
  /** Un auto estacionado (marco local): centro, trompa (atan2(z, x) local) y cuánto queda sobre el terreno. */
  car(x: number, z: number, angle: number, lift: number): void;
  /** Dónde está un letrero en el atlas de letreros, y cuánto se separa su cara de lo que tiene detrás (m). */
  signRect(s: SignFace): SignRect;
  signOffset: number;
}

/** Recorta el polígono `poly` (x, z) al rectángulo [x0, x1] × [z0, z1] (Sutherland–Hodgman). */
function clipRect(poly: THREE.Vector2[], x0: number, x1: number, z0: number, z1: number): THREE.Vector2[] {
  let out = poly;
  const planes: [(p: THREE.Vector2) => number][] = [[(p) => p.x - x0], [(p) => x1 - p.x], [(p) => p.y - z0], [(p) => z1 - p.y]];
  for (const [side] of planes) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const da = side(a);
      const db = side(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) out.push(a.clone().lerp(b, da / (da - db)));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * Piso que sigue el terreno (una vereda, una plaza): el polígono (x, z) recortado a una grilla de
 * `step` m, cada pedazo triangulado a la altura `top(x, z)`, con el dibujo en uv del marco local.
 */
export function pave(batch: Batch, outline: readonly (readonly number[])[], top: (x: number, z: number) => number, step: number, color: THREE.Color, surface: Surface): void {
  const ring = outline.map(([x, z]) => new THREE.Vector2(x, z));
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.y);
    z1 = Math.max(z1, p.y);
  }
  for (let gx = Math.floor(x0 / step) * step; gx < x1; gx += step) {
    for (let gz = Math.floor(z0 / step) * step; gz < z1; gz += step) {
      const piece = clipRect(ring, gx, gx + step, gz, gz + step);
      if (piece.length < 3) continue;
      const tris = THREE.ShapeUtils.triangulateShape(piece, []);
      const v = piece.map((p) => new THREE.Vector3(p.x, top(p.x, p.y), p.y));
      for (const [a, b, c] of tris) {
        const [pa, pb, pc] = [v[a], v[b], v[c]];
        const up = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa)).y > 0;
        const [q0, q1, q2] = up ? [pa, pb, pc] : [pa, pc, pb];
        batch.tri(q0, q1, q2, color, surface, [q0.x, q0.z, q1.x, q1.z, q2.x, q2.z]);
      }
    }
  }
}

/** El grosor de la física de las vallas (`ground.wall`): hace falta recién cuando hay una; `where` dice de qué archivo falta. */
function wallOf(ground: { wall?: number }, where: string): number {
  if (ground.wall === undefined) throw new Error(`${where}: falta ground.wall (el grosor de la física de las vallas)`);
  return ground.wall;
}

/** Física de una valla (marco local): de a a b, hasta `top` (mundo), de `thick` m de grosor. */
function fencePhysics(site: Pick<PlaceSite, 'box'>, a: THREE.Vector2, b: THREE.Vector2, top: number, thick: number): void {
  const len = a.distanceTo(b);
  if (len < 1e-3) return;
  site.box((a.x + b.x) / 2, (a.y + b.y) / 2, len / 2, thick / 2, Math.atan2(b.y - a.y, b.x - a.x), top, false, -Infinity);
}

/**
 * Lo que un retiro o un carril (world/streetLots.ts → buildRetiro, buildLane) necesita para
 * armarse en el pedazo `site` de una calle o de un lugar: sus pisos siguen el terreno en tramos de
 * `ground.step` m, sus vallas atajan con el grosor `ground.wall` y sus autos y palmeras van a los
 * de la ciudad por `host`. `where` es el archivo, para el error si falta el grosor.
 */
export function lotKit(
  host: Pick<StreetKit, 'terrain' | 'car' | 'palm'>,
  batches: { stone: Batch; detail: Batch; rails: Batch },
  site: Pick<PlaceSite, 'box' | 'ground'>,
  ground: { step: number; wall?: number },
  where: string,
): LotKit {
  const { step } = ground;
  const terrain = (x: number, z: number): number => host.terrain(x, z);
  return {
    terrain,
    stone: batches.stone,
    detail: batches.detail,
    rails: batches.rails,
    step,
    pave: (ring, lift, color, surface) => pave(batches.stone, ring, (x, z) => terrain(x, z) + lift, step, color, surface),
    car: (x, z, angle, lift) => host.car(x, z, angle, lift),
    palm: (x, z, y, height) => host.palm(x, z, y, height),
    wall: (a, b, top) => fencePhysics(site, a, b, top, wallOf(ground, where)),
    ground: (ring, offset) =>
      site.ground(
        ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        offset,
      ),
  };
}

/**
 * Arma la calle: por cuadra, los edificios (world/downtown.ts) y las veredas con su bordillo, en
 * mallas que se descartan juntas; los detalles chicos y las barandas solo de cerca.
 */
export class StreetBuilder {
  private readonly signs: THREE.Color[];
  private readonly furniture: ReturnType<typeof layoutFurniture>;
  private readonly models: ReturnType<typeof furnitureModels>;
  /** El poste de dos brazos del parterre (uno para todos). */
  private medianModel: THREE.BufferGeometry | null = null;

  constructor(
    private readonly f: StreetFile,
    private readonly kit: StreetKit,
  ) {
    this.signs = f.signs.map((c) => new THREE.Color(c));
    this.furniture = layoutFurniture(f.furniture, f.blocks, (b) => this.entrances(b as StreetBlock));
    this.models = furnitureModels(f.furniture);
  }

  build(): void {
    for (const block of this.f.blocks) this.block(block);
    for (const m of this.f.medians ?? []) this.median(m);
  }

  /** De qué archivo es la calle (para los errores). */
  private get where(): string {
    return `config/streets (${this.f.name})`;
  }

  /** Un estilo de retiro por nombre, con los retoques del retiro. */
  private retiroStyle(r: Retiro): RetiroStyle {
    const preset = this.f.retiros?.[r.style];
    if (!preset) throw new Error(`Retiro de estilo desconocido en config/streets (${this.f.name}): ${r.style}`);
    const style = deepMerge(preset, r.set);
    checkRetiro(style, `${r.id} (config/streets: ${this.f.name})`);
    return style;
  }

  /** Las entradas de los retiros de una cuadra (tramos en x de la calle): ahí no va un auto ni un árbol. */
  private entrances(block: StreetBlock): number[][] {
    return (block.retiros ?? []).flatMap((r) => this.retiroStyle(r).gaps);
  }

  /**
   * Un parterre: su piso con el bordillo y la cerca (su propio lugar del LOD), los postes de dos
   * brazos instanciados y sus árboles (los de la ciudad).
   */
  private median(m: Median): void {
    const style = this.f.median;
    if (!style) throw new Error(`config/streets (${this.f.name}) tiene parterres sin "median"`);
    const xs = m.ring.map((p) => p[0]);
    const zs = m.ring.map((p) => p[1]);
    const site = this.kit.site((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2);
    const stone = new Batch();
    const rails = new Batch();
    const group = new THREE.Group();
    group.name = `street-${m.id}`;
    buildMedian(m, style, {
      terrain: (x, z) => this.kit.terrain(x, z),
      stone,
      rails,
      pave: (ring, curbs, paved) => this.pavement({ ring, curbs }, paved, stone, site),
      wall: (a, b, top) => fencePhysics(site, a, b, top, wallOf(this.f.ground, this.where)),
    });
    const lamps = medianLamps(style, [m]);
    if (lamps.length) {
      const geometry = this.medianModel ?? (this.medianModel = medianLampModel(style));
      const mesh = new THREE.InstancedMesh(geometry, this.kit.materials.stone, lamps.length);
      const mat = new THREE.Matrix4();
      lamps.forEach((l, k) => mesh.setMatrixAt(k, mat.makeTranslation(l.x, this.kit.terrain(l.x, l.z) + style.height, l.z)));
      mesh.computeBoundingSphere();
      mesh.name = `${group.name}-lamps`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      site.near(mesh, style.lamps.near);
      const [baseR] = style.lamps.pole.base;
      for (const l of lamps) site.circle(l.x, l.z, baseR, this.kit.terrain(l.x, l.z) + style.height + style.lamps.pole.height, false, -Infinity);
    }
    for (const t of medianTrees(style, [m])) this.kit.tree(t.x, t.z, this.kit.terrain(t.x, t.z) + style.height, t.height, t.radius, t.color);
    const add = (batch: Batch, material: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null => {
      if (batch.empty) return null;
      const mesh = new THREE.Mesh(batch.build(), material);
      mesh.name = `${group.name}-${name}`;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    add(stone, this.kit.materials.stone, 'stone', true);
    const fence = add(rails, this.kit.materials.rails, 'rails', false);
    if (fence) site.near(fence, this.f.detail.near);
    this.kit.root.add(group);
  }

  /** Estilo de un edificio: el base, el estilo con nombre y sus retoques. */
  private style(name: string, set?: Record<string, unknown>): DowntownStyle {
    const preset = this.f.styles[name];
    if (!preset) throw new Error(`Estilo desconocido en config/streets (${this.f.name}): ${name}`);
    return deepMerge(deepMerge(this.f.defaults, preset), set);
  }

  private block(block: StreetBlock): void {
    const f = this.f;
    // Centro de la cuadra (para el LOD y la física): el promedio de sus puntos.
    const pts = [...block.buildings.flatMap((b) => b.ring), ...block.sidewalks.flatMap((s) => s.ring)];
    const cx = pts.reduce((a, p) => a + p[0], 0) / Math.max(1, pts.length);
    const cz = pts.reduce((a, p) => a + p[1], 0) / Math.max(1, pts.length);
    const site = this.kit.site(cx, cz);
    const stone = new Batch();
    const glass = new Batch();
    const detail = new Batch();
    const rails = new Batch();
    const kit: DowntownKit = {
      terrain: (x, z) => this.kit.terrain(x, z),
      stone,
      glass,
      detail,
      rails,
      lights: f.lights,
      signs: this.signs,
      groundStep: f.ground.step,
      lift: f.ground.lift,
      bury: f.ground.bury,
      block: (outline, y0, top) => site.block(outline, y0, top),
      box: (x, z, halfU, halfV, angle, top, floor, bottom) => site.box(x, z, halfU, halfV, angle, top, floor, bottom),
      signRect: (s) => this.kit.signRect(s),
      signOffset: this.kit.signOffset,
    };
    for (const b of block.buildings) {
      const podium = new DowntownBuilder(b, this.style(b.style, b.set), kit);
      const { top } = podium.build();
      const t = b.tower;
      if (!t) continue;
      // Torre retranqueada sobre el podio: sin planta baja, con el estilo del podio retocado.
      const ring = t.ring ?? podium.towerRing(t.inset);
      const tower: DowntownBuilding = {
        id: `${b.id}-torre`,
        ring,
        fronts: t.fronts ?? ring.map((_, i) => i),
        floors: t.floors,
        style: t.style ?? b.style,
      };
      const style = deepMerge(deepMerge(this.style(tower.style, t.style ? undefined : b.set), t.set), { ground: 0 });
      new DowntownBuilder(tower, style, kit, top).build();
    }
    const S = f.sidewalks;
    for (const s of block.sidewalks) this.pavement(s, { height: S.height, curb: S.curb, color: S.color, curbColor: S.curbColor, pattern: S.pattern, scale: S.scale }, stone, site);
    const lots = lotKit(this.kit, { stone, detail, rails }, site, f.ground, this.where);
    for (const r of block.retiros ?? []) buildRetiro(r, this.retiroStyle(r), lots);
    if (block.lane) {
      if (!f.lane) throw new Error(`config/streets (${f.name}): la cuadra ${block.id} tiene carril y falta "lane"`);
      checkLane(f.lane, `${block.id} (config/streets: ${f.name})`);
      buildLane(block.lane, f.lane, lots, block.id, this.entrances(block));
    }

    const group = new THREE.Group();
    group.name = `street-${block.id}`;
    this.furnish(block, group, site);
    const add = (batch: Batch, material: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null => {
      if (batch.empty) return null;
      const mesh = new THREE.Mesh(batch.build(), material);
      mesh.name = `${group.name}-${name}`;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    add(stone, this.kit.materials.stone, 'stone', true);
    add(glass, this.kit.materials.glass, 'glass', false);
    // Lo chico no proyecta sombra (medio píxel en el mapa de sombras) y de lejos no se dibuja.
    const near = add(detail, this.kit.materials.stone, 'detail', false);
    if (near) site.near(near, f.detail.near);
    const calado = add(rails, this.kit.materials.rails, 'rails', false);
    if (calado) site.near(calado, f.detail.near);
    this.kit.root.add(group);
  }

  /**
   * Mobiliario de la cuadra: faroles, maceteros, alcorques y bancas instanciados (solo de cerca),
   * con su física; los árboles van a los de la ciudad (world/trees.ts), que ya saben dibujarlos.
   */
  private furnish(block: StreetBlock, group: THREE.Group, site: PlaceSite): void {
    const F = this.f.furniture;
    const top = (x: number, z: number): number => this.kit.terrain(x, z) + this.f.sidewalks.height;
    const mine = <T extends FurnitureItem>(items: readonly T[]): T[] => items.filter((i) => i.block === block.id);
    const lamps = mine(this.furniture.lamps);
    const trees = mine(this.furniture.trees);
    const benches = mine(this.furniture.benches);
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const m = new THREE.Matrix4();
    // +x del modelo hacia los edificios: girar −angle alrededor de y lo lleva a (cos, sin).
    const instanced = (geometry: THREE.BufferGeometry, items: readonly FurnitureItem[], name: string, shadow: boolean): void => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(geometry, this.kit.materials.stone, items.length);
      items.forEach((it, k) => mesh.setMatrixAt(k, m.compose(p.set(it.x, top(it.x, it.z), it.z), q.setFromAxisAngle(up, -it.angle), one)));
      mesh.computeBoundingSphere();
      mesh.name = `${group.name}-${name}`;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      site.near(mesh, F.near);
    };
    // Los faroles y los maceteros dan sombra; la rejilla y las bancas, bajas y caladas, no.
    instanced(this.models.lamp, lamps, 'lamps', true);
    instanced(this.models.planter, trees.filter((t) => t.planter), 'planters', true);
    instanced(this.models.grate, trees.filter((t) => !t.planter), 'grates', false);
    instanced(this.models.bench, benches, 'benches', false);
    const baseRadius = Math.max(...F.lamp.base.map(([r]) => r));
    for (const l of lamps) site.circle(l.x, l.z, baseRadius, top(l.x, l.z) + F.lamp.shaft.height, false, -Infinity);
    for (const t of trees) {
      const y = top(t.x, t.z);
      if (t.planter) site.circle(t.x, t.z, F.planter.radius, y + F.planter.height, false, -Infinity);
      this.kit.tree(t.x, t.z, y, t.height, t.radius, t.color);
    }
    const B = F.bench;
    // Al asiento de una banca se puede subir.
    for (const b of benches) site.box(b.x, b.z, B.depth / 2, B.length / 2, b.angle, top(b.x, b.z) + B.seat, true, -Infinity);
  }

  /** Vereda (o el piso de un parterre) de esta calle: ver `pavement`. */
  private pavement(s: Sidewalk, S: PavedStyle, stone: Batch, site: PlaceSite): void {
    pavement(s, S, this.f.ground, (x, z) => this.kit.terrain(x, z), stone, site);
  }
}

/**
 * Vereda (o el piso de un parterre): la losa a `height` sobre el terreno (en tramos de
 * `ground.step` que lo siguen), con su dibujo en uv del marco local; en los lados que dan a la
 * calzada, el bordillo (su canto y su franja de arriba), que baja `ground.bury` bajo la calzada y
 * sube `ground.lift` sobre la losa. Sirve para una calle y para cualquier lugar.
 */
export function pavement(
  s: Sidewalk,
  S: PavedStyle,
  ground: { step: number; lift: number; bury: number },
  terrain: (x: number, z: number) => number,
  stone: Batch,
  site: { ground(outline: THREE.Vector3[], offset: number): void },
): void {
  const step = ground.step;
  const color = new THREE.Color(S.color);
  const curbColor = new THREE.Color(S.curbColor);
  const ring = s.ring.map(([x, z]) => new THREE.Vector2(x, z));
  const top = (x: number, z: number): number => terrain(x, z) + S.height;
  // Losa: sigue el terreno, con el dibujo de la vereda.
  pave(stone, s.ring, top, step, color, { pattern: patternOf(S.pattern), scale: S.scale });
  // Bordillos: hacia afuera del polígono (la calzada).
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    area += p.x * q.y - q.x * p.y;
  }
  const outward = (dx: number, dz: number): THREE.Vector2 => (area > 0 ? new THREE.Vector2(dz, -dx) : new THREE.Vector2(-dz, dx));
  for (const i of s.curbs) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = a.distanceTo(b);
    const dir = b.clone().sub(a).divideScalar(len);
    const n = outward(dir.x, dir.y);
    const parts = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < parts; k++) {
      const p = a.clone().addScaledVector(dir, (len * k) / parts);
      const q = a.clone().addScaledVector(dir, (len * (k + 1)) / parts);
      const pIn = p.clone().addScaledVector(n, -S.curb);
      const qIn = q.clone().addScaledVector(n, -S.curb);
      const P = (v: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(v.x, y, v.y);
      const yp = top(p.x, p.y);
      const yq = top(q.x, q.y);
      const lift = ground.lift;
      // Canto (mira a la calzada) y la franja de arriba del bordillo (apenas sobre la losa).
      const face = [P(p, yp - S.height - ground.bury), P(q, yq - S.height - ground.bury), P(q, yq), P(p, yp)];
      const facing = new THREE.Vector3().subVectors(face[1], face[0]).cross(new THREE.Vector3().subVectors(face[3], face[0]));
      if (facing.x * n.x + facing.z * n.y > 0) stone.quad(face[0], face[1], face[2], face[3], curbColor);
      else stone.quad(face[1], face[0], face[3], face[2], curbColor);
      const band = [P(p, yp + lift), P(q, yq + lift), P(qIn, top(qIn.x, qIn.y) + lift), P(pIn, top(pIn.x, pIn.y) + lift)];
      const up = new THREE.Vector3().subVectors(band[1], band[0]).cross(new THREE.Vector3().subVectors(band[3], band[0])).y > 0;
      if (up) stone.quad(band[0], band[1], band[2], band[3], curbColor);
      else stone.quad(band[1], band[0], band[3], band[2], curbColor);
    }
  }
  site.ground(
    ring.map((p) => new THREE.Vector3(p.x, 0, p.y)),
    S.height,
  );
}
