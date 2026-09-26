import * as THREE from 'three';
import { Batch, type Surface, patternOf } from './monumentParts';
import type { PlaceSite } from './placeKit';

/**
 * Cómo es un muro o una valla corrida (config/sites → walls, por nombre): el paño entre pilares
 * (macizo con su dibujo, o calado como una malla), sus hiladas de paneles y una franja pintada que
 * sube y baja de hilada (zigzag), los pilares, el remate (cerco eléctrico, alambre o malla con sus
 * postes) y la física. Largos en m; las alturas, sobre el terreno de cada punta de cada vano.
 */
export interface WallStyle {
  /** Alto del paño sobre el terreno. */
  height: number;
  /** Grosor del paño (macizo). */
  thickness: number;
  /** Cuánto baja el paño y los pilares bajo el terreno (donde el suelo baja no queda luz abajo). */
  bury: number;
  /**
   * El paño: 'solid' (muro macizo: sus dos caras y el remate de arriba), 'screen' (malla o reja
   * calada: una cara que se ve de los dos lados) o 'none' (solo pilares y remate). Color, dibujo
   * (PATTERN) y cuántas unidades del dibujo mide cada metro, y su oclusión.
   */
  body: { kind: string; color: string; pattern: string; scale: number[]; ao: number };
  /**
   * Paneles en hiladas horizontales encajados entre pilares: cuántas hiladas hay en el alto y el
   * dibujo de sus juntas (una losa del dibujo por panel: `cell` es cuánto mide una losa del dibujo
   * en sus unidades, config/game.json → monuments.patterns). Sin él, un paño liso.
   */
  courses?: { count: number; pattern: string; cell: number[] };
  /**
   * Franja pintada de `courses` hiladas que cambia de altura en cada vano: la hilada donde arranca
   * en cada vano (desde 0 abajo; la secuencia se repite a lo largo del muro), su color y en qué
   * caras va ('out' = la de afuera del conjunto, 'in' = la de adentro). Necesita `courses`.
   */
  stripe?: { courses: number; sequence: number[]; color: string; faces: string[] };
  /**
   * Pilares: separación buscada (en cada lado se reparten parejos), ancho a lo largo del muro y
   * fondo total (lo que sobresale del paño sale de ahí), cuánto suben sobre el paño, color,
   * dibujo y su escala, y su oclusión.
   */
  posts: { spacing: number; size: number[]; rise: number; color: string; pattern: string; scale: number[]; ao: number };
  /**
   * Remate calado sobre el muro (cerco eléctrico, alambre, malla): su alto sobre el paño, dibujo
   * (PATTERN, calado) y su escala, color; sus postes: cuántos por vano (1 = uno en cada pilar; 2 =
   * además uno a mitad de vano), ancho y fondo, y color.
   */
  topping?: { height: number; pattern: string; scale: number[]; color: string; posts: { per: number; size: number[]; color: string } };
  /** Largo máximo de cada tramo de la física, y de cada paño liso que se arma de corrido. */
  physics: number;
  step: number;
  /** Hasta qué distancia (del centro de su pedazo) se ven el remate calado y sus postes. */
  near: number;
}

/**
 * Un tramo de muro (config): una polilínea en el marco del lugar (o de la zona que lo trae), si
 * cierra, los lados que no llevan muro (i = del punto i al i+1: el portal de una garita), su estilo
 * y de dónde sale. En uno abierto, de qué lado del recorrido queda el afuera (+1 = a la derecha,
 * hacia +z yendo hacia +x; −1 = a la izquierda; si no, +1); en uno cerrado sale de su contorno.
 */
export interface WallRun {
  id: string;
  style: string;
  line: number[][];
  closed: boolean;
  skip?: number[];
  outside?: number;
  source: string;
}

/** Lo que un muro necesita del lugar para armarse (todo en el marco del lugar). */
export interface WallKit {
  terrain(x: number, z: number): number;
  /** Un pedazo de la física y del LOD con centro (x, z): uno por celda del muro. */
  site(x: number, z: number): PlaceSite;
  /** Donde van sus mallas. */
  group: THREE.Group;
  /** Muro (color por vértice), calado (con recorte) y pilares instanciados (el pie del revoque desde cada pilar). */
  materials: { stone: THREE.Material; rails: THREE.Material; posts: THREE.Material };
  /** Grosor mínimo de su física (m): una malla más fina se atravesaría corriendo (el jugador prueba un punto por cuadro). */
  wall: number;
}

