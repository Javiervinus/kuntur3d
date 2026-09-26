import * as THREE from 'three';
import { faceted, inward } from './classical';
import { type LampStyle, type MedianStyle, lampModel } from './medians';
import { Batch } from './monumentParts';
import { type Ctx, type Piece, SQUARE, bar, boxAt, hquad, rand, seedOf, surf, tri, vquad } from './mallParts';
import type { PlaceLight } from './placeKit';
import { type PavedStyle, pavement } from './street';

/*
 * Lo de alrededor de un centro comercial (tipo `mall`, world/mall.ts): puentes peatonales y
 * escaleras, rejas, bolardos, jardineras, pisos con bordillo, paradas de bus, fuentes, vallas y
 * pantallas sobre un poste, postes de luz (que alumbran de noche), palmeras y árboles. Todo en el
 * marco local del lugar y con alturas sobre el terreno de cada punto; nada de medidas aquí.
 */

type V2 = THREE.Vector2;
const v2 = (x: number, z: number): V2 => new THREE.Vector2(x, z);
const UP = new THREE.Vector3(0, 1, 0);
const EPS = 1e-4;

/**
 * Un puente peatonal cubierto: el eje de `line[0]` a `line[1]` (marco local), su ancho, el alto de
 * la cara de abajo del piso sobre el terreno en cada punta (`deck`), el grosor del piso, el alto
 * libre adentro (del piso al techo) y el grosor del techo. La armadura de cada costado: montantes
 * cada `panel` m, de sección `size`, con diagonales 'warren' (en zigzag) o 'pratt' (hacia el
 * centro). `rail`: alto de la baranda que ataja. `banner`: una lona a lo largo de los dos
 * costados (de qué alto a qué alto sobre el piso y entre qué m del eje). Pilas redondas en m del
 * eje (`at`) hasta el terreno. `gaps`: donde llega una escalera por un costado, la baranda y la
 * armadura (su cordón de abajo, sus montantes y las diagonales de los paños que toca) se abren:
 * cada uno [costado, desde, hasta], el costado 1 hacia (−t_z, t_x) de line[0]→line[1] (como `side`
 * de las hileras de un parqueo) o −1 el otro, y desde y hasta en m del eje desde line[0].
 */
export interface MallBridge {
  id: string;
  line: number[][];
  width: number;
  deck: number[];
  slab: number;
  height: number;
  roof: number;
  truss: { panel: number; size: number; kind: string };
  rail: number;
  gaps?: number[][];
  banner?: { y: number[]; span: number[]; skin: string };
  piers: { at: number[]; radius: number; skin: string };
  skins: { floor: string; soffit: string; roof: string; truss: string };
  source: string;
}

/**
 * Una escalera recta al aire libre: del pie `a` al borde de arriba `b` (marco local), su ancho, a
 * qué alto llega sobre el terreno del pie, el alto de cada peldaño, las zancas [alto, ancho] a los
 * costados, el alto de la baranda y cada cuántos m (a lo largo) va un parante de la baranda.
 */
export interface MallStair {
  id: string;
  a: number[];
  b: number[];
  width: number;
  rise: number;
  riser: number;
  stringer: number[];
  rail: number;
  posts: number;
  skins: { steps: string; stringer: string; rail: string };
  source: string;
}

/** Cómo es una reja: alto de los barrotes, murete [alto, ancho] y pilares [cada cuánto, ancho], con sus pieles. */
export interface MallFenceStyle {
  height: number;
  base: number[];
  posts: number[];
  skins: { bars: string; base: string; post: string };
}

/** Una reja por la polilínea `line` (marco local), sin los tramos `gaps` (m a lo largo, desde el primer punto). */
export interface MallFence {
  line: number[][];
  style: string;
  gaps: number[][];
  source: string;
}

/**
 * Bolardos por la polilínea `line`, uno cada `every` m (un solo punto = un solo bolardo): radio,
 * alto, las franjas [desde, hasta, desde, hasta…] (m, de abajo hacia arriba) y sus pieles.
 */
export interface MallBollards {
  line: number[][];
  every: number;
  radius: number;
  height: number;
  stripe: number[];
  skins: { body: string; stripe: string };
  source: string;
}

/**
 * Una jardinera: su contorno, el alto del borde sobre el terreno, el ancho del borde, cuánto más
 * abajo que el tope del borde queda la tierra y sus pieles (borde y tierra).
 */
export interface MallPlanter {
  ring: number[][];
  height: number;
  wall: number;
  drop: number;
  skins: { wall: string; soil: string };
  source: string;
}

/** Un piso con bordillo (una plaza, una vereda, una isla): contorno, lados con bordillo y estilo de `pavedStyles`. */
export interface MallPaved {
  ring: number[][];
  curbs: number[];
  style: string;
  source: string;
}

/**
 * Una parada de bus: centro, hacia dónde mira el frente (grados, atan2(z, x) local), largo y fondo
 * del techo, alto libre, grosor del techo y cuánto sube en el medio (0 = plano; si no, curvo), un
 * poste cada `every` m a lo largo del fondo (ancho `post`), muro de fondo (alto; 0 = sin) y banca
 * [alto, fondo, largo] (alto 0 = sin); sus pieles (`roof`: arriba y los cantos del techo;
 * `soffit`: su cara de abajo, a la sombra). `front` (opcional): cuánto más abajo que el de atrás
 * queda el borde del frente (el techo cae hacia el frente, como una capota; sin él, 0).
 */
export interface MallShelter {
  at: number[];
  angle: number;
  size: number[];
  height: number;
  thickness: number;
  rise: number;
  front?: number;
  every: number;
  post: number;
  back: number;
  bench: number[];
  skins: { roof: string; soffit: string; post: string; back: string; bench: string };
  source: string;
}

/**
 * Una fuente redonda: centro, radio, el borde [alto, ancho], cuánto más abajo que el borde queda el
 * agua, y los chorros (cuántos, en un círculo de qué radio, alto y radio de cada uno); sus pieles.
 */
export interface MallFountain {
  at: number[];
  radius: number;
  wall: number[];
  water: number;
  jets: { count: number; ring: number; height: number; radius: number };
  skins: { wall: string; water: string; jet: string };
  source: string;
}

/**
 * Una valla o pantalla sobre un poste (unipolar): pie, hacia dónde mira la cara (grados), poste
 * [radio, alto hasta el panel], panel [ancho, alto, fondo], ancho del marco alrededor de la cara,
 * si tiene cara también atrás, y sus pieles (la cara, sin texto: los anuncios cambian; `back`, la
 * de la cara de atrás si es otra). `reflectors`: focos sobre el borde de arriba de cada cara,
 * `count` por cara, cada uno al final de un brazo que sale `arm` m de la cara (de grosor `rod`),
 * de tamaño [ancho, alto, fondo] y con su piel (su luz de noche).
 */
