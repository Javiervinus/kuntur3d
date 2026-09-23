import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameConfig } from '../core/types';
import { withNightLight } from '../render/nightLight';

type PalmsConfig = GameConfig['palms'];

/** Azar reproducible en [0, 1) a partir de una semilla entera y un canal. */
function rand(seed: number, channel: number): number {
  let h = (seed * 374761393 + channel * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Geometría indexada con color por vértice, a partir de listas. */
function mesh(positions: number[], colors: number[], index: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * Palmera de referencia (alto `reference` m hasta la corona): tronco que se afina y se curva un
 * poco, el capitel verde de las palmas reales, y un penacho de hojas arqueadas con sección en V
 * (anchas al medio, en punta), más claras hacia la punta. Todo con color por vértice.
 */
function palmGeometry(cfg: PalmsConfig): THREE.BufferGeometry {
  const H = cfg.reference;
  const T = cfg.trunk;
  const C = cfg.crown;
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.Color(T.color);
  const top = new THREE.Color(T.colorTop);
  const c = new THREE.Color();

  // Tronco: anillos a lo largo de una curva suave, del radio de la base al del cuello.
  const trunkTop = H - T.shaft[1];
  {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= T.segments; i++) {
      const t = i / T.segments;
      const cx = T.bend * t * t;
      const y = t * trunkTop;
      const r = T.radius[0] + (T.radius[1] - T.radius[0]) * t;
      c.copy(base).lerp(top, t);
      for (let k = 0; k <= T.sides; k++) {
        const a = (k / T.sides) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * r, y, Math.sin(a) * r);
        col.push(c.r, c.g, c.b);
      }
    }
    const row = T.sides + 1;
    for (let i = 0; i < T.segments; i++) {
      for (let k = 0; k < T.sides; k++) {
        const a = i * row + k;
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    parts.push(mesh(pos, col, idx));
  }

  // Capitel: el cuello verde liso bajo las hojas.
  const shaft = new THREE.CylinderGeometry(T.radius[1] * T.shaft[0], T.radius[1] * T.shaft[0], T.shaft[1], T.sides, 1, true);
  shaft.deleteAttribute('uv');
  shaft.translate(T.bend, trunkTop + T.shaft[1] / 2, 0);
  const shaftColor = new THREE.Color(T.shaftColor);
  shaft.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(Array.from({ length: shaft.getAttribute('position').count }, () => [shaftColor.r, shaftColor.g, shaftColor.b]).flat(), 3),
  );
  parts.push(shaft);

  // Hojas: arcos que suben y caen, con sección en V; unas más altas y otras más caídas.
  const leaf = new THREE.Color(C.color);
  const tip = new THREE.Color(C.tip);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let f = 0; f < C.fronds; f++) {
    const a = ((f + rand(f, 1) * C.jitter) / C.fronds) * Math.PI * 2;
    const L = C.length[0] + (C.length[1] - C.length[0]) * rand(f, 2);
    const rise = C.rise * (f % 2 === 0 ? 1 : C.lower);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const first = pos.length / 3;
    for (let j = 0; j <= C.segments; j++) {
      const t = j / C.segments;
      const s = L * t;
      const px = T.bend + dx * s;
      const py = H + rise * s - (C.droop * s * s) / L;
      const pz = dz * s;
      const w = C.width * 4 * t * (1 - t);
      c.copy(leaf).lerp(tip, t);
      // Centro y los dos bordes, caídos hacia abajo (la V).
      pos.push(px, py, pz);
      pos.push(px - dz * w, py - C.fold * w, pz + dx * w);
      pos.push(px + dz * w, py - C.fold * w, pz - dx * w);
      for (let v = 0; v < 3; v++) col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < C.segments; j++) {
      const a0 = first + j * 3;
      const a1 = a0 + 3;
      idx.push(a0, a0 + 1, a1, a1, a0 + 1, a1 + 1);
      idx.push(a0, a1, a0 + 2, a1, a1 + 2, a0 + 2);
    }
  }
  parts.push(mesh(pos, col, idx));

  for (const p of parts) {
    if (!p.getAttribute('normal')) p.computeVertexNormals();
  }
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('No se pudo armar la palmera');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Palmeras de los malecones (el pipeline las pone en hilera junto a la baranda de los muelles):
 * mallas instanciadas por celda (se descartan fuera de cámara y más allá de `drawDistance`),
 * cada palmera con su alto, giro e inclinación; las hojas se mecen con la brisa del río (en el
 * shader, más cuanto más arriba) y de noche las alumbran los postes.
 */
export class Palms {
  readonly group = new THREE.Group();
  private readonly cells: { mesh: THREE.InstancedMesh; x: number; z: number }[] = [];
  private readonly time = { value: 0 };

  /** `list`: x, z, y (pie), alto y semilla de cada palmera. */
  constructor(
    list: number[][],
    private readonly cfg: PalmsConfig,
  ) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: cfg.roughness,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    const uniforms = {
      uTime: this.time,
      uSway: { value: new THREE.Vector3(cfg.sway.amplitude, cfg.sway.speed, cfg.reference) },
    };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uSway;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  // Se mece más cuanto más arriba (la base queda quieta); cada palmera con su propio ritmo.
  float gyeUp = clamp( position.y / uSway.z, 0.0, 1.2 );
  float gyePhase = 0.0;
  #ifdef USE_INSTANCING
    gyePhase = dot( instanceMatrix[ 3 ].xz, vec2( 0.37, 0.23 ) );
  #endif
  float gyeSway = uSway.x * gyeUp * gyeUp;
  transformed.x += gyeSway * sin( uTime * uSway.y + gyePhase );
  transformed.z += gyeSway * 0.6 * sin( uTime * uSway.y * 1.3 + gyePhase * 1.7 );
}`,
        );
    };
    material.customProgramCacheKey = () => 'gye-palm-v1';
    withNightLight(material);

    const geometry = palmGeometry(cfg);
    this.group.name = 'palms';
    const byCell = new Map<string, number[][]>();
    for (const palm of list) {
      const key = `${Math.floor(palm[0] / cfg.cell)},${Math.floor(palm[1] / cfg.cell)}`;
      const cell = byCell.get(key);
      if (cell) cell.push(palm);
      else byCell.set(key, [palm]);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const lean = THREE.MathUtils.degToRad(cfg.trunk.leanDeg);
    for (const palms of byCell.values()) {
      const mesh = new THREE.InstancedMesh(geometry, material, palms.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      let cx = 0;
      let cz = 0;
      palms.forEach(([x, z, y, height, seed], k) => {
        const scale = height / cfg.reference;
        e.set((rand(seed, 3) - 0.5) * 2 * lean, rand(seed, 4) * Math.PI * 2, (rand(seed, 5) - 0.5) * 2 * lean);
        m.compose(p.set(x, y, z), q.setFromEuler(e), s.set(scale, scale, scale));
        mesh.setMatrixAt(k, m);
        cx += x / palms.length;
        cz += z / palms.length;
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.cells.push({ mesh, x: cx, z: cz });
    }
  }

  /** Brisa, y solo las celdas a menos de `drawDistance` de la cámara (más lejos no se distinguen). */
  update(dt: number, camera: THREE.Camera): void {
    this.time.value += dt;
    const far = this.cfg.drawDistance + this.cfg.cell;
    for (const c of this.cells) c.mesh.visible = Math.hypot(camera.position.x - c.x, camera.position.z - c.z) <= far;
  }
}
