import * as THREE from 'three';
import type { GameConfig } from '../core/types';

/** Pin rojo con un haz de luz: marca el punto exacto de una búsqueda o link pegado. */
export class DestinationMarker {
  readonly group = new THREE.Group();
  private readonly pin = new THREE.Group();

  constructor(private readonly cfg: GameConfig['destinationMarker']) {
    this.group.name = 'destination';
    this.group.visible = false;

    const beam = new THREE.Mesh(
      // El haz empieza sobre la cabeza para no teñir al personaje cuando está en el punto.
      new THREE.CylinderGeometry(cfg.beamRadius, cfg.beamRadius, cfg.beamHeight, 16, 1, true).translate(
        0,
        cfg.beamStart + cfg.beamHeight / 2,
        0,
      ),
      new THREE.MeshBasicMaterial({
        color: cfg.color,
        transparent: true,
        opacity: cfg.beamOpacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.group.add(beam);

    // Pin estilo mapa: esfera sobre un cono invertido.
    const material = new THREE.MeshStandardMaterial({ color: cfg.color, roughness: 0.35, emissive: cfg.color, emissiveIntensity: 0.35 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(cfg.pinRadius, 24, 16), material);
    head.position.y = cfg.pinRadius * 2.2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(cfg.pinRadius * 0.62, cfg.pinRadius * 2.4, 20).rotateX(Math.PI), material);
    tip.position.y = cfg.pinRadius * 1.2;
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(cfg.pinRadius * 0.38, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    );
    dot.position.set(0, cfg.pinRadius * 2.2, cfg.pinRadius * 0.82);
    this.pin.add(head, tip, dot);
    this.pin.traverse((o) => (o.castShadow = true));
    this.group.add(this.pin);
  }

  show(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  get position(): THREE.Vector3 | null {
    return this.group.visible ? this.group.position : null;
  }

  update(time: number): void {
    if (!this.group.visible) return;
    this.pin.position.y = this.cfg.pinHover + Math.sin(time * this.cfg.bobSpeed) * this.cfg.bobAmplitude;
    this.pin.rotation.y = time * 0.8;
  }
}
