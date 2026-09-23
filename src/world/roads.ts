import * as THREE from 'three';
import { DataUtils } from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import { createRoadShading, type RoadShading } from '../render/materials';
import type { RoadError, RoadRequest, RoadResult } from './roadWorker';

/** Texturas de calles de un chunk (contenido de cada canal en roadWorker.ts). */
export interface RoadLayer {
  textures: THREE.DataTexture[];
  /** Los mismos datos en la CPU (medio float), para preguntar qué superficie hay en un punto. */
  data: Uint16Array[];
  side: number;
}

/** Superficies que no son un material de calzada (ver `Roads.surfaceAt`). */
export const SURFACE = { sidewalk: 'sidewalk', park: 'park', pitch: 'pitch', offroad: 'offroad' } as const;

type Listener = (i: number, j: number, layer: RoadLayer | null) => void;

/**
 * Calles alrededor del jugador: cada chunk se rasteriza en un worker a texturas de
 * distancia, que el shader del terreno usa para dibujar calzada, veredas y marcas
 * nítidas encima de la foto satelital.
 */
export class Roads {
  readonly shading: RoadShading;
  private readonly available = new Set<number>();
  private readonly loaded = new Map<number, RoadLayer>();
  private readonly requested = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly ready: { key: number; result: RoadResult }[] = [];
  private readonly wanted = new Set<number>();
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<number, (r: RoadResult | RoadError) => void>();
  private readonly workers: Worker[] = [];
  private readonly channelOf: number[];
  private nextId = 0;
  private nextWorker = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly manifest: WorldManifest,
    private readonly cfg: GameConfig['roads'],
    private readonly stream: GameConfig['streaming'],
  ) {
    const info = manifest.roads;
    for (const [i, j] of info?.chunks ?? []) this.available.add(this.key(i, j));
    this.channelOf = (info?.materials ?? []).map((name) => {
      const channel = cfg.drawOrder.indexOf(name);
      if (channel < 0) throw new Error(`Material de calle sin orden de dibujo en config/game.json: ${name}`);
      return channel;
    });
    const cells = Math.round(manifest.chunks.size / cfg.raster.texel);
    this.shading = createRoadShading(cfg, cells, cells + 2);
    if (!info) return;
    for (let w = 0; w < stream.roadWorkers; w++) {
      const worker = new Worker(new URL('./roadWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<RoadResult | RoadError>) => {
        this.pending.get(e.data.id)?.(e.data);
        this.pending.delete(e.data.id);
      };
      this.workers.push(worker);
    }
  }

  /** Hay datos de calles en el manifest (si no, el terreno se dibuja solo con la foto). */
  get enabled(): boolean {
    return this.workers.length > 0;
  }

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }

  current(i: number, j: number): RoadLayer | null {
    return this.loaded.get(this.key(i, j)) ?? null;
  }

  /**
   * Qué hay en el suelo en (x, z): el material de la calzada (nombre de `drawOrder`), vereda,
   * parque, cancha o fuera de calle; null si ese chunk no tiene las calles cargadas. Lee el
   * texel más cercano de las mismas texturas que dibuja el terreno: lo que se ve es lo que se pisa.
   */
  surfaceAt(x: number, z: number): string | null {
    const { size, nx, nz, xmin, zmin } = this.manifest.chunks;
    const i = Math.floor((x - xmin) / size);
    const j = Math.floor((z - zmin) / size);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return null;
    const layer = this.loaded.get(this.key(i, j));
    if (!layer) return this.available.has(this.key(i, j)) ? null : SURFACE.offroad;
    const t = size / (layer.side - 2);
    // Centro del texel k = origen + (k − ½)·t (hay un texel de borde por lado).
    const col = Math.min(layer.side - 1, Math.max(0, Math.round((x - (xmin + i * size)) / t + 0.5)));
    const row = Math.min(layer.side - 1, Math.max(0, Math.round((z - (zmin + j * size)) / t + 0.5)));
    const o = (row * layer.side + col) * 4;
    const [t0, t1, , t3] = layer.data;
    const half = DataUtils.fromHalfFloat;
    let nearest = Infinity;
    for (let c = 0; c < this.cfg.drawOrder.length; c++) {
      const sd = half(t0[o + c]);
      if (sd < 0) return this.cfg.drawOrder[c];
      nearest = Math.min(nearest, sd);
    }
    if (nearest <= half(t1[o])) return SURFACE.sidewalk;
    if (half(t3[o + 1]) < 0) return SURFACE.pitch;
    if (half(t3[o]) < 0) return SURFACE.park;
    return SURFACE.offroad;
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

  /** Decide qué chunks deben tener calles y pide a los workers los que faltan (los más cercanos primero). */
  update(focusX: number, focusZ: number): void {
    if (!this.enabled) return;
    const s = this.stream;
    this.wanted.clear();
    for (const k of this.available) {
      const d = this.distance(k, focusX, focusZ);
      const keep = this.loaded.has(k) || this.requested.has(k);
      if (d <= s.roadRadius || (keep && d <= s.roadRadius + s.roadHysteresis)) this.wanted.add(k);
    }
    for (const k of [...this.loaded.keys()]) if (!this.wanted.has(k)) this.unload(k);
    const todo = [...this.wanted]
      .filter((k) => !this.loaded.has(k) && !this.requested.has(k) && !this.failed.has(k))
      .sort((a, b) => this.distance(a, focusX, focusZ) - this.distance(b, focusX, focusZ));
    for (const k of todo) {
      if (this.requested.size >= this.workers.length * 2) break;
      this.request(k);
    }
  }

  /** Sube a la GPU las texturas que ya armaron los workers (tope por frame). */
  pump(): void {
    for (let n = 0; n < this.stream.roadTexturesPerFrame && this.ready.length; n++) {
      const { key, result } = this.ready.shift()!;
      if (this.wanted.has(key) && !this.loaded.has(key)) this.install(key, result);
    }
  }

  private request(k: number): void {
    const info = this.manifest.roads!;
    const { size, nx, xmin, zmin } = this.manifest.chunks;
    const i = k % nx;
    const j = Math.floor(k / nx);
    const id = this.nextId++;
    this.requested.add(k);
    this.pending.set(id, (r) => {
      this.requested.delete(k);
      if (!r.ok) {
        this.failed.add(k);
        console.warn('[roads] chunk', i, j, r.error);
      } else if (this.wanted.has(k) && !this.loaded.has(k)) {
        this.ready.push({ key: k, result: r });
      }
    });
    const message: RoadRequest = {
      id,
      url: new URL(info.url.replace('{i}', String(i)).replace('{j}', String(j)), this.baseUrl).href,
      x0: xmin + i * size,
      z0: zmin + j * size,
      size,
      raster: this.cfg.raster,
      channelOf: this.channelOf,
    };
    this.workers[this.nextWorker++ % this.workers.length].postMessage(message);
  }

  private install(k: number, r: RoadResult): void {
    const textures = r.data.map((data) => {
      const texture = new THREE.DataTexture(data, r.side, r.side, THREE.RGBAFormat, THREE.HalfFloatType);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    });
    const layer: RoadLayer = { textures, data: r.data, side: r.side };
    this.loaded.set(k, layer);
    this.emit(k, layer);
  }

  private unload(k: number): void {
    const layer = this.loaded.get(k);
    if (!layer) return;
    this.loaded.delete(k);
    this.emit(k, null);
    for (const texture of layer.textures) texture.dispose();
  }

  private emit(k: number, layer: RoadLayer | null): void {
    const { nx } = this.manifest.chunks;
    for (const fn of this.listeners) fn(k % nx, Math.floor(k / nx), layer);
  }

  get stats(): { chunks: number; queued: number } {
    return { chunks: this.loaded.size, queued: this.requested.size + this.ready.length };
  }
}
