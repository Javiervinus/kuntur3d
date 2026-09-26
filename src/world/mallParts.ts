import * as THREE from 'three';
import type { SignFace } from '../render/signAtlas';
import { inward } from './classical';
import { seedOf } from './downtown';
import { Batch, type Glow, PATTERN, type Surface, glowOf, patternOf } from './monumentParts';
import type { Finish } from './monuments';
import type { MallDeck } from './parking';
import type { LocalRoof, PlaceKit, PlaceLight, PlaceSite } from './placeKit';

/*
 * Piezas genéricas de los centros comerciales (tipo `mall`, world/mall.ts), todas en el marco
 * local del lugar (x al rumbo, z a la derecha) y con alturas en m sobre el suelo de cada pieza:
 * pieles con nombre, plantas con tramos curvos, la cáscara de un volumen con una fachada distinta
 * por lado (franjas, vanos, parteluces, paneles de colores, arcos de portada), sus techos
 * (azotea, dos, tres o cuatro aguas, bóveda, dientes de sierra), marquesinas que se caminan por
 * debajo, letreros, lucernarios, cúpulas, equipos de aire, paneles solares y antenas. Nada de
 * medidas aquí: todo sale de config/sites/<mall>.json.
 */

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const EPS = 1e-4;
/**
 * Tope del inglete: si dos tramos doblan tanto que 1 + n1·n2 queda por debajo de esto (esquina
 * muy aguda), la esquina no se corre a inglete (se iría lejísimos) sino por la normal del tramo.
 */
export const MITER = 0.2;
/** Lados de las barras de perfil cuadrado (marcos de lucernarios, costillas de cúpulas y armaduras de puentes). */
export const SQUARE = 4;
/**
 * El acabado (config/sites → finishes, calado) de las letras sueltas: un letrero con `depth` 0 se
 * dibuja con él y el atlas deja hueco todo lo que no es letra, así no queda el recuadro del fondo
 * sobre la fachada (ni su sombra).
 */
export const LETTERS = 'letters';

// ---------------------------------------------------------------------------------------------
// Config

/** Una piel con nombre (config/sites → skins): cómo se ve una superficie. */
export interface MallSkin {
  /** Color (sRGB). */
  color: string;
  /**
   * Material: 'stone' (el de los monumentos, opaco) o el nombre de un acabado de `finishes`
   * (vidrio, metal, calado, translúcido).
   */
  material: string;
  /**
   * Dibujo (un nombre de PATTERN: 'slabs' paneles o placas con junta, 'tiles' mosaico,
   * 'glazing' vidrio con su carpintería, 'stucco' revoque, 'bars' barrotes calados, 'pavers',
   * 'soil', 'roofTiles'…). Sin él, liso.
   */
  pattern?: string;
  /**
   * Cuántas unidades del dibujo mide cada metro (a lo largo, a lo alto). En 'glazing' es 1/ancho y
   * 1/alto de cada paño: una junta de carpintería en cada entero.
   */
  scale?: number[];
  /** Tono del dibujo (en 'glazing', qué tan clara es la carpintería respecto del vidrio, 0…1). */
  tone?: number;
  /** Oclusión ambiental constante (1 = a la intemperie; un cielo raso, menos). */
  ao?: number;
  /** Luz de noche: el nombre de una luz de `lights`, y qué parte de los paños se enciende (0…1; sin él, todos). */
  glow?: string;
  lit?: number;
  /** De dónde sale el color (foto, fecha; lo estimado se dice). */
  source: string;
}

/**
 * Una franja horizontal de una fachada: de qué alto a qué alto (m sobre el suelo del volumen) y
 * con qué piel. Con `out` sale de la fachada (una cornisa, una losa en voladizo, una banda de
 * letrero) o, negativo, se mete (una cinta de vidrio retranqueada): lleva su canto arriba, abajo
 * y en las puntas. Con `repeat` se repite `repeat[0]` veces cada `repeat[1]` m hacia arriba (las
 * losas y las cintas de vidrio de cada piso de una torre). La piel 'open' deja el hueco.
 */
export interface MallBand {
  y: number[];
  skin: string;
  out?: number;
  repeat?: number[];
}

/**
 * Vanos de una fachada (puertas, vitrinas, ventanas, ranuras de un parqueo, bocas de acceso): el
 * centro a lo largo de la cara (m desde el comienzo de la cara), el ancho, de qué alto a qué alto,
 * cuánto se mete el paño (negativo: sale, un mirador o una vitrina en voladizo, con sus costados,
 * su tapa y su fondo) y su piel (sin piel, un hueco pasante que deja ver lo de adentro); el marco
 * del vano (jambas, dintel, antepecho) con la piel `frame` (si no, la del volumen). `repeat`:
 * cuántos y cada cuántos m a lo largo; `rows`: cuántas hileras y cada cuántos m hacia arriba.
 */
export interface MallOpening {
  u: number;
  width: number;
  y: number[];
  depth: number;
  skin?: string;
  frame?: string;
  repeat?: number[];
  rows?: number[];
}

/**
 * Pilares, parteluces o columnas delante de una fachada: uno cada `every` m desde `phase` m del
 * comienzo de la cara (hasta el final, o entre `span[0]` y `span[1]`), de ancho `width` y que sale
 * `out` m (redondos: `out` es dónde queda el eje), de qué alto a qué alto y su piel. Los que llegan
 * al suelo atajan el paso.
 */
export interface MallFins {
  every: number;
  phase: number;
  span?: number[];
  width: number;
  out: number;
  y: number[];
  skin: string;
  round: boolean;
}

/**
 * Paneles verticales de colores pegados a la fachada (el "gráfico de barras" de un muro): desde
 * el alto `y`, cada uno con un ancho, un alto y una separación al azar entre (mín., máx.), una de
 * las `skins` y el vuelo `out`; se dejan libres `margin` m al comienzo y al final de la cara.
 */
export interface MallPanels {
  y: number;
  width: number[];
  height: number[];
  gap: number[];
  out: number;
  margin: number[];
  skins: string[];
}

/**
 * Un arco de portada: bandas concéntricas en U (de afuera hacia adentro, cada una con su ancho,
 * su vuelo y su piel) centradas en `u` de la cara, de ancho exterior `width`, cuyo tope exterior
 * llega a `top` y cuyas patas bajan hasta `foot` (m sobre el suelo del volumen). Adentro, un paño
 * (`infill`, un vidrio; 'open' = sin paño) y, si hay, un rosetón: un disco de vidrio de radio
 * `radius` con su centro a `y`, `spokes` parteluces radiales y anillos (radios) de ancho `bar`,
 * con la piel `frame`; el vidrio y el marco van `rose.out[0]` y `rose.out[1]` m delante del plano
 * del arco (más que `detail.film`, donde va el paño, y el marco más que el vidrio: si no, las
 * capas titilan). `rise`: flecha del arco (cuánto sube del arranque a la clave; sin él, medio
 * punto: la mitad del ancho; menos, un arco rebajado). `repeat`: cuántos y cada cuántos m a lo
 * largo de la cara (una arcada, las ventanas en arco de un piso). `out`: cuántos m delante del
 * plano de la fachada va el arco entero (sin él, 0): el que va sobre un paño que sobresale (un
 * relieve lleno, que si no lo taparía).
 */
export interface MallArch {
  u: number;
  width: number;
  top: number;
  foot: number;
  rise?: number;
  out?: number;
  repeat?: number[];
  rings: { width: number; out: number; skin: string }[];
  infill: string;
  rose?: { y: number; radius: number; spokes: number; rings: number[]; bar: number; out: number[]; skin: string; frame: string };
}

/**
 * Un relieve sobre la fachada: una moldura que sigue un recorrido (el contorno de un frontón, el
 * aro de un medallón, las agujas de un reloj) o una figura llena (un paño que sobresale, un disco,
 * el remate curvo que asoma sobre el antepecho). Su eje va a `u` m del comienzo de la cara (y se
 * repite `repeat[0]` veces cada `repeat[1]` m); el recorrido son puntos [du, y] o [du, y, flecha]
 * con du hacia la derecha de quien mira la fachada desde afuera e y sobre el suelo del volumen: con
 * flecha, el tramo que arranca en ese punto es un arco que se sale `flecha` m hacia la izquierda
 * del avance (hacia arriba si va de izquierda a derecha; negativa, al revés). Con `mirror` los
 * puntos son la mitad derecha, desde el eje (du = 0), y se completa espejada. `width`: ancho de la
 * moldura (sin él, la figura llena que encierra el recorrido); `closed`: el recorrido de la moldura
 * se cierra (un anillo). Sale `out` m del plano de la fachada y se mete `back` m detrás (lo que
 * asoma sobre el antepecho se ve también desde atrás). `follow`: el relieve sigue la fachada
 * tramo por tramo (una placa de revestimiento o una viga que envuelve una fachada curva, un
 * tambor); sin él va plano, en el marco del punto `u` (en una cara curva sus puntas se despegan
 * del muro o se le meten).
 */
export interface MallRelief {
  u: number;
  repeat?: number[];
  points: number[][];
  mirror?: boolean;
  width?: number;
  closed?: boolean;
  out: number;
  back?: number;
  follow?: boolean;
  skin: string;
}

/**
 * Balcones de una fachada: la losa (grosor `slab`, vuelo `depth`, ancho `width`) con su piso a `y`
 * m sobre el suelo del volumen y centrada en `u` de la cara; la baranda de frente y a los costados
 * (alto `rail`, una piel calada: barrotes o balaustres) con su pasamanos de grosor `handrail`
 * (0 = sin). `repeat`: cuántos y cada cuántos m a lo largo; `rows`: cuántos pisos y cada cuántos m.
 */
export interface MallBalcony {
  u: number;
  width: number;
  y: number;
  depth: number;
  slab: number;
  rail: number;
  handrail: number;
  repeat?: number[];
  rows?: number[];
  skins: { slab: string; rail: string; handrail: string };
}

/**
 * Un faldón o alero inclinado pegado a la fachada (la teja corrida sobre un piso, el faldón a cuatro
 * aguas que rodea una torre): arranca del muro a `y` m sobre el suelo del volumen, vuela `out` m
 * bajando `drop` m hasta su borde, con el grosor `thickness`. Sigue la cara entera (o su `span`),
 * con inglete en las esquinas; si la cara da la vuelta completa, cierra como un techo a cuatro
 * aguas. Pieles: arriba (la teja), el cielo raso y el canto.
 */
export interface MallEave {
  y: number;
  out: number;
  drop: number;
  thickness: number;
  skins: { top: string; soffit: string; edge: string };
}

/**
 * Toldos de media cúpula (capotas) sobre puertas y vitrinas: un cuarto de esfera de ancho `width`,
 * alto `height` y vuelo `depth`, con el borde de abajo a `y` m sobre el suelo del volumen, centrado
 * en `u` de la cara; `repeat`: cuántos y cada cuántos m.
 */
export interface MallHood {
  u: number;
  width: number;
  y: number;
  height: number;
  depth: number;
  repeat?: number[];
  skin: string;
}

/**
 * La fachada de uno o más lados seguidos de la planta (i = del punto i al i+1; un lado curvo
 * cuenta como uno): entre `span[0]` y `span[1]` m a lo largo de esos lados (sin él, enteros),
 * franjas de abajo arriba (lo que no cubren queda con la piel del volumen), vanos, pilares,
 * paneles de colores, arcos, relieves (molduras, frontones, medallones), balcones, faldones
 * inclinados y toldos. Lo que ninguna cara cubre es muro liso con la piel del volumen.
 */
export interface MallFace {
  sides: number[];
  span?: number[];
  bands: MallBand[];
  openings?: MallOpening[];
  fins?: MallFins[];
  panels?: MallPanels[];
  arches?: MallArch[];
  reliefs?: MallRelief[];
  balconies?: MallBalcony[];
  eaves?: MallEave[];
  hoods?: MallHood[];
}

/**
 * El techo de un volumen. 'flat': azotea (con el antepecho del volumen). Los inclinados, sobre
 * plantas de 4 lados rectos: 'gable' (dos aguas), 'hip' (cuatro), 'shed' (un agua), 'vault'
 * (bóveda de cañón) y 'sawtooth' (dientes de sierra, `teeth` dientes). La cumbrera corre a lo
 * largo del lado `along` (índice de la planta) y sube `rise` m sobre el alero; el alero vuela
 * `eave` m. `gable`: piel de los hastiales, de las puntas de la bóveda o del vidrio de los dientes.
 * `under` (en 'gable', 'hip' y 'shed', obligatorio si el alero vuela o si el volumen es 'open'):
 * lo que se ve desde abajo. `soffit`: la piel del cielo del alero, del muro al borde (en un volumen
 * 'open', de la cara de abajo de todo el techo); `fascia`: alto del canto del borde (m; en el borde
 * el cielo queda ese tanto más abajo que las aguas); `edge`: la piel del canto.
 */
export interface MallRoof {
  kind: string;
  skin: string;
  rise?: number;
  along?: number;
  eave?: number;
  teeth?: number;
  gable?: string;
  under?: { soffit: string; fascia: number; edge: string };
}

/**
 * Un volumen del mall (config/sites → volumes): su planta, de dónde a dónde sube, su techo y sus
 * fachadas.
 */
export interface MallVolume {
  id: string;
  /** Qué es (el nombre de la hoja de medidas, para leer la config). */
  name: string;
  /**
   * Planta (marco local): puntos [x, z] o [x, z, flecha]. Con flecha, el lado que arranca en ese
   * punto es un arco que se sale `flecha` m de la cuerda hacia afuera (negativa: hacia adentro).
   * Dos puntos con flecha igual a la mitad de la cuerda en los dos lados dan un círculo (un tambor).
   */
  ring: number[][];
  /** Toma el suelo de otro volumen (va encima de él o pegado): su id, declarado antes. */
  on?: string;
  /** Dónde arrancan sus muros (m sobre el suelo: > 0 sobre un podio o un parqueo) y alto de la azotea o del alero. */
  base: number;
  height: number;
  /** Antepecho de la azotea: alto y grosor (alto 0 = sin). */
  parapet: number[];
  /** Piel de los muros que no cubre ninguna cara ('open': sin muro, como un parqueo abierto). */
  skin: string;
  /**
   * Piel de la cara de abajo de un volumen que vuela (`base` > 0: una caja en voladizo, un
   * mirador sobre la entrada), que se ve desde la vereda. Sin ella, esa cara no se dibuja.
   */
  soffit?: string;
  roof: MallRoof;
  faces: MallFace[];
  /**
   * Física: 'block' (macizo que se trepa, sólido del suelo al techo), 'raised' (sobre un parqueo o
   * una plaza que se camina: se pisa encima y se pasa por debajo de `base`) o 'none'.
   */
  physics: string;
  /** Un parqueo en altura adentro (world/parking.ts): sus losas, columnas, rampas y autos. */
  deck?: MallDeck;
  /** De dónde sale cada medida, con su fecha (lo estimado se dice). */
  source: string;
}

/**
 * Una marquesina: la losa sale desde la fachada, la recta de `line[0]` a `line[1]` (marco local),
 * `depth` m hacia la derecha de esa recta (negativo: hacia la izquierda); con más de dos puntos,
 * la quebrada que sigue una fachada curva (la losa va a inglete en cada quiebre y `u` se mide a lo
 * largo de la quebrada, del primer punto al último). Alto libre debajo (`height`, m sobre el suelo
 * del volumen `on` o, si no, del terreno en el promedio de los puntos de la recta),
 * grosor de la losa, cuánto baja el borde de afuera (`drop`, un agua; negativo: sube) y alto del
 * canto (≥ el grosor: cuelga bajo la losa). `nose` (solo en una recta): el borde de afuera va
 * redondeado: la lámina se curva hacia abajo en los últimos `nose` m del vuelo hasta el pie del
 * canto (un cuarto de elipse de `nose` m de ancho y `fascia` m de alto, con la piel del canto por
 * afuera y la del cielo raso por adentro), y los costados siguen ese perfil. Apoyos: postes (en
 * [u, v]: m a lo largo de la recta y hacia afuera),
 * redondos o no, que suben hasta `top` (si no, hasta la losa) desde `foot` (si no, el terreno); con
 * `y`, cada poste se abre arriba en dos puntales en Y (`spread` m a cada lado a lo largo, `rise` m
 * de alto). Tensores: cada uno [u, v, alto, u, v], de un punto (un pilar, la fachada; alto sobre el
 * suelo) a otro del tope de la losa. Plafones encendidos debajo cada `every` m, en el medio del
 * vuelo, de [ancho, alto] `size`; uno de cada `light.every` alumbra el piso (va al alumbrado de la
 * ciudad con su potencia, 1 = un poste de la calle, y si es LED): sin `light`, solo brillan (una
 * marquesina sobre un techo, que no alumbra la calle).
 */
export interface MallCanopy {
  id: string;
  on?: string;
  line: number[][];
  depth: number;
  height: number;
  thickness: number;
  drop: number;
  fascia: number;
  nose?: number;
  skins: { top: string; soffit: string; fascia: string };
  posts?: { at: number[][]; size: number[]; round: boolean; skin: string; top?: number; foot?: number; y?: { spread: number; rise: number; radius: number } };
  ties?: { at: number[][]; radius: number; skin: string };
  lamps?: { every: number; size: number[]; skin: string; light?: { every: number; power: number; led: boolean } };
  source: string;
}

