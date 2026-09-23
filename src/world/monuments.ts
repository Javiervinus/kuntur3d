import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GeoFrame } from '../core/geo';
import type { GameConfig } from '../core/types';
import { fogTransmittanceGLSL } from '../render/fog';
import { nightLight, withNightLight } from '../render/nightLight';
import type { DeckHit } from './bridges';
import type { Heightmap } from './heightmap';

type MonumentsConfig = GameConfig['monuments'];
type FogConfig = GameConfig['render']['fog'];

const TAU = Math.PI * 2;

/** Luz propia de noche: color (sRGB) e intensidad. */
interface Glow {
  color: string;
  intensity: number;
}

/** Lo común a todos los monumentos de config/game.json → monuments.list. */
interface MonumentBase {
  id: string;
  type: string;
  lat: number;
  lon: number;
  /** Rumbo del frente (grados desde el norte, horario): el eje x local del monumento. */
  headingDeg?: number;
  /** Radio (m) en el que el monumento reemplaza a los edificios de los datos (0 = ninguno). */
  exclude: number;
  /** Cuánto lo alumbran de noche los reflectores (0…1). */
  flood: number;
}

interface Flag {
  stripes: string[];
  vertical?: boolean;
}

/** Asta y paño: radio y alto del asta, ancho y alto del paño, grosor. */
interface FlagSize {
  pole: number[];
  size: number[];
  thickness: number;
}

interface FerrisWheel extends MonumentBase {
  /** Altura del eje y radio de los aros sobre la plataforma (m). */
  hub: number;
  radius: number;
  /** Distancia entre los dos aros. */
  width: number;
  rim: { tube: number; inner: number; innerTube: number };
  truss: { count: number; radius: number };
  hubDisc: { radius: number; thickness: number };
  axle: { radius: number; overhang: number };
  spokes: { count: number; radius: number; twistDeg: number; hubOffset: number };
  crossbar: number;
  legs: { spread: number; depth: number; radius: number; brace: { at: number; radius: number } };
  deck: { length: number; width: number; thickness: number; freeboard: number };
  rpm: number;
  cabins: { count: number; size: number[]; corner: number; glass: number[]; lip: number; hanger: number[] };
  colors: { structure: string; cabin: string; glass: string; deck: string; hub: string };
  lights: {
    rim: number;
    spoke: number;
    radial: number;
    size: number;
    minPixels: number;
    maxPixels: number;
    farFalloff: number;
    core: number;
    glow: number;
    depthPull: number;
    intensity: number;
    speed: number;
    waves: number;
    palette: string[];
    /** Cuánto tiñen los LED de noche los aros y rayos donde van montados. */
    spill: number;
    cabinGlow: Glow;
    /**
     * LED del aro que se reflejan en el agua (una muestra pareja, ver reflectedLights) y su
     * intensidad, en las mismas unidades que la de un poste de alumbrado.
     */
    reflect: { count: number; power: number };
  };
}

interface ClockTower extends MonumentBase {
  base: { width: number; height: number };
  arches: { door: number[]; window: number[]; bulge: number; inset: number };
  shaft: { width: number; height: number; pilaster: number; windows: number };
  cornice: { overhang: number; height: number };
  clock: { width: number; height: number; radius: number; ring: number; lift: number; thickness: number; hour: number[]; minute: number[] };
  gallery: { width: number; height: number; rail: number[] };
  lantern: { width: number; height: number; opening: number[] };
  dome: { radius: number; rise: number; bulge: number };
  finial: { radius: number; taper: number; height: number; ball: number };
  flag: FlagSize & Flag;
  colors: { wall: string; trim: string; opening: string; clock: string; hands: string; dome: string; finial: string; pole: string };
  clockGlow: Glow;
}

interface Hemicycle extends MonumentBase {
  radius: number;
  arcDeg: number;
  supports: { count: number; spacing: number };
  column: { radius: number; taper: number; height: number; base: number[]; capital: number[] };
  pillar: { width: number };
  entablature: { height: number; depth: number; overhang: number };
  platform: { width: number; steps: number; rise: number; run: number };
  pedestal: { width: number; height: number; cap: number[] };
  statues: { radius: number; height: number; gap: number; head: number; arm: number; reach: number; shoulder: number; hand: number };
  flags: FlagSize & { list: Flag[] };
  colors: { stone: string; column: string; bronze: string; platform: string; pole: string };
}

interface Lighthouse extends MonumentBase {
  height: number;
  radius: number[];
  stripes: { count: number; turns: number; across: number; along: number };
  door: { size: number[]; inset: number };
  gallery: { radius: number; height: number; rail: number[]; posts: number };
  lantern: { radius: number; height: number; mullions: number; frame: number };
  cap: { height: number; overhang: number; ball: number };
  colors: { a: string; b: string; gallery: string; lantern: string; cap: string; door: string };
  beam: { count: number; length: number; angleDeg: number; rpm: number; intensity: number; color: string; tessellation: number[] };
  lanternGlow: Glow;
}

type MonumentConfig = FerrisWheel | ClockTower | Hemicycle | Lighthouse;

/** Pieza del mundo físico: obstáculo, o piso donde se puede estar (su tope). */
interface Shape {
  kind: 'circle' | 'ring' | 'box';
  x: number;
  z: number;
  /** circle: radio; ring: radio exterior; box: medio largo (a lo largo de `angle`). */
  a: number;
  /** ring: radio interior; box: medio ancho. */
  b: number;
  /** ring: centro del sector; box: dirección del largo (rad, atan2(z, x) en el mundo). */
  angle: number;
  /** ring: medio ancho del sector (rad). */
  halfArc: number;
  top: number;
  floor: boolean;
}

/** Un monumento para la física: sus piezas y el círculo que las contiene (descarte rápido). */
interface Site {
  x: number;
  z: number;
  r: number;
  shapes: Shape[];
}

interface Wheel {
  rotor: THREE.Group;
  cabins: THREE.InstancedMesh;
  radius: number;
  hub: number;
  hang: number;
  speed: number;
  angle: number;
  /** Sus LED: la config, el radio del aro donde van y los colores de la paleta. */
  lights: FerrisWheel['lights'];
  rim: number;
  palette: THREE.Color[];
}

interface Clock {
  hands: THREE.InstancedMesh;
  faces: THREE.Matrix4[];
  /** Ancho y largo (m) de cada aguja. */
  hour: number[];
  minute: number[];
  thickness: number;
  shown: number;
}

const NO_GLOW = new THREE.Color(0, 0, 0);

/** Índice 0…n−1 para una geometría sin índice (mergeGeometries pide que todas lo tengan). */
function sequence(n: number): THREE.BufferAttribute {
  const index = n > 0xffff ? new Uint32Array(n) : new Uint16Array(n);
  for (let k = 0; k < n; k++) index[k] = k;
  return new THREE.BufferAttribute(index, 1);
}

