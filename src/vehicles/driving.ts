import * as THREE from 'three';
import type { Controls } from '../core/controls';
import type { VehicleConfig } from '../core/types';
import type { Avatar } from '../player/avatar';
import type { PlayerController, WorldQuery } from '../player/controller';
import { nightLight } from '../render/nightLight';
import { roofTop } from '../world/buildings';
import { SURFACE } from '../world/roads';
import { Car, type DriveInput, PARKED } from './car';

/** Superficies que no son calzada (el carro prefiere aparecer fuera de ellas). */
const OFF_ROAD = new Set<string>(Object.values(SURFACE));

/** Lo que la cámara necesita para seguir al carro. */
export interface CarView {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number;
  eye: THREE.Vector3;
  /** Orientación de la cabina en el mundo (la primera persona va "pegada" a ella). */
  cabin: THREE.Quaternion;
}

/**
 * Tu carro: se crea la primera vez que lo pides, aparece a tu lado si está lejos, y te
 * subes o bajas con la misma tecla. Mientras manejas, el personaje va sentado adentro
 * (con su animación de manejo) y el jugador sigue al asiento.
 */
export class Driving {
  car: Car | null = null;
  active = false;
  /** El carro ya fue colocado en el mundo alguna vez. */
  private placed = false;
  private avatar: Avatar | null = null;
  private readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly seatWorld = new THREE.Vector3();
  private readonly eyeWorld = new THREE.Vector3();
  private readonly cabin = new THREE.Quaternion();
  private readonly sway = new THREE.Quaternion();
  private readonly level = new THREE.Quaternion();
  private readonly offsets: [number, number][];
  private readonly beamPos = new THREE.Vector3();
  private readonly beamTurn = new THREE.Quaternion();
  private readonly beamColor = new THREE.Color();

