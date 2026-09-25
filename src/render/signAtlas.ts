import * as THREE from 'three';

/**
 * Un letrero de config/streets (world/downtown.ts → DowntownSign): texto con su letra y sus
 * colores, en una cara de `size` metros. El fondo es el de la caja del letrero (o el del muro,
 * si son letras sueltas pegadas a la fachada).
 */
export interface SignFace {
  text: string;
  /** Ancho y alto de la cara (m). */
  size: number[];
  /** Colores (sRGB) del fondo y de las letras. */
  background: string;
  color: string;
  /** Tipografía: familia CSS (si no, la del atlas), peso y cursiva. */
  font?: string;
  weight?: number;
  italic?: boolean;
  /** Qué parte del alto de la cara ocupan las letras (si no, la del atlas). */
  fill?: number;
  /** Fondo de la caja (m): con 0 son letras sueltas sobre la fachada, y su fondo no se enciende. */
  depth?: number;
}

/** config/game.json → monuments.signs: el atlas donde se dibujan todos los letreros. */
export interface SignAtlasConfig {
  /** Ancho y alto máximo del atlas (px): el alto se recorta a las hileras que ocupan los letreros. */
  size: number[];
  /** Resolución de las letras (px por metro de cara) y tope por letrero (px). */
  pixelsPerMeter: number;
  maxPixels: number[];
  /** Separación entre letreros en el atlas (px, para que el mipmap no mezcle vecinos). */
  padding: number;
  /** Tipografía y peso por defecto, qué parte del alto ocupan las letras y cuánto margen a los lados. */
  font: string;
  weight: number;
  fill: number;
  margin: number;
  /** Cuánto se enciende de noche el fondo de un letrero con caja, respecto de las letras (0…1). */
  backgroundGlow: number;
  /** Filtrado anisótropo (legible en ángulo). */
  anisotropy: number;
  /** Cuánto se separa la cara con las letras de su caja o de la fachada (m), para que no se pelee con ella. */
  offset: number;
}

/** Dónde quedó cada letrero en el atlas: uv (u0, v0) abajo a la izquierda y (u1, v1) arriba a la derecha. */
export type SignRect = [number, number, number, number];

/** La clave de un letrero: dos iguales comparten su lugar en el atlas. */
function keyOf(s: SignFace): string {
  return JSON.stringify([s.text, s.size, s.background, s.color, s.font ?? '', s.weight ?? 0, s.italic ?? false, s.fill ?? 0, s.depth === 0]);
}

/**
 * Atlas de letreros: cada letrero distinto se dibuja una vez en un lienzo (letras centradas,
 * angostadas si no entran) y se empaca por hileras. El color va en rgb; en el alfa, cuánto se
 * enciende de noche (las letras enteras; el fondo, `backgroundGlow` si el letrero tiene caja y
 * nada si son letras sueltas). Es una sola textura para
 * todos los monumentos: el dibujo `sign` (render/surfacePatterns.ts) la lee con las uv del
 * letrero.
 */
export class SignAtlas {
  readonly texture: THREE.DataTexture;
  private readonly rects = new Map<string, SignRect>();