export interface MallBillboard {
  at: number[];
  angle: number;
  pole: number[];
  panel: number[];
  border: number;
  back: boolean;
  skins: { pole: string; frame: string; face: string; back?: string };
  reflectors?: { count: number; arm: number; rod: number; size: number[]; skin: string };
  source: string;
}

/**
 * Torres de vigilancia (una garita en alto sobre un poste): el poste redondo desde el suelo hasta
 * `pole.height`, y a lo largo de él, de abajo arriba, sus piezas, cada una con el pie a `y` m sobre
 * el suelo: cajas ('box': [ancho, alto, fondo]) con una franja de otra piel abajo y arriba (`rims`:
 * alto y piel) y faldones acampanados ('flare': [ancho abajo, ancho arriba, alto], una pirámide
 * trunca de base cuadrada). Cada una en [x, z] o [x, z, grados] (hacia dónde mira su frente; si
 * no, `angle`).
 */
export interface MallTower {
  at: number[][];
  angle: number;
  pole: { radius: number; height: number; skin: string };
  parts: { shape: string; y: number; size: number[]; skin: string; rims?: { height: number; skin: string } }[];
  source: string;
}

/**
 * El modelo de moto estacionada (para instanciar; la rueda de adelante hacia +x, el pie en el
 * origen): ruedas [radio, ancho] con los ejes a `base` m; el cuerpo (motor y tanque) [largo, alto,
 * ancho] a `clearance` m del piso, pintado con el color de cada moto; el asiento [largo, alto,
 * ancho, cuánto se corre hacia atrás] sobre el cuerpo; el manubrio [ancho, alto sobre el piso,
 * cuánto adelante del centro]; `fork`, el radio de los tubos (la horquilla, de la rueda de
 * adelante al manubrio, y el manubrio); los colores de la pintura (uno por moto, al azar), del
 * asiento, de las llantas y del metal.
 */
export interface MallMotoModel {
  wheel: number[];
  base: number;
  body: number[];
  clearance: number;
  seat: number[];
  bars: number[];
  fork: number;
  colors: string[];
  seatColor: string;
  tire: string;
  metal: string;
}

/**
 * Una fila de motos estacionadas: a lo largo de `line` (de su primer punto al segundo), una cada
 * `every` m, con la rueda de adelante hacia `angle` (grados, atan2(z, x) local) girada al azar hasta
 * `turn` grados de más o de menos; `share`: qué parte de los lugares está ocupada.
 */
export interface MallMotoRow {
  line: number[][];
  every: number;
  angle: number;
  turn: number;
  share: number;
  source: string;
}

/**
 * Un modelo de poste de luz (world/medians.ts → lampModel): el fuste, los brazos (uno hacia cada
 * lado de `sides`: ±1 = hacia ±z del poste), la luminaria, su luz para el alumbrado y la propia,
 * sus colores y hasta qué distancia (m) se ve. `turns`: el juego de brazos se repite girado esos
 * grados alrededor del fuste (sin él, una vez: [0, 90] con dos lados da una cruz de cuatro brazos).
 */
export interface MallLampModel extends LampStyle {
  sides: number[];
  turns?: number[];
  colors: MedianStyle['colors'];
  near: number;
}

/** Postes de un modelo: pie en [x, z] (o [x, z, grados]) y hacia dónde apunta el brazo +z (grados, atan2(z, x) local). */
export interface MallLamps {
  model: string;
  at: number[][];
  angle: number;
  source: string;
}

/**
 * Autos estacionados sueltos (los de la ciudad, world/parkedCars.ts): cada uno en [x, z, grados]
 * (hacia dónde mira la trompa, atan2(z, x) local) y cuánto queda sobre el terreno (un auto en
 * paralelo junto a una vereda, una fila de taxis).
 */
export interface MallCars {
  at: number[][];
  lift: number;
  source: string;
}

/** Palmeras (las de la ciudad): dónde y su alto (mín., máx.). */
export interface MallPalms {
  at: number[][];
  height: number[];
  source: string;
}

/** Árboles (los de la ciudad): dónde, alto y radio de copa (mín., máx.) y sus verdes. */
export interface MallTrees {
  at: number[][];
  height: number[];
  radius: number[];
  colors: string[];
  source: string;
}

/**
 * Todo lo de alrededor de un mall (config/sites → site). `towers` (torres de vigilancia) y `motos`
 * (el modelo y sus filas) son opcionales.
 */
export interface MallSite {
  pavedStyles: Record<string, PavedStyle>;
  paved: MallPaved[];
  fenceStyles: Record<string, MallFenceStyle>;
  fences: MallFence[];
  bollards: MallBollards[];
  planters: MallPlanter[];
  shelters: MallShelter[];
  fountains: MallFountain[];
  billboards: MallBillboard[];
  towers?: MallTower[];
  lampModels: Record<string, MallLampModel>;
  lamps: MallLamps[];
  cars: MallCars[];
  motos?: { model: MallMotoModel; rows: MallMotoRow[] };
  palms: MallPalms[];
  trees: MallTrees[];
}

/** Puntos a lo largo de una polilínea cada `every` m (parejos entre las puntas), con su tangente. */
function along(line: readonly (readonly number[])[], every: number): { p: V2; t: V2; s: number }[] {
  const pts = line.map((q) => v2(q[0], q[1]));
  let total = 0;
  for (let k = 0; k + 1 < pts.length; k++) total += pts[k].distanceTo(pts[k + 1]);
  const n = Math.max(1, Math.round(total / every));
  const out: { p: V2; t: V2; s: number }[] = [];
  for (let j = 0; j <= n; j++) {
    let s = (total * j) / n;
    const at = s;
    let k = 0;
    while (k < pts.length - 2 && s > pts[k].distanceTo(pts[k + 1])) {
      s -= pts[k].distanceTo(pts[k + 1]);
      k++;
    }
    const d = pts[k + 1].clone().sub(pts[k]);
    const len = d.length();
    const t = d.divideScalar(len || 1);
    out.push({ p: pts[k].clone().addScaledVector(t, Math.min(s, len)), t, s: at });
  }
  return out;
}

