import * as THREE from 'three';
import type { GameConfig, WorldManifest } from '../core/types';
import { type BakedClip, type CrowdBody, loadCrowdBody } from './crowdModels';
import { EdgeGraph } from './graph';
import type { Heightmap } from './heightmap';
import type { TrafficObstacle } from './traffic';

type PedestriansConfig = GameConfig['pedestrians'];
type WalksInfo = NonNullable<WorldManifest['walks']>;

/**
 * Red peatonal (pipeline/build_world.py, paso `walks`): tramos entre cruces con su eje, el medio
 * ancho de la calzada de circulación, la vereda a cada lado (0 = sin vereda; si no hay ninguna es
 * un sendero y se camina por el medio), el estacionamiento a cada lado (entre la calzada y la
 * vereda), cuánto antes de cada punta parar para no pisar las otras vías del cruce (por lado),
 * la clase y banderas. Por nodo, los tramos que salen (tramo·2 + 1 si es por su final, al revés
 * del dibujo).
 */
class WalkNetwork extends EdgeGraph {
  readonly half: Float32Array;
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly parkLeft: Float32Array;
  readonly parkRight: Float32Array;
  /** Recortes (m) por tramo: al inicio izquierda y derecha, al final izquierda y derecha. */
  readonly trim: Float32Array;
  readonly kind: Uint8Array;
  readonly flags: Uint8Array;
  readonly outStart: Uint32Array;
  readonly outEdge: Uint32Array;

  constructor(
    buffer: ArrayBuffer,
    readonly info: WalksInfo,
    cell: number,
  ) {
    super(buffer, info, cell);
    const E = this.edges;
    const meters = (c: Uint8Array): Float32Array => Float32Array.from(c, (v) => v * info.widthUnit);
    this.half = meters(this.column());
    this.left = meters(this.column());
    this.right = meters(this.column());
    this.parkLeft = meters(this.column());
    this.parkRight = meters(this.column());
    const trims = [this.column(), this.column(), this.column(), this.column()];
    this.trim = new Float32Array(E * 4);
    for (let e = 0; e < E; e++) for (let k = 0; k < 4; k++) this.trim[e * 4 + k] = trims[k][e] * info.widthUnit;
    this.kind = this.column();
    this.flags = this.column();
    this.finish('walks.bin');

    const N = this.nodes;
    const counts = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) {
      counts[this.from[e] + 1]++;
      counts[this.to[e] + 1]++;
    }
    for (let n = 0; n < N; n++) counts[n + 1] += counts[n];
    this.outStart = counts.slice();
    this.outEdge = new Uint32Array(counts[N]);
    const fill = counts.slice(0, N);
    for (let e = 0; e < E; e++) {
      this.outEdge[fill[this.from[e]]++] = e * 2;
      this.outEdge[fill[this.to[e]]++] = e * 2 + 1;
    }
  }

  /** Sin veredas: se camina por el medio (footway, pedestrian…). */
  isPath(e: number): boolean {
    return this.left[e] === 0 && this.right[e] === 0;
  }

  /** Del eje al bordillo del lado `side` (−1 izquierda, 1 derecha): la calzada más su estacionamiento. */
  curb(e: number, side: number): number {
    return this.half[e] + (side < 0 ? this.parkLeft[e] : this.parkRight[e]);
  }
}

/** Qué hace cada persona. */
const WALK = 0;
/** De un tramo al siguiente: una esquina o, si es largo, cruzando la calle. */
const HOP = 1;
/** En el borde, esperando que pasen los carros para cruzar. */
const WAIT = 2;
/** Parada un rato (mirando una vitrina, esperando a alguien). */
const PAUSE = 3;
/** Conversando con otra persona. */
const CHAT = 4;

interface Person {
  body: number;
  hair: number;
  /** Escala del modelo (su estatura / la del modelo). */
  scale: number;
  /** Ropa, pelo y piel: los cuatro vec4 por persona del shader (aTop, aBottom, aFeet, aHead). */
  look: Float32Array;
  walk: BakedClip;
  idle: BakedClip;
  /** Tramo, sentido (0 = el del dibujo) y lado: -1 vereda izquierda, 1 derecha, 0 sendero. */
  edge: number;
  back: number;
  side: number;
  /** Al azar de cada persona (0..1): de él sale por dónde va a lo ancho de la vereda o sendero. */
  u: number;
  /**
   * Desplazamiento a lo ancho (m, positivo a la derecha del dibujo): al que va y el de ahora
   * (se acerca de a poco: no salta al darse la vuelta). Y lo recorrido en el tramo (m).
   */
  offset: number;
  lateral: number;
  s: number;
  /** Velocidad a la que le gusta caminar y la de ahora (m/s). */
  speed: number;
  v: number;
  mode: number;
  /** Cuánto le queda parada o conversando (s), o cuánto lleva esperando para cruzar. */
  timer: number;
  /** Tramo, sentido y lado al que va (en HOP y WAIT), y el trayecto hasta allá. */
  nextEdge: number;
  nextBack: number;
  nextSide: number;
  hop: { x0: number; z0: number; x1: number; z1: number; length: number; s: number };
  crossing: boolean;
  /** Cuánto lleva detenida frente a algo (el jugador): al rato se da la vuelta. */
  blocked: number;
  partner: Person | null;
  x: number;
  z: number;
  y: number;
  heading: number;
  clip: BakedClip;
  phase: number;
  prev: BakedClip | null;
  prevPhase: number;
  fade: number;
}