  constructor(signs: readonly SignFace[], cfg: SignAtlasConfig) {
    const [W, maxH] = cfg.size;
    const unique = new Map<string, SignFace>();
    for (const s of signs) unique.set(keyOf(s), s);
    // Tamaño de cada uno en el atlas (con el tope, achicado parejo: las letras no se deforman) y
    // empacado por hileras (los más altos primero).
    const items = [...unique.entries()].map(([key, s]) => {
      const [w0, h0] = s.size.map((v) => v * cfg.pixelsPerMeter);
      const k = Math.min(1, cfg.maxPixels[0] / w0, cfg.maxPixels[1] / h0);
      return { key, s, w: Math.max(1, Math.round(w0 * k)), h: Math.max(1, Math.round(h0 * k)), x: 0, y: 0 };
    });
    items.sort((a, b) => b.h - a.h);
    const pad = cfg.padding;
    let x = pad;
    let y = pad;
    let row = 0;
    for (const it of items) {
      if (x + it.w + pad > W) {
        x = pad;
        y += row + pad;
        row = 0;
      }
      if (it.w + 2 * pad > W || y + it.h + pad > maxH) {
        throw new Error(`Los letreros no entran en el atlas de ${W}×${maxH} (config/game.json → monuments.signs.size)`);
      }
      it.x = x;
      it.y = y;
      x += it.w + pad;
      row = Math.max(row, it.h);
    }
    // El alto llega hasta la última hilera (sin letreros, un atlas mínimo: el material igual lo pide).
    const H = Math.max(1, y + row + pad);
    // Color en un lienzo y máscara de las letras en otro (sin alfa premultiplicado de por medio).
    const color = document.createElement('canvas');
    const mask = document.createElement('canvas');
    for (const c of [color, mask]) {
      c.width = W;
      c.height = H;
    }
    const cc = color.getContext('2d');
    const mc = mask.getContext('2d');
    if (!cc || !mc) throw new Error('Sin canvas 2D para el atlas de letreros');
    mc.fillStyle = '#000';
    mc.fillRect(0, 0, W, H);
    for (const it of items) {
      const s = it.s;
      // El fondo desborda hasta el borde del relleno: el mipmap no trae el color del vecino. En la
      // máscara, el fondo va con lo que se enciende (nada, si son letras sueltas).
      cc.fillStyle = s.background;
      cc.fillRect(it.x - pad / 2, it.y - pad / 2, it.w + pad, it.h + pad);
      const lit = Math.round((s.depth === 0 ? 0 : cfg.backgroundGlow) * 255);
      mc.fillStyle = `rgb(${lit}, ${lit}, ${lit})`;
      mc.fillRect(it.x - pad / 2, it.y - pad / 2, it.w + pad, it.h + pad);
      const px = Math.max(1, Math.round(it.h * (s.fill ?? cfg.fill)));
      const font = `${s.italic ? 'italic ' : ''}${s.weight ?? cfg.weight} ${px}px ${s.font ?? cfg.font}`;
      for (const [ctx, fill] of [
        [cc, s.color],
        [mc, '#fff'],
      ] as const) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(it.x, it.y, it.w, it.h);
        ctx.clip();
        ctx.font = font;
        ctx.fillStyle = fill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const room = it.w * (1 - 2 * cfg.margin);
        const width = ctx.measureText(s.text).width;
        const squeeze = width > room ? room / width : 1;
        ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
        ctx.scale(squeeze, 1);
        ctx.fillText(s.text, 0, 0);
        ctx.restore();
      }
      this.rects.set(it.key, [it.x / W, 1 - (it.y + it.h) / H, (it.x + it.w) / W, 1 - it.y / H]);
    }
    const rgb = cc.getImageData(0, 0, W, H).data;
    const m = mc.getImageData(0, 0, W, H).data;
    // Las filas del lienzo van de arriba abajo; las de la textura, de abajo arriba.
    const data = new Uint8Array(W * H * 4);
    for (let r = 0; r < H; r++) {
      const src = r * W * 4;
      const dst = (H - 1 - r) * W * 4;
      for (let k = 0; k < W * 4; k += 4) {
        data[dst + k] = rgb[src + k];
        data[dst + k + 1] = rgb[src + k + 1];
        data[dst + k + 2] = rgb[src + k + 2];
        data[dst + k + 3] = m[src + k];
      }
    }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = cfg.anisotropy;
    t.needsUpdate = true;
    this.texture = t;
  }

  /** Las uv de un letrero (tiene que haber estado en la lista del atlas). */
  rect(s: SignFace): SignRect {
    const r = this.rects.get(keyOf(s));
    if (!r) throw new Error(`Letrero sin lugar en el atlas: ${s.text}`);
    return r;
  }
}
