import type { GameConfig } from '../core/types';

type FrameCapConfig = GameConfig['render']['frameCap'];

/**
 * Tope de fps sin tirones. El navegador llama a requestAnimationFrame en cada refresco de la
 * pantalla (60, 120, 144 Hz…); este limitador decide en cuáles se dibuja.
 *
 * - Mide el refresco real (mediana de los intervalos entre llamadas: saltarse un frame no
 *   cuesta nada, así que siguen llegando a ritmo de pantalla).
 * - Si la pantalla ya va al tope o menos no salta nada. Forzar el tope exacto en un monitor
 *   de 60,02 Hz descartaría un frame cada tantos segundos, y eso se ve como un tirón.
 * - Si va más rápido, dibuja el refresco más cercano a cada instante ideal (fase fija de
 *   1/maxFps): en 120 Hz uno sí y uno no; en 144 Hz alterna 2 y 3 refrescos, con promedio
 *   exacto y sin deriva.
 */
export class FrameLimiter {
  private readonly interval: number;
  private readonly deltas: Float64Array;
  private readonly sorted: Float64Array;
  private count = 0;
  private last = -1;
  private next = 0;
  /** Duración estimada de un refresco de la pantalla (ms); 0 hasta tener muestras. */
  private vsync = 0;

  constructor(private readonly cfg: FrameCapConfig) {
    this.interval = cfg.maxFps > 0 ? 1000 / cfg.maxFps : 0;
    this.deltas = new Float64Array(cfg.refreshSamples);
    this.sorted = new Float64Array(cfg.refreshSamples);
  }

  /** Refresco medido de la pantalla (Hz), o null si todavía no hay suficientes muestras. */
  get refreshRate(): number | null {
    return this.vsync ? 1000 / this.vsync : null;
  }

  /** Llamar en cada callback de requestAnimationFrame; `true` si este refresco se dibuja. */
  accept(timestamp: number): boolean {
    if (this.last >= 0) this.sample(timestamp - this.last);
    this.last = timestamp;
    if (!this.interval) return true;
    if (!this.vsync || this.vsync >= this.interval * (1 - this.cfg.nativeTolerance)) {
      this.next = timestamp + this.interval;
      return true;
    }
    if (timestamp < this.next - this.vsync / 2) return false;
    // Si se perdió el refresco que tocaba (frame pesado, pestaña que vuelve), el ritmo se retoma
    // desde aquí: "ponerse al día" dibujando el siguiente a medio intervalo sería un segundo
    // salto visible y más presión sobre una GPU que ya va justa. El umbral queda por encima de
    // medio refresco para no confundir con atraso el empate natural (90 Hz → 1,5 refrescos).
    const late = timestamp - this.next > this.vsync * this.cfg.lateVsyncShare;
    this.next = (late ? timestamp : this.next) + this.interval;
    return true;
  }

  private sample(delta: number): void {
    const n = this.deltas.length;
    this.deltas[this.count % n] = delta;
    if (++this.count % n) return;
    this.sorted.set(this.deltas);
    this.sorted.sort();
    this.vsync = this.sorted[n >> 1];
  }
}
