import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Piezas de arquitectura clásica y ecléctica para armar edificios icónicos (el Palacio Municipal y
 * los que vengan: la Gobernación, la Biblioteca, Correos…): molduras que siguen cualquier
 * recorrido, muros con arcos y vanos, columnas corintias, balaustres, jarrones, cóndores, ménsulas,
 * frontones y cúpulas. Todo en metros, en el marco local del edificio (y hacia arriba), sin
 * colores: eso lo pone quien las arma (ver world/monumentParts.ts → Parts).
 */

const TAU = Math.PI * 2;

/**
 * Perfil de una moldura: puntos (a, b) de su borde, de abajo-atrás a arriba-atrás; `a` es lo que
 * sale hacia afuera y `b` lo que sube (ver `sweep`).
 */
export type Profile = readonly (readonly number[])[];

export interface SweepOptions {
  /** El recorrido vuelve al primer punto. */
  closed?: boolean;
  /** Tapas en los extremos (por defecto, si no es cerrado). */
  caps?: boolean;
  /** Quiebres más suaves que este ángulo se sombrean redondeados (arcos). */
  smoothDeg?: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Empuja un triángulo con sus normales, girándolo si quedó mirando al revés. */
function triangle(pos: number[], nor: number[], p: THREE.Vector3[], n: THREE.Vector3[]): void {
  _a.subVectors(p[1], p[0]);
  _b.subVectors(p[2], p[0]);
  _c.crossVectors(_a, _b);
  _n.copy(n[0]).add(n[1]).add(n[2]);
  const order = _c.dot(_n) < 0 ? [0, 2, 1] : [0, 1, 2];
  for (const k of order) {
    pos.push(p[k].x, p[k].y, p[k].z);
    nor.push(n[k].x, n[k].y, n[k].z);
  }
}

function geometryOf(pos: number[], nor: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * Moldura: el perfil barrido a lo largo de un recorrido. En cada tramo, `a` va hacia
 * `axis × tramo` y `b` a lo largo de `axis`: con axis = arriba y un recorrido en planta que deja
 * el afuera a su derecha (mirado desde arriba con z hacia abajo, en sentido horario), `a` sale
 * del muro y `b` sube. En los quiebres el perfil se corta a inglete.
 */
export function sweep(points: readonly THREE.Vector3[], axis: THREE.Vector3, profile: Profile, opts: SweepOptions = {}): THREE.BufferGeometry {
  const closed = opts.closed ?? false;
  const caps = opts.caps ?? !closed;
  const smooth = Math.cos(THREE.MathUtils.degToRad(opts.smoothDeg ?? 35));
  const n = points.length;
  const segs = closed ? n : n - 1;
  const side: THREE.Vector3[] = [];
  for (let s = 0; s < segs; s++) {
    const t = new THREE.Vector3().subVectors(points[(s + 1) % n], points[s]).normalize();
    side.push(new THREE.Vector3().crossVectors(axis, t).normalize());
  }
  const miter: THREE.Vector3[] = [];
  const rounded: boolean[] = [];
  const mean: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const vin = closed || i > 0 ? side[(i - 1 + segs) % segs] : null;
    const vout = closed || i < n - 1 ? side[i % segs] : null;
    if (vin && vout) {
      const m = new THREE.Vector3().addVectors(vin, vout);
      if (m.lengthSq() < 1e-8) {
        miter.push(vout.clone());
        rounded.push(false);
        mean.push(vout.clone());
        continue;
      }
      m.normalize();
      miter.push(m.clone().divideScalar(Math.max(m.dot(vin), 0.25)));
      rounded.push(vin.dot(vout) >= smooth);
      mean.push(m);
    } else {
      const v = (vin ?? vout) as THREE.Vector3;
      miter.push(v.clone());
      rounded.push(true);
      mean.push(v.clone());
    }
  }
  // Normales del perfil (2D) en cada extremo de cada lado: redondeadas donde el quiebre es suave.
  const P = profile.length;
  const edge: THREE.Vector2[] = [];
  for (let e = 0; e < P - 1; e++) {
    const da = profile[e + 1][0] - profile[e][0];
    const db = profile[e + 1][1] - profile[e][1];
    edge.push(new THREE.Vector2(db, -da).normalize());
  }
  const profileNormal = (e: number, k: number): THREE.Vector2 => {
    const other = k === e ? e - 1 : e + 1;
    if (other < 0 || other >= edge.length || edge[e].dot(edge[other]) < smooth) return edge[e];
    return edge[e].clone().add(edge[other]).normalize();
  };
  const at = (i: number, k: number): THREE.Vector3 =>
    points[i].clone().addScaledVector(miter[i], profile[k][0]).addScaledVector(axis, profile[k][1]);
  const normalAt = (i: number, s: number, n2: THREE.Vector2): THREE.Vector3 =>
    (rounded[i] ? mean[i] : side[s]).clone().multiplyScalar(n2.x).addScaledVector(axis, n2.y).normalize();

  const pos: number[] = [];
  const nor: number[] = [];
  for (let s = 0; s < segs; s++) {
    const i0 = s;
    const i1 = (s + 1) % n;
    for (let e = 0; e < P - 1; e++) {
      const n0 = profileNormal(e, e);
      const n1 = profileNormal(e, e + 1);
      const p = [at(i0, e), at(i1, e), at(i1, e + 1), at(i0, e + 1)];
      const nn = [normalAt(i0, s, n0), normalAt(i1, s, n0), normalAt(i1, s, n1), normalAt(i0, s, n1)];
      triangle(pos, nor, [p[0], p[1], p[2]], [nn[0], nn[1], nn[2]]);
      triangle(pos, nor, [p[0], p[2], p[3]], [nn[0], nn[2], nn[3]]);
    }
  }
  if (caps && !closed) {
    const contour = profile.map(([a, b]) => new THREE.Vector2(a, b));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [i, dir] of [
      [0, new THREE.Vector3().subVectors(points[0], points[1]).normalize()],
      [n - 1, new THREE.Vector3().subVectors(points[n - 1], points[n - 2]).normalize()],
    ] as const) {
      for (const [a, b, c] of tris) triangle(pos, nor, [at(i, a), at(i, b), at(i, c)], [dir, dir, dir]);
    }
  }
  return geometryOf(pos, nor);
}

