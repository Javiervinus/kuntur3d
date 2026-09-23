import * as THREE from 'three';
import type { GameConfig } from '../core/types';

/** En qué pasada va una pieza de la cabina (`userData.cockpitPass`); sin marcar, en las dos. */
export type CockpitPass = 'world' | 'cockpit';

/**
 * Cabina en primera persona: el interior del carro (y el conductor) se dibuja en una segunda
 * pasada con su propia cámara de plano cercano muy corto, como las armas en los juegos de
 * disparos. La cámara del mundo necesita el plano cercano a 0,6 m para que la profundidad
 * alcance 14 km sin parpadeos; con ella, el tablero, el volante y las puertas (a menos de
 * medio metro de los ojos) salían recortados. Nada del mundo puede quedar entre los ojos y
 * el interior del carro, así que basta limpiar la profundidad y dibujarlo encima.
 * - Vidrios (`cockpit`): solo en esta pasada; en las dos se verían el doble de oscuros.
 * - Sombra de contacto bajo el carro (`world`): solo en la del mundo.
 * - Reusa el mapa de sombras del frame y las matrices ya calculadas: cuesta los pocos draw
 *   calls del carro.
 * - Luz de relleno solo en esta pasada: la luz que rebota dentro de la cabina (asientos,
 *   tablero, puertas). Sin ella, bajo el techo solo llega el cielo y el interior sale casi
 *   negro. Es una luz ambiente: solo un uniforme, no crea variantes de shader.
 */
export class Cockpit {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly layer: number;
  private root: THREE.Object3D | null = null;
  private readonly saved = new Map<THREE.Object3D, number>();

  constructor(cfg: GameConfig['render']['cockpit'], scene: THREE.Scene) {
    this.layer = cfg.layer;
    this.camera = new THREE.PerspectiveCamera(50, 1, cfg.near, cfg.far);
    this.camera.layers.set(cfg.layer);
    // Las luces también se filtran por capa: sin esto la cabina saldría a oscuras.
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enable(cfg.layer);
    });
    const fill = new THREE.AmbientLight(cfg.fill.color, cfg.fill.intensity);
    fill.layers.set(cfg.layer);
    scene.add(fill);
  }

  get active(): boolean {
    return this.root !== null;
  }

  /** Cabina de `root` (con todo lo que tenga adentro en este momento), o null para apagarla. */
  set(root: THREE.Object3D | null): void {
    if (root === this.root) return;
    this.restore();
    this.root = root;
    root?.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      this.saved.set(o, o.layers.mask);
      const pass = o.userData.cockpitPass as CockpitPass | undefined;
      if (pass === 'cockpit') o.layers.set(this.layer);
      else if (pass !== 'world') o.layers.enable(this.layer);
    });
  }

  private restore(): void {
    for (const [o, mask] of this.saved) o.layers.mask = mask;
    this.saved.clear();
  }

  /** Segunda pasada: llamar justo después de dibujar el mundo con `main`. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, main: THREE.PerspectiveCamera): void {
    if (!this.root) return;
    const cam = this.camera;
    cam.position.copy(main.position);
    cam.quaternion.copy(main.quaternion);
    if (cam.fov !== main.fov || cam.aspect !== main.aspect) {
      cam.fov = main.fov;
      cam.aspect = main.aspect;
      cam.updateProjectionMatrix();
    }
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.autoUpdate;
    const matrices = scene.matrixWorldAutoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    scene.matrixWorldAutoUpdate = false;
    renderer.clearDepth();
    renderer.render(scene, cam);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
    scene.matrixWorldAutoUpdate = matrices;
  }
}