/** Dos puntos de una línea a menos de esto (m) son el mismo: el último de un tramo cerrado que repite el primero. */
const SAME = 1e-3;

/** Los puntos de un tramo: en uno cerrado, sin el último si repite el primero (la revisión y el armado deciden igual). */
function runPoints(run: WallRun): THREE.Vector2[] {
  const pts = run.line.map(([x, z]) => new THREE.Vector2(x, z));
  if (run.closed && pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < SAME) pts.pop();
  return pts;
}

/** Falla al cargar si un tramo de muro no cierra: menos de dos puntos, o un lado sin muro que no existe. */
export function checkWallRun(run: WallRun, where: string): void {
  const n = runPoints(run).length;
  if (n < 2) throw new Error(`Muro ${run.id} (${where}): la línea necesita al menos dos puntos`);
  const edges = run.closed ? n : n - 1;
  for (const e of run.skip ?? []) if (!Number.isInteger(e) || e < 0 || e >= edges) throw new Error(`Muro ${run.id} (${where}): skip ${e} no es un lado (hay ${edges})`);
  if (run.closed && (run.skip ?? []).length >= edges) throw new Error(`Muro ${run.id} (${where}): skip saca todos los lados`);
  if (run.outside !== undefined && run.outside !== 1 && run.outside !== -1) throw new Error(`Muro ${run.id} (${where}): outside tiene que ser 1 o -1`);
}

/** Falla al cargar si un estilo de muro trae algo que no cierra (un largo ≤ 0 dejaría un bucle sin fin). */
export function checkWallStyle(s: WallStyle, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`Muro ${where}: ${what}`);
  };
  if (!(s.posts.spacing > 0)) bad('posts.spacing tiene que ser mayor que 0');
  if (!(s.physics > 0)) bad('physics tiene que ser mayor que 0');
  if (!(s.step > 0)) bad('step tiene que ser mayor que 0');
  if (!(s.height > 0)) bad('height tiene que ser mayor que 0');
  if (!['solid', 'screen', 'none'].includes(s.body.kind)) bad(`body.kind desconocido: ${s.body.kind} (hay: solid, screen, none)`);
  patternOf(s.body.pattern);
  patternOf(s.posts.pattern);
  if (s.courses) {
    if (!(s.courses.count > 0)) bad('courses.count tiene que ser mayor que 0');
    patternOf(s.courses.pattern);
  }
  if (s.stripe) {
    if (!s.courses) bad('stripe necesita courses (las hiladas de donde sube y baja)');
    if (!s.stripe.sequence.length) bad('stripe.sequence está vacía');
    for (const f of s.stripe.faces) if (f !== 'in' && f !== 'out') bad(`stripe.faces: ${f} (hay: in, out)`);
  }
  if (s.topping) {
    if (!(s.topping.posts.per > 0)) bad('topping.posts.per tiene que ser mayor que 0');
    patternOf(s.topping.pattern);
  }
}

/** Un vano entre dos pilares: sus puntas, en qué lado de la polilínea está y su lugar a lo largo del tramo. */
interface Span {
  a: THREE.Vector2;
  b: THREE.Vector2;
  edge: number;
  /** Índice corrido del vano en el tramo (para la secuencia de la franja). */
  k: number;
  /** Distancia del medio del vano al comienzo del tramo. */
  s: number;
}

/** Un pilar: dónde está, hacia dónde va el muro y su distancia al comienzo del tramo. */
interface Post {
  p: THREE.Vector2;
  angle: number;
  s: number;
}

/**
 * Un pedazo del muro: su física y su LOD (un `site`), su nombre, sus búferes, los pilares y postes
 * de cada modelo, y hasta dónde se ve su remate calado (0 = sin remate: lo calado es malla).
 */