/**
 * Un letrero (solo el nombre, con una letra genérica: los logos no se copian). La cara (texto,
 * tamaño en m, colores, letra; render/signAtlas.ts) va pegada a un volumen (`on`, el lado `side`
 * y, a lo largo de ese lado, `u` m desde su comienzo, o el punto del lado a la altura de la x o la
 * z local dada) o suelta en `at` [x, z] mirando hacia `angle` (grados, atan2(z, x) local). Su
 * centro a `y` m sobre el suelo del volumen (o del punto). La cara vuela `out` m; detrás, una caja
 * de `depth` m del color del fondo (0 = letras sueltas). `res`: qué parte de la resolución del
 * atlas usa (1 = la de las calles; los letreros grandes se leen igual con menos y ahorran atlas).
 * `stretch`: cuánto más anchas que las de la letra se ven las letras (una letra extendida, como la
 * de MEGAMAXI; sin él, 1): se dibujan en el atlas en una cara `stretch` veces más angosta y se
 * estiran a lo ancho del letrero. `pole`: tótem desde el suelo; `stand`: patas desde el alto `stand[0]` (un techo) de ancho
 * `stand[1]`, cuando el letrero va parado sobre un techo; `back`: se lee de los dos lados;
 * `plates`: placas planas detrás o delante de la cara (un rombo, un marco, un disco), con su forma
 * ('rect', 'diamond' o 'circle': una elipse del tamaño dado), tamaño, corrimiento [du, dy] desde
 * el centro, vuelo y color; `glow`: su luz de noche (si no, la de `lights.sign`). `follow`: la
 * cara de un letrero pegado a un volumen sigue la fachada tramo por tramo (las letras sobre un
 * tambor o una fachada curva); solo la cara, sin caja (`depth` 0 o sin él), tótem, patas ni
 * revés.
 */
export interface MallSign extends SignFace {
  on?: string;
  side?: number;
  u?: number;
  x?: number;
  z?: number;
  at?: number[];
  angle?: number;
  y: number;
  out: number;
  res: number;
  stretch?: number;
  follow?: boolean;
  pole?: { width: number; color: string };
  stand?: number[];
  back?: boolean;
  plates?: { shape: string; size: number[]; offset: number[]; out: number; color: string }[];
  glow?: Glow;
  source: string;
}

/**
 * Lucernarios sobre un techo (el del volumen `on`, a `y` m sobre su azotea): 'vault' (bóveda de
 * cañón de vidrio), 'ridge' (a dos aguas) o 'flat' (caja baja con tapa de vidrio), a lo largo de
 * la recta a→b, de ancho `width`, que sube `rise` m sobre su pretil de `curb` [alto, ancho].
 * Costillas cada `ribs[0]` m de ancho `ribs[1]` (0 = sin). `grid`: se repite [cuántos, cada
 * cuántos m] a lo largo y [cuántos, cada cuántos m] a lo ancho (una retícula de lucernarios).
 */
export interface MallSkylight {
  on: string;
  kind: string;
  a: number[];
  b: number[];
  width: number;
  rise: number;
  y: number;
  curb: number[];
  ribs: number[];
  grid?: number[];
  skins: { glass: string; frame: string };
  source: string;
}

/**
 * Una cúpula sobre un techo (o una media cúpula): centro [x, z], radio, alto de la calota,
 * tambor (alto) debajo, desde qué ángulo (`from`, grados) y cuánto da la vuelta (`arc`; 360 =
 * entera), cuántas costillas y su ancho (`rib`), y sus pieles. Arranca a `y` m sobre la azotea del
 * volumen `on`.
 */
export interface MallDome {
  on: string;
  at: number[];
  radius: number;
  rise: number;
  drum: number;
  y: number;
  from: number;
  arc: number;
  ribs: number;
  rib: number;
  skins: { shell: string; drum: string; frame: string };
  source: string;
}

/**
 * Equipos de aire sobre un techo (el del volumen `on`): `count` cajas repartidas en filas dentro
 * de `area` (marco local; si no, la planta del volumen metida `margin` m), giradas `angle` grados,
 * con un tamaño [ancho, fondo, alto] al azar entre `size[0]` y `size[1]`, su piel y un ventilador
 * (disco) arriba de radio `fan.radius` con la piel `fan.skin` (`fan.radius` = 0: sin).
 */
export interface MallEquipment {
  on: string;
  area?: number[][];
  margin: number;
  count: number;
  angle: number;
  size: number[][];
  skin: string;
  fan: { radius: number; skin: string };
  source: string;
}

/**
 * Paneles solares sobre un techo: filas a lo largo de `angle` (grados) cada `pitch` m dentro de
 * `area`, de fondo `depth` (en planta), inclinados `tilt` grados, a `lift` m sobre la azotea del
 * volumen `on`.
 */
export interface MallSolar {
  on: string;
  area: number[][];
  angle: number;
  pitch: number;
  depth: number;
  tilt: number;
  lift: number;
  skin: string;
  source: string;
}

/**
 * Mástiles de antenas: cada uno en [x, z, alto] (alto sobre `y` m del suelo del volumen `on`), de
 * radio `radius`, con `heads` paneles de [ancho, alto, fondo] alrededor de la punta.
 */
export interface MallMast {
  on: string;
  y: number;
  at: number[][];
  radius: number;
  heads: { count: number; size: number[]; skin: string };
  skin: string;
  source: string;
}

// ---------------------------------------------------------------------------------------------
// Utilidades

export const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

export { seedOf };

type V2 = THREE.Vector2;
const v2 = (x: number, z: number): V2 => new THREE.Vector2(x, z);

