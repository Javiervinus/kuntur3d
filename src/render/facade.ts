import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { SEED_SPAN, SHOP_RECORDS, SHOP_TABLE, packShopMix } from '../world/buildingFormat';
import { lighting } from './lightingUniforms';

type FacadeConfig = GameConfig['buildings']['facade'];
type ShopConfig = FacadeConfig['shops'];

const palette = (list: string[]): THREE.Color[] => list.map((hex) => new THREE.Color(hex));
const GRAY = new THREE.Color(1, 1, 1);
const luma = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const mean = (list: THREE.Color[]): THREE.Color =>
  list.reduce((sum, c) => sum.add(c), new THREE.Color(0, 0, 0)).multiplyScalar(1 / Math.max(list.length, 1));

/** Filas y columnas de cada letra de la fuente de los letreros (config → shops.font). */
const GLYPH_ROWS = 5;
const GLYPH_COLUMNS = 5;
/** Columnas de cada letra en el letrero: las de la letra y una de espacio. */
const GLYPH_CELL = GLYPH_COLUMNS + 1;

/** Cómo es el frente de un local abierto y qué se ve adentro (config → shops.kinds[*].interior). */
const SHOP_INTERIOR: Record<string, number> = { shelves: 0, counter: 1, desk: 2 };

/**
 * Letras de la fuente de los letreros, en el orden de sus índices (el de config → shops.font): los
 * letreros con nombre de cada chunk los guardan así (ver buildingWorker.ts).
 */
export function signLetters(shops: ShopConfig): string[] {
  return Object.keys(shops.font);
}

/** Letras de los letreros ya armadas (una sola textura para todos los materiales de edificios). */
const signTexts = new WeakMap<object, { texture: THREE.DataTexture; mean: number; rows: number[][] }>();

/**
 * Fuente y palabras genéricas de los letreros (config → shops.font y shops.kinds[*].words) en una
 * textura de enteros: en la fila 0, cada letra de la fuente como máscara de 5×5 bits (bit fila·5 +
 * columna, fila 0 arriba); en la fila 1 + k, la palabra k: su largo y el índice de cada letra (las
 * de cada tipo de local, seguidas). Además, cuánto del letrero cubren las letras en promedio (lo que
 * se ve de lejos) y, por tipo, su primera fila y cuántas palabras tiene.
 */