/** Un puente peatonal cubierto con su armadura, su lona, sus pilas y su física. */
export function buildBridge(br: MallBridge, piece: Piece, ctx: Ctx): void {
  const S = ctx.skins;
  const a = v2(br.line[0][0], br.line[0][1]);
  const b = v2(br.line[1][0], br.line[1][1]);
  const L = a.distanceTo(b);
  const t = b.clone().sub(a).divideScalar(L);
  const n = v2(-t.y, t.x);
  const hw = br.width / 2;
  const ya = ctx.kit.terrain(a.x, a.y) + br.deck[0];
  const yb = ctx.kit.terrain(b.x, b.y) + br.deck[1];
  const yAt = (u: number): number => ya + ((yb - ya) * u) / L;
  const Q = (u: number, s: number): V2 => a.clone().addScaledVector(t, u).addScaledVector(n, s);
  const P = (u: number, s: number, dy: number): THREE.Vector3 => {
    const q = Q(u, s);
    return new THREE.Vector3(q.x, yAt(u) + dy, q.y);
  };
  const floor = S.look(br.skins.floor);
  const soffit = S.look(br.skins.soffit);
  const roof = S.look(br.skins.roof);
  const truss = S.look(br.skins.truss);
  const fb = piece.bins.of(floor);
  const top = br.slab;
  const ceil = br.slab + br.height;
  // Piso (arriba y abajo) y techo (arriba y abajo), con los cantos a los costados.
  hquad(fb, P(0, -hw, top), P(L, -hw, top), P(L, hw, top), P(0, hw, top), true, floor.color, surf(floor, false), [0, -hw, L, -hw, L, hw, 0, hw]);
  hquad(piece.bins.of(soffit), P(0, -hw, 0), P(L, -hw, 0), P(L, hw, 0), P(0, hw, 0), false, soffit.color, surf(soffit, false));
  const rb = piece.bins.of(roof);
  hquad(rb, P(0, -hw, ceil + br.roof), P(L, -hw, ceil + br.roof), P(L, hw, ceil + br.roof), P(0, hw, ceil + br.roof), true, roof.color, surf(roof, false));
  hquad(rb, P(0, -hw, ceil), P(L, -hw, ceil), P(L, hw, ceil), P(0, hw, ceil), false, roof.color, surf(roof, false));
  for (const s of [-1, 1]) {
    const facing = n.clone().multiplyScalar(s);
    const edge = (y0: number, y1: number, look: typeof floor): void => {
      const A = Q(0, s * hw);
      const B = Q(L, s * hw);
      const quad = [new THREE.Vector3(A.x, ya + y0, A.y), new THREE.Vector3(B.x, yb + y0, B.y), new THREE.Vector3(B.x, yb + y1, B.y), new THREE.Vector3(A.x, ya + y1, A.y)];
      const nn = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[3], quad[0]));
      const batch = piece.bins.of(look);
      if (nn.x * facing.x + nn.z * facing.y >= 0) batch.quad(quad[0], quad[1], quad[2], quad[3], look.color, surf(look, false), [0, y0, L, y1]);
      else batch.quad(quad[1], quad[0], quad[3], quad[2], look.color, surf(look, false), [L, y0, 0, y1]);
    };
    edge(0, top, floor);
    edge(ceil, ceil + br.roof, roof);
    if (br.banner) {
      // La lona: un paño a lo largo del costado, apenas afuera de la armadura.
      const bl = S.look(br.banner.skin);
      const [u0, u1] = br.banner.span;
      const [y0, y1] = br.banner.y;
      const off = s * (hw + br.truss.size);
      const A = Q(u0, off);
      const B = Q(u1, off);
      const quad = [new THREE.Vector3(A.x, yAt(u0) + top + y0, A.y), new THREE.Vector3(B.x, yAt(u1) + top + y0, B.y), new THREE.Vector3(B.x, yAt(u1) + top + y1, B.y), new THREE.Vector3(A.x, yAt(u0) + top + y1, A.y)];
      const nn = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[3], quad[0]));
      const batch = piece.bins.of(bl);
      if (nn.x * facing.x + nn.z * facing.y >= 0) batch.quad(quad[0], quad[1], quad[2], quad[3], bl.color, surf(bl, false), [u0, y0, u1, y1]);
      else batch.quad(quad[1], quad[0], quad[3], quad[2], bl.color, surf(bl, false), [u1, y0, u0, y1]);
    }
    // Armadura: cordones arriba y abajo, montantes y diagonales; donde llega una escalera
    // (`gaps`), sin el cordón de abajo, los montantes ni las diagonales de los paños que toca.
    const T = br.truss;
    const tb = piece.bins.of(truss);
    const r = T.size / 2;
    const sides = SQUARE;
    const holes = (br.gaps ?? []).filter((g) => g[0] === s).map((g) => [g[1], g[2]]);
    const inGap = (u0: number, u1: number): boolean => holes.some(([a0, a1]) => u0 < a1 && u1 > a0);
    const runs = holes.reduce(
      (acc, [a0, a1]) => acc.flatMap(([r0, r1]) => (a1 <= r0 || a0 >= r1 ? [[r0, r1]] : [[r0, Math.max(r0, a0)], [Math.min(r1, a1), r1]].filter(([p0, p1]) => p1 - p0 > EPS))),
      [[0, L]],
    );
    for (const [r0, r1] of runs) bar(tb, P(r0, s * hw, top + r), P(r1, s * hw, top + r), r, sides, truss.color, surf(truss, false));
    bar(tb, P(0, s * hw, ceil - r), P(L, s * hw, ceil - r), r, sides, truss.color, surf(truss, false));
    const panels = Math.max(1, Math.round(L / T.panel));
    for (let k = 0; k <= panels; k++) {
      const u = (L * k) / panels;
      if (!inGap(u, u)) bar(tb, P(u, s * hw, top), P(u, s * hw, ceil), r, sides, truss.color, surf(truss, false));
      if (k === panels) continue;
      const u1 = (L * (k + 1)) / panels;
      if (inGap(u, u1)) continue;
      const up = T.kind === 'warren' ? k % 2 === 0 : u < L / 2;
      if (up) bar(tb, P(u, s * hw, top), P(u1, s * hw, ceil), r, sides, truss.color, surf(truss, false));
      else bar(tb, P(u, s * hw, ceil), P(u1, s * hw, top), r, sides, truss.color, surf(truss, false));
    }
    // La baranda ataja (de lado a lado del piso), salvo donde llega una escalera.
    for (const [r0, r1] of runs) {
      const c = Q((r0 + r1) / 2, s * hw);
      piece.site.box(c.x, c.y, (r1 - r0) / 2, ctx.ground.wall / 2, Math.atan2(t.y, t.x), Math.max(yAt(r0), yAt(r1)) + top + br.rail, false, Math.min(yAt(r0), yAt(r1)));
    }
  }
  // Física del piso (se pisa y se pasa por debajo) y del techo, en tramos por la pendiente.
  const steps = Math.max(1, Math.ceil(L / ctx.ground.step));
  for (let k = 0; k < steps; k++) {
    const u = ((k + 0.5) * L) / steps;
    const c = Q(u, 0);
    piece.site.box(c.x, c.y, L / steps / 2, hw, Math.atan2(t.y, t.x), yAt(u) + top, true, yAt(u));
  }
  const c = Q(L / 2, 0);
  piece.site.box(c.x, c.y, L / 2, hw, Math.atan2(t.y, t.x), Math.max(ya, yb) + ceil + br.roof, true, Math.min(ya, yb) + ceil);
  const pl = S.look(br.piers.skin);
  for (const u of br.piers.at) {
    const q = Q(u, 0);
    const foot = ctx.kit.terrain(q.x, q.y) - ctx.ground.bury;
    const h = yAt(u) - foot;
    const g = new THREE.CylinderGeometry(br.piers.radius, br.piers.radius, h, ctx.detail.sides, 1, true);
    piece.bins.of(pl).geometry(g, new THREE.Matrix4().makeTranslation(q.x, foot + h / 2, q.y), pl.color, surf(pl, false));
    g.dispose();
    piece.site.circle(q.x, q.y, br.piers.radius, yAt(u), false, -Infinity);
  }
}