/** Puntos de un arco en planta (x, z) a la altura y, de a0 a a1 (radianes, atan2(z, x)). */
export function arc(cx: number, cz: number, r: number, a0: number, a1: number, segments: number, y = 0): THREE.Vector3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / segments;
    return new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
  });
}

/** Perfil de torno (radio, altura) con puntos repartidos por largo de arco (las uv miden parejo). */
export function lathe(points: readonly (readonly number[])[], sides: number, phiStart = 0, phiLength = TAU): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y)),
    sides,
    phiStart,
    phiLength,
  );
}

/** Largo de un perfil de torno (para medir las uv en metros). */
export function profileLength(points: readonly (readonly number[])[]): number {
  let length = 0;
  for (let k = 1; k < points.length; k++) length += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
  return length;
}

/**
 * Un arco de medio punto de luz `span` que arranca a la altura `impost` (hueco, en el plano x-y);
 * `flat` = vano recto (una puerta) que llega hasta `impost`.
 */
export interface Arch {
  center: number;
  span: number;
  impost: number;
  flat?: boolean;
}

/**
 * Muro en el plano x-y (de x0 a x1, de bottom a top), con la cara de afuera en z = 0 y el grosor
 * hacia −z: arcos de medio punto y puertas abiertos desde abajo (una arcada, locales) y huecos
 * cerrados (ventanas).
 */
export function wall(x0: number, x1: number, bottom: number, top: number, depth: number, arches: readonly Arch[], holes: readonly THREE.Path[], curve: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(x0, bottom);
  for (const a of [...arches].sort((p, q) => p.center - q.center)) {
    const r = a.span / 2;
    shape.lineTo(a.center - r, bottom);
    shape.lineTo(a.center - r, a.impost);
    if (a.flat) shape.lineTo(a.center + r, a.impost);
    else shape.absarc(a.center, a.impost, r, Math.PI, 0, true);
    shape.lineTo(a.center + r, bottom);
  }
  shape.lineTo(x1, bottom);
  shape.lineTo(x1, top);
  shape.lineTo(x0, top);
  shape.closePath();
  shape.holes.push(...holes);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: curve });
  g.translate(0, 0, -depth);
  return g;
}

/** Hueco rectangular (para `wall`). */
export function rectHole(x0: number, y0: number, x1: number, y1: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(x0, y0);
  p.lineTo(x1, y0);
  p.lineTo(x1, y1);
  p.lineTo(x0, y1);
  p.closePath();
  return p;
}

