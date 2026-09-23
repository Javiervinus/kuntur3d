import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AvatarState, ModelConfig } from '../core/types';
import { addNightLight } from '../render/nightLight';
import { applyOutfit } from './outfit';

/** Si un modelo no trae clip para un estado, usa el de este otro. */
const FALLBACK: Partial<Record<AvatarState, AvatarState>> = {
  swimIdle: 'idle',
  drive: 'idle',
  climb: 'walk',
  swim: 'walk',
  glide: 'idle',
  run: 'walk',
  jump: 'idle',
};

/** Escala que encoge la cabeza hasta desaparecer sin matrices degeneradas (con 0 no se pueden invertir). */
const HIDDEN_SCALE = 1e-4;

/** Personaje animado. `root` está en los pies y mira hacia -z con rotación 0. */
export class Avatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<AvatarState, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentState: AvatarState | null = null;
  private readonly head: THREE.Object3D | null;

  private constructor(
    model: THREE.Object3D,
    clips: THREE.AnimationClip[],
    readonly cfg: ModelConfig,
    readonly height: number,
  ) {
    const stature = (cfg.statureNode && model.getObjectByName(cfg.statureNode)) || model;
    const box = new THREE.Box3().setFromObject(stature);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(height / Math.max(size.y, 1e-3));
    model.position.y = -box.min.y * model.scale.y;
    model.rotation.y = THREE.MathUtils.degToRad(cfg.yawOffsetDeg);
    const tints = cfg.tints ?? {};
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Con un solo personaje en pantalla no vale la pena calcular su caja animada.
      mesh.frustumCulled = false;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const tint = tints[m.name];
        if (tint) (m as THREE.MeshStandardMaterial).color.set(tint);
      }
    });
    if (cfg.outfit) applyOutfit(model, cfg.outfit);
    addNightLight(model);
    this.body.add(model);
    this.root.add(this.body);
    this.root.name = 'avatar';
    this.head = cfg.headBone ? (model.getObjectByName(cfg.headBone) ?? null) : null;
    if (cfg.headBone && !this.head) console.warn(`[avatar] no existe el hueso "${cfg.headBone}"`);

    this.mixer = new THREE.AnimationMixer(model);
    const byClip = new Map<string, THREE.AnimationAction>();
    for (const [state, clipName] of Object.entries(cfg.animations) as [AvatarState, string][]) {
      let action = byClip.get(clipName);
      if (!action) {
        const clip = THREE.AnimationClip.findByName(clips, clipName);
        if (!clip) {
          console.warn(`[avatar] falta la animación "${clipName}"`);
          continue;
        }
        action = this.mixer.clipAction(clip);
        byClip.set(clipName, action);
      }
      if (cfg.loopOnce.includes(state)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(state, action);
    }
  }

  static async load(url: string, cfg: ModelConfig, height: number): Promise<Avatar> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new Avatar(gltf.scene, gltf.animations, cfg, height);
  }

  private resolve(state: AvatarState): [AvatarState, THREE.AnimationAction] | null {
    for (let s: AvatarState | undefined = state; s; s = FALLBACK[s]) {
      const action = this.actions.get(s);
      if (action) return [s, action];
    }
    return null;
  }

  /**
   * Cambia de animación con fundido. `speed` (m/s) ajusta el ritmo de los clips que tienen
   * `strideSpeed` para que los pasos coincidan con lo que avanza el personaje.
   */
  play(state: AvatarState, speed = 0, fade = 0.2): void {
    const found = this.resolve(state);
    if (!found) return;
    const [resolved, next] = found;
    // Con `strideSpeed`, el ritmo sigue a la velocidad real (quieto = pose congelada, p. ej. colgado
    // del muro), hasta `maxStrideRate`: con los multiplicadores de velocidad las piernas no se aceleran más.
    const stride = this.cfg.strideSpeed?.[resolved];
    const rate = stride ? Math.min(speed / stride, this.cfg.maxStrideRate ?? Infinity) : (this.cfg.animationSpeed[resolved] ?? 1);
    const pose = this.cfg.poses[state];
    this.body.position.y = pose ? pose.rise * this.height : 0;
    this.currentState = state;
    if (next === this.current) {
      next.setEffectiveTimeScale(rate);
      return;
    }
    next.reset().setEffectiveTimeScale(rate).setEffectiveWeight(1).fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  get state(): AvatarState | null {
    return this.currentState;
  }

  /** ¿Se puede ver el cuerpo en primera persona? (hace falta poder ocultar la cabeza, que tapa los ojos). */
  get hasHead(): boolean {
    return this.head !== null;
  }

  /** Oculta la cabeza (primera persona con el cuerpo a la vista); la animación no toca la escala. */
  setHeadHidden(hidden: boolean): void {
    this.head?.scale.setScalar(hidden ? HIDDEN_SCALE : 1);
  }

  /** Inclina el cuerpo (p. ej. acostado bajo el ala del planeador). */
  setLean(pitchRad: number, rollRad: number): void {
    this.body.rotation.set(pitchRad, 0, rollRad);
  }

  /** Inclinación configurada para un estado (0 si no tiene). */
  posePitch(state: AvatarState): number {
    return THREE.MathUtils.degToRad(this.cfg.poses[state]?.pitchDeg ?? 0);
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    });
  }
}
