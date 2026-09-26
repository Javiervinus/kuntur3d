import * as THREE from 'three';
import { type Surface, patternOf } from './monumentParts';
import { Frame, type PartsKit, baseOf } from './urbanizationParts';
import type { WallRun } from './walls';

/**
 * Piezas de las áreas sociales (config/sites → zonas): piscinas de cualquier forma, canchas con sus
 * líneas, arcos, tableros, red y cerramiento, y juegos infantiles. Largos en m; alturas sobre el
 * terreno.
 */

const TAU = Math.PI * 2;

/** Cuadrilátero que mira hacia `dir` (lo da vuelta si hace falta). */
function toward(pk: PartsKit, batch: 'stone' | 'detail' | 'rails', dir: THREE.Vector3, p: THREE.Vector3[], color: THREE.Color, surface: Surface = {}, uv?: number[]): void {
  const b = pk[batch];
  const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[0]));
  if (n.dot(dir) >= 0) b.quad(p[0], p[1], p[2], p[3], color, surface, uv);
  else b.quad(p[1], p[0], p[3], p[2], color, surface, uv && [uv[2], uv[3], uv[0], uv[1], uv[6], uv[7], uv[4], uv[5]]);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Un polígono plano (x, z del lugar) a la altura `y`, triangulado y mirando arriba, en `batch`. */
function flat(pk: PartsKit, batch: 'stone' | 'detail' | 'water', ring: readonly THREE.Vector2[], y: number, color: THREE.Color, surface: Surface = {}): void {
  const tris = THREE.ShapeUtils.triangulateShape([...ring], []);
  for (const [a, b, c] of tris) {
    const [pa, pb, pc] = [ring[a], ring[b], ring[c]].map((p) => new THREE.Vector3(p.x, y, p.y));
    const n = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
    const [q0, q1, q2] = n.y >= 0 ? [pa, pb, pc] : [pa, pc, pb];
    pk[batch].tri(q0, q1, q2, color, surface, [q0.x, q0.z, q1.x, q1.z, q2.x, q2.z]);
  }
}

