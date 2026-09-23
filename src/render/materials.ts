import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { BUILDING_STYLE, PORTAL_FLAG, SURFACE } from '../world/buildingFormat';
import { PITCH_CODE_STRIDE, PITCH_SPORT, PITCH_SURFACE } from '../world/groundFormat';
import { FACADE_MAIN, facadeParsGLSL, facadeUniforms } from './facade';
import { lighting } from './lightingUniforms';
import { NIGHT_APPLY, NIGHT_FRAGMENT_PARS, NIGHT_KEY, nightCompute, nightLight } from './nightLight';

/** Chunk al que pertenece un material de edificios (origen y lado en metros). */
export interface ChunkRect {
  x0: number;
  z0: number;
  size: number;
}

/** Imagen satelital de un chunk: textura + matriz UV local del chunk -> UV de la textura. */
export interface RoofImage {
  texture: THREE.Texture;
  matrix: THREE.Matrix3;
}

type ShaderUniforms = Record<string, THREE.IUniform>;

const color = (hex: string): THREE.Color => new THREE.Color(hex);

/** Patrón de cada material de calle en el shader (config/game.json → roads.materials[*].style). */
const ROAD_STYLES: Record<string, number> = { asphalt: 0, slabs: 1, pavers: 2, dirt: 3 };

/** Estilo de las calles, compartido por todos los chunks de terreno (ver src/world/roadWorker.ts). */
export interface RoadShading {
  uniforms: ShaderUniforms;
  /** Textura vacía para los chunks sin calles cargadas. */
  empty: THREE.Texture;
}

/** Texturas de calles de un chunk, en el formato de src/world/roadWorker.ts. */
export interface RoadLayerTextures {
  textures: THREE.Texture[];
}

/**
 * Uniformes del aspecto de una calzada (color, grano y patrón de cada material, veredas y
 * marcas), por canal en el orden de `drawOrder`: los comparten el terreno y los tableros de
 * los puentes (ver ROAD_SURFACE_PARS).
 */
export function roadSurfaceUniforms(cfg: GameConfig['roads']): ShaderUniforms {
  const perChannel = cfg.drawOrder.map((name) => {
    const mat = (cfg.materials as Record<string, (typeof cfg.materials)['asphalt'] | undefined>)[name];
    const style = mat ? ROAD_STYLES[mat.style] : undefined;
    if (!mat || style === undefined) throw new Error(`Material de calle mal configurado en config/game.json: ${name}`);
    return { mat, style };
  });
  const { slabs, pavers, dirt, sidewalk: walk, markings: mk } = cfg;
  return {
    uRoadColor: { value: perChannel.map(({ mat }) => color(mat.color)) },
    uRoadGrain: {
      value: perChannel.map(({ mat }) => new THREE.Vector4(mat.grain, mat.grainScale, mat.patches, mat.patchScale)),
    },
    uRoadStyle: { value: perChannel.map(({ style }) => style) },
    uRoadMarkable: { value: perChannel.map(({ mat }) => (mat.marked ? 1 : 0)) },
    uRoadSlabs: { value: new THREE.Vector3(slabs.length, slabs.joint, slabs.jointShade) },
    uRoadPavers: { value: new THREE.Vector4(pavers.length, pavers.width, pavers.joint, pavers.jointShade) },
    uRoadPaverVariation: { value: pavers.variation },
    uRoadDirt: { value: new THREE.Vector4(dirt.rutOffset, dirt.rutWidth, dirt.rutShade, dirt.pebbleSize) },
    uRoadPebbles: { value: new THREE.Vector2(dirt.pebbleAmount, dirt.pebbleShade) },
    uRoadSidewalk: { value: color(walk.color) },
    uRoadCurb: { value: color(walk.curbColor) },
    uRoadWalk: { value: new THREE.Vector4(walk.curbWidth, walk.tile, walk.joint, walk.jointShade) },
    uRoadWalk2: { value: new THREE.Vector4(walk.grain, walk.grainScale, walk.gutterWidth, walk.gutterShade) },
    uRoadWhite: { value: color(mk.white) },
    uRoadYellow: { value: color(mk.yellow) },
    uRoadMark: { value: new THREE.Vector4(mk.lineWidth, mk.doubleGap, mk.dash, mk.edgeInset) },
    uRoadMarkMisc: {
      value: new THREE.Vector4(cfg.raster.period, cfg.raster.laneCodeStride, mk.junctionFade, mk.wear),
    },
    uRoadMarkRules: {
      value: new THREE.Vector4(mk.doubleCenterMinLanes, mk.edgeLinesMinLanes, mk.edgeLinesMinLanesOneway, mk.frameTolerance),
    },
    uRoadMarkMisc2: { value: new THREE.Vector2(mk.wearScale, mk.stableTolerance) },
  };
}

export function createRoadShading(cfg: GameConfig['roads'], cells: number, side: number): RoadShading {
  const { crosswalk: cw, parks, pitches } = cfg;
  const lineWidth = pitches.lineWidth as Record<keyof typeof PITCH_SPORT, number>;
  const sportWidths = (Object.keys(PITCH_SPORT) as (keyof typeof PITCH_SPORT)[])
    .sort((a, b) => PITCH_SPORT[a] - PITCH_SPORT[b])
    .map((name) => {
      if (lineWidth[name] === undefined) throw new Error(`Falta roads.pitches.lineWidth.${name} en config/game.json`);
      return lineWidth[name];
    });
  const empty = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  empty.needsUpdate = true;
  return {
    empty,
    uniforms: {
      ...roadSurfaceUniforms(cfg),
      uRoadGrid: { value: new THREE.Vector2(cells, side) },
      uRoadFade: { value: new THREE.Vector2(cfg.fade.start, cfg.fade.end) },
      uRoadLight: { value: new THREE.Vector2(cfg.light.lit, cfg.light.self) },
      uRoadFeather: { value: cfg.feather },
      uRoadCross: { value: new THREE.Vector3(cw.length, cw.stripePeriod, cw.stripeDuty) },
      uParkTile: { value: new THREE.Vector4(parks.tile, parks.joint, parks.jointShade, parks.variation) },
      uParkColor: { value: color(parks.color) },
      uParkMix: { value: parks.colorMix },
      uParkFade: { value: new THREE.Vector2(parks.fade.start, parks.fade.end) },
      uPitchLineColor: { value: color(pitches.lineColor) },
      uPitchLineW: { value: sportWidths },
      uPitchSurface: {
        value: new THREE.Vector4(pitches.stripeWidth, pitches.stripeShade, pitches.hardGrain, pitches.wear),
      },
      uPitchScales: { value: new THREE.Vector2(pitches.hardGrainScale, pitches.wearScale) },
    },
  };
}

/** Texturas por chunk que arma src/world/roadWorker.ts (T0…T4). */
const ROAD_TEXTURES = 5;

