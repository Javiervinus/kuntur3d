/** Lo mínimo del ámbito de un worker (el proyecto compila con la lib DOM, no WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<LampMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/**
 * Worker de la luz de los postes: pinta la iluminación que cae al suelo (irradiancia) en
 * texturas RGBA8, con el color de cada luminaria. `rgb = sqrt(E / maxIrradiance)` (más
 * precisión en la luz tenue) y `a` = altura del suelo (base + a · rango); el shader lo
 * decodifica (ver render/nightLight.ts).
 *
 * - `near`: un cuadrado de `size` m alrededor de un punto, con el charco de cada poste:
 *   E = I·cos^k(θ)·cos(θ) / r² (la luminaria concentra la luz hacia abajo según `falloff` = k;
 *   0 = igual en todas direcciones), con la altura de la luz sobre el suelo de cada punto (en
 *   los cerros cambia a lo largo de la calle) y estirado a lo largo de la calle (las luminarias
 *   de alumbrado reparten la luz por la vía más que hacia los lados).
 * - `region`: todo el mundo en una textura gruesa: el flujo de cada charco repartido en su
 *   celda y las vecinas (la misma luz total que el mapa fino); es la ciudad vista desde lejos.
 */

export interface LampSetup {
  type: 'setup';
  /** Por poste: x, z, suelo al pie, altura de la luz sobre el suelo y dirección del brazo (rad). */
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  h: Float32Array;
  arm: Float32Array;
  /** Por poste: r, g, b de la luz (ya con su intensidad); 0 = apagado. */
  color: Float32Array;
  /** Largo del brazo en alturas de poste: el foco queda sobre la calzada. */
  armShare: number;
  /** Cuánto se estira el charco a lo largo de la calle (1 = redondo). */
  stretch: number;
  /** Radio de influencia de un poste, en alturas de poste. */
  reach: number;
  /** Cuánto concentra la luminaria la luz hacia abajo: I(θ) = I·cos^falloff(θ). */
  falloff: number;
  /** Altura mínima de la luz sobre un punto para que lo ilumine (m). */
  minHeight: number;
  maxIrradiance: number;
}

/** Alturas del suelo en una grilla regular (fila a fila, de norte a sur). */
export interface GroundGrid {
  data: Float32Array;
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  spacing: number;
}

export interface LampNearRequest {
  type: 'near';
  id: number;
  x0: number;
  z0: number;
  size: number;
  texels: number;
  /** Suelo que cubre el cuadrado (se interpola en cada texel). */
  ground: GroundGrid;
}

export interface LampRegionRequest {
  type: 'region';
  id: number;
  x0: number;
  z0: number;
  width: number;
  depth: number;
  texelsX: number;
  texelsZ: number;
  /** Suelo en el centro de cada texel (texelsX × texelsZ). */
  ground: Float32Array;
}

export type LampMessage = LampSetup | LampNearRequest | LampRegionRequest;

export interface LampResult {
  id: number;
  data: Uint8Array;
  /** Altura del suelo en el canal a: base y rango (m). */
  groundBase: number;
  groundRange: number;
}

let lamps: LampSetup | null = null;

/** Suelo interpolado en (x, z) (bilineal, con los bordes extendidos). */
function groundAt(g: GroundGrid, x: number, z: number): number {
  const fx = Math.min(Math.max((x - g.x0) / g.spacing, 0), g.cols - 1);
  const fz = Math.min(Math.max((z - g.z0) / g.spacing, 0), g.rows - 1);
  const c = Math.min(Math.floor(fx), g.cols - 2);
  const r = Math.min(Math.floor(fz), g.rows - 2);
  const tx = fx - c;
  const tz = fz - r;
  const d = g.data;
  const a = d[r * g.cols + c] * (1 - tx) + d[r * g.cols + c + 1] * tx;
  const b = d[(r + 1) * g.cols + c] * (1 - tx) + d[(r + 1) * g.cols + c + 1] * tx;
  return a * (1 - tz) + b * tz;
}

function encode(rgb: Float32Array, ground: Float32Array, max: number): LampResult {
  const n = ground.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < n; p++) {
    lo = Math.min(lo, ground[p]);
    hi = Math.max(hi, ground[p]);
  }
  const range = hi > lo ? hi - lo : 0;
  const out = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(Math.sqrt(Math.min(rgb[p * 3 + c] / max, 1)) * 255);
    out[p * 4 + 3] = range > 0 ? Math.round(((ground[p] - lo) / range) * 255) : 0;
  }
  return { id: 0, data: out, groundBase: lo, groundRange: range };
}