interface Cell {
  name: string;
  site: PlaceSite;
  stone: Batch;
  rails: Batch;
  posts: Map<string, THREE.Matrix4[]>;
  fence: Map<string, THREE.Matrix4[]>;
  near: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Cuadrilátero plano a-b-c-d mirando hacia arriba (lo da vuelta si hace falta). */
function upQuad(batch: Batch, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, surface: Surface): void {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
  if (n.y >= 0) batch.quad(a, b, c, d, color, surface);
  else batch.quad(b, a, d, c, color, surface);
}

/**
 * Caja de base 1 × 1 × 1 con el pie en el origen, sin la cara de abajo (se entierra): el modelo de
 * los pilares y de los postes del remate, que se instancian escalados (ancho, alto, fondo). `foot`:
 * cuánto sobre el pie de la instancia está el suelo (un pilar arranca enterrado: su pie sucio del
 * revoque se mide desde el suelo, no desde lo enterrado).
 */
function postModel(color: THREE.Color, surface: Surface, foot: number): THREE.BufferGeometry {
  const b = new Batch();
  b.flood[1] = foot;
  const P = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const h = 0.5;
  // Cuatro costados (antihorario visto desde afuera) y el tope.
  b.quad(P(-h, 0, h), P(h, 0, h), P(h, 1, h), P(-h, 1, h), color, surface);
  b.quad(P(h, 0, -h), P(-h, 0, -h), P(-h, 1, -h), P(h, 1, -h), color, surface);
  b.quad(P(h, 0, h), P(h, 0, -h), P(h, 1, -h), P(h, 1, h), color, surface);
  b.quad(P(-h, 0, -h), P(-h, 0, h), P(-h, 1, h), P(-h, 1, -h), color, surface);
  b.quad(P(-h, 1, h), P(h, 1, h), P(h, 1, -h), P(-h, 1, -h), color, surface);
  return b.build();
}

/**
 * Arma los muros de un lugar. Cada tramo se parte en celdas de `cell` m a lo largo: cada celda es
 * su propio pedazo de física y de LOD (el `site` que da el kit), con una malla de paños, los pilares
 * instanciados y, solo de cerca, el remate calado. Los tramos que caen en el mismo pedazo (las
 * vallas de una zona) comparten sus mallas; `flush` las arma al final. Los modelos de pilar y de
 * poste se arman una vez por estilo.
 */
export class WallBuilder {
  private readonly models = new Map<string, THREE.BufferGeometry>();
  private readonly cells = new Map<PlaceSite, Cell>();

  constructor(
    private readonly styles: Record<string, WallStyle>,
    private readonly kit: WallKit,
    private readonly cell: number,
  ) {}

  /** El estilo con ese nombre (falla si no existe). */
  style(name: string): WallStyle {
    const s = Object.hasOwn(this.styles, name) ? this.styles[name] : undefined;
    if (!s) throw new Error(`Muro de estilo desconocido: ${name} (hay: ${Object.keys(this.styles).join(', ')})`);
    return s;
  }