/** Área con signo de un polígono (x, z) (Σ x·z' − x'·z). */
export function signedArea(pts: readonly V2[]): number {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** ¿El punto (x, z) cae dentro del polígono? */
export function insidePoly(pts: readonly V2[], x: number, z: number): boolean {
  let hit = false;
  for (let k = 0, m = pts.length - 1; k < pts.length; m = k++) {
    const a = pts[k];
    const b = pts[m];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Tramos (en t) donde la recta p + d·t cae dentro del polígono. */
export function scanLine(pts: readonly V2[], p: V2, d: V2): number[][] {
  const ts: number[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const e = v2(b.x - a.x, b.y - a.y);
    const det = d.x * -e.y - d.y * -e.x;
    if (Math.abs(det) < 1e-9) continue;
    const wx = a.x - p.x;
    const wz = a.y - p.y;
    const t = (wx * -e.y - wz * -e.x) / det;
    const s = (d.x * wz - d.y * wx) / det;
    if (s >= 0 && s < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: number[][] = [];
  for (let k = 0; k + 1 < ts.length; k += 2) if (ts[k + 1] - ts[k] > EPS) out.push([ts[k], ts[k + 1]]);
  return out;
}

/** Rectángulo de la física: centro, medio largo, medio ancho y ángulo (atan2(z, x) local). */
export interface PhysBox {
  x: number;
  z: number;
  halfU: number;
  halfV: number;
  angle: number;
}

/**
 * Un polígono cualquiera como rectángulos para la física: franjas de `step` m a lo ancho del lado
 * más largo, cada una del largo que el polígono tiene en su línea media (una losa de parqueo, un
 * volumen que se camina por debajo). Sin lo que cae en los huecos (`holes`, polígonos adentro:
 * el vano de una rampa): a cada franja se le quita lo que el hueco ocupa en su línea media y en sus
 * dos bordes, así la franja nunca tapa el hueco.
 */
export function polyBoxes(pts: readonly V2[], step: number, holes: readonly (readonly V2[])[] = []): PhysBox[] {
  let axis = v2(1, 0);
  let best = 0;
  for (let k = 0; k < pts.length; k++) {
    const d = pts[(k + 1) % pts.length].clone().sub(pts[k]);
    if (d.length() > best) {
      best = d.length();
      axis = d.normalize();
    }
  }
  const across = v2(-axis.y, axis.x);
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    const v = p.dot(across);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const n = Math.max(1, Math.ceil((v1 - v0) / step));
  const w = (v1 - v0) / n;
  const angle = Math.atan2(axis.y, axis.x);
  const out: PhysBox[] = [];
  for (let k = 0; k < n; k++) {
    const v = v0 + (k + 0.5) * w;
    const origin = across.clone().multiplyScalar(v);
    // Lo que los huecos ocupan en la franja (en t, sobre el eje): en su línea media y en sus bordes.
    const cut = holes.flatMap((h) => [-0.5, 0, 0.5].flatMap((s) => scanLine(h, across.clone().multiplyScalar(v + s * w), axis)));
    for (const [t0, t1] of scanLine(pts, origin, axis)) {
      let runs = [[t0, t1]];
      for (const [c0, c1] of cut) runs = runs.flatMap(([r0, r1]) => (c1 <= r0 || c0 >= r1 ? [[r0, r1]] : [[r0, Math.max(r0, c0)], [Math.min(r1, c1), r1]].filter(([p, q]) => q - p > EPS)));
      for (const [r0, r1] of runs) {
        const c = origin.clone().addScaledVector(axis, (r0 + r1) / 2);
        out.push({ x: c.x, z: c.y, halfU: (r1 - r0) / 2, halfV: w / 2, angle });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pieles y búferes

/**
 * Una piel ya resuelta: en qué material va, su color, su superficie y su luz de noche. `thin`: su
 * acabado es calado o transparente (se ve de los dos lados), así que va con una sola cara: sin cara
 * de atrás, tapas ni cantos, que saldrían dobles.
 */
export interface Look {
  material: string;
  color: THREE.Color;
  surface: Surface;
  glow?: THREE.Color;
  lit: number;
  open: boolean;
  thin: boolean;
}

/** Las pieles de un mall por nombre ('open' = sin superficie), con los acabados de `finishes`. */
export class Skins {
  private readonly cache = new Map<string, Look>();

  constructor(
    private readonly skins: Record<string, MallSkin>,
    private readonly glows: Record<string, Glow>,
    private readonly finishes: Record<string, Finish>,
  ) {}

  look(name: string): Look {
    let l = this.cache.get(name);
    if (l) return l;
    if (name === 'open') {
      l = { material: 'stone', color: WHITE, surface: {}, lit: 0, open: true, thin: false };
    } else {
      const s = this.skins[name];
      if (!s) throw new Error(`Piel desconocida en config/sites (mall): ${name}`);
      const glow = s.glow ? this.glows[s.glow] : undefined;
      if (s.glow && !glow) throw new Error(`La piel ${name} pide la luz "${s.glow}", que no está en lights`);
      const finish = s.material === 'stone' ? undefined : this.finishes[s.material];
      l = {
        material: s.material,
        color: new THREE.Color(s.color),
        surface: { pattern: s.pattern ? patternOf(s.pattern) : PATTERN.none, scale: s.scale, tone: s.tone, ao: s.ao },
        glow: glow ? glowOf(glow) : undefined,
        lit: glow ? (s.lit ?? 1) : 0,
        open: false,
        thin: !!finish && (!!finish.cutout || finish.opacity !== undefined),
      };
    }
    this.cache.set(name, l);
    return l;
  }
}

/** La superficie de una piel, encendida de noche o no. */
export function surf(l: Look, on: boolean, extra: Surface = {}): Surface {
  return { ...l.surface, ...extra, glow: on && l.glow ? l.glow : undefined };
}

/**
 * Los búferes de un pedazo del mall, uno por material y por si se ve siempre o solo de cerca
 * (lo chico); `flush` los vuelca en mallas con nombre `<pedazo>-<material>[-near]`.
 */
export class Bins {
  private readonly map = new Map<string, { batch: Batch; material: string; near: boolean }>();

  constructor(private readonly flood: readonly number[]) {}

  get(material: string, near = false): Batch {
    const key = `${material}${near ? '-near' : ''}`;
    let b = this.map.get(key);
    if (!b) {
      const batch = new Batch();
      for (let k = 0; k < 3; k++) batch.flood[k] = this.flood[k];
      b = { batch, material, near };
      this.map.set(key, b);
    }
    return b.batch;
  }

  /** La piel `l` en su búfer. */
  of(l: Look, near = false): Batch {
    return this.get(l.material, near);
  }

  flush(group: THREE.Group, name: string, material: (key: string) => { m: THREE.Material; shadow: boolean }, site: PlaceSite, near: number): void {
    for (const [key, b] of this.map) {
      if (b.batch.empty) continue;
      const { m, shadow } = material(b.material);
      const mesh = new THREE.Mesh(b.batch.build(), m);
      mesh.name = `${name}-${key}`;
      mesh.castShadow = shadow && !b.near;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (b.near) site.near(mesh, near);
    }
  }
}

/** Lo que necesita cada pieza para armarse. */
export interface Ctx {
  kit: PlaceKit;
  skins: Skins;
  /**
   * LOD de lo chico (m al centro de su pedazo), largo máximo de cada tramo de un arco, lados de lo
   * redondo, lados de lo redondo chico (barandas, bolardos, antenas, chorros, ruedas), tramos
   * mínimos de cualquier arco, por chico que sea, y separación entre dos capas que se tapan (m:
   * el paño de un arco sobre su muro, el ventilador sobre su equipo; ver world/mall.ts → MallFile).
   */
  detail: { near: number; arc: number; sides: number; small: number; curve: number; film: number };
  /** Tramos de los pisos que siguen el terreno, cuánto quedan sobre él, cuánto se entierran los muros y grosor de las vallas. */
  ground: { step: number; lift: number; bury: number; wall: number };
}

/** Un pedazo del mall: su física y LOD, sus búferes y su grupo (`<lugar>-<pedazo>`, para medirlo aparte). */
export interface Piece {
  id: string;
  site: PlaceSite;
  bins: Bins;
  group: THREE.Group;
  /** Centro (marco local). */
  x: number;
  z: number;
  /**
   * Lo que la cáscara de su volumen cubre en el plano de la fachada, por tramo de la planta (u
   * desde el comienzo del tramo, y del mundo): ahí un parqueo no dibuja el canto de sus losas, que
   * quedaría en el mismo plano y titilaría (world/parking.ts → buildDeck).
   */
  walls: Map<Seg, Rect[]>;
}

// ---------------------------------------------------------------------------------------------
// Dibujo

/**
 * Cara vertical de A a B (planta) entre y0 e y1 (mundo), mirando hacia `facing` (planta): la da
 * vuelta si hace falta. uv en m (u0 → u1 a lo largo, y hacia arriba).
 */
export function vquad(b: Batch, A: V2, B: V2, y0: number, y1: number, facing: V2, color: THREE.Color, surface: Surface, u0: number, u1: number, v0 = y0, v1 = y1): void {
  if (y1 - y0 < EPS) return;
  const dx = B.x - A.x;
  const dz = B.y - A.y;
  const ok = -dz * facing.x + dx * facing.y >= 0;
  const P = (p: V2, y: number): THREE.Vector3 => new THREE.Vector3(p.x, y, p.y);
  if (ok) b.quad(P(A, y0), P(B, y0), P(B, y1), P(A, y1), color, surface, [u0, v0, u1, v1]);
  else b.quad(P(B, y0), P(A, y0), P(A, y1), P(B, y1), color, surface, [u1, v0, u0, v1]);
}

/** Cuadrilátero a-b-c-d mirando hacia arriba (`up`) o hacia abajo: lo da vuelta si hace falta. uv por esquina (8) o en m del plano (x, z). */
export function hquad(b: Batch, a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, up: boolean, color: THREE.Color, surface: Surface, uv?: number[]): void {
  const n = new THREE.Vector3().subVectors(bb, a).cross(new THREE.Vector3().subVectors(d, a));
  const corners = uv ?? [a.x, a.z, bb.x, bb.z, c.x, c.z, d.x, d.z];
  if (n.y >= 0 === up) b.quad(a, bb, c, d, color, surface, corners);
  else b.quad(bb, a, d, c, color, surface, [corners[2], corners[3], corners[0], corners[1], corners[6], corners[7], corners[4], corners[5]]);
}

/** Triángulo mirando hacia `dir` (lo da vuelta si hace falta), uv en m del plano que se le dé. */
export function tri(b: Batch, p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, surface: Surface, uv: number[]): void {
  const n = new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p));
  if (n.dot(dir) >= 0) b.tri(p, q, r, color, surface, uv);
  else b.tri(p, r, q, color, surface, [uv[0], uv[1], uv[4], uv[5], uv[2], uv[3]]);
}

/** Cuadrilátero p0-p1-p2-p3 (plano) mirando hacia `dir`, en dos triángulos; uv por esquina (8). */
function quadTo(b: Batch, p: THREE.Vector3[], dir: THREE.Vector3, color: THREE.Color, surface: Surface, uv: number[]): void {
  tri(b, p[0], p[1], p[2], dir, color, surface, [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]]);
  tri(b, p[0], p[2], p[3], dir, color, surface, [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]]);
}

/** Marco con x a lo largo de `t` (planta), y arriba y z a su derecha, en (p, y). */
export function frameAt(p: V2, t: V2, y: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(t.x, 0, t.y), UP, new THREE.Vector3(-t.y, 0, t.x)).setPosition(p.x, y, p.y);
}

/** Caja de w (a lo largo de t) × h × d centrada en (p, y). */
export function boxAt(b: Batch, p: V2, t: V2, y: number, w: number, h: number, d: number, color: THREE.Color, surface: Surface = {}): void {
  if (w <= EPS || h <= EPS || d <= EPS) return;
  b.box(frameAt(p, t, y), w, h, d, color, surface);
}

/** Barra redonda de radio r entre dos puntos (mundo del lugar). */
export function bar(b: Batch, a: THREE.Vector3, c: THREE.Vector3, r: number, sides: number, color: THREE.Color, surface: Surface = {}): void {
  const d = new THREE.Vector3().subVectors(c, a);
  const len = d.length();
  if (len < EPS) return;
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(len));
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.geometry(g, m, color, surface);
  g.dispose();
}

// ---------------------------------------------------------------------------------------------
// Plantas y tramos de fachada

/** Un tramo recto de una planta (los arcos van en varios): de a a b, con su normal hacia afuera, su lado en la config y dónde arranca en ese lado (m). */
export interface Seg {
  a: V2;
  b: V2;
  len: number;
  t: V2;
  n: V2;
  side: number;
  su: number;
}

/** Una planta ya en tramos rectos: los tramos, cuántos lados trae la config y cuánto mide cada uno. */
export interface Outline {
  segs: Seg[];
  pts: V2[];
  sides: number;
  sideLen: number[];
}

/** Los puntos de un arco de a a b que se sale `s` m de la cuerda hacia `n` (sin a, con b), en tramos de a lo sumo `maxArc` m y al menos `min`. */
function arcPoints(a: V2, b: V2, n: V2, s: number, maxArc: number, min = 2): V2[] {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const apex = mid.clone().addScaledVector(n, s);
  const c = a.distanceTo(b);
  const h = Math.abs(s);
  const R = (c * c) / 4 / (2 * h) + h / 2;
  const center = apex.clone().addScaledVector(n, -Math.sign(s) * R);
  const ang = (p: V2): number => Math.atan2(p.y - center.y, p.x - center.x);
  const TAU = Math.PI * 2;
  const pos = (x: number): number => ((x % TAU) + TAU) % TAU;
  const ta = ang(a);
  const tm = ang(apex);
  const tb = ang(b);
  const dm = pos(tm - ta);
  const sweep = dm < Math.PI ? pos(tb - ta) : -pos(ta - tb);
  const m = Math.max(min, Math.ceil((R * Math.abs(sweep)) / maxArc));
  const out: V2[] = [];
  for (let j = 1; j < m; j++) {
    const t = ta + (sweep * j) / m;
    out.push(v2(center.x + Math.cos(t) * R, center.y + Math.sin(t) * R));
  }
  out.push(b.clone());
  return out;
}

/**
 * La planta de la config ([x, z] o [x, z, flecha]) en tramos rectos, con la normal hacia afuera
 * de cada uno sea cual sea el sentido en que viene la planta.
 */
export function outline(ring: readonly (readonly number[])[], maxArc: number): Outline {
  const P = ring.map((p) => v2(p[0], p[1]));
  const n = P.length;
  const raw = (i: number): V2 => {
    const d = P[(i + 1) % n].clone().sub(P[i]);
    return v2(-d.y, d.x).normalize();
  };
  // El sentido con las flechas incluidas (dos puntos con arcos son un círculo).
  const probe: V2[] = [];
  for (let i = 0; i < n; i++) {
    probe.push(P[i]);
    const s = ring[i][2] ?? 0;
    if (Math.abs(s) > EPS) probe.push(P[i].clone().add(P[(i + 1) % n]).multiplyScalar(0.5).addScaledVector(raw(i), s));
  }
  const flip = signedArea(probe) > 0 ? -1 : 1;
  const segs: Seg[] = [];
  const pts: V2[] = [];
  const sideLen: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    const s = ring[i][2] ?? 0;
    const nOut = raw(i).multiplyScalar(flip);
    const run = Math.abs(s) > EPS ? arcPoints(a, b, nOut, s, maxArc) : [b.clone()];
    let p = a.clone();
    let su = 0;
    for (const q of run) {
      const d = q.clone().sub(p);
      const len = d.length();
      if (len > EPS) {
        const t = d.divideScalar(len);
        pts.push(p.clone());
        segs.push({ a: p.clone(), b: q.clone(), len, t, n: v2(-t.y, t.x).multiplyScalar(flip), side: i, su });
        su += len;
      }
      p = q;
    }
    sideLen.push(su);
  }
  return { segs, pts, sides: n, sideLen };
}

/** Los tramos de uno o más lados seguidos, con su largo acumulado. */
export interface Chain {
  segs: Seg[];
  /** Dónde arranca cada tramo (m desde el comienzo de la cadena). */
  u: number[];
  length: number;
  closed: boolean;
}

export function chainOf(o: Outline, sides: readonly number[]): Chain {
  const segs: Seg[] = [];
  for (const s of sides) segs.push(...o.segs.filter((g) => g.side === s));
  const u: number[] = [];
  let acc = 0;
  for (const g of segs) {
    u.push(acc);
    acc += g.len;
  }
  return { segs, u, length: acc, closed: sides.length === o.sides };
}

/** Hacia dónde se corre la esquina entre dos tramos (inglete): m·n1 = m·n2 = 1. */
function miter(n1: V2, n2: V2): V2 {
  const d = 1 + n1.dot(n2);
  if (d < MITER) return n2.clone();
  return n1.clone().add(n2).divideScalar(d);
}

/** Un pedazo de la cadena entre dos u: sus puntas, hacia dónde se corre cada una, su normal, su tramo y dónde arranca ese tramo en la cadena. */
export interface Span {
  A: V2;
  B: V2;
  oa: V2;
  ob: V2;
  ua: number;
  ub: number;
  n: V2;
  t: V2;
  seg: Seg;
  s0: number;
}

export function spans(c: Chain, u0: number, u1: number): Span[] {
  const out: Span[] = [];
  const N = c.segs.length;
  for (let k = 0; k < N; k++) {
    const g = c.segs[k];
    const s0 = c.u[k];
    const s1 = s0 + g.len;
    const ua = Math.max(u0, s0);
    const ub = Math.min(u1, s1);
    if (ub - ua < EPS) continue;
    const prev = k > 0 ? c.segs[k - 1] : c.closed ? c.segs[N - 1] : null;
    const next = k < N - 1 ? c.segs[k + 1] : c.closed ? c.segs[0] : null;
    out.push({
      A: g.a.clone().addScaledVector(g.t, ua - s0),
      B: g.a.clone().addScaledVector(g.t, ub - s0),
      oa: ua - s0 < EPS && prev ? miter(prev.n, g.n) : g.n.clone(),
      ob: s1 - ub < EPS && next ? miter(g.n, next.n) : g.n.clone(),
      ua,
      ub,
      n: g.n,
      t: g.t,
      seg: g,
      s0,
    });
  }
  return out;
}

/** Punto, tangente y normal de la cadena a `u` m de su comienzo. */
export function pointAt(c: Chain, u: number): { p: V2; t: V2; n: V2 } {
  let k = 0;
  while (k < c.segs.length - 1 && c.u[k] + c.segs[k].len < u) k++;
  const g = c.segs[k];
  return { p: g.a.clone().addScaledVector(g.t, THREE.MathUtils.clamp(u - c.u[k], 0, g.len)), t: g.t, n: g.n };
}

/** Un rectángulo de fachada (u a lo largo, y en el mundo). */
export interface Rect {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

/** Lo que queda de `r` sin los huecos (en rectángulos, juntando por hilera lo que queda seguido). */
export function cut(r: Rect, holes: readonly Rect[]): Rect[] {
  const hs = holes.filter((h) => h.u1 > r.u0 + EPS && h.u0 < r.u1 - EPS && h.y1 > r.y0 + EPS && h.y0 < r.y1 - EPS);
  if (!hs.length) return [r];
  const uniq = (vals: number[]): number[] => {
    vals.sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of vals) if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
    return out;
  };
  const cu = (v: number): number => THREE.MathUtils.clamp(v, r.u0, r.u1);
  const cy = (v: number): number => THREE.MathUtils.clamp(v, r.y0, r.y1);
  const us = uniq([r.u0, r.u1, ...hs.flatMap((h) => [cu(h.u0), cu(h.u1)])]);
  const ys = uniq([r.y0, r.y1, ...hs.flatMap((h) => [cy(h.y0), cy(h.y1)])]);
  const find = (arr: number[], v: number): number => {
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const nu = us.length - 1;
  const ny = ys.length - 1;
  const hole = new Uint8Array(nu * ny);
  for (const h of hs) {
    const i0 = find(us, cu(h.u0));
    const i1 = find(us, cu(h.u1));
    const j0 = find(ys, cy(h.y0));
    const j1 = find(ys, cy(h.y1));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) hole[j * nu + i] = 1;
  }
  const out: Rect[] = [];
  for (let j = 0; j < ny; j++) {
    let start = -1;
    for (let i = 0; i <= nu; i++) {
      const free = i < nu && !hole[j * nu + i];
      if (free && start < 0) start = i;
      if (!free && start >= 0) {
        out.push({ u0: us[start], u1: us[i], y0: ys[j], y1: ys[j + 1] });
        start = -1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cáscara de un volumen

/**
 * Un rectángulo de fachada sobre la cadena, en el plano corrido `o` m hacia afuera (en las
 * esquinas, a inglete), mirando hacia afuera; con `thick`, además sus cantos (arriba, abajo y las
 * puntas) hasta el plano de la fachada: una franja que vuela o que se mete. Con `back`, también la
 * cara de adentro del muro, `back` m hacia adentro (el muro de un parqueo visto desde sus pisos;
 * no en una piel calada o transparente, que ya se ve de los dos lados). Lo que queda en el plano
 * de la fachada se anota en `piece.walls`.
 */
function rectOn(piece: Piece, c: Chain, r: Rect, o: number, l: Look, on: boolean, thick: boolean, near = false, back = 0): void {
  if (l.open || r.y1 - r.y0 < EPS) return;
  const bins = piece.bins;
  const b = bins.of(l, near);
  const s = surf(l, on);
  const parts = spans(c, r.u0, r.u1);
  for (const p of parts) {
    const A = p.A.clone().addScaledVector(p.oa, o);
    const B = p.B.clone().addScaledVector(p.ob, o);
    vquad(b, A, B, r.y0, r.y1, p.n, l.color, s, p.ua, p.ub);
    if (Math.abs(o) < EPS) {
      const list = piece.walls.get(p.seg);
      const rect = { u0: p.ua - p.s0, u1: p.ub - p.s0, y0: r.y0, y1: r.y1 };
      if (list) list.push(rect);
      else piece.walls.set(p.seg, [rect]);
    }
    if (back > EPS && Math.abs(o) < EPS && !l.thin) vquad(b, p.A.clone().addScaledVector(p.oa, -back), p.B.clone().addScaledVector(p.ob, -back), r.y0, r.y1, p.n.clone().negate(), l.color, surf(l, false), p.ua, p.ub);
    if (!thick || Math.abs(o) < EPS) continue;
    // Cantos de arriba y abajo: del plano de la fachada al corrido (el de arriba mira hacia arriba si vuela).
    const A0 = p.A;
    const B0 = p.B;
    const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
    const ledge = surf(l, false);
    hquad(b, P(A0, r.y1), P(B0, r.y1), P(B, r.y1), P(A, r.y1), o > 0, l.color, ledge);
    hquad(b, P(A0, r.y0), P(B0, r.y0), P(B, r.y0), P(A, r.y0), o < 0, l.color, ledge);
  }
  if (!thick || Math.abs(o) < EPS || !parts.length) return;
  // Puntas: hacia afuera del rectángulo si vuela, hacia adentro del hueco si se mete.
  const first = parts[0];
  const last = parts[parts.length - 1];
  const sgn = o > 0 ? 1 : -1;
  const capS = surf(l, false);
  if (!(c.closed && r.u0 < EPS && r.u1 > c.length - EPS)) {
    vquad(bins.of(l, near), first.A, first.A.clone().addScaledVector(first.oa, o), r.y0, r.y1, first.t.clone().multiplyScalar(-sgn), l.color, capS, 0, Math.abs(o));
    vquad(bins.of(l, near), last.B, last.B.clone().addScaledVector(last.ob, o), r.y0, r.y1, last.t.clone().multiplyScalar(sgn), l.color, capS, 0, Math.abs(o));
  }
}

/** Semilla de encendido de noche: cada paño se enciende o no, siempre igual. */
let serial = 0;
function litNow(l: Look, seed: number): boolean {
  return l.lit > 0 && rand(seed + serial++, 7) < l.lit;
}

/**
 * La cáscara de un volumen: las caras de cada lado (franjas, vanos, pilares, paneles, arcos), el
 * muro liso donde no hay cara, el antepecho y el techo. `ground` es el suelo del volumen (mundo) y
 * `sink` cuánto bajan sus muros bajo él.
 */
export function buildShell(v: MallVolume, o: Outline, ground: number, sink: number, piece: Piece, ctx: Ctx): LocalRoof | undefined {
  const seed = seedOf(v.id);
  const top = v.height + v.parapet[0];
  const bottom = v.base > EPS ? v.base : -sink;
  const back = v.deck ? v.deck.guard[1] : 0;
  const covered: number[][][] = Array.from({ length: o.sides }, () => []);
  const wallLook = ctx.skins.look(v.skin);
  for (const f of v.faces) {
    const c = chainOf(o, f.sides);
    const [U0, U1] = f.span ?? [0, c.length];
    // Qué parte de cada lado cubre la cara (para el muro liso de lo que queda).
    let acc = 0;
    for (const s of f.sides) {
      const len = o.sideLen[s];
      const a = Math.max(U0, acc) - acc;
      const b = Math.min(U1, acc + len) - acc;
      if (b - a > EPS) covered[s].push([a, b]);
      acc += len;
    }
    face(f, c, U0, U1, bottom, top, ground, seed, wallLook, back, v.parapet[1], piece, ctx);
  }
  // Muro liso donde no hay cara.
  for (let s = 0; s < o.sides; s++) {
    if (wallLook.open) break;
    const c = chainOf(o, [s]);
    const iv = covered[s].sort((a, b) => a[0] - b[0]);
    let u = 0;
    const free: number[][] = [];
    for (const [a, b] of iv) {
      if (a - u > EPS) free.push([u, a]);
      u = Math.max(u, b);
    }
    if (c.length - u > EPS) free.push([u, c.length]);
    for (const [a, b] of free) rectOn(piece, c, { u0: a, u1: b, y0: ground + bottom, y1: ground + top }, 0, wallLook, false, false, false, back);
  }
  // La cara de abajo de lo que vuela (mirando hacia abajo).
  if (v.soffit && v.base > EPS) {
    const l = ctx.skins.look(v.soffit);
    if (!l.open) {
      const y = ground + v.base;
      const P = (q: V2): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
      const down = new THREE.Vector3(0, -1, 0);
      const b = piece.bins.of(l);
      const s = surf(l, false);
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(o.pts, [])) tri(b, P(o.pts[i]), P(o.pts[j]), P(o.pts[k]), down, l.color, s, [o.pts[i].x, o.pts[i].y, o.pts[j].x, o.pts[j].y, o.pts[k].x, o.pts[k].y]);
    }
  }
  const roofLook = ctx.skins.look(v.roof.skin);
  const rim = wallLook.open ? roofLook : wallLook;
  // En un parqueo el muro ya trae su cara de adentro: solo falta el tope.
  if (v.deck) parapet(o, ground + top, [0, back], rim, piece);
  else if (v.parapet[0] > EPS) parapet(o, ground + v.height, v.parapet, rim, piece);
  return v.deck ? undefined : roof(v, o, ground, piece, ctx);
}

/** Una cara de fachada sobre la cadena `c`, de U0 a U1. */
function face(f: MallFace, c: Chain, U0: number, U1: number, bottom: number, top: number, ground: number, seed: number, wall: Look, back: number, rim: number, piece: Piece, ctx: Ctx): void {
  // Los huecos (vanos con sus repeticiones), en u de la cadena e y del mundo.
  const holes: (Rect & { op: MallOpening })[] = [];
  for (const op of f.openings ?? []) {
    const [nu, du] = op.repeat ?? [1, 0];
    const [nr, dr] = op.rows ?? [1, 0];
    for (let r = 0; r < nr; r++) {
      for (let k = 0; k < nu; k++) {
        const cu = U0 + op.u + k * du;
        holes.push({ u0: cu - op.width / 2, u1: cu + op.width / 2, y0: ground + op.y[0] + r * dr, y1: ground + op.y[1] + r * dr, op });
      }
    }
  }
  // Franjas con sus repeticiones, y qué altos cubren.
  const bands: { y0: number; y1: number; b: MallBand }[] = [];
  for (const b of f.bands) {
    const [n, dy] = b.repeat ?? [1, 0];
    for (let k = 0; k < n; k++) bands.push({ y0: b.y[0] + k * dy, y1: b.y[1] + k * dy, b });
  }
  for (const { y0, y1, b } of bands) {
    const l = ctx.skins.look(b.skin);
    const out = b.out ?? 0;
    // Una piel calada o transparente va con una sola cara: sin cantos, que saldrían dobles.
    const thick = Math.abs(out) > EPS && !l.thin;
    const lo = Math.max(y0, bottom);
    const hi = Math.min(y1, top);
    if (hi - lo > EPS) for (const r of cut({ u0: U0, u1: U1, y0: ground + lo, y1: ground + hi }, holes)) rectOn(piece, c, r, out, l, litNow(l, seed), thick, false, back);
    // Lo que sube sobre el antepecho (la cresta de una fachada).
    if (y1 > top + EPS && !l.open) crest(piece, c, { u0: U0, u1: U1, y0: ground + Math.max(y0, top), y1: ground + y1 }, out, rim > EPS ? rim : ctx.ground.wall, l, litNow(l, seed), y0 > top + EPS);
  }
  // Lo que las franjas no cubren: la piel del volumen.
  const ivs = bands.map((b) => [Math.max(b.y0, bottom), Math.min(b.y1, top)]).sort((a, b) => a[0] - b[0]);
  let y = bottom;
  const gaps: number[][] = [];
  for (const [a, b] of ivs) {
    if (a - y > EPS) gaps.push([y, a]);
    y = Math.max(y, b);
  }
  if (top - y > EPS) gaps.push([y, top]);
  for (const [a, b] of gaps) for (const r of cut({ u0: U0, u1: U1, y0: ground + a, y1: ground + b }, holes)) rectOn(piece, c, r, 0, wall, false, false, false, back);
  // Los vanos: su paño metido y su marco.
  for (const h of holes) opening(h, h.op, c, wall, seed, piece, ctx);
  for (const fn of f.fins ?? []) fins(fn, c, U0, U1, ground, piece, ctx);
  for (const p of f.panels ?? []) panels(p, c, U0, U1, ground, seed, piece, ctx);
  for (const a of f.arches ?? []) arch(a, c, U0, ground, piece, ctx);
  for (const r of f.reliefs ?? []) relief(r, c, U0, ground, piece, ctx);
  for (const b of f.balconies ?? []) balconies(b, c, U0, ground, piece, ctx);
  for (const e of f.eaves ?? []) eave(e, c, U0, U1, ground, piece, ctx);
  for (const h of f.hoods ?? []) hoods(h, c, U0, ground, piece, ctx);
}

/**
 * Lo que una franja sube sobre el antepecho (la cresta de una fachada, que se ve también desde la
 * azotea): la cara de afuera (corrida `out`) y, si la piel es opaca, la de atrás (`thick` m detrás
 * del plano de la fachada), el tope, las puntas (si la cara no da la vuelta entera) y, si arranca
 * más arriba que el antepecho (`loose`), la cara de abajo. Calada o transparente, una sola cara.
 */
function crest(piece: Piece, c: Chain, r: Rect, out: number, thick: number, l: Look, on: boolean, loose: boolean): void {
  rectOn(piece, c, r, out, l, on, false);
  if (l.thin) return;
  const b = piece.bins.of(l);
  const s = surf(l, false);
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  const parts = spans(c, r.u0, r.u1);
  for (const p of parts) {
    const Ao = p.A.clone().addScaledVector(p.oa, out);
    const Bo = p.B.clone().addScaledVector(p.ob, out);
    const Ai = p.A.clone().addScaledVector(p.oa, -thick);
    const Bi = p.B.clone().addScaledVector(p.ob, -thick);
    vquad(b, Ai, Bi, r.y0, r.y1, p.n.clone().negate(), l.color, s, p.ua, p.ub);
    hquad(b, P(Ao, r.y1), P(Bo, r.y1), P(Bi, r.y1), P(Ai, r.y1), true, l.color, s);
    if (loose) hquad(b, P(Ao, r.y0), P(Bo, r.y0), P(Bi, r.y0), P(Ai, r.y0), false, l.color, s);
  }
  if (!parts.length || (c.closed && r.u0 < EPS && r.u1 > c.length - EPS)) return;
  const first = parts[0];
  const last = parts[parts.length - 1];
  vquad(b, first.A.clone().addScaledVector(first.oa, -thick), first.A.clone().addScaledVector(first.oa, out), r.y0, r.y1, first.t.clone().negate(), l.color, s, -thick, out);
  vquad(b, last.B.clone().addScaledVector(last.ob, -thick), last.B.clone().addScaledVector(last.ob, out), r.y0, r.y1, last.t, l.color, s, -thick, out);
}

/** Un vano: el paño `depth` m adentro (si tiene piel) y las jambas, el dintel y el antepecho. */
function opening(h: Rect, op: MallOpening, c: Chain, wall: Look, seed: number, piece: Piece, ctx: Ctx): void {
  const frame = op.frame ? ctx.skins.look(op.frame) : wall;
  if (op.skin) {
    const l = ctx.skins.look(op.skin);
    rectOn(piece, c, h, -op.depth, l, litNow(l, seed), false);
  }
  if (frame.open) return;
  const b = piece.bins.of(frame);
  const s = surf(frame, false, { ao: frame.surface.ao ?? 1 });
  const parts = spans(c, h.u0, h.u1);
  if (!parts.length) return;
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  // Metido, el marco mira hacia el hueco; saliendo (un mirador), hacia afuera.
  const inside = op.depth >= 0;
  for (const p of parts) {
    const Ai = p.A.clone().addScaledVector(p.oa, -op.depth);
    const Bi = p.B.clone().addScaledVector(p.ob, -op.depth);
    hquad(b, P(p.A, h.y1), P(p.B, h.y1), P(Bi, h.y1), P(Ai, h.y1), !inside, frame.color, s);
    hquad(b, P(p.A, h.y0), P(p.B, h.y0), P(Bi, h.y0), P(Ai, h.y0), inside, frame.color, s);
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const d = Math.abs(op.depth);
  vquad(b, first.A, first.A.clone().addScaledVector(first.oa, -op.depth), h.y0, h.y1, inside ? first.t : first.t.clone().negate(), frame.color, s, 0, d);
  vquad(b, last.B, last.B.clone().addScaledVector(last.ob, -op.depth), h.y0, h.y1, inside ? last.t.clone().negate() : last.t, frame.color, s, 0, d);
}

/**
 * Pilares o columnas delante de una cara, con su física: los que llegan al suelo atajan desde
 * abajo; los que arrancan en alto (los postes de una pérgola sobre una terraza), desde su pie.
 */
function fins(fn: MallFins, c: Chain, U0: number, U1: number, ground: number, piece: Piece, ctx: Ctx): void {
  const l = ctx.skins.look(fn.skin);
  const [a, b] = fn.span ? [U0 + fn.span[0], U0 + fn.span[1]] : [U0, U1];
  const h = fn.y[1] - fn.y[0];
  const batch = piece.bins.of(l);
  const y0 = ground + fn.y[0];
  const below = fn.y[0] <= EPS ? -Infinity : y0;
  for (let u = a + fn.phase; u <= b + EPS; u += fn.every) {
    const { p, t, n } = pointAt(c, u);
    if (fn.round) {
      const at = p.clone().addScaledVector(n, fn.out);
      const g = new THREE.CylinderGeometry(fn.width / 2, fn.width / 2, h, ctx.detail.sides, 1, true);
      batch.geometry(g, new THREE.Matrix4().makeTranslation(at.x, y0 + h / 2, at.y), l.color, surf(l, false));
      g.dispose();
      piece.site.circle(at.x, at.y, fn.width / 2, ground + fn.y[1], false, below);
    } else {
      const at = p.clone().addScaledVector(n, fn.out / 2);
      boxAt(batch, at, t, y0 + h / 2, fn.width, h, fn.out, l.color, surf(l, false));
      piece.site.box(at.x, at.y, fn.width / 2, fn.out / 2, Math.atan2(t.y, t.x), ground + fn.y[1], false, below);
    }
  }
}

/** Los paneles de colores de una cara (sembrados con el id del volumen). */
function panels(p: MallPanels, c: Chain, U0: number, U1: number, ground: number, seed: number, piece: Piece, ctx: Ctx): void {
  const looks = p.skins.map((s) => ctx.skins.look(s));
  const lerp = (r: number[], t: number): number => r[0] + (r[1] - r[0]) * t;
  let u = U0 + p.margin[0];
  let k = 0;
  while (true) {
    const w = lerp(p.width, rand(seed + k, 41));
    if (u + w > U1 - p.margin[1]) break;
    const h = lerp(p.height, rand(seed + k, 43));
    const l = looks[Math.floor(rand(seed + k, 47) * looks.length) % looks.length];
    rectOn(piece, c, { u0: u, u1: u + w, y0: ground + p.y, y1: ground + p.y + h }, p.out, l, litNow(l, seed), true);
    u += w + lerp(p.gap, rand(seed + k, 53));
    k++;
  }
}

/**
 * Contorno en U de medio ancho `w`, centrado en x = 0: las patas desde `foot` y arriba un arco de
 * círculo de radio `R` con centro en (0, cy) (medio punto: R = w; rebajado: R > w).
 */
function uPath(w: number, foot: number, R: number, cy: number, segments: number, reverse: boolean): THREE.Vector2[] {
  const spring = cy + Math.sqrt(Math.max(R * R - w * w, 0));
  const a0 = Math.atan2(spring - cy, w);
  const pts: THREE.Vector2[] = [new THREE.Vector2(-w, foot), new THREE.Vector2(-w, spring)];
  for (let k = 1; k < segments; k++) {
    const a = Math.PI - a0 - ((Math.PI - 2 * a0) * k) / segments;
    pts.push(new THREE.Vector2(Math.cos(a) * R, cy + Math.sin(a) * R));
  }
  pts.push(new THREE.Vector2(w, spring), new THREE.Vector2(w, foot));
  return reverse ? pts.reverse() : pts;
}

/** Un arco de portada (o una arcada de ellos): sus bandas en U, el paño de adentro y el rosetón. */
function arch(a: MallArch, c: Chain, U0: number, ground: number, piece: Piece, ctx: Ctx): void {
  const [count, every] = a.repeat ?? [1, 0];
  for (let k = 0; k < count; k++) archAt(a, c, U0 + a.u + k * every, ground, piece, ctx);
}

/** Un arco centrado a `u` m del comienzo de la cadena. */
function archAt(a: MallArch, c: Chain, u: number, ground: number, piece: Piece, ctx: Ctx): void {
  const { p, t, n } = pointAt(c, u);
  // Marco del arco: x a lo largo de la cara, y arriba, z hacia afuera (puede espejar: Batch lo
  // corrige), corrido `out` m delante de la fachada.
  const base = p.clone().addScaledVector(n, a.out ?? 0);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(t.x, 0, t.y), UP, new THREE.Vector3(n.x, 0, n.y)).setPosition(base.x, ground, base.y);
  const segs = Math.max(ctx.detail.curve, Math.ceil((Math.PI * a.width) / 2 / ctx.detail.arc));
  // El círculo del arco exterior (medio punto o rebajado); las bandas de adentro son concéntricas.
  const half = a.width / 2;
  const rise = Math.min(a.rise ?? half, half);
  let R = (half * half + rise * rise) / (2 * rise);
  const cy = a.top - R;
  let w = half;
  for (const r of a.rings) {
    const l = ctx.skins.look(r.skin);
    const outer = uPath(w, a.foot, R, cy, segs, false);
    const inner = uPath(w - r.width, a.foot, R - r.width, cy, segs, true);
    const shape = new THREE.Shape([...outer, ...inner]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: r.out, bevelEnabled: false, curveSegments: 1 });
    piece.bins.of(l).geometry(g, m, l.color, surf(l, false));
    g.dispose();
    w -= r.width;
    R -= r.width;
  }
  // El paño de adentro, `detail.film` delante del muro ('open': sin paño, se ve lo que haya detrás).
  const inf = ctx.skins.look(a.infill);
  if (!inf.open) {
    const lift = new THREE.Matrix4().makeTranslation(0, 0, ctx.detail.film);
    const inner = new THREE.Shape(uPath(w, a.foot, R, cy, segs, false));
    const gi = new THREE.ShapeGeometry(inner, 1);
    const uv = gi.getAttribute('uv');
    const pos = gi.getAttribute('position');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, pos.getX(k), pos.getY(k));
    piece.bins.of(inf).geometry(gi, m.clone().multiply(lift), inf.color, surf(inf, inf.lit > 0));
    gi.dispose();
  }
  const Rs = a.rose;
  if (!Rs) return;
  const glass = ctx.skins.look(Rs.skin);
  const frame = ctx.skins.look(Rs.frame);
  const disc = new THREE.CircleGeometry(Rs.radius, Math.max(ctx.detail.sides, segs * 2));
  const at = (z: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(0, Rs.y, z));
  const [glassOut, frameOut] = Rs.out;
  piece.bins.of(glass).geometry(disc, at(glassOut), glass.color, surf(glass, glass.lit > 0));
  disc.dispose();
  const fb = piece.bins.of(frame, true);
  for (const r of Rs.rings) {
    const ring = new THREE.RingGeometry(Math.max(0, r - Rs.bar / 2), r + Rs.bar / 2, Math.max(ctx.detail.sides, segs * 2));
    fb.geometry(ring, at(frameOut), frame.color, surf(frame, false));
    ring.dispose();
  }
  for (let k = 0; k < Rs.spokes; k++) {
    const ang = (k / Rs.spokes) * Math.PI * 2;
    const mm = at(frameOut).multiply(new THREE.Matrix4().makeRotationZ(ang)).multiply(new THREE.Matrix4().makeTranslation(Rs.radius / 2, 0, 0));
    fb.box(mm, Rs.radius, Rs.bar, Rs.bar, frame.color, surf(frame, false));
  }
}

/** Marco de una pieza pegada a la cadena en `u`: x a la derecha de quien mira desde afuera, y arriba, z hacia afuera. */
function faceFrame(c: Chain, u: number, y: number): { m: THREE.Matrix4; p: V2; t: V2; n: V2 } {
  const { p, t, n } = pointAt(c, u);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(n.y, 0, -n.x), UP, new THREE.Vector3(n.x, 0, n.y)).setPosition(p.x, y, p.y);
  return { m, p, t, n };
}

/** El recorrido de un relieve en (du, y): los arcos en tramos y, si lo pide, completado en espejo. */
function reliefPath(r: MallRelief, ctx: Ctx): V2[] {
  const P = r.points.map((q) => v2(q[0], q[1]));
  // Una figura llena o una moldura cerrada vuelven al primer punto (salvo la mitad de un espejo).
  const loop = (!r.width || !!r.closed) && !r.mirror;
  const out: V2[] = [];
  P.forEach((a, i) => {
    out.push(a.clone());
    const s = r.points[i][2] ?? 0;
    const j = i + 1 < P.length ? i + 1 : loop ? 0 : -1;
    if (j < 0 || Math.abs(s) < EPS) return;
    const b = P[j];
    const d = b.clone().sub(a);
    out.push(...arcPoints(a, b, v2(-d.y, d.x).normalize(), s, ctx.detail.arc, ctx.detail.curve).slice(0, -1));
  });
  if (!r.mirror) return out;
  const full = [
    ...out
      .slice(1)
      .reverse()
      .map((q) => v2(-q.x, q.y)),
    ...out,
  ];
  // La mitad de una figura llena termina en el eje: la primera y la última coinciden.
  if (full.length > 2 && full[0].distanceTo(full[full.length - 1]) < EPS) full.pop();
  return full;
}

/** La polilínea corrida `d` m hacia su izquierda (a inglete en los quiebres). */
function offsetLine(pts: readonly V2[], d: number, closed: boolean): V2[] {
  const N = pts.length;
  const left = (a: V2, b: V2): V2 => {
    const t = b.clone().sub(a).normalize();
    return v2(-t.y, t.x);
  };
  return pts.map((p, k) => {
    const prev = k > 0 ? pts[k - 1] : closed ? pts[N - 1] : null;
    const next = k < N - 1 ? pts[k + 1] : closed ? pts[0] : null;
    const n1 = prev ? left(prev, p) : null;
    const n2 = next ? left(p, next) : null;
    const m = n1 && n2 ? miter(n1, n2) : ((n1 ?? n2) as V2);
    return p.clone().addScaledVector(m, d);
  });
}

/** Un relieve (moldura por un recorrido o figura llena), repetido a lo largo de la cara. */
function relief(r: MallRelief, c: Chain, U0: number, ground: number, piece: Piece, ctx: Ctx): void {
  const l = ctx.skins.look(r.skin);
  if (l.open) return;
  const pts = reliefPath(r, ctx);
  // El contorno de la figura (du, y) y sus huecos (el de adentro de un anillo).
  let outer: V2[];
  const holes: V2[][] = [];
  if (r.width && r.width > EPS) {
    const closed = !!r.closed && !r.mirror;
    const L = offsetLine(pts, r.width / 2, closed);
    const Rt = offsetLine(pts, -r.width / 2, closed);
    if (closed) {
      const [o, inner] = Math.abs(signedArea(L)) >= Math.abs(signedArea(Rt)) ? [L, Rt] : [Rt, L];
      outer = o;
      holes.push(inner);
    } else {
      outer = [...L, ...Rt.reverse()];
    }
  } else {
    outer = pts;
  }
  const back = r.back ?? 0;
  const [count, every] = r.repeat ?? [1, 0];
  if (r.follow) {
    for (let k = 0; k < count; k++) followRelief(outer, holes, c, U0 + r.u + k * every, ground, r.out, back, l, piece);
    return;
  }
  const shape = new THREE.Shape(outer);
  for (const h of holes) shape.holes.push(new THREE.Path(h));
  const g = new THREE.ExtrudeGeometry(shape, { depth: r.out + back, bevelEnabled: false, curveSegments: 1 });
  const b = piece.bins.of(l);
  const behind = new THREE.Matrix4().makeTranslation(0, 0, -back);
  for (let k = 0; k < count; k++) {
    const { m } = faceFrame(c, U0 + r.u + k * every, ground);
    b.geometry(g, m.multiply(behind), l.color, surf(l, l.lit > 0));
  }
  g.dispose();
}

/**
 * Un tramo recto de la cadena para lo que la sigue: dónde arranca (u), su largo, su punta, su
 * tangente y hacia dónde se corre cada punta (a inglete con el tramo vecino).
 */
interface Leg {
  u: number;
  len: number;
  a: V2;
  t: V2;
  n: V2;
  oa: V2;
  ob: V2;
}

function legsOf(c: Chain): Leg[] {
  const N = c.segs.length;
  return c.segs.map((g, k) => {
    const prev = k > 0 ? c.segs[k - 1] : c.closed ? c.segs[N - 1] : null;
    const next = k < N - 1 ? c.segs[k + 1] : c.closed ? c.segs[0] : null;
    return { u: c.u[k], len: g.len, a: g.a, t: g.t, n: g.n, oa: prev ? miter(prev.n, g.n) : g.n.clone(), ob: next ? miter(g.n, next.n) : g.n.clone() };
  });
}

/** El tramo de la cadena donde cae `u` (fuera de la cadena, el de la punta más cercana). */
function legAt(legs: readonly Leg[], u: number): Leg {
  let k = 0;
  while (k < legs.length - 1 && legs[k].u + legs[k].len <= u) k++;
  return legs[k];
}

/** El punto de la fachada a `u` m del comienzo de la cadena, corrido `d` m hacia afuera, a la altura `y`. */
function onLeg(g: Leg, u: number, y: number, d: number): THREE.Vector3 {
  const f = THREE.MathUtils.clamp((u - g.u) / g.len, 0, 1);
  const p = g.a.clone().addScaledVector(g.t, u - g.u);
  const o = g.oa.clone().lerp(g.ob, f);
  return new THREE.Vector3(p.x + o.x * d, y, p.y + o.y * d);
}

/** Un polígono convexo (u, y) cortado por la vertical u = `at`: lo de la izquierda y lo de la derecha. */
function splitAt(poly: readonly V2[], at: number): [V2[], V2[]] {
  const L: V2[] = [];
  const R: V2[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    if (a.x <= at + EPS) L.push(a);
    if (a.x >= at - EPS) R.push(a);
    if ((a.x < at - EPS && b.x > at + EPS) || (a.x > at + EPS && b.x < at - EPS)) {
      const q = v2(at, a.y + ((at - a.x) / (b.x - a.x)) * (b.y - a.y));
      L.push(q);
      R.push(q);
    }
  });
  return [L, R];
}

/**
 * Un relieve que sigue la cadena: la figura (du, y) con sus huecos, con su eje a `u` m del
 * comienzo de la cadena, cortada en los quiebres de la cadena para que cada pedazo vaya plano
 * sobre su tramo; cara de afuera (a `out` m), cara de atrás (a `back` m detrás del muro) y cantos.
 * du va hacia la derecha de quien mira desde afuera, como en un relieve plano, vaya la cadena
 * hacia donde vaya.
 */
function followRelief(outer: V2[], holes: V2[][], c: Chain, u0: number, ground: number, out: number, back: number, l: Look, piece: Piece): void {
  const legs = legsOf(c);
  const b = piece.bins.of(l);
  const s = surf(l, l.lit > 0);
  // ¿La cadena avanza hacia la derecha de quien la mira desde afuera (+1) o hacia la izquierda (−1)?
  const g0 = legs[0];
  const way = g0.t.x * g0.n.y - g0.t.y * g0.n.x >= 0 ? 1 : -1;
  const breaks = legs.slice(1).map((g) => (g.u - u0) * way);
  const legOf = (du: number): Leg => legAt(legs, u0 + du * way);
  const P = (q: V2, d: number, g: Leg): THREE.Vector3 => onLeg(g, u0 + q.x * way, ground + q.y, d);
  // Caras: cada triángulo de la figura cortado en los quiebres, de afuera y de atrás.
  const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
  const all = [...outer, ...holes.flat()];
  for (const [i, j, k] of tris) {
    let pieces: V2[][] = [[all[i], all[j], all[k]]];
    for (const at of breaks) pieces = pieces.flatMap((p) => (p.some((q) => q.x < at - EPS) && p.some((q) => q.x > at + EPS) ? splitAt(p, at) : [p])).filter((p) => p.length >= 3);
    for (const p of pieces) {
      const g = legOf(p.reduce((acc, q) => acc + q.x, 0) / p.length);
      const n = new THREE.Vector3(g.n.x, 0, g.n.y);
      for (let m = 1; m + 1 < p.length; m++) {
        const uv = [p[0].x, p[0].y, p[m].x, p[m].y, p[m + 1].x, p[m + 1].y];
        tri(b, P(p[0], out, g), P(p[m], out, g), P(p[m + 1], out, g), n, l.color, s, uv);
        tri(b, P(p[0], -back, g), P(p[m], -back, g), P(p[m + 1], -back, g), n.clone().negate(), l.color, s, uv);
      }
    }
  }
  // Cantos: cada borde (cortado en los quiebres) de afuera hacia atrás, mirando fuera de la figura
  // (a la derecha del avance si el anillo va antihorario; en un hueco, al revés).
  const edge = surf(l, false);
  [outer, ...holes].forEach((ring, h) => {
    const sgn = Math.sign(signedArea(ring)) * (h === 0 ? 1 : -1);
    ring.forEach((a, i) => {
      const e = ring[(i + 1) % ring.length];
      if (a.distanceTo(e) < EPS) return;
      const cuts = [a.x, ...breaks.filter((at) => (at - a.x) * (at - e.x) < -EPS), e.x].sort((x, y) => (e.x >= a.x ? x - y : y - x));
      const lerp = (x: number): V2 => a.clone().lerp(e, (x - a.x) / (e.x - a.x));
      for (let m = 0; m + 1 < cuts.length; m++) {
        const p = m === 0 ? a : lerp(cuts[m]);
        const q = m + 2 === cuts.length ? e : lerp(cuts[m + 1]);
        const g = legOf((p.x + q.x) / 2);
        const du = (q.y - p.y) * sgn * way;
        const dir = new THREE.Vector3(g.t.x * du, -(q.x - p.x) * sgn, g.t.y * du);
        const s0 = a.distanceTo(p);
        const s1 = a.distanceTo(q);
        tri(b, P(p, out, g), P(q, out, g), P(q, -back, g), dir, l.color, edge, [s0, out, s1, out, s1, -back]);
        tri(b, P(p, out, g), P(q, -back, g), P(p, -back, g), dir, l.color, edge, [s0, out, s1, -back, s0, -back]);
      }
    });
  });
}

/** Los balcones de una cara: la losa, la baranda calada de frente y a los costados y su pasamanos. */
function balconies(bl: MallBalcony, c: Chain, U0: number, ground: number, piece: Piece, ctx: Ctx): void {
  const slab = ctx.skins.look(bl.skins.slab);
  const rail = ctx.skins.look(bl.skins.rail);
  const hand = ctx.skins.look(bl.skins.handrail);
  const [nu, du] = bl.repeat ?? [1, 0];
  const [nr, dr] = bl.rows ?? [1, 0];
  const w = bl.width / 2;
  const D = bl.depth;
  for (let r = 0; r < nr; r++) {
    for (let k = 0; k < nu; k++) {
      const { p, t, n } = pointAt(c, U0 + bl.u + k * du);
      const y = ground + bl.y + r * dr;
      const at = (s: number, o: number): V2 => p.clone().addScaledVector(t, s * w).addScaledVector(n, o);
      boxAt(piece.bins.of(slab), at(0, D / 2), t, y - bl.slab / 2, bl.width, bl.slab, D, slab.color, surf(slab, false));
      // Baranda (calada: una sola cara basta), uv en m desde su pie.
      const rb = piece.bins.of(rail);
      const rs = surf(rail, false);
      vquad(rb, at(-1, D), at(1, D), y, y + bl.rail, n, rail.color, rs, 0, bl.width, 0, bl.rail);
      vquad(rb, at(-1, 0), at(-1, D), y, y + bl.rail, t.clone().negate(), rail.color, rs, 0, D, 0, bl.rail);
      vquad(rb, at(1, 0), at(1, D), y, y + bl.rail, t, rail.color, rs, 0, D, 0, bl.rail);
      if (bl.handrail > EPS) {
        const hb = piece.bins.of(hand, true);
        const hy = y + bl.rail + bl.handrail / 2;
        boxAt(hb, at(0, D), t, hy, bl.width + bl.handrail, bl.handrail, bl.handrail, hand.color, surf(hand, false));
        for (const s of [-1, 1]) boxAt(hb, at(s, D / 2), n, hy, D, bl.handrail, bl.handrail, hand.color, surf(hand, false));
      }
    }
  }
}

/** Un faldón inclinado a lo largo de la cara (con inglete en las esquinas): arriba, cielo raso, canto y puntas. */
function eave(e: MallEave, c: Chain, U0: number, U1: number, ground: number, piece: Piece, ctx: Ctx): void {
  const top = ctx.skins.look(e.skins.top);
  const soffit = ctx.skins.look(e.skins.soffit);
  const edge = ctx.skins.look(e.skins.edge);
  const y1 = ground + e.y;
  const y2 = y1 - e.drop;
  const T = e.thickness;
  const slope = Math.hypot(e.out, e.drop);
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  const parts = spans(c, U0, U1);
  const outer = (q: V2, o: V2): V2 => q.clone().addScaledVector(o, e.out);
  for (const p of parts) {
    const Ao = outer(p.A, p.oa);
    const Bo = outer(p.B, p.ob);
    // La teja: u a lo largo, v bajando por la pendiente (world/surfacePatterns.ts → roofTiles).
    hquad(piece.bins.of(top), P(p.A, y1), P(p.B, y1), P(Bo, y2), P(Ao, y2), true, top.color, surf(top, false), [p.ua, 0, p.ub, 0, p.ub, slope, p.ua, slope]);
    hquad(piece.bins.of(soffit), P(p.A, y1 - T), P(p.B, y1 - T), P(Bo, y2 - T), P(Ao, y2 - T), false, soffit.color, surf(soffit, false));
    vquad(piece.bins.of(edge), Ao, Bo, y2 - T, y2, p.n, edge.color, surf(edge, false), p.ua, p.ub);
  }
  if (!parts.length || (c.closed && U0 < EPS && U1 > c.length - EPS)) return;
  // Las puntas: el perfil del faldón, del muro al borde, mirando hacia afuera de la cadena.
  const cap = (q: V2, o: V2, dir: V2): void => {
    const qo = outer(q, o);
    const d = new THREE.Vector3(dir.x, 0, dir.y);
    const eb = piece.bins.of(edge);
    const s = surf(edge, false);
    tri(eb, P(q, y1), P(qo, y2), P(qo, y2 - T), d, edge.color, s, [0, y1, e.out, y2, e.out, y2 - T]);
    tri(eb, P(q, y1), P(qo, y2 - T), P(q, y1 - T), d, edge.color, s, [0, y1, e.out, y2 - T, 0, y1 - T]);
  };
  const first = parts[0];
  const last = parts[parts.length - 1];
  cap(first.A, first.oa, first.t.clone().negate());
  cap(last.B, last.ob, last.t);
}

/** Toldos de media cúpula (un cuarto de esfera con su cara de adentro), repetidos a lo largo de la cara. */
function hoods(h: MallHood, c: Chain, U0: number, ground: number, piece: Piece, ctx: Ctx): void {
  const l = ctx.skins.look(h.skin);
  const segs = Math.max(ctx.detail.curve, Math.ceil((Math.PI * h.width) / 2 / ctx.detail.arc));
  // Media esfera de arriba (y ≥ 0) cortada por el plano del muro (z ≥ 0), de radio 1.
  const out = new THREE.SphereGeometry(1, segs * 2, segs, 0, Math.PI, 0, Math.PI / 2);
  const inside = inward(out.clone());
  const scale = new THREE.Matrix4().makeScale(h.width / 2, h.height, h.depth);
  const b = piece.bins.of(l);
  const [count, every] = h.repeat ?? [1, 0];
  for (let k = 0; k < count; k++) {
    const { m } = faceFrame(c, U0 + h.u + k * every, ground + h.y);
    m.multiply(scale);
    b.geometry(out, m, l.color, surf(l, false));
    b.geometry(inside, m, l.color, surf(l, false));
  }
  out.dispose();
  inside.dispose();
}

/** El antepecho de la azotea por dentro: la cara de adentro (si tiene alto) y el tope. */
function parapet(o: Outline, y: number, [h, thick]: number[], l: Look, piece: Piece): void {
  const c = chainOf(
    o,
    Array.from({ length: o.sides }, (_, k) => k),
  );
  const b = piece.bins.of(l);
  const s = surf(l, false);
  const P = (q: V2, yy: number): THREE.Vector3 => new THREE.Vector3(q.x, yy, q.y);
  for (const p of spans(c, 0, c.length)) {
    const Ai = p.A.clone().addScaledVector(p.oa, -thick);
    const Bi = p.B.clone().addScaledVector(p.ob, -thick);
    if (h > EPS) vquad(b, Ai, Bi, y, y + h, p.n.clone().negate(), l.color, s, p.ua, p.ub);
    hquad(b, P(p.A, y + h), P(p.B, y + h), P(Bi, y + h), P(Ai, y + h), true, l.color, s);
  }
}

/** Marco de una planta de 4 lados rectos: centro, eje a lo largo del lado `along`, largo y ancho. */
export function rectFrame(o: Outline, along: number): { c: V2; u: V2; v: V2; L: number; W: number } {
  const S = o.segs;
  const k = along % 4;
  const u = S[k].t.clone();
  const v = v2(-u.y, u.x);
  const c = S.reduce((acc, g) => acc.add(g.a), v2(0, 0)).divideScalar(4);
  const L = (S[k].len + S[(k + 2) % 4].len) / 2;
  const W = (S[(k + 1) % 4].len + S[(k + 3) % 4].len) / 2;
  return { c, u, v, L, W };
}

/**
 * El techo de un volumen: la azotea (triangulada sobre la planta) o un techo inclinado sobre una
 * planta de 4 lados, con lo que se ve desde abajo (`roof.under`: el cielo del alero y su canto, o
 * la cara de abajo del techo entero si el volumen no tiene muros). Devuelve las aguas para la
 * física del macizo (a dos, cuatro o un agua; la bóveda y los dientes se pisan a la altura del
 * alero).
 */
function roof(v: MallVolume, o: Outline, ground: number, piece: Piece, ctx: Ctx): LocalRoof | undefined {
  const R = v.roof;
  const l = ctx.skins.look(R.skin);
  const b = piece.bins.of(l);
  const top = ground + v.height;
  const s = surf(l, false);
  if (R.kind === 'flat') {
    const tris = THREE.ShapeUtils.triangulateShape(o.pts, []);
    const P = (q: V2): THREE.Vector3 => new THREE.Vector3(q.x, top, q.y);
    for (const [i, j, k] of tris) tri(b, P(o.pts[i]), P(o.pts[j]), P(o.pts[k]), UP, l.color, s, [o.pts[i].x, o.pts[i].y, o.pts[j].x, o.pts[j].y, o.pts[k].x, o.pts[k].y]);
    return undefined;
  }
  const { c, u, v: vv, L, W } = rectFrame(o, R.along ?? 0);
  const rise = R.rise ?? 0;
  const e = R.eave ?? 0;
  const gl = ctx.skins.look(R.gable ?? v.skin);
  const gb = piece.bins.of(gl);
  const gs = surf(gl, false);
  const Q = (a: number, bb: number): V2 => c.clone().addScaledVector(u, a).addScaledVector(vv, bb);
  const P = (a: number, bb: number, y: number): THREE.Vector3 => {
    const q = Q(a, bb);
    return new THREE.Vector3(q.x, y, q.y);
  };
  const side = (a: number, bb: number): V2 => u.clone().multiplyScalar(a).addScaledVector(vv, bb);
  const dir = (a: number, bb: number): THREE.Vector3 => {
    const q = side(a, bb);
    return new THREE.Vector3(q.x, 0, q.y);
  };
  const hl = L / 2;
  const hw = W / 2;
  const lu = hl + e;
  // Lo de abajo: sin muros (piel 'open') se ve el techo entero; con muros, lo que vuela.
  const open = ctx.skins.look(v.skin).open;
  const U = R.under && (e > EPS || open) ? R.under : undefined;
  const sl = U ? ctx.skins.look(U.soffit) : l;
  const el = U ? ctx.skins.look(U.edge) : l;
  const sb = piece.bins.of(sl);
  const ss = surf(sl, false);
  const eb = piece.bins.of(el);
  const es = surf(el, false);
  const T = U ? U.fascia : 0;
  if (R.kind === 'gable' || R.kind === 'hip') {
    const hip = R.kind === 'hip';
    const slope = rise / hw;
    const yE = top - e * slope;
    const yR = top + rise;
    const hr = hip ? Math.max(0, hl - hw) : lu;
    const lv = hw + e;
    const down = Math.hypot(lv, lv * slope);
    for (const sv of [1, -1]) hquad(b, P(-lu, sv * lv, yE), P(lu, sv * lv, yE), P(hr, 0, yR), P(-hr, 0, yR), true, l.color, s, [-lu, down, lu, down, hr, 0, -hr, 0]);
    for (const su of [1, -1]) {
      if (hip) tri(b, P(su * lu, -lv, yE), P(su * lu, lv, yE), P(su * hr, 0, yR), UP, l.color, s, [-lv, down, lv, down, 0, 0]);
      else if (!gl.open) tri(gb, P(su * hl, -hw, top), P(su * hl, hw, top), P(su * hl, 0, yR), dir(su, 0), gl.color, gs, [-hw, top, hw, top, 0, yR]);
    }
    if (U) {
      // uv del cielo como las de las aguas: a lo largo del alero y bajando por la pendiente.
      if (open) {
        // Sin muros: la cara de abajo de cada faldón, `fascia` m más abajo que las aguas.
        for (const sv of [1, -1]) hquad(sb, P(-lu, sv * lv, yE - T), P(lu, sv * lv, yE - T), P(hr, 0, yR - T), P(-hr, 0, yR - T), false, sl.color, ss, [-lu, down, lu, down, hr, 0, -hr, 0]);
        if (hip) for (const su of [1, -1]) tri(sb, P(su * lu, -lv, yE - T), P(su * lu, lv, yE - T), P(su * hr, 0, yR - T), DOWN, sl.color, ss, [-lv, down, lv, down, 0, 0]);
      } else if (hip) {
        // El cielo del alero alrededor: del tope de los muros al pie del canto, mirando abajo.
        const corner = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ];
        for (let k = 0; k < 4; k++) {
          const [i, j] = [corner[k], corner[(k + 1) % 4]];
          const byU = k % 2 === 0;
          const uv = (a: number, bb: number): number[] => (byU ? [a, Math.abs(bb)] : [bb, Math.abs(a)]);
          hquad(sb, P(i[0] * hl, i[1] * hw, top), P(j[0] * hl, j[1] * hw, top), P(j[0] * lu, j[1] * lv, yE - T), P(i[0] * lu, i[1] * lv, yE - T), false, sl.color, ss, [...uv(i[0] * hl, i[1] * hw), ...uv(j[0] * hl, j[1] * hw), ...uv(j[0] * lu, j[1] * lv), ...uv(i[0] * lu, i[1] * lv)]);
        }
      } else {
        // A dos aguas: bajo el alero de cada costado y bajo el vuelo de los hastiales.
        for (const sv of [1, -1]) {
          hquad(sb, P(-hl, sv * hw, top), P(hl, sv * hw, top), P(lu, sv * lv, yE - T), P(-lu, sv * lv, yE - T), false, sl.color, ss, [-hl, hw, hl, hw, lu, lv, -lu, lv]);
          for (const su of [1, -1]) hquad(sb, P(su * hl, sv * hw, top), P(su * hl, 0, yR), P(su * lu, 0, yR - T), P(su * lu, sv * lv, yE - T), false, sl.color, ss, [su * hl, hw, su * hl, 0, su * lu, 0, su * lu, lv]);
        }
      }
      // El canto del borde: en los aleros y, a dos aguas, subiendo por los hastiales.
      for (const sv of [1, -1]) vquad(eb, Q(-lu, sv * lv), Q(lu, sv * lv), yE - T, yE, side(0, sv), el.color, es, -lu, lu);
      for (const su of [1, -1]) {
        if (hip) vquad(eb, Q(su * lu, -lv), Q(su * lu, lv), yE - T, yE, side(su, 0), el.color, es, -lv, lv);
        else for (const sv of [1, -1]) quadTo(eb, [P(su * lu, sv * lv, yE - T), P(su * lu, 0, yR - T), P(su * lu, 0, yR), P(su * lu, sv * lv, yE)], dir(su, 0), el.color, es, [sv * lv, yE - T, 0, yR - T, 0, yR, sv * lv, yE]);
      }
    }
    return { hip, x: c.x, z: c.y, angle: Math.atan2(u.y, u.x), halfWidth: hw, halfLength: hl, slope, edge: top };
  }
  if (R.kind === 'shed') {
    // Un agua: sube de −v (el muro bajo) a +v (el alto), y vuela `eave` m en las puntas; el muro
    // alto y los dos hastiales en punta.
    const yH = top + rise;
    hquad(b, P(-lu, -hw, top), P(lu, -hw, top), P(lu, hw, yH), P(-lu, hw, yH), true, l.color, s);
    if (!gl.open) {
      vquad(gb, Q(-hl, hw), Q(hl, hw), top, yH, vv, gl.color, gs, -hl, hl);
      for (const su of [1, -1]) tri(gb, P(su * hl, -hw, top), P(su * hl, hw, top), P(su * hl, hw, yH), dir(su, 0), gl.color, gs, [-hw, top, hw, top, hw, yH]);
    }
    if (U) {
      if (open) hquad(sb, P(-lu, -hw, top - T), P(lu, -hw, top - T), P(lu, hw, yH - T), P(-lu, hw, yH - T), false, sl.color, ss, [-lu, hw, lu, hw, lu, -hw, -lu, -hw]);
      else for (const su of [1, -1]) hquad(sb, P(su * hl, -hw, top), P(su * hl, hw, yH), P(su * lu, hw, yH - T), P(su * lu, -hw, top - T), false, sl.color, ss, [su * hl, hw, su * hl, -hw, su * lu, -hw, su * lu, hw]);
      // El canto: en las puntas y en los bordes largos (con muros, solo lo que vuela).
      for (const su of [1, -1]) quadTo(eb, [P(su * lu, -hw, top - T), P(su * lu, hw, yH - T), P(su * lu, hw, yH), P(su * lu, -hw, top)], dir(su, 0), el.color, es, [-hw, top - T, hw, yH - T, hw, yH, -hw, top]);
      for (const sv of [1, -1]) {
        const y = sv < 0 ? top : yH;
        if (open) vquad(eb, Q(-lu, sv * hw), Q(lu, sv * hw), y - T, y, side(0, sv), el.color, es, -lu, lu);
        else for (const su of [1, -1]) tri(eb, P(su * hl, sv * hw, y), P(su * lu, sv * hw, y), P(su * lu, sv * hw, y - T), dir(0, sv), el.color, es, [su * hl, y, su * lu, y, su * lu, y - T]);
      }
    }
    // Para la física, medio techo a dos aguas con la cumbrera en el muro alto: sube de `top` en el
    // muro bajo a `top + rise` en el alto (la otra mitad cae fuera de la planta).
    const ridge = Q(0, hw);
    return { hip: false, x: ridge.x, z: ridge.y, angle: Math.atan2(u.y, u.x), halfWidth: W, halfLength: hl, slope: rise / W, edge: top };
  }
  if (R.kind === 'vault') {
    // Bóveda de cañón a lo largo de u: un arco de círculo que sube `rise` en el medio.
    const segs = Math.max(ctx.detail.curve, Math.ceil((Math.PI * W) / 2 / ctx.detail.arc));
    const Rr = (hw * hw + rise * rise) / (2 * rise);
    const a0 = Math.asin(THREE.MathUtils.clamp(hw / Rr, -1, 1));
    const at = (k: number): number[] => {
      const a = -a0 + (2 * a0 * k) / segs;
      return [Math.sin(a) * Rr, top + rise - Rr + Math.cos(a) * Rr, (Rr * 2 * a0 * k) / segs];
    };
    for (let k = 0; k < segs; k++) {
      const [v0, y0, s0] = at(k);
      const [v1, y1, s1] = at(k + 1);
      hquad(b, P(-hl, v0, y0), P(hl, v0, y0), P(hl, v1, y1), P(-hl, v1, y1), true, l.color, s, [-hl, s0, hl, s0, hl, s1, -hl, s1]);
      for (const su of [1, -1]) tri(gb, P(su * hl, v0, y0), P(su * hl, v1, y1), P(su * hl, 0, top), dir(su, 0), gl.color, gs, [v0, y0, v1, y1, 0, top]);
    }
    return undefined;
  }
  if (R.kind === 'sawtooth') {
    const n = Math.max(1, R.teeth ?? 1);
    const tl = L / n;
    const seed = seedOf(v.id);
    for (let k = 0; k < n; k++) {
      const a0 = -hl + k * tl;
      const a1 = a0 + tl;
      // El vidrio vertical del diente (mira hacia −u) y el faldón que baja hasta el diente siguiente.
      vquad(gb, Q(a0, -hw), Q(a0, hw), top, top + rise, u.clone().negate(), gl.color, surf(gl, litNow(gl, seed)), -hw, hw);
      hquad(b, P(a0, -hw, top + rise), P(a0, hw, top + rise), P(a1, hw, top), P(a1, -hw, top), true, l.color, s);
      for (const sv of [1, -1]) tri(b, P(a0, sv * hw, top), P(a1, sv * hw, top), P(a0, sv * hw, top + rise), dir(0, sv), l.color, s, [a0, top, a1, top, a0, top + rise]);
    }
    return undefined;
  }
  throw new Error(`Techo desconocido en el volumen ${v.id}: ${R.kind} (hay: flat, gable, hip, shed, vault, sawtooth)`);
}

