import * as THREE from 'three';
import type { GeoFrame } from '../core/geo';
import type { GameConfig, WorldManifest } from '../core/types';
import type { ImageryError, ImageryRequest, ImageryResult } from './imageryWorker';

/**
 * Imagen de un chunk: textura + matriz que lleva la UV local del chunk
 * (u = este, v = norte, 0..1) a la UV de esa textura.
 */
export interface ChunkImage {
  texture: THREE.Texture;
  matrix: THREE.Matrix3;
}

type Listener = (i: number, j: number, image: ChunkImage) => void;

interface Streamed {
  zoom: number;
  image: ChunkImage;
}

/**
 * Imagen satelital por chunk. Lejos se usa la vista general del mundo (una sola
 * textura); cerca se arma una textura con tiles Web Mercator de alta resolución
 * pedidos al proxy local, que los guarda en caché. El armado va en un worker (ver
 * imageryWorker.ts): un solo worker para que los chunks vecinos compartan su caché de tiles.
 */
export class Imagery {
  private overview: THREE.Texture | null = null;
  private readonly overviewClones = new Map<number, ChunkImage>();
  private readonly streamed = new Map<number, Streamed>();
  private readonly loading = new Set<number>();
  private readonly listeners = new Set<Listener>();
  private readonly anisotropy: number;
  /** URL de cada tile con {z}, {x} e {y}: el proxy del servidor de Vite o la fuente directa. */
  private readonly tileTemplate: string;
  private readonly worker: Worker;
  private readonly pending = new Map<number, (r: ImageryResult | ImageryError) => void>();
  private nextId = 0;

