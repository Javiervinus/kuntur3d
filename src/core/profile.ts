import game from '../../config/game.json';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pisa `target` con `overrides` (objetos se mezclan; números, textos y listas se reemplazan).
 * Una clave que no existe en la config es un error de tipeo en el perfil: se avisa en vez de
 * agregarla en silencio.
 */
function merge(target: Json, overrides: Json, path: string): void {
  for (const [key, value] of Object.entries(overrides)) {
    const where = path ? `${path}.${key}` : key;
    if (!(key in target)) throw new Error(`config/game.json → profiles: "${where}" no existe en la config`);
    const current = target[key];
    if (isObject(current) && isObject(value)) merge(current, value, where);
    else target[key] = value;
  }
}

/**
 * Perfiles de config/game.json → `profiles`: cada uno aplica sus `overrides` sobre la config si
 * su media query (`when`) coincide. El de celular baja lo que más memoria usa (resolución,
 * sombras, radios de carga, imagen satelital): Safari en iPhone cierra la pestaña si pasa su
 * límite, que es mucho más bajo que en una computadora.
 *
 * Este módulo se importa primero en main.ts, así el resto del juego ya lee la config ajustada.
 */
export const activeProfiles: string[] = [];
const profiles: Record<string, { when: string; overrides: Json }> = game.profiles;
for (const [name, profile] of Object.entries(profiles)) {
  if (!matchMedia(profile.when).matches) continue;
  merge(game as unknown as Json, profile.overrides, '');
  activeProfiles.push(name);
}
// A la vista para revisar qué perfil corre (y por si el CSS lo necesita).
document.documentElement.dataset.profiles = activeProfiles.join(' ');