  /** Un tramo de muro (sus mallas, nombradas `<name>-<celda>-<parte>`, salen con `flush`). */
  build(run: WallRun, name: string): void {
    const S = this.style(run.style);
    const pts = runPoints(run);
    const edgeCount = run.closed ? pts.length : pts.length - 1;
    const skip = new Set(run.skip ?? []);
    // Cadenas de lados seguidos con muro (un anillo sin saltos es una sola cadena cerrada): en uno
    // cerrado con saltos, se arranca después de un lado sin muro (a lo sumo una vuelta).
    const chains: number[][] = [];
    let start = 0;
    if (run.closed && skip.size) for (let t = 0; t < edgeCount && !skip.has((start + edgeCount - 1) % edgeCount); t++) start++;
    let current: number[] = [];
    for (let j = 0; j < edgeCount; j++) {
      const e = (start + j) % edgeCount;
      if (skip.has(e)) {
        if (current.length) chains.push(current);
        current = [];
        continue;
      }
      current.push(e);
    }
    if (current.length) chains.push(current);
    const loop = run.closed && !skip.size;
    // El afuera: en un contorno cerrado con área positiva (x·z' − x'·z) el adentro queda a la derecha.
    let area = 0;
    for (let k = 0; k < pts.length; k++) area += pts[k].x * pts[(k + 1) % pts.length].y - pts[(k + 1) % pts.length].x * pts[k].y;
    const outside = run.closed ? (area > 0 ? -1 : 1) : (run.outside ?? 1);

    // Vanos y pilares, con su distancia al comienzo del tramo (de ahí sale su celda).
    const spans: Span[] = [];
    const posts: Post[] = [];
    let s = 0;
    let k = 0;
    for (const chain of chains) {
      chain.forEach((e, i) => {
        const a = pts[e];
        const b = pts[(e + 1) % pts.length];
        const len = a.distanceTo(b);
        if (len < 1e-3) return;
        const n = Math.max(1, Math.ceil(len / S.posts.spacing));
        const dir = Math.atan2(b.y - a.y, b.x - a.x);
        // Pilar de la esquina: a mitad de camino entre el lado anterior y este.
        if (i > 0 || loop) {
          const prev = chain[(i + chain.length - 1) % chain.length];
          const pa = pts[prev];
          const before = Math.atan2(a.y - pa.y, a.x - pa.x);
          posts.push({ p: a.clone(), angle: before + Math.atan2(Math.sin(dir - before), Math.cos(dir - before)) / 2, s });
        } else posts.push({ p: a.clone(), angle: dir, s });
        for (let q = 0; q < n; q++) {
          const p0 = a.clone().lerp(b, q / n);
          const p1 = a.clone().lerp(b, (q + 1) / n);
          if (q > 0) posts.push({ p: p0.clone(), angle: dir, s });
          spans.push({ a: p0, b: p1, edge: e, k: k++, s: s + len / n / 2 });
          s += len / n;
        }
        if (i === chain.length - 1 && !loop) posts.push({ p: b.clone(), angle: dir, s });
      });
    }
    if (!spans.length) return;

    // Celdas: cada una con su centro (el promedio de sus vanos) y su pedazo de la física.
    const cellOf = (d: number): number => Math.floor(d / this.cell);
    const sums = new Map<number, { x: number; z: number; n: number }>();
    for (const sp of spans) {
      const c = cellOf(sp.s);
      const acc = sums.get(c) ?? { x: 0, z: 0, n: 0 };
      acc.x += (sp.a.x + sp.b.x) / 2;
      acc.z += (sp.a.y + sp.b.y) / 2;
      acc.n++;
      sums.set(c, acc);
    }
    const cells = new Map<number, Cell>();
    for (const [c, acc] of sums) {
      const site = this.kit.site(acc.x / acc.n, acc.z / acc.n);
      let cell = this.cells.get(site);
      if (!cell) {
        cell = { name: `${name}-${c}`, site, stone: new Batch(), rails: new Batch(), posts: new Map(), fence: new Map(), near: 0 };
        // El suelo de la celda (la mediana del terreno en las puntas de sus vanos): desde ahí se ve el pie sucio del revoque.
        const ground = spans
          .filter((sp) => cellOf(sp.s) === c)
          .map((sp) => this.kit.terrain(sp.a.x, sp.a.y))
          .sort((a, b) => a - b);
        cell.stone.flood[1] = ground[Math.floor(ground.length / 2)];
        this.cells.set(site, cell);
      }
      if (S.topping) cell.near = Math.max(cell.near, S.near);
      cells.set(c, cell);
    }
    const postKey = `${run.style}-post`;
    const fenceKey = `${run.style}-fence`;
    const push = (map: Map<string, THREE.Matrix4[]>, key: string, m: THREE.Matrix4): void => {
      const list = map.get(key);
      if (list) list.push(m);
      else map.set(key, [m]);
    };
    // Un pilar o un tramo de física al final del muro puede caer justo en el borde de otra celda.
    const cellAt = (d: number): Cell => cells.get(cellOf(d)) ?? cells.get(cellOf(Math.max(0, d - this.cell / 2))) ?? [...cells.values()][0];

    const g = (p: THREE.Vector2): number => this.kit.terrain(p.x, p.y);
    const body = new THREE.Color(S.body.color);
    const bodySurface: Surface = { pattern: patternOf(S.body.pattern), scale: S.body.scale, ao: S.body.ao };
    const C = S.courses;
    const joints: Surface = C ? { pattern: patternOf(C.pattern), ao: S.body.ao } : bodySurface;
    const striped = new Set((S.stripe?.faces ?? []).map((f) => (f === 'out' ? outside : -outside)));

    // Paños: la cara pintada, vano por vano; lo liso (las otras caras y el remate), de corrido.
    if (S.body.kind === 'solid') {
      for (const sp of spans) if (striped.size) for (const side of striped) this.stripedFace(sp, side, S, cellAt(sp.s).stone, body, joints);
      this.runs(spans, S.step, (group) => {
        const cellBatch = cellAt((group[0].s + group[group.length - 1].s) / 2).stone;
        for (const side of [1, -1]) if (!striped.has(side)) this.plainFace(group, side, S, cellBatch, body, C ? joints : bodySurface);
        this.top(group, S, cellBatch, body, bodySurface);
      });
    } else if (S.body.kind === 'screen') {
      const screen: Surface = { pattern: patternOf(S.body.pattern), scale: S.body.scale, ao: S.body.ao };
      this.runs(spans, S.step, (group) => {
        const a = group[0].a;
        const b = group[group.length - 1].b;
        const len = a.distanceTo(b);
        const ya = g(a);
        const yb = g(b);
        const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
        cellAt((group[0].s + group[group.length - 1].s) / 2).rails.quad(P(a, ya), P(b, yb), P(b, yb + S.height), P(a, ya + S.height), body, screen, [0, 0, len, 0, len, S.height, 0, S.height]);
      });
    }

    // Pilares: uno por punta de vano, del pie enterrado a su tope.
    const q = new THREE.Quaternion();
    const size = new THREE.Vector3();
    const at = new THREE.Vector3();
    for (const p of posts) {
      const y = g(p.p);
      const h = S.height + S.posts.rise + S.bury;
      q.setFromAxisAngle(UP, -p.angle);
      push(cellAt(p.s).posts, postKey, new THREE.Matrix4().compose(at.set(p.p.x, y - S.bury, p.p.y), q, size.set(S.posts.size[0], h, S.posts.size[1])));
    }

    // Remate calado: los hilos (o la malla) de poste a poste, y sus postes.
    const T = S.topping;
    if (T) {
      const color = new THREE.Color(T.color);
      const surface: Surface = { pattern: patternOf(T.pattern), scale: T.scale };
      const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
      for (const sp of spans) {
        const c = cellAt(sp.s);
        const len = sp.a.distanceTo(sp.b);
        const ya = g(sp.a) + S.height;
        const yb = g(sp.b) + S.height;
        c.rails.quad(P(sp.a, ya), P(sp.b, yb), P(sp.b, yb + T.height), P(sp.a, ya + T.height), color, surface, [0, 0, len, 0, len, T.height, 0, T.height]);
        const dir = Math.atan2(sp.b.y - sp.a.y, sp.b.x - sp.a.x);
        q.setFromAxisAngle(UP, -dir);
        for (let j = 0; j < T.posts.per; j++) {
          const p = sp.a.clone().lerp(sp.b, j / T.posts.per);
          push(c.fence, fenceKey, new THREE.Matrix4().compose(at.set(p.x, g(p) + S.height, p.y), q, size.set(T.posts.size[0], T.height, T.posts.size[1])));
        }
      }
      // El poste del último pilar de cada cadena abierta.
      if (!loop) {
        for (const p of posts) {
          if (spans.some((sp) => sp.a.distanceTo(p.p) < 1e-3)) continue;
          q.setFromAxisAngle(UP, -p.angle);
          push(cellAt(p.s).fence, fenceKey, new THREE.Matrix4().compose(at.set(p.p.x, g(p.p) + S.height, p.p.y), q, size.set(T.posts.size[0], T.height, T.posts.size[1])));
        }
      }
    }

    // Física: tramos rectos de a lo sumo `physics` m, del grosor de los pilares (o el mínimo del lugar), hasta el remate.
    const top = S.height + (T ? T.height : 0);
    const half = Math.max(S.thickness, S.posts.size[1], this.kit.wall) / 2;
    // El pedazo de un tramo de física: el del vano más cercano a su medio.
    const nearestCell = (m: THREE.Vector2): Cell => {
      let best = spans[0];
      let bestD = Infinity;
      for (const sp of spans) {
        const d = Math.hypot((sp.a.x + sp.b.x) / 2 - m.x, (sp.a.y + sp.b.y) / 2 - m.y);
        if (d < bestD) {
          bestD = d;
          best = sp;
        }
      }
      return cellAt(best.s);
    };
    for (const chain of chains) {
      for (const e of chain) {
        const a = pts[e];
        const b = pts[(e + 1) % pts.length];
        const len = a.distanceTo(b);
        if (len < 1e-3) continue;
        const n = Math.max(1, Math.ceil(len / S.physics));
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        for (let j = 0; j < n; j++) {
          const p0 = a.clone().lerp(b, j / n);
          const p1 = a.clone().lerp(b, (j + 1) / n);
          const m = p0.clone().add(p1).multiplyScalar(0.5);
          nearestCell(m).site.box(m.x, m.y, len / n / 2, half, angle, Math.max(g(p0), g(p1)) + top, false, -Infinity);
        }
      }
    }

    // Los modelos de pilar y de poste de este estilo (una vez).
    this.model(postKey, () => postModel(new THREE.Color(S.posts.color), { pattern: patternOf(S.posts.pattern), scale: S.posts.scale, ao: S.posts.ao }, S.bury));
    if (T) this.model(fenceKey, () => postModel(new THREE.Color(T.posts.color), {}, 0));
  }