/** Punto de un tramo: posición en el eje, dirección del dibujo y normal hacia su derecha (suavizada en los vértices). */
interface EdgePoint {
  x: number;
  z: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
}

/** Lo que los peatones necesitan del mundo: alto del suelo y de los tableros. */
export interface PedestrianGround {
  heightmap: Heightmap;
  deckAt: (x: number, z: number, maxY: number) => number;
}

/** Lo que necesitan del tráfico: saber si pueden cruzar. */
export interface PedestrianTraffic {
  clearOf(x0: number, z0: number, x1: number, z1: number, clear: number, near: number, moving: number): boolean;
}

/**
 * Peatones por las veredas y senderos reales alrededor del jugador (red del paso `walks`):
 * caminan a su ritmo (cada uno con su estatura, ropa, pelo y piel), doblan en las esquinas o
 * cruzan la calle esperando que no vengan carros (y los carros frenan ante quien cruza), se
 * detienen a ratos y algunos conversan de a dos. Cuántos hay depende de la calle y de la hora.
 * Se dibujan con mallas instanciadas por cuerpo, peinado y nivel de detalle (ver crowdModels).
 */
export class Pedestrians {
  readonly group = new THREE.Group();
  private readonly people: Person[] = [];
  private readonly pool: Person[] = [];
  private readonly density: Float32Array;
  private readonly bodyShares: number[];
  private readonly frustum = new THREE.Frustum();
  private readonly center = new THREE.Vector2(Infinity, Infinity);
  private candidates: number[] = [];
  private readonly seen = new Set<number>();
  private weights = new Float64Array(0);
  private expected = 0;
  private filled = false;
  private hourFactor = 1;
  private readonly crossers: TrafficObstacle[] = [];
  private crossing = 0;
  /** Quienes están en cada tramo (para esquivarse), armado en cada cuadro. */
  private readonly byEdge = new Map<number, Person[]>();
  /** Duración del cuadro en curso (s). */
  private dt = 0;

  private constructor(
    private readonly net: WalkNetwork,
    private readonly cfg: PedestriansConfig,
    private readonly bodies: CrowdBody[],
    private readonly ground: PedestrianGround,
  ) {
    const classes = net.info.classes;
    const density: Record<string, number> = cfg.density;
    this.density = Float32Array.from(classes, (name) => density[name] ?? 0);
    this.bodyShares = bodies.map((b) => b.cfg.share);
    for (const body of bodies) for (const row of body.meshes) for (const mesh of row) this.group.add(mesh);
    this.group.name = 'pedestrians';
  }

  /** Descarga la red y los modelos (cada tipo de cuerpo en `modelUrl(model)`). */
  static async load(
    baseUrl: string,
    manifest: WorldManifest,
    cfg: PedestriansConfig,
    modelUrl: (model: string) => string,
    ground: PedestrianGround,
  ): Promise<Pedestrians | null> {
    const info = manifest.walks;
    if (!info) return null;
    const [buffer, bodies] = await Promise.all([
      fetch(new URL(info.url, baseUrl)).then((res) => {
        if (!res.ok) throw new Error(`No se pudo cargar la red peatonal (${res.status})`);
        return res.arrayBuffer();
      }),
      Promise.all(cfg.bodies.map((b) => loadCrowdBody(modelUrl(b.model), b, cfg, cfg.maxPeople))),
    ]);
    return new Pedestrians(new WalkNetwork(buffer, info, cfg.cell), cfg, bodies, ground);
  }

  /** Personas en la calle ahora. */
  get count(): number {
    return this.people.length;
  }

  /**
   * Corre `compile` (compilar sus shaders) con todas las mallas a la vista: sin gente todavía
   * están ocultas y no se compilarían hasta que aparezca alguien.
   */
  warm<T>(compile: (group: THREE.Group) => T): T {
    const meshes = this.bodies.flatMap((b) => b.meshes.flat());
    for (const mesh of meshes) mesh.visible = true;
    const result = compile(this.group);
    const hide = (): void => {
      for (const mesh of meshes) mesh.visible = mesh.count > 0;
    };
    if (result instanceof Promise) void result.then(hide, hide);
    else hide();
    return result;
  }

  /**
   * Cada cuadro: elige las veredas cercanas (al moverse), retira a los lejanos, hace aparecer a
   * los que faltan, mueve a todos y los dibuja. `hours`: la hora del día (cuánta gente hay);
   * `obstacles`: el jugador o su carro (se detienen ante ellos).
   */
  update(
    dt: number,
    focusX: number,
    focusZ: number,
    hours: number,
    camera: THREE.PerspectiveCamera,
    traffic: PedestrianTraffic | null,
    obstacles: readonly TrafficObstacle[],
  ): void {
    const cfg = this.cfg;
    const jumped = Math.hypot(focusX - this.center.x, focusZ - this.center.y) > cfg.radius;
    if (jumped) this.clear();
    const factor = this.hoursFactor(hours);
    if (jumped || factor !== this.hourFactor || Math.hypot(focusX - this.center.x, focusZ - this.center.y) > cfg.recenter) {
      this.hourFactor = factor;
      this.gather(focusX, focusZ);
    }
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    // Retirar a los lejanos.
    const far = cfg.radius + cfg.hysteresis;
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (Math.hypot(p.x - focusX, p.z - focusZ) > far) this.remove(i);
    }
    const target = Math.min(cfg.maxPeople, Math.round(this.expected));
    const tries = this.filled ? cfg.spawnPerFrame : target;
    for (let t = 0; t < tries && this.people.length < target; t++) this.spawn(camera, !this.filled);
    this.filled = true;
    // Si sobra gente (se hizo tarde), se van de a poco quienes no están a la vista ni conversando.
    let extra = Math.min(this.people.length - target, cfg.spawnPerFrame);
    for (let i = this.people.length - 1; i >= 0 && extra > 0; i--) {
      const p = this.people[i];
      if (p.partner || this.visible(p, camera)) continue;
      this.remove(i);
      extra--;
    }

