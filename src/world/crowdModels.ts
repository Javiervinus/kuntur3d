import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig } from '../core/types';
import { withNightLight } from '../render/nightLight';

type PedestriansConfig = GameConfig['pedestrians'];
export type CrowdBodyConfig = PedestriansConfig['bodies'][number];

/** Qué es cada vértice (atributo aPart): el cuerpo lleva la ropa, el pelo su color, los ojos su textura. */
const PART_BODY = 0;
const PART_HAIR = 1;
const PART_EYES = 2;

/** Atributos por persona que lee el shader (los escribe Pedestrians en cada cuadro): */
export const CROWD_ATTRIBUTES = [
  /** fila de la animación, fila de la que se viene y cuánto queda de ella (la mezcla al cambiar de clip) */
  'aAnim',
  /** color de la parte de arriba y hasta dónde llegan las mangas (|x| en la pose de reposo) */
  'aTop',
  /** color del pantalón y dónde termina abajo (y en la pose de reposo) */
  'aBottom',
  /** color de los zapatos y hasta dónde suben */
  'aFeet',
  /** color del pelo y tono de piel (factor sobre la textura) */
  'aHead',
] as const;
export type CrowdAttribute = (typeof CROWD_ATTRIBUTES)[number];

/** Clip horneado en la textura de huesos: filas [start, start + frames), una por cuadro. */
export interface BakedClip {
  start: number;
  frames: number;
  duration: number;
  /** m/s a los que el clip va a ritmo normal con el modelo a escala 1 (0: en el lugar). */
  stride: number;
}

/** Un tipo de peatón listo para dibujar: su cuerpo con cada peinado y nivel de detalle. */
export interface CrowdBody {
  cfg: CrowdBodyConfig;
  /** meshes[peinado][nivel de detalle], con sus atributos por persona en attributes[peinado][nivel]. */
  meshes: THREE.InstancedMesh[][];
  attributes: Record<CrowdAttribute, THREE.InstancedBufferAttribute>[][];
  clips: Map<string, BakedClip>;
  /** Estatura del modelo (m, de los pies a la coronilla, sin peinado). */
  height: number;
  /** Giro (rad, alrededor de y) que deja al modelo mirando hacia +x. */
  yaw: number;
}

/** Filas de la textura por hueso: la matriz afín de 3×4, una fila por texel. */
const ROWS_PER_JOINT = 3;

/**
 * Esqueleto animado en el shader: la matriz de cada hueso sale de la textura de huesos (una
 * fila por cuadro de animación, tres texels por hueso) y se mezclan hasta dos cuadros (el clip
 * que empieza y el que termina, mientras dura la transición).
 */
const SKIN_PARS = /* glsl */ `
uniform highp sampler2D uCrowdBones;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aAnim;
mat4 gyeCrowdJoint(float joint, float row) {
  int x = int(joint + 0.5) * ${ROWS_PER_JOINT};
  int y = int(row + 0.5);
  vec4 a = texelFetch(uCrowdBones, ivec2(x, y), 0);
  vec4 b = texelFetch(uCrowdBones, ivec2(x + 1, y), 0);
  vec4 c = texelFetch(uCrowdBones, ivec2(x + 2, y), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 gyeCrowdPose(float row) {
  return skinWeight.x * gyeCrowdJoint(skinIndex.x, row) + skinWeight.y * gyeCrowdJoint(skinIndex.y, row)
    + skinWeight.z * gyeCrowdJoint(skinIndex.z, row) + skinWeight.w * gyeCrowdJoint(skinIndex.w, row);
}
mat4 gyeCrowdSkin() {
  mat4 skin = gyeCrowdPose(aAnim.x);
  if (aAnim.z > 0.0) skin = skin * (1.0 - aAnim.z) + gyeCrowdPose(aAnim.y) * aAnim.z;
  return skin;
}`;

/**
 * Ropa sobre la pose de reposo (T): parte de arriba (hasta las mangas, con cuello redondo),
 * pantalón (largo o corto), zapatos (zapatillas o sandalias) y su suela. Devuelve la prenda
 * (0 arriba, 1 pantalón, 2 zapatos, 3 suela; -1 piel) y la distancia a su borde (dobladillo).
 * Los cortes fijos del cuerpo vienen en uCrowdCut (suela, cintura del pantalón, abajo y arriba
 * de la camiseta) y uCrowdCollar; los de cada persona, como argumentos.
 */
