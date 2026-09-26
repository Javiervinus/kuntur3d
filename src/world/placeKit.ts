import type * as THREE from 'three';
import type { SignFace, SignRect } from '../render/signAtlas';
import type { Batch, MonumentBase } from './monumentParts';
import type { Finish } from './monuments';
import type { LotKit } from './streetLots';

/**
 * Un lugar modelado con su archivo aparte (tipos `mall`, `tower`, `urbanization` y `house`): en
 * config/game.json → monuments.list va solo dónde está su marco local (lat/lon del origen y rumbo
 * del eje x), cuánto lo alumbran los reflectores y el nombre de su archivo en config/sites/, que
 * trae todo lo demás.
 */
export interface Place extends MonumentBase {
  file: string;
}

/**
 * Techo inclinado de un macizo (marco local del lugar): así se camina por sus aguas y no por una
 * losa invisible a la altura de la cumbrera.
 */
export interface LocalRoof {
  /** A cuatro aguas (si no, a dos). */
  hip: boolean;
  /** Centro del techo (marco local). */
  x: number;
  z: number;
  /** Dirección de la cumbrera (atan2(z, x) del marco local). */
  angle: number;
  /** Medio ancho (de la cumbrera al alero) y medio largo (a lo largo de la cumbrera), en m. */
  halfWidth: number;
  halfLength: number;
  /** Cuánto sube por metro hacia la cumbrera. */
  slope: number;
  /** Altura del alero (del mundo). */
  edge: number;
}

/**
 * Lo que un pedazo de un lugar (o una cuadra de una calle, world/street.ts) necesita de Monuments
 * para entrar en la física y en el LOD. Todo en el marco local del lugar; las alturas son del
 * mundo.
 */
export interface PlaceSite {
  /** Macizo que se trepa y se camina encima (planta local, del pie `y0` al techo `top`), con su techo inclinado si lo tiene. */
  block(outline: THREE.Vector3[], y0: number, top: number, roof?: LocalRoof): void;
  /** Rectángulo de física: largo en el ángulo `angle` (atan2(z, x) local); `floor` = se puede pisar su tope; debajo de `bottom` se pasa. */
  box(x: number, z: number, halfU: number, halfV: number, angle: number, top: number, floor: boolean, bottom: number): void;
  /** Obstáculo o piso redondo de radio `r`. */
  circle(x: number, z: number, r: number, top: number, floor: boolean, bottom: number): void;
  /** Piso a `offset` sobre el terreno dentro del polígono (una vereda, una plaza). */
  ground(outline: THREE.Vector3[], offset: number): void;
  /** Detalle que solo se ve a menos de `distance` m del centro de este pedazo. */
  near(o: THREE.Object3D, distance: number): void;
  /** Lo que solo se ve a más de `distance` m (la versión simple de lejos). */
  far(o: THREE.Object3D, distance: number): void;
}

/** Lo que un lugar de config/sites/ necesita de Monuments (world/monuments.ts) para armarse. */
export interface PlaceKit extends PlaceSite {
  root: THREE.Group;
  /**
   * `stone`: el material de los monumentos (color por vértice, oclusión, dibujos, reflectores,
   * luz propia y letreros). `paint`: el mismo, pero una `InstancedMesh` con `instanceColor` tiñe
   * solo lo que se pintó (`Surface.paint`, ver monumentParts.ts): la pared de cada casa con su
   * color, sin teñir el techo ni las ventanas.
   */
  materials: { stone: THREE.Material; paint: THREE.Material };
  /** El material con otro acabado (vidrio, metal, calado), uno por acabado distinto. */
  finish(f: Finish): THREE.Material;
  /** Cuánto lo alumbran de noche los reflectores (config/game.json → la entrada del lugar). */
  flood: number;
  /** Altura del suelo en un punto del marco local. */
  terrain(x: number, z: number): number;
  /**
   * Un pedazo del lugar con su propia física y su propio LOD, con centro (x, z): una celda de
   * casas, un volumen de un mall, una hilera de parqueo. Así una consulta de la física no recorre
   * el lugar entero, y lo chico se esconde según la distancia a su pedazo, no al centro del lugar.
   */
  site(x: number, z: number): PlaceSite;
  /** Un árbol (pie a la altura `y` del mundo) para los árboles de la ciudad. */
  tree(x: number, z: number, y: number, height: number, radius: number, color: THREE.Color): void;
  /** Una palmera (pie a la altura `y` del mundo) para las palmeras de la ciudad. */
  palm(x: number, z: number, y: number, height: number): void;
  /**
   * Un auto estacionado a nivel del suelo: centro, hacia dónde mira la trompa (atan2(z, x) local)
   * y cuánto queda sobre el terreno. Va a los autos de la ciudad (world/parkedCars.ts), que lo
   * asientan en el terreno: no sirve para los pisos de un parqueo en altura.
   */
  car(x: number, z: number, angle: number, lift: number): void;
  /** Dónde está un letrero en el atlas de letreros (lo tiene que declarar `PlaceType.signs`). */
  signRect(s: SignFace): SignRect;
  /** Cuánto se separa la cara de un letrero de lo que tiene detrás (m). */
  signOffset: number;
  /**
   * Lo que un retiro o un carril de parqueo (world/streetLots.ts → buildRetiro, buildLane)
   * necesita para armarse en el pedazo `site`: sus pisos siguen el terreno en tramos de
   * `ground.step` m y sus vallas atajan con el grosor `ground.wall` (el mismo armado que el de las
   * calles: world/street.ts → lotKit).
   */
  lotKit(site: PlaceSite, batches: { stone: Batch; detail: Batch; rails: Batch }, ground: { step: number; wall: number }): LotKit;
}

/**
 * Una luz de un lugar para el alumbrado de la ciudad (world/streetLamps.ts): dónde está el pie
 * (marco local), cuánto sobre el terreno, a qué altura sobre el pie va la luminaria, hacia dónde
 * sale el brazo (atan2(z, x) local), su potencia (1 = un poste de la calle) y si es LED o sodio.
 */
export interface PlaceLight {
  x: number;
  z: number;
  lift: number;
  h: number;
  out: number;
  power: number;
  led: boolean;
}

/**
 * Un tipo de lugar con archivo en config/sites/. Lo que se pide antes de armar (los letreros para
 * el atlas, las luces para el alumbrado y los despejes para los datos) sale de funciones puras de
 * su archivo; `build` arma el lugar.
 */
export interface PlaceType<F> {
  /** Falla al cargar si el archivo trae algo que no cierra (los JSON no se revisan al compilar). */
  check(f: F, where: string): void;
  /** Los letreros del lugar (para el atlas compartido, render/signAtlas.ts). */
  signs(f: F): SignFace[];
  /** Sus luces para el alumbrado. */
  lights(f: F): PlaceLight[];
  /** Polígonos (marco local) donde no quedan edificios, árboles ni postes de los datos. */
  clear(f: F): number[][][];
  build(f: F, kit: PlaceKit): void;
}

const FILES = import.meta.glob('../../config/sites/*.json', { eager: true, import: 'default' });

/** El archivo de config/sites/ de un lugar (por nombre, sin extensión). */
export function siteFile<F>(name: string): F {
  const key = Object.keys(FILES).find((k) => k.endsWith(`/${name}.json`));
  if (!key) throw new Error(`No existe config/sites/${name}.json (monuments.list → file)`);
  return FILES[key] as F;
}
