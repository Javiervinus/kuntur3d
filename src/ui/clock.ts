/** Arco del reloj en el viewBox de su SVG (index.html → #clock): centro, radios y el horizonte. */
const ARC = { cx: 23, cy: 23, rx: 19, ry: 17 };

/**
 * Reloj bajo el minimapa: la hora del mundo (la que ven el sol y la luna, ver
 * render/timeOfDay.ts) con el nombre del momento, y el sol o la luna recorriendo un arco de la
 * salida a la puesta (o de la puesta a la salida). Durante el time-lapse los minutos corren.
 * Un clic pasa a la hora siguiente, como la tecla.
 */
export class Clock {
  private readonly time: HTMLElement;
  private readonly label: HTMLElement;
  private readonly sun: SVGGElement;
  private readonly moon: SVGGElement;
  private readonly root: HTMLElement;
  private shown = '';

  constructor(root: HTMLElement, onCycle: () => void) {
    const time = root.querySelector<HTMLElement>('[data-time]');
    const label = root.querySelector<HTMLElement>('[data-label]');
    const sun = root.querySelector<SVGGElement>('[data-sun]');
    const moon = root.querySelector<SVGGElement>('[data-moon]');
    if (!time || !label || !sun || !moon) throw new Error('Falta el reloj en index.html (#clock)');
    this.root = root;
    this.time = time;
    this.label = label;
    this.sun = sun;
    this.moon = moon;
    root.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).blur();
      onCycle();
    });
  }

  /** `hours` (0-24) de la hora local; `progress` (0…1) del día o de la noche según `day`. */
  update(hours: number, label: string, day: boolean, progress: number): void {
    const minutes = Math.floor((((hours % 24) + 24) % 24) * 60);
    const text = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const key = `${text}|${label}|${day}`;
    if (key === this.shown) return;
    this.shown = key;
    this.time.textContent = text;
    this.label.textContent = label;
    this.root.classList.toggle('night', !day);
    const a = Math.PI * (1 - Math.min(1, Math.max(0, progress)));
    const x = ARC.cx + Math.cos(a) * ARC.rx;
    const y = ARC.cy - Math.sin(a) * ARC.ry;
    const body = day ? this.sun : this.moon;
    body.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    this.sun.style.display = day ? '' : 'none';
    this.moon.style.display = day ? 'none' : '';
  }
}
