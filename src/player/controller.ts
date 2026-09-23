import * as THREE from 'three';
import type { Controls } from '../core/controls';
import type { GameConfig, Movement } from '../core/types';
import type { DeckHit } from '../world/bridges';
import { type BuildingRecord, roofTop } from '../world/buildings';
import type { Character } from './characters';

/** `drive` = sentado en un vehículo: lo mueve el vehículo, no el controlador. */
export type Mode = 'ground' | 'air' | 'climb' | 'glide' | 'swim' | 'drive';

/** Lo que el jugador (y los vehículos) necesitan saber del mundo. */
export interface WorldQuery {
  terrainAt(x: number, z: number): number;
  /** Tablero de puente más alto bajo (x, z) que no pase de `maxY` (-Infinity si no hay); con `hit`, su material. */
  deckAt(x: number, z: number, maxY: number, hit?: DeckHit): number;
  /** Tope de barandas, pilas o costados de rampas en (x, z) para alguien a la altura y (-Infinity si no hay). */
  wallTop(x: number, z: number, y: number): number;
  buildingAt(x: number, z: number): BuildingRecord | null;
  /** Superficie bajo (x, z) según las calles cargadas (material, vereda, parque…) o null si no hay datos. */
  surfaceAt(x: number, z: number): string | null;
  waterLevel: number;
  clampToWorld(x: number, z: number): { x: number; z: number };
}

const forwardOf = (yaw: number, out = new THREE.Vector3()): THREE.Vector3 => out.set(-Math.sin(yaw), 0, -Math.cos(yaw));

interface GlideState {
  heading: number;
  pitch: number;
  bank: number;
  speed: number;
  thermal: number;
}

