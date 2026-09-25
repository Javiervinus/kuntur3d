# Publicar

La versión pública está en https://kuntur3d.javiervinueza.workers.dev, un Worker de Cloudflare
configurado en `wrangler.jsonc`. La dirección anterior, `guayaquil-3d.javiervinueza.workers.dev`,
redirige a esta.

```bash
npm run deploy   # revisión de tipos + vite build + wrangler deploy
```

Wrangler sube solo los archivos que cambiaron.

## Cómo se sirve

- **Archivos estáticos**: la app y los datos del mundo (`dist/`, que incluye lo que `npm run data`
  genera en `public/`) se sirven como *assets* desde la red de Cloudflare, sin pasar por el
  Worker. La red tiene nodos en Guayaquil y Quito.
- **Worker** (`server/cloudflare/worker.ts`): atiende solo lo que no es un archivo, que es la ruta
  que expande los links cortos de Google Maps (`server/edge/resolveMapLink.ts`, el mismo código
  que usa el servidor de desarrollo).
- **Imagen satelital**: en producción los tiles se piden directo a Esri, que permite CORS. En
  desarrollo pasan por un proxy con caché (`server/tileProxy.ts`).
- **Caché**: `public/_headers` deja un año en caché los archivos de `/assets`, que llevan un hash
  en el nombre.
- **Vista previa al compartir** (WhatsApp, Facebook, X…): el título, la descripción y la imagen
  (`public/og.jpg`, 1200 × 630) salen de `config/game.json` → `app.share`. El plugin
  `server/shareMeta.ts` los escribe en el HTML al armar la app.

## Límites

- El plan gratuito admite hasta 20 000 archivos (hoy ~9 500) y 25 MB por archivo. Por eso el
  relieve se guarda comprimido: 4,7 MB en vez de 29 MB (ver el paso `terrain` en
  [como-funciona.md](como-funciona.md#pipeline-de-datos)).
- Los datos del mundo no están en Git. La integración continua (`.github/workflows/ci.yml`)
  revisa los tipos y arma la app, pero no publica. Publicar desde CI requeriría generar los
  datos ahí o alojarlos aparte (`worldUrl` en `config/game.json`).