/** Área con signo de un contorno (x, y de Vector2). */
function signedArea(ring: readonly THREE.Vector2[]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Coseno mínimo del inglete: en una esquina muy aguda la punta no sale más de 1 / MITER veces `d`. */
const MITER = 0.25;

/** El contorno corrido `d` hacia afuera (esquinas a inglete). */
function offset(ring: readonly THREE.Vector2[], d: number): THREE.Vector2[] {
  const s = signedArea(ring) > 0 ? 1 : -1;
  const n = ring.length;
  return ring.map((p, k) => {
    const prev = ring[(k + n - 1) % n];
    const next = ring[(k + 1) % n];
    const e0 = p.clone().sub(prev).normalize();
    const e1 = next.clone().sub(p).normalize();
    // Normal hacia afuera de cada lado (con el signo del sentido del contorno).
    const n0 = new THREE.Vector2(e0.y, -e0.x).multiplyScalar(s);
    const n1 = new THREE.Vector2(e1.y, -e1.x).multiplyScalar(s);
    const m = n0.clone().add(n1);
    const len = m.length();
    if (len < 1e-6) return p.clone().addScaledVector(n0, d);
    m.divideScalar(len);
    const cos = Math.max(MITER, m.dot(n0));
    return p.clone().addScaledVector(m, d / cos);
  });
}

// ---------------------------------------------------------------------------------------------
// Piscinas

/**
 * Cómo es una piscina: el borde (ancho, cuánto sube sobre el piso de alrededor, color, dibujo y
 * escala), el vaso (paredes y fondo: color, dibujo, escala y la oclusión del fondo) y el agua (cuánto
 * bajo el borde y su color; va con el acabado `water` de la config, transparente).
 */
export interface PoolStyle {
  coping: { width: number; height: number; color: string; pattern: string; scale: number[] };
  shell: { color: string; pattern: string; scale: number[]; ao: number };
  water: { below: number; color: string };
}

/** Una piscina en su zona: su contorno de agua (u, v) o una elipse (u, v, radio en u, radio en v, giro en grados); hondo, piso de alrededor sobre el terreno, estilo y fuente. */
export interface PoolPlace {
  id: string;
  ring?: number[][];
  ellipse?: number[];
  depth: number;
  lift: number;
  style: string;
  source: string;
}

/** El contorno de una piscina (marco de su zona). */
export function poolRing(p: PoolPlace, sides: number): number[][] {
  if (p.ring) return p.ring;
  if (!p.ellipse) throw new Error(`Piscina ${p.id}: necesita ring o ellipse`);
  const [cu, cv, ru, rv, deg] = p.ellipse;
  const a = THREE.MathUtils.degToRad(deg);
  return Array.from({ length: sides }, (_, k) => {
    const t = (k / sides) * TAU;
    const x = Math.cos(t) * ru;
    const y = Math.sin(t) * rv;
    return [cu + x * Math.cos(a) - y * Math.sin(a), cv + x * Math.sin(a) + y * Math.cos(a)];
  });
}

/** Arma una piscina: el borde, el vaso visto desde adentro, el fondo y el agua; se camina sobre el agua. */
export function buildPool(p: PoolPlace, S: PoolStyle, zone: Frame, pk: PartsKit): void {
  const ring = zone.ring(poolRing(p, pk.sides)).map(([x, z]) => new THREE.Vector2(x, z));
  const c = ring.reduce((acc, q) => acc.add(q), new THREE.Vector2()).divideScalar(ring.length);
  const samples = [c, ...ring].map((q) => pk.terrain(q.x, q.y)).sort((a, b) => a - b);
  const ground = samples[Math.floor(samples.length / 2)];
  const deck = ground + p.lift;
  const top = deck + S.coping.height;
  const water = top - S.water.below;
  const bottom = top - p.depth;
  const coping = new THREE.Color(S.coping.color);
  const copingSurface: Surface = { pattern: patternOf(S.coping.pattern), scale: S.coping.scale };
  const outer = offset(ring, S.coping.width);
  const sense = signedArea(ring) > 0 ? 1 : -1;
  const shell = new THREE.Color(S.shell.color);
  const shellSurface: Surface = { pattern: patternOf(S.shell.pattern), scale: S.shell.scale, ao: S.shell.ao };
  const V = (q: THREE.Vector2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  let u = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const len = a.distanceTo(b);
    if (len < 1e-4) continue;
    const e = b.clone().sub(a).divideScalar(len);
    const nOut = new THREE.Vector3(e.y, 0, -e.x).multiplyScalar(sense);
    // Borde: su tope (mira arriba) y su canto de afuera.
    const oa = outer[k];
    const ob = outer[(k + 1) % ring.length];
    toward(pk, 'stone', UP, [V(a, top), V(b, top), V(ob, top), V(oa, top)], coping, copingSurface);
    toward(pk, 'stone', nOut, [V(oa, deck), V(ob, deck), V(ob, top), V(oa, top)], coping, copingSurface);
    // Pared del vaso (mira hacia el agua), con el azulejo en metros.
    toward(pk, 'stone', nOut.clone().negate(), [V(a, bottom), V(b, bottom), V(b, top), V(a, top)], shell, shellSurface, [u, 0, u + len, 0, u + len, p.depth, u, p.depth]);
    u += len;
  }
  flat(pk, 'stone', ring, bottom, shell, shellSurface);
  flat(pk, 'water', ring, water, new THREE.Color(S.water.color));
  pk.site.ground(
    ring.map((q) => new THREE.Vector3(q.x, 0, q.y)),
    water - ground,
  );
}

// ---------------------------------------------------------------------------------------------
// Canchas

/**
 * Cómo es una cancha: la losa (cuánto sobre el terreno, color, dibujo y escala) con su franja de
 * borde (ancho y color); las líneas (ancho, color, cuánto sobre la losa) en m desde el centro con
 * u a lo largo: rectángulos (u0, v0, u1, v1), segmentos (u0, v0, u1, v1), círculos (u, v, radio) y
 * arcos (u, v, radio, desde, hasta: grados desde +u); zonas pintadas de otro color (rectángulo o
 * círculo lleno) a `zonesLift` sobre la losa, debajo de las líneas; y lo que tenga: arcos de
 * fútbol, tableros de básquet, red de tenis y el cerramiento de malla. Las alturas de lo pintado
 * son las que no titilan contra la losa (la profundidad no distingue menos) a la distancia a la que
 * se ven: las zonas, siempre; las líneas, solo de cerca (`detail.near`).
 */
export interface CourtStyle {
  surface: { lift: number; color: string; pattern: string; scale: number[] };
  border?: { width: number; color: string };
  lines: { width: number; color: string; lift: number; rects: number[][]; segments: number[][]; circles: number[][]; arcs: number[][] };
  zonesLift: number;
  zones: { rect?: number[]; circle?: number[]; color: string }[];
  /** Arcos de fútbol en u = ±at: ancho, alto, fondo (arriba y abajo), grosor del caño, color; la red calada (dibujo, escala y color). */
  goals?: { at: number; width: number; height: number; depth: number[]; bar: number; color: string; net: { pattern: string; scale: number[]; color: string } };
  /** Tableros de básquet en u = ±at (mirando al centro): el poste (alto, lado, cuánto detrás del tablero, color), el tablero (ancho, alto, grosor, altura de su pie, color) y el aro (radio, grosor, altura, adelanto desde el tablero, color). */
  hoops?: {
    at: number;
    pole: { height: number; size: number; back: number; color: string };
    board: { size: number[]; bottom: number; color: string };
    ring: { radius: number; tube: number; height: number; reach: number; color: string };
  };
  /** Red de tenis a lo ancho (u = 0): postes en v = ±at (lado y alto) y su color, alto de la red, su faja de arriba (alto y color), dibujo calado, escala y color. */
  net?: { at: number; post: number[]; postColor: string; height: number; tape: number; tapeColor: string; pattern: string; scale: number[]; color: string };
  /** Cerramiento de malla (un estilo de walls), a cuánto de la losa, y sus huecos: lado (0 = −v, 1 = +u, 2 = +v, 3 = −u), desde y hasta (m desde el comienzo del lado). */
  fence?: { style: string; margin: number; gaps: number[][] };
}

/** Una cancha en su zona: centro (u, v), largo y ancho de la losa (u a lo largo), giro (grados), estilo y fuente. */
export interface CourtPlace {
  id: string;
  at: number[];
  size: number[];
  angle: number;
  style: string;
  source: string;
}

/** Los tramos del cerramiento de una cancha (marco del lugar), con sus huecos. */
function fenceRuns(c: CourtPlace, S: NonNullable<CourtStyle['fence']>, f: Frame, style: string): WallRun[] {
  const [L, W] = c.size;
  const hu = L / 2 + S.margin;
  const hv = W / 2 + S.margin;
  // Los lados en el sentido de la cancha (−v, +u, +v, −u), cada uno de su punta a la siguiente.
  const corners = [
    [-hu, -hv],
    [hu, -hv],
    [hu, hv],
    [-hu, hv],
  ];
  const out: WallRun[] = [];
  for (let k = 0; k < 4; k++) {
    const a = new THREE.Vector2(...(corners[k] as [number, number]));
    const b = new THREE.Vector2(...(corners[(k + 1) % 4] as [number, number]));
    const len = a.distanceTo(b);
    const gaps = S.gaps.filter((g) => g[0] === k).map((g) => [g[1], g[2]]);
    let runs = [[0, len]];
    for (const [g0, g1] of gaps) {
      runs = runs.flatMap(([r0, r1]) =>
        g1 <= r0 || g0 >= r1
          ? [[r0, r1]]
          : [
              [r0, Math.max(r0, g0)],
              [Math.min(r1, g1), r1],
            ].filter(([p, q]) => q - p > 1e-3),
      );
    }
    runs.forEach(([r0, r1], j) => {
      const p = a.clone().lerp(b, r0 / len);
      const q = a.clone().lerp(b, r1 / len);
      out.push({ id: `${c.id}-${k}-${j}`, style, line: f.ring([p.toArray(), q.toArray()]), closed: false, outside: 1, source: c.source });
    });
  }
  return out;
}

/**
 * Arma una cancha: la losa con su borde, las líneas y zonas pintadas, y lo que tenga (arcos,
 * tableros, red). El cerramiento va aparte (`walls`, con los estilos de muro), en el mismo pedazo.
 */
export function buildCourt(c: CourtPlace, S: CourtStyle, zone: Frame, pk: PartsKit, walls: (run: WallRun) => void): void {
  const f = Frame.of(c.at, c.angle, zone);
  const m = f.matrix();
  const [L, W] = c.size;
  const { base } = baseOf(f, L, W, pk.terrain);
  const y = base + S.surface.lift;
  const P = (u: number, h: number, v: number): THREE.Vector3 => new THREE.Vector3(u, h, v).applyMatrix4(m);
  const up = (batch: 'stone' | 'detail', u0: number, v0: number, u1: number, v1: number, h: number, color: THREE.Color, surface: Surface = {}): void =>
    toward(pk, batch, UP, [P(u0, h, v0), P(u1, h, v0), P(u1, h, v1), P(u0, h, v1)], color, surface, [u0, v0, u1, v0, u1, v1, u0, v1]);
  const B = S.border;
  const bw = B ? B.width : 0;
  const surf: Surface = { pattern: patternOf(S.surface.pattern), scale: S.surface.scale };
  up('stone', -L / 2 + bw, -W / 2 + bw, L / 2 - bw, W / 2 - bw, y, new THREE.Color(S.surface.color), surf);
  if (B) {
    const bc = new THREE.Color(B.color);
    up('stone', -L / 2, -W / 2, L / 2, -W / 2 + bw, y, bc, surf);
    up('stone', -L / 2, W / 2 - bw, L / 2, W / 2, y, bc, surf);
    up('stone', -L / 2, -W / 2 + bw, -L / 2 + bw, W / 2 - bw, y, bc, surf);
    up('stone', L / 2 - bw, -W / 2 + bw, L / 2, W / 2 - bw, y, bc, surf);
  }
  // Canto de la losa.
  const edge = new THREE.Color(B ? B.color : S.surface.color);
  const corners = [
    [-L / 2, -W / 2],
    [L / 2, -W / 2],
    [L / 2, W / 2],
    [-L / 2, W / 2],
  ];
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = corners[k];
    const [u1, v1] = corners[(k + 1) % 4];
    const out = new THREE.Vector3(v1 - v0, 0, -(u1 - u0)).normalize().transformDirection(m);
    const foot = base - pk.ground.bury;
    toward(pk, 'stone', out, [P(u0, foot, v0), P(u1, foot, v1), P(u1, y, v1), P(u0, y, v0)], edge);
  }
  pk.site.ground(
    f.ring(corners).map(([x, z]) => new THREE.Vector3(x, 0, z)),
    S.surface.lift,
  );
  // Zonas pintadas (se ven de lejos) y, encima, las líneas (finas: solo de cerca).
  const Ln = S.lines;
  const hz = y + S.zonesLift;
  const hl = y + Ln.lift;
  for (const z of S.zones) {
    const color = new THREE.Color(z.color);
    if (z.rect) up('stone', z.rect[0], z.rect[1], z.rect[2], z.rect[3], hz, color);
    if (z.circle) disc(z.circle, hz, color);
  }
  const lc = new THREE.Color(Ln.color);
  const w = Ln.width / 2;
  const seg = (u0: number, v0: number, u1: number, v1: number): void => {
    const len = Math.hypot(u1 - u0, v1 - v0);
    if (len < 1e-4) return;
    const nu = (-(v1 - v0) / len) * w;
    const nv = ((u1 - u0) / len) * w;
    toward(pk, 'detail', UP, [P(u0 - nu, hl, v0 - nv), P(u1 - nu, hl, v1 - nv), P(u1 + nu, hl, v1 + nv), P(u0 + nu, hl, v0 + nv)], lc);
  };
  function disc(circle: readonly number[], h: number, color: THREE.Color): void {
    const [cu, cv, r] = circle;
    const cc = P(cu, h, cv);
    for (let k = 0; k < pk.sides; k++) {
      const a0 = (k / pk.sides) * TAU;
      const a1 = ((k + 1) / pk.sides) * TAU;
      const p0 = P(cu + Math.cos(a0) * r, h, cv + Math.sin(a0) * r);
      const p1 = P(cu + Math.cos(a1) * r, h, cv + Math.sin(a1) * r);
      const n = new THREE.Vector3().subVectors(p0, cc).cross(new THREE.Vector3().subVectors(p1, cc));
      if (n.y >= 0) pk.stone.tri(cc, p0, p1, color);
      else pk.stone.tri(cc, p1, p0, color);
    }
  }
  const arc = (cu: number, cv: number, r: number, a0: number, a1: number): void => {
    const n = Math.max(2, Math.ceil((pk.sides * Math.abs(a1 - a0)) / TAU));
    for (let k = 0; k < n; k++) {
      const t0 = a0 + ((a1 - a0) * k) / n;
      const t1 = a0 + ((a1 - a0) * (k + 1)) / n;
      seg(cu + Math.cos(t0) * r, cv + Math.sin(t0) * r, cu + Math.cos(t1) * r, cv + Math.sin(t1) * r);
    }
  };
  for (const [u0, v0, u1, v1] of Ln.rects) {
    seg(u0, v0, u1, v0);
    seg(u1, v0, u1, v1);
    seg(u1, v1, u0, v1);
    seg(u0, v1, u0, v0);
  }
  for (const [u0, v0, u1, v1] of Ln.segments) seg(u0, v0, u1, v1);
  for (const [cu, cv, r] of Ln.circles) arc(cu, cv, r, 0, TAU);
  for (const [cu, cv, r, d0, d1] of Ln.arcs) arc(cu, cv, r, THREE.MathUtils.degToRad(d0), THREE.MathUtils.degToRad(d1));

  const at = (u: number, h: number, v: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, h, v));
  const G = S.goals;
  if (G) {
    const color = new THREE.Color(G.color);
    const net = new THREE.Color(G.net.color);
    const netSurface: Surface = { pattern: patternOf(G.net.pattern), scale: G.net.scale };
    const [dTop, dBottom] = G.depth;
    for (const s of [-1, 1]) {
      const u = s * G.at;
      const hw = G.width / 2;
      // Postes y travesaño al frente; atrás, el marco que sostiene la red.
      for (const e of [-1, 1]) pk.detail.box(at(u, y + G.height / 2, e * hw), G.bar, G.height, G.bar, color);
      pk.detail.box(at(u, y + G.height - G.bar / 2, 0), G.bar, G.bar, G.width, color);
      for (const e of [-1, 1]) pk.detail.box(at(u + (s * dBottom) / 2, y + G.bar / 2, e * hw), dBottom, G.bar, G.bar, color);
      pk.detail.box(at(u + s * dBottom, y + G.bar / 2, 0), G.bar, G.bar, G.width, color);
      // Red: atrás, arriba y a los costados (calada).
      const back = [P(u + s * dBottom, y, -hw), P(u + s * dBottom, y, hw), P(u + s * dTop, y + G.height, hw), P(u + s * dTop, y + G.height, -hw)];
      pk.rails.quad(back[0], back[1], back[2], back[3], net, netSurface, [0, 0, G.width, 0, G.width, G.height, 0, G.height]);
      const roofNet = [P(u, y + G.height, -hw), P(u, y + G.height, hw), P(u + s * dTop, y + G.height, hw), P(u + s * dTop, y + G.height, -hw)];
      pk.rails.quad(roofNet[0], roofNet[1], roofNet[2], roofNet[3], net, netSurface, [0, 0, G.width, 0, G.width, dTop, 0, dTop]);
      for (const e of [-1, 1]) {
        const side = [P(u, y, e * hw), P(u + s * dBottom, y, e * hw), P(u + s * dTop, y + G.height, e * hw), P(u, y + G.height, e * hw)];
        pk.rails.quad(side[0], side[1], side[2], side[3], net, netSurface, [0, 0, dBottom, 0, dTop, G.height, 0, G.height]);
      }
      for (const e of [-1, 1]) {
        const q = f.point(u, e * hw);
        pk.site.circle(q.x, q.z, G.bar, y + G.height, false, -Infinity);
      }
    }
  }
  const H = S.hoops;
  if (H) {
    const [bw2, bh, bt] = H.board.size;
    for (const s of [-1, 1]) {
      const u = s * H.at;
      const pole = new THREE.Color(H.pole.color);
      const up2 = u + s * H.pole.back;
      pk.detail.box(at(up2, y + H.pole.height / 2, 0), H.pole.size, H.pole.height, H.pole.size, pole);
      // Brazo del poste al tablero, el tablero y el aro (hacia el centro de la cancha).
      pk.detail.box(at((u + up2) / 2, y + H.board.bottom + bh / 2, 0), Math.abs(up2 - u), H.pole.size, H.pole.size, pole);
      pk.detail.box(at(u, y + H.board.bottom + bh / 2, 0), bt, bh, bw2, new THREE.Color(H.board.color));
      const torus = new THREE.TorusGeometry(H.ring.radius, H.ring.tube, pk.thin, pk.sides);
      pk.detail.geometry(torus, at(u - s * (H.ring.reach + H.ring.radius), y + H.ring.height, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), new THREE.Color(H.ring.color));
      torus.dispose();
      const q = f.point(up2, 0);
      pk.site.box(q.x, q.z, H.pole.size / 2, H.pole.size / 2, f.angle, y + H.pole.height, false, -Infinity);
    }
  }
  const N = S.net;
  if (N) {
    const [ps, ph] = N.post;
    for (const e of [-1, 1]) {
      pk.detail.box(at(0, y + ph / 2, e * N.at), ps, ph, ps, new THREE.Color(N.postColor));
      const q = f.point(0, e * N.at);
      pk.site.circle(q.x, q.z, ps, y + ph, false, -Infinity);
    }
    const net = [P(0, y, -N.at), P(0, y, N.at), P(0, y + N.height, N.at), P(0, y + N.height, -N.at)];
    pk.rails.quad(net[0], net[1], net[2], net[3], new THREE.Color(N.color), { pattern: patternOf(N.pattern), scale: N.scale }, [0, 0, 2 * N.at, 0, 2 * N.at, N.height, 0, N.height]);
    pk.detail.box(at(0, y + N.height - N.tape / 2, 0), N.tape / 2, N.tape, 2 * N.at, new THREE.Color(N.tapeColor));
  }
  if (S.fence) for (const run of fenceRuns(c, S.fence, f, S.fence.style)) walls(run);
}

