import type { GameConfig } from '../core/types';
import { type MapLayers, type MapView, toView } from './mapLayers';
import { drawDiamond, drawDot, drawPin, drawPlayer } from './minimap';
import { type DirectoryEntry, formatDistance, type PlaceCategory, type ZoneLabel } from './places';

type MapConfig = GameConfig['map'];
type MinimapConfig = GameConfig['minimap'];

/** El jugador en el mapa grande. */
export interface BigMapPlayer {
  x: number;
  z: number;
  facing: number;
  cameraYaw: number;
}

export interface BigMapHandlers {
  /** Ir a un lugar (a su punto de llegada). */
  goTo(entry: DirectoryEntry): void;
  /** Teletransportarse a un punto cualquiera del mapa. */
  teleport(x: number, z: number): void;
  close(): void;
  /** Latitud y longitud de un punto (para mostrarlas). */
  toLatLon(x: number, z: number): { lat: number; lon: number };
}

/** Un lugar dibujado en este cuadro (para saber cuál se tocó). */
interface Hit {
  entry: DirectoryEntry;
  x: number;
  y: number;
}

/** ¿La caja [x0, y0, x1, y1] se monta sobre alguna de las ya puestas? */
function overlaps(box: number[], taken: number[][]): boolean {
  return taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1]);
}

/**
 * Mapa grande (tecla M o clic en el minimapa): toda la ciudad dibujada con el norte arriba. Se
 * arrastra para moverse, la rueda acerca hacia el cursor, "Centrar en mí" vuelve al jugador y
 * los nombres de barrios, parroquias y cantones aparecen cada uno a su escala. Tocar un lugar
 * muestra su ficha corta con "Ir aquí"; tocar cualquier otro punto, "Teletransportarme aquí".
 * Arrastrar nunca cuenta como toque. Se dibuja solo cuando algo cambia.
 */
export class BigMap {
  /** Nombre de esta vista para las capas del mapa (sus baldosas no se sueltan mientras está abierto). */
  private static readonly id = 'bigmap';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly viewBox: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly scale: HTMLElement;
  private readonly view: MapView;
  private entries: DirectoryEntry[] = [];
  private readonly categories = new Map<string, string>();
  private zones: ZoneLabel[] = [];
  private destination: { x: number; z: number } | null = null;
  private player: BigMapPlayer = { x: 0, z: 0, facing: 0, cameraYaw: 0 };
  private width = 0;
  private height = 0;
  private dirty = true;
  private open = false;
  private drag: { x: number; y: number; vx: number; vz: number; moved: number } | null = null;
  /** Dedos sobre el mapa (con dos se acerca o aleja pellizcando). */
  private readonly fingers = new Map<number, [number, number]>();
  private pinch = 0;
  private hits: Hit[] = [];
  private readonly point: number[] = [0, 0];
  private readonly labelWidths = new Map<string, number>();