// ---------------------------------------------------------------------------------------------
// Marquesinas

/** Una marquesina: la losa con su canto, el cielo raso con sus plafones, los apoyos y la física. */
export function buildCanopy(cn: MallCanopy, ref: number, piece: Piece, ctx: Ctx): void {
  if (cn.line.length > 2) {
    canopyPath(cn, ref, piece, ctx);
    return;
  }
  const a = v2(cn.line[0][0], cn.line[0][1]);
  const bb = v2(cn.line[1][0], cn.line[1][1]);
  const L = a.distanceTo(bb);
  const t = bb.clone().sub(a).divideScalar(L);
  const o = v2(-t.y, t.x).multiplyScalar(Math.sign(cn.depth));
  const D = Math.abs(cn.depth);
  const y0 = ref + cn.height;
  const y1 = y0 + cn.thickness;
  const top = ctx.skins.look(cn.skins.top);
  const soffit = ctx.skins.look(cn.skins.soffit);
  const fascia = ctx.skins.look(cn.skins.fascia);
  const at = (u: number, v: number): V2 => a.clone().addScaledVector(t, u).addScaledVector(o, v);
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  if ((cn.nose ?? 0) > EPS) {
    noseSlab(cn, at, t, o, L, D, y0, y1, piece, ctx);
  } else {
    const corners = [at(0, 0), at(L, 0), at(L, D), at(0, D)];
    const dropAt = (k: number): number => (k >= 2 ? cn.drop : 0);
    const cp = corners.map((q, k) => P(q, y1 - dropAt(k)));
    const cs = corners.map((q, k) => P(q, y0 - dropAt(k)));
    hquad(piece.bins.of(top), cp[0], cp[1], cp[2], cp[3], true, top.color, surf(top, false));
    hquad(piece.bins.of(soffit), cs[0], cs[1], cs[2], cs[3], false, soffit.color, surf(soffit, false));
    // Canto alrededor (cuelga `fascia` m desde el tope).
    const fb = piece.bins.of(fascia);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      const mid = corners[k].clone().add(corners[j]).multiplyScalar(0.5);
      const center = at(L / 2, D / 2);
      const facing = mid.clone().sub(center);
      const yt = y1 - Math.max(dropAt(k), dropAt(j));
      vquad(fb, corners[k], corners[j], yt - cn.fascia, yt, facing, fascia.color, surf(fascia, false), 0, corners[k].distanceTo(corners[j]));
    }
  }
  const bottom = y1 - Math.max(cn.fascia, cn.thickness) - cn.drop;
  const center = at(L / 2, D / 2);
  // El tope de la física: el más alto de los dos bordes (el de afuera sube si `drop` es negativo).
  piece.site.box(center.x, center.y, L / 2, D / 2, Math.atan2(t.y, t.x), y1 - Math.min(0, cn.drop), true, bottom);
  const sides = ctx.detail.sides;
  const Ps = cn.posts;
  if (Ps) {
    const pl = ctx.skins.look(Ps.skin);
    const pb = piece.bins.of(pl);
    for (const [u, v] of Ps.at) {
      const q = at(u, v);
      const foot = Ps.foot !== undefined ? ref + Ps.foot : ctx.kit.terrain(q.x, q.y) - ctx.ground.bury;
      // Un poste que arranca en alto (sobre un muro, un techo) no ataja por debajo de su pie.
      const below = Ps.foot !== undefined ? foot : -Infinity;
      const head = (Ps.top !== undefined ? ref + Ps.top : y0) - (Ps.y?.rise ?? 0);
      const [w, d] = Ps.size;
      const h = head - foot;
      if (Ps.round) {
        const g = new THREE.CylinderGeometry(w / 2, w / 2, h, sides, 1, true);
        pb.geometry(g, new THREE.Matrix4().makeTranslation(q.x, foot + h / 2, q.y), pl.color, surf(pl, false));
        g.dispose();
        piece.site.circle(q.x, q.y, w / 2, head, false, below);
      } else {
        boxAt(pb, q, t, foot + h / 2, w, h, d ?? w, pl.color, surf(pl, false));
        piece.site.box(q.x, q.y, w / 2, (d ?? w) / 2, Math.atan2(t.y, t.x), head, false, below);
      }
      if (Ps.y) {
        // Puntales en Y: de la cabeza del poste al cielo raso, abiertos a lo largo.
        for (const sgn of [-1, 1]) {
          const tip = at(u + sgn * Ps.y.spread, v);
          bar(pb, P(q, head), P(tip, y0), Ps.y.radius, sides, pl.color, surf(pl, false));
        }
      }
    }
  }
  const T = cn.ties;
  if (T) {
    const tl = ctx.skins.look(T.skin);
    for (const [u0, v0, y, u1, v1] of T.at) bar(piece.bins.of(tl, true), P(at(u0, v0), ref + y), P(at(u1, v1), y1 - (cn.drop * Math.abs(v1)) / D), T.radius, sides, tl.color, surf(tl, false));
  }
  plafonds(cn, y0, piece, ctx);
}

