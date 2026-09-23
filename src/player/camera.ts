import * as THREE from 'three';
import type { Controls } from '../core/controls';
import type { GameConfig } from '../core/types';

/** Lo que sigue la cámara: el personaje a pie, planeando o el carro. */
export interface CameraSubject {
  position: THREE.Vector3;
  /** Altura sobre `position` del punto que mira la cámara en tercera persona. */
  targetHeight: number;
  /** Ojos en primera persona (coordenadas del mundo). */
  eye: THREE.Vector3;
  /** Distancia mínima en tercera persona (el ala delta y el carro necesitan más). */
  minDistance: number;
  /** Rumbo detrás del cual se acomoda sola la cámara con el mouse quieto (null = libre). */
  alignHeading: number | null;
  alignRate: number;
  /** Adelanto (m, en el mundo) que se suma al punto que sigue la cámara: compensa el retraso a alta velocidad. */
  lead: THREE.Vector3;
  /**
   * Cabina (manejando): en primera persona la vista va pegada a esta orientación y el mouse
   * mira alrededor dentro de ella; null = primera persona libre (a pie).
   */
  cabin: { orientation: THREE.Quaternion; restPitch: number; maxLook: number } | null;
}

/** Cámara en tercera persona (órbita con el mouse) o primera persona. */
export class FollowCamera {
  yaw = 0;
  pitch: number;
  distance: number;
  firstPerson = false;
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private initialized = false;
  /** Largo actual del brazo de la cámara (se acorta si un edificio tapa y vuelve a estirarse suave). */
  private arm = 0;
  /** Mirada dentro de la cabina, relativa al carro (rad). */
  private lookYaw = 0;
  private lookPitch = 0;
  private inCabin = false;
  private readonly look = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly lookQ = new THREE.Quaternion();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly cfg: GameConfig['camera'],
    private readonly groundAt: (x: number, z: number) => number,
    /** Altura del edificio en (x, z) o -Infinity: para que la cámara no quede dentro de uno. */
    private readonly wallTop: (x: number, z: number) => number,
  ) {
    this.pitch = THREE.MathUtils.degToRad(cfg.defaultPitchDeg);
    this.distance = cfg.distance;
  }

  snap(): void {
    this.initialized = false;
  }

  update(dt: number, controls: Controls, subject: CameraSubject): void {
    const c = this.cfg;
    const input = controls.input;
    if (controls.consume('camera')) this.firstPerson = !this.firstPerson;
    const minPitch = THREE.MathUtils.degToRad(c.minPitchDeg);
    const maxPitch = THREE.MathUtils.degToRad(c.maxPitchDeg);
    const idle = (performance.now() - input.lastLookAt) / 1000 > c.autoAlignDelay;
    if (this.firstPerson && subject.cabin) {
      this.updateCabin(dt, controls, subject, subject.cabin, idle, minPitch, maxPitch);
      return;
    }
    this.inCabin = false;
    this.yaw -= input.lookDx * c.mouseSensitivity;
    this.pitch -= input.lookDy * c.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, minPitch, maxPitch);

    const zoomKeys = (controls.isDown('zoomOut') ? dt * 4 : 0) - (controls.isDown('zoomIn') ? dt * 4 : 0);
    const zoom = input.wheel + zoomKeys;
    if (zoom !== 0) {
      this.distance = THREE.MathUtils.clamp(this.distance * Math.pow(c.zoomStep, zoom), c.minDistance, c.maxDistance);
    }

    // Planeando o manejando, la cámara se pone detrás sola si el mouse está quieto.
    if (subject.alignHeading !== null && idle) {
      const delta = Math.atan2(Math.sin(subject.alignHeading - this.yaw), Math.cos(subject.alignHeading - this.yaw));
      this.yaw += delta * Math.min(1, subject.alignRate * dt);
    }

    const cp = Math.cos(this.pitch);
    const dir = this.dir.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    if (this.firstPerson) {
      this.camera.position.copy(subject.eye);
      this.camera.lookAt(this.desired.copy(subject.eye).add(dir));
      this.initialized = false;
      return;
    }

    const p = subject.position;
    this.desired.set(p.x, p.y + subject.targetHeight, p.z).add(subject.lead);
    const dist = Math.max(this.distance, subject.minDistance);
    if (!this.initialized) {
      this.target.copy(this.desired);
      this.arm = dist;
      this.initialized = true;
    } else {
      this.target.lerp(this.desired, Math.min(1, c.followLerp * dt));
    }
    // Brazo de cámara: se acorta de golpe ante un muro y se vuelve a estirar suave.
    const free = this.freeDistance(dir, dist);
    this.arm = free < this.arm ? free : this.arm + (free - this.arm) * Math.min(1, c.armReturnRate * dt);
    this.camera.position.copy(this.target).addScaledVector(dir, -this.arm);
    const floor = this.groundAt(this.camera.position.x, this.camera.position.z) + c.groundClearance;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.camera.lookAt(this.target);
  }

  /**
   * Primera persona en la cabina: la vista gira con el carro (y sigue sus pendientes); el
   * mouse mira alrededor y, quieto un rato, la mirada vuelve al frente. Al entrar se conserva
   * hacia dónde mirabas, y `yaw`/`pitch` quedan al día para volver a tercera persona sin salto.
   */
  private updateCabin(
    dt: number,
    controls: Controls,
    subject: CameraSubject,
    cabin: NonNullable<CameraSubject['cabin']>,
    idle: boolean,
    minPitch: number,
    maxPitch: number,
  ): void {
    const c = this.cfg;
    const input = controls.input;
    const heading = subject.alignHeading ?? this.yaw;
    if (!this.inCabin) {
      this.lookYaw = Math.atan2(Math.sin(this.yaw - heading), Math.cos(this.yaw - heading));
      this.lookPitch = this.pitch;
      this.inCabin = true;
    }
    this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - input.lookDx * c.mouseSensitivity, -cabin.maxLook, cabin.maxLook);
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - input.lookDy * c.mouseSensitivity, minPitch, maxPitch);
    if (idle) {
      const k = Math.min(1, subject.alignRate * dt);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch += (cabin.restPitch - this.lookPitch) * k;
    }
    this.camera.position.copy(subject.eye);
    this.lookQ.setFromEuler(this.look.set(this.lookPitch, this.lookYaw, 0));
    this.camera.quaternion.copy(cabin.orientation).multiply(this.lookQ);
    this.yaw = heading + this.lookYaw;
    this.pitch = this.lookPitch;
    this.initialized = false;
  }

  /** Distancia hasta el primer edificio entre el punto seguido y la cámara (o `dist` si no hay). */
  private freeDistance(dir: THREE.Vector3, dist: number): number {
    const c = this.cfg;
    const t = this.target;
    const steps = Math.min(Math.ceil(dist / c.armProbeStep), c.armMaxProbes);
    for (let k = 1; k <= steps; k++) {
      const d = (dist * k) / steps;
      const x = t.x - dir.x * d;
      const y = t.y - dir.y * d;
      const z = t.z - dir.z * d;
      if (this.wallTop(x, z) > y) return Math.max(c.minDistance * c.armMinShare, d - c.armMargin);
    }
    return dist;
  }
}
