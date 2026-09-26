import * as THREE from 'three';
import {
  type FarGlow,
  type HouseModel,
  type HouseParts,
  type HouseShape,
  buildHouse,
  checkModel,
  checkParts,
  faldonMatrix,
  faldonPiece,
  farPieces,
  housePhysics,
  houseVariant,
  mirroredIndex,
  moveFaldon,
  obraPiece,
  paintHouse,
  placeBoxes,
  positive,
  roleColors,
} from './house';
import type { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';
import { Batch } from './monumentParts';
import type { PlaceKit, PlaceSite } from './placeKit';

/**
 * Casas repetidas de una urbanización, instanciadas: cada modelo (world/house.ts) se arma una vez,
 * cada esquema de colores lo pinta y la otra mano comparte sus búferes con otro índice. Van por
 * celdas (una malla por modelo, esquema y mano en cada una, con su LOD; a media distancia, sin lo
 * fino; su física, en celdas más chicas) y, más allá del detalle, en cuatro mallas de lejos para
 * todas (muros de las construidas y de las en obra, hastiales y aguas) que esconden las casas de
 * las celdas que se ven de cerca. En la sombra, las de cerca proyectan en la cascada cercana y las
 * piezas de lejos de todas las casas en la lejana.
 */

/** Un esquema de colores: el de una etapa de la urbanización. */
export interface HouseScheme {
  /** Qué pinta (la etapa). */
  name: string;
  /** Color (hex) de los papeles para todos sus modelos, encima del de cada modelo. */
  colors: Record<string, string>;
  /** Los que cambian por modelo (modelo → papel → hex): el acento verde de uno, el amarillo de otro. */
  overrides: Record<string, Record<string, string>>;
  /** Papeles que llevan el color de las paredes de cada lote (`palette`). */
  painted: string[];
  /** Colores de las paredes: cada lote lleva el índice de uno; con el peso con que se repartieron, su nombre y su fuente. */
  palette: { color: string; weight: number; name: string; source: string }[];
  source: string;
}

/** Un lote (lo escribe el script de la urbanización desde las fuentes de config/houses/<conjunto>/). */
export interface HouseLot {
  /** El id del lote en la fuente (su registro dice de dónde salió). */
  id: string;
  model: string;
  scheme: string;
  /** Pie del medio de la fachada más adelantada (marco local del lugar, m). */
  x: number;
  z: number;
  /** Hacia dónde mira la fachada (grados, atan2(z, x) local). */
  facing: number;
  /** La otra mano (espejada) de la que describe el modelo. */
  mirror: boolean;
  /** 'built' construida o 'building' en obra (bloque sin enlucir y sin techo). Los lotes vacíos no van. */
  state: 'built' | 'building';
  /** Construida: el color de las paredes (índice en la paleta de su esquema) y el de la cara de arriba del techo (hex). */
  wall?: number;
  roof?: string;
}

/** Un conjunto de casas repetidas (config/houses/<archivo>.json). */
export interface HouseSet {
  name: string;
  /** De dónde salió cada dato (planos, fotos, satélite), con su fecha. */
  sources: string[];
  /** De dónde sale cada lote (el `id` es el de esa fuente). */
  lotSource: string;
  /** Lado de las celdas (m): cada una es un pedazo con su LOD (y sus mallas). */
  cell: number;
  /**
   * Lado de las celdas de la física (m), más chicas que las del LOD: una consulta de la física
   * recorre las piezas de los pedazos cuyo círculo contiene el punto, así ve unas decenas y no
   * cientos.
   */
  physicsCell: number;
  /**
   * LOD: hasta `near` (m, del centro de cada celda) se ven las casas con todo su detalle; más allá,
   * las de lejos. `mid` (m, de la cámara al punto más cercano de la celda): más allá, las de cerca
   * se dibujan sin lo fino (cantos de molduras, onda del borde del techo, tubos, barandas,
   * ménsulas), que desde ahí mide menos de un pixel. `shadows`: si las casas proyectan sombra (las
   * de cerca en la cascada cercana, donde se distingue su detalle; en la lejana, cuyo texel es más
   * grande que ese detalle, todas con sus piezas de lejos).
   */
  detail: { near: number; mid: number; shadows: boolean };
  /** Dónde se mide el suelo de cada casa: fracciones del ancho (−0,5 a 0,5) y del fondo (0 a 1); se asienta en la mediana. */
  ground: number[][];
  /** Si cada casa lleva, además de su macizo, las cajas de su cierre, su pilar y sus tejadillos. */
  physics: { boxes: boolean };
  parts: HouseParts;
  /** Colores fijos de lo que comparten todas las casas: el cielo y la fascia del techo instanciado y el bloque de las casas en obra. */
  shared: { soffit: string; fascia: string; obra: string };
  models: Record<string, HouseModel>;
  schemes: Record<string, HouseScheme>;
  lots: HouseLot[];
}

const FILES = import.meta.glob('../../config/houses/*.json', { eager: true, import: 'default' });

/** El archivo de config/houses/ de un conjunto de casas (por nombre, sin extensión). */
export function houseSet(name: string): HouseSet {
  const key = Object.keys(FILES).find((k) => k.endsWith(`/${name}.json`));
  if (!key) throw new Error(`No existe config/houses/${name}.json`);
  return FILES[key] as HouseSet;
}

/** Revisa el conjunto antes de armarlo (los JSON no se revisan al compilar). */
function checkSet(set: HouseSet, where: string): void {
  positive(where, 'cell', set.cell);
  positive(where, 'physicsCell', set.physicsCell);
  positive(where, 'detail.near', set.detail?.near);
  positive(where, 'detail.mid', set.detail?.mid);
  if (typeof set.detail.shadows !== 'boolean') throw new Error(`${where}: detail.shadows es true o false`);
  if (!set.ground?.length || set.ground.some((p) => p.length !== 2)) throw new Error(`${where}: "ground" son pares [fracción del ancho, fracción del fondo]`);
  checkParts(set.parts, where);
  for (const k of ['soffit', 'fascia', 'obra'] as const) if (typeof set.shared?.[k] !== 'string') throw new Error(`${where}: falta shared.${k}`);
  for (const [name, m] of Object.entries(set.models)) checkModel(m, set.parts, `${where} → models.${name}`);
  for (const [name, s] of Object.entries(set.schemes)) {
    if (!s.palette?.length) throw new Error(`${where} → schemes.${name}: la paleta está vacía`);
    if (!Array.isArray(s.painted)) throw new Error(`${where} → schemes.${name}: falta "painted"`);
  }
  for (const l of set.lots) {
    if (!set.models[l.model]) throw new Error(`${where}: el lote ${l.id} usa el modelo "${l.model}", que no está`);
    const s = set.schemes[l.scheme];
    if (!s) throw new Error(`${where}: el lote ${l.id} usa el esquema "${l.scheme}", que no está`);
    if (l.state !== 'built' && l.state !== 'building') throw new Error(`${where}: el lote ${l.id} tiene el estado "${String(l.state)}" (built o building)`);
    if (l.state === 'built' && (l.wall === undefined || !s.palette[l.wall] || typeof l.roof !== 'string')) throw new Error(`${where}: al lote ${l.id} le falta el color de las paredes (índice de la paleta) o el del techo`);
  }
}

/** Una casa ya ubicada. */
interface Placed {
  lot: HouseLot;
  shape: HouseShape;
  /** Marco de la geometría → marco del lugar (con la base en el suelo y el espejo de la otra mano). */
  m: THREE.Matrix4;
  /**
   * El mismo sin el espejo: para las piezas de lejos, que son simétricas en X (espejadas quedarían
   * con las caras al revés, porque three no da vuelta las caras por instancia).
   */
  at: THREE.Matrix4;
  cell: number;
}

/** Cambia la visibilidad de un objeto avisando cuando cambia (el LOD de Monuments la escribe en cada cuadro). */
function watchVisible(o: THREE.Object3D, onChange: (visible: boolean) => void): void {
  let v = o.visible;
  Object.defineProperty(o, 'visible', {
    get: () => v,
    set: (next: boolean) => {
      if (next === v) return;
      v = next;
      onChange(v);
    },
    configurable: true,
  });
}

/**
 * Las cámaras de las cascadas lejanas de la sombra del sol (SunLightShadow, la de
 * render/cityShadow.ts: la 0 es la cercana), por escena. Los lugares no reciben la sombra de la
 * ciudad: se buscan una vez en la escena de la malla, entre sus luces.
 */
const farCameras = new WeakMap<THREE.Object3D, Set<THREE.Camera>>();

/** ¿`camera` dibuja una cascada lejana de la sombra del sol en la escena de `object`? */
function farCascade(object: THREE.Object3D, camera: THREE.Camera): boolean {
  let scene = object;
  while (scene.parent) scene = scene.parent;
  let far = farCameras.get(scene);
  if (!far) {
    const found = new Set<THREE.Camera>();
    scene.traverse((o) => {
      const shadow = (o as THREE.DirectionalLight).shadow as (THREE.LightShadow & Partial<Pick<SunLightShadow, 'isSunLightShadow' | 'getCamera'>>) | undefined;
      if (shadow?.isSunLightShadow && shadow.getCamera) for (let k = 1; k < shadow.getViewportCount(); k++) found.add(shadow.getCamera(k));
    });
    far = found;
    farCameras.set(scene, far);
  }
  return far.has(camera);
}

const _eye = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/**
 * Las mallas de cerca de una celda: con todo su detalle, o sin lo fino si la cámara está a más de
 * `mid` m del punto más cercano de la celda (`box`, marco del lugar). Proyectan sombra solo en la
 * cascada cercana; en la lejana la dan las piezas de lejos de todas las casas (`farShadow`).
 */
function nearMesh(mesh: THREE.InstancedMesh, box: THREE.Box3, lod: { coarse: number; mid: number } | null): void {
  const full = (): void => {
    mesh.geometry.drawRange.count = Infinity;
  };
  const range = (camera: THREE.Camera): void => {
    if (!lod) return;
    _eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse.copy(mesh.matrixWorld).invert());
    mesh.geometry.drawRange.count = box.distanceToPoint(_eye) > lod.mid ? lod.coarse : Infinity;
  };
  if (lod) {
    mesh.onBeforeRender = (_renderer, _scene, camera) => range(camera);
    mesh.onAfterRender = full;
  }
  let saved = -1;
  mesh.onBeforeShadow = (_renderer, _object, camera, shadowCamera) => {
    if (!farCascade(mesh, shadowCamera)) {
      range(camera);
      return;
    }
    saved = mesh.count;
    mesh.count = 0;
  };
  mesh.onAfterShadow = () => {
    if (lod) full();
    if (saved < 0) return;
    mesh.count = saved;
    saved = -1;
  };
}

