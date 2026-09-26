import * as THREE from 'three';
import { deepMerge } from './downtown';
import { Batch, type Surface } from './monumentParts';
import { type Ctx, type Outline, type Piece, boxAt, cut, hquad, insidePoly, polyBoxes, rand, seedOf, surf, tri, vquad } from './mallParts';
import { pave } from './street';
import { type Retiro, type RetiroStyle, buildRetiro, checkRetiro } from './streetLots';

/*
 * Los parqueaderos de un centro comercial (tipo `mall`, world/mall.ts): los parqueos en altura
 * (losas por nivel, columnas en grilla, rampas, líneas de los puestos y autos quietos en los
 * pisos altos) y los parqueaderos a nivel, cuyas hileras son retiros de world/streetLots.ts
 * (puestos, topes, autos de la ciudad, palmeras y borde). Todo en el marco local del lugar; nada
 * de medidas aquí: todo sale de config/sites/<mall>.json.
 */

type V2 = THREE.Vector2;
const v2 = (x: number, z: number): V2 => new THREE.Vector2(x, z);
const UP = new THREE.Vector3(0, 1, 0);
const EPS = 1e-4;

/**
 * Una hilera de puestos a 90° dentro de un parqueo en altura: la línea de las colas de los autos
 * (de `a` a `b`, marco local), hacia qué lado van los puestos (1: a la derecha de a→b, −1: a la
 * izquierda), su fondo, en qué niveles está (0 = la planta baja, k = la losa k de `levels`) y qué
 * parte de sus puestos está ocupada (una azotea casi vacía, un piso lleno).
 */
export interface MallDeckRow {
  a: number[];
  b: number[];
  side: number;
  depth: number;
  levels: number[];
  cars: number;
}

/**
 * Una rampa entre niveles: de `a` a `b` (el eje, marco local), su ancho, a qué alto arranca y a qué
 * alto llega (m sobre el suelo del volumen) y su piel. Para la física es una escalera de tramos
 * que suben a lo sumo `MallDeck.climb` m cada uno (se camina). La losa a la que llega se abre sobre
 * toda su planta: las rampas de varios niveles apiladas en la misma planta tienen que subir en el
 * mismo sentido (una encima de la otra, a un nivel de distancia); en sentidos contrarios se
 * cruzarían.
 */
export interface MallRamp {
  a: number[];
  b: number[];
  width: number;
  y: number[];
  skin: string;
}

/**
 * Los autos quietos de los pisos altos (ParkedCars solo sabe del suelo: estos van instanciados
 * aquí, cada uno con su caja de física desde el piso de su nivel). El modelo:
 * carrocería [largo, ancho, alto], cabina [largo, alto, cuánto se corre hacia atrás, cuánto más
 * angosta que la carrocería a cada lado], ruedas [radio, ancho, a cuánto de cada punta va el eje]
 * y a qué alto va la carrocería sobre el piso; los colores de la pintura (uno por auto, al azar),
 * del vidrio y de las llantas.
 */
export interface MallCars {
  size: number[];
  cabin: number[];
  wheel: number[];
  clearance: number;
  colors: string[];
  glass: string;
  tire: string;
}

/**
 * Un parqueo en altura (MallVolume.deck): la cáscara del volumen es su fachada (con la piel
 * 'open' donde no hay muro y vanos pasantes sin piel); aquí va lo de adentro. `levels`: el alto
 * de cada losa sobre el suelo (m, de abajo arriba; la última es la azotea). `slab`: grosor de las
 * losas. `guard`: antepecho de cada nivel para la física (alto y grosor; el grosor también es el
 * del muro de la fachada visto desde adentro). `climb`: lo más que sube cada tramo de una rampa
 * (se camina). Columnas en una grilla [a lo largo, a lo ancho] (m) alineada con el lado más largo,
 * de ancho `size`, redondas o no, a no menos de `margin` m de la fachada. Puestos: ancho, grosor,
 * color y alto de las líneas pintadas (`lift`, m sobre la losa o el piso: al menos 1 cm, o
 * titilan con él; pitfalls.md → caras en el mismo plano). `entrances`: tramos de la planta baja
 * por donde se entra ([lado, desde, hasta] en m a lo largo del lado). El canto de cada losa no se
 * dibuja donde la fachada ya pone muro en ese plano (quedarían en el mismo plano).
 */
