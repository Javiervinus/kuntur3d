import * as THREE from 'three';
import type { GameConfig, RoadNetwork, WorldManifest } from '../core/types';
import { createHaloMaterial, haloPixels } from '../render/halos';
import { nightLight } from '../render/nightLight';
import { EdgeGraph } from './graph';
import type { Heightmap } from './heightmap';
import { createVehicleMaterial, type VehicleKind, type VehicleLights, vehicleGeometry, vehicleLights } from './vehicleModels';

type TrafficConfig = GameConfig['traffic'];
type TrafficInfo = NonNullable<WorldManifest['traffic']>;

const KMH = 1 / 3.6;

/** Parte del tráfico que circula a la hora `hours` (0-24), interpolando la tabla por hora. */
function hourlyShare(table: readonly number[], hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  const k = Math.floor(h);
  const t = h - k;
  return table[k % table.length] * (1 - t) + table[(k + 1) % table.length] * t;
}

/** Lo que el tráfico necesita del mundo: alto del suelo y de los tableros de puentes y muelles. */
export interface TrafficGround {
  heightmap: Heightmap;
  /** Tablero más alto en (x, z) por debajo de maxY (-Infinity si no hay). */
  deckAt: (x: number, z: number, maxY: number) => number;
}

/** Algo en la calle ante lo que el tráfico frena: el jugador a pie o su carro. */
export interface TrafficObstacle {
  x: number;
  z: number;
  radius: number;
}

/**
 * Red de calles (pipeline/build_world.py, paso `traffic`): tramos entre cruces con su eje, los
 * carriles en cada sentido, la velocidad, la clase y banderas. Además arma, por nodo, los tramos
 * por los que se puede salir (tramo·2 + 1 si es a contramano del dibujo).
 */
class TrafficNetwork extends EdgeGraph {
  readonly forward: Uint8Array;
  readonly backward: Uint8Array;
  readonly speed: Uint8Array;
  readonly kind: Uint8Array;
  readonly flags: Uint8Array;
  /** Tráfico estimado en cada sentido (0-255, escala logarítmica; ver traffic_flow en el pipeline). */
  readonly flowForward: Uint8Array;
  readonly flowBackward: Uint8Array;
  /** Salidas de cada nodo (CSR): outStart[n]..outStart[n + 1] en outEdge. */
  readonly outStart: Uint32Array;
  readonly outEdge: Uint32Array;

  constructor(
    buffer: ArrayBuffer,
    readonly info: TrafficInfo,
    cell: number,
  ) {
    super(buffer, info, cell);
    this.forward = this.column();
    this.backward = this.column();
    this.speed = this.column();
    this.kind = this.column();
    this.flags = this.column();
    this.flowForward = this.column();
    this.flowBackward = this.column();
    this.finish('traffic.bin');

    const E = this.edges;
    const N = this.nodes;
    const counts = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) {
      if (this.forward[e] > 0) counts[this.from[e] + 1]++;
      if (this.backward[e] > 0) counts[this.to[e] + 1]++;
    }
    for (let n = 0; n < N; n++) counts[n + 1] += counts[n];
    this.outStart = counts.slice();
    this.outEdge = new Uint32Array(counts[N]);
    const fill = counts.slice(0, N);
    for (let e = 0; e < E; e++) {
      if (this.forward[e] > 0) this.outEdge[fill[this.from[e]]++] = e * 2;
      if (this.backward[e] > 0) this.outEdge[fill[this.to[e]]++] = e * 2 + 1;
    }
  }

  /** Carriles en el sentido `back` (0 = el del dibujo, 1 = al revés). */
  lanes(e: number, back: number): number {
    return back ? this.backward[e] : this.forward[e];
  }

  /** Tráfico estimado en el sentido `back` (0-255). */
  flow(e: number, back: number): number {
    return back ? this.flowBackward[e] : this.flowForward[e];
  }
}

/** Un vehículo del tráfico. */
interface Vehicle {
  kind: number;
  color: THREE.Color;
  /** Tramo, sentido (0 = el del dibujo) y carril (0 = el de la derecha). */
  edge: number;
  back: number;
  lane: number;
  /** Distancia recorrida en el tramo, en su sentido (m), y velocidad (m/s). */
  s: number;
  v: number;
  /** Cuánto más o menos rápido que el límite le gusta ir. */
  pace: number;
  /** Tramo siguiente (tramo·2 + sentido) y el anterior (para el eje trasero). */
  next: number;
  prev: number;
  /** Nodo que está cruzando (-1 = ninguno) y cuánto lleva esperando turno en uno. */
  holds: number;
  waited: number;
  /** Frenando (0..1, suavizado: las luces de freno). */
  brake: number;
  y: number;
  /** Dónde se dibujó por última vez y hacia dónde mira (para quien quiere cruzar la calle). */
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Retirarlo (llegó a un callejón sin salida). */
  done: boolean;
}

