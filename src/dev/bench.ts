import type * as THREE from 'three';
import bench from '../../config/bench.json';
import type { GeoFrame } from '../core/geo';
import type { GpuTimer } from '../render/gpuTimer';
import type { FollowCamera } from '../player/camera';
import type { PlayerController } from '../player/controller';
import type { Driving } from '../vehicles/driving';
import type { Roads } from '../world/roads';
import type { Buildings } from '../world/buildings';
import type { Heightmap } from '../world/heightmap';

/**
 * Banco de pruebas de rendimiento (solo en desarrollo): recorre siempre la misma ruta
 * (quieto en el centro, vuelo rápido que obliga a cargar el mundo, manejo, llegada a otra
 * zona) y mide tiempos de frame, tirones, tiempo real de GPU, draw calls y memoria.
 * Uso desde la consola: `await __gye.bench()` (o `__gye.bench(['manejo'])`).
 */

export interface BenchContext {
  renderer: THREE.WebGLRenderer;
  gpuTimer: GpuTimer | null;
  /** Suscribe a cada frame dibujado (con el tope de fps no todos los refrescos se dibujan). */
  onFrame: (hook: (frameMs: number) => void) => () => void;
  player: PlayerController;
  follow: FollowCamera;
  driving: Driving;
  roads: Roads;
  buildings: Buildings;
  heightmap: Heightmap;
  geo: GeoFrame;
  teleport: (x: number, z: number) => Promise<void>;
}

type Scenario = (typeof bench.scenarios)[number] & Partial<{ orbitRate: number; altitude: number; headingDeg: number; speedIndex: number; searchRadius: number }>;

