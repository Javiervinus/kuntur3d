import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import type { Heightmap } from './heightmap';
import { createVehicleMaterial, type VehicleKind, vehicleGeometry } from './vehicleModels';

type ParkingConfig = GameConfig['parking'];
type ParkingInfo = NonNullable<WorldManifest['parking']>;
type TrafficConfig = GameConfig['traffic'];
type ChunkGrid = WorldManifest['chunks'];

/** Lo calculado de un chunk cercano: cómo se dibuja cada auto y dónde está, para chocar. */
interface ChunkReady {
  /** Matriz de cada auto (16 floats, asentado en la pendiente). */
  matrices: Float32Array;
  /** Centro de cada auto (x, y, z). */
  centers: Float32Array;
  /** Autos del chunk ordenados por celda (índices locales) y dónde empieza cada celda. */
  items: Uint32Array;
  cellStart: Uint32Array;
  cells: number;
  /** Altura media de sus autos y cuánto se apartan de ella (con el alto de un auto), para el recorte. */
  middle: number;
  relief: number;
}

interface ParkingChunk {
  i: number;
  j: number;
  first: number;
  count: number;
  ready: ChunkReady | null;
}

/**
 * Puestos que no vienen de parking.bin (los parqueaderos y carriles de las calles modeladas,
 * world/monuments.ts → parkingSpots): posición, rumbo (atan2(z, x) de la trompa, en el mundo),
 * semilla (tipo y color) y cuánto quedan sobre el terreno (el piso del parqueadero).
 */
export interface ExtraSpots {
  x: Float32Array;
  z: Float32Array;
  heading: Float32Array;
  seed: Uint8Array;
  lift: Float32Array;
}

/** Medidas de un tipo de vehículo en su marco (x adelante, y arriba, z al costado). */
interface KindSize {
  halfLength: number;
  halfWidth: number;
  height: number;
  radius: number;
}

const _frustum = new THREE.Frustum();
const _matrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _color = new THREE.Color();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Pseudoaleatorio estable en [0, 1) a partir de dos enteros. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * Autos estacionados (pipeline, paso `roads`: parking.bin) junto al bordillo, en los carriles de
 * estacionamiento de las calles, más los de los parqueaderos y carriles de las calles modeladas
 * (`ExtraSpots`, cada uno sobre su piso). Tipo y color salen de la semilla de cada puesto (tipos y
 * pesos en `parking.kinds`, con los modelos y pinturas del tráfico); de noche no llevan luces:
 * los alumbran los postes.
 *
 * - Cada chunk a menos de `radius` m de la cámara se prepara una vez (a lo sumo uno por
 *   cuadro): cada auto asentado en la pendiente (cuatro muestras del relieve) y una grilla de
 *   `cell` m para chocar. Los chunks que quedan lejos se sueltan.
 * - Se dibujan con una malla instanciada por tipo y detalle: cerca (a menos de `near` m, con
 *   sombra) el modelo completo; lejos, el de ruedas con menos lados y sin faros. Solo los
 *   que entran en la vista, y se rearma solo cuando la cámara se mueve.
 * - Son obstáculos: `topAt` da el techo del auto en (x, z) para el jugador y su carro.
 */
export class ParkedCars {
  readonly group = new THREE.Group();
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly kind: Uint8Array;
  private readonly paint: Uint8Array;
  /** Cuánto queda cada auto sobre el terreno (los de los parqueaderos, sobre su piso). */
  private readonly lift: Float32Array;
  private readonly chunks: ParkingChunk[];
  private readonly byKey = new Map<number, ParkingChunk[]>();
  private readonly kinds: VehicleKind[];
  private readonly sizes: KindSize[];
  private readonly palettes: THREE.Color[][];
  /** Mallas por tipo: [cerca, lejos]. */
  private readonly meshes: THREE.InstancedMesh[][] = [];
  private readonly lastCamera = new THREE.Matrix4();
  private readonly lastProjection = new THREE.Matrix4();
  private dirty = true;

