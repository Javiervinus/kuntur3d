import type { Action, Controls } from '../core/controls';
import type { Character } from '../player/characters';
import { formatMultiplier, type Legend, type LegendItem } from './hud';

/** Lo que la leyenda necesita saber del carro que manejas. */
export interface DrivingLegend {
  canBoost: boolean;
}

/** Un grupo de la lista de controles de la pausa. */
export interface ControlSection {
  title: string;
  items: LegendItem[];
}

/**
 * Leyenda de teclas del HUD: a pie muestra solo lo que el personaje sabe hacer
 * (planear, manejar, cambiar de velocidad…); manejando, los mandos del carro. Abajo, que
 * con la pausa hay más.
 */
export function legendFor(controls: Controls, character: Character, driving: DrivingLegend | null, canSwitch: boolean): Legend {
  const k = (action: Action): string => controls.label(action);
  const item = (text: string, ...actions: Action[]): LegendItem => ({ keys: actions.map(k), text });
  const wasd: Legend['wasd'] = [k('forward'), k('left'), k('back'), k('right')];
  const more = `${k('pause')} pausa y más opciones`;
  if (driving) {
    return {
      wasd,
      items: [
        item('FRENO DE MANO', 'handbrake'),
        ...(driving.canBoost ? [item('EMPUJÓN', 'speedDown', 'speedUp')] : []),
        item('BAJARSE', 'vehicle'),
        item('CÁMARA', 'camera'),
        item('HORA', 'timeOfDay'),
        item('MAPA', 'map'),
        item('ZOOM', 'zoomIn', 'zoomOut'),
      ],
      hint: `${more} · ${k('forward')} acelera · ${k('back')} frena y da reversa · ${k('left')} ${k('right')} giran`,
    };
  }
  const a = character.abilities;
  const items: LegendItem[] = [item('CORRER', 'run'), item('SALTAR', 'jump')];
  if (a.glide) items.push(item('PLANEADOR', 'glide'));
  if (a.drive) items.push(item('CARRO', 'vehicle'));
  if (canSwitch) items.push(item('PERSONAJE', 'character'));
  items.push(item('CÁMARA', 'camera'), item('HORA', 'timeOfDay'));
  if (character.movement.speedMultipliers.length > 1) items.push(item('VELOCIDAD', 'speedDown', 'speedUp'));
  items.push(item('ZOOM', 'zoomIn', 'zoomOut'), item('MAPA', 'map'));
  const climb = a.climb ? ` · camina contra un edificio con ${k('forward')} para treparlo` : '';
  return { wasd, items, hint: `${more}${climb} · clic y arrastra para mirar` };
}

/** Todos los controles, por contexto, para la pestaña de la pausa. */
export function controlSections(controls: Controls, character: Character, canSwitch: boolean): ControlSection[] {
  const k = (action: Action): string => controls.label(action);
  const item = (text: string, ...actions: Action[]): LegendItem => ({ keys: actions.map(k), text });
  const a = character.abilities;
  const speeds = character.movement.speedMultipliers;
  const walk: LegendItem[] = [item('Moverse', 'forward', 'left', 'back', 'right'), item('Correr', 'run'), item('Saltar', 'jump')];
  if (a.climb) walk.push({ keys: [k('forward')], text: 'Contra un edificio: treparlo' });
  if (a.glide) walk.push(item('Abrir o cerrar el planeador', 'glide'));
  if (a.drive) walk.push(item('Subir al carro', 'vehicle'));
  if (speeds.length > 1) {
    const range = `×${formatMultiplier(Math.min(...speeds))} a ×${formatMultiplier(Math.max(...speeds))}`;
    walk.push(item(`Velocidad (${range})`, 'speedDown', 'speedUp'));
  }
  if (canSwitch) walk.push(item('Cambiar de personaje', 'character'));
  const sections: ControlSection[] = [{ title: 'A PIE', items: walk }];
  if (a.drive) {
    sections.push({
      title: 'MANEJANDO',
      items: [
        item('Acelerar · frenar y reversa', 'forward', 'back'),
        item('Girar', 'left', 'right'),
        item('Freno de mano', 'handbrake'),
        item('Empujón', 'speedDown', 'speedUp'),
        item('Bajarse', 'vehicle'),
      ],
    });
  }
  sections.push({
    title: 'SIEMPRE',
    items: [
      item('Primera o tercera persona', 'camera'),
      item('Hora del día', 'timeOfDay'),
      item('Mapa', 'map'),
      item('Acercar o alejar la cámara', 'zoomIn', 'zoomOut'),
      { keys: [...new Set(controls.labels('pause'))], text: 'Pausa' },
    ],
  });
  return sections;
}
