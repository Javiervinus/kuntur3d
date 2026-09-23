import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { GameConfig } from '../core/types';
import { type SkyLook, type SkyParams, horizonRadiance, skyAmbient, sunTransmittance } from './atmosphere';
import type { Celestial } from './celestial';
import { CityShadow } from './cityShadow';
import { setFogColor } from './fog';
import { lighting } from './lightingUniforms';
import { nightLight } from './nightLight';
import { SkyDome } from './skyDome';

type RenderConfig = GameConfig['render'];
type Curve = readonly (readonly number[])[];

/** Interpolación lineal por tramos de una curva [[x, y], …] ordenada por x. */
function curve(points: Curve, x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let k = 1; k < points.length; k++) {
    const [x1, y1] = points[k];
    if (x <= x1) {
      const [x0, y0] = points[k - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** 0 en `a`, 1 en `b` (suave), en cualquier sentido. */
function ramp(x: number, a: number, b: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;

const _c = new THREE.Color();
const _sunLight = new THREE.Color();
const _moonLight = new THREE.Color();
const _sky = new THREE.Color();
const _total = new THREE.Color();
const _fog = new THREE.Color();
const _axis = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

/** Lo que ilumina el mundo en un instante (ver `Environment.light`). */
interface LightState {
  sunAlt: number;
  night: number;
  lightsOn: number;
}

/**
 * Luz del mundo según la hora: el cielo (día, bruma, crepúsculo, noche), el sol o la luna como
 * luz principal con sombras en cascada, la luz ambiente (reflejos y luz difusa: el cielo más
 * el rebote cálido del suelo), la bruma, la exposición y la luz propia de la foto satelital.
 *
 * Todo sale del mismo modelo: el cielo de Preetham evaluado en la CPU (atmosphere.ts) da el
 * color del horizonte y la luz que manda el cielo; el sol se calibra para que la luz difusa
 * sea `diffuseShare` de la total a la altura de referencia (aire húmedo del trópico) y se
 * tiñe al atravesar la atmósfera. Así, con la misma escala, la sombra, el cielo y la bruma
 * cuadran entre sí a cualquier hora.
 *
 * La luz ambiente es un mapa de entorno prefiltrado (PMREM) que usan todos los materiales.
 * Prefiltrarlo cuesta unos milisegundos, así que no se rehace en cada frame: al elegir otra
 * hora se prepara una vez el de la hora de destino y, durante el time-lapse, se funde el de
 * partida con el de llegada (el filtrado es lineal, así que fundir mapas equivale a fundir cielos).
 */
export class Environment {
  readonly sun: SunLight;
  /** Mapa de entorno (PMREM) que usan todos los materiales; se actualiza en su lugar. */
  readonly envMap: THREE.Texture;
  private readonly sky: SkyDome;
  private readonly shadow: CityShadow;
  private readonly params: SkyParams;
  private readonly look: SkyLook;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly cube: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly captureScene = new THREE.Scene();
  private readonly groundMaterial: THREE.MeshBasicMaterial;
  /** Entorno que se ve y los dos extremos del fundido (partida → destino). */
  private readonly shown: THREE.WebGLRenderTarget;
  private readonly from: THREE.WebGLRenderTarget;
  private readonly to: THREE.WebGLRenderTarget;
  private readonly blendMaterial: THREE.ShaderMaterial;
  private readonly blendScene = new THREE.Scene();
  private readonly blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Irradiancia del sol en el cenit (unidades del juego) y la luz total de referencia de la foto. */
  private readonly sunScale: number;
  private readonly selfLightReference: number;
  /** Cuánto es de noche (0…1) en el instante mostrado. */
  private night = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly cfg: RenderConfig,
    private readonly origin: { lat: number; lon: number },
    celestial: Celestial,
    instant: Date,
  ) {
    const lc = cfg.lighting;
    this.params = {
      turbidity: lc.sky.turbidity,
      rayleigh: lc.sky.rayleigh,
      mieCoefficient: lc.sky.mieCoefficient,
      mieDirectionalG: lc.sky.mieDirectionalG,
    };
    this.look = {
      scale: lc.sky.scale,
      hazeAmount: lc.sky.haze.amount,
      hazeFalloff: lc.sky.haze.falloff,
      hazeColor: new THREE.Color(lc.sky.haze.color),
      saturation: lc.sky.saturation,
    };

    this.sky = new SkyDome();
    this.sky.mesh.scale.setScalar(cfg.far * cfg.skyScaleOfFar);
    scene.add(this.sky.mesh);
    this.setStaticSkyUniforms();

    // Calibración: con el sol a la altura de referencia, la luz del cielo es `diffuseShare` de la total.
    const refAlt = lc.sun.referenceAltitude;
    const refSky = luminance(this.skyIrradiance(this.directionAt(refAlt), _c));
    const refT = luminance(sunTransmittance(refAlt, lc.sun.rayleighDepth, lc.sun.aerosolDepth, _c));
    const share = lc.sun.diffuseShare;
    this.sunScale = (refSky * (1 - share)) / share / (Math.sin(THREE.MathUtils.degToRad(refAlt)) * refT);
    const selfAlt = lc.selfLightReferenceAltitude;
    const selfT = luminance(sunTransmittance(selfAlt, lc.sun.rayleighDepth, lc.sun.aerosolDepth, _c));
    const selfSky = luminance(this.skyIrradiance(this.directionAt(selfAlt), _c));
    this.selfLightReference = this.sunScale * selfT * Math.sin(THREE.MathUtils.degToRad(selfAlt)) + selfSky;
    // La foto satelital responde a la luz de los postes en la misma escala que a la del cielo.
    nightLight.uNightSurface.value.z = 1 / this.selfLightReference;

    scene.fog = new THREE.Fog(cfg.fog.color, cfg.fog.near, cfg.fog.far);

    // Sol (o luna) con sombras en dos cascadas.
    this.sun = new SunLight(0xffffff, 1);
    this.shadow = new CityShadow();
    this.sun.shadow = this.shadow;
    const sh = cfg.shadow;
    this.sun.castShadow = true;
    this.shadow.mapSize.set(sh.mapSize, sh.mapSize);
    this.shadow.bias = sh.bias;
    this.shadow.normalBias = sh.normalBias;
    this.shadow.radius = sh.radius;
    this.shadow.fade = sh.fade;
    this.shadow.camera.near = sh.shadowNear;
    scene.add(this.sun);

    // Luz ambiente: el cielo y un suelo del color del rebote capturados en un cubo y prefiltrados.
    const size = lc.environment.size;
    this.cube = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(0.1, 1000, this.cube);
    const skyCopy = new THREE.Mesh(this.sky.mesh.geometry, this.sky.material);
    skyCopy.scale.setScalar(100);
    skyCopy.frustumCulled = false;
    this.groundMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false });
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(50, 32, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      this.groundMaterial,
    );
    this.captureScene.add(skyCopy, ground);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.blendMaterial = new THREE.ShaderMaterial({
      uniforms: { tFrom: { value: null }, tTo: { value: null }, uMix: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tFrom; uniform sampler2D tTo; uniform float uMix; varying vec2 vUv;
void main() { gl_FragColor = mix(texture2D(tFrom, vUv), texture2D(tTo, vUv), uMix); }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMaterial);
    quad.frustumCulled = false;
    this.blendScene.add(quad);

    this.apply(celestial, instant);
    this.captureSky();
    this.shown = this.pmrem.fromCubemap(this.cube.texture);
    this.from = this.pmrem.fromCubemap(this.cube.texture);
    this.to = this.pmrem.fromCubemap(this.cube.texture);
    this.envMap = this.shown.texture;
    scene.environment = this.envMap;
    scene.environmentIntensity = lc.ambient;
  }

  /** Sombras en cascada del sol (o la luna). */
  get cityShadow(): CityShadow {
    return this.shadow;
  }

  private directionAt(altitudeDeg: number): THREE.Vector3 {
    const a = THREE.MathUtils.degToRad(altitudeDeg);
    return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
  }

  /** Irradiancia del cielo de día sobre el suelo, en unidades del juego. */
  private skyIrradiance(sun: THREE.Vector3, out: THREE.Color): THREE.Color {
    return skyAmbient(sun, this.params, this.look, out).multiplyScalar(Math.PI);
  }

  private setStaticSkyUniforms(): void {
    const u = this.sky.uniforms;
    const lc = this.cfg.lighting;
    const s = lc.sky;
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mieCoefficient;
    u.mieDirectionalG.value = s.mieDirectionalG;
    u.cloudCoverage.value = s.clouds.coverage;
    u.cloudDensity.value = s.clouds.density;
    u.cloudScale.value = s.clouds.scale;
    u.cloudSpeed.value = s.clouds.speed;
    u.cloudElevation.value = s.clouds.elevation;
    u.uSkyScale.value = s.scale;
    u.uHaze.value.set(s.haze.amount, s.haze.falloff);
    (u.uHazeColor.value as THREE.Color).set(s.haze.color);
    u.uSkySaturation.value = s.saturation;
    const m = lc.moon;
    u.uMoonRadius.value = THREE.MathUtils.degToRad(m.radiusDeg);
    u.uEarthshine.value = m.earthshine;
    (u.uMoonColor.value as THREE.Color).set(m.color).multiplyScalar(m.brightness);
    const n = lc.night;
    (u.uNightZenith.value as THREE.Color).set(n.zenith);
    (u.uNightHorizon.value as THREE.Color).set(n.horizon);
    u.uCityGlowFalloff.value = n.cityGlow.falloff;
    u.uCloudCityGlow.value = n.cityGlow.clouds;
    u.uTwilightFalloff.value = n.twilight.falloff;
    u.uStars.value.set(n.stars.grid, n.stars.density, n.stars.size, n.stars.exponent);
    const w = lc.windows;
    lighting.uWindowWarm.value.set(w.warm);
    lighting.uWindowCool.value.set(w.cool);
    lighting.uWindowCoolShare.value = w.coolShare;
  }

  /**
   * Cielo y luz para la posición del sol y la luna: deja en el shader del cielo y en el suelo
   * de la captura lo de ese instante, y en `_sunLight`, `_moonLight`, `_sky` y `_total` la luz
   * directa, la del cielo y la total sobre el suelo.
   */
  private light(c: Celestial, instant: Date): LightState {
    const lc = this.cfg.lighting;
    const u = this.sky.uniforms;
    const sunAlt = c.sun.altitude;
    u.sunPosition.value.copy(c.sun.direction);
    u.uMoonDirection.value.copy(c.moon.direction);

    // Luz directa del sol, teñida por la atmósfera; las nubes la reflejan (albedo / π), en la
    // escala del modelo del cielo (el shader después la lleva a la del juego).
    sunTransmittance(sunAlt, lc.sun.rayleighDepth, lc.sun.aerosolDepth, _sunLight).multiplyScalar(this.sunScale);
    (u.uCloudSun.value as THREE.Color).copy(_sunLight).multiplyScalar(lc.sky.clouds.albedo / Math.PI / lc.sky.scale);
    // Luna: mucho más débil, según su fase y su altura (se apaga cerca del horizonte).
    const m = lc.moon;
    const moonUp = ramp(c.moon.altitude, 0, m.fadeAltitude);
    sunTransmittance(Math.max(c.moon.altitude, 0), lc.sun.rayleighDepth, lc.sun.aerosolDepth, _moonLight);
    _moonLight.multiply(_c.set(m.color)).multiplyScalar(m.intensity * moonUp * Math.pow(c.moon.illumination, m.phaseExponent));

    // Noche, crepúsculo, estrellas y luna en el cielo.
    const n = lc.night;
    const night = ramp(sunAlt, n.from, n.to);
    const lightsOn = ramp(sunAlt, n.lightsOn[0], n.lightsOn[1]);
    u.uNightLevel.value = night;
    (u.uCityGlow.value as THREE.Color).set(n.cityGlow.color).multiplyScalar(n.cityGlow.intensity * lightsOn);
    const tw = n.twilight;
    const twilight = sunAlt < tw.peak ? ramp(sunAlt, tw.from, tw.peak) : 1 - ramp(sunAlt, tw.peak, tw.to);
    (u.uTwilight.value as THREE.Color).set(tw.color).multiplyScalar(tw.intensity * twilight);
    u.uStarLevel.value = n.stars.brightness * night;
    this.starRotation(instant, u.uStarRotation.value as THREE.Matrix3);
    u.uMoonGlow.value.set(m.glow[0] * c.moon.illumination, m.glow[1], m.glow[2] * c.moon.illumination, m.glow[3]);

    // Luz del cielo (de día, de noche y el resplandor de la ciudad) y total sobre el suelo.
    this.skyIrradiance(c.sun.direction, _sky);
    _sky.add(_c.set(n.zenith).lerp(_fog.set(n.horizon), 0.5).multiplyScalar(night * Math.PI));
    _sky.add(_c.copy(u.uCityGlow.value as THREE.Color).multiplyScalar(Math.PI * 0.5));
    const sunH = Math.max(Math.sin(THREE.MathUtils.degToRad(sunAlt)), 0);
    const moonH = Math.max(Math.sin(THREE.MathUtils.degToRad(c.moon.altitude)), 0);
    _total.copy(_sunLight).multiplyScalar(sunH).add(_c.copy(_moonLight).multiplyScalar(moonH)).add(_sky);

    // Suelo de la captura del ambiente: albedo × luz total / π, más las calles iluminadas de noche.
    this.groundMaterial.color.set(lc.groundAlbedo).multiply(_total).multiplyScalar(1 / Math.PI);
    this.groundMaterial.color.add(_c.set(n.groundBounce).multiplyScalar(lightsOn));
    return { sunAlt, night, lightsOn };
  }

  /** Recalcula la luz del instante mostrado (cada frame durante un time-lapse). */
  apply(c: Celestial, instant: Date): void {
    const lc = this.cfg.lighting;
    const { sunAlt, night, lightsOn } = this.light(c, instant);
    this.night = night;
    nightLight.uLightsOn.value = lightsOn;

    // Luz principal: el sol mientras está arriba; ya puesto (con su luz en cero), la luna.
    const sw = lc.keySwap;
    const useSun = sunAlt > sw.sunAltitude;
    const key = useSun ? _sunLight : _c.copy(_moonLight).multiplyScalar(ramp(sunAlt, sw.sunAltitude, sw.sunAltitude - sw.rampDeg));
    const strength = Math.max(key.r, key.g, key.b);
    this.sun.position.copy(useSun ? c.sun.direction : c.moon.direction);
    if (strength > 0) this.sun.color.setRGB(key.r / strength, key.g / strength, key.b / strength);
    this.sun.intensity = strength;
    // Sin luz principal (sol puesto y sin luna) no se dibuja el mapa de sombras.
    this.shadow.autoUpdate = strength > lc.minShadowLight;

    // Bruma: el horizonte del lado contrario al sol (el brillo hacia el sol lo pone el shader de la bruma).
    const n = lc.night;
    _fog.setRGB(0, 0, 0);
    const samples = lc.fogSamples;
    const sunAz = Math.atan2(c.sun.direction.x, c.sun.direction.z);
    const elevation = THREE.MathUtils.degToRad(lc.fogElevationDeg);
    for (let k = 0; k < samples; k++) {
      const az = sunAz + Math.PI * (0.5 + k / (samples - 1));
      _fog.add(horizonRadiance(az, elevation, c.sun.direction, this.params, this.look, _c));
    }
    _fog.multiplyScalar(1 / samples);
    _fog.add(_c.set(n.horizon).multiplyScalar(night)).add(this.sky.uniforms.uCityGlow.value as THREE.Color);
    setFogColor(this.scene.fog as THREE.Fog, _fog);

    // Exposición y luz propia de la foto satelital (relativa a la luz de referencia).
    this.renderer.toneMappingExposure = curve(lc.exposure, sunAlt);
    lighting.uSelfLight.value.copy(_total).multiplyScalar(1 / this.selfLightReference);

    // Ventanas encendidas y locales abiertos (por la hora de sus relojes).
    const w = lc.windows;
    lighting.uWindowLit.value = curve(w.lit, sunAlt);
    lighting.uWindowGlow.value = curve(w.glow, sunAlt);
    const hours = instant.getTime() / HOUR_MS + this.cfg.timeOfDay.utcOffsetHours;
    lighting.uShopHour.value = ((hours % DAY_HOURS) + DAY_HOURS) % DAY_HOURS;
  }

  /** Giro de la esfera celeste: tiempo sidéreo local alrededor del eje del mundo. */
  private starRotation(instant: Date, out: THREE.Matrix3): void {
    const days = instant.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0;
    const era = 2 * Math.PI * ((0.779057273264 + 1.00273781191135448 * days) % 1);
    const lst = era + THREE.MathUtils.degToRad(this.origin.lon);
    const lat = THREE.MathUtils.degToRad(this.origin.lat);
    // Polo celeste norte en el marco local (x = este, y = arriba, z = sur).
    _axis.set(0, Math.sin(lat), -Math.cos(lat));
    out.setFromMatrix4(_m4.makeRotationAxis(_axis, lst));
  }

  /** Cubo del cielo actual (sin el disco del sol: su luz ya es la luz principal). */
  private captureSky(): void {
    const u = this.sky.uniforms;
    const disc = u.showSunDisc.value;
    u.showSunDisc.value = 0;
    this.cubeCamera.update(this.renderer, this.captureScene);
    u.showSunDisc.value = disc;
  }

  /**
   * Empieza un cambio de hora: el entorno que se ve pasa a ser el de partida y se prepara
   * (una sola vez) el de la hora de destino. Luego `blend` los funde.
   */
  beginTransition(current: Celestial, currentInstant: Date, target: Celestial, targetInstant: Date): void {
    this.drawBlend(this.shown.texture, this.shown.texture, 0, this.from);
    this.light(target, targetInstant);
    this.captureSky();
    this.pmrem.fromCubemap(this.cube.texture, this.to);
    this.light(current, currentInstant);
  }

  /** Funde el entorno de partida con el de destino (0 = partida, 1 = destino). */
  blend(t: number): void {
    this.drawBlend(this.from.texture, this.to.texture, t, this.shown);
  }

  private drawBlend(a: THREE.Texture, b: THREE.Texture, t: number, into: THREE.WebGLRenderTarget): void {
    const u = this.blendMaterial.uniforms;
    u.tFrom.value = a;
    u.tTo.value = b;
    u.uMix.value = t;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(into);
    this.renderer.render(this.blendScene, this.blendCamera);
    this.renderer.setRenderTarget(previous);
  }

  /**
   * Cada frame: el cielo sigue a la cámara, las nubes avanzan y las cascadas de sombra se
   * ajustan a la altura de la cámara sobre el suelo. De noche las sombras (de la luna) se
   * acortan: a oscuras no se distinguen lejos y dibujarlas cuesta lo mismo que las del sol.
   */
  update(dt: number, camera: THREE.Camera, heightAboveGround: number): void {
    this.sky.mesh.position.copy(camera.position);
    this.sky.uniforms.time.value += dt;
    const sh = this.cfg.shadow;
    const h = Math.max(heightAboveGround, 0);
    const split = sh.split + h * sh.splitPerHeight;
    const far = Math.min(sh.far + h * sh.farPerHeight, sh.farMax);
    this.shadow.split = THREE.MathUtils.lerp(split, Math.min(split, sh.night.split), this.night);
    this.shadow.far = THREE.MathUtils.lerp(far, Math.min(far, sh.night.far), this.night);
  }
}