/**
 * La losa de una marquesina recta con el borde de afuera redondeado (`nose`): el tope y el cielo
 * raso hasta donde arranca la curva (inclinados por `drop`), la curva por afuera (piel del canto)
 * y por adentro (piel del cielo raso) con su labio de abajo, el canto de atrás (contra la fachada)
 * y los dos costados con el perfil entero. `at(u, v)`: el punto a `u` m a lo largo de la recta y
 * `v` m hacia afuera (`o`).
 */
function noseSlab(cn: MallCanopy, at: (u: number, v: number) => V2, t: V2, o: V2, L: number, D: number, y0: number, y1: number, piece: Piece, ctx: Ctx): void {
  const top = ctx.skins.look(cn.skins.top);
  const soffit = ctx.skins.look(cn.skins.soffit);
  const fascia = ctx.skins.look(cn.skins.fascia);
  const r = cn.nose as number;
  const T = cn.thickness;
  const F = cn.fascia;
  const v0 = D - r;
  // El tope donde arranca la curva y el pie del canto.
  const yN = y1 - (cn.drop * v0) / D;
  const foot = yN - F;
  const n = Math.max(ctx.detail.curve, Math.ceil((Math.PI * Math.max(r, F)) / 2 / ctx.detail.arc));
  // El perfil (v hacia afuera, y) de la curva: un cuarto de elipse por afuera, del tope al pie, y
  // otro por adentro (más chico en el grosor), del cielo raso al pie; con la normal de cada punto.
  const outer: V2[] = [];
  const inner: V2[] = [];
  const normal: V2[] = [];
  for (let k = 0; k <= n; k++) {
    const q = (Math.PI / 2) * (k / n);
    outer.push(v2(v0 + r * Math.sin(q), foot + F * Math.cos(q)));
    inner.push(v2(v0 + (r - T) * Math.sin(q), foot + (F - T) * Math.cos(q)));
    normal.push(v2(Math.sin(q) / r, Math.cos(q) / F).normalize());
  }
  const P = (u: number, q: V2): THREE.Vector3 => {
    const p = at(u, q.x);
    return new THREE.Vector3(p.x, q.y, p.y);
  };
  const dir = (m: V2, s: number): THREE.Vector3 => new THREE.Vector3(o.x * m.x * s, m.y * s, o.y * m.x * s);
  // Una tira a lo largo de la marquesina entre dos puntos del perfil (uv: a lo largo y por el arco).
  const strip = (b: Batch, p: V2, q: V2, d: THREE.Vector3, l: Look, s0: number, s1: number): void => {
    tri(b, P(0, p), P(L, p), P(L, q), d, l.color, surf(l, false), [0, s0, L, s0, L, s1]);
    tri(b, P(0, p), P(L, q), P(0, q), d, l.color, surf(l, false), [0, s0, L, s1, 0, s1]);
  };
  hquad(piece.bins.of(top), P(0, v2(0, y1)), P(L, v2(0, y1)), P(L, v2(v0, yN)), P(0, v2(v0, yN)), true, top.color, surf(top, false));
  hquad(piece.bins.of(soffit), P(0, v2(0, y0)), P(L, v2(0, y0)), P(L, v2(v0, yN - T)), P(0, v2(v0, yN - T)), false, soffit.color, surf(soffit, false));
  const fb = piece.bins.of(fascia);
  const sb = piece.bins.of(soffit);
  let so = 0;
  let si = 0;
  for (let k = 0; k < n; k++) {
    const m = normal[k].clone().add(normal[k + 1]).normalize();
    const dso = outer[k].distanceTo(outer[k + 1]);
    const dsi = inner[k].distanceTo(inner[k + 1]);
    strip(fb, outer[k], outer[k + 1], dir(m, 1), fascia, so, so + dso);
    strip(sb, inner[k], inner[k + 1], dir(m, -1), soffit, si, si + dsi);
    so += dso;
    si += dsi;
  }
  strip(fb, inner[n], outer[n], new THREE.Vector3(0, -1, 0), fascia, 0, T);
  strip(fb, v2(0, y0), v2(0, y1), dir(v2(-1, 0), 1), fascia, y0, y1);
  // Los costados: el perfil entero (tope, curva por afuera, labio, curva por adentro, cielo raso).
  const profile = [v2(0, y1), ...outer, ...inner.slice().reverse(), v2(0, y0)];
  const tris = THREE.ShapeUtils.triangulateShape(profile, []);
  for (const [u, sgn] of [
    [0, -1],
    [L, 1],
  ]) {
    const d = new THREE.Vector3(t.x * sgn, 0, t.y * sgn);
    for (const [i, j, k] of tris) tri(fb, P(u, profile[i]), P(u, profile[j]), P(u, profile[k]), d, fascia.color, surf(fascia, false), [profile[i].x, profile[i].y, profile[j].x, profile[j].y, profile[k].x, profile[k].y]);
  }
}

