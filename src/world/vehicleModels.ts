import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig } from '../core/types';
import { withNightLight } from '../render/nightLight';

type TrafficConfig = GameConfig['traffic'];
export type VehicleKind = TrafficConfig['kinds'][number];

/**
 * Pieza de un vehículo (config/game.json → traffic.kinds[].parts): un perfil lateral (x, y)
 * extruido `width` m a lo ancho, o una caja de lados `box` centrada en `at`. Sin `color` va
 * pintada del color del vehículo; `glow` es su luz propia de noche (por `glowIntensity`).
 */
interface VehiclePart {
  shape?: number[][];
  width?: number;
  box?: number[];
  at?: number[];
  color?: string;
  glow?: string;
  glowIntensity?: number;
}

/** Luces del vehículo en su marco (x adelante, y arriba, z al costado): una de cada par (la otra, con z opuesta). */
export interface VehicleLights {
  head: THREE.Vector3;
  tail: THREE.Vector3;
}

/**
 * Da a una pieza los atributos que usa el material de los vehículos: color (blanco donde va la
 * pintura del vehículo), aPaint (1 = se pinta con su color), aGlow (luz propia de noche) y aTail
 * (1 = luz de freno).
 */
function finish(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  paint: number,
  glow: THREE.Color,
  tail: number,
): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.clearGroups();
  const n = g.getAttribute('position').count;
  const fill = (values: number[]): Float32Array => {
    const out = new Float32Array(n * values.length);
    for (let k = 0; k < n; k++) out.set(values, k * values.length);
    return out;
  };
  g.setAttribute('color', new THREE.BufferAttribute(fill([color.r, color.g, color.b]), 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(fill([paint]), 1));
  g.setAttribute('aGlow', new THREE.BufferAttribute(fill([glow.r, glow.g, glow.b]), 3));
  g.setAttribute('aTail', new THREE.BufferAttribute(fill([tail]), 1));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/** Geometría de una pieza: perfil lateral extruido a lo ancho, o caja. */
function partGeometry(part: VehiclePart): THREE.BufferGeometry {
  if (part.shape) {
    const shape = new THREE.Shape(part.shape.map(([x, y]) => new THREE.Vector2(x, y)));
    const width = part.width ?? 0;
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    g.translate(0, 0, -width / 2);
    return g;
  }
  if (part.box && part.at) {
    const [sx, sy, sz] = part.box;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(part.at[0], part.at[1], part.at[2]);
    return g;
  }
  throw new Error('Pieza de vehículo sin "shape" ni "box"/"at" en config/game.json (traffic.kinds)');
}

/** Detalle de un vehículo lejano: ruedas con menos lados y sin faros ni luces de atrás. */
export interface VehicleFar {
  wheelSegments: number;
}

/**
 * Vehículo de un tipo (config/game.json → traffic.kinds), en su marco: x hacia adelante, y
 * hacia arriba desde el suelo, z al costado. Piezas de la config (carrocería y cabina como
 * perfiles laterales extruidos, techo, letreros…), las cuatro ruedas y los faros y luces de
 * atrás (con la luz propia de `lights`), todo en una sola geometría. Con `far`, la versión
 * para lejos (ver VehicleFar).
 */
export function vehicleGeometry(kind: VehicleKind, lights: TrafficConfig['lights'], far?: VehicleFar): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const black = new THREE.Color(0, 0, 0);
  const white = new THREE.Color(1, 1, 1);
  for (const part of kind.parts as readonly VehiclePart[]) {
    const color = part.color ? new THREE.Color(part.color) : white;
    const glow = part.glow ? new THREE.Color(part.glow).multiplyScalar(part.glowIntensity ?? 1) : black;
    parts.push(finish(partGeometry(part), color, part.color ? 0 : 1, glow, 0));
  }
  // Ruedas.
  const w = kind.wheels;
  const wheelColor = new THREE.Color(w.color);
  for (const x of w.axles) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(w.radius, w.radius, w.width, far ? far.wheelSegments : w.segments);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(x, w.radius, (side * w.track) / 2);
      parts.push(finish(wheel, wheelColor, 0, black, 0));
    }
  }
  // Faros y luces de atrás, a los dos lados.
  const l = kind.lights;
  const lamp = (at: number[], light: TrafficConfig['lights']['head'], tail: number): void => {
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(l.size[0], l.size[1], l.size[2]);
      g.translate(at[0], at[1], side * at[2]);
      parts.push(finish(g, new THREE.Color(light.lens), 0, new THREE.Color(light.color).multiplyScalar(light.glow), tail));
    }
  };
  if (!far) {
    lamp(l.head, lights.head, 0);
    lamp(l.tail, lights.tail, 1);
  }
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error(`No se pudo armar el vehículo ${kind.name}`);
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Material de los vehículos (tráfico y estacionados): colores por vértice, el color de cada
 * vehículo solo en la pintura (aPaint), luz propia de noche (aGlow, por `lightsOn`: 0 = apagadas)
 * y luz de freno (aTail por aBrake, un atributo por vehículo). Los postes los alumbran de noche.
 * Un solo programa para todos: cambian solo los valores de sus uniformes.
 */
export function createVehicleMaterial(cfg: TrafficConfig, lightsOn: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: cfg.roughness, metalness: cfg.metalness });
  // (No `uLightsOn`: ese nombre es de la luz de noche, que se agrega después y lo pisaría.)
  const uniforms = {
    uVehicleLights: lightsOn,
    uBrake: { value: new THREE.Color(cfg.lights.tail.color).multiplyScalar(cfg.lights.brake) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uVehicleLights;
uniform vec3 uBrake;
attribute float aPaint;
attribute vec3 aGlow;
attribute float aTail;
attribute float aBrake;
varying vec3 vVehicleGlow;`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4( 1.0 );
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  // El color de cada vehículo solo en la pintura (no en vidrios, llantas ni luces).
  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, aPaint );
#endif
// Luz propia: faros, luces de atrás y letreros de noche; la de freno, siempre que frena.
vVehicleGlow = aGlow * uVehicleLights + uBrake * ( aTail * aBrake );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVehicleGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vVehicleGlow;');
  };
  material.customProgramCacheKey = () => 'gye-vehicle-v2';
  withNightLight(material);
  return material;
}

/** Dónde van las luces de un tipo de vehículo (para los halos). */
export function vehicleLights(kind: VehicleKind): VehicleLights {
  const l = kind.lights;
  return {
    head: new THREE.Vector3(l.head[0] + l.size[0] / 2, l.head[1], l.head[2]),
    tail: new THREE.Vector3(l.tail[0] - l.size[0] / 2, l.tail[1], l.tail[2]),
  };
}