/** Una escalera recta: peldaños (que se pisan), zancas, barandas y su física. */
export function buildStair(st: MallStair, piece: Piece, ctx: Ctx): void {
  const a = v2(st.a[0], st.a[1]);
  const b = v2(st.b[0], st.b[1]);
  const L = a.distanceTo(b);
  const t = b.clone().sub(a).divideScalar(L);
  const n = v2(-t.y, t.x);
  const foot = ctx.kit.terrain(a.x, a.y);
  const count = Math.max(1, Math.ceil(st.rise / st.riser));
  const rise = st.rise / count;
  const run = L / count;
  const steps = ctx.skins.look(st.skins.steps);
  const stringer = ctx.skins.look(st.skins.stringer);
  const rail = ctx.skins.look(st.skins.rail);
  const sb = piece.bins.of(steps);
  const angle = Math.atan2(t.y, t.x);
  for (let k = 0; k < count; k++) {
    const c = a.clone().addScaledVector(t, (k + 0.5) * run);
    const y = foot + (k + 1) * rise;
    boxAt(sb, c, t, y - rise / 2, run, rise, st.width, steps.color, surf(steps, false));
    piece.site.box(c.x, c.y, run / 2, st.width / 2, angle, y, true, y - st.stringer[0]);
  }
  const [sh, sw] = st.stringer;
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  const sides = ctx.detail.small;
  const posts = Math.max(1, Math.round(L / st.posts));
  for (const s of [-1, 1]) {
    const off = s * (st.width / 2 + sw / 2);
    const A = a.clone().addScaledVector(n, off);
    const B = b.clone().addScaledVector(n, off);
    const facing = n.clone().multiplyScalar(s);
    const quad = [P(A, foot - sh), P(B, foot + st.rise - sh), P(B, foot + st.rise), P(A, foot)];
    const nn = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[3], quad[0]));
    const batch = piece.bins.of(stringer);
    if (nn.x * facing.x + nn.z * facing.y >= 0) batch.quad(quad[0], quad[1], quad[2], quad[3], stringer.color, surf(stringer, false));
    else batch.quad(quad[1], quad[0], quad[3], quad[2], stringer.color, surf(stringer, false));
    const rb = piece.bins.of(rail, true);
    bar(rb, P(A, foot + st.rail), P(B, foot + st.rise + st.rail), sw / 2, sides, rail.color, surf(rail, false));
    for (let k = 0; k <= posts; k++) {
      const q = A.clone().addScaledVector(t, (k / posts) * L);
      const y = foot + (k / posts) * st.rise;
      bar(rb, P(q, y), P(q, y + st.rail), sw / 2, sides, rail.color, surf(rail, false));
    }
    const c = a.clone().addScaledVector(t, L / 2).addScaledVector(n, off);
    piece.site.box(c.x, c.y, L / 2, sw / 2, angle, foot + st.rise + st.rail, false, foot);
  }
}

/** Una reja por su polilínea: el murete, los barrotes calados que siguen el terreno, los pilares y la física. */
export function buildFence(fe: MallFence, style: MallFenceStyle, rails: Batch, piece: Piece, ctx: Ctx): void {
  const S = ctx.skins;
  const bars = S.look(style.skins.bars);
  const baseL = S.look(style.skins.base);
  const post = S.look(style.skins.post);
  const [bh, bw] = style.base;
  const [every, pw] = style.posts;
  const pts = fe.line.map((q) => v2(q[0], q[1]));
  const top = (q: V2): number => ctx.kit.terrain(q.x, q.y);
  let s = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const p = pts[k];
    const q = pts[k + 1];
    const len = p.distanceTo(q);
    if (len < EPS) continue;
    const t = q.clone().sub(p).divideScalar(len);
    // Tramos libres de este lado (sin las entradas).
    let runs = [[0, len]];
    for (const [g0, g1] of fe.gaps) {
      const a = g0 - s;
      const b = g1 - s;
      runs = runs.flatMap(([r0, r1]) =>
        b <= r0 || a >= r1
          ? [[r0, r1]]
          : [
              [r0, Math.max(r0, a)],
              [Math.min(r1, b), r1],
            ].filter(([x0, x1]) => x1 - x0 > EPS),
      );
    }
    for (const [r0, r1] of runs) {
      const parts = Math.max(1, Math.ceil((r1 - r0) / ctx.ground.step));
      for (let j = 0; j < parts; j++) {
        const u0 = r0 + ((r1 - r0) * j) / parts;
        const u1 = r0 + ((r1 - r0) * (j + 1)) / parts;
        const A = p.clone().addScaledVector(t, u0);
        const B = p.clone().addScaledVector(t, u1);
        const ya = top(A);
        const yb = top(B);
        if (bh > EPS) {
          const c = A.clone().add(B).multiplyScalar(0.5);
          const y0 = Math.min(ya, yb) - ctx.ground.bury;
          boxAt(piece.bins.of(baseL), c, t, (y0 + Math.max(ya, yb) + bh) / 2, u1 - u0, Math.max(ya, yb) + bh - y0, bw, baseL.color, surf(baseL, false));
        }
        // Barrotes: uv en m a lo largo de toda la reja (los barrotes no se cortan entre tramos).
        const quad = [new THREE.Vector3(A.x, ya + bh, A.y), new THREE.Vector3(B.x, yb + bh, B.y), new THREE.Vector3(B.x, yb + bh + style.height, B.y), new THREE.Vector3(A.x, ya + bh + style.height, A.y)];
        rails.quad(quad[0], quad[1], quad[2], quad[3], bars.color, surf(bars, false), [s + u0, 0, s + u1, style.height]);
      }
      const posts = Math.max(1, Math.round((r1 - r0) / every));
      for (let j = 0; j <= posts; j++) {
        const u = THREE.MathUtils.clamp(r0 + ((r1 - r0) * j) / posts, r0 + pw / 2, r1 - pw / 2);
        const c = p.clone().addScaledVector(t, u);
        const y0 = top(c) - ctx.ground.bury;
        const h = top(c) + bh + style.height - y0;
        boxAt(piece.bins.of(post), c, t, y0 + h / 2, pw, h, pw, post.color, surf(post, false));
      }
      const c = p.clone().addScaledVector(t, (r0 + r1) / 2);
      const hi = Math.max(top(p.clone().addScaledVector(t, r0)), top(p.clone().addScaledVector(t, r1)));
      piece.site.box(c.x, c.y, (r1 - r0) / 2, Math.max(bw, ctx.ground.wall) / 2, Math.atan2(t.y, t.x), hi + bh + style.height, false, -Infinity);
    }
    s += len;
  }
}