  constructor(
    private readonly root: HTMLElement,
    private readonly layers: MapLayers,
    private readonly cfg: MapConfig,
    private readonly markers: MinimapConfig,
    private readonly handlers: BigMapHandlers,
  ) {
    const canvas = root.querySelector('canvas');
    const ctx = canvas?.getContext('2d');
    const viewBox = root.querySelector<HTMLElement>('[data-view]');
    const pop = root.querySelector<HTMLElement>('[data-pop]');
    const scale = root.querySelector<HTMLElement>('[data-scale]');
    if (!canvas || !ctx || !viewBox || !pop || !scale) throw new Error('Falta el mapa grande en index.html (#bigmap)');
    this.canvas = canvas;
    this.ctx = ctx;
    this.viewBox = viewBox;
    this.pop = pop;
    this.scale = scale;
    this.view = { x: 0, z: 0, mpp: cfg.big.defaultMpp, rotation: 0 };

    const b = cfg.big;
    root.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => this.zoomAt(1 / b.buttonZoom, this.width / 2, this.height / 2));
    root.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => this.zoomAt(b.buttonZoom, this.width / 2, this.height / 2));
    root.querySelector('[data-action="center"]')?.addEventListener('click', () => this.center());
    root.querySelector('[data-action="close"]')?.addEventListener('click', () => handlers.close());
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', () => this.endDrag());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    new ResizeObserver(() => this.resize()).observe(viewBox);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Abre el mapa centrado en el jugador. */
  show(player: BigMapPlayer): void {
    this.open = true;
    this.root.hidden = false;
    this.player = { ...player };
    this.view.x = player.x;
    this.view.z = player.z;
    this.pop.hidden = true;
    this.resize();
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.pop.hidden = true;
    this.endDrag();
    // Sus baldosas ya no hacen falta (quedan las de repuesto y las del minimapa).
    this.layers.release(BigMap.id);
  }

  setPlaces(categories: PlaceCategory[], entries: DirectoryEntry[]): void {
    this.categories.clear();
    for (const c of categories) this.categories.set(c.id, c.label);
    this.entries = entries;
    this.dirty = true;
  }

  setZones(labels: ZoneLabel[]): void {
    this.zones = labels;
    this.dirty = true;
  }

  setDestination(point: { x: number; z: number } | null): void {
    this.destination = point;
    this.dirty = true;
  }

  /** Redibuja si algo cambió o faltaban baldosas. */
  update(): void {
    if (!this.open || !this.dirty || !this.width) return;
    this.dirty = this.draw();
  }

  private resize(): void {
    const w = this.viewBox.clientWidth;
    const h = this.viewBox.clientHeight;
    if (!w || !h) return;
    const dpr = this.layers.pixelRatio;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dirty = true;
  }

  /** Devuelve true si faltaron baldosas (hay que volver a dibujar cuando estén). */
  private draw(): boolean {
    const { ctx, width: W, height: H, view } = this;
    const dpr = this.layers.pixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const missing = this.layers.draw(ctx, W, H, view, BigMap.id, { baseLevels: this.cfg.big.baseLevels });
    this.hits = [];
    const names: { text: string; x: number; y: number; rank: number; center: number }[] = [];
    for (const entry of this.entries) {
      const [x, y] = toView(entry.x, entry.z, W, H, view, this.point);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      this.hits.push({ entry, x, y });
      // El nombre, solo si el marcador se ve (si no, saldría cortado en el borde).
      if (x < 0 || y < 0 || x > W || y > H) continue;
      names.push({ text: entry.name, x, y, rank: entry.ficha ? 0 : 1, center: Math.hypot(x - W / 2, y - H / 2) });
    }
    // Nombres de lugares: primero los que tienen ficha y, en cada grupo, los más cercanos al
    // centro; a la derecha del marcador (a la izquierda si se saldría del mapa), y el que se
    // montaría sobre otro ya puesto no se escribe.
    const lc = this.cfg.style.labels;
    ctx.font = lc.font;
    names.sort((a, b) => a.rank - b.rank || a.center - b.center);
    const taken: number[][] = [];
    const placed: { text: string; x: number; y: number }[] = [];
    for (const n of names) {
      const w = this.measure(n.text, lc.font);
      const right = n.x + 10 + w <= W - 4;
      const box = right ? [n.x + 6, n.y - 8, n.x + 10 + w, n.y + 6] : [n.x - 10 - w, n.y - 8, n.x - 6, n.y + 6];
      if (overlaps(box, taken)) continue;
      taken.push(box);
      placed.push({ text: n.text, x: right ? n.x + 8 : n.x - 8 - w, y: n.y + 4 });
    }
    // Debajo, los nombres de zonas que no choquen con esos (ni entre sí).
    this.drawZones(taken);
    for (const hit of this.hits) {
      if (hit.entry.ficha) drawDiamond(ctx, hit.x, hit.y, this.markers.places);
      else drawDot(ctx, hit.x, hit.y, this.markers.places);
    }
    ctx.font = lc.font;
    ctx.lineJoin = 'round';
    ctx.lineWidth = lc.haloPx;
    ctx.strokeStyle = lc.halo;
    ctx.fillStyle = lc.color;
    for (const label of placed) {
      ctx.strokeText(label.text, label.x, label.y);
      ctx.fillText(label.text, label.x, label.y);
    }
    if (this.destination) {
      const [x, y] = toView(this.destination.x, this.destination.z, W, H, view, this.point);
      drawPin(ctx, x, y, this.markers.destination);
    }
    const p = this.player;
    const [px, py] = toView(p.x, p.z, W, H, view, this.point);
    drawPlayer(ctx, px, py, -p.facing, -p.cameraYaw, this.markers.player);
    const meters = this.cfg.big.scaleBarPx * view.mpp;
    this.scale.textContent = `${this.cfg.big.scaleBarPx} px ≈ ${formatDistance(meters)}`;
    return missing;
  }

  /**
   * Nombres de barrios, parroquias y cantones, cada tipo en su rango de escala; primero las zonas
   * más grandes, y solo donde no chocan con `taken` (los nombres de lugares) ni entre sí.
   */
  private drawZones(taken: number[][]): void {
    const { ctx, width: W, height: H, view } = this;
    const lc = this.cfg.style.labels;
    const ranges: Record<string, number[]> = this.cfg.big.zoneLabels;
    ctx.save();
    ctx.font = lc.zoneFont;
    ctx.letterSpacing = `${lc.zoneLetterSpacingPx}px`;
    ctx.fillStyle = lc.zoneColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const visible = this.zones
      .filter((zone) => {
        const range = ranges[zone.kind];
        return range !== undefined && view.mpp >= range[0] && view.mpp <= range[1];
      })
      .sort((a, b) => b.area - a.area);
    for (const zone of visible) {
      const [x, y] = toView(zone.x, zone.z, W, H, view, this.point);
      if (x < -100 || y < -20 || x > W + 100 || y > H + 20) continue;
      const text = zone.name.toUpperCase();
      const half = this.measure(text, `${lc.zoneFont}|${lc.zoneLetterSpacingPx}`) / 2;
      const box = [x - half - 4, y - 8, x + half + 4, y + 8];
      if (overlaps(box, taken)) continue;
      taken.push(box);
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  /** Ancho del texto con la fuente puesta ahora en el canvas (`key` distingue fuentes y espaciados). */
  private measure(text: string, key: string): number {
    const id = `${key}|${text}`;
    let w = this.labelWidths.get(id);
    if (w === undefined) {
      w = this.ctx.measureText(text).width;
      this.labelWidths.set(id, w);
    }
    return w;
  }

  private center(): void {
    this.view.x = this.player.x;
    this.view.z = this.player.z;
    this.pop.hidden = true;
    this.dirty = true;
  }

  /** Acerca o aleja `factor` veces dejando quieto el punto bajo (sx, sy). */
  private zoomAt(factor: number, sx: number, sy: number): void {
    const b = this.cfg.big;
    const v = this.view;
    const wx = v.x + (sx - this.width / 2) * v.mpp;
    const wz = v.z + (sy - this.height / 2) * v.mpp;
    v.mpp = Math.min(b.maxMpp, Math.max(b.minMpp, v.mpp * factor));
    v.x = wx - (sx - this.width / 2) * v.mpp;
    v.z = wz - (sy - this.height / 2) * v.mpp;
    this.pop.hidden = true;
    this.dirty = true;
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private readonly onDown = (e: PointerEvent): void => {
    // Solo el botón principal (o el dedo): el derecho abre el menú del navegador, que se come el
    // pointerup y dejaba el mapa pegado al mouse.
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch') {
      this.fingers.set(e.pointerId, [x, y]);
      if (this.fingers.size === 2) {
        // El segundo dedo empieza a pellizcar: ya no es arrastre ni toque.
        this.pinch = this.spread();
        this.canvas.setPointerCapture(e.pointerId);
        if (this.drag) this.drag.moved = Infinity;
        return;
      }
    }
    this.drag = { x, y, vx: this.view.x, vz: this.view.z, moved: 0 };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.classList.add('dragging');
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.fingers.has(e.pointerId)) {
      this.fingers.set(e.pointerId, this.local(e));
      if (this.fingers.size === 2) {
        const spread = this.spread();
        const [[ax, ay], [bx, by]] = [...this.fingers.values()];
        if (this.pinch > 0 && spread > 0) this.zoomAt(this.pinch / spread, (ax + bx) / 2, (ay + by) / 2);
        this.pinch = spread;
        return;
      }
    }
    const d = this.drag;
    if (!d) return;
    // El botón se soltó sin que llegara el pointerup (p. ej. fuera de la ventana): se termina el arrastre.
    if ((e.buttons & 1) === 0) {
      this.endDrag();
      return;
    }
    const [x, y] = this.local(e);
    d.moved = Math.max(d.moved, Math.hypot(x - d.x, y - d.y));
    if (d.moved <= this.cfg.big.dragThreshold) return;
    this.view.x = d.vx - (x - d.x) * this.view.mpp;
    this.view.z = d.vz - (y - d.y) * this.view.mpp;
    this.pop.hidden = true;
    this.dirty = true;
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.fingers.delete(e.pointerId);
    if (this.fingers.size > 0) {
      // Queda un dedo tras pellizcar: no arrastra desde donde empezó ni cuenta como toque.
      this.pinch = 0;
      this.drag = null;
      return;
    }
    const d = this.drag;
    this.endDrag();
    if (!d || d.moved > this.cfg.big.dragThreshold) return;
    const [x, y] = this.local(e);
    let best: Hit | null = null;
    let bestD = this.cfg.big.hitRadius;
    for (const hit of this.hits) {
      const dist = Math.hypot(hit.x - x, hit.y - y);
      if (dist <= bestD) {
        best = hit;
        bestD = dist;
      }
    }
    if (best) this.showPlace(best);
    else this.showPoint(x, y);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [x, y] = this.local(e);
    this.zoomAt(Math.pow(this.cfg.big.wheelZoom, e.deltaY), x, y);
  };

  private spread(): number {
    const [a, b] = [...this.fingers.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }

  private endDrag(): void {
    this.fingers.clear();
    this.pinch = 0;
    this.drag = null;
    this.canvas.classList.remove('dragging');
  }

  private popup(x: number, y: number, kicker: string, title: string, meta: string, action: string, onAction: () => void): void {
    const pop = this.pop;
    const small = document.createElement('small');
    small.textContent = kicker;
    const strong = document.createElement('strong');
    strong.textContent = title;
    const info = document.createElement('span');
    info.textContent = meta;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action;
    button.addEventListener('click', onAction);
    pop.replaceChildren(small, strong, info, button);
    pop.hidden = false;
    // Dentro del mapa aunque el punto esté cerca del borde.
    const half = pop.offsetWidth / 2;
    pop.style.left = `${Math.min(Math.max(x, half + 8), this.width - half - 8)}px`;
    pop.style.top = `${Math.max(y, pop.offsetHeight + 16)}px`;
  }

  private showPlace(hit: Hit): void {
    const e = hit.entry;
    const away = formatDistance(Math.hypot(e.x - this.player.x, e.z - this.player.z));
    const kicker = this.categories.get(e.category) ?? '';
    const meta = [e.kicker, `a ${away}`].filter(Boolean).join(' · ');
    this.popup(hit.x, hit.y, kicker, e.name, meta, 'IR AQUÍ', () => this.handlers.goTo(e));
  }

  private showPoint(sx: number, sy: number): void {
    const v = this.view;
    const wx = v.x + (sx - this.width / 2) * v.mpp;
    const wz = v.z + (sy - this.height / 2) * v.mpp;
    const ll = this.handlers.toLatLon(wx, wz);
    const away = formatDistance(Math.hypot(wx - this.player.x, wz - this.player.z));
    this.popup(sx, sy, 'PUNTO DEL MAPA', `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`, `a ${away} de ti`, 'TELETRANSPORTARME AQUÍ', () =>
      this.handlers.teleport(wx, wz),
    );
  }
}