    this.crossing = 0;
    this.sortEdges();
    for (const p of this.people) this.step(p, dt, traffic, obstacles);
    this.draw(camera);
  }

  /** Reparte a quienes están en un tramo (no cruzando de uno a otro) por tramo. */
  private sortEdges(): void {
    if (this.byEdge.size > MAX_EDGE_LISTS) this.byEdge.clear();
    for (const list of this.byEdge.values()) list.length = 0;
    for (const p of this.people) {
      if (p.mode === HOP) continue;
      const list = this.byEdge.get(p.edge);
      if (list) list.push(p);
      else this.byEdge.set(p.edge, [p]);
    }
  }

  /** Por dónde se puede ir a lo ancho (m desde el eje, positivo a la derecha del dibujo): la vereda o el sendero. */
  private bounds(e: number, side: number, out: [number, number]): [number, number] {
    const net = this.net;
    const margin = this.cfg.avoid.edgeMargin;
    if (side === 0) {
      const w = net.half[e] * this.cfg.walking.pathLane;
      out[0] = -w;
      out[1] = w;
      return out;
    }
    const sidewalk = side < 0 ? net.left[e] : net.right[e];
    const a = side * (net.curb(e, side) + margin * sidewalk);
    const b = side * (net.curb(e, side) + (1 - margin) * sidewalk);
    out[0] = Math.min(a, b);
    out[1] = Math.max(a, b);
    return out;
  }

  /**
   * A lo ancho, por dónde pasar a `other` (m, marco del dibujo) si estorba a quien quiere ir
   * por `lane`: su costado más cercano a `lane` que quepa en [lo, hi]; NaN si no hay espacio.
   */
  private passBy(lane: number, other: number, reach: number, lo: number, hi: number): number {
    const first = lane <= other ? other - reach : other + reach;
    const second = lane <= other ? other + reach : other - reach;
    if (first >= lo && first <= hi) return first;
    if (second >= lo && second <= hi) return second;
    return NaN;
  }

  /**
   * Esquivar mientras camina: a quien va adelante en su tramo (parado, más lento o de frente)
   * y al jugador o su carro. Se corre hacia el costado con espacio; si no cabe, frena detrás
   * de quien va en su mismo sentido o se detiene. Devuelve la velocidad a la que puede ir.
   */
  private avoid(p: Person, target: number, obstacles: readonly TrafficObstacle[]): number {
    const a = this.cfg.avoid;
    const L = this.net.length[p.edge];
    const [lo, hi] = this.bounds(p.edge, p.side, _bounds);
    let lane = this.offsetFor(p.edge, p.back, p.side, p.u);
    let speed = target;
    let blocked = false;
    for (const q of this.byEdge.get(p.edge) ?? NOBODY) {
      if (q === p || q.side !== p.side) continue;
      const ahead = (q.back === p.back ? q.s : L - q.s) - p.s;
      if (ahead <= 0 || ahead > a.lookAhead || Math.abs(q.lateral - lane) >= a.space) continue;
      const along = q.back === p.back && q.mode === WALK;
      if (along && q.v >= p.v) continue;
      const pass = this.passBy(lane, q.lateral, a.pass, lo, hi);
      if (Number.isNaN(pass)) {
        speed = Math.min(speed, along ? q.v : 0);
        blocked = !along;
      } else lane = pass;
    }
    // El jugador (o su carro): mismo trato, con su radio.
    if (obstacles.length) {
      this.centerAt(p.edge, p.back ? L - p.s : p.s, _edge2);
      const sign = p.back ? -1 : 1;
      for (const o of obstacles) {
        const along = ((o.x - p.x) * _edge2.dx + (o.z - p.z) * _edge2.dz) * sign;
        if (along <= 0 || along > a.lookAhead + o.radius) continue;
        const across = (o.x - _edge2.x) * _edge2.nx + (o.z - _edge2.z) * _edge2.nz;
        if (Math.abs(across - lane) >= a.space + o.radius) continue;
        const pass = this.passBy(lane, across, a.pass + o.radius, lo, hi);
        if (Number.isNaN(pass)) {
          speed = 0;
          blocked = true;
        } else lane = pass;
      }
    }
    p.offset = lane;
    if (blocked) {
      p.blocked += this.dt;
      if (p.blocked > this.cfg.player.patience) this.turnAround(p);
    } else p.blocked = 0;
    return speed;
  }

  /** Quienes están cruzando la calle ahora (los carros frenan ante ellos). */
  obstacles(out: TrafficObstacle[]): void {
    for (let k = 0; k < this.crossing; k++) out.push(this.crossers[k]);
  }

  /** Cuánta gente hay a esta hora (config → hours: [hora, factor], interpolado). */
  private hoursFactor(hours: number): number {
    const table = this.cfg.hours;
    const h = ((hours % 24) + 24) % 24;
    for (let k = 1; k < table.length; k++) {
      const [h1, f1] = table[k];
      if (h <= h1) {
        const [h0, f0] = table[k - 1];
        // Redondeado: no hace falta rehacer el reparto por cambios diminutos.
        return Math.round((f0 + ((f1 - f0) * (h - h0)) / Math.max(h1 - h0, 1e-6)) * 20) / 20;
      }
    }
    return table[table.length - 1][1];
  }

  private clear(): void {
    for (let i = this.people.length - 1; i >= 0; i--) this.remove(i);
    this.filled = false;
  }

  /** Personas que le tocan a cada tramo cercano: largo dentro del radio × veredas × densidad de su clase × hora. */
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
      const sides = net.isPath(e) ? 1 : (net.left[e] > 0 ? 1 : 0) + (net.right[e] > 0 ? 1 : 0);
      total += ((inside * sides) / 1000) * this.density[net.kind[e]] * this.hourFactor;
      this.weights[i] = total;
    }
    this.expected = total;
  }

  private remove(i: number): void {
    const p = this.people[i];
    if (p.partner) p.partner.partner = null;
    p.partner = null;
    this.people[i] = this.people[this.people.length - 1];
    this.people.pop();
    this.pool.push(p);
  }

  /** Índice al azar según sus pesos. */
  private pick(shares: readonly number[]): number {
    let total = 0;
    for (const s of shares) total += s;
    let r = Math.random() * total;
    for (let k = 0; k < shares.length; k++) {
      r -= shares[k];
      if (r <= 0) return k;
    }
    return shares.length - 1;
  }

  /** Una persona nueva (o una pareja conversando) en una vereda cercana al azar, fuera de la vista si está cerca. */
  private spawn(camera: THREE.Camera, anywhere: boolean): void {
    const n = this.candidates.length;
    if (!n) return;
    const cfg = this.cfg;
    const total = this.weights[n - 1];
    if (!(total > 0)) return;
    const r = Math.random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.weights[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const e = this.candidates[lo];
    const side = this.randomSide(e);
    const back = Math.random() < 0.5 ? 0 : 1;
    const [s0, s1] = this.range(e, back, side);
    const s = s0 + Math.random() * (s1 - s0);
    const chat = Math.random() < cfg.chat.chance && s1 - s0 > cfg.chat.distance * 2;
    const p = this.create(e, back, side, s);
    // Solo la parte del tramo dentro del radio (la que contó gather), y sin aparecer a la vista.
    if (Math.hypot(p.x - this.center.x, p.z - this.center.y) > cfg.radius || (!anywhere && this.visible(p, camera))) {
      this.pool.push(p);
      return;
    }
    this.people.push(p);
    if (!chat) {
      p.mode = WALK;
      p.v = p.speed;
      this.setClip(p, p.walk, true);
      return;
    }
    // Conversando: la otra persona enfrente, un poco más allá en la misma vereda.
    const q = this.create(e, back, side, Math.min(s + cfg.chat.distance, s1));
    q.u = p.u;
    q.offset = p.offset;
    q.lateral = p.lateral;
    this.place(q);
    this.people.push(q);
    const seconds = THREE.MathUtils.randFloat(cfg.chat.seconds[0], cfg.chat.seconds[1]);
    for (const [a, b] of [
      [p, q],
      [q, p],
    ] as const) {
      a.mode = CHAT;
      a.timer = seconds;
      a.partner = b;
      a.v = 0;
      this.setClip(a, this.bodyClip(a, this.cfg.animation.talk), true);
      a.heading = Math.atan2(-(b.z - a.z), b.x - a.x);
    }
  }

  /** Lado al azar de un tramo (entre los que tienen vereda), o 0 si es un sendero. */
  private randomSide(e: number): number {
    const net = this.net;
    if (net.isPath(e)) return 0;
    if (net.left[e] > 0 && net.right[e] > 0) return Math.random() < 0.5 ? -1 : 1;
    return net.left[e] > 0 ? -1 : 1;
  }

  /** Arma una persona al azar (cuerpo, estatura, ropa…) parada en ese punto. */
  private create(e: number, back: number, side: number, s: number): Person {
    const cfg = this.cfg;
    const b = this.pick(this.bodyShares);
    const body = this.bodies[b];
    const bc = body.cfg;
    const p =
      this.pool.pop() ??
      ({
        look: new Float32Array(16),
        hop: { x0: 0, z0: 0, x1: 0, z1: 0, length: 0, s: 0 },
      } as Person);
    p.body = b;
    p.hair = this.pick(bc.hair.map((h) => h.share));
    p.scale = THREE.MathUtils.randFloat(bc.height[0], bc.height[1]) / body.height;
    const look = cfg.look;
    const o = bc.outfit;
    const color = (list: readonly string[], at: number): void => {
      _color.set(list[Math.floor(Math.random() * list.length)]);
      p.look[at] = _color.r;
      p.look[at + 1] = _color.g;
      p.look[at + 2] = _color.b;
    };
    color(look.tops, 0);
    p.look[3] = o.top.sleeves[this.pick(o.top.sleeves.map((v) => v.share))].reach;
    color(look.bottoms, 4);
    p.look[7] = o.pants.bottoms[this.pick(o.pants.bottoms.map((v) => v.share))].bottom;
    color(look.shoes, 8);
    p.look[11] = o.shoes[this.pick(o.shoes.map((v) => v.share))].top;
    color(look.hair, 12);
    p.look[15] = look.skin[Math.floor(Math.random() * look.skin.length)];
    p.walk = this.bodyClip(p, cfg.animation.walk);
    p.idle = this.bodyClip(p, cfg.animation.idle);
    p.edge = e;
    p.back = back;
    p.side = side;
    p.u = Math.random();
    p.offset = this.offsetFor(e, back, side, p.u);
    p.lateral = p.offset;
    p.s = s;
    p.speed = THREE.MathUtils.randFloat(cfg.walking.speed[0], cfg.walking.speed[1]);
    p.v = 0;
    p.mode = WALK;
    p.timer = 0;
    p.crossing = false;
    p.blocked = 0;
    p.partner = null;
    p.prev = null;
    p.fade = 0;
    p.phase = Math.random();
    p.clip = p.walk;
    this.place(p);
    // Sobre un puente, el tablero más alto; si no, el suelo (aunque pase un puente por encima).
    const bridge = (this.net.flags[e] & this.net.info.flags.bridge) !== 0;
    p.y = this.surface(p.x, p.z, bridge ? Infinity : this.ground.heightmap.sample(p.x, p.z) + cfg.walking.stepHeight);
    this.centerAt(e, back ? this.net.length[e] - s : s, _edge);
    const sign = back ? -1 : 1;
    p.heading = Math.atan2(-_edge.dz * sign, _edge.dx * sign);
    return p;
  }

  /** Clip de una lista de la config (según `share`) en el cuerpo de esa persona. */
  private bodyClip(p: Person, list: readonly { clip: string; share: number }[]): BakedClip {
    const name = list[this.pick(list.map((c) => c.share))].clip;
    const clip = this.bodies[p.body].clips.get(name);
    if (!clip) throw new Error(`Clip de peatones sin hornear: ${name}`);
    return clip;
  }

  /** Cambia de animación mezclando con la anterior (o de golpe con `now`). */
  private setClip(p: Person, clip: BakedClip, now = false): void {
    if (p.clip === clip) return;
    if (now) {
      p.prev = null;
      p.fade = 0;
    } else {
      p.prev = p.clip;
      p.prevPhase = p.phase;
      p.fade = this.cfg.animation.blend;
    }
    p.clip = clip;
    p.phase = now ? Math.random() : 0;
  }

  /**
   * Parte del tramo por la que se camina (m desde el nodo de partida): sin pisar la calzada de
   * las otras vías en cada punta (recorte de su lado; en un sendero, el mayor). Si el tramo es
   * más corto que los recortes, un solo punto.
   */
  private range(e: number, back: number, side: number): [number, number] {
    const t = this.net.trim;
    const L = this.net.length[e];
    const atFrom = side < 0 ? t[e * 4] : side > 0 ? t[e * 4 + 1] : Math.max(t[e * 4], t[e * 4 + 1]);
    const atTo = side < 0 ? t[e * 4 + 2] : side > 0 ? t[e * 4 + 3] : Math.max(t[e * 4 + 2], t[e * 4 + 3]);
    const first = back ? atTo : atFrom;
    const last = back ? atFrom : atTo;
    if (first + last <= L) return [first, L - last];
    const s = (L * first) / Math.max(first + last, 1e-6);
    return [s, s];
  }

  /**
   * A lo ancho (m desde el eje, positivo a la derecha del dibujo): en una vereda, entre el
   * bordillo y la pared según `walking.lane`, cada uno por la mitad que le queda a su derecha
   * (así los que van y los que vienen no se chocan); en un sendero, por su derecha.
   */
  private offsetFor(e: number, back: number, side: number, u: number): number {
    const net = this.net;
    const w = this.cfg.walking;
    if (side === 0) return (back ? -1 : 1) * (0.1 + 0.9 * u) * net.half[e] * w.pathLane;
    const [lo, hi] = w.lane;
    const mid = (lo + hi) / 2;
    // Su derecha da hacia la pared si va en el sentido del dibujo por la vereda derecha (o al revés por la izquierda).
    const outer = side > 0 === (back === 0);
    const lane = outer ? mid + u * (hi - mid) : lo + u * (mid - lo);
    const sidewalk = side < 0 ? net.left[e] : net.right[e];
    return side * (net.curb(e, side) + lane * sidewalk);
  }

  /** Punto del eje de un tramo a `a` m de su inicio (en el sentido del dibujo). */
  private centerAt(e: number, a: number, out: EdgePoint): EdgePoint {
    const net = this.net;
    const k0 = net.start[e];
    const k1 = net.start[e + 1] - 1;
    let lo = k0;
    let hi = k1 - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (net.arc[mid] <= a) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    const seg = net.arc[k + 1] - net.arc[k];
    const t = seg > 0 ? THREE.MathUtils.clamp((a - net.arc[k]) / seg, 0, 1) : 0;
    const ex = net.x[k + 1] - net.x[k];
    const ez = net.z[k + 1] - net.z[k];
    const len = Math.hypot(ex, ez) || 1;
    out.x = net.x[k] + ex * t;
    out.z = net.z[k] + ez * t;
    out.dx = ex / len;
    out.dz = ez / len;
    // Normal de cada vértice = promedio de sus dos tramos: la vereda no salta en los quiebres.
    const n0x = -out.dz;
    const n0z = out.dx;
    let ax = n0x;
    let az = n0z;
    let bx = n0x;
    let bz = n0z;
    if (k > k0) {
      const px = net.x[k] - net.x[k - 1];
      const pz = net.z[k] - net.z[k - 1];
      const pl = Math.hypot(px, pz) || 1;
      ax = (n0x - pz / pl) / 2;
      az = (n0z + px / pl) / 2;
    }
    if (k + 1 < k1) {
      const qx = net.x[k + 2] - net.x[k + 1];
      const qz = net.z[k + 2] - net.z[k + 1];
      const ql = Math.hypot(qx, qz) || 1;
      bx = (n0x - qz / ql) / 2;
      bz = (n0z + qx / ql) / 2;
    }
    const nx = ax + (bx - ax) * t;
    const nz = az + (bz - az) * t;
    const nl = Math.hypot(nx, nz) || 1;
    out.nx = nx / nl;
    out.nz = nz / nl;
    return out;
  }

  /** Dónde queda la persona en su tramo (x, z), con su desplazamiento a lo ancho. */
  private place(p: Person): void {
    const L = this.net.length[p.edge];
    this.centerAt(p.edge, p.back ? L - p.s : p.s, _edge);
    p.x = _edge.x + _edge.nx * p.lateral;
    p.z = _edge.z + _edge.nz * p.lateral;
  }

  /** Punto de partida en un tramo (su comienzo en ese lado y sentido) para alguien con ese desplazamiento. */
  private entry(e: number, back: number, side: number, u: number, out: { x: number; z: number }): void {
    const [s0] = this.range(e, back, side);
    const L = this.net.length[e];
    this.centerAt(e, back ? L - s0 : s0, _edge);
    const offset = this.offsetFor(e, back, side, u);
    out.x = _edge.x + _edge.nx * offset;
    out.z = _edge.z + _edge.nz * offset;
  }

  /** Suelo o tablero más alto por debajo de maxY. */
  private surface(x: number, z: number, maxY: number): number {
    return Math.max(this.ground.heightmap.sample(x, z), this.ground.deckAt(x, z, maxY));
  }

  /** ¿Se vería aparecer? (cerca y dentro del cuadro). */
  private visible(p: Person, camera: THREE.Camera): boolean {
    _v.set(p.x, this.ground.heightmap.sample(p.x, p.z) + 1, p.z);
    return _v.distanceTo(camera.position) < this.cfg.popDistance && this.frustum.containsPoint(_v);
  }

  /**
   * Salida al llegar a la punta del tramo: al azar entre los tramos del nodo, pesados por lo
   * concurrida que es cada vía y un poco por seguir derecho; volver por donde vino, solo si no
   * hay otra. Del tramo elegido, el lado cuya punta queda más cerca (dobla la esquina por su
   * vereda o, si hace falta, cruza la calle).
   */
  private choose(p: Person): void {
    const net = this.net;
    const node = net.endNode(p.edge, p.back);
    const L = net.length[p.edge];
    this.centerAt(p.edge, p.back ? 0 : L, _edge);
    const sign = p.back ? -1 : 1;
    const dx = _edge.dx * sign;
    const dz = _edge.dz * sign;
    const reverse = p.edge * 2 + (1 - p.back);
    let total = 0;
    let options = 0;
    for (let k = net.outStart[node]; k < net.outStart[node + 1]; k++) {
      const code = net.outEdge[k];
      if (code === reverse) continue;
      total += this.exitWeight(code, dx, dz);
      options++;
    }
    let code = reverse;
    if (options > 0 && total > 0) {
      let r = Math.random() * total;
      for (let k = net.outStart[node]; k < net.outStart[node + 1]; k++) {
        const c = net.outEdge[k];
        if (c === reverse) continue;
        r -= this.exitWeight(c, dx, dz);
        if (r <= 0) {
          code = c;
          break;
        }
      }
    }
    const e = code >> 1;
    const back = code & 1;
    let side = 0;
    if (!net.isPath(e)) {
      // El lado cuya punta queda más cerca de donde está.
      let best = Infinity;
      for (const s of SIDES) {
        if ((s < 0 ? net.left[e] : net.right[e]) <= 0) continue;
        this.entry(e, back, s, p.u, _point);
        const d = Math.hypot(_point.x - p.x, _point.z - p.z);
        if (d < best) {
          best = d;
          side = s;
        }
      }
    }
    p.nextEdge = e;
    p.nextBack = back;
    p.nextSide = side;
    this.entry(e, back, side, p.u, _point);
    const h = p.hop;
    h.x0 = p.x;
    h.z0 = p.z;
    h.x1 = _point.x;
    h.z1 = _point.z;
    h.length = Math.hypot(h.x1 - h.x0, h.z1 - h.z0);
    h.s = 0;
    p.crossing = h.length > this.cfg.walking.crossingMin;
  }

  private exitWeight(code: number, dx: number, dz: number): number {
    const net = this.net;
    const e = code >> 1;
    this.centerAt(e, code & 1 ? net.length[e] : 0, _edge2);
    const sign = code & 1 ? -1 : 1;
    const straight = Math.max(0, dx * _edge2.dx * sign + dz * _edge2.dz * sign);
    return (this.density[net.kind[e]] + 1) * (1 + this.cfg.walking.straightBias * straight);
  }

  /** Un cuadro de una persona: camina, dobla, espera, cruza, se detiene o conversa. */
  private step(p: Person, dt: number, traffic: PedestrianTraffic | null, obstacles: readonly TrafficObstacle[]): void {
    const cfg = this.cfg;
    const w = cfg.walking;
    let target = p.speed;
    let face = p.heading;
    this.dt = dt;

    if (p.mode === CHAT) {
      p.timer -= dt;
      if (p.partner) face = Math.atan2(-(p.partner.z - p.z), p.partner.x - p.x);
      if (p.timer <= 0) this.leaveChat(p);
      target = 0;
    } else if (p.mode === PAUSE) {
      p.timer -= dt;
      target = 0;
      if (p.timer <= 0) this.startHop(p);
    } else if (p.mode === WAIT) {
      p.timer += dt;
      target = 0;
      const h = p.hop;
      face = Math.atan2(-(h.z1 - h.z0), h.x1 - h.x0);
      const c = cfg.crossing;
      if (p.timer > c.patience || !traffic || traffic.clearOf(h.x0, h.z0, h.x1, h.z1, c.clear, c.near, c.moving)) {
        p.mode = HOP;
        this.setClip(p, p.walk);
      }
    }

    // Caminando esquiva (ver avoid); cruzando la calle, solo se detiene ante el jugador o su carro.
    if (p.mode === WALK) target = this.avoid(p, target, obstacles);
    else if (p.mode === HOP) {
      const dirX = Math.cos(p.heading);
      const dirZ = -Math.sin(p.heading);
      for (const o of obstacles) {
        const rx = o.x - p.x;
        const rz = o.z - p.z;
        const along = rx * dirX + rz * dirZ;
        const across = Math.abs(rx * dirZ - rz * dirX);
        if (along > 0 && along < cfg.avoid.lookAhead + o.radius && across < cfg.avoid.space + o.radius) target = 0;
      }
    }

    // Velocidad (arranca y frena en un par de pasos) y animación: caminar o parada.
    p.v += THREE.MathUtils.clamp(target - p.v, -w.accel * dt, w.accel * dt);
    if (p.mode === WALK || p.mode === HOP) {
      this.setClip(p, p.v < w.idleBelow && target === 0 ? p.idle : p.walk);
    }

    if (p.mode === WALK) {
      const [, s1] = this.range(p.edge, p.back, p.side);
      p.s = Math.min(p.s + p.v * dt, s1);
      p.lateral += THREE.MathUtils.clamp(p.offset - p.lateral, -w.lateralSpeed * dt, w.lateralSpeed * dt);
      // place deja en _edge el punto del eje: de ahí sale hacia dónde mira.
      this.place(p);
      const sign = p.back ? -1 : 1;
      face = Math.atan2(-_edge.dz * sign, _edge.dx * sign);
      if (p.s >= s1) {
        // Al final del tramo: elige por dónde sigue y a veces se detiene un rato antes.
        this.choose(p);
        if (Math.random() < w.pause.chance) {
          p.mode = PAUSE;
          p.timer = THREE.MathUtils.randFloat(w.pause.seconds[0], w.pause.seconds[1]);
          this.setClip(p, p.idle);
        } else this.startHop(p);
      }
    } else if (p.mode === HOP) {
      const h = p.hop;
      h.s += p.v * dt;
      if (h.length > 1e-3) face = Math.atan2(-(h.z1 - h.z0), h.x1 - h.x0);
      if (h.s >= h.length) {
        p.edge = p.nextEdge;
        p.back = p.nextBack;
        p.side = p.nextSide;
        p.offset = this.offsetFor(p.edge, p.back, p.side, p.u);
        p.lateral = p.offset;
        p.s = this.range(p.edge, p.back, p.side)[0];
        p.mode = WALK;
        p.crossing = false;
        this.place(p);
      } else {
        const t = h.length > 0 ? h.s / h.length : 1;
        p.x = h.x0 + (h.x1 - h.x0) * t;
        p.z = h.z0 + (h.z1 - h.z0) * t;
        if (p.crossing) {
          const o = this.crossers[this.crossing] ?? { x: 0, z: 0, radius: 0 };
          this.crossers[this.crossing++] = o;
          o.x = p.x;
          o.z = p.z;
          o.radius = cfg.crossing.obstacle;
        }
      }
    }

    // Gira de a poco hacia donde va; sube o baja de a un escalón (rampas, puentes).
    let turn = face - p.heading;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    p.heading += THREE.MathUtils.clamp(turn, -w.turnRate * dt, w.turnRate * dt);
    p.y = this.surface(p.x, p.z, p.y + w.stepHeight);

    // Animación: la de caminar al ritmo de sus pasos (sin patinar), las demás a ritmo normal.
    const c = p.clip;
    const rate = c.stride > 0 ? p.v / (c.stride * p.scale) : 1;
    p.phase = (p.phase + (dt * rate) / c.duration) % 1;
    if (p.prev) {
      p.prevPhase = (p.prevPhase + dt / p.prev.duration) % 1;
      p.fade -= dt;
      if (p.fade <= 0) p.prev = null;
    }
  }

  /** Sale hacia el tramo siguiente: si hay que cruzar la calle, primero espera en el borde. */
  private startHop(p: Person): void {
    p.mode = p.crossing ? WAIT : HOP;
    p.timer = 0;
    this.setClip(p, p.crossing ? p.idle : p.walk);
  }

  /** Se da la vuelta en su vereda (algo le bloquea el paso). */
  private turnAround(p: Person): void {
    const L = this.net.length[p.edge];
    p.back = 1 - p.back;
    p.s = L - p.s;
    p.offset = this.offsetFor(p.edge, p.back, p.side, p.u);
    p.blocked = 0;
  }

  /** Termina la conversación: se van cada uno por su lado o juntos. */
  private leaveChat(p: Person): void {
    const q = p.partner;
    p.mode = WALK;
    p.partner = null;
    this.setClip(p, p.walk);
    if (!q) return;
    q.partner = null;
    q.mode = WALK;
    this.setClip(q, q.walk);
    // Uno de los dos se da la vuelta: se van por lados opuestos o, a veces, juntos.
    if (Math.random() < this.cfg.chat.leaveTogether) {
      q.speed = p.speed;
      this.turnAround(q);
    } else this.turnAround(p);
    q.timer = 0;
  }

  /** Arma las instancias de cada malla con quienes se ven (nivel de detalle según la distancia). */
  private draw(camera: THREE.PerspectiveCamera): void {
    for (const body of this.bodies) for (const row of body.meshes) for (const mesh of row) mesh.count = 0;
    const distances = this.cfg.lod.distances;
    const cam = camera.position;
    for (const p of this.people) {
      const body = this.bodies[p.body];
      const tall = body.height * p.scale;
      _sphere.center.set(p.x, p.y + tall / 2, p.z);
      _sphere.radius = tall / 2 + SPHERE_MARGIN;
      if (!this.frustum.intersectsSphere(_sphere)) continue;
      const d = _sphere.center.distanceTo(cam);
      let lod = 0;
      while (lod < distances.length && d > distances[lod]) lod++;
      const mesh = body.meshes[p.hair][lod];
      const attrs = body.attributes[p.hair][lod];
      const slot = mesh.count++;
      _quat.setFromAxisAngle(_up, body.yaw + p.heading);
      _pos.set(p.x, p.y, p.z);
      _scale.setScalar(p.scale);
      mesh.setMatrixAt(slot, _m.compose(_pos, _quat, _scale));
      const anim = attrs.aAnim.array as Float32Array;
      anim[slot * 4] = p.clip.start + Math.min(Math.floor(p.phase * p.clip.frames), p.clip.frames - 1);
      if (p.prev) {
        anim[slot * 4 + 1] = p.prev.start + Math.min(Math.floor(p.prevPhase * p.prev.frames), p.prev.frames - 1);
        anim[slot * 4 + 2] = Math.max(p.fade, 0) / this.cfg.animation.blend;
      } else {
        anim[slot * 4 + 1] = anim[slot * 4];
        anim[slot * 4 + 2] = 0;
      }
      copy4(p.look, 0, attrs.aTop.array as Float32Array, slot * 4);
      copy4(p.look, 4, attrs.aBottom.array as Float32Array, slot * 4);
      copy4(p.look, 8, attrs.aFeet.array as Float32Array, slot * 4);
      copy4(p.look, 12, attrs.aHead.array as Float32Array, slot * 4);
    }
    for (const body of this.bodies) {
      body.meshes.forEach((row, h) =>
        row.forEach((mesh, lod) => {
          mesh.visible = mesh.count > 0;
          if (!mesh.visible) return;
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
          mesh.instanceMatrix.needsUpdate = true;
          for (const attr of Object.values(body.attributes[h][lod])) {
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, mesh.count * 4);
            attr.needsUpdate = true;
          }
        }),
      );
    }
  }
}

const SIDES = [-1, 1] as const;
/** Tope de listas por tramo guardadas (se rehacen si se pasa: tramos que ya no se usan). */
const MAX_EDGE_LISTS = 4096;
const NOBODY: readonly Person[] = [];
const _bounds: [number, number] = [0, 0];

/** Copia cuatro floats (un vec4 por persona) sin crear vistas nuevas. */
function copy4(from: Float32Array, at: number, to: Float32Array, into: number): void {
  to[into] = from[at];
  to[into + 1] = from[at + 1];
  to[into + 2] = from[at + 2];
  to[into + 3] = from[at + 3];
}
/** Margen (m) de la esfera con que se descarta a quien no se ve (brazos, pelo). */
const SPHERE_MARGIN = 0.5;
const _edge: EdgePoint = { x: 0, z: 0, dx: 1, dz: 0, nx: 0, nz: 1 };
const _edge2: EdgePoint = { x: 0, z: 0, dx: 1, dz: 0, nx: 0, nz: 1 };
const _point = { x: 0, z: 0 };
const _color = new THREE.Color();
const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _matrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
