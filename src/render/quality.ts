import type * as THREE from 'three';
import type { GameConfig } from '../core/types';
import type { GpuTimer } from './gpuTimer';

type QualityConfig = GameConfig['quality'];
interface Level {
  pixelRatio: number;
  shadowMapSize: number;
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Promedio sin los extremos: ignora los picos sueltos de carga y, a diferencia de la mediana,
 * no se confunde con el ritmo alternado de 60 fps en pantallas de 144 Hz (13,9 / 20,8 ms).
 */
const trimmedMean = (values: number[], trim: number): number => {
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  const kept = s.slice(cut, s.length - cut);
  return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : 0;
};

/**
 * Calidad adaptativa: si el equipo no llega a `targetFps` porque la GPU no da abasto, baja
 * la resolución interna por escalones (y al final el mapa de sombras); cuando sobra margen,
 * la vuelve a subir. En un equipo que llega holgado no cambia nada.
 *
 * - Decide con el promedio recortado de ventanas de `windowSeconds` (los picos sueltos de carga
 *   no cuentan).
 * - Con el tiempo real de GPU distingue si el cuello es la GPU (bajar resolución sirve) o el
 *   procesador (no sirve: no toca nada), y predice si el escalón de arriba cabe antes de subir.
 * - Sin medidor de GPU (Safari, Firefox) sube "a prueba" tras un rato estable.
 * - Si al subir tiene que volver a bajar enseguida, se queda en el escalón estable.
 */
export class AdaptiveQuality {
  private levels: Level[] = [];
  private level = 0;
  /** Escalón más alto permitido (sube cuando se detecta que el de arriba no se sostiene). */
  private best = 0;
  private readonly frames: number[] = [];
  private readonly gpu: number[] = [];
  private windowStart = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private windowsSinceChange = 0;
  private lastWasIncline = false;
  private cap = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly sun: { shadow: THREE.LightShadow },
    private readonly cfg: QualityConfig,
    private readonly maxPixelRatio: number,
    timer: GpuTimer | null,
  ) {
    timer?.onSample((ms) => this.gpu.push(ms));
    this.rebuild();
    this.apply();
  }

  /** Escalones posibles en esta pantalla (la resolución nunca pasa del devicePixelRatio). */
  private rebuild(): void {
    this.cap = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const levels: Level[] = [];
    for (const l of this.cfg.levels) {
      const level = { pixelRatio: Math.min(l.pixelRatio, this.cap), shadowMapSize: l.shadowMapSize };
      const prev = levels[levels.length - 1];
      if (!prev || prev.pixelRatio !== level.pixelRatio || prev.shadowMapSize !== level.shadowMapSize) levels.push(level);
    }
    this.levels = levels;
    this.level = Math.min(this.level, levels.length - 1);
    this.best = Math.min(this.best, this.level);
  }

  private apply(): void {
    const l = this.levels[this.level];
    if (this.renderer.getPixelRatio() !== l.pixelRatio) this.renderer.setPixelRatio(l.pixelRatio);
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== l.shadowMapSize) {
      shadow.mapSize.set(l.shadowMapSize, l.shadowMapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
  }

  get current(): Level & { index: number; levels: number } {
    return { ...this.levels[this.level], index: this.level, levels: this.levels.length };
  }

  /** Llamar una vez por frame con el tiempo de ese frame (ms). */
  update(now: number, frameMs: number): void {
    if (!this.cfg.adaptive) return;
    // Pestaña oculta o una pausa larga: no es falta de rendimiento.
    if (frameMs < this.cfg.maxFrameMs) this.frames.push(frameMs);
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < this.cfg.windowSeconds * 1000) return;
    this.evaluate();
    this.windowStart = now;
    this.frames.length = 0;
    this.gpu.length = 0;
  }

  private evaluate(): void {
    const c = this.cfg;
    // La ventana pasó a otra pantalla con otra densidad de píxeles.
    if (Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) !== this.cap) {
      this.rebuild();
      this.apply();
    }
    this.windowsSinceChange++;
    if (this.frames.length < c.minFramesPerWindow) return;
    const budget = 1000 / c.targetFps;
    const frame = trimmedMean(this.frames, c.frameTrim);
    const gpu = this.gpu.length ? median(this.gpu) : null;
    const slow = frame > budget * c.declineAbove;
    // Con medidor: solo es culpa de la GPU si ella se come la mayor parte del presupuesto.
    const gpuBound = gpu === null || gpu > budget * c.gpuBoundShare;

    if (slow && gpuBound && this.level < this.levels.length - 1) {
      this.fastWindows = 0;
      if (++this.slowWindows >= c.declineWindows) this.change(+1);
      return;
    }
    this.slowWindows = 0;
    if (slow || this.level <= this.best) {
      this.fastWindows = 0;
      return;
    }
    let roomy: boolean;
    if (gpu !== null) {
      // Lo que costaría el escalón de arriba: el trabajo por píxel escala con el área.
      const up = this.levels[this.level - 1];
      const scale = (up.pixelRatio / this.levels[this.level].pixelRatio) ** 2;
      roomy = gpu * scale < budget * c.inclineBelow;
    } else {
      roomy = frame <= budget * c.vsyncTolerance;
    }
    const needed = gpu !== null ? c.inclineWindows : c.probeWindows;
    this.fastWindows = roomy ? this.fastWindows + 1 : 0;
    if (this.fastWindows >= needed) this.change(-1);
  }

  private change(step: 1 | -1): void {
    // Bajar justo después de haber subido = el escalón de arriba no se sostiene: ese es el techo.
    if (step > 0 && this.lastWasIncline && this.windowsSinceChange <= this.cfg.settleWindows) this.best = this.level + 1;
    this.level += step;
    this.lastWasIncline = step < 0;
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.windowsSinceChange = 0;
    this.apply();
    if (import.meta.env.DEV) {
      const l = this.levels[this.level];
      console.info(`[calidad] resolución ×${l.pixelRatio} · sombras ${l.shadowMapSize}`);
    }
  }
}
