import * as THREE from 'three';

/**
 * Uniformes de iluminación compartidos por todos los materiales del mundo (terreno, edificios,
 * árboles, agua…). Son los mismos objetos en todos los shaders: cambiar la hora del día toca
 * un solo valor y no crea variantes de shader (nada se recompila).
 */
export const lighting = {
  /**
   * Luz propia de la foto satelital (suelo y calles), relativa al mediodía de referencia:
   * la foto ya trae el sol del momento en que se tomó, así que se atenúa y tiñe con la luz
   * de la hora elegida (dorada en la tarde, casi apagada de noche).
   */
  uSelfLight: { value: new THREE.Color(1, 1, 1) },
  /** Fracción de ventanas encendidas (0 de día). */
  uWindowLit: { value: 0 },
  /** Brillo de las ventanas encendidas (0 de día). */
  uWindowGlow: { value: 0 },
  uWindowWarm: { value: new THREE.Color() },
  uWindowCool: { value: new THREE.Color() },
  /** Parte de ventanas con luz fría (LED/fluorescente) en vez de cálida. */
  uWindowCoolShare: { value: 0 },
  /**
   * Hora del mundo (0…24, la de sus relojes): cada local de planta baja abre y cierra según el
   * horario de su tipo (ver render/facade.ts).
   */
  uShopHour: { value: 12 },
  /**
   * Oclusión ambiental (ver world/skyOcclusion.ts): cuánto tapan las copas de los árboles
   * (0 = nada, 1 = como un muro) y cuánto se aplica a la luz del cielo, a la luz propia de la
   * foto satelital y a los reflejos.
   */
  uSkyLook: { value: new THREE.Vector4(0, 0, 0, 0) },
  /**
   * Fachadas: a cuántos metros delante del muro se mira el cielo, cuánto oscurece la base
   * (ganancia y mínimo) y metros por unidad del canal de altura.
   */
  uSkyFacade: { value: new THREE.Vector4(1, 0, 1, 0) },
} satisfies Record<string, THREE.IUniform>;

export type LightingUniforms = typeof lighting;
