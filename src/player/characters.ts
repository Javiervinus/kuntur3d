import type * as THREE from 'three';
import type { CharacterConfig, GameConfig, ModelConfig } from '../core/types';
import { Avatar } from './avatar';

export interface Character extends CharacterConfig {
  id: string;
  modelConfig: ModelConfig;
}

/**
 * Personajes jugables. Cada uno es solo config: modelo, altura, cómo se mueve y qué sabe
 * hacer (trepar, planear, manejar…). Los modelos se descargan la primera vez que se usan
 * y quedan en memoria para cambiar al instante; la elección se recuerda en el navegador.
 */
export class Roster {
  readonly list: Character[];
  private readonly avatars = new Map<string, Promise<Avatar>>();

  constructor(
    private readonly cfg: GameConfig['characters'],
    models: Record<string, ModelConfig>,
    private readonly baseUrl: string,
  ) {
    const roster: Record<string, CharacterConfig> = cfg.roster;
    this.list = Object.entries(roster).map(([id, c]) => {
      const modelConfig = models[c.model];
      if (!modelConfig) throw new Error(`El personaje "${id}" usa el modelo "${c.model}", que no está en config/assets.json`);
      return { ...c, id, modelConfig };
    });
    if (!this.list.length) throw new Error('config/game.json no define personajes (characters.roster)');
  }

  /** El último elegido en este navegador, o el de la config. */
  initial(): Character {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(this.cfg.storageKey);
    } catch {
      // Almacenamiento bloqueado (modo privado, etc.): se usa el de la config.
    }
    return this.get(saved) ?? this.get(this.cfg.default) ?? this.list[0];
  }

  get(id: string | null): Character | undefined {
    return this.list.find((c) => c.id === id);
  }

  after(current: Character): Character {
    return this.list[(this.list.indexOf(current) + 1) % this.list.length];
  }

  remember(character: Character): void {
    try {
      localStorage.setItem(this.cfg.storageKey, character.id);
    } catch {
      // Sin almacenamiento solo se pierde el recuerdo de la elección.
    }
  }

  /** Descarga todos los personajes (en paralelo con el resto de la carga): cambiar es instantáneo. */
  loadAll(): Promise<Avatar[]> {
    return Promise.all(this.list.map((c) => this.avatar(c)));
  }

  /** Compila los shaders de todos los personajes sin trabar la imagen (compilación paralela). */
  async prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<Avatar[]> {
    const avatars = await this.loadAll();
    await Promise.all(avatars.map((a) => renderer.compileAsync(a.root, camera, scene)));
    return avatars;
  }

  avatar(character: Character): Promise<Avatar> {
    let job = this.avatars.get(character.id);
    if (!job) {
      const url = new URL(character.modelConfig.publicUrl, this.baseUrl).href;
      job = Avatar.load(url, character.modelConfig, character.height);
      // Si falla (red), el próximo intento vuelve a descargar.
      job.catch(() => this.avatars.delete(character.id));
      this.avatars.set(character.id, job);
    }
    return job;
  }
}