/** Pone (o quita, con null) las texturas de calles de un chunk en su material de terreno. */
export function setRoadLayer(material: THREE.Material, layer: RoadLayerTextures | null): void {
  const road = material.userData.road as { uniforms: ShaderUniforms; empty: THREE.Texture } | undefined;
  if (!road) return;
  for (let k = 0; k < ROAD_TEXTURES; k++) road.uniforms[`uRoad${k}`].value = layer ? layer.textures[k] : road.empty;
  road.uniforms.uRoadOn.value = layer ? 1 : 0;
}

/** Oclusión ambiental de un chunk: su imagen (ver world/skyOcclusion.ts) y dónde está. */
function skyUniforms(texture: THREE.Texture, rect: ChunkRect): ShaderUniforms {
  return {
    uSkyMap: { value: texture },
    uSkyRect: { value: new THREE.Vector3(rect.x0, rect.z0, rect.size) },
    uSkyLook: lighting.uSkyLook,
  };
}

/**
 * Cielo visible del suelo en (x, z) (x, con las copas según su opacidad) y altura de lo que
 * lo tapa (y, normalizada: metros = y · uSkyFacade.w).
 */
const SKY_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uSkyMap;
uniform vec3 uSkyRect;
uniform vec4 uSkyLook;
vec2 gyeSkyAt(vec2 xz) {
  vec3 s = texture2D(uSkyMap, (xz - uSkyRect.xy) / uSkyRect.z).rgb;
  return vec2(mix(s.r, s.g, uSkyLook.x), s.b);
}`;

/** Aplica el cielo visible a la luz del cielo y a los reflejos (después de `lights_fragment_end`). */
function skyApply(sky: string): string {
  return /* glsl */ `
