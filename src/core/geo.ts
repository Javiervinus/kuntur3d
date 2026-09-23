import proj4, { type Converter } from 'proj4';
import type { WorldManifest } from './types';

/**
 * Conversión entre lat/lon y el marco local del mundo:
 * x = metros al este del origen, z = metros al sur, y = altura.
 */
export class GeoFrame {
  private readonly converter: Converter;
  private readonly e0: number;
  private readonly n0: number;
  readonly xmin: number;
  readonly zmin: number;
  readonly xmax: number;
  readonly zmax: number;

  constructor(manifest: WorldManifest) {
    this.converter = proj4('EPSG:4326', manifest.proj4);
    this.e0 = manifest.origin.easting;
    this.n0 = manifest.origin.northing;
    const { size, nx, nz, xmin, zmin } = manifest.chunks;
    this.xmin = xmin;
    this.zmin = zmin;
    this.xmax = xmin + nx * size;
    this.zmax = zmin + nz * size;
  }

  toLocal(lat: number, lon: number): { x: number; z: number } {
    const [e, n] = this.converter.forward([lon, lat]);
    return { x: e - this.e0, z: this.n0 - n };
  }

  toLatLon(x: number, z: number): { lat: number; lon: number } {
    const [lon, lat] = this.converter.inverse([this.e0 + x, this.n0 - z]);
    return { lat, lon };
  }

  contains(x: number, z: number, margin = 0): boolean {
    return x >= this.xmin + margin && x <= this.xmax - margin && z >= this.zmin + margin && z <= this.zmax - margin;
  }

  /** Metros desde (x, z) hasta el borde de la zona (0 si está dentro). */
  distanceOutside(x: number, z: number): number {
    const dx = Math.max(this.xmin - x, 0, x - this.xmax);
    const dz = Math.max(this.zmin - z, 0, z - this.zmax);
    return Math.hypot(dx, dz);
  }

  clamp(x: number, z: number, margin: number): { x: number; z: number } {
    return {
      x: Math.min(Math.max(x, this.xmin + margin), this.xmax - margin),
      z: Math.min(Math.max(z, this.zmin + margin), this.zmax - margin),
    };
  }
}