/** Hueco con remate de medio punto (ventana en arco, lucarna). */
export function archHole(cx: number, y0: number, width: number, impost: number): THREE.Path {
  const p = new THREE.Path();
  const r = width / 2;
  p.moveTo(cx - r, y0);
  p.lineTo(cx + r, y0);
  p.lineTo(cx + r, impost);
  p.absarc(cx, impost, r, 0, Math.PI, false);
  p.closePath();
  return p;
}

/**
 * Hueco de arco apuntado (una lanceta gótica): recto hasta `impost` y arriba dos arcos de radio
 * `width`·`sharp` (0,5 = medio punto, 1 = arco equilátero) que se juntan en la punta.
 */
export function pointedHole(cx: number, y0: number, width: number, impost: number, sharp: number): THREE.Path {
  const p = new THREE.Path();
  const h = width / 2;
  const r = Math.max(width * sharp, h);
  const rise = Math.sqrt(r * r - (r - h) * (r - h));
  const a = Math.atan2(rise, r - h);
  p.moveTo(cx - h, y0);
  p.lineTo(cx + h, y0);
  p.lineTo(cx + h, impost);
  p.absarc(cx + h - r, impost, r, 0, a, false);
  p.absarc(cx - h + r, impost, r, Math.PI - a, Math.PI, false);
  p.closePath();
  return p;
}

/**
 * Recorrido del borde de un arco (medio punto con `sharp` 0,5, apuntado con más) en el plano x-y:
 * sube por la jamba izquierda desde `y0`, pasa por la clave y baja por la derecha. Con eje +z en
 * `sweep`, la moldura queda alrededor del vano (un arquivolto, un guardapolvo).
 */
export function archPath(cx: number, y0: number, width: number, impost: number, sharp: number, segments: number): THREE.Vector3[] {
  const h = width / 2;
  const r = Math.max(width * sharp, h);
  const rise = Math.sqrt(r * r - (r - h) * (r - h));
  const a = Math.atan2(rise, r - h);
  const out: THREE.Vector3[] = [];
  if (y0 < impost) out.push(new THREE.Vector3(cx - h, y0, 0));
  // Arco izquierdo (centro a la derecha de su arranque) de π a π − a; el derecho, de a a 0.
  for (let k = 0; k <= segments; k++) {
    const t = Math.PI - a * (k / segments);
    out.push(new THREE.Vector3(cx - h + r + Math.cos(t) * r, impost + Math.sin(t) * r, 0));
  }
  for (let k = 1; k <= segments; k++) {
    const t = a - a * (k / segments);
    out.push(new THREE.Vector3(cx + h - r + Math.cos(t) * r, impost + Math.sin(t) * r, 0));
  }
  if (y0 < impost) out.push(new THREE.Vector3(cx + h, y0, 0));
  return out;
}

/** Hueco redondo (óculo). */
export function roundHole(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, TAU, false);
  return p;
}

