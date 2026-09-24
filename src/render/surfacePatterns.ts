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
  const gl = cfg.glazing;
  const pv = cfg.pavers;
  const br = cfg.bars;
  const bl = cfg.balusters;
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
    uGlazing: { value: new THREE.Vector4(gl.frame, gl.bump, gl.variation, gl.toneScale) },
    uPavers: { value: new THREE.Vector4(pv.size[0], pv.size[1], pv.joint, pv.jointShade) },
    uPaversTone: { value: new THREE.Vector2(pv.variation, pv.bump) },
    uBars: { value: new THREE.Vector2(br.spacing, br.width) },
    uBalusters: { value: new THREE.Vector4(bl.spacing, bl.width, bl.plinth, bl.neck) },
    uPatternBump: { value: cfg.bump },
    uAoSpecular: { value: cfg.aoSpecular },
  };
}

/**
 * Declaraciones del vertex shader (después de `#include <common>`): `aSurface` = (oclusión, LED,
 * tipo de dibujo / 255, tono del dibujo) en bytes y `aDetail` = uv del dibujo en metros (ver
 * world/monumentParts.ts → compact).
 */
export const PATTERN_VERTEX_PARS = /* glsl */ `
attribute vec4 aSurface;
attribute vec2 aDetail;
varying float vGyeAo;
varying vec3 vGyeDetail;
varying vec3 vGyeWorld;
varying float vGyeFoot;
varying float vGyeTone;`;

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
  vGyeTone = aSurface.w;
  vGyeDetail = vec3( aDetail, floor( aSurface.z * 255.0 + 0.5 ) );
}`;

/**
 * Funciones del fragment shader: cada dibujo devuelve cuánto tiñe el color y un relieve (m) del
 * que sale la normal (bump mapping de Mikkelsen, igual que el de three.js). `gyeMask` es cuánto
 * de la luz propia deja pasar (la carpintería de una ventana encendida no brilla).
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
uniform vec4 uGlazing;
uniform vec4 uPavers;
uniform vec2 uPaversTone;
uniform vec2 uBars;
uniform vec4 uBalusters;
uniform float uPatternBump;
uniform float uAoSpecular;
varying float vGyeAo;
varying vec3 vGyeDetail;
varying vec3 vGyeWorld;
varying float vGyeFoot;
varying float vGyeTone;
float gyeMask = 1.0;

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
  if ( kind == 6 ) {
    // Carpintería: una junta (marco, parteluz, travesaño) en cada entero de las uv, que van en
    // hojas; el marco es más claro u oscuro que el vidrio según el tono, y cada hoja refleja un
    // poco distinto. Las juntas no brillan de noche.
    vec2 g = abs( fract( d.xy + 0.5 ) - 0.5 );
    vec2 aa = fwidth( d.xy );
    float frame = max( 1.0 - smoothstep( uGlazing.x - aa.x, uGlazing.x + aa.x, g.x ), 1.0 - smoothstep( uGlazing.x - aa.y, uGlazing.x + aa.y, g.y ) );
    float pane = 1.0 + ( gyeHash3( vec3( floor( d.xy ), 11.0 ) + floor( w * 0.37 ) ) - 0.5 ) * uGlazing.z;
    gyeMask = 1.0 - frame;
    return vec4( vec3( mix( pane, vGyeTone * uGlazing.w, frame ) ), frame * uGlazing.y );
  }
  if ( kind == 7 ) {
    // Adoquines de vereda en hileras trabadas (medio adoquín de corrimiento por hilera), con su
    // junta hundida y el tono de cada pieza.
    vec2 cell = d.xy / uPavers.xy;
    float row = floor( cell.y );
    cell.x += 0.5 * mod( row, 2.0 );
    vec2 g = abs( fract( cell ) - 0.5 ) * uPavers.xy;
    vec2 edge = uPavers.xy * 0.5 - g;
    float joint = 1.0 - smoothstep( uPavers.z * 0.5, uPavers.z, min( edge.x, edge.y ) );
    float tone = 1.0 + ( gyeHash3( vec3( floor( cell.x ), row, 7.0 ) ) - 0.5 ) * uPaversTone.x;
    return vec4( vec3( tone * ( 1.0 - joint * uPavers.w ) ), -joint * uPaversTone.y );
  }
  if ( kind == 8 ) {
    // Baranda de barrotes (uv en m): un barrote cada tanto y la pletina de abajo; lo demás es
    // hueco (el material con recorte lo descarta, ver GYE_CUTOUT).
    // De lejos, cuando un barrote ya es más fino que un píxel, un tramado estable con la misma
    // parte llena (sin el muaré de barrotes que aparecen y desaparecen).
    float g = abs( fract( d.x / uBars.x + 0.5 ) - 0.5 ) * uBars.x;
    float bar = max( step( g, uBars.y * 0.5 ), step( d.y, uBars.y ) );
    float fine = smoothstep( 0.5, 1.0, fwidth( d.x ) / uBars.y );
    float dither = step( gyeHash3( vec3( floor( gl_FragCoord.xy ), 8.0 ) ), uBars.y / uBars.x );
    gyeMask = mix( bar, dither, step( 0.5, fine ) );
    return vec4( vec3( 1.0 ), 0.0 );
  }
  if ( kind == 9 ) {
    // Balaustrada (uv en m, v desde el pie): zócalo lleno abajo, pasamanos lleno arriba y entre
    // ellos un balaustre por celda con silueta de jarrón (panza abajo, cuello y collar arriba; el
    // mismo perfil que world/classical.ts → baluster), sombreado como si fuera torneado.
    float x = abs( fract( d.x / uBalusters.x ) - 0.5 ) * uBalusters.x;
    float t = clamp( ( d.y - uBalusters.z ) / uBalusters.w, 0.0, 1.0 );
    float belly = sin( 3.14159 * clamp( t / 0.55, 0.0, 1.0 ) );
    float collar = smoothstep( 0.72, 0.8, t ) * ( 1.0 - smoothstep( 0.88, 0.96, t ) );
    float r = uBalusters.y * ( 0.2 + 0.26 * belly + 0.1 * collar );
    float solid = step( d.y, uBalusters.z ) + step( uBalusters.z + uBalusters.w, d.y );
    gyeMask = max( min( solid, 1.0 ), step( x, r ) );
    float turned = sqrt( max( 1.0 - ( x * x ) / max( r * r, 1e-6 ), 0.0 ) );
    return vec4( vec3( mix( 0.7 + 0.3 * turned, 1.0, min( solid, 1.0 ) ) ), 0.0 );
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

/** Después de `color_fragment`: tiñe el color con el dibujo (con GYE_CUTOUT, descarta los huecos). */
export const PATTERN_COLOR = /* glsl */ `
vec4 gyeSurf = gyePattern( vGyeDetail, vGyeWorld );
#ifdef GYE_CUTOUT
  if ( gyeMask < 0.5 ) discard;
#endif
diffuseColor.rgb *= gyeSurf.rgb;`;

/** Después de `normal_fragment_maps`: el relieve del dibujo. */
export const PATTERN_NORMAL = /* glsl */ `
normal = gyePerturbNormal( -vViewPosition, normal, vec2( dFdx( gyeSurf.a ), dFdy( gyeSurf.a ) ) * uPatternBump, faceDirection );`;

/** Después de `aomap_fragment`: la oclusión ambiental de cada vértice. */
export const PATTERN_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= vGyeAo;
reflectedLight.indirectSpecular *= mix( 1.0, vGyeAo, uAoSpecular );`;
