import type { LocalSearch, SearchHit } from './search';
import type { SearchConfig, SearchLandmark, SearchResult } from './searchEngine';
import type { SearchReply, SearchRequest } from './searchWorker';

/** Desde dónde se ordena por cercanía: la posición del jugador. */
export type Origin = () => { x: number; z: number };

export type SearchState = 'idle' | 'loading' | 'ready' | 'failed' | 'missing';

interface Job {
  id: number;
  text: string;
  x: number;
  z: number;
  resolve: (results: SearchResult[] | null) => void;
}

/**
 * Buscador local, lado del hilo principal: arranca el worker (src/ui/searchWorker.ts) la primera
 * vez que hace falta (al enfocar la caja) y le pasa las consultas de a una. Si mientras se
 * responde una llegan otras, solo la última espera turno: las del medio ya no importan y se
 * resuelven con null.
 */
export class PlaceSearch implements LocalSearch {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private current: SearchState;
  private nextId = 1;
  private inFlight: Job | null = null;
  private queued: Job | null = null;

  /** `url`: el índice (manifest.search), o null si el mundo se generó sin el paso `search`. */
  constructor(
    private readonly url: string | null,
    private readonly landmarks: SearchLandmark[],
    private readonly cfg: SearchConfig,
    private readonly origin: Origin,
  ) {
    this.current = url ? 'idle' : 'missing';
  }

  get state(): SearchState {
    return this.current;
  }

  /** Arranca el worker y la descarga del índice (una sola vez); true cuando está listo. */
  warm(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (!this.url) {
      this.ready = Promise.resolve(false);
      return this.ready;
    }
    this.current = 'loading';
    const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.ready = new Promise<boolean>((resolve) => {
      worker.onmessage = (event: MessageEvent<SearchReply>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          this.current = 'ready';
          resolve(true);
        } else if (msg.type === 'failed') {
          this.current = 'failed';
          console.warn('[search] No se pudo cargar el índice del buscador:', msg.error);
          resolve(false);
        } else this.answered(msg.id, msg.results);
      };
      worker.onerror = (event) => {
        this.current = 'failed';
        console.warn('[search] El worker del buscador falló:', event.message);
        resolve(false);
        this.flush();
      };
    });
    const init: SearchRequest = { type: 'init', url: this.url, landmarks: this.landmarks, config: this.cfg };
    worker.postMessage(init);
    return this.ready;
  }

  /** Resultados para `text` vistos desde el jugador; null si otra consulta la reemplazó. */
  query(text: string): Promise<SearchResult[] | null> {
    void this.warm();
    const { x, z } = this.origin();
    return new Promise((resolve) => {
      const job: Job = { id: this.nextId++, text, x, z, resolve };
      if (!this.worker || this.current === 'failed') resolve([]);
      else if (this.inFlight) {
        this.queued?.resolve(null);
        this.queued = job;
      } else this.send(job);
    });
  }

  /** El primer resultado (lo que da Enter sin elegir), para src/ui/search.ts. */
  async best(text: string): Promise<SearchHit | null> {
    for (;;) {
      const results = await this.query(text);
      if (results === null) continue;
      const first = results[0];
      return first ? { x: first.x, z: first.z, label: first.name } : null;
    }
  }

  private send(job: Job): void {
    this.inFlight = job;
    const { id, text, x, z } = job;
    const msg: SearchRequest = { type: 'query', id, text, x, z, limit: this.cfg.maxResults };
    this.worker?.postMessage(msg);
  }

  private answered(id: number, results: SearchResult[]): void {
    const job = this.inFlight;
    if (!job || job.id !== id) return;
    this.inFlight = null;
    job.resolve(results);
    const next = this.queued;
    this.queued = null;
    if (next) this.send(next);
  }

  /** El worker se cayó: lo pendiente se resuelve vacío. */
  private flush(): void {
    this.inFlight?.resolve([]);
    this.queued?.resolve([]);
    this.inFlight = null;
    this.queued = null;
  }
}
