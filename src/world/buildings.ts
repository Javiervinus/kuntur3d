import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import type { CityShadow } from '../render/cityShadow';
import { isSharedShopTable, shopKindIndex, shopTableTexture, signLetters } from '../render/facade';
import { createBuildingMaterial, setRoofImage, setSkyMap } from '../render/materials';
import { META_STRIDE, ROOF_KIND, packShopMix } from './buildingFormat';
import type { BuildError, BuildRequest, BuildResult, BuildingStyle } from './buildingWorker';
import type { Imagery } from './imagery';
import type { SkyOcclusion } from './skyOcclusion';

/** Techo inclinado: centro, dirección de la cumbrera, medio ancho/largo, pendiente y altura del borde. */
export interface RoofShape {
  hip: boolean;
  cx: number;
  cz: number;
  ax: number;
  az: number;
  halfWidth: number;
  halfLength: number;
  slope: number;
  edge: number;
}

/** Datos mínimos de un edificio para colisiones y para trepar. */
export interface BuildingRecord {
  y0: number;
  /** Punto más alto (losa o cumbrera). */
  y1: number;
  rings: Float32Array[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  chunk: number;
  /** null = losa plana a la altura y1. */
  roof: RoofShape | null;
}

/** Altura del techo del edificio en (x, z): la losa, o la superficie de las aguas si es de teja. */
export function roofTop(b: BuildingRecord, x: number, z: number): number {
  const r = b.roof;
  if (!r) return b.y1;
  const dx = x - r.cx;
  const dz = z - r.cz;
  const across = r.halfWidth - Math.abs(dz * r.ax - dx * r.az);
  const run = r.hip ? Math.min(across, r.halfLength - Math.abs(dx * r.ax + dz * r.az)) : across;
  return Math.min(b.y1, r.edge + r.slope * Math.max(0, run));
}

/** Grilla espacial para preguntar "¿qué edificio hay en (x, z)?"; admite quitar chunks enteros. */
export class BuildingIndex {
  private readonly cells = new Map<number, BuildingRecord[]>();
  private readonly chunkCells = new Map<number, number[]>();
  private readonly cols: number;

  constructor(
    private readonly xmin: number,
    private readonly zmin: number,
    width: number,
    private readonly cell: number,
  ) {
    this.cols = Math.ceil(width / cell) + 1;
  }

  addChunk(chunk: number, records: BuildingRecord[]): void {
    const touched = new Set<number>();
    for (const record of records) {
      const c0 = Math.floor((record.minX - this.xmin) / this.cell);
      const c1 = Math.floor((record.maxX - this.xmin) / this.cell);
      const r0 = Math.floor((record.minZ - this.zmin) / this.cell);
      const r1 = Math.floor((record.maxZ - this.zmin) / this.cell);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * this.cols + c;
          const list = this.cells.get(key);
          if (list) list.push(record);
          else this.cells.set(key, [record]);
          touched.add(key);
        }
      }
    }
    this.chunkCells.set(chunk, [...touched]);
  }

  removeChunk(chunk: number): void {
    for (const key of this.chunkCells.get(chunk) ?? []) {
      const kept = (this.cells.get(key) ?? []).filter((r) => r.chunk !== chunk);
      if (kept.length) this.cells.set(key, kept);
      else this.cells.delete(key);
    }
    this.chunkCells.delete(chunk);
  }

  private static inside(record: BuildingRecord, x: number, z: number): boolean {
    let hit = false;
    for (const ring of record.rings) {
      const n = ring.length / 2;
      for (let k = 0, m = n - 1; k < n; m = k++) {
        const xk = ring[k * 2];
        const zk = ring[k * 2 + 1];
        const xm = ring[m * 2];
        const zm = ring[m * 2 + 1];
        if (zk > z !== zm > z && x < ((xm - xk) * (z - zk)) / (zm - zk) + xk) hit = !hit;
      }
    }
    return hit;
  }

  /** Edificio más alto que contiene el punto, o null. */
  at(x: number, z: number): BuildingRecord | null {
    const c = Math.floor((x - this.xmin) / this.cell);
    const r = Math.floor((z - this.zmin) / this.cell);
    const list = this.cells.get(r * this.cols + c);
    if (!list) return null;
    let best: BuildingRecord | null = null;
    for (const b of list) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (BuildingIndex.inside(b, x, z) && (!best || b.y1 > best.y1)) best = b;
    }
    return best;
  }
}

