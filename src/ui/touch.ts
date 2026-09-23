import type { Action, Controls } from '../core/controls';
import type { GameConfig } from '../core/types';

type TouchConfig = GameConfig['touch'];

/** Qué está haciendo el jugador: define qué botones se muestran. */
export type TouchContext = keyof TouchConfig['buttons'];

interface ButtonDef {
  action: string;
  label: string;
  main?: boolean;
  ability?: string;
  icon?: string;
}

/**
 * Controles para pantallas táctiles:
 * - joystick flotante a la izquierda: aparece donde se apoya el dedo; empujado hasta el borde, corre;
 * - arrastrar el resto de la pantalla para mirar, y dos dedos para acercar o alejar la cámara;
 * - botones a la derecha según lo que se está haciendo (a pie, trepando, planeando, manejando) y
 *   arriba el menú y la cámara.
 * Todo aprieta las mismas teclas que el teclado (`Input.setVirtual`): el resto del juego no
 * distingue si se juega con teclado o con los dedos.
 */
export class TouchControls {
  private enabled = false;
  private active = true;
  private stick: { id: number; x: number; y: number } | null = null;
  private readonly looks = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private context = '';
  private readonly held = new Map<HTMLElement, string>();
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly cfg: TouchConfig,
    private readonly controls: Controls,
    /** Donde se toca la ciudad (el canvas del mundo). */
    private readonly surface: HTMLElement,
    /** Contenedor de los controles (index.html → #touch). */
    private readonly root: HTMLElement,
  ) {
    const style = document.documentElement.style;
    style.setProperty('--stick-radius', `${cfg.joystick.radius}px`);
    style.setProperty('--stick-margin', `${cfg.joystick.margin}px`);
    surface.addEventListener('pointerdown', this.onDown);
    surface.addEventListener('pointermove', this.onMove);
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onUp);
    window.addEventListener('blur', () => this.releaseAll());
    // Una pantalla táctil que no se anuncia como tal (p. ej. una laptop con pantalla táctil): los
    // controles aparecen con el primer toque.
    window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && this.enable(), { capture: true });
    if (matchMedia(cfg.detect).matches) queueMicrotask(() => this.enable());
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Avisa cuando se activan los controles táctiles (para compactar el HUD, cambiar textos…). */
  onEnable(listener: () => void): void {
    if (this.enabled) listener();
    else this.listeners.push(listener);
  }

  /** Solo se juega con la ciudad en pantalla: en la pausa o el mapa se sueltan los controles. */
  setActive(on: boolean): void {
    this.active = on;
    if (!on) this.releaseAll();
  }

  /** Botones de la derecha según lo que se está haciendo y lo que el personaje sabe hacer. */
  setContext(context: TouchContext, abilities: Record<string, boolean>): void {
    if (!this.enabled) return;
    const key = `${context}:${Object.entries(abilities)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(',')}`;
    if (key === this.context) return;
    this.context = key;
    this.releaseButtons();
    const defs: ButtonDef[] = this.cfg.buttons[context];
    const buttons = defs.filter((def) => !def.ability || abilities[def.ability]).map((def) => this.button(def, 'touch-action'));
    this.part('[data-touch-actions]').replaceChildren(...buttons);
  }

  /** Suelta todo lo apretado (el joystick, los botones y los dedos que miraban). */
  releaseAll(): void {
    this.stick = null;
    this.looks.clear();
    this.pinch = 0;
    this.releaseButtons();
    this.controls.input.clearVirtual();
    this.showStick(null);
  }

  private enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
    const corner: ButtonDef[] = this.cfg.corner;
    this.part('[data-touch-corner]').replaceChildren(...corner.map((def) => this.button(def, 'touch-corner-button')));
    // El multiplicador de velocidad del velocímetro también se toca (−/+).
    this.holdable(document.getElementById('speed-down'), 'speedDown');
    this.holdable(document.getElementById('speed-up'), 'speedUp');
    for (const listener of this.listeners.splice(0)) listener();
  }

  private part(selector: string): HTMLElement {
    const el = this.root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Falta ${selector} en #touch (index.html)`);
    return el;
  }

  private button(def: ButtonDef, className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = def.main ? `${className} main` : className;
    button.setAttribute('aria-label', def.label);
    if (def.icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#i-${def.icon}`);
      svg.append(use);
      button.append(svg);
    }
    const label = document.createElement('span');
    label.textContent = def.label;
    button.append(label);
    this.holdable(button, def.action as Action);
    return button;
  }

  /** Mientras el dedo está sobre `el`, la acción queda apretada (como mantener la tecla). */
  private holdable(el: HTMLElement | null, action: Action): void {
    const code = this.controls.code(action);
    if (!el || !code) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      this.held.set(el, code);
      this.controls.input.setVirtual(code, 1);
    });
    const release = (): void => {
      if (!this.held.has(el)) return;
      this.held.delete(el);
      el.classList.remove('on');
      this.controls.input.setVirtual(code, 0);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }

  private releaseButtons(): void {
    for (const [el, code] of this.held) {
      el.classList.remove('on');
      this.controls.input.setVirtual(code, 0);
    }
    this.held.clear();
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType !== 'touch') return;
    // Sin esto, el navegador simula un clic de mouse (que pediría capturar el puntero).
    e.preventDefault();
    if (!this.active) return;
    this.surface.setPointerCapture(e.pointerId);
    const j = this.cfg.joystick;
    if (!this.stick && e.clientX < window.innerWidth * j.zone) {
      // El joystick nace bajo el dedo, pero entero dentro de la pantalla.
      const edge = j.radius + j.margin;
      const x = Math.max(edge, e.clientX);
      const y = Math.min(window.innerHeight - edge, Math.max(edge, e.clientY));
      this.stick = { id: e.pointerId, x, y };
      this.moveStick(e.clientX, e.clientY);
      return;
    }
    this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinch = this.looks.size === 2 ? this.spread() : 0;
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType !== 'touch' || !this.active) return;
    if (this.stick?.id === e.pointerId) {
      this.moveStick(e.clientX, e.clientY);
      return;
    }
    const last = this.looks.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last.x = e.clientX;
    last.y = e.clientY;
    if (this.looks.size === 1) {
      const s = this.cfg.look.sensitivity;
      this.controls.input.look(dx * s, dy * s);
    } else if (this.looks.size === 2) {
      const spread = this.spread();
      // Separar los dedos acerca la cámara (como la rueda hacia adelante).
      this.controls.input.zoom((this.pinch - spread) * this.cfg.look.pinchZoom);
      this.pinch = spread;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    if (this.stick?.id === e.pointerId) {
      this.stick = null;
      this.setStick(0, 0, 0);
      this.showStick(null);
      return;
    }
    this.looks.delete(e.pointerId);
    this.pinch = this.looks.size === 2 ? this.spread() : 0;
  };

  private spread(): number {
    const [a, b] = [...this.looks.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private moveStick(px: number, py: number): void {
    const s = this.stick;
    if (!s) return;
    const j = this.cfg.joystick;
    let dx = (px - s.x) / j.radius;
    let dy = (py - s.y) / j.radius;
    const raw = Math.hypot(dx, dy);
    if (raw > 1) {
      dx /= raw;
      dy /= raw;
    }
    this.showStick({ x: s.x, y: s.y, kx: dx * j.radius, ky: dy * j.radius });
    const mag = Math.min(1, raw);
    if (mag < j.deadzone) {
      this.setStick(0, 0, 0);
      return;
    }
    // Pasada la zona muerta, la fuerza va de 0 a 1 (sin salto al salir de ella).
    const k = (mag - j.deadzone) / (1 - j.deadzone) / mag;
    this.setStick(dx * k, dy * k, mag);
  }

  /** Aprieta a medias las teclas de caminar según el joystick (y la de correr, al borde). */
  private setStick(x: number, y: number, mag: number): void {
    const input = this.controls.input;
    const set = (action: Action, amount: number): void => {
      const code = this.controls.code(action);
      if (code) input.setVirtual(code, amount);
    };
    set('forward', Math.max(0, -y));
    set('back', Math.max(0, y));
    set('right', Math.max(0, x));
    set('left', Math.max(0, -x));
    set('run', mag >= this.cfg.joystick.runAt ? 1 : 0);
  }

  /** Dibuja el joystick donde está el dedo; sin dedo, vuelve a su lugar de descanso. */
  private showStick(at: { x: number; y: number; kx: number; ky: number } | null): void {
    const base = this.part('[data-touch-stick]');
    const knob = this.part('[data-touch-knob]');
    base.classList.toggle('held', !!at);
    base.style.left = at ? `${at.x}px` : '';
    base.style.top = at ? `${at.y}px` : '';
    knob.style.transform = at ? `translate(${at.kx}px, ${at.ky}px)` : '';
  }
}
