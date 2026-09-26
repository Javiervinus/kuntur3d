import * as THREE from 'three';
import {
  Bins,
  type Ctx,
  type MallCanopy,
  type MallDome,
  type MallEquipment,
  type MallFace,
  type MallMast,
  type MallSign,
  type MallSkin,
  type MallSkylight,
  type MallSolar,
  type MallVolume,
  LETTERS,
  MITER,
  type Outline,
  type Piece,
  Skins,
  buildCanopy,
  buildDome,
  buildEquipment,
  buildMasts,
  buildShell,
  buildSign,
  buildSkylight,
  buildSolar,
  canopyLights,
  chainOf,
  materialOf,
  outline,
  pointAt,
  polyBoxes,
  signFace,
} from './mallParts';
import {
  type MallBridge,
  type MallSite,
  type MallStair,
  buildBillboard,
  buildBollards,
  buildBridge,
  buildFence,
  buildFountain,
  buildLamps,
  buildMotos,
  buildPaved,
  buildPlanter,
  buildShelter,
  buildStair,
  buildTowers,
  lampGeometry,
  lampLights,
  park,
  plant,
} from './mallSite';
import { type Glow, patternOf } from './monumentParts';
import type { Finish } from './monuments';
import { type MallLot, buildDeck, buildLot, checkDeck, checkLot } from './parking';
import type { PlaceKit, PlaceType } from './placeKit';
import type { RetiroStyle } from './streetLots';

/**
 * Un centro comercial, por fuera (tipo `mall`, config/sites/<archivo>.json; en config/game.json
 * → monuments.list va solo su marco: lat/lon del origen, rumbo del eje x y el nombre del archivo).
 * Todo en el marco local (x al rumbo, z a la derecha; z negativa, a la izquierda) y en m; las
 * alturas, sobre el suelo de cada volumen (su base es la mediana del terreno a lo largo de su
 * planta; lo que baja de ahí se entierra). Cada dato con su fuente y su fecha; lo estimado se dice.
 */
export interface MallFile {
  name: string;
  /** De dónde salió cada dato (fotos, satélite, planos, Street View solo mirado), con su fecha. */
  sources: string[];
  /**
   * Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos, además de
   * las plantas de los volúmenes y de los parqueaderos (que se despejan solas): las plazas, las
   * veredas y lo que haya entre volúmenes.
   */
  clear: number[][][];
  /**
   * Pisos que siguen el terreno: `step`, largo de cada tramo (y ancho de las franjas con que la
   * física cubre una losa: parqueos, volúmenes sobre un parqueo); `lift`, cuánto quedan sobre el
   * suelo; `bury`, cuánto se entierran los muros bajo el punto más bajo; `wall`, grosor de la
   * física de las vallas y del cierre de atrás de las franjas que suben sobre la azotea.
   */
  ground: { step: number; lift: number; bury: number; wall: number };
  /**
   * Hasta qué distancia (m al centro de su pedazo) se ve lo chico; largo máximo de los tramos de un
   * arco; lados de lo redondo (pilares, pilas, ventiladores); lados de lo redondo chico (barandas,
   * bolardos, antenas, chorros, ruedas); tramos mínimos de cualquier arco, por chico que sea;
   * `film`: cuánto se separan dos capas que se tapan (el paño de un arco delante de su muro, el
   * ventilador sobre la tapa de su equipo), m: al menos 1 cm, o titilan de lejos (pitfalls.md →
   * caras en el mismo plano).
   */
  detail: { near: number; arc: number; sides: number; small: number; curve: number; film: number };
  /**
   * Acabados por nombre (world/monuments.ts → Finish: rugosidad, metal, opacidad, calado) que
   * usan las pieles con `material`. `rails` (calado) lo piden las rejas y los parqueaderos, y
   * `letters` (calado) los letreros de letras sueltas.
   */
  finishes: Record<string, Finish>;
  /** Luces de noche por nombre (las pieles con `glow`); `sign` es la de los letreros. */
  lights: Record<string, Glow>;
  /** Pieles por nombre (world/mallParts.ts → MallSkin). */
  skins: Record<string, MallSkin>;
  /** Los cuerpos del edificio, en orden (uno con `on` va después de aquel en que se apoya). */
  volumes: MallVolume[];
  /** Marquesinas de las entradas (se caminan por debajo). */
  canopies: MallCanopy[];
  /** Letreros (solo el nombre; comparten el atlas con las calles: pocos y con `res` baja si son grandes). */
  signs: MallSign[];
  /** Lucernarios, cúpulas, equipos de aire, paneles solares y antenas de los techos. */
  skylights: MallSkylight[];
  domes: MallDome[];
  equipment: MallEquipment[];
  solar: MallSolar[];
  masts: MallMast[];
  /** Puentes peatonales y escaleras al aire libre. */
  bridges: MallBridge[];
  stairs: MallStair[];
  /** Parqueaderos a nivel y los estilos de sus hileras (world/streetLots.ts → RetiroStyle). */
  lots: MallLot[];
  retiros: Record<string, RetiroStyle>;
  /** Lo de alrededor: pisos, rejas, bolardos, jardineras, paradas, fuentes, vallas, postes, autos sueltos, palmeras y árboles. */
  site: MallSite;
}

