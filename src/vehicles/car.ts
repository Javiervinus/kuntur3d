import * as THREE from 'three';
import type { VehicleConfig } from '../core/types';
import type { WorldQuery } from '../player/controller';
import type { DeckHit } from '../world/bridges';
import { roofTop } from '../world/buildings';
import { type CarModel, createCarModel } from './carModel';

/** Mandos del conductor (0..1, dirección −1..1: positivo = izquierda). */
export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

/** Sin conductor: freno de mano puesto. */
export const PARKED: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };

const smoothstep = (a: number, b: number, x: number): number => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Resistencia de una superficie: rodadura (fracción del peso) y "baches" (desaceleración por m/s). */
interface SurfaceDrag {
  grip: number;
  crr: number;
  bump: number;
}

/** Pose que se dibuja: se interpola entre los dos últimos pasos de física. */
interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
}

/**
 * Carro con dinámica de vehículo real (modelo de bicicleta):
 *  - motor limitado por potencia (P / v) y por la tracción del eje delantero, arrastre
 *    aerodinámico, resistencia a la rodadura y pendiente del terreno;
 *  - neumáticos con curva tipo Pacejka por eje y círculo de fricción (acelerar o frenar
 *    fuerte le quita agarre lateral), transferencia de peso adelante/atrás;
 *  - lo que trae un sedán moderno: ABS, reparto electrónico de frenado (EBD: las traseras,
 *    descargadas al frenar, nunca se bloquean antes que las delanteras) y control de
 *    estabilidad (ESC: si el carro gira más de lo que pide el volante o se cruza, frena una
 *    rueda y corta motor). El freno de mano bloquea las traseras y sigue sirviendo para derrapar;
 *  - dirección limitada por el agarre a alta velocidad (con teclado es todo o nada: a 120 km/h
 *    el volante a fondo pediría varias veces lo que aguantan las llantas);
 *  - agarre y resistencia por superficie bajo cada rueda (tierra y pasto frenan de forma
 *    progresiva, no de golpe), que cambian con la distancia de relajación de la llanta;
 *  - choques con impulso contra edificios (con giro si le pegas a una esquina), sin trepar;
 *  - agua: se frena y, pasado cierto fondo, el motor se ahoga y queda estancado;
 *  - "empujón": multiplicadores de velocidad (como los del personaje) que suben el tope y
 *    suman empuje directo al chasis, sin gastar el agarre de las llantas.
 * Se integra a paso fijo (estable a toda velocidad) y lo que se dibuja se interpola entre
 * los dos últimos pasos: sin eso, a 60 fps un frame avanzaba un paso y el siguiente tres
 * (a 120 km/h, saltos de 0,3 a 0,8 m) y el carro se veía "a trozos". A baja velocidad se
 * mezcla con el modelo cinemático, que no tiene la singularidad de la deriva cerca de 0 m/s.
 */
export class Car {
  readonly model: CarModel;
  /** Centro de gravedad a ras de suelo (estado de la física). */
  readonly position = new THREE.Vector3();
  /** Velocidad en el mundo (m/s). */
  readonly velocity = new THREE.Vector3();
  heading = 0;
  /** Pose dibujada (interpolada): la que deben seguir la cámara y el conductor. */
  readonly renderPosition = new THREE.Vector3();
  renderHeading = 0;
  /** Velocidad adelante, hacia la izquierda (m/s) y de giro (rad/s, + = izquierda). */
  vx = 0;
  vy = 0;
  r = 0;
  steer = 0;
  /** Motor ahogado en agua: no arranca hasta que el carro se vuelva a colocar. */
  stalled = false;
  /** Golpe más fuerte reciente (cambio de velocidad en m/s), para la cámara. */
  impact = 0;
  surface = '';
  braking = false;
  reversing = false;
  /** El control de estabilidad está actuando (para el HUD). */
  escActive = false;
  /** Escalón de `boost.multipliers` elegido. */
  boostIndex: number;

