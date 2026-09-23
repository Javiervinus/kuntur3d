import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import { lighting } from '../render/lightingUniforms';

type SkyConfig = GameConfig['render']['lighting']['skyOcclusion'];
type Listener = (i: number, j: number, texture: THREE.Texture) => void;

/**
 * Oclusión ambiental precalculada (pipeline → paso `ao`): por chunk, una imagen con el cielo
 * que ve el suelo en cada punto (R: entre edificios y relieve, G: contando además las copas de
 * los árboles) y la altura de lo que tapa el horizonte (B, en `heightUnit` m). Las calles
 * angostas entre edificios altos reciben menos luz del cielo; las fachadas, menos abajo que
 * arriba. Se carga alrededor del jugador; los chunks sin imagen están a cielo abierto.
 */
export class SkyOcclusion {
  /** Cielo abierto: la textura de los chunks sin imagen o todavía sin cargar. */
  readonly open: THREE.DataTexture;
  private readonly available = new Set<number>();
  private readonly loaded = new Map<number, THREE.Texture>();
  private readonly loading = new Set<number>();
  private readonly listeners = new Set<Listener>();
  private readonly loader = new THREE.ImageBitmapLoader();

  constructor(
    private readonly baseUrl: string,
    private readonly manifest: WorldManifest,
    private readonly cfg: SkyConfig,
  ) {
    this.open = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1);
    this.open.needsUpdate = true;
    for (const [i, j] of manifest.ao?.chunks ?? []) this.available.add(this.key(i, j));
    // Son datos, no color: sin conversiones al decodificar.
    this.loader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    lighting.uSkyLook.value.set(cfg.canopyOpacity, cfg.ambient, cfg.photo, cfg.specular);
    const f = cfg.facade;
    // El canal B llega normalizado (0…1): metros = B · 255 · heightUnit.
    lighting.uSkyFacade.value.set(f.frontOffset, f.gain, f.min, 255 * (manifest.ao?.heightUnit ?? 0));
  }

  private key(i: number, j: number): number {
    return j * this.manifest.chunks.nx + i;
  }

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }

  current(i: number, j: number): THREE.Texture {
    return this.loaded.get(this.key(i, j)) ?? this.open;
  }

  private emit(i: number, j: number): void {
    const texture = this.current(i, j);
    for (const fn of this.listeners) fn(i, j, texture);
  }

  private distance(i: number, j: number, x: number, z: number): number {
    const { size, xmin, zmin } = this.manifest.chunks;
    return Math.hypot(
      Math.max(xmin + i * size - x, 0, x - (xmin + (i + 1) * size)),
      Math.max(zmin + j * size - z, 0, z - (zmin + (j + 1) * size)),
    );
  }

  /** Carga los chunks cercanos (los más cercanos primero) y libera los lejanos. */
  update(focusX: number, focusZ: number): void {
    const info = this.manifest.ao;
    if (!info) return;
    const { size, nx, nz, xmin, zmin } = this.manifest.chunks;
    for (const [k, texture] of this.loaded) {
      const i = k % nx;
      const j = Math.floor(k / nx);
      if (this.distance(i, j, focusX, focusZ) > this.cfg.radius + this.cfg.hysteresis) {
        this.loaded.delete(k);
        this.emit(i, j);
        texture.dispose();
        (texture.image as ImageBitmap).close();
      }
    }
    const r = this.cfg.radius;
    const wanted: { i: number; j: number; d: number }[] = [];
    const i0 = Math.max(0, Math.floor((focusX - r - xmin) / size));
    const i1 = Math.min(nx - 1, Math.floor((focusX + r - xmin) / size));
    const j0 = Math.max(0, Math.floor((focusZ - r - zmin) / size));
    const j1 = Math.min(nz - 1, Math.floor((focusZ + r - zmin) / size));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = this.key(i, j);
        if (!this.available.has(k) || this.loaded.has(k) || this.loading.has(k)) continue;
        const d = this.distance(i, j, focusX, focusZ);
        if (d <= r) wanted.push({ i, j, d });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    const free = this.cfg.concurrency - this.loading.size;
    for (const w of wanted.slice(0, Math.max(0, free))) void this.load(w.i, w.j, focusX, focusZ);
  }

  private async load(i: number, j: number, focusX: number, focusZ: number): Promise<void> {
    const info = this.manifest.ao;
    if (!info) return;
    const k = this.key(i, j);
    this.loading.add(k);
    try {
      const url = new URL(info.url.replace('{i}', String(i)).replace('{j}', String(j)), this.baseUrl).href;
      const bitmap = await this.loader.loadAsync(url);
      if (this.distance(i, j, focusX, focusZ) > this.cfg.radius + this.cfg.hysteresis) {
        bitmap.close();
        return;
      }
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      this.loaded.set(k, texture);
      this.emit(i, j);
    } catch (err) {
      console.warn('[ao] chunk', i, j, err);
      this.available.delete(k);
    } finally {
      this.loading.delete(k);
    }
  }
}