const PHYSICS = ['block', 'raised', 'none'];
const ROOFS = ['flat', 'gable', 'hip', 'shed', 'vault', 'sawtooth'];
/** Los techos con alero (`roof.eave`) y lo de abajo (`roof.under`). */
const EAVED = ['gable', 'hip', 'shed'];

/** Las claves que todo archivo de un mall trae (aunque sean listas vacías). */
const KEYS: (keyof MallFile)[] = ['name', 'sources', 'clear', 'ground', 'detail', 'finishes', 'lights', 'skins', 'volumes', 'canopies', 'signs', 'skylights', 'domes', 'equipment', 'solar', 'masts', 'bridges', 'stairs', 'lots', 'retiros', 'site'];
const SITE_KEYS: (keyof MallSite)[] = ['pavedStyles', 'paved', 'fenceStyles', 'fences', 'bollards', 'planters', 'shelters', 'fountains', 'billboards', 'lampModels', 'lamps', 'cars', 'palms', 'trees'];
const PLATES = ['rect', 'diamond', 'circle'];
const TOWER_PARTS = ['box', 'flare'];

/** Falla al cargar con un mensaje claro si el archivo trae algo que no cierra (los JSON no se revisan al compilar). */
function check(f: MallFile, where: string): void {
  const bad = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  for (const k of KEYS) if (!(k in f)) bad(`falta "${k}" (world/mall.ts → MallFile)`);
  for (const k of SITE_KEYS) if (!(k in f.site)) bad(`falta "site.${k}" (world/mallSite.ts → MallSite)`);
  // Un lugar terminado trae sus fuentes y sus volúmenes (lo suelto va al pedazo más cercano).
  if (!f.sources.length) bad('sources está vacío: cada dato con su fuente y su fecha');
  if (!f.volumes.length) bad('volumes está vacío: un mall sin volúmenes no está modelado');
  const positive = (v: number, what: string): void => {
    if (!(v > 0)) bad(`${what} tiene que ser mayor que 0`);
  };
  const run = (r: number[] | undefined, what: string): void => {
    if (!r) return;
    if (r.length !== 2 || r[0] < 1 || (r[0] > 1 && !(r[1] > 0))) bad(`${what} tiene que ser [cuántos ≥ 1, cada cuánto > 0]`);
  };
  positive(f.ground.step, 'ground.step');
  positive(f.ground.wall, 'ground.wall');
  positive(f.detail.arc, 'detail.arc');
  positive(f.detail.near, 'detail.near');
  if (f.detail.sides < 3) bad('detail.sides tiene que ser al menos 3');
  if (f.detail.small < 3) bad('detail.small tiene que ser al menos 3');
  if (f.detail.curve < 1) bad('detail.curve tiene que ser al menos 1');
  positive(f.detail.film, 'detail.film');
  for (const [name, s] of Object.entries(f.skins)) {
    if (s.pattern) patternOf(s.pattern);
    if (s.material !== 'stone' && !f.finishes[s.material]) bad(`la piel ${name} pide el acabado "${s.material}", que no está en finishes`);
    if (s.scale && (s.scale.length !== 2 || s.scale.some((v) => !(v > 0)))) bad(`la piel ${name}: scale tiene que ser [a lo largo, a lo alto] mayores que 0`);
  }
  // Todas las pieles que se piden existen (Skins.look falla con el nombre).
  const skins = new Skins(f.skins, f.lights, f.finishes);
  const skin = (name: string): void => void skins.look(name);
  const ids = new Map<string, MallVolume>();
  const outlines = new Map<string, Outline>();
  for (const v of f.volumes) {
    const at = `volumen ${v.id}`;
    if (ids.has(v.id)) bad(`${at} está repetido`);
    if (v.on && !ids.has(v.on)) bad(`${at}: se apoya en "${v.on}", que no está declarado antes`);
    const curved = v.ring.some((p) => (p[2] ?? 0) !== 0);
    if (v.ring.length < 3 && !(v.ring.length === 2 && curved)) bad(`${at}: la planta necesita 3 puntos (o 2 con arcos)`);
    if (!(v.height > v.base)) bad(`${at}: height tiene que ser mayor que base`);
    if (v.parapet.length !== 2) bad(`${at}: parapet es [alto, grosor]`);
    if (!PHYSICS.includes(v.physics)) bad(`${at}: physics "${v.physics}" (hay: ${PHYSICS.join(', ')})`);
    if (!ROOFS.includes(v.roof.kind)) bad(`${at}: techo "${v.roof.kind}" (hay: ${ROOFS.join(', ')})`);
    if (v.roof.kind !== 'flat') {
      if (v.ring.length !== 4 || curved) bad(`${at}: un techo inclinado va sobre una planta de 4 lados rectos`);
      positive(v.roof.rise ?? 0, `${at}: roof.rise`);
      if (v.roof.kind === 'sawtooth') positive(v.roof.teeth ?? 0, `${at}: roof.teeth`);
      if ((v.roof.eave ?? 0) < 0) bad(`${at}: roof.eave no puede ser negativo`);
    }
    // Lo que se ve bajo un techo inclinado: el cielo del alero y su canto (o el techo entero sin muros).
    const U = v.roof.under;
    if (EAVED.includes(v.roof.kind) && ((v.roof.eave ?? 0) > 0 || v.skin === 'open') && !U) bad(`${at}: el techo vuela (eave) o no tiene muros: falta roof.under (cielo del alero y su canto)`);
    if (U) {
      if (!EAVED.includes(v.roof.kind)) bad(`${at}: roof.under va en los techos ${EAVED.join(', ')}`);
      positive(U.fascia, `${at}: roof.under.fascia`);
      skin(U.soffit);
      skin(U.edge);
    }
    skin(v.skin);
    if (v.soffit) skin(v.soffit);
    skin(v.roof.skin);
    if (v.roof.gable) skin(v.roof.gable);
    const o = outline(v.ring, f.detail.arc);
    for (const fc of v.faces) checkFace(fc, o, `${at}, cara ${fc.sides.join('-')}`, bad, positive, run, skin, f.detail.film);
    if (v.deck) {
      checkDeck(v.deck, `${where} → ${at}`);
      for (const k of Object.values(v.deck.skins)) skin(k);
      for (const r of v.deck.ramps) skin(r.skin);
      for (const e of v.deck.entrances) if (e[0] < 0 || e[0] >= o.sides) bad(`${at}: una entrada pide el lado ${e[0]}`);
    }
    ids.set(v.id, v);
    outlines.set(v.id, o);
  }
  const volume = (id: string | undefined, what: string): void => {
    if (id !== undefined && !ids.has(id)) bad(`${what}: el volumen "${id}" no existe`);
  };
  for (const c of f.canopies) {
    volume(c.on, `marquesina ${c.id}`);
    if (c.line.length < 2 || c.line.some((q) => q.length !== 2)) bad(`marquesina ${c.id}: line son dos o más puntos [x, z]`);
    if (!(Math.abs(c.depth) > 0)) bad(`marquesina ${c.id}: depth no puede ser 0`);
    positive(c.thickness, `marquesina ${c.id}: thickness`);
    if (c.nose !== undefined) {
      if (c.line.length !== 2) bad(`marquesina ${c.id}: nose (borde redondeado) va solo en una marquesina recta (line de dos puntos)`);
      if (!(c.nose > c.thickness && c.nose < Math.abs(c.depth))) bad(`marquesina ${c.id}: nose tiene que ser mayor que thickness y menor que el vuelo (depth)`);
      if (!(c.fascia > c.thickness)) bad(`marquesina ${c.id}: con nose, fascia (lo que baja la curva) tiene que ser mayor que thickness`);
    }
    if (c.lamps) {
      positive(c.lamps.every, `marquesina ${c.id}: lamps.every`);
      if (c.lamps.size.length !== 2 || c.lamps.size.some((v) => !(v > 0))) bad(`marquesina ${c.id}: lamps.size es [ancho, alto] mayores que 0`);
      const G = c.lamps.light;
      if (G && (!Number.isInteger(G.every) || G.every < 1)) bad(`marquesina ${c.id}: lamps.light.every (uno de cada cuántos plafones alumbra) es un entero ≥ 1`);
      if (G) positive(G.power, `marquesina ${c.id}: lamps.light.power`);
    }
    Object.values(c.skins).forEach(skin);
    if (c.posts) skin(c.posts.skin);
    if (c.ties) skin(c.ties.skin);
    if (c.lamps) skin(c.lamps.skin);
  }
  for (const s of f.signs) {
    const at = `letrero "${s.text}"`;
    if (!(s.res > 0 && s.res <= 1)) bad(`${at}: res va de 0 a 1`);
    if (s.stretch !== undefined && !(s.stretch > 0)) bad(`${at}: stretch tiene que ser mayor que 0`);
    if (s.size.some((v) => !(v > 0))) bad(`${at}: size tiene que ser mayor que 0`);
    if (s.on) {
      volume(s.on, at);
      const o = outlines.get(s.on) as Outline;
      if (s.side === undefined || s.side < 0 || s.side >= o.sides) bad(`${at}: el volumen ${s.on} no tiene el lado ${s.side}`);
      if (s.u === undefined && s.x === undefined && s.z === undefined) bad(`${at}: falta dónde va a lo largo del lado (u, x o z)`);
    } else if (!s.at || s.angle === undefined) bad(`${at}: va pegado a un volumen (on, side) o suelto (at, angle)`);
    if (s.follow && (!s.on || (s.depth ?? 0) > 0 || s.pole || s.stand || s.back)) bad(`${at}: follow es para la cara de un letrero pegado a un volumen, sin caja (depth 0), tótem, patas ni revés`);
    if (!s.glow && !f.lights.sign) bad(`${at}: falta la luz de los letreros (lights.sign) o la suya (glow)`);
    for (const pl of s.plates ?? []) {
      if (!PLATES.includes(pl.shape)) bad(`${at}: placa "${pl.shape}" (hay: ${PLATES.join(', ')})`);
      if (pl.size.length !== 2 || pl.size.some((v) => !(v > 0))) bad(`${at}: el tamaño de una placa es [ancho, alto] mayores que 0`);
      if (pl.offset.length !== 2) bad(`${at}: el corrimiento de una placa es [du, dy]`);
    }
  }
  for (const s of f.skylights) {
    volume(s.on, 'lucernario');
    positive(s.width, 'lucernario: width');
    if (s.kind !== 'flat') positive(s.rise, 'lucernario: rise');
    if (s.grid && (s.grid.length !== 4 || s.grid[0] < 1 || s.grid[2] < 1)) bad('lucernario: grid es [cuántos, cada cuánto, cuántos, cada cuánto]');
    Object.values(s.skins).forEach(skin);
  }
  for (const d of f.domes) {
    volume(d.on, 'cúpula');
    positive(d.radius, 'cúpula: radius');
    if (!(d.arc > 0 && d.arc <= 360)) bad('cúpula: arc va de 0 a 360 grados');
    if (d.ribs > 0) positive(d.rib, 'cúpula: rib');
    Object.values(d.skins).forEach(skin);
  }
  for (const e of f.equipment) {
    volume(e.on, 'equipos');
    if (e.count < 0) bad('equipos: count no puede ser negativo');
    if (e.size.length !== 2 || e.size.some((s) => s.length !== 3 || s.some((v) => !(v > 0)))) bad('equipos: size es [[ancho, fondo, alto] mín., [ancho, fondo, alto] máx.]');
    if (e.fan.radius < 0 || 2 * e.fan.radius > Math.min(e.size[0][0], e.size[0][1])) bad('equipos: el ventilador (fan.radius) cabe en la tapa del equipo más chico');
    skin(e.skin);
    skin(e.fan.skin);
  }
  for (const s of f.solar) {
    volume(s.on, 'paneles solares');
    positive(s.pitch, 'paneles solares: pitch');
    skin(s.skin);
  }
  for (const m of f.masts) {
    volume(m.on, 'antenas');
    skin(m.skin);
    skin(m.heads.skin);
  }
  for (const b of f.bridges) {
    positive(b.truss.panel, `puente ${b.id}: truss.panel`);
    positive(b.width, `puente ${b.id}: width`);
    if (b.line.length !== 2) bad(`puente ${b.id}: line son dos puntos`);
    if (!['warren', 'pratt'].includes(b.truss.kind)) bad(`puente ${b.id}: truss.kind (hay: warren, pratt)`);
    const len = Math.hypot(b.line[1][0] - b.line[0][0], b.line[1][1] - b.line[0][1]);
    for (const g of b.gaps ?? []) if (g.length !== 3 || Math.abs(g[0]) !== 1 || !(g[1] >= 0 && g[2] > g[1] && g[2] <= len)) bad(`puente ${b.id}: cada hueco (gaps) es [costado 1 o −1, desde, hasta] dentro del largo (${len.toFixed(1)} m)`);
    Object.values(b.skins).forEach(skin);
    skin(b.piers.skin);
    if (b.banner) skin(b.banner.skin);
  }
  for (const s of f.stairs) {
    positive(s.riser, `escalera ${s.id}: riser`);
    positive(s.rise, `escalera ${s.id}: rise`);
    positive(s.posts, `escalera ${s.id}: posts`);
    Object.values(s.skins).forEach(skin);
  }
  const rails = f.lots.length > 0 || f.site.fences.length > 0;
  if (rails && !f.finishes.rails?.cutout) bad('las rejas y los parqueaderos piden el acabado calado finishes.rails (cutout: true)');
  if (f.signs.some((s) => s.depth === 0) && !f.finishes[LETTERS]?.cutout) bad(`los letreros de letras sueltas (depth 0) piden el acabado calado finishes.${LETTERS} (cutout: true)`);
  for (const l of f.lots) {
    checkLot(l, f.retiros, where);
    skin(l.skin);
  }
  const S = f.site;
  for (const p of S.paved) {
    const st = S.pavedStyles[p.style];
    if (!st) bad(`piso: el estilo "${p.style}" no está en site.pavedStyles`);
    patternOf(st.pattern);
  }
  for (const fe of S.fences) {
    const st = S.fenceStyles[fe.style];
    if (!st) bad(`reja: el estilo "${fe.style}" no está en site.fenceStyles`);
    positive(st.posts[0], `reja ${fe.style}: posts[0]`);
    Object.values(st.skins).forEach(skin);
  }
  for (const b of S.bollards) {
    positive(b.every, 'bolardos: every');
    if (!b.line.length) bad('bolardos: line necesita al menos un punto');
    if (b.stripe.length % 2 || b.stripe.some((v, k) => v > b.height || (k > 0 && v < b.stripe[k - 1]))) bad('bolardos: stripe son pares [desde, hasta] que suben, hasta el alto del bolardo');
    Object.values(b.skins).forEach(skin);
  }
  for (const p of S.planters) {
    if (p.drop < 0 || p.drop > p.height) bad('jardinera: drop va de 0 al alto del borde');
    Object.values(p.skins).forEach(skin);
  }
  for (const s of S.shelters) {
    positive(s.every, 'parada: every');
    if (!s.skins.soffit) bad('parada: falta skins.soffit (la cara de abajo del techo)');
    if (s.front !== undefined && !(s.front >= 0 && s.front < s.height)) bad('parada: front va de 0 a menos que el alto (height)');
    Object.values(s.skins).forEach(skin);
  }
  for (const s of S.fountains) Object.values(s.skins).forEach(skin);
  for (const s of S.billboards) {
    Object.values(s.skins).forEach(skin);
    const R = s.reflectors;
    if (R) {
      if (!(R.count >= 1)) bad('valla: reflectors.count tiene que ser al menos 1');
      positive(R.arm, 'valla: reflectors.arm');
      positive(R.rod, 'valla: reflectors.rod');
      if (R.size.length !== 3 || R.size.some((v) => !(v > 0))) bad('valla: reflectors.size es [ancho, alto, fondo] mayores que 0');
      skin(R.skin);
    }
  }
  for (const tw of S.towers ?? []) {
    positive(tw.pole.radius, 'torre de vigilancia: pole.radius');
    positive(tw.pole.height, 'torre de vigilancia: pole.height');
    if (tw.at.some((q) => q.length < 2)) bad('torre de vigilancia: cada una es [x, z] o [x, z, grados]');
    skin(tw.pole.skin);
    for (const p of tw.parts) {
      if (!TOWER_PARTS.includes(p.shape)) bad(`torre de vigilancia: pieza "${p.shape}" (hay: ${TOWER_PARTS.join(', ')})`);
      if (p.size.length !== 3 || p.size.some((v) => !(v > 0))) bad(`torre de vigilancia: el tamaño de una pieza ${p.shape} son 3 medidas mayores que 0`);
      if (p.rims && !(p.rims.height > 0)) bad('torre de vigilancia: rims.height tiene que ser mayor que 0');
      skin(p.skin);
      if (p.rims) skin(p.rims.skin);
    }
  }
  if (S.motos) {
    const M = S.motos.model;
    if (M.wheel.length !== 2 || M.body.length !== 3 || M.seat.length !== 4 || M.bars.length !== 3) bad('motos: wheel [radio, ancho], body [largo, alto, ancho], seat [largo, alto, ancho, atrás] y bars [ancho, alto, adelante]');
    [...M.wheel, ...M.body, ...M.seat.slice(0, 3), M.bars[0], M.bars[1], M.base, M.fork].forEach((v) => positive(v, 'motos: las medidas del modelo'));
    if (!M.colors.length) bad('motos: colors está vacío');
    for (const r of S.motos.rows) {
      if (r.line.length !== 2 || r.line.some((q) => q.length !== 2)) bad('motos: line son dos puntos [x, z]');
      positive(r.every, 'motos: every');
      if (!(r.share >= 0 && r.share <= 1)) bad('motos: share va de 0 a 1');
    }
  }
  for (const l of S.lamps) if (!S.lampModels[l.model]) bad(`postes: el modelo "${l.model}" no está en site.lampModels`);
  for (const m of Object.values(S.lampModels)) {
    if (!m.sides.length) bad('postes: un modelo sin brazos (sides)');
    if (m.turns && !m.turns.length) bad('postes: turns vacío (sin él, un solo juego de brazos)');
  }
  for (const c of S.cars) if (c.at.some((q) => q.length < 2)) bad('autos: cada uno es [x, z] o [x, z, grados]');
  const range = (r: number[], what: string): void => {
    if (r.length !== 2 || !(r[0] > 0) || r[1] < r[0]) bad(`${what} es [mín., máx.] mayores que 0`);
  };
  for (const p of S.palms) range(p.height, 'palmeras: height');
  for (const t of S.trees) {
    range(t.height, 'árboles: height');
    range(t.radius, 'árboles: radius');
    if (!t.colors.length) bad('árboles: colors está vacío');
  }
}

