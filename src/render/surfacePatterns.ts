import * as THREE from 'three';
import type { GameConfig } from '../core/types';

type PatternsConfig = GameConfig['monuments']['patterns'];

/**
 * Uniformes de los dibujos procedurales de los monumentos (ver world/monumentParts.ts →
 * PATTERN), sacados de config/game.json → monuments.patterns.
 */
export function patternUniforms(cfg: PatternsConfig): Record<string, THREE.IUniform> {
  const s = cfg.stucco;
  const f = cfg.scales;
  const sh = cfg.shutter;
  const t = cfg.terrazzo;
  const ti = cfg.tiles;
  return {
    uStucco: { value: new THREE.Vector4(s.blotch, s.contrast, s.grain, s.grainBump) },
    uStreaks: { value: new THREE.Vector4(s.streaks.width, s.streaks.length, s.streaks.contrast, s.streaks.threshold) },
    uFoot: { value: new THREE.Vector2(s.foot.height, s.foot.shade) },
    uScales: { value: new THREE.Vector4(f.size[0], f.size[1], f.rim, f.bump) },
    uShutter: { value: new THREE.Vector4(sh.pitch, sh.contrast, sh.bump, sh.grime) },
    uTerrazzo: { value: new THREE.Vector4(t.diamond, t.band, t.chips, t.chipContrast) },
    uTerrazzoA: { value: new THREE.Color(t.colors[0]) },
    uTerrazzoB: { value: new THREE.Color(t.colors[1]) },
    uTiles: { value: new THREE.Vector4(ti.size, ti.joint, ti.jointShade, ti.variation) },
    uPatternBump: { value: cfg.bump },
    uAoSpecular: { value: cfg.aoSpecular },
  };
}

/**
 * Declaraciones del vertex shader (después de `#include <common>`): `aSurface` = (oclusión, LED,
 * tipo de dibujo / 255, —) en bytes y `aDetail` = uv del dibujo en metros (ver
 * world/monumentParts.ts → compact).
 */
export const PATTERN_VERTEX_PARS = /* glsl */ `
attribute vec4 aSurface;
attribute vec2 aDetail;
varying float vGyeAo;
varying vec3 vGyeDetail;
varying vec3 vGyeWorld;
varying float vGyeFoot;`;

/**
 * Después de `worldpos_vertex`: oclusión, coordenadas del dibujo, posición en el mundo y altura
 * sobre la base del monumento (`aFlood.y`, la declara el material de los monumentos).
 */
export const PATTERN_VERTEX = /* glsl */ `
{
  vec4 gyeWorldPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    gyeWorldPos = instanceMatrix * gyeWorldPos;
  #endif
  vGyeWorld = ( modelMatrix * gyeWorldPos ).xyz;
  vGyeFoot = vGyeWorld.y - aFlood.y;
  vGyeAo = aSurface.x;
  vGyeDetail = vec3( aDetail, floor( aSurface.z * 255.0 + 0.5 ) );
}`;

/**
 * Funciones del fragment shader: cada dibujo devuelve cuánto tiñe el color y un relieve (m) del
 * que sale la normal (bump mapping de Mikkelsen, igual que el de three.js).
 */
