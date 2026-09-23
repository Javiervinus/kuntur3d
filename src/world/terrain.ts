import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import { createFarTerrainMaterial, createTerrainMaterial, setRoadLayer, setSkyMap } from '../render/materials';
import type { Heightmap } from './heightmap';
import type { ChunkImage, Imagery } from './imagery';
import type { Roads } from './roads';
import type { SkyOcclusion } from './skyOcclusion';

interface NearChunk {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
}

/**
 * Terreno en dos capas: una malla general de todo el mundo (vista general, baja
 * resolución) y mallas detalladas por chunk alrededor del jugador. La general se
 * descarta en el shader donde ya hay un chunk detallado (máscara por chunk).
 * Los chunks detallados dibujan además las calles (texturas de `Roads`).
 */
export class Terrain {
  readonly group = new THREE.Group();
  private readonly near = new Map<number, NearChunk>();
  private readonly mask: THREE.DataTexture;

  constructor(
    private readonly manifest: WorldManifest,
    private readonly heightmap: Heightmap,
    private readonly imagery: Imagery,
    private readonly roads: Roads,
    private readonly sky: SkyOcclusion,
    private readonly cfg: GameConfig['terrain'],
    private readonly stream: GameConfig['streaming'],
  ) {
    this.group.name = 'terrain';
    const { nx, nz } = manifest.chunks;
    this.mask = new THREE.DataTexture(new Uint8Array(nx * nz), nx, nz, THREE.RedFormat);
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    imagery.onChange((i, j, image) => this.setImage(i, j, image));
    roads.onChange((i, j, layer) => {
      const chunk = this.near.get(this.key(i, j));
      if (chunk) setRoadLayer(chunk.material, layer);
    });
    sky.onChange((i, j, texture) => {
      const chunk = this.near.get(this.key(i, j));
      if (chunk) setSkyMap(chunk.material, texture);
    });
  }

  private key(i: number, j: number): number {
    return j * this.manifest.chunks.nx + i;
  }

  /** Malla general de todo el mundo con la vista general. */
  buildFar(overview: THREE.Texture): void {
    const hm = this.heightmap;
    const { size, nx, nz, xmin, zmin } = this.manifest.chunks;
    const step = this.cfg.farStep;
    const cols = Math.floor((hm.width - 1) / step) + 1;
    const rows = Math.floor((hm.height - 1) / step) + 1;
    const positions = new Float32Array(cols * rows * 3);
    const normals = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    const normal: [number, number, number] = [0, 1, 0];
    const width = nx * size;
    const depth = nz * size;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        const x = hm.xmin + c * step * hm.spacing;
        const z = hm.zmin + r * step * hm.spacing;
        positions[k * 3] = x;
        positions[k * 3 + 1] = hm.at(c * step, r * step) + this.cfg.farOffset;
        positions[k * 3 + 2] = z;
        hm.normalAt(c * step, r * step, normal);
        normals.set(normal, k * 3);
        uvs[k * 2] = (x - xmin) / width;
        uvs[k * 2 + 1] = 1 - (z - zmin) / depth;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(gridIndex(cols, rows));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, createFarTerrainMaterial(this.cfg, overview, this.mask, this.manifest.chunks));
    mesh.receiveShadow = true;
    mesh.name = 'terrain-far';
    this.group.add(mesh);
  }

  /** Crea/descarta chunks detallados según la distancia al foco. */
  update(focusX: number, focusZ: number): void {
    const { size, nx, nz, xmin, zmin } = this.manifest.chunks;
    const r = this.stream.terrainRadius;
    const drop = r + this.stream.terrainHysteresis;
    const dist = (i: number, j: number): number =>
      Math.hypot(
        Math.max(xmin + i * size - focusX, 0, focusX - (xmin + (i + 1) * size)),
        Math.max(zmin + j * size - focusZ, 0, focusZ - (zmin + (j + 1) * size)),
      );

    let maskDirty = false;
    for (const [k, chunk] of this.near) {
      const i = k % nx;
      const j = Math.floor(k / nx);
      if (dist(i, j) > drop) {
        this.group.remove(chunk.mesh);
        chunk.mesh.geometry.dispose();
        chunk.material.dispose();
        this.near.delete(k);
        this.mask.image.data![k] = 0;
        maskDirty = true;
      }
    }

    const wanted: { i: number; j: number; d: number }[] = [];
    const i0 = Math.max(0, Math.floor((focusX - r - xmin) / size));
    const i1 = Math.min(nx - 1, Math.floor((focusX + r - xmin) / size));
    const j0 = Math.max(0, Math.floor((focusZ - r - zmin) / size));
    const j1 = Math.min(nz - 1, Math.floor((focusZ + r - zmin) / size));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = dist(i, j);
        if (d <= r && !this.near.has(this.key(i, j))) wanted.push({ i, j, d });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    for (const w of wanted.slice(0, this.stream.terrainMeshesPerUpdate)) {
      this.addChunk(w.i, w.j);
      this.mask.image.data![this.key(w.i, w.j)] = 255;
      maskDirty = true;
    }
    if (maskDirty) this.mask.needsUpdate = true;
  }

  private setImage(i: number, j: number, image: ChunkImage): void {
    const chunk = this.near.get(this.key(i, j));
    if (!chunk) return;
    chunk.material.map = image.texture;
    chunk.material.emissiveMap = image.texture;
    chunk.material.needsUpdate = true;
  }

  private addChunk(i: number, j: number): void {
    const { size, xmin, zmin } = this.manifest.chunks;
    const hm = this.heightmap;
    const x0 = xmin + i * size;
    const z0 = zmin + j * size;
    const steps = Math.round(size / hm.spacing);
    const col0 = Math.round((x0 - hm.xmin) / hm.spacing);
    const row0 = Math.round((z0 - hm.zmin) / hm.spacing);
    const n = steps + 1;

    const positions = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const normal: [number, number, number] = [0, 1, 0];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const k = r * n + c;
        positions[k * 3] = x0 + c * hm.spacing;
        positions[k * 3 + 1] = hm.at(col0 + c, row0 + r);
        positions[k * 3 + 2] = z0 + r * hm.spacing;
        hm.normalAt(col0 + c, row0 + r, normal);
        normals.set(normal, k * 3);
        uvs[k * 2] = c / steps;
        uvs[k * 2 + 1] = 1 - r / steps;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(gridIndex(n, n));
    geometry.computeBoundingSphere();

    const roads = this.roads.enabled ? this.roads.shading : null;
    const material = createTerrainMaterial(
      this.cfg,
      this.imagery.current(i, j).texture,
      { x0, z0, size },
      roads,
      this.sky.current(i, j),
    );
    setRoadLayer(material, this.roads.current(i, j));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.name = `terrain-${i}-${j}`;
    this.group.add(mesh);
    this.near.set(this.key(i, j), { mesh, material });
  }

  get nearCount(): number {
    return this.near.size;
  }
}

/** Índices de una grilla (filas hacia el sur, columnas hacia el este) con caras hacia arriba. */
function gridIndex(cols: number, rows: number): THREE.BufferAttribute {
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + cols;
      index[p++] = a;
      index[p++] = b;
      index[p++] = a + 1;
      index[p++] = a + 1;
      index[p++] = b;
      index[p++] = b + 1;
    }
  }
  return new THREE.BufferAttribute(index, 1);
}