/** Revisa una cara: lados seguidos, franjas, vanos, pilares, paneles y arcos. */
function checkFace(fc: MallFace, o: Outline, at: string, bad: (w: string) => never, positive: (v: number, w: string) => void, run: (r: number[] | undefined, w: string) => void, skin: (n: string) => void, film: number): void {
  if (!fc.sides.length) bad(`${at}: sin lados`);
  fc.sides.forEach((s, k) => {
    if (s < 0 || s >= o.sides) bad(`${at}: la planta no tiene el lado ${s}`);
    if (k && s !== (fc.sides[k - 1] + 1) % o.sides) bad(`${at}: los lados tienen que ir seguidos`);
  });
  if (fc.span && !(fc.span[1] > fc.span[0])) bad(`${at}: span va de menos a más`);
  for (const b of fc.bands) {
    if (!(b.y[1] > b.y[0])) bad(`${at}: una franja va de ${b.y[0]} a ${b.y[1]}`);
    run(b.repeat, `${at}: repeat de una franja`);
    skin(b.skin);
  }
  for (const op of fc.openings ?? []) {
    positive(op.width, `${at}: el ancho de un vano`);
    if (!(op.y[1] > op.y[0])) bad(`${at}: un vano va de ${op.y[0]} a ${op.y[1]}`);
    run(op.repeat, `${at}: repeat de un vano`);
    run(op.rows, `${at}: rows de un vano`);
    if (op.skin) skin(op.skin);
    if (op.frame) skin(op.frame);
  }
  for (const fn of fc.fins ?? []) {
    positive(fn.every, `${at}: fins.every`);
    skin(fn.skin);
  }
  for (const p of fc.panels ?? []) {
    if (p.width.length !== 2 || p.width.some((v) => !(v > 0))) bad(`${at}: el ancho de los paneles es [mín., máx.] mayores que 0`);
    if (p.height.length !== 2 || p.height.some((v) => !(v > 0))) bad(`${at}: el alto de los paneles es [mín., máx.] mayores que 0`);
    if (p.gap.length !== 2 || p.gap.some((v) => !(v >= 0))) bad(`${at}: la separación de los paneles es [mín., máx.], sin negativos`);
    if (p.margin.length !== 2) bad(`${at}: margin de los paneles es [al comienzo, al final]`);
    if (!p.skins.length) bad(`${at}: paneles sin pieles`);
    p.skins.forEach(skin);
  }
  for (const a of fc.arches ?? []) {
    if (a.rings.reduce((s, r) => s + r.width, 0) >= a.width / 2) bad(`${at}: las bandas del arco no dejan hueco adentro`);
    if (a.rise !== undefined) positive(a.rise, `${at}: rise de un arco`);
    run(a.repeat, `${at}: repeat de un arco`);
    a.rings.forEach((r) => skin(r.skin));
    skin(a.infill);
    if (a.rose) {
      // El vidrio delante del paño (a `detail.film`) y el marco delante del vidrio: si no, titilan.
      if (!a.rose.out || a.rose.out.length !== 2 || !(a.rose.out[0] > film && a.rose.out[1] > a.rose.out[0])) bad(`${at}: rose.out es [vidrio, marco], m delante del arco: el vidrio más que detail.film (${film}) y el marco más que el vidrio`);
      skin(a.rose.skin);
      skin(a.rose.frame);
    }
  }
  for (const r of fc.reliefs ?? []) {
    const width = r.width ?? 0;
    if (width < 0) bad(`${at}: el ancho de un relieve no puede ser negativo`);
    // Una figura llena necesita tres puntos, o dos si algún tramo es un arco (un medio disco).
    const need = width > 0 || r.mirror || r.points.some((q) => Math.abs(q[2] ?? 0) > 0) ? 2 : 3;
    if (r.points.length < need || r.points.some((q) => q.length < 2)) bad(`${at}: un relieve necesita al menos ${need} puntos [du, y] (o [du, y, flecha])`);
    if (r.mirror && Math.abs(r.points[0][0]) > 1e-6) bad(`${at}: un relieve en espejo arranca en el eje (du = 0)`);
    positive(r.out + (r.back ?? 0), `${at}: out + back de un relieve`);
    run(r.repeat, `${at}: repeat de un relieve`);
    skin(r.skin);
  }
  for (const b of fc.balconies ?? []) {
    positive(b.width, `${at}: el ancho de un balcón`);
    positive(b.depth, `${at}: el vuelo de un balcón`);
    positive(b.slab, `${at}: la losa de un balcón`);
    positive(b.rail, `${at}: la baranda de un balcón`);
    if (b.handrail < 0) bad(`${at}: el pasamanos de un balcón no puede ser negativo`);
    run(b.repeat, `${at}: repeat de un balcón`);
    run(b.rows, `${at}: rows de un balcón`);
    Object.values(b.skins).forEach(skin);
  }
  for (const e of fc.eaves ?? []) {
    positive(e.out, `${at}: el vuelo de un faldón`);
    positive(e.thickness, `${at}: el grosor de un faldón`);
    if (e.drop < 0) bad(`${at}: drop de un faldón no puede ser negativo`);
    Object.values(e.skins).forEach(skin);
  }
  for (const h of fc.hoods ?? []) {
    positive(h.width, `${at}: el ancho de un toldo`);
    positive(h.height, `${at}: el alto de un toldo`);
    positive(h.depth, `${at}: el vuelo de un toldo`);
    run(h.repeat, `${at}: repeat de un toldo`);
    skin(h.skin);
  }
}

