import type { ControlSection } from './legend';
import { type DirectoryEntry, formatDistance, type PlaceCategory } from './places';

/** Lo que hace cada botón del menú de pausa. */
export interface PauseHandlers {
  resume(): void;
  openMap(): void;
  /** Ir a un lugar de la lista (a su punto de llegada). */
  goTo(entry: DirectoryEntry): void;
  selectTime(id: string): void;
  toast(message: string): void;
}

/** Una hora del día en su tarjeta: el cielo (degradado de arriba a abajo) y el sol o la luna. */
export interface TimeCard {
  id: string;
  label: string;
  time: string;
  sky: string[];
  orb: string;
  /** Dónde va el sol o la luna en la tarjeta (x %, y %). */
  at: number[];
}

/** Dónde está el jugador, para compartirlo. */
export interface ShareInfo {
  place: string;
  lat: number;
  lon: number;
  /** Link que abre el juego en este punto. */
  link: string;
  /** El mismo punto en Google Maps. */
  mapsUrl: string;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Ícono de alfiler para los lugares sin foto (del sprite de index.html). */
function pinIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-pin');
  svg.append(use);
  return svg;
}

/** Teclas como en la leyenda. */
function keycaps(keys: string[]): HTMLElement {
  const span = node('span', 'keycaps');
  for (const key of keys) span.append(node('kbd', '', key));
  return span;
}

/**
 * Pausa: "En pausa" arriba (con el estilo de los títulos de barrio) y un panel a la izquierda
 * con los lugares (por tipo, con foto y a qué distancia están, del más cercano al más lejano),
 * la hora del día, todos los controles, cómo compartir dónde estás y los créditos completos. El
 * centro de la pantalla queda libre: la ciudad se sigue viendo, quieta.
 */
