import { DataUtils } from 'three';
import { PITCH_CODE_STRIDE } from './groundFormat';

/** Lo mínimo del ámbito de un worker (el proyecto compila con la lib DOM, no WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<RoadRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/**
 * Worker: convierte las calles, parques y canchas de un chunk (datos del pipeline) en cinco
 * texturas RGBA de medio float, 1 texel = `texel` m, con un texel de borde extra por lado
 * para que el filtrado no deje costuras entre chunks:
 *
 *   T0  distancia con signo al borde de cada material (negativa = sobre la calzada),
 *       en el orden de dibujo (canal 0 = el que se pinta encima)
 *   T1  ancho de vereda de la calle "dueña" del texel (del lado en que cae), distancia con signo a su eje,
 *       y sen/cos de la posición a lo largo del eje (fase de período `period`;
 *       el vector queda en cero donde ninguna calle es dueña)
 *   T2  carriles codificados ±(carriles·stride + ancho de carril; negativo = un sentido),
 *       distancia a lo largo del eje a la caja de intersección más cercana (negativa
 *       adentro), distancia a lo largo del eje al cruce peatonal más cercano, y tono
 *   T3  distancia con signo al borde de parques y de canchas, y código de la cancha
 *       (deporte · PITCH_CODE_STRIDE + superficie, ver groundFormat.ts)
 *   T4  marco de la cancha: posición a lo largo y a lo ancho desde su centro, medio largo y medio ancho
 *
 * La calle "dueña" de un texel es la de mayor prioridad que lo cubre; fuera de las
 * calzadas, la más cercana. Así las marcas y patrones siguen a la vía principal en los cruces.
 */

export interface RoadRaster {
  texel: number;
  influence: number;
  period: number;
  laneCodeStride: number;
  eventFar: number;
}

export interface RoadRequest {
  id: number;
  url: string;
  x0: number;
  z0: number;
  size: number;
  raster: RoadRaster;
  /** Canal de T0 de cada material del pipeline (índice = material del manifest). */
  channelOf: number[];
}

export interface RoadResult {
  id: number;
  ok: true;
  /** Lado de las texturas en texels (con el borde). */
  side: number;
  data: Uint16Array[];
}

export interface RoadError {
  id: number;
  ok: false;
  error: string;
}

/**
 * prioridad, medio ancho de circulación, vereda izquierda, vereda derecha (según el sentido de la
 * vía), material, carriles, un sentido, tono, [x,z…], [s…], [s, caja…], [s…], estacionamiento
 * izquierdo y derecho (por fuera de la circulación; datos viejos no lo traen)
 */
type RawRoad = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number[],
  number[],
  number[],
  number[],
  number?,
  number?,
];
/** material, anillo exterior [x,z…], huecos… */
type RawArea = [number, ...number[][]];
/** deporte, superficie, centro x, z, eje largo x, z, medio largo, medio ancho, anillo exterior, huecos… */
type RawPitch = [number, number, number, number, number, number, number, number, ...number[][]];

interface ChunkData {
  r: RawRoad[];
  a: RawArea[];
  /** Parques: anillo exterior y huecos. */
  p?: number[][][];
  f?: RawPitch[];
}

interface Grid {
  x0: number;
  z0: number;
  t: number;
  side: number;
}

/** Rango de texels (inclusive) cuyos centros caen en [lo, hi]; centro del texel k = origen + (k − ½)·t. */
function span(lo: number, hi: number, origin: number, g: Grid): [number, number] {
  return [Math.max(0, Math.ceil((lo - origin) / g.t + 0.5)), Math.min(g.side - 1, Math.floor((hi - origin) / g.t + 0.5))];
}