function signText(shops: ShopConfig): { texture: THREE.DataTexture; mean: number; rows: number[][] } {
  const cached = signTexts.get(shops);
  if (cached) return cached;
  const font = shops.font as Record<string, string[]>;
  const letters = signLetters(shops);
  const words = shops.kinds.flatMap((kind) => kind.words);
  const empty = shops.kinds.find((kind) => kind.words.length === 0);
  if (empty) throw new Error(`shops.kinds["${empty.id}"].words en config/game.json no tiene palabras`);
  const width = Math.max(letters.length, 1 + Math.max(...words.map((w) => [...w].length)));
  const data = new Uint32Array(width * (1 + words.length));
  const bits = letters.map((ch, i) => {
    const rows = font[ch];
    if (rows.length !== GLYPH_ROWS || rows.some((r) => r.length !== GLYPH_COLUMNS)) {
      throw new Error(`Letra "${ch}" de shops.font en config/game.json: debe ser de ${GLYPH_COLUMNS}×${GLYPH_ROWS}`);
    }
    let mask = 0;
    let on = 0;
    rows.forEach((row, r) => {
      for (let c = 0; c < GLYPH_COLUMNS; c++) {
        if (row[c] !== '.') {
          mask |= 1 << (r * GLYPH_COLUMNS + c);
          on++;
        }
      }
    });
    data[i] = mask >>> 0;
    return on;
  });
  let covered = 0;
  let cells = 0;
  words.forEach((word, k) => {
    const row = (1 + k) * width;
    const chars = [...word];
    data[row] = chars.length;
    chars.forEach((ch, j) => {
      const index = letters.indexOf(ch);
      if (index < 0) throw new Error(`La palabra "${word}" de shops.kinds usa "${ch}", que no está en shops.font`);
      data[row + 1 + j] = index;
      covered += bits[index];
      cells += GLYPH_CELL * GLYPH_ROWS;
    });
  });
  let first = 1;
  const rows = shops.kinds.map((kind) => {
    const range = [first, kind.words.length];
    first += kind.words.length;
    return range;
  });
  const texture = new THREE.DataTexture(data, width, 1 + words.length, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  texture.internalFormat = 'R32UI';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const result = { texture, mean: covered / Math.max(cells, 1), rows };
  signTexts.set(shops, result);
  return result;
}

/** Tabla de locales vacía (1 texel en cero): la de los chunks sin locales. */
let emptyTable: THREE.DataTexture | null = null;

/**
 * Tabla de locales de un chunk (formato en buildingFormat.ts → SHOP_TABLE) como textura RGBA16UI;
 * sin datos, la tabla vacía compartida (no se libera).
 */
export function shopTableTexture(data: Uint16Array | null | undefined): THREE.DataTexture {
  if (!data || data.length === 0) {
    if (!emptyTable) emptyTable = shopTableTexture(new Uint16Array(SHOP_TABLE.width * 4));
    return emptyTable;
  }
  const rows = data.length / (4 * SHOP_TABLE.width);
  const texture = new THREE.DataTexture(data, SHOP_TABLE.width, rows, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
  texture.internalFormat = 'RGBA16UI';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** ¿Es la tabla vacía compartida? (esa no se libera con el chunk). */
export function isSharedShopTable(texture: THREE.Texture): boolean {
  return texture === emptyTable;
}

/** Índice de cada tipo de local de config → shops.kinds (por su id). */
export function shopKindIndex(shops: ShopConfig): Map<string, number> {
  if (shops.kinds.length >= 1 << SHOP_TABLE.kindBits) {
    throw new Error(`config/game.json → shops.kinds: a lo más ${(1 << SHOP_TABLE.kindBits) - 1} tipos`);
  }
  return new Map(shops.kinds.map((kind, k) => [kind.id, k]));
}

/** Uniformes del kit de fachadas (config/game.json → buildings.facade). */
export function facadeUniforms(cfg: FacadeConfig): Record<string, THREE.IUniform> {
  const w = cfg.windows;
  const r = cfg.rooms;
  const c = cfg.curtains;
  const s = cfg.shops;
  const a = cfg.ac;
  const g = cfg.grime;
  const b = cfg.bars;
  const cw = cfg.curtainWall;
  const pt = cfg.portales;
  const text = signText(s);
  // Letreros: la paleta de cada tipo, seguidas; por tipo, dónde empieza la suya y sus palabras.
  const signs = s.kinds.flatMap((kind) => palette(kind.signs));
  let firstSign = 0;
  const kindSigns = s.kinds.map((kind, k) => {
    if (kind.signs.length === 0) throw new Error(`shops.kinds["${kind.id}"].signs en config/game.json está vacío`);
    const v = new THREE.Vector4(firstSign, kind.signs.length, text.rows[k][0], text.rows[k][1]);
    firstSign += kind.signs.length;
    return v;
  });
  const interior = (kind: ShopConfig['kinds'][number]): number => {
    const code = SHOP_INTERIOR[kind.interior];
    if (code === undefined) throw new Error(`shops.kinds["${kind.id}"].interior en config/game.json: "${kind.interior}"`);
    return code;
  };
  const kinds = shopKindIndex(s);
  const fallback = s.fallback.kinds.map((id) => {
    const k = kinds.get(id);
    if (k === undefined) throw new Error(`config/game.json → shops.fallback.kinds: no hay un tipo "${id}"`);
    return k;
  });
  const goods = palette(s.goods.colors).map((col) => col.lerp(GRAY.clone().multiplyScalar(luma(col)), s.goods.muted));
  return {
    uFacWin: { value: new THREE.Vector4(w.width, w.height, w.sill, w.frame) },
    uFacWin2: { value: new THREE.Vector4(w.mullionMinWidth, w.ledge, w.slabBand, w.slabShade) },
    uFacWin3: { value: new THREE.Vector3(w.missing, w.door[0], w.door[1]) },
    uFacFrames: { value: palette(w.frameColors) },
    uFacDoor: { value: new THREE.Color(w.doorColor) },
    uFacRoom: { value: new THREE.Vector4(r.depth[0], r.depth[1], r.daylight, r.backShade) },
    uFacRoomWalls: { value: palette(r.walls) },
    uFacRoomFloors: { value: palette(r.floors) },
    uFacRoomCeiling: { value: new THREE.Color(r.ceiling) },
    uFacCurtain: { value: new THREE.Vector4(c.probability, c.cover[0], c.cover[1], c.glow) },
    uFacCurtains: { value: palette(c.colors) },
    uFacShop: { value: new THREE.Vector4(s.height, s.signHeight, s.shutterBox, s.vacant) },
    uFacShop2: { value: new THREE.Vector4(s.pillar, s.rib, s.textShare, s.textHeight) },
    uFacShop3: { value: new THREE.Vector4(s.letter, s.signGlow, s.glow, s.depth) },
    uFacShopWidth: { value: new THREE.Vector2(s.width[0], s.width[1]) },
    uFacText: { value: text.texture },
    uFacTextLook: { value: new THREE.Vector2(text.mean, s.letterStretch) },
    uFacShutter: { value: new THREE.Color(s.shutter) },
    uFacCounter: { value: new THREE.Vector2(s.interiors.counter.height, s.interiors.desk.height) },
    uFacCounterColor: { value: new THREE.Color(s.interiors.counter.color) },
    uFacDeskColor: { value: new THREE.Color(s.interiors.desk.color) },
    uShopSigns: { value: signs },
    uShopSignsMean: { value: mean(signs) },
    uShopKind: { value: kindSigns },
    uShopHours: { value: s.kinds.map((kind) => new THREE.Vector4(kind.open[0], kind.open[1], kind.close[0], kind.close[1])) },
    uShopLook: { value: s.kinds.map((kind) => new THREE.Vector4(kind.openFront, interior(kind), kind.allDay, kind.signLit)) },
    uShopLight: {
      value: s.kinds.map((kind) => {
        const light = new THREE.Color(kind.light);
        return new THREE.Vector4(light.r, light.g, light.b, kind.signLate);
      }),
    },
    uShopFallback: { value: packShopMix(fallback[0], fallback[1] ?? fallback[0], s.fallback.share) },
    uShopHour: lighting.uShopHour,
    uFacShopGoods: { value: new THREE.Vector4(s.goods.shelf, s.goods.width, s.goods.fill, s.goods.tubes) },
    uFacGoodsRun: { value: s.goods.run },
    uFacGoods: { value: goods },
    uFacGoodsMean: { value: mean(goods) },
    uFacAC: { value: new THREE.Vector4(a.probability, a.width, a.height, a.shadow) },
    uFacACFan: { value: a.fan },
    uFacACColor: { value: new THREE.Color(a.color) },
    uFacGrime: { value: new THREE.Vector4(g.streaks, g.streakLength, g.top, g.topLength) },
    uFacGrimeScale: { value: g.scale },
    uFacBars: { value: new THREE.Vector4(b.probability, b.spacing, b.width, b.floors) },
    uFacBarColor: { value: new THREE.Color(b.color) },
    uFacGlass: { value: new THREE.Vector4(cw.mullion, cw.mullionWidth, cw.spandrel, cw.interior) },
    uFacGlassRoom: { value: cw.roomBays },
    uFacGlassFrame: { value: new THREE.Color(cw.frame) },
    uFacSpandrel: { value: new THREE.Color(cw.spandrelColor) },
    uFacPortal: { value: new THREE.Vector4(pt.height, pt.beam, pt.column, pt.depth) },
    uFacPortal2: { value: new THREE.Vector4(pt.bay[0], pt.bay[1], pt.ceilingDrop, pt.tile) },
    uFacPortal3: { value: new THREE.Vector4(pt.shade, pt.lamp.glow, pt.lamp.radius, pt.plinthShade) },
    uFacPortalFloor: { value: new THREE.Color(pt.floor) },
    uFacPortalCeiling: { value: new THREE.Color(pt.ceiling) },
    uFacPortalLamp: { value: new THREE.Color(pt.lamp.color) },
    uFacPortalLight: { value: new THREE.Vector3(pt.lamp.light, pt.lamp.bounce, pt.lamp.lit) },
    uFacLod: {
      value: new THREE.Vector4(cfg.interiorFade[0], cfg.interiorFade[1], cfg.interiorGrazing[0], cfg.interiorGrazing[1]),
    },
    uFacDetail: { value: new THREE.Vector2(cfg.detailFade[0], cfg.detailFade[1]) },
  };
}

/**
 * Declaraciones y funciones del kit de fachadas. Necesita `gyeWindowLight` y los uniformes de
 * la luz de las ventanas (los declara el material de edificios) y la tabla de locales del chunk
 * (`uShopTable`, ver shopTableTexture).
 */
export function facadeParsGLSL(cfg: FacadeConfig): string {
  const s = cfg.shops;
  const shift = Math.log2(SHOP_TABLE.width);
  if (!Number.isInteger(shift)) throw new Error('SHOP_TABLE.width debe ser potencia de 2');
  return /* glsl */ `
#define GYE_SEED_SPAN ${SEED_SPAN.toFixed(4)}
#define GYE_SHOP_RECORDS ${SHOP_RECORDS.toFixed(1)}
#define GYE_SHOP_TABLE_MASK ${SHOP_TABLE.width - 1}u
#define GYE_SHOP_TABLE_SHIFT ${shift}u
#define GYE_SHOP_FULL ${SHOP_TABLE.full}u
#define GYE_SHOP_KIND_BITS ${SHOP_TABLE.kindBits}u
#define GYE_SHOP_KIND_MASK ${(1 << SHOP_TABLE.kindBits) - 1}u
#define GYE_SHOP_SHARE_STEPS ${SHOP_TABLE.shareSteps.toFixed(1)}
#define GYE_SHOP_GLYPHS ${SHOP_TABLE.glyphs}
#define GYE_BAY_NONE ${SHOP_TABLE.bay.none}u
#define GYE_BAY_GENERIC ${SHOP_TABLE.bay.generic}u
#define GYE_BAY_NAMED ${SHOP_TABLE.bay.named}u
#define GYE_SHOP_KINDS ${s.kinds.length}
#define GYE_SHOP_SIGNS ${s.kinds.reduce((n, kind) => n + kind.signs.length, 0)}
#define GYE_INTERIOR_COUNTER ${SHOP_INTERIOR.counter.toFixed(1)}
#define GYE_INTERIOR_DESK ${SHOP_INTERIOR.desk.toFixed(1)}
#define GYE_FAC_FRAMES ${cfg.windows.frameColors.length}
#define GYE_FAC_WALLS ${cfg.rooms.walls.length}
#define GYE_FAC_FLOORS ${cfg.rooms.floors.length}
#define GYE_FAC_CURTAINS ${cfg.curtains.colors.length}
#define GYE_FAC_GLYPH_ROWS ${GLYPH_ROWS}
#define GYE_FAC_GLYPH_COLUMNS ${GLYPH_COLUMNS}
#define GYE_FAC_GLYPH_CELL ${GLYPH_CELL}
#define GYE_FAC_GOODS ${s.goods.colors.length}
uniform vec4 uFacWin;
uniform vec4 uFacWin2;
uniform vec3 uFacWin3;
uniform vec3 uFacFrames[GYE_FAC_FRAMES];
uniform vec3 uFacDoor;
uniform vec4 uFacRoom;
uniform vec3 uFacRoomWalls[GYE_FAC_WALLS];
uniform vec3 uFacRoomFloors[GYE_FAC_FLOORS];
uniform vec3 uFacRoomCeiling;
uniform vec4 uFacCurtain;
uniform vec3 uFacCurtains[GYE_FAC_CURTAINS];
// Locales: alto, alto del letrero, alto de la cortina enrollada y parte de los genéricos
// desocupados; pilar, nervio de la cortina, ancho y alto del letrero que ocupan las letras; ancho
// máximo de una letra, brillo del letrero, de la vitrina y fondo del local. Ancho de las crujías
// (solo sin tabla).
uniform vec4 uFacShop;
uniform vec4 uFacShop2;
uniform vec4 uFacShop3;
uniform vec2 uFacShopWidth;
// Letreros: fuente y palabras genéricas (ver signText en render/facade.ts); cuánto los cubren las
// letras en promedio y alto máximo de un punto de letra respecto de su ancho.
uniform highp usampler2D uFacText;
uniform vec2 uFacTextLook;
uniform vec3 uFacShutter;
// Adentro de los locales de comida (mostrador) y de oficina (escritorio): alto y color.
uniform vec2 uFacCounter;
uniform vec3 uFacCounterColor;
uniform vec3 uFacDeskColor;
// Tabla de locales del chunk (formato en world/buildingFormat.ts → SHOP_TABLE).
uniform highp usampler2D uShopTable;
// Por tipo de local: primer color de su paleta y cuántos, primera fila de sus palabras genéricas y
// cuántas; horario (abre entre x e y, cierra entre z y w; más de 24 = después de medianoche);
// parte con el frente abierto (sin vidrio), interior, parte abierta todo el día y parte con el
// letrero iluminado; luz de adentro y parte de los letreros que siguen prendidos ya cerrado.
uniform vec3 uShopSigns[GYE_SHOP_SIGNS];
uniform vec3 uShopSignsMean;
uniform vec4 uShopKind[GYE_SHOP_KINDS];
uniform vec4 uShopHours[GYE_SHOP_KINDS];
uniform vec4 uShopLook[GYE_SHOP_KINDS];
uniform vec4 uShopLight[GYE_SHOP_KINDS];
// Tipos de los locales genéricos de un edificio sin tabla (empacados como en la cabecera).
uniform uint uShopFallback;
// Hora del mundo (0…24): qué locales están abiertos.
uniform float uShopHour;
uniform vec4 uFacShopGoods;
uniform vec3 uFacGoods[GYE_FAC_GOODS];
uniform vec3 uFacGoodsMean;
uniform float uFacGoodsRun;
uniform vec4 uFacAC;
uniform float uFacACFan;
uniform vec3 uFacACColor;
uniform vec4 uFacGrime;
uniform float uFacGrimeScale;
uniform vec4 uFacBars;
uniform vec3 uFacBarColor;
uniform vec4 uFacGlass;
uniform float uFacGlassRoom;
uniform vec3 uFacGlassFrame;
uniform vec3 uFacSpandrel;
// Portales: alto, viga, columna y fondo; vano mínimo y máximo, caída del cielo raso y baldosa;
// luz del día que llega adentro, brillo y radio de las lámparas, sombra del zócalo. De noche,
// cuánto alumbra cada lámpara el corredor, lo que rebota del piso al cielo raso y cuántas encienden.
uniform vec4 uFacPortal;
uniform vec4 uFacPortal2;
uniform vec4 uFacPortal3;
uniform vec3 uFacPortalFloor;
uniform vec3 uFacPortalCeiling;
uniform vec3 uFacPortalLamp;
uniform vec3 uFacPortalLight;
// Interiores: distancia a la que se desvanecen y ángulo (coseno con la normal) desde el que se ven.
uniform vec4 uFacLod;
uniform vec2 uFacDetail;
// Tres pseudoaleatorios en [0, 1) sin seno (Dave Hoskins): estables con índices grandes.
vec3 gyeFacHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float gyeFacNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gyeFacHash(i).x, gyeFacHash(i + vec2(1.0, 0.0)).x, f.x),
    mix(gyeFacHash(i + vec2(0.0, 1.0)).x, gyeFacHash(i + vec2(1.0, 1.0)).x, f.x),
    f.y
  );
}
// Cuánto del píxel (de ancho aa, centrado en x) cae en [lo, hi]: filtro de caja exacto.
float gyeSpan(float x, float lo, float hi, float aa) {
  return clamp((min(x + 0.5 * aa, hi) - max(x - 0.5 * aa, lo)) / aa, 0.0, 1.0);
}
float gyeRect(vec2 p, vec4 r, vec2 aa) { return gyeSpan(p.x, r.x, r.z, aa.x) * gyeSpan(p.y, r.y, r.w, aa.y); }
// Franjas de ancho w cada 'period' (barrotes, nervios), filtradas: de lejos, su promedio.
float gyeFacSum(float x, float period, float w) { return floor(x / period) * w + min(mod(x, period), w); }
float gyeStripes(float x, float period, float w, float aa) {
  return clamp((gyeFacSum(x + 0.5 * aa, period, w) - gyeFacSum(x - 0.5 * aa, period, w)) / aa, 0.0, 1.0);
}
// Cuarto falso detrás de una ventana (interior mapping): p = punto del vidrio en el cuarto (m,
// desde su esquina de abajo), d = dirección de la vista (x a lo largo del muro, y hacia
// arriba, z hacia adentro), room = ancho, alto y fondo. Devuelve el color de lo que se ve
// (pared del fondo, paredes, piso o cielo raso) y qué tan al fondo está (0..1); deja el punto
// visto en 'hit' y la cara en 'face' (GYE_FACE_*).
#define GYE_FACE_BACK 0.0
#define GYE_FACE_SIDE 1.0
#define GYE_FACE_FLOOR 2.0
#define GYE_FACE_CEILING 3.0
vec4 gyeRoom(vec2 p, vec3 d, vec3 room, vec3 rnd, out vec3 hit, out float face) {
  vec3 inv = 1.0 / max(abs(d), vec3(1e-4));
  float tx = (d.x > 0.0 ? room.x - p.x : p.x) * inv.x;
  float ty = (d.y > 0.0 ? room.y - p.y : p.y) * inv.y;
  float tz = room.z * inv.z;
  vec3 walls = uFacRoomWalls[int(rnd.x * float(GYE_FAC_WALLS))];
  vec3 c;
  float t;
  if (tz <= tx && tz <= ty) {
    t = tz;
    c = walls;
    face = GYE_FACE_BACK;
  } else if (tx <= ty) {
    t = tx;
    c = walls * 0.82;
    face = GYE_FACE_SIDE;
  } else if (d.y < 0.0) {
    t = ty;
    c = uFacRoomFloors[int(rnd.y * float(GYE_FAC_FLOORS))];
    face = GYE_FACE_FLOOR;
  } else {
    t = ty;
    c = uFacRoomCeiling;
    face = GYE_FACE_CEILING;
  }
  hit = vec3(p, 0.0) + d * t;
  return vec4(c, clamp(hit.z / room.z, 0.0, 1.0));
}
// Un local por dentro: tubos de luz en el techo y, en las paredes, estantes con mercadería
// (tiendas), un mostrador (comida, café, bar) o escritorios (bancos, salud, belleza). 'aa' es el
// ancho del píxel ya estirado a la profundidad del punto visto: lo que no alcanza a verse se
// promedia (sin centelleo).
vec3 gyeShopInside(vec3 c, vec3 hit, float face, vec3 rnd, float aa, float top, vec3 d, float interior) {
  // Vista de refilón: las paredes de los costados se comprimen a lo largo (más por píxel).
  float alongAA = face == GYE_FACE_SIDE ? aa * abs(d.z) / max(abs(d.x), 0.05) : aa;
  if (face == GYE_FACE_CEILING) {
    return mix(c, vec3(1.0), gyeStripes(hit.x + rnd.x, uFacShopGoods.w, uFacShopGoods.w * 0.08, aa) * 0.9);
  }
  if (face == GYE_FACE_FLOOR) return c;
  if (interior > GYE_INTERIOR_COUNTER - 0.5) {
    // Mostrador o escritorios: franja baja de otro color, con su canto claro.
    bool counter = interior < GYE_INTERIOR_DESK - 0.5;
    float h = counter ? uFacCounter.x : uFacCounter.y;
    vec3 band = counter ? uFacCounterColor : uFacDeskColor;
    float low = gyeSpan(hit.y, 0.0, h, aa);
    float edge = gyeSpan(hit.y, h - 0.05, h, aa);
    return mix(mix(c, band * (0.85 + 0.3 * rnd.z), low), band * 1.25, edge);
  }
  float along = face == GYE_FACE_BACK ? hit.x : hit.z;
  float shelf = gyeStripes(hit.y, uFacShopGoods.x, uFacShopGoods.x * 0.1, aa);
  // El mismo producto en tandas de varios; cada unidad con su brillo.
  float shelfRow = floor(hit.y / uFacShopGoods.x) + face * 13.0;
  vec3 g = gyeFacHash(vec2(floor(along / uFacShopGoods.y) + rnd.y * 71.0, shelfRow));
  vec3 kind = gyeFacHash(vec2(floor(along / (uFacShopGoods.y * uFacGoodsRun)) + rnd.z * 53.0, shelfRow));
  vec3 goods = uFacGoods[int(kind.x * float(GYE_FAC_GOODS))] * (0.8 + 0.35 * g.y);
  float blur = smoothstep(0.35, 0.8, alongAA / uFacShopGoods.y);
  goods = mix(goods, uFacGoodsMean, blur);
  float stocked = mix(step(g.z, uFacShopGoods.z), uFacShopGoods.z, blur) * step(hit.y, top);
  return mix(mix(c, goods, stocked), c * 0.55, shelf);
}
// Texel i de la tabla de locales del chunk.
uvec4 gyeShopTexel(uint i) {
  return texelFetch(uShopTable, ivec2(int(i & GYE_SHOP_TABLE_MASK), int(i >> GYE_SHOP_TABLE_SHIFT)), 0);
}
// La crujía sc de un edificio (cabecera hdr): código, primer texel del letrero, letras y variante.
uvec4 gyeShopBay(uvec4 hdr, float sc) {
  uint count = hdr.y & (GYE_SHOP_FULL - 1u);
  if (count == 0u) return uvec4(GYE_BAY_GENERIC, 0u, 0u, 0u);
  if (sc < 0.0 || sc >= float(count)) return uvec4(GYE_BAY_NONE);
  return gyeShopTexel(hdr.x + uint(sc));
}
// Letra 'li' de un letrero: de un negocio (tabla del chunk, desde el texel 'start') o de una
// palabra genérica (fila 'row' de uFacText).
uint gyeShopGlyph(bool named, uint start, int row, int li) {
  if (!named) return texelFetch(uFacText, ivec2(1 + li, row), 0).r;
  uvec4 t = gyeShopTexel(start + uint(li / GYE_SHOP_GLYPHS));
  int pair = (li % GYE_SHOP_GLYPHS) / 2;
  uint two = pair == 0 ? t.x : pair == 1 ? t.y : pair == 2 ? t.z : t.w;
  return (li % 2 == 0) ? (two & 255u) : (two >> 8u);
}
// Un local en (u, v) de un muro con locales de alto shopH y crujías de ancho shopW: pilares,
// letrero (el nombre del negocio o una palabra de su tipo) y cortina metálica, frente abierto o
// vitrina con el local adentro, según su tipo y su horario. 'bay' = la crujía (ver gyeShopBay) y
// 'mixBits' = los tipos de los genéricos. Pinta sobre c (el muro), suma la luz del local (glow) y la
// del letrero de noche (night) y deja en glassM cuánto es vidrio. camDist: distancia de la cámara
// al punto visto (lo de adentro se filtra según ella).
void gyeShop(
  float u, float v, float shopH, float shopW, uvec4 bay, uint mixBits, vec2 fw, float bseed, float style,
  vec3 dirTS, float rooms, vec3 farRoom, bool nightOn, float camDist,
  inout vec3 c, inout vec3 glow, inout vec3 night, inout float glassM
) {
  float sc = floor(u / shopW);
  float su = u - sc * shopW;
  vec3 sr = gyeFacHash(vec2(sc + bseed * 97.0, style + 3.0));
  vec3 sq = gyeFacHash(vec2(sc + bseed * 59.0, style + 23.0));
  // Si un píxel abarca varios locales (de lejos o de refilón), lo que cada uno elige al azar
  // (color del letrero, cortina o vitrina) se promedia: si no, centellea.
  float many = smoothstep(0.3, 0.8, fw.x / shopW);
  float pil = uFacShop2.x * 0.5;
  float signTop = shopH - 0.15;
  float signBot = signTop - uFacShop.y;
  float board = gyeRect(vec2(su, v), vec4(pil, signBot, shopW - pil, signTop), fw);
  float front = gyeRect(vec2(su, v), vec4(pil + 0.08, 0.0, shopW - pil - 0.08, signBot - 0.12), fw);
  // Tipo: el del negocio o, en los genéricos, uno de los dos de su cuadra.
  bool named = bay.x >= GYE_BAY_NAMED;
  float shareA = float(mixBits >> (2u * GYE_SHOP_KIND_BITS)) / GYE_SHOP_SHARE_STEPS;
  uint pick = sq.x < shareA ? mixBits : mixBits >> GYE_SHOP_KIND_BITS;
  int kind = min(int(named ? bay.x - GYE_BAY_NAMED : pick & GYE_SHOP_KIND_MASK), GYE_SHOP_KINDS - 1);
  vec4 look = uShopLook[kind];
  vec4 hours = uShopHours[kind];
  // Abierto entre su hora de abrir y la de cerrar (cada local la suya, dentro de las de su tipo;
  // un cierre después de medianoche pasa de 24); algunos, todo el día. Los genéricos desocupados
  // (y las crujías de un portal sin local) tienen la cortina siempre abajo.
  float openAt = mix(hours.x, hours.y, sq.y);
  float closeAt = mix(hours.z, hours.w, sq.z);
  bool open = (uShopHour >= openAt && uShopHour < closeAt) || uShopHour + 24.0 < closeAt || fract(sr.x * 3.71) < look.z;
  if (!named && (bay.x == GYE_BAY_NONE || fract(sr.x * 5.37) < uFacShop.w)) open = false;
  // Letrero: los de un mismo negocio (cadena) comparten color; los genéricos, al azar.
  vec4 kr = uShopKind[kind];
  float variant = named ? fract(float(bay.w) * 0.6180339) : sr.y;
  vec3 signC = mix(uShopSigns[int(kr.x) + min(int(variant * kr.y), int(kr.y) - 1)], uShopSignsMean, many);
  // Letras: el nombre del negocio o una palabra de su tipo (FARMACIA, CEVICHERIA…) en la fuente de
  // los letreros, centradas; del ancho que quepa y, si son muchas, también más bajas (no se
  // estiran más de uFacTextLook.y). De lejos, su promedio.
  int row = int(kr.z) + min(int(sr.z * kr.w), int(kr.w) - 1);
  int letters = max(named ? int(bay.z) : int(texelFetch(uFacText, ivec2(0, row), 0).r), 1);
  float lw = min(uFacShop3.x, (shopW - 2.0 * pil) * uFacShop2.z / float(letters));
  vec2 cellSize = vec2(lw / float(GYE_FAC_GLYPH_CELL), 0.0);
  cellSize.y = min(uFacShop.y * uFacShop2.w / float(GYE_FAC_GLYPH_ROWS), cellSize.x * uFacTextLook.y);
  float textW = lw * float(letters);
  float textH = cellSize.y * float(GYE_FAC_GLYPH_ROWS);
  vec2 tp = vec2(su - 0.5 * (shopW - textW), v - 0.5 * (signBot + signTop - textH));
  vec2 gpix = floor(tp / cellSize);
  float glyph = 0.0;
  if (gpix.x >= 0.0 && gpix.y >= 0.0 && gpix.y < float(GYE_FAC_GLYPH_ROWS) && tp.x < textW) {
    int letter = int(gpix.x) / GYE_FAC_GLYPH_CELL;
    int col = int(gpix.x) - letter * GYE_FAC_GLYPH_CELL;
    // (letter < letters: por redondeo, el borde derecho puede caer en la celda siguiente)
    if (col < GYE_FAC_GLYPH_COLUMNS && letter < letters) {
      uint glyphIndex = gyeShopGlyph(named, bay.y, row, letter);
      uint mask = texelFetch(uFacText, ivec2(int(glyphIndex), 0), 0).r;
      // Fila 0 de la letra = la de arriba.
      int gr = GYE_FAC_GLYPH_ROWS - 1 - int(gpix.y);
      glyph = float((mask >> uint(gr * GYE_FAC_GLYPH_COLUMNS + col)) & 1u);
    }
  }
  glyph = mix(uFacTextLook.x, glyph, 1.0 - smoothstep(0.35, 0.7, fw.x / cellSize.x));
  glyph *= gyeRect(tp, vec4(0.0, 0.0, textW, textH), fw);
  vec3 textC = dot(signC, vec3(0.2126, 0.7152, 0.0722)) > 0.35 ? vec3(0.06) : vec3(0.92);
  signC = mix(signC, textC, glyph);
  if (!open) {
    float rib = gyeStripes(v, uFacShop2.y, uFacShop2.y * 0.35, fw.y);
    c = mix(c, uFacShutter * (0.85 + 0.3 * sr.z) * (1.0 - 0.12 * rib), front);
  } else if (front > 0.0) {
    vec3 room = vec3(shopW - 2.0 * pil, signBot, uFacShop3.w * (0.7 + 0.6 * sr.y));
    vec3 hitP;
    float face;
    vec4 hit = rooms > 0.0 ? gyeRoom(vec2(su - pil, v), dirTS, room, sr, hitP, face) : vec4(farRoom, 0.5);
    // El píxel visto adentro es más grande: crece con lo que el rayo recorre en el local.
    float aaIn = max(fw.x, fw.y) * (1.0 + length(hitP - vec3(su - pil, v, 0.0)) / max(camDist, 1.0));
    vec3 inside = rooms > 0.0 ? gyeShopInside(hit.rgb, hitP, face, sr, aaIn, room.y - uFacShopGoods.x, dirTS, look.y) : farRoom;
    vec3 roomC = mix(farRoom, inside * (1.0 - 0.3 * hit.a), rooms);
    glow = roomC * uShopLight[kind].rgb * uFacShop3.z * front;
    c = mix(c, uWindowColor, front);
    if (fract(variant * 7.13 + sr.z) < look.x) {
      // Frente abierto (ferretería, taller, tienda de barrio): sin vidrio, con la cortina
      // metálica enrollada arriba.
      float box = gyeRect(vec2(su, v), vec4(pil + 0.08, signBot - 0.12 - uFacShop.z, shopW - pil - 0.08, signBot - 0.12), fw);
      float rib = gyeStripes(v, uFacShop2.y, uFacShop2.y * 0.35, fw.y);
      c = mix(c, uFacShutter * (1.0 - 0.12 * rib), box);
      glow *= 1.0 - box;
    } else {
      glassM = front * 0.8;
    }
  }
  c = mix(c, mix(uFacShutter, uWindowColor, 0.5), many * front);
  glow *= 1.0 - many;
  c = mix(c, signC, board);
  // De noche alumbran los letreros iluminados mientras el local atiende (y algunos después).
  float lit = open ? look.w : look.w * uShopLight[kind].w;
  if (nightOn) night += signC * board * uFacShop3.y * mix(step(fract(sr.x * 9.73), lit), lit, many);
}
// Si la lámpara del vano b de un portal enciende (alguna está quemada).
float gyePortalLamp(float b, float bseed) {
  return step(gyeFacHash(vec2(b + bseed * 131.0, 29.0)).x, uFacPortalLight.z);
}`;
}

/**
 * Fachada procedural de un muro (edificios bajos, torres, muros cortina y casas): pisos con
 * losa a la vista, ventanas con marco, repisa y parteluz, un cuarto detrás de cada vidrio
 * (interior mapping), cortinas, rejas en los pisos bajos, aires acondicionados, locales en
 * la planta baja (letrero con su nombre, cortina metálica, frente abierto o vitrina iluminada)
 * donde el paso `shops` los puso, o portal (galería con columnas y los locales al fondo,
 * alumbrada de noche por sus lámparas), puerta, pretil y el chorreado de la humedad bajo las
 * repisas y desde el pretil. Todo filtrado por el ancho del píxel (sin centelleo de lejos). Espera
 * en el ámbito: wall, style, tall, glassy, house, portal y vFacadeSeed (aFacade.w sin interpolar);
 * deja gyeGlass (vidrio), gyeHole (hueco, sin brillo de fachada), gyeLit (luz de noche), gyeInside
 * (lo que se ve adentro, con la luz del día) y gyeGlow (locales encendidos).
 */
export const FACADE_MAIN = /* glsl */ `
{
  float u = vFacade.x;
  float v = vFacade.y;
  float h = vFacade.z;
  // Registro de locales y azar del edificio (ver buildingFormat.ts → SURFACE): exactos, son
  // potencias de 2 en un float32 que llega sin interpolar.
  float seedRecord = vFacadeSeed * (GYE_SHOP_RECORDS / GYE_SEED_SPAN);
  float record = floor(seedRecord);
  float bseed = seedRecord - record;
  vec3 br = gyeFacHash(vec2(bseed * 1013.0, style * 17.0 + 3.0));
  vec2 fw = max(fwidth(vec2(u, v)), vec2(1e-3));
  // Marco del muro: normal hacia la cámara, a lo largo del muro (+u) y arriba (+v). Se deriva
  // en el espacio de la cámara (números chicos cerca de ella) y se lleva al del mundo: con las
  // coordenadas del mundo (miles de metros) la derivada de un píxel cercano (milímetros) es
  // puro redondeo, y el cuarto falso, que agranda cualquier error con su fondo, se llena de ruido.
  vec3 pdx = (vec4(dFdx(-vViewPosition), 0.0) * viewMatrix).xyz;
  vec3 pdy = (vec4(dFdy(-vViewPosition), 0.0) * viewMatrix).xyz;
  vec3 nW = normalize(cross(pdx, pdy));
  vec3 tW = cross(vec3(0.0, 1.0, 0.0), nW);
  float tLen = length(tW);
  tW = tLen > 1e-4 ? tW / tLen : vec3(1.0, 0.0, 0.0);
  if (dFdx(u) * dot(pdx, tW) + dFdy(u) * dot(pdy, tW) < 0.0) tW = -tW;
  vec3 eye = normalize((vec4(-vViewPosition, 0.0) * viewMatrix).xyz);
  vec3 dirTS = vec3(dot(eye, tW), eye.y, max(-dot(eye, nW), 1e-3));
  // Los cuartos se ven de cerca; de lejos, su color promedio (y nada que calcular). Los detalles
  // chicos (repisas, aires, rejas, cortinas, chorreado) se apagan cuando el píxel ya los tapa.
  // De refilón, lo de adentro cabe en muy pocos píxeles (centellearía): también su promedio.
  float rooms = (1.0 - smoothstep(uFacLod.x, uFacLod.y, length(vWorld - cameraPosition))) * smoothstep(uFacLod.z, uFacLod.w, dirTS.z);
  float detail = 1.0 - smoothstep(uFacDetail.x, uFacDetail.y, max(fw.x, fw.y));
  vec3 farRoom = uFacRoomWalls[0] * (1.0 - 0.5 * uFacRoom.w);

  vec3 c = wall * (0.96 + 0.08 * br.x);
  float glassM = 0.0;
  vec3 inside = vec3(0.0);
  vec3 night = vec3(0.0);
  vec3 glow = vec3(0.0);
  bool nightOn = uWindowGlow > 0.0;
  float floorH = uFloorH * (0.94 + 0.12 * br.y);
  // Locales en la planta baja solo donde el paso shops los puso (registro > 0). Si todas las
  // crujías son locales, la planta baja es más alta y los pisos van encima; si solo algunas
  // (un negocio en una cuadra residencial), el local ocupa el primer piso y las otras crujías son
  // un piso más, con su ventana o su puerta.
  bool shops = record > 0.5;
  uvec4 shopHdr = shops ? gyeShopTexel(uint(record)) : uvec4(0u, 0u, 0u, uShopFallback);
  bool fullShops = shops && ((shopHdr.y & (GYE_SHOP_FULL - 1u)) == 0u || (shopHdr.y & GYE_SHOP_FULL) != 0u);
  float shopW = shops ? float(shopHdr.z) * 0.01 : mix(uFacShopWidth.x, uFacShopWidth.y, br.x);
  float shopH = !shops ? 0.0 : fullShops ? min(uFacShop.x, h - 0.5) : min(floorH, house ? h : h - 0.5);
  // Con portal, la planta baja es una galería más alta que un local.
  float portalH = portal ? min(uFacPortal.x, h - 0.5) : 0.0;
  float baseH = max(fullShops ? shopH : 0.0, portalH);
  uvec4 bayData = v < shopH ? gyeShopBay(shopHdr, floor(u / shopW)) : uvec4(GYE_BAY_NONE);
  bool shopBay = bayData.x != GYE_BAY_NONE;

  if (glassy && !shopBay) {
    // Muro cortina: parteluces, antepecho opaco en cada losa y oficinas detrás.
    float mw = uFacGlass.x;
    float fl = floor(v / floorH);
    float fv = v - fl * floorH;
    float mu = u - floor(u / mw) * mw;
    float halfM = uFacGlass.y * 0.5;
    float spandrel = gyeSpan(fv, 0.0, uFacGlass.z, fw.y);
    float pane = gyeSpan(mu, halfM, mw - halfM, fw.x) * gyeSpan(fv, uFacGlass.z + halfM, floorH - halfM, fw.y);
    c = mix(uFacGlassFrame, uFacSpandrel, spandrel);
    c = mix(c, uGlassColor, pane);
    glassM = max(pane, spandrel * 0.7);
    if (pane > 0.0) {
      float roomW = mw * uFacGlassRoom;
      float rc = floor(u / roomW);
      vec3 rr = gyeFacHash(vec2(rc + bseed * 97.0, fl + 5.0));
      vec3 room = vec3(roomW, floorH, mix(uFacRoom.x, uFacRoom.y, rr.y));
      vec3 hitP;
      float face;
      vec4 hit = rooms > 0.0 ? gyeRoom(vec2(u - rc * roomW, fv), dirTS, room, rr, hitP, face) : vec4(farRoom, 0.5);
      vec3 roomC = mix(farRoom, hit.rgb * (1.0 - uFacRoom.w * hit.a), rooms);
      inside = roomC * pane * uFacGlass.w;
      if (nightOn) night = roomC * gyeWindowLight(vec2(rc + bseed * 97.0, fl), uWindowLit) * pane * (1.0 - 0.4 * hit.a);
    }
  } else if (v < portalH) {
    // Portal: galería techada (columnas y viga al frente; por el vano, el corredor con su piso,
    // su cielo raso con lámparas y los locales en el muro del fondo). Lo de adentro está a la
    // sombra: se ve con una parte de la luz del día (como los cuartos) y con sus lámparas.
    float bay = mix(uFacPortal2.x, uFacPortal2.y, br.y);
    float bu = u - floor(u / bay) * bay;
    float halfCol = uFacPortal.z * 0.5;
    float beamBot = portalH - uFacPortal.y;
    float open = gyeSpan(bu, halfCol, bay - halfCol, fw.x) * gyeSpan(v, 0.0, beamBot, fw.y);
    gyeHole = open;
    c *= mix(1.0, uFacPortal3.w, gyeSpan(v, 0.0, uFacPortal.y, fw.y) * (1.0 - open));
    if (open > 0.0) {
      float ceilH = portalH - uFacPortal2.z;
      float depth = uFacPortal.w;
      float tb = depth / dirTS.z;
      float tf = dirTS.y < 0.0 ? v / -dirTS.y : 1e9;
      float tc = dirTS.y > 0.0 ? (ceilH - v) / dirTS.y : 1e9;
      float t = min(tb, min(tf, tc));
      vec3 hitP = vec3(u, v, 0.0) + dirTS * t;
      float camDist = length(vWorld - cameraPosition);
      // El píxel visto adentro es más grande: crece con lo que el rayo recorre.
      vec2 fwIn = fw * (1.0 + t / max(camDist, 1.0));
      vec3 seen = wall * 0.92;
      vec3 seenGlow = vec3(0.0);
      vec3 seenNight = vec3(0.0);
      float seenGlass = 0.0;
      float back = clamp(hitP.z / depth, 0.0, 1.0);
      float lampBay = floor(hitP.x / bay);
      if (t == tb) {
        // Los locales del fondo: los de la tabla del edificio (o genéricos, si no tiene). (Medido:
        // juntar esta llamada y la del frente en una sola sale más caro, no más barato.)
        uvec4 backBay = gyeShopBay(shopHdr, floor(hitP.x / shopW));
        gyeShop(hitP.x, hitP.y, ceilH, shopW, backBay, shopHdr.w, fwIn, bseed, style, dirTS, rooms, farRoom, nightOn,
          camDist + t, seen, seenGlow, seenNight, seenGlass);
      } else if (t == tf) {
        float joints = max(gyeStripes(hitP.x, uFacPortal2.w, uFacPortal2.w * 0.06, fwIn.x),
          gyeStripes(hitP.z, uFacPortal2.w, uFacPortal2.w * 0.06, fwIn.x));
        seen = uFacPortalFloor * (1.0 - 0.2 * joints * rooms) * (1.0 - 0.3 * back);
      } else {
        // Una lámpara en el medio de cada vano.
        vec2 lampAt = vec2((lampBay + 0.5) * bay, depth * 0.5);
        float lamp = 1.0 - smoothstep(uFacPortal3.z - fwIn.x, uFacPortal3.z + fwIn.x, length(hitP.xz - lampAt));
        seen = mix(uFacPortalCeiling * (1.0 - 0.35 * back), uFacPortalLamp, lamp);
        if (nightOn) seenNight += uFacPortalLamp * uFacPortal3.y * lamp * gyePortalLamp(lampBay, bseed);
      }
      // De noche, las lámparas alumbran el corredor: paneles que dan hacia abajo (I·cos de la
      // lámpara·cos de la superficie/d²), la del vano y la del vecino más cercano. El cielo raso
      // no les ve la cara: recibe lo que rebota del piso.
      if (nightOn) {
        vec3 nrm = t == tb ? vec3(0.0, 0.0, -1.0) : t == tf ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0);
        float side = hitP.x < (lampBay + 0.5) * bay ? -1.0 : 1.0;
        float light = t == tc ? uFacPortalLight.y * gyePortalLamp(lampBay, bseed) : 0.0;
        for (int k = 0; k < 2; k++) {
          float b = lampBay + float(k) * side;
          vec3 l = vec3((b + 0.5) * bay, ceilH, depth * 0.5) - hitP;
          float d2 = max(dot(l, l), 0.25);
          light += gyePortalLamp(b, bseed) * uFacPortalLight.x * max(l.y, 0.0) * max(dot(nrm, l), 0.0) / (d2 * d2);
        }
        seenNight += seen * uFacPortalLamp * light;
      }
      // Emitido como los cuartos (gyeInside, que el material escala por uFacRoom.z): con la
      // fracción de luz del día que llega bajo el portal.
      inside += seen * open * uFacPortal3.x / max(uFacRoom.z, 1e-3);
      glow += seenGlow * open;
      night += seenNight * open;
      c = mix(c, vec3(0.0), open);
    }
  } else if (shopBay) {
    // Locales: pilares, letrero con letras, y cortina metálica, frente abierto o vitrina.
    gyeShop(u, v, shopH, shopW, bayData, shopHdr.w, fw, bseed, style, dirTS, rooms, farRoom, nightOn,
      length(vWorld - cameraPosition), c, glow, night, glassM);
  } else {
    // Pisos con ventanas: una por crujía, con marco, repisa y un cuarto detrás. En la planta baja
    // de un edificio con locales solo en algunas crujías, una ventana (o la puerta) centrada en
    // cada crujía de local: así ninguna queda cortada por un local vecino.
    bool ground = v < shopH;
    float vu = v - baseH;
    float fl = floor(vu / floorH);
    float fv = vu - fl * floorH;
    float storey = fl + (baseH > 0.0 ? 1.0 : 0.0);
    float bay = ground ? shopW : uWinW * (tall ? 1.0 : 0.85 + 0.3 * br.z);
    float cell = floor(u / bay);
    float fu = u - cell * bay;
    vec3 wr = gyeFacHash(vec2(cell + bseed * 311.0, fl + style * 7.0 + 1.0));
    float winW = min(bay * uFacWin.x * (tall ? 1.3 : house ? 0.85 : 1.0), bay - 0.5);
    if (ground) winW = min(winW, uWinW * uFacWin.x);
    float winH = uFacWin.y * (tall ? 1.3 : 1.0);
    float sill = uFacWin.z * (tall ? 0.6 : 1.0);
    vec4 wrect = vec4(0.5 * (bay - winW), sill, 0.5 * (bay + winW), sill + winH);
    float fits = step(baseH + fl * floorH + sill + winH + 0.35, h);
    // Casas y edificios bajos: la puerta en una crujía de la planta baja; alguna ventana ciega.
    float doorCell = step(abs(cell - floor(br.x * 3.0)), 0.5) * step(storey, 0.5) * (tall ? 0.0 : 1.0);
    float present = fits * step(uFacWin3.x * (tall ? 0.0 : 1.0), wr.x) * (1.0 - doorCell);
    vec2 wp = vec2(fu, fv);
    float fr = uFacWin.w;
    // Losa a la vista en cada piso y su sombra.
    c *= mix(1.0, uFacWin2.w, gyeSpan(fv, floorH - uFacWin2.z - 0.1, floorH - uFacWin2.z, fw.y));
    c = mix(c, c * 1.06, gyeSpan(fv, floorH - uFacWin2.z, floorH, fw.y));
    if (detail > 0.0) {
      vec3 base = c;
      // Repisa, su sombra y el chorreado de la lluvia debajo.
      vec4 ledgeR = vec4(wrect.x - 0.05, sill - uFacWin2.y, wrect.z + 0.05, sill);
      c = mix(c, c * 1.1, gyeRect(wp, ledgeR, fw) * present);
      c *= 1.0 - 0.18 * gyeRect(wp, vec4(ledgeR.x, ledgeR.y - 0.1, ledgeR.z, ledgeR.y), fw) * present;
      float drop = ledgeR.y - fv;
      float streak = gyeFacNoise(vec2(u * 6.0 / uFacGrimeScale, v * 0.25));
      c *= 1.0 - uFacGrime.x * gyeSpan(fu, wrect.x, wrect.z, fw.x) * present * step(0.0, drop) * streak * exp(-drop / uFacGrime.y);
      // Aire acondicionado al lado de la ventana (si hay espacio en la crujía), con su sombra.
      float side = wr.z < 0.5 ? -1.0 : 1.0;
      float acX = side > 0.0 ? wrect.z + 0.18 : wrect.x - 0.18 - uFacAC.y;
      float room = side > 0.0 ? bay - wrect.z : wrect.x;
      float hasAC = step(wr.y, uFacAC.x) * present * step(uFacAC.y + 0.3, room);
      vec4 acR = vec4(acX, sill - 0.25, acX + uFacAC.y, sill - 0.25 + uFacAC.z);
      float ac = gyeRect(wp, acR, fw) * hasAC;
      float fan = 1.0 - smoothstep(uFacACFan - fw.x, uFacACFan + fw.x, length(wp - vec2(acR.x + uFacAC.y * 0.62, acR.y + uFacAC.z * 0.5)));
      c *= 1.0 - (1.0 - uFacAC.w) * gyeRect(wp, vec4(acR.x, acR.y - 0.18, acR.z, acR.y), fw) * hasAC;
      c = mix(c, uFacACColor * (1.0 - 0.45 * fan), ac);
      // Puerta (madera o metal) en la planta baja.
      float door = gyeRect(wp, vec4(0.5 * (bay - uFacWin3.y), 0.0, 0.5 * (bay + uFacWin3.y), uFacWin3.z), fw) * doorCell * fits;
      c = mix(c, uFacDoor * (0.8 + 0.4 * br.y), door);
      c = mix(base, c, detail);
    }
    // Ventana: marco, parteluz si es ancha, vidrio y lo que se ve detrás.
    float opening = gyeRect(wp, wrect, fw) * present;
    float pane = gyeRect(wp, wrect + vec4(fr, fr, -fr, -fr), fw) * present;
    pane *= 1.0 - step(uFacWin2.x, winW) * gyeSpan(fu, 0.5 * (bay - fr), 0.5 * (bay + fr), fw.x);
    c = mix(c, uFacFrames[int(br.y * float(GYE_FAC_FRAMES))], opening);
    if (pane > 0.0) {
      vec3 roomSize = vec3(bay, floorH, mix(uFacRoom.x, uFacRoom.y, wr.y));
      vec3 hitP;
      float face;
      vec4 hit = rooms > 0.0 ? gyeRoom(wp, dirTS, roomSize, wr, hitP, face) : vec4(farRoom, 0.5);
      vec3 roomC = mix(farRoom, hit.rgb * (1.0 - uFacRoom.w * hit.a), rooms);
      // Cortinas a los lados (o cerradas), del color de cada casa.
      float xin = (fu - wrect.x) / max(winW, 1e-3);
      float cover = mix(uFacCurtain.y, uFacCurtain.z, fract(wr.x * 7.31));
      float curt = step(fract(wr.z * 3.17), uFacCurtain.x) * max(step(xin, cover * 0.5), step(1.0 - cover * 0.5, xin));
      // De lejos, la cortina es su parte promedio de la ventana.
      curt = mix(step(fract(wr.z * 3.17), uFacCurtain.x) * cover, curt, detail);
      vec3 curtC = uFacCurtains[int(fract(wr.y * 5.13) * float(GYE_FAC_CURTAINS))];
      roomC = mix(roomC, curtC * 0.8, curt);
      // Rejas en los pisos bajos de casas y edificios bajos.
      float barsOn = (tall ? 0.0 : 1.0) * step(storey, uFacBars.w - 1.0) * step(br.x, uFacBars.x);
      float bar = detail > 0.0 ? barsOn * gyeStripes(fu, uFacBars.y, uFacBars.z, fw.x) : barsOn * uFacBars.z / uFacBars.y;
      inside = roomC * pane * (1.0 - bar);
      if (nightOn) {
        vec3 lamp = gyeWindowLight(vec2(cell + bseed * 311.0, fl), uWindowLit);
        night = (roomC + curt * curtC * uFacCurtain.w) * lamp * pane * (1.0 - bar) * (1.0 - 0.4 * hit.a);
      }
      c = mix(c, uWindowColor, pane);
      c = mix(c, uFacBarColor, bar * pane);
      glassM = pane * (1.0 - bar);
    }
  }
  // Pretil y la humedad que chorrea desde arriba (clima húmedo); zócalo más oscuro.
  float parapet = house ? 0.0 : step(h - 0.45, v);
  c = mix(c, wall * 1.06, parapet * (1.0 - glassM));
  float grime = detail > 0.0 ? mix(0.5, gyeFacNoise(vec2(u * 1.7 / uFacGrimeScale, v * 0.08 / uFacGrimeScale)), detail) : 0.5;
  c *= 1.0 - (glassy ? 0.0 : uFacGrime.z * exp(-(h - v) / uFacGrime.w) * (0.4 + 0.6 * grime) * (1.0 - glassM));
  c *= mix(1.0 - uAO, 1.0, smoothstep(0.0, 3.5, v));
  diffuseColor.rgb = c;
  gyeGlass = glassM;
  gyeLit = night;
  gyeInside = inside;
  gyeGlow = glow;
}`;