interface LoadedChunk {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** Tabla de locales del chunk (ver render/facade.ts → shopTableTexture). */
  shops: THREE.DataTexture;
  count: number;
  /** Edificios con locales y negocios con letrero (para el banco de pruebas). */
  shopStats: BuildResult['shopStats'];
}

/** Los edificios de un chunk dentro de un grupo del horizonte lejano. */
interface SkylinePart {
  positions: Float32Array;
  facade: Float32Array;
  tint: Uint8Array;
  index: Uint32Array;
}

/**
 * Separa la geometría de un grupo del horizonte según el "c" de cada vértice (2·chunk + nivel
 * de su edificio): cada chunk y nivel queda con sus propios vértices, renumerados.
 */
function splitByChunk(r: BuildResult, chunkOf: Uint16Array): Map<number, SkylinePart> {
  const vertices = chunkOf.length;
  const local = new Uint32Array(vertices);
  const counts = new Map<number, { vertices: number; indices: number }>();
  for (let v = 0; v < vertices; v++) {
    let c = counts.get(chunkOf[v]);
    if (!c) counts.set(chunkOf[v], (c = { vertices: 0, indices: 0 }));
    local[v] = c.vertices++;
  }
  for (let t = 0; t < r.index.length; t += 3) counts.get(chunkOf[r.index[t]])!.indices += 3;
  const parts = new Map<number, SkylinePart & { filled: number }>();
  for (const [chunk, c] of counts) {
    parts.set(chunk, {
      positions: new Float32Array(c.vertices * 3),
      facade: new Float32Array(c.vertices * 4),
      tint: new Uint8Array(c.vertices * 4),
      index: new Uint32Array(c.indices),
      filled: 0,
    });
  }
  for (let v = 0; v < vertices; v++) {
    const p = parts.get(chunkOf[v])!;
    const l = local[v];
    p.positions.set(r.positions.subarray(v * 3, v * 3 + 3), l * 3);
    p.facade.set(r.facade.subarray(v * 4, v * 4 + 4), l * 4);
    p.tint.set(r.tint.subarray(v * 4, v * 4 + 4), l * 4);
  }
  for (let t = 0; t < r.index.length; t += 3) {
    const p = parts.get(chunkOf[r.index[t]])!;
    for (let k = 0; k < 3; k++) p.index[p.filled++] = local[r.index[t + k]];
  }
  return parts;
}

/**
 * Edificios por chunk alrededor del jugador. La geometría se arma en workers y
 * aquí solo se crean los meshes (con un tope por frame para no trabar).
 * Más allá, el horizonte lejano: los edificios altos de toda la ciudad (paso `skyline`), con
 * el mismo material (no se nota el cambio al acercarse). Cada grupo es un BatchedMesh con un
 * trozo por chunk: se apaga el trozo donde ya están los de cerca y la GPU no lo procesa.
 */
