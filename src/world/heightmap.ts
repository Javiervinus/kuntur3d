import type { WorldManifest } from '../core/types';

/** Heightmap global (fila = z, columna = x) con muestreo bilineal. */
export class Heightmap {
  readonly width: number;
  readonly height: number;
  readonly spacing: number;
  readonly xmin: number;
  readonly zmin: number;
  private readonly data: Float32Array;

  constructor(info: WorldManifest['heightmap'], data: Float32Array) {
    this.width = info.width;
    this.height = info.height;
    this.spacing = info.spacing;
    this.xmin = info.xmin;
    this.zmin = info.zmin;
    this.data = data;
  }

  /**
   * Baja y arma el relieve: viene en 16 bits, como diferencias a lo largo de cada fila y con gzip
   * (~5 MB en vez de 29 MB; ver el paso `terrain` del pipeline). Se descomprime con el
   * DecompressionStream del navegador y se suma fila por fila.
   */
  static async load(baseUrl: string, info: WorldManifest['heightmap']): Promise<Heightmap> {
    const res = await fetch(new URL(info.url, baseUrl));
    if (!res.ok || !res.body) throw new Error(`No se pudo cargar el heightmap (${res.status})`);
    const raw = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const delta = new Uint16Array(raw);
    const expected = info.width * info.height;
    if (delta.length !== expected) {
      throw new Error(`heightmap inválido: ${delta.length} muestras, se esperaban ${expected}`);
    }
    const data = new Float32Array(expected);
    for (let r = 0; r < info.height; r++) {
      const row = r * info.width;
      let q = 0;
      for (let c = 0; c < info.width; c++) {
        q = (q + delta[row + c]) & 0xffff;
        data[row + c] = info.offset + q * info.scale;
      }
    }
    return new Heightmap(info, data);
  }

  /** Altura en un vértice de la grilla (con clamp a los bordes). */
  at(col: number, row: number): number {
    const c = Math.min(Math.max(col, 0), this.width - 1);
    const r = Math.min(Math.max(row, 0), this.height - 1);
    return this.data[r * this.width + c];
  }

  sample(x: number, z: number): number {
    const fc = (x - this.xmin) / this.spacing;
    const fr = (z - this.zmin) / this.spacing;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const tz = fr - r0;
    const h00 = this.at(c0, r0);
    const h10 = this.at(c0 + 1, r0);
    const h01 = this.at(c0, r0 + 1);
    const h11 = this.at(c0 + 1, r0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Normal por diferencias centrales en un vértice de la grilla (sin costuras entre chunks). */
  normalAt(col: number, row: number, out: [number, number, number]): void {
    const dx = (this.at(col + 1, row) - this.at(col - 1, row)) / (2 * this.spacing);
    const dz = (this.at(col, row + 1) - this.at(col, row - 1)) / (2 * this.spacing);
    const len = Math.hypot(dx, 1, dz);
    out[0] = -dx / len;
    out[1] = 1 / len;
    out[2] = -dz / len;
  }
}
