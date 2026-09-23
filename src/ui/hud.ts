import type { Mode } from '../player/controller';
import type { ZoneInfo } from './places';

const MODE_LABEL: Record<Mode, string> = {
  ground: 'CAMINANDO',
  air: 'EN EL AIRE',
  climb: 'TREPANDO',
  glide: 'PLANEANDO',
  swim: 'NADANDO',
  drive: 'MANEJANDO',
};

/** Ícono de cada modo (símbolos del sprite de index.html). */
const MODE_ICON: Record<Mode, string> = {
  ground: 'i-walk',
  air: 'i-air',
  climb: 'i-climb',
  glide: 'i-glide',
  swim: 'i-swim',
  drive: 'i-car',
};

/** Modos en los que la altura sobre el suelo importa (se muestra en el velocímetro). */
const HEIGHT_MODES: ReadonlySet<Mode> = new Set(['air', 'climb', 'glide']);

/** Una tecla (o grupo de teclas) de la leyenda con lo que hace. */
export interface LegendItem {
  keys: string[];
  text: string;
}

export interface Legend {
  /** Etiquetas del bloque W A S D (adelante, izquierda, atrás, derecha). */
  wasd: [string, string, string, string];
  items: LegendItem[];
  hint: string;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Falta #${id} en index.html`);
  return node as T;
}

export interface HudStatus {
  mode: Mode;
  speed: number;
  /** Multiplicador de velocidad, o null si el personaje (o el carro) no tiene. */
  speedMultiplier: number | null;
  /** Detalle del modo (p. ej. "REVERSA", "MOTOR AHOGADO"). */
  modeDetail: string;
  heightAboveGround: number;
}

/**
 * Lo que se ve encima del mundo mientras se juega: carga, barrio donde estás (arriba a la
 * izquierda), velocímetro, leyenda de teclas, buscador, avisos y créditos. El minimapa, el
 * reloj, la pausa y el mapa grande tienen su propio módulo.
 */
export class Hud {
  private toastTimer = 0;
  private worldName = '';
  private statusKey = '';

  constructor(
    /** Desde cuántos metros sobre el suelo se muestra la altura (planeando, trepando, saltando). */
    private readonly altitudeFrom: number,
  ) {}

  /** Nombre de la ciudad cargada y de la app (el título de la pestaña junta los dos). */
  setWorldName(name: string, appName: string, title: string): void {
    this.worldName = name;
    document.querySelector('.loading h1')!.textContent = name;
    el('loading-brand').textContent = appName;
    document.title = title;
    this.setLocation(null);
  }

  setLoading(progress: number, label: string): void {
    el('loading-bar').style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
    el('loading-label').textContent = label;
  }

  failLoading(message: string): void {
    el('loading').classList.add('error');
    el('loading-label').textContent = message;
  }

  hideLoading(): void {
    el('loading').classList.add('done');
  }

  /** Créditos en una línea corta (la lista completa va en la pausa). */
  setCredits(line: string): void {
    el('credits').textContent = line;
  }

  /** Barrio donde está el jugador y las zonas que lo contienen; fuera de todas, el nombre del mundo. */
  setLocation(zone: ZoneInfo | null): void {
    el('location-name').textContent = zone ? zone.name : this.worldName;
    el('location-sub').textContent = zone ? zone.above.join(' · ') : '';
    el('location-sub').hidden = !zone || !zone.above.length;
  }

  onSearch(handler: (query: string) => Promise<void>): void {
    const form = el<HTMLFormElement>('search');
    const input = el<HTMLInputElement>('search-input');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input.value;
      handler(query)
        .then(() => {
          input.value = '';
          input.blur();
        })
        .catch((err: unknown) => this.toast(err instanceof Error ? err.message : String(err)));
    });
  }

  /** Botón de ubicación: el aviso de búsqueda dura lo que puede tardar y el de error, `errorMs`. */
  onLocate(handler: () => Promise<void>, searchingMs: number, errorMs: number): void {
    const button = el<HTMLButtonElement>('locate');
    button.addEventListener('click', () => {
      if (button.classList.contains('busy')) return;
      button.classList.add('busy');
      this.toast('Buscando tu ubicación…', searchingMs);
      handler()
        .catch((err: unknown) => this.toast(err instanceof Error ? err.message : String(err), errorMs))
        .finally(() => button.classList.remove('busy'));
    });
  }

  /** Leyenda de teclas según el contexto (a pie, manejando) y lo que sabe hacer el personaje. */
  setLegend(legend: Legend): void {
    const ids = ['key-forward', 'key-left', 'key-back', 'key-right'];
    ids.forEach((id, k) => (el(id).textContent = legend.wasd[k]));
    const list = el('keylist');
    list.replaceChildren(
      ...legend.items.map((item) => {
        const row = document.createElement('div');
        for (const key of item.keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          row.append(kbd);
        }
        const text = document.createElement('span');
        text.textContent = item.text;
        row.append(text);
        return row;
      }),
    );
    el('key-hint').textContent = legend.hint;
  }

  /** Teclas del multiplicador de velocidad (en el velocímetro). */
  setSpeedKeys(down: string, up: string): void {
    el('speed-down').textContent = down;
    el('speed-up').textContent = up;
  }

  /** Velocímetro: km/h, el modo con su ícono, el multiplicador y, en el aire, la altura sobre el suelo. */
  setStatus(s: HudStatus): void {
    el('speed-value').textContent = (s.speed * 3.6).toFixed(0);
    const high = HEIGHT_MODES.has(s.mode) && s.heightAboveGround >= this.altitudeFrom;
    const alt = el('speed-alt');
    alt.hidden = !high;
    if (high) alt.textContent = `+${s.heightAboveGround.toFixed(0)} m`;
    // Lo que cambia poco (modo, detalle, multiplicador) solo se toca cuando cambia.
    const key = `${s.mode}|${s.modeDetail}|${s.speedMultiplier}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    el('speed-mode-label').textContent = MODE_LABEL[s.mode];
    el('speed-mode-icon').setAttribute('href', `#${MODE_ICON[s.mode]}`);
    const detail = el('speed-detail');
    detail.textContent = s.modeDetail;
    detail.hidden = !s.modeDetail;
    el('speed-mult').hidden = s.speedMultiplier === null;
    if (s.speedMultiplier !== null) el('speed-mult-value').textContent = `×${formatMultiplier(s.speedMultiplier)}`;
  }

  toast(message: string, ms = 2600): void {
    const node = el('toast');
    node.textContent = message;
    node.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => node.classList.remove('visible'), ms);
  }
}

/** ×0,5 · ×2 · ×1,5 (coma decimal). */
export function formatMultiplier(value: number): string {
  return String(value).replace('.', ',');
}
