import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VehicleConfig } from '../core/types';
import type { CockpitPass } from '../render/cockpit';
import { addNightLight } from '../render/nightLight';

/**
 * Sedán procedural a partir de las medidas de config/game.json → vehicles.car. La carrocería
 * es hueca como un carro de verdad (guardafangos, puertas, piso, vidrios y techo por separado)
 * para que se vea el interior y al conductor; todas las piezas se fusionan por material, así
 * el carro completo son ~8 draw calls y las 4 ruedas van instanciadas.
 *
 * Marco del cuerpo al construir: origen en el suelo bajo el eje delantero, z hacia atrás,
 * x a la derecha. Al final todo se corre para que el origen quede en el centro de gravedad.
 */

type Rgb = THREE.Color;
type Pt = [number, number];

/** Geometría lista para fusionar: sin índice y solo con posición, normal y (opcional) color. */
function part(geometry: THREE.BufferGeometry, color?: Rgb): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (color) {
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, tiltX = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tiltX) g.rotateX(tiltX);
  return g.translate(x, y, z);
}

/** Extrusión a lo ancho (eje x) de un perfil lateral (z, y), centrada en `x`. El bisel no agranda el perfil. */
function sideExtrude(points: Pt[], width: number, bevel: number, curveSegments: number, x = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(width - 2 * bevel, 1e-3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
  });
  // (x del perfil, y, z de extrusión) → (z del carro, y, −x del carro).
  g.rotateY(-Math.PI / 2);
  return g.translate(depth / 2 + x, 0, 0);
}

/** Polígono plano en un costado (x fijo), con la cara hacia afuera. */
function sidePlane(points: Pt[], x: number): THREE.BufferGeometry {
  // ShapeGeometry mira a +z; girado ±90° mira a ±x. Del lado derecho el perfil va espejado
  // para que, tras el giro, z siga creciendo hacia atrás sin invertir el orden de los vértices.
  const s = x < 0 ? 1 : -1;
  const g = new THREE.ShapeGeometry(new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(s * z, y))));
  g.rotateY(-s * (Math.PI / 2));
  return g.translate(x, 0, 0);
}

/**
 * Vidrio de lado a lado entre dos bordes (z0,y0) → (z1,y1), levemente abombado hacia afuera
 * (parabrisas y luneta), con `columns` franjas a lo ancho.
 */