export interface MallDeck {
  levels: number[];
  slab: number;
  guard: number[];
  climb: number;
  skins: { floor: string; soffit: string; edge: string; column: string };
  columns: { grid: number[]; size: number; round: boolean; margin: number };
  stalls: { width: number; line: number; color: string; lift: number };
  rows: MallDeckRow[];
  ramps: MallRamp[];
  entrances: number[][];
  cars: MallCars;
}

/**
 * Un parqueadero a nivel: su piso (contorno, piel y cuánto queda sobre el terreno, menos que el
 * de sus hileras) y las hileras de puestos a 90°, cada una un retiro de world/streetLots.ts: la
 * línea del pasillo de `a` a `b`, hacia qué lado van los puestos (1: a la derecha de a→b), el
 * estilo de `retiros` y sus retoques.
 */
export interface MallLot {
  id: string;
  ring: number[][];
  skin: string;
  lift: number;
  rows: { a: number[]; b: number[]; side: number; style: string; set?: Record<string, unknown> }[];
  source: string;
}

/** Falla al cargar si un parqueo en altura trae algo que no cierra. */
export function checkDeck(d: MallDeck, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`Parqueo ${where}: ${what}`);
  };
  if (!d.levels.length) bad('levels está vacío');
  d.levels.forEach((y, k) => {
    if (y <= (k ? d.levels[k - 1] : 0)) bad('levels tiene que ir de abajo arriba y sobre el suelo');
  });
  if (d.slab <= 0) bad('slab tiene que ser mayor que 0');
  if (d.climb <= 0) bad('climb tiene que ser mayor que 0');
  if (d.columns.grid.some((g) => g <= 0)) bad('columns.grid tiene que ser mayor que 0');
  if (d.stalls.width <= 0) bad('stalls.width tiene que ser mayor que 0');
  if (!(d.stalls.lift > 0)) bad('stalls.lift (alto de las líneas sobre la losa) tiene que ser mayor que 0');
  if (d.cars.size.length !== 3 || d.cars.cabin.length !== 4 || d.cars.wheel.length !== 3) bad('cars: size [largo, ancho, alto], cabin [largo, alto, atrás, angostura] y wheel [radio, ancho, eje]');
  for (const r of d.rows) if (r.levels.some((l) => l < 0 || l > d.levels.length)) bad(`una hilera pide un nivel que no existe (${r.levels})`);
  // Rampas apiladas en la misma planta: en el mismo sentido (en sentidos contrarios se cruzan).
  const box = (r: MallRamp): number[] => {
    const q = rampPlan(r);
    return [Math.min(...q.map((p) => p.x)), Math.max(...q.map((p) => p.x)), Math.min(...q.map((p) => p.y)), Math.max(...q.map((p) => p.y))];
  };
  d.ramps.forEach((r, k) => {
    if (!(r.width > 0) || !(r.y[1] > r.y[0]) || Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) < EPS) bad(`la rampa ${k} necesita ancho, largo y subir de y[0] a y[1]`);
    const [x0, x1, z0, z1] = box(r);
    d.ramps.slice(k + 1).forEach((s, j) => {
      const [u0, u1, w0, w1] = box(s);
      const overlap = x0 < u1 - EPS && u0 < x1 - EPS && z0 < w1 - EPS && w0 < z1 - EPS;
      const same = (r.b[0] - r.a[0]) * (s.b[0] - s.a[0]) + (r.b[1] - r.a[1]) * (s.b[1] - s.a[1]) > 0;
      if (overlap && !same) bad(`las rampas ${k} y ${k + j + 1} se pisan en planta y suben en sentidos contrarios`);
    });
  });
  if (d.cars.colors.length < 1) bad('cars.colors está vacío');
}

