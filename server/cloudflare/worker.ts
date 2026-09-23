import game from '../../config/game.json';
import resolveMapLink from '../edge/resolveMapLink';

/**
 * Worker de Cloudflare (wrangler.jsonc). La página y los datos del mundo los sirve Cloudflare
 * directo desde los assets estáticos, sin pasar por acá (gratis y sin límite de visitas): solo
 * llegan las rutas que no son un archivo, como la que expande links cortos de Google Maps.
 */
export default {
  fetch(request: Request): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === `/${game.mapLinks.resolverPath}`) return resolveMapLink(request);
    return new Response('No encontrado', { status: 404 });
  },
};
