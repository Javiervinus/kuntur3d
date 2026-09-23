import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig, WorldManifest } from '../core/types';
import type { CityShadow } from '../render/cityShadow';
import { withNightLight } from '../render/nightLight';

type TreesConfig = GameConfig['trees'];

interface TreeChunk {
  canopy: THREE.InstancedMesh;
  trunks: THREE.InstancedMesh;
  /** Centro de cada copa (x, z), para elegir las que se dibujan con detalle. */
  xz: Float32Array;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Copa de radio 1: una esfera (icosaedro con `detail` subdivisiones) de perfil más lleno que una
 * elipse (superelipse de exponente `fullness`: la copa aplastada no termina en un borde fino),
 * con bultos, las masas de hojas (`lumps`, repartidos por la esfera, de ancho entre
 * `widthDeg`), y la base más plana (`bottom`). Entre bultos se hunde hasta 1 − `depth`. Normales
 * suaves y, por vértice, aHollow: cuánto queda en un pliegue entre bultos (0 en la cima de uno,
 * 1 en el fondo), para oscurecerlo.
 */
function canopyGeometry(detail: number, shape: TreesConfig['canopyShape']): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, detail);
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const geometry = mergeVertices(base);
  base.dispose();
  // Bultos: direcciones de una espiral de Fibonacci con un poco de azar (estable por la semilla).
  let seed = shape.seed;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const lumps = Array.from({ length: shape.lumps }, (_, k) => {
    const y = 1 - (2 * (k + 0.5)) / shape.lumps;
    const ring = Math.sqrt(1 - y * y);
    const turn = golden * k + (random() - 0.5) * 0.6;
    const dir = new THREE.Vector3(Math.cos(turn) * ring, y, Math.sin(turn) * ring).normalize();
    const width = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(shape.widthDeg[0], shape.widthDeg[1], random()));
    return { dir, cos: Math.cos(width) };
  });
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const hollow = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let top = 0;
    for (const lump of lumps) top = Math.max(top, smoothstep(lump.cos, 1, v.dot(lump.dir)));
    hollow[i] = 1 - top;
    const across = Math.hypot(v.x, v.z);
    const full = Math.pow(Math.pow(across, shape.fullness) + Math.pow(Math.abs(v.y), shape.fullness), -1 / shape.fullness);
    v.multiplyScalar(full * (1 - shape.depth * (1 - top)));
    if (v.y < 0) v.y *= shape.bottom;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.setAttribute('aHollow', new THREE.BufferAttribute(hollow, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Corte cerca/lejos de una malla de árboles (en el vértice, después de `begin_vertex`): con
 * uTreeCut = (x, z de la cámara, radio, lado), lado 1 dibuja solo los árboles fuera del radio y
 * −1 los de adentro; los demás se reducen a un punto (no se dibujan).
 */
const TREE_CUT = /* glsl */ `
if ( ( distance( ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz, uTreeCut.xy ) - uTreeCut.z ) * uTreeCut.w < 0.0 ) {
  transformed = vec3( 0.0 );
}`;

/**
 * Tronco en unidades de su radio (a lo ancho) y del alto hasta el centro de la copa (a lo alto),
 * como lo escala cada instancia: un cilindro de radio 1 en la base que se afina a `trunkTaper`.
 * Cerca (`branched`), con más lados y abierto en `branches.count` ramas que salen a `fork` del
 * alto y llegan a `reach` radios del eje a la altura del centro de la copa.
 */
function trunkGeometry(cfg: TreesConfig, branched: boolean): THREE.BufferGeometry {
  const bc = cfg.branches;
  if (!branched) {
    const plain = new THREE.CylinderGeometry(cfg.trunkTaper, 1, 1, 5, 1, true);
    plain.translate(0, 0.5, 0);
    return plain;
  }
  const forkRadius = THREE.MathUtils.lerp(1, cfg.trunkTaper, bc.fork);
  const stem = new THREE.CylinderGeometry(forkRadius, 1, bc.fork, bc.trunkSides, 1, true);
  stem.translate(0, bc.fork / 2, 0);
  const parts: THREE.BufferGeometry[] = [stem];
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < bc.count; k++) {
    const angle = (k / bc.count) * Math.PI * 2;
    const from = new THREE.Vector3(0, bc.fork, 0);
    const dir = new THREE.Vector3(Math.cos(angle) * bc.reach, 1, Math.sin(angle) * bc.reach).sub(from);
    const length = dir.length();
    const branch = new THREE.CylinderGeometry(bc.tipRadius, bc.radius, length, bc.sides, 1, true);
    branch.translate(0, length / 2, 0);
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
    branch.translate(from.x, from.y, from.z);
    parts.push(branch);
  }
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('No se pudo armar el tronco con ramas (config/game.json → trees.branches)');
  return merged;
}

/** Material de los troncos, con el corte cerca/lejos (ver TREE_CUT). */
function trunkMaterial(cfg: TreesConfig, cut: THREE.Vector4): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: cfg.trunkColor, roughness: 1 });
  const uniforms = { uTreeCut: { value: cut } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uTreeCut;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${TREE_CUT}`);
  };
  material.customProgramCacheKey = () => 'gye-trunk-v1';
  withNightLight(material);
  return material;
}

const luminance = (c: THREE.Color): number => Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-4);

/**
 * Color de la copa: el tono de la foto satelital mezclado con un verde de hoja, con el brillo
 * de una hoja. En la foto los árboles salen casi negros (sombra dentro de la copa) y a veces
 * con el color del techo o la calle de al lado: con la luz del sol quedarían negros o grises.
 * Se lleva su brillo a `albedo`, conservando parte de la diferencia entre árboles.
 */
function leafColor(photo: THREE.Color, green: THREE.Color, cfg: GameConfig['trees']['canopyColor']): THREE.Color {
  const lum = luminance(photo);
  const target = cfg.albedo * Math.pow(lum / cfg.reference, cfg.variation);
  // Tono (color con luminancia 1): el de la foto, llevado hacia el verde de la paleta.
  photo.multiplyScalar(1 / lum).lerp(_hue.copy(green).multiplyScalar(1 / luminance(green)), cfg.greenMix);
  photo.multiplyScalar(target / luminance(photo));
  // Más saturado alrededor de su propio gris (la foto lo lava con la bruma).
  return photo.setRGB(
    Math.max(target + (photo.r - target) * cfg.saturation, 0),
    Math.max(target + (photo.g - target) * cfg.saturation, 0),
    Math.max(target + (photo.b - target) * cfg.saturation, 0),
  );
}
const _hue = new THREE.Color();

/** Lado de la textura de ruido de las hojas (valores al azar que se repiten cada tantas celdas). */
const LEAF_NOISE_SIZE = 32;
let leafNoiseTexture: THREE.Data3DTexture | null = null;

/** Textura 3D de ruido de valor para las hojas (una para todas las copas), filtrada y repetida. */
function leafNoise(): THREE.Data3DTexture {
  if (leafNoiseTexture) return leafNoiseTexture;
  const n = LEAF_NOISE_SIZE;
  const data = new Uint8Array(n * n * n);
  let seed = 1;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = Math.floor((seed / 2147483647) * 256);
  }
  const texture = new THREE.Data3DTexture(data, n, n, n);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  leafNoiseTexture = texture;
  return texture;
}

/**
 * Material de las copas (una malla instanciada con aHollow, ver canopyGeometry):
 *
 * - Luz que atraviesa las hojas: la cara de la copa que no mira al sol (o al cielo) recibe
 *   parte de esa luz desde el otro lado, teñida por el color de la hoja. Sin esto, vista desde
 *   la calle (desde abajo) la copa es una sombra negra.
 * - Hojas: racimos y grano fino (ruido 3D en metros del mundo) que varían el color y, con su
 *   relieve, la normal; los pliegues entre bultos y la base de la copa, más oscuros. De lejos se
 *   funden (sin centelleo).
 * - Corte cerca/lejos: `cut` = (x, z de la cámara, radio, lado). Con lado 1 la malla solo dibuja
 *   los árboles fuera del radio; con −1, los de adentro (así cada árbol sale una sola vez: con
 *   la copa detallada cerca y la simple lejos, ver Trees.draw).
 */
function canopyMaterial(cfg: TreesConfig, cut: THREE.Vector4): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: cfg.roughness });
  const lc = cfg.leaves;
  const uniforms = {
    uLeafTransmission: { value: new THREE.Vector2(cfg.canopyTransmission.sun, cfg.canopyTransmission.sky) },
    uLeaves: { value: new THREE.Vector4(lc.cluster, lc.fine, lc.hollowShade, lc.variation) },
    uLeaves2: { value: new THREE.Vector3(lc.bump, lc.fade[0], lc.fade[1]) },
    uLeafUnder: { value: lc.underShade },
    uLeafNoise: { value: leafNoise() },
    uTreeCut: { value: cut },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aHollow;
uniform vec4 uTreeCut;
varying float vHollow;
varying float vCanopyY;
varying vec3 vLeafWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vHollow = aHollow;
vCanopyY = position.y;${TREE_CUT}
vLeafWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec2 uLeafTransmission;
// Racimo y grano fino (m), sombra de los pliegues, variación del color; relieve (m) y
// distancias entre las que las hojas se funden.
uniform vec4 uLeaves;
uniform vec3 uLeaves2;
// Cuánta luz le queda a la base de la copa (la tapan sus propias hojas).
uniform float uLeafUnder;
varying float vHollow;
varying float vCanopyY;
varying vec3 vLeafWorld;
float gyeLeafHeight = 0.5;
// Ruido de valor 3D: una textura de ${LEAF_NOISE_SIZE}³ valores al azar que se repite; el filtrado
// del hardware interpola entre ellos (una lectura por octava en vez de ocho hashes). La posición
// dentro de la celda pasa por smoothstep: con la interpolación lineal sola, el relieve de las
// hojas (que usa la pendiente del ruido) marca la grilla.
uniform highp sampler3D uLeafNoise;
float gyeLeafNoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return texture( uLeafNoise, ( i + f + 0.5 ) / ${LEAF_NOISE_SIZE}.0 ).r;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float leafNear = 1.0 - smoothstep( uLeaves2.y, uLeaves2.z, length( vViewPosition ) );
  // De lejos, las hojas ya se fundieron: ni se leen.
  if ( leafNear > 0.0 ) {
    float clusters = gyeLeafNoise( vLeafWorld / uLeaves.x );
    float grain = gyeLeafNoise( vLeafWorld / uLeaves.y + 17.0 );
    gyeLeafHeight = mix( 0.5, 0.65 * clusters + 0.35 * grain, leafNear );
  }
  diffuseColor.rgb *= ( 1.0 - uLeaves.z * vHollow ) * ( 1.0 + ( gyeLeafHeight - 0.5 ) * 2.0 * uLeaves.w );
  diffuseColor.rgb *= mix( uLeafUnder, 1.0, smoothstep( -0.6, 0.55, vCanopyY ) );
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // Relieve de las hojas: la normal se inclina según cambia su altura en pantalla.
  vec3 sx = dFdx( -vViewPosition );
  vec3 sy = dFdy( -vViewPosition );
  vec3 r1 = cross( sy, normal );
  vec3 r2 = cross( normal, sx );
  float det = dot( sx, r1 );
  vec2 dh = vec2( dFdx( gyeLeafHeight ), dFdy( gyeLeafHeight ) ) * uLeaves2.x;
  vec3 grad = sign( det ) * ( dh.x * r1 + dh.y * r2 );
  normal = normalize( abs( det ) * normal - grad );
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  vec3 leaf = BRDF_Lambert( material.diffuseContribution );
  #if NUM_SUN_LIGHTS > 0
    float through = max( -dot( geometryNormal, sunLights[ 0 ].direction ), 0.0 );
    reflectedLight.directDiffuse += sunLights[ 0 ].color * ( through * uLeafTransmission.x ) * leaf;
  #endif
  #ifdef USE_ENVMAP
    reflectedLight.indirectDiffuse += getIBLIrradiance( -geometryNormal ) * uLeafTransmission.y * leaf;
  #endif
}`,
      );
  };
  material.customProgramCacheKey = () => 'gye-leaf-v3';
  withNightLight(material);
  return material;
}