/** Falla al cargar si un parqueadero a nivel trae algo que no cierra. */
export function checkLot(l: MallLot, retiros: Record<string, RetiroStyle> | undefined, where: string): void {
  for (const r of l.rows) {
    const preset = retiros?.[r.style];
    if (!preset) throw new Error(`Parqueadero ${where}: el estilo de retiro "${r.style}" no está en retiros`);
    const style = deepMerge(preset, r.set);
    checkRetiro(style, `${l.id} (${where})`);
    if (style.height <= l.lift) throw new Error(`Parqueadero ${where}: el piso de las hileras (${style.height}) tiene que quedar sobre el del lote (${l.lift})`);
  }
}

/** El auto quieto (para instanciar; trompa hacia +x, pie en el origen): solo la carrocería se pinta con el color de cada auto. */
function carModel(c: MallCars, sides: number): THREE.BufferGeometry {
  const b = new Batch();
  const [L, W, H] = c.size;
  const [cl, ch, back, narrow] = c.cabin;
  const [r, w, axle] = c.wheel;
  const glass = new THREE.Color(c.glass);
  const tire = new THREE.Color(c.tire);
  b.box(new THREE.Matrix4().makeTranslation(0, c.clearance + H / 2, 0), L, H, W, new THREE.Color(1, 1, 1), { paint: 1 });
  b.box(new THREE.Matrix4().makeTranslation(-back, c.clearance + H + ch / 2, 0), cl, ch, W - 2 * narrow, glass);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(r, r, w, sides);
      b.geometry(g, new THREE.Matrix4().makeTranslation(sx * (L / 2 - axle), r, (sz * (W - w)) / 2).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)), tire);
      g.dispose();
    }
  }
  return b.build();
}

/** La planta de una rampa: el rectángulo de su ancho a lo largo del eje a→b. */
function rampPlan(r: MallRamp): V2[] {
  const a = v2(r.a[0], r.a[1]);
  const b = v2(r.b[0], r.b[1]);
  const t = b.clone().sub(a).normalize();
  const n = v2(-t.y, t.x).multiplyScalar(r.width / 2);
  return [a.clone().sub(n), b.clone().sub(n), b.clone().add(n), a.clone().add(n)];
}

/**
 * Lo de adentro de un parqueo en altura (el volumen `id` con planta `o` y suelo `ground`): las
 * losas de cada nivel, el piso de la planta baja, las columnas, las rampas, las líneas de los
 * puestos, los autos (los de la planta baja van a los de la ciudad; los de arriba, quietos e
 * instanciados) y su física: cada losa se pisa y se pasa por debajo, el antepecho de cada nivel
 * ataja y la planta baja se cierra salvo en sus entradas.
 */
