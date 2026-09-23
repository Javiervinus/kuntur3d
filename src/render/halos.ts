import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { fogTransmittanceGLSL } from './fog';
import { nightLight } from './nightLight';

/** Forma de un halo (streetLights.halo en config/game.json; los faros de los carros usan la misma). */
export type HaloConfig = Pick<
  GameConfig['render']['lighting']['streetLights']['halo'],
  'size' | 'minPixels' | 'maxPixels' | 'farFalloff' | 'core' | 'glow' | 'brightness' | 'depthPull' | 'maxDistance'
>;

/** Halos direccionales: la luz se ve de frente y se apaga hacia atrás (faros de un carro). */
export interface HaloFacing {
  /** Coseno del ángulo con el eje de la luz desde el que empieza a verse y en el que se ve entera. */
  from: number;
  to: number;
}

/**
 * Halos de luces: puntos que se ven del tamaño de la lámpara de cerca y como estrellas de lejos
 * (de lejos no bajan de `minPixels` y en cambio se atenúan), con la bruma y solo de noche.
 * Atributos: position y tint (color con su intensidad); con `facing`, también aFacing (hacia
 * dónde apunta cada luz). El tamaño en pantalla depende de uHalo.w (píxeles por metro a 1 m),
 * que se actualiza con la cámara (ver haloPixels), y el máximo de uHalo.z, del que admita la GPU.
 */
export function createHaloMaterial(
  h: HaloConfig,
  fog: GameConfig['render']['fog'],
  renderer: THREE.WebGLRenderer,
  facing?: HaloFacing,
): THREE.ShaderMaterial {
  // El tamaño máximo de un punto depende de la GPU.
  const gl = renderer.getContext();
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
  return new THREE.ShaderMaterial({
    defines: facing ? { GYE_HALO_FACING: '' } : {},
    uniforms: {
      uLightsOn: nightLight.uLightsOn,
      uHalo: { value: new THREE.Vector4(h.size, h.minPixels, Math.min(h.maxPixels, range[1]), 1) },
      uHaloLook: { value: new THREE.Vector4(h.brightness, h.depthPull, h.maxDistance, h.farFalloff) },
      uHaloShape: { value: new THREE.Vector2(h.core, h.glow) },
      uHaloFacing: { value: new THREE.Vector2(facing?.from ?? 0, facing?.to ?? 1) },
    },
    vertexShader: /* glsl */ `
uniform float uLightsOn;
uniform vec4 uHalo;
uniform vec4 uHaloLook;
uniform vec2 uHaloFacing;
attribute vec3 tint;
#ifdef GYE_HALO_FACING
  attribute vec3 aFacing;
#endif
varying vec3 vHalo;
${fogTransmittanceGLSL(fog)}
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  float dist = length(mv.xyz);
  // Tamaño en pantalla (px) de la lámpara; de lejos no baja de un mínimo y en cambio se atenúa.
  float px = uHalo.x * uHalo.w / max(dist, 1e-3);
  float size = clamp(px, uHalo.y, uHalo.z);
  float energy = pow(min(px / uHalo.y, 1.0), uHaloLook.w);
  vHalo = tint * (uLightsOn * uHaloLook.x * energy * gyeFogTransmittance(world.xyz));
  #ifdef GYE_HALO_FACING
    // Solo de frente: se apaga cuando la cámara queda al costado o detrás de la luz.
    vHalo *= smoothstep(uHaloFacing.x, uHaloFacing.y, dot(aFacing, (cameraPosition - world.xyz) / max(dist, 1e-3)));
  #endif
  // Un poco hacia la cámara: la profundidad no alcanza a separar la lámpara del suelo lejano.
  mv.xyz *= 1.0 - uHaloLook.y;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size;
  // Apagadas o demasiado lejos: fuera de la pantalla.
  if (dot(vHalo, vHalo) <= 0.0 || dist > uHaloLook.z) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec2 uHaloShape;
varying vec3 vHalo;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float edge = 1.0 - r2;
  gl_FragColor = vec4(vHalo * (exp(-r2 * uHaloShape.x) + uHaloShape.y * edge * edge), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Píxeles por metro a 1 m de distancia con esta cámara (uHalo.w de los halos). */
export function haloPixels(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): number {
  return renderer.getDrawingBufferSize(_size).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

const _size = new THREE.Vector2();
