/**
 * Contrato del formato de edificios entre el pipeline (pipeline/build_world.py, pasos
 * `buildings`, `roofs` y `shops`), el worker que arma la geometría y el shader de fachadas.
 * Vive aparte del worker para poder importarlo desde el hilo principal sin cargar el worker.
 */

/**
 * Estilo de fachada (canal alfa del atributo aTint). `stand` = fila de gradería de un estadio
 * (lista "g" de cada chunk del pipeline): concreto sin ventanas y, arriba, la foto de los asientos.
 */
export const BUILDING_STYLE = { low: 0, high: 1, glass: 2, house: 3, fixture: 4, industrial: 5, stand: 6 } as const;

/**
 * Bandera sumada al estilo (canal alfa de aTint) de los edificios con portal: la planta baja
 * es una galería techada con columnas, como en el centro de Guayaquil.
 */
export const PORTAL_FLAG = 16;

/** Tipo de techo en la lista "r" de cada chunk del pipeline (la losa plana no se lista). */
export const ROOF_KIND = { flat: 0, gable: 1, hip: 2 } as const;

/**
 * Superficie en el atributo aFacade.w (parte entera): muro, techo (foto satelital) o remate del
 * techo (alero, canto). La parte fraccionaria (0 ≤ f < SEED_SPAN) lleva, sin otro atributo, el
 * registro de locales del edificio en la tabla de su chunk (0 = sin locales, ver SHOP_TABLE) y su
 * azar, con el que elige ventanas, locales y cortinas: f = SEED_SPAN·(registro + q/SEED_STEPS) /
 * SHOP_RECORDS, con q entero. Todo son potencias de 2 y caben en los 24 bits de un float32: en los
 * muros (parte entera 0) el valor es exacto y el shader lo lee sin interpolar (varying `flat`).
 */
export const SURFACE = { wall: 0, roof: 1, trim: 2 } as const;
export const SEED_SPAN = 0.5;
export const SHOP_RECORDS = 4096;
export const SEED_STEPS = 4096;

/**
 * Locales comerciales (paso `shops` del pipeline): cada edificio de la lista "s" de un chunk trae
 * SHOP_FIELDS valores (índice en "b", comercial 0/1, tipo A, tipo B y parte de A en % de los
 * locales genéricos) y después SHOP_NAMED_FIELDS por negocio (x, z, tipo e índice de su letrero
 * en la lista "sn"). Los tipos son índices de manifest.shops.kinds.
 */
export const SHOP_FIELDS = 5;
export const SHOP_NAMED_FIELDS = 4;

/**
 * Tabla de locales de un chunk (textura RGBA16UI de `width` texels de ancho, la arma el worker).
 * Texel r (1 ≤ r < SHOP_RECORDS): cabecera del edificio r = (primer texel de sus crujías, cuántas
 * son + `full` si todas son locales (0 crujías = todas locales genéricos), ancho de una crujía en
 * cm, tipos de los genéricos: A + B·2^kindBits + parte de A (0…shareSteps)·2^(2·kindBits)).
 * Crujía = (código: `none` sin local, `generic` o `named` + tipo, primer texel del letrero, cuántas
 * letras, variante del letrero). Letreros: `glyphs` letras por texel, un byte cada una (la menor,
 * la primera), índices de la fuente de config/game.json → shops.font.
 */
export const SHOP_TABLE = {
  width: 256,
  full: 0x8000,
  kindBits: 5,
  shareSteps: 31,
  glyphs: 8,
  bay: { none: 0, generic: 1, named: 2 },
} as const;

/** Tipos de los locales genéricos (A, B y parte de A, 0…1) empacados como en la cabecera. */
export function packShopMix(kindA: number, kindB: number, shareA: number): number {
  const steps = SHOP_TABLE.shareSteps;
  const share = Math.min(steps, Math.max(0, Math.round(shareA * steps)));
  return kindA | (kindB << SHOP_TABLE.kindBits) | (share << (2 * SHOP_TABLE.kindBits));
}

/**
 * Floats por edificio en los datos de colisión:
 * y0, y1, minX, maxX, minZ, maxZ, tipo de techo, cx, cz, ax, az, W, L, pendiente, alero.
 * (cx, cz) centro del techo, (ax, az) dirección de la cumbrera, W y L medio ancho y medio
 * largo del techo, alero = altura del borde del techo.
 */
export const META_STRIDE = 15;
