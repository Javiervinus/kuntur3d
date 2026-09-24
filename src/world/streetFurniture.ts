import * as THREE from 'three';
import { inward, lathe } from './classical';
import { Batch, type Glow, type Surface, colorsOf, glowOf } from './monumentParts';

/**
 * El mobiliario de una calle modelada (config/streets/*.json → furniture): dónde van los faroles,
 * los árboles con su macetero o alcorque y las bancas (reglas por cuadra, siempre en el mismo
 * lugar), y sus modelos.
 */
export interface StreetFurniture {
  /** Distancia (m) al centro de la cuadra hasta la que se ve su mobiliario. */
  near: number;
  /**
   * Faroles: a cuántos m del bordillo, cada cuánto como máximo y a cuánto de las puntas de la
   * vereda (los cruces) van el primero y el último: quedan parejos, con uno en cada esquina.
   */
  lamps: { inset: number; spacing: number; margin: number };
  /**
   * Árboles: a cuántos m del bordillo, cada cuánto, desde dónde en la vereda norte y en la sur,
   * cuánto se alejan de las puntas y de un farol, alto y radio de copa (mín., máx.), verdes (como
   * se ven en la foto satelital) y qué parte va en macetero (el resto, en alcorque con rejilla).
   */
  trees: { inset: number; spacing: number; phase: number[]; margin: number; clearance: number; height: number[]; radius: number[]; colors: string[]; planters: number };
  /** Bancas: una cada tantos árboles, corrida a lo largo desde el árbol y a cuánto del bordillo. */
  benches: { every: number; offset: number; inset: number };
  /**
   * Farol ornamental de hierro de dos linternas (el de la regeneración urbana de Guayaquil), en m:
   * perfil de la base (radio, alto), fuste que se afina, collarín y remate a la altura de la
   * cruceta, volutas de apoyo, linternas (pie, vidrio que se abre hacia arriba, sombrerete con su
   * vuelo y remate) y la estrella celeste de Guayaquil (radio 0 = sin estrella).
   */
  lamp: {
    sides: number;
    base: number[][];
    shaft: { bottom: number; top: number; height: number };
    collar: { radius: number; height: number };
    finial: number;
    bar: { length: number; radius: number; height: number };
    scroll: { radius: number; tube: number };
    lantern: { sides: number; radius: number; foot: number; glass: number; taper: number; roof: number; overhang: number; finial: number };
    star: { radius: number; inner: number; thickness: number; height: number };
  };
  /** Macetero redondo de acero: radio, alto, cuánto se afina abajo, grosor del borde y hondura de la tierra. */
  planter: { radius: number; height: number; taper: number; rim: number; soil: number };
  /** Alcorque: la rejilla cuadrada a ras de la vereda. */
  grate: { size: number; thickness: number };
  /**
   * Banca de listones: largo, alto del asiento, fondo, alto del respaldo, listones del asiento y del
   * respaldo (ancho, grosor), y las patas de hierro (ancho, a cuánto de cada punta).
   */
  bench: { length: number; seat: number; depth: number; back: number; slats: number; backSlats: number; slat: number[]; leg: number[] };
  /** Luz de cada linterna para el alumbrado: potencia (1 = la de un poste de la calle) y LED o sodio. */
  light: { power: number; led: boolean };
  glow: Glow;
  colors: { iron: string; glass: string; star: string; planter: string; soil: string; grate: string; bench: string };
}

/** Algo del mobiliario en el marco de la calle: posición y hacia dónde mira (rad, atan2(z, x) local). */
export interface FurnitureItem {
  block: string;
  x: number;
  z: number;
  /** Hacia adentro de la vereda (de la calzada a los edificios). */
  angle: number;
}

export interface TreeItem extends FurnitureItem {
  height: number;
  radius: number;
  color: THREE.Color;
  planter: boolean;
}

/** Lo que el mobiliario necesita de cada cuadra: su id y sus veredas (el lado 0 es el bordillo de la calle). */
interface BlockLike {
  id: string;
  sidewalks: { ring: number[][] }[];
}