/**
 * Piezas de un monumento, unidas en una sola geometría: color por vértice, luz propia de noche
 * (vidrios, relojes), cuánto lo alumbran los reflectores (se apagan con la altura desde su base:
 * `base` y `height`, en el mundo) y cuánto lo tiñen los LED montados encima (solo las ruedas).
 */
class Parts {
  private readonly list: THREE.BufferGeometry[] = [];

  constructor(
    private readonly flood: number,
    private readonly base: number,
    private readonly height: number,
  ) {}

  add(geometry: THREE.BufferGeometry, color: THREE.Color, matrix: THREE.Matrix4, glow: THREE.Color = NO_GLOW, led = 0): void {
    geometry.deleteAttribute('uv');
    if (!geometry.index) geometry.setIndex(sequence(geometry.getAttribute('position').count));
    geometry.applyMatrix4(matrix);
    const n = geometry.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    const glows = new Float32Array(n * 3);
    const floods = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      color.toArray(colors, k * 3);
      glow.toArray(glows, k * 3);
      floods[k * 3] = this.flood;
      floods[k * 3 + 1] = this.base;
      floods[k * 3 + 2] = this.height;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aGlow', new THREE.BufferAttribute(glows, 3));
    geometry.setAttribute('aFlood', new THREE.BufferAttribute(floods, 3));
    geometry.setAttribute('aLed', new THREE.BufferAttribute(new Float32Array(n).fill(led), 1));
    this.list.push(geometry);
  }

  merge(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list);
    if (!merged) throw new Error('No se pudo armar la geometría de un monumento');
    for (const g of this.list) g.dispose();
    merged.computeBoundingSphere();
    return merged;
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _size = new THREE.Vector2();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

/** Matriz de posición, giro (radianes, en orden XYZ) y escala. */
function place(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Barra cilíndrica de radio r entre dos puntos. */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, sides: number): { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const d = new THREE.Vector3().subVectors(b, a);
  const length = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(length));
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return { geometry: new THREE.CylinderGeometry(r, r, length, sides, 1, true), matrix };
}

/** Prisma de `sides` lados con apotema `apothem` y una cara mirando a +x. */
function prism(apothem: number, height: number, sides: number): THREE.CylinderGeometry {
  const r = apothem / Math.cos(Math.PI / sides);
  return new THREE.CylinderGeometry(r, r, height, sides, 1, false, Math.PI / sides);
}

/**
 * Arco de herradura (morisco) de ancho w y alto total h en el plano x-y, con la base en y = 0:
 * con `bulge` > 1 el arco pasa de la media circunferencia y se cierra antes de las jambas.
 */
function horseshoe(w: number, h: number, bulge: number, segments: number): THREE.ShapeGeometry {
  const R = (w / 2) * bulge;
  const drop = Math.sqrt(R * R - (w * w) / 4);
  const center = h - R;
  const beta = Math.atan2(drop, w / 2);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(-w / 2, center - drop);
  shape.absarc(0, center, R, Math.PI + beta, -beta, true);
  shape.lineTo(w / 2, 0);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, segments);
}