/** Losa en planta: el polígono (x, z) entre las alturas y0 e y1, con huecos. */
export function slab(outline: readonly THREE.Vector3[], y0: number, y1: number, holes: readonly (readonly THREE.Vector3[])[] = []): THREE.BufferGeometry {
  // En el plano de la forma y = −z; al girar −90° en x, la extrusión queda hacia arriba.
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, -p.z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/**
 * Corta los triángulos de una pieza en rebanadas de `step` a lo largo de x (solo donde hace falta
 * para curvarla: los cortes verticales no agregan nada), interpolando la normal.
 */
function sliceX(geometry: THREE.BufferGeometry, step: number): THREE.BufferGeometry {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = src.getAttribute('position');
  const nm = src.getAttribute('normal');
  const pos: number[] = [];
  const nor: number[] = [];
  type V = number[];
  const lerp = (a: V, b: V, t: number): V => a.map((v, i) => v + (b[i] - v) * t);
  // Recorta un polígono (x, y, z, nx, ny, nz) al semiespacio sign·(x − x0) ≥ 0.
  const clip = (poly: V[], x0: number, sign: number): V[] => {
    const out: V[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = sign * (a[0] - x0);
      const db = sign * (b[0] - x0);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(lerp(a, b, da / (da - db)));
    }
    return out;
  };
  for (let t = 0; t < p.count; t += 3) {
    const tri: V[] = [0, 1, 2].map((k) => [p.getX(t + k), p.getY(t + k), p.getZ(t + k), nm.getX(t + k), nm.getY(t + k), nm.getZ(t + k)]);
    const xs = tri.map((v) => v[0]);
    const k0 = Math.floor(Math.min(...xs) / step);
    const k1 = Math.ceil(Math.max(...xs) / step);
    for (let k = k0; k < k1; k++) {
      const poly = k1 - k0 === 1 ? tri : clip(clip(tri, k * step, 1), (k + 1) * step, -1);
      for (let i = 1; i + 1 < poly.length; i++) {
        for (const v of [poly[0], poly[i], poly[i + 1]]) {
          pos.push(v[0], v[1], v[2]);
          nor.push(v[3], v[4], v[5]);
        }
      }
    }
  }
  return geometryOf(pos, nor);
}

/**
 * Curva una pieza armada en plano (x a lo largo, y arriba, z hacia afuera con z = 0 en el radio
 * R) alrededor del centro (cx, cz): x = 0 queda en el ángulo a0 y crece en sentido horario (ángulo
 * decreciente), que es el que conserva el lado de afuera. Antes la corta en rebanadas de `maxEdge`.
 */
export function bend(geometry: THREE.BufferGeometry, R: number, cx: number, cz: number, a0: number, maxEdge: number): THREE.BufferGeometry {
  const g = sliceX(geometry, maxEdge);
  geometry.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const nm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const r = R + p.getZ(k);
    const phi = a0 - x / R;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    p.setXYZ(k, cx + r * c, p.getY(k), cz + r * s);
    const nx = nm.getX(k);
    const nz = nm.getZ(k);
    nm.setXYZ(k, nx * s + nz * c, nm.getY(k), -nx * c + nz * s);
  }
  return g;
}

/** Columna corintia: basa ática y fuste con éntasis (piedra); capitel con hojas y volutas (adorno). */
export interface Column {
  shaft: THREE.BufferGeometry;
  capital: THREE.BufferGeometry;
  /** El mismo capitel sin hojas ni volutas (de lejos). */
  plain: THREE.BufferGeometry;
}

/** Proporciones de la columna (en diámetros del fuste), de config. */
export interface ColumnShape {
  base: number;
  capital: number;
  taper: number;
  abacus: number[];
  leaves: number[];
  /** Volutas de las esquinas: radio y grosor (en diámetros del fuste). */
  volutes: number[];
}

/**
 * Hoja de acanto: una lámina curva que sale del cáliz y vuelca la punta hacia afuera (de frente a
 * +x, al pie en el origen), con su espesor.
 */
