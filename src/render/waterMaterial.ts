import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { withNightLight } from './nightLight';

type WaterConfig = GameConfig['water'];

/** Rectángulo del mundo que cubre la foto satelital general (x0, z0, ancho, fondo). */
export interface PhotoRect {
  x0: number;
  z0: number;
  width: number;
  depth: number;
}

const color = (hex: string): THREE.Color => new THREE.Color(hex);

/**
 * Agua del Guayas, el Daule, el Babahoyo y los esteros:
 * - Color de cuerpo: el río es opaco de sedimento ("café con leche"); se mezcla el color de la
 *   foto satelital (las plumas de sedimento y los canales reales) con el de la configuración,
 *   más oscuro y verdoso en los esteros y brazos de mar.
 * - Oleaje: varias escalas de ondas (de decenas de metros a uno) que viajan con la corriente,
 *   más o menos picadas por zonas; las que ya no caben en un píxel se apagan (sin centelleo).
 *   El reflejo del cielo y el brillo del sol los pone el material físico (Fresnel).
 * - Lechuguines: manchas de jacinto de agua a la deriva con la corriente, solo en los ríos de
 *   agua dulce (atributo `aFresh`), con matas, borde oscuro y superficie rugosa.
 * - De noche, las luces de la orilla brillan sobre el agua (reflejo en las olas).
 */
export function createWaterMaterial(cfg: WaterConfig): THREE.MeshStandardMaterial {
  const w = cfg.waves;
  const h = cfg.hyacinth;
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uRiverColor: { value: color(cfg.riverColor) },
    uSeaColor: { value: color(cfg.seaColor) },
    uWaterPhoto: { value: null },
    uWaterPhotoRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uWaterPhotoLook: { value: new THREE.Vector2(0, cfg.photoGain) },
    uFlow: { value: new THREE.Vector2(cfg.flow[0], cfg.flow[1]) },
    uWaves: { value: new THREE.Vector4(w.length, w.lengthFalloff, w.strength, w.speed) },
    uWaveShape: { value: new THREE.Vector3(w.amplitudeFalloff, w.patchScale, w.patchAmount) },
    // Píxeles por onda entre los que se apaga cada escala (como fracción onda/píxel) y torcido de crestas.
    uWaveFade: { value: new THREE.Vector4(w.fade[0], w.fade[1], w.warp, w.warpScale) },
    // Al ras: elevación de la vista (seno) entre la que las olas se aplanan, cuánto quedan y
    // elevación mínima del reflejo.
    uWaveGraze: { value: new THREE.Vector4(w.graze.from, w.graze.to, w.graze.keep, w.graze.minReflection) },
    // Apertura entre los dos trenes de cada escala (rad), largo de los grupos (en ondas) y cuánto los corta.
    uWaveSpread: { value: new THREE.Vector3(THREE.MathUtils.degToRad(w.spreadDeg), w.groups.frequency, w.groups.depth) },
    uHyacinth: { value: new THREE.Vector4(h.scale, h.coverage, h.edge, h.clumpScale) },
    uHyColors: { value: h.colors.map(color) },
    uHyRim: { value: color(h.rim) },
    uHyLook: { value: new THREE.Vector4(h.roughness, h.bump, h.rimWidth, h.drift) },
    // Cuánto se estiran las matas con la corriente y cuánto se tuercen sus bordes (en tamaños de mata).
    uHyShape: { value: new THREE.Vector2(h.stretch, h.ragged) },
    uWaterNight: { value: cfg.nightSpecular },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: cfg.roughness, metalness: 0 });
  material.userData.uniforms = uniforms;
  material.customProgramCacheKey = () => 'gye-water-v5';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aFresh;\nvarying vec3 vWaterWorld;\nvarying float vFresh;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFresh = aFresh;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uTime;