/**
 * Una marquesina por una quebrada (la que sigue una fachada curva): un tramo de losa por lado,
 * con el borde de afuera a inglete en cada quiebre (sin rendijas ni solapes), el canto por afuera
 * y en las dos puntas, un rectángulo de física por tramo, y los postes, tensores y plafones
 * ubicados a lo largo de la quebrada.
 */
function canopyPath(cn: MallCanopy, ref: number, piece: Piece, ctx: Ctx): void {
  const pts = cn.line.map((q) => v2(q[0], q[1]));
  const sgn = Math.sign(cn.depth);
  const D = Math.abs(cn.depth);
  // Los tramos: punta, tangente, normal hacia donde vuela la losa y dónde arranca (m).
  const legs: { a: V2; b: V2; t: V2; o: V2; u: number; len: number }[] = [];
  let acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const len = pts[k].distanceTo(pts[k + 1]);
    if (len < EPS) continue;
    const t = pts[k + 1].clone().sub(pts[k]).divideScalar(len);
    legs.push({ a: pts[k], b: pts[k + 1], t, o: v2(-t.y, t.x).multiplyScalar(sgn), u: acc, len });
    acc += len;
  }
  // Hacia dónde se corre cada punto de la quebrada para el borde de afuera (a inglete en los quiebres).
  const out = [legs[0].o.clone(), ...legs.slice(1).map((g, k) => miter(legs[k].o, g.o)), legs[legs.length - 1].o.clone()];
  const y0 = ref + cn.height;
  const y1 = y0 + cn.thickness;
  const top = ctx.skins.look(cn.skins.top);
  const soffit = ctx.skins.look(cn.skins.soffit);
  const fascia = ctx.skins.look(cn.skins.fascia);
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  const legAtU = (u: number): (typeof legs)[number] => legs.find((g) => u <= g.u + g.len + EPS) ?? legs[legs.length - 1];
  const at = (u: number, v: number): V2 => {
    const g = legAtU(u);
    return g.a.clone().addScaledVector(g.t, u - g.u).addScaledVector(g.o, v);
  };
  const fb = piece.bins.of(fascia);
  const edgeTop = y1 - cn.drop;
  legs.forEach((g, k) => {
    const Ao = g.a.clone().addScaledVector(out[k], D);
    const Bo = g.b.clone().addScaledVector(out[k + 1], D);
    hquad(piece.bins.of(top), P(g.a, y1), P(g.b, y1), P(Bo, y1 - cn.drop), P(Ao, y1 - cn.drop), true, top.color, surf(top, false));
    hquad(piece.bins.of(soffit), P(g.a, y0), P(g.b, y0), P(Bo, y0 - cn.drop), P(Ao, y0 - cn.drop), false, soffit.color, surf(soffit, false));
    vquad(fb, Ao, Bo, edgeTop - cn.fascia, edgeTop, g.o, fascia.color, surf(fascia, false), g.u, g.u + g.len);
    const c = g.a.clone().addScaledVector(g.t, g.len / 2).addScaledVector(g.o, D / 2);
    piece.site.box(c.x, c.y, g.len / 2, D / 2, Math.atan2(g.t.y, g.t.x), y1 - Math.min(0, cn.drop), true, y1 - Math.max(cn.fascia, cn.thickness) - cn.drop);
  });
  // Las dos puntas: del muro al borde de afuera, mirando hacia afuera de la quebrada.
  const first = legs[0];
  const last = legs[legs.length - 1];
  vquad(fb, first.a, first.a.clone().addScaledVector(out[0], D), edgeTop - cn.fascia, edgeTop, first.t.clone().negate(), fascia.color, surf(fascia, false), 0, D);
  vquad(fb, last.b, last.b.clone().addScaledVector(out[legs.length], D), edgeTop - cn.fascia, edgeTop, last.t, fascia.color, surf(fascia, false), 0, D);
  const sides = ctx.detail.sides;
  const Ps = cn.posts;
  if (Ps) {
    const pl = ctx.skins.look(Ps.skin);
    const pb = piece.bins.of(pl);
    for (const [u, v] of Ps.at) {
      const q = at(u, v);
      const g = legAtU(u);
      const foot = Ps.foot !== undefined ? ref + Ps.foot : ctx.kit.terrain(q.x, q.y) - ctx.ground.bury;
      const below = Ps.foot !== undefined ? foot : -Infinity;
      const head = (Ps.top !== undefined ? ref + Ps.top : y0) - (Ps.y?.rise ?? 0);
      const [w, d] = Ps.size;
      const h = head - foot;
      if (Ps.round) {
        const geo = new THREE.CylinderGeometry(w / 2, w / 2, h, sides, 1, true);
        pb.geometry(geo, new THREE.Matrix4().makeTranslation(q.x, foot + h / 2, q.y), pl.color, surf(pl, false));
        geo.dispose();
        piece.site.circle(q.x, q.y, w / 2, head, false, below);
      } else {
        boxAt(pb, q, g.t, foot + h / 2, w, h, d ?? w, pl.color, surf(pl, false));
        piece.site.box(q.x, q.y, w / 2, (d ?? w) / 2, Math.atan2(g.t.y, g.t.x), head, false, below);
      }
      if (Ps.y) for (const s of [-1, 1]) bar(pb, P(q, head), P(at(u + s * Ps.y.spread, v), y0), Ps.y.radius, sides, pl.color, surf(pl, false));
    }
  }
  const T = cn.ties;
  if (T) {
    const tl = ctx.skins.look(T.skin);
    for (const [u0, v0, y, u1, v1] of T.at) bar(piece.bins.of(tl, true), P(at(u0, v0), ref + y), P(at(u1, v1), y1 - (cn.drop * Math.abs(v1)) / D), T.radius, sides, tl.color, surf(tl, false));
  }
  plafonds(cn, y0, piece, ctx);
}

