import {
  SearchEngine,
  type SearchConfig,
  type SearchIndexData,
  type SearchLandmark,
  type SearchResult,
} from './searchEngine';

/** Lo mínimo del ámbito de un worker (el proyecto compila con la lib DOM, no WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(message: SearchReply): void;
}
const scope = self as unknown as WorkerScope;

export type SearchRequest =
  | { type: 'init'; url: string; landmarks: SearchLandmark[]; config: SearchConfig }
  | { type: 'query'; id: number; text: string; x: number; z: number; limit: number };

export type SearchReply =
  | { type: 'ready'; counts: Record<string, number>; ms: number }
  | { type: 'failed'; error: string }
  | { type: 'results'; id: number; results: SearchResult[]; ms: number };

type Query = Extract<SearchRequest, { type: 'query' }>;

/**
 * Worker del buscador: descarga e interpreta el índice (public/world/search.json) y responde las
 * consultas con src/ui/searchEngine.ts, sin tocar el hilo principal. Mientras carga, guarda solo
 * la última consulta (las anteriores ya no importan).
 */
let engine: SearchEngine | null = null;
let failed = false;
let waiting: Query | null = null;

function answer(query: Query): void {
  if (!engine && !failed) {
    waiting = query;
    return;
  }
  const t0 = performance.now();
  const results = engine ? engine.search(query.text, query.x, query.z, query.limit) : [];
  scope.postMessage({ type: 'results', id: query.id, results, ms: performance.now() - t0 });
}

async function load(url: string, landmarks: SearchLandmark[], config: SearchConfig): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} al pedir ${url}`);
    const data = (await res.json()) as SearchIndexData;
    engine = new SearchEngine(data, landmarks, config);
    scope.postMessage({ type: 'ready', counts: engine.counts, ms: performance.now() - t0 });
  } catch (err) {
    failed = true;
    scope.postMessage({ type: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
  if (waiting) {
    const query = waiting;
    waiting = null;
    answer(query);
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') void load(msg.url, msg.landmarks, msg.config);
  else answer(msg);
};
