/** Lo mínimo del ámbito de un worker (el proyecto compila con la lib DOM, no WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ImageryRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/**
 * Worker: arma la imagen satelital de un chunk. Pide los tiles Web Mercator (al proxy o a la
 * fuente, según `template`), los decodifica y los pega en un OffscreenCanvas recortado al
 * rectángulo que cubre el chunk (más un margen para el filtrado), y devuelve un ImageBitmap
 * listo para subir a la GPU.
 * Así la descarga, la decodificación y el pegado no tocan el hilo principal, y la textura
 * no carga con los pedazos de tiles que caen fuera del chunk (cerca de la mitad del área).
 * Guarda los tiles decodificados (LRU): los chunks vecinos comparten tiles del borde.
 */

export interface ImageryRequest {
  id: number;
  /** URL de cada tile, con {z}, {x} e {y} para completar. */
  template: string;
  zoom: number;
  tileSize: number;
  /** Rectángulo a componer, en píxeles globales del zoom. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Tiles decodificados que se conservan para reusar. */
  cacheSize: number;
}

export interface ImageryResult {
  id: number;
  ok: true;
  bitmap: ImageBitmap;
}

export interface ImageryError {
  id: number;
  ok: false;
  error: string;
}

const tiles = new Map<string, Promise<ImageBitmap | null>>();

function tile(req: ImageryRequest, x: number, y: number): Promise<ImageBitmap | null> {
  const k = `${req.zoom}/${x}/${y}`;
  const hit = tiles.get(k);
  if (hit) {
    // Reinsertar = marcar como usado recientemente (LRU por orden de inserción).
    tiles.delete(k);
    tiles.set(k, hit);
    return hit;
  }
  const url = req.template.replace('{z}', String(req.zoom)).replace('{x}', String(x)).replace('{y}', String(y));
  const job = fetch(url)
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => (blob ? createImageBitmap(blob) : null))
    .catch(() => null);
  tiles.set(k, job);
  while (tiles.size > req.cacheSize) {
    const oldest = tiles.keys().next().value as string;
    void tiles.get(oldest)?.then((bmp) => bmp?.close());
    tiles.delete(oldest);
  }
  return job;
}

scope.onmessage = async (event: MessageEvent<ImageryRequest>) => {
  const req = event.data;
  try {
    const ts = req.tileSize;
    const canvas = new OffscreenCanvas(req.width, req.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D no disponible');
    const tx0 = Math.floor(req.x / ts);
    const ty0 = Math.floor(req.y / ts);
    const tx1 = Math.floor((req.x + req.width - 1) / ts);
    const ty1 = Math.floor((req.y + req.height - 1) / ts);
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push(
          tile(req, tx, ty).then((bmp) => {
            if (bmp) ctx.drawImage(bmp, tx * ts - req.x, ty * ts - req.y);
          }),
        );
      }
    }
    await Promise.all(jobs);
    const bitmap = canvas.transferToImageBitmap();
    const result: ImageryResult = { id: req.id, ok: true, bitmap };
    scope.postMessage(result, [bitmap]);
  } catch (err) {
    const error: ImageryError = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(error);
  }
};