const CLOTH_GLSL = /* glsl */ `
uniform vec4 uCrowdCut;
uniform vec2 uCrowdCollar;
int gyeCrowdPiece(vec3 r, float sleeves, float legs, float shoes, out float edge) {
  float ax = abs(r.x);
  float collar = sqrt(max(0.0, 1.0 - (ax * ax) / (uCrowdCollar.x * uCrowdCollar.x)));
  float neck = uCrowdCut.w - uCrowdCollar.y * collar;
  if (r.y >= uCrowdCut.z && r.y <= neck && ax <= sleeves) {
    edge = min(min(r.y - uCrowdCut.z, neck - r.y), sleeves - ax);
    return 0;
  }
  if (r.y >= legs && r.y <= uCrowdCut.y) {
    edge = min(r.y - legs, uCrowdCut.y - r.y);
    return 1;
  }
  if (r.y < uCrowdCut.x) {
    edge = 1.0;
    return 3;
  }
  if (r.y <= shoes) {
    edge = shoes - r.y;
    return 2;
  }
  edge = 0.0;
  return -1;
}`;

const NOISE_GLSL = /* glsl */ `
float gyeCrowdNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 k = vec2(0.0, 1.0);
  #define GYE_H(o) fract(sin(dot(i + o, vec3(127.1, 311.7, 74.7))) * 43758.5453)
  float a = mix(mix(GYE_H(k.xxx), GYE_H(k.yxx), f.x), mix(GYE_H(k.xyx), GYE_H(k.yyx), f.x), f.y);
  float b = mix(mix(GYE_H(k.xxy), GYE_H(k.yxy), f.x), mix(GYE_H(k.xyy), GYE_H(k.yyy), f.x), f.y);
  #undef GYE_H
  return mix(a, b, f.z);
}`;

/** Copia de un atributo en floats sin normalizar (así se pueden unir piezas de tipos distintos). */
function floatAttribute(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = a.count;
  const size = a.itemSize;
  const out = new Float32Array(n * size);
  const get = [a.getX, a.getY, a.getZ, a.getW];
  for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = get[c].call(a, i);
  return new THREE.BufferAttribute(out, size);
}

/** Una malla del modelo como pieza de un peatón: sus atributos de piel en el espacio del modelo. */
function piece(mesh: THREE.SkinnedMesh, part: number): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
    const a = src.getAttribute(name);
    if (!a) throw new Error(`La malla ${mesh.name} de los peatones no tiene "${name}"`);
    g.setAttribute(name, floatAttribute(a));
  }
  if (src.index) g.setIndex(src.index.clone());
  // Las posiciones de reposo, en el espacio en que se hornearon los huesos.
  g.applyMatrix4(mesh.bindMatrix);
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(part), 1));
  return g;
}

/**
 * Hornea los clips en una textura de floats: por cuadro, una fila con la matriz de cada hueso
 * ya lista para el shader (hueso · inversa de enlace, llevada al espacio del modelo). Para los
 * clips de caminar mide además su velocidad de zancada: la del pie apoyado (el más bajo), que
 * se mueve hacia atrás respecto del cuerpo justo a la velocidad a la que hay que avanzar para
 * que no patine; y de ahí sale hacia dónde mira el modelo.
 */