function leaf(width: number, height: number, bulge: number, curl: number, thickness: number): THREE.BufferGeometry {
  const across = 2;
  const up = 3;
  const pos: number[] = [];
  const index: number[] = [];
  for (const back of [0, 1]) {
    for (let j = 0; j <= up; j++) {
      const v = j / up;
      const w = width * (1 - 0.45 * v * v);
      const out = bulge * Math.sin(Math.PI * v * 0.85) + curl * Math.max(0, v - 0.6) ** 2 * 6 - back * thickness;
      const y = height * v - curl * Math.max(0, v - 0.8) * 2;
      for (let i = 0; i <= across; i++) {
        const u = i / across - 0.5;
        // Nervio al centro: la hoja se pliega un poco hacia atrás en los bordes.
        pos.push(out - Math.abs(u) * bulge * 0.6, y, u * w);
      }
    }
  }
  const row = across + 1;
  const layer = row * (up + 1);
  for (let j = 0; j < up; j++) {
    for (let i = 0; i < across; i++) {
      const a = j * row + i;
      // Cara de afuera hacia +x y la de atrás hacia −x.
      index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      const b = layer + a;
      index.push(b, b + 1, b + row, b + 1, b + row + 1, b + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Ábaco del capitel: cuadrado de lados cóncavos (de `width` entre puntas), de alto `height`. */
function abacus(width: number, height: number, sag: number): THREE.BufferGeometry {
  const h = width / 2;
  const shape = new THREE.Shape();
  const corners = [
    [h, -h],
    [h, h],
    [-h, h],
    [-h, -h],
  ];
  shape.moveTo(corners[0][0], corners[0][1]);
  for (let k = 0; k < 4; k++) {
    const [x0, y0] = corners[k];
    const [x1, y1] = corners[(k + 1) % 4];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const len = Math.hypot(mx, my);
    shape.quadraticCurveTo(mx - (mx / len) * sag * 2, my - (my / len) * sag * 2, x1, y1);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  return g;
}

export function corinthianColumn(d: number, height: number, cfg: ColumnShape, sides: number): Column {
  const capH = cfg.capital * d;
  const baseH = cfg.base * d;
  const top = height - capH;
  const r = d / 2;
  // Basa: plinto cuadrado, toro, escocia, toro y filete.
  const plinth = new THREE.BoxGeometry(d * 1.36, baseH * 0.3, d * 1.36).translate(0, baseH * 0.15, 0);
  const base = lathe(
    [
      [0.66, 0.3],
      [0.69, 0.42],
      [0.66, 0.55],
      [0.58, 0.6],
      [0.56, 0.7],
      [0.59, 0.76],
      [0.61, 0.83],
      [0.58, 0.9],
      [0.52, 0.94],
      [0.5, 1],
    ].map(([rr, y]) => [rr * d, y * baseH]),
    sides,
  );
  // Fuste: derecho el primer tercio y después se afina (éntasis); collarino arriba.
  const shaftPoints: number[][] = [[r * 1.04, baseH]];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const y = baseH + (top - baseH) * t;
    const narrow = t < 1 / 3 ? 0 : ((t - 1 / 3) / (2 / 3)) ** 1.5;
    shaftPoints.push([r * (1 - (1 - cfg.taper) * narrow), y]);
  }
  const rt = r * cfg.taper;
  shaftPoints.push([rt * 1.08, top - d * 0.04], [rt * 1.08, top - d * 0.01], [rt, top]);
  const shaft = mergeGeometries([plinth.toNonIndexed(), base.toNonIndexed(), lathe(shaftPoints, sides).toNonIndexed()]);

  // Capitel: cáliz, ábaco de lados cóncavos y, en el detallado, dos coronas de hojas y volutas.
  const [abacusWidth, abacusHeight, sag] = cfg.abacus;
  const bellTop = capH - abacusHeight * d;
  const bell = lathe(
    [
      [rt, 0],
      [rt * 1.02, bellTop * 0.4],
      [rt * 1.08, bellTop * 0.75],
      [rt * 1.2, bellTop],
    ],
    sides,
  ).translate(0, top, 0);
  const slabTop = abacus(abacusWidth * d, abacusHeight * d, sag * d).translate(0, top + bellTop, 0);
  const plain = mergeGeometries([bell.clone().toNonIndexed(), slabTop.clone()].map(clean));
  const [leafWidth, row1, row2, bulge, curl] = cfg.leaves;
  const ornaments: THREE.BufferGeometry[] = [bell.toNonIndexed(), slabTop];
  for (const [rowHeight, offset] of [
    [row1, 0],
    [row2, Math.PI / 8],
  ]) {
    for (let k = 0; k < 8; k++) {
      const a = offset + (k * TAU) / 8;
      const g = leaf(leafWidth * d, rowHeight * capH, bulge * d, curl * d, d * 0.02);
      g.translate(rt * 0.98, top, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(-a));
      ornaments.push(g.toNonIndexed());
    }
  }
  // Volutas en las esquinas (bajo las puntas del ábaco) y hélices al centro de cada cara.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const [vr, vt] = cfg.volutes;
    const corner = new THREE.TorusGeometry(d * vr, d * vt, 4, 9, Math.PI * 1.7).rotateY(Math.PI / 2);
    corner.translate(abacusWidth * d * 0.42, top + bellTop - d * vr, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(-a));
    ornaments.push(corner.toNonIndexed());
    const b = (k * TAU) / 4;
    const helix = new THREE.TorusGeometry(d * 0.05, d * 0.018, 3, 6, Math.PI * 1.6).rotateY(Math.PI / 2);
    helix.translate(rt * 1.12, top + bellTop - d * 0.08, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(-b));
    ornaments.push(helix.toNonIndexed());
    const flower = new THREE.SphereGeometry(d * 0.055, 5, 3).translate(abacusWidth * d * 0.5 - sag * d * 2, top + bellTop + abacusHeight * d * 0.5, 0);
    flower.applyMatrix4(new THREE.Matrix4().makeRotationY(-b));
    ornaments.push(flower.toNonIndexed());
  }
  const capital = mergeGeometries(ornaments.map(clean));
  return { shaft: clean(shaft), capital, plain: clean(plain) };
}

/** Deja solo posición y normal (mergeGeometries pide los mismos atributos en todas). */
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  return g;
}

/**
 * La pieza con caras planas: sin índice y con la normal de cada triángulo (un prisma de pocos
 * lados, un tronco de pirámide). Los cilindros de three.js comparten los vértices de las aristas
 * y se sombrean redondeados.
 */
export function faceted(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.deleteAttribute('normal');
  flat.computeVertexNormals();
  return flat;
}

/** La pieza vista desde adentro: caras y normales dadas vuelta (la pared interior de un macetero). */
export function inward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  // Cada triángulo con su segundo y tercer vértice cambiados (todos los atributos juntos).
  for (const attr of Object.values(flat.attributes) as THREE.BufferAttribute[]) {
    const n = attr.itemSize;
    const a = attr.array;
    for (let k = 0; k < attr.count; k += 3) {
      for (let c = 0; c < n; c++) {
        const t = a[(k + 1) * n + c];
        a[(k + 1) * n + c] = a[(k + 2) * n + c];
        a[(k + 2) * n + c] = t;
      }
    }
  }
  const nor = flat.getAttribute('normal');
  for (let k = 0; k < nor.count; k++) nor.setXYZ(k, -nor.getX(k), -nor.getY(k), -nor.getZ(k));
  return flat;
}

/**
 * Remate de hastial colonial: dos contracurvas que suben de los hombros (a `rise − curve`) a la
 * punta (a `rise`), de ancho w, de izquierda a derecha (en el plano x-y, centrado en x = 0).
 */
export function gableTop(w: number, rise: number, curve: number, segments: number): THREE.Vector2[] {
  const left = new THREE.CubicBezierCurve(new THREE.Vector2(-w / 2, rise - curve), new THREE.Vector2(-w / 4, rise - curve), new THREE.Vector2(-w / 4, rise), new THREE.Vector2(0, rise));
  const right = new THREE.CubicBezierCurve(new THREE.Vector2(0, rise), new THREE.Vector2(w / 4, rise), new THREE.Vector2(w / 4, rise - curve), new THREE.Vector2(w / 2, rise - curve));
  return [...left.getPoints(segments), ...right.getPoints(segments).slice(1)];
}

/** Blasón de ancho w y alto h (recto arriba, en punta redondeada abajo), en el plano x-y con la punta en el origen. */
export function shield(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, h);
  s.lineTo(-w / 2, h / 3);
  s.quadraticCurveTo(-w / 2, 0, 0, 0);
  s.quadraticCurveTo(w / 2, 0, w / 2, h / 3);
  s.lineTo(w / 2, h);
  s.closePath();
  return s;
}

