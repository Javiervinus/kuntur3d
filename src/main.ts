// Primero: ajusta la config al dispositivo (perfil de celular) antes de que otro módulo la lea.
import './core/profile';
import * as THREE from 'three';
import assets from '../config/assets.json';
import game from '../config/game.json';
import { Controls } from './core/controls';
import { currentPosition } from './core/deviceLocation';
import { GeoFrame } from './core/geo';
import { Input } from './core/input';
import type { ModelConfig, WorldManifest } from './core/types';
import type { Avatar } from './player/avatar';
import { type CameraSubject, FollowCamera } from './player/camera';
import { Roster } from './player/characters';
import { LastPlace, type Place } from './player/lastPlace';
import { PlayerController, type WorldQuery } from './player/controller';
import { createGlider } from './player/glider';
import { Environment } from './render/environment';
import { installFog } from './render/fog';
import { FrameLimiter } from './render/frameLimiter';
import { GpuTimer } from './render/gpuTimer';
import { installGrading } from './render/grading';
import { ProgramPin } from './render/programs';
import { AdaptiveQuality } from './render/quality';
import { TimeOfDay } from './render/timeOfDay';
import { Cockpit } from './render/cockpit';
import { warmShadowPrograms } from './render/warmup';
import { BigMap } from './ui/bigMap';
import { Clock } from './ui/clock';
import { Hud } from './ui/hud';
import { controlSections, legendFor } from './ui/legend';
import { MapLayers } from './ui/mapLayers';
import { Minimap } from './ui/minimap';
import { PauseMenu, type TimeCard } from './ui/pauseMenu';
import { PlaceSearch, type Origin } from './ui/placeSearch';
import { Search } from './ui/search';
import { SearchBox } from './ui/searchBox';
import { type TouchContext, TouchControls } from './ui/touch';
import './ui/styles.css';
import { Driving } from './vehicles/driving';
import { Aerialways } from './world/aerialways';
import { Bridges } from './world/bridges';
import { Buildings, roofTop } from './world/buildings';
import { Heightmap } from './world/heightmap';
import { Imagery } from './world/imagery';
import { DestinationMarker } from './world/marker';
import { MONUMENT_CHUNK, Monuments } from './world/monuments';
import { Palms } from './world/palms';
import { Roads } from './world/roads';
import { SkyOcclusion } from './world/skyOcclusion';
import { StreetLamps } from './world/streetLamps';
import { ParkedCars } from './world/parkedCars';
import { Pedestrians } from './world/pedestrians';
import { Traffic, type TrafficObstacle } from './world/traffic';
import { Terrain } from './world/terrain';
import { Trees } from './world/trees';
import { Water } from './world/water';
import { WaterGlints } from './world/waterGlints';
import { PlaceGuide, placeDirectory, searchLandmarks } from './ui/places';

const hud = new Hud(game.hud.altitudeFrom);

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Falta #${id} en index.html`);
  return node;
}

async function loadManifest(url: string): Promise<WorldManifest> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('No hay datos del mundo. Corre "npm run data" para generarlos desde config/region.json.');
  }
  return (await res.json()) as WorldManifest;
}

function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, game.render.maxPixelRatio));
  renderer.setSize(container.clientWidth, container.clientHeight);
  // Tone mapping Neutral + ajuste de color final dentro del shader (ver render/grading.ts).
  installGrading(renderer, game.render.grading);
  // Bruma húmeda con la altura y el brillo del sol (ver render/fog.ts); la exposición la pone la hora.
  installFog(game.render.fog);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Revisar errores de shaders obliga a esperar cada compilación de forma síncrona: solo en desarrollo.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  container.append(renderer.domElement);
  return renderer;
}

/**
 * Buscador local con autocompletado (índice del paso `search`): su worker arranca la primera vez
 * que se enfoca la caja, ordena por cercanía al jugador y cada resultado lleva ahí con `goTo`.
 * Lo que escribes y confirmas sin elegir sigue por `Search`, que también le pregunta primero.
 */
function setupPlaceSearch(
  manifestUrl: string,
  manifest: WorldManifest,
  search: Search,
  origin: Origin,
  goTo: (x: number, z: number, label: string) => Promise<void>,
): void {
  const url = manifest.search ? new URL(manifest.search.url, manifestUrl).href : null;
  // Destacados: los lugares con ficha y los del panel (ver searchLandmarks en ui/places.ts).
  const places = new PlaceSearch(url, searchLandmarks(manifest), game.search, origin);
  search.useLocal(places);
  const pick = (result: { x: number; z: number; name: string }): Promise<void> => goTo(result.x, result.z, result.name);
  new SearchBox(game.search, game.mapLinks, game.locale, places, pick, (message) => hud.toast(message));
  if (import.meta.env.DEV) Object.assign(window, { __gyeSearch: places });
}

