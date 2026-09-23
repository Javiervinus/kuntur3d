/** Estado de teclado y mouse. Las acciones de un solo disparo se consumen con `consume`. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly target: HTMLElement;
  lookDx = 0;
  lookDy = 0;
  wheel = 0;
  lastLookAt = -Infinity;
  private dragging = false;
  private locked = false;
  private readonly lockLost = new Set<() => void>();

  constructor(target: HTMLElement) {
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.down.clear());
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.target;
      if (this.locked && !locked) for (const listener of this.lockLost) listener();
      this.locked = locked;
    });
  }

  /**
   * Avisa cuando el navegador suelta el mouse capturado: Esc (que el navegador se queda y no
   * llega como tecla), cambiar de ventana… También cuando lo suelta `release`.
   */
  onLockLost(listener: () => void): void {
    this.lockLost.add(listener);
  }

  /** Suelta el mouse capturado (para usar el menú o el mapa). */
  release(): void {
    this.dragging = false;
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  /** Mientras se escribe en un input del HUD, el juego no recibe teclas. */
  private static typing(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (Input.typing(e)) return;
    if (!this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.dragging = true;
    if (document.pointerLockElement !== this.target && e.button === 0) {
      // Justo después de soltarlo con Esc, Chrome rechaza capturarlo de nuevo por un momento:
      // se sigue mirando arrastrando y el próximo clic lo captura.
      this.target.requestPointerLock?.()?.catch(() => {});
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === this.target || this.dragging) {
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
      this.lastLookAt = performance.now();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  consume(code: string): boolean {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /** Llamar al final de cada frame. */
  endFrame(): void {
    this.pressed.clear();
    this.lookDx = 0;
    this.lookDy = 0;
    this.wheel = 0;
  }
}