/** Une piezas con distintos atributos (solo posición y normal). */
export function combine(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(list.map((g) => clean(g.index ? g.toNonIndexed() : g)));
  for (const g of list) g.dispose();
  return merged;
}

/** Balaustre torneado (jarrón) entre dos dados, de alto h y ancho w, con el pie en y = 0. */
export function baluster(h: number, w: number, sides: number): THREE.BufferGeometry {
  const foot = new THREE.BoxGeometry(w, h * 0.1, w).translate(0, h * 0.05, 0);
  const head = new THREE.BoxGeometry(w * 0.9, h * 0.08, w * 0.9).translate(0, h * 0.96, 0);
  const vase = lathe(
    [
      [0.3, 0.1],
      [0.46, 0.25],
      [0.4, 0.41],
      [0.18, 0.6],
      [0.2, 0.74],
      [0.29, 0.84],
      [0.22, 0.92],
    ].map(([r, y]) => [r * w, y * h]),
    sides,
  );
  return combine([foot, vase, head]);
}

/** Balaustre de lejos: un prisma de cuatro caras con su silueta media. */
export function balusterFar(h: number, w: number): THREE.BufferGeometry {
  return combine([new THREE.CylinderGeometry(w * 0.3, w * 0.42, h, 4, 1, true).rotateY(Math.PI / 4).translate(0, h / 2, 0)]);
}

