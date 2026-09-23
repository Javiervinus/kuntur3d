import { getTimes } from 'suncalc';
import type { GameConfig } from '../core/types';
import { type Celestial, celestialAt } from './celestial';

type TimeOfDayConfig = GameConfig['render']['timeOfDay'];
export type DayPreset = TimeOfDayConfig['presets'][number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** "HH:MM" → horas decimales. */
function parseClock(text: string): number {
  const [h, m] = text.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error(`Hora mal escrita en config/game.json: "${text}"`);
  return h + m / 60;
}

/**
 * Reloj del mundo: la hora elegida (mañana, mediodía, tarde, noche…) como un instante real,
 * con el sol y la luna donde de verdad están ese día sobre la ciudad. Cambiar de hora es un
 * pequeño time-lapse que siempre avanza (de la noche a la mañana se pasa por la madrugada),
 * así la luna sigue su fase sin saltos. La elección se recuerda en el navegador.
 */
export class TimeOfDay {
  readonly presets: DayPreset[];
  private preset: DayPreset;
  /** Instante mostrado (ms desde 1970, UTC). */
  private now: number;
  private from = 0;
  private to = 0;
  /** Avance del time-lapse en curso (0…1); 1 = quieto. */
  private progress = 1;
  private eased = 1;
  readonly celestial: Celestial;
  /** Sol y luna a la hora de destino del time-lapse (o la actual si no hay). */
  readonly target: Celestial;
  private readonly listeners = new Set<(preset: DayPreset) => void>();

  constructor(
    private readonly cfg: TimeOfDayConfig,
    private readonly lat: number,
    private readonly lon: number,
  ) {
    this.presets = cfg.presets;
    if (!this.presets.length) throw new Error('config/game.json → render.timeOfDay.presets está vacío');
    this.preset = this.byId(this.load()) ?? this.byId(cfg.default) ?? this.presets[0];
    this.now = this.dayStart() + parseClock(this.preset.time) * HOUR_MS;
    this.to = this.now;
    this.celestial = celestialAt(new Date(this.now), lat, lon);
    this.target = celestialAt(new Date(this.now), lat, lon);
  }

  private byId(id: string | null): DayPreset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  /** Medianoche local del día configurado (o de hoy), en UTC. */
  private dayStart(): number {
    const offset = this.cfg.utcOffsetHours * HOUR_MS;
    const base = this.cfg.date === 'today' ? Date.now() : Date.parse(`${this.cfg.date}T00:00:00Z`) - offset;
    if (!Number.isFinite(base)) throw new Error(`Fecha mal escrita en config/game.json → render.timeOfDay.date: "${this.cfg.date}"`);
    return Math.floor((base + offset) / DAY_MS) * DAY_MS - offset;
  }

  private load(): string | null {
    try {
      return localStorage.getItem(this.cfg.storageKey);
    } catch {
      return null;
    }
  }

  private remember(): void {
    try {
      localStorage.setItem(this.cfg.storageKey, this.preset.id);
    } catch {
      // Sin almacenamiento (modo privado): simplemente no se recuerda.
    }
  }

  get current(): DayPreset {
    return this.preset;
  }

  get instant(): Date {
    return new Date(this.now);
  }

  /** Hora local mostrada, en horas (0…24): la que marcan los relojes del mundo. */
  get hours(): number {
    return this.localHours(this.now);
  }

  /**
   * ¿Es de día a la hora mostrada? Y cuánto va (0…1) del día, de la salida a la puesta real del
   * sol sobre la ciudad, o de la noche, de la puesta a la salida (para el reloj del HUD).
   */
  dayArc(): { day: boolean; progress: number } {
    const times = getTimes(new Date(this.now), this.lat, this.lon);
    // Sin salida o puesta ese día (solo pasa cerca de los polos): de día si el sol está arriba.
    if (!times.sunrise || !times.sunset) return { day: this.celestial.sun.altitude > 0, progress: 0.5 };
    const rise = this.localHours(times.sunrise.getTime());
    const set = this.localHours(times.sunset.getTime());
    const h = this.hours;
    if (h >= rise && h < set) return { day: true, progress: (h - rise) / (set - rise) };
    return { day: false, progress: ((h - set + 24) % 24) / (24 - (set - rise)) };
  }

  private localHours(ms: number): number {
    const local = ms + this.cfg.utcOffsetHours * HOUR_MS;
    return (((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
  }

  /** true mientras corre un time-lapse. */
  get moving(): boolean {
    return this.progress < 1;
  }

  /** Instante de destino del time-lapse (o el actual). */
  get destination(): Date {
    return new Date(this.to);
  }

  /** Avance suavizado del time-lapse: 0 al elegir la hora, 1 al llegar. */
  get blend(): number {
    return this.eased;
  }

  onChange(listener: (preset: DayPreset) => void): void {
    this.listeners.add(listener);
  }

  /** Pasa a la próxima vez que sea la hora de `id` (siempre hacia adelante). */
  select(id: string): void {
    const next = this.byId(id);
    if (!next || next === this.preset) return;
    this.preset = next;
    this.remember();
    const clock = parseClock(next.time) * HOUR_MS;
    const today = Math.floor((this.now + this.cfg.utcOffsetHours * HOUR_MS) / DAY_MS) * DAY_MS - this.cfg.utcOffsetHours * HOUR_MS;
    let target = today + clock;
    while (target <= this.now) target += DAY_MS;
    this.from = this.now;
    this.to = target;
    this.progress = this.cfg.transitionSeconds > 0 ? 0 : 1;
    this.eased = this.progress;
    celestialAt(new Date(target), this.lat, this.lon, this.target);
    if (this.progress >= 1) {
      this.now = target;
      celestialAt(new Date(this.now), this.lat, this.lon, this.celestial);
    }
    for (const listener of this.listeners) listener(next);
  }

  /** La siguiente de la lista (tecla de hora). */
  cycle(): void {
    const k = this.presets.indexOf(this.preset);
    this.select(this.presets[(k + 1) % this.presets.length].id);
  }

  /** Avanza el time-lapse; devuelve true si el cielo cambió en este frame. */
  update(dt: number): boolean {
    if (this.progress >= 1) return false;
    this.progress = Math.min(1, this.progress + dt / this.cfg.transitionSeconds);
    // Arranca y termina suave (smootherstep).
    const p = this.progress;
    this.eased = p * p * p * (p * (p * 6 - 15) + 10);
    this.now = this.from + (this.to - this.from) * this.eased;
    celestialAt(new Date(this.now), this.lat, this.lon, this.celestial);
    return true;
  }
}