// ---------------------------------------------------------------------------------------------
// Juegos infantiles

/**
 * Un juego infantil: 'swing' (columpio: marco en A de caños, viga y asientos colgados) o 'slide'
 * (resbaladera: plataforma sobre postes con escalera y el tobogán). Medidas y colores de cada parte.
 */
export interface PlayStyle {
  kind: string;
  /** Columpio: alto de la viga, largo, separación de las patas abajo, radio del caño; asientos (cuántos; ancho, fondo y grosor; alto sobre el piso) y cadenas (radio). */
  swing?: { height: number; length: number; spread: number; tube: number; seats: { count: number; size: number[]; height: number }; chain: number };
  /**
   * Resbaladera: plataforma (alto, ancho y fondo, grosor), postes (lado), cuánto sube la baranda
   * sobre la plataforma, tobogán (largo en planta, ancho, alto del borde) y escalera (peldaños,
   * ancho, largo en planta, radio de sus caños y de los peldaños).
   */
  slide?: {
    deck: { height: number; size: number[]; thickness: number };
    post: number;
    rail: number;
    chute: { run: number; width: number; lip: number };
    ladder: { steps: number; width: number; run: number; tube: number; rung: number };
  };
  colors: { frame: string; seat: string; chute: string; deck: string };
}

/** Un juego en su zona: dónde (u, v), giro (grados), estilo y fuente. */
export interface PlayPlace {
  id: string;
  at: number[];
  angle: number;
  style: string;
  source: string;
}

