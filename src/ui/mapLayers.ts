import type { GameConfig, RoadNetwork, WorldManifest } from '../core/types';

type MapConfig = GameConfig['map'];

/** Estilo de un grupo de calles (config/game.json → map.style.roads). */
interface RoadStyle {
  classes: string[];
  color: string;
  /** Ancho real (m): se dibuja a escala, pero nunca más fino que `minPx`. */
  meters: number;
  minPx: number;
  /** Borde oscuro alrededor (px), para que la calle se despegue del fondo. */
  casingPx: number;
  /** Con más metros por píxel que esto, el grupo no se dibuja (no se distinguiría). */
  maxMpp?: number;
  /** Desde estos metros por píxel se atenúa a `fadeAlpha`. */
  fadeFromMpp?: number;
  fadeAlpha?: number;
}

interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Polígono (agua, parque): anillos [x, z, …]; los huecos restan (par-impar). */
interface Shape extends Box {
  rings: Float32Array[];
}

interface Line extends Box {
  points: Float32Array;
}

/** Vista de un mapa: centro (m del marco local), metros por píxel CSS y giro en pantalla (rad). */
export interface MapView {
  x: number;
  z: number;
  mpp: number;
  /** 0 = norte arriba; positivo = el mapa gira en sentido horario. */
  rotation: number;
}

function boxOf(parts: ArrayLike<number>[]): Box {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of parts) {
    for (let k = 0; k < p.length; k += 2) {
      x0 = Math.min(x0, p[k]);
      x1 = Math.max(x1, p[k]);
      z0 = Math.min(z0, p[k + 1]);
      z1 = Math.max(z1, p[k + 1]);
    }
  }
  return { x0, z0, x1, z1 };
}

/** Punto del mundo (x, z) en la vista: píxeles CSS desde la esquina, con el giro del mapa. */
export function toView(x: number, z: number, width: number, height: number, view: MapView, out: number[]): number[] {
  const dx = (x - view.x) / view.mpp;
  const dz = (z - view.z) / view.mpp;
  const c = Math.cos(view.rotation);
  const s = Math.sin(view.rotation);
  out[0] = width / 2 + dx * c - dz * s;
  out[1] = height / 2 + dx * s + dz * c;
  return out;
}

/** Índice por celdas de `cell` m: qué elementos toca cada una (para dibujar solo lo de una baldosa). */
class Grid<T extends Box> {
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private tick = 0;

  constructor(
    private readonly items: T[],
    private readonly cell: number,
  ) {
    this.stamp = new Uint32Array(items.length);
    items.forEach((it, k) => {
      for (let i = Math.floor(it.x0 / cell); i <= Math.floor(it.x1 / cell); i++) {
        for (let j = Math.floor(it.z0 / cell); j <= Math.floor(it.z1 / cell); j++) {
          const key = Grid.key(i, j);
          const list = this.cells.get(key);
          if (list) list.push(k);
          else this.cells.set(key, [k]);
        }
      }
    });
  }

  private static key(i: number, j: number): number {
    // Celdas con índices de hasta ±2^15: caben de a pares en un número.
    return (i + 32768) * 65536 + (j + 32768);
  }

  /** Cada elemento cuya caja toca la caja pedida, una sola vez. */
  each(x0: number, z0: number, x1: number, z1: number, fn: (item: T) => void): void {
    const tick = ++this.tick;
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const list = this.cells.get(Grid.key(i, j));
        if (!list) continue;
        for (const k of list) {
          if (this.stamp[k] === tick) continue;
          this.stamp[k] = tick;
          const it = this.items[k];
          if (it.x1 < x0 || it.x0 > x1 || it.z1 < z0 || it.z0 > z1) continue;
          fn(it);
        }
      }
    }
  }
}

/** Baldosa que falta: quién la pidió, qué tan urgente es y a cuántos px del centro de su vista queda. */
interface Wanted {
  owner: string;
  /** 0: se ve y no hay nada con qué taparla; 1: se ve, tapada por otro nivel; 2: de base. */
  rank: number;
  distance: number;
}

/** Cómo es una vista del mapa. */
export interface ViewShape {
  /** La vista es el círculo inscrito (el minimapa): no se piden las baldosas de las esquinas. */
  round?: boolean;
  /**
   * Cuántos de los niveles más lejanos se tienen armados para todo el mundo mientras la vista
   * está abierta: con eso, un hueco (al alejar o al arrastrar rápido) nunca queda vacío.
   */
  baseLevels?: number;
}