/**
 * Movimiento del jugador a pie: caminar/correr, saltar, trepar edificios, nadar y planear
 * con ala delta. Velocidades y habilidades salen del personaje activo (config/game.json →
 * characters); una habilidad nueva es un modo más aquí más su bandera en la config.
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  facing = 0;
  mode: Mode = 'ground';
  speedIndex = 0;
  readonly glide: GlideState = { heading: 0, pitch: 0, bank: 0, speed: 0, thermal: 0 };
  private climbing: BuildingRecord | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private m: Movement;

  constructor(
    private readonly world: WorldQuery,
    private readonly cfg: GameConfig['player'],
    private readonly gcfg: GameConfig['glider'],
    public character: Character,
  ) {
    this.m = character.movement;
    this.setCharacter(character);
  }

  /** Cambia de personaje en el lugar; si el nuevo no sabe hacer lo que estaba haciendo, se suelta. */
  setCharacter(character: Character): void {
    this.character = character;
    this.m = character.movement;
    this.speedIndex = Math.min(this.m.defaultSpeedIndex, this.m.speedMultipliers.length - 1);
    if (this.mode === 'glide' && !character.abilities.glide) this.land();
    if (this.mode === 'climb' && !character.abilities.climb) {
      this.climbing = null;
      this.mode = 'air';
    }
  }

  get height(): number {
    return this.character.height;
  }

  get speedMultiplier(): number {
    return this.m.speedMultipliers[this.speedIndex];
  }

  /** El personaje puede cambiar su multiplicador de velocidad (los ficticios sí; un humano no). */
  get canBoost(): boolean {
    return this.m.speedMultipliers.length > 1;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get stepHeight(): number {
    return this.m.stepHeight;
  }

  /** Suelo transitable bajo (x, z): terreno, tableros de puentes y techos alcanzables. */
  groundAt(x: number, z: number, maxY: number): number {
    let ground = Math.max(this.world.terrainAt(x, z), this.world.deckAt(x, z, maxY));
    const b = this.world.buildingAt(x, z);
    const top = b ? roofTop(b, x, z) : -Infinity;
    if (top <= maxY) ground = Math.max(ground, top);
    return ground;
  }

  private inWater(x: number, z: number, ground: number): boolean {
    return ground < this.world.waterLevel - this.cfg.swimDepth * 0.5 && !this.world.buildingAt(x, z);
  }

  teleport(x: number, z: number): void {
    const p = this.world.clampToWorld(x, z);
    const b = this.world.buildingAt(p.x, p.z);
    // Sobre un puente se llega al tablero de más arriba.
    const ground = Math.max(b ? roofTop(b, p.x, p.z) : this.world.terrainAt(p.x, p.z), this.world.deckAt(p.x, p.z, Infinity));
    this.position.set(p.x, Math.max(ground, this.world.waterLevel) + this.cfg.spawnHeightOffset, p.z);
    this.velocity.set(0, 0, 0);
    this.climbing = null;
    this.mode = 'air';
  }

  /** Sube a un vehículo: desde aquí el vehículo decide la posición (ver `followSeat`). */
  enterVehicle(): void {
    this.velocity.set(0, 0, 0);
    this.climbing = null;
    this.glide.thermal = 0;
    this.mode = 'drive';
  }

  /** Mientras maneja, el jugador va donde está el asiento (para cámara, HUD y carga del mundo). */
  followSeat(seat: THREE.Vector3, heading: number, velocity: THREE.Vector3): void {
    this.position.copy(seat);
    this.velocity.copy(velocity);
    this.facing = heading;
  }

  /** Baja del vehículo de pie en (x, z), mirando hacia `facing`; `y`: altura del carro (sobre un puente). */
  exitVehicle(x: number, z: number, facing: number, y = -Infinity): void {
    const ground = this.groundAt(x, z, Math.max(this.world.terrainAt(x, z), y) + this.m.stepHeight);
    this.position.set(x, Math.max(ground, this.world.waterLevel - this.cfg.swimDepth), z);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    this.mode = 'air';
  }

  update(dt: number, controls: Controls, cameraYaw: number): void {
    if (this.mode === 'drive') return;
    if (controls.consume('speedUp')) this.speedIndex = Math.min(this.speedIndex + 1, this.m.speedMultipliers.length - 1);
    if (controls.consume('speedDown')) this.speedIndex = Math.max(this.speedIndex - 1, 0);

    if (controls.consume('glide') && this.character.abilities.glide) {
      if (this.mode === 'glide') {
        this.mode = 'air';
      } else {
        this.startGlide(this.mode === 'ground' || this.mode === 'climb' || this.mode === 'swim', cameraYaw);
      }
    }

    switch (this.mode) {
      case 'glide':
        this.updateGlide(dt, controls);
        break;
      case 'climb':
        this.updateClimb(dt, controls);
        break;
      default:
        this.updateWalk(dt, controls, cameraYaw);
    }
    const c = this.world.clampToWorld(this.position.x, this.position.z);
    this.position.x = c.x;
    this.position.z = c.z;
  }

  private startGlide(withThermal: boolean, cameraYaw: number): void {
    const g = this.glide;
    g.heading = this.mode === 'climb' ? this.facing + Math.PI : cameraYaw;
    g.pitch = 0;
    g.bank = 0;
    g.speed = Math.max(this.gcfg.trimSpeed, this.horizontalSpeed);
    g.thermal = withThermal ? this.gcfg.thermalHeight : 0;
    this.climbing = null;
    this.mode = 'glide';
  }

  private updateWalk(dt: number, controls: Controls, cameraYaw: number): void {
    const p = this.position;
    const v = this.velocity;
    const m = this.m;
    // Los edificios se cargan por partes: si uno apareció con el jugador adentro, sube al techo.
    const around = this.world.buildingAt(p.x, p.z);
    const aroundTop = around ? roofTop(around, p.x, p.z) : -Infinity;
    if (p.y < aroundTop - m.stepHeight) {
      p.y = aroundTop;
      v.y = 0;
    }
    const moveF = controls.axis('back', 'forward');
    const moveR = controls.axis('left', 'right');
    const fwd = forwardOf(cameraYaw, this.tmp);
    this.dir.set(fwd.x * moveF - fwd.z * moveR, 0, fwd.z * moveF + fwd.x * moveR);
    const moving = this.dir.lengthSq() > 0;
    if (moving) this.dir.normalize();

    const swimming = this.mode === 'swim';
    const running = controls.isDown('run');
    let speed = swimming ? (running ? m.swimRunSpeed : m.swimSpeed) : running ? m.runSpeed : m.walkSpeed;
    speed *= this.speedMultiplier;
    const k = Math.min(1, m.acceleration * dt * (this.mode === 'air' ? m.airControl : 1));
    v.x += (this.dir.x * speed - v.x) * k;
    v.z += (this.dir.z * speed - v.z) * k;

    if (moving) {
      const target = Math.atan2(-this.dir.x, -this.dir.z);
      const delta = Math.atan2(Math.sin(target - this.facing), Math.cos(target - this.facing));
      this.facing += delta * Math.min(1, m.turnRate * dt);
    }

    // Horizontal con colisión contra muros (o empezar a trepar).
    const nx = p.x + v.x * dt;
    const nz = p.z + v.z * dt;
    const hs = Math.hypot(v.x, v.z);
    if (hs > 1e-4) {
      const probe = this.cfg.probeDistance / hs;
      const wall = this.blockingBuilding(nx + v.x * probe, nz + v.z * probe);
      if (!wall && !this.blocked(nx + v.x * probe, nz + v.z * probe)) {
        p.x = nx;
        p.z = nz;
      } else if (wall && moveF > 0 && !swimming && this.character.abilities.climb) {
        this.climbing = wall;
        this.facing = Math.atan2(-v.x, -v.z);
        v.set(0, 0, 0);
        this.mode = 'climb';
        return;
      } else if (!this.blocked(nx + v.x * probe, p.z)) {
        p.x = nx;
        v.z = 0;
      } else if (!this.blocked(p.x, nz + v.z * probe)) {
        p.z = nz;
        v.x = 0;
      } else {
        v.x = 0;
        v.z = 0;
      }
    }

    // Vertical.
    const ground = this.groundAt(p.x, p.z, p.y + m.stepHeight);
    const water = this.inWater(p.x, p.z, ground);
    const floor = water ? this.world.waterLevel - this.cfg.swimDepth : ground;
    if (this.mode === 'ground' || this.mode === 'swim') {
      if (p.y - floor > m.stepHeight * 1.5) {
        this.mode = 'air';
      } else {
        p.y = floor;
        v.y = 0;
        this.mode = water ? 'swim' : 'ground';
        if (!water && controls.consume('jump')) {
          v.y = m.jumpSpeed;
          this.mode = 'air';
        }
      }
    }
    if (this.mode === 'air') {
      v.y -= m.gravity * dt;
      p.y += v.y * dt;
      if (p.y <= floor && v.y <= 0) {
        p.y = floor;
        v.y = 0;
        this.mode = water ? 'swim' : 'ground';
      }
    }
  }

  /** Edificio que impide pasar a (x, z) desde la altura actual. */
  private blockingBuilding(x: number, z: number): BuildingRecord | null {
    const b = this.world.buildingAt(x, z);
    return b && roofTop(b, x, z) > this.position.y + this.m.stepHeight ? b : null;
  }

  /** ¿Impide pasar a (x, z) un edificio o un puente (baranda, pila, costado de rampa)? */
  private blocked(x: number, z: number): boolean {
    const y = this.position.y;
    return !!this.blockingBuilding(x, z) || this.world.wallTop(x, z, y) > y + this.m.stepHeight;
  }

  private updateClimb(dt: number, controls: Controls): void {
    const b = this.climbing;
    const p = this.position;
    if (!b) {
      this.mode = 'air';
      return;
    }
    const fwd = forwardOf(this.facing, this.tmp);
    if (controls.consume('jump')) {
      this.velocity.set(-fwd.x * 4, this.m.jumpSpeed * 0.8, -fwd.z * 4);
      this.climbing = null;
      this.mode = 'air';
      return;
    }
    if (controls.isDown('back')) {
      this.velocity.set(0, 0, 0);
      this.climbing = null;
      this.mode = 'air';
      return;
    }
    const climbing = controls.isDown('forward');
    this.velocity.set(0, climbing ? this.m.climbSpeed * this.speedMultiplier : 0, 0);
    p.y += this.velocity.y * dt;
    // Tope del muro justo adentro del borde: la losa, o el alero/hastial en techos de teja.
    const top = roofTop(b, p.x + fwd.x * this.cfg.roofLedge, p.z + fwd.z * this.cfg.roofLedge);
    if (p.y >= top) {
      p.y = top;
      p.x += fwd.x * this.cfg.roofLedge;
      p.z += fwd.z * this.cfg.roofLedge;
      this.climbing = null;
      this.velocity.set(0, 0, 0);
      this.mode = 'ground';
    }
  }

  private updateGlide(dt: number, controls: Controls): void {
    const g = this.glide;
    const c = this.gcfg;
    const p = this.position;
    const deg = THREE.MathUtils.degToRad;
    const turn = controls.axis('left', 'right');
    const pitchIn = controls.axis('back', 'forward');

    g.bank += (turn * deg(c.maxBankDeg) - g.bank) * Math.min(1, dt * 3);
    g.heading -= turn * c.turnRate * dt;
    if (pitchIn !== 0) g.pitch += pitchIn * c.pitchRate * dt;
    else g.pitch += (0 - g.pitch) * Math.min(1, dt * 0.8);
    g.pitch = THREE.MathUtils.clamp(g.pitch, -deg(c.maxPitchUpDeg), deg(c.maxPitchDownDeg));
    g.speed += (c.gravity * Math.sin(g.pitch) - c.drag * (g.speed - c.trimSpeed)) * dt;
    g.speed = THREE.MathUtils.clamp(g.speed, c.minSpeed, c.maxSpeed);

    let climb = -g.speed * Math.sin(g.pitch) - c.sinkRate;
    if (g.thermal > 0) {
      climb += c.thermalRate;
      g.thermal -= c.thermalRate * dt;
    }
    const fwd = forwardOf(g.heading, this.tmp);
    // Mientras la térmica sube, se avanza poco: primero ganar altura, después planear.
    const thermalFactor = g.thermal > 0 ? c.thermalForwardFactor : 1;
    const hs = g.speed * Math.cos(g.pitch) * this.speedMultiplier * thermalFactor;
    this.velocity.set(fwd.x * hs, climb, fwd.z * hs);
    p.addScaledVector(this.velocity, dt);
    this.facing = g.heading;

    const b = this.world.buildingAt(p.x, p.z);
    const top = b ? roofTop(b, p.x, p.z) : -Infinity;
    if (b && p.y < top) {
      if (top - p.y <= c.grabHeight) {
        p.y = top;
        this.land();
      } else if (this.character.abilities.climb) {
        // Choque contra la fachada: retrocede hasta el muro y se agarra para trepar.
        this.backOff(b, fwd);
        this.climbing = b;
        this.velocity.set(0, 0, 0);
        this.mode = 'climb';
      } else {
        this.backOff(b, fwd);
        this.land();
      }
      return;
    }
    // Aterrizar en el tablero de un puente (lo que quede al alcance para agarrarse) o en el suelo.
    const ground = Math.max(this.world.terrainAt(p.x, p.z), this.world.deckAt(p.x, p.z, p.y + c.grabHeight));
    const water = ground < this.world.waterLevel;
    const floor = water ? this.world.waterLevel - this.cfg.swimDepth : ground;
    if (p.y <= floor) {
      p.y = floor;
      this.land();
    }
  }

  /** Retrocede en línea recta hasta salir del edificio. */
  private backOff(b: BuildingRecord, fwd: THREE.Vector3): void {
    const p = this.position;
    for (let k = 0; k < 20 && this.world.buildingAt(p.x, p.z) === b; k++) {
      p.x -= fwd.x * 0.5;
      p.z -= fwd.z * 0.5;
    }
  }

  private land(): void {
    this.velocity.set(0, 0, 0);
    this.glide.thermal = 0;
    this.mode = 'air';
  }
}
