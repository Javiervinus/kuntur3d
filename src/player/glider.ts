import * as THREE from 'three';
import type { GameConfig } from '../core/types';
import { addNightLight } from '../render/nightLight';

/** Ala delta: nariz hacia -z, el piloto cuelga debajo del arnés. */
export function createGlider(cfg: GameConfig['glider'], pilotHeight: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'glider';
  const half = cfg.span / 2;
  const nose = -cfg.chord * 0.55;
  const tail = cfg.chord * 0.45;
  const notch = cfg.chord * 0.18;
  const lift = pilotHeight * 1.25;

  // Vela en dos paños con un leve diedro.
  const sail = new THREE.BufferGeometry();
  const dihedral = cfg.span * 0.03;
  sail.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, nose, -half, dihedral, tail, 0, 0.05, notch, 0, 0, nose, 0, 0.05, notch, half, dihedral, tail],
      3,
    ),
  );
  sail.computeVertexNormals();
  const sailMesh = new THREE.Mesh(
    sail,
    new THREE.MeshStandardMaterial({ color: cfg.color, roughness: 0.55, side: THREE.DoubleSide }),
  );
  sailMesh.castShadow = true;
  sailMesh.position.y = lift;
  group.add(sailMesh);

  // Bordes de ataque en color claro.
  const trim = new THREE.MeshStandardMaterial({ color: cfg.trimColor, roughness: 0.4 });
  const edge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): void => {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 6), trim);
    tube.position.copy(a).add(b).multiplyScalar(0.5);
    tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    tube.castShadow = true;
    group.add(tube);
  };
  edge(0, lift, nose, -half, lift + dihedral, tail, 0.06);
  edge(0, lift, nose, half, lift + dihedral, tail, 0.06);
  edge(0, lift + 0.02, nose, 0, lift + 0.05, notch, 0.05);
  // Trapecio (A-frame) hasta las manos del piloto.
  const bar = pilotHeight * 0.55;
  edge(0, lift, 0, -0.6, bar, 0.2, 0.03);
  edge(0, lift, 0, 0.6, bar, 0.2, 0.03);
  edge(-0.6, bar, 0.2, 0.6, bar, 0.2, 0.03);
  addNightLight(group);
  return group;
}