/**
 * Mapa dibujado de la ciudad para el HUD (minimapa y mapa grande), nítido a cualquier escala:
 * calles por jerarquía (la red del tráfico, ya cargada), agua (water.json), parques (map.json)
 * y la Aerovía.
 *
 * - Se arma en baldosas de `tile` px CSS por nivel de detalle (`levels`, metros por píxel, cada
 *   uno el doble del anterior): cada una se dibuja una sola vez y se guarda; por cuadro solo se
 *   copian imágenes. Una vista usa el nivel más fino que no la supera y lo achica.
 * - Cada vista (minimapa, mapa grande) dibuja con su nombre: las baldosas que muestra no se
 *   sueltan nunca, por grande que sea la pantalla (si se soltaran, se volverían a armar en cada
 *   cuadro y el mapa titilaría). Aparte, se guardan hasta `spareTiles` de las últimas que
 *   dejaron de verse, para volver atrás sin rearmarlas.
 * - Las que faltan se piden al dibujar y se arman con `pump`, las del centro primero, dentro de
 *   un tiempo por cuadro; mientras tanto se ve lo que haya de los niveles vecinos (al acercar,
 *   la de arriba estirada; al alejar, las de abajo achicadas).
 * - Cada capa se indexa por celdas de `cell` m, así una baldosa solo recorre lo suyo.
 */
export class MapLayers {
  private water: Grid<Shape> | null = null;
  private parks: Grid<Shape> | null = null;
  private roads: Grid<Line>[] = [];
  private bridges: Grid<Line>[] = [];
  private readonly aerovia: Float32Array[];
  private readonly styles: RoadStyle[];
  /** Baldosas armadas, de la usada hace más tiempo a la más reciente. */
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  /** Lo que muestra cada vista en su último dibujo (y lo que se le armó desde entonces). */
  private readonly shown = new Map<string, Set<string>>();
  /** Baldosas que las vistas pidieron en este cuadro y todavía no existen. */
  private readonly wanted = new Map<string, Wanted>();
  private readonly dpr: number;
  /** Caja (m) de la baldosa que se está completando con las de otros niveles. */
  private readonly hole: Box = { x0: 0, z0: 0, x1: 0, z1: 0 };
  /** Todo el mundo (m): lo que cubren las baldosas de base. */
  private readonly extent: Box;

  constructor(
    private readonly cfg: MapConfig,
    manifest: WorldManifest,
  ) {
    this.styles = cfg.style.roads;
    // Las baldosas de un nivel caben justo cuatro en una del siguiente (para completar lo que falta).
    cfg.levels.forEach((mpp, k) => {
      if (k > 0 && mpp !== cfg.levels[k - 1] * 2) throw new Error('config/game.json → map.levels: cada nivel debe ser el doble del anterior');
    });
    this.dpr = Math.min(window.devicePixelRatio || 1, cfg.maxPixelRatio);
    this.aerovia = (manifest.aerialways?.lines ?? []).map((line) => Float32Array.from(line.points.flatMap((p) => [p[1], p[2]])));
    const c = manifest.chunks;
    this.extent = { x0: c.xmin, z0: c.zmin, x1: c.xmin + c.nx * c.size, z1: c.zmin + c.nz * c.size };
  }

  /** Píxeles reales por píxel CSS con que se dibujan las baldosas (y conviene dibujar las vistas). */
  get pixelRatio(): number {
    return this.dpr;
  }

  /** Parques de toda la ciudad (map.json, paso `roads`); null si el manifest no los trae. */
  static async loadParks(baseUrl: string, manifest: WorldManifest): Promise<number[][][] | null> {
    if (!manifest.map) return null;
    const res = await fetch(new URL(manifest.map.url, baseUrl));
    if (!res.ok) throw new Error(`No se pudo cargar el mapa (${res.status})`);
    return ((await res.json()) as { parks: number[][][] }).parks;
  }

  setWater(polygons: number[][][]): void {
    this.water = this.shapes(polygons);
    this.clear();
  }

  setParks(polygons: number[][][]): void {
    this.parks = this.shapes(polygons);
    this.clear();
  }

