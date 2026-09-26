import * as THREE from 'three';
import type { SignFace } from '../render/signAtlas';
import { type DowntownBuilding, DowntownBuilder, type DowntownKit, type DowntownLights, type DowntownStyle, deepMerge, seedOf } from './downtown';
import { Batch, patternOf } from './monumentParts';
import type { Finish } from './monuments';
import type { PlaceKit, PlaceLight, PlaceSite, PlaceType } from './placeKit';
import {
  type BaseKit,
  type Bed,
  type Canopy,
  type Curb,
  type Flight,
  type Paved,
  type PlacedSign,
  type Platform,
  buildBed,
  buildCanopy,
  buildCurb,
  buildFlight,
  buildPaved,
  buildPlatform,
  buildSign,
  canopyLights,
} from './towerBase';
import { type CrownStyle, type ShaftStyle, buildCrown, buildShaft, crownLevels, shaftLights, shaftPhysics } from './towerShaft';

/**
 * Un cuerpo al lado de la torre (el anexo, el parqueo, su núcleo, la rampa): un edificio armado
 * con las fachadas de las calles (world/downtown.ts), con la misma huella, pisos, estilo y
 * retoques que un edificio de config/streets; con `tower`, otro cuerpo encima (el parqueo abierto
 * sobre su zócalo ciego).
 */
export interface TowerBody extends DowntownBuilding {
  /** El acabado de sus vidrios (una clave de `finishes`): un vidrio que refleja, o uno mate para los vanos abiertos de un parqueo. */
  glass: string;
  source: string;
}

/**
 * Una torre de planta repetida que puede girar piso a piso (tipo `tower`, config/sites/<archivo>.json),
 * con su remate, la calle a sus pies y los cuerpos que tiene al lado. Marco local del lugar
 * (config/game.json → monuments.list: x al rumbo, z a su derecha), largos en m y alturas desde la
 * base del lugar (la mediana del terreno en `ground.samples`).
 */
export interface TowerFile {
  name: string;
  /** De dónde salió cada dato (fotos, satélite, planos), con su fecha. */
  sources: string[];
  /** Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos (también del horizonte lejano). */
  clear: number[][][];
  /**
   * El suelo: puntos (marco local) cuya mediana del terreno es la base (la vereda de referencia);
   * largo de los tramos de los pisos que siguen el terreno, cuánto quedan sobre él, cuánto se
   * entierran los muros y grosor de la física de las barandas y vallas (no el que se ve: tiene que
   * pasar lo que se avanza por cuadro corriendo, o se atraviesan).
   */
  ground: { samples: number[][]; step: number; lift: number; bury: number; wall: number };
  /** Distancias (m, en planta al centro de cada pedazo) hasta las que se ve lo chico de la calle y lo chico del remate. */
  detail: { near: number; crown: number };
  /** Acabados con nombre (vidrios, calados): los piden los vidrios del fuste, los cuerpos y las barandas. */
  finishes: Record<string, Finish>;
  shaft: ShaftStyle;
  crown: CrownStyle;
  /** Lo que está a nivel de la calle, a los pies de la torre. */
  street: {
    platforms: Platform[];
    flights: Flight[];
    canopies: Canopy[];
    beds: Bed[];
    curbs: Curb[];
    paved: Paved[];
    /** Palmeras sueltas en la vereda: [x, z, alto]. */
    palms: number[][];
    signs: PlacedSign[];
    /** El acabado (una clave de `finishes`) de las barandas caladas. */
    rails: string;
  };
  /** Los cuerpos de al lado: el estilo base, los estilos con nombre (retoques), sus luces, los colores de los letreros de sus locales y cada cuerpo. */
  bodies: {
    defaults: DowntownStyle;
    styles: Record<string, Record<string, unknown>>;
    lights: DowntownLights;
    signs: string[];
    list: TowerBody[];
  };
}

/** Falla con un mensaje claro si `ok` no se cumple. */
function need(ok: boolean, where: string, what: string): void {
  if (!ok) throw new Error(`${where}: ${what}`);
}

const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;
const index = (v: unknown, length: number): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) < length;
const pair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(finite);
const ring = (r: unknown, min = 3): boolean => Array.isArray(r) && r.length >= min && r.every((p) => Array.isArray(p) && p.length >= 2 && p.every(finite));