/** Bolardos por su polilínea, instanciados (solo de cerca), con su física. */
export function buildBollards(bo: MallBollards, root: THREE.Object3D, name: string, piece: Piece, ctx: Ctx): void {
  const body = ctx.skins.look(bo.skins.body);
  const stripe = ctx.skins.look(bo.skins.stripe);
  const b = new Batch();
  const put = (y0: number, y1: number, look: typeof body): void => {
    if (y1 - y0 < EPS) return;
    const g = new THREE.CylinderGeometry(bo.radius, bo.radius, y1 - y0, ctx.detail.small, 1, true);
    b.geometry(g, new THREE.Matrix4().makeTranslation(0, (y0 + y1) / 2, 0), look.color, surf(look, false));
    g.dispose();
  };
  // El cuerpo entre franjas y cada franja [desde, hasta], de abajo hacia arriba.
  let from = -ctx.ground.bury;
  for (let k = 0; k + 1 < bo.stripe.length; k += 2) {
    put(from, bo.stripe[k], body);
    put(bo.stripe[k], bo.stripe[k + 1], stripe);
    from = bo.stripe[k + 1];
  }
  put(from, bo.height, body);
  // La tapa, del color de lo que llega arriba.
  const top = bo.stripe.length && bo.stripe[bo.stripe.length - 1] >= bo.height - EPS ? stripe : body;
  const cap = new THREE.CircleGeometry(bo.radius, ctx.detail.small);
  b.geometry(cap, new THREE.Matrix4().makeTranslation(0, bo.height, 0).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), top.color, surf(top, false));
  cap.dispose();
  const spots = bo.line.length === 1 ? [{ p: v2(bo.line[0][0], bo.line[0][1]) }] : along(bo.line, bo.every);
  const mesh = new THREE.InstancedMesh(b.build(), ctx.kit.materials.stone, spots.length);
  const m = new THREE.Matrix4();
  spots.forEach(({ p }, k) => {
    const y = ctx.kit.terrain(p.x, p.y);
    mesh.setMatrixAt(k, m.makeTranslation(p.x, y, p.y));
    piece.site.circle(p.x, p.y, bo.radius, y + bo.height, false, -Infinity);
  });
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);
  piece.site.near(mesh, ctx.detail.near);
}

/** Una jardinera: el borde (cara de afuera, de adentro y tope), la tierra y el piso de la física. */
export function buildPlanter(pl: MallPlanter, piece: Piece, ctx: Ctx): void {
  const wall = ctx.skins.look(pl.skins.wall);
  const soil = ctx.skins.look(pl.skins.soil);
  const pts = pl.ring.map((q) => v2(q[0], q[1]));
  let area = 0;
  for (let k = 0; k < pts.length; k++) area += pts[k].x * pts[(k + 1) % pts.length].y - pts[(k + 1) % pts.length].x * pts[k].y;
  const flip = area > 0 ? -1 : 1;
  const wb = piece.bins.of(wall);
  const top = (q: V2): number => ctx.kit.terrain(q.x, q.y) + pl.height;
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % pts.length];
    const len = p.distanceTo(q);
    if (len < EPS) continue;
    const t = q.clone().sub(p).divideScalar(len);
    const out = v2(-t.y, t.x).multiplyScalar(flip);
    const y0 = Math.min(ctx.kit.terrain(p.x, p.y), ctx.kit.terrain(q.x, q.y)) - ctx.ground.bury;
    const y1 = Math.max(top(p), top(q));
    vquad(wb, p, q, y0, y1, out, wall.color, surf(wall, false), 0, len);
    const pi = p.clone().addScaledVector(out, -pl.wall);
    const qi = q.clone().addScaledVector(out, -pl.wall);
    vquad(wb, pi, qi, y1 - pl.drop, y1, out.clone().negate(), wall.color, surf(wall, false), 0, len);
    hquad(wb, P(p, y1), P(q, y1), P(qi, y1), P(pi, y1), true, wall.color, surf(wall, false));
  }
  // La tierra, `drop` m más abajo que el tope del borde.
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const sb = piece.bins.of(soil);
  for (const [i, j, k] of tris) {
    const Y = (q: V2): number => top(q) - pl.drop;
    tri(sb, P(pts[i], Y(pts[i])), P(pts[j], Y(pts[j])), P(pts[k], Y(pts[k])), UP, soil.color, surf(soil, false), [pts[i].x, pts[i].y, pts[j].x, pts[j].y, pts[k].x, pts[k].y]);
  }
  piece.site.ground(
    pts.map((q) => new THREE.Vector3(q.x, 0, q.y)),
    pl.height,
  );
}

/** Un piso con bordillo (world/street.ts → pavement). */
export function buildPaved(pv: MallPaved, style: PavedStyle, piece: Piece, ctx: Ctx): void {
  pavement({ ring: pv.ring, curbs: pv.curbs }, style, ctx.ground, (x, z) => ctx.kit.terrain(x, z), piece.bins.get('stone'), piece.site);
}