reflectedLight.indirectDiffuse *= mix(1.0, ${sky}, uSkyLook.y);
reflectedLight.indirectSpecular *= mix(1.0, ${sky}, uSkyLook.w);`;
}

/** Calles sobre la foto: calzada por material, veredas con bordillo, líneas de carril y pasos cebra. */
/**
 * Superficie de una calzada en el shader: declaraciones de `roadSurfaceUniforms` y funciones
 * de ruido, juntas, patrón de cada material (`gyeRoadSurface`). La comparten el terreno y los
 * tableros de los puentes.
 */
export const ROAD_SURFACE_PARS = /* glsl */ `
uniform vec3 uRoadColor[4];
uniform vec4 uRoadGrain[4];
uniform float uRoadStyle[4];
uniform float uRoadMarkable[4];
uniform vec3 uRoadSlabs;
uniform vec4 uRoadPavers;
uniform float uRoadPaverVariation;
uniform vec4 uRoadDirt;
uniform vec2 uRoadPebbles;
uniform vec3 uRoadSidewalk;
uniform vec3 uRoadCurb;
uniform vec4 uRoadWalk;
uniform vec4 uRoadWalk2;
uniform vec3 uRoadWhite;
uniform vec3 uRoadYellow;
uniform vec4 uRoadMark;
uniform vec4 uRoadMarkMisc;
uniform vec4 uRoadMarkRules;
uniform vec2 uRoadMarkMisc2;
// Guardia numérica para divisiones (no es un parámetro visual).
#define GYE_ROAD_EPS 1e-4
// Hash sin seno (Dave Hoskins): estable con coordenadas de mundo grandes.
float gyeRoadHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gyeRoadNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gyeRoadHash(i), gyeRoadHash(i + vec2(1.0, 0.0)), f.x),
    mix(gyeRoadHash(i + vec2(0.0, 1.0)), gyeRoadHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
// 1 dentro de una franja de medio ancho h alrededor de x = 0, con borde suavizado aa.
float gyeBand(float x, float h, float aa) { return 1.0 - smoothstep(h - aa, h + aa, abs(x)); }
// Juntas de ancho w cada 'period' metros.
float gyeJoint(float x, float period, float w, float aa) {
  float f = mod(x, period);
  return gyeBand(min(f, period - f), w * 0.5, aa);
}
// Un patrón de período p se apaga cuando el píxel cubre más de medio período (evita moiré).
float gyeFine(float p, float aa) { return 1.0 - smoothstep(0.25, 0.5, aa / p); }
float gyePaverShade(vec2 uv, float aa) {
  float row = floor(uv.y / uRoadPavers.y);
  float u = uv.x + mod(row, 2.0) * uRoadPavers.x * 0.5;
  float joint = max(gyeJoint(u, uRoadPavers.x, uRoadPavers.z, aa), gyeJoint(uv.y, uRoadPavers.y, uRoadPavers.z, aa));
  float fine = gyeFine(uRoadPavers.y, aa);
  float brick = gyeRoadHash(vec2(floor(u / uRoadPavers.x), row));
  return (1.0 - uRoadPavers.w * joint * fine) * (1.0 + (brick - 0.5) * uRoadPaverVariation * fine);
}
// Color de la calzada del canal k: base * tono de la foto, grano, manchas y el patrón del material.
vec3 gyeRoadSurface(int k, vec2 world, float along, float across, float frame, float tone, float aa) {
  vec4 g = uRoadGrain[k];
  float grain = mix(0.5, gyeRoadNoise(world / g.y), gyeFine(g.y, aa));
  float patches = gyeRoadNoise(world / g.w);
  vec3 c = uRoadColor[k] * tone * (1.0 + (grain - 0.5) * g.x) * (1.0 + (patches - 0.5) * g.z);
  float style = uRoadStyle[k];
  if (style > 0.5 && style < 1.5) {
    // Losas de hormigón: juntas transversales y una longitudinal en el eje.
    float joints = max(gyeJoint(along, uRoadSlabs.x, uRoadSlabs.y, aa), gyeBand(across, uRoadSlabs.y * 0.5, aa));
    c *= 1.0 - uRoadSlabs.z * joints * frame * gyeFine(uRoadSlabs.x, aa);
  } else if (style > 1.5 && style < 2.5) {
    // Adoquines alineados a la calle; lejos de las calles (plazas), a los ejes del mundo.
    c *= mix(gyePaverShade(world, aa), gyePaverShade(vec2(along, across), aa), frame);
  } else if (style > 2.5) {
    // Tierra: huellas de llantas a ambos lados del eje y piedritas.
    c *= 1.0 - uRoadDirt.z * gyeBand(abs(across) - uRoadDirt.x, uRoadDirt.y * 0.5, aa) * frame;
    // Piedritas: manchas redondeadas donde el ruido pasa un umbral (borde suavizado por píxel).
    float pebbleNoise = gyeRoadNoise(world / uRoadDirt.w);
    float pebbleEdge = aa / uRoadDirt.w;
    float pebble = smoothstep(1.0 - uRoadPebbles.x - pebbleEdge, 1.0 - uRoadPebbles.x + pebbleEdge, pebbleNoise);
    c *= 1.0 - uRoadPebbles.y * pebble * gyeFine(uRoadDirt.w, aa);
  }
  return c;
}
`;

const ROAD_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uRoad0;
uniform sampler2D uRoad1;
uniform sampler2D uRoad2;
uniform sampler2D uRoad3;
uniform sampler2D uRoad4;
uniform vec4 uParkTile;
uniform vec3 uParkColor;
uniform float uParkMix;
uniform vec2 uParkFade;
uniform vec3 uPitchLineColor;
uniform float uPitchLineW[${Object.keys(PITCH_SPORT).length}];
uniform vec4 uPitchSurface;
uniform vec2 uPitchScales;
#define GYE_PITCH_STRIDE ${PITCH_CODE_STRIDE}.0
#define GYE_SPORT_SOCCER ${PITCH_SPORT.soccer}.0
#define GYE_SPORT_BASKETBALL ${PITCH_SPORT.basketball}.0
#define GYE_SPORT_VOLLEYBALL ${PITCH_SPORT.volleyball}.0
#define GYE_SPORT_TENNIS ${PITCH_SPORT.tennis}.0
#define GYE_SURFACE_PHOTO ${PITCH_SURFACE.photo}.0
#define GYE_SURFACE_GRASS ${PITCH_SURFACE.grass}.0
#define GYE_SURFACE_TURF ${PITCH_SURFACE.turf}.0
#define GYE_SURFACE_HARD ${PITCH_SURFACE.hard}.0
uniform float uRoadOn;
uniform vec4 uRoadRect;
uniform vec2 uRoadGrid;
uniform vec2 uRoadFade;
uniform vec2 uRoadLight;
uniform float uRoadFeather;
uniform vec3 uRoadCross;
${ROAD_SURFACE_PARS}
// Línea de ancho w centrada en d = 0.
float gyeLine(float d, float w, float aa) { return gyeBand(d, w * 0.5, aa); }
// Contorno de un rectángulo centrado de medio largo/ancho e.
float gyeOutline(vec2 p, vec2 e, float w, float aa) {
  vec2 a = abs(p);
  return max(gyeLine(a.x - e.x, w, aa) * step(a.y, e.y + w * 0.5), gyeLine(a.y - e.y, w, aa) * step(a.x, e.x + w * 0.5));
}
bool gyeIs(float a, float b) { return abs(a - b) < 0.5; }
// Líneas reglamentarias escaladas a la cancha (p: a lo largo y a lo ancho desde el centro,
// H: medio largo y medio ancho). Proporciones de las medidas oficiales de cada deporte.
float gyePitchLines(float sport, vec2 p, vec2 H, float w, float aa) {
  vec2 e = H - w * 0.5;
  vec2 a = abs(p);
  float L = 2.0 * e.x;
  float W = 2.0 * e.y;
  float l = gyeOutline(p, e, w, aa);
  float mid = gyeLine(p.x, w, aa) * step(a.y, e.y);
  l = max(l, mid);
  if (gyeIs(sport, GYE_SPORT_SOCCER)) {
    // Círculo central 9,15 m, áreas 16,5 × 40,3 m y 5,5 × 18,3 m, punto penal a 11 m (cancha de 105 × 68).
    l = max(l, gyeLine(length(p) - 0.0871 * L, w, aa));
    l = max(l, 1.0 - smoothstep(w - aa, w + aa, length(p)));
    vec2 box = vec2(0.157 * L, 0.2965 * W);
    l = max(l, gyeLine(a.x - (e.x - box.x), w, aa) * step(a.y, box.y));
    l = max(l, gyeLine(a.y - box.y, w, aa) * step(e.x - box.x, a.x));
    vec2 goal = vec2(0.0524 * L, 0.1346 * W);
    l = max(l, gyeLine(a.x - (e.x - goal.x), w, aa) * step(a.y, goal.y));
    l = max(l, gyeLine(a.y - goal.y, w, aa) * step(e.x - goal.x, a.x));
    vec2 spot = vec2(a.x - (e.x - 0.1048 * L), p.y);
    l = max(l, 1.0 - smoothstep(w - aa, w + aa, length(spot)));
    l = max(l, gyeLine(length(spot) - 0.0871 * L, w, aa) * step(a.x, e.x - box.x));
  } else if (gyeIs(sport, GYE_SPORT_BASKETBALL)) {
    // Círculo 1,8 m, zona 5,8 × 4,9 m y triple a 6,75 m del aro, con rectas a 6,6 m del eje (cancha de 28 × 15).
    l = max(l, gyeLine(length(p) - 0.0643 * L, w, aa));
    vec2 key = vec2(0.2071 * L, 0.1633 * W);
    l = max(l, gyeLine(a.x - (e.x - key.x), w, aa) * step(a.y, key.y));
    l = max(l, gyeLine(a.y - key.y, w, aa) * step(e.x - key.x, a.x));
    l = max(l, gyeLine(length(vec2(a.x - (e.x - key.x), p.y)) - 0.0643 * L, w, aa) * step(a.x, e.x - key.x));
    float hoop = e.x - 0.0563 * L;
    float r3 = 0.2411 * L;
    float side = 0.44 * W;
    float cut = sqrt(max(r3 * r3 - side * side, 0.0));
    l = max(l, gyeLine(length(vec2(a.x - hoop, p.y)) - r3, w, aa) * step(a.y, side) * step(a.x, hoop));
    l = max(l, gyeLine(a.y - side, w, aa) * step(hoop - cut, a.x));
  } else if (gyeIs(sport, GYE_SPORT_VOLLEYBALL)) {
    // Líneas de ataque a 3 m de la red (cancha de 18 × 9).
    l = max(l, gyeLine(a.x - e.x / 3.0, w, aa) * step(a.y, e.y));
  } else if (gyeIs(sport, GYE_SPORT_TENNIS)) {
    // Laterales de singles, líneas de saque a 6,4 m de la red y central (cancha de 23,77 × 10,97).
    float singles = 0.75 * e.y;
    float service = 0.5385 * e.x;
    l = max(l, gyeLine(a.y - singles, w, aa) * step(a.x, e.x));
    l = max(l, gyeLine(a.x - service, w, aa) * step(a.y, singles));
    l = max(l, gyeLine(p.y, w, aa) * step(a.x, service));
  }
  return l;
}
`;

/** Parques (baldosas donde la foto no es verde) y canchas (superficie y líneas), bajo las calles. */
const GROUND_AREAS_MAIN = /* glsl */ `
if (uRoadOn > 0.5) {
  vec2 gCell = (vGroundWorld.xz - uRoadRect.xy) / uRoadRect.z * uRoadGrid.x;
  vec2 gUV = (gCell + 1.0) / uRoadGrid.y;
  vec4 t3 = texture2D(uRoad3, gUV);
  vec4 t4 = texture2D(uRoad4, gUV);
  float pitch = 1.0 - smoothstep(-gyeAA, gyeAA, t3.y);
  // Las canchas dentro de un parque tapan sus baldosas.
  float park = (1.0 - smoothstep(-gyeAA, gyeAA, t3.x)) * (1.0 - gyeGreen) * (1.0 - pitch);
  park *= 1.0 - smoothstep(uParkFade.x, uParkFade.y, gyeDist);
  if (park > 0.0) {
    float fine = gyeFine(uParkTile.x, gyeAA);
    float joint = max(gyeJoint(gyeLocal.x, uParkTile.x, uParkTile.y, gyeAA), gyeJoint(gyeLocal.y, uParkTile.x, uParkTile.y, gyeAA));
    float tile = gyeRoadHash(floor(gyeLocal / uParkTile.x));
    vec3 paved = mix(gyeGround, uParkColor, uParkMix);
    paved *= (1.0 - uParkTile.z * joint * fine) * (1.0 + (tile - 0.5) * uParkTile.w * fine);
    gyeGround = mix(gyeGround, paved, park);
  }
  if (pitch > 0.0) {
    float code = floor(t3.z + 0.5);
    float sport = floor((code + 0.5) / GYE_PITCH_STRIDE);
    float kind = code - sport * GYE_PITCH_STRIDE;
    vec3 surf = gyeGround;
    bool grassy = gyeIs(kind, GYE_SURFACE_GRASS) || gyeIs(kind, GYE_SURFACE_TURF) || (gyeIs(kind, GYE_SURFACE_PHOTO) && gyeGreen > 0.5);
    if (grassy) {
      // Franjas de corte del césped, a lo ancho de la cancha.
      float stripe = mod(floor(t4.x / uPitchSurface.x), 2.0);
      surf *= 1.0 + (stripe - 0.5) * 2.0 * uPitchSurface.y;
    } else if (gyeIs(kind, GYE_SURFACE_HARD)) {
      surf *= 1.0 + (gyeRoadNoise(gyeLocal / uPitchScales.x) - 0.5) * uPitchSurface.z * gyeFine(uPitchScales.x, gyeAA);
    }
    float width = uPitchLineW[int(clamp(sport, 0.0, float(${Object.keys(PITCH_SPORT).length - 1})))];
    float lines = gyePitchLines(sport, t4.xy, t4.zw, width, gyeAA);
    float wear = 1.0 - uPitchSurface.w * gyeRoadNoise(gyeLocal / uPitchScales.y);
    surf = mix(surf, uPitchLineColor, clamp(lines, 0.0, 1.0) * wear);
    gyeGround = mix(gyeGround, surf, pitch);
  }
}
`;

const ROAD_FRAGMENT_MAIN = /* glsl */ `
float gyeRoadA = 0.0;
vec3 gyeRoadRGB = vec3(0.0);
if (uRoadOn > 0.5) {
  vec2 world = vGroundWorld.xz;
  vec2 cell = (world - uRoadRect.xy) / uRoadRect.z * uRoadGrid.x;
  vec2 ruv = (cell + 1.0) / uRoadGrid.y;
  vec4 t0 = texture2D(uRoad0, ruv);
  vec4 t1 = texture2D(uRoad1, ruv);
  vec4 t2 = texture2D(uRoad2, ruv);
  // Derivadas fuera de cualquier rama no uniforme.
  float aa = length(fwidth(world));
  float codeChange = fwidth(t2.x) / max(length(fwidth(cell)), GYE_ROAD_EPS);
  // Gradientes en metros de mundo: dentro de una misma calle |∇(distancia al eje)| = 1 y
  // |∇(posición a lo largo)| <= 1. Donde el texel mezcla dos calles distintas no se cumple,
  // y ahí se apagan los patrones que dependen del eje (líneas, cebras, juntas).
  vec2 wx = dFdx(world);
  vec2 wy = dFdy(world);
  mat2 screenToWorld = mat2(wx.x, wy.x, wx.y, wy.y);
  float areaPx = abs(determinant(screenToWorld));
  mat2 worldGrad = areaPx > GYE_ROAD_EPS * length(wx) * length(wy) ? inverse(screenToWorld) : mat2(0.0);
  float gradAcross = length(worldGrad * vec2(dFdx(t1.y), dFdy(t1.y)));
  float phase2 = max(dot(t1.zw, t1.zw), GYE_ROAD_EPS);
  vec2 dPhase = vec2(t1.w * dFdx(t1.z) - t1.z * dFdx(t1.w), t1.w * dFdy(t1.z) - t1.z * dFdy(t1.w)) / phase2;
  float gradAlong = length(worldGrad * dPhase) * uRoadMarkMisc.x / (2.0 * PI);
  float tol = uRoadMarkRules.w;
  float frameOK = (1.0 - smoothstep(tol, tol * 2.0, abs(gradAcross - 1.0))) * (1.0 - smoothstep(1.0 + tol, 1.0 + tol * 2.0, gradAlong));
  float fade = 1.0 - smoothstep(uRoadFade.x, uRoadFade.y, length(vViewPosition));
  if (fade > 0.0 && aa > 0.0) {
    float period = uRoadMarkMisc.x;
    float owned = clamp(length(t1.zw), 0.0, 1.0);
    float frame = owned * frameOK;
    float along = mod(atan(t1.z, t1.w + step(owned, 0.0)) / (2.0 * PI) * period, period);
    float across = t1.y;
    float walkW = t1.x;
    float hasWalk = step(uRoadWalk.x, walkW);
    float sdMin = min(min(t0.x, t0.y), min(t0.z, t0.w));

    // Calzada: el primer canal que cubre el punto es el que se ve (orden de dibujo).
    float soft = uRoadFeather * (1.0 - hasWalk);
    float covered = 0.0;
    float markable = 0.0;
    vec3 surf = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      float cov = (1.0 - smoothstep(-aa - soft, aa, t0[k])) * (1.0 - covered);
      if (cov > 0.0) {
        surf += cov * gyeRoadSurface(k, world, along, across, frame, t2.w, aa);
        markable += cov * uRoadMarkable[k];
      }
      covered += cov;
    }
    vec3 road = surf / max(covered, GYE_ROAD_EPS);
    markable /= max(covered, GYE_ROAD_EPS);
    road *= 1.0 - uRoadWalk2.w * hasWalk * (1.0 - smoothstep(0.0, uRoadWalk2.z, -sdMin));

    // Líneas: el código trae carriles, ancho de carril y sentido de la calle dueña del punto.
    float code = t2.x;
    float lanes = floor(abs(code) / uRoadMarkMisc.y);
    float laneW = abs(code) - lanes * uRoadMarkMisc.y;
    float halfW = lanes * laneW * 0.5;
    float white = 0.0;
    float yellow = 0.0;
    if (lanes > 0.5 && codeChange < uRoadMarkMisc2.y && abs(across) < halfW) {
      float lh = uRoadMark.x * 0.5;
      float dash = smoothstep(-aa, aa, along) * (1.0 - smoothstep(uRoadMark.z - aa, uRoadMark.z + aa, along));
      float ad = abs(across);
      if (code > 0.0) {
        bool wide = lanes >= uRoadMarkRules.x;
        yellow = wide ? gyeBand(ad - (uRoadMark.y * 0.5 + lh), lh, aa) : gyeBand(across, lh, aa) * dash;
        float k = floor(ad / laneW + 0.5);
        if (k > 0.5 && k < floor(lanes * 0.5) - 0.5) white = gyeBand(ad - k * laneW, lh, aa) * dash;
        if (lanes >= uRoadMarkRules.y) white = max(white, gyeBand(ad - (halfW - uRoadMark.w), lh, aa));
      } else {
        float k = floor((across + halfW) / laneW + 0.5);
        if (k > 0.5 && k < lanes - 0.5) white = gyeBand(across + halfW - k * laneW, lh, aa) * dash;
        if (lanes >= uRoadMarkRules.z) white = max(white, gyeBand(ad - (halfW - uRoadMark.w), lh, aa));
      }
      float open = smoothstep(0.0, uRoadMarkMisc.z, t2.y) * frame;
      white *= open;
      yellow *= open;
    }
    // Paso cebra: franjas paralelas a la calle alrededor de cada cruce.
    float zebraBand = 1.0 - smoothstep(uRoadCross.x * 0.5 - aa, uRoadCross.x * 0.5 + aa, t2.z);
    float stripe = fract(across / uRoadCross.y);
    float stripeAA = aa / uRoadCross.y;
    float zebra = smoothstep(0.0, stripeAA, stripe) * (1.0 - smoothstep(uRoadCross.z - stripeAA, uRoadCross.z + stripeAA, stripe));
    white = max(white, zebraBand * zebra * frame);
    float wear = 1.0 - uRoadMarkMisc.w * gyeRoadNoise(world / uRoadMarkMisc2.x);
    road = mix(road, uRoadWhite, clamp(white, 0.0, 1.0) * wear * markable);
    road = mix(road, uRoadYellow, clamp(yellow, 0.0, 1.0) * wear * markable);

    // Vereda con baldosas y bordillo, entre el borde de la calzada y su ancho.
    float walkA = hasWalk * smoothstep(-aa, aa, sdMin) * (1.0 - smoothstep(walkW - uRoadFeather, walkW + aa, sdMin));
    float walkGrain = mix(0.5, gyeRoadNoise(world / uRoadWalk2.y), gyeFine(uRoadWalk2.y, aa));
    vec3 walk = uRoadSidewalk * (1.0 + (walkGrain - 0.5) * uRoadWalk2.x);
    float tiles = max(gyeJoint(along, uRoadWalk.y, uRoadWalk.z, aa) * frame, gyeJoint(sdMin - uRoadWalk.x, uRoadWalk.y, uRoadWalk.z, aa));
    walk *= 1.0 - uRoadWalk.w * tiles * gyeFine(uRoadWalk.y, aa);
    float curb = smoothstep(-aa, aa, sdMin) * (1.0 - smoothstep(uRoadWalk.x - aa, uRoadWalk.x + aa, sdMin));
    walk = mix(walk, uRoadCurb, curb);

    walkA *= 1.0 - covered;
    float alpha = covered + walkA;
    gyeRoadRGB = (road * covered + walk * walkA) / max(alpha, GYE_ROAD_EPS);
    gyeRoadA = alpha * fade;
    diffuseColor.rgb = mix(diffuseColor.rgb, gyeRoadRGB * uRoadLight.x, gyeRoadA);
  }
}
`;

/**
 * Terreno: la foto satelital ya trae luz y sombras reales, así que se muestra
 * casi sin iluminar (autoiluminación) y solo una parte recibe la luz del sol,
 * que es la que aporta las sombras de nuestros edificios. De cerca, el color de la
 * foto decide el detalle del suelo (pasto, tierra o grano genérico); donde hay datos de
 * calles (texturas de src/world/roadWorker.ts) se dibujan encima parques, canchas y calles.
 */
export function createTerrainMaterial(
  cfg: GameConfig['terrain'],
  map: THREE.Texture,
  rect: ChunkRect,
  roads: RoadShading | null,
  sky: THREE.Texture,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map,
    emissiveMap: map,
    emissive: new THREE.Color(cfg.selfLight, cfg.selfLight, cfg.selfLight),
    color: new THREE.Color(cfg.litShare, cfg.litShare, cfg.litShare),
    roughness: cfg.roughness,
    metalness: 0,
  });
  const d = cfg.detail;
  const gr = cfg.ground;
  const uniforms: ShaderUniforms = {
    uDetail: { value: new THREE.Vector4(d.strength, d.scaleFine, d.scaleCoarse, 0) },
    uDetailFade: { value: new THREE.Vector2(d.fadeStart, d.fadeEnd) },
    // Ruido en coordenadas locales al chunk: con coordenadas de mundo grandes el float pierde precisión.
    uGroundOrigin: { value: new THREE.Vector2(rect.x0, rect.z0) },
    uGroundClass: { value: new THREE.Vector4(gr.green[0], gr.green[1], gr.soil[0], gr.soil[1]) },
    uGroundFade: { value: new THREE.Vector2(gr.fade.start, gr.fade.end) },
    uGrassScale: { value: new THREE.Vector4(gr.grass.blade, gr.grass.tuft, gr.grass.clump, gr.grass.patch) },
    uGrassAmount: {
      value: new THREE.Vector4(gr.grass.bladeAmount, gr.grass.tuftAmount, gr.grass.clumpAmount, gr.grass.dryAmount),
    },
    uGrassDry: { value: new THREE.Vector3(...gr.grass.dryTint) },
    uSoil: {
      value: new THREE.Vector4(
        gr.soilDetail.pebbleSize,
        gr.soilDetail.pebbleAmount,
        gr.soilDetail.pebbleShade,
        gr.soilDetail.mottleScale,
      ),
    },
    uSoilMottle: { value: gr.soilDetail.mottleAmount },
    uSelfLight: lighting.uSelfLight,
    ...nightLight,
    ...skyUniforms(sky, rect),
  };
  material.userData.sky = uniforms.uSkyMap;
  if (roads) {
    const own: ShaderUniforms = {
      uRoadOn: { value: 0 },
      uRoadRect: { value: new THREE.Vector4(rect.x0, rect.z0, rect.size, 0) },
    };
    for (let k = 0; k < ROAD_TEXTURES; k++) own[`uRoad${k}`] = { value: roads.empty };
    Object.assign(uniforms, roads.uniforms, own);
    material.userData.road = { uniforms: own, empty: roads.empty };
  }
  material.customProgramCacheKey = () => `${roads ? 'gye-terrain-roads-v3' : 'gye-terrain-v3'}|${NIGHT_KEY}|gye-sky-v1`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 uDetail;