function rasterize({ r: roads, a: areas, p: parks = [], f: pitches = [] }: ChunkData, req: RoadRequest): Uint16Array[] {
  const { texel, influence, period, laneCodeStride, eventFar } = req.raster;
  const cells = Math.round(req.size / texel);
  const g: Grid = { x0: req.x0, z0: req.z0, t: req.size / cells, side: cells + 2 };
  const count = g.side * g.side;
  const surface = new Float32Array(count * 4).fill(influence);
  const ownKey = new Float32Array(count).fill(Infinity);
  const sidewalk = new Float32Array(count);
  const across = new Float32Array(count);
  const along = new Float32Array(count);
  const owned = new Uint8Array(count);
  const lanes = new Float32Array(count);
  const junction = new Float32Array(count).fill(eventFar);
  const crossing = new Float32Array(count).fill(eventFar);
  const tone = new Float32Array(count).fill(1);

  // La prioridad pesa más que cualquier profundidad dentro de la calzada.
  let deepest = 0;
  for (const road of roads) deepest = Math.max(deepest, road[1] + Math.max(road[12] ?? 0, road[13] ?? 0));
  const priorityWeight = 2 * (deepest + influence);

  for (const [prio, hw, swLeft, swRight, mat, laneCount, oneway, roadTone, xz, s, boxes, crossings, parkLeft = 0, parkRight = 0] of roads) {
    const reach = hw + Math.max(parkLeft, parkRight) + Math.max(swLeft, swRight) + influence;
    const channel = req.channelOf[mat];
    // Las líneas van en la calzada de circulación (sin el estacionamiento).
    const code = laneCount > 0 ? (oneway ? -1 : 1) * (laneCount * laneCodeStride + (2 * hw) / laneCount) : 0;
    for (let k = 0; k + 1 < s.length; k++) {
      const ax = xz[k * 2];
      const az = xz[k * 2 + 1];
      const ex = xz[k * 2 + 2] - ax;
      const ez = xz[k * 2 + 3] - az;
      const len2 = ex * ex + ez * ez;
      if (len2 <= 0) continue;
      const len = Math.sqrt(len2);
      const [i0, i1] = span(Math.min(ax, ax + ex) - reach, Math.max(ax, ax + ex) + reach, g.x0, g);
      const [j0, j1] = span(Math.min(az, az + ez) - reach, Math.max(az, az + ez) + reach, g.z0, g);
      for (let j = j0; j <= j1; j++) {
        const rz = g.z0 + (j - 0.5) * g.t - az;
        for (let i = i0; i <= i1; i++) {
          const rx = g.x0 + (i - 0.5) * g.t - ax;
          const u = Math.min(1, Math.max(0, (rx * ex + rz * ez) / len2));
          const dist = Math.hypot(rx - u * ex, rz - u * ez);
          if (dist > reach) continue;
          const p = j * g.side + i;
          // x = este, z = sur: con la vía hacia el este, la izquierda (norte) da distancia negativa.
          const side = (ex * rz - ez * rx) / len;
          const sd = dist - hw - (side < 0 ? parkLeft : parkRight);
          if (sd < surface[p * 4 + channel]) surface[p * 4 + channel] = sd;
          const key = sd < 0 ? sd - prio * priorityWeight : sd;
          if (key >= ownKey[p]) continue;
          ownKey[p] = key;
          owned[p] = 1;
          sidewalk[p] = side < 0 ? swLeft : swRight;
          across[p] = side;
          const at = s[k] + u * (s[k + 1] - s[k]);
          along[p] = at;
          lanes[p] = code;
          tone[p] = roadTone;
          let jd = eventFar;
          for (let b = 0; b < boxes.length; b += 2) jd = Math.min(jd, Math.abs(at - boxes[b]) - boxes[b + 1]);
          junction[p] = jd;
          let cd = eventFar;
          for (const c of crossings) cd = Math.min(cd, Math.abs(at - c));
          crossing[p] = cd;
        }
      }
    }
  }

  for (const [mat, ...rings] of areas) fillArea(rings, req.channelOf[mat], surface, influence, g);

  // Parques en el canal 0; canchas en el 1, y cada texel (también el borde de `influence`
  // alrededor) guarda el código y el marco de la cancha más cercana para dibujar sus líneas.
  const ground = new Float32Array(count * 4);
  const frame = new Float32Array(count * 4);
  for (let p = 0; p < count; p++) {
    ground[p * 4] = influence;
    ground[p * 4 + 1] = influence;
  }
  for (const rings of parks) fillArea(rings, 0, ground, influence, g);
  for (const [sport, kind, cx, cz, ax, az, hl, hw, ...rings] of pitches) {
    const d = areaDistance(rings, influence, g);
    if (!d) continue;
    for (let j = 0; j < d.h; j++) {
      const rz = g.z0 + (j + d.j0 - 0.5) * g.t - cz;
      for (let i = 0; i < d.w; i++) {
        const sd = d.sd[j * d.w + i];
        const p = (j + d.j0) * g.side + i + d.i0;
        if (sd >= ground[p * 4 + 1]) continue;
        const rx = g.x0 + (i + d.i0 - 0.5) * g.t - cx;
        ground[p * 4 + 1] = sd;
        ground[p * 4 + 2] = sport * PITCH_CODE_STRIDE + kind;
        frame[p * 4] = rx * ax + rz * az;
        frame[p * 4 + 1] = rz * ax - rx * az;
        frame[p * 4 + 2] = hl;
        frame[p * 4 + 3] = hw;
      }
    }
  }

  const t0 = new Uint16Array(count * 4);
  const t1 = new Uint16Array(count * 4);
  const t2 = new Uint16Array(count * 4);
  const t3 = new Uint16Array(count * 4);
  const t4 = new Uint16Array(count * 4);
  const half = DataUtils.toHalfFloat;
  const turn = (2 * Math.PI) / period;
  for (let p = 0; p < count; p++) {
    const o = p * 4;
    for (let c = 0; c < 4; c++) t0[o + c] = half(surface[o + c]);
    t1[o] = half(sidewalk[p]);
    t1[o + 1] = half(across[p]);
    t1[o + 2] = half(owned[p] ? Math.sin(along[p] * turn) : 0);
    t1[o + 3] = half(owned[p] ? Math.cos(along[p] * turn) : 0);
    t2[o] = half(lanes[p]);
    t2[o + 1] = half(junction[p]);
    t2[o + 2] = half(crossing[p]);
    t2[o + 3] = half(tone[p]);
    for (let c = 0; c < 4; c++) {
      t3[o + c] = half(ground[o + c]);
      t4[o + c] = half(frame[o + c]);
    }
  }
  return [t0, t1, t2, t3, t4];
}