  private readonly P: VehicleConfig['physics'];
  private readonly surfaces = new Map<string, SurfaceDrag>();
  private readonly fallbackSurface: SurfaceDrag;
  private readonly contacts: [number, number][] = [];
  private readonly wheelLocal: [number, number][];
  private readonly wheelGround = [0, 0, 0, 0];
  /** Agarre, rodadura y baches bajo cada rueda (ya suavizados por la relajación de la llanta). */
  private readonly wheelGrip = [1, 1, 1, 1];
  private readonly wheelCrr = [0, 0, 0, 0];
  private readonly wheelBump = [0, 0, 0, 0];
  private readonly grip = { front: 1, rear: 1 };
  private ax = 0;
  private ay = 0;
  private vertical = 0;
  private airborne = false;
  private terrainPitch = 0;
  private terrainRoll = 0;
  private bodyPitch = 0;
  private bodyPitchVel = 0;
  private bodyRoll = 0;
  private bodyRollVel = 0;
  private spinFront = 0;
  private spinRear = 0;
  private accumulator = 0;
  private asleep = true;
  private depth = 0;
  private escMoment = 0;
  private escBrake = 0;
  /** Fuerza lateral del eje delantero en el paso anterior (la usa el control de tracción). */
  private lastFyF = 0;
  private readonly prev: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };
  private renderPitch = 0;
  private renderRoll = 0;
  private readonly noLift = [0, 0, 0, 0];
  private readonly contact = { x: 0, z: 0, n: 0 };
  // Temporales reutilizados: el paso de física no crea objetos (nada que recolectar por frame).
  private readonly scratch = { x: 0, z: 0 };
  private readonly normal = { x: 0, z: 0 };
  private readonly deckHit: DeckHit = { y: 0, surface: '' };
  private onDeck = false;

  constructor(
    private readonly cfg: VehicleConfig,
    private readonly world: WorldQuery,
  ) {
    this.P = cfg.physics;
    this.model = createCarModel(cfg);
    this.boostIndex = Math.min(cfg.boost.defaultIndex, cfg.boost.multipliers.length - 1);
    const m = this.model;
    const half = cfg.body.width / 2;
    const t = cfg.body.track / 2;
    this.wheelLocal = [
      [-t, -m.a],
      [t, -m.a],
      [-t, m.b],
      [t, m.b],
    ];
    // Puntos del contorno de la carrocería (x a la derecha, z hacia atrás) cada `contactSpacing` m.
    const along = Math.ceil((m.front + m.rear) / this.P.contactSpacing);
    const across = Math.ceil(cfg.body.width / this.P.contactSpacing);
    for (let k = 0; k <= along; k++) {
      const z = -m.front + ((m.front + m.rear) * k) / along;
      this.contacts.push([-half, z], [half, z]);
    }
    for (let k = 1; k < across; k++) {
      const x = -half + (cfg.body.width * k) / across;
      this.contacts.push([x, -m.front], [x, m.rear]);
    }
    for (const [name, s] of Object.entries(cfg.surfaces as Record<string, { grip: number; crr: number; topSpeedKmh: number }>)) {
      this.surfaces.set(name, { grip: s.grip, crr: s.crr, bump: this.bumpFor(s.crr, s.topSpeedKmh) });
    }
    const fallback = this.surfaces.get(cfg.unknownSurface);
    if (!fallback) throw new Error(`Superficie desconocida en config/game.json: ${cfg.unknownSurface}`);
    this.fallbackSurface = fallback;
  }

  /**
   * "Baches" de una superficie blanda: una desaceleración proporcional a la velocidad, elegida
   * para que a fondo (sin empujón) el tope ahí sea `topKmh`. Sumada a la rodadura, frena de
   * forma progresiva: entrar al pasto a 120 km/h se siente como soltar el acelerador y frenar
   * suave, no como chocar (antes, el tope se imponía de golpe: hasta 2,4 g).
   */
  private bumpFor(crr: number, topKmh: number): number {
    if (!topKmh) return 0;
    const P = this.P;
    const v = topKmh / 3.6;
    const push = P.wheelPower / (P.mass * v);
    const air = (0.5 * P.airDensity * P.dragArea * v * v) / P.mass;
    return Math.max(0, (push - crr * P.gravity - air) / v);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  get wheelbase(): number {
    return this.model.a + this.model.b;
  }

  /** Multiplicador de velocidad elegido. */
  get boost(): number {
    return this.cfg.boost.multipliers[this.boostIndex];
  }

  get canBoost(): boolean {
    return this.cfg.boost.multipliers.length > 1;
  }

  shiftBoost(step: number): void {
    this.boostIndex = THREE.MathUtils.clamp(this.boostIndex + step, 0, this.cfg.boost.multipliers.length - 1);
  }

  /** Local (x derecha, z atrás) → mundo, con la pose (x, z, rumbo) dada. */
  private toWorld(lx: number, lz: number, x: number, z: number, heading: number, out: { x: number; z: number }): void {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    out.x = x + lx * c + lz * s;
    out.z = z - lx * s + lz * c;
  }

  /** ¿Hay un muro más alto que un bordillo en algún punto del contorno con esta pose? Deja el centroide en `contact`. */
  private collides(x: number, z: number, heading: number, y: number): boolean {
    const p = this.scratch;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const [lx, lz] of this.contacts) {
      this.toWorld(lx, lz, x, z, heading, p);
      if (this.wallAt(p.x, p.z, y)) {
        sx += p.x;
        sz += p.z;
        n++;
      }
    }
    this.contact.n = n;
    if (n) {
      this.contact.x = sx / n;
      this.contact.z = sz / n;
    }
    return n > 0;
  }

  private wallAt(x: number, z: number, y: number): boolean {
    const b = this.world.buildingAt(x, z);
    const top = Math.max(b ? roofTop(b, x, z) : -Infinity, this.world.wallTop(x, z, y));
    return top > y + this.P.stepHeight;
  }

  /**
   * Suelo bajo (x, z) para las ruedas: el terreno o el tablero de un puente que no pase de
   * `maxY` (deja en `onDeck` si es un tablero y su material en `deckHit`).
   */
  private groundUnder(x: number, z: number, maxY: number): number {
    const terrain = this.world.terrainAt(x, z);
    const deck = this.world.deckAt(x, z, maxY, this.deckHit);
    this.onDeck = deck > terrain;
    return this.onDeck ? deck : terrain;
  }

  /**
   * ¿Cabe el carro aquí (sin muros, sin agua honda y sin quedar ladeado en un talud)? `y`: altura
   * de referencia para elegir el tablero de un puente (por defecto, el suelo).
   */
  fits(x: number, z: number, heading: number, y = -Infinity): boolean {
    const reach = Math.max(this.world.terrainAt(x, z), y) + this.P.stepHeight;
    const ground = this.groundUnder(x, z, reach);
    if (this.world.waterLevel - ground > this.P.wadeDepth) return false;
    const p = this.scratch;
    const h = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const [lx, lz] = this.wheelLocal[k];
      this.toWorld(lx, lz, x, z, heading, p);
      h[k] = this.groundUnder(p.x, p.z, reach);
    }
    const pitch = Math.atan2(Math.abs(h[0] + h[1] - h[2] - h[3]) / 2, this.wheelbase);
    const roll = Math.atan2(Math.abs(h[1] + h[3] - h[0] - h[2]) / 2, this.cfg.body.track);
    if (Math.max(pitch, roll) > THREE.MathUtils.degToRad(this.P.maxPlaceSlopeDeg)) return false;
    return !this.collides(x, z, heading, ground);
  }

  /** Coloca el carro detenido en (x, z) mirando a `heading` (motor en marcha); `y` como en `fits`. */
  place(x: number, z: number, heading: number, y = -Infinity): void {
    this.position.set(x, this.groundUnder(x, z, Math.max(this.world.terrainAt(x, z), y) + this.P.stepHeight), z);
    this.heading = heading;
    this.vx = this.vy = this.r = this.steer = 0;
    this.velocity.set(0, 0, 0);
    this.ax = this.ay = this.vertical = 0;
    this.lastFyF = this.escMoment = this.escBrake = 0;
    this.bodyPitch = this.bodyRoll = this.bodyPitchVel = this.bodyRollVel = 0;
    this.stalled = false;
    this.airborne = false;
    this.accumulator = 0;
    this.asleep = false;
    this.sampleGround(0);
    this.position.y = this.groundLevel();
    this.capture();
    this.interpolate(1);
    this.syncModel(0, PARKED);
  }

  update(dt: number, input: DriveInput): void {
    this.impact = Math.max(0, this.impact - dt * 4);
    const driven = input !== PARKED;
    if (this.asleep && !driven) return;
    this.asleep = false;
    const h = this.P.fixedStep;
    this.accumulator = Math.min(this.accumulator + dt, h * this.P.maxSubsteps);
    while (this.accumulator >= h) {
      this.capture();
      this.step(h, input);
      this.sampleGround(h);
      this.updateVertical(h);
      this.accumulator -= h;
    }
    this.interpolate(this.accumulator / h);
    this.syncModel(dt, input);
    if (!driven && this.speed < this.P.holdSpeed && !this.airborne) this.asleep = true;
  }

  private capture(): void {
    const q = this.prev;
    q.x = this.position.x;
    q.y = this.position.y;
    q.z = this.position.z;
    q.heading = this.heading;
    q.pitch = this.terrainPitch;
    q.roll = this.terrainRoll;
  }

  /** Pose dibujada = entre el paso anterior y el actual, según cuánto tiempo sobró (`alpha`). */
  private interpolate(alpha: number): void {
    const q = this.prev;
    const p = this.position;
    this.renderPosition.set(q.x + (p.x - q.x) * alpha, q.y + (p.y - q.y) * alpha, q.z + (p.z - q.z) * alpha);
    this.renderHeading = q.heading + (this.heading - q.heading) * alpha;
    this.renderPitch = q.pitch + (this.terrainPitch - q.pitch) * alpha;
    this.renderRoll = q.roll + (this.terrainRoll - q.roll) * alpha;
  }

  /**
   * Alturas y superficie bajo cada rueda, profundidad del agua, pendiente e inclinación lateral.
   * El agarre y la resistencia de cada rueda cambian a lo largo de `relaxationLength` metros
   * recorridos (como una llanta real), así el borde entre calzada y vereda no titila.
   */
  private sampleGround(h: number): void {
    const p = this.scratch;
    const floatLevel = this.world.waterLevel - this.P.floatDepth;
    const blend = h > 0 ? 1 - Math.exp((-this.speed * h) / this.P.relaxationLength) : 1;
    for (let k = 0; k < 4; k++) {
      const [lx, lz] = this.wheelLocal[k];
      this.toWorld(lx, lz, this.position.x, this.position.z, this.heading, p);
      // Sobre un puente, el tablero (hasta un escalón por encima del carro) y su calzada.
      this.wheelGround[k] = Math.max(this.groundUnder(p.x, p.z, this.position.y + this.P.stepHeight), floatLevel);
      const name = this.onDeck ? this.deckHit.surface : (this.world.surfaceAt(p.x, p.z) ?? this.cfg.unknownSurface);
      if (k === 0) this.surface = name;
      const s = this.surfaces.get(name) ?? this.fallbackSurface;
      this.wheelGrip[k] += (s.grip - this.wheelGrip[k]) * blend;
      this.wheelCrr[k] += (s.crr - this.wheelCrr[k]) * blend;
      this.wheelBump[k] += (s.bump - this.wheelBump[k]) * blend;
    }
    this.grip.front = (this.wheelGrip[0] + this.wheelGrip[1]) / 2;
    this.grip.rear = (this.wheelGrip[2] + this.wheelGrip[3]) / 2;
    const [fl, fr, rl, rr] = this.wheelGround;
    this.terrainPitch = Math.atan2((fl + fr - rl - rr) / 2, this.wheelbase);
    this.terrainRoll = Math.atan2((fr + rr - fl - rl) / 2, this.cfg.body.track);
    this.depth =
      this.world.waterLevel - this.groundUnder(this.position.x, this.position.z, this.position.y + this.P.stepHeight);
    if (this.depth > this.P.stallDepth) this.stalled = true;
  }

  private groundLevel(): number {
    const g = this.wheelGround;
    return (g[0] + g[1] + g[2] + g[3]) / 4;
  }

  private step(h: number, input: DriveInput): void {
    const P = this.P;
    const g = P.gravity;
    const m = P.mass;
    const a = this.model.a;
    const b = this.model.b;
    const L = a + b;
    const vx0 = this.vx;
    const vy0 = this.vy;
    const grounded = !this.airborne;

    // Dirección: el giro máximo es el que aprovecha el agarre (radio mínimo a esta velocidad
    // más un margen de deriva), y el volante tarda lo mismo en llegar a fondo a cualquier velocidad.
    const vxa = Math.abs(this.vx);
    const gripAccel = P.tireMu * Math.min(this.grip.front, this.grip.rear) * g;
    const gripSteer = Math.atan((L * gripAccel * P.steerGripShare) / Math.max(vxa * vxa, 1e-3));
    const maxSteer = Math.min(THREE.MathUtils.degToRad(P.maxSteerDeg), gripSteer + THREE.MathUtils.degToRad(P.steerSlipDeg));
    const rate = maxSteer / (input.steer !== 0 ? P.steerSeconds : P.steerReturnSeconds);
    this.steer += THREE.MathUtils.clamp(input.steer * maxSteer - this.steer, -rate * h, rate * h);
    const cosD = Math.cos(this.steer);
    const sinD = Math.sin(this.steer);

    // Carga por eje con transferencia de peso (frenar carga el eje delantero).
    const transfer = (P.cgHeight / L) * m * this.ax;
    const fzF = Math.max(0, (m * g * b) / L - transfer);
    const fzR = Math.max(0, (m * g * a) / L + transfer);
    const capF = this.loadedMu(fzF) * this.grip.front * fzF;
    const capR = this.loadedMu(fzR) * this.grip.rear * fzR;
    const dir = this.vx >= 0 ? 1 : -1;

    // Tracción delantera: potencia / velocidad, hasta lo que deja el control de tracción: una
    // parte de lo que queda del círculo de fricción después de la fuerza de la curva. Sin él,
    // a fondo y a baja velocidad el motor se comía todo el agarre delantero y el carro no
    // doblaba hasta pasar los ~30 km/h. El empujón suma potencia como empuje directo del
    // chasis; al acercarse al tope, el limitador corta suave.
    const traction = P.tractionControl * Math.sqrt(Math.max(0, capF * capF - this.lastFyF * this.lastFyF));
    const boost = this.boost;
    const top = (P.maxSpeedKmh / 3.6) * boost;
    let drive = 0;
    let thrust = 0;
    let brakeReq = 0;
    if (grounded && !this.stalled) {
      if (input.throttle > 0) {
        if (this.vx < -P.holdSpeed) brakeReq = input.throttle;
        else {
          const limiter = THREE.MathUtils.clamp((top - this.vx) / (P.limiterBandKmh / 3.6), 0, 1);
          const v = Math.max(this.vx, P.minPowerSpeed);
          drive = input.throttle * limiter * Math.min(P.wheelPower / v, traction);
          // Tope del empuje: lo que gana en aceleración (por escalón) más lo que se come el aire,
          // para que llegue al tope de cada escalón sin volverse un cohete al arrancar.
          const air = 0.5 * P.airDensity * P.dragArea * this.vx * this.vx;
          const extraCap = this.cfg.boost.extraAccelPerStep * (boost - 1) * m + air;
          thrust = input.throttle * limiter * Math.min(((boost ** 3 - 1) * P.wheelPower) / v, extraCap);
        }
      }
      if (input.brake > 0) {
        if (this.vx > P.holdSpeed) brakeReq = Math.max(brakeReq, input.brake);
        else if (this.vx > -P.reverseMaxKmh / 3.6) {
          drive -= input.brake * Math.min((P.reversePowerShare * P.wheelPower) / Math.max(-this.vx, P.minPowerSpeed), traction);
        }
      }
    }
    const cut = this.stability(input, grounded, capF + capR);
    if (drive > 0) drive *= cut;
    thrust *= cut;

    // Freno con ABS y reparto según la carga de cada eje (EBD, con margen hacia adelante).
    const brakeTotal = P.brakeDecel * m * brakeReq;
    const rearShare = fzF + fzR > 0 ? (fzR / (fzF + fzR)) * P.ebdRearBias : 0;
    const brakeF = grounded ? Math.min(brakeTotal * (1 - rearShare), P.absLimit * capF) : 0;
    let brakeR = grounded && !input.handbrake ? Math.min(brakeTotal * rearShare, P.absLimit * capR) : 0;
    // El ESC gira el carro repartiendo el freno entre ruedas: con el pedal ya a fondo no puede
    // frenar más de lo que dan las llantas (solo redistribuye), así que su freno extra se acota.
    this.escBrake = Math.min(this.escBrake, Math.max(0, P.absLimit * (capF + capR) - brakeF - brakeR));
    const coasting = input.throttle === 0 && input.brake === 0 && !this.stalled;
    const engineBrake = grounded && coasting ? P.engineBrake * m : 0;

    // Fuerzas laterales (Pacejka simplificado) con lo que queda del círculo de fricción.
    const vxs = Math.max(vxa, P.kinematicBelowSpeed);
    const longF = drive - dir * brakeF;
    const latCapF = Math.sqrt(Math.max(0, capF * capF - longF * longF));
    const alphaF = Math.atan2(this.vy + a * this.r, vxs) - this.steer * dir;
    const fyF = grounded ? -latCapF * this.tire(alphaF) : 0;
    let fxR = 0;
    let fyR = 0;
    if (grounded && input.handbrake) {
      // Traseras bloqueadas: la fricción de deslizamiento se opone a la velocidad de ese eje.
      const rx = this.vx;
      const ry = this.vy - b * this.r;
      const vr = Math.hypot(rx, ry);
      if (vr > P.holdSpeed) {
        const slide = P.slideMu * capR;
        fxR = (-slide * rx) / vr;
        fyR = (-slide * ry) / vr;
      }
      brakeR = 0;
    } else if (grounded) {
      const latCapR = Math.sqrt(Math.max(0, capR * capR - brakeR * brakeR));
      const alphaR = Math.atan2(this.vy - b * this.r, vxs);
      fyR = -latCapR * this.tire(alphaR);
    }

    const frontX = drive * cosD - fyF * sinD;
    const frontY = drive * sinD + fyF * cosD;
    const slope = -m * g * Math.sin(this.terrainPitch);
    const fx = frontX + fxR + slope + thrust;
    const fy = frontY + fyR;
    const mz = a * frontY - b * fyR + this.escMoment;
    this.vx += (fx / m + this.vy * this.r) * h;
    this.vy += (fy / m - vx0 * this.r) * h;
    this.r += (mz / P.yawInertia) * h;

    // Lo que solo frena (nunca invierte el sentido): frenos (también los del ESC), freno motor,
    // rodadura y baches de cada rueda, y aire.
    let resist = brakeF + brakeR + engineBrake + this.escBrake;
    if (grounded) {
      for (let k = 0; k < 4; k++) resist += (m / 4) * (this.wheelCrr[k] * g + this.wheelBump[k] * vxa);
    }
    const dv = (resist / m) * h;
    this.vx = Math.abs(this.vx) <= dv ? 0 : this.vx - Math.sign(this.vx) * dv;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 0) {
      const drag = (0.5 * P.airDensity * P.dragArea * speed * speed * h) / m;
      const k = Math.max(0, 1 - drag / speed);
      this.vx *= k;
      this.vy *= k;
    }

    // A baja velocidad, modelo cinemático (sin deriva): la rueda trasera no se desliza.
    const blend = smoothstep(P.kinematicBelowSpeed, P.dynamicAboveSpeed, Math.hypot(this.vx, this.vy));
    const rKin = (this.vx * Math.tan(this.steer)) / L;
    this.r = rKin + (this.r - rKin) * blend;
    this.vy = rKin * b + (this.vy - rKin * b) * blend;
    // Lo que la curva le pide al eje delantero (para el control de tracción): casi parado, la
    // deriva no tiene sentido y la fuerza "dinámica" sale saturada; ahí vale la centrípeta real.
    this.lastFyF = grounded ? fyF * blend + (1 - blend) * m * this.vx * rKin * (b / L) : 0;

    // Agua: arrastre según el fondo.
    const wet = THREE.MathUtils.clamp((this.depth - P.wadeDepth) / (P.stallDepth - P.wadeDepth), 0, 1);
    if (wet > 0) {
      const k = Math.exp(-P.waterDamping * wet * h);
      this.vx *= k;
      this.vy *= k;
      this.r *= k;
    }
    // Detenido y frenado (no dando reversa): la fricción estática lo sostiene, también en pendiente.
    const holding = drive === 0 && (brakeReq > 0 || input.handbrake);
    if (holding && Math.hypot(this.vx, this.vy) < P.holdSpeed) this.vx = this.vy = this.r = 0;

    // Aceleración "sentida" (transferencia de peso y balanceo de la carrocería).
    const felt = Math.min(1, h * P.accelSmoothing);
    this.ax += ((this.vx - vx0) / h - vy0 * this.r - this.ax) * felt;
    this.ay += ((this.vy - vy0) / h + vx0 * this.r - this.ay) * felt;

    this.move(h);
  }

  /**
   * Control de estabilidad. Compara el giro real con el que pide el volante (el geométrico,
   * limitado a lo que da el agarre) y mira si las llantas traseras resbalan; si sobra giro o
   * la cola se sale, aplica el momento contrario frenando una rueda (lo que también le quita
   * velocidad) y corta motor en proporción. No actúa con el freno de mano (derrape a
   * propósito) ni al subviraje. El resbalamiento se mide en el eje trasero y no en el centro
   * del carro: en una curva cerrada a baja velocidad el centro "deriva" ~20° por pura
   * geometría sin que ninguna llanta resbale, y medirlo ahí hacía que el ESC frenara el giro.
   * Deja el momento y la fuerza de freno pedida para este paso (`step` la acota a lo que
   * sobra de agarre); devuelve cuánto motor queda (0..1).
   */
  private stability(input: DriveInput, grounded: boolean, grip: number): number {
    const E = this.P.esc;
    this.escMoment = 0;
    this.escBrake = 0;
    this.escActive = false;
    if (!E.enabled || !grounded || input.handbrake || this.vx < E.minSpeedKmh / 3.6) return 1;
    const P = this.P;
    const v = this.vx;
    // Giro posible = lo que queda del círculo de fricción después de acelerar o frenar
    // (con el pedal a fondo casi no hay agarre lateral), con un mínimo para que igual doble.
    const gripAccel = P.tireMu * Math.min(this.grip.front, this.grip.rear) * P.gravity * E.gripShare;
    const lateral = Math.max(Math.sqrt(Math.max(0, gripAccel * gripAccel - this.ax * this.ax)), gripAccel * E.minLateralShare);
    const rLimit = lateral / v;
    const rWanted = THREE.MathUtils.clamp((v * Math.tan(this.steer)) / this.wheelbase, -rLimit, rLimit);
    let excess = 0;
    if (Math.abs(rWanted) > 1e-6 && Math.sign(this.r) !== Math.sign(rWanted)) excess = this.r;
    else {
      const over = Math.abs(this.r) - Math.abs(rWanted) * (1 + E.yawTolerance);
      if (over > 0) excess = Math.sign(this.r) * over;
    }
    const rearSlip = Math.atan2(this.vy - this.model.b * this.r, v);
    const maxSlip = THREE.MathUtils.degToRad(E.maxSlipDeg);
    const slip = rearSlip - THREE.MathUtils.clamp(rearSlip, -maxSlip, maxSlip);
    if (excess === 0 && slip === 0) return 1;
    const Iz = P.yawInertia;
    const halfTrack = this.cfg.body.track / 2;
    const maxMoment = E.brakeShare * (grip / 2) * halfTrack;
    const moment = THREE.MathUtils.clamp(Iz * (-E.yawGain * excess + E.slipGain * slip), -maxMoment, maxMoment);
    this.escMoment = moment;
    this.escBrake = Math.abs(moment) / halfTrack;
    this.escActive = Math.abs(moment) > 0;
    return 1 - E.throttleCut * Math.min(1, Math.abs(moment) / Math.max(maxMoment, 1e-6));
  }

  /**
   * Coeficiente de fricción de las llantas de un eje con carga `axleLoad` (N). Una llanta más
   * cargada rinde un poco menos por kilo (sensibilidad a la carga): por eso los sedanes de
   * fábrica tienden a abrirse suave en el límite en vez de cruzarse, y al frenar o soltar el
   * acelerador (más carga adelante) la cola gana agarre en vez de perderlo.
   */
  private loadedMu(axleLoad: number): number {
    const P = this.P;
    const nominal = (P.mass * P.gravity) / 4;
    const k = 1 - P.tireLoadSensitivity * (axleLoad / 2 / nominal - 1);
    return P.tireMu * THREE.MathUtils.clamp(k, P.tireLoadMuRange[0], P.tireLoadMuRange[1]);
  }

  /** Fuerza lateral del neumático (fracción del máximo) según el ángulo de deriva: Pacejka simplificado. */
  private tire(alpha: number): number {
    return Math.sin(this.P.tireC * Math.atan(this.P.tireB * alpha));
  }

  /** Avanza la pose y resuelve choques con impulso contra los edificios. */
  private move(h: number): void {
    const P = this.P;
    const px = this.position.x;
    const pz = this.position.z;
    const ph = this.heading;
    const y = this.position.y;
    this.heading += this.r * h;
    this.updateVelocity();
    let nx = px + this.velocity.x * h;
    let nz = pz + this.velocity.z * h;
    const clamped = this.world.clampToWorld(nx, nz);
    if (clamped.x !== nx || clamped.z !== nz) {
      nx = clamped.x;
      nz = clamped.z;
      this.vx = this.vy = 0;
    }
    if (!this.collides(nx, nz, this.heading, y)) {
      this.position.x = nx;
      this.position.z = nz;
      return;
    }
    const cx = this.contact.x;
    const cz = this.contact.z;
    const n = this.wallNormal(cx, cz, y, nx, nz);
    // Impulso en el punto de contacto (con rebote y roce contra el muro).
    const m = P.mass;
    const iz = P.yawInertia;
    const rx = cx - nx;
    const rz = cz - nz;
    const vcx = this.velocity.x + this.r * rz;
    const vcz = this.velocity.z - this.r * rx;
    const vn = vcx * n.x + vcz * n.z;
    if (vn < 0) {
      const rn = rz * n.x - rx * n.z;
      const j = (-(1 + P.restitution) * vn) / (1 / m + (rn * rn) / iz);
      let tx = vcx - vn * n.x;
      let tz = vcz - vn * n.z;
      const tl = Math.hypot(tx, tz);
      let jt = 0;
      if (tl > 1e-6) {
        tx /= tl;
        tz /= tl;
        const rt = rz * tx - rx * tz;
        jt = THREE.MathUtils.clamp(-tl / (1 / m + (rt * rt) / iz), -P.wallFriction * j, P.wallFriction * j);
      }
      const ix = j * n.x + jt * tx;
      const iz2 = j * n.z + jt * tz;
      this.velocity.x += ix / m;
      this.velocity.z += iz2 / m;
      this.r += (rz * ix - rx * iz2) / iz;
      this.impact = Math.max(this.impact, j / m);
      this.fromVelocity();
    }
    // Vuelve a la pose anterior; si igual queda adentro (un edificio que recién cargó), sale por la normal.
    this.heading = ph;
    this.position.x = px;
    this.position.z = pz;
    for (let k = 0; k < P.pushOutSteps && this.collides(this.position.x, this.position.z, this.heading, y); k++) {
      this.position.x += n.x * P.pushOutStep;
      this.position.z += n.z * P.pushOutStep;
    }
  }

  /** Normal del muro: hacia donde no hay edificio alrededor del contacto (o del contacto al centro). */
  private wallNormal(cx: number, cz: number, y: number, fromX: number, fromZ: number): { x: number; z: number } {
    const probe = this.P.contactProbe;
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < 8; k++) {
      const t = (k * Math.PI) / 4;
      const dx = Math.cos(t);
      const dz = Math.sin(t);
      if (this.wallAt(cx + dx * probe, cz + dz * probe, y)) {
        sx -= dx;
        sz -= dz;
      }
    }
    let len = Math.hypot(sx, sz);
    if (len < 1e-3) {
      sx = fromX - cx;
      sz = fromZ - cz;
      len = Math.hypot(sx, sz) || 1;
    }
    this.normal.x = sx / len;
    this.normal.z = sz / len;
    return this.normal;
  }

  /** Velocidad del cuerpo (adelante/izquierda) → mundo. */
  private updateVelocity(): void {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    // adelante = (−sen, −cos); izquierda = (−cos, sen)
    this.velocity.x = -s * this.vx - c * this.vy;
    this.velocity.z = -c * this.vx + s * this.vy;
  }

  private fromVelocity(): void {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    this.vx = -s * this.velocity.x - c * this.velocity.z;
    this.vy = -c * this.velocity.x + s * this.velocity.z;
  }

  /** Altura: pegado al suelo, o en el aire si el terreno cae más rápido que la gravedad (lomas a alta velocidad). */
  private updateVertical(h: number): void {
    const P = this.P;
    const ground = this.groundLevel();
    const p = this.position;
    if (this.airborne) {
      this.vertical -= P.gravity * h;
      p.y += this.vertical * h;
      if (p.y <= ground) {
        this.impact = Math.max(this.impact, -this.vertical);
        p.y = ground;
        this.vertical = 0;
        this.airborne = false;
      }
    } else {
      const ballistic = p.y + this.vertical * h - 0.5 * P.gravity * h * h;
      if (ground < ballistic - P.launchTolerance) {
        this.vertical -= P.gravity * h;
        p.y = ballistic;
        this.airborne = true;
      } else {
        this.vertical = (ground - p.y) / h;
        p.y = ground;
      }
    }
    this.velocity.y = this.vertical;
  }

  /** Pose del modelo (la interpolada): el chasis sigue el terreno; la carrocería se balancea con la inercia. */
  private syncModel(dt: number, input: DriveInput): void {
    const P = this.P;
    const m = this.model;
    m.group.position.copy(this.renderPosition);
    m.group.rotation.set(this.renderPitch, this.renderHeading, this.renderRoll, 'YXZ');
    if (dt > 0) {
      const pitchTarget = P.pitchPerAccel * this.ax;
      const rollTarget = -P.rollPerLatAccel * this.ay;
      this.bodyPitchVel += (P.bodyStiffness * (pitchTarget - this.bodyPitch) - P.bodyDamping * this.bodyPitchVel) * dt;
      this.bodyRollVel += (P.bodyStiffness * (rollTarget - this.bodyRoll) - P.bodyDamping * this.bodyRollVel) * dt;
      this.bodyPitch += this.bodyPitchVel * dt;
      this.bodyRoll += this.bodyRollVel * dt;
    }
    m.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    const R = this.cfg.body.wheelRadius;
    const turn = Math.PI * 2;
    this.spinFront = (this.spinFront - (this.vx / R) * dt) % turn;
    if (!input.handbrake) this.spinRear = (this.spinRear - (this.vx / R) * dt) % turn;
    m.setWheels(this.steer, this.spinFront, this.spinRear, this.noLift);
    this.braking = (input.brake > 0 && this.vx > P.holdSpeed) || (input.throttle > 0 && this.vx < -P.holdSpeed);
    this.reversing = input.brake > 0 && this.vx < -P.holdSpeed;
    m.setLights(this.braking, this.reversing);
  }

  dispose(): void {
    this.model.dispose();
  }
}