/**
 * Árboles instanciados por chunk, cargados solo cerca de la cámara. Posición, alto y radio de
 * copa salen del mapa de altura de copas y el color, de la foto satelital (paso `trees` del
 * pipeline: x, y, z, alto, radio, r, g, b por árbol). La copa es una masa de hojas con bultos
 * (canopyGeometry): lejos, con pocas caras (la de cada chunk); a menos de `near.radius` m de la
 * cámara, con más, en una sola malla que se rearma al moverse (ver draw).
 */
export class Trees {
  readonly group = new THREE.Group();
  private readonly counts = new Map<number, number>();
  private readonly loaded = new Map<number, TreeChunk>();
  private readonly loading = new Set<number>();
  private readonly canopyGeo: THREE.BufferGeometry;
  private readonly trunkGeo: THREE.BufferGeometry;
  private readonly canopyMat: THREE.MeshStandardMaterial;
  private readonly trunkMat: THREE.MeshStandardMaterial;
  /** Copas cercanas (detalladas) y los cortes: las de los chunks, fuera del radio; esta, adentro. */
  private readonly near: THREE.InstancedMesh;
  private readonly nearTrunks: THREE.InstancedMesh;
  private readonly cutFar = new THREE.Vector4(0, 0, 0, 1);
  private readonly cutNear = new THREE.Vector4(0, 0, 0, -1);
  private readonly nearCenter = new THREE.Vector2(Infinity, Infinity);
  private nearRadius = 0;
  private nearDirty = true;
  private nearFound = new Float32Array(0);