  private constructor(
    buffer: ArrayBuffer,
    info: ParkingInfo,
    private readonly cfg: ParkingConfig,
    traffic: TrafficConfig,
    private readonly grid: ChunkGrid,
    private readonly heightmap: Heightmap,
    extra: ExtraSpots,
  ) {
    this.group.name = 'parked-cars';
    const count = info.count;
    if (buffer.byteLength !== count * info.stride) {
      throw new Error(`parking.bin inválido: ${buffer.byteLength} bytes, se esperaban ${count * info.stride}`);
    }
    const view = new DataView(buffer);
    const all = count + extra.x.length;
    this.x = new Float32Array(all);
    this.z = new Float32Array(all);
    this.cos = new Float32Array(all);
    this.sin = new Float32Array(all);
    this.kind = new Uint8Array(all);
    this.paint = new Uint8Array(all);
    this.lift = new Float32Array(all);

    const weights = cfg.kinds as Record<string, number>;
    this.kinds = Object.keys(weights).map((name) => {
      const k = traffic.kinds.find((t) => t.name === name);
      if (!k) throw new Error(`parking.kinds en config/game.json: "${name}" no es un tipo de traffic.kinds`);
      return k;
    });
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const cumulative: number[] = [];
    let acc = 0;
    for (const name of Object.keys(weights)) {
      acc += weights[name] / total;
      cumulative.push(acc);
    }
    this.palettes = this.kinds.map((k) => k.paint.map((hex) => new THREE.Color(hex)));

    const step = 65535;
    // Tipo y pintura: de la semilla del puesto y su lugar en la lista (estables).
    const choose = (c: number, seed: number): void => {
      const r = hash01(seed, c);
      let k = 0;
      while (k < cumulative.length - 1 && r >= cumulative[k]) k++;
      this.kind[c] = k;
      this.paint[c] = Math.floor(hash01(c, seed) * this.palettes[k].length);
    };
    this.chunks = info.chunks.map(([i, j, first, n]) => {
      const x0 = grid.xmin + i * grid.size;
      const z0 = grid.zmin + j * grid.size;
      for (let c = first; c < first + n; c++) {
        const o = c * info.stride;
        this.x[c] = x0 + (view.getUint16(o, true) / step) * grid.size;
        this.z[c] = z0 + (view.getUint16(o + 2, true) / step) * grid.size;
        const heading = (view.getUint8(o + 4) / 256) * Math.PI * 2;
        this.cos[c] = Math.cos(heading);
        this.sin[c] = Math.sin(heading);
        choose(c, view.getUint8(o + 5));
      }
      return { i, j, first, count: n, ready: null };
    });
    // Los puestos de afuera van después de los de parking.bin, agrupados en sus propios chunks.
    const groups = new Map<number, number[]>();
    for (let k = 0; k < extra.x.length; k++) {
      const i = Math.floor((extra.x[k] - grid.xmin) / grid.size);
      const j = Math.floor((extra.z[k] - grid.zmin) / grid.size);
      const key = j * grid.nx + i;
      groups.set(key, [...(groups.get(key) ?? []), k]);
    }
    let next = count;
    for (const [key, list] of groups) {
      const first = next;
      for (const k of list) {
        this.x[next] = extra.x[k];
        this.z[next] = extra.z[k];
        this.cos[next] = Math.cos(extra.heading[k]);
        this.sin[next] = Math.sin(extra.heading[k]);
        this.lift[next] = extra.lift[k];
        choose(next, extra.seed[k]);
        next++;
      }
      this.chunks.push({ i: key % grid.nx, j: Math.floor(key / grid.nx), first, count: list.length, ready: null });
    }
    for (const chunk of this.chunks) {
      const key = chunk.j * grid.nx + chunk.i;
      this.byKey.set(key, [...(this.byKey.get(key) ?? []), chunk]);
    }

    const material = createVehicleMaterial(traffic, { value: 0 });
    const capacity = cfg.maxVisible;
    this.sizes = this.kinds.map((kind) => {
      const near = vehicleGeometry(kind, traffic.lights);
      const far = vehicleGeometry(kind, traffic.lights, { wheelSegments: cfg.wheelSegments });
      near.computeBoundingBox();
      const box = near.boundingBox ?? new THREE.Box3();
      const pair = [near, far].map((geometry, lod) => {
        // Sin luz de freno (el material la espera por vértice).
        geometry.setAttribute('aBrake', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1));
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
          THREE.DynamicDrawUsage,
        );
        mesh.count = 0;
        mesh.castShadow = lod === 0;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.name = `parked-${kind.name}-${lod === 0 ? 'near' : 'far'}`;
        this.group.add(mesh);
        return mesh;
      });
      this.meshes.push(pair);
      const halfLength = Math.max(-box.min.x, box.max.x);
      const halfWidth = Math.max(-box.min.z, box.max.z);
      return { halfLength, halfWidth, height: box.max.y, radius: Math.hypot(halfLength, halfWidth, box.max.y / 2) };
    });
  }

  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    cfg: ParkingConfig,
    traffic: TrafficConfig,
    heightmap: Heightmap,
    extra: ExtraSpots,
  ): Promise<ParkedCars | null> {
    const info = manifest.parking;
    if (!info) return null;
    const res = await fetch(new URL(info.url, baseUrl));
    if (!res.ok) throw new Error(`No se pudieron cargar los autos estacionados (${res.status})`);
    return new ParkedCars(await res.arrayBuffer(), info, cfg, traffic, manifest.chunks, heightmap, extra);
  }

  /** Autos dibujados ahora (para depurar). */
  get visible(): number {
    let n = 0;
    for (const pair of this.meshes) for (const mesh of pair) n += mesh.count;
    return n;
  }

  /** Prepara los chunks cercanos, suelta los lejanos y, si la cámara se movió, rearma lo que se dibuja. */
  update(camera: THREE.PerspectiveCamera): void {
    const cfg = this.cfg;
    const cx = camera.position.x;
    const cz = camera.position.z;
    let prepared = false;
    for (const chunk of this.chunks) {
      const d = this.chunkDistance(chunk, cx, cz);
      if (d < cfg.radius) {
        if (!chunk.ready && !prepared) {
          chunk.ready = this.prepare(chunk);
          prepared = true;
          this.dirty = true;
        }
      } else if (chunk.ready && d > cfg.radius + this.grid.size) {
        chunk.ready = null;
      }
    }
    camera.updateMatrixWorld();
    if (!this.dirty && this.lastCamera.equals(camera.matrixWorld) && this.lastProjection.equals(camera.projectionMatrix)) return;
    this.lastCamera.copy(camera.matrixWorld);
    this.lastProjection.copy(camera.projectionMatrix);
    this.dirty = false;
    this.draw(camera);
  }

  /**
   * Techo del auto estacionado en (x, z) (m, altura del mundo), o -Infinity si no hay ninguno:
   * con él, el jugador y su carro no lo atraviesan (ver WorldQuery.wallTop).
   */
  topAt(x: number, z: number): number {
    let top = -Infinity;
    const reach = this.cfg.cell;
    const { size, nx, xmin, zmin } = this.grid;
    const i0 = Math.floor((x - reach - xmin) / size);
    const i1 = Math.floor((x + reach - xmin) / size);
    const j0 = Math.floor((z - reach - zmin) / size);
    const j1 = Math.floor((z + reach - zmin) / size);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const chunk of this.byKey.get(j * nx + i) ?? []) {
          const ready = chunk.ready;
          if (!ready) continue;
          const col = Math.floor((x - (xmin + i * size)) / this.cfg.cell);
          const row = Math.floor((z - (zmin + j * size)) / this.cfg.cell);
          for (let r = row - 1; r <= row + 1; r++) {
            if (r < 0 || r >= ready.cells) continue;
            for (let c = col - 1; c <= col + 1; c++) {
              if (c < 0 || c >= ready.cells) continue;
              const cell = r * ready.cells + c;
              for (let k = ready.cellStart[cell]; k < ready.cellStart[cell + 1]; k++) {
                const local = ready.items[k];
                const car = chunk.first + local;
                const dims = this.sizes[this.kind[car]];
                const dx = x - ready.centers[local * 3];
                const dz = z - ready.centers[local * 3 + 2];
                const along = dx * this.cos[car] + dz * this.sin[car];
                const across = -dx * this.sin[car] + dz * this.cos[car];
                if (Math.abs(along) <= dims.halfLength && Math.abs(across) <= dims.halfWidth) {
                  top = Math.max(top, ready.centers[local * 3 + 1] + dims.height);
                }
              }
            }
          }
        }
      }
    }
    return top;
  }

  private chunkDistance(chunk: ParkingChunk, x: number, z: number): number {
    const { size, xmin, zmin } = this.grid;
    const x0 = xmin + chunk.i * size;
    const z0 = zmin + chunk.j * size;
    return Math.hypot(Math.max(x0 - x, 0, x - (x0 + size)), Math.max(z0 - z, 0, z - (z0 + size)));
  }

  /** Matrices (cada auto sobre la pendiente, con cuatro muestras del relieve) y grilla de un chunk. */
  private prepare(chunk: ParkingChunk): ChunkReady {
    const hm = this.heightmap;
    const n = chunk.count;
    const matrices = new Float32Array(n * 16);
    const centers = new Float32Array(n * 3);
    const cellSize = this.cfg.cell;
    const cells = Math.ceil(this.grid.size / cellSize);
    const x0 = this.grid.xmin + chunk.i * this.grid.size;
    const z0 = this.grid.zmin + chunk.j * this.grid.size;
    const cellOf = new Uint32Array(n);
    const cellStart = new Uint32Array(cells * cells + 1);
    for (let local = 0; local < n; local++) {
      const c = chunk.first + local;
      const size = this.sizes[this.kind[c]];
      const x = this.x[c];
      const z = this.z[c];
      const dx = this.cos[c];
      const dz = this.sin[c];
      // Al costado (+z del vehículo): (−dz, dx).
      const hl = size.halfLength;
      const hw = size.halfWidth;
      const front = hm.sample(x + dx * hl, z + dz * hl);
      const back = hm.sample(x - dx * hl, z - dz * hl);
      const side = hm.sample(x - dz * hw, z + dx * hw);
      const other = hm.sample(x + dz * hw, z - dx * hw);
      _f.set(2 * hl * dx, front - back, 2 * hl * dz).normalize();
      _s.set(-2 * hw * dz, side - other, 2 * hw * dx).normalize();
      _u.crossVectors(_s, _f).normalize();
      _s.crossVectors(_f, _u);
      const y = (front + back + side + other) / 4 + this.lift[c];
      _matrix.makeBasis(_f, _u, _s).setPosition(x, y, z);
      _matrix.toArray(matrices, local * 16);
      centers[local * 3] = x;
      centers[local * 3 + 1] = y;
      centers[local * 3 + 2] = z;
      const col = Math.min(cells - 1, Math.max(0, Math.floor((x - x0) / cellSize)));
      const row = Math.min(cells - 1, Math.max(0, Math.floor((z - z0) / cellSize)));
      cellOf[local] = row * cells + col;
      cellStart[cellOf[local] + 1]++;
    }
    for (let k = 0; k < cells * cells; k++) cellStart[k + 1] += cellStart[k];
    const fill = cellStart.slice(0, cells * cells);
    const items = new Uint32Array(n);
    for (let local = 0; local < n; local++) items[fill[cellOf[local]]++] = local;
    let low = Infinity;
    let high = -Infinity;
    for (let local = 0; local < n; local++) {
      low = Math.min(low, centers[local * 3 + 1]);
      high = Math.max(high, centers[local * 3 + 1]);
    }
    const tallest = Math.max(...this.sizes.map((s) => s.height));
    return { matrices, centers, items, cellStart, cells, middle: (low + high) / 2, relief: (high - low) / 2 + tallest };
  }

  /** Los autos cercanos que entran en la vista, en la malla de su tipo y detalle. */
  private draw(camera: THREE.PerspectiveCamera): void {
    const cfg = this.cfg;
    _frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const pair of this.meshes) for (const mesh of pair) mesh.count = 0;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const radius2 = cfg.radius * cfg.radius;
    const near2 = cfg.near * cfg.near;
    const half = this.grid.size / 2;
    for (const chunk of this.chunks) {
      const ready = chunk.ready;
      if (!ready) continue;
      // Todo el chunk (con holgura para lo que sube o baja el relieve dentro de él).
      _sphere.center.set(this.grid.xmin + chunk.i * this.grid.size + half, ready.middle, this.grid.zmin + chunk.j * this.grid.size + half);
      _sphere.radius = Math.hypot(half * Math.SQRT2, ready.relief);
      if (!_frustum.intersectsSphere(_sphere)) continue;
      for (let local = 0; local < chunk.count; local++) {
        const x = ready.centers[local * 3];
        const y = ready.centers[local * 3 + 1];
        const z = ready.centers[local * 3 + 2];
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz);
        if (d2 > radius2) continue;
        const car = chunk.first + local;
        const kind = this.kind[car];
        _sphere.center.set(x, y, z);
        _sphere.radius = this.sizes[kind].radius;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        const mesh = this.meshes[kind][d2 < near2 ? 0 : 1];
        if (mesh.count >= cfg.maxVisible) continue;
        const slot = mesh.count++;
        (mesh.instanceMatrix.array as Float32Array).set(ready.matrices.subarray(local * 16, local * 16 + 16), slot * 16);
        mesh.setColorAt(slot, _color.copy(this.palettes[kind][this.paint[car]]));
      }
    }
    for (const pair of this.meshes) {
      for (const mesh of pair) {
        if (mesh.count === 0) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        const colors = mesh.instanceColor;
        if (colors) {
          colors.clearUpdateRanges();
          colors.addUpdateRange(0, mesh.count * 3);
          colors.needsUpdate = true;
        }
      }
    }
  }
}