/** Una parada de bus: techo (plano o curvo, con su cara de abajo y sus cantos), postes, muro de fondo y banca, con su física. */
export function buildShelter(sh: MallShelter, piece: Piece, ctx: Ctx): void {
  const S = ctx.skins;
  const roof = S.look(sh.skins.roof);
  const soffit = S.look(sh.skins.soffit);
  const post = S.look(sh.skins.post);
  const back = S.look(sh.skins.back);
  const bench = S.look(sh.skins.bench);
  const ang = THREE.MathUtils.degToRad(sh.angle);
  const f = v2(Math.cos(ang), Math.sin(ang));
  const t = v2(-f.y, f.x);
  const c = v2(sh.at[0], sh.at[1]);
  const [L, D] = sh.size;
  const ground = ctx.kit.terrain(c.x, c.y);
  const y0 = ground + sh.height;
  const Q = (u: number, v: number): V2 => c.clone().addScaledVector(t, u).addScaledVector(f, v);
  const P = (u: number, v: number, y: number): THREE.Vector3 => {
    const q = Q(u, v);
    return new THREE.Vector3(q.x, y, q.y);
  };
  const rb = piece.bins.of(roof);
  const rs = surf(roof, false);
  const segs = sh.rise > EPS ? Math.max(ctx.detail.curve, Math.ceil(D / ctx.detail.arc)) : 1;
  // Del fondo (k = 0, donde van los postes) al frente: el arco más la caída hacia el frente.
  const front = sh.front ?? 0;
  const yAt = (k: number): number => y0 + sh.rise * Math.sin((Math.PI * k) / segs) - (front * k) / segs;
  const T = sh.thickness;
  for (let k = 0; k < segs; k++) {
    const v0 = -D / 2 + (D * k) / segs;
    const v1 = -D / 2 + (D * (k + 1)) / segs;
    hquad(rb, P(-L / 2, v0, yAt(k) + T), P(L / 2, v0, yAt(k) + T), P(L / 2, v1, yAt(k + 1) + T), P(-L / 2, v1, yAt(k + 1) + T), true, roof.color, rs);
    hquad(piece.bins.of(soffit), P(-L / 2, v0, yAt(k)), P(L / 2, v0, yAt(k)), P(L / 2, v1, yAt(k + 1)), P(-L / 2, v1, yAt(k + 1)), false, soffit.color, surf(soffit, false));
    // Los cantos de las puntas, siguiendo el perfil del techo.
    for (const su of [-1, 1]) {
      const d = new THREE.Vector3(t.x * su, 0, t.y * su);
      const p0 = P((su * L) / 2, v0, yAt(k));
      const p1 = P((su * L) / 2, v1, yAt(k + 1));
      const p2 = P((su * L) / 2, v1, yAt(k + 1) + T);
      const p3 = P((su * L) / 2, v0, yAt(k) + T);
      tri(rb, p0, p1, p2, d, roof.color, rs, [v0, yAt(k), v1, yAt(k + 1), v1, yAt(k + 1) + T]);
      tri(rb, p0, p2, p3, d, roof.color, rs, [v0, yAt(k), v1, yAt(k + 1) + T, v0, yAt(k) + T]);
    }
  }
  // Los cantos del fondo y del frente.
  vquad(rb, Q(-L / 2, -D / 2), Q(L / 2, -D / 2), yAt(0), yAt(0) + T, f.clone().negate(), roof.color, rs, 0, L);
  vquad(rb, Q(-L / 2, D / 2), Q(L / 2, D / 2), yAt(segs), yAt(segs) + T, f, roof.color, rs, 0, L);
  const angle = Math.atan2(t.y, t.x);
  piece.site.box(c.x, c.y, L / 2, D / 2, angle, y0 + sh.rise + sh.thickness, true, y0 - front);
  const posts = Math.max(1, Math.round(L / sh.every));
  const pb = piece.bins.of(post);
  for (let k = 0; k <= posts; k++) {
    const q = Q(-L / 2 + (L * k) / posts, -D / 2 + sh.post);
    const foot = ctx.kit.terrain(q.x, q.y) - ctx.ground.bury;
    boxAt(pb, q, t, (foot + y0) / 2, sh.post, y0 - foot, sh.post, post.color, surf(post, false));
    piece.site.box(q.x, q.y, sh.post / 2, sh.post / 2, angle, y0, false, -Infinity);
  }
  if (sh.back > EPS) {
    const A = Q(-L / 2, -D / 2 + sh.post);
    const B = Q(L / 2, -D / 2 + sh.post);
    vquad(piece.bins.of(back), A, B, ground, ground + sh.back, f, back.color, surf(back, false), 0, L);
    vquad(piece.bins.of(back), A, B, ground, ground + sh.back, f.clone().negate(), back.color, surf(back, false), 0, L);
    const m = Q(0, -D / 2 + sh.post);
    piece.site.box(m.x, m.y, L / 2, ctx.ground.wall / 2, angle, ground + sh.back, false, -Infinity);
  }
  const [bh, bd, bl] = sh.bench;
  if (bh > EPS) {
    const q = Q(0, -D / 2 + sh.post + bd / 2);
    boxAt(piece.bins.of(bench, true), q, t, ground + bh / 2, bl, bh, bd, bench.color, surf(bench, false));
    piece.site.box(q.x, q.y, bl / 2, bd / 2, angle, ground + bh, true, -Infinity);
  }
}

/** Una fuente redonda: el borde, el agua y los chorros. */
export function buildFountain(fo: MallFountain, piece: Piece, ctx: Ctx): void {
  const wall = ctx.skins.look(fo.skins.wall);
  const water = ctx.skins.look(fo.skins.water);
  const jet = ctx.skins.look(fo.skins.jet);
  const [wh, ww] = fo.wall;
  const [x, z] = fo.at;
  const y = ctx.kit.terrain(x, z);
  const sides = Math.max(ctx.detail.sides, Math.ceil((2 * Math.PI * fo.radius) / ctx.detail.arc));
  const wb = piece.bins.of(wall);
  const at = (dy: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y + dy, z);
  const outer = new THREE.CylinderGeometry(fo.radius, fo.radius, wh + ctx.ground.bury, sides, 1, true);
  wb.geometry(outer, at((wh - ctx.ground.bury) / 2), wall.color, surf(wall, false));
  outer.dispose();
  // La cara de adentro del borde, vista desde el agua (world/classical.ts → inward).
  const inner = inward(new THREE.CylinderGeometry(fo.radius - ww, fo.radius - ww, fo.water, sides, 1, true));
  wb.geometry(inner, at(wh - fo.water / 2), wall.color, surf(wall, false));
  inner.dispose();
  const rim = new THREE.RingGeometry(fo.radius - ww, fo.radius, sides);
  wb.geometry(rim, at(wh).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), wall.color, surf(wall, false));
  rim.dispose();
  const disc = new THREE.CircleGeometry(fo.radius - ww, sides);
  piece.bins.of(water).geometry(disc, at(wh - fo.water).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), water.color, surf(water, false));
  disc.dispose();
  const J = fo.jets;
  for (let k = 0; k < J.count; k++) {
    const a = (k / J.count) * Math.PI * 2;
    const p = new THREE.Vector3(x + Math.cos(a) * J.ring, y + wh - fo.water, z + Math.sin(a) * J.ring);
    const g = new THREE.ConeGeometry(J.radius, J.height, ctx.detail.small, 1, true);
    piece.bins.of(jet, true).geometry(g, new THREE.Matrix4().makeTranslation(p.x, p.y + J.height / 2, p.z), jet.color, surf(jet, jet.lit > 0));
    g.dispose();
  }
  piece.site.circle(x, z, fo.radius, y + wh, true, -Infinity);
}

