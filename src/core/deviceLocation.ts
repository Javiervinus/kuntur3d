import type { GameConfig } from './types';

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;

const ERRORS: Record<number, string> = {
  [PERMISSION_DENIED]: 'No diste permiso de ubicación al navegador',
  // En la Mac la posición sale de las redes Wi-Fi vecinas; a veces el escaneo se queda colgado
  // y abrir el menú de Wi-Fi fuerza uno nuevo.
  [POSITION_UNAVAILABLE]:
    'La Mac no tiene tu posición ahora. Abre el menú de Wi-Fi de la barra superior (eso fuerza un escaneo de ' +
    'redes), espera unos segundos y vuelve a intentar. Si sigue igual: Ajustes del Sistema → Privacidad y ' +
    'seguridad → Localización → activa tu navegador',
  3: 'Se agotó el tiempo buscando tu ubicación (si el navegador pidió permiso, acéptalo y vuelve a intentar)',
};

async function permissionState(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return null;
  }
}

/** Error de ubicación con el código de la API (1 permiso, 2 no disponible, 3 tiempo agotado). */
class LocationError extends Error {
  constructor(
    readonly code: number,
    detail: string,
  ) {
    super(ERRORS[code] ?? detail);
    if (detail && ERRORS[code]) this.message += ` (${detail})`;
  }
}

/**
 * Espera la primera posición durante `timeoutMs`. Usa watchPosition y no getCurrentPosition:
 * en macOS, CoreLocation suele avisar "posición no disponible" mientras todavía está
 * escaneando el Wi-Fi, y una sola consulta se rinde con ese primer aviso.
 */
function firstFix(highAccuracy: boolean, timeoutMs: number, maximumAgeMs: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    let last: GeolocationPositionError | null = null;
    const finish = (): void => {
      window.clearTimeout(timer);
      navigator.geolocation.clearWatch(id);
    };
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        finish();
        resolve(pos);
      },
      (err) => {
        last = err;
        if (err.code === PERMISSION_DENIED) {
          finish();
          reject(new LocationError(err.code, err.message));
        }
      },
      { enableHighAccuracy: highAccuracy, maximumAge: maximumAgeMs },
    );
    const timer = window.setTimeout(() => {
      finish();
      reject(new LocationError(last?.code ?? 3, last?.message ?? ''));
    }, timeoutMs);
  });
}

/**
 * Ubicación actual del dispositivo. Requiere localhost o HTTPS; la primera vez el
 * navegador pide permiso (`onPrompt` avisa para que el HUD lo diga). Si la alta precisión
 * no llega, se reintenta con la precisión normal (Wi-Fi / red).
 */
export async function currentPosition(
  cfg: GameConfig['geolocation'],
  onPrompt: () => void,
): Promise<GeolocationPosition> {
  if (!('geolocation' in navigator)) throw new Error('Este navegador no permite obtener la ubicación');
  if (!window.isSecureContext) {
    throw new Error('La ubicación solo funciona abriendo el juego en localhost o con HTTPS, no por la IP de la red');
  }
  const state = await permissionState();
  if (state === 'denied') {
    throw new Error('La ubicación está bloqueada para este sitio: habilítala desde el candado de la barra de direcciones');
  }
  if (state === 'prompt') onPrompt();
  try {
    return await firstFix(cfg.highAccuracy, cfg.timeoutMs, cfg.maximumAgeMs);
  } catch (err) {
    if (!cfg.highAccuracy || (err instanceof LocationError && err.code === PERMISSION_DENIED)) throw err;
    return firstFix(false, cfg.fallbackTimeoutMs, cfg.maximumAgeMs);
  }
}