  /** Arma las mallas de todos los pedazos: una por pedazo y por material, y una instanciada por modelo de pilar o poste. */
  flush(): void {
    for (const cell of this.cells.values()) {
      this.mesh(cell.stone, this.kit.materials.stone, `${cell.name}-stone`, true);
      const rails = this.mesh(cell.rails, this.kit.materials.rails, `${cell.name}-rails`, false);
      if (rails && cell.near > 0) cell.site.near(rails, cell.near);
      for (const [key, list] of cell.posts) this.instances(this.models.get(key)!, list, `${cell.name}-${key}`, true);
      for (const [key, list] of cell.fence) {
        const fence = this.instances(this.models.get(key)!, list, `${cell.name}-${key}`, false);
        if (fence) cell.site.near(fence, cell.near);
      }
    }
    this.cells.clear();
  }

  /** Vanos seguidos del mismo lado de la polilínea en grupos de a lo sumo `step` m (para armar lo liso de corrido). */
  private runs(spans: readonly Span[], step: number, emit: (group: Span[]) => void): void {
    let group: Span[] = [];
    let len = 0;
    for (const sp of spans) {
      const l = sp.a.distanceTo(sp.b);
      const last = group[group.length - 1];
      if (group.length && (last.edge !== sp.edge || last.b.distanceTo(sp.a) > 1e-3 || len + l > step)) {
        emit(group);
        group = [];
        len = 0;
      }
      group.push(sp);
      len += l;
    }
    if (group.length) emit(group);
  }

