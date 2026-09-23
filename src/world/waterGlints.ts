import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { fogTransmittanceGLSL } from '../render/fog';
import { nightLight } from '../render/nightLight';
import type { Heightmap } from './heightmap';
import type { LampData } from './streetLamps';

type GlintConfig = GameConfig['water']['glints'];
type LightsConfig = GameConfig['render']['lighting']['streetLights'];

/** Media de crest² con crest = (1 + sen)/2: dividir por ella deja igual la luz total de las crestas. */
const CREST_MEAN = 3 / 8;
/** Pasos de las bisecciones que buscan los extremos de cada tira (precisión 1/2^pasos del tramo). */
const BISECTION_STEPS = 10;
/** Margen (rad) para que la tangente del doble del borde no se dispare en π/2. */
const EDGE_EPSILON = 1e-3;

/** Luminarias con reflejo de una celda: centro, índices y altura máxima de la luminaria sobre el agua. */
interface Cell {
  x: number;
  z: number;
  lamps: Uint32Array;
  top: number;
}

/** GLSL compartido: el destello a lo largo de la tira (ver WaterGlints). */
const GLINT_GLSL = /* glsl */ `
// Inclinación de la ola a lo largo de la tira para que el punto a s del pie de la luminaria
// (hacia la cámara, cuyo pie está a D) la refleje: la mitad de la diferencia de las elevaciones,
// atan(a) - atan(b) con a y b sus tangentes. gyeTiltTan da (a - b, 1 + ab): esa diferencia es
// atan((a - b) / (1 + ab)) (a y b no son negativas), y se puede comparar sin arcotangente.
vec2 gyeTiltTan(float s, float D, float hl, float hc) {
  float a = hc / max(D - s, 1e-3);
  float b = hl / max(s, 1e-3);
  return vec2(a - b, 1.0 + a * b);
}
float gyeTilt(float s, float D, float hl, float hc) {
  vec2 q = gyeTiltTan(s, D, hl, hc);
  return 0.5 * atan(q.x, q.y);
}
// Lo más cerca del pie de la cámara que llega la tira: más allá del punto de espejo (s0) la
// elevación de la luminaria vista desde el agua no pasa de atan((hl + hc) / D), así que la de la
// cámara no pasa de esa más el doble del borde (tangente edgeTan): tan de la suma sin trigonometría.
float gyeNearest(float hl, float hc, float D, float edgeTan) {
  float x = (hl + hc) / D;
  float below = 1.0 - edgeTan * x;
  return below > 0.0 ? hc * below / (edgeTan + x) : 0.0;
}
// Destello en ese punto sin la luz del poste ni la pendiente: x = Fresnel con el ángulo de
// incidencia sobre la ola (la mitad del que forman las direcciones a la luz y a la cámara);
// y = la distancia a la luz y la vista (1 / (d² · cos θv)).
vec2 gyeGlint(float s, float D, float hl, float hc) {
  float toCam = D - s;
  float dl2 = s * s + hl * hl;
  float dc = sqrt(toCam * toCam + hc * hc);
  float cosI = sqrt(clamp(0.5 + 0.5 * (hl * hc - s * toCam) / (sqrt(dl2) * dc), 0.0, 1.0));
  float f = 1.0 - cosI;
  return vec2(0.02 + 0.98 * f * f * f * f * f, dc / (dl2 * hc));
}
// Pendiente normal con t2 = suma de los cuadrados de las inclinaciones (en desviaciones),
// rebajada para que llegue a 0 justo en el borde de la tira (edge = su valor ahí): sin corte.
float gyeSlope(float t2, float edge) {
  return max(exp(-0.5 * t2) - edge, 0.0) / (1.0 - edge);
}
// Brillo (sin el color): el destello con tope en el del reflejo en un espejo (la luminaria
// vista en el agua quieta no puede brillar más que ella misma por Fresnel).
float gyeGlintLight(vec2 glint, float slope, float power, float mirror) {
  return glint.x * min(power * glint.y * slope, mirror);
}`;

