import type { FollowCamera } from '../player/camera';
import type { PlayerController } from '../player/controller';
import type { TimeOfDay } from '../render/timeOfDay';

/** Lo que necesitan las tomas de prueba (ver `createShots`). */
export interface ShotContext {
  follow: FollowCamera;
  player: PlayerController;
  daytime: TimeOfDay;
  teleport: (x: number, z: number) => Promise<void>;
  /** Postes (para ubicarse en una calle iluminada) y largo de su brazo en alturas de poste. */
  lamps: { x: Float32Array; z: Float32Array; h: Float32Array; arm: Float32Array; count: number } | null;
  armShare: number;
  container: HTMLElement;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ayudas de desarrollo para revisar la imagen desde la consola (`__gye.shots`): cámara fija
 * relativa al jugador, hora del día sin esperar a mano, ubicarse en una calle junto a un poste
 * y teclas simuladas. Solo en desarrollo (se carga con import dinámico).
 */
export function createShots(ctx: ShotContext) {
  const original = ctx.follow.update.bind(ctx.follow);
  return {
    /** Cámara en jugador + (dx, dy, dz) mirando a jugador + (tx, ty, tz). */
    at(v: number[]): void {
      ctx.follow.update = function (this: FollowCamera) {
        const p = ctx.player.position;
        this.camera.position.set(p.x + v[0], p.y + v[1], p.z + v[2]);
        this.camera.lookAt(p.x + v[3], p.y + v[4], p.z + v[5]);
      };
    },
    /** Devuelve la cámara al jugador. */
    free(): void {
      ctx.follow.update = original;
    },
    /** Cambia la hora y espera a que termine el time-lapse. */
    async preset(id: string): Promise<string> {
      if (ctx.daytime.current.id !== id) {
        ctx.daytime.select(id);
        await wait(100);
        while (ctx.daytime.moving) await wait(100);
        await wait(400);
      }
      return ctx.daytime.current.id;
    },
    /** Índice del poste más cercano a (x, z). */
    lampNear(x: number, z: number): number {
      const l = ctx.lamps;
      if (!l) return -1;
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < l.count; k++) {
        const d = Math.hypot(l.x[k] - x, l.z[k] - z);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      return best;
    },
    /** Parado en la calzada `into` m más allá del foco del poste `k`, mirando a lo largo de la calle. */
    async street(k: number, back = 9, up = 2.4, into = 4): Promise<void> {
      const l = ctx.lamps;
      if (!l) return;
      const ax = Math.cos(l.arm[k]);
      const az = Math.sin(l.arm[k]);
      const reach = l.h[k] * ctx.armShare + into;
      await ctx.teleport(l.x[k] + ax * reach, l.z[k] + az * reach);
      await wait(3000);
      this.at([az * back - ax * 2, up, -ax * back - az * 2, -az * 40, 3, ax * 40]);
      await wait(1500);
    },
    /** Pulsa y suelta una tecla. */
    async tap(code: string): Promise<void> {
      ctx.container.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await wait(80);
      ctx.container.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await wait(300);
    },
    wait,
  };
}