  /** Una cara lisa de un grupo de vanos (el lado `side`: +1 a la derecha del recorrido), del pie enterrado al remate. */
  private plainFace(group: readonly Span[], side: number, S: WallStyle, batch: Batch, color: THREE.Color, surface: Surface): void {
    const a = group[0].a;
    const b = group[group.length - 1].b;
    const len = a.distanceTo(b);
    const n = new THREE.Vector2(-(b.y - a.y), b.x - a.x).divideScalar(len).multiplyScalar((side * S.thickness) / 2);
    const A = a.clone().add(n);
    const B = b.clone().add(n);
    const ga = this.kit.terrain(a.x, a.y);
    const gb = this.kit.terrain(b.x, b.y);
    const C = S.courses;
    // Con hiladas, una losa del dibujo por panel (vano × hilada); si no, uv en metros.
    const hc = C ? S.height / C.count : 1;
    const u1 = C ? group.length * C.cell[0] : len;
    const v0 = C ? (-S.bury / hc) * C.cell[1] : -S.bury;
    const v1 = C ? C.count * C.cell[1] : S.height;
    const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
    const q = [P(A, ga - S.bury), P(B, gb - S.bury), P(B, gb + S.height), P(A, ga + S.height)];
    const uv = [0, v0, u1, v0, u1, v1, 0, v1];
    if (side > 0) batch.quad(q[0], q[1], q[2], q[3], color, surface, uv);
    else batch.quad(q[1], q[0], q[3], q[2], color, surface, [u1, v0, 0, v0, 0, v1, u1, v1]);
  }

