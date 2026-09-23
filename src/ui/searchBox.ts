import type { GameConfig } from '../core/types';
import type { PlaceSearch } from './placeSearch';
import { directKind, type DirectKind } from './search';
import type { SearchConfig, SearchResult } from './searchEngine';
import { searchIcon } from './searchIcons';
import './search.css';

/** Una fila de la lista: un resultado del índice o lo escrito tal cual (link, coordenadas, Plus Code). */
type Row = { type: 'result'; result: SearchResult } | { type: 'direct'; kind: DirectKind; text: string };

/**
 * Autocompletado de la caja de búsqueda: mientras se escribe, lista los resultados del buscador
 * local (src/ui/placeSearch.ts) con ícono, nombre (con lo escrito resaltado), detalle y
 * distancia. Flechas para elegir, Enter o clic para ir, Esc para cerrar. Enter sin nada elegido
 * va al primero; los links, coordenadas y Plus Codes, y lo que no esté en el índice, siguen por el
 * envío normal del formulario (src/ui/search.ts, con Nominatim de respaldo).
 */
export class SearchBox {
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private rows: Row[] = [];
  private active = -1;
  /** Texto al que corresponden las filas que se ven. */
  private shownFor = '';
  private readonly meters: Intl.NumberFormat;
  private readonly kilometers: Intl.NumberFormat;
  private readonly kilometersFine: Intl.NumberFormat;

