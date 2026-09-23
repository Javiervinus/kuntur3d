import type { Plugin } from 'vite';
import game from '../config/game.json';

/** Escapa un texto para ponerlo en un atributo HTML. */
function attr(text: string | number): string {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Vista previa al compartir el link (WhatsApp, Facebook, X, Telegram…) y datos para buscadores:
 * título, descripción e imagen salen de config/game.json → app.share. Se escriben en el HTML al
 * armarlo, porque quienes arman la vista previa no corren el JavaScript de la página.
 */
export function shareMeta(): Plugin {
  const app = game.app;
  const s = app.share;
  const image = new URL(s.image, s.url).href;
  const meta = (key: 'name' | 'property', name: string, content: string | number): string =>
    `<meta ${key}="${name}" content="${attr(content)}" />`;
  const tags = [
    meta('name', 'description', s.description),
    meta('name', 'theme-color', s.themeColor),
    `<link rel="canonical" href="${attr(s.url)}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', app.name),
    meta('property', 'og:locale', s.locale),
    meta('property', 'og:url', s.url),
    meta('property', 'og:title', s.title),
    meta('property', 'og:description', s.description),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', s.imageWidth),
    meta('property', 'og:image:height', s.imageHeight),
    meta('property', 'og:image:alt', s.imageAlt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', s.title),
    meta('name', 'twitter:description', s.description),
    meta('name', 'twitter:image', image),
  ];
  return {
    name: 'share-meta',
    transformIndexHtml(html) {
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${attr(s.title)}</title>`)
        .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
    },
  };
}
