import type gameConfig from '../../config/game.json';

export type GameConfig = typeof gameConfig;

/** Personaje jugable (config/game.json → characters.roster). */
export type CharacterConfig = GameConfig['characters']['roster']['human'];
export type Abilities = CharacterConfig['abilities'];
export type Movement = CharacterConfig['movement'];

/** Vehículo (config/game.json → vehicles). */
export type VehicleConfig = GameConfig['vehicles']['car'];

/** Estados de animación de un personaje; cada modelo dice qué clip usa en cada uno. */
export type AvatarState = 'idle' | 'walk' | 'run' | 'jump' | 'climb' | 'glide' | 'swim' | 'swimIdle' | 'drive';

/** Ropa procedural pintada sobre el cuerpo en pose de reposo (ver src/player/outfit.ts). */
export interface OutfitConfig {
  material: string;
  hem: number;
  hemShade: number;
  grain: number;
  grainScale: number;
  pieces: {
    name: string;
    color: string;
    yMin: number;
    yMax: number;
    xMax: number;
    collarRadius: number;
    collarDrop: number;
    roughness: number;
    normal: number;
    /** Holgura: cuánto se separa la tela del cuerpo (m del modelo), a lo largo de la normal. */
    inflate: number;
  }[];
}

/** Modelo 3D de un personaje (config/assets.json). */
export interface ModelConfig {
  publicUrl: string;
  credit: string;
  yawOffsetDeg: number;
  /** Clip de cada estado; los que falten usan el estado de respaldo (ver avatar.ts). */
  animations: Partial<Record<AvatarState, string>>;
  animationSpeed: Partial<Record<AvatarState, number>>;
  /** Velocidad (m/s) a la que el clip va a ritmo normal: se acelera o frena con la real (pies sin patinar). */
  strideSpeed?: Partial<Record<AvatarState, number>>;
  /** Tope del ritmo de los clips con `strideSpeed` (con ×8 o ×16 las piernas se verían caricaturescas). */
  maxStrideRate?: number;
  loopOnce: string[];
  /** Por encima de esta velocidad (m/s) se usa la animación de correr. */
  runThreshold: number;
  /** Inclinación del cuerpo en ciertos estados (acostado bajo el ala delta). */
  poses: Partial<Record<AvatarState, { pitchDeg: number; rise: number }>>;
  /** Malla con la que se mide la estatura (sin peinado); por defecto, todo el modelo. */
  statureNode?: string;
  /** Hueso de la cabeza: se oculta en primera persona cuando el cuerpo queda a la vista (manejando). */
  headBone?: string;
  /** Color que multiplica la textura de ciertos materiales (p. ej. el pelo, que viene en gris). */
  tints?: Record<string, string>;
  outfit?: OutfitConfig;
}

export interface Landmark {
  name: string;
  lat: number;
  lon: number;
  /** Punto al que se llega (caminable: fuera del agua y de los edificios). */
  x: number;
  z: number;
  /** Centro del lugar (el marcador); falta en manifests viejos. */
  cx?: number;
  cz?: number;
}

/**
 * Una línea de teleférico del paso `aerial` (contrato con pipeline/build_world.py). `points`, en
 * orden: tipo (0 torre, 1 centro de estación, 2 boca por donde el cable entra a la estación), x,
 * z, suelo (fondo del río si la torre está en el agua), cable y techo, en m del mundo; el techo
 * de una torre es la punta de su estructura y el de una estación, el de su edificio.
 */
export interface AerialLine {
  name: string | null;
  /** `aerialway` de OSM (gondola, cable_car). */
  kind: string;
  gauge: number;
  catenary: number;
  /** Plazas por cabina y minutos de viaje, si OSM los trae. */
  occupancy: number | null;
  duration: number | null;
  points: [number, number, number, number, number, number][];
  /**
   * Tipo (0 terminal, 1 parada, 2 técnica), punto de su centro, techo de su edificio (null si no
   * tiene) y sus bocas: punto, normal de la fachada hacia afuera (x, z) y cuánto cabe a cada lado
   * de la boca en esa fachada (0 si la estación es abierta).
   */
  stations: {
    name: string | null;
    type: number;
    point: number;
    top: number | null;
    portals: [number, number, number, number][];
  }[];
}

/**
 * Calles para el mapa del HUD: la red del tráfico ya cargada (traffic.bin, ver
 * src/world/traffic.ts), ejes de cada tramo en m del marco local, su clase y sus banderas.
 */
export interface RoadNetwork {
  readonly edges: number;
  /** Primer punto de cada tramo (tramos + 1). */
  readonly start: Uint32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Índice de la clase de OSM en `info.classes`. */
  readonly kind: Uint8Array;
  readonly flags: Uint8Array;
  readonly info: { readonly classes: string[]; readonly flags: { readonly bridge: number } };
}

