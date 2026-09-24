import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig, WorldManifest } from '../core/types';
import { createHaloMaterial, haloPixels } from '../render/halos';
import { nightLight, withNightLight } from '../render/nightLight';
import type { DeckLamps } from './bridges';
import type { Heightmap } from './heightmap';
import type { GroundGrid, LampMessage, LampResult } from './lampWorker';

type LightsConfig = GameConfig['render']['lighting']['streetLights'];
type LampsInfo = NonNullable<WorldManifest['lamps']>;

/**
 * Formato de lamps.bin (pipeline/build_world.py → LAMP_DTYPE): por poste, x y z (int16, en
 * `unit` m), altura de la luz (uint8, en `heightUnit` m), banderas, brazo (uint8, vuelta
 * completa) y semilla. Posición de cada campo en bytes.
 */
const FIELD = { x: 0, z: 2, h: 4, flags: 5, arm: 6 } as const;
const ARM_STEPS = 256;

const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Postes en el marco local del mundo. */
export interface LampData {
  count: number;
  x: Float32Array;
  z: Float32Array;
  /** Suelo al pie del poste. */
  y: Float32Array;
  /** Altura de la luz sobre el suelo. */
  h: Float32Array;
  /** Dirección del brazo hacia la calle (rad, desde +x hacia +z). */
  arm: Float32Array;
  /** Color de la luminaria con luminancia 1 (sodio o LED); 0 = apagada. */
  tint: Float32Array;
  /**
   * 1 = sobre el tablero de un puente (world/bridges.ts): su luz no va a los mapas del suelo
   * (el tablero la tapa); el puente la guarda en sus vértices.
   */
  elevated: Uint8Array;
  /** 1 = se dibuja el poste de concreto; 0 = el farol lo dibuja otro (una calle modelada). */
  pole: Uint8Array;
}

/**
 * Luces de faroles que dibuja otro (las linternas de una calle modelada, world/street.ts): dónde
 * está cada luz, el suelo bajo ella, su alto sobre él, hacia dónde se estira (rad, desde +x hacia
 * +z), su potencia (1 = la de un poste) y si es LED (si no, sodio).
 */
export interface LanternLights {
  count: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  h: Float32Array;
  arm: Float32Array;
  power: Float32Array;
  led: Uint8Array;
}

/** Lo que las calles modeladas cambian del alumbrado: sus linternas, y dónde ya no van los postes de los datos. */
export interface ModeledLamps {
  lanterns: LanternLights;
  cleared(x: number, z: number): boolean;
}

function decode(
  buffer: ArrayBuffer,
  info: LampsInfo,
  heightmap: Heightmap,
  cfg: LightsConfig,
  deck: DeckLamps | null,
  modeled: ModeledLamps | null,
): LampData {
  if (buffer.byteLength !== info.count * info.stride) {
    throw new Error(`lamps.bin inválido: ${buffer.byteLength} bytes, se esperaban ${info.count * info.stride}`);
  }
  const view = new DataView(buffer);
  const xOf = (k: number): number => view.getInt16(k * info.stride + FIELD.x, true) * info.unit;
  const zOf = (k: number): number => view.getInt16(k * info.stride + FIELD.z, true) * info.unit;
  // Los postes de los datos, menos los que caen donde una calle modelada pone sus faroles.
  const kept: number[] = [];
  for (let k = 0; k < info.count; k++) if (!modeled?.cleared(xOf(k), zOf(k))) kept.push(k);
  const street = kept.length;
  const decks = deck?.count ?? 0;
  const lanterns = modeled?.lanterns;
  const count = street + decks + (lanterns?.count ?? 0);
  const sodium = new THREE.Color(cfg.sodium);
  sodium.multiplyScalar(1 / luminance(sodium));
  const led = new THREE.Color(cfg.led);
  led.multiplyScalar(1 / luminance(led));
  const data: LampData = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    y: new Float32Array(count),
    h: new Float32Array(count),
    arm: new Float32Array(count),
    tint: new Float32Array(count * 3),
    elevated: new Uint8Array(count),
    pole: new Uint8Array(count).fill(1),
  };
  const paint = (k: number, flags: number, power = 1): void => {
    if (flags & info.flags.dead) return;
    const c = flags & info.flags.led ? led : sodium;
    data.tint[k * 3] = c.r * power;
    data.tint[k * 3 + 1] = c.g * power;
    data.tint[k * 3 + 2] = c.b * power;
  };
  for (let k = 0; k < street; k++) {
    const o = kept[k] * info.stride;
    const x = xOf(kept[k]);
    const z = zOf(kept[k]);
    data.x[k] = x;
    data.z[k] = z;
    data.y[k] = heightmap.sample(x, z);
    data.h[k] = view.getUint8(o + FIELD.h) * info.heightUnit;
    data.arm[k] = (view.getUint8(o + FIELD.arm) / ARM_STEPS) * Math.PI * 2;
    paint(k, view.getUint8(o + FIELD.flags));
  }
  // Postes sobre los tableros de los puentes: su pie es el tablero, no el suelo. Los de los
  // muelles (a ras del suelo) alumbran el suelo como los de la calle.
  for (let d = 0; deck && d < deck.count; d++) {
    const k = street + d;
    data.x[k] = deck.x[d];
    data.z[k] = deck.z[d];
    data.y[k] = deck.y[d];
    data.h[k] = deck.h[d];
    data.arm[k] = deck.arm[d];
    data.elevated[k] = deck.ground[d] ? 0 : 1;
    paint(k, deck.flags[d]);
  }
  // Linternas: el poste (que no se dibuja) queda donde su luz cae justo en la linterna.
  for (let j = 0; lanterns && j < lanterns.count; j++) {
    const k = street + decks + j;
    const reach = cfg.armShare * lanterns.h[j];
    data.x[k] = lanterns.x[j] - Math.cos(lanterns.arm[j]) * reach;
    data.z[k] = lanterns.z[j] - Math.sin(lanterns.arm[j]) * reach;
    data.y[k] = lanterns.y[j];
    data.h[k] = lanterns.h[j];
    data.arm[k] = lanterns.arm[j];
    data.pole[k] = 0;
    paint(k, lanterns.led[j] ? info.flags.led : 0, lanterns.power[j]);
  }
  return data;
}

