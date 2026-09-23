import type { ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import game from '../config/game.json';
import { asUrl, isShortHost } from '../src/core/mapLinks';

const cfg = game.mapLinks;

/**
 * Expande links cortos (maps.app.goo.gl/…) siguiendo sus redirecciones del lado del
 * servidor: el navegador no puede leerlas por CORS. Solo se piden URLs de los dominios
 * cortos permitidos; en cuanto la redirección sale de ellos se devuelve sin abrirla.
 */
export async function expand(input: string): Promise<string> {
  let current = asUrl(input);
  if (!current || current.protocol !== 'https:' || !isShortHost(current.hostname, cfg)) {
    throw new Error('Solo se expanden links cortos de Google Maps');
  }
  for (let hop = 0; hop < cfg.maxRedirects; hop++) {
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) {
      throw new Error(`El link corto no redirigió a un mapa (HTTP ${res.status})`);
    }
    const next = new URL(location, current);
    if (!isShortHost(next.hostname, cfg)) return next.href;
    current = next;
  }
  throw new Error('El link corto tiene demasiadas redirecciones');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const handler: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== `/${cfg.resolverPath}`) {
    next();
    return;
  }
  expand(url.searchParams.get('url') ?? '').then(
    (expanded) => send(res, 200, { url: expanded }),
    (err: unknown) => send(res, 400, { error: err instanceof Error ? err.message : String(err) }),
  );
};

export function mapLinkResolver(): Plugin {
  return {
    name: 'gye-map-link-resolver',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
