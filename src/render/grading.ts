import * as THREE from 'three';
import type { GameConfig } from '../core/types';

const glsl = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v));

/**
 * Ajuste de color final (saturación, contraste y brillo) hecho dentro del tone mapping, con
 * las mismas fórmulas que los filtros CSS saturate(), contrast() y brightness() (Filter
 * Effects, en sRGB). Antes era un `filter` CSS sobre el canvas, que el navegador aplica en
 * una pasada extra de pantalla completa en cada frame; aquí cuesta unas pocas operaciones
 * por píxel. Como three.js solo aplica tone mapping al dibujar en pantalla, los render
 * targets internos (reflejos del cielo, sombras) no se ven afectados.
 * Llamar antes de compilar cualquier material.
 */
export function installGrading(renderer: THREE.WebGLRenderer, cfg: GameConfig['render']['grading']): void {
  const s = cfg.saturate;
  // Matriz de feColorMatrix type="saturate" (columnas: aporte de R, G y B).
  const sat = [
    [0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s],
    [0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s],
    [0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s],
  ];
  const mat = `mat3(${sat.flat().map(glsl).join(', ')})`;
  const custom = /* glsl */ `
vec3 gyeLinearToSRGB( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}
vec3 gyeSRGBToLinear( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}
vec3 CustomToneMapping( vec3 color ) {
  vec3 c = gyeLinearToSRGB( clamp( NeutralToneMapping( color ), 0.0, 1.0 ) );
  c = clamp( ${mat} * c, 0.0, 1.0 );
  c = clamp( ( c - 0.5 ) * ${glsl(cfg.contrast)} + 0.5, 0.0, 1.0 );
  c = clamp( c * ${glsl(cfg.brightness)}, 0.0, 1.0 );
  return gyeSRGBToLinear( c );
}`;
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(stub)) throw new Error('three.js cambió tonemapping_pars_fragment: revisar render/grading.ts');
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, custom);
  renderer.toneMapping = THREE.CustomToneMapping;
}