/** Poste de alumbrado de concreto con brazo y luminaria, a la altura de referencia (brazo hacia +x). */
function poleGeometry(cfg: LightsConfig): { body: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const p = cfg.poles;
  const H = p.referenceHeight;
  const reach = cfg.armShare * H;
  const colored = (g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry => {
    const geometry = g.index ? g.toNonIndexed() : g;
    const c = new THREE.Color(hex);
    const n = geometry.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) colors.set([c.r, c.g, c.b], k * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.deleteAttribute('uv');
    return geometry;
  };
  const shaftTop = H - p.arm.rise;
  const shaft = new THREE.CylinderGeometry(p.shaft.topRadius, p.shaft.baseRadius, shaftTop, p.shaft.segments, 1, false);
  shaft.translate(0, shaftTop / 2, 0);
  // Brazo: del tope del poste a la luminaria, subiendo un poco.
  const from = new THREE.Vector3(0, shaftTop, 0);
  const to = new THREE.Vector3(reach, H + p.head.size[1] / 2, 0);
  const armLength = from.distanceTo(to);
  const arm = new THREE.CylinderGeometry(p.arm.radius, p.arm.radius, armLength, p.arm.segments, 1, true);
  arm.translate(0, armLength / 2, 0);
  arm.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  arm.translate(from.x, from.y, from.z);
  const [hl, hh, hw] = p.head.size;
  const head = new THREE.BoxGeometry(hl, hh, hw).translate(reach, H + hh / 2, 0);
  const [ll, lh, lw] = p.lens.size;
  const lens = new THREE.BoxGeometry(ll, lh, lw).translate(reach, H - lh / 2, 0);
  lens.deleteAttribute('uv');
  const body = mergeGeometries([colored(shaft, p.shaft.color), colored(arm, p.arm.color), colored(head, p.head.color)]);
  if (!body) throw new Error('No se pudo armar el poste de alumbrado');
  body.computeBoundingSphere();
  return { body, lens };
}

/**
 * Alumbrado público: los postes que el pipeline puso a lo largo de las calles reales (sodio
 * naranja y LED blanco en las avenidas nuevas), con
 * - la luz que dejan en el suelo, los muros, los árboles y el personaje: un worker la pinta en
 *   un mapa fino alrededor del jugador y otro grueso de toda la ciudad (render/nightLight.ts);
 * - los postes en 3D cerca del jugador (de día también), con la luminaria encendida de noche;
 * - un halo por lámpara, que de lejos es el punto de luz de la ciudad vista desde el aire.
 */
export class StreetLamps {
  readonly group = new THREE.Group();
  private readonly worker: Worker;
  private readonly nearTexture: THREE.DataTexture;
  private readonly regionTexture: THREE.DataTexture;
  private nextId = 1;
  private regionId = 0;
  private readonly regionSize = new THREE.Vector2();
  /** Pedido del mapa fino en curso (0 = ninguno) y su cuadrado. */
  private nearPending = 0;
  private readonly nearAsked = new THREE.Vector2(Infinity, Infinity);
  private readonly nearRect = new THREE.Vector4();
  private readonly cells = new Map<number, number[]>();
  private readonly cellCols: number;
  private readonly poleCenter = new THREE.Vector2(Infinity, Infinity);
  private readonly poles: THREE.InstancedMesh;
  private readonly lenses: THREE.InstancedMesh;
  private readonly lensTint: THREE.InstancedBufferAttribute;
  private readonly halos: THREE.Points;
  private readonly haloSize: THREE.Vector4;

  private constructor(
    private readonly lamps: LampData,
    private readonly heightmap: Heightmap,
    private readonly chunks: WorldManifest['chunks'],
    private readonly cfg: LightsConfig,
    fog: GameConfig['render']['fog'],
    renderer: THREE.WebGLRenderer,
  ) {
    this.group.name = 'street-lamps';
    const n = lamps.count;

    // Luz de cada poste para el worker: I = luz bajo la lámpara · h² (E = I / h² justo debajo).
    const color = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      // Los de los puentes no alumbran el suelo (el tablero los tapa): quedan en negro.
      const intensity = lamps.elevated[k] ? 0 : cfg.underLamp * lamps.h[k] * lamps.h[k];
      for (let c = 0; c < 3; c++) color[k * 3 + c] = lamps.tint[k * 3 + c] * intensity;
    }
    this.worker = new Worker(new URL('./lampWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<LampResult>) => this.receive(event.data);
    this.worker.onerror = (event) => console.error('[lamps] worker', event.message);
    const setup: LampMessage = {
      type: 'setup',
      x: lamps.x.slice(),
      z: lamps.z.slice(),
      y: lamps.y.slice(),
      h: lamps.h.slice(),
      arm: lamps.arm.slice(),
      color,
      armShare: cfg.armShare,
      stretch: cfg.stretch,
      reach: cfg.reach,
      falloff: cfg.falloff,
      minHeight: cfg.minHeight,
      maxIrradiance: cfg.maxIrradiance,
    };
    this.worker.postMessage(setup, [setup.x.buffer, setup.z.buffer, setup.y.buffer, setup.h.buffer, setup.arm.buffer, color.buffer]);

    // Las texturas nacen con su tamaño final: three.js reserva la memoria una sola vez y después
    // solo reemplaza el contenido.
    this.nearTexture = this.dataTexture(cfg.near.texels, cfg.near.texels);
    this.regionSize.set(
      Math.round((chunks.nx * chunks.size) / cfg.regionTexel),
      Math.round((chunks.nz * chunks.size) / cfg.regionTexel),
    );
    this.regionTexture = this.dataTexture(this.regionSize.x, this.regionSize.y);
    nightLight.uNightNear.value = this.nearTexture;
    nightLight.uNightRegion.value = this.regionTexture;
    nightLight.uNightDecode.value = 0;
    const s = cfg.surface;
    nightLight.uNightSurface.value.x = s.wallOffset;
    nightLight.uNightSurface.value.y = s.wallFactor;
    nightLight.uNightFade.value.set(s.roofFade[0], s.roofFade[1], s.wallFade[0], s.wallFade[1]);
    this.requestRegion();

    // Índice de postes por celda (para los postes en 3D cercanos).
    const cell = cfg.poles.radius;
    this.cellCols = Math.ceil((chunks.nx * chunks.size) / cell);
    for (let k = 0; k < n; k++) {
      const key = this.cellOf(lamps.x[k], lamps.z[k]);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(k);
    }

    const p = cfg.poles;
    const geometry = poleGeometry(cfg);
    const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: p.roughness });
    withNightLight(bodyMaterial);
    this.poles = new THREE.InstancedMesh(geometry.body, bodyMaterial, p.maxInstances);
    this.poles.count = 0;
    this.poles.castShadow = true;
    this.poles.receiveShadow = true;
    this.poles.frustumCulled = false;
    this.poles.name = 'lamp-poles';
    this.lensTint = new THREE.InstancedBufferAttribute(new Float32Array(p.maxInstances * 3), 3);
    geometry.lens.setAttribute('aLampTint', this.lensTint);
    const lensMaterial = new THREE.MeshStandardMaterial({ color: p.lens.color, roughness: p.roughness });
    const lensUniforms = { uLightsOn: nightLight.uLightsOn, uLensGlow: { value: p.lens.glow } };
    lensMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, lensUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aLampTint;\nvarying vec3 vLampTint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampTint = aLampTint;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uLightsOn;\nuniform float uLensGlow;\nvarying vec3 vLampTint;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vLampTint * (uLensGlow * uLightsOn);',
        );
    };
    lensMaterial.customProgramCacheKey = () => 'gye-lamp-lens-v1';
    this.lenses = new THREE.InstancedMesh(geometry.lens, lensMaterial, p.maxInstances);
    this.lenses.instanceMatrix = this.poles.instanceMatrix;
    this.lenses.count = 0;
    this.lenses.frustumCulled = false;
    this.lenses.name = 'lamp-lenses';

    // Halos: todas las lámparas en un solo dibujo.
    const positions = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const reach = cfg.armShare * lamps.h[k];
      positions[k * 3] = lamps.x[k] + Math.cos(lamps.arm[k]) * reach;
      positions[k * 3 + 1] = lamps.y[k] + lamps.h[k] - cfg.halo.drop;
      positions[k * 3 + 2] = lamps.z[k] + Math.sin(lamps.arm[k]) * reach;
    }
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    points.setAttribute('tint', new THREE.BufferAttribute(lamps.tint, 3));
    const halo = createHaloMaterial(cfg.halo, fog, renderer);
    this.haloSize = halo.uniforms.uHalo.value as THREE.Vector4;
    this.halos = new THREE.Points(points, halo);
    this.halos.frustumCulled = false;
    this.halos.visible = false;
    this.halos.name = 'lamp-halos';

    this.group.add(this.poles, this.lenses, this.halos);
  }

  /** Los postes (posición, altura, brazo y color). */
  get data(): LampData {
    return this.lamps;
  }

  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    heightmap: Heightmap,
    cfg: LightsConfig,
    fog: GameConfig['render']['fog'],
    renderer: THREE.WebGLRenderer,
    deck: DeckLamps | null,
    modeled: ModeledLamps | null,
  ): Promise<StreetLamps | null> {
    const info = manifest.lamps;
    if (!info) return null;
    const res = await fetch(new URL(info.url, baseUrl));
    if (!res.ok) throw new Error(`No se pudieron cargar los postes (${res.status})`);
    const lamps = decode(await res.arrayBuffer(), info, heightmap, cfg, deck, modeled);
    return new StreetLamps(lamps, heightmap, manifest.chunks, cfg, fog, renderer);
  }

  private dataTexture(width: number, height: number): THREE.DataTexture {
    const t = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  private cellOf(x: number, z: number): number {
    const cell = this.cfg.poles.radius;
    const i = Math.floor((x - this.chunks.xmin) / cell);
    const j = Math.floor((z - this.chunks.zmin) / cell);
    return j * this.cellCols + i;
  }

  /** Mapa grueso de toda la ciudad (una sola vez): suelo en el centro de cada texel. */
  private requestRegion(): void {
    const { size, nx, nz, xmin, zmin } = this.chunks;
    const width = nx * size;
    const depth = nz * size;
    const texelsX = this.regionSize.x;
    const texelsZ = this.regionSize.y;
    const ground = new Float32Array(texelsX * texelsZ);
    for (let j = 0; j < texelsZ; j++) {
      const z = zmin + ((j + 0.5) * depth) / texelsZ;
      for (let i = 0; i < texelsX; i++) ground[j * texelsX + i] = this.heightmap.sample(xmin + ((i + 0.5) * width) / texelsX, z);
    }
    this.regionId = this.nextId++;
    const msg: LampMessage = { type: 'region', id: this.regionId, x0: xmin, z0: zmin, width, depth, texelsX, texelsZ, ground };
    this.worker.postMessage(msg, [ground.buffer]);
    nightLight.uNightRegionRect.value.set(xmin, zmin, width, depth);
  }

  /** Suelo de un cuadrado (con un margen), tomado de la grilla del mapa de alturas. */
  private groundPatch(x0: number, z0: number, size: number): GroundGrid {
    const hm = this.heightmap;
    const c0 = Math.floor((x0 - hm.xmin) / hm.spacing) - 1;
    const r0 = Math.floor((z0 - hm.zmin) / hm.spacing) - 1;
    const cols = Math.ceil(size / hm.spacing) + 3;
    const data = new Float32Array(cols * cols);
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = hm.at(c0 + c, r0 + r);
    return { data, cols, rows: cols, x0: hm.xmin + c0 * hm.spacing, z0: hm.zmin + r0 * hm.spacing, spacing: hm.spacing };
  }

  private requestNear(x: number, z: number): void {
    const { size, texels } = this.cfg.near;
    // Alineado a la grilla de texels: el charco de cada poste no "baila" al recentrar.
    const step = size / texels;
    const x0 = Math.round((x - size / 2) / step) * step;
    const z0 = Math.round((z - size / 2) / step) * step;
    const ground = this.groundPatch(x0, z0, size);
    this.nearPending = this.nextId++;
    this.nearAsked.set(x, z);
    this.nearRect.set(x0, z0, size, this.cfg.near.edge);
    const msg: LampMessage = { type: 'near', id: this.nearPending, x0, z0, size, texels, ground };
    this.worker.postMessage(msg, [ground.data.buffer]);
  }

  private receive(result: LampResult): void {
    if (result.id === this.regionId) {
      this.regionTexture.image = { data: result.data, width: this.regionSize.x, height: this.regionSize.y };
      this.regionTexture.needsUpdate = true;
      nightLight.uNightRegionGround.value.set(result.groundBase, result.groundRange);
      nightLight.uNightDecode.value = this.cfg.maxIrradiance;
      return;
    }
    if (result.id !== this.nearPending) return;
    this.nearPending = 0;
    const n = this.cfg.near.texels;
    this.nearTexture.image = { data: result.data, width: n, height: n };
    this.nearTexture.needsUpdate = true;
    nightLight.uNightNearRect.value.copy(this.nearRect);
    nightLight.uNightNearGround.value.set(result.groundBase, result.groundRange);
  }

  /** Postes en 3D a menos de `radius` del foco. */
  private placePoles(x: number, z: number): void {
    const p = this.cfg.poles;
    const l = this.lamps;
    const r2 = p.radius * p.radius;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const [ci, cj] = [Math.floor((x - this.chunks.xmin) / p.radius), Math.floor((z - this.chunks.zmin) / p.radius)];
    let count = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = this.cells.get((cj + dj) * this.cellCols + ci + di);
        if (!list) continue;
        for (const k of list) {
          if (count >= p.maxInstances) break;
          if (!l.pole[k]) continue;
          const dx = l.x[k] - x;
          const dz = l.z[k] - z;
          if (dx * dx + dz * dz > r2) continue;
          // El brazo de la geometría apunta a +x: girar -arm alrededor de y lo lleva a (cos, sin).
          q.setFromAxisAngle(up, -l.arm[k]);
          const s = l.h[k] / p.referenceHeight;
          m.compose(pos.set(l.x[k], l.y[k], l.z[k]), q, scale.set(s, s, s));
          this.poles.setMatrixAt(count, m);
          this.lensTint.setXYZ(count, l.tint[k * 3], l.tint[k * 3 + 1], l.tint[k * 3 + 2]);
          count++;
        }
      }
    }
    this.poles.count = count;
    this.lenses.count = count;
    this.poles.instanceMatrix.needsUpdate = true;
    this.lensTint.needsUpdate = true;
    this.poleCenter.set(x, z);
  }

  /** Cada frame: mapa fino y postes alrededor del foco, halos según la hora y la pantalla. */
  update(focusX: number, focusZ: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    const on = nightLight.uLightsOn.value > 0;
    const near = this.cfg.near;
    if (on && this.nearPending === 0 && Math.hypot(focusX - this.nearAsked.x, focusZ - this.nearAsked.y) > near.recenter) {
      this.requestNear(focusX, focusZ);
    }
    if (Math.hypot(focusX - this.poleCenter.x, focusZ - this.poleCenter.y) > this.cfg.poles.recenter) {
      this.placePoles(focusX, focusZ);
    }
    this.halos.visible = on;
    // Píxeles por metro a 1 m de distancia (el tamaño de los halos en pantalla).
    if (on) this.haloSize.w = haloPixels(camera, renderer);
  }

  dispose(): void {
    this.worker.terminate();
    this.nearTexture.dispose();
    this.regionTexture.dispose();
    this.poles.geometry.dispose();
    this.lenses.geometry.dispose();
    this.halos.geometry.dispose();
    (this.poles.material as THREE.Material).dispose();
    (this.lenses.material as THREE.Material).dispose();
    (this.halos.material as THREE.Material).dispose();
  }
}