export function buildDeck(id: string, d: MallDeck, o: Outline, ground: number, piece: Piece, root: THREE.Group, ctx: Ctx): void {
  const S = ctx.skins;
  const floor = S.look(d.skins.floor);
  const soffit = S.look(d.skins.soffit);
  const edge = S.look(d.skins.edge);
  const column = S.look(d.skins.column);
  const pts = o.pts;
  const P = (q: V2, y: number): THREE.Vector3 => new THREE.Vector3(q.x, y, q.y);
  const top = d.levels[d.levels.length - 1];
  const [guardH, thick] = d.guard;
  const strip = ctx.ground.step;
  // Losas: piso, cielo raso y canto; su física (se pisa y se pasa por debajo) y el antepecho. La
  // losa a la que llega una rampa se abre sobre ella (si no, quien sube se da con la cabeza).
  for (const level of d.levels) {
    const y1 = ground + level;
    const y0 = y1 - d.slab;
    const holes = d.ramps.filter((r) => r.y[0] < level - EPS && r.y[1] > level - EPS).map(rampPlan);
    const all = [...pts, ...holes.flat()];
    const fb = piece.bins.of(floor);
    const sb = piece.bins.of(soffit);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, holes)) {
      const uv = [all[i].x, all[i].y, all[j].x, all[j].y, all[k].x, all[k].y];
      tri(fb, P(all[i], y1), P(all[j], y1), P(all[k], y1), UP, floor.color, surf(floor, false), uv);
      tri(sb, P(all[i], y0), P(all[j], y0), P(all[k], y0), UP.clone().negate(), soffit.color, surf(soffit, soffit.lit > 0), uv);
    }
    // El canto, donde la fachada no pone muro en su mismo plano (si no, titilarían).
    for (const g of o.segs) {
      for (const r of cut({ u0: 0, u1: g.len, y0, y1 }, piece.walls.get(g) ?? [])) {
        vquad(piece.bins.of(edge), g.a.clone().addScaledVector(g.t, r.u0), g.a.clone().addScaledVector(g.t, r.u1), r.y0, r.y1, g.n, edge.color, surf(edge, false), g.su + r.u0, g.su + r.u1);
      }
    }
    // El canto del vano, mirando hacia adentro del vano.
    for (const h of holes) {
      const mid = h.reduce((s, q) => s.add(q), v2(0, 0)).divideScalar(h.length);
      h.forEach((q, k) => {
        const r = h[(k + 1) % h.length];
        const m = q.clone().add(r).multiplyScalar(0.5);
        vquad(piece.bins.of(edge), q, r, y0, y1, mid.clone().sub(m), edge.color, surf(edge, false), 0, q.distanceTo(r));
      });
    }
    for (const bx of polyBoxes(pts, strip, holes)) piece.site.box(bx.x, bx.z, bx.halfU, bx.halfV, bx.angle, y1, true, y0);
    for (const g of o.segs) {
      const c = g.a.clone().add(g.b).multiplyScalar(0.5).addScaledVector(g.n, -thick / 2);
      piece.site.box(c.x, c.y, g.len / 2, thick / 2, Math.atan2(g.t.y, g.t.x), y1 + guardH, false, y0);
    }
  }
  // Planta baja: el piso que sigue el terreno y los muros cerrados salvo en las entradas.
  pave(piece.bins.of(floor), pts.map((q) => [q.x, q.y]), (x, z) => ctx.kit.terrain(x, z) + ctx.ground.lift, ctx.ground.step, floor.color, surf(floor, false));
  piece.site.ground(pts.map((q) => new THREE.Vector3(q.x, 0, q.y)), ctx.ground.lift);
  const below = ground + d.levels[0] - d.slab;
  for (const g of o.segs) {
    const gaps = d.entrances.filter((e) => e[0] === g.side).map((e) => [e[1] - g.su, e[2] - g.su]);
    let runs = [[0, g.len]];
    for (const [a, b] of gaps) {
      runs = runs.flatMap(([r0, r1]) =>
        b <= r0 || a >= r1
          ? [[r0, r1]]
          : [
              [r0, Math.max(r0, a)],
              [Math.min(r1, b), r1],
            ].filter(([p, q]) => q - p > EPS),
      );
    }
    for (const [a, b] of runs) {
      const c = g.a.clone().addScaledVector(g.t, (a + b) / 2).addScaledVector(g.n, -thick / 2);
      piece.site.box(c.x, c.y, (b - a) / 2, thick / 2, Math.atan2(g.t.y, g.t.x), below, false, -Infinity);
    }
  }
  // Columnas en grilla, alineada con el lado más largo.
  let axis = v2(1, 0);
  let longest = 0;
  for (const g of o.segs) {
    if (g.len > longest) {
      longest = g.len;
      axis = g.t.clone();
    }
  }
  const across = v2(-axis.y, axis.x);
  const C = d.columns;
  const [gu, gv] = C.grid;
  let u0 = Infinity;
  let u1 = -Infinity;
  let w0 = Infinity;
  let w1 = -Infinity;
  for (const q of pts) {
    u0 = Math.min(u0, q.dot(axis));
    u1 = Math.max(u1, q.dot(axis));
    w0 = Math.min(w0, q.dot(across));
    w1 = Math.max(w1, q.dot(across));
  }
  const cb = piece.bins.of(column);
  const colTop = ground + top - d.slab;
  const nu = Math.max(1, Math.round((u1 - u0 - 2 * C.margin) / gu));
  const nv = Math.max(1, Math.round((w1 - w0 - 2 * C.margin) / gv));
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const q = axis
        .clone()
        .multiplyScalar(u0 + C.margin + ((u1 - u0 - 2 * C.margin) * i) / nu)
        .addScaledVector(across, w0 + C.margin + ((w1 - w0 - 2 * C.margin) * j) / nv);
      const ok = [v2(0, 0), axis, across, axis.clone().negate(), across.clone().negate()].every((dd) => insidePoly(pts, q.x + dd.x * C.margin, q.y + dd.y * C.margin));
      if (!ok) continue;
      const foot = ctx.kit.terrain(q.x, q.y) - ctx.ground.bury;
      const h = colTop - foot;
      if (C.round) {
        const g = new THREE.CylinderGeometry(C.size / 2, C.size / 2, h, ctx.detail.sides, 1, true);
        cb.geometry(g, new THREE.Matrix4().makeTranslation(q.x, foot + h / 2, q.y), column.color, surf(column, false));
        g.dispose();
        piece.site.circle(q.x, q.y, C.size / 2, colTop, false, -Infinity);
      } else {
        boxAt(cb, q, axis, foot + h / 2, C.size, h, C.size, column.color, surf(column, false));
        piece.site.box(q.x, q.y, C.size / 2, C.size / 2, Math.atan2(axis.y, axis.x), colTop, false, -Infinity);
      }
    }
  }
  // Rampas: la losa inclinada (piso, cielo raso y cantos) y, para caminarla, tramos que suben de a poco.
  for (const r of d.ramps) {
    const a = v2(r.a[0], r.a[1]);
    const b = v2(r.b[0], r.b[1]);
    const len = a.distanceTo(b);
    const t = b.clone().sub(a).divideScalar(len);
    const n = v2(-t.y, t.x);
    const hw = r.width / 2;
    const [ya, yb] = [ground + r.y[0], ground + r.y[1]];
    const rl = S.look(r.skin);
    const rb = piece.bins.of(rl);
    const run = Math.hypot(len, yb - ya);
    const corner = (q: V2, s: number): V2 => q.clone().addScaledVector(n, s * hw);
    hquad(rb, P(corner(a, -1), ya), P(corner(b, -1), yb), P(corner(b, 1), yb), P(corner(a, 1), ya), true, rl.color, surf(rl, false), [-hw, 0, -hw, run, hw, run, hw, 0]);
    hquad(piece.bins.of(soffit), P(corner(a, -1), ya - d.slab), P(corner(b, -1), yb - d.slab), P(corner(b, 1), yb - d.slab), P(corner(a, 1), ya - d.slab), false, soffit.color, surf(soffit, false));
    for (const s of [-1, 1]) {
      const A = corner(a, s);
      const B = corner(b, s);
      const eb = piece.bins.of(edge);
      const facing = n.clone().multiplyScalar(s);
      const quad = [P(A, ya - d.slab), P(B, yb - d.slab), P(B, yb), P(A, ya)];
      const nn = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[3], quad[0]));
      if (nn.x * facing.x + nn.z * facing.y >= 0) eb.quad(quad[0], quad[1], quad[2], quad[3], edge.color, surf(edge, false));
      else eb.quad(quad[1], quad[0], quad[3], quad[2], edge.color, surf(edge, false));
    }
    const steps = Math.max(1, Math.ceil(Math.abs(yb - ya) / d.climb));
    for (let k = 0; k < steps; k++) {
      const c = a.clone().addScaledVector(t, ((k + 0.5) * len) / steps);
      const y = ya + ((yb - ya) * (k + 1)) / steps;
      piece.site.box(c.x, c.y, len / steps / 2, hw, Math.atan2(t.y, t.x), y, true, y - d.slab);
    }
  }
  // Líneas de los puestos y autos.
  const seed = seedOf(id);
  const lineColor = new THREE.Color(d.stalls.color);
  const lb = piece.bins.get('stone', true);
  const upper: { x: number; z: number; y: number; angle: number; k: number }[] = [];
  let serial = 0;
  for (const row of d.rows) {
    const a = v2(row.a[0], row.a[1]);
    const b = v2(row.b[0], row.b[1]);
    const len = a.distanceTo(b);
    const t = b.clone().sub(a).divideScalar(len);
    const n = v2(-t.y, t.x).multiplyScalar(Math.sign(row.side) || 1);
    const count = Math.floor(len / d.stalls.width);
    const start = (len - count * d.stalls.width) / 2;
    const angle = Math.atan2(n.y, n.x);
    for (const level of row.levels) {
      const y = level === 0 ? null : ground + d.levels[level - 1];
      const lift = ctx.ground.lift;
      for (let j = 0; j <= count; j++) {
        const u = start + j * d.stalls.width;
        const p0 = a.clone().addScaledVector(t, u - d.stalls.line / 2);
        const p1 = a.clone().addScaledVector(t, u + d.stalls.line / 2);
        const yy = (q: V2): number => (y ?? ctx.kit.terrain(q.x, q.y) + lift) + d.stalls.lift;
        const q0 = p0.clone().addScaledVector(n, row.depth);
        const q1 = p1.clone().addScaledVector(n, row.depth);
        hquad(lb, P(p0, yy(p0)), P(p1, yy(p1)), P(q1, yy(q1)), P(q0, yy(q0)), true, lineColor, {});
      }
      for (let j = 0; j < count; j++) {
        if (rand(seed + serial++, 3) >= row.cars) continue;
        const c = a.clone().addScaledVector(t, start + (j + 0.5) * d.stalls.width).addScaledVector(n, row.depth / 2);
        if (y === null) ctx.kit.car(c.x, c.y, angle, lift);
        else upper.push({ x: c.x, z: c.y, y, angle, k: serial });
      }
    }
  }
  if (upper.length) {
    const mesh = new THREE.InstancedMesh(carModel(d.cars, ctx.detail.small), ctx.kit.materials.paint, upper.length);
    const colors = d.cars.colors.map((c) => new THREE.Color(c));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    // La caja de cada auto, del piso de su nivel al techo de la cabina (el de abajo pasa libre).
    const [L, W, H] = d.cars.size;
    const roofOf = d.cars.clearance + H + d.cars.cabin[1];
    upper.forEach((c, k) => {
      mesh.setMatrixAt(k, m.compose(new THREE.Vector3(c.x, c.y, c.z), q.setFromAxisAngle(UP, -c.angle), one));
      mesh.setColorAt(k, colors[Math.floor(rand(seed + c.k, 11) * colors.length) % colors.length]);
      piece.site.box(c.x, c.z, L / 2, W / 2, c.angle, c.y + roofOf, false, c.y);
    });
    mesh.computeBoundingSphere();
    mesh.name = `${id}-cars`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
    piece.site.near(mesh, ctx.detail.near);
  }
}