export const PATTERN_FRAGMENT_PARS = /* glsl */ `
uniform vec4 uStucco;
uniform vec4 uStreaks;
uniform vec2 uFoot;
uniform vec4 uScales;
uniform vec4 uShutter;
uniform vec4 uTerrazzo;
uniform vec3 uTerrazzoA;
uniform vec3 uTerrazzoB;
uniform vec4 uTiles;
uniform float uPatternBump;
uniform float uAoSpecular;
varying float vGyeAo;
varying vec3 vGyeDetail;
varying vec3 vGyeWorld;
varying float vGyeFoot;

float gyeHash3( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float gyeNoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( gyeHash3( i ), gyeHash3( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( gyeHash3( i + vec3( 0.0, 1.0, 0.0 ) ), gyeHash3( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
    mix( mix( gyeHash3( i + vec3( 0.0, 0.0, 1.0 ) ), gyeHash3( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( gyeHash3( i + vec3( 0.0, 1.0, 1.0 ) ), gyeHash3( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
    f.z
  );
}

// Tinte (rgb) y relieve (a, en m) del dibujo de la pieza.
vec4 gyePattern( vec3 d, vec3 w ) {
  int kind = int( d.z + 0.5 );
  if ( kind == 1 ) {
    // Revoque: manchas grandes de la pintura gastada, chorreado vertical de la humedad (más
    // fuerte al pie) y grano fino.
    float blot = gyeNoise3( w / uStucco.x ) * 0.65 + gyeNoise3( w / ( uStucco.x * 0.37 ) ) * 0.35;
    float streak = gyeNoise3( vec3( ( w.x + w.z ) / uStreaks.x, w.y / uStreaks.y, ( w.x - w.z ) / uStreaks.x ) );
    float foot = 1.0 - smoothstep( 0.0, uFoot.x, vGyeFoot );
    float tint = 1.0 + ( blot - 0.5 ) * uStucco.y - max( streak - uStreaks.w, 0.0 ) * uStreaks.z - foot * uFoot.y;
    return vec4( vec3( tint ), gyeNoise3( w / uStucco.z ) * uStucco.w );
  }
  if ( kind == 2 ) {
    // Escamas: filas desfasadas de medio ancho; cada escama es la mitad de abajo de un disco
    // colgado del borde de arriba de su celda y tapa a las de la fila de abajo.
    vec2 cell = d.xy / uScales.xy;
    float row = floor( cell.y );
    cell.x += 0.5 * mod( row, 2.0 );
    vec2 f = ( fract( cell ) - vec2( 0.5, 1.0 ) ) * uScales.xy;
    float R = uScales.x * 0.5;
    float r = length( f );
    vec2 id = vec2( floor( cell.x ), row );
    if ( r > R ) {
      vec2 fl = ( fract( cell ) - vec2( 0.0, 0.0 ) ) * uScales.xy;
      vec2 fr = ( fract( cell ) - vec2( 1.0, 0.0 ) ) * uScales.xy;
      r = min( length( fl ), length( fr ) );
      id += vec2( length( fl ) < length( fr ) ? 0.0 : 1.0, -1.0 );
    }
    float t = clamp( r / R, 0.0, 1.0 );
    float shade = 1.0 - smoothstep( 0.78, 1.0, t ) * uScales.z + ( gyeHash3( vec3( id, 3.0 ) ) - 0.5 ) * 0.08;
    return vec4( vec3( shade ), t * uScales.w );
  }
  if ( kind == 3 ) {
    // Cortina metálica enrollable: lamas horizontales y mugre abajo.
    float s = sin( d.y / uShutter.x * 6.2831853 );
    float grime = 1.0 - ( 1.0 - smoothstep( 0.0, 1.2, d.y ) ) * uShutter.w;
    return vec4( vec3( ( 1.0 + s * uShutter.y ) * grime ), s * uShutter.z );
  }
  if ( kind == 4 ) {
    // Terrazo: franjas de dos colores en rombos sobre el fondo, con su grano de piedritas.
    vec2 q = vec2( d.x + d.y, d.x - d.y ) * 0.70710678 / uTerrazzo.x;
    vec2 g = abs( fract( q ) - 0.5 );
    float line = min( g.x, g.y ) * uTerrazzo.x;
    float band = 1.0 - smoothstep( uTerrazzo.y * 0.5 - 0.01, uTerrazzo.y * 0.5, line );
    float which = mod( floor( q.x ) + floor( q.y ), 2.0 );
    float chip = step( 1.0 - uTerrazzo.z, gyeHash3( floor( vec3( d.xy / 0.012, 1.0 ) ) ) );
    vec3 base = mix( vec3( 1.0 ), which > 0.5 ? uTerrazzoA : uTerrazzoB, band );
    return vec4( base * ( 1.0 - chip * uTerrazzo.w ), 0.0 );
  }
  if ( kind == 5 ) {
    // Baldosas: juntas oscuras y hundidas, y cada baldosa con su tono.
    vec2 cell = d.xy / uTiles.x;
    vec2 g = abs( fract( cell ) - 0.5 ) * uTiles.x;
    float joint = smoothstep( uTiles.x * 0.5 - uTiles.y, uTiles.x * 0.5 - uTiles.y * 0.5, max( g.x, g.y ) );
    float tone = 1.0 + ( gyeHash3( vec3( floor( cell ), 5.0 ) ) - 0.5 ) * uTiles.w;
    return vec4( vec3( tone * ( 1.0 - joint * uTiles.z ) ), -joint * 0.002 );
  }
  return vec4( 1.0, 1.0, 1.0, 0.0 );
}

// Sin normalizar las derivadas de la posición: la inclinación es la pendiente real del relieve.
vec3 gyePerturbNormal( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sigmaX = dFdx( surfPos );
  vec3 sigmaY = dFdy( surfPos );
  vec3 r1 = cross( sigmaY, surfNorm );
  vec3 r2 = cross( surfNorm, sigmaX );
  float det = dot( sigmaX, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}`;

/** Después de `color_fragment`: tiñe el color con el dibujo. */
export const PATTERN_COLOR = /* glsl */ `
vec4 gyeSurf = gyePattern( vGyeDetail, vGyeWorld );
diffuseColor.rgb *= gyeSurf.rgb;`;

/** Después de `normal_fragment_maps`: el relieve del dibujo. */
export const PATTERN_NORMAL = /* glsl */ `
normal = gyePerturbNormal( -vViewPosition, normal, vec2( dFdx( gyeSurf.a ), dFdy( gyeSurf.a ) ) * uPatternBump, faceDirection );`;

/** Después de `aomap_fragment`: la oclusión ambiental de cada vértice. */
export const PATTERN_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= vGyeAo;
reflectedLight.indirectSpecular *= mix( 1.0, vGyeAo, uAoSpecular );`;