uniform vec3 uRiverColor;
uniform vec3 uSeaColor;
uniform sampler2D uWaterPhoto;
uniform vec4 uWaterPhotoRect;
uniform vec2 uWaterPhotoLook;
uniform vec2 uFlow;
uniform vec4 uWaves;
uniform vec3 uWaveShape;
uniform vec4 uWaveFade;
uniform vec4 uWaveGraze;
uniform vec3 uWaveSpread;
uniform vec4 uHyacinth;
uniform vec3 uHyColors[${h.colors.length}];
uniform vec3 uHyRim;
uniform vec4 uHyLook;
uniform vec2 uHyShape;
uniform float uWaterNight;
varying vec3 vWaterWorld;
varying float vFresh;
#define GYE_WAVE_OCTAVES ${w.octaves}
#define GYE_GRAVITY 9.81
#define GYE_GOLDEN_ANGLE 2.39996323
// Hash sin seno (Dave Hoskins) y ruido de valor, estables con coordenadas grandes.
float gyeWaterHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gyeWaterNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gyeWaterHash(i), gyeWaterHash(i + vec2(1.0, 0.0)), f.x),
    mix(gyeWaterHash(i + vec2(0.0, 1.0)), gyeWaterHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
// Pendiente del oleaje (xy: dh/dx, dh/dz) de ondas de aguas profundas en varias direcciones,
// cada escala más corta. La que ya no cabe en el píxel (aa, en metros) se apaga y su pendiente
// pasa a rugosidad (z: varianza perdida, Toksvig/LEAN): de lejos el agua es un reflejo borroso
// y no rayas.
vec3 gyeWaveSlope(vec2 p, float t, float aa, float strength) {
  vec2 slope = vec2(0.0);
  float lost = 0.0;
  float len = uWaves.x;
  float amp = strength;
  for (int k = 0; k < GYE_WAVE_OCTAVES; k++) {
    float fine = 1.0 - smoothstep(uWaveFade.x, uWaveFade.y, aa / len);
    float wn = 6.2831853 / len;
    float speed = sqrt(GYE_GRAVITY / wn) * uWaves.w;
    // Dos trenes por escala, abiertos a ambos lados de su dirección y cortados en grupos a lo
    // largo de la cresta: sin grupos, unas pocas ondas planas iguales forman rosetas y anillos.
    for (int j = 0; j < 2; j++) {
      float ang = float(k) * GYE_GOLDEN_ANGLE + (float(j) - 0.5) * uWaveSpread.x;
      vec2 d = vec2(cos(ang), sin(ang));
      vec2 across = vec2(-d.y, d.x);
      float phase = float(k * 2 + j) * 2.3999632;
      float group = 1.0 - uWaveSpread.z * (0.5 + 0.5 * sin(dot(across, p) * wn * uWaveSpread.y + phase));
      slope += d * (cos(dot(d, p) * wn - t * wn * speed * (1.0 + 0.07 * float(j)) + phase) * amp * group * fine);
      // Varianza de la pendiente de un coseno: amplitud² / 2.
      lost += 0.5 * amp * amp * (1.0 - fine);
    }
    len *= uWaves.y;
    amp *= uWaveShape.x;
  }
  return vec3(slope, lost);
}
// Lechuguines: matas a la deriva (1 dentro), estiradas a lo largo de la corriente, con bordes
// irregulares (coordenadas torcidas) y matas sueltas más chicas alrededor de las grandes.
float gyeHyacinth(vec2 p) {
  vec2 f = normalize(uFlow + vec2(1e-5, 0.0));
  vec2 q = vec2(dot(p, f) / uHyShape.x, dot(p, vec2(-f.y, f.x)));
  float s = uHyacinth.x;
  q += (vec2(gyeWaterNoise(q / (s * 0.5)), gyeWaterNoise(q / (s * 0.5) + 7.7)) - 0.5) * s * uHyShape.y;
  float n = gyeWaterNoise(q / s) * 0.55 + gyeWaterNoise(q / (s * 0.37) + 13.1) * 0.3 + gyeWaterNoise(q / (s * 0.12) + 5.3) * 0.15;
  return smoothstep(1.0 - uHyacinth.y - uHyacinth.z, 1.0 - uHyacinth.y + uHyacinth.z, n);
}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
vec2 gyeDrift = vWaterWorld.xz - uFlow * uTime;
float gyeWaterAA = length(fwidth(vWaterWorld.xz));
// Oleaje más o menos picado por zonas, con las crestas torcidas (sin grilla regular).
float gyePatchy = 1.0 + uWaveShape.z * (gyeWaterNoise(gyeDrift / uWaveShape.y) - 0.5);
vec2 gyeWarp = vec2(gyeWaterNoise(gyeDrift / uWaveFade.w), gyeWaterNoise(gyeDrift / uWaveFade.w + 17.3)) - 0.5;
vec3 gyeWave = gyeWaveSlope(gyeDrift + gyeWarp * uWaveFade.z, uTime, gyeWaterAA, uWaves.z * gyePatchy);
// Color de cuerpo: el de la foto satelital (sedimento, canales) mezclado con el configurado.
vec2 gyePhotoUV = vec2((vWaterWorld.x - uWaterPhotoRect.x) / uWaterPhotoRect.z, 1.0 - (vWaterWorld.z - uWaterPhotoRect.y) / uWaterPhotoRect.w);
vec3 gyePhoto = texture2D(uWaterPhoto, gyePhotoUV).rgb * uWaterPhotoLook.y;
vec3 gyeBody = mix(uSeaColor, uRiverColor, vFresh);
diffuseColor.rgb = mix(gyeBody, gyePhoto, uWaterPhotoLook.x);
// Lechuguines (solo en los ríos de agua dulce), a la deriva un poco más lento que el agua.
vec2 gyeLeafP = vWaterWorld.xz - uFlow * uTime * uHyLook.w;
float gyeLeaf = vFresh > 0.01 ? gyeHyacinth(gyeLeafP) * vFresh : 0.0;
float gyeClump = gyeWaterNoise(gyeLeafP / uHyacinth.w);
if (gyeLeaf > 0.0) {
  float pick = gyeWaterNoise(gyeLeafP / (uHyacinth.w * 7.0) + 3.7) * ${h.colors.length}.0;
  vec3 leaf = mix(uHyColors[int(min(pick, ${h.colors.length - 1}.0))], uHyColors[int(min(pick + 1.0, ${h.colors.length - 1}.0))], fract(pick));
  leaf *= 0.75 + 0.5 * gyeClump;
  // Borde oscuro (raíces y sombra sobre el agua).
  leaf = mix(uHyRim, leaf, smoothstep(0.0, uHyLook.z, gyeLeaf));
  diffuseColor.rgb = mix(diffuseColor.rgb, leaf, smoothstep(0.0, 0.25, gyeLeaf));
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        // Rugosidad del GGX (alpha = rugosidad²) con la varianza de las ondas que no se ven:
        // alpha² += 2σ².
        `#include <roughnessmap_fragment>
roughnessFactor = sqrt(sqrt(pow(roughnessFactor, 4.0) + 2.0 * gyeWave.z));
roughnessFactor = mix(roughnessFactor, uHyLook.x, smoothstep(0.0, 0.25, gyeLeaf));`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `#include <normal_fragment_begin>
{
  // Oleaje; sobre los lechuguines, el relieve de las matas.
  vec2 slope = gyeWave.xy;
  // Mirando al ras, las caras de las olas que dan la espalda quedan tapadas por las crestas
  // (enmascaramiento): la pendiente visible se aplana, y ninguna refleja por debajo del
  // horizonte (el reflejo de una cara inclinada baja el doble de su inclinación).
  vec3 gyeToEye = normalize(cameraPosition - vWaterWorld);
  slope *= mix(uWaveGraze.z, 1.0, smoothstep(uWaveGraze.x, uWaveGraze.y, gyeToEye.y));
  vec2 gyeEyeDir = normalize(gyeToEye.xz + vec2(1e-5, 0.0));
  float gyeDrop = dot(slope, gyeEyeDir);
  float gyeRoom = max(gyeToEye.y - uWaveGraze.w, 0.0) * 0.5;
  if (gyeDrop > gyeRoom) slope -= gyeEyeDir * (gyeDrop - gyeRoom);
  if (gyeLeaf > 0.0) {
    // Relieve de las matas: gradiente del ruido de matas en el mundo (diferencias centrales).
    float fineLeaf = 1.0 - smoothstep(0.25, 0.6, gyeWaterAA / uHyacinth.w);
    vec2 e = vec2(uHyacinth.w * 0.25, 0.0);
    vec2 grad = vec2(
      gyeWaterNoise((gyeLeafP + e.xy) / uHyacinth.w) - gyeWaterNoise((gyeLeafP - e.xy) / uHyacinth.w),
      gyeWaterNoise((gyeLeafP + e.yx) / uHyacinth.w) - gyeWaterNoise((gyeLeafP - e.yx) / uHyacinth.w)
    ) / (2.0 * e.x);
    vec2 bump = grad * uHyacinth.w * uHyLook.y * fineLeaf;
    slope = mix(slope, bump, smoothstep(0.0, 0.25, gyeLeaf));
  }
  normal = normalize(normal + (viewMatrix * vec4(-slope.x, 0.0, -slope.y, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        // De noche: las luces de la orilla (gyeNightE, ver nightLight.ts) brillan en las olas.
        /* glsl */ `#include <lights_fragment_end>
{
  float fresnel = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
  reflectedLight.directSpecular += gyeNightE * (uWaterNight * fresnel * (1.0 - smoothstep(0.0, 0.25, gyeLeaf)));
}`,
      );
  };
  withNightLight(material);
  return material;
}

/** La foto satelital general (color del agua) y el rectángulo del mundo que cubre. */
export function setWaterPhoto(material: THREE.Material, texture: THREE.Texture, rect: PhotoRect, mix: number): void {
  const u = material.userData.uniforms as Record<string, THREE.IUniform>;
  u.uWaterPhoto.value = texture;
  u.uWaterPhotoRect.value.set(rect.x0, rect.z0, rect.width, rect.depth);
  u.uWaterPhotoLook.value.x = mix;
}

export function tickWater(material: THREE.Material, time: number): void {
  const u = material.userData.uniforms as Record<string, THREE.IUniform> | undefined;
  if (u) u.uTime.value = time;
}