export interface ScenarioResult {
  name: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  long: Record<string, number>;
  loafMs: number;
  gpuAvg: number | null;
  gpuP95: number | null;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  heapMB: number | null;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const key = (code: string, type: 'keydown' | 'keyup'): boolean => window.dispatchEvent(new KeyboardEvent(type, { code }));
async function tap(code: string): Promise<void> {
  key(code, 'keydown');
  await wait(60);
  key(code, 'keyup');
  await wait(60);
}

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const round = (v: number): number => Math.round(v * 10) / 10;

export function createBench(ctx: BenchContext): (only?: string[]) => Promise<ScenarioResult[]> {
  const gpuSamples: number[] = [];
  ctx.gpuTimer?.onSample((ms) => gpuSamples.push(ms));

  /** Mide `seconds` segundos de frames, llamando a `each(dt)` en cada uno. */
  async function measure(name: string, seconds: number, each: (dt: number) => void): Promise<ScenarioResult> {
    const times: number[] = [];
    let calls = 0;
    let triangles = 0;
    let loafMs = 0;
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) loafMs += e.duration;
    });
    try {
      observer.observe({ type: 'long-animation-frame' });
    } catch {
      // Navegador sin Long Animation Frames: solo se pierde esa métrica.
    }
    const gpuStart = gpuSamples.length;
    await new Promise<void>((resolve) => {
      const start = performance.now();
      const stop = ctx.onFrame((frameMs) => {
        times.push(frameMs);
        const info = ctx.renderer.info;
        calls += info.render.calls;
        triangles += info.render.triangles;
        each(frameMs / 1000);
        if (performance.now() - start < seconds * 1000) return;
        stop();
        resolve();
      });
    });
    observer.disconnect();
    times.shift();
    const sorted = [...times].sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0);
    const gpuTimes = gpuSamples.slice(gpuStart).sort((a, b) => a - b);
    const long: Record<string, number> = {};
    for (const ms of bench.longFrameMs) long[`>${ms}ms`] = times.filter((t) => t > ms).length;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      name,
      frames: times.length,
      fps: round((1000 * times.length) / total),
      p50: round(pct(sorted, 0.5)),
      p95: round(pct(sorted, 0.95)),
      p99: round(pct(sorted, 0.99)),
      max: round(sorted[sorted.length - 1] ?? 0),
      long,
      loafMs: Math.round(loafMs),
      gpuAvg: gpuTimes.length ? round(gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length) : null,
      gpuP95: gpuTimes.length ? round(pct(gpuTimes, 0.95)) : null,
      calls: Math.round(calls / Math.max(1, times.length)),
      triangles: Math.round(triangles / Math.max(1, times.length)),
      textures: ctx.renderer.info.memory.textures,
      geometries: ctx.renderer.info.memory.geometries,
      heapMB: memory ? Math.round(memory.usedJSHeapSize / 1e6) : null,
    };
  }

  async function useCharacter(id: string): Promise<void> {
    for (let k = 0; k < 8 && ctx.player.character.id !== id; k++) {
      await tap('KeyP');
      await wait(400);
    }
  }

  async function leaveCar(): Promise<void> {
    if (!ctx.driving.active) return;
    key('KeyS', 'keydown');
    for (let k = 0; k < 60 && (ctx.driving.car?.speed ?? 0) > 1; k++) await wait(100);
    key('KeyS', 'keyup');
    await tap('KeyF');
  }

  /** Rumbo desde (x, z) con el tramo más largo de asfalto sin edificios. */
  function roadHeading(x: number, z: number): number {
    let best = { heading: 0, run: -1 };
    for (let k = 0; k < 72; k++) {
      const h = (k * Math.PI) / 36;
      let run = 0;
      for (let d = 2; d <= 300; d += 3, run++) {
        const px = x - Math.sin(h) * d;
        const pz = z - Math.cos(h) * d;
        if (ctx.roads.surfaceAt(px, pz) !== 'asphalt' || ctx.buildings.index.at(px, pz)) break;
      }
      if (run > best.run) best = { heading: h, run };
    }
    return best.heading;
  }

  /** Un punto de asfalto cerca de (x, z). */
  function nearestRoad(x: number, z: number, radius: number): { x: number; z: number } {
    for (let r = 0; r <= radius; r += 3) {
      for (let a = 0; a < 24; a++) {
        const px = x + r * Math.cos((a * Math.PI) / 12);
        const pz = z + r * Math.sin((a * Math.PI) / 12);
        if (ctx.roads.surfaceAt(px, pz) === 'asphalt' && !ctx.buildings.index.at(px, pz)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  async function run(sc: Scenario): Promise<ScenarioResult> {
    await leaveCar();
    await useCharacter(sc.character);
    const { x, z } = ctx.geo.toLocal(sc.lat, sc.lon);
    const settle = bench.settleSeconds * 1000;
    const orbit = (dt: number): void => {
      ctx.follow.yaw += (sc.orbitRate ?? 0) * dt;
    };
    switch (sc.kind) {
      case 'orbit':
        await ctx.teleport(x, z);
        await wait(settle);
        return measure(sc.name, sc.seconds, orbit);
      case 'arrive':
        await ctx.teleport(x, z);
        return measure(sc.name, sc.seconds, orbit);
      case 'glide': {
        await ctx.teleport(x, z);
        await wait(settle);
        const p = ctx.player;
        p.position.y = ctx.heightmap.sample(x, z) + (sc.altitude ?? 0);
        p.velocity.set(0, 0, 0);
        p.mode = 'air';
        p.speedIndex = sc.speedIndex ?? p.speedIndex;
        ctx.follow.yaw = ((sc.headingDeg ?? 0) * Math.PI) / 180;
        await tap('KeyH');
        return measure(sc.name, sc.seconds, () => undefined);
      }
      case 'drive': {
        await ctx.teleport(x, z);
        await wait(settle);
        const road = nearestRoad(x, z, sc.searchRadius ?? 0);
        await ctx.teleport(road.x, road.z);
        await wait(settle / 2);
        ctx.follow.yaw = roadHeading(road.x, road.z);
        await tap('KeyF');
        key('KeyW', 'keydown');
        const result = await measure(sc.name, sc.seconds, () => undefined);
        key('KeyW', 'keyup');
        return result;
      }
      default:
        throw new Error(`Escenario desconocido: ${sc.kind}`);
    }
  }

  return async (only?: string[]) => {
    if (!ctx.gpuTimer?.available) console.warn('[bench] sin EXT_disjoint_timer_query_webgl2: no hay tiempos de GPU');
    const results: ScenarioResult[] = [];
    for (const sc of bench.scenarios as Scenario[]) {
      if (only && !only.includes(sc.name)) continue;
      results.push(await run(sc));
    }
    await leaveCar();
    console.table(results.map(({ long, ...r }) => ({ ...r, ...long })));
    return results;
  };
}
