import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AerialLine, GameConfig, WorldManifest } from '../core/types';
import { createHaloMaterial, haloPixels } from '../render/halos';
import { nightLight, withNightLight } from '../render/nightLight';

type AerialConfig = GameConfig['aerialways'];
type KindConfig = AerialConfig['kinds']['gondola'];
type CabinConfig = AerialConfig['cabin'];
type TowerConfig = AerialConfig['tower'];
type FogConfig = GameConfig['render']['fog'];

/** Tipo de cada punto de una línea (contrato con el paso `aerial` de pipeline/build_world.py). */
const POINT = { tower: 0, station: 1, portal: 2 } as const;
/** Tipo de estación (AERIAL_STATION_TYPES del pipeline). */
const STATION = { terminal: 0, stop: 1, technical: 2 } as const;
const GRAVITY = 9.81;
/**
 * Orden de dibujo (renderOrder): los andenes y las cabinas antes que todo; después, las máscaras
 * de las bocas (solo profundidad); el resto del mundo (0), al final.
 */
const BEHIND_MASK = -2;
const MASK = -1;

/** Cómo toma el color cada pieza (atributo aSurface): del color de la cabina, vidrio, baliza. */
interface Surface {
  tint: number;
  glass: number;
  flash: number;
}
const PLAIN: Surface = { tint: 0, glass: 0, flash: 0 };
const TINTED: Surface = { tint: 1, glass: 0, flash: 0 };
const GLASS: Surface = { tint: 0, glass: 1, flash: 0 };
const BEACON: Surface = { tint: 0, glass: 0, flash: 1 };
const NO_GLOW = new THREE.Color(0, 0, 0);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _x = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

/** Pseudoaleatorio estable en [0, 1) a partir de dos enteros. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Índice 0…n−1 para una geometría sin índice (mergeGeometries pide que todas lo tengan). */
function sequence(n: number): THREE.BufferAttribute {
  const index = n > 0xffff ? new Uint32Array(n) : new Uint16Array(n);
  for (let k = 0; k < n; k++) index[k] = k;
  return new THREE.BufferAttribute(index, 1);
}

/**
 * Piezas unidas en una sola geometría: color por vértice, cómo toma el color cada una
 * (aSurface: x = del color de la instancia, y = vidrio, z = baliza que destella) y su luz propia
 * de noche (aGlow, color lineal ya multiplicado por su intensidad).
 */
class Parts {
  private readonly list: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, color: THREE.Color, matrix: THREE.Matrix4 | null, surface = PLAIN, glow = NO_GLOW): void {
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
    if (!geometry.index) geometry.setIndex(sequence(geometry.getAttribute('position').count));
    if (matrix) geometry.applyMatrix4(matrix);
    const n = geometry.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    const surfaces = new Float32Array(n * 3);
    const glows = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      color.toArray(colors, k * 3);
      surfaces[k * 3] = surface.tint;
      surfaces[k * 3 + 1] = surface.glass;
      surfaces[k * 3 + 2] = surface.flash;
      glow.toArray(glows, k * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSurface', new THREE.BufferAttribute(surfaces, 3));
    geometry.setAttribute('aGlow', new THREE.BufferAttribute(glows, 3));
    this.list.push(geometry);
  }

  /** Caja de medidas (sx, sy, sz) en `matrix`. */
  box(sx: number, sy: number, sz: number, color: THREE.Color, matrix: THREE.Matrix4, surface = PLAIN, glow = NO_GLOW): void {
    this.add(new THREE.BoxGeometry(sx, sy, sz), color, matrix, surface, glow);
  }

  /** Barra cilíndrica de radio r entre a y b (en el marco de `frame`, si se da). */
  strut(a: THREE.Vector3, b: THREE.Vector3, r: number, sides: number, color: THREE.Color, frame: THREE.Matrix4 | null = null): void {
    const d = _v.subVectors(b, a);
    const length = d.length();
    if (length < 1e-6) return;
    _q.setFromUnitVectors(_y, d.divideScalar(length));
    const matrix = new THREE.Matrix4().compose(_w.addVectors(a, b).multiplyScalar(0.5), _q, _s);
    if (frame) matrix.premultiply(frame);
    this.add(new THREE.CylinderGeometry(r, r, length, sides, 1, true), color, matrix);
  }

  /**
   * Losa de seis caras con esquinas dadas (0–3 abajo y 4–7 arriba, en el mismo orden): las
   * paredes del andén van oblicuas cuando la línea cruza la fachada en diagonal. Las caras que
   * miran hacia `inside` llevan `color`; las de afuera, `outside` (lo que asome del edificio se ve
   * como el revestimiento de la estación).
   */
  slab(corners: THREE.Vector3[], color: THREE.Color, inside: THREE.Vector3, outside: THREE.Color): void {
    const faces = [
      [0, 1, 2, 3],
      [4, 7, 6, 5],
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ];
    const center = new THREE.Vector3();
    for (const c of corners) center.add(c);
    center.divideScalar(corners.length);
    const n = new THREE.Vector3();
    const mid = new THREE.Vector3();
    for (const face of faces) {
      const [a, b, c, d] = face.map((k) => corners[k]);
      n.subVectors(c, a).cross(_v.subVectors(d, b)).normalize();
      mid.copy(a).add(b).add(c).add(d).multiplyScalar(0.25);
      // Hacia afuera de la losa, sea cual sea el orden de las esquinas.
      const quad = n.dot(_w.subVectors(mid, center)) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      if (n.dot(_w) < 0) n.negate();
      const positions: number[] = [];
      const normals: number[] = [];
      for (const p of quad) {
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      this.add(geometry, n.dot(_w.subVectors(inside, mid)) > 0 ? color : outside, null);
    }
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  merge(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list);
    if (!merged) throw new Error('No se pudo armar la geometría del teleférico');
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Traslación a (x, y, z) dentro de `frame` (o en el mundo). */
function at(x: number, y: number, z: number, frame: THREE.Matrix4 | null = null): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(x, y, z);
  return frame ? m.premultiply(frame) : m;
}

/**
 * Material de torres, estaciones y cabinas: color por vértice; en las cabinas, las piezas con
 * aSurface.x toman el color de la instancia (blanca o azul) y las de vidrio (aSurface.y) son más
 * lisas. De noche suma la luz propia de cada pieza (aGlow: la cabina encendida por dentro, la boca
 * de una estación) y las balizas destellan con `beacon` (aSurface.z). `uLightsOn` lo declara la
 * luz de noche (withNightLight), que siempre va encadenada.
 */
function createAerialMaterial(
  roughness: number,
  metalness: number,
  glass: THREE.Vector2,
  beacon: { value: number },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  const uniforms = { uAerialGlass: { value: glass }, uBeaconOn: beacon };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aSurface;
attribute vec3 aGlow;
varying vec3 vSurface;
varying vec3 vGlow;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix( color, color * instanceColor.rgb, aSurface.x );
#endif
vSurface = aSurface;
vGlow = aGlow;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec2 uAerialGlass;
uniform float uBeaconOn;
varying vec3 vSurface;
varying vec3 vGlow;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, uAerialGlass.x, vSurface.y );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, uAerialGlass.y, vSurface.y );')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vGlow * ( uLightsOn * mix( 1.0, uBeaconOn, vSurface.z ) );`,
      );
  };
  material.customProgramCacheKey = () => 'gye-aerial-v1';
  withNightLight(material);
  return material;
}

/**
 * Material de los cables: una cinta de frente a la cámara del grosor real del cable o, si en
 * pantalla sería más fina que `minPixels`, de ese ancho y más transparente (la parte del píxel que
 * de verdad cubre): de lejos se ve como una línea fina que se desvanece, sin parpadear. La luz la
 * toma como un cilindro (normal del centro hacia los bordes de la cinta).
 */