/**
 * Reflejos de los postes en el agua de noche: la columna de luz que cada luminaria de la orilla
 * (o de un puente) deja sobre el río, estirada hacia quien mira por las olas.
 *
 * Por poste cerca del agua, una tira sobre la superficie en la línea que va del pie de la
 * luminaria al de la cámara. Con el agua quieta el reflejo sería un punto (donde la vista y la
 * luz forman el mismo ángulo con el agua); con olas lo reflejan también las caras inclinadas.
 * Brillo de cada punto como el destello del sol en el mar (Cox y Munk):
 *   L = F(θi) · I / d² · p(pendiente) / (4 · cos θv),
 * con p normal de desviación `slope` (rad) a lo largo y a lo ancho, F de Fresnel con el ángulo
 * de incidencia sobre la ola, I la intensidad del poste (la misma con la que alumbra la calle,
 * por `gain`), d la distancia a la luminaria y θv el ángulo de la vista con la vertical. Con
 * tope en F · el brillo del halo (por `mirror`): el reflejo en agua quieta, que es lo más que
 * puede brillar (junto al pie de los postes cercanos la fórmula se pasa).
 *
 * La tira va de `sigmas` desviaciones del lado del poste hasta `sigmas` del lado de la cámara o
 * hasta donde el brillo baja de `cutoff` (el vertex shader busca los extremos por bisección), y
 * a lo ancho solo hasta donde el brillo baja de `cutoff` (hacia la cámara, donde se enciman las
 * estelas de todos los postes, se afina hasta terminar en punta). Ese mínimo se le resta al
 * brillo, que así llega a 0 justo en el borde de lo dibujado: sin cortes. El ancho sigue la
 * pendiente de costado que hace falta y de lejos no baja de `minPixels` (con la luz repartida en
 * ese ancho, como los halos). Encima corren crestas de olas (se apagan donde serían más finas
 * que un píxel). La tierra y los puentes la tapan por profundidad: va sobre el plano del agua.
 *
 * Además de los postes, luces que se mueven (los LED de La Perla, que giran y cambian de color):
 * hasta `moving`, reescritas cada cuadro (ver movingBuffers y commitMoving).
 */
export class WaterGlints {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  /** Las luces que se mueven: su malla y sus datos (luminaria, color e intensidad). */
  private readonly movingMesh: THREE.Mesh;
  private readonly movingGeometry: THREE.InstancedBufferGeometry;
  readonly movingBuffers: { head: Float32Array; tint: Float32Array; power: Float32Array };
  private readonly pixels: { value: number };
  private readonly time: { value: number };
  /** Costados de la vista (normal hacia adentro y constante), para descartar tiras enteras. */
  private readonly planes = Array.from({ length: 4 }, () => new THREE.Vector4());
  /** Todas las luminarias con reflejo: luminaria (x, y, z), color e intensidad. */
  private readonly head: Float32Array;
  private readonly tint: Float32Array;
  private readonly power: Float32Array;
  /**
   * Las mismas por celda de `cell` m (centro, lista y altura máxima de sus luminarias sobre el
   * agua), para mandar a la GPU solo las que pueden verse.
   */
  private readonly cells: Cell[] = [];
  /**
   * Celdas al alcance (se eligen al alejarse `recenter` m de `center`), las que están en la GPU
   * y las que se ven en este cuadro (se reusan: nada nuevo por cuadro).
   */
  private near: Cell[] = [];
  private shown: Cell[] = [];
  private seen: Cell[] = [];
  private readonly center = new THREE.Vector2(Infinity, Infinity);
  private readonly waterY: number;
  /** Tangente del doble de la inclinación del borde de la tira. */
  private readonly edgeTan: number;