/** Las plantas (marco local) que el mall reemplaza: las de sus volúmenes y parqueaderos, y los despejes de la config. */
function clearOf(f: MallFile): number[][][] {
  return [...f.clear, ...f.volumes.map((v) => outline(v.ring, f.detail.arc).pts.map((p) => [p.x, p.y])), ...f.lots.map((l) => l.ring)];
}

/**
 * Arma el mall: cada volumen es un pedazo con su física y su LOD (su cáscara, sus marquesinas,
 * letreros y lo de su techo, y su parqueo si lo tiene); los puentes y los parqueaderos, los suyos;
 * lo de alrededor va al pedazo más cercano.
 */
function build(f: MallFile, kit: PlaceKit): void {
  const ctx: Ctx = { kit, skins: new Skins(f.skins, f.lights, f.finishes), detail: f.detail, ground: f.ground };
  const pieces: Piece[] = [];
  const volumes = new Map<string, { v: MallVolume; o: Outline; ground: number; piece: Piece }>();
  const name = kit.root.name;
  const piece = (id: string, x: number, z: number, base: number, height: number): Piece => {
    const group = new THREE.Group();
    group.name = `${name}-${id}`;
    kit.root.add(group);
    const p: Piece = { id, site: kit.site(x, z), bins: new Bins([kit.flood, base, height]), group, x, z, walls: new Map() };
    pieces.push(p);
    return p;
  };
  const nearest = (x: number, z: number): Piece => pieces.reduce((best, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z) ? p : best));

  for (const v of f.volumes) {
    const o = outline(v.ring, f.detail.arc);
    // El suelo: la mediana del terreno a lo largo de la planta (o el del volumen en que se apoya).
    const samples: number[] = [];
    for (const g of o.segs) {
      const n = Math.max(1, Math.ceil(g.len / f.ground.step));
      for (let k = 0; k < n; k++) {
        const q = g.a.clone().addScaledVector(g.t, (g.len * k) / n);
        samples.push(kit.terrain(q.x, q.y));
      }
    }
    samples.sort((a, b) => a - b);
    const ground = v.on ? (volumes.get(v.on) as { ground: number }).ground : samples[Math.floor(samples.length / 2)];
    const sink = ground - samples[0] + f.ground.bury;
    const cx = o.pts.reduce((a, p) => a + p.x, 0) / o.pts.length;
    const cz = o.pts.reduce((a, p) => a + p.y, 0) / o.pts.length;
    const p = piece(v.id, cx, cz, ground, v.height);
    const roof = buildShell(v, o, ground, sink, p, ctx);
    // Un macizo con techo inclinado llega hasta la cumbrera: se camina por sus aguas.
    const ridge = roof ? roof.edge + roof.slope * roof.halfWidth : ground + v.height;
    if (v.deck) buildDeck(`${name}-${v.id}`, v.deck, o, ground, p, p.group, ctx);
    else if (v.physics === 'block') p.site.block(o.pts.map((q) => new THREE.Vector3(q.x, 0, q.y)), ground - sink, ridge, roof);
    else if (v.physics === 'raised') for (const b of polyBoxes(o.pts, f.ground.step)) p.site.box(b.x, b.z, b.halfU, b.halfV, b.angle, ground + v.height, true, ground + v.base);
    volumes.set(v.id, { v, o, ground, piece: p });
  }
  const on = (id: string): { v: MallVolume; o: Outline; ground: number; piece: Piece } => volumes.get(id) as { v: MallVolume; o: Outline; ground: number; piece: Piece };

  for (const c of f.canopies) {
    // El medio de la recta (o de la quebrada: el promedio de sus puntos).
    const mx = c.line.reduce((a, q) => a + q[0], 0) / c.line.length;
    const mz = c.line.reduce((a, q) => a + q[1], 0) / c.line.length;
    const ref = c.on ? on(c.on).ground : kit.terrain(mx, mz);
    buildCanopy(c, ref, c.on ? on(c.on).piece : nearest(mx, mz), ctx);
  }
  for (const s of f.signs) {
    const glow = s.glow ?? f.lights.sign;
    if (s.on) {
      const V = on(s.on);
      const c = chainOf(V.o, [s.side as number]);
      const u = s.u ?? uAt(c, s.x, s.z);
      const { p, n } = pointAt(c, u);
      buildSign(s, p, n, V.ground + s.y, V.ground, glow, V.piece, ctx, s.follow ? { c, u } : undefined);
    } else {
      const [x, z] = s.at as number[];
      const a = THREE.MathUtils.degToRad(s.angle as number);
      const ground = kit.terrain(x, z);
      buildSign(s, new THREE.Vector2(x, z), new THREE.Vector2(Math.cos(a), Math.sin(a)), ground + s.y, ground, glow, nearest(x, z), ctx);
    }
  }
  const roofOf = (id: string): number => on(id).ground + on(id).v.height;
  for (const s of f.skylights) buildSkylight(s, roofOf(s.on), on(s.on).piece, ctx);
  for (const d of f.domes) buildDome(d, roofOf(d.on), on(d.on).piece, ctx);
  f.equipment.forEach((e, k) => {
    const V = on(e.on);
    const area = e.area ? e.area.map((q) => new THREE.Vector2(q[0], q[1])) : inset(V.o, e.margin);
    buildEquipment(e, area, roofOf(e.on), V.piece.group, `${name}-${e.on}-equipment-${k}`, V.piece, ctx);
  });
  for (const s of f.solar) buildSolar(s, roofOf(s.on), on(s.on).piece, ctx);
  for (const m of f.masts) buildMasts(m, on(m.on).ground, on(m.on).piece, ctx);

  for (const b of f.bridges) {
    const x = (b.line[0][0] + b.line[1][0]) / 2;
    const z = (b.line[0][1] + b.line[1][1]) / 2;
    buildBridge(b, piece(b.id, x, z, kit.terrain(x, z), b.deck[0] + b.slab + b.height), ctx);
  }
  for (const s of f.stairs) buildStair(s, nearest((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2), ctx);
  for (const l of f.lots) {
    const x = l.ring.reduce((a, q) => a + q[0], 0) / l.ring.length;
    const z = l.ring.reduce((a, q) => a + q[1], 0) / l.ring.length;
    const p = piece(l.id, x, z, kit.terrain(x, z), f.ground.lift);
    buildLot(l, f.retiros, p.bins.get('rails', true), p, ctx);
  }

  const S = f.site;
  const mid = (line: readonly (readonly number[])[]): number[] => [line.reduce((a, q) => a + q[0], 0) / line.length, line.reduce((a, q) => a + q[1], 0) / line.length];
  for (const pv of S.paved) {
    const [x, z] = mid(pv.ring);
    buildPaved(pv, S.pavedStyles[pv.style], nearest(x, z), ctx);
  }
  for (const fe of S.fences) {
    const [x, z] = mid(fe.line);
    const p = nearest(x, z);
    buildFence(fe, S.fenceStyles[fe.style], p.bins.get('rails', true), p, ctx);
  }
  S.bollards.forEach((b, k) => {
    const [x, z] = mid(b.line);
    const p = nearest(x, z);
    buildBollards(b, p.group, `${name}-bollards-${k}`, p, ctx);
  });
  for (const pl of S.planters) {
    const [x, z] = mid(pl.ring);
    buildPlanter(pl, nearest(x, z), ctx);
  }
  for (const s of S.shelters) buildShelter(s, nearest(s.at[0], s.at[1]), ctx);
  for (const s of S.fountains) buildFountain(s, nearest(s.at[0], s.at[1]), ctx);
  for (const s of S.billboards) buildBillboard(s, nearest(s.at[0], s.at[1]), ctx);
  for (const tw of S.towers ?? []) {
    const [x, z] = mid(tw.at);
    buildTowers(tw, nearest(x, z), ctx);
  }
  if (S.motos && S.motos.rows.length) {
    const [x, z] = mid(S.motos.rows.flatMap((r) => r.line));
    const p = nearest(x, z);
    buildMotos(S.motos, p.group, `${name}-motos`, p, ctx);
  }
  const models = new Map<string, THREE.BufferGeometry>();
  S.lamps.forEach((l, k) => {
    const model = S.lampModels[l.model];
    let g = models.get(l.model);
    if (!g) models.set(l.model, (g = lampGeometry(model)));
    const [x, z] = mid(l.at);
    const p = nearest(x, z);
    buildLamps(l, model, g, p.group, `${name}-lamps-${k}`, p, ctx);
  });
  park(S, ctx);
  plant(S, ctx);

  const material = materialOf(kit, f.finishes);
  for (const p of pieces) p.bins.flush(p.group, p.group.name, material, p.site, f.detail.near);
}