uniform vec2 uDetailFade;
uniform vec2 uGroundOrigin;
uniform vec4 uGroundClass;
uniform vec2 uGroundFade;
uniform vec4 uGrassScale;
uniform vec4 uGrassAmount;
uniform vec3 uGrassDry;
uniform vec4 uSoil;
uniform float uSoilMottle;
uniform vec3 uSelfLight;
varying vec3 vGroundWorld;
${NIGHT_FRAGMENT_PARS}
${SKY_FRAGMENT_PARS}
// Cuánto de pasto tiene la foto en este punto (lo usan también parques y canchas).
float gyeGreen = 0.0;
// Hash sin seno (Dave Hoskins).
float gyeGroundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gyeGroundNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gyeGroundHash(i), gyeGroundHash(i + vec2(1.0, 0.0)), f.x),
    mix(gyeGroundHash(i + vec2(0.0, 1.0)), gyeGroundHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
// Un patrón de período p se apaga cuando el píxel cubre más de medio período (evita moiré).
float gyeGroundFine(float p, float aa) { return 1.0 - smoothstep(0.25, 0.5, aa / p); }
// Color del suelo: la foto con grano genérico y, de cerca, pasto (hojitas, matas y manchas secas)
// donde la foto es verde o tierra con piedritas donde es cálida.
vec3 gyeGroundCover(vec3 photo, vec2 local, float aa, float dist) {
  vec3 s = sqrt(max(photo, 0.0));
  float sum = max(s.r + s.g + s.b, 1e-3);
  gyeGreen = smoothstep(uGroundClass.x, uGroundClass.y, (2.0 * s.g - s.r - s.b) / sum);
  float soil = smoothstep(uGroundClass.z, uGroundClass.w, (s.r - s.b) / sum) * (1.0 - gyeGreen);
  float grain = gyeGroundNoise(local / uDetail.y) * 0.6 + gyeGroundNoise(local / uDetail.z) * 0.4;
  vec3 c = photo * (1.0 + (grain - 0.5) * uDetail.x * (1.0 - smoothstep(uDetailFade.x, uDetailFade.y, dist)));
  float near = 1.0 - smoothstep(uGroundFade.x, uGroundFade.y, dist);
  if (near > 0.0) {
    // El ruido de valor se agrupa cerca de 0,5: se estira con smoothstep para que haya hojas claras y huecos oscuros.
    float blades = smoothstep(0.3, 0.7, 0.5 * (gyeGroundNoise(local / uGrassScale.x) + gyeGroundNoise(local.yx / (uGrassScale.x * 0.61) + 17.0)));
    float tufts = smoothstep(0.25, 0.75, gyeGroundNoise(local / uGrassScale.y));
    float clumps = smoothstep(0.2, 0.8, gyeGroundNoise(local / uGrassScale.z + 5.0));
    float dry = smoothstep(0.35, 0.8, gyeGroundNoise(local / uGrassScale.w)) * uGrassAmount.w;
    float g = 1.0 + (blades - 0.5) * uGrassAmount.x * gyeGroundFine(uGrassScale.x, aa);
    g += (tufts - 0.5) * uGrassAmount.y * gyeGroundFine(uGrassScale.y, aa);
    g += (clumps - 0.5) * uGrassAmount.z;
    vec3 grass = c * max(g, 0.0) * mix(vec3(1.0), uGrassDry, dry);
    float edge = aa / uSoil.x;
    float pebble = smoothstep(1.0 - uSoil.y - edge, 1.0 - uSoil.y + edge, gyeGroundNoise(local / uSoil.x));
    float mottle = gyeGroundNoise(local / uSoil.w);
    vec3 dirt = c * (1.0 + (mottle - 0.5) * uSoilMottle) * (1.0 - uSoil.z * pebble * gyeGroundFine(uSoil.x, aa));
    c = mix(c, grass, gyeGreen * near);
    c = mix(c, dirt, soil * near);
  }
  return c;
}
${roads ? ROAD_FRAGMENT_PARS : ''}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec2 gyeLocal = vGroundWorld.xz - uGroundOrigin;
float gyeAA = length(fwidth(vGroundWorld.xz));
float gyeDist = length(vViewPosition);
vec3 gyeGround = gyeGroundCover(sampledDiffuseColor.rgb, gyeLocal, gyeAA, gyeDist);
float gyeSky = gyeSkyAt(vGroundWorld.xz).x;
${roads ? GROUND_AREAS_MAIN : ''}
diffuseColor.rgb = diffuse * gyeGround;
${roads ? ROAD_FRAGMENT_MAIN : ''}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // La luz propia de la foto sube también con la luz de los postes (en la misma escala que la del cielo).
        `#include <emissivemap_fragment>${nightCompute('vGroundWorld', '0.0')}
vec3 gyeSelf = uSelfLight * mix(1.0, gyeSky, uSkyLook.z) + gyeNightE * uNightSurface.z;
totalEmissiveRadiance = emissive * gyeGround * gyeSelf;${
          roads ? '\ntotalEmissiveRadiance = mix(totalEmissiveRadiance, gyeRoadRGB * uRoadLight.y * gyeSelf, gyeRoadA);' : ''
        }`,
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>${NIGHT_APPLY}${skyApply('gyeSky')}`);
  };
  return material;
}

/**
 * Terreno lejano: la vista general de todo el mundo, sin grano de detalle, y se
 * descarta donde la máscara marca que ya hay un chunk detallado.
 */
export function createFarTerrainMaterial(
  cfg: GameConfig['terrain'],
  map: THREE.Texture,
  mask: THREE.DataTexture,
  chunks: { size: number; nx: number; nz: number; xmin: number; zmin: number },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map,
    emissiveMap: map,
    emissive: new THREE.Color(cfg.selfLight, cfg.selfLight, cfg.selfLight),
    color: new THREE.Color(cfg.litShare, cfg.litShare, cfg.litShare),
    roughness: cfg.roughness,
    metalness: 0,
  });
  const uniforms: ShaderUniforms = {
    uNearMask: { value: mask },
    uGrid: { value: new THREE.Vector4(chunks.xmin, chunks.zmin, chunks.size, 0) },
    uGridCount: { value: new THREE.Vector2(chunks.nx, chunks.nz) },
    uSelfLight: lighting.uSelfLight,
    ...nightLight,
  };
  material.customProgramCacheKey = () => `gye-terrain-far-v2|${NIGHT_KEY}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vFarWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFarWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uNearMask;
uniform vec4 uGrid;
uniform vec2 uGridCount;
uniform vec3 uSelfLight;
varying vec3 vFarWorld;
${NIGHT_FRAGMENT_PARS}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  vec2 cell = floor((vFarWorld.xz - uGrid.xy) / uGrid.z);
  if (texture2D(uNearMask, (cell + 0.5) / uGridCount).r > 0.5) discard;
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>${nightCompute('vFarWorld', '0.0')}
totalEmissiveRadiance *= uSelfLight + gyeNightE * uNightSurface.z;`,
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>${NIGHT_APPLY}`);
  };
  return material;
}