  /** La cara pintada de un vano: debajo de la franja, la franja (de su color) y encima, con las juntas de sus hiladas. */
  private stripedFace(sp: Span, side: number, S: WallStyle, batch: Batch, color: THREE.Color, surface: Surface): void {
    const C = S.courses;
    const T = S.stripe;
    if (!C || !T) return;
    const len = sp.a.distanceTo(sp.b);
    const n = new THREE.Vector2(-(sp.b.y - sp.a.y), sp.b.x - sp.a.x).divideScalar(len).multiplyScalar((side * S.thickness) / 2);
    const A = sp.a.clone().add(n);
    const B = sp.b.clone().add(n);
    const ga = this.kit.terrain(sp.a.x, sp.a.y);
    const gb = this.kit.terrain(sp.b.x, sp.b.y);
    const hc = S.height / C.count;
    const first = T.sequence[sp.k % T.sequence.length];
    const paint = new THREE.Color(T.color);
    // Cortes en hiladas (desde el pie visible): el entierro, la franja y lo de arriba.
    const cuts = [-S.bury / hc, first, first + T.courses, C.count];
    const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
    for (let j = 0; j < 3; j++) {
      const c0 = Math.max(cuts[j], cuts[0]);
      const c1 = Math.min(cuts[j + 1], C.count);
      if (c1 - c0 < 1e-3) continue;
      const col = j === 1 ? paint : color;
      const v0 = c0 * C.cell[1];
      const v1 = c1 * C.cell[1];
      const q = [P(A, ga + c0 * hc), P(B, gb + c0 * hc), P(B, gb + c1 * hc), P(A, ga + c1 * hc)];
      if (side > 0) batch.quad(q[0], q[1], q[2], q[3], col, surface, [0, v0, C.cell[0], v0, C.cell[0], v1, 0, v1]);
      else batch.quad(q[1], q[0], q[3], q[2], col, surface, [C.cell[0], v0, 0, v0, 0, v1, C.cell[0], v1]);
    }
  }

  /** El remate de arriba del paño macizo, de corrido. */
  private top(group: readonly Span[], S: WallStyle, batch: Batch, color: THREE.Color, surface: Surface): void {
    const a = group[0].a;
    const b = group[group.length - 1].b;
    const len = a.distanceTo(b);
    const n = new THREE.Vector2(-(b.y - a.y), b.x - a.x).divideScalar(len).multiplyScalar(S.thickness / 2);
    const ya = this.kit.terrain(a.x, a.y) + S.height;
    const yb = this.kit.terrain(b.x, b.y) + S.height;
    const P = (p: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
    upQuad(batch, P(a.clone().add(n), ya), P(b.clone().add(n), yb), P(b.clone().sub(n), yb), P(a.clone().sub(n), ya), color, surface);
  }

  private model(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.models.get(key);
    if (!g) {
      g = make();
      this.models.set(key, g);
    }
    return g;
  }

  private mesh(batch: Batch, material: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null {
    if (batch.empty) return null;
    const mesh = new THREE.Mesh(batch.build(), material);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.kit.group.add(mesh);
    return mesh;
  }

  private instances(geometry: THREE.BufferGeometry, matrices: readonly THREE.Matrix4[], name: string, shadow: boolean): THREE.InstancedMesh | null {
    if (!matrices.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, this.kit.materials.posts, matrices.length);
    matrices.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.computeBoundingSphere();
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.kit.group.add(mesh);
    return mesh;
  }
}
