/** Encabezado de una red del pipeline (en el manifest): tramos, nodos, puntos y metros por unidad. */
export interface GraphInfo {
  edges: number;
  nodes: number;
  points: number;
  unit: number;
}

/**
 * Red de tramos entre nodos del pipeline (traffic.bin, walks.bin), little endian: from y to
 * (uint32 por tramo), inicio de los puntos de cada tramo (uint32, tramos + 1) y puntos (int16
 * x, z en `unit` m); después, las columnas propias de cada red, de un byte por tramo, que cada
 * subclase lee en orden con `column()` y cierra con `finish()`. Arma el largo recorrido hasta
 * cada punto, cuántos tramos tocan cada nodo y una grilla de tramos por celda para encontrar
 * los cercanos.
 */
export class EdgeGraph {
  readonly edges: number;
  readonly nodes: number;
  readonly from: Uint32Array;
  readonly to: Uint32Array;
  readonly start: Uint32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Largo recorrido hasta cada punto, desde el comienzo de su tramo. */
  readonly arc: Float32Array;
  readonly length: Float32Array;
  /** Tramos que tocan cada nodo (hasta 255). */
  readonly degree: Uint8Array;
  private readonly cells = new Map<number, number[]>();
  private offset = 0;

  constructor(
    private readonly buffer: ArrayBuffer,
    info: GraphInfo,
    private readonly cell: number,
  ) {
    const E = info.edges;
    const P = info.points;
    const u32 = (n: number): Uint32Array => {
      const a = new Uint32Array(buffer, this.offset, n);
      this.offset += n * 4;
      return a;
    };
    this.edges = E;
    this.nodes = info.nodes;
    this.from = u32(E);
    this.to = u32(E);
    this.start = u32(E + 1);
    const pts = new Int16Array(buffer, this.offset, P * 2);
    this.offset += P * 4;

    this.x = new Float32Array(P);
    this.z = new Float32Array(P);
    this.arc = new Float32Array(P);
    this.length = new Float32Array(E);
    for (let k = 0; k < P; k++) {
      this.x[k] = pts[k * 2] * info.unit;
      this.z[k] = pts[k * 2 + 1] * info.unit;
    }
    for (let e = 0; e < E; e++) {
      let s = 0;
      for (let k = this.start[e] + 1; k < this.start[e + 1]; k++) {
        s += Math.hypot(this.x[k] - this.x[k - 1], this.z[k] - this.z[k - 1]);
        this.arc[k] = s;
      }
      this.length[e] = s;
    }

    this.degree = new Uint8Array(info.nodes);
    for (let e = 0; e < E; e++) {
      this.degree[this.from[e]] = Math.min(this.degree[this.from[e]] + 1, 255);
      this.degree[this.to[e]] = Math.min(this.degree[this.to[e]] + 1, 255);
    }

    // Grilla: cada tramo en las celdas que toca su caja.
    for (let e = 0; e < E; e++) {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let k = this.start[e]; k < this.start[e + 1]; k++) {
        x0 = Math.min(x0, this.x[k]);
        x1 = Math.max(x1, this.x[k]);
        z0 = Math.min(z0, this.z[k]);
        z1 = Math.max(z1, this.z[k]);
      }
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
          const key = this.cellKey(i, j);
          const list = this.cells.get(key);
          if (list) list.push(e);
          else this.cells.set(key, [e]);
        }
      }
    }
  }

  /** Siguiente columna de un byte por tramo, en el orden del archivo. */
  protected column(): Uint8Array {
    const a = new Uint8Array(this.buffer, this.offset, this.edges);
    this.offset += this.edges;
    return a;
  }

  /** Comprueba que las columnas leídas cubren el archivo entero. */
  protected finish(name: string): void {
    if (this.offset !== this.buffer.byteLength) {
      throw new Error(`${name} inválido: ${this.buffer.byteLength} bytes, se esperaban ${this.offset}`);
    }
  }

  private cellKey(i: number, j: number): number {
    // Celdas con índices de hasta ±2^15: caben de a pares en un número.
    return (i + 32768) * 65536 + (j + 32768);
  }

  /** Tramos con alguna celda a menos de `radius` de (x, z) (sin repetir). */
  near(x: number, z: number, radius: number, out: number[], seen: Set<number>): void {
    out.length = 0;
    seen.clear();
    const c = this.cell;
    for (let i = Math.floor((x - radius) / c); i <= Math.floor((x + radius) / c); i++) {
      for (let j = Math.floor((z - radius) / c); j <= Math.floor((z + radius) / c); j++) {
        const dx = Math.max(i * c - x, 0, x - (i + 1) * c);
        const dz = Math.max(j * c - z, 0, z - (j + 1) * c);
        if (dx * dx + dz * dz > radius * radius) continue;
        for (const e of this.cells.get(this.cellKey(i, j)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          out.push(e);
        }
      }
    }
  }

  /** Nodo al que se llega recorriendo el tramo en ese sentido (0 = el del dibujo, 1 = al revés). */
  endNode(e: number, back: number): number {
    return back ? this.from[e] : this.to[e];
  }
}