  constructor(
    private readonly cfg: SearchConfig,
    private readonly links: GameConfig['mapLinks'],
    locale: string,
    private readonly places: PlaceSearch,
    private readonly onPick: (result: SearchResult) => Promise<void>,
    private readonly onError: (message: string) => void,
  ) {
    const form = document.getElementById('search');
    const input = document.getElementById('search-input');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
      throw new Error('Falta #search o #search-input en index.html');
    }
    this.form = form;
    this.input = input;
    const unit = (unit: string, digits: number): Intl.NumberFormat =>
      new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits });
    this.meters = unit('meter', 0);
    this.kilometers = unit('kilometer', 0);
    this.kilometersFine = unit('kilometer', 1);

    // La lista va en <body> y no dentro del formulario: así queda sobre los demás paneles y su
    // vidrio desenfoca lo que hay detrás (dentro de otro panel con desenfoque solo vería ese panel).
    this.list = document.createElement('div');
    this.list.id = 'search-results';
    this.list.className = 'search-results';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', cfg.labels.list);
    document.body.append(this.list);
    window.addEventListener('resize', () => {
      if (this.isOpen) this.place();
    });
    input.placeholder = cfg.labels.placeholder;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', this.list.id);
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('focus', () => {
      void this.places.warm();
      if (input.value.trim()) this.refresh();
    });
    input.addEventListener('input', () => this.refresh());
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('blur', () => this.close());
    // Que el clic en la lista no le quite el foco a la caja (se cerraría antes de elegir).
    this.list.addEventListener('pointerdown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('[data-index]');
      if (row) void this.choose(Number(row.dataset.index));
    });
    this.list.addEventListener('pointermove', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('[data-index]');
      if (row) this.highlight(Number(row.dataset.index), false);
    });
  }

  private get isOpen(): boolean {
    return this.list.classList.contains('open');
  }

  /** Pide resultados para lo que hay escrito (la respuesta vieja se ignora si ya se escribió otra cosa). */
  private refresh(): void {
    const text = this.input.value;
    if (!text.trim()) {
      this.close();
      return;
    }
    const direct = directKind(text, this.links);
    if (direct) {
      this.show([{ type: 'direct', kind: direct, text: text.trim() }], text);
      return;
    }
    if (this.places.state === 'loading' && this.shownFor !== text) this.status('loading', this.cfg.labels.loading, '');
    void this.places.query(text).then((results) => {
      if (results === null || this.input.value !== text) return;
      this.show(
        results.map((result) => ({ type: 'result', result })),
        text,
      );
    });
  }

  private onKey(e: KeyboardEvent): void {
    // Mientras se compone un carácter (acentos con teclas muertas, IME), las teclas son del sistema.
    if (e.isComposing) return;
    const count = this.rows.length;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!this.isOpen) {
          this.refresh();
          return;
        }
        if (!count) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.highlight((this.active + step + count) % count, true);
        return;
      }
      case 'Enter':
        e.preventDefault();
        void this.submit();
        return;
      case 'Escape':
        e.preventDefault();
        if (this.isOpen) this.close();
        else this.input.blur();
        return;
    }
  }

  /** Enter: el elegido, o el primero; si no hay nada en el índice, el envío normal (Nominatim). */
  private async submit(): Promise<void> {
    const text = this.input.value;
    if (!text.trim()) return;
    if (directKind(text, this.links)) {
      this.close();
      this.form.requestSubmit();
      return;
    }
    let index = this.active >= 0 ? this.active : 0;
    if (this.shownFor !== text) {
      // Lo escrito cambió y su respuesta aún no llegó: se espera la de este texto.
      const results = await this.places.query(text);
      if (results === null || this.input.value !== text) return;
      this.show(
        results.map((result) => ({ type: 'result', result })),
        text,
      );
      index = 0;
    }
    await this.choose(index);
  }

  private async choose(index: number): Promise<void> {
    const row = this.rows[index];
    if (!row || row.type === 'direct') {
      this.close();
      this.form.requestSubmit();
      return;
    }
    this.close();
    this.input.value = '';
    this.input.blur();
    try {
      await this.onPick(row.result);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
    }
  }

  private show(rows: Row[], text: string): void {
    this.rows = rows;
    this.shownFor = text;
    this.active = rows.length ? 0 : -1;
    if (!rows.length) {
      const failed = this.places.state === 'failed' || this.places.state === 'missing';
      const { labels } = this.cfg;
      this.status('search', failed ? labels.failed : labels.empty, failed ? '' : labels.emptyHint);
      return;
    }
    const labels = this.cfg.labels;
    const items = rows.map((row, i) => {
      const option = document.createElement('div');
      option.className = 'search-option';
      option.id = `search-option-${i}`;
      option.dataset.index = String(i);
      option.setAttribute('role', 'option');
      if (row.type === 'result') {
        const r = row.result;
        option.dataset.kind = r.kind;
        option.append(
          this.iconBox(r.icon),
          this.body(this.marked(r.name, r.marks), r.detail),
          this.span('search-distance', this.distance(r.distance)),
        );
      } else {
        option.dataset.kind = 'direct';
        const detail = `${labels[row.kind]}${labels.detailSeparator}${labels.direct}`;
        option.append(this.iconBox(row.kind), this.body(this.span('search-name', row.text), detail));
      }
      return option;
    });
    const hint = this.span('search-hint', labels.hint);
    // Ayuda visual del teclado: el lector de pantalla ya anuncia la lista como combobox.
    hint.setAttribute('aria-hidden', 'true');
    this.list.replaceChildren(...items, hint);
    this.open();
    this.highlight(this.active, false);
  }

  /** Fila de estado (cargando, sin resultados): no se puede elegir. */
  private status(icon: string, text: string, detail: string): void {
    const row = document.createElement('div');
    row.className = `search-status${icon === 'loading' ? ' busy' : ''}`;
    row.setAttribute('role', 'status');
    row.append(this.iconBox(icon), this.body(this.span('search-name', text), detail));
    this.rows = [];
    this.active = -1;
    this.list.replaceChildren(row);
    this.input.removeAttribute('aria-activedescendant');
    this.open();
  }

  private highlight(index: number, scroll: boolean): void {
    this.active = index;
    this.list.querySelectorAll<HTMLElement>('.search-option').forEach((el, i) => {
      const on = i === index;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    });
    if (index >= 0) this.input.setAttribute('aria-activedescendant', `search-option-${index}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private open(): void {
    this.place();
    this.list.classList.add('open');
    this.input.setAttribute('aria-expanded', 'true');
  }

  /** Justo debajo de la caja, con su mismo ancho. */
  private place(): void {
    const box = this.form.getBoundingClientRect();
    this.list.style.left = `${box.left}px`;
    this.list.style.width = `${box.width}px`;
    this.list.style.setProperty('--search-bottom', `${box.bottom}px`);
  }

  private close(): void {
    this.list.classList.remove('open');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  private iconBox(key: string): HTMLElement {
    const box = this.span('search-icon', '');
    box.dataset.icon = key;
    box.append(searchIcon(key));
    return box;
  }

  private body(name: HTMLElement, detail: string): HTMLElement {
    const body = this.span('search-body', '');
    body.append(name);
    if (detail) body.append(this.span('search-detail', detail));
    return body;
  }

  /** El nombre con los tramos que calzan con lo escrito resaltados. */
  private marked(name: string, marks: [number, number][]): HTMLElement {
    const el = this.span('search-name', '');
    let at = 0;
    for (const [from, to] of marks) {
      if (from > at) el.append(name.slice(at, from));
      const mark = document.createElement('mark');
      mark.textContent = name.slice(from, to);
      el.append(mark);
      at = to;
    }
    if (at < name.length) el.append(name.slice(at));
    el.title = name;
    return el;
  }

  private span(className: string, text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  /** "350 m", "1,2 km", "15 km" (en el formato del idioma del juego). */
  private distance(meters: number): string {
    const d = this.cfg.distance;
    if (meters < d.kilometersFrom) {
      return this.meters.format(Math.max(d.roundMeters, Math.round(meters / d.roundMeters) * d.roundMeters));
    }
    return (meters < d.oneDecimalBelow ? this.kilometersFine : this.kilometers).format(meters / 1000);
  }
}