function bake(
  root: THREE.Object3D,
  body: THREE.SkinnedMesh,
  animations: THREE.AnimationClip[],
  wanted: { clip: string; walk: boolean }[],
  anim: PedestriansConfig['animation'],
): { texture: THREE.DataTexture; clips: Map<string, BakedClip>; forward: THREE.Vector2 } {
  const skeleton = body.skeleton;
  const joints = skeleton.bones.length;
  const width = joints * ROWS_PER_JOINT;
  const plans = wanted.map((w) => {
    const clip = animations.find((a) => a.name === w.clip);
    if (!clip) throw new Error(`El modelo de peatones no trae la animación "${w.clip}"`);
    return { ...w, clip, frames: Math.max(1, Math.round(clip.duration * anim.fps)) };
  });
  const rows = plans.reduce((sum, p) => sum + p.frames, 0);
  const data = new Float32Array(width * rows * 4);
  const feet = anim.feet.map((name) => {
    const bone = skeleton.getBoneByName(name);
    if (!bone) throw new Error(`El esqueleto de los peatones no tiene el hueso "${name}"`);
    return bone;
  });
  root.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().multiplyMatrices(body.matrixWorld, body.bindMatrixInverse);
  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map<string, BakedClip>();
  const forward = new THREE.Vector2();
  const m = new THREE.Matrix4();
  const foot = new THREE.Vector3();
  let row = 0;
  for (const plan of plans) {
    const action = mixer.clipAction(plan.clip);
    action.reset().play();
    const track: THREE.Vector3[][] = feet.map(() => []);
    for (let f = 0; f < plan.frames; f++) {
      mixer.setTime((f * plan.clip.duration) / plan.frames);
      root.updateMatrixWorld(true);
      skeleton.update();
      const matrices = skeleton.boneMatrices;
      if (!matrices) throw new Error('El esqueleto de los peatones no tiene matrices');
      for (let j = 0; j < joints; j++) {
        m.fromArray(matrices, j * 16).premultiply(toModel);
        const e = m.elements;
        const o = ((row + f) * width + j * ROWS_PER_JOINT) * 4;
        for (let r = 0; r < ROWS_PER_JOINT; r++) {
          data[o + r * 4] = e[r];
          data[o + r * 4 + 1] = e[4 + r];
          data[o + r * 4 + 2] = e[8 + r];
          data[o + r * 4 + 3] = e[12 + r];
        }
      }
      feet.forEach((bone, k) => track[k].push(foot.setFromMatrixPosition(bone.matrixWorld).clone()));
    }
    action.stop();
    let stride = 0;
    if (plan.walk) {
      // Velocidad del pie apoyado en cada cuadro (el más bajo de los dos, si sigue siéndolo en el siguiente).
      const dt = plan.clip.duration / plan.frames;
      const speeds: number[] = [];
      const sum = new THREE.Vector2();
      for (let f = 0; f < plan.frames; f++) {
        const next = (f + 1) % plan.frames;
        let low = 0;
        for (let k = 1; k < track.length; k++) if (track[k][f].y < track[low][f].y) low = k;
        if (track.some((t, k) => k !== low && t[next].y < track[low][next].y)) continue;
        const vx = (track[low][next].x - track[low][f].x) / dt;
        const vz = (track[low][next].z - track[low][f].z) / dt;
        sum.x -= vx;
        sum.y -= vz;
        speeds.push(Math.hypot(vx, vz));
      }
      speeds.sort((a, b) => a - b);
      stride = speeds.length ? speeds[speeds.length >> 1] : 0;
      if (sum.lengthSq() > 0) forward.add(sum.normalize());
    }
    clips.set(plan.clip.name, { start: row, frames: plan.frames, duration: plan.clip.duration, stride });
    row += plan.frames;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  if (forward.lengthSq() === 0) throw new Error('No se pudo medir hacia dónde caminan los peatones (¿faltan clips de caminar?)');
  forward.normalize();

  const texture = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, clips, forward };
}

/** Uniformes que comparten el material y su versión para sombras. */
interface CrowdUniforms {
  uCrowdBones: { value: THREE.DataTexture };
  uCrowdCut: { value: THREE.Vector4 };
  uCrowdCollar: { value: THREE.Vector2 };
  uCrowdInflate: { value: number };
  uCrowdCloth: { value: THREE.Vector4 };
  uCrowdRough: { value: THREE.Vector4 };
  uCrowdSole: { value: THREE.Color };
  uCrowdHair: { value: THREE.Texture | null };
  uCrowdEyes: { value: THREE.Texture | null };
}

