import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import { ROAD_SURFACE_PARS, roadSurfaceUniforms } from '../render/materials';
import { withNightLight } from '../render/nightLight';
import type { Heightmap } from './heightmap';
import type { LampData } from './streetLamps';

type BridgeConfig = GameConfig['bridges'];
type LightsConfig = GameConfig['render']['lighting']['streetLights'];
/**
 * Bordes que sabe dibujar: barrera de concreto (vehiculares), bordillo con baranda metálica, o
 * nada (el lado de tierra de un muelle: el tablero sigue a ras del paseo).
 */
const STYLES = ['barrier', 'railing', 'none'] as const;
type Style = (typeof STYLES)[number];

/** Parte de cada punto del eje (contrato con pipeline/build_world.py → step_bridges). */
const PART = { span: 0, ramp: 1, stairs: 2 } as const;

/** Un puente de public/world/bridges.json. */
interface BridgeRecord {
  /** Tipo (config/region.json → bridges.kinds): define barandas, pilas y pendientes. */
  kind: string;
  name: string;
  /** Ancho de la calzada o del paso (m), sin los bordes. */
  width: number;
  /** Borde a cada lado (vereda o bordillo, m). */
  margin: number;
  /** Espesor del tablero (m). */
  deck: number;
  lanes: number;
  oneway: boolean;
  /** Material de la calzada (config/game.json → roads.materials). */
  surface: string;
  covered: boolean;
  /** Colgado de otro tablero (ciclovía o vereda de un puente): sin pilas propias. */
  attached: boolean;
  /** Eje: x, z, y (superficie del tablero) por punto. */
  pts: number[];
  /** Parte de cada punto (PART). */
  part: number[];
  /**
   * Borde de cada lado, [izquierda, derecha] según el sentido del eje (STYLES); sin él, el del
   * tipo en los dos. Los muelles llevan baranda solo del lado del agua.
   */
  edges?: string[];
}

interface BridgesFile {
  bridges: BridgeRecord[];
  /** Postes sobre los tableros: x, z, y (tablero), alto de la luz, brazo (rad), banderas (las de lamps.bin). */
  lamps: number[][];
  /** Palmeras de los muelles: x, z, y (tablero), alto y semilla (ver world/palms.ts). */
  palms?: number[][];
}

/** Postes sobre los tableros, para el alumbrado (ver world/streetLamps.ts). */
export interface DeckLamps {
  count: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  h: Float32Array;
  arm: Float32Array;
  flags: Uint8Array;
  /** 1 = tablero a ras del suelo (muelle): el poste alumbra también el suelo, como uno de la calle. */
  ground: Uint8Array;
}

/** Lo que `deckAt` deja además de la altura: el material de la calzada (agarre del carro). */
export interface DeckHit {
  y: number;
  surface: string;
}

/** Eje remuestreado de un puente: posición, dirección y pendiente por fila. */
interface Rows {
  n: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  s: Float64Array;
  /** Dirección horizontal (unitaria). */
  tx: Float64Array;
  tz: Float64Array;
  /** Factor de inglete: en las curvas el ancho se mantiene. */
  miter: Float64Array;
  slope: Float64Array;
  /** Parte del tramo que empieza en cada fila. */
  part: Uint8Array;
}

/** Atributo `aDeck` de lo que no es calzada (concreto, pilas…): canal -1 = color por vértice. */
const NOT_DECK: readonly number[] = [0, 0, -1, 0];
/** Color por vértice de la calzada: la pinta el shader (ver createBridgeMaterial). */
const WHITE = new THREE.Color(1, 1, 1);

