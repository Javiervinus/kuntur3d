/**
 * Contrato de parques y canchas entre el pipeline (pipeline/build_world.py, paso `roads`:
 * listas "p" y "f" de cada chunk), el worker que los rasteriza y el shader del terreno.
 * Mismo orden que PITCH_SPORTS y PITCH_SURFACES del pipeline.
 */

/** Deporte de la cancha: decide qué líneas se pintan. */
export const PITCH_SPORT = { other: 0, soccer: 1, basketball: 2, volleyball: 3, tennis: 4 } as const;

/** Superficie de la cancha; `photo` = sin etiqueta, la decide el color de la foto. */
export const PITCH_SURFACE = { photo: 0, grass: 1, turf: 2, hard: 3, earth: 4, sand: 5 } as const;

/** Código de cancha en la textura: deporte · PITCH_CODE_STRIDE + superficie. */
export const PITCH_CODE_STRIDE = 8;
