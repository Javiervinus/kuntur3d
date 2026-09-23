/**
 * Plus Codes (Open Location Code) — decodificación de códigos completos y cortos.
 * Especificación: https://github.com/google/open-location-code/blob/main/Documentation/Specification/specification.md
 */

const ALPHABET = '23456789CFGHJMPQRVWX';
const SEPARATOR = '+';
const SEPARATOR_POSITION = 8;
const PADDING = '0';
const PAIR_CODE_LENGTH = 10;
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];
const GRID_ROWS = 5;
const GRID_COLUMNS = 4;
const LAT_MAX = 90;
const LNG_MAX = 180;

/** Código corto o completo, p. ej. "RX6H+5PG" o "67W4RX6H+5PG". */
export const PLUS_CODE_PATTERN = new RegExp(`^[${ALPHABET}${PADDING}]{2,8}\\${SEPARATOR}[${ALPHABET}]{0,7}$`, 'i');

export interface LatLon {
  lat: number;
  lon: number;
}

function isValid(code: string): boolean {
  if (!PLUS_CODE_PATTERN.test(code)) return false;
  const sep = code.indexOf(SEPARATOR);
  if (sep % 2 !== 0 || sep > SEPARATOR_POSITION) return false;
  return code.length - sep - 1 !== 1;
}

export function isFull(code: string): boolean {
  return isValid(code) && code.indexOf(SEPARATOR) === SEPARATOR_POSITION;
}

export function isShort(code: string): boolean {
  return isValid(code) && code.indexOf(SEPARATOR) < SEPARATOR_POSITION;
}

/** Centro del área que representa un código completo. */
export function decode(code: string): LatLon {
  if (!isFull(code)) throw new Error(`Plus Code inválido: ${code}`);
  const digits = code.replace(SEPARATOR, '').replace(new RegExp(`${PADDING}+`, 'g'), '').toUpperCase();
  let lat = -LAT_MAX;
  let lon = -LNG_MAX;
  let latRes = PAIR_RESOLUTIONS[0];
  let lonRes = PAIR_RESOLUTIONS[0];
  const pairDigits = Math.min(digits.length, PAIR_CODE_LENGTH);
  for (let i = 0; i < pairDigits; i += 2) {
    const res = PAIR_RESOLUTIONS[i / 2];
    lat += ALPHABET.indexOf(digits[i]) * res;
    latRes = res;
    if (i + 1 < pairDigits) {
      lon += ALPHABET.indexOf(digits[i + 1]) * res;
      lonRes = res;
    }
  }
  for (let i = PAIR_CODE_LENGTH; i < digits.length; i++) {
    const d = ALPHABET.indexOf(digits[i]);
    latRes /= GRID_ROWS;
    lonRes /= GRID_COLUMNS;
    lat += Math.floor(d / GRID_COLUMNS) * latRes;
    lon += (d % GRID_COLUMNS) * lonRes;
  }
  return { lat: lat + latRes / 2, lon: lon + lonRes / 2 };
}

/** Prefijo del código completo de un punto (solo hacen falta los primeros pares). */
function encodePrefix(lat: number, lon: number, length: number): string {
  let la = Math.min(Math.max(lat, -LAT_MAX), LAT_MAX - 1e-9) + LAT_MAX;
  let lo = ((((lon + LNG_MAX) % 360) + 360) % 360);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    const res = PAIR_RESOLUTIONS[i];
    const dLat = Math.floor(la / res);
    const dLon = Math.floor(lo / res);
    la -= dLat * res;
    lo -= dLon * res;
    out += ALPHABET[dLat] + ALPHABET[dLon];
  }
  return out.slice(0, length);
}

/** Completa un código corto con el punto de referencia más cercano (algoritmo recoverNearest). */
export function recoverNearest(shortCode: string, reference: LatLon): string {
  const code = shortCode.toUpperCase();
  if (!isShort(code)) {
    if (isFull(code)) return code;
    throw new Error(`Plus Code inválido: ${shortCode}`);
  }
  const padding = SEPARATOR_POSITION - code.indexOf(SEPARATOR);
  const resolution = Math.pow(20, 2 - padding / 2);
  const half = resolution / 2;
  const full = encodePrefix(reference.lat, reference.lon, padding) + code;
  const center = decode(full);
  let { lat, lon } = center;
  if (reference.lat + half < lat && lat - resolution >= -LAT_MAX) lat -= resolution;
  else if (reference.lat - half > lat && lat + resolution <= LAT_MAX) lat += resolution;
  if (reference.lon + half < lon) lon -= resolution;
  else if (reference.lon - half > lon) lon += resolution;
  const digits = full.replace(SEPARATOR, '');
  return encodePrefix(lat, lon, padding) + digits.slice(padding, SEPARATOR_POSITION) + SEPARATOR + digits.slice(SEPARATOR_POSITION);
}

/** Decodifica un código completo o corto (este último relativo a `reference`). */
export function decodeNearest(code: string, reference: LatLon): LatLon {
  return decode(recoverNearest(code.trim(), reference));
}