/**
 * Turno de un cruce: el acceso (tramo·2 + sentido) que tiene paso, cuántos vehículos lo están
 * cruzando, desde cuándo lo tiene y cuándo pidió paso por última vez alguien de otro acceso.
 */
interface Turn {
  approach: number;
  crossing: number;
  since: number;
  waitingAt: number;
}

/** Punto sobre un tramo: posición, dirección de avance (x, z) y si va sobre un puente. */
interface LanePoint {
  x: number;
  z: number;
  dx: number;
  dz: number;
  bridge: boolean;
}

/**
 * Tráfico: carros, taxis amarillos, camionetas y buses que circulan por las calles reales
 * alrededor del jugador (pipeline, paso `traffic`), por la derecha y en su carril.
 *
 * - Aparecen en calles a menos de `radius` m (más en las vías de más tráfico: `density`
 *   vehículos por km de carril según la clase, por lo transitado de cada tramo según el
 *   pipeline, `flow`, y por la hora, `hourly`), fuera de la vista si están cerca, y se retiran
 *   al quedar lejos.
 * - Manejan con el modelo del conductor inteligente (IDM): aceleran hasta su velocidad (el
 *   límite de la calle por su ritmo), frenan para no alcanzar al de adelante y para doblar
 *   (la velocidad de curva sale de la aceleración lateral cómoda) y se detienen ante el jugador.
 * - En los cruces (nodos con tres o más tramos) pasan por turnos de acceso, como un semáforo
 *   que se adapta (ver enter).
 * - Al llegar a un cruce eligen salida al azar, pesada por lo transitada que es cada calle y
 *   por seguir derecho; en un callejón sin salida dan la vuelta, o se retiran si no pueden.
 * - Se dibujan con una malla instanciada por tipo (color por vehículo), con luz de freno, y de
 *   noche con faros y luces de atrás (y halos que se ven de lejos, solo del lado al que apuntan).
 */
export class Traffic {
  readonly group = new THREE.Group();
  private readonly net: TrafficNetwork;
  private readonly kinds: VehicleKind[];
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly brakeAttr: THREE.InstancedBufferAttribute[] = [];
  private readonly lightSpots: VehicleLights[] = [];
  private readonly vehicles: Vehicle[] = [];
  /** Cruce (nodo) → a qué acceso le toca pasar. */
  private readonly turns = new Map<number, Turn>();
  /** Reloj de la simulación (s), para la duración de los turnos. */
  private clock = 0;
  /** Vehículos por tramo y sentido (tramo·2 + sentido), ordenados por avance en cada cuadro. */
  private readonly lanesOf = new Map<number, Vehicle[]>();
  private readonly spareLists: Vehicle[][] = [];
  /** Lo más cercano adelante del vehículo que se está moviendo: distancia libre y su velocidad. */
  private gap = Infinity;
  private lead = 0;
  private readonly pool: Vehicle[][] = [];
  /** Tramos cercanos al último centro y su peso para aparecer (acumulado). */
  private readonly candidates: number[] = [];
  private readonly seen = new Set<number>();
  private weights = new Float64Array(0);
  private expected = 0;
  private readonly center = new THREE.Vector2(Infinity, Infinity);
  private filled = false;
  private readonly density: Float32Array;
  /** Multiplicador de la densidad según el tráfico estimado del tramo (índice 0-255, ver `flow`). */
  private readonly flowFactor: Float32Array;
  private readonly allowed: boolean[][];
  private readonly haloPositions: Float32Array;
  private readonly haloTints: Float32Array;
  private readonly haloFacing: Float32Array;
  private readonly halos: THREE.Points;
  private readonly haloSize: THREE.Vector4;
  private readonly frustum = new THREE.Frustum();