/**
 * Un parqueadero a nivel: el piso del lote y cada hilera como un retiro (world/streetLots.ts), con
 * sus puestos, topes, autos (los de la ciudad), borde y palmeras. `rails`: el búfer del calado
 * (rejas del borde).
 */
export function buildLot(l: MallLot, retiros: Record<string, RetiroStyle>, rails: Batch, piece: Piece, ctx: Ctx): void {
  const look = ctx.skins.look(l.skin);
  const surface: Surface = surf(look, false);
  pave(piece.bins.of(look), l.ring, (x, z) => ctx.kit.terrain(x, z) + l.lift, ctx.ground.step, look.color, surface);
  piece.site.ground(
    l.ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    l.lift,
  );
  const lots = ctx.kit.lotKit(piece.site, { stone: piece.bins.get('stone'), detail: piece.bins.get('stone', true), rails }, { step: ctx.ground.step, wall: ctx.ground.wall });
  l.rows.forEach((row, k) => {
    const style = deepMerge(retiros[row.style], row.set);
    const a = v2(row.a[0], row.a[1]);
    const b = v2(row.b[0], row.b[1]);
    const t = b.clone().sub(a).normalize();
    const n = v2(-t.y, t.x).multiplyScalar(Math.sign(row.side) || 1);
    const depth = style.stalls.depth;
    const ring = [a, b, b.clone().addScaledVector(n, depth), a.clone().addScaledVector(n, depth)].map((q) => [q.x, q.y]);
    // El borde va de x menor a mayor (así lo mide streetLots.ts).
    const along = a.x <= b.x ? [row.a, row.b] : [row.b, row.a];
    const r: Retiro = { id: `${l.id}-${k}`, style: row.style, ring, along, depth };
    buildRetiro(r, style, lots);
  });
}