/** Revisa el archivo al cargar: lo que falta o lo que armaría mal (un largo ≤ 0 en un bucle, un nombre que no existe). */
function check(f: TowerFile, where: string): void {
  need(!!f && typeof f.name === 'string', where, 'falta "name"');
  need(Array.isArray(f.sources) && f.sources.length > 0, where, 'faltan las fuentes ("sources")');
  need(Array.isArray(f.clear) && f.clear.every((r) => ring(r)), where, '"clear" debe ser una lista de polígonos de al menos 3 puntos');
  const G = f.ground;
  need(!!G && ring(G.samples, 1), where, 'faltan los puntos del terreno ("ground.samples")');
  need(positive(G.step) && finite(G.lift) && finite(G.bury) && positive(G.wall), where, '"ground" necesita step > 0, lift, bury y wall > 0');
  need(!!f.detail && positive(f.detail.near) && positive(f.detail.crown), where, '"detail" necesita near y crown > 0');
  need(!!f.finishes && typeof f.finishes === 'object', where, 'faltan los acabados ("finishes")');
  const finish = (name: string, what: string): void => need(Object.hasOwn(f.finishes, name), where, `${what}: acabado desconocido "${name}" (hay: ${Object.keys(f.finishes).join(', ')})`);

  const S = f.shaft;
  need(!!S && ring([S.center], 1), where, 'falta el eje del fuste ("shaft.center")');
  need(!!S.plan && Array.isArray(S.plan.size) && S.plan.size.length === 2 && S.plan.size.every(positive), where, '"shaft.plan.size" debe ser [ancho, fondo] > 0');
  need(finite(S.plan.radius) && S.plan.radius >= 0 && count(S.plan.segments), where, '"shaft.plan" necesita radius ≥ 0 y segments (entero) > 0');
  need(finite(S.plan.fillet) && S.plan.fillet >= 0 && S.plan.fillet <= Math.min(...S.plan.size) / 2, where, '"shaft.plan.fillet" debe ir de 0 a la mitad del lado más corto');
  need(!(S.plan.fillet > 0 && S.plan.radius > 0), where, '"shaft.plan": las esquinas van redondeadas (fillet) o recortadas por un círculo (radius), no las dos');
  need(finite(S.lift), where, 'falta "shaft.lift"');
  need(!!S.glazings && typeof S.glazings === 'object', where, 'faltan los vidrios ("shaft.glazings")');
  need(Array.isArray(S.floors) && S.floors.length > 0, where, 'faltan los pisos ("shaft.floors")');
  for (const [k, fl] of S.floors.entries()) {
    const w = `shaft.floors[${k}]`;
    need(count(fl.count), where, `${w}: count debe ser un entero > 0`);
    need(positive(fl.height) && positive(fl.band) && fl.band < fl.height, where, `${w}: height y band > 0, band < height`);
    need(finite(fl.inset) && fl.inset >= 0, where, `${w}: inset ≥ 0`);
    need(Object.hasOwn(S.glazings, fl.glazing), where, `${w}: vidrio desconocido "${fl.glazing}"`);
  }
  for (const [name, g] of Object.entries(S.glazings)) {
    need(positive(g.module) && pair(g.panes) && g.panes.every(positive), where, `shaft.glazings.${name}: module > 0 y panes [x, y] > 0`);
    need(pair(g.ao) && finite(g.share) && finite(g.tone) && !!g.glow, where, `shaft.glazings.${name}: faltan ao [pie, cabeza], share, tone o glow`);
    finish(g.finish, `shaft.glazings.${name}`);
  }
  const floors = S.floors.reduce((a, fl) => a + fl.count, 0);
  need(Array.isArray(S.twist) && S.twist.length > 0 && S.twist.every((r) => pair(r)), where, '"shaft.twist" debe tener filas [nivel, grados]');
  need(
    S.twist.every((r, k) => k === 0 || r[0] > S.twist[k - 1][0]),
    where,
    '"shaft.twist": los niveles deben crecer de fila en fila',
  );
  need(!!S.band && finite(S.band.round) && count(S.band.segments) && finite(S.band.overlap) && !!S.band.ao, where, '"shaft.band" necesita round, segments (entero) > 0, overlap y ao');
  need(!!S.skirt && !!S.leds && !!S.spots && !!S.physics, where, '"shaft" necesita skirt, leds, spots y physics');
  patternOf(S.skirt.pattern);
  need(Number.isInteger(S.leds.from) && Number.isInteger(S.leds.to) && positive(S.leds.height), where, '"shaft.leds" necesita from y to (niveles) y height > 0');
  const P = S.spots;
  need(Number.isInteger(P.level) && P.level >= 1 && P.level <= floors, where, `"shaft.spots.level" debe ser un nivel de 1 a ${floors}`);
  need(positive(P.spacing) && positive(P.size) && finite(P.drop) && Array.isArray(P.sides) && P.sides.every((r) => pair(r)), where, '"shaft.spots" necesita spacing y size > 0, drop y sides [[desde, hasta]]');
  need(!!P.light && count(P.light.every), where, '"shaft.spots.light.every" debe ser un entero > 0');
  need(count(S.sections), where, '"shaft.sections" debe ser un entero > 0');
  need(count(S.physics.every) && positive(S.physics.depth) && count(S.physics.segments), where, '"shaft.physics" necesita every y segments (enteros) > 0 y depth > 0');

  const C = f.crown;
  need(!!C && !!C.ring && !!C.fins && !!C.inner && !!C.ribs && !!C.led && !!C.rail && !!C.floor && Array.isArray(C.rooms) && Array.isArray(C.masts), where, '"crown" necesita ring, fins, inner, ribs, led, rail, floor, rooms y masts');
  need(positive(C.height) && positive(C.ring.height) && C.ring.height <= C.height && positive(C.ring.depth), where, '"crown" necesita height > 0 y un anillo (ring) con height ≤ crown.height y depth > 0');
  need(positive(C.fins.spacing) && pair(C.fins.size) && C.fins.size.every(positive), where, '"crown.fins" necesita spacing > 0 y size [grosor, fondo] > 0');
  need(pair(C.inner.size) && C.inner.size.every(positive) && pair(C.ribs.size) && C.ribs.size.every(positive), where, '"crown.inner.size" y "crown.ribs.size" deben ser [ancho, alto] > 0');
  need(Number.isInteger(C.ribs.count) && C.ribs.count >= 0, where, '"crown.ribs.count" debe ser un entero ≥ 0');
  need(Object.hasOwn(S.glazings, C.rail.glazing) && positive(C.rail.height), where, '"crown.rail" necesita height > 0 y un vidrio de shaft.glazings');
  patternOf(C.floor.pattern);
  for (const m of C.masts) need(ring([m.at], 1) && positive(m.height) && positive(m.radius) && count(m.sides), where, '"crown.masts": at, height y radius > 0 y sides (entero) > 0');
  for (const r of C.rooms) need(ring([r.at], 1) && Array.isArray(r.size) && r.size.length === 3 && r.size.every(positive), where, '"crown.rooms": at y size [ancho, fondo, alto] > 0');

  const T = f.street;
  need(!!T && [T.platforms, T.flights, T.canopies, T.beds, T.curbs, T.paved, T.palms, T.signs].every(Array.isArray), where, '"street" necesita las listas platforms, flights, canopies, beds, curbs, paved, palms y signs (vacías si no hay)');
  finish(T.rails, 'street.rails');
  for (const p of T.platforms) {
    need(ring(p.ring) && Array.isArray(p.edges) && p.edges.every((i) => index(i, p.ring.length)), where, `street.platforms ${p.id}: ring de 3+ puntos y edges dentro de él`);
    need(!!p.rail && positive(p.rail.post) && positive(p.rail.height) && Array.isArray(p.rail.gaps), where, `street.platforms ${p.id}: rail con post y height > 0 y gaps`);
    need(p.rail.gaps.every((g) => g.length === 3 && index(g[0], p.ring.length) && finite(g[1]) && g[2] > g[1]), where, `street.platforms ${p.id}: cada tramo sin baranda es [lado, desde, hasta] con hasta > desde`);
    patternOf(p.wall.pattern);
    patternOf(p.floor.pattern);
    patternOf(p.rail.pattern);
  }
  for (const fl of T.flights) {
    need(fl.kind === 'steps' || fl.kind === 'ramp', where, `street.flights ${fl.id}: kind debe ser "steps" o "ramp"`);
    need(ring([fl.at], 1) && positive(fl.rise) && positive(fl.width), where, `street.flights ${fl.id}: at, rise y width > 0`);
    need(fl.kind === 'steps' ? positive(fl.run) && fl.slope === undefined : positive(fl.slope) && fl.run === undefined, where, `street.flights ${fl.id}: una escalera lleva run > 0 (y no slope); una rampa, slope > 0 (y no run)`);
    patternOf(fl.pattern);
  }
  for (const c of T.canopies) {
    need(ring(c.ring) && positive(c.soffit) && positive(c.fascia) && positive(c.strip), where, `street.canopies ${c.id}: ring, soffit, fascia y strip > 0`);
    need(Array.isArray(c.attached) && c.attached.every((i) => index(i, c.ring.length)) && ring(c.columns.at, 0) && positive(c.columns.size), where, `street.canopies ${c.id}: attached dentro de la planta y columnas con at y size > 0`);
    need(positive(c.spots.spacing) && positive(c.spots.size) && count(c.spots.light.every), where, `street.canopies ${c.id}: spots.spacing y size > 0, spots.light.every entero > 0`);
    patternOf(c.cladding.pattern);
    need(Array.isArray(c.signs), where, `street.canopies ${c.id}: faltan sus letreros ("signs", vacío si no hay)`);
    for (const sg of c.signs) {
      need(index(sg.edge, c.ring.length) && !c.attached.includes(sg.edge), where, `street.canopies ${c.id}: el letrero "${sg.text}" va en un lado con canto`);
      need(pair(sg.size) && sg.size.every(positive) && finite(sg.at), where, `street.canopies ${c.id}: el letrero "${sg.text}" necesita size [ancho, alto] > 0 y at`);
    }
  }
  for (const b of T.beds) {
    need(ring(b.ring) && Array.isArray(b.palms) && b.palms.every((p) => p.length === 3 && p.every(finite)), where, `street.beds ${b.id}: ring de 3+ puntos y palmeras [x, z, alto]`);
    patternOf(b.hedge.pattern);
  }
  for (const c of T.curbs) {
    need(ring(c.line, 2) && positive(c.width) && positive(c.height), where, `street.curbs ${c.id}: line de 2+ puntos, width y height > 0`);
    patternOf(c.pattern);
  }
  for (const p of T.paved) {
    need(ring(p.ring) && finite(p.lift), where, `street.paved ${p.id}: ring de 3+ puntos y lift`);
    patternOf(p.pattern);
  }
  need(T.palms.every((p) => p.length === 3 && p.every(finite)), where, '"street.palms" debe ser una lista de [x, z, alto]');
  for (const s of T.signs) need(typeof s.text === 'string' && pair(s.size) && s.size.every(positive) && ring([s.at], 1) && finite(s.y) && finite(s.angle), where, `street.signs "${s.text}": text, size [ancho, alto] > 0, at, y y angle`);

  const B = f.bodies;
  need(!!B && !!B.defaults && !!B.styles && !!B.lights && Array.isArray(B.signs) && Array.isArray(B.list), where, '"bodies" necesita defaults, styles, lights, signs y list');
  for (const b of B.list) {
    need(ring(b.ring) && Number.isInteger(b.floors) && b.floors >= 0 && Array.isArray(b.fronts) && b.fronts.every((i) => index(i, b.ring.length)), where, `bodies ${b.id}: ring de 3+ puntos, floors entero ≥ 0 y fronts dentro de la huella`);
    need(Object.hasOwn(B.styles, b.style) && (!b.tower?.style || Object.hasOwn(B.styles, b.tower.style)), where, `bodies ${b.id}: estilo desconocido`);
    need(!b.tower || (count(b.tower.floors) && (!b.tower.ring || ring(b.tower.ring))), where, `bodies ${b.id}: el cuerpo de arriba necesita floors (entero) > 0`);
    finish(b.glass, `bodies ${b.id}`);
  }
  for (const [name, st] of Object.entries(B.styles)) {
    const s = deepMerge(B.defaults, st);
    need(positive(s.floor) && positive(s.facade.bay) && positive(s.portal.bay) && positive(s.shops.pane) && count(s.curve), where, `bodies.styles.${name}: floor, facade.bay, portal.bay y shops.pane > 0 y curve entero > 0`);
  }
}