/** Jarrón (de los remates del ático) de alto h con el pie en y = 0. */
export function urn(h: number, sides: number): THREE.BufferGeometry {
  return combine([
    lathe(
      [
        [0, 0],
        [0.17, 0],
        [0.17, 0.05],
        [0.11, 0.08],
        [0.07, 0.14],
        [0.1, 0.18],
        [0.2, 0.27],
        [0.235, 0.38],
        [0.215, 0.5],
        [0.14, 0.58],
        [0.11, 0.62],
        [0.15, 0.66],
        [0.15, 0.69],
        [0.09, 0.72],
        [0.11, 0.76],
        [0.07, 0.84],
        [0.05, 0.88],
        [0.06, 0.92],
        [0.03, 0.97],
        [0, 1],
      ].map(([r, y]) => [r * h, y * h]),
      sides,
    ),
  ]);
}

/**
 * Figura de pie para una estatua (de alto `height`, mirando a +z, los pies en y = 0), en
 * fracciones de su alto: el cuerpo es un torno de los pies a los hombros aplastado de frente
 * (`depth` = fondo / ancho), con la cabeza, los hombros y dos brazos de dos tramos cada uno: por
 * brazo, [largo, x, y, z] del brazo y del antebrazo (la dirección no hace falta normalizada).
 * Devuelve también dónde quedan las manos (para lo que sostienen: una antorcha, un libro).
 */
export interface FigureShape {
  body: number[][];
  depth: number;
  head: number[];
  shoulders: number[];
  arm: number;
  arms: number[][][];
}

export function figure(height: number, s: FigureShape, sides: number): { geometry: THREE.BufferGeometry; hands: THREE.Vector3[] } {
  const H = height;
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.LatheGeometry(
    s.body.map(([r, y]) => new THREE.Vector2(r * H, y * H)),
    sides,
  );
  body.scale(1, 1, s.depth);
  parts.push(body);
  const [headR, headY] = s.head;
  parts.push(new THREE.SphereGeometry(headR * H, sides, sides / 2).translate(0, headY * H, 0));
  const [halfW, shoulderY] = s.shoulders;
  const up = new THREE.Vector3(0, 1, 0);
  const r = s.arm * H;
  const hands: THREE.Vector3[] = [];
  s.arms.forEach((segments, k) => {
    const side = k === 0 ? 1 : -1;
    let from = new THREE.Vector3(side * halfW * H, shoulderY * H, 0);
    parts.push(new THREE.SphereGeometry(r, sides / 2, sides / 4).translate(from.x, from.y, from.z));
    for (const [length, dx, dy, dz] of segments) {
      const dir = new THREE.Vector3(side * dx, dy, dz).normalize();
      const to = from.clone().addScaledVector(dir, length * H);
      const limb = new THREE.CylinderGeometry(r, r, length * H, sides / 2, 1, true);
      limb.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
      limb.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
      parts.push(limb, new THREE.SphereGeometry(r, sides / 2, sides / 4).translate(to.x, to.y, to.z));
      from = to;
    }
    hands.push(from);
  });
  return { geometry: combine(parts), hands };
}

/**
 * Cóndor con las alas abiertas hacia arriba (como los del ático), de envergadura `span`, mirando a
 * +z con las patas en y = 0.
 */
export function condor(span: number, raiseDeg: number, sides: number): THREE.BufferGeometry {
  const s = span;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.SphereGeometry(s * 0.13, sides, sides / 2).scale(0.8, 1.25, 1).translate(0, s * 0.3, 0));
  parts.push(new THREE.SphereGeometry(s * 0.06, sides, sides / 2).translate(0, s * 0.5, s * 0.05));
  parts.push(new THREE.ConeGeometry(s * 0.025, s * 0.08, 6).rotateX(Math.PI / 2).translate(0, s * 0.49, s * 0.13));
  parts.push(new THREE.ConeGeometry(s * 0.09, s * 0.22, 6).scale(1, 1, 0.35).rotateX(Math.PI * 0.85).translate(0, s * 0.12, -s * 0.08));
  // Ala: silueta con las plumas del borde de fuga, en el plano x-y, desde el hombro hacia +x.
  const wing = new THREE.Shape();
  wing.moveTo(0, 0);
  wing.lineTo(s * 0.18, s * 0.1);
  wing.lineTo(s * 0.46, s * 0.14);
  for (let k = 0; k < 5; k++) {
    const x = s * (0.46 - k * 0.07);
    wing.lineTo(x - s * 0.02, s * (0.02 - k * 0.012));
    wing.lineTo(x - s * 0.07, s * (0.06 - k * 0.01));
  }
  wing.lineTo(s * 0.04, -s * 0.12);
  wing.closePath();
  const raise = THREE.MathUtils.degToRad(raiseDeg);
  for (const side of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(wing, { depth: s * 0.025, bevelEnabled: false });
    g.translate(0, 0, -s * 0.0125);
    g.rotateZ(raise);
    // La izquierda es la misma ala dada vuelta (girar en vez de espejar no invierte las caras).
    if (side < 0) g.rotateY(Math.PI);
    g.translate(side * s * 0.07, s * 0.36, -s * 0.02);
    parts.push(g);
  }
  return combine(parts);
}

