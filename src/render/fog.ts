import * as THREE from 'three';
import type { GameConfig } from '../core/types';

const glsl = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v));

/**
 * Bruma del trópico húmedo para todos los materiales (reemplaza la niebla lineal de three.js):
 * - Densidad exponencial con la altura: el aire húmedo pesa abajo, así que desde el ala delta
 *   la ciudad lejana se ve lechosa pero el cielo de arriba no; `fog.far` es la visibilidad a
 *   nivel del mar (el contraste cae al 5 %) y `fog.near`, la distancia sin bruma.
 * - Color: el del cielo cerca del horizonte (`scene.fog.color`, lo calcula la iluminación
 *   para cada hora) más la luz del sol dispersada hacia adelante, así que mirando al sol la
 *   bruma brilla dorada y de espaldas queda del color del cielo.
 * Usa `sunLights[0]` (la luz del sol o de la luna) que ya tienen los materiales iluminados:
 * no agrega uniformes ni crea variantes de shader. Los materiales sin iluminación llevan solo
 * el color de la bruma.
 * Se aplica en luz lineal, antes del tone mapping (three.js la mezcla después, ya en el
 * espacio de color de la pantalla: la bruma no cuadraba con la exposición y apagaba las luces
 * lejanas de noche). Por eso `scene.fog.color` se guarda con `setFogColor`, que compensa la
 * conversión que hace three.js al subir el color. Llamar antes de compilar cualquier material.
 */
export function installFog(cfg: GameConfig['render']['fog']): void {
  const chunks = THREE.ShaderChunk;
  const expect = (name: keyof typeof THREE.ShaderChunk, text: string): void => {
    if (!chunks[name].includes(text)) throw new Error(`three.js cambió ${name}: revisar render/fog.ts`);
  };
  expect('fog_vertex', 'vFogDepth = - mvPosition.z;');
  expect('fog_fragment', 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );');
  expect('tonemapping_fragment', '#if defined( TONE_MAPPING )');
  expect('lights_pars_begin', 'uniform SunLight sunLights[ NUM_SUN_LIGHTS ];');

  // Marca los shaders que declaran las luces: los materiales sin iluminación (básicos, puntos)
  // también tienen bruma, pero no conocen `sunLights` y no llevan el brillo del sol.
  chunks.lights_pars_begin = `#define GYE_LIGHTS\n${chunks.lights_pars_begin}`;

  chunks.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogView;
#endif
`;
  chunks.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogView = mvPosition.xyz;
#endif
`;
  chunks.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${fogDensityGLSL(cfg)}
#endif
`;
  chunks.fog_fragment = '';
  chunks.tonemapping_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    // Rayo cámara → fragmento en el mundo (la rotación de la vista es ortonormal).
    vec3 fogRay = transpose( mat3( viewMatrix ) ) * vFogView;
    float fogDist = length( vFogView );
    float fogMean = gyeFogMeanDensity( fogRay );
    #ifdef FOG_EXP2
      float fogTau = fogDensity * fogDist * fogMean;
    #else
      float fogTau = 3.0 / fogFar * max( fogDist - fogNear, 0.0 ) * fogMean;
    #endif
    float fogFactor = 1.0 - exp( -fogTau );
    vec3 fogTint = fogColor;
    #if defined( GYE_LIGHTS ) && NUM_SUN_LIGHTS > 0
      float fogCos = max( dot( normalize( vFogView ), sunLights[ 0 ].direction ), 0.0 );
      fogTint += sunLights[ 0 ].color * ( ${glsl(cfg.sunGlow)} * pow( fogCos, ${glsl(cfg.sunGlowPower)} ) + ${glsl(cfg.sunHalo)} * pow( fogCos, ${glsl(cfg.sunHaloPower)} ) );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
  }
#endif
${chunks.tonemapping_fragment}`;
}

/**
 * GLSL: densidad media de la bruma (relativa a la del nivel del mar) a lo largo del rayo
 * cámara → punto (`ray`, en el mundo), con densidad ∝ exp(-altura / escala).
 */
function fogDensityGLSL(cfg: GameConfig['render']['fog']): string {
  return /* glsl */ `
float gyeFogMeanDensity( vec3 ray ) {
  float rho = exp( -( cameraPosition.y - ${glsl(cfg.baseHeight)} ) / ${glsl(cfg.scaleHeight)} );
  float k = ray.y / ${glsl(cfg.scaleHeight)};
  return abs( k ) > 1e-3 ? rho * ( 1.0 - exp( -k ) ) / k : rho;
}`;
}

/**
 * GLSL (vertex o fragment): cuánto de la luz de un punto del mundo llega a la cámara a través
 * de la bruma (1 = nada se pierde). Para lo que se suma sobre la imagen, como los halos de los
 * postes, que no pueden mezclarse con el color de la bruma.
 */
export function fogTransmittanceGLSL(cfg: GameConfig['render']['fog']): string {
  return /* glsl */ `${fogDensityGLSL(cfg)}
float gyeFogTransmittance( vec3 world ) {
  vec3 ray = world - cameraPosition;
  return exp( -3.0 / ${glsl(cfg.far)} * max( length( ray ) - ${glsl(cfg.near)}, 0.0 ) * gyeFogMeanDensity( ray ) );
}`;
}

/**
 * Color de la bruma en luz lineal (unidades del juego). three.js lo convierte al espacio de
 * color de la pantalla al subirlo; como aquí se usa antes de esa conversión, se guarda con la
 * conversión inversa (la ida y vuelta es exacta, también para valores mayores que 1).
 */
export function setFogColor(fog: THREE.Fog, linear: THREE.Color): void {
  fog.color.copy(linear).convertSRGBToLinear();
}