/** Vértices e índices de una malla en construcción (normales y color por vértice). */
class MeshData {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** Tablero: coordenadas en metros (a lo ancho desde el eje, a lo largo). Barandas: a lo largo y altura. */
  readonly uv: number[] = [];
  /** Tablero: medio ancho de calzada, código de carriles, canal del material y si tiene veredas. */
  readonly deck: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: THREE.Color,
    u = 0,
    v = 0,
    deck: readonly number[] = NOT_DECK,
  ): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    this.deck.push(deck[0], deck[1], deck[2], deck[3]);
    return this.count - 1;
  }

  /** Cuadrilátero a-b-c-d, con la cara hacia donde apuntan las normales de sus vértices. */
  quad(a: number, b: number, c: number, d: number): void {
    const p = this.pos;
    const n = this.nor;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    let dot = 0;
    for (const k of [a, b, c, d]) dot += fx * n[k * 3] + fy * n[k * 3 + 1] + fz * n[k * 3 + 2];
    if (dot >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  /** Une dos filas de vértices (misma cantidad) con cuadriláteros. */
  strip(prev: number[], row: number[]): void {
    for (let k = 0; k + 1 < row.length; k++) this.quad(prev[k], prev[k + 1], row[k + 1], row[k]);
  }

  geometry(kind: 'solid' | 'rail'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aSurfaceUv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (kind === 'solid') {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('aDeck', new THREE.Float32BufferAttribute(this.deck, 4));
    }
    // Luz de los postes sobre el tablero (ver `bakeNight`); en cero hasta que cargan los postes.
    g.setAttribute('aLamp', new THREE.Float32BufferAttribute(new Float32Array(this.count * 3), 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Mallas de una zona: todo el concreto y la calzada en una, las barandas (con transparencia) en otra. */
interface Group {
  solid: MeshData;
  rail: MeshData;
}

/** Tramo del índice de física: eje de a a b con su altura, medio ancho, puente y parte. */
interface Segment {
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  half: number;
  bridge: number;
  part: number;
}

/** Columna de una pila: centro, radio, alto (fondo del tablero), pie y dirección del puente. */
interface Pier {
  x: number;
  z: number;
  r: number;
  top: number;
  base: number;
  dx: number;
  dz: number;
}

/** Vértices del tablero/barandas: declaraciones y paso de atributos al fragment shader. */
const LAMP_VERTEX_PARS = /* glsl */ `
attribute vec3 aLamp;
varying vec3 vLamp;`;
const LAMP_FRAGMENT_PARS = /* glsl */ `
varying vec3 vLamp;`;
/** Luz de los postes del tablero (irradiancia precalculada por vértice), solo de noche. */
const LAMP_APPLY = /* glsl */ `
reflectedLight.directDiffuse += vLamp * uLightsOn * BRDF_Lambert( material.diffuseContribution );`;

/**
 * Luz de los postes del tablero, encadenada antes de `withNightLight` (que declara
 * `uLightsOn` y suma la de los mapas del suelo y los faros).
 */
function addLampLight(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${LAMP_VERTEX_PARS}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLamp = aLamp;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${LAMP_FRAGMENT_PARS}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LAMP_APPLY}`);
}

/**
 * Concreto (color por vértice) y, en el tablero, la misma calzada que las calles del terreno
 * (color, grano y patrón de cada material, veredas con bordillo y las marcas de carril:
 * amarilla al centro en doble vía, blancas entre carriles y en los bordes), en coordenadas
 * del tablero. Un solo material para las dos cosas: una llamada de dibujo por zona.
 */
function createBridgeMaterial(roads: GameConfig['roads'], cfg: BridgeConfig): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: cfg.roughness });
  const uniforms = roadSurfaceUniforms(roads);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    addLampLight(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSurfaceUv;
attribute vec4 aDeck;
varying vec2 vDeckUv;
varying vec4 vDeck;
varying vec2 vDeckWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vDeckUv = aSurfaceUv;
vDeck = aDeck;
vDeckWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vDeckUv;
varying vec4 vDeck;
varying vec2 vDeckWorld;
${ROAD_SURFACE_PARS}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Calzada (canal >= 0); el resto es concreto con su color por vértice.
if (vDeck.z > -0.5) {
  float across = vDeckUv.x;
  float along = vDeckUv.y;
  vec2 fw = fwidth(vDeckUv);
  float aa = max(fw.x, fw.y) * 0.75 + GYE_ROAD_EPS;
  float halfC = vDeck.x;
  float code = vDeck.y;
  int k = int(vDeck.z + 0.5);
  vec3 surf = gyeRoadSurface(k, vDeckWorld, along, across, 1.0, 1.0, aa);
  // Marcas: el código trae los carriles (negativo = un solo sentido).
  float lanes = abs(code);
  float white = 0.0;
  float yellow = 0.0;
  if (lanes > 0.5 && abs(across) < halfC) {
    float laneW = 2.0 * halfC / lanes;
    float lh = uRoadMark.x * 0.5;
    float period = mod(along, uRoadMarkMisc.x);
    float dash = smoothstep(-aa, aa, period) * (1.0 - smoothstep(uRoadMark.z - aa, uRoadMark.z + aa, period));
    float ad = abs(across);
    if (code > 0.0) {
      bool wide = lanes >= uRoadMarkRules.x;
      yellow = wide ? gyeBand(ad - (uRoadMark.y * 0.5 + lh), lh, aa) : gyeBand(across, lh, aa) * dash;
      float j = floor(ad / laneW + 0.5);
      if (j > 0.5 && j < floor(lanes * 0.5) - 0.5) white = gyeBand(ad - j * laneW, lh, aa) * dash;
      if (lanes >= uRoadMarkRules.y) white = max(white, gyeBand(ad - (halfC - uRoadMark.w), lh, aa));
    } else {
      float j = floor((across + halfC) / laneW + 0.5);
      if (j > 0.5 && j < lanes - 0.5) white = gyeBand(across + halfC - j * laneW, lh, aa) * dash;
      if (lanes >= uRoadMarkRules.z) white = max(white, gyeBand(ad - (halfC - uRoadMark.w), lh, aa));
    }
    float wear = 1.0 - uRoadMarkMisc.w * gyeRoadNoise(vDeckWorld / uRoadMarkMisc2.x);
    float markable = uRoadMarkable[k];
    surf = mix(surf, uRoadWhite, clamp(white, 0.0, 1.0) * wear * markable);
    surf = mix(surf, uRoadYellow, clamp(yellow, 0.0, 1.0) * wear * markable);
  }
  // Veredas a los lados de la calzada, con baldosas y bordillo.
  float outside = abs(across) - halfC;
  if (vDeck.w > 0.5 && outside > 0.0) {
    float grain = mix(0.5, gyeRoadNoise(vDeckWorld / uRoadWalk2.y), gyeFine(uRoadWalk2.y, aa));
    vec3 walk = uRoadSidewalk * (1.0 + (grain - 0.5) * uRoadWalk2.x);
    float tiles = max(gyeJoint(along, uRoadWalk.y, uRoadWalk.z, aa), gyeJoint(outside - uRoadWalk.x, uRoadWalk.y, uRoadWalk.z, aa));
    walk *= 1.0 - uRoadWalk.w * tiles * gyeFine(uRoadWalk.y, aa);
    float curb = 1.0 - smoothstep(uRoadWalk.x - aa, uRoadWalk.x + aa, outside);
    surf = mix(walk, uRoadCurb, curb);
  }
  diffuseColor.rgb *= surf;
}`,
      );
  };
  material.customProgramCacheKey = () => 'gye-bridge-v2';
  withNightLight(material);
  return material;
}

/**
 * Baranda metálica de los pasos peatonales: una cinta con barrotes, pasamanos y postes
 * dibujados en el shader. La cobertura de cada píxel es el filtro de caja exacto del patrón
 * (alpha-to-coverage con el MSAA): de lejos los barrotes se funden en una trama, sin moiré.
 */
function createRailMaterial(cfg: BridgeConfig): THREE.MeshStandardMaterial {
  const r = cfg.railing;
  const material = new THREE.MeshStandardMaterial({
    color: cfg.colors.railing,
    roughness: r.roughness,
    metalness: r.metalness,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
  const uniforms = {
    uRail: { value: new THREE.Vector4(r.barSpacing, r.bar, r.postSpacing, r.post) },
    uRailRail: { value: new THREE.Vector2(r.height, r.rail) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    addLampLight(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSurfaceUv;\nvarying vec2 vRailUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRailUv = aSurfaceUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 uRail;
uniform vec2 uRailRail;
varying vec2 vRailUv;
// Cuánto de [0, x] cubren franjas de ancho w cada p (integral del patrón).
float gyeRailSum(float x, float p, float w) { return floor(x / p) * w + min(mod(x, p), w); }
// Cobertura de las franjas en un píxel de ancho fw alrededor de x (filtro de caja).
float gyeRailCover(float x, float p, float w, float fw) {
  return clamp((gyeRailSum(x + fw * 0.5, p, w) - gyeRailSum(x - fw * 0.5, p, w)) / fw, 0.0, 1.0);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 fw = max(fwidth(vRailUv), vec2(1e-4));
  float bars = gyeRailCover(vRailUv.x, uRail.x, uRail.y, fw.x);
  float posts = gyeRailCover(vRailUv.x, uRail.z, uRail.w, fw.x);
  // Pasamanos arriba y travesaño abajo: franjas en la altura.
  float h = vRailUv.y;
  float top = clamp((min(h + fw.y * 0.5, uRailRail.x) - max(h - fw.y * 0.5, uRailRail.x - uRailRail.y)) / fw.y, 0.0, 1.0);
  float low = clamp((min(h + fw.y * 0.5, uRailRail.y) - max(h - fw.y * 0.5, 0.0)) / fw.y, 0.0, 1.0);
  diffuseColor.a = max(max(bars, posts), max(top, low));
}`,
      );
  };
  material.customProgramCacheKey = () => 'gye-bridge-rail-v1';
  withNightLight(material);
  return material;
}

const segPart = (a: number, b: number): number =>
  a === b ? a : a === PART.stairs || b === PART.stairs ? PART.stairs : PART.ramp;

/** Eje remuestreado cada `step` m como máximo (la luz de los postes se guarda por vértice). */
function resample(b: BridgeRecord, step: number): Rows {
  const p = b.pts;
  const n0 = p.length / 3;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const parts: number[] = [];
  for (let i = 0; i + 1 < n0; i++) {
    const [x0, z0, y0, x1, z1, y1] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5]];
    const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    const part = segPart(b.part[i], b.part[i + 1]);
    for (let j = 0; j < m; j++) {
      const t = j / m;
      xs.push(x0 + (x1 - x0) * t);
      zs.push(z0 + (z1 - z0) * t);
      ys.push(y0 + (y1 - y0) * t);
      parts.push(part);
    }
  }
  xs.push(p[(n0 - 1) * 3]);
  zs.push(p[(n0 - 1) * 3 + 1]);
  ys.push(p[(n0 - 1) * 3 + 2]);
  parts.push(parts[parts.length - 1] ?? b.part[n0 - 1]);
  const n = xs.length;
  const rows: Rows = {
    n,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    z: Float64Array.from(zs),
    s: new Float64Array(n),
    tx: new Float64Array(n),
    tz: new Float64Array(n),
    miter: new Float64Array(n),
    slope: new Float64Array(n),
    part: Uint8Array.from(parts),
  };
  for (let i = 1; i < n; i++) rows.s[i] = rows.s[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0);
    const c = Math.min(i + 1, n - 1);
    let dx = xs[c] - xs[a];
    let dz = zs[c] - zs[a];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    rows.tx[i] = dx;
    rows.tz[i] = dz;
    const ds = rows.s[c] - rows.s[a];
    rows.slope[i] = ds > 1e-6 ? (ys[c] - ys[a]) / ds : 0;
    // Inglete: el tramo de llegada contra la dirección promedio (en una esquina de 90°, √2).
    const sx = xs[i] - xs[a] || xs[c] - xs[i];
    const sz = zs[i] - zs[a] || zs[c] - zs[i];
    const sl = Math.hypot(sx, sz) || 1;
    rows.miter[i] = 1 / Math.max((sx * dx + sz * dz) / sl, 0.6);
  }
  return rows;
}

/**
 * Puentes 3D (pipeline → paso `bridges`): tablero con la misma calzada y marcas que las calles,
 * barreras de concreto o barandas, pilas, rampas macizas, escaleras y techos de los pasos
 * cubiertos, agrupados por zonas (pocas llamadas de dibujo). También responde a la física:
 * altura del tablero bajo un punto y los muros (barandas, pilas, costados de las rampas).
 */
export class Bridges {
  readonly group = new THREE.Group();
  readonly lamps: DeckLamps;
  private readonly records: BridgeRecord[];
  /** Palmeras de los muelles: x, z, y (tablero), alto y semilla. */
  readonly palms: number[][];
  private readonly segments: Segment[] = [];
  private readonly piers: Pier[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly pierCells = new Map<number, number[]>();
  private readonly cellCols: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly meshes: THREE.Mesh[] = [];
  /**
   * Resultado de `onSegment` (sin crear objetos en cada consulta de la física): altura del
   * tablero, distancia al eje y de qué lado cae (+1 derecha, -1 izquierda).
   */
  private readonly probe = { y: 0, lateral: 0, side: 1 };

  private constructor(
    data: BridgesFile,
    manifest: WorldManifest,
    private readonly cfg: BridgeConfig,
    roads: GameConfig['roads'],
    private readonly heightmap: Heightmap,
  ) {
    this.group.name = 'bridges';
    this.records = data.bridges;
    this.palms = data.palms ?? [];
    const { size, nx, xmin, zmin } = manifest.chunks;
    this.x0 = xmin;
    this.z0 = zmin;
    this.cellCols = Math.ceil((nx * size) / cfg.index.cell);

    const l = data.lamps;
    const groundFlag = manifest.bridges?.groundFlag ?? 0;
    this.lamps = {
      count: l.length,
      x: Float32Array.from(l, (r) => r[0]),
      z: Float32Array.from(l, (r) => r[1]),
      y: Float32Array.from(l, (r) => r[2]),
      h: Float32Array.from(l, (r) => r[3]),
      arm: Float32Array.from(l, (r) => r[4]),
      flags: Uint8Array.from(l, (r) => r[5]),
      ground: Uint8Array.from(l, (r) => (r[5] & groundFlag ? 1 : 0)),
    };

    const channels = roads.drawOrder;
    const groups = new Map<number, Group>();
    const groupCols = Math.ceil((nx * size) / cfg.groupSize);
    this.records.forEach((b, id) => {
      const rows = resample(b, cfg.sampleStep);
      const mid = Math.floor(rows.n / 2);
      const key =
        Math.floor((rows.z[mid] - zmin) / cfg.groupSize) * groupCols + Math.floor((rows.x[mid] - xmin) / cfg.groupSize);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { solid: new MeshData(), rail: new MeshData() }));
      const channel = channels.indexOf(b.surface);
      this.build(b, rows, g, Math.max(channel, 0));
      this.index(b, id);
    });

    const solidMaterial = createBridgeMaterial(roads, cfg);
    const railMaterial = createRailMaterial(cfg);
    for (const g of groups.values()) {
      const parts: [MeshData, THREE.Material, 'solid' | 'rail', boolean][] = [
        [g.solid, solidMaterial, 'solid', true],
        [g.rail, railMaterial, 'rail', false],
      ];
      for (const [data, material, kind, casts] of parts) {
        if (data.count === 0) continue;
        const mesh = new THREE.Mesh(data.geometry(kind), material);
        mesh.castShadow = casts;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }
  }

  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    cfg: BridgeConfig,
    roads: GameConfig['roads'],
    heightmap: Heightmap,
  ): Promise<Bridges | null> {
    const info = manifest.bridges;
    if (!info) return null;
    try {
      const res = await fetch(new URL(info.url, baseUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Bridges((await res.json()) as BridgesFile, manifest, cfg, roads, heightmap);
    } catch (err) {
      console.warn('[bridges] sin puentes:', err);
      return null;
    }
  }

  /** Estilo de borde de un tipo de puente (barrera de concreto o baranda). */
  private styleOf(kind: string): Style {
    const style = (this.cfg.style as Record<string, string | undefined>)[kind];
    const known = STYLES.find((s) => s === style);
    if (!known) throw new Error(`bridges.style.${kind} en config/game.json debe ser ${STYLES.join(', ')}`);
    return known;
  }

  /** Borde del lado `side` (-1 izquierda, +1 derecha) de un puente: el suyo o el de su tipo. */
  private edgeOf(b: BridgeRecord, side: number): Style {
    if (!b.edges) return this.styleOf(b.kind);
    const style = b.edges[side < 0 ? 0 : 1];
    const known = STYLES.find((s) => s === style);
    if (!known) throw new Error(`Borde desconocido en bridges.json (${b.name || b.kind}): ${style}`);
    return known;
  }

  private perKind(values: Record<string, number>, kind: string, what: string): number {
    const v = values[kind];
    if (v === undefined) throw new Error(`Falta bridges.${what}.${kind} en config/game.json`);
    return v;
  }

  /** Arma la geometría de un puente en las mallas de su zona. */
  private build(b: BridgeRecord, rows: Rows, g: Group, channel: number): void {
    const cfg = this.cfg;
    const colors = cfg.colors;
    const concrete = new THREE.Color(colors.concrete);
    const under = concrete.clone().multiplyScalar(cfg.underShade);
    const barrierColor = new THREE.Color(colors.barrier);
    const wallColor = new THREE.Color(colors.rampWall);
    const W = b.width / 2 + b.margin;
    const laneCode = b.lanes * (b.oneway ? -1 : 1);
    // Vereda solo en los puentes con carriles; en los peatonales todo el ancho es paso.
    const halfC = b.lanes > 0 ? b.width / 2 : W;
    const walk = b.lanes > 0 ? 1 : 0;
    const deckCode = [halfC, laneCode, channel, walk];

    // Tramos seguidos de la misma parte.
    const runs: [number, number, number][] = [];
    let start = 0;
    for (let i = 1; i < rows.n; i++) {
      if (i === rows.n - 1 || rows.part[i] !== rows.part[start]) {
        runs.push([start, i, rows.part[start]]);
        start = i;
      }
    }

    for (const [a, z, part] of runs) {
      if (part === PART.stairs) {
        this.buildStairs(rows, a, z, W, g);
        continue;
      }
      // Tablero: filas de vértices a lo ancho.
      const cells = Math.max(1, Math.ceil((2 * W) / cfg.topCellWidth));
      let prevTop: number[] | null = null;
      for (let i = a; i <= z; i++) {
        const { x, y, zz, sx, sz, m } = this.frame(rows, i);
        const s = rows.slope[i];
        const nl = Math.hypot(rows.tx[i] * s, 1, rows.tz[i] * s);
        const row: number[] = [];
        for (let k = 0; k <= cells; k++) {
          const o = -W + (2 * W * k) / cells;
          const n = [(-rows.tx[i] * s) / nl, 1 / nl, (-rows.tz[i] * s) / nl];
          row.push(g.solid.vertex(x + sx * o * m, y, zz + sz * o * m, n[0], n[1], n[2], WHITE, o, rows.s[i], deckCode));
        }
        if (prevTop) g.solid.strip(prevTop, row);
        prevTop = row;
      }

      // Bordes: barrera o bordillo con baranda (o nada), y la cara exterior hasta abajo del
      // tablero (tramos en el aire) o hasta el suelo (rampas macizas, muelles).
      for (const side of [-1, 1]) {
        const style = this.edgeOf(b, side);
        const edge = style === 'barrier' ? cfg.barrier.height : style === 'railing' ? cfg.curb.height : 0;
        let prev: number[] | null = null;
        let prevRail: number[] | null = null;
        for (let i = a; i <= z; i++) {
          const { x, y, zz, sx, sz, m } = this.frame(rows, i);
          const at = (o: number): [number, number] => [x + sx * o * side * m, zz + sz * o * side * m];
          const nx = sx * side;
          const nz = sz * side;
          const bottom =
            part === PART.ramp ? this.heightmap.sample(...at(W)) - cfg.rampWall.footing : y - b.deck;
          const faceColor = part === PART.ramp ? wallColor : style === 'barrier' ? barrierColor : concrete;
          const row: number[] = [];
          const [ox, oz] = at(W);
          // Cara exterior (de arriba hacia abajo).
          row.push(g.solid.vertex(ox, y + edge, oz, nx, 0, nz, faceColor));
          row.push(g.solid.vertex(ox, bottom, oz, nx, 0, nz, faceColor));
          if (style !== 'none') {
            // Cara superior e interior del borde.
            const inTop = style === 'barrier' ? cfg.barrier.top : cfg.curb.width;
            const inBase = style === 'barrier' ? cfg.barrier.base : cfg.curb.width;
            const [tx0, tz0] = at(W);
            const [tx1, tz1] = at(W - inTop);
            const [bx1, bz1] = at(W - inBase);
            row.push(g.solid.vertex(tx0, y + edge, tz0, 0, 1, 0, barrierColor));
            row.push(g.solid.vertex(tx1, y + edge, tz1, 0, 1, 0, barrierColor));
            // Normal de la cara interior: hacia la calzada y algo hacia arriba si está inclinada.
            const dh = inBase - inTop;
            const nl = Math.hypot(edge, dh);
            const inx = (-nx * edge) / nl;
            const inz = (-nz * edge) / nl;
            const iny = dh / nl;
            row.push(g.solid.vertex(tx1, y + edge, tz1, inx, iny, inz, barrierColor));
            row.push(g.solid.vertex(bx1, y, bz1, inx, iny, inz, barrierColor));
          }
          if (prev) {
            g.solid.quad(prev[0], prev[1], row[1], row[0]);
            if (style !== 'none') {
              g.solid.quad(prev[2], prev[3], row[3], row[2]);
              g.solid.quad(prev[4], prev[5], row[5], row[4]);
            }
          }
          prev = row;

          if (style === 'railing') {
            const [rx, rz] = at(W - cfg.curb.width / 2);
            const r0 = g.rail.vertex(rx, y + edge, rz, -nx, 0, -nz, concrete, rows.s[i], 0);
            const r1 = g.rail.vertex(rx, y + edge + cfg.railing.height, rz, -nx, 0, -nz, concrete, rows.s[i], cfg.railing.height);
            if (prevRail) g.rail.quad(prevRail[0], prevRail[1], r1, r0);
            prevRail = [r0, r1];
          }
        }
      }

      if (part === PART.span) {
        // Panza del tablero (más oscura: la luz del cielo casi no llega).
        let prev: number[] | null = null;
        for (let i = a; i <= z; i++) {
          const { x, y, zz, sx, sz, m } = this.frame(rows, i);
          const yb = y - b.deck;
          const row = [
            g.solid.vertex(x - sx * W * m, yb, zz - sz * W * m, 0, -1, 0, under),
            g.solid.vertex(x + sx * W * m, yb, zz + sz * W * m, 0, -1, 0, under),
          ];
          if (prev) g.solid.quad(prev[0], prev[1], row[1], row[0]);
          prev = row;
        }
        this.buildPiers(b, rows, a, z, W, g);
      }

      // Cierres: el tablero en los extremos del puente (o donde sigue una escalera) y, donde una
      // rampa maciza llega a un vano, la cara del estribo que mira al vano, hasta el suelo.
      const ends: [number, number, number][] = [
        [a, -1, a > 0 ? rows.part[a - 1] : -1],
        [z, 1, z < rows.n - 1 ? rows.part[z] : -1],
      ];
      for (const [i, dir, neighbor] of ends) {
        const { x, y, zz, sx, sz, m } = this.frame(rows, i);
        let bottom: number;
        if (part === PART.span && (neighbor === -1 || neighbor === PART.stairs)) bottom = y - b.deck;
        else if (part === PART.ramp && neighbor === PART.span) {
          bottom = Math.min(this.heightmap.sample(x, zz), y - b.deck) - cfg.rampWall.footing;
        } else continue;
        const nx = rows.tx[i] * dir;
        const nz = rows.tz[i] * dir;
        const c = part === PART.ramp ? wallColor : concrete;
        const v = [
          g.solid.vertex(x - sx * W * m, y, zz - sz * W * m, nx, 0, nz, c),
          g.solid.vertex(x + sx * W * m, y, zz + sz * W * m, nx, 0, nz, c),
          g.solid.vertex(x + sx * W * m, bottom, zz + sz * W * m, nx, 0, nz, c),
          g.solid.vertex(x - sx * W * m, bottom, zz - sz * W * m, nx, 0, nz, c),
        ];
        g.solid.quad(v[0], v[1], v[2], v[3]);
      }

      if (b.covered) this.buildRoof(rows, a, z, W, g);
    }
  }

  /** Posición, lado (unitario, horizontal) e inglete de la fila i. */
  private frame(rows: Rows, i: number): { x: number; y: number; zz: number; sx: number; sz: number; m: number } {
    return { x: rows.x[i], y: rows.y[i], zz: rows.z[i], sx: -rows.tz[i], sz: rows.tx[i], m: rows.miter[i] };
  }

  /** Fila interpolada a la distancia `at` del eje (dentro del tramo a..z). */
  private rowAt(rows: Rows, a: number, z: number, at: number): { x: number; y: number; zz: number; sx: number; sz: number; tx: number; tz: number } {
    let i = a;
    while (i < z - 1 && rows.s[i + 1] < at) i++;
    const span = rows.s[i + 1] - rows.s[i];
    const t = span > 1e-9 ? THREE.MathUtils.clamp((at - rows.s[i]) / span, 0, 1) : 0;
    const x = rows.x[i] + (rows.x[i + 1] - rows.x[i]) * t;
    const y = rows.y[i] + (rows.y[i + 1] - rows.y[i]) * t;
    const zz = rows.z[i] + (rows.z[i + 1] - rows.z[i]) * t;
    const tx = rows.x[i + 1] - rows.x[i];
    const tz = rows.z[i + 1] - rows.z[i];
    const len = Math.hypot(tx, tz) || 1;
    return { x, y, zz, sx: -tz / len, sz: tx / len, tx: tx / len, tz: tz / len };
  }

  /**
   * Pilas bajo un vano: columnas con viga cabezal (vehiculares) o un poste (peatonales), más
   * gruesas cuanto más alto el tablero. Frente a las pilas de un puente paralelo ya armado (la
   * otra calzada) van a la misma altura del cauce, como en un puente real; en el resto, a
   * `spacing` m. Los pasos colgados de otro tablero (ciclovías, veredas) no llevan.
   */
  private buildPiers(b: BridgeRecord, rows: Rows, a: number, z: number, W: number, g: Group): void {
    if (b.attached) return;
    const p = this.cfg.piers;
    const spacing = this.perKind(p.spacing, b.kind, 'piers.spacing');
    const column = this.perKind(p.column, b.kind, 'piers.column');
    const s0 = rows.s[a];
    const s1 = rows.s[z];
    // Estaciones de las pilas vecinas de puentes paralelos, proyectadas sobre este eje.
    const reach = W + p.align.reach;
    const cosMax = Math.cos(THREE.MathUtils.degToRad(p.align.maxAngleDeg));
    const found: number[] = [];
    for (const id of this.piersNear(rows, a, z, reach)) {
      const q = this.piers[id];
      let best = -1;
      let bestD = Infinity;
      for (let i = a; i <= z; i++) {
        const d = Math.hypot(q.x - rows.x[i], q.z - rows.z[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const tx = rows.tx[best];
      const tz = rows.tz[best];
      if (Math.abs(q.dx * tx + q.dz * tz) < cosMax) continue;
      const along = (q.x - rows.x[best]) * tx + (q.z - rows.z[best]) * tz;
      const lateral = Math.abs((q.x - rows.x[best]) * tz - (q.z - rows.z[best]) * tx);
      const at = rows.s[best] + along;
      if (lateral <= reach && at > s0 + spacing * p.align.endGap && at < s1 - spacing * p.align.endGap) found.push(at);
    }
    found.sort((u, v) => u - v);
    const stations: number[] = [];
    for (const at of found) if (!stations.length || at - stations[stations.length - 1] > spacing * p.align.merge) stations.push(at);
    // Los tramos sin vecinas se reparten parejos entre los apoyos (estribos y pilas alineadas).
    const anchors = [s0, ...stations, s1];
    const all = [...stations];
    for (let k = 0; k + 1 < anchors.length; k++) {
      const gap = anchors[k + 1] - anchors[k];
      const n = Math.round(gap / spacing) - 1;
      for (let j = 1; j <= n; j++) all.push(anchors[k] + (gap * j) / (n + 1));
    }
    if (!all.length) return;
    const color = new THREE.Color(this.cfg.colors.pier);
    const withCap = this.styleOf(b.kind) === 'barrier';
    const columns = withCap ? Math.max(1, Math.round((2 * W) / p.columnSpacing)) : 1;
    for (const at of all) {
      const r = this.rowAt(rows, a, z, at);
      const bottom = r.y - b.deck;
      // Sobre el agua la pila baja hasta el fondo (el relieve bajo el río).
      const ground = this.heightmap.sample(r.x, r.zz);
      if (bottom - ground < p.minHeight) continue;
      const radius = Math.max(column, (bottom - ground) * p.perMeter) / 2;
      const base = ground - p.buried;
      const capBottom = withCap ? bottom - p.cap.height : bottom;
      for (let c = 0; c < columns; c++) {
        const o = columns === 1 ? 0 : -W + ((2 * W) * (c + 0.5)) / columns;
        const cx = r.x + r.sx * o;
        const cz = r.zz + r.sz * o;
        this.prism(g.solid, cx, cz, radius, base, capBottom, p.sides, color);
        this.addPier({ x: cx, z: cz, r: radius, top: bottom, base, dx: r.tx, dz: r.tz });
      }
      if (withCap) {
        const halfAcross = Math.max(W - p.cap.overhang, radius);
        const halfAlong = radius + p.cap.overhang;
        this.box(g.solid, r.x, r.zz, r.tx, r.tz, halfAlong, halfAcross, capBottom, bottom, color);
      }
    }
  }

  /** Pilas ya armadas cerca de las filas a..z (a menos de `reach` m de su recuadro). */
  private piersNear(rows: Rows, a: number, z: number, reach: number): Set<number> {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = a; i <= z; i++) {
      x0 = Math.min(x0, rows.x[i]);
      x1 = Math.max(x1, rows.x[i]);
      z0 = Math.min(z0, rows.z[i]);
      z1 = Math.max(z1, rows.z[i]);
    }
    const c = this.cfg.index.cell;
    const out = new Set<number>();
    const i0 = Math.floor((x0 - reach - this.x0) / c);
    const i1 = Math.floor((x1 + reach - this.x0) / c);
    const j0 = Math.floor((z0 - reach - this.z0) / c);
    const j1 = Math.floor((z1 + reach - this.z0) / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.pierCells.get(j * this.cellCols + i);
        if (list) for (const id of list) out.add(id);
      }
    }
    return out;
  }

  /** Prisma vertical de `sides` caras (columna; los extremos quedan bajo tierra y bajo el tablero). */
  private prism(m: MeshData, x: number, z: number, r: number, y0: number, y1: number, sides: number, c: THREE.Color): void {
    let prev: number[] | null = null;
    for (let k = 0; k <= sides; k++) {
      const a = ((k % sides) / sides) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const row = [m.vertex(x + nx * r, y1, z + nz * r, nx, 0, nz, c), m.vertex(x + nx * r, y0, z + nz * r, nx, 0, nz, c)];
      if (prev) m.quad(prev[0], prev[1], row[1], row[0]);
      prev = row;
    }
  }

  /** Caja orientada con el eje (medio largo a lo largo, medio ancho a lo ancho), de y0 a y1. */
  private box(
    m: MeshData,
    x: number,
    z: number,
    tx: number,
    tz: number,
    halfAlong: number,
    halfAcross: number,
    y0: number,
    y1: number,
    c: THREE.Color,
  ): void {
    const sx = -tz;
    const sz = tx;
    const corner = (u: number, v: number): [number, number] => [x + tx * u * halfAlong + sx * v * halfAcross, z + tz * u * halfAlong + sz * v * halfAcross];
    const faces: [number, number, number, [number, number][]][] = [
      [tx, 0, tz, [[1, -1], [1, 1]]],
      [-tx, 0, -tz, [[-1, 1], [-1, -1]]],
      [sx, 0, sz, [[1, 1], [-1, 1]]],
      [-sx, 0, -sz, [[-1, -1], [1, -1]]],
    ];
    for (const [nx, ny, nz, [[u0, v0], [u1, v1]]] of faces) {
      const [ax, az] = corner(u0, v0);
      const [bx, bz] = corner(u1, v1);
      m.quad(
        m.vertex(ax, y1, az, nx, ny, nz, c),
        m.vertex(bx, y1, bz, nx, ny, nz, c),
        m.vertex(bx, y0, bz, nx, ny, nz, c),
        m.vertex(ax, y0, az, nx, ny, nz, c),
      );
    }
    for (const [ny, y] of [
      [1, y1],
      [-1, y0],
    ] as const) {
      const v = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map(([px, pz]) => m.vertex(px, y, pz, 0, ny, 0, c));
      m.quad(v[0], v[1], v[2], v[3]);
    }
  }

  /** Escalera: peldaños, zancas, losa inclinada abajo y barandas, del tramo a..z. */
  private buildStairs(rows: Rows, a: number, z: number, W: number, g: Group): void {
    const cfg = this.cfg;
    const color = new THREE.Color(cfg.colors.concrete);
    const under = color.clone().multiplyScalar(cfg.underShade);
    const s0 = rows.s[a];
    const s1 = rows.s[z];
    const run = s1 - s0;
    if (run < 1e-3) return;
    const y0 = rows.y[a];
    const y1 = rows.y[z];
    const steps = Math.max(1, Math.round(Math.abs(y1 - y0) / cfg.stairs.rise));
    const rise = (y1 - y0) / steps;
    // Peldaños: huella a su altura y contrahuella al subir (en el sentido del eje o al revés).
    for (let k = 0; k < steps; k++) {
      const sa = s0 + (run * k) / steps;
      const sb = s0 + (run * (k + 1)) / steps;
      const ra = this.rowAt(rows, a, z, sa);
      const rb = this.rowAt(rows, a, z, sb);
      // Sube en el sentido del eje: la huella k está a y0 + rise·(k+1), su contrahuella en sa.
      const up = rise > 0;
      const tread = up ? y0 + rise * (k + 1) : y0 + rise * k;
      const t = [
        g.solid.vertex(ra.x - ra.sx * W, tread, ra.zz - ra.sz * W, 0, 1, 0, color),
        g.solid.vertex(ra.x + ra.sx * W, tread, ra.zz + ra.sz * W, 0, 1, 0, color),
        g.solid.vertex(rb.x + rb.sx * W, tread, rb.zz + rb.sz * W, 0, 1, 0, color),
        g.solid.vertex(rb.x - rb.sx * W, tread, rb.zz - rb.sz * W, 0, 1, 0, color),
      ];
      g.solid.quad(t[0], t[1], t[2], t[3]);
      const at = up ? ra : rb;
      const lo = up ? tread - rise : tread + rise;
      const nx = up ? -at.tx : at.tx;
      const nz = up ? -at.tz : at.tz;
      const r = [
        g.solid.vertex(at.x - at.sx * W, tread, at.zz - at.sz * W, nx, 0, nz, color),
        g.solid.vertex(at.x + at.sx * W, tread, at.zz + at.sz * W, nx, 0, nz, color),
        g.solid.vertex(at.x + at.sx * W, lo, at.zz + at.sz * W, nx, 0, nz, color),
        g.solid.vertex(at.x - at.sx * W, lo, at.zz - at.sz * W, nx, 0, nz, color),
      ];
      g.solid.quad(r[0], r[1], r[2], r[3]);
    }
    // Zancas a los costados (tapan el serrucho) y losa inclinada por debajo.
    const line = (i: number): number => y0 + ((rows.s[i] - s0) / run) * (y1 - y0);
    const top = Math.abs(rise);
    for (const side of [-1, 1]) {
      let prev: number[] | null = null;
      let prevRail: number[] | null = null;
      for (let i = a; i <= z; i++) {
        const { x, zz, sx, sz } = this.frame(rows, i);
        const px = x + sx * W * side;
        const pz = zz + sz * W * side;
        const yl = line(i);
        const row = [
          g.solid.vertex(px, yl + top, pz, sx * side, 0, sz * side, color),
          g.solid.vertex(px, yl - cfg.stairs.slab, pz, sx * side, 0, sz * side, color),
        ];
        if (prev) g.solid.quad(prev[0], prev[1], row[1], row[0]);
        prev = row;
        const rx = x + sx * (W - cfg.curb.width / 2) * side;
        const rz = zz + sz * (W - cfg.curb.width / 2) * side;
        const r0 = g.rail.vertex(rx, yl + top, rz, -sx * side, 0, -sz * side, color, rows.s[i], 0);
        const r1 = g.rail.vertex(rx, yl + top + cfg.railing.height, rz, -sx * side, 0, -sz * side, color, rows.s[i], cfg.railing.height);
        if (prevRail) g.rail.quad(prevRail[0], prevRail[1], r1, r0);
        prevRail = [r0, r1];
      }
    }
    let prev: number[] | null = null;
    for (let i = a; i <= z; i++) {
      const { x, zz, sx, sz } = this.frame(rows, i);
      const yl = line(i) - cfg.stairs.slab;
      const row = [
        g.solid.vertex(x - sx * W, yl, zz - sz * W, 0, -1, 0, under),
        g.solid.vertex(x + sx * W, yl, zz + sz * W, 0, -1, 0, under),
      ];
      if (prev) g.solid.quad(prev[0], prev[1], row[1], row[0]);
      prev = row;
    }
  }

  /** Techo de un paso peatonal cubierto: losa delgada sobre postes a los costados. */
  private buildRoof(rows: Rows, a: number, z: number, W: number, g: Group): void {
    const r = this.cfg.roof;
    const color = new THREE.Color(this.cfg.colors.roof);
    const half = W + r.overhang;
    let prev: number[] | null = null;
    for (let i = a; i <= z; i++) {
      const { x, y, zz, sx, sz, m } = this.frame(rows, i);
      const y0 = y + r.height;
      const y1 = y0 + r.thickness;
      const row = [
        g.solid.vertex(x - sx * half * m, y1, zz - sz * half * m, 0, 1, 0, color),
        g.solid.vertex(x + sx * half * m, y1, zz + sz * half * m, 0, 1, 0, color),
        g.solid.vertex(x + sx * half * m, y0, zz + sz * half * m, 0, -1, 0, color),
        g.solid.vertex(x - sx * half * m, y0, zz - sz * half * m, 0, -1, 0, color),
      ];
      if (prev) {
        g.solid.quad(prev[0], prev[1], row[1], row[0]);
        g.solid.quad(prev[3], prev[2], row[2], row[3]);
      }
      prev = row;
    }
    const length = rows.s[z] - rows.s[a];
    const count = Math.max(1, Math.round(length / r.postSpacing));
    for (let k = 0; k <= count; k++) {
      const p = this.rowAt(rows, a, z, rows.s[a] + (length * k) / count);
      for (const side of [-1, 1]) {
        const o = (W - r.post) * side;
        this.box(g.solid, p.x + p.sx * o, p.zz + p.sz * o, p.tx, p.tz, r.post / 2, r.post / 2, p.y, p.y + r.height, color);
      }
    }
  }

  private cellKey(x: number, z: number): number {
    const c = this.cfg.index.cell;
    return Math.floor((z - this.z0) / c) * this.cellCols + Math.floor((x - this.x0) / c);
  }

  /** Registra los tramos del eje de un puente en las celdas que tocan (para la física). */
  private index(b: BridgeRecord, bridge: number): void {
    const p = b.pts;
    const n = p.length / 3;
    const half = b.width / 2 + b.margin;
    const c = this.cfg.index.cell;
    for (let i = 0; i + 1 < n; i++) {
      const seg: Segment = {
        ax: p[i * 3],
        az: p[i * 3 + 1],
        ay: p[i * 3 + 2],
        bx: p[i * 3 + 3],
        bz: p[i * 3 + 4],
        by: p[i * 3 + 5],
        half,
        bridge,
        part: segPart(b.part[i], b.part[i + 1]),
      };
      const id = this.segments.push(seg) - 1;
      const pad = half + this.cfg.index.slack;
      const i0 = Math.floor((Math.min(seg.ax, seg.bx) - pad - this.x0) / c);
      const i1 = Math.floor((Math.max(seg.ax, seg.bx) + pad - this.x0) / c);
      const j0 = Math.floor((Math.min(seg.az, seg.bz) - pad - this.z0) / c);
      const j1 = Math.floor((Math.max(seg.az, seg.bz) + pad - this.z0) / c);
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const key = j * this.cellCols + k;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(id);
        }
      }
    }
  }

  private addPier(pier: Pier): void {
    const id = this.piers.push(pier) - 1;
    const key = this.cellKey(pier.x, pier.z);
    let list = this.pierCells.get(key);
    if (!list) this.pierCells.set(key, (list = []));
    list.push(id);
  }

  /**
   * ¿Cae (x, z) a lo largo del tramo s? Deja en `probe` la altura del tablero ahí y la
   * distancia al eje (el ancho lo revisa quien llama).
   */
  private onSegment(s: Segment, x: number, z: number): boolean {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-9) return false;
    const len = Math.sqrt(len2);
    const t = ((x - s.ax) * dx + (z - s.az) * dz) / len2;
    const slack = this.cfg.index.slack / len;
    if (t < -slack || t > 1 + slack) return false;
    // Hacia la derecha del eje: (-dz, dx), como el lado +1 de la geometría.
    const signed = ((z - s.az) * dx - (x - s.ax) * dz) / len;
    const tc = Math.min(Math.max(t, 0), 1);
    this.probe.y = s.ay + (s.by - s.ay) * tc;
    this.probe.lateral = Math.abs(signed);
    this.probe.side = signed < 0 ? -1 : 1;
    return true;
  }

  /**
   * Superficie de tablero más alta bajo (x, z) que no pase de `maxY` (-Infinity si no hay).
   * Con `hit`, deja también el material de la calzada.
   */
  deckAt(x: number, z: number, maxY: number, hit?: DeckHit): number {
    const list = this.cells.get(this.cellKey(x, z));
    if (!list) return -Infinity;
    let best = -Infinity;
    let bridge = -1;
    for (const id of list) {
      const s = this.segments[id];
      if (!this.onSegment(s, x, z) || this.probe.lateral > s.half) continue;
      const y = this.probe.y;
      if (y <= maxY && y > best) {
        best = y;
        bridge = s.bridge;
      }
    }
    if (hit && bridge >= 0) {
      hit.y = best;
      hit.surface = this.records[bridge].surface;
    }
    return best;
  }

  /**
   * Tope del obstáculo de puente en (x, z) para alguien a la altura y (-Infinity si no hay):
   * las barandas del tablero donde está parado, los costados de una rampa maciza (desde abajo)
   * y las pilas. Es muro si el tope queda más alto que lo que se puede subir de un paso.
   */
  wallTop(x: number, z: number, y: number): number {
    let top = -Infinity;
    const cfg = this.cfg;
    const list = this.cells.get(this.cellKey(x, z));
    if (list) {
      for (const id of list) {
        const s = this.segments[id];
        if (!this.onSegment(s, x, z)) continue;
        const deck = this.probe.y;
        const lateral = this.probe.lateral;
        if (lateral > s.half + cfg.index.slack) continue;
        const style = this.edgeOf(this.records[s.bridge], this.probe.side);
        const edge = style === 'barrier' ? cfg.barrier.height : cfg.curb.height + cfg.railing.height;
        // Baranda: en la franja del borde, para quien está sobre ese tablero (del lado que la lleva).
        if (style !== 'none' && lateral >= s.half - cfg.walls.band && y >= deck - cfg.walls.stand && y < deck + edge) {
          top = Math.max(top, deck + edge);
        }
        // Rampa maciza: desde abajo es un muro.
        if (s.part === PART.ramp && lateral <= s.half && y < deck) top = Math.max(top, deck);
      }
    }
    const piers = this.pierCells.get(this.cellKey(x, z));
    if (piers) {
      for (const id of piers) {
        const p = this.piers[id];
        if (y < p.top && Math.hypot(x - p.x, z - p.z) <= p.r) top = Math.max(top, p.top);
      }
    }
    return top;
  }

  /**
   * Luz de los postes sobre los tableros, por vértice (sus mapas de luz son los del suelo:
   * ahí no se dibujan). Misma distribución que los charcos del suelo (world/lampWorker.ts):
   * E = I·cos^k(θ)·(n·l) / r², estirada a lo largo de la calle, con I = luz bajo el poste · h².
   */
  bakeNight(lamps: LampData, light: LightsConfig): void {
    const own: number[] = [];
    for (let k = 0; k < lamps.count; k++) if (lamps.elevated[k]) own.push(k);
    if (own.length === 0) return;
    // Índice de postes por celda del alcance máximo.
    let maxH = 0;
    for (const k of own) maxH = Math.max(maxH, lamps.h[k]);
    const cell = maxH * light.reach * light.stretch;
    const grid = new Map<string, number[]>();
    const keyOf = (i: number, j: number): string => `${i},${j}`;
    for (const k of own) {
      const ax = Math.cos(lamps.arm[k]);
      const az = Math.sin(lamps.arm[k]);
      const fx = lamps.x[k] + ax * lamps.h[k] * light.armShare;
      const fz = lamps.z[k] + az * lamps.h[k] * light.armShare;
      const key = keyOf(Math.floor(fx / cell), Math.floor(fz / cell));
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(k);
    }
    const inv = 1 / (light.stretch * light.stretch);
    const power = light.falloff;
    for (const mesh of this.meshes) {
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nor = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const out = mesh.geometry.getAttribute('aLamp') as THREE.BufferAttribute;
      const arr = out.array as Float32Array;
      let any = false;
      for (let v = 0; v < pos.count; v++) {
        const px = pos.getX(v);
        const py = pos.getY(v);
        const pz = pos.getZ(v);
        const nx = nor.getX(v);
        const ny = nor.getY(v);
        const nz = nor.getZ(v);
        const ci = Math.floor(px / cell);
        const cj = Math.floor(pz / cell);
        let r = 0;
        let gr = 0;
        let bl = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const list = grid.get(keyOf(ci + di, cj + dj));
            if (!list) continue;
            for (const k of list) {
              const h = lamps.h[k];
              const ax = Math.cos(lamps.arm[k]);
              const az = Math.sin(lamps.arm[k]);
              const lx = lamps.x[k] + ax * h * light.armShare;
              const lz = lamps.z[k] + az * h * light.armShare;
              const ly = lamps.y[k] + h;
              const dx = px - lx;
              const dz = pz - lz;
              const across = dx * ax + dz * az;
              const along = dz * ax - dx * az;
              const d2 = across * across + along * along * inv;
              const limit = h * light.reach;
              if (d2 > limit * limit) continue;
              const above = ly - py;
              // Lo que queda bajo el tablero (su canto, la panza, las pilas) no ve el poste.
              if (above < light.minHeight || py < lamps.y[k] - this.cfg.lampShadowDepth) continue;
              const q = d2 + above * above;
              const rq = Math.sqrt(q);
              // Coseno con la normal hacia la luz (con las distancias estiradas, como en el suelo).
              const facing = Math.max((-dx * nx + above * ny - dz * nz) / rq, 0);
              if (facing <= 0) continue;
              const e = (light.underLamp * h * h * Math.pow(above / rq, power) * facing) / q;
              r += lamps.tint[k * 3] * e;
              gr += lamps.tint[k * 3 + 1] * e;
              bl += lamps.tint[k * 3 + 2] * e;
            }
          }
        }
        if (r + gr + bl > 0) any = true;
        arr[v * 3] = r;
        arr[v * 3 + 1] = gr;
        arr[v * 3 + 2] = bl;
      }
      if (any) out.needsUpdate = true;
    }
  }
}
