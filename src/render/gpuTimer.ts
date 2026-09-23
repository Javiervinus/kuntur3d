import type * as THREE from 'three';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * Tiempo real de GPU de cada frame (EXT_disjoint_timer_query_webgl2), entre `begin()` y
 * `end()`: cubre todas las pasadas del frame (mundo y cabina). Los resultados llegan unos
 * frames después; no hay medida donde el navegador no expone la extensión (Safari, casi todo
 * Firefox): ahí solo queda el tiempo de frame.
 */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly listeners: ((ms: number) => void)[] = [];
  private open = false;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get available(): boolean {
    return this.ext !== null;
  }

  onSample(listener: (ms: number) => void): void {
    this.listeners.push(listener);
  }

  begin(): void {
    if (!this.ext || this.open) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.pending.push(q);
    this.open = true;
  }

  end(): void {
    if (!this.ext || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.open = false;
    this.poll();
  }

  private poll(): void {
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      // Si la GPU cambió de estado a mitad (disjoint), la medida no vale.
      if (!gl.getParameter(this.ext!.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        for (const fn of this.listeners) fn(ms);
      }
      gl.deleteQuery(q);
    }
  }
}
