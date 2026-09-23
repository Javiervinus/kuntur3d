import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig, WorldManifest } from '../core/types';
import { type PhotoRect, createWaterMaterial, setWaterPhoto, tickWater } from '../render/waterMaterial';

/**
 * Río Guayas, Daule, Babahoyo y esteros a partir de los polígonos de Overture (paso `water`).
 * Cada polígono dice si es río de agua dulce (`fresh`): ahí flotan los lechuguines.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshStandardMaterial;

  private constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    private readonly cfg: GameConfig['water'],
    /** Polígonos del agua (anillos [x, z, …] en el marco local): también los dibuja el mapa del HUD. */
    readonly polygons: number[][][],
  ) {
    this.material = material;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'water';
    this.mesh.receiveShadow = true;
  }

  static async load(baseUrl: string, manifest: WorldManifest, cfg: GameConfig['water']): Promise<Water> {
    const res = await fetch(new URL(manifest.water.url, baseUrl));
    if (!res.ok) throw new Error(`No se pudo cargar el agua (${res.status})`);
    const data = (await res.json()) as { polygons: number[][][]; fresh?: number[] };
    const toPoints = (ring: number[]): THREE.Vector2[] => {
      const pts: THREE.Vector2[] = [];
      // Shape vive en XY; al rotar -90° en X, (x, y) pasa a (x, -y) en z, por eso se niega z.
      for (let k = 0; k < ring.length; k += 2) pts.push(new THREE.Vector2(ring[k], -ring[k + 1]));
      return pts;
    };
    // Una geometría por clase de agua, con su marca por vértice, y después una sola malla.
    const parts: THREE.BufferGeometry[] = [];
    for (const kind of [0, 1]) {
      const shapes = data.polygons
        .filter((_, k) => (data.fresh?.[k] ?? 0) === kind)
        .map(([outer, ...holes]) => {
          const shape = new THREE.Shape(toPoints(outer));
          shape.holes = holes.map((hole) => new THREE.Path(toPoints(hole)));
          return shape;
        });
      if (!shapes.length) continue;
      const part = new THREE.ShapeGeometry(shapes);
      part.deleteAttribute('uv');
      part.setAttribute('aFresh', new THREE.BufferAttribute(new Float32Array(part.getAttribute('position').count).fill(kind), 1));
      parts.push(part);
    }
    const geometry = mergeGeometries(parts);
    if (!geometry) throw new Error('No se pudo armar el agua');
    for (const part of parts) part.dispose();
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, manifest.waterLevel + cfg.offset, 0);
    geometry.computeBoundingSphere();
    return new Water(geometry, createWaterMaterial(cfg), cfg, data.polygons);
  }

  /** Color del agua desde la foto satelital general (sedimento y canales reales). */
  setPhoto(texture: THREE.Texture, rect: PhotoRect): void {
    setWaterPhoto(this.material, texture, rect, this.cfg.photoMix);
  }

  update(time: number): void {
    tickWater(this.material, time);
  }
}
