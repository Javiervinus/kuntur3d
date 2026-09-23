import * as THREE from 'three';

/**
 * Modelo del cielo en la CPU: el mismo cielo analítico de Preetham que dibuja el shader
 * (three/addons/objects/Sky.js, sin nubes), evaluado en JavaScript. Sirve para lo que tiene
 * que coincidir con el cielo que se ve sin leer nada de la GPU: el color del horizonte (la
 * bruma lejana se funde con él), la luz que el cielo manda al suelo (el rebote del suelo en
 * los reflejos) y la del sol que atraviesa la atmósfera (dorado al amanecer y al atardecer).
 * Unidades: las del shader (ya con su factor de exposición 0,04).
 */

export interface SkyParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

/**
 * Lo que el shader del cielo le hace al modelo de Preetham (ver skyDome.ts), en el mismo orden:
 * escala a las unidades del juego, bruma húmeda hacia el horizonte (misma luminancia, color de
 * la bruma) y saturación general.
 */
export interface SkyLook {
  scale: number;
  hazeAmount: number;
  hazeFalloff: number;
  hazeColor: THREE.Color;
  saturation: number;
}

const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const _haze = new THREE.Color();

/** Aplica el aspecto del cielo del shader a un color del modelo, visto con altura `dirY` (seno). */
export function applyLook(c: THREE.Color, dirY: number, look: SkyLook): THREE.Color {
  c.multiplyScalar(look.scale);
  const mix = look.hazeAmount * Math.exp(-Math.max(dirY, 0) * look.hazeFalloff);
  _haze.copy(look.hazeColor).multiplyScalar(lum(c) / Math.max(lum(look.hazeColor), 1e-4));
  c.lerp(_haze, mix);
  const l = lum(c);
  return c.setRGB(l + (c.r - l) * look.saturation, l + (c.g - l) * look.saturation, l + (c.b - l) * look.saturation);
}

// Constantes del shader de three.js (Preetham): longitudes de onda R, G, B y dispersión.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const EXPOSURE = 0.04;
const NIGHT_FLOOR = [0, 0.0003, 0.00075];
const THREE_OVER_SIXTEEN_PI = 3 / (16 * Math.PI);
const ONE_OVER_FOUR_PI = 1 / (4 * Math.PI);

function sunIntensity(zenithAngleCos: number): number {
  const c = THREE.MathUtils.clamp(zenithAngleCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}

/** Lo que el shader calcula por vértice: depende solo del sol y de los parámetros. */
interface Coefficients {
  betaR: number[];
  betaM: number[];
  sunE: number;
}

function coefficients(sun: THREE.Vector3, p: SkyParams): Coefficients {
  // Igual que el shader con la dirección unitaria del sol como `sunPosition` (queda casi en 1).
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(sun.y / 450000), 0, 1);
  const rayleighCoefficient = p.rayleigh - (1 - sunfade);
  const c = 0.2 * p.turbidity * 10e-18;
  return {
    betaR: TOTAL_RAYLEIGH.map((b) => b * rayleighCoefficient),
    betaM: MIE_CONST.map((m) => 0.434 * c * m * p.mieCoefficient),
    sunE: sunIntensity(sun.y),
  };
}

/** Radiancia del cielo en la dirección `dir` (unitaria), sin disco solar ni nubes. */
export function skyRadiance(dir: THREE.Vector3, sun: THREE.Vector3, p: SkyParams, out: THREE.Color, k = coefficients(sun, p)): THREE.Color {
  const zenithAngle = Math.acos(Math.max(0, dir.y));
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  const cosTheta = dir.dot(sun);
  const rc = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEEN_PI * (1 + rc * rc);
  const g2 = p.mieDirectionalG * p.mieDirectionalG;
  const mPhase = ONE_OVER_FOUR_PI * ((1 - g2) / Math.pow(1 - 2 * p.mieDirectionalG * cosTheta + g2, 1.5));
  const horizonMix = THREE.MathUtils.clamp(Math.pow(1 - sun.y, 5), 0, 1);
  const rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const fex = Math.exp(-(k.betaR[c] * sR + k.betaM[c] * sM));
    const ratio = (k.betaR[c] * rPhase + k.betaM[c] * mPhase) / (k.betaR[c] + k.betaM[c]);
    let lin = Math.pow(k.sunE * ratio * (1 - fex), 1.5);
    lin *= THREE.MathUtils.lerp(1, Math.pow(k.sunE * ratio * fex, 0.5), horizonMix);
    const l0 = 0.1 * fex;
    rgb[c] = (lin + l0) * EXPOSURE + NIGHT_FLOOR[c];
  }
  return out.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
}

const _dir = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Irradiancia del cielo sobre una superficie horizontal dividida por π (= radiancia media
 * ponderada por el coseno): lo que ilumina el suelo aparte del sol directo.
 */
export function skyAmbient(sun: THREE.Vector3, p: SkyParams, look: SkyLook, out: THREE.Color, rings = 8, sectors = 24): THREE.Color {
  const k = coefficients(sun, p);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < rings; i++) {
    // Anillos de igual área proyectada: sin² de la altura uniforme.
    const sinAlt = Math.sqrt((i + 0.5) / rings);
    const cosAlt = Math.sqrt(1 - sinAlt * sinAlt);
    for (let j = 0; j < sectors; j++) {
      const az = ((j + 0.5) / sectors) * Math.PI * 2;
      _dir.set(cosAlt * Math.sin(az), sinAlt, cosAlt * Math.cos(az));
      applyLook(skyRadiance(_dir, sun, p, _c, k), _dir.y, look);
      r += _c.r;
      g += _c.g;
      b += _c.b;
      weight++;
    }
  }
  return out.setRGB(r / weight, g / weight, b / weight, THREE.LinearSRGBColorSpace);
}

/** Color del cielo (con su aspecto) cerca del horizonte, visto con acimut `azimuth` (rad, 0 = +z). */
export function horizonRadiance(
  azimuth: number,
  elevation: number,
  sun: THREE.Vector3,
  p: SkyParams,
  look: SkyLook,
  out: THREE.Color,
): THREE.Color {
  const ce = Math.cos(elevation);
  _dir.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth));
  return applyLook(skyRadiance(_dir, sun, p, out), _dir.y, look);
}

/**
 * Color relativo de la luz del sol después de atravesar la atmósfera (1 = sol en el cenit
 * con el aire de referencia): Rayleigh por longitud de onda más aerosoles (bruma), con la
 * masa de aire de Kasten y Young. Con el sol bajo pasa a dorado y naranja; bajo el horizonte, 0.
 */
export function sunTransmittance(
  altitudeDeg: number,
  rayleighDepth: readonly number[],
  aerosolDepth: number,
  out: THREE.Color,
): THREE.Color {
  if (altitudeDeg <= -0.5) return out.setRGB(0, 0, 0);
  const alt = Math.max(altitudeDeg, 0);
  const airMass = 1 / (Math.sin(THREE.MathUtils.degToRad(alt)) + 0.50572 * Math.pow(alt + 6.07995, -1.6364));
  const t = (c: number): number => Math.exp(-(rayleighDepth[c] + aerosolDepth) * (airMass - 1));
  // Se apaga suave en el último medio grado (el disco se hunde en el horizonte).
  const sink = THREE.MathUtils.smoothstep(altitudeDeg, -0.5, 0.5);
  return out.setRGB(t(0) * sink, t(1) * sink, t(2) * sink, THREE.LinearSRGBColorSpace);
}