/** Ménsula en voluta (clave de arco, soporte de balcón): de ancho w, alto h y vuelo d, mirando a +z. */
export function bracket(w: number, h: number, d: number): THREE.BufferGeometry {
  // Perfil lateral (z = vuelo, y = alto): ancha arriba, se recoge en una curva hacia abajo.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(d * 0.35, 0);
  shape.quadraticCurveTo(d * 0.35, h * 0.55, d, h * 0.75);
  shape.lineTo(d, h);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 5 });
  // La forma va en x-y: girada, el vuelo (x) queda hacia +z y la extrusión a lo ancho (x).
  g.rotateY(-Math.PI / 2);
  g.translate(w / 2, 0, 0);
  return clean(g);
}

/**
 * Corona de laurel con una estrella al centro (el escudo de Guayaquil en los tímpanos): en el
 * plano x-y, mirando a +z.
 */
export function wreath(r: number, depth: number, sides: number): { ring: THREE.BufferGeometry; star: THREE.BufferGeometry } {
  const ring = new THREE.TorusGeometry(r, r * 0.16, 5, sides * 2).scale(1, 1, depth / (r * 0.32));
  const star = new THREE.Shape();
  for (let k = 0; k < 10; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 === 0 ? r * 0.62 : r * 0.25;
    if (k === 0) star.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else star.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  star.closePath();
  return { ring: clean(ring), star: clean(new THREE.ExtrudeGeometry(star, { depth, bevelEnabled: false })) };
}

/**
 * Perfil de una cúpula: de radio r0 en su arranque (y = 0) sube `rise` hasta el anillo de la
 * linterna (radio `top`), con la panza `bulge` (fracción del radio), repartido por largo de arco.
 */
export function domeProfile(r0: number, rise: number, bulge: number, top: number, steps: number): number[][] {
  const raw: number[][] = [];
  const fine = steps * 8;
  for (let i = 0; i <= fine; i++) {
    const t = i / fine;
    const th = (t * Math.PI) / 2;
    raw.push([Math.max(top, r0 * (1 + bulge * Math.sin(Math.PI * t)) * Math.cos(th)), rise * Math.sin(th)]);
  }
  // Hasta donde el radio llega al de la linterna.
  const end = raw.findIndex(([r], i) => i > 0 && r <= top);
  const curve = raw.slice(0, end > 0 ? end + 1 : raw.length);
  const total = profileLength(curve);
  const out: number[][] = [curve[0]];
  let acc = 0;
  let next = total / steps;
  for (let k = 1; k < curve.length; k++) {
    const seg = Math.hypot(curve[k][0] - curve[k - 1][0], curve[k][1] - curve[k - 1][1]);
    while (acc + seg >= next && out.length < steps) {
      const f = (next - acc) / seg;
      out.push([curve[k - 1][0] + (curve[k][0] - curve[k - 1][0]) * f, curve[k - 1][1] + (curve[k][1] - curve[k - 1][1]) * f]);
      next += total / steps;
    }
    acc += seg;
  }
  out.push(curve[curve.length - 1]);
  return out;
}

/** Nervio que sube por una cúpula (perfil `profile`, de torno) en el ángulo `a`, de ancho w y resalte h. */
export function rib(profile: readonly (readonly number[])[], a: number, w: number, h: number): THREE.BufferGeometry {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const points = profile.map(([r, y]) => new THREE.Vector3(c * r, y, s * r));
  // Eje horizontal perpendicular al meridiano: axis × subida = hacia afuera de la cúpula.
  const axis = new THREE.Vector3(s, 0, -c);
  return sweep(
    points,
    axis,
    [
      [0, -w / 2],
      [h, -w / 2],
      [h, w / 2],
      [0, w / 2],
    ],
    { smoothDeg: 60 },
  );
}