  /** Calles de la red del tráfico, por grupo de estilo (las clases que no están en ninguno no se dibujan). */
  setRoads(net: RoadNetwork): void {
    const groupOf = new Map<string, number>();
    this.styles.forEach((style, g) => style.classes.forEach((name) => groupOf.set(name, g)));
    const roads: Line[][] = this.styles.map(() => []);
    const bridges: Line[][] = this.styles.map(() => []);
    for (let e = 0; e < net.edges; e++) {
      const g = groupOf.get(net.info.classes[net.kind[e]]);
      const a = net.start[e];
      const b = net.start[e + 1];
      if (g === undefined || b - a < 2) continue;
      const points = new Float32Array((b - a) * 2);
      for (let k = a; k < b; k++) {
        points[(k - a) * 2] = net.x[k];
        points[(k - a) * 2 + 1] = net.z[k];
      }
      (net.flags[e] & net.info.flags.bridge ? bridges : roads)[g].push({ points, ...boxOf([points]) });
    }
    this.roads = roads.map((lines) => new Grid(lines, this.cfg.cell));
    this.bridges = bridges.map((lines) => new Grid(lines, this.cfg.cell));
    this.clear();
  }

  /** Suelta todas las baldosas (llegaron datos nuevos: hay que volver a dibujarlas). */
  clear(): void {
    this.tiles.clear();
  }

  /** La vista `owner` dejó de mostrarse (se cerró el mapa): sus baldosas ya se pueden soltar. */
  release(owner: string): void {
    this.shown.delete(owner);
    for (const [key, want] of this.wanted) if (want.owner === owner) this.wanted.delete(key);
    this.trim();
  }