  constructor(
    lamps: LampData,
    heightmap: Heightmap,
    waterY: number,
    private readonly cfg: GlintConfig,
    lights: LightsConfig,
    fog: GameConfig['render']['fog'],
    moving: number,
  ) {
    // Luminarias encendidas con agua a menos de `shoreDistance` de su pie (el agua está hundida
    // en el relieve: ver el paso `terrain` del pipeline).
    const heads: number[] = [];
    const tints: number[] = [];
    const powers: number[] = [];
    for (let k = 0; k < lamps.count; k++) {
      if (lamps.tint[k * 3] + lamps.tint[k * 3 + 1] + lamps.tint[k * 3 + 2] <= 0) continue;
      let wet = false;
      for (let i = 1; i <= cfg.shoreRings && !wet; i++) {
        const r = (cfg.shoreDistance * i) / cfg.shoreRings;
        for (let a = 0; a < cfg.shoreAngles && !wet; a++) {
          const t = (a / cfg.shoreAngles) * Math.PI * 2;
          wet = heightmap.sample(lamps.x[k] + Math.cos(t) * r, lamps.z[k] + Math.sin(t) * r) < waterY - cfg.wetDepth;
        }
      }
      if (!wet) continue;
      const reach = lights.armShare * lamps.h[k];
      heads.push(lamps.x[k] + Math.cos(lamps.arm[k]) * reach, lamps.y[k] + lamps.h[k] - lights.halo.drop, lamps.z[k] + Math.sin(lamps.arm[k]) * reach);
      tints.push(lamps.tint[k * 3], lamps.tint[k * 3 + 1], lamps.tint[k * 3 + 2]);
      // Intensidad como la del mapa de luz del suelo (luz bajo la lámpara · h²).
      powers.push(lights.underLamp * lamps.h[k] * lamps.h[k]);
    }

    // Una tira de `segments` tramos: a lo largo 0 = lado del poste … 1 = lado de la cámara; a lo ancho ±1.
    const corners: number[] = [];
    const index: number[] = [];
    for (let s = 0; s <= cfg.segments; s++) {
      corners.push(s / cfg.segments, -1, s / cfg.segments, 1);
      if (s < cfg.segments) {
        const a = s * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.head = new Float32Array(heads);
    this.tint = new Float32Array(tints);
    this.power = new Float32Array(powers);
    this.waterY = waterY;
    this.edgeTan = Math.tan(Math.min(2 * cfg.slope * cfg.sigmas, Math.PI / 2 - EDGE_EPSILON));
    const byCell = new Map<string, number[]>();
    for (let k = 0; k < this.power.length; k++) {
      const key = `${Math.floor(this.head[k * 3] / cfg.cell)},${Math.floor(this.head[k * 3 + 2] / cfg.cell)}`;
      const list = byCell.get(key);
      if (list) list.push(k);
      else byCell.set(key, [k]);
    }
    for (const [key, list] of byCell) {
      const [i, j] = key.split(',').map(Number);
      let top = 0;
      for (const k of list) top = Math.max(top, this.head[k * 3 + 1] - waterY);
      this.cells.push({ x: (i + 0.5) * cfg.cell, z: (j + 0.5) * cfg.cell, lamps: Uint32Array.from(list), top });
    }

    // Cada luminaria dibujada cuesta sus vértices aunque su tira no se vea: la GPU recibe solo las
    // que pueden verse (ver update), en atributos que se reescriben cuando eso cambia.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
    geometry.setIndex(index);
    const dynamic = (array: Float32Array, size: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(new Float32Array(array.length), size).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aHead', dynamic(this.head, 3));
    geometry.setAttribute('aTint', dynamic(this.tint, 3));
    geometry.setAttribute('aPower', dynamic(this.power, 1));
    geometry.instanceCount = 0;
    this.geometry = geometry;
    // Las que se mueven: la misma tira, sus propios datos.
    this.movingBuffers = { head: new Float32Array(moving * 3), tint: new Float32Array(moving * 3), power: new Float32Array(moving) };
    const movingGeometry = new THREE.InstancedBufferGeometry();
    movingGeometry.setAttribute('aCorner', geometry.getAttribute('aCorner'));
    movingGeometry.setIndex(geometry.getIndex());
    movingGeometry.setAttribute('aHead', new THREE.InstancedBufferAttribute(this.movingBuffers.head, 3).setUsage(THREE.DynamicDrawUsage));
    movingGeometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.movingBuffers.tint, 3).setUsage(THREE.DynamicDrawUsage));
    movingGeometry.setAttribute('aPower', new THREE.InstancedBufferAttribute(this.movingBuffers.power, 1).setUsage(THREE.DynamicDrawUsage));
    movingGeometry.instanceCount = 0;
    this.movingGeometry = movingGeometry;

    this.pixels = { value: 1 };
    this.time = { value: 0 };
    const w = cfg.waves;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uLightsOn: nightLight.uLightsOn,
        uWaterY: { value: waterY },
        uGlint: { value: new THREE.Vector4(cfg.slope, cfg.sigmas, cfg.minPixels, cfg.maxDistance) },
        // Escala del brillo (la normalización de p y el 1/4 de la fórmula), brillo mínimo visible,
        // tope del reflejo en espejo y valor de la pendiente normal en el borde de la tira.
        uGlintScale: {
          value: new THREE.Vector4(
            cfg.gain / (8 * Math.PI * cfg.slope * cfg.slope),
            cfg.cutoff,
            cfg.mirror * lights.halo.brightness,
            Math.exp(-0.5 * cfg.sigmas * cfg.sigmas),
          ),
        },
        // Crestas: número de onda, velocidad, cuánto marcan y cuánto sube la luz en la más alta.
        uGlintWaves: {
          value: new THREE.Vector4((2 * Math.PI) / w.length, w.speed, w.amount, 1 + w.amount * (1 / CREST_MEAN - 1)),
        },
        // Su vaivén: amplitud (rad de fase), número de onda y velocidad.
        uGlintWobble: { value: new THREE.Vector3(w.wobble, (2 * Math.PI) / w.wobbleLength, w.wobbleSpeed) },
        // Tangente del doble de la inclinación del borde (para compararla sin arcotangente).
        uGlintEdgeTan: { value: this.edgeTan },
        uGlintPlanes: { value: this.planes },
        uPixels: this.pixels,
        uTime: this.time,
      },
      vertexShader: /* glsl */ `
uniform float uLightsOn;
uniform float uWaterY;
uniform vec4 uGlint;
uniform vec4 uGlintScale;
uniform vec4 uGlintWaves;
uniform float uGlintEdgeTan;
uniform vec4 uGlintPlanes[4];
uniform float uPixels;
attribute vec2 aCorner;
attribute vec3 aHead;
attribute vec3 aTint;
attribute float aPower;
// Por tira: color de la luz, cuánto queda de ella (encendido, bruma y lo que se reparte de
// lejos), su intensidad con la escala del brillo, y alturas de la luminaria y de la cámara
// sobre el agua y la distancia entre sus pies (m).
varying vec3 vGlintTint;
varying float vGlintKeep;
varying float vGlintPower;
varying vec3 vGlintGeom;
// Distancia al pie de la luminaria a lo largo de la tira, y posición a lo ancho en desviaciones.
varying float vGlintS;
varying float vGlintAcross;
${fogTransmittanceGLSL(fog)}
${GLINT_GLSL}
void main() {
  vGlintTint = aTint;
  vGlintKeep = 0.0;
  vGlintPower = 0.0;
  vGlintGeom = vec3(1.0);
  vGlintS = 0.0;
  vGlintAcross = 0.0;
  float hl = aHead.y - uWaterY;
  float hc = cameraPosition.y - uWaterY;
  vec2 toCam = cameraPosition.xz - aHead.xz;
  float D = length(toCam);
  if (uLightsOn <= 0.0 || hl <= 0.0 || hc <= 0.0 || D < 1.0 || D > uGlint.w) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // La tira queda entre el pie de la luminaria y, a lo más, el punto a gyeNearest(...) del pie
  // de la cámara, sobre el agua: si ese tramo cae entero fuera de un costado de la vista (con
  // margen para su ancho en cada punta: cambia parejo a lo largo), no hay nada que dibujar.
  float nearest = gyeNearest(hl, hc, D, uGlintEdgeTan);
  vec3 pa = vec3(aHead.x, uWaterY, aHead.z);
  vec3 pb = vec3(cameraPosition.x, uWaterY, cameraPosition.z);
  pb.xz -= toCam / D * nearest;
  float halfWidth = uGlint.y * uGlint.x;
  float minHalf = 0.5 * uGlint.z / uPixels;
  float toEye = length(vec2(nearest, hc));
  float toLamp = D - nearest;
  float marginA = halfWidth * max(hl, hc) + minHalf * D;
  float marginB = halfWidth * (hl * toEye + hc * toLamp) / max(toEye + toLamp, 1e-3) + minHalf * toEye;
  for (int i = 0; i < 4; i++) {
    vec4 plane = uGlintPlanes[i];
    if (dot(plane.xyz, pa) + plane.w < -marginA && dot(plane.xyz, pb) + plane.w < -marginB) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  }
  vec2 u = toCam / D;
  float power = aPower * uGlintScale.x;
  // Extremos. Del lado del poste, donde la inclinación llega a -sigmas desviaciones; del lado de
  // la cámara, donde llega a +sigmas o antes, donde ni la cresta más alta se ve (de ahí en
  // adelante el brillo solo baja: más inclinación, más lejos de la luz y la vista más empinada).
  // ${BISECTION_STEPS} pasos: el extremo queda a 1/${2 ** BISECTION_STEPS} del tramo.
  float s0 = D * hl / (hl + hc);
  float a = 0.0;
  float b = s0;
  for (int i = 0; i < ${BISECTION_STEPS}; i++) {
    float m = 0.5 * (a + b);
    vec2 q = gyeTiltTan(m, D, hl, hc);
    if (q.x < -uGlintEdgeTan * q.y) a = m; else b = m;
  }
  float sFar = a;
  a = s0;
  b = D;
  for (int i = 0; i < ${BISECTION_STEPS}; i++) {
    float m = 0.5 * (a + b);
    float t = gyeTilt(m, D, hl, hc) / uGlint.x;
    float light = gyeGlintLight(gyeGlint(m, D, hl, hc), gyeSlope(t * t, uGlintScale.w), power, uGlintScale.z);
    if (t < uGlint.y && light * uGlintWaves.w > uGlintScale.y) a = m; else b = m;
  }
  float s = mix(sFar, b, aCorner.x);
  float t = gyeTilt(s, D, hl, hc) / uGlint.x;
  vec2 glint = gyeGlint(s, D, hl, hc);
  // Hasta dónde a lo ancho (en desviaciones) la cresta más alta supera el mínimo visible:
  // exp(-(t² + a²) / 2) > edge + (1 - edge) · mínimo / brillo sin la pendiente.
  float k = uGlintScale.w + (1.0 - uGlintScale.w) * uGlintScale.y / max(glint.x * power * glint.y * uGlintWaves.w, 1e-12);
  float reach = k < 1.0 ? clamp(sqrt(max(-2.0 * log(k) - t * t, 0.0)), 0.0, uGlint.y) : 0.0;
  // Ancho: a y metros del eje, la ola debe inclinarse de costado y·(1/dl + 1/dc) / (suma de los
  // senos de las dos elevaciones); una desviación de pendiente corresponde a este ancho (m).
  float dl = sqrt(s * s + hl * hl);
  float dc = sqrt((D - s) * (D - s) + hc * hc);
  float sigmaW = uGlint.x * (hl / dl + hc / dc) / (1.0 / dl + 1.0 / dc);
  vec2 xz = aHead.xz + u * s;
  vec3 world = vec3(xz.x, uWaterY, xz.y);
  // De lejos, la tira entera al menos minPixels de ancho, con la misma luz total (repartida en
  // más ancho).
  float perMeter = uPixels / max(distance(world, cameraPosition), 1e-3);
  float drawn = max(sigmaW, 0.5 * uGlint.z / (uGlint.y * perMeter));
  world.xz += vec2(-u.y, u.x) * (aCorner.y * reach * drawn);
  vGlintKeep = uLightsOn * sigmaW / drawn * gyeFogTransmittance(world);
  vGlintPower = power;
  vGlintGeom = vec3(hl, hc, D);
  vGlintS = s;
  vGlintAcross = aCorner.y * reach;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform vec4 uGlint;
uniform vec4 uGlintScale;
uniform vec4 uGlintWaves;
uniform vec3 uGlintWobble;
uniform float uTime;
varying vec3 vGlintTint;
varying float vGlintKeep;
varying float vGlintPower;
varying vec3 vGlintGeom;
varying float vGlintS;
varying float vGlintAcross;
${GLINT_GLSL}
void main() {
  float s = vGlintS;
  float t = gyeTilt(s, vGlintGeom.z, vGlintGeom.x, vGlintGeom.y) / uGlint.x;
  vec2 glint = gyeGlint(s, vGlintGeom.z, vGlintGeom.x, vGlintGeom.y);
  // Crestas que corren hacia la cámara, con vaivén (la luz total no cambia). Se apagan donde
  // medio periodo cabe en un píxel (fwidth ≥ π).
  float phase = s * uGlintWaves.x - uTime * uGlintWaves.y + uGlintWobble.x * sin(s * uGlintWobble.y + uTime * uGlintWobble.z);
  float crisp = clamp(1.0 - fwidth(phase) / ${Math.PI.toFixed(8)}, 0.0, 1.0);
  float crest = 0.5 + 0.5 * sin(phase);
  float waves = mix(1.0, crest * crest / ${CREST_MEAN.toFixed(3)}, uGlintWaves.z * crisp);
  float slope = gyeSlope(t * t + vGlintAcross * vGlintAcross, uGlintScale.w);
  float light = gyeGlintLight(glint, slope * waves, vGlintPower, uGlintScale.z) * vGlintKeep;
  // Sin el mínimo visible: llega a 0 justo en el borde de lo dibujado.
  gl_FragColor = vec4(vGlintTint * max(light - uGlintScale.y, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.movingMesh = new THREE.Mesh(movingGeometry, material);
    this.mesh.name = 'water-glints';
    this.movingMesh.name = 'water-glints-moving';
    for (const mesh of [this.mesh, this.movingMesh]) {
      mesh.frustumCulled = false;
      mesh.visible = false;
      // Después del agua (que es opaca): se suma encima.
      mesh.renderOrder = 1;
    }
    this.group.name = 'water-glints';
    this.group.add(this.mesh, this.movingMesh);
  }

  /** Las luces que se mueven ya escritas en movingBuffers: las primeras `count` se dibujan. */
  commitMoving(count: number): void {
    const g = this.movingGeometry;
    g.instanceCount = count;
    for (const name of ['aHead', 'aTint', 'aPower']) {
      const attribute = g.getAttribute(name) as THREE.InstancedBufferAttribute;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  /** Postes con reflejo (en todo el mundo). */
  get count(): number {
    return this.power.length;
  }

  /** Los que están en la GPU ahora (los que quedan al alcance de la cámara). */
  get drawn(): number {
    return this.geometry.instanceCount;
  }

  /**
   * Solo de noche. Manda a la GPU las luminarias de las celdas que pueden verse: al alejarse
   * `recenter` m elige las que quedan a menos de `maxDistance` (más ese margen) y en cada cuadro,
   * de esas, las que caen en la vista (ver inView). El ancho mínimo en pantalla y los costados de
   * la vista dependen de la cámara.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    const on = nightLight.uLightsOn.value > 0;
    this.mesh.visible = on && this.count > 0;
    this.movingMesh.visible = on && this.movingGeometry.instanceCount > 0;
    if (!on) return;
    this.time.value += dt;
    this.pixels.value = renderer.getDrawingBufferSize(_size).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    // Los cuatro primeros planos de three.js son los costados (derecha, izquierda, abajo, arriba).
    for (let i = 0; i < this.planes.length; i++) {
      const plane = _frustum.planes[i];
      this.planes[i].set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    }
    const eye = camera.position;
    if (Math.hypot(eye.x - this.center.x, eye.z - this.center.y) > this.cfg.recenter) {
      this.center.set(eye.x, eye.z);
      const reach = this.cfg.maxDistance + this.cfg.recenter + this.cfg.cell * Math.SQRT1_2;
      this.near = this.cells.filter((c) => Math.hypot(c.x - eye.x, c.z - eye.z) <= reach);
    }
    const seen = this.seen;
    seen.length = 0;
    for (const cell of this.near) if (this.inView(cell, eye)) seen.push(cell);
    let same = seen.length === this.shown.length;
    for (let i = 0; same && i < seen.length; i++) same = seen[i] === this.shown[i];
    if (!same) {
      // Se intercambian: la lista vieja se reusa en el próximo cuadro.
      this.seen = this.shown;
      this.shown = seen;
      this.upload(seen);
    }
    this.mesh.visible = this.drawn > 0;
  }

  /**
   * Si alguna tira de la celda puede verse (la misma prueba que hace la GPU con cada una, para
   * toda la celda): van del disco de la celda hacia el pie de la cámara sin acercarse a él más que
   * gyeNearest con la luminaria más alta y la distancia más corta; esos extremos caen en el
   * triángulo que envuelve el arco a esa distancia. Fuera de un costado de la vista todo eso, con
   * margen para el ancho de la tira, la celda no se manda. El ancho cambia parejo a lo largo de
   * la tira (sigue a la altura de la luminaria cerca de ella y a la de la cámara cerca de esta, y
   * el mínimo en píxeles crece con la distancia): cada extremo lleva su propio margen.
   */
  private inView(cell: Cell, eye: THREE.Vector3): boolean {
    const hc = eye.y - this.waterY;
    if (hc <= 0) return false;
    const radius = this.cfg.cell * Math.SQRT1_2;
    const dx = cell.x - eye.x;
    const dz = cell.z - eye.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= radius) return true;
    const x = (cell.top + hc) / (dist - radius);
    const below = 1 - this.edgeTan * x;
    const nearest = below > 0 ? (hc * below) / (this.edgeTan + x) : 0;
    const spread = Math.asin(radius / dist);
    const heading = Math.atan2(dz, dx);
    const tip = nearest / Math.cos(spread);
    _points[0].set(eye.x + Math.cos(heading - spread) * nearest, this.waterY, eye.z + Math.sin(heading - spread) * nearest);
    _points[1].set(eye.x + Math.cos(heading + spread) * nearest, this.waterY, eye.z + Math.sin(heading + spread) * nearest);
    _points[2].set(eye.x + Math.cos(heading) * tip, this.waterY, eye.z + Math.sin(heading) * tip);
    _center.set(cell.x, this.waterY, cell.z);
    const halfWidth = this.cfg.sigmas * this.cfg.slope;
    const minHalf = (0.5 * this.cfg.minPixels) / this.pixels.value;
    const far = halfWidth * Math.max(cell.top, hc) + minHalf * (dist + radius);
    // Junto a la cámara: promedio de las alturas pesado por la distancia a la otra punta.
    const toEye = Math.hypot(tip, hc);
    const toLamp = Math.max(dist - radius - tip, 0);
    const near = (halfWidth * (cell.top * toEye + hc * toLamp)) / Math.max(toEye + toLamp, 1e-3) + minHalf * toEye;
    for (let i = 0; i < this.planes.length; i++) {
      const plane = _frustum.planes[i];
      if (plane.distanceToPoint(_center) >= -(radius + far)) continue;
      let outside = true;
      for (const point of _points) outside &&= plane.distanceToPoint(point) < -near;
      if (outside) return false;
    }
    return true;
  }

  /** Copia a la GPU las luminarias de esas celdas. */
  private upload(cells: Cell[]): void {
    const head = this.geometry.getAttribute('aHead') as THREE.InstancedBufferAttribute;
    const tint = this.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
    const power = this.geometry.getAttribute('aPower') as THREE.InstancedBufferAttribute;
    const h = head.array as Float32Array;
    const t = tint.array as Float32Array;
    const p = power.array as Float32Array;
    let n = 0;
    for (const cell of cells) {
      for (const k of cell.lamps) {
        h.set(this.head.subarray(k * 3, k * 3 + 3), n * 3);
        t.set(this.tint.subarray(k * 3, k * 3 + 3), n * 3);
        p[n] = this.power[k];
        n++;
      }
    }
    for (const attribute of [head, tint, power]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
  }
}

const _size = new THREE.Vector2();
const _frustum = new THREE.Frustum();
const _matrix = new THREE.Matrix4();
const _center = new THREE.Vector3();
const _points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