/** Contrato con pipeline/build_world.py (public/world/manifest.json). */
export interface WorldManifest {
  version: number;
  id: string;
  name: string;
  generatedAt: string;
  proj4: string;
  origin: { easting: number; northing: number; lon: number; lat: number };
  bbox: { west: number; south: number; east: number; north: number };
  chunks: { size: number; nx: number; nz: number; xmin: number; zmin: number };
  heightmap: {
    url: string;
    /** 16 bits, diferencias a lo largo de cada fila y gzip (ver el paso `terrain`). */
    format: 'u16-rowdelta-gzip';
    /** Metros por unidad y altura del 0: altura = offset + valor · scale. */
    scale: number;
    offset: number;
    width: number;
    height: number;
    spacing: number;
    xmin: number;
    zmin: number;
  };
  waterLevel: number;
  water: { url: string; polygons: number };
  buildings: {
    url: string;
    count: number;
    chunks: [number, number, number][];
    heightSources: Record<string, number>;
  };
  /** Resumen del paso `roofs` (los techos van en la lista "r" de cada chunk de edificios). */
  roofs?: { pitched: number; hip: number; buildings: number };
  /**
   * Paso `shops`: locales comerciales en las plantas bajas (listas "s" y "sn" de cada chunk de
   * edificios, ver buildingFormat.ts). `kinds` = nombre de cada tipo de local, en el orden de sus
   * índices; `named` negocios con letrero en `buildings` edificios y `generic` edificios más con
   * locales genéricos (zonas y calles comerciales).
   */
  shops?: { kinds: string[]; named: number; buildings: number; generic: number };
  imagery: { attribution: string };
  /** Foto satelital de todo el mundo en el marco local (terreno lejano y minimapa). */
  overview: { url: string; width: number; height: number };
  /** Árboles por chunk: `stride` floats por árbol (x, y, z, alto, radio, r, g, b). */
  trees?: { url: string; stride: number; count: number; chunks: [number, number, number][] };
  /**
   * Calles por chunk (ejes con ancho, material, carriles y cruces), más parques y canchas
   * (listas "p" y "f", ver src/world/groundFormat.ts); `materials` = nombre de cada índice.
   */
  roads?: {
    url: string;
    count: number;
    areas: number;
    parks?: number;
    pitches?: number;
    materials: string[];
    chunks: [number, number, number][];
  };
  /**
   * Lo que el mapa del HUD (src/ui/mapLayers.ts) necesita de toda la ciudad y no está entero en
   * otro archivo (paso `roads`): los parques, anillos [x, z, …] en m enteros del marco local.
   */
  map?: { url: string; parks: number };
  /**
   * Oclusión ambiental por chunk (paso `ao`, ver src/world/skyOcclusion.ts): imágenes de
   * `texels`² a `resolution` m por píxel; `chunks` = los que tienen imagen.
   */
  ao?: { url: string; resolution: number; texels: number; heightUnit: number; chunks: [number, number][] };
  /**
   * Postes de alumbrado (paso `roads`): `stride` bytes por poste (ver src/world/streetLamps.ts),
   * posición en `unit` m, altura de la luz en `heightUnit` m y banderas (LED, apagado).
   */
  lamps?: {
    url: string;
    count: number;
    stride: number;
    unit: number;
    heightUnit: number;
    flags: { led: number; dead: number };
  };
  /**
   * Puentes y muelles (paso `bridges`, ver src/world/bridges.ts): ejes con su altura y postes
   * sobre los tableros; `groundFlag` marca los de tableros a ras del suelo (muelles), que
   * alumbran también el suelo.
   */
  bridges?: { url: string; count: number; lamps: number; groundFlag?: number };
  /**
   * Horizonte lejano (paso `skyline`): los edificios altos de toda la ciudad en grupos de
   * `group`×`group` chunks, con el chunk y el nivel de cada uno (ver Buildings).
   */
  skyline?: {
    url: string;
    group: number;
    minHeight: number;
    tallHeight: number;
    count: number;
    groups: [number, number, number][];
  };
  /**
   * Red de calles para el tráfico (paso `traffic`, ver src/world/traffic.ts): tramos entre
   * cruces con sus carriles en cada sentido, velocidad, clase (índice en `classes`) y banderas.
   */
  traffic?: {
    url: string;
    edges: number;
    nodes: number;
    points: number;
    unit: number;
    laneWidth: number;
    classes: string[];
    flags: { bridge: number; roundabout: number };
  };
  /**
   * Autos estacionados (paso `roads`, ver src/world/parkedCars.ts): `stride` bytes por auto,
   * agrupados por chunk (`chunks` = i, j, primero, cuántos): x y z dentro del chunk (uint16, el
   * chunk entero en 65535 pasos), rumbo (uint8, vuelta completa) y semilla (uint8).
   */
  parking?: { url: string; count: number; stride: number; chunks: [number, number, number, number][] };
  /** Red peatonal (paso `walks`): veredas y senderos entre cruces, con el estacionamiento a cada lado. */
  walks?: {
    url: string;
    edges: number;
    nodes: number;
    points: number;
    unit: number;
    /** Metros por unidad de los anchos y recortes de cada tramo. */
    widthUnit: number;
    classes: string[];
    flags: { bridge: number; steps: number };
  };
  /**
   * Teleféricos (paso `aerial`, ver src/world/aerialways.ts), con la separación de los dos
   * cables (`gauge`, m) y el parámetro de su catenaria (`catenary`, m: flecha = L² / 8·catenary).
   */
  aerialways?: { lines: AerialLine[] };
  /**
   * Índice del buscador (paso `search`, formato en src/ui/searchEngine.ts): calles con sus cruces,
   * negocios y lugares de Overture, y barrios, parroquias y cantones, con su punto de llegada.
   */
  search?: { url: string; streets: number; crossings: number; places: number; areas: number };
  landmarks: Landmark[];
  /**
   * Paso `places`: límites de barrios, parroquias y cantones (zones.json) y, por id de lugar de
   * config/places.json, dónde está su ficha ([cx, cz] del marcador y [x, z] de llegada, fuera del
   * agua y de los edificios) y su foto (bajada de Wikimedia Commons, con su crédito).
   */
  places?: {
    zones: string;
    anchors: Record<string, [number, number, number, number]>;
    /** Foto de cada ficha y su miniatura cuadrada (la lista de lugares de la pausa). */
    photos: Record<string, { url: string; thumb?: string; artist: string; license: string; source: string }>;
  };
  spawn: Landmark | null;
  assets: Record<string, { url: string; credit: string }>;
  geocoder: { url: string; attribution: string; minIntervalMs: number };
  attributions: string[];
}