/** Arma un juego infantil (lo chico, solo de cerca) con una física simple (sus patas o su plataforma). */
export function buildPlay(p: PlayPlace, S: PlayStyle, zone: Frame, pk: PartsKit): void {
  const f = Frame.of(p.at, p.angle, zone);
  const m = f.matrix();
  const y = pk.terrain(f.x, f.z);
  const at = (u: number, h: number, v: number): THREE.Matrix4 => m.clone().multiply(new THREE.Matrix4().makeTranslation(u, h, v));
  const P = (u: number, h: number, v: number): THREE.Vector3 => new THREE.Vector3(u, h, v).applyMatrix4(m);
  const frame = new THREE.Color(S.colors.frame);
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, color: THREE.Color): void => {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, pk.thin, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(len));
    pk.detail.geometry(g, new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), color);
    g.dispose();
  };
  if (S.kind === 'swing' && S.swing) {
    const W = S.swing;
    const hl = W.length / 2;
    // Marco en A en cada punta y la viga.
    for (const e of [-1, 1]) {
      const topP = P(e * hl, y + W.height, 0);
      for (const s of [-1, 1]) {
        tube(P(e * hl, y, (s * W.spread) / 2), topP, W.tube, frame);
        const q = f.point(e * hl, (s * W.spread) / 2);
        pk.site.circle(q.x, q.z, W.tube, y + W.height, false, -Infinity);
      }
    }
    tube(P(-hl, y + W.height, 0), P(hl, y + W.height, 0), W.tube, frame);
    const [sw, sd, st] = W.seats.size;
    for (let k = 0; k < W.seats.count; k++) {
      const u = -hl + (W.length * (k + 0.5)) / W.seats.count;
      pk.detail.box(at(u, y + W.seats.height, 0), sw, st, sd, new THREE.Color(S.colors.seat));
      for (const e of [-1, 1]) tube(P(u + (e * sw) / 2, y + W.seats.height, 0), P(u + (e * sw) / 2, y + W.height, 0), W.chain, frame);
    }
    return;
  }
  if (S.kind === 'slide' && S.slide) {
    const D = S.slide;
    const [dw, dd] = D.deck.size;
    const h = D.deck.height;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const u = (su * (dw - D.post)) / 2;
      const v = (sv * (dd - D.post)) / 2;
      pk.detail.box(at(u, y + (h + D.rail) / 2, v), D.post, h + D.rail, D.post, frame);
    }
    pk.detail.box(at(0, y + h - D.deck.thickness / 2, 0), dw, D.deck.thickness, dd, new THREE.Color(S.colors.deck));
    // Tobogán hacia +u, escalera hacia −u.
    const chute = new THREE.Color(S.colors.chute);
    const cw = D.chute.width / 2;
    const bed = [P(dw / 2, y + h, -cw), P(dw / 2 + D.chute.run, y + D.deck.thickness, -cw), P(dw / 2 + D.chute.run, y + D.deck.thickness, cw), P(dw / 2, y + h, cw)];
    toward(pk, 'detail', UP, bed, chute);
    for (const e of [-1, 1]) {
      const lip = [P(dw / 2, y + h, e * cw), P(dw / 2 + D.chute.run, y + D.deck.thickness, e * cw), P(dw / 2 + D.chute.run, y + D.deck.thickness + D.chute.lip, e * cw), P(dw / 2, y + h + D.chute.lip, e * cw)];
      toward(pk, 'detail', new THREE.Vector3(0, 0, -e).transformDirection(m), lip, chute);
    }
    const Ld = D.ladder;
    const lw = Ld.width / 2;
    for (const e of [-1, 1]) tube(P(-dw / 2, y + h + D.rail, e * lw), P(-dw / 2 - Ld.run, y, e * lw), Ld.tube, frame);
    for (let k = 1; k <= Ld.steps; k++) {
      const t = k / (Ld.steps + 1);
      tube(P(-dw / 2 - Ld.run * (1 - t), y + h * t, -lw), P(-dw / 2 - Ld.run * (1 - t), y + h * t, lw), Ld.rung, frame);
    }
    pk.site.box(f.x, f.z, dw / 2, dd / 2, f.angle, y + h, true, -Infinity);
  }
}