export class PauseMenu {
  private readonly panels = new Map<string, HTMLElement>();
  private readonly tabs: HTMLButtonElement[];
  private categories: PlaceCategory[] = [];
  private entries: DirectoryEntry[] = [];
  private share: ShareInfo | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly menu: HTMLElement,
    private readonly handlers: PauseHandlers,
  ) {
    this.tabs = [...menu.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    for (const panel of menu.querySelectorAll<HTMLElement>('[data-panel]')) this.panels.set(panel.dataset.panel ?? '', panel);
    for (const tab of this.tabs) tab.addEventListener('click', () => this.select(tab.dataset.tab ?? ''));
    overlay.querySelector('[data-action="resume"]')?.addEventListener('click', () => handlers.resume());
    menu.querySelector('[data-action="map"]')?.addEventListener('click', () => handlers.openMap());
    menu.querySelector('[data-action="copy"]')?.addEventListener('click', () => this.copyLink());
    // Que los clics en el menú no lleguen al mundo (un clic en la ciudad es "seguir").
    for (const root of [overlay, menu]) root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  show(on: boolean): void {
    this.overlay.hidden = !on;
    this.menu.hidden = !on;
  }

  setWorldName(name: string, subtitle: string): void {
    const title = this.menu.querySelector('[data-world]');
    if (title) title.textContent = name;
    const sub = this.menu.querySelector('[data-app-subtitle]');
    if (sub) sub.textContent = subtitle;
  }

  setPlaces(categories: PlaceCategory[], entries: DirectoryEntry[]): void {
    this.categories = categories;
    this.entries = entries;
  }

  /** Arma la lista de lugares ordenada por cercanía a (x, z) (al abrir la pausa). */
  refresh(x: number, z: number): void {
    const panel = this.panels.get('places');
    if (!panel) return;
    const near = this.entries.map((entry) => ({ entry, d: Math.hypot(entry.x - x, entry.z - z) })).sort((a, b) => a.d - b.d);
    panel.replaceChildren();
    for (const category of this.categories) {
      const list = near.filter(({ entry }) => entry.category === category.id);
      if (!list.length) continue;
      const head = node('div', 'pm-group', category.label);
      head.append(node('i', '', String(list.length)));
      panel.append(head);
      for (const { entry, d } of list) {
        const row = node('button', 'pm-place');
        row.type = 'button';
        if (entry.thumb) {
          const img = node('img', 'pm-thumb');
          img.src = entry.thumb;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          row.append(img);
        } else {
          const blank = node('span', 'pm-thumb blank');
          blank.append(pinIcon());
          row.append(blank);
        }
        const text = node('span', 'pm-text');
        const name = node('span', 'pm-name');
        if (entry.ficha) name.append(node('i', 'pm-ficha'));
        name.append(entry.name);
        const kicker = [entry.kicker, entry.year].filter(Boolean).join(' · ');
        text.append(name, node('span', 'pm-kicker', kicker || 'Lugar del mapa'));
        row.append(text, node('span', 'pm-dist', formatDistance(d)));
        row.addEventListener('click', () => this.handlers.goTo(entry));
        panel.append(row);
      }
    }
  }

  /** Tarjetas de las horas del día; la de `current` queda marcada. */
  setTimes(cards: TimeCard[], current: string): void {
    const panel = this.panels.get('time');
    if (!panel) return;
    panel.replaceChildren(
      ...cards.map((card) => {
        const button = node('button', 'pm-time');
        button.type = 'button';
        button.dataset.id = card.id;
        button.style.background = `linear-gradient(180deg, ${card.sky.join(', ')})`;
        const orb = node('span', 'pm-orb');
        orb.style.left = `${card.at[0]}%`;
        orb.style.top = `${card.at[1]}%`;
        orb.style.background = card.orb;
        orb.style.boxShadow = `0 0 18px ${card.orb}`;
        button.append(orb, node('b', '', card.time), node('span', '', card.label));
        button.addEventListener('click', () => this.handlers.selectTime(card.id));
        return button;
      }),
    );
    this.setTime(current);
  }

  setTime(current: string): void {
    for (const button of this.panels.get('time')?.querySelectorAll<HTMLElement>('.pm-time') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.id === current));
    }
  }

  setControls(sections: ControlSection[]): void {
    const panel = this.panels.get('controls');
    if (!panel) return;
    panel.replaceChildren();
    for (const section of sections) {
      panel.append(node('div', 'pm-group', section.title));
      for (const item of section.items) {
        const row = node('div', 'pm-control');
        row.append(keycaps(item.keys), node('span', '', item.text));
        panel.append(row);
      }
    }
  }

  setShare(info: ShareInfo): void {
    this.share = info;
    const panel = this.panels.get('share');
    if (!panel) return;
    const set = (key: string, text: string): void => {
      const target = panel.querySelector(`[data-${key}]`);
      if (target) target.textContent = text;
    };
    set('place', info.place);
    set('coords', `${info.lat.toFixed(5)}, ${info.lon.toFixed(5)}`);
    panel.querySelector<HTMLAnchorElement>('[data-maps]')?.setAttribute('href', info.mapsUrl);
  }

  /**
   * Créditos: primero la app (quién la hizo, su licencia y el link al código, que la licencia pide
   * mantener visibles en cualquier versión) y después las fuentes de datos.
   */
  setCredits(appName: string, about: string[], source: { label: string; url: string }, attributions: string[]): void {
    const app = node('div', 'pm-about');
    app.append(node('strong', '', appName), ...about.map((line) => node('p', '', line)));
    const link = node('a', '', source.label);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const buttons = node('div', 'pm-buttons');
    buttons.append(link);
    app.append(buttons);
    this.panels.get('credits')?.replaceChildren(app, ...attributions.map((line) => node('p', '', line)));
  }

  private select(id: string): void {
    for (const tab of this.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
    for (const [key, panel] of this.panels) panel.hidden = key !== id;
  }

  private copyLink(): void {
    const link = this.share?.link;
    if (!link) return;
    navigator.clipboard
      .writeText(link)
      .then(() => this.handlers.toast('Link copiado'))
      .catch(() => this.handlers.toast(link));
  }
}
