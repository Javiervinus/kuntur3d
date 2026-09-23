import type * as THREE from 'three';

/**
 * Mantiene vivos los shaders ya compilados. three.js destruye un programa en cuanto se
 * libera el último material que lo usa, y el streaming libera y crea materiales todo el
 * tiempo: al cruzar una zona sin edificios (el río hacia Durán) se iban todos los de
 * edificios y, al volver, se recompilaban en pleno juego (15–30 ms de tirón). Las variantes
 * del juego son pocas decenas, así que conservarlas cuesta poca memoria.
 */
export class ProgramPin {
  private readonly pinned = new WeakSet<object>();
  private seen = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** Llamar después de cada render: fija los programas que se hayan creado. */
  update(): void {
    const programs = this.renderer.info.programs;
    // Los fijados nunca se liberan, así que la lista solo crece: si no cambió, no hay nuevos.
    if (!programs || programs.length === this.seen) return;
    for (const program of programs) {
      if (this.pinned.has(program)) continue;
      program.usedTimes++;
      this.pinned.add(program);
    }
    this.seen = programs.length;
  }

  get count(): number {
    return this.seen;
  }
}