  constructor(
    private readonly manifest: WorldManifest,
    private readonly geo: GeoFrame,
    private readonly cfg: GameConfig['imagery'],
    renderer: THREE.WebGLRenderer,
  ) {
    this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // En desarrollo, el proxy con caché en disco (la misma del pipeline). Publicado no hay ese
    // servidor: se piden directo a la fuente, que permite CORS.
    this.tileTemplate = import.meta.env.DEV ? `${new URL(`${cfg.proxyPath}/`, document.baseURI).href}{z}/{x}/{y}` : __IMAGERY_SOURCE__;
    this.worker = new Worker(new URL('./imageryWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<ImageryResult | ImageryError>) => {
      this.pending.get(e.data.id)?.(e.data);
      this.pending.delete(e.data.id);
    };
    // Si el worker falla, los pedidos en curso se cierran con error en vez de quedar colgados
    // ocupando cupos de `concurrency` (el chunk sigue con la vista general).
    this.worker.onerror = (e) => {
      for (const [id, done] of this.pending) done({ id, ok: false, error: e.message });
      this.pending.clear();
    };
  }

  private key(i: number, j: number): number {
    return j * this.manifest.chunks.nx + i;
  }

  async loadOverview(baseUrl: string): Promise<THREE.Texture> {
    let texture: THREE.Texture = await new THREE.TextureLoader().loadAsync(new URL(this.manifest.overview.url, baseUrl).href);
    // Achicada si pasa `overviewMaxSize` (perfil de celular): a 4096 px ocupa ~80 MB en la GPU.
    const image = texture.image as HTMLImageElement;
    const scale = this.cfg.overviewMaxSize / Math.max(image.width, image.height);
    if (scale < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D no disponible para achicar la vista general');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.dispose();
      texture = new THREE.CanvasTexture(canvas);
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    this.overview = texture;
    return texture;
  }

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }

  /** Vista general recortada al chunk (clon: comparte la imagen en GPU, con su propia matriz). */
  private overviewImage(i: number, j: number): ChunkImage {
    const k = this.key(i, j);
    const cached = this.overviewClones.get(k);
    if (cached) return cached;
    const image = this.overviewSpan(i, j, 1);
    this.overviewClones.set(k, image);
    return image;
  }

  /**
   * Vista general recortada a un cuadrado de `span`×`span` chunks que empieza en el chunk
   * (i0, j0): para los grupos del horizonte lejano. UV local del cuadrado → UV de la vista.
   */
  overviewSpan(i0: number, j0: number, span: number): ChunkImage {
    if (!this.overview) throw new Error('La vista general todavía no está cargada');
    const { nx, nz } = this.manifest.chunks;
    // clone() marca como nueva la imagen compartida (Texture.copy → needsUpdate) y obligaría a
    // decodificar y volver a subir los 4096 px de la vista general por cada chunk (~125 ms de
    // tirón). Se restaura su versión: el clon usa la misma textura que ya está en la GPU.
    const version = this.overview.source.version;
    const texture = this.overview.clone();
    texture.source.version = version;
    texture.matrixAutoUpdate = false;
    // Lineal: la vista general y el cuadrado están en el mismo marco local.
    const sx = 1 / nx;
    const sz = 1 / nz;
    texture.matrix.set(span * sx, 0, i0 * sx, 0, span * sz, 1 - (j0 + span) * sz, 0, 0, 1);
    return { texture, matrix: texture.matrix };
  }

  current(i: number, j: number): ChunkImage {
    return this.streamed.get(this.key(i, j))?.image ?? this.overviewImage(i, j);
  }

  private emit(i: number, j: number): void {
    const image = this.current(i, j);
    for (const fn of this.listeners) fn(i, j, image);
  }

  /** Zoom deseado para un chunk a distancia `d` (null = basta la vista general). */
  private zoomFor(d: number, altitude: number): number | null {
    const grow = 1 + (Math.max(0, altitude) / 100) * (this.cfg.altitudeRadiusFactor - 1);
    for (const level of this.cfg.levels) if (d <= level.radius * grow) return level.zoom;
    return null;
  }

  update(focusX: number, focusZ: number, altitude: number): void {
    const { size, nx, nz, xmin, zmin } = this.manifest.chunks;
    const maxRadius = Math.max(...this.cfg.levels.map((l) => l.radius)) * this.cfg.altitudeRadiusFactor;
    const i0 = Math.max(0, Math.floor((focusX - maxRadius - xmin) / size));
    const i1 = Math.min(nx - 1, Math.floor((focusX + maxRadius - xmin) / size));
    const j0 = Math.max(0, Math.floor((focusZ - maxRadius - zmin) / size));
    const j1 = Math.min(nz - 1, Math.floor((focusZ + maxRadius - zmin) / size));

    const wanted: { i: number; j: number; d: number; zoom: number }[] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = this.distance(i, j, focusX, focusZ);
        const zoom = this.zoomFor(d, altitude);
        if (zoom !== null) wanted.push({ i, j, d, zoom });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    const keep = new Map<number, number>();
    for (const w of wanted.slice(0, this.cfg.maxTextures)) keep.set(this.key(w.i, w.j), w.zoom);

    // Liberar lo que quedó lejos (con histéresis para no parpadear en el borde).
    for (const [k, s] of this.streamed) {
      const i = k % nx;
      const j = Math.floor(k / nx);
      const zoomNow = this.zoomFor(Math.max(0, this.distance(i, j, focusX, focusZ) - this.cfg.hysteresis), altitude);
      if (!keep.has(k) && zoomNow === null) {
        s.image.texture.dispose();
        this.streamed.delete(k);
        this.emit(i, j);
      }
    }

    for (const w of wanted) {
      if (this.loading.size >= this.cfg.concurrency) break;
      const k = this.key(w.i, w.j);
      const zoom = keep.get(k);
      if (zoom === undefined || this.loading.has(k) || this.streamed.get(k)?.zoom === zoom) continue;
      this.loading.add(k);
      this.build(w.i, w.j, zoom)
        .then((image) => {
          const previous = this.streamed.get(k);
          this.streamed.set(k, { zoom, image });
          this.emit(w.i, w.j);
          previous?.image.texture.dispose();
        })
        .catch((err: unknown) => console.warn('[imagery] chunk', w.i, w.j, err))
        .finally(() => this.loading.delete(k));
    }
  }

  private distance(i: number, j: number, x: number, z: number): number {
    const { size, xmin, zmin } = this.manifest.chunks;
    const dx = Math.max(xmin + i * size - x, 0, x - (xmin + (i + 1) * size));
    const dz = Math.max(zmin + j * size - z, 0, z - (zmin + (j + 1) * size));
    return Math.hypot(dx, dz);
  }

  /** Pide al worker la imagen del rectángulo (píxeles globales del zoom). */
  private compose(zoom: number, x: number, y: number, width: number, height: number): Promise<ImageBitmap> {
    const id = this.nextId++;
    const request: ImageryRequest = {
      id,
      template: this.tileTemplate,
      zoom,
      tileSize: this.cfg.tileSize,
      x,
      y,
      width,
      height,
      cacheSize: this.cfg.tileCacheSize,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.ok ? resolve(r.bitmap) : reject(new Error(r.error))));
      this.worker.postMessage(request);
    });
  }

  /** Textura del chunk con tiles del zoom pedido y su matriz UV (proyección local -> Web Mercator). */
  private async build(i: number, j: number, zoom: number): Promise<ChunkImage> {
    const { size, xmin, zmin } = this.manifest.chunks;
    const x0 = xmin + i * size;
    const z0 = zmin + j * size;
    const scale = 2 ** zoom * this.cfg.tileSize;
    const toPx = (x: number, z: number): [number, number] => {
      const { lat, lon } = this.geo.toLatLon(x, z);
      const r = (lat * Math.PI) / 180;
      return [((lon + 180) / 360) * scale, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale];
    };
    const nw = toPx(x0, z0);
    const ne = toPx(x0 + size, z0);
    const sw = toPx(x0, z0 + size);
    const se = toPx(x0 + size, z0 + size);
    // Solo el rectángulo que cubre el chunk, con margen para que el filtrado y los mipmaps
    // del borde lean imagen real y no se note la costura con el vecino.
    const margin = this.cfg.cropMarginPx;
    const ox = Math.floor(Math.min(nw[0], ne[0], sw[0], se[0])) - margin;
    const oy = Math.floor(Math.min(nw[1], ne[1], sw[1], se[1])) - margin;
    const width = Math.ceil(Math.max(nw[0], ne[0], sw[0], se[0])) + margin - ox;
    const height = Math.ceil(Math.max(nw[1], ne[1], sw[1], se[1])) + margin - oy;
    const bitmap = await this.compose(zoom, ox, oy, width, height);

    const texture = new THREE.Texture(bitmap);
    // Un ImageBitmap se sube tal cual (el navegador ignora flipY): la fila 0 queda en v = 0.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.matrixAutoUpdate = false;
    texture.needsUpdate = true;
    // Una vez en la GPU, la copia en RAM ya no hace falta (ni si se descarta antes de subirla).
    texture.onUpdate = () => bitmap.close();
    texture.addEventListener('dispose', () => bitmap.close());
    // UV de la imagen en tres esquinas -> transformación afín.
    const cu = (p: [number, number]): number => (p[0] - ox) / width;
    const cv = (p: [number, number]): number => (p[1] - oy) / height;
    texture.matrix.set(
      cu(ne) - cu(nw),
      cu(nw) - cu(sw),
      cu(sw),
      cv(ne) - cv(nw),
      cv(nw) - cv(sw),
      cv(sw),
      0,
      0,
      1,
    );
    return { texture, matrix: texture.matrix };
  }

  get streamedCount(): number {
    return this.streamed.size;
  }
}