/** Material de los peatones: esqueleto en el shader, ropa pintada, pelo teñido, piel de cada uno y luz de noche. */
function crowdMaterial(uniforms: CrowdUniforms, map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${SKIN_PARS}
${CLOTH_GLSL}
uniform float uCrowdInflate;
attribute float aPart;
attribute vec4 aTop;
attribute vec4 aBottom;
attribute vec4 aFeet;
attribute vec4 aHead;
varying vec3 vCrowdRest;
varying float vCrowdPart;
varying vec4 vCrowdTop;
varying vec4 vCrowdBottom;
varying vec4 vCrowdFeet;
varying vec4 vCrowdHead;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `mat4 gyeSkin = gyeCrowdSkin();
vec3 objectNormal = mat3(gyeSkin) * normal;
vCrowdRest = position;
vCrowdPart = aPart;
vCrowdTop = aTop;
vCrowdBottom = aBottom;
vCrowdFeet = aFeet;
vCrowdHead = aHead;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `vec3 transformed = position;
// La tela se separa un poco del cuerpo (holgura): no parece pintada y los bordes son dobladillos.
if (aPart < 0.5) {
  float edge;
  if (gyeCrowdPiece(position, aTop.w, aBottom.w, aFeet.w, edge) >= 0) transformed += normal * uCrowdInflate;
}
transformed = (gyeSkin * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${CLOTH_GLSL}
${NOISE_GLSL}
uniform vec4 uCrowdCloth;
uniform vec4 uCrowdRough;
uniform vec3 uCrowdSole;
uniform sampler2D uCrowdHair;
uniform sampler2D uCrowdEyes;
varying vec3 vCrowdRest;
varying float vCrowdPart;
varying vec4 vCrowdTop;
varying vec4 vCrowdBottom;
varying vec4 vCrowdFeet;
varying vec4 vCrowdHead;
float gyeCrowdRoughness = 1.0;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
if (vCrowdPart < ${PART_BODY}.5) {
  float edge;
  int cloth = gyeCrowdPiece(vCrowdRest, vCrowdTop.w, vCrowdBottom.w, vCrowdFeet.w, edge);
  if (cloth < 0) {
    diffuseColor.rgb *= vCrowdHead.w;
    gyeCrowdRoughness = uCrowdRough.x;
  } else {
    vec3 fabric = cloth == 0 ? vCrowdTop.rgb : cloth == 1 ? vCrowdBottom.rgb : cloth == 2 ? vCrowdFeet.rgb : uCrowdSole;
    float hem = mix(uCrowdCloth.y, 1.0, smoothstep(0.0, uCrowdCloth.x, edge));
    float grain = 1.0 + uCrowdCloth.z * (gyeCrowdNoise(vCrowdRest * uCrowdCloth.w) - 0.5);
    diffuseColor.rgb = fabric * hem * grain;
    gyeCrowdRoughness = uCrowdRough.y;
  }
} else if (vCrowdPart < ${PART_HAIR}.5) {
  // El pelo viene en gris: toma el color de cada persona.
  diffuseColor.rgb = vCrowdHead.rgb * texture2D(uCrowdHair, vMapUv).rgb;
  gyeCrowdRoughness = uCrowdRough.z;
} else {
  diffuseColor.rgb = texture2D(uCrowdEyes, vMapUv).rgb;
  gyeCrowdRoughness = uCrowdRough.w;
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gyeCrowdRoughness;');
  };
  material.customProgramCacheKey = () => 'gye-crowd-v1';
  withNightLight(material);
  return material;
}

/** Versión para el mapa de sombras: el mismo esqueleto animado. */
function crowdDepthMaterial(uniforms: CrowdUniforms): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCrowdBones = uniforms.uCrowdBones;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = (gyeCrowdSkin() * vec4(position, 1.0)).xyz;');
  };
  material.customProgramCacheKey = () => 'gye-crowd-depth-v1';
  return material;
}

/** Textura de la primera malla del modelo con ese nombre (la de su material). */
function textureOf(mesh: THREE.SkinnedMesh): THREE.Texture | null {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  return material.map ?? null;
}

/**
 * Carga un tipo de peatón (config/assets.json → crowd, armado por el paso `assets` con sus
 * peinados y niveles de detalle) y arma una malla instanciada por peinado y nivel de detalle,
 * con capacidad para `capacity` personas cada una.
 */
