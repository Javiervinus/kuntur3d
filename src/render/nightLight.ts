import * as THREE from 'three';

/** Textura negra de 1×1 mientras no hay mapas de luz (y el suelo en 0). */
function blank(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.needsUpdate = true;
  return t;
}

/**
 * Uniformes de la luz de noche, compartidos por todos los materiales del mundo (como
 * `lighting`): los mapas de luz de los postes (ver world/streetLamps.ts) y los faros del
 * carro. Cambiar la hora o moverse solo toca valores: nada se recompila.
 */
export const nightLight = {
  /** Luz de los postes alrededor del jugador: rgb = sqrt(E / uNightDecode), a = altura del suelo. */
  uNightNear: { value: blank() as THREE.Texture },
  /**
   * x0, z0, lado (m) y ancho del borde donde se funde con el mapa de toda la ciudad. Empieza
   * lejos del mundo: hasta que llega el primer mapa fino se usa solo el de la ciudad.
   */
  uNightNearRect: { value: new THREE.Vector4(-1e6, -1e6, 1, 1) },
  /** Altura del suelo en el canal a: base y rango (m). */
  uNightNearGround: { value: new THREE.Vector2(0, 0) },
  /** Lo mismo para toda la ciudad, en grueso (la luz promedio de cada celda). */
  uNightRegion: { value: blank() as THREE.Texture },
  uNightRegionRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uNightRegionGround: { value: new THREE.Vector2(0, 0) },
  /** Postes encendidos (0 de día, 1 de noche). */
  uLightsOn: { value: 0 },
  /** Escala de la codificación (irradiancia máxima); 0 mientras no hay mapas. */
  uNightDecode: { value: 0 },
  /**
   * Superficies: distancia a la que un muro "mira" la calle (m), luz de los muros respecto
   * del suelo, y cuánto de la luz propia de la foto satelital sube con la luz de los postes.
   */
  uNightSurface: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** Altura sobre el suelo a la que se apaga la luz de los postes: techos (inicio, fin) y muros (inicio, fin). */
  uNightFade: { value: new THREE.Vector4(0, 1, 0, 1) },
  /** Faros del carro: posición y nivel (0 = apagados). */
  uHeadPos: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** Dirección del haz y su alcance (m). */
  uHeadDir: { value: new THREE.Vector4(0, 0, -1, 1) },
  /** Color por intensidad (irradiancia a 1 m en el eje del haz). */
  uHeadColor: { value: new THREE.Color(0, 0, 0) },
  /**
   * Coseno del borde exterior e interior del haz, y distancias (m) entre las que se enciende el
   * suelo delante del carro (el borde inferior del haz: los primeros metros quedan en sombra).
   */
  uHeadCone: { value: new THREE.Vector4(0, 1, 0, 1) },
} satisfies Record<string, THREE.IUniform>;

/** Declaraciones del vertex shader: posición en el mundo para la luz de noche. */
export const NIGHT_VERTEX_PARS = /* glsl */ `varying vec3 vGyeNight;`;

/** Posición en el mundo (con instancias, lotes y esqueleto), después de `worldpos_vertex`. */
export const NIGHT_VERTEX = /* glsl */ `
{
  vec4 gyeNightPos = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    gyeNightPos = batchingMatrix * gyeNightPos;
  #endif
  #ifdef USE_INSTANCING
    gyeNightPos = instanceMatrix * gyeNightPos;
  #endif
  vGyeNight = ( modelMatrix * gyeNightPos ).xyz;
}`;

