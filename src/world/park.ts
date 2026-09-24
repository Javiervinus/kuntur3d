import * as THREE from 'three';
import { type FigureShape, condor, figure } from './classical';
import { Batch, type Glow, type MonumentBase, PATTERN, type Surface, colorsOf, glowOf, patternOf } from './monumentParts';
import { pave } from './street';

/**
 * Un parque del centro (config/game.json → monuments.list, tipo `park`), como el Parque Centenario:
 * sus paseos y plazas de losas, la reja perimetral de lanzas sobre su bordillo con las portadas
 * de cada entrada (postes con globos y un cóndor), los grupos de bronce sobre pedestales de mármol
 * que las flanquean, los faroles de globos y los mástiles con la bandera. Los árboles y el césped
 * son los de los datos del mundo. Marco local en m (el de su monumento central).
 */
export interface Park extends MonumentBase {
  /** Polígonos (marco local) donde no quedan edificios ni árboles de los datos. */
  clear: number[][][];
  /** Cuánto sube el piso sobre el terreno, lado de los tramos que lo siguen y cuánto se entierra lo que se apoya. */
  ground: { lift: number; step: number; bury: number };
  detail: { near: number; sides: number };
  rails: { roughness: number; metalness: number };
  colors: { curb: string; fence: string; pillar: string; globe: string; bronze: string; marble: string; mast: string };
  glow: Glow;
  /** Cuánto alumbran el piso los faroles de noche y si son LED (blancos) o de sodio. */
  light: { power: number; led: boolean };
  /** Paseos y plazas: contorno (marco local), color y dibujo. */
  floors: { ring: number[][]; color: string; pattern: string; scale: number[] }[];
  /** Reja: tramos (recorridos en el marco local), bordillo (ancho, alto), reja (alto, lado de los postes, separación). */
  fence: { runs: number[][][]; curb: number[]; rail: number[] };
  /**
   * Portadas: por entrada [x, z, hacia dónde mira afuera (rad, atan2(z, x)), ancho]; en cada lado un
   * dado de piedra (lado, alto), el poste de hierro (radio arriba y abajo, alto), la cruceta con sus
   * globos (largo, radio del globo, altura, radio de la cruceta) y el cóndor encima (envergadura,
   * alas en grados).
   */
  gates: { at: number[][]; pillar: number[]; post: number[]; globes: number[]; condor: number[] };
  /**
   * Grupos de bronce a los lados de cada entrada: a cuánto del eje de la entrada y hacia adentro,
   * pedestal (largo, fondo, alto), las figuras (alto, figura, cuántas y separación) y la roca o
   * el caballo que las acompaña (largo, alto, ancho, cuánto va hacia atrás y hacia afuera de la entrada).
   */
  groups: { offset: number[]; pedestal: number[]; height: number; shape: FigureShape; figures: number[]; mass: number[] };
  /** Faroles de globos: dónde, poste (radio arriba y abajo, alto), brazos (cuántos, largo, altura, radio) y radio de cada globo. */
  lamps: { at: number[][]; post: number[]; arms: number[]; globe: number };
  /**
   * Mástiles: dónde, alto, radio abajo y arriba; bandera (largo, alto, cuánto baja de la punta) y sus
   * franjas (colores y qué parte del alto lleva cada una).
   */
  masts: { at: number[][]; height: number; radius: number[]; flag: number[]; stripes: string[]; share: number[] };
}

/** Dónde alumbra cada farol (marco local): al centro del poste, a la altura de los globos de los brazos. */
export function parkLights(p: Park): { x: number; z: number; h: number }[] {
  const [, , armY] = p.lamps.arms;
  return p.lamps.at.map(([x, z]) => ({ x, z, h: armY + p.lamps.globe }));
}