export async function loadCrowdBody(
  url: string,
  bodyCfg: CrowdBodyConfig,
  cfg: PedestriansConfig,
  capacity: number,
): Promise<CrowdBody> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const byName = new Map<string, THREE.SkinnedMesh>();
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) byName.set(o.name, o as THREE.SkinnedMesh);
  });
  const find = (name: string, lod: number): THREE.SkinnedMesh => {
    const key = lod ? `${name}_LOD${lod}` : name;
    const mesh = byName.get(key);
    if (!mesh) throw new Error(`${url} no tiene la malla "${key}" (config/game.json → pedestrians.bodies)`);
    return mesh;
  };
  const body = find(bodyCfg.body, 0);

  const a = cfg.animation;
  const wanted = [
    ...a.walk.map((c) => ({ clip: c.clip, walk: true })),
    ...[...a.idle, ...a.talk].map((c) => ({ clip: c.clip, walk: false })),
  ].filter((w, i, all) => all.findIndex((o) => o.clip === w.clip) === i);
  const baked = bake(root, body, gltf.animations, wanted, a);
  body.geometry.computeBoundingBox();
  const box = body.geometry.boundingBox!.clone().applyMatrix4(body.bindMatrix);
  const height = box.max.y - box.min.y;

  const o = bodyCfg.outfit;
  const look = cfg.look;
  const uniforms: CrowdUniforms = {
    uCrowdBones: { value: baked.texture },
    uCrowdCut: { value: new THREE.Vector4(o.sole, o.pants.top, o.top.bottom, o.top.top) },
    uCrowdCollar: { value: new THREE.Vector2(o.top.collarRadius, o.top.collarDrop) },
    uCrowdInflate: { value: look.inflate },
    uCrowdCloth: { value: new THREE.Vector4(look.hem, look.hemShade, look.grain, look.grainScale) },
    uCrowdRough: {
      value: new THREE.Vector4(look.roughness.skin, look.roughness.cloth, look.roughness.hair, look.roughness.eyes),
    },
    uCrowdSole: { value: new THREE.Color(look.sole) },
    uCrowdHair: { value: textureOf(find(bodyCfg.hair[0].node, 0)) },
    uCrowdEyes: { value: textureOf(find(bodyCfg.eyes, 0)) },
  };
  const material = crowdMaterial(uniforms, textureOf(body));
  const depth = crowdDepthMaterial(uniforms);

  const levels = cfg.lod.distances.length + 1;
  const meshes: THREE.InstancedMesh[][] = [];
  const attributes: Record<CrowdAttribute, THREE.InstancedBufferAttribute>[][] = [];
  for (const hair of bodyCfg.hair) {
    const row: THREE.InstancedMesh[] = [];
    const rowAttributes: Record<CrowdAttribute, THREE.InstancedBufferAttribute>[] = [];
    for (let lod = 0; lod < levels; lod++) {
      // De lejos sobran los ojos; más lejos, también las cejas.
      const parts = [piece(find(bodyCfg.body, lod), PART_BODY), piece(find(hair.node, lod), PART_HAIR)];
      if (lod < levels - 1) parts.push(piece(find(bodyCfg.eyebrows, lod), PART_HAIR));
      if (lod === 0) parts.push(piece(find(bodyCfg.eyes, lod), PART_EYES));
      const geometry = mergeGeometries(parts);
      if (!geometry) throw new Error(`No se pudo armar el peatón ${bodyCfg.model} con ${hair.node}`);
      for (const p of parts) p.dispose();
      const attrs = {} as Record<CrowdAttribute, THREE.InstancedBufferAttribute>;
      for (const name of CROWD_ATTRIBUTES) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attr);
        attrs[name] = attr;
      }
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = lod <= cfg.lod.shadows;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depth;
      mesh.name = `pedestrians-${bodyCfg.model}-${hair.node}-${lod}`;
      row.push(mesh);
      rowAttributes.push(attrs);
    }
    meshes.push(row);
    attributes.push(rowAttributes);
  }
  // Las mallas originales ya no se usan (sus texturas sí: las comparte el material).
  for (const mesh of byName.values()) mesh.geometry.dispose();

  return {
    cfg: bodyCfg,
    meshes,
    attributes,
    clips: baked.clips,
    height,
    yaw: Math.atan2(baked.forward.y, baked.forward.x),
  };
}