  constructor(
    private readonly baseUrl: string,
    private readonly manifest: WorldManifest,
    private readonly cfg: GameConfig['trees'],
    private readonly stream: GameConfig['streaming'],
    private readonly shadow: CityShadow,
    /** ¿Hay algo construido (un tablero de puente, una rampa) entre el suelo y `top` en (x, z)? */
    private readonly occupied: ((x: number, z: number, top: number) => boolean) | null = null,
  ) {
    this.group.name = 'trees';
    for (const [i, j, count] of manifest.trees?.chunks ?? []) this.counts.set(j * manifest.chunks.nx + i, count);
    // Copa = masa de radio 1 y tronco = cilindro unitario desde el suelo; cada instancia los escala por separado.
    this.canopyGeo = canopyGeometry(cfg.canopyDetail, cfg.canopyShape);
    this.trunkGeo = trunkGeometry(cfg, false);
    this.canopyMat = canopyMaterial(cfg, this.cutFar);
    this.trunkMat = trunkMaterial(cfg, this.cutFar);

    // Los cercanos no dan sombra: la dan los de los chunks (el mismo árbol, con menos caras).
    const capacity = cfg.near.capacity;
    const nearMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = name;
      this.group.add(mesh);
      return mesh;
    };
    this.near = nearMesh(canopyGeometry(cfg.near.detail, cfg.canopyShape), canopyMaterial(cfg, this.cutNear), 'trees-near');
    this.near.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.nearTrunks = nearMesh(trunkGeometry(cfg, true), trunkMaterial(cfg, this.cutNear), 'trees-near-trunks');
  }

  /**
   * Cada cuadro: el radio de las copas detalladas sigue a la cámara (las de los chunks se
   * apagan adentro y la cercana afuera, en el shader); cuáles hay adentro se rearma al moverse
   * `near.refresh` m o al cargar o soltar un chunk. Si no caben todas (`near.capacity`), el
   * radio se achica hasta la última que cupo.
   */
  draw(camera: THREE.Camera): void {
    const nc = this.cfg.near;
    const x = camera.position.x;
    const z = camera.position.z;
    if (this.nearDirty || Math.hypot(x - this.nearCenter.x, z - this.nearCenter.y) > nc.refresh) this.gatherNear(x, z);
    this.cutFar.set(x, z, this.nearRadius, 1);
    this.cutNear.set(x, z, this.nearRadius, -1);
  }

  private gatherNear(x: number, z: number): void {
    const nc = this.cfg.near;
    const reach = nc.radius + nc.refresh;
    const reach2 = reach * reach;
    // Candidatas: (distancia, chunk, índice), en un arreglo plano que se reutiliza.
    let found = 0;
    const chunks: TreeChunk[] = [];
    for (const [k, chunk] of this.loaded) {
      if (this.distance(k, x, z) > reach) continue;
      const c = chunks.length;
      chunks.push(chunk);
      const xz = chunk.xz;
      for (let t = 0; t < chunk.canopy.count; t++) {
        const dx = xz[t * 2] - x;
        const dz = xz[t * 2 + 1] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > reach2) continue;
        if (this.nearFound.length < (found + 1) * 3) {
          const grown = new Float32Array(Math.max(1024, this.nearFound.length * 2));
          grown.set(this.nearFound);
          this.nearFound = grown;
        }
        this.nearFound[found * 3] = Math.sqrt(d2);
        this.nearFound[found * 3 + 1] = c;
        this.nearFound[found * 3 + 2] = t;
        found++;
      }
    }
    let radius = nc.radius;
    let order: number[] | null = null;
    if (found > nc.capacity) {
      order = Array.from({ length: found }, (_, i) => i).sort((a, b) => this.nearFound[a * 3] - this.nearFound[b * 3]);
      radius = Math.min(radius, this.nearFound[order[nc.capacity - 1] * 3] - nc.refresh);
    }
    const n = Math.min(found, nc.capacity);
    const matrices = this.near.instanceMatrix.array as Float32Array;
    const trunkMatrices = this.nearTrunks.instanceMatrix.array as Float32Array;
    const colors = (this.near.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    for (let slot = 0; slot < n; slot++) {
      const f = order ? order[slot] : slot;
      const chunk = chunks[this.nearFound[f * 3 + 1]];
      const t = this.nearFound[f * 3 + 2];
      matrices.set((chunk.canopy.instanceMatrix.array as Float32Array).subarray(t * 16, t * 16 + 16), slot * 16);
      trunkMatrices.set((chunk.trunks.instanceMatrix.array as Float32Array).subarray(t * 16, t * 16 + 16), slot * 16);
      const from = chunk.canopy.instanceColor?.array as Float32Array | undefined;
      if (from) colors.set(from.subarray(t * 3, t * 3 + 3), slot * 3);
    }
    for (const mesh of [this.near, this.nearTrunks]) {
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    const colorAttr = this.near.instanceColor as THREE.InstancedBufferAttribute;
    colorAttr.clearUpdateRanges();
    colorAttr.addUpdateRange(0, n * 3);
    colorAttr.needsUpdate = true;
    this.nearRadius = Math.max(radius, 0);
    this.nearCenter.set(x, z);
    this.nearDirty = false;
  }

  private distance(k: number, x: number, z: number): number {
    const { size, nx, xmin, zmin } = this.manifest.chunks;
    const i = k % nx;
    const j = Math.floor(k / nx);
    return Math.hypot(
      Math.max(xmin + i * size - x, 0, x - (xmin + (i + 1) * size)),
      Math.max(zmin + j * size - z, 0, z - (zmin + (j + 1) * size)),
    );
  }

  update(focusX: number, focusZ: number): void {
    const info = this.manifest.trees;
    if (!info) return;
    const r = this.stream.treeRadius;
    for (const [k, chunk] of this.loaded) {
      if (this.distance(k, focusX, focusZ) > r + this.stream.treeHysteresis) {
        this.group.remove(chunk.canopy, chunk.trunks);
        chunk.canopy.dispose();
        chunk.trunks.dispose();
        this.loaded.delete(k);
        this.nearDirty = true;
      }
    }
    const wanted = [...this.counts.keys()]
      .filter((k) => !this.loaded.has(k) && !this.loading.has(k))
      .map((k) => ({ k, d: this.distance(k, focusX, focusZ) }))
      .filter((c) => c.d <= r)
      .sort((a, b) => a.d - b.d);
    for (const { k } of wanted.slice(0, this.stream.maxMeshesPerFrame * 2)) void this.load(k, focusX, focusZ);
  }

  private async load(k: number, focusX: number, focusZ: number): Promise<void> {
    const info = this.manifest.trees;
    if (!info) return;
    this.loading.add(k);
    try {
      const { nx } = this.manifest.chunks;
      const url = new URL(info.url.replace('{i}', String(k % nx)).replace('{j}', String(Math.floor(k / nx))), this.baseUrl);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Float32Array(await res.arrayBuffer());
      if (this.loaded.has(k) || this.distance(k, focusX, focusZ) > this.stream.treeRadius + this.stream.treeHysteresis) {
        return;
      }
      // De los más altos a los más bajos: de lejos solo los altos proyectan sombra. Sin los que
      // quedarían atravesando un puente o una rampa (la foto los vio al lado o debajo).
      const occupied = this.occupied;
      const order = Array.from({ length: data.length / info.stride }, (_, t) => t)
        .filter((t) => {
          if (!occupied) return true;
          const o = t * info.stride;
          const [x, y, z, h, r] = [data[o], data[o + 1], data[o + 2], data[o + 3], data[o + 4]];
          // El tronco y el borde de la copa (hacia los cuatro lados).
          const reach = r * this.cfg.clearanceShare;
          return ![
            [0, 0],
            [reach, 0],
            [-reach, 0],
            [0, reach],
            [0, -reach],
          ].some(([dx, dz]) => occupied(x + dx, z + dz, y + h));
        })
        .sort((a, b) => data[b * info.stride + 3] - data[a * info.stride + 3]);
      const count = order.length;
      const canopy = new THREE.InstancedMesh(this.canopyGeo, this.canopyMat, count);
      const trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const color = new THREE.Color();
      const tint = this.cfg.canopyColor;
      const greens = tint.greens.map((hex) => new THREE.Color(hex));
      const xz = new Float32Array(count * 2);
      let tall = 0;
      for (let t = 0; t < count; t++) {
        const o = order[t] * info.stride;
        if (data[o + 3] >= this.cfg.farShadowMinHeight) tall = t + 1;
        const [x, y, z, h, r] = [data[o], data[o + 1], data[o + 2], data[o + 3], data[o + 4]];
        xz[t * 2] = x;
        xz[t * 2 + 1] = z;
        // La copa toca la altura medida; su alto no pasa de `canopyMaxAspect` veces su radio
        // (copas tropicales anchas, no columnas) y el tronco sube hasta su centro.
        const half = Math.min(this.cfg.canopyVerticalRatio * h, this.cfg.canopyMaxAspect * r);
        const center = h - half;
        q.setFromAxisAngle(up, ((x * 12.9898 + z * 78.233) % 1) * Math.PI * 2);
        m.compose(pos.set(x, y + center, z), q, scl.set(r, half, r));
        canopy.setMatrixAt(t, m);
        const trunk = this.cfg.trunkRadius * r;
        m.compose(pos.set(x, y, z), q, scl.set(trunk, center, trunk));
        trunks.setMatrixAt(t, m);
        color.setRGB(data[o + 5], data[o + 6], data[o + 7], THREE.SRGBColorSpace);
        // Un verde de la paleta por árbol (estable: sale de su posición).
        const pick = Math.floor(((x * 0.0917 + z * 0.1531) % 1 + 1) % 1 * greens.length);
        canopy.setColorAt(t, leafColor(color, greens[pick], tint));
      }
      for (const mesh of [canopy, trunks]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.shadow.limitFar(mesh, tall);
      }
      this.group.add(canopy, trunks);
      this.loaded.set(k, { canopy, trunks, xz });
      this.nearDirty = true;
    } catch (err) {
      console.warn('[trees] chunk', k, err);
    } finally {
      this.loading.delete(k);
    }
  }
}