  constructor(
    private readonly cfg: VehicleConfig,
    private readonly world: WorldQuery,
    private readonly scene: THREE.Scene,
  ) {
    // Lugares a probar alrededor (derecha, izquierda, adelante, atrás y diagonales) a 1, 2 y 3 veces la distancia.
    const dirs: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, -1],
      [0, 1],
      [1, -1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ];
    this.offsets = [1, 2, 3].flatMap((k) =>
      dirs.map(([x, z]) => {
        const len = Math.hypot(x, z);
        return [(x / len) * cfg.summonDistance * k, (z / len) * cfg.summonDistance * k] as [number, number];
      }),
    );
  }

  private ensureCar(): Car {
    if (!this.car) {
      this.car = new Car(this.cfg, this.world);
      // Oculto hasta que se coloque por primera vez.
      this.car.model.group.visible = false;
      this.scene.add(this.car.model.group);
    }
    return this.car;
  }

  /**
   * Arma el carro y compila sus shaders en segundo plano (compilación paralela del navegador),
   * para que la primera vez que lo llames no se trabe la imagen.
   */
  async prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera): Promise<THREE.Object3D> {
    const car = this.ensureCar();
    await renderer.compileAsync(car.model.group, camera, this.scene);
    return car.model.group;
  }

  /**
   * Lugar libre cerca de (x, z) para el carro mirando a `yaw`; mejor si cae sobre la calzada.
   * `y`: altura de referencia para elegir el tablero de un puente (ver `Car.fits`).
   */
  private findSpot(car: Car, x: number, z: number, yaw: number, y: number): { x: number; z: number } | null {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let fallback: { x: number; z: number } | null = null;
    for (const [ox, oz] of this.offsets) {
      // Desplazamiento local (x derecha, z atrás) → mundo, según hacia dónde mira la cámara.
      const px = x + ox * c + oz * s;
      const pz = z - ox * s + oz * c;
      if (!car.fits(px, pz, yaw, y)) continue;
      const surface = this.world.surfaceAt(px, pz);
      if (surface !== null && !OFF_ROAD.has(surface)) return { x: px, z: pz };
      fallback ??= { x: px, z: pz };
    }
    return fallback;
  }

  /** F a pie: subir si el carro está cerca, o traerlo y subir. Devuelve un aviso para el HUD (o null). */
  toggle(player: PlayerController, avatar: Avatar, cameraYaw: number, characterKey: string): string | null {
    if (this.active) return this.exit(player);
    if (!player.character.abilities.drive) {
      return `${player.character.name}: no cabe en el carro. Cambia de personaje con ${characterKey}`;
    }
    if (player.mode !== 'ground') return 'Para subirte al carro tienes que estar de pie en el suelo';
    const p = player.position;
    // En la calle o en el tablero de un puente (no en un techo).
    const street = Math.max(this.world.terrainAt(p.x, p.z), this.world.deckAt(p.x, p.z, p.y + player.stepHeight));
    if (p.y - street > player.stepHeight * 2) return 'Baja a la calle para usar el carro';
    return this.board(player, avatar, cameraYaw);
  }

  /**
   * Sube al personaje: al carro si está cerca, o lo trae a su lado mirando a `yaw` (o justo
   * donde está, con `exact`). Sin las reglas de `toggle` (de pie, en la calle): sirve también
   * para retomar manejando al recargar, cuando el personaje recién aparece. Devuelve un aviso
   * para el HUD (o null).
   */
  board(player: PlayerController, avatar: Avatar, yaw: number, exact = false): string | null {
    const p = player.position;
    const car = this.ensureCar();
    const near = this.placed && !car.stalled && car.position.distanceTo(p) <= this.cfg.enterReach;
    if (!near) {
      // `exact`: el carro va justo donde está el personaje (al retomar, ahí estaba el carro).
      const spot = exact && car.fits(p.x, p.z, yaw, p.y) ? { x: p.x, z: p.z } : this.findSpot(car, p.x, p.z, yaw, p.y);
      if (!spot) return 'Aquí no hay espacio para el carro';
      car.place(spot.x, spot.z, yaw, p.y);
      car.model.group.visible = true;
      this.placed = true;
    }
    this.enter(player, avatar);
    return null;
  }

  private enter(player: PlayerController, avatar: Avatar): void {
    const car = this.car!;
    this.avatar = avatar;
    car.model.seat.add(avatar.root);
    avatar.root.position.set(0, 0, 0);
    avatar.root.rotation.set(0, 0, 0);
    player.enterVehicle();
    this.active = true;
    this.syncPlayer(player);
  }

  /** Bajarse por el lado del conductor (o el que esté libre). */
  exit(player: PlayerController): string | null {
    const car = this.car;
    if (!car || !this.active) return null;
    if (car.speed * 3.6 > this.cfg.exitMaxSpeedKmh) return 'Frena para bajarte';
    const half = this.cfg.body.width / 2 + this.cfg.exitSideGap;
    const seatZ = car.model.seat.position.z;
    const spots: [number, number][] = [
      [-half, seatZ],
      [half, seatZ],
      [0, -car.model.front - this.cfg.exitSideGap],
      [0, car.model.rear + this.cfg.exitSideGap],
    ];
    const c = Math.cos(car.heading);
    const s = Math.sin(car.heading);
    const y = car.position.y;
    const reach = y + player.stepHeight;
    for (const [lx, lz] of spots) {
      const x = car.position.x + lx * c + lz * s;
      const z = car.position.z - lx * s + lz * c;
      const b = this.world.buildingAt(x, z);
      const floor = Math.max(this.world.terrainAt(x, z), this.world.deckAt(x, z, reach));
      if (b && roofTop(b, x, z) > floor + player.stepHeight) continue;
      // Ni contra la baranda de un puente ni al vacío por el borde del tablero.
      if (this.world.wallTop(x, z, y) > reach || floor < y - player.stepHeight * 2) continue;
      this.leave(player, x, z, car.heading, y);
      return null;
    }
    return 'No hay por dónde bajarse aquí';
  }

  private leave(player: PlayerController, x: number, z: number, facing: number, y = -Infinity): void {
    if (this.avatar) this.scene.add(this.avatar.root);
    this.avatar = null;
    this.active = false;
    player.exitVehicle(x, z, facing, y);
  }

  /** Teletransporte manejando: el carro va contigo si cabe en el destino; si no, llegas a pie. */
  relocate(player: PlayerController, x: number, z: number, yaw: number): boolean {
    const car = this.car;
    if (!car || !this.active) return false;
    // Al teletransportarse sobre un puente, el carro queda en el tablero de más arriba.
    const spot = this.findSpot(car, x, z, yaw, Infinity);
    if (!spot) {
      this.leave(player, x, z, yaw);
      return false;
    }
    car.place(spot.x, spot.z, yaw, Infinity);
    this.syncPlayer(player);
    return true;
  }

  update(dt: number, controls: Controls, player: PlayerController): void {
    const car = this.car;
    if (!car) return;
    if (!this.active) {
      car.update(dt, PARKED);
      return;
    }
    const i = this.input;
    i.throttle = controls.amount('forward');
    i.brake = controls.amount('back');
    i.steer = controls.axis('right', 'left');
    i.handbrake = controls.isDown('handbrake');
    if (controls.consume('speedUp')) car.shiftBoost(1);
    if (controls.consume('speedDown')) car.shiftBoost(-1);
    car.update(dt, i);
    this.syncPlayer(player);
  }

  /**
   * Faros: encendidos mientras manejas y está oscuro (se prenden con los postes). Su luz la
   * calculan los shaders del mundo (render/nightLight.ts); aquí van su posición y dirección.
   */
  updateHeadlights(): void {
    const car = this.car;
    const on = car && this.active ? nightLight.uLightsOn.value : 0;
    car?.model.setHeadlights(on);
    const u = nightLight;
    u.uHeadPos.value.w = on;
    if (!car || on <= 0) return;
    const hl = this.cfg.headlights;
    const node = car.model.headlight;
    node.getWorldPosition(this.beamPos);
    node.getWorldQuaternion(this.beamTurn);
    u.uHeadPos.value.set(this.beamPos.x, this.beamPos.y, this.beamPos.z, on);
    // El carro mira hacia -z de su cuerpo.
    const dir = this.beamPos.set(0, 0, -1).applyQuaternion(this.beamTurn);
    u.uHeadDir.value.set(dir.x, dir.y, dir.z, hl.range);
    u.uHeadColor.value.copy(this.beamColor.set(hl.color)).multiplyScalar(hl.intensity);
    const [outer, inner] = hl.coneDeg;
    u.uHeadCone.value.set(
      Math.cos(THREE.MathUtils.degToRad(outer)),
      Math.cos(THREE.MathUtils.degToRad(inner)),
      hl.foreground[0],
      hl.foreground[1],
    );
  }

  private syncPlayer(player: PlayerController): void {
    const car = this.car!;
    car.model.group.updateMatrixWorld(true);
    car.model.seat.getWorldPosition(this.seatWorld);
    player.followSeat(this.seatWorld, car.renderHeading, car.velocity);
  }

  /** Para la cámara: la pose dibujada del carro (interpolada), rumbo, ojos del conductor y orientación de la cabina. */
  view(): CarView | null {
    const car = this.car;
    if (!car || !this.active) return null;
    const model = car.model;
    model.eye.getWorldPosition(this.eyeWorld);
    // El chasis sigue el terreno; del balanceo de la carrocería la cabeza siente solo una parte
    // (el cuello compensa): con todo, la vista se mecería de más en cada curva y frenada.
    this.sway.copy(this.level).slerp(model.body.quaternion, this.cfg.camera.cabinSwayShare);
    this.cabin.copy(model.group.quaternion).multiply(this.sway);
    return { position: car.renderPosition, velocity: car.velocity, heading: car.renderHeading, eye: this.eyeWorld, cabin: this.cabin };
  }
}