  private constructor(
    buffer: ArrayBuffer,
    info: TrafficInfo,
    private readonly cfg: TrafficConfig,
    private readonly ground: TrafficGround,
    fog: GameConfig['render']['fog'],
    renderer: THREE.WebGLRenderer,
  ) {
    this.net = new TrafficNetwork(buffer, info, cfg.cell);
    this.kinds = cfg.kinds;
    this.group.name = 'traffic';
    const densities = cfg.density as Record<string, number>;
    this.density = Float32Array.from(info.classes, (name) => densities[name] ?? 0);
    const fl = cfg.flow;
    this.flowFactor = Float32Array.from({ length: 256 }, (_, k) => fl.min + (fl.max - fl.min) * Math.pow(k / 255, fl.gamma));
    // Qué tipos pueden circular por cada clase de calle (los buses, solo por las avenidas).
    this.allowed = this.kinds.map((k) => {
      const only = k.classes as readonly string[];
      return info.classes.map((name) => only.length === 0 || only.includes(name));
    });

    const material = createVehicleMaterial(cfg, nightLight.uLightsOn);

    const max = cfg.maxVehicles;
    for (const kind of this.kinds) {
      const geometry = vehicleGeometry(kind, cfg.lights);
      const brake = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aBrake', brake);
      const mesh = new THREE.InstancedMesh(geometry, material, max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = `traffic-${kind.name}`;
      this.meshes.push(mesh);
      this.brakeAttr.push(brake);
      this.lightSpots.push(vehicleLights(kind));
      this.pool.push([]);
      this.group.add(mesh);
    }

    // Halos de faros y luces de atrás: cuatro por vehículo.
    const lights = max * 4;
    this.haloPositions = new Float32Array(lights * 3);
    this.haloTints = new Float32Array(lights * 3);
    this.haloFacing = new Float32Array(lights * 3);
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(this.haloPositions, 3).setUsage(THREE.DynamicDrawUsage));
    points.setAttribute('tint', new THREE.BufferAttribute(this.haloTints, 3).setUsage(THREE.DynamicDrawUsage));
    points.setAttribute('aFacing', new THREE.BufferAttribute(this.haloFacing, 3).setUsage(THREE.DynamicDrawUsage));
    points.setDrawRange(0, 0);
    const halo = createHaloMaterial(cfg.lights.halo, fog, renderer, cfg.lights.facing);
    this.haloSize = halo.uniforms.uHalo.value as THREE.Vector4;
    this.halos = new THREE.Points(points, halo);
    this.halos.frustumCulled = false;
    this.halos.name = 'traffic-lights';
    this.group.add(this.halos);
  }

  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    cfg: TrafficConfig,
    ground: TrafficGround,
    fog: GameConfig['render']['fog'],
    renderer: THREE.WebGLRenderer,
  ): Promise<Traffic | null> {
    const info = manifest.traffic;
    if (!info) return null;
    const res = await fetch(new URL(info.url, baseUrl));
    if (!res.ok) throw new Error(`No se pudo cargar el tráfico (${res.status})`);
    return new Traffic(await res.arrayBuffer(), info, cfg, ground, fog, renderer);
  }

  /** Las calles por las que circula (las dibuja el mapa del HUD). */
  get roads(): RoadNetwork {
    return this.net;
  }

  /** Vehículos circulando ahora. */
  get count(): number {
    return this.vehicles.length;
  }

  /**
   * ¿Se puede cruzar la calle de (x0, z0) a (x1, z1)? No si hay un vehículo encima del cruce (a
   * menos de `near` m) o uno andando (a más de `moving` m/s) que se le acerca desde menos de
   * `clear` m.
   */
  clearOf(x0: number, z0: number, x1: number, z1: number, clear: number, near: number, moving: number): boolean {
    const ex = x1 - x0;
    const ez = z1 - z0;
    const len2 = ex * ex + ez * ez;
    for (const v of this.vehicles) {
      const u = len2 > 0 ? THREE.MathUtils.clamp(((v.x - x0) * ex + (v.z - z0) * ez) / len2, 0, 1) : 0;
      // Del vehículo al punto más cercano del cruce.
      const px = x0 + u * ex - v.x;
      const pz = z0 + u * ez - v.z;
      const d = Math.hypot(px, pz);
      if (d < near) return false;
      if (d < clear && v.v > moving && px * v.dirX + pz * v.dirZ > 0) return false;
    }
    return true;
  }

  /**
   * Cada cuadro: elige las calles cercanas (al moverse), retira a los lejanos, hace aparecer a
   * los que faltan (menos de madrugada y más en las horas pico: `hourly`, por hora del día),
   * mueve a todos y los dibuja. `obstacles`: el jugador y su carro.
   */
  update(
    dt: number,
    focusX: number,
    focusZ: number,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    obstacles: TrafficObstacle[],
    hours: number,
  ): void {
    const cfg = this.cfg;
    const jumped = Math.hypot(focusX - this.center.x, focusZ - this.center.y) > cfg.radius;
    if (jumped) this.clear();
    if (jumped || Math.hypot(focusX - this.center.x, focusZ - this.center.y) > cfg.recenter) this.gather(focusX, focusZ);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    // Retirar a los lejanos y a los que terminaron.
    const far = cfg.radius + cfg.hysteresis;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      this.pointAt(v.edge, v.back, v.lane, v.s, _p);
      if (v.done || Math.hypot(_p.x - focusX, _p.z - focusZ) > far) this.remove(i);
    }
    // Aparecer a los que faltan (todos de una vez al llegar a un lugar nuevo).
    const target = Math.min(cfg.maxVehicles, Math.round(this.expected * hourlyShare(cfg.hourly, hours)));
    const tries = this.filled ? cfg.spawnPerFrame : target;
    for (let t = 0; t < tries && this.vehicles.length < target; t++) this.spawn(camera, !this.filled);
    this.filled = true;

    this.clock += dt;
    this.sortLanes();
    for (const v of this.vehicles) this.drive(v, dt, obstacles);
    this.draw(camera, renderer);
  }

  /** Saca a todos (al saltar a otro lugar). */
  private clear(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) this.remove(i);
    this.turns.clear();
    this.filled = false;
  }

  /**
   * Calles a menos de `radius` de (x, z), con su peso para aparecer: los vehículos que les tocan
   * según el largo de carril que queda dentro del radio (los tramos largos, como un puente, solo
   * cuentan su parte cercana).
   */
  private gather(x: number, z: number): void {
    this.center.set(x, z);
    const net = this.net;
    const r2 = this.cfg.radius * this.cfg.radius;
    net.near(x, z, this.cfg.radius, this.candidates, this.seen);
    if (this.weights.length < this.candidates.length) this.weights = new Float64Array(this.candidates.length * 2);
    let total = 0;
    for (let i = 0; i < this.candidates.length; i++) {
      const e = this.candidates[i];
      let inside = 0;
      for (let k = net.start[e] + 1; k < net.start[e + 1]; k++) {
        const mx = (net.x[k] + net.x[k - 1]) / 2 - x;
        const mz = (net.z[k] + net.z[k - 1]) / 2 - z;
        if (mx * mx + mz * mz <= r2) inside += net.arc[k] - net.arc[k - 1];
      }
      const f = this.flowFactor;
      const lanes = net.forward[e] * f[net.flowForward[e]] + net.backward[e] * f[net.flowBackward[e]];
      total += ((inside * lanes) / 1000) * this.density[net.kind[e]];
      this.weights[i] = total;
    }
    this.expected = total;
  }

  private remove(i: number): void {
    const v = this.vehicles[i];
    this.release(v);
    this.vehicles[i] = this.vehicles[this.vehicles.length - 1];
    this.vehicles.pop();
    this.pool[v.kind].push(v);
  }

  /** Un vehículo nuevo en una calle cercana al azar (fuera de la vista si está cerca). */
  private spawn(camera: THREE.Camera, anywhere: boolean): void {
    const n = this.candidates.length;
    if (!n) return;
    const net = this.net;
    const cfg = this.cfg;
    const total = this.weights[n - 1];
    if (!(total > 0)) return;
    // Tramo al azar según su peso (búsqueda binaria en el acumulado).
    const r = Math.random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.weights[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const e = this.candidates[lo];
    // Sentido según sus carriles y el tráfico estimado de cada uno.
    const wF = net.forward[e] * this.flowFactor[net.flowForward[e]];
    const wB = net.backward[e] * this.flowFactor[net.flowBackward[e]];
    const back = Math.random() * (wF + wB) < wF ? 0 : 1;
    const lanes = net.lanes(e, back);
    if (!lanes) return;
    const kind = this.pickKind(net.kind[e]);
    if (kind < 0) return;
    const length = this.kinds[kind].length;
    const L = net.length[e];
    if (L < length + cfg.minSpacing) return;
    const lane = Math.floor(Math.random() * lanes);
    const s = length / 2 + Math.random() * (L - length);
    // Lejos de los demás de ese carril.
    for (const other of this.vehicles) {
      if (other.edge === e && other.back === back && other.lane === lane && Math.abs(other.s - s) < (length + this.kinds[other.kind].length) / 2 + cfg.minSpacing) return;
    }
    this.pointAt(e, back, lane, s, _p);
    // Solo la parte del tramo dentro del radio (la que contó gather).
    if (Math.hypot(_p.x - this.center.x, _p.z - this.center.y) > cfg.radius) return;
    if (!anywhere) {
      _v.set(_p.x, this.ground.heightmap.sample(_p.x, _p.z), _p.z);
      if (_v.distanceTo(camera.position) < cfg.popDistance && this.frustum.containsPoint(_v)) return;
    }
    const v = this.pool[kind].pop() ?? ({ color: new THREE.Color() } as Vehicle);
    v.kind = kind;
    const colors = this.kinds[kind].paint;
    v.color.set(colors[Math.floor(Math.random() * colors.length)]);
    v.edge = e;
    v.back = back;
    v.lane = lane;
    v.s = s;
    v.pace = cfg.driving.pace[0] + Math.random() * (cfg.driving.pace[1] - cfg.driving.pace[0]);
    v.v = this.cruise(v) * cfg.driving.startShare;
    v.prev = -1;
    v.holds = -1;
    v.waited = 0;
    v.brake = 0;
    v.done = false;
    // Sobre un puente, el tablero más alto; si no, el suelo (aunque pase un puente por encima).
    const bridge = (net.flags[e] & net.info.flags.bridge) !== 0;
    v.y = this.surface(_p.x, _p.z, bridge ? Infinity : this.ground.heightmap.sample(_p.x, _p.z) + cfg.climb);
    v.x = _p.x;
    v.z = _p.z;
    v.dirX = _p.dx;
    v.dirZ = _p.dz;
    v.next = this.choose(v);
    this.vehicles.push(v);
  }

  /** Tipo de vehículo al azar según `share`, entre los que pueden ir por esa clase de calle. */
  private pickKind(cls: number): number {
    let total = 0;
    for (let k = 0; k < this.kinds.length; k++) if (this.allowed[k][cls]) total += this.kinds[k].share;
    let r = Math.random() * total;
    for (let k = 0; k < this.kinds.length; k++) {
      if (!this.allowed[k][cls]) continue;
      r -= this.kinds[k].share;
      if (r <= 0) return k;
    }
    return -1;
  }

  /** Velocidad a la que quiere ir en su tramo (m/s). */
  private cruise(v: Vehicle): number {
    return this.net.speed[v.edge] * KMH * v.pace * this.kinds[v.kind].speedFactor;
  }

  /**
   * Salida al llegar al final del tramo: al azar entre las del nodo, pesadas por lo transitada
   * que es cada calle y por seguir derecho; la vuelta en U solo si no hay otra.
   */
  private choose(v: Vehicle): number {
    const net = this.net;
    const node = net.endNode(v.edge, v.back);
    this.pointAt(v.edge, v.back, 0, net.length[v.edge], _p);
    const dx = _p.dx;
    const dz = _p.dz;
    let total = 0;
    const reverse = v.edge * 2 + (1 - v.back);
    for (let k = net.outStart[node]; k < net.outStart[node + 1]; k++) {
      const code = net.outEdge[k];
      if (code === reverse) continue;
      total += this.exitWeight(code, dx, dz);
    }
    if (total <= 0) {
      // Callejón sin salida: vuelta en U si la calle es de doble sentido.
      return net.lanes(v.edge, 1 - v.back) > 0 ? reverse : -1;
    }
    let r = Math.random() * total;
    for (let k = net.outStart[node]; k < net.outStart[node + 1]; k++) {
      const code = net.outEdge[k];
      if (code === reverse) continue;
      r -= this.exitWeight(code, dx, dz);
      if (r <= 0) return code;
    }
    return -1;
  }

  private exitWeight(code: number, dx: number, dz: number): number {
    const net = this.net;
    const e = code >> 1;
    const back = code & 1;
    this.pointAt(e, back, 0, 0, _q);
    const straight = Math.max(dx * _q.dx + dz * _q.dz, 0);
    const flow = this.flowFactor[net.flow(e, back)];
    return this.density[net.kind[e]] * flow * net.lanes(e, back) * (1 + this.cfg.driving.straightBias * straight);
  }

  /** Vehículos de cada tramo y sentido, ordenados por avance. */
  private sortLanes(): void {
    for (const list of this.lanesOf.values()) {
      list.length = 0;
      this.spareLists.push(list);
    }
    this.lanesOf.clear();
    for (const v of this.vehicles) {
      const key = v.edge * 2 + v.back;
      let list = this.lanesOf.get(key);
      if (!list) {
        list = this.spareLists.pop() ?? [];
        this.lanesOf.set(key, list);
      }
      list.push(v);
    }
    for (const list of this.lanesOf.values()) if (list.length > 1) list.sort(byProgress);
  }

  /** Anota lo que hay adelante si es lo más cercano hasta ahora. */
  private consider(gap: number, speed: number): void {
    if (gap < this.gap) {
      this.gap = gap;
      this.lead = speed;
    }
  }

  /** Avanza un vehículo: IDM contra lo que tenga adelante (vehículo, cruce ocupado, jugador o curva). */
  private drive(v: Vehicle, dt: number, obstacles: TrafficObstacle[]): void {
    const net = this.net;
    const cfg = this.cfg;
    const d = cfg.driving;
    const j = cfg.junction;
    const kind = this.kinds[v.kind];
    const L = net.length[v.edge];
    const toEnd = L - v.s;
    let v0 = this.cruise(v);
    // Distancia libre y velocidad de lo que va adelante (Infinity = nada).
    this.gap = Infinity;
    this.lead = 0;

    // El de adelante en el mismo carril (en este tramo o, si no hay, en el siguiente).
    const here = this.lanesOf.get(v.edge * 2 + v.back);
    let ahead: Vehicle | null = null;
    if (here) {
      for (const o of here) {
        if (o !== v && o.lane === v.lane && o.s > v.s) {
          ahead = o;
          break;
        }
      }
    }
    if (ahead) this.consider(ahead.s - v.s - (kind.length + this.kinds[ahead.kind].length) / 2, ahead.v);
    else if (v.next >= 0) {
      const there = this.lanesOf.get(v.next);
      const lanes = net.lanes(v.next >> 1, v.next & 1);
      const lane = Math.min(v.lane, lanes - 1);
      if (there) {
        for (const o of there) {
          if (o.lane === lane) {
            this.consider(toEnd + o.s - (kind.length + this.kinds[o.kind].length) / 2, o.v);
            break;
          }
        }
      }
    }

    // Cruce: al acercarse pide paso (ver enter); sin él, se detiene antes. (Sin salida: sigue
    // hasta el final y se retira.)
    const node = net.endNode(v.edge, v.back);
    if (v.next >= 0 && net.degree[node] >= j.minDegree && v.holds !== node && toEnd < j.approach) {
      if (this.enter(v, node)) v.waited = 0;
      else {
        this.consider(toEnd - kind.length / 2 - j.stopGap, 0);
        if (v.v < d.stopped) v.waited += dt;
      }
    }

    // Curva al doblar: la velocidad a la que la aceleración lateral es cómoda.
    if (v.next >= 0) {
      this.pointAt(v.edge, v.back, 0, L, _p);
      this.pointAt(v.next >> 1, v.next & 1, 0, 0, _q);
      const cos = THREE.MathUtils.clamp(_p.dx * _q.dx + _p.dz * _q.dz, -1, 1);
      const half = Math.acos(cos) / 2;
      if (half > 1e-3) {
        // Radio del arco que empieza a `cornerLength` m de la esquina: esa distancia / tan(ángulo / 2).
        const turn = Math.sqrt((d.lateralAccel * d.cornerLength) / Math.tan(half));
        v0 = Math.min(v0, Math.sqrt(turn * turn + 2 * d.comfort * Math.max(toEnd - kind.length / 2, 0)));
      }
    }

    // El jugador (o su carro) en el carril, adelante.
    this.pointAt(v.edge, v.back, v.lane, v.s, _p);
    for (const o of obstacles) {
      const rx = o.x - _p.x;
      const rz = o.z - _p.z;
      const along = rx * _p.dx + rz * _p.dz;
      const side = Math.abs(rx * _p.dz - rz * _p.dx);
      if (along > 0 && along < cfg.obstacles.lookAhead && side < this.net.info.laneWidth / 2 + o.radius) {
        this.consider(along - kind.length / 2 - o.radius, 0);
      }
    }

    // IDM.
    const speedTerm = Math.pow(v.v / Math.max(v0, 0.1), d.exponent);
    let accel = d.accel * (1 - speedTerm);
    if (this.gap < Infinity) {
      const desired = d.minGap + Math.max(0, v.v * d.headway + (v.v * (v.v - this.lead)) / (2 * Math.sqrt(d.accel * d.decel)));
      accel -= d.accel * (desired / Math.max(this.gap, 0.1)) ** 2;
    }
    accel = Math.max(accel, -d.maxDecel);
    v.v = Math.max(0, v.v + accel * dt);
    const braking = accel < -d.brakeLights || v.v < d.stopped ? 1 : 0;
    v.brake += (braking - v.brake) * Math.min(1, dt * d.brakeFade);
    v.s += v.v * dt;

    // Cambio de tramo (varios si son cortos).
    while (v.s > net.length[v.edge] && !v.done) {
      if (v.next < 0) {
        v.done = true;
        break;
      }
      v.s -= net.length[v.edge];
      v.prev = v.edge * 2 + v.back;
      v.edge = v.next >> 1;
      v.back = v.next & 1;
      v.lane = Math.min(v.lane, net.lanes(v.edge, v.back) - 1);
      v.next = this.choose(v);
    }
    // Suelta el cruce cuando ya lo pasó entero.
    if (v.holds >= 0 && v.holds !== net.endNode(v.edge, v.back) && v.s > kind.length + j.clearance) this.release(v);
  }

  /**
   * Paso por un cruce, por turnos de acceso como un semáforo que se adapta: pasan juntos todos
   * los que vienen del mismo tramo (en fila o por carriles paralelos no se cruzan); si llega
   * alguien por otro acceso, espera a que el cruce se vacíe, y el acceso con paso deja de
   * admitir nuevos cuando lleva `green` s con otros esperando. Quien espera más de `patience` s
   * pasa igual (para no trabarse nunca).
   */
  private enter(v: Vehicle, node: number): boolean {
    const j = this.cfg.junction;
    const approach = v.edge * 2 + v.back;
    let turn = this.turns.get(node);
    if (!turn) {
      turn = { approach, crossing: 0, since: this.clock, waitingAt: -Infinity };
      this.turns.set(node, turn);
    }
    // Alguien de otro acceso pidió paso hace menos de `memory` s y este ya tuvo su verde.
    const expired = this.clock - turn.waitingAt < j.memory && this.clock - turn.since > j.green;
    const allowed = turn.approach === approach ? !expired : turn.crossing === 0;
    if (!allowed && v.waited <= j.patience) {
      if (turn.approach !== approach) turn.waitingAt = this.clock;
      return false;
    }
    if (turn.approach !== approach) {
      turn.approach = approach;
      turn.since = this.clock;
      turn.waitingAt = -Infinity;
    }
    this.release(v);
    turn.crossing++;
    v.holds = node;
    return true;
  }

  /** Deja el cruce que estaba pasando. */
  private release(v: Vehicle): void {
    if (v.holds < 0) return;
    const turn = this.turns.get(v.holds);
    if (turn) {
      turn.crossing = Math.max(turn.crossing - 1, 0);
      // Cruces vacíos y sin nadie esperando: no se guardan (el mapa no crece con la ciudad).
      if (turn.crossing === 0 && this.clock - turn.waitingAt > this.cfg.junction.memory) this.turns.delete(v.holds);
    }
    v.holds = -1;
  }

  /**
   * Punto del carril a `s` m del comienzo del tramo en el sentido de avance: sobre el eje, corrido
   * a la derecha hasta el centro del carril (la calle ocupa todos sus carriles, los de este
   * sentido a la derecha). s fuera del tramo sigue por el anterior o el siguiente del vehículo
   * si se pasan (ver poseOf); acá se limita al tramo.
   */
  private pointAt(e: number, back: number, lane: number, s: number, out: LanePoint): LanePoint {
    const net = this.net;
    const L = net.length[e];
    const along = THREE.MathUtils.clamp(back ? L - s : s, 0, L);
    const a = net.start[e];
    const b = net.start[e + 1] - 1;
    // Búsqueda binaria del segmento.
    let lo = a;
    let hi = b;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (net.arc[mid] <= along) lo = mid;
      else hi = mid;
    }
    const seg = Math.max(net.arc[hi] - net.arc[lo], 1e-6);
    const t = THREE.MathUtils.clamp((along - net.arc[lo]) / seg, 0, 1);
    let dx = (net.x[hi] - net.x[lo]) / seg;
    let dz = (net.z[hi] - net.z[lo]) / seg;
    if (back) {
      dx = -dx;
      dz = -dz;
    }
    const lanesHere = net.lanes(e, back);
    const lanesThere = net.lanes(e, 1 - back);
    // A la derecha del avance (x, z) → (-dz, dx), con x al este y z al sur.
    const offset = ((lanesHere + lanesThere) / 2 - (lane + 0.5)) * net.info.laneWidth;
    out.x = net.x[lo] + (net.x[hi] - net.x[lo]) * t - dz * offset;
    out.z = net.z[lo] + (net.z[hi] - net.z[lo]) * t + dx * offset;
    out.dx = dx;
    out.dz = dz;
    out.bridge = (net.flags[e] & net.info.flags.bridge) !== 0;
    return out;
  }

  /** Punto del recorrido del vehículo a `offset` m de su centro (adelante > 0), pasando al tramo vecino si hace falta. */
  private poseOf(v: Vehicle, offset: number, out: LanePoint): LanePoint {
    const net = this.net;
    const s = v.s + offset;
    if (s > net.length[v.edge] && v.next >= 0) {
      const e = v.next >> 1;
      const back = v.next & 1;
      return this.pointAt(e, back, Math.min(v.lane, net.lanes(e, back) - 1), s - net.length[v.edge], out);
    }
    if (s < 0 && v.prev >= 0) {
      const e = v.prev >> 1;
      const back = v.prev & 1;
      return this.pointAt(e, back, Math.min(v.lane, net.lanes(e, back) - 1), net.length[e] + s, out);
    }
    return this.pointAt(v.edge, v.back, v.lane, s, out);
  }

  /** Alto de la calzada: el tablero de un puente (hasta `maxY`) o el suelo. */
  private surface(x: number, z: number, maxY: number): number {
    return Math.max(this.ground.heightmap.sample(x, z), this.ground.deckAt(x, z, maxY));
  }

  /** Matrices, colores, luces de freno y halos. */
  private draw(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    const cfg = this.cfg;
    for (const mesh of this.meshes) mesh.count = 0;
    const night = nightLight.uLightsOn.value;
    const lights = night > 0;
    const head = _c1.set(cfg.lights.head.color).multiplyScalar(cfg.lights.head.halo);
    const tail = _c2.set(cfg.lights.tail.color);
    let h = 0;
    for (const v of this.vehicles) {
      const kind = this.kinds[v.kind];
      const half = kind.wheelbase / 2;
      const front = this.poseOf(v, half, _p);
      const rear = this.poseOf(v, -half, _q);
      // Sube o baja a lo más `climb` por cuadro (rampas de los puentes).
      const maxY = v.y + cfg.climb;
      const yf = this.surface(front.x, front.z, maxY);
      const yr = this.surface(rear.x, rear.z, maxY);
      v.y = (yf + yr) / 2;
      const dx = front.x - rear.x;
      const dz = front.z - rear.z;
      const flat = Math.max(Math.hypot(dx, dz), 1e-3);
      const heading = Math.atan2(-dz, dx);
      const pitch = Math.atan2(yf - yr, flat);
      _e.set(0, heading, pitch, 'YZX');
      _quat.setFromEuler(_e);
      _pos.set((front.x + rear.x) / 2, v.y, (front.z + rear.z) / 2);
      _m.compose(_pos, _quat, _one);
      v.x = _pos.x;
      v.z = _pos.z;
      v.dirX = dx / flat;
      v.dirZ = dz / flat;
      const mesh = this.meshes[v.kind];
      const slot = mesh.count++;
      mesh.setMatrixAt(slot, _m);
      mesh.setColorAt(slot, v.color);
      this.brakeAttr[v.kind].array[slot] = v.brake;
      if (!lights) continue;
      // Halos: dos faros adelante y dos luces atrás.
      const spots = this.lightSpots[v.kind];
      for (const side of SIDES) {
        this.halo(h++, spots.head, side, head, 1);
        _c3.copy(tail).multiplyScalar(cfg.lights.tail.halo * (1 + v.brake * cfg.lights.brake));
        this.halo(h++, spots.tail, side, _c3, -1);
      }
    }
    this.meshes.forEach((mesh, k) => {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
        mesh.instanceColor.needsUpdate = true;
      }
      const brake = this.brakeAttr[k];
      brake.clearUpdateRanges();
      brake.addUpdateRange(0, mesh.count);
      brake.needsUpdate = true;
    });
    this.halos.visible = lights && h > 0;
    if (this.halos.visible) {
      const geometry = this.halos.geometry;
      geometry.setDrawRange(0, h);
      for (const name of ['position', 'tint', 'aFacing']) {
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, h * 3);
        attribute.needsUpdate = true;
      }
      this.haloSize.w = haloPixels(camera, renderer);
    }
  }

  /** Un halo en la luz `spot` (del lado `side`) del vehículo recién puesto en _m, apuntando a `facing` (1 adelante, -1 atrás). */
  private halo(i: number, spot: THREE.Vector3, side: number, tint: THREE.Color, facing: number): void {
    const o = i * 3;
    _v.set(spot.x, spot.y, spot.z * side).applyMatrix4(_m);
    this.haloPositions[o] = _v.x;
    this.haloPositions[o + 1] = _v.y;
    this.haloPositions[o + 2] = _v.z;
    this.haloTints[o] = tint.r;
    this.haloTints[o + 1] = tint.g;
    this.haloTints[o + 2] = tint.b;
    _v.set(facing, 0, 0).applyQuaternion(_quat);
    this.haloFacing[o] = _v.x;
    this.haloFacing[o + 1] = _v.y;
    this.haloFacing[o + 2] = _v.z;
  }
}

const SIDES = [-1, 1] as const;
const byProgress = (a: Vehicle, b: Vehicle): number => a.s - b.s;
const _p: LanePoint = { x: 0, z: 0, dx: 1, dz: 0, bridge: false };
const _q: LanePoint = { x: 0, z: 0, dx: 1, dz: 0, bridge: false };
const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _matrix = new THREE.Matrix4();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