/** Sector de anillo (radios r0…r1, ángulos a0…a1 en atan2(z, x)) de alto `depth` hacia abajo desde y = 0. */
function ringSector(r0: number, r1: number, a0: number, a1: number, depth: number, segments: number): THREE.BufferGeometry {
  const arc = (r: number, from: number, to: number): THREE.Vector2[] =>
    Array.from({ length: segments + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / segments;
      return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
    });
  // La forma va en x-y con y = z del mundo: girada, la extrusión (+z) queda hacia abajo.
  const g = new THREE.ExtrudeGeometry(new THREE.Shape([...arc(r1, a0, a1), ...arc(r0, a1, a0)]), { depth, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Una de las `count` franjas en espiral (la `k`) sobre un tronco de cono (radio r0 abajo, r1
 * arriba, alto h) que dan `turns` vueltas: cada franja es su propia malla (bordes exactos).
 */
function helixStripe(r0: number, r1: number, h: number, count: number, turns: number, k: number, across: number, along: number): THREE.BufferGeometry {
  const width = TAU / count;
  const slope = (r0 - r1) / h;
  const len = Math.hypot(1, slope);
  const positions: number[] = [];
  const normals: number[] = [];
  for (let j = 0; j <= along; j++) {
    const v = j / along;
    const r = r0 + (r1 - r0) * v;
    for (let i = 0; i <= across; i++) {
      const theta = (k + i / across) * width + TAU * turns * v;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      positions.push(r * c, v * h, r * s);
      normals.push(c / len, slope / len, s / len);
    }
  }
  const index: number[] = [];
  const row = across + 1;
  for (let j = 0; j < along; j++) {
    for (let i = 0; i < across; i++) {
      const a = j * row + i;
      const c = a + row;
      // Hacia afuera: (a, c, b) y (b, c, d).
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  return g;
}

/** Cúpula de bulbo (árabe-bizantina): perfil de radio R y alto rise·R, un poco panzón. */
function onionDome(R: number, rise: number, bulge: number, segments: number, sides: number): THREE.LatheGeometry {
  const points = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    const r = R * Math.sqrt(Math.max(0, 1 - t * t)) * (1 + bulge * Math.sin(Math.PI * t));
    return new THREE.Vector2(r, t * R * rise);
  });
  return new THREE.LatheGeometry(points, sides);
}

/**
 * GLSL: color de los LED de una rueda en una fase (0…1 da la vuelta): ondas de la paleta que
 * avanzan con el tiempo, fundidas entre colores vecinos. uLedChase = (ondas por vuelta,
 * velocidad, cuánto se adelanta la fase del cubo al aro, intensidad del teñido).
 */
function ledGLSL(colors: number): string {
  return /* glsl */ `
uniform vec3 uLedPalette[${colors}];
uniform vec4 uLedChase;
uniform float uLedTime;
vec3 gyeLedColor(float phase) {
  float t = fract(phase * uLedChase.x - uLedTime * uLedChase.y) * ${colors}.0;
  int i = int(floor(t));
  return mix(uLedPalette[i], uLedPalette[(i + 1) % ${colors}], smoothstep(0.0, 1.0, fract(t)));
}`;
}

/** Uniformes de los LED de una rueda (compartidos por sus puntos de luz y su estructura). */
interface Leds {
  uniforms: Record<string, THREE.IUniform>;
  colors: number;
}

/**
 * Material de los monumentos: color por vértice; de noche, reflectores cálidos desde la base
 * (bajan con la altura) y la luz propia de vidrios y relojes. Con `leds`, la estructura que
 * gira de una rueda: sus aros y rayos se tiñen con el color de los LED que llevan encima (la
 * fase sale del ángulo y la distancia al cubo, en el marco del rotor). `uLightsOn` lo declara
 * la luz de noche (withNightLight), que siempre va encadenada.
 */
function createMaterial(cfg: MonumentsConfig, leds?: Leds): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: cfg.roughness });
  const uniforms = {
    uFloodColor: { value: new THREE.Color(cfg.flood.color).multiplyScalar(cfg.flood.intensity) },
    uFloodTop: { value: cfg.flood.top },
    ...leds?.uniforms,
  };
  const ledPars = leds ? `uniform vec2 uLedHub;\n${ledGLSL(leds.colors)}` : '';
  const ledVertex = leds
    ? `
  float gyeLedA = atan( position.y, position.x ) / ${TAU};
  float gyeLedS = clamp( ( length( position.xy ) - uLedHub.x ) / ( uLedHub.y - uLedHub.x ), 0.0, 1.0 );
  vLed = gyeLedColor( gyeLedA + uLedChase.z * gyeLedS ) * ( aLed * uLedChase.w );`
    : `
  vLed = vec3( 0.0 );`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uFloodTop;
attribute vec3 aGlow;
attribute vec3 aFlood;
attribute float aLed;
varying vec3 vGlow;
varying float vFlood;
varying vec3 vLed;
${ledPars}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
{
  vec4 gyeFloodPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    gyeFloodPos = instanceMatrix * gyeFloodPos;
  #endif
  float gyeFloodH = clamp( ( ( modelMatrix * gyeFloodPos ).y - aFlood.y ) / max( aFlood.z, 1.0 ), 0.0, 1.0 );
  vFlood = aFlood.x * mix( 1.0, uFloodTop, gyeFloodH );
  vGlow = aGlow;${ledVertex}
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uFloodColor;\nvarying vec3 vGlow;\nvarying float vFlood;\nvarying vec3 vLed;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += ( diffuseColor.rgb * uFloodColor * vFlood + vGlow + vLed ) * uLightsOn;`,
      );
  };
  material.customProgramCacheKey = () => `gye-monument-v3${leds ? `-led${leds.colors}` : ''}`;
  withNightLight(material);
  return material;
}

/** Color de luz propia (lineal) de un `Glow` de la config. */
function glowOf(g: Glow): THREE.Color {
  return new THREE.Color(g.color).multiplyScalar(g.intensity);
}

/** Todos los colores de un bloque `colors` de la config, como THREE.Color. */
function colorsOf<K extends string>(colors: Record<K, string>): Record<K, THREE.Color> {
  const out = {} as Record<K, THREE.Color>;
  for (const key of Object.keys(colors) as K[]) out[key] = new THREE.Color(colors[key]);
  return out;
}

/**
 * Lugares icónicos en 3D (config/game.json → monuments), armados con primitivas a sus medidas
 * reales:
 * - La Perla, la noria de 57 m del Malecón 2000 sobre su plataforma en el río: una vuelta cada
 *   ~12 min con sus 36 cabinas siempre derechas, y de noche ondas de colores en sus LED;
 * - la Torre Morisca (base octogonal, arcos de herradura, cúpula de bulbo y la bandera de
 *   Guayaquil), con un reloj que marca la hora del juego;
 * - el Hemiciclo de la Rotonda: columnata en semicírculo con las banderas, y Bolívar y San
 *   Martín dándose la mano de frente al río;
 * - el Faro del cerro Santa Ana, con sus franjas celestes y blancas en espiral y los haces que
 *   giran de noche.
 * Donde un monumento ocupa la huella de un edificio de los datos, ese edificio no se dibuja
 * (`exclusions`); sus pisos y obstáculos entran en la física (`deckAt`, `wallTop`).
 */
export class Monuments {
  readonly group = new THREE.Group();
  private readonly sites: Site[] = [];
  private readonly wheels: Wheel[] = [];
  private readonly clocks: Clock[] = [];
  private readonly beams: { group: THREE.Group; speed: number }[] = [];
  private readonly leds: THREE.Points[] = [];
  private readonly time = { value: 0 };
  /** Píxeles por metro a 1 m de la cámara (tamaño de los LED en pantalla). */
  private readonly pixels = { value: 1 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly list: readonly MonumentConfig[];

  constructor(
    private readonly cfg: MonumentsConfig,
    private readonly geo: GeoFrame,
    private readonly heightmap: Heightmap,
    private readonly waterLevel: number,
    private readonly fog: FogConfig,
  ) {
    this.group.name = 'monuments';
    this.material = createMaterial(cfg);
    // Asignarla a los tipos de arriba valida la config al compilar.
    this.list = cfg.list;
    for (const m of this.list) {
      const at = geo.toLocal(m.lat, m.lon);
      const root = new THREE.Group();
      root.name = m.id;
      root.position.set(at.x, 0, at.z);
      // El eje x local apunta al rumbo: (sen θ, −cos θ) en (x = este, z = sur).
      root.rotation.y = Math.PI / 2 - THREE.MathUtils.degToRad(m.headingDeg ?? 0);
      const site: Site = { x: at.x, z: at.z, r: 0, shapes: [] };
      switch (m.type) {
        case 'ferrisWheel':
          this.ferrisWheel(root, site, m as FerrisWheel);
          break;
        case 'clockTower':
          this.clockTower(root, site, m as ClockTower);
          break;
        case 'hemicycle':
          this.hemicycle(root, site, m as Hemicycle);
          break;
        case 'lighthouse':
          this.lighthouse(root, site, m as Lighthouse);
          break;
        default:
          throw new Error(`Monumento de tipo desconocido en config/game.json → monuments: ${m.type}`);
      }
      for (const s of site.shapes) {
        const extent = s.kind === 'box' ? Math.hypot(s.a, s.b) : s.a;
        site.r = Math.max(site.r, Math.hypot(s.x - site.x, s.z - site.z) + extent);
      }
      this.sites.push(site);
      this.group.add(root);
    }
    this.group.updateMatrixWorld(true);
  }

  /** Círculos (marco local) donde los monumentos reemplazan a los edificios de los datos. */
  get exclusions(): { x: number; z: number; radius: number }[] {
    return this.list.filter((m) => m.exclude > 0).map((m) => ({ ...this.geo.toLocal(m.lat, m.lon), radius: m.exclude }));
  }

  /** Suelo bajo un círculo de radio `radius`: el más alto (donde se asienta) y el más bajo (hasta donde baja). */
  private ground(root: THREE.Object3D, radius: number): { top: number; bottom: number } {
    const { rings, angles } = this.cfg.ground;
    let top = this.heightmap.sample(root.position.x, root.position.z);
    let bottom = top;
    for (let i = 1; i <= rings; i++) {
      const r = (radius * i) / rings;
      for (let k = 0; k < angles; k++) {
        const a = (k / angles) * TAU;
        const h = this.heightmap.sample(root.position.x + r * Math.cos(a), root.position.z + r * Math.sin(a));
        top = Math.max(top, h);
        bottom = Math.min(bottom, h);
      }
    }
    return { top, bottom };
  }

  private mesh(geometry: THREE.BufferGeometry, parent: THREE.Object3D, material = this.material): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** Punto del marco local del monumento en el mundo (x, z). */
  private world(root: THREE.Object3D, lx: number, lz: number): { x: number; z: number } {
    const c = Math.cos(root.rotation.y);
    const s = Math.sin(root.rotation.y);
    return { x: root.position.x + lx * c + lz * s, z: root.position.z - lx * s + lz * c };
  }

  /** Obstáculo o piso circular en (lx, lz) del marco local; `top` en el mundo. */
  private circle(site: Site, root: THREE.Object3D, lx: number, lz: number, r: number, top: number, floor = false): void {
    const p = this.world(root, lx, lz);
    site.shapes.push({ kind: 'circle', x: p.x, z: p.z, a: r, b: 0, angle: 0, halfArc: 0, top, floor });
  }

  /** Sector de anillo centrado en el monumento; `angle` en el marco local (atan2(z, x)). */
  private ring(site: Site, root: THREE.Object3D, inner: number, outer: number, angle: number, halfArc: number, top: number, floor = false): void {
    site.shapes.push({ kind: 'ring', x: root.position.x, z: root.position.z, a: outer, b: inner, angle: angle - root.rotation.y, halfArc, top, floor });
  }

  /** Rectángulo de medio largo `halfU` (eje x local) y medio ancho `halfV`, centrado en (lx, lz). */
  private box(site: Site, root: THREE.Object3D, lx: number, lz: number, halfU: number, halfV: number, top: number, floor = false): void {
    const p = this.world(root, lx, lz);
    site.shapes.push({ kind: 'box', x: p.x, z: p.z, a: halfU, b: halfV, angle: -root.rotation.y, halfArc: 0, top, floor });
  }

  private ferrisWheel(root: THREE.Group, site: Site, w: FerrisWheel): void {
    const D = this.cfg.detail;
    const col = colorsOf(w.colors);
    const half = w.width / 2;
    const R = w.radius;
    // La plataforma de 1200 m² sobre el río: a la altura del malecón y nunca bajo el agua.
    const g = this.ground(root, Math.hypot(w.deck.length, w.deck.width) / 2);
    const base = Math.max(g.top, this.waterLevel + w.deck.freeboard);
    root.position.y = base;
    const parts = new Parts(w.flood, base, w.hub + R);
    const depth = Math.max(base - g.bottom, w.deck.thickness);
    parts.add(new THREE.BoxGeometry(w.deck.length, depth, w.deck.width), col.deck, place(0, -depth / 2, 0));
    this.box(site, root, 0, 0, w.deck.length / 2, w.deck.width / 2, base, true);

    // Patas en A a cada lado, del piso a las puntas del eje, abiertas hacia afuera.
    const axleEnd = half + w.spokes.hubOffset + w.axle.overhang;
    const legs = w.legs;
    for (const side of [-1, 1]) {
      const head = new THREE.Vector3(0, w.hub, side * axleEnd);
      const feet = [-1, 1].map((along) => new THREE.Vector3((along * legs.spread) / 2, 0, side * (axleEnd + legs.depth)));
      for (const foot of feet) {
        const leg = strut(foot, head, legs.radius, D.sides);
        parts.add(leg.geometry, col.structure, leg.matrix);
        this.circle(site, root, foot.x, foot.z, legs.radius, base + w.hub);
      }
      const [a, b] = feet.map((f) => f.clone().lerp(head, legs.brace.at));
      const brace = strut(a, b, legs.brace.radius, D.sides);
      parts.add(brace.geometry, col.structure, brace.matrix);
    }
    parts.add(new THREE.CylinderGeometry(w.axle.radius, w.axle.radius, axleEnd * 2, D.sides), col.hub, place(0, w.hub, 0, Math.PI / 2));
    this.mesh(parts.merge(), root);

    // Lo que gira: aros con su celosía, cubos, rayos tensados y los travesaños de las cabinas.
    // Los aros y los rayos llevan los LED: de noche se tiñen de su color.
    const rotor = new THREE.Group();
    rotor.position.set(0, w.hub, 0);
    root.add(rotor);
    const rp = new Parts(w.flood, base, w.hub + R);
    const inner = R * w.rim.inner;
    const L = w.lights;
    const leds: Leds = {
      colors: L.palette.length,
      uniforms: {
        uLedPalette: { value: L.palette.map((c) => new THREE.Color(c)) },
        uLedChase: { value: new THREE.Vector4(L.waves, L.speed, L.radial, L.spill) },
        uLedTime: this.time,
        uLedHub: { value: new THREE.Vector2(w.hubDisc.radius, inner) },
      },
    };
    const twist = THREE.MathUtils.degToRad(w.spokes.twistDeg);
    const step = TAU / w.truss.count;
    for (const side of [-1, 1]) {
      const z = side * half;
      rp.add(new THREE.TorusGeometry(R, w.rim.tube, D.rimSides, D.rimSegments), col.structure, place(0, 0, z), NO_GLOW, 1);
      rp.add(new THREE.TorusGeometry(inner, w.rim.innerTube, D.rimSides, D.rimSegments), col.structure, place(0, 0, z), NO_GLOW, 1);
      for (let k = 0; k < w.truss.count; k++) {
        const a = k * step;
        const o0 = new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, z);
        const i0 = new THREE.Vector3(Math.cos(a + step / 2) * inner, Math.sin(a + step / 2) * inner, z);
        const o1 = new THREE.Vector3(Math.cos(a + step) * R, Math.sin(a + step) * R, z);
        for (const [p, q] of [
          [o0, i0],
          [i0, o1],
        ]) {
          const s = strut(p, q, w.truss.radius, D.thin);
          rp.add(s.geometry, col.structure, s.matrix);
        }
      }
      const hz = side * (half + w.spokes.hubOffset);
      rp.add(new THREE.CylinderGeometry(w.hubDisc.radius, w.hubDisc.radius, w.hubDisc.thickness, D.sides), col.hub, place(0, 0, hz, Math.PI / 2));
      for (let k = 0; k < w.spokes.count; k++) {
        const a = (k / w.spokes.count) * TAU;
        // Rayos tangentes, alternados: se cruzan como en una rueda de bicicleta.
        const t = a + (k % 2 === 0 ? twist : -twist);
        const s = strut(
          new THREE.Vector3(Math.cos(a) * w.hubDisc.radius, Math.sin(a) * w.hubDisc.radius, hz),
          new THREE.Vector3(Math.cos(t) * inner, Math.sin(t) * inner, z),
          w.spokes.radius,
          D.thin,
        );
        rp.add(s.geometry, col.structure, s.matrix, NO_GLOW, 1);
      }
    }
    for (let k = 0; k < w.cabins.count; k++) {
      const a = (k / w.cabins.count) * TAU;
      const s = strut(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, -half), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, half), w.crossbar, D.thin);
      rp.add(s.geometry, col.structure, s.matrix);
    }
    this.mesh(rp.merge(), rotor, createMaterial(this.cfg, leds));
    rotor.add(this.wheelLights(w, half, inner, leds));

    // Cabinas: cuelgan derechas de su travesaño (se reubican al girar).
    const [cw, ch, cd] = w.cabins.size;
    const [g0, g1] = w.cabins.glass;
    const [hangerRadius, hangerLength] = w.cabins.hanger;
    const band = (g1 - g0) * ch;
    const lip = w.cabins.lip * 2;
    const cabin = new Parts(w.flood, base, w.hub + R);
    cabin.add(new RoundedBoxGeometry(cw, ch, cd, D.rounded, w.cabins.corner), col.cabin, new THREE.Matrix4());
    cabin.add(
      new RoundedBoxGeometry(cw + lip, band, cd + lip, D.rounded, Math.min(w.cabins.corner, band / 2)),
      col.glass,
      place(0, -ch / 2 + ((g0 + g1) / 2) * ch, 0),
      glowOf(w.lights.cabinGlow),
    );
    const hanger = strut(new THREE.Vector3(0, ch / 2, 0), new THREE.Vector3(0, ch / 2 + hangerLength, 0), hangerRadius, D.thin);
    cabin.add(hanger.geometry, col.structure, hanger.matrix);
    const cabins = new THREE.InstancedMesh(cabin.merge(), this.material, w.cabins.count);
    cabins.castShadow = true;
    cabins.receiveShadow = true;
    root.add(cabins);
    const wheel: Wheel = {
      rotor,
      cabins,
      radius: R,
      hub: w.hub,
      hang: hangerLength + ch / 2,
      speed: (w.rpm * TAU) / 60,
      angle: 0,
      lights: w.lights,
      rim: w.radius + w.rim.tube,
      palette: w.lights.palette.map((c) => new THREE.Color(c)),
    };
    this.placeCabins(wheel);
    // Las cabinas recorren la rueda entera: la esfera de todas las posiciones vale para siempre.
    cabins.computeBoundingSphere();
    this.wheels.push(wheel);
  }

  /** Cabinas en su lugar según el giro de la rueda. */
  private placeCabins(w: Wheel): void {
    const n = w.cabins.count;
    for (let k = 0; k < n; k++) {
      const a = w.angle + (k / n) * TAU;
      w.cabins.setMatrixAt(k, _m.makeTranslation(Math.cos(a) * w.radius, w.hub + Math.sin(a) * w.radius - w.hang, 0));
    }
    w.cabins.instanceMatrix.needsUpdate = true;
  }

  /**
   * Las luces LED de la rueda (más de 1400 en la real): en el borde de los aros y a lo largo de
   * los rayos. Puntos que de cerca miden lo que un LED y de lejos no bajan de un mínimo en
   * pantalla (entonces se atenúan): la rueda se ve como un anillo de luz desde toda la ciudad.
   */
  private wheelLights(w: FerrisWheel, half: number, inner: number, leds: Leds): THREE.Points {
    const L = w.lights;
    const positions: number[] = [];
    const phases: number[] = [];
    const rim = w.radius + w.rim.tube;
    // Fase = vuelta (0…1) + adelanto por la distancia al cubo: la misma que tiñe la estructura.
    for (const side of [-1, 1]) {
      const z = side * half;
      for (let k = 0; k < L.rim; k++) {
        const a = (k / L.rim) * TAU;
        positions.push(Math.cos(a) * rim, Math.sin(a) * rim, z);
        phases.push(k / L.rim + L.radial);
      }
      const hz = side * (half + w.spokes.hubOffset);
      for (let k = 0; k < w.spokes.count; k++) {
        const a = (k / w.spokes.count) * TAU;
        for (let i = 1; i <= L.spoke; i++) {
          const t = i / (L.spoke + 1);
          const r = w.hubDisc.radius + (inner - w.hubDisc.radius) * t;
          positions.push(Math.cos(a) * r, Math.sin(a) * r, hz + (z - hz) * t);
          phases.push(k / w.spokes.count + L.radial * t);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...leds.uniforms,
        uLightsOn: nightLight.uLightsOn,
        uPixels: this.pixels,
        uLedSize: { value: new THREE.Vector4(L.size, L.minPixels, L.maxPixels, L.farFalloff) },
        uLedLook: { value: new THREE.Vector2(L.intensity, L.depthPull) },
        uLedShape: { value: new THREE.Vector2(L.core, L.glow) },
      },
      vertexShader: /* glsl */ `
uniform float uLightsOn;
uniform float uPixels;
uniform vec4 uLedSize;
uniform vec2 uLedLook;
attribute float aPhase;
varying vec3 vLed;
${ledGLSL(leds.colors)}
${fogTransmittanceGLSL(this.fog)}
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  float dist = length(mv.xyz);
  // Tamaño en pantalla del LED; de lejos no baja del mínimo y en cambio se atenúa.
  float px = uLedSize.x * uPixels / max(dist, 1e-3);
  float energy = pow(min(px / uLedSize.y, 1.0), uLedSize.w);
  vLed = gyeLedColor(aPhase) * (uLightsOn * uLedLook.x * energy * gyeFogTransmittance(world.xyz));
  // Un poco hacia la cámara: que el tubo del aro no tape la mitad del punto.
  mv.xyz *= 1.0 - uLedLook.y;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(px, uLedSize.y, uLedSize.z);
}`,
      fragmentShader: /* glsl */ `
uniform vec2 uLedShape;
varying vec3 vLed;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float edge = 1.0 - r2;
  gl_FragColor = vec4(vLed * (exp(-r2 * uLedShape.x) + uLedShape.y * edge * edge), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'wheel-lights';
    points.visible = false;
    this.leds.push(points);
    return points;
  }

  /** Cuántos LED de las ruedas se reflejan en el agua (ver reflectedLights). */
  get reflectedCount(): number {
    return this.wheels.reduce((sum, w) => sum + w.lights.reflect.count, 0);
  }

  /**
   * LED de las ruedas que se reflejan en el agua (world/waterGlints.ts): `reflect.count` por
   * rueda, repartidos por el aro en su plano medio, con su posición en el mundo (según el giro
   * de ahora), el color que muestran en este momento (el mismo cálculo que ledGLSL) y su
   * intensidad. Devuelve cuántos escribió.
   */
  reflectedLights(positions: Float32Array, colors: Float32Array, powers: Float32Array): number {
    let n = 0;
    for (const w of this.wheels) {
      const L = w.lights;
      w.rotor.updateWorldMatrix(true, false);
      for (let k = 0; k < L.reflect.count; k++) {
        const a = (k / L.reflect.count) * TAU;
        _v.set(Math.cos(a) * w.rim, Math.sin(a) * w.rim, 0).applyMatrix4(w.rotor.matrixWorld);
        positions[n * 3] = _v.x;
        positions[n * 3 + 1] = _v.y;
        positions[n * 3 + 2] = _v.z;
        // La fase de los LED del aro (ver wheelLights) y el color de la persecución.
        const phase = k / L.reflect.count + L.radial;
        const t = phase * L.waves - this.time.value * L.speed;
        const at = (t - Math.floor(t)) * w.palette.length;
        const i = Math.floor(at);
        _c.copy(w.palette[i]).lerp(w.palette[(i + 1) % w.palette.length], THREE.MathUtils.smoothstep(at - i, 0, 1));
        colors[n * 3] = _c.r;
        colors[n * 3 + 1] = _c.g;
        colors[n * 3 + 2] = _c.b;
        powers[n] = L.reflect.power;
        n++;
      }
    }
    return n;
  }

  private clockTower(root: THREE.Group, site: Site, t: ClockTower): void {
    const D = this.cfg.detail;
    const col = colorsOf(t.colors);
    const A = t.arches;
    const g = this.ground(root, t.base.width / 2);
    const base = g.top;
    root.position.y = base;
    const sink = base - g.bottom;
    const top =
      t.base.height + t.shaft.height + t.cornice.height + t.clock.height + t.gallery.height + t.lantern.height + t.dome.radius * t.dome.rise + t.finial.height;
    const parts = new Parts(t.flood, base, top);
    /** Arco (puerta, ventana) en la cara de apotema `apothem` que mira hacia `a`, con su base en y. */
    const arch = (size: number[], apothem: number, a: number, y: number): void => {
      const d = apothem + A.inset;
      parts.add(horseshoe(size[0], size[1], A.bulge, D.arch), col.opening, place(Math.cos(a) * d, y, Math.sin(a) * d, 0, Math.PI / 2 - a));
    };

    // Base octogonal: puertas en herradura en las cuatro caras principales, ventanas en las otras.
    const apothem = t.base.width / 2;
    parts.add(prism(apothem, t.base.height + sink, 8), col.wall, place(0, (t.base.height - sink) / 2, 0));
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      if (k % 2 === 0) arch(A.door, apothem, a, 0);
      else arch(A.window, apothem, a, (t.base.height - A.window[1]) / 2);
    }
    let y = t.base.height;

    // Fuste con pilastras en las esquinas y ventanas en herradura en cada cara.
    const sw = t.shaft.width;
    const P = t.shaft.pilaster;
    parts.add(new THREE.BoxGeometry(sw, t.shaft.height, sw), col.wall, place(0, y + t.shaft.height / 2, 0));
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      parts.add(new THREE.BoxGeometry(P, t.shaft.height, P), col.trim, place((sx * sw) / 2, y + t.shaft.height / 2, (sz * sw) / 2));
    }
    const slot = t.shaft.height / t.shaft.windows;
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < t.shaft.windows; j++) arch(A.window, sw / 2, (k * Math.PI) / 2, y + slot * j + (slot - A.window[1]) / 2);
    }
    y += t.shaft.height;

    // Cornisa y el cuerpo del reloj (más ancho): cuatro esferas que de noche se iluminan.
    const cornice = sw + t.cornice.overhang * 2;
    parts.add(new THREE.BoxGeometry(cornice, t.cornice.height, cornice), col.trim, place(0, y + t.cornice.height / 2, 0));
    y += t.cornice.height;
    const C = t.clock;
    parts.add(new THREE.BoxGeometry(C.width, C.height, C.width), col.wall, place(0, y + C.height / 2, 0));
    const faces: THREE.Matrix4[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const d = C.width / 2 + C.lift;
      const face = place(Math.cos(a) * d, y + C.height / 2, Math.sin(a) * d, 0, Math.PI / 2 - a);
      parts.add(new THREE.CircleGeometry(C.radius, D.sides * 2), col.clock, face, glowOf(t.clockGlow));
      parts.add(new THREE.TorusGeometry(C.radius, C.ring, D.thin, D.sides * 2), col.trim, face);
      faces.push(face.clone().multiply(place(0, 0, C.lift)));
    }
    y += C.height;

    // Galería con antepecho, linterna octogonal con arcos, cúpula de bulbo, remate y bandera.
    const G = t.gallery;
    const [railHeight, railWidth] = G.rail;
    parts.add(new THREE.BoxGeometry(G.width, G.height, G.width), col.trim, place(0, y + G.height / 2, 0));
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const d = G.width / 2 - railWidth / 2;
      parts.add(new THREE.BoxGeometry(railWidth, railHeight, G.width), col.wall, place(Math.cos(a) * d, y + G.height + railHeight / 2, Math.sin(a) * d, 0, -a));
    }
    y += G.height;
    const lanternApothem = t.lantern.width / 2;
    parts.add(prism(lanternApothem, t.lantern.height, 8), col.wall, place(0, y + t.lantern.height / 2, 0));
    for (let k = 0; k < 8; k++) arch(t.lantern.opening, lanternApothem, (k * Math.PI) / 4, y + (t.lantern.height - t.lantern.opening[1]) / 2);
    y += t.lantern.height;
    const dome = t.dome;
    parts.add(onionDome(dome.radius, dome.rise, dome.bulge, D.lathe, D.sides), col.dome, place(0, y, 0));
    y += dome.radius * dome.rise;
    const F = t.finial;
    parts.add(new THREE.CylinderGeometry(F.radius * F.taper, F.radius, F.height, D.thin), col.finial, place(0, y + F.height / 2, 0));
    parts.add(new THREE.SphereGeometry(F.ball, D.thin * 2, D.thin), col.finial, place(0, y + F.height, 0));
    y += F.height;
    this.flag(parts, root, new THREE.Vector3(0, y, 0), t.flag, t.flag, col.pole);
    this.mesh(parts.merge(), root);
    this.circle(site, root, 0, 0, apothem, base + top);

    // Agujas: dos por esfera, en instancias (se mueven con la hora del juego).
    const hand = new Parts(t.flood, base, top);
    hand.add(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0.5), col.hands, new THREE.Matrix4());
    const hands = new THREE.InstancedMesh(hand.merge(), this.material, faces.length * 2);
    // Giran dentro de las esferas: sin recorte por la esfera de la primera posición.
    hands.frustumCulled = false;
    root.add(hands);
    const clock: Clock = {
      hands,
      faces,
      hour: [C.hour[0], C.hour[1] * C.radius],
      minute: [C.minute[0], C.minute[1] * C.radius],
      thickness: C.thickness,
      shown: NaN,
    };
    this.setClock(clock, 0);
    this.clocks.push(clock);
  }

  /** Mueve las agujas a la hora `hours` (0…24). */
  private setClock(c: Clock, hours: number): void {
    const hour = ((((hours % 12) + 12) % 12) / 12) * TAU;
    const minute = (((hours % 1) + 1) % 1) * TAU;
    c.faces.forEach((face, f) => {
      for (const [k, angle, [width, length]] of [
        [0, hour, c.hour],
        [1, minute, c.minute],
      ] as const) {
        // En sentido horario visto de frente: giro negativo alrededor de la normal (+z de la esfera).
        _m.compose(_p.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, -angle)), _s.set(width, length, c.thickness));
        c.hands.setMatrixAt(f * 2 + k, _m.premultiply(face));
      }
    });
    c.hands.instanceMatrix.needsUpdate = true;
    c.shown = hours;
  }

  /**
   * Asta con bandera en `at` (marco local): franjas horizontales (o verticales), flameando
   * hacia donde sopla el viento de la config.
   */
  private flag(parts: Parts, root: THREE.Object3D, at: THREE.Vector3, size: FlagSize, flag: Flag, poleColor: THREE.Color): void {
    const [radius, height] = size.pole;
    const [fw, fh] = size.size;
    parts.add(new THREE.CylinderGeometry(radius, radius, height, this.cfg.detail.thin), poleColor, place(at.x, at.y + height / 2, at.z));
    // Rumbo del viento en el marco local del monumento (el giro del monumento se aplica afuera).
    const yaw = Math.PI / 2 - THREE.MathUtils.degToRad(this.cfg.wind.headingDeg) - root.rotation.y;
    const frame = place(at.x, at.y + height, at.z, 0, yaw);
    const n = flag.stripes.length;
    flag.stripes.forEach((hex, k) => {
      const stripe = flag.vertical
        ? new THREE.BoxGeometry(fw / n, fh, size.thickness).translate(radius + (fw / n) * (k + 0.5), -fh / 2, 0)
        : new THREE.BoxGeometry(fw, fh / n, size.thickness).translate(radius + fw / 2, -(fh / n) * (k + 0.5), 0);
      parts.add(stripe, new THREE.Color(hex), frame);
    });
  }

  private hemicycle(root: THREE.Group, site: Site, h: Hemicycle): void {
    const D = this.cfg.detail;
    const col = colorsOf(h.colors);
    const P = h.platform;
    const R = h.radius;
    const g = this.ground(root, R + P.width / 2);
    const base = g.top;
    root.position.y = base;
    const sink = base - g.bottom;
    const podium = P.steps * P.rise;
    const C = h.column;
    const E = h.entablature;
    const top = podium + C.height + E.height + h.flags.pole[1];
    const parts = new Parts(h.flood, base, top);
    // Semicírculo del lado −x: abre hacia +x (el frente, al río), adonde miran las estatuas.
    const arc = THREE.MathUtils.degToRad(h.arcDeg);
    const a0 = Math.PI - arc / 2;
    const a1 = Math.PI + arc / 2;
    const extra = E.overhang / R;
    const segments = D.sides * 2;

    // Gradas: la más baja es la que más entra hacia el centro; atrás, un muro.
    const outer = R + P.width / 2;
    for (let j = 0; j < P.steps; j++) {
      const from = R - P.width / 2 - (P.steps - 1 - j) * P.run;
      const to = j === P.steps - 1 ? outer : from + P.run;
      const rise = (j + 1) * P.rise;
      parts.add(ringSector(from, to, a0 - extra, a1 + extra, rise + sink, segments), col.platform, place(0, rise, 0));
      this.ring(site, root, from, to, Math.PI, arc / 2 + extra, base + rise, true);
    }

    // Pilares atrás y columnas delante, en pares, con las banderas sobre las columnas.
    const S = h.supports;
    const [baseWidth, baseHeight] = C.base;
    const [capWidth, capHeight] = C.capital;
    for (let k = 0; k < S.count; k++) {
      const a = a0 + (arc * k) / (S.count - 1);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rp = R + S.spacing / 2;
      const rc = R - S.spacing / 2;
      parts.add(new THREE.BoxGeometry(h.pillar.width, C.height, h.pillar.width), col.stone, place(c * rp, podium + C.height / 2, s * rp, 0, -a));
      this.circle(site, root, c * rp, s * rp, h.pillar.width / 2, base + podium + C.height);
      parts.add(new THREE.CylinderGeometry(C.radius * C.taper, C.radius, C.height, D.sides), col.column, place(c * rc, podium + C.height / 2, s * rc));
      parts.add(new THREE.BoxGeometry(C.radius * 2 * baseWidth, baseHeight, C.radius * 2 * baseWidth), col.stone, place(c * rc, podium + baseHeight / 2, s * rc, 0, -a));
      parts.add(new THREE.BoxGeometry(C.radius * 2 * capWidth, capHeight, C.radius * 2 * capWidth), col.stone, place(c * rc, podium + C.height - capHeight / 2, s * rc, 0, -a));
      this.circle(site, root, c * rc, s * rc, C.radius, base + podium + C.height);
      this.flag(parts, root, new THREE.Vector3(c * rc, podium + C.height + E.height, s * rc), h.flags, h.flags.list[k % h.flags.list.length], col.pole);
    }
    // Entablamento curvo sobre pilares y columnas.
    parts.add(ringSector(R - E.depth / 2, R + E.depth / 2, a0 - extra, a1 + extra, E.height, segments), col.stone, place(0, podium + C.height + E.height, 0));

    // Pedestal al centro y los dos libertadores dándose la mano, de frente al río.
    const Pd = h.pedestal;
    const [capW, capH] = Pd.cap;
    parts.add(new THREE.BoxGeometry(Pd.width, Pd.height + sink, Pd.width), col.stone, place(0, (Pd.height - sink) / 2, 0));
    parts.add(new THREE.BoxGeometry(capW, capH, capW), col.stone, place(0, Pd.height + capH / 2, 0));
    this.box(site, root, 0, 0, Pd.width / 2, Pd.width / 2, base + Pd.height + capH);
    const St = h.statues;
    const foot = Pd.height + capH;
    const body = St.height - St.head * 2;
    for (const side of [-1, 1]) {
      const z = (side * St.gap) / 2;
      parts.add(new THREE.CapsuleGeometry(St.radius, body - St.radius * 2, D.thin, D.sides), col.bronze, place(0, foot + body / 2, z));
      parts.add(new THREE.SphereGeometry(St.head, D.sides, D.thin * 2), col.bronze, place(0, foot + St.height - St.head, z));
      const arm = strut(new THREE.Vector3(0, foot + St.height * St.shoulder, z), new THREE.Vector3(St.reach, foot + St.height * St.hand, 0), St.arm, D.thin);
      parts.add(arm.geometry, col.bronze, arm.matrix);
    }
    this.mesh(parts.merge(), root);
  }

  private lighthouse(root: THREE.Group, site: Site, f: Lighthouse): void {
    const D = this.cfg.detail;
    const col = colorsOf(f.colors);
    const [r0, r1] = f.radius;
    const g = this.ground(root, r0);
    const base = g.top;
    root.position.y = base;
    const sink = base - g.bottom;
    const G = f.gallery;
    const Ln = f.lantern;
    const top = f.height + G.height + Ln.height + f.cap.height;
    const parts = new Parts(f.flood, base, top);
    const segments = D.sides * 2;
    // Pie enterrado (el cerro no es plano) y las franjas en espiral, celeste y blanco.
    if (sink > 0) parts.add(new THREE.CylinderGeometry(r0, r0, sink, segments), col.a, place(0, -sink / 2, 0));
    const S = f.stripes;
    for (let k = 0; k < S.count; k++) {
      parts.add(helixStripe(r0, r1, f.height, S.count, S.turns, k, S.across, S.along), k % 2 === 0 ? col.a : col.b, new THREE.Matrix4());
    }
    // Puerta en la base, inclinada como el muro.
    const [dw, dh] = f.door.size;
    const lean = Math.atan2(r0 - r1, f.height);
    parts.add(
      horseshoe(dw, dh, 1, D.arch),
      col.door,
      place(r0 + f.door.inset, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(lean)).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)),
    );

    // Balcón con baranda, linterna de vidrio (brilla de noche) y el techo.
    parts.add(new THREE.CylinderGeometry(G.radius, G.radius, G.height, segments), col.gallery, place(0, f.height + G.height / 2, 0));
    const [railHeight, railRadius] = G.rail;
    const floor = f.height + G.height;
    const railY = floor + railHeight;
    const railR = G.radius - railRadius;
    parts.add(new THREE.TorusGeometry(railR, railRadius, D.thin, segments), col.gallery, place(0, railY, 0, Math.PI / 2));
    for (let k = 0; k < G.posts; k++) {
      const a = (k / G.posts) * TAU;
      const post = strut(new THREE.Vector3(Math.cos(a) * railR, floor, Math.sin(a) * railR), new THREE.Vector3(Math.cos(a) * railR, railY, Math.sin(a) * railR), railRadius, D.thin);
      parts.add(post.geometry, col.gallery, post.matrix);
    }
    parts.add(new THREE.CylinderGeometry(Ln.radius, Ln.radius, Ln.height, segments), col.lantern, place(0, floor + Ln.height / 2, 0), glowOf(f.lanternGlow));
    for (let k = 0; k < Ln.mullions; k++) {
      const a = (k / Ln.mullions) * TAU;
      parts.add(new THREE.BoxGeometry(Ln.frame, Ln.height, Ln.frame), col.gallery, place(Math.cos(a) * Ln.radius, floor + Ln.height / 2, Math.sin(a) * Ln.radius, 0, -a));
    }
    const roof = floor + Ln.height;
    parts.add(new THREE.ConeGeometry(Ln.radius * f.cap.overhang, f.cap.height, segments), col.cap, place(0, roof + f.cap.height / 2, 0));
    parts.add(new THREE.SphereGeometry(f.cap.ball, D.thin * 2, D.thin), col.cap, place(0, roof + f.cap.height, 0));
    this.mesh(parts.merge(), root);
    this.circle(site, root, 0, 0, r0, base + top);

    // Haces del faro: conos de luz que giran de noche (aditivos, sin sombra).
    const B = f.beam;
    const radius = Math.tan(THREE.MathUtils.degToRad(B.angleDeg)) * B.length;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(B.color).multiplyScalar(B.intensity) },
        uLength: { value: B.length },
        uLightsOn: nightLight.uLightsOn,
      },
      vertexShader: /* glsl */ `
varying float vAlong;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vFog;
${fogTransmittanceGLSL(this.fog)}
void main() {
  vAlong = position.x;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  vFog = gyeFogTransmittance(world.xyz);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uLength;
uniform float uLightsOn;
varying float vAlong;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vFog;
void main() {
  float t = clamp(vAlong / uLength, 0.0, 1.0);
  // Más intenso junto a la linterna y en el eje del cono (bordes suaves).
  float axis = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.5);
  gl_FragColor = vec4(uColor * ((1.0 - t) * (1.0 - t) * axis * uLightsOn * vFog), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beams = new THREE.Group();
    beams.name = 'lighthouse-beams';
    beams.position.set(0, floor + Ln.height / 2, 0);
    beams.visible = false;
    const [around, along] = B.tessellation;
    for (let k = 0; k < B.count; k++) {
      // Cono con la punta en la linterna, abierto hacia +x (fino en ambos sentidos: sin facetas).
      const cone = new THREE.ConeGeometry(radius, B.length, around, along, true).translate(0, -B.length / 2, 0).rotateZ(Math.PI / 2);
      const mesh = new THREE.Mesh(cone, material);
      mesh.rotation.y = (k / B.count) * TAU;
      beams.add(mesh);
    }
    root.add(beams);
    this.beams.push({ group: beams, speed: (B.rpm * TAU) / 60 });
  }

  /** Cada frame: ruedas y cabinas, luces, haces y relojes (a la hora `hours` del juego). */
  update(dt: number, hours: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    this.time.value += dt;
    const on = nightLight.uLightsOn.value > 0;
    for (const w of this.wheels) {
      w.angle = (w.angle + w.speed * dt) % TAU;
      w.rotor.rotation.z = w.angle;
      this.placeCabins(w);
    }
    for (const b of this.beams) {
      b.group.visible = on;
      b.group.rotation.y += b.speed * dt;
    }
    for (const led of this.leds) led.visible = on;
    if (on) this.pixels.value = renderer.getDrawingBufferSize(_size).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const c of this.clocks) if (c.shown !== hours) this.setClock(c, hours);
  }

  private static inside(s: Shape, x: number, z: number, margin: number): boolean {
    const dx = x - s.x;
    const dz = z - s.z;
    switch (s.kind) {
      case 'circle':
        return dx * dx + dz * dz <= (s.a + margin) * (s.a + margin);
      case 'ring': {
        const d = Math.hypot(dx, dz);
        if (d > s.a + margin || d < s.b - margin) return false;
        const t = Math.atan2(dz, dx) - s.angle;
        return Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) <= s.halfArc + margin / Math.max(d, 1);
      }
      case 'box': {
        const c = Math.cos(s.angle);
        const sn = Math.sin(s.angle);
        return Math.abs(dx * c + dz * sn) <= s.a + margin && Math.abs(dz * c - dx * sn) <= s.b + margin;
      }
    }
  }

  /**
   * Piso de monumento más alto en (x, z) que no pase de `maxY` (la plataforma de La Perla, las
   * gradas de la Rotonda), o `best` si lo encontrado antes (un puente) está más alto. Si gana,
   * lo anota en `hit`.
   */
  deckAt(x: number, z: number, maxY: number, best = -Infinity, hit?: DeckHit): number {
    let y = -Infinity;
    for (const site of this.sites) {
      if (Math.hypot(x - site.x, z - site.z) > site.r) continue;
      for (const s of site.shapes) {
        if (s.floor && s.top <= maxY && s.top > y && Monuments.inside(s, x, z, 0)) y = s.top;
      }
    }
    if (y <= best) return best;
    if (hit) {
      hit.y = y;
      hit.surface = this.cfg.surface;
    }
    return y;
  }

  /** Tope del monumento en (x, z) para alguien a la altura y (-Infinity si no hay): lo que queda más alto es muro. */
  wallTop(x: number, z: number, y: number): number {
    let top = -Infinity;
    for (const site of this.sites) {
      if (Math.hypot(x - site.x, z - site.z) > site.r) continue;
      for (const s of site.shapes) {
        if (y < s.top && s.top > top && Monuments.inside(s, x, z, 0)) top = s.top;
      }
    }
    return top;
  }

  /** ¿Hay parte de un monumento en (x, z), con un margen (m)? (para no plantar árboles adentro). */
  occupied(x: number, z: number, margin = 0): boolean {
    for (const site of this.sites) {
      if (Math.hypot(x - site.x, z - site.z) > site.r + margin) continue;
      for (const s of site.shapes) if (Monuments.inside(s, x, z, margin)) return true;
    }
    return false;
  }
}