/**
 * Edificios: fachadas procedurales (pisos, ventanas, vidrio, locales, oclusión en la base)
 * y techos con la foto satelital proyectada desde arriba (también en las aguas de teja).
 * Atributos: aFacade = (u perímetro, v altura, alto del muro, superficie + registro de locales y
 *            azar del edificio: ver SURFACE), aTint = (rgb, estilo: bajo/alto/vidrio/casa de
 *            teja/tanque/galpón). Códigos en buildingFormat.ts. `shops` = tabla de locales del
 *            chunk (ver render/facade.ts → shopTableTexture).
 */
export function createBuildingMaterial(
  cfg: GameConfig['buildings'],
  roof: RoofImage,
  rect: ChunkRect,
  sky: THREE.Texture,
  shops: THREE.Texture,
): THREE.MeshStandardMaterial {
  const ind = cfg.industrial;
  const uniforms: ShaderUniforms = {
    uRoofMap: { value: roof.texture },
    uRoofMatrix: { value: roof.matrix },
    uRoofRect: { value: new THREE.Vector4(rect.x0, rect.z0, rect.size, cfg.roofImageryMix) },
    uFloorH: { value: cfg.floorHeight },
    uWinW: { value: cfg.windowSpacing },
    uAO: { value: cfg.aoStrength },
    uWindowColor: { value: color(cfg.windowColor) },
    uGlassColor: { value: color(cfg.glassColor) },
    uGlassRough: { value: cfg.glassRoughness },
    uRoofShade: { value: cfg.roofShade },
    uRoofTrim: { value: cfg.trimShade },
    uShedA: { value: new THREE.Vector4(ind.ribPeriod, ind.ribShade, ind.plinthHeight, ind.plinthShade) },
    uShedB: { value: new THREE.Vector4(ind.bandTop, ind.bandBottom, ind.bandWindow, ind.doorSpacing) },
    uShedC: { value: new THREE.Vector4(ind.doorWidth, ind.doorHeight, ind.doorProbability, ind.doorShade) },
    uShedSlat: { value: ind.slat },
    uStand: {
      value: new THREE.Vector4(cfg.stands.nosing, cfg.stands.nosingShade, cfg.stands.baseHeight, cfg.stands.baseShade),
    },
    uStandSeat: {
      value: new THREE.Vector4(cfg.stands.seatBand, cfg.stands.seatWidth, cfg.stands.seatGap, cfg.stands.seatGapShade),
    },
    uWindowLit: lighting.uWindowLit,
    uWindowGlow: lighting.uWindowGlow,
    uWindowWarm: lighting.uWindowWarm,
    uWindowCool: lighting.uWindowCool,
    uWindowCoolShare: lighting.uWindowCoolShare,
    uSelfLight: lighting.uSelfLight,
    ...facadeUniforms(cfg.facade),
    uShopTable: { value: shops },
    ...nightLight,
    ...skyUniforms(sky, rect),
    uSkyFacade: lighting.uSkyFacade,
  };
  // Luz ambiente y reflejos: el entorno de la escena (cielo + rebote del suelo, ver environment.ts).
  const material = new THREE.MeshStandardMaterial({
    roughness: cfg.roughness,
    metalness: 0,
    flatShading: true,
  });
  material.userData.uniforms = uniforms;
  material.userData.sky = uniforms.uSkyMap;
  material.customProgramCacheKey = () => `gye-building-v9|${NIGHT_KEY}|gye-sky-v1`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aFacade;
attribute vec4 aTint;
varying vec4 vFacade;
varying vec4 vTint;
varying vec3 vWorld;
// aFacade.w tal cual (sin interpolar): el registro de locales y el azar del edificio van en sus bits.
flat varying float vFacadeSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vFacade = aFacade;
vFacadeSeed = aFacade.w;
vTint = aTint;
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uRoofMap;
uniform mat3 uRoofMatrix;
uniform vec4 uRoofRect;
uniform float uFloorH;
uniform float uWinW;
uniform float uAO;
uniform vec3 uWindowColor;
uniform vec3 uGlassColor;
uniform float uGlassRough;
uniform float uRoofShade;
uniform float uRoofTrim;
uniform vec4 uShedA;
uniform vec4 uShedB;
uniform vec4 uShedC;
uniform float uShedSlat;
// Gradería: canto de cada fila (m) y cuánto más claro; pie del muro (m) y cuánto más oscuro.
uniform vec4 uStand;
// Respaldos de los asientos: alto de la franja (m), ancho de un asiento (m), parte que es junta
// y cuánto más oscura.
uniform vec4 uStandSeat;
uniform float uWindowLit;
uniform float uWindowGlow;
uniform vec3 uWindowWarm;
uniform vec3 uWindowCool;
uniform float uWindowCoolShare;
#define GYE_STYLE_HIGH ${BUILDING_STYLE.high}.0
#define GYE_STYLE_INDUSTRIAL ${BUILDING_STYLE.industrial}.0
#define GYE_STYLE_STAND ${BUILDING_STYLE.stand}.0
#define GYE_STYLE_GLASS ${BUILDING_STYLE.glass}.0
#define GYE_STYLE_HOUSE ${BUILDING_STYLE.house}.0
#define GYE_STYLE_FIXTURE ${BUILDING_STYLE.fixture}.0
#define GYE_STYLE_PORTAL ${PORTAL_FLAG}.0
#define GYE_SURFACE_TRIM ${SURFACE.trim}.0
varying vec4 vFacade;
varying vec4 vTint;
varying vec3 vWorld;
flat varying float vFacadeSeed;
float gyeHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gyeBox(float a, float lo, float hi) { return step(lo, a) * step(a, hi); }
// Luz de una ventana de noche: encendida o no según su azar y la fracción encendida; tibia o
// fría, con brillo distinto (cortinas, lámparas) para que la fachada no se vea uniforme.
vec3 gyeWindowLight(vec2 id, float fraction) {
  float r = gyeHash(id + vec2(17.31, 91.7));
  float on = step(r, fraction);
  vec3 tint = mix(uWindowWarm, uWindowCool, step(1.0 - uWindowCoolShare, fract(r * 7.13 + 0.37)));
  return tint * on * (0.45 + 0.55 * fract(r * 13.7));
}
uniform vec3 uSelfLight;
${facadeParsGLSL(cfg.facade)}
${NIGHT_FRAGMENT_PARS}
${SKY_FRAGMENT_PARS}
uniform vec4 uSkyFacade;
// Cielo que ve un muro: el del suelo unos metros delante (sin contar el propio muro, que ahí
// tapa medio cielo), más oscuro abajo y abierto a la altura de lo que lo rodea.
float gyeFacadeSky(vec3 n) {
  if (vFacade.w > 0.5) return 1.0;
  vec2 s = gyeSkyAt(vWorld.xz + n.xz * uSkyFacade.x);
  float d = uSkyFacade.x;
  float own = 0.5 * (1.0 - d / sqrt(d * d + vFacade.z * vFacade.z));
  float base = clamp(1.0 - (1.0 - min(s.x + own, 1.0)) * uSkyFacade.y, uSkyFacade.z, 1.0);
  return mix(base, 1.0, smoothstep(0.0, max(s.y * uSkyFacade.w, 1.0), vFacade.y));
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float gyeGlass = 0.0;
// Hueco (el vano de un portal): lo que se ve es lo de adentro, sin el brillo de la fachada.
float gyeHole = 0.0;
vec3 gyeLit = vec3(0.0);
vec3 gyeInside = vec3(0.0);
vec3 gyeGlow = vec3(0.0);
{
  vec3 wall = vTint.rgb;
  float style = floor(vTint.a * 255.0 + 0.5);
  // Con portal (galería en la planta baja) el estilo trae una bandera sumada.
  bool portal = style > GYE_STYLE_PORTAL - 0.5;
  if (portal) style -= GYE_STYLE_PORTAL;
  float seed = vTint.r * 13.0 + vTint.g * 7.0 + vTint.b * 3.0 + style;
  bool tall = abs(style - GYE_STYLE_HIGH) < 0.5;
  bool glassy = abs(style - GYE_STYLE_GLASS) < 0.5;
  bool house = abs(style - GYE_STYLE_HOUSE) < 0.5;
  if (abs(style - GYE_STYLE_FIXTURE) < 0.5) {
    // Tanques de agua: color sólido, sin ventanas ni foto.
    diffuseColor.rgb = wall;
  } else if (vFacade.w > 0.5) {
    vec2 local = vec2((vWorld.x - uRoofRect.x) / uRoofRect.z, 1.0 - (vWorld.z - uRoofRect.y) / uRoofRect.z);
    vec2 uv = (uRoofMatrix * vec3(local, 1.0)).xy;
    vec3 roof = texture2D(uRoofMap, clamp(uv, 0.001, 0.999)).rgb;
    diffuseColor.rgb = mix(wall * 0.72, roof, uRoofRect.w) * uRoofShade;
    // Canto y cara inferior del techo de teja: el mismo color, en sombra.
    if (vFacade.w > GYE_SURFACE_TRIM - 0.5) diffuseColor.rgb *= uRoofTrim;
  } else if (abs(style - GYE_STYLE_STAND) < 0.5) {
    // Gradería: concreto sin ventanas ni locales; el pie del muro exterior, más oscuro (tierra y
    // salpicaduras). Arriba de cada muro van los respaldos de la fila: del color de sus asientos
    // en la foto, con la junta entre asiento y asiento, y el canto de la fila más claro.
    float u = vFacade.x;
    float v = vFacade.y;
    float h = vFacade.z;
    vec3 c = mix(wall, wall * uStand.w, step(v, uStand.z));
    float seat = step(h - uStandSeat.x, v);
    if (seat > 0.0) {
      vec2 local = vec2((vWorld.x - uRoofRect.x) / uRoofRect.z, 1.0 - (vWorld.z - uRoofRect.y) / uRoofRect.z);
      vec3 photo = texture2D(uRoofMap, clamp((uRoofMatrix * vec3(local, 1.0)).xy, 0.001, 0.999)).rgb;
      float gap = step(fract(u / uStandSeat.y), uStandSeat.z);
      gap = mix(gap, uStandSeat.z, clamp(fwidth(u) / uStandSeat.y * 2.0 - 0.5, 0.0, 1.0));
      c = photo * uRoofShade * mix(1.0, uStandSeat.w, gap);
    }
    c = mix(c, c * uStand.y, step(h - uStand.x, v));
    c *= mix(1.0 - uAO, 1.0, smoothstep(0.0, 3.5, v));
    diffuseColor.rgb = c;
  } else if (abs(style - GYE_STYLE_INDUSTRIAL) < 0.5) {
    // Galpón: lámina con nervios verticales, zócalo de bloque, franja alta de ventanas y portones enrollables.
    float u = vFacade.x;
    float v = vFacade.y;
    float h = vFacade.z;
    float rib = 0.5 + 0.5 * cos(u * 6.2831853 / uShedA.x);
    rib = mix(rib, 0.5, clamp(fwidth(u) / uShedA.x * 2.0 - 0.5, 0.0, 1.0));
    vec3 c = wall * (1.0 - uShedA.y * rib);
    c = mix(c, wall * uShedA.w, step(v, uShedA.z));
    float band = gyeBox(v, h - uShedB.y, h - uShedB.x) * gyeBox(fract(u / uShedB.z), 0.12, 0.88);
    band *= step(uShedB.y + uShedC.y, h);
    float slot = floor(u / uShedB.w);
    float across = abs(fract(u / uShedB.w) - 0.5) * uShedB.w;
    float door = step(across, uShedC.x * 0.5) * step(v, uShedC.y) * step(1.0 - uShedC.z, gyeHash(vec2(slot, seed)));
    door *= step(uShedC.y + 1.0, h);
    c = mix(c, wall * uShedC.w * (1.0 - 0.12 * step(0.5, fract(v / uShedSlat))), door);
    c = mix(c, mix(uWindowColor, uGlassColor, 0.35), band);
    c = mix(c, wall * 1.05, step(h - 0.45, v) * (1.0 - band));
    c *= mix(1.0 - uAO, 1.0, smoothstep(0.0, 3.5, v));
    diffuseColor.rgb = c;
    gyeGlass = band;
    if (uWindowGlow > 0.0) gyeLit = gyeWindowLight(vec2(floor(u / uShedB.z), seed), uWindowLit) * band;
  } else ${FACADE_MAIN}
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, uGlassRough, gyeGlass);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
material.specularColor *= 1.0 - gyeHole;
material.specularColorBlended *= 1.0 - gyeHole;
material.specularF90 *= 1.0 - gyeHole;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // Altura sobre el suelo: la del punto en el muro; los techos, la del muro.
        `#include <emissivemap_fragment>
totalEmissiveRadiance += gyeLit * uWindowGlow + gyeInside * uSelfLight * uFacRoom.z + gyeGlow;${nightCompute('vWorld', 'vFacade.w > 0.5 ? vFacade.z : vFacade.y')}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>${NIGHT_APPLY}
float gyeSky = gyeFacadeSky(inverseTransformDirection(normal, viewMatrix));${skyApply('gyeSky')}`,
      );
  };
  return material;
}

/** Cambia la oclusión ambiental de un chunk de terreno o de edificios (ver world/skyOcclusion.ts). */
export function setSkyMap(material: THREE.Material, texture: THREE.Texture): void {
  const uniform = material.userData.sky as THREE.IUniform | undefined;
  if (uniform) uniform.value = texture;
}

export function setRoofImage(material: THREE.Material, roof: RoofImage): void {
  const uniforms = material.userData.uniforms as ShaderUniforms | undefined;
  if (!uniforms) return;
  uniforms.uRoofMap.value = roof.texture;
  uniforms.uRoofMatrix.value = roof.matrix;
}
