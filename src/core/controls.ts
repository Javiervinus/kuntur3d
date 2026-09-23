import type { Input } from './input';
import type { GameConfig } from './types';

export type Action = keyof GameConfig['controls']['keys'];

/** Acciones del juego sobre el teclado: qué teclas hacen qué sale de config/game.json → controls. */
export class Controls {
  constructor(
    readonly input: Input,
    private readonly cfg: GameConfig['controls'],
  ) {}

  isDown(action: Action): boolean {
    return this.cfg.keys[action].some((code) => this.input.isDown(code));
  }

  /** Disparo único: true una sola vez por pulsación. */
  consume(action: Action): boolean {
    let hit = false;
    for (const code of this.cfg.keys[action]) hit = this.input.consume(code) || hit;
    return hit;
  }

  axis(negative: Action, positive: Action): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /** Nombre visible de la primera tecla de la acción (para la leyenda del HUD). */
  label(action: Action): string {
    return this.keyName(this.cfg.keys[action][0] ?? '');
  }

  /** Nombre visible de cada tecla de la acción. */
  labels(action: Action): string[] {
    return this.cfg.keys[action].map((code: string) => this.keyName(code));
  }

  private keyName(code: string): string {
    const labels: Record<string, string> = this.cfg.labels;
    return labels[code] ?? code.replace(/^(Key|Digit|Numpad)/, '');
  }
}