export class Buildings {
  readonly group = new THREE.Group();
  readonly index: BuildingIndex;
  private readonly skyline = new THREE.Group();
  /** Trozos del horizonte de cada chunk: su BatchedMesh, la instancia y si son los altos. */
  private readonly skylineParts = new Map<number, { mesh: THREE.BatchedMesh; instance: number; tall: boolean }[]>();
  /** Último foco de la carga (los medianos del horizonte se ven hasta `skylineMidRadius` de él). */
  private readonly focus = { x: 0, z: 0 };
  private readonly counts = new Map<number, number>();
  private readonly loaded = new Map<number, LoadedChunk>();
  private readonly requests = new Map<number, Promise<BuildResult | null>>();
  private readonly ready: { key: number; result: BuildResult }[] = [];
  private readonly wanted = new Set<number>();
  private readonly workers: Worker[];
  private readonly pending = new Map<number, (r: BuildResult | BuildError) => void>();
  private readonly style: BuildingStyle;
  private nextId = 0;
  private nextWorker = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly manifest: WorldManifest,
    private readonly imagery: Imagery,
    private readonly sky: SkyOcclusion,
    private readonly shadow: CityShadow,
    private readonly cfg: GameConfig['buildings'],
    private readonly stream: GameConfig['streaming'],
    collisionCell: number,
    /** Zonas de paleta, y círculos y polígonos donde un monumento reemplaza al edificio (marco local). */
    placement: Pick<BuildingStyle, 'zones' | 'exclude' | 'excludeAreas' | 'portales'> = {
      zones: [],
      exclude: [],
      excludeAreas: [],
      portales: { polygon: [], minHeight: Infinity, minArea: Infinity, probability: 0 },
    },
  ) {
    this.group.name = 'buildings';
    const { size, nx, xmin, zmin } = manifest.chunks;
    this.index = new BuildingIndex(xmin, zmin, nx * size, collisionCell);
    this.skyline.name = 'skyline';
    this.group.add(this.skyline);
    for (const [i, j, count] of manifest.buildings.chunks) this.counts.set(this.key(i, j), count);
    // Locales: los tipos del pipeline (manifest) con los de la config del juego, por nombre.
    const shops = cfg.facade.shops;
    const kindIndex = shopKindIndex(shops);
    const missing = (manifest.shops?.kinds ?? []).filter((id) => !kindIndex.has(id));
    if (missing.length) console.warn('[buildings] tipos de local sin aspecto en config/game.json → shops.kinds:', missing);
    const fallback = shops.fallback.kinds.map((id) => kindIndex.get(id) ?? 0);
    this.style = {
      highRiseThreshold: cfg.highRiseThreshold,
      glassMinHeight: cfg.glassMinHeight,
      glassProbability: cfg.glassProbability,
      lowRisePalette: cfg.lowRisePalette,
      highRisePalette: cfg.highRisePalette,
      industrial: cfg.industrial,
      stands: cfg.stands,
      pitchedRoofs: cfg.pitchedRoofs,
      waterTanks: cfg.waterTanks,
      farShadowMinHeight: cfg.farShadowMinHeight,
      zones: placement.zones,
      exclude: placement.exclude,
      excludeAreas: placement.excludeAreas,
      portales: placement.portales,
      shops: {
        width: shops.width,
        maxShift: shops.maxShift,
        letters: signLetters(shops),
        kinds: (manifest.shops?.kinds ?? []).map((id) => kindIndex.get(id) ?? -1),
        fallback: packShopMix(fallback[0], fallback[1] ?? fallback[0], shops.fallback.share),
      },
    };
    this.workers = Array.from({ length: stream.workers }, () => {
      const worker = new Worker(new URL('./buildingWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<BuildResult | BuildError>) => {
        this.pending.get(e.data.id)?.(e.data);
        this.pending.delete(e.data.id);
      };
      return worker;
    });
    imagery.onChange((i, j, image) => {
      const chunk = this.loaded.get(this.key(i, j));
      if (chunk) setRoofImage(chunk.material, image);
    });
    sky.onChange((i, j, texture) => {
      const chunk = this.loaded.get(this.key(i, j));
      if (chunk) setSkyMap(chunk.material, texture);
    });
  }

  private key(i: number, j: number): number {
    return j * this.manifest.chunks.nx + i;
  }

  private distance(k: number, x: number, z: number): number {
    const { size, nx, xmin, zmin } = this.manifest.chunks;
    const i = k % nx;
    const j = Math.floor(k / nx);
    return Math.hypot(
      Math.max(xmin + i * size - x, 0, x - (xmin + (i + 1) * size)),
      Math.max(zmin + j * size - z, 0, z - (zmin + (j + 1) * size)),
    );
  }

  /** Arma en un worker el archivo de edificios `template` ({i}, {j} → i, j). */
  private work(template: string, i: number, j: number): Promise<BuildResult | null> {
    const url = new URL(template.replace('{i}', String(i)).replace('{j}', String(j)), this.baseUrl).href;
    const id = this.nextId++;
    return new Promise<BuildResult | null>((resolve) => {
      this.pending.set(id, (r) => {
        if (!r.ok) console.warn('[buildings]', url, r.error);
        resolve(r.ok ? r : null);
      });
      const message: BuildRequest = { id, url, style: this.style };
      this.workers[this.nextWorker++ % this.workers.length].postMessage(message);
    });
  }

  private request(k: number): Promise<BuildResult | null> {
    const existing = this.requests.get(k);
    if (existing) return existing;
    const { nx } = this.manifest.chunks;
    const job = this.work(this.manifest.buildings.url, k % nx, Math.floor(k / nx)).finally(() => this.requests.delete(k));
    this.requests.set(k, job);
    return job;
  }

  /**
   * Arma el horizonte lejano, un grupo a la vez (el otro worker sigue libre para los chunks de
   * cerca), empezando por los grupos con más edificios altos (el centro). `prepare` compila el
   * material antes de mostrarlo (sin tirones al aparecer).
   */
  async loadSkyline(prepare?: (mesh: THREE.Mesh) => Promise<unknown>): Promise<void> {
    const info = this.manifest.skyline;
    if (!info) return;
    const { size, xmin, zmin } = this.manifest.chunks;
    const span = info.group;
    for (const [gi, gj] of [...info.groups].sort((a, b) => b[2] - a[2])) {
      const r = await this.work(info.url, gi, gj);
      if (!r?.chunk) continue;
      const parts = splitByChunk(r, r.chunk);
      let vertices = 0;
      let indices = 0;
      for (const p of parts.values()) {
        vertices += p.positions.length / 3;
        indices += p.index.length;
      }
      const i0 = gi * span;
      const j0 = gj * span;
      const material = createBuildingMaterial(
        this.cfg,
        this.imagery.overviewSpan(i0, j0, span),
        { x0: xmin + i0 * size, z0: zmin + j0 * size, size: span * size },
        this.sky.open,
        shopTableTexture(r.shops),
      );
      const mesh = new THREE.BatchedMesh(parts.size, vertices, indices, material);
      // Lejos de la sombra del sol: ni la proyecta ni la recibe.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `skyline-${gi}-${gj}`;
      for (const [code, p] of parts) {
        // "c" = 2·chunk + nivel (1: los altos, que se ven desde toda la ciudad).
        const chunk = code >> 1;
        const tall = (code & 1) === 1;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
        geometry.setAttribute('aFacade', new THREE.BufferAttribute(p.facade, 4));
        geometry.setAttribute('aTint', new THREE.BufferAttribute(p.tint, 4, true));
        geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
        const instance = mesh.addInstance(mesh.addGeometry(geometry));
        mesh.setVisibleAt(instance, this.skylineShown(chunk, tall));
        const list = this.skylineParts.get(chunk);
        if (list) list.push({ mesh, instance, tall });
        else this.skylineParts.set(chunk, [{ mesh, instance, tall }]);
      }
      if (prepare) await prepare(mesh);
      this.skyline.add(mesh);
    }
  }

  /**
   * ¿Se dibuja el trozo del horizonte del chunk k? No donde ya están los edificios de cerca; los
   * medianos, además, solo hasta `skylineMidRadius` (más lejos miden pocos píxeles).
   */
  private skylineShown(k: number, tall: boolean): boolean {
    return !this.loaded.has(k) && (tall || this.distance(k, this.focus.x, this.focus.z) <= this.stream.skylineMidRadius);
  }

  /** Prende o apaga los trozos del horizonte del chunk k según lo cargado y la distancia. */
  private refreshSkyline(k: number): void {
    for (const part of this.skylineParts.get(k) ?? []) part.mesh.setVisibleAt(part.instance, this.skylineShown(k, part.tall));
  }

  /** Decide qué chunks deben estar cargados (distancia + tope total de edificios). */
  update(focusX: number, focusZ: number, altitude: number): void {
    this.focus.x = focusX;
    this.focus.z = focusZ;
    for (const k of this.skylineParts.keys()) this.refreshSkyline(k);
    const s = this.stream;
    const radius = Math.min(s.buildingRadiusMax, s.buildingRadius + Math.max(0, altitude) * s.buildingRadiusPerMeterAltitude);
    const candidates: { k: number; d: number }[] = [];
    for (const k of this.counts.keys()) {
      const d = this.distance(k, focusX, focusZ);
      if (d <= radius + s.buildingHysteresis) candidates.push({ k, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    this.wanted.clear();
    let budget = s.maxResidentBuildings;
    for (const { k, d } of candidates) {
      const count = this.counts.get(k) ?? 0;
      if (count > budget) break;
      // Dentro del radio se pide; en la franja de histéresis solo se conserva lo ya cargado.
      if (d <= radius || this.loaded.has(k)) {
        this.wanted.add(k);
        budget -= count;
      }
    }
    for (const k of [...this.loaded.keys()]) if (!this.wanted.has(k)) this.unload(k);
    for (const k of this.wanted) {
      if (this.loaded.has(k) || this.requests.has(k)) continue;
      if (this.requests.size >= s.workers * 2) break;
      void this.request(k).then((result) => {
        if (result && this.wanted.has(k) && !this.loaded.has(k)) this.ready.push({ key: k, result });
      });
    }
  }

  /** Convierte en meshes los chunks que ya armaron los workers (tope por frame). */
  pump(): void {
    for (let n = 0; n < this.stream.maxMeshesPerFrame && this.ready.length; n++) {
      const { key, result } = this.ready.shift()!;
      if (this.wanted.has(key) && !this.loaded.has(key)) this.install(key, result);
    }
  }

  /** Carga ya (sin esperar turno) los chunks alrededor de un punto: para teletransportes. */
  async ensure(x: number, z: number, radius: number): Promise<void> {
    const keys = [...this.counts.keys()].filter((k) => this.distance(k, x, z) <= radius);
    await Promise.all(
      keys.map(async (k) => {
        this.wanted.add(k);
        if (this.loaded.has(k)) return;
        const result = await this.request(k);
        if (result && !this.loaded.has(k)) this.install(k, result);
      }),
    );
  }

  private install(k: number, r: BuildResult): void {
    const { size, nx, xmin, zmin } = this.manifest.chunks;
    const i = k % nx;
    const j = Math.floor(k / nx);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geometry.setAttribute('aFacade', new THREE.BufferAttribute(r.facade, 4));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(r.tint, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(r.index, 1));
    geometry.computeBoundingSphere();
    const shops = shopTableTexture(r.shops);
    const material = createBuildingMaterial(
      this.cfg,
      this.imagery.current(i, j),
      { x0: xmin + i * size, z0: zmin + j * size, size },
      this.sky.current(i, j),
      shops,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.shadow.limitFar(mesh, r.farShadowCount);
    mesh.name = `buildings-${i}-${j}`;
    this.group.add(mesh);

    const count = r.meta.length / META_STRIDE;
    const records: BuildingRecord[] = new Array(count);
    for (let b = 0; b < count; b++) {
      const rings: Float32Array[] = [];
      for (let ring = r.buildingRings[b]; ring < r.buildingRings[b + 1]; ring++) {
        rings.push(r.ringCoords.subarray(r.ringStarts[ring], r.ringStarts[ring + 1]));
      }
      const m = r.meta.subarray(b * META_STRIDE, (b + 1) * META_STRIDE);
      records[b] = {
        y0: m[0],
        y1: m[1],
        minX: m[2],
        maxX: m[3],
        minZ: m[4],
        maxZ: m[5],
        rings,
        chunk: k,
        roof:
          m[6] === ROOF_KIND.flat
            ? null
            : {
                hip: m[6] === ROOF_KIND.hip,
                cx: m[7],
                cz: m[8],
                ax: m[9],
                az: m[10],
                halfWidth: m[11],
                halfLength: m[12],
                slope: m[13],
                edge: m[14],
              },
      };
    }
    this.index.addChunk(k, records);
    this.loaded.set(k, { mesh, material, shops, count, shopStats: r.shopStats });
    this.refreshSkyline(k);
  }

  private unload(k: number): void {
    const chunk = this.loaded.get(k);
    if (!chunk) return;
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.material.dispose();
    if (!isSharedShopTable(chunk.shops)) chunk.shops.dispose();
    this.index.removeChunk(k);
    this.loaded.delete(k);
    this.refreshSkyline(k);
  }

  get stats(): { chunks: number; buildings: number; queued: number } {
    let buildings = 0;
    for (const c of this.loaded.values()) buildings += c.count;
    return { chunks: this.loaded.size, buildings, queued: this.requests.size + this.ready.length };
  }

  /**
   * Locales de los chunks cargados: edificios con locales, negocios con letrero, edificios que se
   * quedaron sin lugar en la tabla y memoria de las tablas (bytes).
   */
  get shopStats(): { records: number; named: number; dropped: number; bytes: number } {
    const out = { records: 0, named: 0, dropped: 0, bytes: 0 };
    for (const c of this.loaded.values()) {
      out.records += c.shopStats.records;
      out.named += c.shopStats.named;
      out.dropped += c.shopStats.dropped;
      if (!isSharedShopTable(c.shops)) out.bytes += (c.shops.image.data as Uint16Array).byteLength;
    }
    return out;
  }
}