/** Una valla o pantalla unipolar: el poste, el panel con sus caras y la física del poste. */
export function buildBillboard(bb: MallBillboard, piece: Piece, ctx: Ctx): void {
  const pole = ctx.skins.look(bb.skins.pole);
  const frame = ctx.skins.look(bb.skins.frame);
  const face = ctx.skins.look(bb.skins.face);
  const [x, z] = bb.at;
  const y = ctx.kit.terrain(x, z);
  const [r, h] = bb.pole;
  const [w, ph, d] = bb.panel;
  const ang = THREE.MathUtils.degToRad(bb.angle);
  const f = v2(Math.cos(ang), Math.sin(ang));
  const t = v2(-f.y, f.x);
  const g = new THREE.CylinderGeometry(r, r, h + ctx.ground.bury, ctx.detail.sides, 1, true);
  piece.bins.of(pole).geometry(g, new THREE.Matrix4().makeTranslation(x, y + (h - ctx.ground.bury) / 2, z), pole.color, surf(pole, false));
  g.dispose();
  const c = v2(x, z);
  boxAt(piece.bins.of(frame), c, t, y + h + ph / 2, w, ph, d, frame.color, surf(frame, false));
  const R = bb.reflectors;
  const lamp = R ? ctx.skins.look(R.skin) : undefined;
  for (const s of bb.back ? [1, -1] : [1]) {
    // La cara de atrás con su propia piel, si la tiene (otro anuncio).
    const look = s < 0 && bb.skins.back ? ctx.skins.look(bb.skins.back) : face;
    const off = c.clone().addScaledVector(f, s * (d / 2 + ctx.kit.signOffset));
    const inset = bb.border;
    vquad(piece.bins.of(look), off.clone().addScaledVector(t, -w / 2 + inset), off.clone().addScaledVector(t, w / 2 - inset), y + h + inset, y + h + ph - inset, f.clone().multiplyScalar(s), look.color, surf(look, look.lit > 0), 0, w);
    if (!R || !lamp) continue;
    // Focos en brazos sobre el borde de arriba, repartidos parejo a lo ancho.
    const out = f.clone().multiplyScalar(s);
    const yTop = y + h + ph;
    const [lw, lh, ld] = R.size;
    for (let k = 0; k < R.count; k++) {
      const along = -w / 2 + (w * (k + 0.5)) / R.count;
      const root = c.clone().addScaledVector(t, along).addScaledVector(out, d / 2);
      boxAt(piece.bins.of(lamp, true), root.clone().addScaledVector(out, R.arm / 2), out, yTop + R.rod / 2, R.arm, R.rod, R.rod, lamp.color, surf(lamp, false));
      boxAt(piece.bins.of(lamp, true), root.clone().addScaledVector(out, R.arm), t, yTop + lh / 2, lw, lh, ld, lamp.color, surf(lamp, true));
    }
  }
  piece.site.circle(x, z, r, y + h, false, -Infinity);
  piece.site.box(x, z, w / 2, d / 2, Math.atan2(t.y, t.x), y + h + ph, false, y + h);
}

/** Torres de vigilancia: el poste, sus cajas con sus franjas y sus faldones, con su física. */
export function buildTowers(tw: MallTower, piece: Piece, ctx: Ctx): void {
  const pole = ctx.skins.look(tw.pole.skin);
  // El faldón: una pirámide trunca de base cuadrada, de lado 1 abajo y `k` arriba, alto 1 (con tapas).
  const flare = (k: number): THREE.BufferGeometry => faceted(new THREE.CylinderGeometry(k * Math.SQRT1_2, Math.SQRT1_2, 1, SQUARE, 1, false, Math.PI / SQUARE));
  for (const at of tw.at) {
    const [x, z] = at;
    const ang = THREE.MathUtils.degToRad(at[2] ?? tw.angle);
    const t = v2(Math.cos(ang), Math.sin(ang));
    const c = v2(x, z);
    const ground = ctx.kit.terrain(x, z);
    const foot = ground - ctx.ground.bury;
    const g = new THREE.CylinderGeometry(tw.pole.radius, tw.pole.radius, ground + tw.pole.height - foot, ctx.detail.small, 1, true);
    piece.bins.of(pole).geometry(g, new THREE.Matrix4().makeTranslation(x, (foot + ground + tw.pole.height) / 2, z), pole.color, surf(pole, false));
    g.dispose();
    piece.site.circle(x, z, tw.pole.radius, ground + tw.pole.height, false, -Infinity);
    for (const p of tw.parts) {
      const l = ctx.skins.look(p.skin);
      const y = ground + p.y;
      if (p.shape === 'box') {
        const [w, h, d] = p.size;
        const rim = p.rims ? Math.min(p.rims.height, h / 2) : 0;
        boxAt(piece.bins.of(l), c, t, y + h / 2, w, h - 2 * rim, d, l.color, surf(l, l.lit > 0));
        if (p.rims && rim > EPS) {
          const rl = ctx.skins.look(p.rims.skin);
          for (const yy of [y + rim / 2, y + h - rim / 2]) boxAt(piece.bins.of(rl), c, t, yy, w, rim, d, rl.color, surf(rl, false));
        }
        piece.site.box(x, z, w / 2, d / 2, ang, y + h, false, y);
      } else if (p.shape === 'flare') {
        const [w0, w1, h] = p.size;
        const geo = flare(w1 / w0);
        const m = new THREE.Matrix4().makeTranslation(x, y + h / 2, z).multiply(new THREE.Matrix4().makeRotationY(-ang)).multiply(new THREE.Matrix4().makeScale(w0, h, w0));
        piece.bins.of(l).geometry(geo, m, l.color, surf(l, false));
        geo.dispose();
        piece.site.box(x, z, w0 / 2, w0 / 2, ang, y + h, false, y);
      } else {
        throw new Error(`Torre de vigilancia: pieza "${p.shape}" (hay: box, flare)`);
      }
    }
  }
}