/** Lo que el parque necesita de Monuments (world/monuments.ts). */
export interface ParkKit {
  root: THREE.Group;
  materials: { stone: THREE.Material; rails: THREE.Material };
  terrain(x: number, z: number): number;
  box(x: number, z: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  circle(x: number, z: number, r: number, top: number, floor: boolean, bottom: number): void;
  /** Piso a `offset` sobre el terreno dentro del polígono. */
  ground(outline: THREE.Vector3[], offset: number): void;
  near(o: THREE.Object3D, distance: number): void;
}

/**
 * Arma el parque en `kit.root`: pisos y bordillos en una malla, la reja calada, y lo chico
 * (portadas, grupos, faroles) solo de cerca; los mástiles siempre.
 */
export class ParkBuilder {
  private readonly col: ReturnType<typeof colorsOf<keyof Park['colors']>>;
  private readonly stone = new Batch();
  private readonly paving = new Batch();
  private readonly detail = new Batch();
  private readonly rails = new Batch();

  constructor(
    private readonly p: Park,
    private readonly kit: ParkKit,
  ) {
    this.col = colorsOf(p.colors);
  }

  build(): void {
    const p = this.p;
    for (const b of [this.stone, this.paving, this.detail, this.rails]) b.flood.splice(0, 3, p.flood, this.floor(0, 0), p.masts.height);
    for (const f of p.floors) {
      pave(this.paving, f.ring, (x, z) => this.floor(x, z), p.ground.step, new THREE.Color(f.color), { pattern: patternOf(f.pattern), scale: f.scale });
      this.kit.ground(
        f.ring.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        p.ground.lift,
      );
    }
    for (const run of p.fence.runs) this.fence(run);
    for (const g of p.gates.at) this.gate(g);
    for (const at of p.lamps.at) this.lamp(at[0], at[1]);
    for (const at of p.masts.at) this.mast(at[0], at[1]);
    this.meshes();
  }

  private floor(x: number, z: number): number {
    return this.kit.terrain(x, z) + this.p.ground.lift;
  }

  private meshes(): void {
    const k = this.kit;
    const add = (batch: Batch, material: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null => {
      if (batch.empty) return null;
      const mesh = new THREE.Mesh(batch.build(), material);
      mesh.name = `${this.p.id}-${name}`;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      k.root.add(mesh);
      return mesh;
    };
    add(this.paving, k.materials.stone, 'floors', false);
    add(this.stone, k.materials.stone, 'stone', true);
    const near = add(this.detail, k.materials.stone, 'detail', true);
    if (near) k.near(near, this.p.detail.near);
    const fence = add(this.rails, k.materials.rails, 'fence', false);
    if (fence) k.near(fence, this.p.detail.near);
  }

  private put(g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, surface: Surface = {}, batch = this.detail): void {
    batch.geometry(g, m, color, surface);
    g.dispose();
  }

  /** Marco en (x, z) sobre el piso, mirando hacia `facing` (rad, atan2(z, x) local) con su +z. */
  private frame(x: number, z: number, facing: number, y = 0): THREE.Matrix4 {
    return new THREE.Matrix4().makeTranslation(x, this.floor(x, z) + y, z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2 - facing));
  }