const rand = (k: number, salt: number): number => {
  const v = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Dónde va cada cosa: a lo largo del bordillo de cada vereda (su primer lado), a la distancia de la
 * config y sin acercarse a los cruces; los árboles, sin pisar un farol.
 */
export function layoutFurniture(f: StreetFurniture, blocks: readonly BlockLike[]): { lamps: FurnitureItem[]; trees: TreeItem[]; benches: FurnitureItem[] } {
  const lamps: FurnitureItem[] = [];
  const trees: TreeItem[] = [];
  const benches: FurnitureItem[] = [];
  const greens = f.trees.colors.map((c) => new THREE.Color(c));
  let serial = 0;
  for (const b of blocks) {
    for (const s of b.sidewalks) {
      const r = s.ring;
      const a = new THREE.Vector2(r[0][0], r[0][1]);
      const c = new THREE.Vector2(r[1][0], r[1][1]);
      const len = a.distanceTo(c);
      const dir = c.clone().sub(a).divideScalar(len);
      // Hacia adentro: el lado de la normal donde queda el resto del contorno.
      let n = new THREE.Vector2(-dir.y, dir.x);
      const mid = r.reduce((acc, p) => acc.add(new THREE.Vector2(p[0], p[1])), new THREE.Vector2()).divideScalar(r.length);
      if (mid.clone().sub(a).dot(n) < 0) n = n.negate();
      // Vereda norte (adentro hacia +z) o sur: cada una con su desfase.
      const side = n.y > 0 ? 0 : 1;
      const angle = Math.atan2(n.y, n.x);
      const at = (u: number, inset: number): THREE.Vector2 => a.clone().addScaledVector(dir, u).addScaledVector(n, inset);
      const L = f.lamps;
      const run = len - 2 * L.margin;
      const gaps = run > 0 ? Math.max(1, Math.ceil(run / L.spacing)) : 0;
      const lampUs = run > 0 ? Array.from({ length: gaps + 1 }, (_, k) => L.margin + (run * k) / gaps) : [len / 2];
      for (const u of lampUs) {
        const p = at(u, L.inset);
        lamps.push({ block: b.id, x: p.x, z: p.y, angle });
      }
      const T = f.trees;
      let k = 0;
      for (let u = T.margin + T.phase[side]; u <= len - T.margin; u += T.spacing) {
        if (lampUs.some((q) => Math.abs(q - u) < T.clearance)) continue;
        const p = at(u, T.inset);
        const seed = serial++;
        trees.push({
          block: b.id,
          x: p.x,
          z: p.y,
          angle,
          height: THREE.MathUtils.lerp(T.height[0], T.height[1], rand(seed, 1)),
          radius: THREE.MathUtils.lerp(T.radius[0], T.radius[1], rand(seed, 2)),
          color: greens[Math.floor(rand(seed, 3) * greens.length) % greens.length],
          planter: rand(seed, 4) < T.planters,
        });
        if (k++ % f.benches.every === 0) {
          const q = at(u + f.benches.offset, f.benches.inset);
          benches.push({ block: b.id, x: q.x, z: q.y, angle });
        }
      }
    }
  }
  return { lamps, trees, benches };
}

/**
 * Luces de un farol (sus dos linternas), en el marco de la calle: posición de la luz, su altura
 * sobre el pie del poste y hacia dónde sale del poste (la cruceta va de la calzada a los edificios).
 */
export function lampLights(f: StreetFurniture, lamp: FurnitureItem): { x: number; z: number; h: number; out: number }[] {
  const { bar, lantern } = f.lamp;
  const h = bar.height + lantern.foot + lantern.glass / 2;
  return [-1, 1].map((s) => ({
    x: lamp.x + Math.cos(lamp.angle) * s * (bar.length / 2),
    z: lamp.z + Math.sin(lamp.angle) * s * (bar.length / 2),
    h,
    out: lamp.angle + (s < 0 ? Math.PI : 0),
  }));
}

/**
 * Los modelos del mobiliario (cada uno una geometría para instanciar, con el pie en el origen y
 * +x hacia los edificios): el farol con la cruceta a lo largo de x y la estrella de frente a lo
 * largo de la calle (z), el macetero, la rejilla del alcorque y la banca (a lo largo de z, mirando
 * a +x, con el respaldo del lado de la calzada).
 */
export function furnitureModels(f: StreetFurniture): { lamp: THREE.BufferGeometry; planter: THREE.BufferGeometry; grate: THREE.BufferGeometry; bench: THREE.BufferGeometry } {
  const c = colorsOf(f.colors);
  const L = f.lamp;
  const sides = L.sides;
  const lamp = new Batch();
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}): void => {
    lamp.geometry(g, m, color, surface);
    g.dispose();
  };
  const at = (x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y, z);
  // Base torneada, fuste que se afina, collarín y remate sobre la cruceta.
  put(lathe(L.base, sides), new THREE.Matrix4(), c.iron);
  const baseTop = L.base[L.base.length - 1][1];
  const { shaft, collar, bar } = L;
  put(new THREE.CylinderGeometry(shaft.top, shaft.bottom, shaft.height - baseTop, sides, 1, true), at(0, (shaft.height + baseTop) / 2, 0), c.iron);
  put(new THREE.CylinderGeometry(collar.radius, collar.radius, collar.height, sides), at(0, bar.height, 0), c.iron);
  put(new THREE.SphereGeometry(L.finial, sides, sides / 2), at(0, bar.height + collar.height / 2 + L.finial, 0), c.iron);
  // Cruceta con sus dos volutas de apoyo: cuartos de toro que bajan de la cruceta al fuste.
  put(new THREE.CylinderGeometry(bar.radius, bar.radius, bar.length, sides / 2).rotateZ(Math.PI / 2), at(0, bar.height, 0), c.iron);
  for (const s of [-1, 1]) {
    const scroll = new THREE.TorusGeometry(L.scroll.radius, L.scroll.tube, sides / 2, sides, Math.PI / 2).rotateZ(-Math.PI / 2);
    put(scroll, at(0, bar.height, 0).multiply(new THREE.Matrix4().makeScale(s, 1, 1)), c.iron);
  }
  // Linternas en las puntas: pie, vidrio que brilla de noche, sombrerete y remate.
  const T = L.lantern;
  for (const s of [-1, 1]) {
    const x = (s * bar.length) / 2;
    let y = bar.height;
    put(new THREE.CylinderGeometry(T.radius * T.taper, bar.radius, T.foot, T.sides), at(x, y + T.foot / 2, 0), c.iron);
    y += T.foot;
    put(new THREE.CylinderGeometry(T.radius, T.radius * T.taper, T.glass, T.sides, 1, true), at(x, y + T.glass / 2, 0), c.glass, { glow: glowOf(f.glow) });
    y += T.glass;
    put(new THREE.ConeGeometry(T.radius * T.overhang, T.roof, T.sides), at(x, y + T.roof / 2, 0), c.iron);
    y += T.roof;
    put(new THREE.SphereGeometry(T.finial, T.sides, T.sides / 2), at(x, y + T.finial, 0), c.iron);
  }
  // La estrella celeste de cinco puntas, de frente a lo largo de la calle.
  const S = L.star;
  if (S.radius > 0) {
    const star = new THREE.Shape();
    for (let k = 0; k < 10; k++) {
      const a = Math.PI / 2 + (k * Math.PI) / 5;
      const r = k % 2 === 0 ? S.radius : S.radius * S.inner;
      if (k === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    star.closePath();
    put(new THREE.ExtrudeGeometry(star, { depth: S.thickness, bevelEnabled: false }), at(0, S.height, -S.thickness / 2), c.star);
  }

  // Macetero: el cilindro de acero con su borde, la cara de adentro sobre la tierra y la tierra.
  const P = f.planter;
  const planter = new Batch();
  const pot = (g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color): void => {
    planter.geometry(g, m, color);
    g.dispose();
  };
  pot(new THREE.CylinderGeometry(P.radius, P.radius * P.taper, P.height, sides * 2, 1, true), at(0, P.height / 2, 0), c.planter);
  pot(new THREE.TorusGeometry(P.radius - P.rim / 2, P.rim / 2, sides / 2, sides * 2).rotateX(Math.PI / 2), at(0, P.height, 0), c.planter);
  pot(inward(new THREE.CylinderGeometry(P.radius - P.rim, P.radius - P.rim, P.soil, sides * 2, 1, true)), at(0, P.height - P.soil / 2, 0), c.planter);
  pot(new THREE.CircleGeometry(P.radius - P.rim, sides * 2).rotateX(-Math.PI / 2), at(0, P.height - P.soil, 0), c.soil);

  // Alcorque: la rejilla cuadrada de hierro, apenas sobre la vereda.
  const G = f.grate;
  const grate = new Batch();
  grate.box(at(0, G.thickness / 2, 0), G.size, G.thickness, G.size, c.grate);

  // Banca: listones del asiento y del respaldo (del lado de −x) sobre dos patas de hierro.
  const B = f.bench;
  const [slatW, slatT] = B.slat;
  const [legW, legInset] = B.leg;
  const bench = new Batch();
  for (let k = 0; k < B.slats; k++) {
    const x = -B.depth / 2 + slatW / 2 + (k * (B.depth - slatW)) / Math.max(1, B.slats - 1);
    bench.box(at(x, B.seat - slatT / 2, 0), slatW, slatT, B.length, c.bench);
  }
  const backX = -B.depth / 2 - slatT / 2;
  for (let k = 0; k < B.backSlats; k++) {
    const y = B.seat + ((k + 1) * B.back) / B.backSlats - slatW / 2;
    bench.box(at(backX, y, 0), slatT, slatW, B.length, c.bench);
  }
  for (const s of [-1, 1]) {
    const z = s * (B.length / 2 - legInset);
    bench.box(at(0, (B.seat - slatT) / 2, z), B.depth, B.seat - slatT, legW, c.iron);
    bench.box(at(backX - slatT, B.seat + B.back / 2, z), legW, B.back, legW, c.iron);
  }
  return { lamp: lamp.build(), planter: planter.build(), grate: grate.build(), bench: bench.build() };
}