/** El modelo de moto (instanciado; la rueda de adelante hacia +x): solo el cuerpo se pinta con el color de cada una. */
function motoModel(m: MallMotoModel, sides: number): THREE.BufferGeometry {
  const b = new Batch();
  const [r, wt] = m.wheel;
  const [bl, bh, bw] = m.body;
  const [sl, sh, sw, back] = m.seat;
  const [barW, barH, barX] = m.bars;
  const tire = new THREE.Color(m.tire);
  const metal = new THREE.Color(m.metal);
  for (const s of [-1, 1]) {
    const g = new THREE.CylinderGeometry(r, r, wt, sides);
    b.geometry(g, new THREE.Matrix4().makeTranslation((s * m.base) / 2, r, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), tire);
    g.dispose();
  }
  b.box(new THREE.Matrix4().makeTranslation(0, m.clearance + bh / 2, 0), bl, bh, bw, new THREE.Color(1, 1, 1), { paint: 1 });
  b.box(new THREE.Matrix4().makeTranslation(-back, m.clearance + bh + sh / 2, 0), sl, sh, sw, new THREE.Color(m.seatColor));
  // La horquilla, de la rueda de adelante al manubrio, y el manubrio de lado a lado.
  const front = m.base / 2;
  const fork = new THREE.Vector3(front, r, 0);
  const head = new THREE.Vector3(barX, barH, 0);
  const d = new THREE.Vector3().subVectors(head, fork);
  const len = d.length();
  const g = new THREE.CylinderGeometry(m.fork, m.fork, len, sides, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
  b.geometry(g, new THREE.Matrix4().compose(new THREE.Vector3().addVectors(fork, head).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), metal);
  g.dispose();
  b.box(new THREE.Matrix4().makeTranslation(head.x, head.y, 0), m.fork * 2, m.fork * 2, barW, metal);
  return b.build();
}

/**
 * Las motos estacionadas del mall: un modelo instanciado para todas (solo de cerca, sin sombra),
 * con el color de cada una, y la física de cada tramo seguido de motos de una fila.
 */
export function buildMotos(mt: { model: MallMotoModel; rows: MallMotoRow[] }, root: THREE.Object3D, name: string, piece: Piece, ctx: Ctx): void {
  const M = mt.model;
  const seed = seedOf(name);
  const spots: { x: number; z: number; y: number; a: number }[] = [];
  // El largo y el ancho de una moto (en planta): de rueda a rueda y el manubrio.
  const long = Math.max(M.base + 2 * M.wheel[0], M.body[0]);
  const wide = Math.max(M.bars[0], M.body[2]);
  let serial = 0;
  for (const row of mt.rows) {
    const a = v2(row.line[0][0], row.line[0][1]);
    const b = v2(row.line[1][0], row.line[1][1]);
    const L = a.distanceTo(b);
    const t = b.clone().sub(a).divideScalar(L);
    const n = Math.floor(L / row.every);
    const base = THREE.MathUtils.degToRad(row.angle);
    const turn = THREE.MathUtils.degToRad(row.turn);
    // Cuánto ocupa la fila de través, según hacia dónde miran las motos respecto de ella.
    const rel = base - Math.atan2(t.y, t.x);
    const across = Math.abs(Math.sin(rel)) * long + Math.abs(Math.cos(rel)) * wide;
    // Los tramos seguidos de motos (en m a lo largo de la fila), para la física.
    let run: number[] | null = null;
    const close = (): void => {
      if (!run) return;
      const [s0, s1] = run;
      const c = a.clone().addScaledVector(t, (s0 + s1) / 2);
      piece.site.box(c.x, c.y, (s1 - s0) / 2, across / 2, Math.atan2(t.y, t.x), ctx.kit.terrain(c.x, c.y) + M.bars[1], false, -Infinity);
      run = null;
    };
    for (let k = 0; k < n; k++) {
      if (rand(seed + serial++, 13) >= row.share) {
        close();
        continue;
      }
      const s = (k + 0.5) * row.every;
      const p = a.clone().addScaledVector(t, s);
      spots.push({ x: p.x, z: p.y, y: ctx.kit.terrain(p.x, p.y), a: base + (rand(seed + serial, 17) * 2 - 1) * turn });
      run = run ? [run[0], s + row.every / 2] : [s - row.every / 2, s + row.every / 2];
    }
    close();
  }
  if (!spots.length) return;
  const mesh = new THREE.InstancedMesh(motoModel(M, ctx.detail.small), ctx.kit.materials.paint, spots.length);
  const colors = M.colors.map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  spots.forEach((s, k) => {
    mesh.setMatrixAt(k, m.compose(new THREE.Vector3(s.x, s.y, s.z), q.setFromAxisAngle(UP, -s.a), one));
    mesh.setColorAt(k, colors[Math.floor(rand(seed + k, 19) * colors.length) % colors.length]);
  });
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  root.add(mesh);
  piece.site.near(mesh, ctx.detail.near);
}

/** Dónde va cada poste de un grupo, con el ángulo (atan2(z, x) local) de su brazo +z. */
function lampSpots(l: MallLamps): { x: number; z: number; a: number }[] {
  return l.at.map((q) => ({ x: q[0], z: q[1], a: THREE.MathUtils.degToRad(q[2] ?? l.angle) }));
}

/** Los giros del juego de brazos de un modelo (radianes). */
function lampTurns(model: MallLampModel): number[] {
  return (model.turns ?? [0]).map((d) => THREE.MathUtils.degToRad(d));
}

/** Los postes de un grupo, instanciados (se ven hasta `near` del modelo), con su física. */
export function buildLamps(l: MallLamps, model: MallLampModel, geometry: THREE.BufferGeometry, root: THREE.Object3D, name: string, piece: Piece, ctx: Ctx): void {
  const spots = lampSpots(l);
  const turns = lampTurns(model);
  // Un juego de brazos por instancia: los fustes de los giros de un mismo poste coinciden.
  const mesh = new THREE.InstancedMesh(geometry, ctx.kit.materials.stone, spots.length * turns.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const [baseR] = model.pole.base;
  spots.forEach((s, k) => {
    const y = ctx.kit.terrain(s.x, s.z);
    // El modelo tiene su brazo +1 hacia +z: girar π/2 − a lo lleva a (cos a, sin a).
    turns.forEach((turn, j) => mesh.setMatrixAt(k * turns.length + j, m.compose(new THREE.Vector3(s.x, y, s.z), q.setFromAxisAngle(UP, Math.PI / 2 - s.a - turn), one)));
    piece.site.circle(s.x, s.z, baseR, y + model.pole.height, false, -Infinity);
  });
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  piece.site.near(mesh, model.near);
}

/** El modelo de un poste (world/medians.ts → lampModel). */
export function lampGeometry(model: MallLampModel): THREE.BufferGeometry {
  return lampModel(model, model.colors, model.sides);
}

/** Las luces de los postes de un grupo para el alumbrado: una por brazo, en su punta. */
export function lampLights(l: MallLamps, model: MallLampModel): PlaceLight[] {
  const out: PlaceLight[] = [];
  const turns = lampTurns(model);
  for (const s of lampSpots(l)) {
    for (const turn of turns) {
      for (const side of model.sides) {
        const a = s.a + turn + (side > 0 ? 0 : Math.PI);
        out.push({
          x: s.x + Math.cos(a) * model.arm.reach,
          z: s.z + Math.sin(a) * model.arm.reach,
          lift: 0,
          h: model.pole.height + model.arm.rise,
          out: a,
          power: model.light.power,
          led: model.light.led,
        });
      }
    }
  }
  return out;
}

/** Los autos sueltos del mall (van a los de la ciudad). */
export function park(site: MallSite, ctx: Ctx): void {
  for (const c of site.cars) for (const [x, z, deg] of c.at) ctx.kit.car(x, z, THREE.MathUtils.degToRad(deg ?? 0), c.lift);
}

/** Palmeras y árboles del mall (van a los de la ciudad). */
export function plant(site: MallSite, ctx: Ctx): void {
  let k = 0;
  for (const p of site.palms) {
    for (const [x, z] of p.at) ctx.kit.palm(x, z, ctx.kit.terrain(x, z), THREE.MathUtils.lerp(p.height[0], p.height[1], rand(k++, 5)));
  }
  for (const t of site.trees) {
    const greens = t.colors.map((c) => new THREE.Color(c));
    for (const [x, z] of t.at) {
      const j = k++;
      ctx.kit.tree(x, z, ctx.kit.terrain(x, z), THREE.MathUtils.lerp(t.height[0], t.height[1], rand(j, 1)), THREE.MathUtils.lerp(t.radius[0], t.radius[1], rand(j, 2)), greens[Math.floor(rand(j, 3) * greens.length) % greens.length]);
    }
  }
}