function createCableMaterial(cfg: AerialConfig['cable']): { material: THREE.MeshStandardMaterial; uniform: THREE.Vector4 } {
  const material = new THREE.MeshStandardMaterial({
    color: cfg.color,
    roughness: cfg.roughness,
    metalness: cfg.metalness,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Radio (m), medio ancho mínimo (px), píxeles por metro a 1 m (se actualiza con la cámara).
  const uniform = new THREE.Vector4(cfg.radius, cfg.minPixels / 2, 1, 0);
  const uniforms = { uCable: { value: uniform } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aTangent;
attribute float aSide;
uniform vec4 uCable;
varying float vCableSide;
varying float vCableCover;
varying vec3 vCableAcross;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  // La malla está en el origen del mundo: position ya es el punto del eje del cable.
  vec3 toCamera = cameraPosition - position;
  float dist = length( toCamera );
  vec3 across = cross( aTangent, toCamera );
  float len = length( across );
  across = len > 1e-4 * dist ? across / len : normalize( cross( aTangent, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4, 0.0, 0.0 ) );
  float radius = max( uCable.x, uCable.y * dist / uCable.z );
  vCableCover = uCable.x / radius;
  vCableSide = aSide;
  vCableAcross = normalize( ( viewMatrix * vec4( across, 0.0 ) ).xyz );
  transformed = position + across * ( aSide * radius );
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vCableSide;
varying float vCableCover;
varying vec3 vCableAcross;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
{
  float u = clamp( vCableSide, -1.0, 1.0 );
  normal = normalize( vCableAcross * u + normalize( vViewPosition ) * sqrt( max( 1.0 - u * u, 0.0 ) ) );
}`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vCableCover;');
  };
  material.customProgramCacheKey = () => 'gye-aerial-cable-v1';
  return { material, uniform };
}

/** Recorrido de las cabinas de una línea, muestreado cada `step` m (ver buildLoop). */
interface Loop {
  line: AerialLine;
  kind: KindConfig;
  length: number;
  step: number;
  count: number;
  /** Posición de la pinza (x, y, z) y rumbo en planta (x, z) en cada muestra. */
  pos: Float32Array;
  dir: Float32Array;
  /** Velocidad (m/s), aceleración a lo largo (m/s²) y curvatura hacia afuera (1/m). */
  speed: Float32Array;
  along: Float32Array;
  curve: Float32Array;
  /** Segundos por vuelta y arco (m) recorrido a cada `timeStep` s desde el inicio. */
  period: number;
  timeStep: number;
  sAt: Float32Array;
  /** Arco (m) donde el bucle pasa por una torre (ordenados). */
  towers: Float32Array;
  headway: number;
  cabins: number;
  /** Velocidad de línea usada (m/s) y segundos de punta a punta (con las paradas). */
  lineSpeed: number;
  oneWay: number;
}

/**
 * Bucle de las cabinas de una línea: la ida a un lado del eje (`rightHand`: a la derecha del
 * sentido de avance), media vuelta en la terminal del final, la vuelta del otro lado y media vuelta
 * en la del principio, a `gauge` / 2 del eje. Entre apoyos, la catenaria del cable (parábola de
 * flecha L² / 8·catenary, la misma con la que el pipeline calculó las torres); dentro de una
 * estación, plano a la altura del cable y, si la línea gira ahí (Julián Coronel, la técnica), con
 * una curva de `turnRadius` m. En cada estación las cabinas se sueltan del cable: frenan hasta
 * `stopSpeed` (`technicalSpeed` en la técnica) con `accel` m/s² y aceleran de nuevo al salir.
 */
function buildLoop(line: AerialLine, kind: KindConfig, cfg: AerialConfig): Loop {
  const pc = cfg.path;
  const pts = line.points.map(([k, x, z, , cable]) => ({ k, x, z, cable }));
  const n = pts.length;
  const half = line.gauge / 2;
  const side = cfg.rightHand ? 1 : -1;
  const minTurn = THREE.MathUtils.degToRad(pc.minTurnDeg);

  // Curva de cada estación intermedia donde la línea gira: tangentes A y B, centro, radio, arco.
  const fillets = pts.map((p, i) => {
    if (p.k !== POINT.station || i === 0 || i === n - 1) return null;
    const a = pts[i - 1];
    const b = pts[i + 1];
    const li = Math.hypot(p.x - a.x, p.z - a.z);
    const lo = Math.hypot(b.x - p.x, b.z - p.z);
    if (li < 1e-6 || lo < 1e-6) return null;
    const ix = (p.x - a.x) / li;
    const iz = (p.z - a.z) / li;
    const ox = (b.x - p.x) / lo;
    const oz = (b.z - p.z) / lo;
    const turn = Math.acos(THREE.MathUtils.clamp(ix * ox + iz * oz, -1, 1));
    if (turn < minTurn) return null;
    const tan = Math.tan(turn / 2);
    const t = Math.min(kind.turnRadius * tan, pc.filletShare * Math.min(li, lo));
    const r = t / tan;
    const ax = p.x - ix * t;
    const az = p.z - iz * t;
    // Derecha de la entrada: (−iz, ix). El centro queda del lado al que gira.
    const toward = -iz * ox + ix * oz > 0 ? 1 : -1;
    const cx = ax - iz * r * toward;
    const cz = az + ix * r * toward;
    const a0 = Math.atan2(az - cz, ax - cx);
    let sweep = Math.atan2(p.z + oz * t - cz, p.x + ox * t - cx) - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    return { ax, az, bx: p.x + ox * t, bz: p.z + oz * t, cx, cz, r, a0, sweep };
  });

  // Eje denso (x, y, z) y en qué muestra queda cada punto de la línea.
  const ex: number[] = [];
  const ey: number[] = [];
  const ez: number[] = [];
  const mark = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const fa = fillets[i];
    const fb = fillets[i + 1];
    const sx = fa ? fa.bx : a.x;
    const sz = fa ? fa.bz : a.z;
    const tx = fb ? fb.ax : b.x;
    const tz = fb ? fb.az : b.z;
    if (!fa) mark[i] = ex.length;
    const span = a.k !== POINT.station && b.k !== POINT.station;
    const full = Math.hypot(b.x - a.x, b.z - a.z);
    const straight = Math.hypot(tx - sx, tz - sz);
    const steps = Math.max(1, Math.ceil(straight / (span ? pc.spanStep : pc.step)));
    const sag = span ? (full * full) / (8 * line.catenary) : 0;
    for (let s = 0; s < steps; s++) {
      const x = sx + ((tx - sx) * s) / steps;
      const z = sz + ((tz - sz) * s) / steps;
      const t = full > 0 ? Math.hypot(x - a.x, z - a.z) / full : 0;
      ex.push(x);
      ey.push(a.cable + (b.cable - a.cable) * t - 4 * sag * t * (1 - t));
      ez.push(z);
    }
    if (fb) {
      const m = Math.max(2, Math.ceil((fb.r * Math.abs(fb.sweep)) / pc.arcStep));
      for (let s = 0; s < m; s++) {
        if (s === m >> 1) mark[i + 1] = ex.length;
        const angle = fb.a0 + (fb.sweep * s) / m;
        ex.push(fb.cx + Math.cos(angle) * fb.r);
        ey.push(b.cable);
        ez.push(fb.cz + Math.sin(angle) * fb.r);
      }
    }
  }
  mark[n - 1] = ex.length;
  ex.push(pts[n - 1].x);
  ey.push(pts[n - 1].cable);
  ez.push(pts[n - 1].z);

  // Desplazamiento hacia cada lado (inglete en los quiebres de las torres).
  const m = ex.length;
  const nx = new Float64Array(m);
  const nz = new Float64Array(m);
  let lastX = 0;
  let lastZ = 1;
  const segNormal = (k: number): [number, number] => {
    const dx = ex[k + 1] - ex[k];
    const dz = ez[k + 1] - ez[k];
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) {
      lastX = -dz / l;
      lastZ = dx / l;
    }
    return [lastX, lastZ];
  };
  for (let k = 0; k < m; k++) {
    const [n1x, n1z] = segNormal(Math.max(k - 1, 0));
    const [n2x, n2z] = segNormal(Math.min(k, m - 2));
    let mx = n1x + n2x;
    let mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const scale = 1 / Math.max(mx * n2x + mz * n2z, 1 / pc.miterLimit);
    nx[k] = mx * scale * half * side;
    nz[k] = mz * scale * half * side;
  }

  // Bucle: ida, media vuelta final, vuelta y media vuelta inicial.
  const lx: number[] = [];
  const ly: number[] = [];
  const lz: number[] = [];
  const uTurn = (k: number, dx: number, dz: number): number => {
    const l = Math.hypot(dx, dz) || 1;
    const fx = dx / l;
    const fz = dz / l;
    const rx = -fz * side;
    const rz = fx * side;
    const steps = Math.max(2, Math.ceil((Math.PI * half) / pc.arcStep));
    for (let s = 1; s < steps; s++) {
      const phi = (Math.PI * s) / steps;
      lx.push(ex[k] + half * (rx * Math.cos(phi) + fx * Math.sin(phi)));
      ly.push(ey[k]);
      lz.push(ez[k] + half * (rz * Math.cos(phi) + fz * Math.sin(phi)));
    }
    return steps - 1;
  };
  for (let k = 0; k < m; k++) {
    lx.push(ex[k] + nx[k]);
    ly.push(ey[k]);
    lz.push(ez[k] + nz[k]);
  }
  const endTurn = uTurn(m - 1, ex[m - 1] - ex[m - 2], ez[m - 1] - ez[m - 2]);
  for (let k = m - 1; k >= 0; k--) {
    lx.push(ex[k] - nx[k]);
    ly.push(ey[k]);
    lz.push(ez[k] - nz[k]);
  }
  uTurn(0, ex[0] - ex[1], ez[0] - ez[1]);

  const count0 = lx.length;
  const arc = new Float64Array(count0 + 1);
  for (let k = 1; k <= count0; k++) {
    const j = k % count0;
    arc[k] = arc[k - 1] + Math.hypot(lx[j] - lx[k - 1], ly[j] - ly[k - 1], lz[j] - lz[k - 1]);
  }
  const length = arc[count0];
  const onA = (i: number): number => arc[mark[i]];
  const onB = (i: number): number => arc[m + endTurn + (m - 1 - mark[i])];

  // Remuestreo uniforme.
  const count = Math.max(pc.minSamples, Math.round(length / pc.step));
  const step = length / count;
  const pos = new Float32Array(count * 3);
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const s = j * step;
    while (seg < count0 - 1 && arc[seg + 1] <= s) seg++;
    const next = (seg + 1) % count0;
    const u = (s - arc[seg]) / Math.max(arc[seg + 1] - arc[seg], 1e-9);
    pos[j * 3] = lx[seg] + (lx[next] - lx[seg]) * u;
    pos[j * 3 + 1] = ly[seg] + (ly[next] - ly[seg]) * u;
    pos[j * 3 + 2] = lz[seg] + (lz[next] - lz[seg]) * u;
  }
  const dir = new Float32Array(count * 2);
  for (let j = 0; j < count; j++) {
    const a = ((j - 1 + count) % count) * 3;
    const b = ((j + 1) % count) * 3;
    const dx = pos[b] - pos[a];
    const dz = pos[b + 2] - pos[a + 2];
    const l = Math.hypot(dx, dz) || 1;
    dir[j * 2] = dx / l;
    dir[j * 2 + 1] = dz / l;
  }
  // Curvatura hacia afuera (el lado de la pinza): la cabina se abre hacia ahí en las curvas.
  const curve = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const a = ((j - 1 + count) % count) * 2;
    const b = ((j + 1) % count) * 2;
    const tx = dir[j * 2];
    const tz = dir[j * 2 + 1];
    curve[j] = (((dir[b] - dir[a]) * -tz + (dir[b + 1] - dir[a + 1]) * tx) * side) / (2 * step);
  }

  // Tramos lentos: cada paso por una estación, de boca a boca (en una terminal, con la media
  // vuelta; la del principio cruza el inicio del bucle).
  const zones: { a: number; len: number; v: number }[] = [];
  const zone = (a: number, b: number, v: number): void => {
    zones.push({ a, len: (((b - a) % length) + length) % length, v });
  };
  for (const st of line.stations) {
    const v = st.type === STATION.technical ? kind.technicalSpeed : kind.stopSpeed;
    const before = st.portals.map((p) => p[0]).filter((p) => p < st.point);
    const after = st.portals.map((p) => p[0]).filter((p) => p > st.point);
    if (st.point === n - 1 && before.length) zone(onA(before[0]), onB(before[0]), v);
    else if (st.point === 0 && after.length) zone(onB(after[0]), onA(after[0]), v);
    else if (before.length && after.length) {
      zone(onA(before[0]), onA(after[0]), v);
      zone(onB(after[0]), onB(before[0]), v);
    }
  }
  // Velocidad de cada muestra con la línea a V m/s, y el tiempo acumulado hasta cada una.
  const A = kind.accel;
  const speed = new Float32Array(count);
  const time = new Float64Array(count + 1);
  const run = (V: number): void => {
    for (let j = 0; j < count; j++) {
      const s = j * step;
      let v = V;
      for (const z of zones) {
        const e = (((s - z.a) % length) + length) % length;
        if (e > z.len) continue;
        // Frena desde la boca de entrada y acelera hasta la de salida (si no alcanza a llegar a
        // la velocidad del andén, se queda en la más baja a la que llega).
        const brake = Math.sqrt(Math.max(V * V - 2 * A * e, 0));
        const leave = Math.sqrt(Math.max(V * V - 2 * A * (z.len - e), 0));
        v = Math.min(v, Math.max(z.v, brake, leave));
      }
      speed[j] = v;
    }
    for (let j = 0; j < count; j++) time[j + 1] = time[j] + (2 * step) / (speed[j] + speed[(j + 1) % count]);
  };
  // De punta a punta: por la ida, del centro de la primera terminal al de la última.
  const arrive = Math.min(Math.round(onA(n - 1) / step), count);
  const oneWay = (): number => time[arrive];
  // Velocidad de operación: si OSM trae la duración del viaje, la que da ese tiempo (entre
  // `minSpeed` y `speed`, el máximo de diseño); si no, la de diseño.
  let lineSpeed = kind.speed;
  const target = line.duration && kind.matchDuration ? line.duration * 60 : 0;
  if (target > 0) {
    let lo = kind.minSpeed;
    let hi = kind.speed;
    run(hi);
    if (oneWay() < target) {
      run(lo);
      if (oneWay() > target) {
        for (let k = 0; k < pc.speedIterations; k++) {
          lineSpeed = (lo + hi) / 2;
          run(lineSpeed);
          if (oneWay() > target) lo = lineSpeed;
          else hi = lineSpeed;
        }
      } else lineSpeed = lo;
    }
  }
  run(lineSpeed);
  const along = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const a = speed[(j - 1 + count) % count];
    const b = speed[(j + 1) % count];
    along[j] = (b * b - a * a) / (4 * step);
  }

  // Y a la inversa: dónde va a cada instante.
  const period = time[count];
  const timeStep = pc.timeStep;
  const sAt = new Float32Array(Math.ceil(period / timeStep) + 2);
  let j = 0;
  for (let i = 0; i < sAt.length; i++) {
    const tau = Math.min(i * timeStep, period);
    while (j < count - 1 && time[j + 1] < tau) j++;
    sAt[i] = (j + (tau - time[j]) / Math.max(time[j + 1] - time[j], 1e-9)) * step;
  }

  const towers: number[] = [];
  pts.forEach((p, i) => {
    if (p.k === POINT.tower) towers.push(onA(i), onB(i));
  });
  towers.sort((a, b) => a - b);
  const cabins = Math.max(1, Math.round(period / kind.headway));
  return {
    line,
    kind,
    length,
    step,
    count,
    pos,
    dir,
    speed,
    along,
    curve,
    period,
    timeStep,
    sAt,
    towers: Float32Array.from(towers),
    headway: period / cabins,
    cabins,
    lineSpeed,
    oneWay: oneWay(),
  };
}

/** Cuántos valores de `sorted` son ≤ v. */
function upper(sorted: Float32Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Cabina: pinza, brazo curvo que rodea las poleas por afuera (+z) y la caja con esquinas
 * redondeadas, banda de vidrio polarizado alrededor de la mitad de arriba, estrías en el tercio
 * de abajo y faldón oscuro. El origen es la pinza sobre el cable; x = sentido de avance. Lejos,
 * solo la caja, la banda y una barra por brazo.
 */
function cabinGeometry(c: CabinConfig, near: boolean): THREE.BufferGeometry {
  const parts = new Parts();
  const white = new THREE.Color(1, 1, 1);
  const frame = new THREE.Color(c.colors.frame);
  const glass = new THREE.Color(c.colors.glass);
  const glow = new THREE.Color(c.glow.color).multiplyScalar(c.glow.intensity);
  const top = -c.hanger.drop;
  const bottom = top - c.height;
  const [g0, g1] = c.glass;
  const band = (g1 - g0) * c.height;
  const lip = c.lip * 2;
  const box = (x: number, y: number, z: number, r: number): THREE.BufferGeometry =>
    near ? new RoundedBoxGeometry(x, y, z, c.segments, Math.min(r, x / 2, y / 2, z / 2)) : new THREE.BoxGeometry(x, y, z);
  parts.add(box(c.length, c.height, c.width, c.corner), white, at(0, (top + bottom) / 2, 0), TINTED);
  parts.add(box(c.length + lip, band, c.width + lip, c.corner), glass, at(0, bottom + ((g0 + g1) / 2) * c.height, 0), GLASS, glow);
  if (!near) {
    parts.box(c.hanger.radius * 2, c.hanger.drop, c.hanger.radius * 2, frame, at(0, top / 2, c.hanger.reach / 2));
    return parts.merge();
  }
  // Parantes en las cuatro esquinas (del color de la cabina): la banda de vidrio queda en cuatro
  // paños, y la línea de la puerta a cada costado.
  const bandY = bottom + ((g0 + g1) / 2) * c.height;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pillar = new THREE.CylinderGeometry(c.corner + c.pillar, c.corner + c.pillar, band, c.pillarSides, 1, true);
      parts.add(pillar, white, at(sx * (c.length / 2 - c.corner), bandY, sz * (c.width / 2 - c.corner)), TINTED);
    }
  }
  const door = c.door;
  const doorShade = new THREE.Color(door.shade, door.shade, door.shade);
  parts.box(door.width, c.height - c.skirt.height, c.width + 2 * (c.lip + door.lip), doorShade, at(0, (top + bottom + c.skirt.height) / 2, 0), TINTED);
  const roof = c.roof;
  parts.add(box(c.length - 2 * roof.inset, roof.height * 2, c.width - 2 * roof.inset, roof.height), white, at(0, top, 0), TINTED);
  const ribs = c.ribs;
  const shade = new THREE.Color(ribs.shade, ribs.shade, ribs.shade);
  for (let k = 0; k < ribs.count; k++) {
    const y = bottom + (ribs.from + k * ribs.spacing) * c.height;
    parts.box(c.length + 2 * ribs.lip, ribs.height, c.width + 2 * ribs.lip, shade, at(0, y, 0), TINTED);
  }
  const sk = c.skirt;
  parts.box(c.length + 2 * sk.lip, sk.height, c.width + 2 * sk.lip, frame, at(0, bottom + sk.height / 2, 0));
  const h = c.hanger;
  const curve = new THREE.CatmullRomCurve3(h.path.map(([z, y]) => new THREE.Vector3(0, -y * h.drop, z * h.reach)));
  parts.add(new THREE.TubeGeometry(curve, h.segments, h.radius, h.sides, false), frame, null);
  const [mx, my, mz] = c.mount;
  parts.box(mx, my, mz, frame, at(0, top + my / 2, 0));
  const [gx, gy, gz] = c.grip.size;
  parts.box(gx, gy, gz, new THREE.Color(c.colors.grip), at(0, gy / 2 - c.grip.below, 0));
  return parts.merge();
}

/** Torre en el mundo: pie, altura del cable y de la punta, y el rumbo de la línea (x, z) ahí. */
interface TowerSite {
  x: number;
  z: number;
  ground: number;
  cable: number;
  top: number;
  dx: number;
  dz: number;
}

/**
 * Torre de la Aerovía (fotos de Commons): poste tubular de acero galvanizado en tramos con bridas,
 * escalera por afuera y, arriba, la cruceta con los trenes de poleas bajo cada cable, la
 * plataforma con baranda y el pórtico por encima de los cables. En tierra, sobre un dado de
 * hormigón; en el río, sobre un cabezal de pilotes con el marco de tubos que la protege de las
 * barcazas. Todo por debajo del paso de las cabinas: la cruceta queda entre el techo de la cabina
 * y el cable, y lo que sube por encima del cable va por dentro de las pinzas. Devuelve la altura de
 * la punta (donde va la baliza).
 */
function towerParts(parts: Parts, t: TowerSite, cfg: TowerConfig, gauge: number, waterLevel: number): number {
  const col = cfg.colors;
  const steel = new THREE.Color(col.steel);
  const dark = new THREE.Color(col.dark);
  const concrete = new THREE.Color(col.concrete);
  const half = gauge / 2;
  const hd = cfg.head;
  // Marco de la torre: x a lo largo de la línea, z hacia la derecha (el lado del cable de ida).
  const l = Math.hypot(t.dx, t.dz) || 1;
  _x.set(t.dx / l, 0, t.dz / l);
  _z.set(-t.dz / l, 0, t.dx / l);
  const frame = new THREE.Matrix4().makeBasis(_x, _y, _z).setPosition(t.x, 0, t.z);

  // Pie: dado en tierra; cabezal, pilotes y marco de defensa en el río.
  let foot: number;
  if (t.ground < waterLevel) {
    const rv = cfg.river;
    const [capSize, capRise] = rv.cap;
    foot = waterLevel + capRise;
    parts.box(capSize, foot - t.ground, capSize, concrete, at(0, (foot + t.ground) / 2, 0, frame));
    const pile = new THREE.Color(col.pile);
    const offs = rv.piles.offsets;
    const topY = waterLevel + rv.piles.rise;
    offs.forEach(([px, pz], k) => {
      parts.strut(new THREE.Vector3(px, t.ground, pz), new THREE.Vector3(px, topY, pz), rv.piles.radius, hd.sides, pile, frame);
      const [qx, qz] = offs[(k + 1) % offs.length];
      for (const level of rv.rails.levels) {
        const y = waterLevel + level;
        parts.strut(new THREE.Vector3(px, y, pz), new THREE.Vector3(qx, y, qz), rv.rails.radius, hd.sides, pile, frame);
      }
    });
  } else {
    const pl = cfg.plinth;
    foot = t.ground + pl.height;
    parts.box(pl.size, pl.height + pl.sink, pl.size, concrete, at(0, t.ground + (pl.height - pl.sink) / 2, 0, frame));
  }

  // Poste tubular: más grueso cuanto más alto (radios a `referenceHeight`), con sus bridas.
  const armY = t.cable - hd.armDrop;
  const mastTop = armY - hd.armHeight / 2;
  const height = Math.max(mastTop - foot, 1);
  const mc = cfg.mast;
  const scale = Math.pow(height / mc.referenceHeight, mc.exponent);
  const [r0, r1] = [mc.radius[0] * scale, mc.radius[1] * scale];
  parts.add(new THREE.CylinderGeometry(r1, r0, height, mc.sides, 1, true), steel, at(0, foot + height / 2, 0, frame));
  const [flangeOut, flangeTall] = mc.flange;
  for (let y = mc.flangeSpacing; y < height - mc.flangeSpacing / 2; y += mc.flangeSpacing) {
    const r = r0 + ((r1 - r0) * y) / height + flangeOut;
    parts.add(new THREE.CylinderGeometry(r, r, flangeTall, mc.sides, 1), steel, at(0, foot + y, 0, frame));
  }
  // Escalera por el lado de atrás (−x), siguiendo el afinado del poste.
  const ld = cfg.ladder;
  for (const s of [-1, 1]) {
    parts.strut(
      new THREE.Vector3(-(r0 + ld.offset), foot, (s * ld.width) / 2),
      new THREE.Vector3(-(r1 + ld.offset), mastTop, (s * ld.width) / 2),
      ld.rail,
      ld.sides,
      dark,
      frame,
    );
  }

  // Cruceta, riostras en V y los trenes de poleas bajo cada cable.
  const inner = half - hd.inboard;
  parts.box(hd.armDepth, hd.armHeight, inner * 2, steel, at(0, armY, 0, frame));
  const braceFoot = mastTop - hd.braceDrop;
  const bat = cfg.battery;
  const sheave = new THREE.Color(col.sheave);
  const axle = t.cable - bat.radius;
  const [plateTall, plateThick] = bat.plate;
  const plateOff = bat.thickness / 2 + bat.gap + plateThick / 2;
  const length = bat.pitch * bat.sheaves;
  for (const s of [-1, 1]) {
    parts.strut(
      new THREE.Vector3(0, braceFoot, s * r1 * hd.braceFoot),
      new THREE.Vector3(0, armY - hd.armHeight / 2, s * (inner - hd.braceInset)),
      hd.braceRadius,
      hd.sides,
      steel,
      frame,
    );
    // Soporte de la cruceta al tren de poleas.
    const stubZ = s * (inner + (half - plateOff - inner) / 2);
    parts.box(hd.stub, axle - armY, half - plateOff - inner + hd.stub, dark, at(0, (axle + armY) / 2, stubZ, frame));
    for (const p of [-1, 1]) {
      parts.box(length, plateTall, plateThick, dark, at(0, axle, s * half + p * plateOff, frame));
    }
    for (let k = 0; k < bat.sheaves; k++) {
      const x = (k - (bat.sheaves - 1) / 2) * bat.pitch;
      const g = new THREE.CylinderGeometry(bat.radius, bat.radius, bat.thickness, bat.sides);
      g.rotateX(Math.PI / 2);
      parts.add(g, sheave, at(x, axle, s * half, frame));
    }
  }
  // Plataforma con baranda sobre la cruceta.
  const pf = cfg.platform;
  const deck = armY + hd.armHeight / 2 + pf.thickness / 2;
  parts.box(pf.width, pf.thickness, inner * 2, new THREE.Color(col.grating), at(0, deck, 0, frame));
  for (const s of [-1, 1]) {
    parts.box(pf.rail, pf.rail, inner * 2, dark, at((s * pf.width) / 2, deck + pf.railHeight, 0, frame));
    parts.box(pf.rail, pf.railHeight, pf.rail, dark, at((s * pf.width) / 2, deck + pf.railHeight / 2, inner, frame));
    parts.box(pf.rail, pf.railHeight, pf.rail, dark, at((s * pf.width) / 2, deck + pf.railHeight / 2, -inner, frame));
  }
  // Pórtico sobre los cables: postes por dentro de las pinzas y viga de lado a lado.
  const gantry = t.cable + hd.gantryRise;
  for (const s of [-1, 1]) {
    parts.box(hd.post, gantry - armY, hd.post, steel, at(0, (gantry + armY) / 2, s * inner, frame));
  }
  parts.box(hd.beam, hd.beam, (half + hd.gantryOverhang) * 2, steel, at(0, gantry, 0, frame));
  // Pararrayos hasta la punta de la torre.
  const tip = Math.max(t.top, gantry + cfg.rod.min);
  const rod = cfg.rod;
  parts.add(new THREE.CylinderGeometry(rod.radius, rod.radius, tip - gantry, rod.sides, 1, true), steel, at(0, (tip + gantry) / 2, 0, frame));
  return tip;
}

/** Boca de una estación en la fachada de su edificio (ver portalShape). */
interface PortalSite {
  x: number;
  z: number;
  cable: number;
  /** Techo del edificio (m del mundo). */
  top: number;
  /** Normal de la fachada hacia afuera y rumbo de la línea al salir (x, z). */
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  /** Centro de la estación (donde dan la vuelta en una terminal) y distancia hasta él (m). */
  cx: number;
  cz: number;
  reach: number;
  terminal: boolean;
}

/** Medidas de una boca: marco de la fachada (x a lo largo, y arriba, z hacia afuera), medio ancho, piso y techo. */
interface PortalShape {
  frame: THREE.Matrix4;
  tx: number;
  tz: number;
  halfWidth: number;
  floor: number;
  ceiling: number;
}

/**
 * Tan ancha como el paso de las dos filas de cabinas (más si la línea cruza la fachada en
 * diagonal) y del piso de las cabinas a un poco sobre las pinzas, sin pasar del techo del edificio.
 */
function portalShape(p: PortalSite, cfg: AerialConfig, gauge: number): PortalShape {
  const pc = cfg.portal;
  const c = cfg.cabin;
  const slant = Math.max(Math.abs(p.dx * p.nx + p.dz * p.nz), Math.cos(THREE.MathUtils.degToRad(pc.maxSlantDeg)));
  _z.set(p.nx, 0, p.nz);
  _x.crossVectors(_y, _z);
  return {
    frame: new THREE.Matrix4().makeBasis(_x, _y, _z).setPosition(p.x, 0, p.z),
    tx: _x.x,
    tz: _x.z,
    halfWidth: (gauge / 2 + Math.max(c.length, c.width) / 2) / slant + pc.margin,
    floor: p.cable - c.hanger.drop - c.height - pc.floorGap,
    ceiling: Math.max(Math.min(p.cable + pc.top, p.top - pc.roofEdge), p.cable),
  };
}

/** Marco saliente del revestimiento claro alrededor de la boca (como en Julián Coronel). */
function portalParts(parts: Parts, shape: PortalShape, cfg: AerialConfig): void {
  const pc = cfg.portal;
  const { frame, halfWidth, floor, ceiling } = shape;
  const tall = ceiling - floor;
  const trim = new THREE.Color(pc.colors.frame);
  const out = pc.inset + pc.depth / 2;
  const f = pc.frame;
  parts.box(halfWidth * 2 + f * 2, f, pc.depth, trim, at(0, ceiling + f / 2, out, frame));
  parts.box(halfWidth * 2 + f * 2, f, pc.depth, trim, at(0, floor - f / 2, out, frame));
  for (const s of [-1, 1]) parts.box(f, tall, pc.depth, trim, at(s * (halfWidth + f / 2), floor + tall / 2, out, frame));
}

/**
 * El andén que se ve por la boca: piso, paredes, cielo raso con sus luces y los rieles por donde
 * ruedan las pinzas sueltas del cable, desde la boca hacia el centro de la estación (en una
 * terminal, hasta pasar la rueda donde dan la vuelta). Las paredes siguen la línea: si cruza la
 * fachada en diagonal, el andén es oblicuo. Va dentro del edificio de los datos: solo se ve por la
 * boca (ver la máscara en Aerialways).
 */
function hallParts(hall: Parts, p: PortalSite, shape: PortalShape, cfg: AerialConfig, gauge: number): void {
  const pc = cfg.portal;
  const hc = pc.hall;
  const half = gauge / 2;
  const col = hc.colors;
  const m = pc.inset + pc.maskGap;
  const ix = -p.dx;
  const iz = -p.dz;
  const depth = p.reach + m + (p.terminal ? half + cfg.cabin.length / 2 + hc.margin : hc.overlap);
  const ox = p.x + p.nx * m;
  const oz = p.z + p.nz * m;
  const hw = shape.halfWidth;
  const th = hc.slab;
  const { floor, ceiling } = shape;
  // Esquina en planta: `s` a lo largo de la fachada (−1…1) y `back` hacia adentro (0…1).
  const plan = (s: number, back: number, lateral = 0, deeper = 0): [number, number] => [
    ox + shape.tx * (hw * s + lateral) + ix * (depth * back + deeper),
    oz + shape.tz * (hw * s + lateral) + iz * (depth * back + deeper),
  ];
  const [ix0, iz0] = plan(0, 0.5);
  const inside = new THREE.Vector3(ix0, (floor + ceiling) / 2, iz0);
  const cladding = new THREE.Color(col.outside);
  const slab = (ring: [number, number][], y0: number, y1: number, color: string): void => {
    const corners = [...ring.map(([x, z]) => new THREE.Vector3(x, y0, z)), ...ring.map(([x, z]) => new THREE.Vector3(x, y1, z))];
    hall.slab(corners, new THREE.Color(color), inside, cladding);
  };
  const deck = [plan(-1, 0), plan(1, 0), plan(1, 1), plan(-1, 1)];
  slab(deck, floor - th, floor, col.floor);
  slab(deck, ceiling, ceiling + th, col.ceiling);
  slab([plan(-1, 0), plan(-1, 1), plan(-1, 1, -th), plan(-1, 0, -th)], floor - th, ceiling + th, col.wall);
  slab([plan(1, 0), plan(1, 1), plan(1, 1, th), plan(1, 0, th)], floor - th, ceiling + th, col.wall);
  slab([plan(-1, 1), plan(1, 1), plan(1, 1, 0, th), plan(-1, 1, 0, th)], floor - th, ceiling + th, col.back);

  // Luces del cielo raso y rieles sobre cada fila de cabinas, a lo largo de la línea.
  _x.set(ix, 0, iz);
  _z.crossVectors(_x, _y);
  const along = new THREE.Matrix4().makeBasis(_x, _y, _z);
  const run = p.reach - (p.terminal ? half : 0);
  const glow = new THREE.Color(hc.glow.color).multiplyScalar(hc.glow.intensity);
  const [stripW, stripH] = hc.strip;
  const [railW, railH] = hc.rail;
  const [lineW, lineH] = hc.edge;
  const cabinHalf = cfg.cabin.width / 2 + hc.edgeGap;
  for (const s of [-1, 1]) {
    const x = p.x + ix * (run / 2) + _z.x * half * s;
    const z = p.z + iz * (run / 2) + _z.z * half * s;
    hall.box(run, stripH, stripW, new THREE.Color(col.strip), at(x, ceiling - hc.stripDrop, z).multiply(along), PLAIN, glow);
    hall.box(run, railH, railW, new THREE.Color(col.rail), at(x, p.cable + hc.railRise, z).multiply(along));
    // Líneas amarillas a cada lado del paso de las cabinas (el borde del andén).
    for (const e of [-1, 1]) {
      const ex = x + _z.x * cabinHalf * e;
      const ez = z + _z.z * cabinHalf * e;
      hall.box(run, lineH, lineW, new THREE.Color(col.edge), at(ex, floor + lineH / 2, ez).multiply(along));
    }
  }
  // Eje de la rueda de la terminal, hasta el cielo raso.
  if (p.terminal) {
    const b = pc.bullwheel;
    const hubH = b.hub[1];
    hall.add(new THREE.CylinderGeometry(b.shaft, b.shaft, ceiling - p.cable - hubH / 2, b.sides), new THREE.Color(b.color), at(p.cx, (ceiling + p.cable + hubH / 2) / 2, p.cz));
    hall.add(new THREE.CylinderGeometry(b.plate, b.plate, th, b.sides), new THREE.Color(b.color), at(p.cx, ceiling - th / 2, p.cz));
  }
}

/** Máscara de la boca: solo escribe profundidad (ver Aerialways), en un plano delante de la fachada. */
function maskGeometry(shape: PortalShape, cfg: AerialConfig): THREE.BufferGeometry {
  const pc = cfg.portal;
  const tall = shape.ceiling - shape.floor;
  const geometry = new THREE.PlaneGeometry(shape.halfWidth * 2, tall);
  geometry.applyMatrix4(at(0, shape.floor + tall / 2, pc.inset + pc.maskGap, shape.frame));
  geometry.deleteAttribute('uv');
  return geometry;
}

/** Rueda de la terminal (horizontal, de radio `radius`: el cable da la vuelta por su llanta): llanta, rayos y cubo. */
function bullwheelGeometry(cfg: AerialConfig, radius: number): THREE.BufferGeometry {
  const b = cfg.portal.bullwheel;
  const parts = new Parts();
  const color = new THREE.Color(b.color);
  const rim = new THREE.TorusGeometry(radius, b.tube, b.sides, b.segments);
  rim.rotateX(Math.PI / 2);
  parts.add(rim, color, null);
  const [hubR, hubH] = b.hub;
  parts.add(new THREE.CylinderGeometry(hubR, hubR, hubH, b.hubSides), color, null);
  for (let k = 0; k < b.spokes; k++) {
    const a = (k / b.spokes) * Math.PI * 2;
    parts.strut(
      new THREE.Vector3(Math.cos(a) * hubR, 0, Math.sin(a) * hubR),
      new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius),
      b.spoke,
      b.sides,
      color,
    );
  }
  return parts.merge();
}

/** Estado de una cabina: su lugar en el bucle, su color y cómo se balancea (péndulo). */
interface Cabin {
  loop: Loop;
  /** Adelanto (s) respecto del reloj: cabinas separadas `headway` s. */
  offset: number;
  color: THREE.Color;
  s: number;
  pitch: number;
  pitchRate: number;
  roll: number;
  rollRate: number;
  phase: number;
}

/**
 * La Aerovía (y cualquier teleférico de OSM, paso `aerial`): torres con su altura real o la que
 * libra el gálibo, cables en catenaria y cabinas que recorren el bucle a la velocidad de la línea.
 *
 * Datos reales: 5 m/s de velocidad máxima de diseño (POMA); la de operación sale de los 17 min de
 * punta a punta (`aerialway:duration` de OSM, lo mismo que publica aeroviagye.com): ~4,6 m/s. Una
 * cabina cada ~15 s (El Universo; el pliego pedía 13,85 s en hora pico): ~68 m entre cabinas, como
 * en la foto satelital. Servicio de 05:30 a 21:30, cabinas de 10 plazas blancas y azules (los
 * colores de la ciudad) con la banda de vidrio polarizado, y torres tubulares galvanizadas; en el
 * río, sobre pilotes con marco de defensa.
 *
 * - Las torres y las bocas de las estaciones van en una sola malla (una llamada de dibujo); los dos
 *   cables, en otra (una cinta con el ancho mínimo de un píxel, ver createCableMaterial).
 * - Las cabinas son dos mallas instanciadas: cerca (a menos de `cabin.near` m, con sombra) la
 *   detallada; lejos, una caja con su banda de vidrio, hasta `cabin.far` m. Cada cuadro se calcula
 *   dónde va cada una (tabla de tiempo → arco del bucle, sin geometría nueva) y su balanceo: un
 *   péndulo empujado por los frenazos de las estaciones, las curvas, el viento y el golpe al pasar
 *   por las poleas de cada torre.
 * - De noche, las cabinas se encienden por dentro (y se ven de lejos como puntos de luz que se
 *   mueven) y las torres más altas llevan baliza roja con destellos sincronizados.
 */
export class Aerialways {
  readonly group = new THREE.Group();
  private readonly loops: Loop[];
  private readonly cabins: Cabin[] = [];
  private readonly nearMesh: THREE.InstancedMesh;
  private readonly farMesh: THREE.InstancedMesh;
  private readonly lights: THREE.Points;
  private readonly lightPositions: THREE.BufferAttribute;
  private readonly lightSize: THREE.Vector4;
  private readonly beacons: THREE.Points | null = null;
  private readonly beaconSize: THREE.Vector4 | null = null;
  private readonly cableUniform: THREE.Vector4;
  private readonly beaconOn = { value: 0 };
  private readonly structureMaterial: THREE.MeshStandardMaterial;
  /** Ruedas de las terminales de cada línea: centros (x, y, z) y giro (rad/s, el del cable). */
  private readonly wheels: { mesh: THREE.InstancedMesh; at: number[]; rate: number }[] = [];
  /** Pinza → centro de la cabina y → centro de sus ventanas (m), y radio que la envuelve (para recortar con la vista). */
  private readonly hang: number;
  private readonly lightDrop: number;
  private readonly radius: number;
  private clock = 0;

  private constructor(
    lines: AerialLine[],
    private readonly cfg: AerialConfig,
    waterLevel: number,
    fog: FogConfig,
    renderer: THREE.WebGLRenderer,
  ) {
    this.group.name = 'aerialways';
    const kinds = cfg.kinds as Record<string, KindConfig | undefined>;
    this.loops = lines.map((line) => {
      const kind = kinds[line.kind];
      if (!kind) throw new Error(`config/game.json → aerialways.kinds no tiene "${line.kind}" (línea ${line.name ?? '?'})`);
      return buildLoop(line, kind, cfg);
    });
    const c = cfg.cabin;
    this.hang = c.hanger.drop + c.height / 2;
    this.lightDrop = c.hanger.drop + c.height * (1 - (c.glass[0] + c.glass[1]) / 2);
    this.radius = Math.hypot(c.length / 2, this.hang + c.height / 2, c.width / 2 + c.hanger.reach);
    const hd = cfg.tower.head;
    if (hd.armDrop + hd.armHeight / 2 >= c.hanger.drop) {
      throw new Error('aerialways: la cruceta (tower.head.armDrop) choca con el techo de las cabinas (cabin.hanger.drop)');
    }

    // Torres y bocas de estación: una sola malla.
    const tc = cfg.tower;
    this.structureMaterial = createAerialMaterial(tc.roughness, tc.metalness, new THREE.Vector2(), this.beaconOn);
    const parts = new Parts();
    const hall = new Parts();
    const masks: THREE.BufferGeometry[] = [];
    const beaconAt: number[] = [];
    const lens = new THREE.Color(cfg.tower.colors.lens);
    const bc = cfg.tower.beacon;
    const beaconGlow = new THREE.Color(bc.color).multiplyScalar(bc.glow);
    for (const line of lines) {
      const pts = line.points;
      pts.forEach(([kind, x, z, ground, cable, top], i) => {
        if (kind !== POINT.tower) return;
        const a = pts[Math.max(i - 1, 0)];
        const b = pts[Math.min(i + 1, pts.length - 1)];
        const la = Math.hypot(x - a[1], z - a[2]) || 1;
        const lb = Math.hypot(b[1] - x, b[2] - z) || 1;
        const site: TowerSite = {
          x,
          z,
          ground,
          cable,
          top,
          dx: (x - a[1]) / la + (b[1] - x) / lb,
          dz: (z - a[2]) / la + (b[2] - z) / lb,
        };
        const tip = towerParts(parts, site, cfg.tower, line.gauge, waterLevel);
        if (tip - Math.max(ground, waterLevel) >= bc.minHeight) {
          const [around, rings] = bc.segments;
          parts.add(new THREE.SphereGeometry(bc.size / 2, around, rings), lens, at(x, tip + bc.size / 2, z), BEACON, beaconGlow);
          beaconAt.push(x, tip + bc.size / 2, z);
        }
      });
      // Bocas de las estaciones con edificio: marco, andén de adentro y máscara; y la rueda de
      // cada terminal.
      const turns: number[] = [];
      for (const st of line.stations) {
        if (st.top === null) continue;
        const center = pts[st.point];
        const terminal = st.type === STATION.terminal;
        let open = false;
        for (const [index, nx, nz, room] of st.portals) {
          if (room <= 0) continue;
          const p = pts[index];
          const reach = Math.hypot(p[1] - center[1], p[2] - center[2]) || 1;
          const site: PortalSite = {
            x: p[1],
            z: p[2],
            cable: p[4],
            top: st.top,
            nx,
            nz,
            dx: (p[1] - center[1]) / reach,
            dz: (p[2] - center[2]) / reach,
            cx: center[1],
            cz: center[2],
            reach,
            terminal,
          };
          const shape = portalShape(site, cfg, line.gauge);
          portalParts(parts, shape, cfg);
          hallParts(hall, site, shape, cfg, line.gauge);
          masks.push(maskGeometry(shape, cfg));
          open = true;
        }
        if (terminal && open) turns.push(center[1], center[4], center[2]);
      }
      if (turns.length) {
        const wheels = new THREE.InstancedMesh(bullwheelGeometry(cfg, line.gauge / 2), this.structureMaterial, turns.length / 3);
        wheels.name = 'aerial-bullwheels';
        wheels.renderOrder = BEHIND_MASK;
        wheels.receiveShadow = true;
        wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(wheels);
        const loop = this.loops[lines.indexOf(line)];
        this.wheels.push({ mesh: wheels, at: turns, rate: ((cfg.rightHand ? 1 : -1) * loop.kind.speed) / (line.gauge / 2) });
      }
    }
    const structure = new THREE.Mesh(parts.merge(), this.structureMaterial);
    structure.name = 'aerial-structures';
    structure.castShadow = true;
    structure.receiveShadow = true;
    this.group.add(structure);
    // Andenes y máscaras de las bocas. Los andenes (y las cabinas) se dibujan antes que todo lo
    // demás; después, cada máscara escribe la profundidad de su boca sin pintar nada: el edificio
    // de los datos, que se dibuja más tarde, no tapa la boca y se ve el andén con las cabinas.
    if (!hall.empty) {
      const hc = cfg.portal.hall;
      const hallMaterial = createAerialMaterial(hc.roughness, hc.metalness, new THREE.Vector2(), this.beaconOn);
      const hallMesh = new THREE.Mesh(hall.merge(), hallMaterial);
      hallMesh.name = 'aerial-halls';
      hallMesh.renderOrder = BEHIND_MASK;
      hallMesh.receiveShadow = true;
      this.group.add(hallMesh);
      const maskGeometryAll = mergeGeometries(masks);
      if (!maskGeometryAll) throw new Error('No se pudieron unir las bocas de las estaciones');
      for (const g of masks) g.dispose();
      const mask = new THREE.Mesh(maskGeometryAll, new THREE.MeshBasicMaterial({ colorWrite: false }));
      mask.name = 'aerial-portal-masks';
      mask.renderOrder = MASK;
      this.group.add(mask);
    }

    // Cables: el bucle de cada línea, como cinta cerrada.
    const cable = createCableMaterial(cfg.cable);
    this.cableUniform = cable.uniform;
    const cableMesh = new THREE.Mesh(this.cableGeometry(), cable.material);
    cableMesh.name = 'aerial-cables';
    this.group.add(cableMesh);

    // Cabinas.
    const glass = new THREE.Vector2(c.glassRoughness, c.glassMetalness);
    const material = createAerialMaterial(c.roughness, c.metalness, glass, this.beaconOn);
    const palette = c.palette.map((p) => ({ color: new THREE.Color(p.color), weight: p.weight }));
    const total = palette.reduce((sum, p) => sum + p.weight, 0);
    this.loops.forEach((loop, li) => {
      for (let k = 0; k < loop.cabins; k++) {
        let r = hash01(k, li) * total;
        const pick = palette.find((p) => (r -= p.weight) < 0) ?? palette[palette.length - 1];
        const offset = k * loop.headway;
        this.cabins.push({
          loop,
          offset,
          color: pick.color,
          s: this.arcAt(loop, offset),
          pitch: 0,
          pitchRate: 0,
          roll: 0,
          rollRate: 0,
          phase: hash01(li, k) * Math.PI * 2,
        });
      }
    });
    const capacity = this.cabins.length;
    const mesh = (geometry: THREE.BufferGeometry, name: string, shadow: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geometry, material, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.renderOrder = BEHIND_MASK;
      m.name = name;
      this.group.add(m);
      return m;
    };
    this.nearMesh = mesh(cabinGeometry(c, true), 'aerial-cabins-near', true);
    this.farMesh = mesh(cabinGeometry(c, false), 'aerial-cabins-far', false);

    // Luces de noche: cada cabina encendida y las balizas, como halos.
    const hc = cfg.halos;
    const lightGeometry = new THREE.BufferGeometry();
    this.lightPositions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    lightGeometry.setAttribute('position', this.lightPositions);
    const tint = new THREE.Color(c.glow.color).multiplyScalar(hc.cabin.intensity);
    const tints = new Float32Array(capacity * 3);
    for (let k = 0; k < capacity; k++) tint.toArray(tints, k * 3);
    lightGeometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    lightGeometry.setDrawRange(0, 0);
    const lightMaterial = createHaloMaterial(hc.cabin, fog, renderer);
    this.lightSize = lightMaterial.uniforms.uHalo.value as THREE.Vector4;
    this.lights = new THREE.Points(lightGeometry, lightMaterial);
    this.lights.name = 'aerial-cabin-lights';
    this.lights.frustumCulled = false;
    this.lights.visible = false;
    this.group.add(this.lights);
    if (beaconAt.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(beaconAt, 3));
      const red = new THREE.Color(bc.color).multiplyScalar(hc.beacon.intensity);
      const reds = new Float32Array(beaconAt.length);
      for (let k = 0; k < beaconAt.length / 3; k++) red.toArray(reds, k * 3);
      geometry.setAttribute('tint', new THREE.BufferAttribute(reds, 3));
      const haloMaterial = createHaloMaterial(hc.beacon, fog, renderer);
      this.beaconSize = haloMaterial.uniforms.uHalo.value as THREE.Vector4;
      this.beacons = new THREE.Points(geometry, haloMaterial);
      this.beacons.name = 'aerial-beacons';
      this.beacons.frustumCulled = false;
      this.beacons.visible = false;
      this.group.add(this.beacons);
    }
  }

  static async load(
    manifest: WorldManifest,
    cfg: AerialConfig,
    fog: FogConfig,
    renderer: THREE.WebGLRenderer,
  ): Promise<Aerialways | null> {
    const lines = manifest.aerialways?.lines ?? [];
    if (!lines.length) return null;
    return new Aerialways(lines, cfg, manifest.waterLevel, fog, renderer);
  }

  /** Para depurar: cabinas en el bucle y dibujadas, vuelta y viaje de punta a punta (s). */
  get stats(): {
    cabins: number;
    near: number;
    far: number;
    loops: { period: number; length: number; cabins: number; headway: number; speed: number; oneWay: number }[];
  } {
    return {
      cabins: this.cabins.length,
      near: this.nearMesh.count,
      far: this.farMesh.count,
      loops: this.loops.map((l) => ({
        period: l.period,
        length: l.length,
        cabins: l.cabins,
        headway: l.headway,
        speed: l.lineSpeed,
        oneWay: l.oneWay,
      })),
    };
  }

  /** Cada cuadro: dónde va cada cabina y cómo se balancea, qué se dibuja y las luces de noche. */
  update(dt: number, hours: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    const cfg = this.cfg;
    this.clock += dt;
    const on = nightLight.uLightsOn.value > 0;
    const pixels = haloPixels(camera, renderer);
    this.cableUniform.z = pixels;
    const flash = cfg.tower.beacon.flash;
    const lit = this.clock % flash.period < flash.on;
    this.beaconOn.value = lit ? 1 : 0;
    if (this.beacons && this.beaconSize) {
      this.beacons.visible = on && lit;
      this.beaconSize.w = pixels;
    }
    this.lightSize.w = pixels;
    const running = hours >= cfg.service.open && hours < cfg.service.close;
    for (const w of this.wheels) {
      // El cable no para en las estaciones: la rueda gira siempre a la velocidad de la línea.
      _q.setFromAxisAngle(_y, running ? this.clock * w.rate : 0);
      for (let k = 0; k < w.at.length / 3; k++) {
        w.mesh.setMatrixAt(k, _m.compose(_v.fromArray(w.at, k * 3), _q, _s));
      }
      w.mesh.instanceMatrix.needsUpdate = true;
    }

    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const c = cfg.cabin;
    const near2 = c.near * c.near;
    const far2 = c.far * c.far;
    const cam = camera.position;
    const side = cfg.rightHand ? 1 : -1;
    const sw = cfg.sway;
    const maxAngle = THREE.MathUtils.degToRad(sw.maxDeg);
    const w2 = GRAVITY / this.hang;
    const steps = Math.max(1, Math.ceil(dt / sw.substep));
    const h = dt / steps;
    const { windPeriods, windShares, windPhases } = sw;
    const lights = this.lightPositions.array as Float32Array;
    let nNear = 0;
    let nFar = 0;
    let nLights = 0;
    for (const cab of this.cabins) {
      const loop = cab.loop;
      const s = this.arcAt(loop, this.clock + cab.offset);
      // Muestra del bucle: posición de la pinza, rumbo y lo que la empuja.
      const f = s / loop.step;
      const j0 = Math.floor(f) % loop.count;
      const j1 = (j0 + 1) % loop.count;
      const u = f - Math.floor(f);
      const px = loop.pos[j0 * 3] + (loop.pos[j1 * 3] - loop.pos[j0 * 3]) * u;
      const py = loop.pos[j0 * 3 + 1] + (loop.pos[j1 * 3 + 1] - loop.pos[j0 * 3 + 1]) * u;
      const pz = loop.pos[j0 * 3 + 2] + (loop.pos[j1 * 3 + 2] - loop.pos[j0 * 3 + 2]) * u;
      let tx = loop.dir[j0 * 2] + (loop.dir[j1 * 2] - loop.dir[j0 * 2]) * u;
      let tz = loop.dir[j0 * 2 + 1] + (loop.dir[j1 * 2 + 1] - loop.dir[j0 * 2 + 1]) * u;
      const tl = Math.hypot(tx, tz) || 1;
      tx = (tx / tl) * side;
      tz = (tz / tl) * side;
      const v = loop.speed[j0];
      // Aceleración de la pinza en el marco de la cabina: x adelante, z hacia afuera.
      const ax = loop.along[j0] * side;
      // Viento: suma de ondas (período, peso y desfase propio de cada cabina).
      let wind = 0;
      for (let k = 0; k < windPeriods.length; k++) {
        wind += windShares[k] * Math.sin((Math.PI * 2 * this.clock) / windPeriods[k] + windPhases[k] * cab.phase);
      }
      const az = v * v * loop.curve[j0] + sw.windAccel * wind;
      // Golpe al pasar por las poleas de una torre.
      const t = loop.towers;
      const passed = s >= cab.s ? upper(t, s) - upper(t, cab.s) : upper(t, s) + t.length - upper(t, cab.s);
      if (passed > 0) cab.pitchRate -= sw.towerKick;
      cab.s = s;
      for (let k = 0; k < steps; k++) {
        cab.pitchRate += (-w2 * Math.sin(cab.pitch) - (ax / this.hang) * Math.cos(cab.pitch) - sw.damping * cab.pitchRate) * h;
        cab.pitch = THREE.MathUtils.clamp(cab.pitch + cab.pitchRate * h, -maxAngle, maxAngle);
        cab.rollRate += (-w2 * Math.sin(cab.roll) + (az / this.hang) * Math.cos(cab.roll) - sw.damping * cab.rollRate) * h;
        cab.roll = THREE.MathUtils.clamp(cab.roll + cab.rollRate * h, -maxAngle, maxAngle);
      }
      if (!running) continue;

      // Orientación: base (adelante, arriba, afuera) por el cabeceo (eje z) y el alabeo (eje x).
      const ct = Math.cos(cab.pitch);
      const st = Math.sin(cab.pitch);
      const cp = Math.cos(cab.roll);
      const sp = Math.sin(cab.roll);
      const rx = -tz;
      const rz = tx;
      // Columnas: x' = X·cθ + Y·sθ; y' = −X·sθcφ + Y·cθcφ + Z·sφ; z' = X·sθsφ − Y·cθsφ + Z·cφ.
      const c0x = tx * ct;
      const c0y = st;
      const c0z = tz * ct;
      const c1x = -tx * st * cp + rx * sp;
      const c1y = ct * cp;
      const c1z = -tz * st * cp + rz * sp;
      const c2x = tx * st * sp + rx * cp;
      const c2y = -ct * sp;
      const c2z = tz * st * sp + rz * cp;
      const cx = px - c1x * this.hang;
      const cy = py - c1y * this.hang;
      const cz = pz - c1z * this.hang;
      const d2 = (cx - cam.x) ** 2 + (cy - cam.y) ** 2 + (cz - cam.z) ** 2;
      if (d2 > far2) continue;
      _sphere.center.set(cx, cy, cz);
      _sphere.radius = this.radius;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      const mesh = d2 < near2 ? this.nearMesh : this.farMesh;
      const slot = mesh === this.nearMesh ? nNear++ : nFar++;
      const e = mesh.instanceMatrix.array as Float32Array;
      const o = slot * 16;
      e[o] = c0x;
      e[o + 1] = c0y;
      e[o + 2] = c0z;
      e[o + 3] = 0;
      e[o + 4] = c1x;
      e[o + 5] = c1y;
      e[o + 6] = c1z;
      e[o + 7] = 0;
      e[o + 8] = c2x;
      e[o + 9] = c2y;
      e[o + 10] = c2z;
      e[o + 11] = 0;
      e[o + 12] = px;
      e[o + 13] = py;
      e[o + 14] = pz;
      e[o + 15] = 1;
      mesh.setColorAt(slot, cab.color);
      if (on) {
        lights[nLights * 3] = px - c1x * this.lightDrop;
        lights[nLights * 3 + 1] = py - c1y * this.lightDrop;
        lights[nLights * 3 + 2] = pz - c1z * this.lightDrop;
        nLights++;
      }
    }
    for (const [mesh, n] of [
      [this.nearMesh, nNear],
      [this.farMesh, nFar],
    ] as const) {
      mesh.count = n;
      if (n === 0) continue;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      const colors = mesh.instanceColor;
      if (colors) {
        colors.clearUpdateRanges();
        colors.addUpdateRange(0, n * 3);
        colors.needsUpdate = true;
      }
    }
    this.lights.visible = on && nLights > 0;
    this.lights.geometry.setDrawRange(0, nLights);
    if (nLights > 0) {
      this.lightPositions.clearUpdateRanges();
      this.lightPositions.addUpdateRange(0, nLights * 3);
      this.lightPositions.needsUpdate = true;
    }
  }

  /** Arco del bucle (m) donde va, en el instante `time` (s), una cabina que salió en 0. */
  private arcAt(loop: Loop, time: number): number {
    const tau = ((time % loop.period) + loop.period) % loop.period;
    const f = tau / loop.timeStep;
    const i = Math.min(Math.floor(f), loop.sAt.length - 2);
    const s = loop.sAt[i] + (loop.sAt[i + 1] - loop.sAt[i]) * (f - i);
    return Math.min(s, loop.length - 1e-6);
  }

  /** Los cables: el bucle de cada línea (cada `path.cableStep` m) como una cinta cerrada. */
  private cableGeometry(): THREE.BufferGeometry {
    const every = Math.max(1, Math.round(this.cfg.path.cableStep / this.cfg.path.step));
    const positions: number[] = [];
    const tangents: number[] = [];
    const sides: number[] = [];
    const index: number[] = [];
    for (const loop of this.loops) {
      const first = positions.length / 3;
      const n = Math.floor(loop.count / every);
      for (let i = 0; i < n; i++) {
        const j = i * every;
        const a = ((j - every + loop.count) % loop.count) * 3;
        const b = ((j + every) % loop.count) * 3;
        _v.set(loop.pos[b] - loop.pos[a], loop.pos[b + 1] - loop.pos[a + 1], loop.pos[b + 2] - loop.pos[a + 2]).normalize();
        for (const s of [-1, 1]) {
          positions.push(loop.pos[j * 3], loop.pos[j * 3 + 1], loop.pos[j * 3 + 2]);
          tangents.push(_v.x, _v.y, _v.z);
          sides.push(s);
        }
        const p = first + i * 2;
        const q = first + ((i + 1) % n) * 2;
        index.push(p, p + 1, q, q, p + 1, q + 1);
      }
    }
    // La normal la arma el shader (ver createCableMaterial); el atributo solo tiene que existir.
    const normals = new Float32Array(positions.length);
    for (let k = 1; k < normals.length; k += 3) normals[k] = 1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
    geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    return geometry;
  }
}