/**
 * Una malla de lejos para todas las casas, ordenada por celda: cuando una celda se ve de cerca,
 * sus instancias se achican a nada (y vuelven cuando se aleja), sin rearmar ni recalcular nada.
 */
class FarLayer {
  readonly mesh: THREE.InstancedMesh;
  /** Las matrices de todas las casas, sin achicar. */
  readonly full: Float32Array;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: THREE.Matrix4[],
    colors: THREE.Color[],
    private readonly ranges: number[][],
    name: string,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, k) => {
      this.mesh.setMatrixAt(k, m);
      this.mesh.setColorAt(k, colors[k]);
    });
    this.full = Float32Array.from(this.mesh.instanceMatrix.array);
    this.mesh.computeBoundingSphere();
    this.mesh.name = name;
    // La sombra de estas piezas la da `farShadow` (en la vista faltan las celdas que se ven de cerca).
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  /** Muestra (o esconde) las instancias de una celda. */
  show(cell: number, on: boolean): void {
    const [start, count] = this.ranges[cell];
    if (!count) return;
    const a = this.mesh.instanceMatrix.array as Float32Array;
    for (let k = start; k < start + count; k++) {
      // Escondida: la misma posición con escala cero (sus triángulos no ocupan nada).
      for (let e = 0; e < 12; e++) a[k * 16 + e] = on ? this.full[k * 16 + e] : 0;
    }
    this.mesh.instanceMatrix.addUpdateRange(start * 16, count * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * La sombra de una capa de lejos en la cascada lejana: todas sus casas (también las de las celdas
 * que se ven de cerca), con las piezas de lejos, que en esa cascada (texel de medio metro o más) no
 * se distinguen del detalle. No se dibuja en la vista ni en la cascada cercana. Comparte con la capa
 * su geometría, su material y sus colores (así usa el mismo programa).
 */
function farShadow(layer: FarLayer, name: string): THREE.InstancedMesh {
  const src = layer.mesh;
  // Sus matrices son las de la capa sin achicar (el mismo arreglo; en la GPU, su propio búfer).
  const mesh = new THREE.InstancedMesh(src.geometry, src.material, 0);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(layer.full, 16);
  mesh.count = src.count;
  mesh.instanceColor = src.instanceColor;
  mesh.boundingSphere = src.boundingSphere;
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  let saved = -1;
  const hide = (): void => {
    saved = mesh.count;
    mesh.count = 0;
  };
  const back = (): void => {
    if (saved < 0) return;
    mesh.count = saved;
    saved = -1;
  };
  mesh.onBeforeRender = hide;
  mesh.onAfterRender = back;
  mesh.onBeforeShadow = (_renderer, _object, _camera, shadowCamera) => {
    if (!farCascade(mesh, shadowCamera)) hide();
  };
  mesh.onAfterShadow = back;
  return mesh;
}

/** Arma las casas de un conjunto en el lugar del kit (marco local del lugar). */
export function buildHouses(set: HouseSet, kit: PlaceKit): void {
  const where = `config/houses (${set.name})`;
  checkSet(set, where);
  const id = kit.root.name;
  const P = set.parts;
  const standing = set.lots;
  if (!standing.length) return;

  // Cada modelo se arma una vez (sin color: cada esquema lo pinta).
  const shapes = new Map<string, HouseShape>();
  for (const name of new Set(standing.map((l) => l.model))) {
    shapes.set(name, buildHouse(set.models[name], P, false, { intensity: kit.flood, base: 0 }, `${where} → models.${name}`));
  }
  const mirrors = new Map<string, THREE.BufferAttribute>();
  const variants = new Map<string, THREE.BufferGeometry[]>();
  /** La geometría de cerca de un lote: su modelo con los colores de su esquema, en su mano. */
  const variant = (l: HouseLot): THREE.BufferGeometry => {
    const key = `${l.model}/${l.scheme}`;
    let v = variants.get(key);
    if (!v) {
      const shape = shapes.get(l.model)!;
      const s = set.schemes[l.scheme];
      const colors = roleColors(set.models[l.model], s.colors, s.overrides[l.model]);
      const paint = paintHouse(shape.body, shape.roles, shape.role, shape.shade, colors, new Set(s.painted));
      let mirror = mirrors.get(l.model);
      if (!mirror) {
        mirror = mirroredIndex(shape.body);
        mirrors.set(l.model, mirror);
      }
      v = [houseVariant(shape.body, paint, null), houseVariant(shape.body, paint, mirror)];
      variants.set(key, v);
    }
    return v[l.mirror ? 1 : 0];
  };

  // Piezas instanciadas comunes: el faldón unitario, la caja de la obra y las de lejos.
  const soffit = new THREE.Color(set.shared.soffit);
  const fascia = new THREE.Color(set.shared.fascia);
  const roofBatch = new Batch();
  roofBatch.flood[0] = kit.flood;
  faldonPiece(roofBatch, new THREE.Matrix4(), P, { top: new THREE.Color(1, 1, 1), paint: 1, soffit, fascia });
  const roofPiece = roofBatch.build();
  const obraBox = obraPiece(P, kit.flood);
  // De noche, la caja de lejos lleva la luz de las ventanas y apliques de cerca repartida en cada
  // cara: el promedio de las casas construidas (la otra mano cambia los costados: van juntos).
  const glow: FarGlow = { front: new THREE.Color(0, 0, 0), back: new THREE.Color(0, 0, 0), sides: new THREE.Color(0, 0, 0) };
  const built = standing.filter((l) => l.state === 'built');
  for (const l of built) {
    const g = shapes.get(l.model)!.glow;
    glow.front.add(g.front);
    glow.back.add(g.back);
    glow.sides.add(g.left).add(g.right);
  }
  if (built.length) {
    glow.front.multiplyScalar(1 / built.length);
    glow.back.multiplyScalar(1 / built.length);
    glow.sides.multiplyScalar(1 / (2 * built.length));
  }
  const far = farPieces(kit.flood, { soffit }, glow);
  const obraColor = new THREE.Color(set.shared.obra);

  // Cada lote en su lugar: asentado en la mediana del suelo de su planta.
  const cells = new Map<string, number>();
  const cellKeys: string[] = [];
  const placed: Placed[] = [];
  const probe = new THREE.Vector3();
  const flip = new THREE.Matrix4();
  for (const l of standing) {
    const shape = shapes.get(l.model)!;
    const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2 - THREE.MathUtils.degToRad(l.facing));
    const hs = set.ground
      .map(([fx, fz]) => {
        probe.set(fx * shape.width, 0, -fz * shape.depth).applyMatrix4(rot);
        return kit.terrain(l.x + probe.x, l.z + probe.z);
      })
      .sort((a, b) => a - b);
    const base = hs[Math.floor(hs.length / 2)];
    const at = new THREE.Matrix4().makeTranslation(l.x, base, l.z).multiply(rot);
    const m = at.clone().multiply(flip.makeScale(l.mirror ? -1 : 1, 1, 1));
    // La celda en el nombre de sus mallas, sin guiones (un −1 sale «m1») para no partir `<id>-<parte>`.
    const tag = (k: number): string => (k < 0 ? `m${-k}` : `${k}`);
    const key = `${tag(Math.floor(l.x / set.cell))}_${tag(Math.floor(l.z / set.cell))}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = cellKeys.length;
      cells.set(key, cell);
      cellKeys.push(key);
    }
    placed.push({ lot: l, shape, m, at, cell });
  }
  placed.sort((a, b) => a.cell - b.cell);

  // Las mallas de lejos (todas las casas, por celda: los muros de las construidas, los de las que
  // están en obra, los hastiales y las aguas) y lo que se escribe en cada una.
  const farLists = [0, 1, 2, 3].map(() => ({ matrices: [] as THREE.Matrix4[], colors: [] as THREE.Color[] }));
  const [farWalls, farBare, farGables, farRoofs] = farLists;
  const ranges = farLists.map(() => cellKeys.map(() => [0, 0]));
  const quarter = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const local = new THREE.Matrix4();
  const scale = new THREE.Matrix4();

  const byCell: Placed[][] = cellKeys.map(() => []);
  for (const h of placed) byCell[h.cell].push(h);
  // La física de cada casa va al pedazo de su celda de física (con centro en el de la celda).
  const physics = new Map<string, PlaceSite>();
  const physicsOf = (l: HouseLot): PlaceSite => {
    const i = Math.floor(l.x / set.physicsCell);
    const j = Math.floor(l.z / set.physicsCell);
    const key = `${i}_${j}`;
    let site = physics.get(key);
    if (!site) {
      site = kit.site((i + 0.5) * set.physicsCell, (j + 0.5) * set.physicsCell);
      physics.set(key, site);
    }
    return site;
  };
  const faldon = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  byCell.forEach((list, cell) => {
    farLists.forEach((f, k) => (ranges[k][cell][0] = f.matrices.length));
    const cx = list.reduce((s, h) => s + h.lot.x, 0) / list.length;
    const cz = list.reduce((s, h) => s + h.lot.z, 0) / list.length;
    const site = kit.site(cx, cz);
    const group = new THREE.Group();
    group.name = `${id}-casas-${cellKeys[cell]}`;
    // Lo que ocupa la celda (marco del lugar): de ahí se mide la distancia de la cámara a su punto más cercano.
    const bounds = new THREE.Box3();
    // Cerca: una malla por modelo, esquema y mano.
    const bodies = new Map<THREE.BufferGeometry, Placed[]>();
    const roofs: { m: THREE.Matrix4; color: THREE.Color }[] = [];
    const obra: THREE.Matrix4[] = [];
    for (const h of list) {
      const l = h.lot;
      const S = h.shape;
      const F = S.far;
      for (const p of S.outline) bounds.expandByPoint(corner.set(p.x, 0, p.y).applyMatrix4(h.m));
      bounds.expandByPoint(corner.set(l.x, h.m.elements[13] + S.top, l.z));
      if (l.state === 'built') {
        const s = set.schemes[l.scheme];
        const wall = new THREE.Color(s.palette[l.wall!].color);
        const roof = new THREE.Color(l.roof!);
        // Lejos: los muros hasta el alero, los hastiales y las aguas.
        farWalls.matrices.push(h.at.clone().multiply(local.makeTranslation(0, 0, -S.depth / 2)).multiply(scale.makeScale(S.width, F.walls, S.depth)));
        farWalls.colors.push(wall);
        if (F.ridge > F.walls) {
          const turn = F.axis === 'z';
          const gable = local.makeTranslation(0, F.walls, -S.depth / 2);
          if (turn) gable.multiply(quarter);
          farGables.matrices.push(h.at.clone().multiply(gable).multiply(scale.makeScale(turn ? S.depth : S.width, F.ridge - F.walls, turn ? S.width : S.depth)));
          farGables.colors.push(wall);
          const R = S.roofSpan;
          const spanX = 2 * R.half;
          const spanZ = R.front + R.back;
          const top = local.makeTranslation(0, F.eave, (R.front - R.back) / 2);
          if (turn) top.multiply(quarter);
          // La pieza corre su cumbrera en su x: girada, la x de la pieza va a lo largo de Z.
          farRoofs.matrices.push(h.at.clone().multiply(top).multiply(scale.makeScale(turn ? spanZ : spanX, F.ridge - F.eave, turn ? spanX : spanZ)));
          farRoofs.colors.push(roof);
        }
        let same = bodies.get(variant(l));
        if (!same) bodies.set(variant(l), (same = []));
        same.push(h);
        for (const f of S.roof) roofs.push({ m: faldonMatrix(moveFaldon(f, h.m), faldon).clone(), color: roof });
        housePhysics(physicsOf(l), S, h.m, set.physics.boxes);
      } else {
        // En obra: los muros de bloque (lejos, una caja hasta donde llegan) y su física tramo por tramo.
        farBare.matrices.push(h.at.clone().multiply(local.makeTranslation(0, 0, -S.depth / 2)).multiply(scale.makeScale(S.width, S.obraTop, S.depth)));
        farBare.colors.push(obraColor);
        for (const b of S.obra) {
          const c = b.center.clone().applyMatrix4(h.m);
          const d = b.dir.clone().transformDirection(h.m);
          const n = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
          obra.push(new THREE.Matrix4().makeBasis(d.multiplyScalar(b.length), new THREE.Vector3(0, b.height, 0), n.multiplyScalar(b.thickness)).setPosition(c));
        }
        placeBoxes(physicsOf(l), S.obraWalls, h.m);
      }
    }
    for (const [geometry, houses] of bodies) {
      const l = houses[0].lot;
      const mesh = new THREE.InstancedMesh(geometry, kit.materials.paint, houses.length);
      houses.forEach((h, k) => {
        mesh.setMatrixAt(k, h.m);
        mesh.setColorAt(k, new THREE.Color(set.schemes[h.lot.scheme].palette[h.lot.wall!].color));
      });
      mesh.computeBoundingSphere();
      mesh.name = `${group.name}-${l.model}-${l.scheme}${l.mirror ? '-espejo' : ''}`;
      mesh.castShadow = set.detail.shadows;
      mesh.receiveShadow = true;
      nearMesh(mesh, bounds, { coarse: houses[0].shape.coarse, mid: set.detail.mid });
      group.add(mesh);
    }
    const instanced = (geometry: THREE.BufferGeometry, items: { m: THREE.Matrix4; color: THREE.Color }[], name: string): void => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(geometry, kit.materials.paint, items.length);
      items.forEach((it, k) => {
        mesh.setMatrixAt(k, it.m);
        mesh.setColorAt(k, it.color);
      });
      mesh.computeBoundingSphere();
      mesh.name = `${group.name}-${name}`;
      mesh.castShadow = set.detail.shadows;
      mesh.receiveShadow = true;
      nearMesh(mesh, bounds, null);
      group.add(mesh);
    };
    instanced(roofPiece, roofs, 'techos');
    instanced(
      obraBox,
      obra.map((m) => ({ m, color: obraColor })),
      'obra',
    );
    farLists.forEach((f, k) => (ranges[k][cell][1] = f.matrices.length - ranges[k][cell][0]));
    // De cerca apagada hasta que el LOD diga; al cambiar, esconde o muestra sus casas de lejos.
    group.visible = false;
    watchVisible(group, (near) => {
      for (const layer of layers) layer.show(cell, !near);
    });
    site.near(group, set.detail.near);
    kit.root.add(group);
  });

  const pieces = [far.walls, far.bare, far.gables, far.roof];
  const names = ['muros', 'obra', 'hastiales', 'techos'];
  const layers = farLists.map((f, k) => new FarLayer(pieces[k], kit.materials.paint, f.matrices, f.colors, ranges[k], `${id}-casas-lejos-${names[k]}`));
  for (const [k, layer] of layers.entries()) {
    if (!layer.mesh.count) continue;
    kit.root.add(layer.mesh);
    if (set.detail.shadows) kit.root.add(farShadow(layer, `${id}-casas-lejos-${names[k]}-sombra`));
  }
}