/**
 * La recta (o la quebrada) de una marquesina: su largo, su vuelo y, a `u` m a lo largo y `v` m
 * hacia afuera, el punto y la tangente de su tramo (sin inglete: el de los postes y plafones).
 */
function canopyLine(cn: MallCanopy): { L: number; D: number; at: (u: number, v: number) => V2; t: (u: number) => V2 } {
  const pts = cn.line.map((q) => v2(q[0], q[1]));
  const sgn = Math.sign(cn.depth);
  const legs: { a: V2; t: V2; o: V2; u: number; len: number }[] = [];
  let acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const len = pts[k].distanceTo(pts[k + 1]);
    if (len < EPS) continue;
    const t = pts[k + 1].clone().sub(pts[k]).divideScalar(len);
    legs.push({ a: pts[k], t, o: v2(-t.y, t.x).multiplyScalar(sgn), u: acc, len });
    acc += len;
  }
  const leg = (u: number): (typeof legs)[number] => legs.find((g) => u <= g.u + g.len + EPS) ?? legs[legs.length - 1];
  return {
    L: acc,
    D: Math.abs(cn.depth),
    at: (u, v) => {
      const g = leg(u);
      return g.a.clone().addScaledVector(g.t, u - g.u).addScaledVector(g.o, v);
    },
    t: (u) => leg(u).t,
  };
}

/** Dónde van los plafones de una marquesina: parejos a lo largo, en el medio del vuelo, con la tangente de su tramo. */
function plafondSpots(cn: MallCanopy): { p: V2; t: V2 }[] {
  const Lm = cn.lamps;
  if (!Lm) return [];
  const { L, D, at, t } = canopyLine(cn);
  const n = Math.max(1, Math.floor(L / Lm.every));
  return Array.from({ length: n }, (_, k) => {
    const u = ((k + 0.5) * L) / n;
    return { p: at(u, D / 2), t: t(u) };
  });
}

/** Los plafones encendidos bajo el cielo raso de una marquesina (su losa abajo a `y0`, mundo). */
function plafonds(cn: MallCanopy, y0: number, piece: Piece, ctx: Ctx): void {
  const Lm = cn.lamps;
  if (!Lm) return;
  const ll = ctx.skins.look(Lm.skin);
  for (const { p, t } of plafondSpots(cn)) boxAt(piece.bins.of(ll, true), p, t, y0 - cn.drop / 2 - Lm.size[1] / 2, Lm.size[0], Lm.size[1], Lm.size[0], ll.color, surf(ll, true));
}

/**
 * Las luces de una marquesina para el alumbrado (world/streetLamps.ts): uno de cada `lamps.light.every`
 * plafones, a su alto sobre el suelo, con el brazo hacia afuera de la fachada.
 */
export function canopyLights(cn: MallCanopy): PlaceLight[] {
  const Lm = cn.lamps;
  const G = Lm?.light;
  if (!Lm || !G) return [];
  const h = cn.height - cn.drop / 2 - Lm.size[1];
  return plafondSpots(cn)
    .filter((_, k) => k % G.every === 0)
    .map(({ p, t }) => {
      const o = v2(-t.y, t.x).multiplyScalar(Math.sign(cn.depth));
      return { x: p.x, z: p.y, lift: 0, h, out: Math.atan2(o.y, o.x), power: G.power, led: G.led };
    });
}

// ---------------------------------------------------------------------------------------------
// Letreros

/** La cara del letrero para el atlas (su tamaño por la resolución que usa, y más angosta si las letras se estiran). */
export function signFace(s: MallSign): SignFace {
  const [w, h] = s.size;
  return {
    text: s.text,
    size: [(w * s.res) / (s.stretch ?? 1), h * s.res],
    background: s.background,
    color: s.color,
    font: s.font,
    weight: s.weight,
    italic: s.italic,
    fill: s.fill,
    depth: s.depth,
  };
}

/**
 * Un letrero en su lugar: la cara (mirando hacia `n`, centrada en `p` a la altura `y`), su caja,
 * sus placas, su tótem o sus patas, y la física del tótem. Con `along` (un letrero con `follow`:
 * la cadena de su lado y dónde va su centro a lo largo de ella), la cara sigue la fachada.
 */
export function buildSign(s: MallSign, p: V2, n: V2, y: number, ground: number, glow: Glow | undefined, piece: Piece, ctx: Ctx, along?: { c: Chain; u: number }): void {
  const [w, h] = s.size;
  // A lo largo de la cara, de izquierda a derecha para quien la mira de frente.
  const t = v2(n.y, -n.x);
  const gap = ctx.kit.signOffset;
  const depth = s.depth ?? 0;
  const b = piece.bins.get('stone');
  // Letras sueltas: calado (solo la letra); con caja, la cara entera.
  const fb = s.depth === 0 ? piece.bins.get(LETTERS) : b;
  const P = (q: V2, yy: number): THREE.Vector3 => new THREE.Vector3(q.x, yy, q.y);
  const face = (o: number, back: boolean): void => {
    const c = p.clone().addScaledVector(n, back ? -o : o);
    const A = c.clone().addScaledVector(t, back ? w / 2 : -w / 2);
    const B = c.clone().addScaledVector(t, back ? -w / 2 : w / 2);
    const light = glow ? glowOf(glow) : undefined;
    fb.quad(P(A, y - h / 2), P(B, y - h / 2), P(B, y + h / 2), P(A, y + h / 2), WHITE, { pattern: PATTERN.sign, glow: light }, ctx.kit.signRect(signFace(s)));
  };
  // Las placas delante van sobre la cara; las de atrás (vuelo menor), entre la caja y la cara.
  for (const pl of s.plates ?? []) {
    const [pw, ph] = pl.size;
    const c = p.clone().addScaledVector(t, pl.offset[0]).addScaledVector(n, pl.out);
    const yc = y + pl.offset[1];
    const color = new THREE.Color(pl.color);
    if (pl.shape === 'circle') {
      // Un disco (una elipse del tamaño dado) en el plano de la cara, mirando hacia afuera.
      const disc = new THREE.CircleGeometry(0.5, Math.max(ctx.detail.sides, ctx.detail.curve * 4));
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(t.x, 0, t.y), UP, new THREE.Vector3(n.x, 0, n.y)).setPosition(c.x, yc, c.y).multiply(new THREE.Matrix4().makeScale(pw, ph, 1));
      b.geometry(disc, m, color);
      disc.dispose();
      continue;
    }
    const pts =
      pl.shape === 'diamond'
        ? [c.clone().addScaledVector(t, -pw / 2), c.clone(), c.clone().addScaledVector(t, pw / 2), c.clone()].map((q, k) => P(q, yc + [0, -ph / 2, 0, ph / 2][k]))
        : [P(c.clone().addScaledVector(t, -pw / 2), yc - ph / 2), P(c.clone().addScaledVector(t, pw / 2), yc - ph / 2), P(c.clone().addScaledVector(t, pw / 2), yc + ph / 2), P(c.clone().addScaledVector(t, -pw / 2), yc + ph / 2)];
    const nn = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[3], pts[0]));
    if (nn.x * n.x + nn.z * n.y >= 0) b.quad(pts[0], pts[1], pts[2], pts[3], color);
    else b.quad(pts[1], pts[0], pts[3], pts[2], color);
  }
  if (along) {
    // La cara en tiras, una por tramo de la cadena, cada una con su pedazo del atlas.
    const [u0, v0, u1, v1] = ctx.kit.signRect(signFace(s));
    const light = glow ? glowOf(glow) : undefined;
    const g = along.c.segs[0];
    const way = g.t.x * g.n.y - g.t.y * g.n.x >= 0 ? 1 : -1;
    const tex = (u: number): number => u0 + (u1 - u0) * (0.5 + ((u - along.u) * way) / w);
    const o = s.out + gap;
    for (const sp of spans(along.c, along.u - w / 2, along.u + w / 2)) {
      const A = sp.A.clone().addScaledVector(sp.oa, o);
      const B = sp.B.clone().addScaledVector(sp.ob, o);
      vquad(fb, A, B, y - h / 2, y + h / 2, sp.n, WHITE, { pattern: PATTERN.sign, glow: light }, tex(sp.ua), tex(sp.ub), v0, v1);
    }
    return;
  }
  face(s.out + gap, false);
  if (s.back) face(-(s.out - depth - gap), true);
  if (depth > 0) {
    const c = p.clone().addScaledVector(n, s.out - depth / 2);
    boxAt(b, c, t, y, w, h, depth, new THREE.Color(s.background));
  }
  const angle = Math.atan2(t.y, t.x);
  if (s.pole) {
    const c = p.clone().addScaledVector(n, s.out - depth / 2);
    const foot = ctx.kit.terrain(c.x, c.y) - ctx.ground.bury;
    const pw = s.pole.width;
    boxAt(b, c, t, (foot + y - h / 2) / 2, pw, y - h / 2 - foot, pw, new THREE.Color(s.pole.color));
    piece.site.box(c.x, c.y, pw / 2, pw / 2, angle, y - h / 2, false, -Infinity);
    piece.site.box(c.x, c.y, w / 2, Math.max(depth, pw) / 2, angle, y + h / 2, false, y - h / 2);
  }
  if (s.stand) {
    const [from, width] = s.stand;
    const y0 = ground + from;
    const c = p.clone().addScaledVector(n, s.out - Math.max(depth, width) / 2);
    const color = new THREE.Color(s.background);
    for (const sgn of [-1, 1]) boxAt(b, c.clone().addScaledVector(t, (sgn * (w - width)) / 2), t, (y0 + y - h / 2) / 2, width, y - h / 2 - y0, width, color);
  }
}

// ---------------------------------------------------------------------------------------------
// Techos: lucernarios, cúpulas, equipos, paneles solares, antenas

