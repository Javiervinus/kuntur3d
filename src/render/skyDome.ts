import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Cielo para todas las horas: de día el modelo analítico de Preetham de three.js (con sus
 * nubes); encima, lo que ese modelo no tiene: la bruma húmeda del horizonte, el crepúsculo, el
 * cielo de noche con el resplandor naranja de la ciudad (que también tiñe las nubes desde
 * abajo), las estrellas fijas en la esfera celeste (giran con la hora) y la luna con su fase
 * real (el lado iluminado es el que mira al sol) y su halo en el aire húmedo.
 * Salida en radiancia lineal (las unidades del shader de Preetham); el tone mapping es el del juego.
 */

const NIGHT_PARS = /* glsl */ `
uniform float uSkyScale;
uniform vec3 uMoonDirection;
uniform float uMoonRadius;
uniform vec3 uMoonColor;
uniform vec4 uMoonGlow;
uniform float uEarthshine;
uniform float uNightLevel;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;
uniform vec3 uCityGlow;
uniform float uCityGlowFalloff;
uniform float uCloudCityGlow;
uniform vec3 uTwilight;
uniform float uTwilightFalloff;
uniform float uStarLevel;
uniform vec4 uStars;
uniform mat3 uStarRotation;
uniform vec3 uHazeColor;
uniform vec2 uHaze;
uniform float uSkySaturation;
uniform vec3 uCloudSun;

float gyeSkyHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gyeSkyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gyeSkyHash(i), gyeSkyHash(i + vec2(1.0, 0.0)), f.x),
    mix(gyeSkyHash(i + vec2(0.0, 1.0)), gyeSkyHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// Estrellas: a lo más una por celda de una grilla sobre las caras de un cubo, del tamaño de un
// par de píxeles a cualquier resolución. uStars = (celdas por cara, fracción con estrella,
// tamaño en píxeles, exponente de brillo: más alto = menos estrellas brillantes).
vec3 gyeStars(vec3 d) {
  vec3 a = abs(d);
  float major = max(a.x, max(a.y, a.z));
  // Tamaño del píxel en celdas, desde la derivada de la dirección (continua entre caras).
  float px = max(length(fwidth(d)) * uStars.x * 0.5 / major, 1e-5);
  vec2 uv;
  float face;
  if (a.x >= a.y && a.x >= a.z) {
    uv = d.yz / a.x;
    face = d.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    uv = d.xz / a.y;
    face = d.y > 0.0 ? 2.0 : 3.0;
  } else {
    uv = d.xy / a.z;
    face = d.z > 0.0 ? 4.0 : 5.0;
  }
  vec2 g = (uv * 0.5 + 0.5) * uStars.x;
  vec2 seed = floor(g) + face * 157.0;
  if (gyeSkyHash(seed) > uStars.y) return vec3(0.0);
  vec2 center = 0.2 + 0.6 * vec2(gyeSkyHash(seed + 11.3), gyeSkyHash(seed + 27.9));
  float r = length(fract(g) - center) / (px * uStars.z);
  float magnitude = pow(gyeSkyHash(seed + 41.7), uStars.w);
  vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.78, 0.86, 1.0), gyeSkyHash(seed + 63.1));
  return tint * magnitude * exp(-r * r);
}

// Luna: la parte del disco que mira al sol está iluminada (fase y orientación reales), con
// mares más oscuros y algo de luz cenicienta. uMoonGlow = (brillo del borde, nitidez,
// halo, nitidez del halo): la dispersión hacia adelante en el aire húmedo.
vec3 gyeMoon(vec3 d, vec3 sunDir) {
  float cosM = dot(d, uMoonDirection);
  vec3 color = vec3(0.0);
  if (cosM > cos(uMoonRadius)) {
    vec3 t = normalize(cross(abs(uMoonDirection.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), uMoonDirection));
    vec3 b = cross(uMoonDirection, t);
    vec2 xy = vec2(dot(d, t), dot(d, b)) / sin(uMoonRadius);
    float z = sqrt(max(1.0 - dot(xy, xy), 0.0));
    vec3 n = normalize(xy.x * t + xy.y * b - z * uMoonDirection);
    float lit = smoothstep(-0.03, 0.08, dot(n, sunDir));
    float maria = gyeSkyNoise(xy * 2.3 + 7.0) * 0.65 + gyeSkyNoise(xy * 5.1 + 3.0) * 0.35;
    float albedo = mix(0.6, 1.0, smoothstep(0.35, 0.65, maria));
    float edge = 1.0 - smoothstep(0.94, 1.0, length(xy));
    color = uMoonColor * albedo * (lit + uEarthshine) * edge;
  }
  float c = max(cosM, 0.0);
  return color + uMoonColor * (uMoonGlow.x * pow(c, uMoonGlow.y) + uMoonGlow.z * pow(c, uMoonGlow.w));
}

// Capa de noche y crepúsculo que se suma al modelo de día (que de noche queda casi negro).
vec3 gyeNightSky(vec3 d, vec3 sunDir) {
  float h = max(d.y, 0.0);
  vec3 c = mix(uNightHorizon, uNightZenith, sqrt(h)) * uNightLevel;
  c += uCityGlow * exp(-h * uCityGlowFalloff);
  vec2 dh = normalize(d.xz + 1e-5);
  vec2 sh = normalize(sunDir.xz + 1e-5);
  c += uTwilight * pow(dot(dh, sh) * 0.5 + 0.5, 3.0) * exp(-h * uTwilightFalloff);
  return c;
}
`;