function near(req: LampNearRequest, l: LampSetup): LampResult {
  const n = req.texels;
  const t = req.size / n;
  const ground = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = req.z0 + (j + 0.5) * t;
    for (let i = 0; i < n; i++) ground[j * n + i] = groundAt(req.ground, req.x0 + (i + 0.5) * t, z);
  }
  const rgb = new Float32Array(n * n * 3);
  const inv = 1 / (l.stretch * l.stretch);
  const power = l.falloff + 1;
  const count = l.x.length;
  for (let k = 0; k < count; k++) {
    const r = l.color[k * 3];
    const g = l.color[k * 3 + 1];
    const b = l.color[k * 3 + 2];
    if (r + g + b <= 0) continue;
    const h = l.h[k];
    const extent = h * l.reach * l.stretch;
    // Ejes del charco: el brazo apunta a la calle; la calle va perpendicular al brazo.
    const ax = Math.cos(l.arm[k]);
    const az = Math.sin(l.arm[k]);
    // El foco queda sobre la calzada, al final del brazo.
    const cx = l.x[k] + ax * h * l.armShare;
    const cz = l.z[k] + az * h * l.armShare;
    if (cx < req.x0 - extent || cx > req.x0 + req.size + extent || cz < req.z0 - extent || cz > req.z0 + req.size + extent) {
      continue;
    }
    const top = l.y[k] + h;
    const i0 = Math.max(0, Math.floor((cx - extent - req.x0) / t));
    const i1 = Math.min(n - 1, Math.ceil((cx + extent - req.x0) / t));
    const j0 = Math.max(0, Math.floor((cz - extent - req.z0) / t));
    const j1 = Math.min(n - 1, Math.ceil((cz + extent - req.z0) / t));
    const limit = h * l.reach * h * l.reach;
    for (let j = j0; j <= j1; j++) {
      const dz = req.z0 + (j + 0.5) * t - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = req.x0 + (i + 0.5) * t - cx;
        const across = dx * ax + dz * az;
        const along = dz * ax - dx * az;
        const d2 = across * across + along * along * inv;
        if (d2 > limit) continue;
        const p = j * n + i;
        const above = top - ground[p];
        if (above < l.minHeight) continue;
        const q = d2 + above * above;
        // cos(θ)^(k+1) / r²: con la luz justo debajo, E = I / h².
        const e = Math.pow(above / Math.sqrt(q), power) / q;
        rgb[p * 3] += r * e;
        rgb[p * 3 + 1] += g * e;
        rgb[p * 3 + 2] += b * e;
      }
    }
  }
  return encode(rgb, ground, l.maxIrradiance);
}

function region(req: LampRegionRequest, l: LampSetup): LampResult {
  const nx = req.texelsX;
  const nz = req.texelsZ;
  const tx = req.width / nx;
  const tz = req.depth / nz;
  // Luz total de un charco del mapa fino (∫E dA):
  // 2πI / (k + 1) · estiramiento · (1 − (1 + alcance²)^−(k+1)/2).
  const k1 = l.falloff + 1;
  const flux = ((2 * Math.PI) / k1) * l.stretch * (1 - Math.pow(1 + l.reach * l.reach, -k1 / 2));
  const share = flux / (tx * tz);
  const rgb = new Float32Array(nx * nz * 3);
  // Núcleo 3×3 (tienda de campaña): suaviza sin mover la luz de su celda.
  const weights = [0.0625, 0.125, 0.0625, 0.125, 0.25, 0.125, 0.0625, 0.125, 0.0625];
  const count = l.x.length;
  for (let k = 0; k < count; k++) {
    const r = l.color[k * 3] * share;
    const g = l.color[k * 3 + 1] * share;
    const b = l.color[k * 3 + 2] * share;
    if (r + g + b <= 0) continue;
    const reachOut = l.h[k] * l.armShare;
    const i = Math.floor((l.x[k] + Math.cos(l.arm[k]) * reachOut - req.x0) / tx);
    const j = Math.floor((l.z[k] + Math.sin(l.arm[k]) * reachOut - req.z0) / tz);
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const w = weights[(dj + 1) * 3 + di + 1];
        const p = (jj * nx + ii) * 3;
        rgb[p] += r * w;
        rgb[p + 1] += g * w;
        rgb[p + 2] += b * w;
      }
    }
  }
  return encode(rgb, req.ground, l.maxIrradiance);
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'setup') {
    lamps = msg;
    return;
  }
  if (!lamps) return;
  const result = msg.type === 'near' ? near(msg, lamps) : region(msg, lamps);
  result.id = msg.id;
  scope.postMessage(result, [result.data.buffer]);
};
