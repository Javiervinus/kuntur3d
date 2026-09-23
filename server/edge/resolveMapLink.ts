import game from '../../config/game.json';
import { expand } from '../mapLinkResolver';

/**
 * Publicado no está el servidor de Vite: esta función hace lo mismo que su plugin
 * (server/mapLinkResolver.ts), expandir links cortos de Google Maps, con el mismo código. Solo usa
 * APIs web (Request, Response, fetch), así que corre en el Worker de Cloudflare
 * (server/cloudflare/worker.ts), en config/game.json → mapLinks.resolverPath.
 */
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== `/${game.mapLinks.resolverPath}`) return reply(404, { error: 'Ruta desconocida' });
  try {
    return reply(200, { url: await expand(url.searchParams.get('url') ?? '') });
  } catch (err) {
    return reply(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
