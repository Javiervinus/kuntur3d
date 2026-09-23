import type { GameConfig } from '../core/types';
import { type MapLayers, type MapView, toView } from './mapLayers';

type MinimapConfig = GameConfig['minimap'];

/** Un lugar en los mapas: con ficha (rombo) o del panel (punto). */
export interface MapPlace {
  x: number;
  z: number;
  name: string;
  ficha: boolean;
}

/** Lo que el minimapa necesita del jugador en cada cuadro. */
export interface MinimapSubject {
  x: number;
  z: number;
  /** Hacia dónde mira el personaje (o el carro) y la cámara (rad, 0 = norte). */
  facing: number;
  cameraYaw: number;
  /** m/s: con más velocidad se ve más lejos. */
  speed: number;
}

/** Rombo de un lugar con ficha (el del marcador sobre el mundo). */
export function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, p: MinimapConfig['places']): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = p.fill;
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = p.lineWidth;
  ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
  ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
  ctx.restore();
}

/** Punto de un lugar del panel sin ficha. */
export function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, p: MinimapConfig['places']): void {
  ctx.fillStyle = p.dot;
  ctx.beginPath();
  ctx.arc(x, y, p.dotRadius, 0, Math.PI * 2);
  ctx.fill();
}

/** Flecha del jugador girada `angle` (rad, 0 = arriba) y, si `cone`, el cono de la cámara hacia `coneAngle`. */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  coneAngle: number | null,
  p: MinimapConfig['player'],
): void {
  if (coneAngle !== null) {
    const c = p.cone;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(coneAngle);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, c.radius);
    glow.addColorStop(0, `rgba(255, 255, 255, ${c.alpha})`);
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, c.radius, -Math.PI / 2 - c.halfAngle, -Math.PI / 2 + c.halfAngle);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = p.fill;
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = p.lineWidth;
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(7, 7);
  ctx.lineTo(0, 3);
  ctx.lineTo(-7, 7);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

/** Alfiler del destino de la última búsqueda, con la punta en (x, y). */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, d: MinimapConfig['destination']): void {
  ctx.fillStyle = d.fill;
  ctx.strokeStyle = d.stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y - 9, 6, Math.PI * 0.8, Math.PI * 2.2);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = d.stroke;
  ctx.beginPath();
  ctx.arc(x, y - 9, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Minimapa redondo arriba a la derecha: el mapa dibujado (mapLayers.ts) centrado en el jugador
 * y girado con la cámara, así lo que se tiene enfrente queda siempre arriba (como en GTA); una N
 * en el borde marca el norte. Con velocidad (manejando, planeando) se aleja solo, hasta
 * `speedZoom.maxFactor` veces a `speedZoom.fullSpeed` m/s. Los lugares van como rombos (con
 * ficha) o puntos; el destino de la última búsqueda, si queda fuera, se pega al borde. Un clic
 * abre el mapa grande.
 */
export class Minimap {
  /** Nombre de esta vista para las capas del mapa. */
  private static readonly id = 'minimap';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly north: HTMLElement;
  private places: MapPlace[] = [];
  private destination: { x: number; z: number } | null = null;
  /** Alejamiento por la velocidad (1 = quieto), suavizado. */
  private zoom = 1;
  private readonly view: MapView = { x: 0, z: 0, mpp: 1, rotation: 0 };
  private readonly point: number[] = [0, 0];

  constructor(
    root: HTMLElement,
    private readonly layers: MapLayers,
    private readonly cfg: MinimapConfig,
    onOpenMap: () => void,
  ) {
    const canvas = root.querySelector('canvas');
    const ctx = canvas?.getContext('2d');
    const north = root.querySelector<HTMLElement>('[data-north]');
    if (!canvas || !ctx || !north) throw new Error('Falta el canvas o la N del minimapa en index.html');
    this.canvas = canvas;
    this.ctx = ctx;
    this.north = north;
    root.querySelector('[data-open-map]')?.addEventListener('click', onOpenMap);
  }

  setPlaces(places: MapPlace[]): void {
    this.places = places;
  }

  setDestination(point: { x: number; z: number } | null): void {
    this.destination = point;
  }

  update(dt: number, s: MinimapSubject): void {
    const canvas = this.canvas;
    const size = canvas.clientWidth;
    if (!size) return;
    const dpr = this.layers.pixelRatio;
    if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
    const sz = this.cfg.speedZoom;
    const target = 1 + (sz.maxFactor - 1) * Math.min(1, s.speed / sz.fullSpeed);
    this.zoom += (target - this.zoom) * Math.min(1, dt * sz.rate);
    const view = this.view;
    view.x = s.x;
    view.z = s.z;
    view.mpp = this.cfg.metersPerPixel * this.zoom;
    // La cámara mira "arriba": el mapa gira lo mismo que ella.
    view.rotation = s.cameraYaw;

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layers.draw(ctx, size, size, view, Minimap.id, { round: true });
    const radius = size / 2;
    const p = this.cfg.places;
    for (const place of this.places) {
      const [x, y] = toView(place.x, place.z, size, size, view, this.point);
      if (Math.hypot(x - radius, y - radius) > radius - p.size) continue;
      if (place.ficha) drawDiamond(ctx, x, y, p);
      else drawDot(ctx, x, y, p);
    }
    if (this.destination) {
      const d = this.cfg.destination;
      let [x, y] = toView(this.destination.x, this.destination.z, size, size, view, this.point);
      const off = Math.hypot(x - radius, y - radius);
      const max = radius - d.margin;
      if (off > max) {
        x = radius + ((x - radius) / off) * max;
        y = radius + ((y - radius) / off) * max;
      }
      drawPin(ctx, x, y, d);
    }
    // La flecha, girada lo que el personaje difiere de la cámara; el cono de la cámara, hacia arriba.
    drawPlayer(ctx, radius, radius, s.cameraYaw - s.facing, 0, this.cfg.player);
    // N en el borde: el norte (arriba sin giro) girado con el mapa.
    this.north.style.transform = `translate(${(radius + Math.sin(view.rotation) * radius).toFixed(1)}px, ${(radius - Math.cos(view.rotation) * radius).toFixed(1)}px)`;
  }
}