/** Distancia con signo (negativa adentro, regla par-impar) de un polígono en su recuadro de texels. */
function areaDistance(
  rings: number[][],
  influence: number,
  g: Grid,
): { i0: number; j0: number; w: number; h: number; sd: Float32Array } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k += 2) {
      minX = Math.min(minX, ring[k]);
      maxX = Math.max(maxX, ring[k]);
      minZ = Math.min(minZ, ring[k + 1]);
      maxZ = Math.max(maxZ, ring[k + 1]);
    }
  }
  const [i0, i1] = span(minX - influence, maxX + influence, g.x0, g);
  const [j0, j1] = span(minZ - influence, maxZ + influence, g.z0, g);
  if (i0 > i1 || j0 > j1) return null;
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const dist = new Float32Array(w * h).fill(influence);
  const flip = new Uint8Array(w * h + 1);

  for (const ring of rings) {
    const n = ring.length / 2;
    for (let k = 0, m = n - 1; k < n; m = k++) {
      const ax = ring[m * 2];
      const az = ring[m * 2 + 1];
      const bx = ring[k * 2];
      const bz = ring[k * 2 + 1];
      // Cruces del borde con cada fila de texels: marca dónde cambia adentro/afuera.
      const [r0, r1] = span(Math.min(az, bz), Math.max(az, bz), g.z0, g);
      for (let j = Math.max(r0, j0); j <= Math.min(r1, j1); j++) {
        const pz = g.z0 + (j - 0.5) * g.t;
        if (az <= pz === bz <= pz) continue;
        const xc = ax + ((pz - az) * (bx - ax)) / (bz - az);
        const first = Math.floor((xc - g.x0) / g.t + 0.5) + 1;
        if (first <= i1) flip[(j - j0) * w + Math.max(first, i0) - i0] ^= 1;
      }
      // Distancia a este borde en su vecindario.
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      const [c0, c1] = span(Math.min(ax, bx) - influence, Math.max(ax, bx) + influence, g.x0, g);
      const [q0, q1] = span(Math.min(az, bz) - influence, Math.max(az, bz) + influence, g.z0, g);
      for (let j = Math.max(q0, j0); j <= Math.min(q1, j1); j++) {
        const rz = g.z0 + (j - 0.5) * g.t - az;
        for (let i = Math.max(c0, i0); i <= Math.min(c1, i1); i++) {
          const rx = g.x0 + (i - 0.5) * g.t - ax;
          const u = len2 > 0 ? Math.min(1, Math.max(0, (rx * ex + rz * ez) / len2)) : 0;
          const d = Math.hypot(rx - u * ex, rz - u * ez);
          const q = (j - j0) * w + i - i0;
          if (d < dist[q]) dist[q] = d;
        }
      }
    }
  }

  for (let j = 0; j < h; j++) {
    let inside = 0;
    for (let i = 0; i < w; i++) {
      const q = j * w + i;
      inside ^= flip[q];
      if (inside) dist[q] = -dist[q];
    }
  }
  return { i0, j0, w, h, sd: dist };
}

/** Polígono relleno como distancia con signo en un canal (se queda el mínimo con lo que ya había). */
function fillArea(rings: number[][], channel: number, surface: Float32Array, influence: number, g: Grid): void {
  const d = areaDistance(rings, influence, g);
  if (!d) return;
  for (let j = 0; j < d.h; j++) {
    for (let i = 0; i < d.w; i++) {
      const sd = d.sd[j * d.w + i];
      const o = ((j + d.j0) * g.side + i + d.i0) * 4 + channel;
      if (sd < surface[o]) surface[o] = sd;
    }
  }
}

scope.onmessage = async (event: MessageEvent<RoadRequest>) => {
  const req = event.data;
  try {
    const res = await fetch(req.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ChunkData;
    const textures = rasterize(data, req);
    const result: RoadResult = { id: req.id, ok: true, side: Math.round(req.size / req.raster.texel) + 2, data: textures };
    scope.postMessage(
      result,
      textures.map((t) => t.buffer),
    );
  } catch (err) {
    const error: RoadError = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(error);
  }
};