/** Uniformes y funciones del fragment shader. */
export const NIGHT_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uNightNear;
uniform vec4 uNightNearRect;
uniform vec2 uNightNearGround;
uniform sampler2D uNightRegion;
uniform vec4 uNightRegionRect;
uniform vec2 uNightRegionGround;
uniform float uLightsOn;
uniform float uNightDecode;
uniform vec4 uNightSurface;
uniform vec4 uNightFade;
uniform vec4 uHeadPos;
uniform vec4 uHeadDir;
uniform vec3 uHeadColor;
uniform vec4 uHeadCone;
// Luz de los postes que llega al suelo en (x, z) (rgb) y la altura del suelo ahí (a): el mapa
// fino alrededor del jugador, fundido en su borde con el grueso de toda la ciudad.
vec4 gyeNightSample(vec2 xz) {
  vec2 nearUV = (xz - uNightNearRect.xy) / uNightNearRect.z;
  vec2 regionUV = (xz - uNightRegionRect.xy) / uNightRegionRect.zw;
  vec4 a = texture2D(uNightNear, nearUV);
  vec4 b = texture2D(uNightRegion, regionUV);
  vec2 inside = min(nearUV, 1.0 - nearUV) * uNightNearRect.z;
  float w = smoothstep(0.0, uNightNearRect.w, min(inside.x, inside.y));
  vec3 e = mix(b.rgb * b.rgb, a.rgb * a.rgb, w);
  float ground = mix(b.a * uNightRegionGround.y + uNightRegionGround.x, a.a * uNightNearGround.y + uNightNearGround.x, w);
  return vec4(e, ground);
}
// Irradiancia de noche (postes y faros) sobre una superficie en p con normal n (en el mundo).
// above: altura sobre el suelo; si es negativa, se toma el suelo del mapa de luz.
// Los muros leen la luz del suelo unos metros delante de ellos (la calle a la que miran).
vec3 gyeNightLight(vec3 p, vec3 n, float above) {
  vec3 e = vec3(0.0);
  float on = uLightsOn * uNightDecode;
  if (on > 0.0) {
    vec4 s = gyeNightSample(p.xz + n.xz * uNightSurface.x);
    float h = above < 0.0 ? p.y - s.a : above;
    float up = max(n.y, 0.0) * (1.0 - smoothstep(uNightFade.x, uNightFade.y, h));
    float side = (1.0 - abs(n.y)) * uNightSurface.y * (1.0 - smoothstep(uNightFade.z, uNightFade.w, h));
    e = s.rgb * on * (up + side);
  }
  if (uHeadPos.w > 0.0) {
    vec3 l = uHeadPos.xyz - p;
    float d2 = max(dot(l, l), 1e-4);
    float d = sqrt(d2);
    l /= d;
    float cone = smoothstep(uHeadCone.x, uHeadCone.y, dot(-l, uHeadDir.xyz)) * smoothstep(uHeadCone.z, uHeadCone.w, d);
    float fall = clamp(1.0 - d2 * d2 / (uHeadDir.w * uHeadDir.w * uHeadDir.w * uHeadDir.w), 0.0, 1.0);
    e += uHeadColor * (uHeadPos.w * cone * fall * fall * max(dot(n, l), 0.0) / d2);
  }
  return e;
}`;

/** Calcula `gyeNightE` (después de las normales); `above` es una expresión GLSL (ver gyeNightLight). */
export function nightCompute(position: string, above: string): string {
  return /* glsl */ `
vec3 gyeNightE = gyeNightLight(${position}, inverseTransformDirection(normal, viewMatrix), ${above});`;
}

/** Suma la luz de noche como luz directa difusa (después de `lights_fragment_end`). */
export const NIGHT_APPLY = /* glsl */ `
reflectedLight.directDiffuse += gyeNightE * BRDF_Lambert( material.diffuseContribution );`;

/** Versión del código de arriba en las claves de programa (cambiarla si cambia el GLSL). */
export const NIGHT_KEY = 'gye-night-v1';

const wrapped = new WeakSet<THREE.Material>();

/**
 * Agrega la luz de noche a un material iluminado (personaje, carro, árboles, postes…),
 * encadenada con lo que el material ya tuviera en `onBeforeCompile`. La altura sobre el suelo
 * se toma del mapa de luz.
 */
export function withNightLight(material: THREE.Material): void {
  const standard = material as THREE.MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial || wrapped.has(material)) return;
  wrapped.add(material);
  const previous = material.onBeforeCompile;
  // La clave por defecto de three.js es el código de onBeforeCompile: se conserva la del original.
  const previousKey =
    material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey
      ? () => previous.toString()
      : material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, nightLight);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NIGHT_VERTEX_PARS}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${NIGHT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGyeNight;\n${NIGHT_FRAGMENT_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${nightCompute('vGyeNight', '-1.0')}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${NIGHT_APPLY}`);
  };
  material.customProgramCacheKey = () => `${previousKey()}|${NIGHT_KEY}`;
  material.needsUpdate = true;
}

/** `withNightLight` para todos los materiales de un objeto y sus hijos. */
export function addNightLight(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) withNightLight(m);
  });
}