function curvedGlass(halfWidth: number, a: Pt, b: Pt, bulge: number, outward: number, columns: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const at = (u: number, top: boolean): [number, number, number] => {
    const x = -halfWidth + 2 * halfWidth * u;
    const bow = bulge * (1 - (2 * u - 1) ** 2);
    const [z, y] = top ? b : a;
    return [x, y, z + outward * bow];
  };
  for (let c = 0; c < columns; c++) {
    const u0 = c / columns;
    const u1 = (c + 1) / columns;
    const p00 = at(u0, false);
    const p10 = at(u1, false);
    const p01 = at(u0, true);
    const p11 = at(u1, true);
    pos.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Media caña dentro del arco de rueda (el pasarruedas oscuro), de lado a lado. */
function archLiner(axleZ: number, centerY: number, radius: number, fromAngle: number, halfWidth: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const to = Math.PI - fromAngle;
  for (let k = 0; k < segments; k++) {
    const t0 = fromAngle + ((to - fromAngle) * k) / segments;
    const t1 = fromAngle + ((to - fromAngle) * (k + 1)) / segments;
    const z0 = axleZ + radius * Math.cos(t0);
    const y0 = centerY + radius * Math.sin(t0);
    const z1 = axleZ + radius * Math.cos(t1);
    const y1 = centerY + radius * Math.sin(t1);
    pos.push(-halfWidth, y0, z0, halfWidth, y0, z0, halfWidth, y1, z1, -halfWidth, y0, z0, halfWidth, y1, z1, -halfWidth, y1, z1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Puntos del arco de rueda en el perfil lateral, de atrás hacia adelante (ángulo θ0 → π−θ0). */
function arch(axleZ: number, centerY: number, radius: number, fromAngle: number, segments: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= segments; k++) {
    const t = fromAngle + ((Math.PI - 2 * fromAngle) * k) / segments;
    out.push([axleZ + radius * Math.cos(t), centerY + radius * Math.sin(t)]);
  }
  return out;
}

export interface CarModel {
  /** Pose del carro en el mundo (origen = centro de gravedad a ras de suelo). */
  readonly group: THREE.Group;
  /** Carrocería (se inclina con la suspensión; las ruedas no). */
  readonly body: THREE.Group;
  /** Donde se sienta el conductor (hijo de `body`). */
  readonly seat: THREE.Object3D;
  /** Ojos del conductor para la primera persona (hijo de `body`). */
  readonly eye: THREE.Object3D;
  /** Distancias desde el centro de gravedad: eje delantero (a), trasero (b), frente y cola de la carrocería. */
  readonly a: number;
  readonly b: number;
  readonly front: number;
  readonly rear: number;
  setWheels(steer: number, spinFront: number, spinRear: number, lift: number[]): void;
  setLights(brake: boolean, reverse: boolean): void;
  /** Faros: punto medio entre las dos lámparas, mirando hacia adelante y un poco abajo (hijo de `body`). */
  readonly headlight: THREE.Object3D;
  /** Brillo de los faros de noche (0 = de día, solo las luces de posición; 1 = encendidos). */
  setHeadlights(level: number): void;
  dispose(): void;
}

export function createCarModel(cfg: VehicleConfig): CarModel {
  const b = cfg.body;
  const d = cfg.details;
  const inn = cfg.interior;
  const deg = THREE.MathUtils.degToRad;
  const W = b.width;
  const half = W / 2;
  const R = b.wheelRadius;
  const A = R + b.archClearance;
  const c = b.clearance;

  // Estaciones a lo largo (z hacia atrás desde el eje delantero).
  const zF = -b.frontOverhang;
  const zR = b.length - b.frontOverhang;
  const axleR = b.wheelbase;
  const zWs = zF + b.hoodLength;
  const zWsTop = zWs + b.windshieldRun;
  const zRoofEnd = zWsTop + b.roofLength;
  const zRw = zRoofEnd + b.rearWindowRun;
  const zDoorF = A + b.fenderBehindArch;
  const zDoorR = axleR - A - b.fenderAheadOfArch;
  const zB = (zDoorF + zDoorR) / 2;
  const theta0 = Math.asin(THREE.MathUtils.clamp((c - R) / A, -1, 1));
  const archSegs = Math.max(6, Math.round(b.curveSegments * 1.2));
  const gx = half - b.cabinInset;

  const paint: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const misc: THREE.BufferGeometry[] = [];
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  const reverse: THREE.BufferGeometry[] = [];
  const trim = new THREE.Color(cfg.trimColor);
  const interior = new THREE.Color(cfg.interiorColor);
  const plate = new THREE.Color(cfg.plateColor);

  // --- Carrocería: guardafango delantero con capó, guardafango trasero con maletero, puertas, piso.
  const nose = b.noseRound;
  const frontBlock: Pt[] = [
    [zF + nose * 0.4, c + nose * 0.4],
    [zF, c + nose],
    [zF - 0.01, b.bumperHeight],
    [zF + nose * 0.25, b.hoodHeight - nose * 0.45],
    [zF + nose, b.hoodHeight],
    [zWs, b.beltHeight],
    [zDoorF, b.beltHeight],
    [zDoorF, c],
    ...arch(0, R, A, theta0, archSegs),
  ];
  paint.push(part(sideExtrude(frontBlock, W, b.bevel, b.curveSegments)));
  const tailR = b.tailRound;
  const rearBlock: Pt[] = [
    [zDoorR, c],
    [zDoorR, b.beltHeight],
    [zRw, b.trunkHeight],
    [zR - tailR, b.trunkHeight],
    [zR - tailR * 0.15, b.trunkHeight - tailR * 0.4],
    [zR + 0.01, b.bumperHeight],
    [zR, c + tailR],
    [zR - tailR * 0.6, c + tailR * 0.4],
    ...arch(axleR, R, A, theta0, archSegs),
  ];
  paint.push(part(sideExtrude(rearBlock, W, b.bevel, b.curveSegments)));
  const doorPts: Pt[] = [
    [zDoorF + d.seam, c + b.doorBevel],
    [zDoorF + d.seam, b.beltHeight],
    [zDoorR - d.seam, b.beltHeight],
    [zDoorR - d.seam, c + b.doorBevel],
  ];
  for (const s of [-1, 1]) {
    paint.push(part(sideExtrude(doorPts, b.doorThickness, b.doorBevel, 1, s * (half - b.doorThickness / 2))));
    // Repisa sobre la puerta hasta el vidrio (burlete oscuro, como en los carros reales: por
    // dentro no se ve la pintura), y línea entre la puerta delantera y la trasera.
    const ledge = half - b.doorThickness - gx;
    misc.push(part(box(ledge + d.seam, b.doorBevel * 2, zDoorR - zDoorF, s * (gx + ledge / 2), b.beltHeight - b.doorBevel, (zDoorF + zDoorR) / 2), trim));
    misc.push(part(box(d.seam, b.beltHeight - c - 2 * b.doorBevel, d.seam, s * half, (b.beltHeight + c) / 2, zB), trim));
    // Manillas, estribo y espejo.
    const hd = d.handle;
    for (const z0 of [zDoorF, zB]) {
      misc.push(part(box(hd.size[0], hd.size[1], hd.size[2], s * (half + hd.size[0] / 2), b.beltHeight - hd.drop, z0 + hd.back), trim));
    }
    misc.push(part(box(d.rocker.size[0], d.rocker.size[1], zDoorR - zDoorF, s * (half - d.rocker.size[0] / 2 + d.seam), c + d.rocker.rise, (zDoorF + zDoorR) / 2), trim));
    const mr = d.mirror;
    paint.push(part(box(mr.size[0], mr.size[1], mr.size[2], s * (half + mr.out), b.beltHeight + mr.rise, zWs + mr.back)));
  }
  misc.push(part(archLiner(0, R, A - d.liner, theta0, half - d.liner, archSegs), trim));
  misc.push(part(archLiner(axleR, R, A - d.liner, theta0, half - d.liner, archSegs), trim));

  // --- Invernadero: vidrios, techo y pilares.
  const sideGlass: Pt[] = [
    [zWs, b.beltHeight],
    [zWsTop, b.roofHeight],
    [zRoofEnd, b.roofHeight],
    [zRw, b.trunkHeight],
  ];
  for (const s of [-1, 1]) glass.push(part(sidePlane(sideGlass, s * gx)));
  glass.push(part(curvedGlass(gx, [zWs, b.beltHeight], [zWsTop, b.roofHeight], b.windshieldBulge, -1, b.glassColumns)));
  glass.push(part(curvedGlass(gx, [zRw, b.trunkHeight], [zRoofEnd, b.roofHeight], b.windshieldBulge, 1, b.glassColumns)));
  const roof: Pt[] = [
    [zWsTop - b.pillarWidth, b.roofHeight - b.roofThickness],
    [zWsTop + b.pillarWidth, b.roofHeight + b.roofCrown],
    [zRoofEnd - b.pillarWidth, b.roofHeight + b.roofCrown],
    [zRoofEnd + b.pillarWidth, b.roofHeight - b.roofThickness],
  ];
  paint.push(part(sideExtrude(roof, 2 * gx + 2 * d.seam, b.roofThickness / 2, 1)));
  const pw = b.pillarWidth;
  const aLen = Math.hypot(b.windshieldRun, b.roofHeight - b.beltHeight);
  const aTilt = Math.atan2(b.windshieldRun, b.roofHeight - b.beltHeight);
  for (const s of [-1, 1]) {
    const px = s * (gx - pw / 2 + d.seam);
    paint.push(part(box(pw, aLen, pw, px, (b.beltHeight + b.roofHeight) / 2, (zWs + zWsTop) / 2, aTilt)));
    paint.push(part(box(pw, b.roofHeight - b.beltHeight, b.bPillarDepth, px, (b.beltHeight + b.roofHeight) / 2, zB)));
    const cPillar: Pt[] = [
      [zRoofEnd - b.cPillarReach * 0.6, b.roofHeight - d.seam],
      [zRoofEnd + d.seam, b.roofHeight - d.seam],
      [zRw + d.seam, b.trunkHeight],
      [zRw - b.cPillarReach, b.beltHeight + (b.trunkHeight - b.beltHeight) * 0.5],
    ];
    paint.push(part(sideExtrude(cPillar, pw / 2, 0, 1, s * (gx + d.seam))));
  }

  // --- Frente y cola.
  const hl = d.headlight;
  const tl = d.taillight;
  const rl = d.reverseLight;
  for (const s of [-1, 1]) {
    head.push(part(box(hl.size[0], hl.size[1], hl.size[2], s * (half - hl.inset), b.hoodHeight - hl.drop, zF + nose * 0.2)));
    tail.push(part(box(tl.size[0], tl.size[1], tl.size[2], s * (half - tl.inset), b.trunkHeight - tl.drop, zR - tl.size[2] / 3)));
    reverse.push(part(box(rl.size[0], rl.size[1], rl.size[2], s * (half - rl.inset), b.trunkHeight - rl.drop, zR - rl.size[2] / 3)));
  }
  const gr = d.grille;
  misc.push(part(box(gr.size[0], gr.size[1], gr.size[2], 0, b.bumperHeight + gr.rise, zF + gr.size[2] / 4), trim));
  const it = d.intake;
  misc.push(part(box(it.size[0], it.size[1], it.size[2], 0, c + it.rise, zF + nose * 0.2), trim));
  misc.push(part(box(it.size[0], it.size[1], it.size[2], 0, c + it.rise, zR - tailR * 0.15), trim));
  const pl = d.plate;
  misc.push(part(box(pl.size[0], pl.size[1], pl.size[2], 0, c + pl.frontRise, zF - 0.01 - pl.size[2] / 2), plate));
  misc.push(part(box(pl.size[0], pl.size[1], pl.size[2], 0, b.bumperHeight + pl.rearRise, zR + 0.01 + pl.size[2] / 2), plate));

  // --- Interior: piso, tablero con instrumentos, consola, paneles de puerta, techo, asientos y
  // volante. Pensado para verse de cerca en primera persona: tonos que se distinguen entre sí
  // (el volante negro contra un tablero gris, no negro sobre negro) y forros donde por dentro
  // se vería la pintura (puertas, pilares, techo, el muro del guardafango bajo el tablero).
  const col = (hex: string): Rgb => new THREE.Color(hex);
  const ic = inn.colors;
  const inner = W - 2 * b.doorThickness;
  misc.push(part(box(inner, inn.floorThickness, zDoorR - zDoorF + 2 * b.bevel, 0, inn.floorHeight, (zDoorF + zDoorR) / 2), interior));
  const dash = inn.dash;
  const dashTop = b.beltHeight + dash.rise;
  const dashBottom = dashTop - dash.height;
  const dashBack = zWs + dash.depth;
  // Perfil del tablero: sube desde el parabrisas, techo plano, canto redondeado hacia el
  // conductor y la cara de abajo inclinada hacia adelante (espacio para las rodillas).
  const dashProfile: Pt[] = [
    [zWs, b.beltHeight],
    [zWs + dash.depth * dash.slopeShare, dashTop],
    [dashBack - dash.lip, dashTop],
    [dashBack, dashTop - dash.lip],
    [dashBack - dash.lip, dashBottom],
    [zWs, dashBottom],
  ];
  misc.push(part(sideExtrude(dashProfile, inner, dash.bevel, 1), col(ic.dash)));
  // Muro del guardafango bajo el tablero (por dentro se vería la pintura).
  misc.push(part(box(inner, dashBottom - inn.floorHeight, inn.floorThickness, 0, (dashBottom + inn.floorHeight) / 2, zDoorF + inn.floorThickness), col(ic.console)));
  // Tablero de instrumentos frente al conductor: visera y dos relojes mirando al asiento.
  const cl = inn.cluster;
  const clusterZ = dashBack - dash.lip - cl.depth / 2;
  misc.push(part(box(cl.width, cl.height, cl.depth, inn.seat.x, dashTop + cl.height / 2, clusterZ), col(ic.cluster)));
  // Cada reloj: esfera oscura, bisel claro y aguja (velocímetro y revoluciones, en reposo).
  cl.needleAnglesDeg.forEach((needleDeg, k) => {
    const x = inn.seat.x + ((k * 2 - 1) * cl.dialGap) / 2;
    const y = dashTop + cl.height * 0.45;
    const z = clusterZ + cl.depth / 2 + cl.dialDepth / 2;
    const face = new THREE.CylinderGeometry(cl.dialRadius, cl.dialRadius, cl.dialDepth, 24);
    face.rotateX(Math.PI / 2);
    misc.push(part(face.translate(x, y, z), col(ic.gaugeFace)));
    misc.push(part(new THREE.TorusGeometry(cl.dialRadius, cl.bezel, 6, 24).translate(x, y, z + cl.dialDepth / 2), col(ic.gaugeBezel)));
    const [length, width] = cl.needle;
    const t = deg(needleDeg);
    const needle = new THREE.BoxGeometry(length, width, cl.dialDepth);
    needle.translate(length / 2, 0, 0).rotateZ(t);
    misc.push(part(needle.translate(x, y, z + cl.dialDepth), col(ic.needle)));
  });
  // Consola: columna central bajo el tablero y túnel entre los asientos.
  const cs = inn.console;
  misc.push(part(box(cs.width, dashBottom - inn.floorHeight, cs.stackDepth, 0, (dashBottom + inn.floorHeight) / 2, dashBack - dash.lip - cs.stackDepth / 2), col(ic.console)));
  misc.push(part(box(cs.width, cs.tunnelHeight, cs.tunnelLength, 0, inn.floorHeight + cs.tunnelHeight / 2, inn.seat.z - cs.tunnelLength / 4), col(ic.console)));
  // Paneles de puerta tapizados, con apoyabrazos.
  const dc = inn.doorCard;
  for (const s of [-1, 1]) {
    const cardX = s * (half - b.doorThickness - dc.thickness / 2);
    misc.push(part(box(dc.thickness, b.beltHeight - inn.floorHeight, zDoorR - zDoorF, cardX, (b.beltHeight + inn.floorHeight) / 2, (zDoorF + zDoorR) / 2), col(ic.panel)));
    const [aw, ah, ad] = dc.armrest;
    misc.push(part(box(aw, ah, ad, s * (half - b.doorThickness - dc.thickness - aw / 2), dc.armrestHeight, inn.seat.z), col(ic.console)));
  }
  // Techo interior y forro de los pilares A y B.
  const hl2 = inn.headliner;
  misc.push(
    part(
      box(2 * gx, hl2.thickness, zRoofEnd - zWsTop + 2 * b.pillarWidth, 0, b.roofHeight - b.roofThickness - hl2.gap - hl2.thickness / 2, (zWsTop + zRoofEnd) / 2),
      col(ic.headliner),
    ),
  );
  {
    const pw = b.pillarWidth;
    const aLen = Math.hypot(b.windshieldRun, b.roofHeight - b.beltHeight);
    const aTilt = Math.atan2(b.windshieldRun, b.roofHeight - b.beltHeight);
    // El forro envuelve el pilar por dentro y por sus caras de adelante y atrás; solo queda
    // afuera una franja de pintura junto al vidrio (`pillarEdge`).
    const t = inn.pillarTrim;
    const outer = gx + d.seam - inn.pillarEdge;
    const inside = gx + d.seam - pw - t;
    for (const s of [-1, 1]) {
      const tx = (s * (outer + inside)) / 2;
      const tw = outer - inside;
      misc.push(part(box(tw, aLen, pw + 2 * t, tx, (b.beltHeight + b.roofHeight) / 2, (zWs + zWsTop) / 2, aTilt), col(ic.headliner)));
      misc.push(part(box(tw, b.roofHeight - b.beltHeight, b.bPillarDepth + 2 * t, tx, (b.beltHeight + b.roofHeight) / 2, zB), col(ic.headliner)));
    }
  }
  const ss = inn.seatSize;
  const seat = inn.seat;
  for (const s of [-1, 1]) {
    const sx = s * Math.abs(seat.x);
    const cushionTop = seat.y + ss.cushionHeight;
    misc.push(part(box(ss.width, ss.cushionHeight, ss.cushion, sx, seat.y + ss.cushionHeight / 2, seat.z), interior));
    const tilt = deg(ss.backTiltDeg);
    const backZ = seat.z + ss.cushion / 2 + (ss.back / 2) * Math.sin(tilt);
    misc.push(part(box(ss.width, ss.back, ss.backThickness, sx, cushionTop + (ss.back / 2) * Math.cos(tilt), backZ, tilt), interior));
    const [hw, hh, hdp] = ss.headrest;
    misc.push(part(box(hw, hh, hdp, sx, cushionTop + ss.back * Math.cos(tilt) + hh / 2, backZ + (ss.back / 2) * Math.sin(tilt)), interior));
  }
  misc.push(part(box(inn.rearBench.width, ss.cushionHeight, ss.cushion, 0, seat.y + ss.cushionHeight / 2, inn.rearBench.z), interior));
  // Volante: aro, centro y rayos en el plano del volante (su eje mira al conductor, `tiltDeg`
  // por encima de la horizontal); la columna sale hacia el tablero.
  const sw = inn.steeringWheel;
  const swTilt = deg(sw.tiltDeg);
  const wheelParts: THREE.BufferGeometry[] = [];
  const wheelColor = col(ic.wheel);
  wheelParts.push(part(new THREE.TorusGeometry(sw.radius, sw.thickness, 8, 32), wheelColor));
  const hub = new THREE.CylinderGeometry(sw.hubRadius, sw.hubRadius, sw.hubDepth, 16);
  hub.rotateX(Math.PI / 2);
  wheelParts.push(part(hub, col(ic.hub)));
  const spokeLength = sw.radius - sw.hubRadius;
  for (const a of sw.spokeAnglesDeg) {
    const t = deg(a);
    const r = sw.hubRadius + spokeLength / 2;
    const spoke = new THREE.BoxGeometry(spokeLength, sw.spokeWidth, sw.thickness * 1.5);
    spoke.rotateZ(t);
    wheelParts.push(part(spoke.translate(r * Math.cos(t), r * Math.sin(t), 0), wheelColor));
  }
  for (const g of wheelParts) misc.push(g.rotateX(-swTilt).translate(seat.x, sw.y, sw.z));
  const columnLength = sw.radius * 1.6;
  const column = new THREE.CylinderGeometry(sw.thickness * 1.6, sw.thickness * 1.6, columnLength, 8);
  column.rotateX(Math.PI / 2 - swTilt);
  const cx = (columnLength / 2) * Math.sin(swTilt);
  const cz = (columnLength / 2) * Math.cos(swTilt);
  misc.push(part(column.translate(seat.x, sw.y - cx, sw.z - cz), trim));

  // --- Materiales (compartidos por todas las piezas de su tipo).
  const paintMat = new THREE.MeshPhysicalMaterial({
    color: cfg.paint,
    metalness: cfg.paintMetalness,
    roughness: cfg.paintRoughness,
    clearcoat: cfg.paintClearcoat,
    clearcoatRoughness: cfg.paintClearcoatRoughness,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: cfg.glass.color,
    roughness: cfg.glass.roughness,
    metalness: 0,
    transparent: true,
    opacity: cfg.glass.opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const miscMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
  const headMat = new THREE.MeshStandardMaterial({
    color: cfg.headlightColor,
    emissive: cfg.headlightColor,
    emissiveIntensity: cfg.headlightGlow,
    roughness: 0.15,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: cfg.taillightColor,
    emissive: cfg.taillightColor,
    emissiveIntensity: cfg.taillightGlow,
    roughness: 0.2,
  });
  const reverseMat = new THREE.MeshStandardMaterial({
    color: cfg.headlightColor,
    emissive: cfg.headlightColor,
    emissiveIntensity: 0,
    roughness: 0.2,
  });

  const group = new THREE.Group();
  group.name = 'car';
  const body = new THREE.Group();
  group.add(body);
  // Centro de gravedad: `frontWeightShare` del peso sobre el eje delantero.
  const aDist = b.wheelbase * (1 - cfg.physics.frontWeightShare);
  const shift = new THREE.Vector3(0, 0, -aDist);
  const meshes: THREE.Mesh[] = [];
  const add = (list: THREE.BufferGeometry[], mat: THREE.Material, shadow: boolean): THREE.Mesh => {
    const geometry = mergeGeometries(list);
    for (const g of list) g.dispose();
    geometry.translate(shift.x, shift.y, shift.z);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    body.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  add(paint, paintMat, true);
  add(misc, miscMat, true);
  add(head, headMat, false);
  add(tail, tailMat, false);
  add(reverse, reverseMat, false);
  // Primera persona: los vidrios van solo en la pasada de la cabina (ver render/cockpit.ts).
  add(glass, glassMat, false).userData.cockpitPass = 'cockpit' satisfies CockpitPass;

  const seatNode = new THREE.Object3D();
  // El personaje se sienta sobre el cojín; `driver` corrige según la pose de su animación.
  seatNode.position.set(seat.x, seat.y + ss.cushionHeight - inn.driver.drop, seat.z + inn.driver.back).add(shift);
  body.add(seatNode);
  const eye = new THREE.Object3D();
  eye.position.set(inn.eye.x, inn.eye.y, inn.eye.z).add(shift);
  body.add(eye);
  const headlight = new THREE.Object3D();
  headlight.position.set(0, b.hoodHeight - hl.drop, zF + nose * 0.2).add(shift);
  headlight.rotation.x = deg(cfg.headlights.pitchDeg);
  body.add(headlight);

  // --- Ruedas: llanta (goma) y aro con rayos, freno y tambor (metal), instanciadas.
  const wc = cfg.wheel;
  const rimR = R * wc.rimShare;
  const wW = b.wheelWidth;
  const round = wc.sidewallRound;
  const tireProfile = [
    new THREE.Vector2(rimR, -wW / 2),
    new THREE.Vector2(R - round, -wW / 2),
    new THREE.Vector2(R - round * 0.25, -wW / 2 + round * 0.35),
    new THREE.Vector2(R, -wW / 2 + round),
    new THREE.Vector2(R, wW / 2 - round),
    new THREE.Vector2(R - round * 0.25, wW / 2 - round * 0.35),
    new THREE.Vector2(R - round, wW / 2),
    new THREE.Vector2(rimR, wW / 2),
  ];
  const tireGeo = new THREE.LatheGeometry(tireProfile, wc.segments).rotateZ(-Math.PI / 2);
  const rimShape = new THREE.Shape().absarc(0, 0, rimR, 0, Math.PI * 2, false);
  const gap = ((Math.PI * 2) / wc.spokes) * wc.spokeGapShare;
  for (let k = 0; k < wc.spokes; k++) {
    const a0 = (k * Math.PI * 2) / wc.spokes + (Math.PI * 2) / wc.spokes / 2 - gap / 2;
    const hole = new THREE.Path();
    hole.absarc(0, 0, rimR * 0.82, a0, a0 + gap, false);
    hole.absarc(0, 0, rimR * 0.34, a0 + gap, a0, true);
    rimShape.holes.push(hole);
  }
  const rimFace = new THREE.ExtrudeGeometry(rimShape, {
    depth: wc.rimDepth,
    curveSegments: Math.round(wc.segments / 2),
    bevelEnabled: false,
  });
  // Cara del aro hacia +x (afuera en las ruedas derechas; las izquierdas se giran media vuelta).
  rimFace.rotateY(Math.PI / 2).translate(wW / 2 - wc.rimInset - wc.rimDepth, 0, 0);
  const disc = new THREE.CylinderGeometry(rimR * wc.discShare, rimR * wc.discShare, wW * 0.12, wc.segments).rotateZ(Math.PI / 2);
  const barrel = new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, wW * 0.9, wc.segments, 1, true).rotateZ(Math.PI / 2);
  const rimGeo = mergeGeometries([
    part(rimFace, new THREE.Color(cfg.rimColor)),
    part(disc, new THREE.Color(wc.discColor)),
    part(barrel, new THREE.Color(wc.barrelColor)),
  ]);
  const tireMat = new THREE.MeshStandardMaterial({ color: cfg.tireColor, roughness: 0.92, side: THREE.DoubleSide });
  const rimMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.3, side: THREE.DoubleSide });
  const tires = new THREE.InstancedMesh(tireGeo, tireMat, 4);
  const rims = new THREE.InstancedMesh(rimGeo, rimMat, 4);
  for (const m of [tires, rims]) {
    m.castShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }
  const wheelBase: THREE.Vector3[] = [];
  for (const z of [0, axleR]) for (const s of [-1, 1]) wheelBase.push(new THREE.Vector3((s * b.track) / 2, R, z).add(shift));

  // --- Sombra de contacto: el carro "pisa" el suelo aunque el mapa de sombras sea grueso.
  const sh = cfg.shadow;
  const canvas = document.createElement('canvas');
  canvas.width = sh.texture;
  canvas.height = sh.texture;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(sh.texture / 2, sh.texture / 2, 0, sh.texture / 2, sh.texture / 2, sh.texture / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, sh.texture, sh.texture);
  const shadowTex = new THREE.CanvasTexture(canvas);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    opacity: sh.opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const shadowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(W * sh.widthScale, b.length * sh.lengthScale).rotateX(-Math.PI / 2),
    shadowMat,
  );
  shadowMesh.position.set(0, sh.lift, (zF + zR) / 2 - aDist);
  shadowMesh.renderOrder = -1;
  shadowMesh.userData.cockpitPass = 'world' satisfies CockpitPass;
  group.add(shadowMesh);
  // Luz de los postes y de los propios faros sobre la carrocería de noche.
  addNightLight(group);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();

  return {
    group,
    body,
    seat: seatNode,
    eye,
    a: aDist,
    b: b.wheelbase - aDist,
    front: aDist + b.frontOverhang,
    rear: b.length - b.frontOverhang - aDist,
    headlight,
    setWheels(steer, spinFront, spinRear, lift) {
      for (let k = 0; k < 4; k++) {
        const front = k < 2;
        const left = k % 2 === 0;
        const spin = front ? spinFront : spinRear;
        // Las ruedas izquierdas van giradas media vuelta: su giro sobre x va al revés.
        e.set(left ? -spin : spin, (front ? steer : 0) + (left ? Math.PI : 0), 0);
        q.setFromEuler(e);
        pos.copy(wheelBase[k]);
        pos.y += lift[k];
        m4.compose(pos, q, one);
        tires.setMatrixAt(k, m4);
        rims.setMatrixAt(k, m4);
      }
      tires.instanceMatrix.needsUpdate = true;
      rims.instanceMatrix.needsUpdate = true;
    },
    setLights(brake, rev) {
      tailMat.emissiveIntensity = brake ? cfg.brakeGlow : cfg.taillightGlow;
      reverseMat.emissiveIntensity = rev ? cfg.reverseGlow : 0;
    },
    setHeadlights(level) {
      headMat.emissiveIntensity = THREE.MathUtils.lerp(cfg.headlightGlow, cfg.headlights.lensGlow, level);
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      for (const mat of [paintMat, glassMat, miscMat, headMat, tailMat, reverseMat, tireMat, rimMat, shadowMat]) mat.dispose();
      tireGeo.dispose();
      rimGeo.dispose();
      shadowTex.dispose();
      shadowMesh.geometry.dispose();
      group.removeFromParent();
    },
  };
}