/** Los letreros del lugar: los puestos en la calle, los de las marquesinas y los de los locales de los cuerpos. */
function signs(f: TowerFile): SignFace[] {
  return [...f.street.signs, ...f.street.canopies.flatMap((c) => c.signs), ...f.bodies.list.flatMap((b) => b.signs ?? [])];
}

/** Sus luces para el alumbrado: los focos del soportal y los de las marquesinas. */
function lights(f: TowerFile): PlaceLight[] {
  return [...shaftLights(f.shaft), ...f.street.canopies.flatMap((c) => canopyLights(c))];
}

/** El centro (promedio de los puntos) de unos contornos. */
function centerOf(rings: readonly (readonly (readonly number[])[])[]): [number, number] {
  const pts = rings.flat();
  if (!pts.length) return [0, 0];
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

/** Arma el lugar: el fuste por grupos de pisos, el remate, la calle a sus pies y los cuerpos de al lado. */
class TowerBuilder {
  private readonly id: string;
  private readonly base: number;
  /** Alto del lugar (de la base al tope del remate): hasta ahí se apagan los reflectores. */
  private readonly height: number;

  constructor(
    private readonly f: TowerFile,
    private readonly kit: PlaceKit,
  ) {
    this.id = kit.root.name;
    const samples = f.ground.samples.map(([x, z]) => kit.terrain(x, z)).sort((a, b) => a - b);
    this.base = samples[Math.floor(samples.length / 2)];
    this.height = crownLevels(f.shaft, f.crown).top;
  }

  /** Un búfer de piezas con los reflectores del lugar (desde su base, apagándose hasta su tope). */
  private batch(): Batch {
    const b = new Batch();
    b.flood.splice(0, 3, this.kit.flood, this.base, this.height);
    return b;
  }

  build(): void {
    this.shaft();
    this.street();
    for (const b of this.f.bodies.list) this.body(b);
  }

  /** Una malla con lo que juntó un `Batch` (nada si quedó vacío). */
  private mesh(batch: Batch, material: THREE.Material, name: string, shadow: boolean, parent: THREE.Object3D): THREE.Mesh | null {
    if (batch.empty) return null;
    const mesh = new THREE.Mesh(batch.build(), material);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private material(finish: string): THREE.Material {
    return this.kit.finish(this.f.finishes[finish]);
  }

  /** El fuste (por grupos de pisos, cada uno con sus mallas), el remate y su física. */
  private shaft(): void {
    const f = this.f;
    const S = f.shaft;
    const site = this.kit.site(S.center[0], S.center[1]);
    const group = new THREE.Group();
    group.name = `${this.id}-fuste`;
    const stone: Batch[] = [];
    const glass: Map<string, Batch>[] = [];
    const detail = this.batch();
    buildShaft(S, {
      base: this.base,
      terrain: (x, z) => this.kit.terrain(x, z),
      bury: f.ground.bury,
      step: f.ground.step,
      stone: (k) => (stone[k] ??= this.batch()),
      glass: (k, finish) => {
        const byFinish = (glass[k] ??= new Map());
        let b = byFinish.get(finish);
        if (!b) {
          b = this.batch();
          byFinish.set(finish, b);
        }
        return b;
      },
      detail,
      seed: seedOf(this.id),
    });
    stone.forEach((b, k) => this.mesh(b, this.kit.materials.stone, `${group.name}-${k}`, true, group));
    glass.forEach((byFinish, k) => {
      for (const [finish, b] of byFinish) this.mesh(b, this.material(finish), `${group.name}-${k}-vidrio-${finish}`, true, group);
    });
    const spots = this.mesh(detail, this.kit.materials.stone, `${group.name}-focos`, false, group);
    if (spots) site.near(spots, f.detail.near);

    const crown = new THREE.Group();
    crown.name = `${this.id}-corona`;
    const cStone = this.batch();
    const cDetail = this.batch();
    const cGlass = new Map<string, Batch>();
    buildCrown(S, f.crown, {
      base: this.base,
      stone: cStone,
      glass: (finish) => {
        let b = cGlass.get(finish);
        if (!b) {
          b = this.batch();
          cGlass.set(finish, b);
        }
        return b;
      },
      detail: cDetail,
    });
    this.mesh(cStone, this.kit.materials.stone, `${crown.name}-anillo`, true, crown);
    for (const [finish, b] of cGlass) {
      const m = this.mesh(b, this.material(finish), `${crown.name}-baranda-${finish}`, false, crown);
      if (m) site.near(m, f.detail.crown);
    }
    const machines = this.mesh(cDetail, this.kit.materials.stone, `${crown.name}-maquinas`, true, crown);
    if (machines) site.near(machines, f.detail.crown);
    shaftPhysics(S, f.crown, site, this.base, f.ground.bury, f.ground.wall);
    this.kit.root.add(group, crown);
  }

  /** La calle a los pies de la torre: terraza, escaleras y rampas, marquesinas, jardineras, bordillos, pisos, palmeras y letreros. */
  private street(): void {
    const f = this.f;
    const T = f.street;
    const [cx, cz] = centerOf([...T.platforms.map((p) => p.ring), ...T.canopies.map((c) => c.ring), ...T.paved.map((p) => p.ring)]);
    const site = this.kit.site(cx, cz);
    const group = new THREE.Group();
    group.name = `${this.id}-calle`;
    const stone = this.batch();
    const detail = this.batch();
    const rails = this.batch();
    const kit: BaseKit = {
      base: this.base,
      terrain: (x, z) => this.kit.terrain(x, z),
      step: f.ground.step,
      bury: f.ground.bury,
      wall: f.ground.wall,
      stone,
      detail,
      rails,
      site,
      palm: (x, z, y, height) => this.kit.palm(x, z, y, height),
      signRect: (s) => this.kit.signRect(s),
      signOffset: this.kit.signOffset,
    };
    for (const p of T.paved) buildPaved(p, kit);
    for (const p of T.platforms) buildPlatform(p, kit);
    for (const fl of T.flights) buildFlight(fl, kit);
    for (const c of T.canopies) buildCanopy(c, kit);
    for (const b of T.beds) buildBed(b, kit);
    for (const c of T.curbs) buildCurb(c, kit);
    for (const s of T.signs) buildSign(s, kit);
    for (const [x, z, height] of T.palms) this.kit.palm(x, z, this.kit.terrain(x, z), height);
    this.mesh(stone, this.kit.materials.stone, `${group.name}-piedra`, true, group);
    const near = this.mesh(detail, this.kit.materials.stone, `${group.name}-detalle`, false, group);
    if (near) site.near(near, f.detail.near);
    const calado = this.mesh(rails, this.material(T.rails), `${group.name}-barandas`, false, group);
    if (calado) site.near(calado, f.detail.near);
    this.kit.root.add(group);
  }

  /** Estilo de un cuerpo: el base, el estilo con nombre y sus retoques. */
  private style(name: string, set?: Record<string, unknown>): DowntownStyle {
    const B = this.f.bodies;
    return deepMerge(deepMerge(B.defaults, B.styles[name]), set);
  }

  /** Un cuerpo de al lado (con las fachadas de las calles), en su propio pedazo de física y LOD. */
  private body(b: TowerBody): void {
    const f = this.f;
    const [cx, cz] = centerOf([b.ring]);
    const site: PlaceSite = this.kit.site(cx, cz);
    const stone = this.batch();
    const glass = this.batch();
    const detail = this.batch();
    const rails = this.batch();
    const kit: DowntownKit = {
      terrain: (x, z) => this.kit.terrain(x, z),
      stone,
      glass,
      detail,
      rails,
      lights: f.bodies.lights,
      signs: f.bodies.signs.map((c) => new THREE.Color(c)),
      groundStep: f.ground.step,
      lift: f.ground.lift,
      bury: f.ground.bury,
      block: (outline, y0, top) => site.block(outline, y0, top),
      box: (x, z, halfU, halfV, angle, top, floor, bottom) => site.box(x, z, halfU, halfV, angle, top, floor, bottom),
      signRect: (s) => this.kit.signRect(s),
      signOffset: this.kit.signOffset,
    };
    const podium = new DowntownBuilder(b, this.style(b.style, b.set), kit);
    const { top } = podium.build();
    const t = b.tower;
    if (t) {
      // Otro cuerpo encima (sin planta baja), con el estilo del de abajo retocado, como en las calles.
      const ring = t.ring ?? podium.towerRing(t.inset);
      const upper: DowntownBuilding = { id: `${b.id}-arriba`, ring, fronts: t.fronts ?? ring.map((_, i) => i), floors: t.floors, style: t.style ?? b.style };
      const style = deepMerge(deepMerge(this.style(upper.style, t.style ? undefined : b.set), t.set), { ground: 0 });
      new DowntownBuilder(upper, style, kit, top).build();
    }
    const group = new THREE.Group();
    group.name = `${this.id}-${b.id}`;
    this.mesh(stone, this.kit.materials.stone, `${group.name}-piedra`, true, group);
    this.mesh(glass, this.material(b.glass), `${group.name}-vidrio`, false, group);
    const near = this.mesh(detail, this.kit.materials.stone, `${group.name}-detalle`, false, group);
    if (near) site.near(near, f.detail.near);
    const calado = this.mesh(rails, this.material(f.street.rails), `${group.name}-barandas`, false, group);
    if (calado) site.near(calado, f.detail.near);
    this.kit.root.add(group);
  }
}

export const TOWER: PlaceType<TowerFile> = {
  check,
  signs,
  lights,
  clear: (f) => f.clear,
  build: (f, kit) => new TowerBuilder(f, kit).build(),
};