interface ShaderSource {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

function buildShader(): { vertexShader: string; fragmentShader: string } {
  const base = Sky.SkyShader as ShaderSource;
  let fragment = base.fragmentShader;
  const replace = (from: string, to: string): void => {
    if (!fragment.includes(from)) throw new Error('three.js cambió Sky.js: revisar render/skyDome.ts');
    fragment = fragment.replace(from, to);
  };
  replace('uniform float time;', `uniform float time;\n${NIGHT_PARS}`);
  // Bruma, noche, crepúsculo, estrellas y luna, antes de las nubes (que los tapan).
  replace(
    'vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );',
    `vec3 texColor = ( ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 ) ) * uSkyScale;
			// Bruma húmeda (uHaze = cantidad, caída con la altura): cerca del horizonte el cielo
			// pierde saturación hacia el color de la bruma, con la misma luminancia.
			float hazeMix = uHaze.x * exp( -max( direction.y, 0.0 ) * uHaze.y );
			float hazeLum = dot( uHazeColor, vec3( 0.2126, 0.7152, 0.0722 ) );
			vec3 hazed = uHazeColor * dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( hazeLum, 1e-4 );
			texColor = mix( texColor, hazed, hazeMix );
			texColor = mix( vec3( dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), texColor, uSkySaturation );
			texColor += gyeNightSky( direction, vSunDirection );
			if ( uStarLevel > 0.0 ) texColor += gyeStars( uStarRotation * direction ) * uStarLevel * smoothstep( 0.0, 0.3, direction.y );
			texColor += gyeMoon( direction, vSunDirection ) * smoothstep( -0.02, 0.02, direction.y );`,
  );
  // Las nubes, en la misma escala que el cielo; de noche quedan iluminadas desde abajo por la
  // ciudad (resplandor naranja).
  replace(
    'cloudColor *= max( dayFactor, 0.03 );',
    'cloudColor *= max( dayFactor, 0.03 ) * uSkyScale;\n\t\t\t\tcloudColor += uCityGlow * uCloudCityGlow;',
  );
  replace('texColor -= L0 * 0.04 * alpha;', 'texColor -= L0 * 0.04 * uSkyScale * alpha;');
  // Las nubes se iluminan con la luz del sol que les llega (la misma que ilumina la ciudad:
  // blanca de día, dorada al atardecer), no con el color de la línea de vista.
  replace(
    'vec3 sunColor = vSunE * Fex * 0.22 * 0.04; // 0.22 ~ albedo/pi, 0.04 = exposure; the aerial composite adds the eye-leg extinction',
    'vec3 sunColor = uCloudSun;',
  );
  return { vertexShader: base.vertexShader, fragmentShader: fragment };
}

export class SkyDome {
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  constructor() {
    const { vertexShader, fragmentShader } = buildShader();
    const uniforms = THREE.UniformsUtils.merge([
      (Sky.SkyShader as ShaderSource).uniforms,
      {
        uSkyScale: { value: 1 },
        uMoonDirection: { value: new THREE.Vector3(0, 1, 0) },
        uMoonRadius: { value: 0 },
        uMoonColor: { value: new THREE.Color() },
        uMoonGlow: { value: new THREE.Vector4() },
        uEarthshine: { value: 0 },
        uNightLevel: { value: 0 },
        uNightZenith: { value: new THREE.Color() },
        uNightHorizon: { value: new THREE.Color() },
        uCityGlow: { value: new THREE.Color() },
        uCityGlowFalloff: { value: 1 },
        uCloudCityGlow: { value: 0 },
        uTwilight: { value: new THREE.Color() },
        uTwilightFalloff: { value: 1 },
        uStarLevel: { value: 0 },
        uStars: { value: new THREE.Vector4(1, 0, 1, 1) },
        uStarRotation: { value: new THREE.Matrix3() },
        uHazeColor: { value: new THREE.Color(1, 1, 1) },
        uHaze: { value: new THREE.Vector2() },
        uSkySaturation: { value: 1 },
        uCloudSun: { value: new THREE.Color() },
      },
    ]);
    this.material = new THREE.ShaderMaterial({
      name: 'GyeSky',
      uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }
}
