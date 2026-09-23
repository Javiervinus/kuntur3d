import * as THREE from 'three';
import { getMoonIllumination, getMoonPosition, getPosition } from 'suncalc';

/** Dónde está un astro: dirección unitaria en el marco del mundo y altura sobre el horizonte. */
export interface Body {
  direction: THREE.Vector3;
  /** Grados sobre el horizonte (con refracción); negativo = bajo el horizonte. */
  altitude: number;
}

export interface Celestial {
  sun: Body;
  moon: Body & {
    /** Fracción iluminada del disco: 0 luna nueva, 1 llena. */
    illumination: number;
  };
}

/**
 * Dirección en el marco local (x = este, z = sur, y = arriba) desde el azimut (grados desde el
 * norte, horario) y la altura sobre el horizonte. El norte de la cuadrícula UTM y el geográfico
 * difieren menos de 0,1° en esta zona.
 */
function toDirection(azimuthDeg: number, altitudeDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const alt = THREE.MathUtils.degToRad(altitudeDeg);
  return out.set(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)).normalize();
}

/** Posición real del sol y la luna vistos desde (lat, lon) en ese instante (algoritmos de SunCalc). */
export function celestialAt(instant: Date, lat: number, lon: number, out?: Celestial): Celestial {
  const sky = out ?? {
    sun: { direction: new THREE.Vector3(), altitude: 0 },
    moon: { direction: new THREE.Vector3(), altitude: 0, illumination: 0 },
  };
  const sun = getPosition(instant, lat, lon);
  toDirection(sun.azimuth, sun.altitude, sky.sun.direction);
  sky.sun.altitude = sun.altitude;
  const moon = getMoonPosition(instant, lat, lon);
  toDirection(moon.azimuth, moon.altitude, sky.moon.direction);
  sky.moon.altitude = moon.altitude;
  sky.moon.illumination = getMoonIllumination(instant).fraction;
  return sky;
}
