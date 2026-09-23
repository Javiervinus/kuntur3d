import type { GameConfig } from '../core/types';

/** Dónde estabas: posición en el mundo, hacia dónde mirabas y si ibas manejando. */
export interface Place {
  x: number;
  z: number;
  yaw: number;
  driving: boolean;
}

const isPlace = (v: unknown): v is Place => {
  const p = v as Partial<Place> | null;
  return (
    !!p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.z) &&
    Number.isFinite(p.yaw) &&
    typeof p.driving === 'boolean'
  );
};

/**
 * Recuerda en el navegador dónde quedaste, para retomar ahí al recargar (en vez de volver
 * siempre al punto de partida). Sin almacenamiento (modo privado, bloqueado) simplemente no
 * recuerda nada.
 */
export class LastPlace {
  private elapsed = 0;

  constructor(private readonly cfg: GameConfig['resume']) {}

  load(): Place | null {
    try {
      const raw = localStorage.getItem(this.cfg.storageKey);
      const place: unknown = raw ? JSON.parse(raw) : null;
      return isPlace(place) ? place : null;
    } catch {
      return null;
    }
  }

  save(place: Place): void {
    try {
      localStorage.setItem(this.cfg.storageKey, JSON.stringify(place));
    } catch {
      // Sin almacenamiento: no se recuerda, sin más.
    }
  }

  /** Llamar cada frame: guarda cada `saveEverySeconds` (y al cerrar, ver `saveOnLeave`). */
  tick(dt: number, place: () => Place): void {
    this.elapsed += dt;
    if (this.elapsed < this.cfg.saveEverySeconds) return;
    this.elapsed = 0;
    this.save(place());
  }

  /** Guarda también al recargar, cerrar o cambiar de pestaña (lo último que se hizo cuenta). */
  saveOnLeave(place: () => Place): void {
    const save = (): void => this.save(place());
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save();
    });
  }
}