/** Un lucernario (o una retícula de ellos) sobre un techo a la altura `y0` (mundo). */
export function buildSkylight(sk: MallSkylight, y0: number, piece: Piece, ctx: Ctx): void {
  const a = v2(sk.a[0], sk.a[1]);
  const b = v2(sk.b[0], sk.b[1]);
  const L = a.distanceTo(b);
  const u = b.clone().sub(a).divideScalar(L);
  const v = v2(-u.y, u.x);
  const glass = ctx.skins.look(sk.skins.glass);
  const frame = ctx.skins.look(sk.skins.frame);
  const [na, da, nw, dw] = sk.grid ?? [1, 0, 1, 0];
  const [curbH, curbW] = sk.curb;
  const hw = sk.width / 2;
  const segs = sk.kind === 'vault' ? Math.max(ctx.detail.curve, Math.ceil((Math.PI * sk.width) / 2 / ctx.detail.arc)) : sk.kind === 'ridge' ? 2 : 1;
  const base = y0 + sk.y + curbH;
  // Sección: puntos (a lo ancho, alto) de un lado al otro.
  const section: number[][] = [];
  if (sk.kind === 'vault') {
    const R = (hw * hw + sk.rise * sk.rise) / (2 * sk.rise);
    const a0 = Math.asin(THREE.MathUtils.clamp(hw / R, -1, 1));
    for (let k = 0; k <= segs; k++) {
      const ang = -a0 + (2 * a0 * k) / segs;
      section.push([Math.sin(ang) * R, sk.rise - R + Math.cos(ang) * R]);
    }
  } else if (sk.kind === 'ridge') {
    section.push([-hw, 0], [0, sk.rise], [hw, 0]);
  } else if (sk.kind === 'flat') {
    section.push([-hw, sk.rise], [hw, sk.rise]);
  } else {
    throw new Error(`Lucernario desconocido: ${sk.kind} (hay: vault, ridge, flat)`);
  }
  const gb = piece.bins.of(glass);
  const fb = piece.bins.of(frame);
  const fbNear = piece.bins.of(frame, true);
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nw; j++) {
      const o = a.clone().addScaledVector(u, i * da).addScaledVector(v, (j - (nw - 1) / 2) * dw);
      const P = (along: number, across: number, y: number): THREE.Vector3 => {
        const q = o.clone().addScaledVector(u, along).addScaledVector(v, across);
        return new THREE.Vector3(q.x, y, q.y);
      };
      const len = sk.grid ? da || L : L;
      const span = sk.grid ? Math.min(len, L) : L;
      // Pretil: cuatro caras.
      if (curbH > EPS) {
        const c0 = [P(0, -hw - curbW, 0), P(span, -hw - curbW, 0), P(span, hw + curbW, 0), P(0, hw + curbW, 0)];
        for (let k = 0; k < 4; k++) {
          const p = c0[k];
          const q = c0[(k + 1) % 4];
          const mid = new THREE.Vector3().addVectors(p, q).multiplyScalar(0.5);
          const cen = P(span / 2, 0, 0);
          vquad(fb, v2(p.x, p.z), v2(q.x, q.z), y0 + sk.y, base, v2(mid.x - cen.x, mid.z - cen.z), frame.color, surf(frame, false), 0, p.distanceTo(q));
        }
        hquad(fb, P(0, -hw - curbW, base), P(span, -hw - curbW, base), P(span, -hw, base), P(0, -hw, base), true, frame.color, surf(frame, false));
        hquad(fb, P(0, hw, base), P(span, hw, base), P(span, hw + curbW, base), P(0, hw + curbW, base), true, frame.color, surf(frame, false));
      }
      let arcU = 0;
      for (let k = 0; k + 1 < section.length; k++) {
        const [v0, h0] = section[k];
        const [v1, h1] = section[k + 1];
        const d = Math.hypot(v1 - v0, h1 - h0);
        hquad(gb, P(0, v0, base + h0), P(span, v0, base + h0), P(span, v1, base + h1), P(0, v1, base + h1), true, glass.color, surf(glass, litNow(glass, i * 31 + j)), [0, arcU, span, arcU, span, arcU + d, 0, arcU + d]);
        arcU += d;
      }
      // Puntas: abanico desde la base (en la caja plana, el rectángulo de su costado, que ya la cierra).
      for (const [along, dir] of [
        [0, -1],
        [span, 1],
      ] as const) {
        const face = new THREE.Vector3(u.x * dir, 0, u.y * dir);
        if (sk.kind === 'flat') {
          vquad(gb, v2(P(along, -hw, 0).x, P(along, -hw, 0).z), v2(P(along, hw, 0).x, P(along, hw, 0).z), base, base + sk.rise, v2(face.x, face.z), glass.color, surf(glass, false), -hw, hw);
          continue;
        }
        for (let k = 0; k + 1 < section.length; k++) {
          const [v0, h0] = section[k];
          const [v1, h1] = section[k + 1];
          tri(gb, P(along, v0, base + h0), P(along, v1, base + h1), P(along, 0, base), face, glass.color, surf(glass, false), [v0, h0, v1, h1, 0, 0]);
        }
      }
      if (sk.kind === 'flat') {
        for (const sv of [-1, 1]) vquad(gb, v2(P(0, sv * hw, 0).x, P(0, sv * hw, 0).z), v2(P(span, sv * hw, 0).x, P(span, sv * hw, 0).z), base, base + sk.rise, v2(v.x * sv, v.y * sv), glass.color, surf(glass, false), 0, span);
      }
      // Costillas: la sección hecha barra cada tanto.
      const [every, rw] = sk.ribs;
      if (every > 0 && rw > 0) {
        const n = Math.max(1, Math.round(span / every));
        for (let r = 0; r <= n; r++) {
          const along = (span * r) / n;
          for (let k = 0; k + 1 < section.length; k++) {
            const [v0, h0] = section[k];
            const [v1, h1] = section[k + 1];
            const p0 = P(along, v0, base + h0 + rw / 2);
            const p1 = P(along, v1, base + h1 + rw / 2);
            bar(fbNear, p0, p1, rw / 2, SQUARE, frame.color, surf(frame, false));
          }
        }
      }
    }
  }
}

/** Una cúpula (o parte de una) con su tambor y sus costillas, arrancando a `y0` (mundo). */
export function buildDome(d: MallDome, y0: number, piece: Piece, ctx: Ctx): void {
  const shell = ctx.skins.look(d.skins.shell);
  const drum = ctx.skins.look(d.skins.drum);
  const frame = ctx.skins.look(d.skins.frame);
  const phi0 = THREE.MathUtils.degToRad(d.from);
  const phiL = THREE.MathUtils.degToRad(d.arc);
  const full = d.arc >= 360 - EPS;
  const sides = Math.max(ctx.detail.sides, Math.ceil((d.radius * phiL) / ctx.detail.arc));
  const steps = Math.max(ctx.detail.curve, Math.ceil((Math.PI * d.radius) / 2 / ctx.detail.arc));
  // Perfil de la calota: un cuarto de elipse de radio `radius` y alto `rise` (del borde a la clave).
  const prof: THREE.Vector2[] = [];
  for (let k = steps; k >= 0; k--) {
    const a = (Math.PI / 2) * (k / steps);
    prof.push(new THREE.Vector2(Math.cos(a) * d.radius, Math.sin(a) * d.rise));
  }
  const base = y0 + d.y + d.drum;
  // LatheGeometry: phi 0 en +z y creciendo hacia +x; se gira para que `from` sea atan2(z, x) local.
  const m = new THREE.Matrix4().makeTranslation(d.at[0], base, d.at[1]).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  prof.reverse();
  let arcLen = 0;
  for (let k = 1; k < prof.length; k++) arcLen += prof[k].distanceTo(prof[k - 1]);
  const g = new THREE.LatheGeometry(prof, sides, -phi0 - phiL, phiL);
  piece.bins.of(shell).geometry(g, m, shell.color, surf(shell, shell.lit > 0, { scale: [(d.radius * phiL) * (shell.surface.scale?.[0] ?? 1), arcLen * (shell.surface.scale?.[1] ?? 1)] }));
  g.dispose();
  if (d.drum > EPS) {
    const cyl = new THREE.CylinderGeometry(d.radius, d.radius, d.drum, sides, 1, true, -phi0 - phiL + Math.PI / 2, phiL);
    piece.bins.of(drum).geometry(cyl, new THREE.Matrix4().makeTranslation(d.at[0], y0 + d.y + d.drum / 2, d.at[1]), drum.color, surf(drum, false, { scale: [d.radius * phiL * (drum.surface.scale?.[0] ?? 1), d.drum * (drum.surface.scale?.[1] ?? 1)] }));
    cyl.dispose();
  }
  if (!full) {
    // Parte de una cúpula: la cara plana de cada corte (el perfil del borde al centro), con la piel
    // del tambor, mirando hacia afuera del cuerpo: el cuerpo crece desde `from` en el sentido de
    // atan2(z, x), así que el corte del comienzo mira hacia atrás de ese giro y el del final, hacia
    // adelante (en una media cúpula los dos quedan en el mismo plano, mirando al mismo lado).
    const cut = (ang: number): V2 => v2(Math.cos(ang), Math.sin(ang));
    const e0 = cut(phi0);
    const e1 = cut(phi0 + phiL);
    const P = (r: number, e: V2, y: number): THREE.Vector3 => new THREE.Vector3(d.at[0] + e.x * r, y, d.at[1] + e.y * r);
    const db = piece.bins.of(drum);
    for (const [e, facing] of [
      [e0, v2(e0.y, -e0.x)],
      [e1, v2(-e1.y, e1.x)],
    ]) {
      const face3 = new THREE.Vector3(facing.x, 0, facing.y);
      for (let k = 0; k < steps; k++) {
        const a = (Math.PI / 2) * (k / steps);
        const a1 = (Math.PI / 2) * ((k + 1) / steps);
        tri(db, P(Math.cos(a) * d.radius, e, base + Math.sin(a) * d.rise), P(Math.cos(a1) * d.radius, e, base + Math.sin(a1) * d.rise), P(0, e, base), face3, drum.color, surf(drum, false), [Math.cos(a) * d.radius, Math.sin(a) * d.rise, Math.cos(a1) * d.radius, Math.sin(a1) * d.rise, 0, 0]);
      }
      if (d.drum > EPS) vquad(db, v2(d.at[0], d.at[1]), v2(d.at[0] + e.x * d.radius, d.at[1] + e.y * d.radius), y0 + d.y, base, facing, drum.color, surf(drum, false), 0, d.radius);
    }
  }
  for (let k = 0; k < d.ribs; k++) {
    const ang = phi0 + (phiL * (k + (full ? 0 : 0.5))) / d.ribs;
    const e = v2(Math.cos(ang), Math.sin(ang));
    for (let j = 0; j < steps; j++) {
      const a = (Math.PI / 2) * (j / steps);
      const a1 = (Math.PI / 2) * ((j + 1) / steps);
      const p0 = new THREE.Vector3(d.at[0] + e.x * Math.cos(a) * d.radius, base + Math.sin(a) * d.rise, d.at[1] + e.y * Math.cos(a) * d.radius);
      const p1 = new THREE.Vector3(d.at[0] + e.x * Math.cos(a1) * d.radius, base + Math.sin(a1) * d.rise, d.at[1] + e.y * Math.cos(a1) * d.radius);
      bar(piece.bins.of(frame, true), p0, p1, d.rib / 2, SQUARE, frame.color, surf(frame, false));
    }
  }
}

/**
 * Los equipos de aire de un techo a la altura `y0` (mundo), instanciados y solo de cerca. Los
 * ventiladores van aparte, con su radio en m (en el modelo instanciado se estirarían con cada
 * caja), en el búfer de lo chico del pedazo: `detail.film` sobre la tapa de su caja.
 */
export function buildEquipment(eq: MallEquipment, area: V2[], y0: number, root: THREE.Object3D, name: string, piece: Piece, ctx: Ctx): void {
  if (eq.count <= 0) return;
  const l = ctx.skins.look(eq.skin);
  const fan = ctx.skins.look(eq.fan.skin);
  // El modelo: una caja de 1 × 1 × 1 con el pie en el origen.
  const b = new Batch();
  b.box(new THREE.Matrix4().makeTranslation(0, 0.5, 0), 1, 1, 1, l.color, surf(l, false));
  const geometry = b.build();
  // Grilla dentro del área, del paso que da `count` equipos, girada `angle`.
  const ang = THREE.MathUtils.degToRad(eq.angle);
  const u = v2(Math.cos(ang), Math.sin(ang));
  const v = v2(-u.y, u.x);
  const step = Math.sqrt(Math.abs(signedArea(area)) / eq.count);
  if (!(step > EPS)) throw new Error(`${name}: el área de los equipos (o la planta metida margin m) no tiene superficie`);
  let u0 = Infinity;
  let u1 = -Infinity;
  let w0 = Infinity;
  let w1 = -Infinity;
  for (const p of area) {
    u0 = Math.min(u0, p.dot(u));
    u1 = Math.max(u1, p.dot(u));
    w0 = Math.min(w0, p.dot(v));
    w1 = Math.max(w1, p.dot(v));
  }
  const spots: V2[] = [];
  for (let a = u0 + step / 2; a < u1; a += step) {
    for (let c = w0 + step / 2; c < w1; c += step) {
      const p = u.clone().multiplyScalar(a).addScaledVector(v, c);
      if (insidePoly(area, p.x, p.y)) spots.push(p);
    }
  }
  const seed = seedOf(name);
  const picked = spots.map((p, k) => ({ p, r: rand(seed + k, 61) })).sort((x, y) => x.r - y.r).slice(0, eq.count);
  const mesh = new THREE.InstancedMesh(geometry, ctx.kit.materials.stone, picked.length);
  const q = new THREE.Quaternion().setFromAxisAngle(UP, -ang);
  const m = new THREE.Matrix4();
  const [lo, hi] = eq.size;
  const disc = eq.fan.radius > 0 ? new THREE.CircleGeometry(eq.fan.radius, ctx.detail.sides).rotateX(-Math.PI / 2) : null;
  const fb = piece.bins.of(fan, true);
  picked.forEach(({ p }, k) => {
    const s = [0, 1, 2].map((i) => lo[i] + (hi[i] - lo[i]) * rand(seed + k, 67 + i));
    m.compose(new THREE.Vector3(p.x, y0, p.y), q, new THREE.Vector3(s[0], s[2], s[1]));
    mesh.setMatrixAt(k, m);
    if (disc) fb.geometry(disc, new THREE.Matrix4().makeTranslation(p.x, y0 + s[2] + ctx.detail.film, p.y), fan.color, surf(fan, false));
  });
  disc?.dispose();
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);
  piece.site.near(mesh, ctx.detail.near);
}

/** Paneles solares en filas sobre un techo a la altura `y0` (mundo). */
export function buildSolar(so: MallSolar, y0: number, piece: Piece, ctx: Ctx): void {
  const l = ctx.skins.look(so.skin);
  const area = so.area.map((p) => v2(p[0], p[1]));
  const ang = THREE.MathUtils.degToRad(so.angle);
  const u = v2(Math.cos(ang), Math.sin(ang));
  const v = v2(-u.y, u.x);
  let w0 = Infinity;
  let w1 = -Infinity;
  for (const p of area) {
    w0 = Math.min(w0, p.dot(v));
    w1 = Math.max(w1, p.dot(v));
  }
  const rise = so.depth * Math.tan(THREE.MathUtils.degToRad(so.tilt));
  const slope = Math.hypot(so.depth, rise);
  const b = piece.bins.of(l);
  for (let c = w0 + so.pitch / 2; c < w1; c += so.pitch) {
    const origin = v.clone().multiplyScalar(c);
    for (const [t0, t1] of scanLine(area, origin, u)) {
      const P = (along: number, across: number, y: number): THREE.Vector3 => {
        const q = origin.clone().addScaledVector(u, along).addScaledVector(v, across);
        return new THREE.Vector3(q.x, y, q.y);
      };
      const y = y0 + so.lift;
      hquad(b, P(t0, -so.depth / 2, y), P(t1, -so.depth / 2, y), P(t1, so.depth / 2, y + rise), P(t0, so.depth / 2, y + rise), true, l.color, surf(l, false), [0, 0, t1 - t0, 0, t1 - t0, slope, 0, slope]);
    }
  }
}

/** Mástiles de antenas con sus paneles. `y0`: el suelo del volumen (mundo). */
export function buildMasts(ms: MallMast, y0: number, piece: Piece, ctx: Ctx): void {
  const l = ctx.skins.look(ms.skin);
  const hl = ctx.skins.look(ms.heads.skin);
  const b = piece.bins.of(l);
  const hb = piece.bins.of(hl, true);
  for (const [x, z, h] of ms.at) {
    const foot = y0 + ms.y;
    bar(b, new THREE.Vector3(x, foot, z), new THREE.Vector3(x, foot + h, z), ms.radius, ctx.detail.small, l.color, surf(l, false));
    const [w, hh, d] = ms.heads.size;
    for (let k = 0; k < ms.heads.count; k++) {
      const a = (k / ms.heads.count) * Math.PI * 2;
      const dir = v2(Math.cos(a), Math.sin(a));
      const p = v2(x, z).addScaledVector(dir, ms.radius + d / 2);
      boxAt(hb, p, v2(-dir.y, dir.x), foot + h - hh / 2, w, hh, d, hl.color, surf(hl, false));
    }
  }
}

/** Las superficies de un acabado para `Bins.flush`: el material y si proyecta sombra. */
export function materialOf(kit: PlaceKit, finishes: Record<string, Finish>): (key: string) => { m: THREE.Material; shadow: boolean } {
  return (key) => {
    if (key === 'stone') return { m: kit.materials.stone, shadow: true };
    const f = finishes[key];
    if (!f) throw new Error(`Acabado desconocido en config/sites (mall → finishes): ${key}`);
    return { m: kit.finish(f), shadow: f.opacity === undefined && !f.cutout };
  };
}