  /** Reja de lanzas (el dibujo de barrotes, calado y visto por los dos lados) sobre su bordillo, a lo largo de un recorrido. */
  private fence(run: number[][]): void {
    const p = this.p;
    const [curbW, curbH] = p.fence.curb;
    const [height, postW, spacing] = p.fence.rail;
    const bury = p.ground.bury;
    let u = 0;
    for (let k = 0; k + 1 < run.length; k++) {
      const a = new THREE.Vector2(run[k][0], run[k][1]);
      const b = new THREE.Vector2(run[k + 1][0], run[k + 1][1]);
      const len = a.distanceTo(b);
      const steps = Math.max(1, Math.ceil(len / p.ground.step));
      for (let s = 0; s < steps; s++) {
        const p0 = a.clone().lerp(b, s / steps);
        const p1 = a.clone().lerp(b, (s + 1) / steps);
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const piece = p0.distanceTo(p1);
        // Bordillo: una caja por tramo, enterrada para seguir el terreno.
        const m = new THREE.Matrix4().makeTranslation(mid.x, this.floor(mid.x, mid.y) + (curbH - bury) / 2, mid.y).multiply(new THREE.Matrix4().makeRotationY(-angle));
        this.stone.box(m, piece, curbH + bury, curbW, this.col.curb);
        const y0 = this.floor(p0.x, p0.y) + curbH;
        const y1 = this.floor(p1.x, p1.y) + curbH;
        const q0 = new THREE.Vector3(p0.x, y0, p0.y);
        const q1 = new THREE.Vector3(p1.x, y1, p1.y);
        const up = new THREE.Vector3(0, height, 0);
        this.rails.quad(q0, q1, q1.clone().add(up), q0.clone().add(up), this.col.fence, { pattern: PATTERN.bars }, [u, 0, u + piece, height]);
        this.kit.box(mid.x, mid.y, piece / 2, curbW / 2, angle, this.floor(mid.x, mid.y) + curbH + height, false, -Infinity);
        u += piece;
      }
      const posts = Math.max(1, Math.round(len / spacing));
      for (let j = 0; j <= posts; j++) {
        const q = a.clone().lerp(b, j / posts);
        this.detail.box(new THREE.Matrix4().makeTranslation(q.x, this.floor(q.x, q.y) + curbH + height / 2, q.y), postW, height, postW, this.col.fence);
      }
    }
  }

  /** Portada de una entrada: a cada lado un dado con su poste de globos y el cóndor, y los grupos de bronce. */
  private gate([x, z, facing, width]: number[]): void {
    const p = this.p;
    const G = p.gates;
    const [pillarW, pillarH] = G.pillar;
    const [postR, postBase, postH] = G.post;
    const [armL, globeR, globeY, armR] = G.globes;
    const [span, raise] = G.condor;
    const along = new THREE.Vector2(-Math.sin(facing), Math.cos(facing));
    const inward = new THREE.Vector2(-Math.cos(facing), -Math.sin(facing));
    const globe = glowOf(p.glow);
    for (const side of [-1, 1]) {
      const q = new THREE.Vector2(x, z).addScaledVector(along, (side * width) / 2);
      this.stone.box(this.frame(q.x, q.y, facing, (pillarH - p.ground.bury) / 2), pillarW, pillarH + p.ground.bury, pillarW, this.col.pillar);
      this.kit.box(q.x, q.y, pillarW / 2, pillarW / 2, facing, this.floor(q.x, q.y) + pillarH, false, -Infinity);
      this.put(new THREE.CylinderGeometry(postR, postBase, postH, p.detail.sides), this.frame(q.x, q.y, facing, pillarH + postH / 2), this.col.fence);
      this.put(new THREE.CylinderGeometry(armR, armR, armL, p.detail.sides / 2).rotateZ(Math.PI / 2), this.frame(q.x, q.y, facing, pillarH + globeY), this.col.fence);
      for (const k of [-1, 1]) {
        const g = new THREE.SphereGeometry(globeR, p.detail.sides, p.detail.sides / 2);
        this.put(g, this.frame(q.x, q.y, facing, pillarH + globeY + globeR).multiply(new THREE.Matrix4().makeTranslation((k * armL) / 2, 0, 0)), this.col.globe, { glow: globe });
      }
      this.put(condor(span, raise, p.detail.sides), this.frame(q.x, q.y, facing, pillarH + postH), this.col.bronze);
      this.group(new THREE.Vector2(x, z), along, inward, side, facing);
    }
  }

