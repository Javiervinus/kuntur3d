import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import game from '../config/game.json';
import region from '../config/region.json';

/**
 * Proxy de tiles satelitales con caché en disco. El juego pide la imagen de alta
 * resolución bajo demanda (solo lo que se visita) y queda guardada en la misma
 * caché que usa el pipeline (`<cacheDir>/imagery/z/x/y.jpg`).
 * Solo sirve tiles dentro del bbox del mundo y de los zooms configurados.
 */

const runtime = region.imagery.runtime;
const route = new RegExp(`^/${game.imagery.proxyPath}/(\\d+)/(\\d+)/(\\d+)$`);

function tileRange(zoom: number): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** zoom;
  const m = runtime.bboxMarginDeg;
  const toX = (lon: number): number => Math.floor(((lon + 180) / 360) * n);
  const toY = (lat: number): number => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const b = region.bbox;
  return { x0: toX(b.west - m), x1: toX(b.east + m), y0: toY(b.north + m), y1: toY(b.south - m) };
}

/** Semáforo simple para no abrir demasiadas descargas a la vez contra el servidor de origen. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function tileProxy(): Plugin {
  const limit = limiter(region.imagery.concurrency);
  const inFlight = new Map<string, Promise<string | null>>();

  const fetchTile = (root: string, z: number, x: number, y: number): Promise<string | null> => {
    const file = path.join(root, region.cacheDir, 'imagery', String(z), String(x), `${y}.jpg`);
    const key = `${z}/${x}/${y}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = (async (): Promise<string | null> => {
      try {
        await stat(file);
        return file;
      } catch {
        // No está en caché: se descarga.
      }
      return limit(async () => {
        const url = region.imagery.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url, { headers: { 'User-Agent': region.userAgent } });
        if (!res.ok) return null;
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.part`;
        await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
        await rename(tmp, file);
        return file;
      });
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };

  const handler =
    (root: string): Connect.NextHandleFunction =>
    (req, res, next) => {
      const m = route.exec((req.url ?? '').split('?')[0]);
      if (!m) {
        next();
        return;
      }
      const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const range = tileRange(z);
      const allowed =
        z >= runtime.minZoom && z <= runtime.maxZoom && x >= range.x0 && x <= range.x1 && y >= range.y0 && y <= range.y1;
      if (!allowed) {
        end(res, 404);
        return;
      }
      fetchTile(root, z, x, y).then(
        (file) => {
          if (!file) {
            end(res, 502);
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
          createReadStream(file).pipe(res);
        },
        () => end(res, 502),
      );
    };

  return {
    name: 'gye-tile-proxy',
    configureServer(server) {
      server.middlewares.use(handler(server.config.root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(server.config.root));
    },
  };
}

function end(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.end();
}