  /**
   * Dibuja la vista `owner` en `ctx` (`width` × `height` px CSS, con la escala del devicePixelRatio
   * ya puesta). Devuelve true si faltó alguna baldosa (quedó pedida para `pump`).
   */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, view: MapView, owner: string, shape: ViewShape = {}): boolean {
    const round = shape.round ?? false;
    const cfg = this.cfg;
    const used = new Set<string>();
    ctx.save();
    ctx.fillStyle = cfg.style.land;
    ctx.fillRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.rotate(view.rotation);
    const level = this.levelFor(view.mpp);
    const span = cfg.tile * cfg.levels[level];
    // Lo que se ve, en metros desde el centro: el rectángulo girado (su caja) o el círculo.
    const cos = Math.abs(Math.cos(view.rotation));
    const sin = Math.abs(Math.sin(view.rotation));
    const radius = (Math.min(width, height) / 2) * view.mpp;
    const hx = round ? radius : ((cos * width) / 2 + (sin * height) / 2) * view.mpp;
    const hz = round ? radius : ((sin * width) / 2 + (cos * height) / 2) * view.mpp;
    let missing = false;
    for (let tx = Math.floor((view.x - hx) / span); tx <= Math.floor((view.x + hx) / span); tx++) {
      for (let ty = Math.floor((view.z - hz) / span); ty <= Math.floor((view.z + hz) / span); ty++) {
        const hole = this.hole;
        hole.x0 = tx * span;
        hole.z0 = ty * span;
        hole.x1 = hole.x0 + span;
        hole.z1 = hole.z0 + span;
        if (round) {
          // Fuera del círculo: ni se dibuja ni se pide.
          const dx = Math.max(hole.x0 - view.x, 0, view.x - hole.x1);
          const dz = Math.max(hole.z0 - view.z, 0, view.z - hole.z1);
          if (dx * dx + dz * dz > radius * radius) continue;
        }
        const key = this.key(level, tx, ty);
        const tile = this.touch(key);
        if (tile) {
          used.add(key);
          this.blit(ctx, view, tile, level, tx, ty, hole);
          continue;
        }
        missing = true;
        const distance = Math.hypot((hole.x0 + span / 2 - view.x) / view.mpp, (hole.z0 + span / 2 - view.z) / view.mpp);
        const covered = this.patch(ctx, view, level, hole, used);
        this.want(key, owner, covered ? 1 : 0, distance);
      }
    }
    ctx.restore();
    // La base: los niveles más lejanos, para todo el mundo (no se dibujan: solo se tienen).
    const levels = cfg.levels;
    const e = this.extent;
    for (let base = Math.max(0, levels.length - (shape.baseLevels ?? 0)); base < levels.length; base++) {
      const baseSpan = cfg.tile * levels[base];
      for (let tx = Math.floor(e.x0 / baseSpan); tx <= Math.floor(e.x1 / baseSpan); tx++) {
        for (let ty = Math.floor(e.z0 / baseSpan); ty <= Math.floor(e.z1 / baseSpan); ty++) {
          const key = this.key(base, tx, ty);
          if (!this.tiles.has(key)) {
            missing = true;
            this.want(key, owner, 2, 0);
          }
          used.add(key);
        }
      }
    }
    this.shown.set(owner, used);
    return missing;
  }

  private want(key: string, owner: string, rank: number, distance: number): void {
    const prior = this.wanted.get(key);
    if (!prior || rank < prior.rank || (rank === prior.rank && distance < prior.distance)) this.wanted.set(key, { owner, rank, distance });
  }

  /**
   * Arma las baldosas pedidas en este cuadro durante `budgetMs` (al menos una si falta alguna):
   * primero los huecos que se ven vacíos, después los tapados por otro nivel (en cada grupo, las
   * del centro de su vista primero) y al final la base. Olvida el resto: si una vista las sigue
   * necesitando, las vuelve a pedir en el próximo. Devuelve si quedaron pendientes.
   */
  pump(budgetMs: number): boolean {
    if (!this.wanted.size) return false;
    const start = performance.now();
    const queue = [...this.wanted].sort((a, b) => a[1].rank - b[1].rank || a[1].distance - b[1].distance);
    this.wanted.clear();
    let built = 0;
    for (const [key, want] of queue) {
      if (built > 0 && performance.now() - start >= budgetMs) break;
      const [level, tx, ty] = key.split(':').map(Number);
      this.tiles.set(key, this.render(level, tx, ty));
      // Ya es de la vista que la pidió (la muestra en su próximo dibujo): no se suelta antes.
      this.shown.get(want.owner)?.add(key);
      built++;
    }
    this.trim();
    return built < queue.length;
  }

  /** Suelta las baldosas que ninguna vista muestra, las usadas hace más tiempo, hasta dejar `spareTiles`. */
  private trim(): void {
    const keep = new Set<string>();
    for (const keys of this.shown.values()) for (const key of keys) keep.add(key);
    let spare = 0;
    for (const key of this.tiles.keys()) if (!keep.has(key)) spare++;
    for (const key of this.tiles.keys()) {
      if (spare <= this.cfg.spareTiles) break;
      if (keep.has(key)) continue;
      this.tiles.delete(key);
      spare--;
    }
  }

  /**
   * Tapa el hueco de una baldosa que falta con lo que haya de los niveles vecinos: la más cercana
   * de arriba, estirada (al acercar), y encima las de abajo que estén, achicadas (al alejar).
   * Devuelve si tapó algo.
   */
  private patch(ctx: CanvasRenderingContext2D, view: MapView, level: number, hole: Box, used: Set<string>): boolean {
    let covered = false;
    const levels = this.cfg.levels;
    const cx = (hole.x0 + hole.x1) / 2;
    const cz = (hole.z0 + hole.z1) / 2;
    for (let up = level + 1; up < levels.length; up++) {
      const upSpan = this.cfg.tile * levels[up];
      const tx = Math.floor(cx / upSpan);
      const ty = Math.floor(cz / upSpan);
      const key = this.key(up, tx, ty);
      const tile = this.touch(key);
      if (!tile) continue;
      used.add(key);
      this.blit(ctx, view, tile, up, tx, ty, hole);
      covered = true;
      break;
    }
    if (level === 0) return covered;
    const span = this.cfg.tile * levels[level - 1];
    for (let tx = Math.round(hole.x0 / span); tx < Math.round(hole.x1 / span); tx++) {
      for (let ty = Math.round(hole.z0 / span); ty < Math.round(hole.z1 / span); ty++) {
        const key = this.key(level - 1, tx, ty);
        const tile = this.touch(key);
        if (!tile) continue;
        used.add(key);
        this.blit(ctx, view, tile, level - 1, tx, ty, hole);
        covered = true;
      }
    }
    return covered;
  }

  /** Copia la parte de la baldosa (level, tx, ty) que cae dentro de `clip` (m) a su lugar en la vista. */
  private blit(ctx: CanvasRenderingContext2D, view: MapView, tile: HTMLCanvasElement, level: number, tx: number, ty: number, clip: Box): void {
    const span = this.cfg.tile * this.cfg.levels[level];
    const x0 = Math.max(tx * span, clip.x0);
    const z0 = Math.max(ty * span, clip.z0);
    const x1 = Math.min((tx + 1) * span, clip.x1);
    const z1 = Math.min((ty + 1) * span, clip.z1);
    if (x1 <= x0 || z1 <= z0) return;
    const k = tile.width / span;
    // Medio píxel más por lado: sin él se ven las uniones entre baldosas.
    const seam = 0.6;
    ctx.drawImage(
      tile,
      (x0 - tx * span) * k,
      (z0 - ty * span) * k,
      (x1 - x0) * k,
      (z1 - z0) * k,
      (x0 - view.x) / view.mpp,
      (z0 - view.z) / view.mpp,
      (x1 - x0) / view.mpp + seam,
      (z1 - z0) / view.mpp + seam,
    );
  }

  /** El nivel más fino cuyos metros por píxel no pasan los de la vista (se dibuja achicado, nítido). */
  private levelFor(mpp: number): number {
    const levels = this.cfg.levels;
    let level = 0;
    while (level < levels.length - 1 && levels[level + 1] <= mpp) level++;
    return level;
  }

  private key(level: number, tx: number, ty: number): string {
    return `${level}:${tx}:${ty}`;
  }

  /** La baldosa ya armada (null si no está), marcada como recién usada: al final de la lista. */
  private touch(key: string): HTMLCanvasElement | null {
    const tile = this.tiles.get(key);
    if (!tile) return null;
    this.tiles.delete(key);
    this.tiles.set(key, tile);
    return tile;
  }

  private shapes(polygons: number[][][]): Grid<Shape> {
    const items: Shape[] = [];
    for (const poly of polygons) {
      const rings = poly.filter((ring) => ring.length >= 6).map((ring) => Float32Array.from(ring));
      if (rings.length) items.push({ rings, ...boxOf(rings) });
    }
    return new Grid(items, this.cfg.cell);
  }

  private render(level: number, tx: number, ty: number): HTMLCanvasElement {
    const cfg = this.cfg;
    const style = cfg.style;
    const mpp = cfg.levels[level];
    const span = cfg.tile * mpp;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.round(cfg.tile * this.dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('El navegador no permite dibujar el mapa (canvas 2D)');
    ctx.fillStyle = style.land;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Metros del mundo → píxeles de la baldosa; lo que asoma por el borde se dibuja igual (margen).
    const k = this.dpr / mpp;
    const x0 = tx * span;
    const z0 = ty * span;
    ctx.setTransform(k, 0, 0, k, -x0 * k, -z0 * k);
    const pad = cfg.tileMarginPx * mpp;
    const box: Box = { x0: x0 - pad, z0: z0 - pad, x1: x0 + span + pad, z1: z0 + span + pad };
    this.fill(ctx, this.parks, style.park, box);
    this.fill(ctx, this.water, style.water, box);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const shown = this.styles.map((s) => mpp <= (s.maxMpp ?? Infinity));
    const width = (s: RoadStyle): number => Math.max(s.minPx, s.meters / mpp) * mpp;
    // Primero el borde de todas y después el relleno: los cruces quedan limpios.
    this.styles.forEach((s, g) => {
      if (shown[g]) this.stroke(ctx, this.roads[g], box, style.casing, width(s) + s.casingPx * mpp);
    });
    this.styles.forEach((s, g) => {
      if (!shown[g]) return;
      ctx.globalAlpha = s.fadeFromMpp !== undefined && mpp > s.fadeFromMpp ? (s.fadeAlpha ?? 1) : 1;
      this.stroke(ctx, this.roads[g], box, s.color, width(s));
    });
    ctx.globalAlpha = 1;
    // Puentes encima, con un borde más marcado (se ven pasar sobre el agua y las otras calles).
    this.styles.forEach((s, g) => {
      if (!shown[g]) return;
      this.stroke(ctx, this.bridges[g], box, style.casing, width(s) + style.bridgeCasingPx * mpp);
      this.stroke(ctx, this.bridges[g], box, s.color, width(s));
    });

    const air = style.aerovia;
    ctx.setLineDash(air.dashPx.map((v) => v * mpp));
    ctx.strokeStyle = air.color;
    ctx.lineWidth = air.widthPx * mpp;
    for (const line of this.aerovia) {
      ctx.beginPath();
      ctx.moveTo(line[0], line[1]);
      for (let i = 2; i < line.length; i += 2) ctx.lineTo(line[i], line[i + 1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    return canvas;
  }

  private fill(ctx: CanvasRenderingContext2D, grid: Grid<Shape> | null, color: string, box: Box): void {
    if (!grid) return;
    ctx.fillStyle = color;
    // Uno por uno: juntos en un solo trazo, los que se solapan se restarían (par-impar).
    grid.each(box.x0, box.z0, box.x1, box.z1, (shape) => {
      ctx.beginPath();
      for (const ring of shape.rings) {
        ctx.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
        ctx.closePath();
      }
      ctx.fill('evenodd');
    });
  }

  private stroke(ctx: CanvasRenderingContext2D, grid: Grid<Line> | undefined, box: Box, color: string, width: number): void {
    if (!grid) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    grid.each(box.x0, box.z0, box.x1, box.z1, (line) => {
      const p = line.points;
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    });
    ctx.stroke();
  }
}