  /** Grupo de bronce sobre su pedestal de mármol, a un lado de la entrada, mirando hacia afuera. */
  private group(center: THREE.Vector2, along: THREE.Vector2, inward: THREE.Vector2, side: number, facing: number): void {
    const p = this.p;
    const G = p.groups;
    const [off, depth] = G.offset;
    const [pl, pd, ph] = G.pedestal;
    const [count, gap] = G.figures;
    const [ml, mh, mw, behind, aside] = G.mass;
    const q = center.clone().addScaledVector(along, side * off).addScaledVector(inward, depth);
    this.stone.box(this.frame(q.x, q.y, facing, (ph - p.ground.bury) / 2), pl, ph + p.ground.bury, pd, this.col.marble);
    this.kit.box(q.x, q.y, pl / 2, pd / 2, facing + Math.PI / 2, this.floor(q.x, q.y) + ph, true, -Infinity);
    const body = figure(G.height, G.shape, p.detail.sides).geometry;
    for (let k = 0; k < count; k++) {
      const u = (k - (count - 1) / 2) * gap;
      this.detail.geometry(body, this.frame(q.x, q.y, facing, ph).multiply(new THREE.Matrix4().makeTranslation(u, 0, 0)), this.col.bronze);
    }
    body.dispose();
    // La roca o el caballo del grupo, detrás de las figuras.
    const mass = new THREE.SphereGeometry(1, p.detail.sides, p.detail.sides / 2).scale(ml / 2, mh / 2, mw / 2);
    this.put(mass, this.frame(q.x, q.y, facing, ph + mh / 2).multiply(new THREE.Matrix4().makeTranslation(side * aside, 0, -behind)), this.col.bronze);
  }

  /** Farol de hierro con sus globos en brazos y uno arriba. */
  private lamp(x: number, z: number): void {
    const p = this.p;
    const L = p.lamps;
    const [r, base, h] = L.post;
    const [arms, reach, armY, armR] = L.arms;
    const glow = glowOf(p.glow);
    const y = this.floor(x, z);
    this.put(new THREE.CylinderGeometry(r, base, h, p.detail.sides), new THREE.Matrix4().makeTranslation(x, y + h / 2, z), this.col.fence);
    this.kit.circle(x, z, base, y + h, false, -Infinity);
    for (let k = 0; k < arms; k++) {
      const a = (k / arms) * Math.PI * 2;
      const gx = x + Math.cos(a) * reach;
      const gz = z + Math.sin(a) * reach;
      this.put(new THREE.CylinderGeometry(armR, armR, reach, p.detail.sides / 2).rotateZ(Math.PI / 2).rotateY(-a), new THREE.Matrix4().makeTranslation(x + (Math.cos(a) * reach) / 2, y + armY, z + (Math.sin(a) * reach) / 2), this.col.fence);
      this.put(new THREE.SphereGeometry(L.globe, p.detail.sides, p.detail.sides / 2), new THREE.Matrix4().makeTranslation(gx, y + armY + L.globe, gz), this.col.globe, { glow });
    }
    this.put(new THREE.SphereGeometry(L.globe, p.detail.sides, p.detail.sides / 2), new THREE.Matrix4().makeTranslation(x, y + h + L.globe, z), this.col.globe, { glow });
  }

  /** Mástil con la bandera ondeando quieta a lo largo de +x. */
  private mast(x: number, z: number): void {
    const p = this.p;
    const M = p.masts;
    const [r0, r1] = M.radius;
    const y = this.floor(x, z);
    this.put(new THREE.CylinderGeometry(r1, r0, M.height, p.detail.sides), new THREE.Matrix4().makeTranslation(x, y + M.height / 2, z), this.col.mast, {}, this.stone);
    this.kit.circle(x, z, r0, y + M.height, false, -Infinity);
    const [fl, fh, drop] = M.flag;
    let top = y + M.height - drop;
    M.stripes.forEach((color, k) => {
      const h = fh * M.share[k];
      const c = new THREE.Color(color);
      const a = new THREE.Vector3(x + r1, top - h, z);
      const b = new THREE.Vector3(x + r1 + fl, top - h, z);
      const up = new THREE.Vector3(0, h, 0);
      // Las dos caras de la tela.
      this.stone.quad(a, b, b.clone().add(up), a.clone().add(up), c);
      this.stone.quad(b, a, a.clone().add(up), b.clone().add(up), c);
      top -= h;
    });
  }
}