async function main(): Promise<void> {
  const container = document.getElementById('world');
  if (!container) throw new Error('Falta #world');
  const manifestUrl = new URL(game.worldUrl, document.baseURI).href;
  const manifest = await loadManifest(manifestUrl);
  const app = game.app;
  hud.setWorldName(manifest.name, app.name, app.titleFormat.replace('{world}', manifest.name).replace('{name}', app.name));
  hud.setCredits(game.hud.shortCredits);

  const renderer = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    game.render.fov,
    container.clientWidth / container.clientHeight,
    game.render.near,
    game.render.far,
  );
  // Hora del día (mañana, mediodía, tarde, noche): el sol y la luna reales sobre la ciudad.
  const daytime = new TimeOfDay(game.render.timeOfDay, manifest.origin.lat, manifest.origin.lon);
  const env = new Environment(scene, renderer, game.render, manifest.origin, daytime.celestial, daytime.instant);
  const gpuTimer = game.quality.gpuTimer ? new GpuTimer(renderer) : null;
  const cockpit = new Cockpit(game.render.cockpit, scene);
  // El frame puede tener dos pasadas (mundo y cabina): las estadísticas se reinician por frame.
  renderer.info.autoReset = false;
  const quality = new AdaptiveQuality(renderer, env.sun, game.quality, game.render.maxPixelRatio, gpuTimer);
  const geo = new GeoFrame(manifest);
  const imagery = new Imagery(manifest, geo, game.imagery, renderer);
  const models: Record<string, ModelConfig> = assets.characters;
  const roster = new Roster(game.characters, models, document.baseURI);
  const canSwitch = roster.list.length > 1;

  // Lo único que se carga completo al inicio: relieve, vista general, agua y el personaje elegido
  // (los demás personajes se descargan la primera vez que se eligen).
  const w = game.loading.weights;
  const loadingLabel = game.loading.label.replace('{world}', manifest.name);
  let progress = 0;
  const step = <T>(weight: number, job: Promise<T>): Promise<T> =>
    job.then((value) => {
      progress += weight;
      hud.setLoading(progress, loadingLabel);
      return value;
    });
  hud.setLoading(0, loadingLabel);
  const firstCharacter = roster.initial();
  const heightmapJob = Heightmap.load(manifestUrl, manifest.heightmap);
  // Puentes: su geometría necesita el relieve (pilas, rampas) y sus postes van al alumbrado.
  const bridgesJob = heightmapJob.then((hm) => Bridges.load(manifestUrl, manifest, game.bridges, game.roads, hm));
  const [heightmap, overview, water, , bridges, lamps] = await Promise.all([
    step(w.heightmap, heightmapJob),
    step(w.overview, imagery.loadOverview(manifestUrl)),
    step(w.water, Water.load(manifestUrl, manifest, game.water)),
    // Todos los personajes: cambiar de uno a otro después es instantáneo.
    step(w.avatar, roster.loadAll()),
    step(w.bridges, bridgesJob),
    // Alumbrado público (necesita el relieve para el pie de cada poste, y los de los puentes). Las
    // calles modeladas ponen sus faroles en lugar de los postes de los datos.
    step(
      w.lamps,
      Promise.all([heightmapJob, bridgesJob]).then(([hm, deck]) =>
        StreetLamps.load(
          manifestUrl,
          manifest,
          hm,
          game.render.lighting.streetLights,
          game.render.fog,
          renderer,
          deck?.lamps ?? null,
          { lanterns: Monuments.lanterns(game.monuments, geo, hm), cleared: Monuments.clearedTest(game.monuments, geo) },
        ),
      ),
    ),
  ]);
  const firstAvatar = await roster.avatar(firstCharacter);

  const roads = new Roads(manifestUrl, manifest, game.roads, game.streaming);
  const sky = new SkyOcclusion(manifestUrl, manifest, game.render.lighting.skyOcclusion);
  const terrain = new Terrain(manifest, heightmap, imagery, roads, sky, game.terrain, game.streaming);
  terrain.buildFar(overview);
  const { size: chunkSize, nx, nz, xmin, zmin } = manifest.chunks;
  water.setPhoto(overview, { x0: xmin, z0: zmin, width: nx * chunkSize, depth: nz * chunkSize });
  scene.add(terrain.group, water.mesh);
  // Lugares icónicos: reemplazan a los edificios de los datos en su huella.
  const monuments = new Monuments(game.monuments, geo, heightmap, manifest.waterLevel, game.render.fog);
  scene.add(monuments.group);
  const buildings = new Buildings(
    manifestUrl,
    manifest,
    imagery,
    sky,
    env.cityShadow,
    game.buildings,
    game.streaming,
    game.collision.gridCell,
    {
      zones: game.buildings.zones.map((z) => ({ ...geo.toLocal(z.lat, z.lon), radius: z.radius, palette: z.palette })),
      exclude: monuments.exclusions,
      excludeAreas: Monuments.clearings(game.monuments, geo),
      portales: {
        polygon: game.buildings.facade.portales.polygon.map(([lat, lon]) => geo.toLocal(lat, lon)),
        minHeight: game.buildings.facade.portales.minHeight,
        minArea: game.buildings.facade.portales.minArea,
        probability: game.buildings.facade.portales.probability,
      },
    },
  );
  scene.add(buildings.group);
  // Los macizos de los monumentos (el Palacio Municipal) se trepan y se caminan como edificios.
  buildings.index.addChunk(MONUMENT_CHUNK, monuments.records);
  const trees = new Trees(
    manifestUrl,
    manifest,
    game.trees,
    game.streaming,
    env.cityShadow,
    (x, z, top) => (bridges ? bridges.deckAt(x, z, top) > -Infinity : false) || monuments.occupied(x, z) || monuments.cleared(x, z),
  );
  // Los árboles de las veredas de las calles modeladas (siempre cargados).
  trees.addFixed(monuments.streetTrees);
  scene.add(trees.group);
  if (lamps) scene.add(lamps.group);
  if (bridges) {
    scene.add(bridges.group);
    if (lamps) bridges.bakeNight(lamps.data, game.render.lighting.streetLights);
  }
  // Palmeras de los malecones (junto a la baranda de los muelles).
  const palms = bridges?.palms.length ? new Palms(bridges.palms, game.palms) : null;
  if (palms) scene.add(palms.group);
  // Reflejos en el río de noche: los postes de las orillas y los puentes, y los LED de La Perla
  // (que giran y cambian de color).
  const glints = lamps
    ? new WaterGlints(
        lamps.data,
        heightmap,
        manifest.waterLevel + game.water.offset,
        game.water.glints,
        game.render.lighting.streetLights,
        game.render.fog,
        monuments.reflectedCount,
      )
    : null;
  if (glints) scene.add(glints.group);

  const outer = game.terrain.outerGround;
  const outerGround = new THREE.Mesh(
    new THREE.PlaneGeometry(outer.size, outer.size).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: outer.color, roughness: 1 }),
  );
  outerGround.position.y = manifest.waterLevel - outer.depthBelowWater;
  outerGround.receiveShadow = true;
  scene.add(outerGround);

  // Autos estacionados (se cargan ya jugando, más abajo): también son obstáculos.
  let parkedCars: ParkedCars | null = null;
  const world: WorldQuery = {
    terrainAt: (x, z) => heightmap.sample(x, z),
    buildingAt: (x, z) => buildings.index.at(x, z),
    surfaceAt: (x, z) => roads.surfaceAt(x, z),
    deckAt: (x, z, maxY, hit) => monuments.deckAt(x, z, maxY, bridges ? bridges.deckAt(x, z, maxY, hit) : -Infinity, hit),
    wallTop: (x, z, y) =>
      Math.max(
        bridges ? bridges.wallTop(x, z, y) : -Infinity,
        monuments.wallTop(x, z, y),
        parkedCars ? parkedCars.topAt(x, z) : -Infinity,
      ),
    waterLevel: manifest.waterLevel,
    clampToWorld: (x, z) => geo.clamp(x, z, game.player.worldMargin),
  };
  const player = new PlayerController(world, game.player, game.glider, firstCharacter);
  const controls = new Controls(new Input(container), game.controls);
  const touch = new TouchControls(game.touch, controls, container, element('touch'));
  const driving = new Driving(game.vehicles.car, world, scene);

  // Personaje visible: cada modelo lleva su propia ala delta (el trapecio depende de su altura).
  const gliders = new Map<Avatar, THREE.Group>();
  let avatar = firstAvatar;
  const gliderOf = (a: Avatar): THREE.Group => {
    let g = gliders.get(a);
    if (!g) {
      g = createGlider(game.glider, a.height);
      g.visible = false;
      a.root.add(g);
      gliders.set(a, g);
    }
    return g;
  };
  scene.add(avatar.root);

  /** Qué botones táctiles corresponden a lo que está haciendo el jugador. */
  const touchContext = (): TouchContext => {
    if (driving.active) return 'drive';
    if (player.mode === 'glide') return 'glide';
    if (player.mode === 'climb') return 'climb';
    return 'walk';
  };

  let legendKey = '';
  const refreshLegend = (): void => {
    const key = `${player.character.id}:${driving.active}`;
    if (key === legendKey) return;
    legendKey = key;
    hud.setLegend(legendFor(controls, player.character, driving.active ? driving.car : null, canSwitch));
  };
  refreshLegend();
  hud.setSpeedKeys(controls.label('speedDown'), controls.label('speedUp'));
  /** En pausa el mundo no se redibuja: algo cambió a la vista (la hora, la ventana) y hay que mostrarlo. */
  let needsRender = false;
  daytime.onChange((preset) => {
    pauseMenu.setTime(preset.id);
    hud.toast(preset.label);
    env.beginTransition(daytime.celestial, daytime.instant, daytime.target, daytime.destination);
    if (!daytime.moving) {
      env.apply(daytime.celestial, daytime.instant);
      env.blend(1);
    }
    // En pausa el mundo no se redibuja solo: el cielo nuevo hay que mostrarlo.
    needsRender = true;
  });

  let switching = false;
  const switchCharacter = async (): Promise<void> => {
    if (switching || !canSwitch) return;
    if (driving.active) {
      hud.toast('Bájate del carro para cambiar de personaje');
      return;
    }
    switching = true;
    const next = roster.after(player.character);
    const slow = window.setTimeout(() => hud.toast(`Cargando ${next.name}…`), 150);
    try {
      const nextAvatar = await roster.avatar(next);
      if (driving.active) return;
      avatar.root.removeFromParent();
      avatar = nextAvatar;
      scene.add(avatar.root);
      player.setCharacter(next);
      roster.remember(next);
      hud.toast(next.name);
      refreshLegend();
      pauseMenu.setControls(touch.isEnabled ? game.touch.help : controlSections(controls, player.character, canSwitch));
    } catch (err) {
      console.error(err);
      hud.toast(`No se pudo cargar ${next.name}`);
    } finally {
      window.clearTimeout(slow);
      switching = false;
    }
  };

  /** Superficie visible en (x, z): techo, terreno o agua, lo que esté más alto. */
  const surfaceAt = (x: number, z: number): number => {
    const b = buildings.index.at(x, z);
    return Math.max(heightmap.sample(x, z), manifest.waterLevel, b ? roofTop(b, x, z) : -Infinity);
  };
  const follow = new FollowCamera(camera, game.camera, surfaceAt, (x, z, y) => {
    const b = buildings.index.at(x, z);
    return Math.max(b ? roofTop(b, x, z) : -Infinity, monuments.wallTop(x, z, y));
  });
  const marker = new DestinationMarker(game.destinationMarker);
  scene.add(marker.group);

  /** Carga lo de alrededor de un punto antes de llegar (para caer en el techo correcto). */
  const prepare = async (x: number, z: number): Promise<void> => {
    await buildings.ensure(x, z, game.streaming.prepareRadius);
    terrain.update(x, z);
    imagery.update(x, z, 0);
    trees.update(x, z);
    roads.update(x, z);
    sky.update(x, z);
  };
  const teleport = async (x: number, z: number, label?: string): Promise<void> => {
    await prepare(x, z);
    if (driving.active && !driving.relocate(player, x, z, follow.yaw)) {
      player.teleport(x, z);
      hud.toast('El carro no cabe ahí: llegaste a pie');
    } else if (!driving.active) {
      player.teleport(x, z);
    }
    follow.snap();
    if (label) hud.toast(`→ ${label}`);
  };

  // Mapa dibujado de la ciudad (minimapa y mapa grande): el agua ya está; los parques y las
  // calles (la red del tráfico) se suman apenas llegan.
  const mapLayers = new MapLayers(game.map, manifest);
  mapLayers.setWater(water.polygons);
  MapLayers.loadParks(manifestUrl, manifest)
    .then((parks) => {
      if (parks) mapLayers.setParks(parks);
    })
    .catch((err: unknown) => console.error('[map]', err));
  const directory = placeDirectory(manifest, manifestUrl);
  const minimap = new Minimap(element('radar'), mapLayers, game.minimap, () => setScreen('map'));
  minimap.setPlaces(directory.entries);

  const search = new Search(manifest, geo, game.mapLinks, game.locale);
  /** Teletransporte a un destino buscado, dejando el pin en el punto exacto. */
  const goTo = async (x: number, z: number, label: string): Promise<void> => {
    await teleport(x, z, label);
    marker.show(x, surfaceAt(x, z), z);
    minimap.setDestination({ x, z });
    bigMap.setDestination({ x, z });
  };
  /** Ir a un lugar desde la pausa o el mapa grande: se vuelve al juego y se viaja. */
  const travel = (x: number, z: number, label: string): void => {
    setScreen('play');
    void goTo(x, z, label);
  };

  // Pausa (Esc o P; también cuando el navegador suelta el mouse con Esc) y mapa grande (M): el
  // mundo se congela y deja de dibujarse (la GPU descansa) hasta volver al juego.
  type Screen = 'play' | 'pause' | 'map';
  let screen: Screen = 'play';
  /** A dónde vuelve el mapa grande al cerrarse (se abre jugando o desde la pausa). */
  let mapBack: Screen = 'play';
  /** Cuándo el navegador soltó el mouse: si además llega la tecla Esc, no es para seguir. */
  let lockLostAt = -Infinity;
  const pauseMenu = new PauseMenu(element('pause'), element('pause-menu'), {
    resume: () => setScreen('play'),
    openMap: () => setScreen('map'),
    goTo: (entry) => travel(entry.ax, entry.az, entry.name),
    selectTime: (id) => daytime.select(id),
    toast: (message) => hud.toast(message),
  });
  const bigMap = new BigMap(element('bigmap'), mapLayers, game.map, game.minimap, {
    goTo: (entry) => travel(entry.ax, entry.az, entry.name),
    teleport: (x, z) => {
      setScreen('play');
      void teleport(x, z, 'Teletransporte');
    },
    close: () => setScreen(mapBack),
    toLatLon: (x, z) => geo.toLatLon(x, z),
  });
  const mapPlayer = (): { x: number; z: number; facing: number; cameraYaw: number } => ({
    x: player.position.x,
    z: player.position.z,
    facing: player.facing,
    cameraYaw: follow.yaw,
  });
  /** Dónde estás, para la pestaña Compartir (y el link que abre el juego ahí). */
  let zoneName = manifest.name;
  const shareInfo = (): Parameters<PauseMenu['setShare']>[0] => {
    const ll = geo.toLatLon(player.position.x, player.position.z);
    const url = new URL(window.location.href);
    url.searchParams.set('lat', ll.lat.toFixed(6));
    url.searchParams.set('lon', ll.lon.toFixed(6));
    const maps = game.hud.mapsUrl.replace('{lat}', ll.lat.toFixed(6)).replace('{lon}', ll.lon.toFixed(6));
    return { place: zoneName, lat: ll.lat, lon: ll.lon, link: url.toString(), mapsUrl: maps };
  };
  const setScreen = (next: Screen): void => {
    if (next === screen) return;
    if (next === 'map') mapBack = screen;
    screen = next;
    document.body.classList.toggle('paused', next !== 'play');
    document.body.classList.toggle('map-open', next === 'map');
    pauseMenu.show(next === 'pause');
    if (next === 'pause') {
      pauseMenu.refresh(player.position.x, player.position.z);
      pauseMenu.setShare(shareInfo());
    }
    if (next === 'map') bigMap.show(mapPlayer());
    else if (bigMap.isOpen) bigMap.hide();
    // Con el menú o el mapa, el mouse queda libre para usarlos (y se sueltan los controles táctiles).
    if (next !== 'play') controls.input.release();
    touch.setActive(next === 'play');
  };
  controls.input.onLockLost(() => {
    if (screen !== 'play') return;
    lockLostAt = performance.now();
    setScreen('pause');
  });
  // Un clic en la ciudad (el velo de la pausa lo deja pasar) sigue el juego y vuelve a capturar el mouse.
  container.addEventListener('pointerdown', () => {
    if (screen === 'pause') setScreen('play');
  });
  const clock = new Clock(element('clock'), () => daytime.cycle());
  const cards: Record<string, Omit<TimeCard, 'id' | 'label' | 'time'>> = game.hud.timeCards;
  pauseMenu.setWorldName(manifest.name, app.subtitle);
  pauseMenu.setPlaces(directory.categories, directory.entries);
  pauseMenu.setTimes(
    daytime.presets.map((preset) => {
      const card = cards[preset.id];
      if (!card) throw new Error(`config/game.json → hud.timeCards no tiene la hora "${preset.id}"`);
      return { id: preset.id, label: preset.label, time: preset.time, ...card };
    }),
    daytime.current.id,
  );
  pauseMenu.setControls(controlSections(controls, player.character, canSwitch));
  pauseMenu.setCredits(app.name, app.about, app.source, manifest.attributions);
  bigMap.setPlaces(directory.categories, directory.entries);
  // Las teclas que se ven en el minimapa, el reloj, la pausa y el mapa salen de la config.
  for (const [id, action] of [
    ['map-key', 'map'],
    ['pause-map-key', 'map'],
    ['bigmap-key', 'map'],
    ['clock-key', 'timeOfDay'],
    ['pause-keys', 'pause'],
  ] as const) {
    element(id).textContent = controls.label(action);
  }
  touch.onEnable(() => {
    element('pause-hint').textContent = game.touch.pauseHint;
    pauseMenu.setControls(game.touch.help);
    if (matchMedia('(orientation: portrait)').matches) hud.toast(game.touch.portraitHint, game.touch.portraitHintMs);
  });

  hud.onSearch(async (query) => {
    const hit = await search.resolve(query);
    await goTo(hit.x, hit.z, hit.label);
    setScreen('play');
  });
  setupPlaceSearch(manifestUrl, manifest, search, () => player.position, (x, z, label) => {
    setScreen('play');
    return goTo(x, z, label);
  });
  const locateMs = game.geolocation.timeoutMs + game.geolocation.fallbackTimeoutMs;
  hud.onLocate(
    async () => {
      const { coords } = await currentPosition(game.geolocation, () =>
        hud.toast('Acepta el permiso de ubicación que te pide el navegador', locateMs),
      );
      const hit = search.fromDevice(coords.latitude, coords.longitude, coords.accuracy);
      await goTo(hit.x, hit.z, hit.label);
    },
    locateMs,
    game.geolocation.errorToastMs,
  );

  // Punto de partida: ?lat=&lon= en la URL (un link compartido), o donde quedaste la última
  // vez, o el spawn del manifest, o el centro.
  const lastPlace = new LastPlace(game.resume);
  const params = new URLSearchParams(window.location.search);
  const fromUrl =
    params.has('lat') && params.has('lon') ? geo.toLocal(Number(params.get('lat')), Number(params.get('lon'))) : null;
  const linked = fromUrl && geo.contains(fromUrl.x, fromUrl.z) ? fromUrl : null;
  const saved = linked ? null : lastPlace.load();
  const resume = saved && geo.contains(saved.x, saved.z) ? saved : null;
  const start = linked ?? resume ?? manifest.spawn ?? { x: 0, z: 0 };
  if (resume) {
    follow.yaw = resume.yaw;
    player.facing = resume.yaw;
  }
  hud.setLoading(progress, 'Cargando los alrededores…');
  await teleport(start.x, start.z);

  // Detrás de la pantalla de carga: compilar los shaders de lo que aún no salió en pantalla
  // (carro, otros personajes y sus variantes de sombra) para que usarlos no dé tirones.
  hud.setLoading(progress, 'Preparando personajes y carro…');
  const drives = roster.list.some((c) => c.abilities.drive);
  const carModel = drives ? await driving.prewarm(renderer, camera) : null;
  for (const a of await roster.loadAll()) gliderOf(a);
  const avatars = await roster.prewarm(renderer, camera, scene);
  const unseen: THREE.Object3D[] = [...avatars.filter((a) => a !== avatar).map((a) => a.root), gliderOf(avatar)];
  if (carModel) unseen.push(carModel);
  if (lamps) {
    // Postes alrededor del punto de partida y los halos (ocultos de día) ya compilados.
    lamps.update(player.position.x, player.position.z, camera, renderer);
    await renderer.compileAsync(lamps.group, camera, scene);
    unseen.push(lamps.group);
  }
  // Monumentos (luces y haces de noche incluidos, aunque de día estén ocultos).
  monuments.update(0, daytime.hours, camera, renderer);
  await renderer.compileAsync(monuments.group, camera, scene);
  unseen.push(monuments.group);
  if (palms) {
    await renderer.compileAsync(palms.group, camera, scene);
    unseen.push(palms.group);
  }
  if (glints) await renderer.compileAsync(glints.group, camera, scene);
  warmShadowPrograms(renderer, camera, unseen, game.prewarm.shadowMapSize, env.envMap);
  hud.setLoading(1, 'Listo');

  // Si ibas manejando, retomas en el carro.
  if (resume?.driving && player.character.abilities.drive) {
    const message = driving.board(player, avatar, follow.yaw, true);
    if (message) hud.toast(message);
    follow.snap();
    refreshLegend();
  }
  const here = (): Place => {
    const car = driving.active ? driving.car : null;
    const p = car ? car.position : player.position;
    return { x: p.x, z: p.z, yaw: car ? car.heading : follow.yaw, driving: car !== null };
  };
  lastPlace.saveOnLeave(here);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    // Cambiar el tamaño borra el canvas: en pausa hay que volver a dibujar la última imagen.
    needsRender = true;
  });

  /** Pose y animación del personaje según lo que está haciendo. */
  const syncAvatar = (dt: number): void => {
    const glider = gliderOf(avatar);
    const gliding = player.mode === 'glide';
    if (player.mode !== 'drive') {
      avatar.root.position.copy(player.position);
      avatar.root.rotation.y = player.facing;
    }
    glider.visible = gliding;
    glider.rotation.set(gliding ? -player.glide.pitch * 0.5 : 0, 0, gliding ? -player.glide.bank : 0);
    const speed = player.horizontalSpeed;
    if (player.mode === 'drive') avatar.play('drive');
    else if (gliding) avatar.play('glide');
    else if (player.mode === 'climb') avatar.play('climb', Math.abs(player.velocity.y));
    else if (player.mode === 'swim') avatar.play(speed > 0.3 ? 'swim' : 'swimIdle', speed);
    else if (player.mode === 'air') avatar.play('jump');
    else if (speed < 0.3) avatar.play('idle');
    else avatar.play(speed > avatar.cfg.runThreshold ? 'run' : 'walk', speed);
    // Postura del estado (acostado bajo el ala, de cara al muro al trepar…) y alabeo al planear.
    avatar.setLean(-avatar.posePitch(avatar.state ?? 'idle'), gliding ? -player.glide.bank : 0);
    avatar.update(dt);
    // En primera persona a pie no se ve el cuerpo; manejando sí (manos al volante), sin la cabeza.
    const body = driving.active && avatar.hasHead;
    avatar.root.visible = !follow.firstPerson || body;
    avatar.setHeadHidden(follow.firstPerson && body);
  };

  const subject: CameraSubject = {
    position: new THREE.Vector3(),
    targetHeight: 0,
    eye: new THREE.Vector3(),
    minDistance: 0,
    alignHeading: null,
    alignRate: 0,
    lead: new THREE.Vector3(),
    cabin: null,
  };
  const carCam = game.vehicles.car.camera;
  const cabin = {
    orientation: new THREE.Quaternion(),
    restPitch: THREE.MathUtils.degToRad(carCam.cabinPitchDeg),
    maxLook: THREE.MathUtils.degToRad(carCam.cabinLookDeg),
  };
  /** A quién sigue la cámara: el carro si manejas, si no el personaje. */
  const updateSubject = (): CameraSubject => {
    const view = driving.view();
    const cam = game.camera;
    if (view) {
      const car = game.vehicles.car.camera;
      subject.position.copy(view.position);
      subject.eye.copy(view.eye);
      subject.targetHeight = car.targetHeight;
      subject.minDistance = car.distance;
      subject.alignHeading = view.heading;
      subject.alignRate = car.alignRate;
      // Sin adelanto la cámara quedaría v / followLerp metros atrás (5 m a 180 km/h); se deja una parte.
      subject.lead.copy(view.velocity).multiplyScalar((1 - car.lagShare) / cam.followLerp);
      subject.lead.y = 0;
      cabin.orientation.copy(view.cabin);
      subject.cabin = cabin;
      return subject;
    }
    const p = player.position;
    const gliding = player.mode === 'glide';
    subject.position.copy(p);
    subject.eye.set(p.x, p.y + player.height * game.player.eyeShare, p.z);
    subject.targetHeight = player.height * game.player.cameraTargetShare;
    subject.minDistance = gliding ? cam.gliderDistance : cam.minDistance;
    subject.alignHeading = gliding ? player.glide.heading : null;
    subject.alignRate = cam.autoAlignRate;
    subject.lead.set(0, 0, 0);
    subject.cabin = null;
    return subject;
  };

  const timer = new THREE.Timer();
  timer.connect(document);
  let hudTimer = 0;
  let streamTimer = 0;
  container.focus();
  hud.hideLoading();
  // Lugares con historia: título de zona al entrar a un barrio, marcadores y fichas (ya jugando).
  let places: PlaceGuide | null = null;
  PlaceGuide.load(manifestUrl, manifest, game.places, heightmap, (x, z, label) => void goTo(x, z, label))
    .then((loaded) => {
      loaded.start();
      touch.onEnable(() => loaded.setCompact(true));
      // El barrio arriba a la izquierda (y en Compartir), y los nombres de zonas en el mapa grande.
      loaded.onZone((zone) => {
        hud.setLocation(zone);
        zoneName = zone ? [zone.name, ...zone.above].join(' · ') : manifest.name;
      });
      bigMap.setZones(loaded.zoneLabels());
      places = loaded;
    })
    .catch((err: unknown) => console.error('[places]', err));
  // Horizonte lejano (edificios altos de toda la ciudad), de a poco y ya jugando.
  void buildings.loadSkyline((mesh) => renderer.compileAsync(mesh, camera, scene));
  // Tráfico por las calles reales, también ya jugando (sus shaders se compilan antes de mostrarlo).
  let traffic: Traffic | null = null;
  const trafficGround = {
    heightmap,
    deckAt: (x: number, z: number, maxY: number) => (bridges ? bridges.deckAt(x, z, maxY) : -Infinity),
  };
  Traffic.load(manifestUrl, manifest, game.traffic, trafficGround, game.render.fog, renderer)
    .then(async (loaded) => {
      if (!loaded) return;
      // Sus calles son las del mapa del HUD.
      mapLayers.setRoads(loaded.roads);
      await renderer.compileAsync(loaded.group, camera, scene);
      scene.add(loaded.group);
      traffic = loaded;
    })
    .catch((err: unknown) => console.error('[traffic]', err));
  // Autos estacionados junto a las veredas (con el mismo programa de los del tráfico).
  ParkedCars.load(manifestUrl, manifest, game.parking, game.traffic, heightmap)
    .then(async (loaded) => {
      if (!loaded) return;
      await renderer.compileAsync(loaded.group, camera, scene);
      scene.add(loaded.group);
      parkedCars = loaded;
    })
    .catch((err: unknown) => console.error('[parking]', err));
  // Aerovía: torres, cables y cabinas que recorren la línea real a su velocidad.
  let aerialways: Aerialways | null = null;
  Aerialways.load(manifest, game.aerialways, game.render.fog, renderer)
    .then(async (loaded) => {
      if (!loaded) return;
      await renderer.compileAsync(loaded.group, camera, scene);
      scene.add(loaded.group);
      aerialways = loaded;
    })
    .catch((err: unknown) => console.error('[aerialways]', err));
  // Peatones por las veredas y senderos (con sus modelos de config/assets.json → crowd).
  let pedestrians: Pedestrians | null = null;
  const crowdModels: Record<string, { publicUrl: string }> = assets.crowd;
  const crowdUrl = (model: string): string => {
    const entry = crowdModels[model];
    if (!entry) throw new Error(`pedestrians.bodies usa el modelo "${model}", que no está en config/assets.json → crowd`);
    return new URL(entry.publicUrl, document.baseURI).href;
  };
  Pedestrians.load(manifestUrl, manifest, game.pedestrians, crowdUrl, trafficGround)
    .then(async (loaded) => {
      if (!loaded) return;
      // Sus shaders (también los de sombra) se compilan antes de que aparezca el primero.
      await loaded.warm((group) => renderer.compileAsync(group, camera, scene));
      loaded.warm((group) => warmShadowPrograms(renderer, camera, [group], game.prewarm.shadowMapSize, env.envMap));
      scene.add(loaded.group);
      pedestrians = loaded;
    })
    .catch((err: unknown) => console.error('[pedestrians]', err));
  // Ante qué frena el tráfico: el jugador a pie en el suelo y su carro (manejándolo o estacionado).
  const walker: TrafficObstacle = { x: 0, z: 0, radius: game.traffic.obstacles.walk };
  const parked: TrafficObstacle = { x: 0, z: 0, radius: game.traffic.obstacles.car };
  const obstacles: TrafficObstacle[] = [];
  const trafficObstacles = (): TrafficObstacle[] => {
    obstacles.length = 0;
    const car = driving.car;
    if (car && car.model.group.visible) {
      parked.x = car.position.x;
      parked.z = car.position.z;
      obstacles.push(parked);
    }
    if (player.mode === 'ground') {
      walker.x = player.position.x;
      walker.z = player.position.z;
      obstacles.push(walker);
    }
    return obstacles;
  };

  const limiter = new FrameLimiter(game.render.frameCap);
  const programs = new ProgramPin(renderer);
  /** Avisos por cada frame dibujado (solo los usa el banco de pruebas en desarrollo). */
  const frameHooks = new Set<(frameMs: number) => void>();
  /** Tiempo del mundo (s): corre solo jugando (en pausa el agua y el marcador quedan quietos). */
  let worldTime = 0;
  /** Velocidad que se muestra (m/s): la del carro, la del vuelo o la del paso. */
  const shownSpeed = (): number => {
    const car = driving.active ? driving.car : null;
    if (car) return car.speed;
    return player.mode === 'glide' ? player.velocity.length() : player.horizontalSpeed;
  };
  const radarSubject = { x: 0, z: 0, facing: 0, cameraYaw: 0, speed: 0 };
  const updateRadar = (dt: number): void => {
    radarSubject.x = player.position.x;
    radarSubject.z = player.position.z;
    radarSubject.facing = player.facing;
    radarSubject.cameraYaw = follow.yaw;
    radarSubject.speed = shownSpeed();
    minimap.update(dt, radarSubject);
  };
  const updateClock = (): void => {
    const arc = daytime.dayArc();
    clock.update(daytime.hours, daytime.current.label, arc.day, arc.progress);
  };
  const draw = (): void => {
    cockpit.set(driving.active && follow.firstPerson ? driving.car!.model.group : null);
    renderer.info.reset();
    gpuTimer?.begin();
    renderer.render(scene, camera);
    cockpit.render(renderer, scene, camera);
    gpuTimer?.end();
  };
  /** Luces y cielo de lo que se ve (la hora cambió en pausa): todo quieto, `dt` 0. */
  const redrawFrozen = (): void => {
    const cam = camera.position;
    env.update(0, camera, cam.y - heightmap.sample(cam.x, cam.z));
    lamps?.update(player.position.x, player.position.z, camera, renderer);
    monuments.update(0, daytime.hours, camera, renderer);
    if (glints) {
      const b = glints.movingBuffers;
      glints.commitMoving(monuments.reflectedLights(b.head, b.tint, b.power));
      glints.update(0, camera, renderer);
    }
    aerialways?.update(0, daytime.hours, camera, renderer);
    draw();
  };
  updateClock();
  renderer.setAnimationLoop((timestamp) => {
    if (!limiter.accept(timestamp)) return;
    timer.update(timestamp);
    const frameSeconds = timer.getDelta();

    // Pausa, mapa y hora funcionan en cualquier pantalla. Si el navegador acaba de soltar el
    // mouse con Esc (y ya pausó), esa misma Esc no cuenta para seguir.
    if (controls.consume('pause') && performance.now() - lockLostAt > game.hud.lockGraceMs) {
      setScreen(screen === 'map' ? mapBack : screen === 'play' ? 'pause' : 'play');
    }
    if (controls.consume('map')) setScreen(screen === 'map' ? mapBack : 'map');
    if (controls.consume('timeOfDay')) daytime.cycle();

    if (screen !== 'play') {
      // Congelado: nada se mueve ni se redibuja, salvo el time-lapse de la hora (se ve el cielo
      // cambiar) o si la ventana cambió de tamaño. Los mapas sí (son 2D y livianos).
      if (daytime.update(frameSeconds)) {
        env.apply(daytime.celestial, daytime.instant);
        env.blend(daytime.blend);
        needsRender = true;
      }
      if (needsRender) {
        needsRender = false;
        redrawFrozen();
      }
      updateClock();
      if (screen !== 'map') updateRadar(0);
      bigMap.update();
      mapLayers.pump(game.map.big.tileBudgetMs);
      controls.input.endFrame();
      return;
    }

    quality.update(performance.now(), frameSeconds * 1000);
    const dt = Math.min(frameSeconds, 0.05);
    worldTime += dt;

    if (controls.consume('character')) void switchCharacter();
    if (daytime.update(frameSeconds)) {
      env.apply(daytime.celestial, daytime.instant);
      env.blend(daytime.blend);
      updateClock();
    }
    if (controls.consume('vehicle')) {
      const message = driving.toggle(player, avatar, follow.yaw, controls.label('character'));
      if (message) hud.toast(message);
    }
    if (driving.active) driving.update(dt, controls, player);
    else {
      player.update(dt, controls, follow.yaw);
      driving.update(dt, controls, player);
    }
    driving.updateHeadlights();
    refreshLegend();
    touch.setContext(touchContext(), player.character.abilities);
    syncAvatar(dt);

    follow.update(dt, controls, updateSubject());
    const cam = camera.position;
    env.update(dt, camera, cam.y - heightmap.sample(cam.x, cam.z));
    lamps?.update(player.position.x, player.position.z, camera, renderer);
    monuments.update(dt, daytime.hours, camera, renderer);
    palms?.update(dt, camera);
    if (glints) {
      const b = glints.movingBuffers;
      glints.commitMoving(monuments.reflectedLights(b.head, b.tint, b.power));
      glints.update(dt, camera, renderer);
    }
    // Los peatones se detienen ante el jugador y su carro; los carros, además, ante quien cruza.
    const blockers = trafficObstacles();
    pedestrians?.update(dt, player.position.x, player.position.z, daytime.hours, camera, traffic, blockers);
    pedestrians?.obstacles(blockers);
    traffic?.update(dt, player.position.x, player.position.z, camera, renderer, blockers, daytime.hours);
    parkedCars?.update(camera);
    aerialways?.update(dt, daytime.hours, camera, renderer);
    places?.update(dt, player.position, camera);
    trees.draw(camera);
    water.update(worldTime);
    marker.update(worldTime);

    // Carga por partes alrededor del jugador (a intervalos) y armado de meshes (tope por frame).
    streamTimer -= dt;
    if (streamTimer <= 0) {
      streamTimer = game.streaming.updateIntervalSeconds;
      const p = player.position;
      const altitude = p.y - heightmap.sample(p.x, p.z);
      buildings.update(p.x, p.z, altitude);
      terrain.update(p.x, p.z);
      trees.update(p.x, p.z);
      roads.update(p.x, p.z);
      sky.update(p.x, p.z);
      imagery.update(camera.position.x, camera.position.z, camera.position.y - heightmap.sample(camera.position.x, camera.position.z));
    }
    buildings.pump();
    roads.pump();

    lastPlace.tick(dt, here);
    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = game.hudRefreshSeconds;
      const p = player.position;
      const ground = player.groundAt(p.x, p.z, p.y + player.stepHeight);
      const car = driving.active ? driving.car : null;
      let detail = '';
      if (car?.stalled) detail = 'MOTOR AHOGADO';
      else if (car?.reversing) detail = 'REVERSA';
      else if (car?.escActive) detail = 'CONTROL DE ESTABILIDAD';
      hud.setStatus({
        mode: player.mode,
        speed: shownSpeed(),
        speedMultiplier: car ? (car.canBoost ? car.boost : null) : player.canBoost ? player.speedMultiplier : null,
        modeDetail: detail,
        heightAboveGround: Math.max(0, p.y - Math.max(ground, manifest.waterLevel)),
      });
      updateClock();
    }
    updateRadar(dt);
    mapLayers.pump(game.minimap.tileBudgetMs);

    draw();
    programs.update();
    controls.input.endFrame();
    for (const hook of frameHooks) hook(frameSeconds * 1000);
  });

  if (import.meta.env.DEV) {
    // Acceso para depurar desde la consola del navegador; el banco de pruebas se carga aparte
    // (import dinámico) para que no entre al build de producción.
    const { createBench } = await import('./dev/bench');
    const { createShots } = await import('./dev/shots');
    const onFrame = (hook: (frameMs: number) => void): (() => void) => {
      frameHooks.add(hook);
      return () => frameHooks.delete(hook);
    };
    const bench = createBench({ renderer, gpuTimer, onFrame, player, follow, driving, roads, buildings, heightmap, geo, teleport });
    const shots = createShots({
      follow,
      player,
      daytime,
      teleport,
      lamps: lamps?.data ?? null,
      armShare: game.render.lighting.streetLights.armShare,
      container,
    });
    Object.assign(window, {
      __gye: {
        bench,
        shots,
        geo,
        player,
        follow,
        imagery,
        terrain,
        buildings,
        trees,
        roads,
        heightmap,
        teleport,
        goTo,
        marker,
        search,
        renderer,
        scene,
        daytime,
        env,
        lamps,
        bridges,
        monuments,
        palms,
        glints,
        traffic: () => traffic,
        pedestrians: () => pedestrians,
        parkedCars: () => parkedCars,
        aerialways: () => aerialways,
        sky,
        roster,
        driving,
        controls,
        quality,
        limiter,
        programs,
        gpuTimer,
        avatar: () => avatar,
        screen: () => screen,
        setScreen,
        mapLayers,
        minimap,
        bigMap,
        pauseMenu,
      },
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  hud.failLoading(err instanceof Error ? err.message : String(err));
});
