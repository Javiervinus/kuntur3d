import { defineConfig } from 'vite';
import region from './config/region.json';
import { mapLinkResolver } from './server/mapLinkResolver';
import { tileProxy } from './server/tileProxy';

export default defineConfig({
  plugins: [mapLinkResolver(), tileProxy()],
  // .wrangler (lo que deja `npm run deploy`) no es parte del proyecto en desarrollo.
  server: { watch: { ignored: ['**/.wrangler/**'] } },
  optimizeDeps: { entries: ['index.html'] },
  // Publicado (hosting estático, sin el proxy de este servidor), el navegador pide los tiles
  // directo a la fuente: la misma plantilla que usan el pipeline y el proxy.
  define: { __IMAGERY_SOURCE__: JSON.stringify(region.imagery.urlTemplate) },
});