/** A cuántos m del comienzo de la cadena queda la x (o la z) local dada. */
function uAt(c: ReturnType<typeof chainOf>, x: number | undefined, z: number | undefined): number {
  for (let k = 0; k < c.segs.length; k++) {
    const g = c.segs[k];
    const [a, b, v] = x !== undefined ? [g.a.x, g.b.x, x] : [g.a.y, g.b.y, z as number];
    if ((v - a) * (v - b) <= 0 && Math.abs(b - a) > 1e-6) return c.u[k] + ((v - a) / (b - a)) * g.len;
  }
  throw new Error(`Un letrero pide ${x !== undefined ? `x = ${x}` : `z = ${z}`}, que su lado no cruza`);
}

/** La planta corrida `d` m hacia adentro (a inglete en las esquinas). */
function inset(o: Outline, d: number): THREE.Vector2[] {
  const S = o.segs;
  return S.map((g, k) => {
    const prev = S[(k + S.length - 1) % S.length];
    const m = prev.n.clone().add(g.n);
    const den = 1 + prev.n.dot(g.n);
    return g.a.clone().addScaledVector(den > MITER ? m.divideScalar(den) : g.n, -d);
  });
}

export const MALL: PlaceType<MallFile> = {
  check,
  signs: (f) => f.signs.map(signFace),
  lights: (f) => [...f.site.lamps.flatMap((l) => lampLights(l, f.site.lampModels[l.model])), ...f.canopies.flatMap(canopyLights)],
  clear: clearOf,
  build,
};
