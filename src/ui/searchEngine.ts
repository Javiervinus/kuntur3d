import type { GameConfig } from '../core/types';

/** Lugar destacado del buscador: los del panel y los lugares con ficha (ver searchLandmarks en ui/places.ts). */
export interface SearchLandmark {
  name: string;
  /** Punto de llegada. */
  x: number;
  z: number;
  /** Otros nombres con los que se encuentra (el del lugar del panel en que se basa una ficha). */
  alt?: string[];
  /** Qué es ("Noria · Malecón 2000"); si no lo trae, `labels.landmark`. */
  detail?: string;
}

/**
 * Motor del buscador: corre en src/ui/searchWorker.ts (fuera del hilo principal) sobre el índice
 * del paso `search` del pipeline (public/world/search.json) más los lugares destacados (los del
 * panel y los lugares con ficha, ver SearchLandmark).
 *
 * - Todo se compara normalizado (minúsculas, sin tildes, "av" = "avenida", "diez" = "10", "1ro" =
 *   "1"; tablas en config/region.json → search.text, las mismas que usa el pipeline).
 * - Diccionario ordenado de palabras: lo que se está escribiendo es un rango de ese diccionario
 *   (las palabras que empiezan así) y cada palabra sabe en qué nombres aparece. Se parte de la
 *   palabra escrita que aparece en menos nombres y se verifica el resto: cada tecla cuesta poco
 *   aunque haya decenas de miles de nombres.
 * - Coincidencias, de mejor a peor: nombre idéntico, empieza igual (sin contar el tipo de vía ni
 *   las palabras vacías: "9 oct" encuentra "Boulevard 9 de Octubre"), la categoría ("farmacia" son
 *   todas las farmacias), la frase más adentro del nombre, las palabras en orden, en cualquier
 *   orden, el nombre más su barrio o categoría ("kfc alborada") y, si hay pocos resultados,
 *   subcadenas y errores de tipeo: letras de más, de menos, cambiadas o al revés, comparando cómo
 *   suenan ("bernasa" = "Vernaza", "rio sentro" = "Riocentro").
 * - "9 de Octubre y Boyacá": los cruces de las calles de un lado con las del otro.
 * - Puntaje: coincidencia + tipo (lugares icónicos y barrios antes que negocios) + importancia −
 *   distancia al jugador en escala logarítmica (desempata, no manda). Pesos en config/game.json.
 */

export type SearchConfig = GameConfig['search'];
export type ResultKind = 'landmark' | 'area' | 'street' | 'crossing' | 'place';

export interface SearchResult {
  kind: ResultKind;
  name: string;
  /** Tramos [inicio, fin) del nombre que calzan con lo escrito (se resaltan). */
  marks: [number, number][];
  detail: string;
  /** Ícono: el tipo de resultado o, en negocios y lugares, el grupo de su categoría. */
  icon: string;
  /** Punto de llegada (caminable) en el marco local. */
  x: number;
  z: number;
  /** Metros desde el jugador. */
  distance: number;
}

/** Normalización (config/region.json → search.text). */
export interface TextConfig {
  symbols: Record<string, string>;
  abbreviations: Record<string, string>;
  numbers: Record<string, string>;
  romans: Record<string, string>;
  ordinalSuffixes: string[];
  stopwords: string[];
  streetTypes: string[];
  /** Tipos de vía que valen lo mismo ("avenida" = "boulevard"; "calle" ≠ "avenida"). */
  streetTypeGroups: string[][];
  codeTokens: string[];
  separators: string[];
  /** Reemplazos en orden para comparar por cómo suena ("bernasa" = "vernaza"), solo en la segunda pasada. */
  phonetic: [string, string][];
}

/**
 * public/world/search.json (step_search en pipeline/build_world.py): columnas; los textos, un
 * nombre por línea (los alternativos de cada uno separados por "|"); las coordenadas, enteras en
 * `unit` m y, como las columnas a, b de los cruces, cada una como diferencia con la anterior.
 */
export interface SearchIndexData {
  version: number;
  unit: number;
  text: TextConfig;
  /** Nombre, grupo de ícono, peso (0-100) y alias ("a|b") de cada categoría; la última es la de respaldo. */
  categories: [string, string, number, string][];
  streetKinds: string[];
  areaKinds: string[];
  areas: { name: string; label: string; kind: number[]; rank: number[]; parent: number[]; x: number[]; z: number[] };
  streets: {
    name: string;
    alt: string;
    kind: number[];
    rank: number[];
    /** Cuántos puntos tiene cada calle (seguidos en x, z, area). */
    count: number[];
    x: number[];
    z: number[];
    area: number[];
  };
  crossings: { a: number[]; b: number[]; x: number[]; z: number[]; area: number[] };
  places: { name: string; alt: string; cat: number[]; rank: number[]; area: number[]; x: number[]; z: number[] };
}

type Tier = keyof SearchConfig['ranking']['tiers'];

// Tipos de entrada del índice (los cruces van aparte: no tienen nombre propio).
const LANDMARK = 0;
const AREA = 1;
const STREET = 2;
const PLACE = 3;
const KINDS: ResultKind[] = ['landmark', 'area', 'street', 'place'];

// Cómo calza una palabra del diccionario con una escrita.
const NONE = 0;
const LOOSE = 1;
const PREFIX = 2;
const EXACT = 3;

// Dónde calzó una palabra que no está en el nombre (context()), más LOOSELY si fue aflojada y
// BY_ALIAS si fue con un alias de la categoría ("catedral"), no con su nombre ("iglesia").
const IN_AREA = 1;
const IN_CATEGORY = 2;
const LOOSELY = 4;
const BY_ALIAS = 8;

const COMBINING = /[\u0300-\u036f]/g;
const SPLIT = /[^0-9a-z]+/;
const WORD = /[\p{L}\p{N}]+/gu;
/** Mayor que cualquier letra o cifra: [p, p + END) son las palabras que empiezan con p. */
const END = '\u007f';

/** Normalización de config/region.json → search.text; la misma que SearchText en el pipeline. */
export class Normalizer {
  private readonly symbols: [string, string][];
  private readonly words: Map<string, string>;
  private readonly abbreviations: Map<string, string[]>;
  private readonly ordinal: RegExp;
  private readonly sounds: [string, string][];

  constructor(cfg: TextConfig) {
    this.sounds = cfg.phonetic;
    this.symbols = Object.entries(cfg.symbols);
    this.words = new Map([...Object.entries(cfg.numbers), ...Object.entries(cfg.romans)]);
    this.abbreviations = new Map(Object.entries(cfg.abbreviations).map(([k, v]) => [k, v.split(' ')]));
    this.ordinal = new RegExp(`^(\\d+)(?:${cfg.ordinalSuffixes.join('|')})$`);
  }

  tokens(text: string): string[] {
    let t = text;
    // Con palabra vacía el signo se borra sin cortar ("McDonald's" = "mcdonalds").
    for (const [symbol, word] of this.symbols) t = t.split(symbol).join(word ? ` ${word} ` : '');
    const plain = t.toLowerCase().normalize('NFD').replace(COMBINING, '');
    const out: string[] = [];
    for (const raw of plain.split(SPLIT)) {
      if (!raw) continue;
      let tok = this.words.get(raw) ?? raw;
      const ordinal = this.ordinal.exec(tok);
      if (ordinal) tok = ordinal[1];
      const expansion = this.abbreviations.get(tok);
      if (expansion) out.push(...expansion);
      else out.push(tok);
    }
    return out;
  }

  /** Cómo suena una palabra ya normalizada (b = v, z = s, "ce" = "se", la h muda…). */
  phonetic(word: string): string {
    let out = word;
    for (const [from, to] of this.sounds) out = out.split(from).join(to);
    return out;
  }
}

/** Una palabra escrita: las del diccionario que empiezan así son [lo, hi); `exact`, la idéntica. */
interface Term {
  text: string;
  lo: number;
  hi: number;
  exact: number;
  /** Palabra vacía ("de", "la"): no hace falta que esté. */
  optional: boolean;
  /** Tipo de vía ("avenida", "calle"): al comienzo se puede saltar. */
  type: boolean;
  /** Segunda pasada: palabras que la contienen o que están a pocas letras (1 = calza). */
  loose: Uint8Array | null;
  /** Qué encontró la segunda pasada: la subcadena o errores de tipeo. */
  looseTier: Tier;
}

/** Puntaje de texto de un nombre (sin tipo, importancia ni distancia) y su nivel de coincidencia. */
interface TextScore {
  score: number;
  tier: Tier;
}

/** Un candidato ya puntuado. */
interface Hit {
  score: number;
  kind: ResultKind;
  /** Entrada del índice o, en los cruces, el cruce. */
  id: number;
  /** Nombre alternativo que calzó (-1: el principal). */
  alt: number;
  /** Punto de llegada, distancia y barrio (en las calles, los del punto más cercano al jugador). */
  x: number;
  z: number;
  distance: number;
  area: number;
  /** Cruces: las dos calles, en el orden en que se escribieron. */
  a: number;
  b: number;
}

/** Los `size` mejores puntajes (montículo de mínimos). */
class TopHits {
  readonly items: Hit[] = [];
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  get floor(): number {
    return this.items.length < this.size ? -Infinity : this.items[0].score;
  }

  push(hit: Hit): void {
    const a = this.items;
    let i: number;
    if (a.length < this.size) {
      a.push(hit);
      i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].score <= a[i].score) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
      return;
    }
    if (hit.score <= a[0].score) return;
    a[0] = hit;
    i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && a[l].score < a[m].score) m = l;
      if (r < a.length && a[r].score < a[m].score) m = r;
      if (m === i) break;
      [a[m], a[i]] = [a[i], a[m]];
      i = m;
    }
  }
}

/**
 * Distancia de edición entre `a` y `b` si es ≤ `max` (si no, algo mayor): letras de más, de menos,
 * cambiadas o dos vecinas al revés ("centrla" = "central"), cada una un error. Con `prefix`, contra
 * el comienzo de `b` que más se le parezca (lo que se está escribiendo: "kenedy" ≈ "kennedy").
 */
function editDistance(a: string, b: string, max: number, prefix: boolean): number {
  if (b.length < a.length - max || (!prefix && b.length > a.length + max)) return max + 1;
  // Un comienzo más largo que `a` + `max` ya no puede estar a `max` o menos.
  const n = prefix ? Math.min(b.length, a.length + max) : b.length;
  if (editRows[0].length <= n) editRows = editRows.map(() => new Int32Array(2 * (n + 1)));
  // Filas i - 2, i - 1 e i de la tabla (la i - 2, para las vecinas al revés).
  let [before, prev, cur] = editRows;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    cur[0] = i;
    let rowBest = i;
    for (let j = 1; j <= n; j++) {
      const cb = b.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
      const swapped = i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb;
      if (swapped) v = Math.min(v, before[j - 2] + 1);
      cur[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    [before, prev, cur] = [prev, cur, before];
  }
  if (!prefix) return prev[n];
  let best = prev[0];
  for (let j = 1; j <= n; j++) best = Math.min(best, prev[j]);
  return best;
}

/** Filas de trabajo de editDistance: se reusan, porque se llama miles de veces por consulta. */
let editRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

/** Columna en diferencias → valores (por `scale`). */
function undelta(values: number[], scale: number): Float64Array {
  const out = new Float64Array(values.length);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    out[i] = acc * scale;
  }
  return out;
}

/** Líneas de una columna de texto de `count` filas. */
function lines(text: string, count: number): string[] {
  return count === 0 ? [] : text.split('\n');
}

/** Filas de largo variable en dos arreglos: la fila i es items[start[i]..start[i + 1]). */
function packed(rows: number[][]): { start: Uint32Array; items: Uint32Array } {
  const start = new Uint32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) start[i + 1] = start[i] + rows[i].length;
  const items = new Uint32Array(start[rows.length]);
  for (let i = 0; i < rows.length; i++) items.set(rows[i], start[i]);
  return { start, items };
}

function sortedUnique(row: number[]): number[] {
  return [...new Set(row)].sort((a, b) => a - b);
}

export class SearchEngine {
  private readonly cfg: SearchConfig;
  private readonly norm: Normalizer;

  // Diccionario ordenado; por palabra, sus banderas y los nombres donde aparece.
  private readonly dict: string[];
  /** Cómo suena cada palabra del diccionario (para los errores de tipeo). */
  private readonly sound: string[];
  private readonly optionalWord: Uint8Array;
  private readonly typeWord: Uint8Array;
  /** Grupo de cada tipo de vía (-1 si no es uno o no tiene grupo). */
  private readonly typeGroup: Int16Array;
  private readonly separators: Set<string>;
  private readonly postStart: Uint32Array;
  private readonly post: Uint32Array;

  // Nombres: el principal de cada entrada y sus alternativos, como palabras del diccionario.
  private readonly nameEntry: Uint32Array;
  /** Cuál alternativo de su entrada es (-1: el principal). */
  private readonly nameAlt: Int32Array;
  private readonly nameTokStart: Uint32Array;
  private readonly nameTok: Uint32Array;
  private readonly entryNameStart: Uint32Array;

  // Entradas: lugares del panel, áreas, calles y negocios, seguidos.
  private readonly entryKind: Uint8Array;
  private readonly entryRef: Uint32Array;
  private readonly entryRank: Float32Array;
  private readonly base: number[];

  private readonly landmarks: SearchLandmark[];
  private readonly areaName: string[];
  private readonly areaLabel: string[];
  private readonly areaKind: number[];
  private readonly areaParent: number[];
  private readonly areaX: Float64Array;
  private readonly areaZ: Float64Array;
  private readonly areaKinds: string[];
  /** Palabras (ordenadas) del nombre de cada área y de las que la contienen: "kfc alborada". */
  private readonly areaCtxStart: Uint32Array;
  private readonly areaCtx: Uint32Array;

  private readonly streetName: string[];
  private readonly streetAlt: string[][];
  private readonly streetKind: number[];
  private readonly streetKinds: string[];
  private readonly sampleStart: Uint32Array;
  private readonly sampleX: Float64Array;
  private readonly sampleZ: Float64Array;
  private readonly sampleArea: Int32Array;

  private readonly crossA: Uint32Array;
  private readonly crossB: Uint32Array;
  private readonly crossX: Float64Array;
  private readonly crossZ: Float64Array;
  private readonly crossArea: Int32Array;
  /** Cruces de cada calle. */
  private readonly adjStart: Uint32Array;
  private readonly adj: Uint32Array;

  private readonly placeName: string[];
  private readonly placeAlt: string[][];
  private readonly placeCat: number[];
  private readonly placeArea: number[];
  private readonly placeX: Float64Array;
  private readonly placeZ: Float64Array;
  private readonly categories: SearchIndexData['categories'];
  /** Palabras (ordenadas) del nombre y los alias de cada categoría, las del nombre solo y sus negocios. */
  private readonly catTokStart: Uint32Array;
  private readonly catTok: Uint32Array;
  private readonly labelTokStart: Uint32Array;
  private readonly labelTok: Uint32Array;
  private readonly catEntStart: Uint32Array;
  private readonly catEnt: Uint32Array;

  /** Marca, por consulta, de las entradas ya evaluadas. */
  private readonly seen: Uint32Array;
  private pass = 0;

  constructor(data: SearchIndexData, landmarks: SearchLandmark[], cfg: SearchConfig) {
    this.cfg = cfg;
    this.norm = new Normalizer(data.text);
    this.landmarks = landmarks;
    const unit = data.unit;
    const { areas: A, streets: S, crossings: C, places: P } = data;

    this.areaName = lines(A.name, A.kind.length);
    this.areaLabel = lines(A.label, A.kind.length);
    this.areaKind = A.kind;
    this.areaParent = A.parent;
    this.areaX = undelta(A.x, unit);
    this.areaZ = undelta(A.z, unit);
    this.areaKinds = data.areaKinds;
    this.streetName = lines(S.name, S.kind.length);
    this.streetAlt = lines(S.alt, S.kind.length).map((l) => (l ? l.split('|') : []));
    this.streetKind = S.kind;
    this.streetKinds = data.streetKinds;
    this.sampleStart = new Uint32Array(S.count.length + 1);
    for (let i = 0; i < S.count.length; i++) this.sampleStart[i + 1] = this.sampleStart[i] + S.count[i];
    this.sampleX = undelta(S.x, unit);
    this.sampleZ = undelta(S.z, unit);
    this.sampleArea = Int32Array.from(S.area);
    this.crossA = Uint32Array.from(undelta(C.a, 1));
    this.crossB = Uint32Array.from(undelta(C.b, 1));
    this.crossX = undelta(C.x, unit);
    this.crossZ = undelta(C.z, unit);
    this.crossArea = Int32Array.from(C.area);
    this.placeName = lines(P.name, P.cat.length);
    this.placeAlt = lines(P.alt, P.cat.length).map((l) => (l ? l.split('|') : []));
    this.placeCat = P.cat;
    this.placeArea = P.area;
    this.placeX = undelta(P.x, unit);
    this.placeZ = undelta(P.z, unit);
    this.categories = data.categories;

    // Entradas en orden: lugares del panel, áreas, calles y negocios.
    const nL = landmarks.length;
    const nA = this.areaName.length;
    const nS = this.streetName.length;
    const nP = this.placeName.length;
    this.base = [0, nL, nL + nA, nL + nA + nS];
    const E = nL + nA + nS + nP;
    this.entryKind = new Uint8Array(E);
    this.entryRef = new Uint32Array(E);
    this.entryRank = new Float32Array(E);
    const fill = (kind: number, count: number, rank: (i: number) => number): void => {
      for (let i = 0; i < count; i++) {
        const e = this.base[kind] + i;
        this.entryKind[e] = kind;
        this.entryRef[e] = i;
        this.entryRank[e] = rank(i);
      }
    };
    fill(LANDMARK, nL, () => cfg.ranking.landmarkImportance);
    fill(AREA, nA, (i) => A.rank[i] / 100);
    fill(STREET, nS, (i) => S.rank[i] / 100);
    fill(PLACE, nP, (i) => P.rank[i] / 100);

    // Palabras de todo: nombres, alternativos, categorías y áreas (numeradas al aparecer).
    const ids = new Map<string, number>();
    const words: string[] = [];
    const tokenize = (text: string): number[] =>
      this.norm.tokens(text).map((w) => {
        let id = ids.get(w);
        if (id === undefined) {
          id = words.length;
          ids.set(w, id);
          words.push(w);
        }
        return id;
      });
    const names: number[][] = [];
    const nameEntry: number[] = [];
    const nameAlt: number[] = [];
    this.entryNameStart = new Uint32Array(E + 1);
    const addNames = (e: number, primary: string, alts: string[]): void => {
      this.entryNameStart[e] = names.length;
      [primary, ...alts].forEach((name, k) => {
        names.push(tokenize(name));
        nameEntry.push(e);
        nameAlt.push(k - 1);
      });
    };
    for (let i = 0; i < nL; i++) addNames(this.base[LANDMARK] + i, landmarks[i].name, landmarks[i].alt ?? []);
    for (let i = 0; i < nA; i++) addNames(this.base[AREA] + i, this.areaName[i], []);
    for (let i = 0; i < nS; i++) addNames(this.base[STREET] + i, this.streetName[i], this.streetAlt[i]);
    for (let i = 0; i < nP; i++) addNames(this.base[PLACE] + i, this.placeName[i], this.placeAlt[i]);
    this.entryNameStart[E] = names.length;
    const catWords = data.categories.map(([label, , , aliases]) =>
      [label, ...(aliases ? aliases.split('|') : [])].flatMap(tokenize),
    );
    const areaWords = this.areaName.map(tokenize);

    // Diccionario ordenado: se renumera todo.
    const order = words.map((_, i) => i).sort((a, b) => (words[a] < words[b] ? -1 : words[a] > words[b] ? 1 : 0));
    const renumber = new Uint32Array(words.length);
    order.forEach((old, i) => (renumber[old] = i));
    this.dict = order.map((i) => words[i]);
    this.sound = this.dict.map((w) => this.norm.phonetic(w));
    const remap = (row: number[]): number[] => row.map((t) => renumber[t]);
    const nameRows = names.map(remap);
    const flag = (list: string[]): Uint8Array => {
      const out = new Uint8Array(this.dict.length);
      for (const w of list) {
        const id = ids.get(w);
        if (id !== undefined) out[renumber[id]] = 1;
      }
      return out;
    };
    this.optionalWord = flag(data.text.stopwords);
    this.typeWord = flag(data.text.streetTypes);
    this.typeGroup = new Int16Array(this.dict.length).fill(-1);
    data.text.streetTypeGroups.forEach((group, g) => {
      for (const w of group) {
        const id = ids.get(w);
        if (id !== undefined) this.typeGroup[renumber[id]] = g;
      }
    });
    this.separators = new Set(data.text.separators);

    const nameRowsPacked = packed(nameRows);
    this.nameTokStart = nameRowsPacked.start;
    this.nameTok = nameRowsPacked.items;
    this.nameEntry = Uint32Array.from(nameEntry);
    this.nameAlt = Int32Array.from(nameAlt);

    // Nombres donde aparece cada palabra (contiguos por palabra: un prefijo es un tramo seguido).
    const postings: number[][] = this.dict.map(() => []);
    nameRows.forEach((row, n) => {
      for (const t of new Set(row)) postings[t].push(n);
    });
    const postPacked = packed(postings);
    this.postStart = postPacked.start;
    this.post = postPacked.items;

    const cats = packed(catWords.map((row) => sortedUnique(remap(row))));
    this.catTokStart = cats.start;
    this.catTok = cats.items;
    const labels = packed(data.categories.map(([label]) => sortedUnique(remap(tokenize(label)))));
    this.labelTokStart = labels.start;
    this.labelTok = labels.items;
    const byCategory: number[][] = data.categories.map(() => []);
    for (let i = 0; i < nP; i++) byCategory[P.cat[i]]?.push(this.base[PLACE] + i);
    const catEnt = packed(byCategory);
    this.catEntStart = catEnt.start;
    this.catEnt = catEnt.items;

    // Contexto de cada área: su nombre y el de las que la contienen.
    const context = this.areaName.map((_, a) => {
      const row: number[] = [];
      for (let k = a, depth = 0; k >= 0 && depth < nA; k = this.areaParent[k], depth++) row.push(...areaWords[k]);
      return sortedUnique(remap(row));
    });
    const areaCtx = packed(context);
    this.areaCtxStart = areaCtx.start;
    this.areaCtx = areaCtx.items;

    const adjacency: number[][] = this.streetName.map(() => []);
    for (let c = 0; c < this.crossA.length; c++) {
      adjacency[this.crossA[c]].push(c);
      adjacency[this.crossB[c]].push(c);
    }
    const adj = packed(adjacency);
    this.adjStart = adj.start;
    this.adj = adj.items;

    this.seen = new Uint32Array(E);
  }

  get counts(): Record<string, number> {
    return {
      landmarks: this.landmarks.length,
      areas: this.areaName.length,
      streets: this.streetName.length,
      crossings: this.crossA.length,
      places: this.placeName.length,
      words: this.dict.length,
    };
  }

  search(text: string, px: number, pz: number, limit: number): SearchResult[] {
    const words = this.norm.tokens(text);
    if (!words.length) return [];
    const open = !/\s$/.test(text);
    const terms = words.map((w) => this.term(w));
    const required = this.required(terms);
    const top = new TopHits(limit * this.cfg.candidatesPerResult);
    this.collect(terms, required, px, pz, top);
    this.crossings(terms, open, px, pz, top);
    if (top.items.length < limit) {
      // Pocos resultados: subcadenas y errores de tipeo, con menos puntaje que lo anterior. La última
      // palabra, si no hay un espacio después, se está escribiendo: se compara con los comienzos.
      const typing = (i: number): boolean => open && i === terms.length - 1;
      this.loosen(terms, typing);
      if (terms.some((t) => t.loose)) {
        this.collect(terms, required, px, pz, top);
        this.crossings(terms, open, px, pz, top);
      }
      // Y dos palabras seguidas como una sola: "mc donalds" es "McDonald's"; "rio sentro", "Riocentro"
      // (juntas solo valen si suenan igual: con errores, "hospita luis" sería "hospitales").
      for (let i = 0; i + 1 < words.length; i++) {
        const pair = this.term(words[i] + words[i + 1]);
        if (pair.exact < 0) this.loosenWith(pair, typing(i + 1), true);
        const joined = [...terms.slice(0, i), pair, ...terms.slice(i + 2)];
        this.collect(joined, this.required(joined), px, pz, top);
      }
      // También puede estar mal escrita una palabra que existe ("burguer" por "burger"; "sanborondon"
      // aparece en un solo nombre). Se afloja una a la vez (lo normal es un solo error) y las demás
      // tienen que estar tal cual en el nombre: "kfc alborada" no es cualquier "CF" de la Alborada.
      if (top.items.length < limit) {
        terms.forEach((t, i) => {
          if (t.exact < 0) return;
          const one = terms.map((u) => ({ ...u, loose: null }));
          if (!this.loosenWith(one[i], typing(i))) return;
          this.collect(one, required, px, pz, top, false);
          this.crossings(one, open, px, pz, top);
        });
      }
    }
    return this.finish(top, words, limit);
  }

  /** Primera palabra del diccionario ≥ `w`. */
  private lowerBound(w: string): number {
    let lo = 0;
    let hi = this.dict.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dict[mid] < w) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private term(text: string): Term {
    const lo = this.lowerBound(text);
    const hi = this.lowerBound(text + END);
    const exact = lo < hi && this.dict[lo] === text ? lo : -1;
    return {
      text,
      lo,
      hi,
      exact,
      optional: exact >= 0 && this.optionalWord[exact] === 1,
      type: exact >= 0 && this.typeWord[exact] === 1,
      loose: null,
      looseTier: 'substring',
    };
  }

  /** Palabras que tienen que estar: todas menos las vacías (salvo que no haya otras). */
  private required(terms: Term[]): number[] {
    const idx = terms.map((_, i) => i).filter((i) => !terms[i].optional);
    return idx.length ? idx : terms.map((_, i) => i);
  }

  private hit(term: Term, t: number): number {
    if (t === term.exact) return EXACT;
    if (t >= term.lo && t < term.hi) return PREFIX;
    return term.loose !== null && term.loose[t] === 1 ? LOOSE : NONE;
  }

  /** Cómo calza `term` con alguna palabra de items[from..to) (ordenadas): PREFIX, LOOSE o NONE. */
  private hasWord(items: Uint32Array, from: number, to: number, term: Term): number {
    let lo = from;
    let hi = to;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid] < term.lo) lo = mid + 1;
      else hi = mid;
    }
    if (lo < to && items[lo] < term.hi) return PREFIX;
    if (term.loose === null) return NONE;
    for (let i = from; i < to; i++) if (term.loose[items[i]] === 1) return LOOSE;
    return NONE;
  }

  private inArea(area: number, term: Term): number {
    return area >= 0 ? this.hasWord(this.areaCtx, this.areaCtxStart[area], this.areaCtxStart[area + 1], term) : NONE;
  }

  /** ¿La palabra escrita está en la categoría o el barrio de la entrada? IN_CATEGORY o IN_AREA (+ LOOSELY), o 0. */
  private context(e: number, term: Term): number {
    const where = (place: number, how: number): number => (how === NONE ? 0 : place | (how === LOOSE ? LOOSELY : 0));
    const ref = this.entryRef[e];
    switch (this.entryKind[e]) {
      case PLACE: {
        const c = this.placeCat[ref];
        const category = this.hasWord(this.catTok, this.catTokStart[c], this.catTokStart[c + 1], term);
        if (category !== NONE) {
          const label = this.hasWord(this.labelTok, this.labelTokStart[c], this.labelTokStart[c + 1], term);
          return where(IN_CATEGORY, category) | (label === NONE ? BY_ALIAS : 0);
        }
        return where(IN_AREA, this.inArea(this.placeArea[ref], term));
      }
      case STREET: {
        let best = NONE;
        for (let s = this.sampleStart[ref]; s < this.sampleStart[ref + 1] && best !== PREFIX; s++) {
          best = Math.max(best, this.inArea(this.sampleArea[s], term));
        }
        return where(IN_AREA, best);
      }
      case AREA:
        return where(IN_AREA, this.inArea(this.areaParent[ref], term));
      default:
        return 0;
    }
  }

  /**
   * ¿Lo escrito calza seguido desde la palabra `s` del nombre? Las palabras vacías de cualquiera
   * de los dos lados se pueden saltar ("9 octubre" = "9 de Octubre"). Devuelve cuántas calzaron
   * idénticas, si se llegó al final del nombre, si alguna calzó aflojada y cuántas palabras
   * completas calzaron solo con el comienzo de otra (ver `partial`), o null.
   */
  private runFrom(
    from: number,
    m: number,
    s: number,
    terms: Term[],
    q0: number,
  ): [number, boolean, boolean, number] | null {
    const tok = this.nameTok;
    let j = s;
    let exact = 0;
    let partial = 0;
    let loose = false;
    let i = q0;
    while (i < terms.length) {
      const h = j < m ? this.hit(terms[i], tok[from + j]) : NONE;
      if (h !== NONE) {
        if (h === EXACT) exact++;
        if (h === LOOSE) loose = true;
        if (h === PREFIX && this.partial(terms[i])) partial++;
        i++;
        j++;
      } else if (j < m && this.optionalWord[tok[from + j]] === 1) j++;
      else if (terms[i].optional) i++;
      else return null;
    }
    while (j < m && this.optionalWord[tok[from + j]] === 1) j++;
    return [exact, j === m, loose, partial];
  }

  /**
   * ¿Es una palabra que ya existe entera (y no es corta)? Entonces que en un nombre solo calce con
   * el comienzo de otra ("espol" en "Espoltel") vale menos que encontrarla tal cual ("ESPOL").
   */
  private partial(term: Term): boolean {
    return term.exact >= 0 && term.text.length >= this.cfg.ranking.partialMinLength;
  }

  /**
   * Puntaje de texto de un nombre, o null si no calza. `useContext`: las palabras que no están
   * en el nombre pueden estar en la categoría o el barrio de la entrada.
   */
  private scoreName(n: number, e: number, terms: Term[], required: number[], useContext: boolean): TextScore | null {
    const w = this.cfg.ranking;
    const from = this.nameTokStart[n];
    const m = this.nameTokStart[n + 1] - from;
    const tok = this.nameTok;
    const significant = (): number => {
      let count = 0;
      for (let j = 0; j < m; j++) if (this.optionalWord[tok[from + j]] === 0) count++;
      return count;
    };
    const finish = (tier: Tier, exact: number, matched: number, loose: boolean, partial: number): TextScore => {
      const t: Tier = loose ? this.looseTier(terms) : tier;
      const extra = Math.max(0, significant() - matched);
      // Aflojada, vale lo de su nivel más una parte de cómo calzó: "Burger King" por "burguer king"
      // va antes que una hamburguesería que solo se parece a "king". Repartida entre el nombre y el
      // barrio o la categoría no suma: con errores de tipeo es poca evidencia.
      const whole = tier !== 'context';
      const text = loose && whole ? w.tiers[t] + w.looseStructure * (w.tiers[tier] - w.tiers[t]) : w.tiers[t];
      const score = text + w.exactWord * exact - w.extraWord * extra - w.partialWord * partial;
      return { score, tier: t };
    };

    // 1) Seguido: desde el comienzo (saltando el tipo de vía de cualquiera de los dos) o más adentro.
    let nameStart = 0;
    while (nameStart < m - 1 && this.typeWord[tok[from + nameStart]] === 1) nameStart++;
    let queryStart = 0;
    while (queryStart < terms.length - 1 && terms[queryStart].type) queryStart++;
    const matchedCount = (q0: number): number => {
      let count = 0;
      for (let i = q0; i < terms.length; i++) if (!terms[i].optional) count++;
      return count;
    };
    for (let s = 0; s < m; s++) {
      if (s > 0 && s !== nameStart && this.optionalWord[tok[from + s]] === 1) continue;
      for (const q0 of queryStart > 0 ? [0, queryStart] : [0]) {
        const run = this.runFrom(from, m, s, terms, q0);
        if (!run) continue;
        const [exact, toEnd, loose, partial] = run;
        const atStart = s === 0 || s === nameStart;
        const allExact = exact === terms.length - q0;
        const tier: Tier = atStart ? (allExact && toEnd ? 'exact' : 'prefix') : 'phrase';
        const scored = finish(tier, exact, matchedCount(q0) + (atStart ? s : 0), loose, partial);
        // Se saltó el tipo de vía escrito: si esto no es una calle, o es una de otro tipo ("calle 22
        // no" no es "Avenida 22 NO"; "av 9 de octubre" sí es "Boulevard 9 de Octubre"), vale menos.
        if (q0 > 0) {
          const street = this.entryKind[e] === STREET;
          if (!street || (s === nameStart && nameStart > 0 && !this.sameType(terms[0].exact, tok[from]))) {
            scored.score -= w.typeMismatch;
          }
        }
        return scored;
      }
    }

    // 2) Las palabras en orden (con otras entre medio) o en cualquier orden.
    const used = new Uint8Array(m);
    let pos = 0;
    let inOrder = true;
    let found = 0;
    let exact = 0;
    let partial = 0;
    let loose = false;
    const missing: number[] = [];
    for (const i of required) {
      let k = -1;
      let best = NONE;
      for (let j = inOrder ? pos : 0; j < m; j++) {
        if (used[j]) continue;
        const h = this.hit(terms[i], tok[from + j]);
        if (h > best) {
          best = h;
          k = j;
          if (h === EXACT) break;
        }
      }
      if (k < 0 && inOrder && pos > 0) {
        for (let j = 0; j < pos; j++) {
          if (used[j]) continue;
          const h = this.hit(terms[i], tok[from + j]);
          if (h > best) {
            best = h;
            k = j;
          }
        }
        if (k >= 0) inOrder = false;
      }
      if (k < 0) {
        missing.push(i);
        continue;
      }
      used[k] = 1;
      pos = k + 1;
      found++;
      if (best === EXACT) exact++;
      if (best === LOOSE) loose = true;
      if (best === PREFIX && this.partial(terms[i])) partial++;
    }
    if (!missing.length) return finish(inOrder ? 'words' : 'any', exact, found, loose, partial);
    if (!useContext) return null;

    // 3) Lo que falta, en la categoría o el barrio ("kfc alborada", "farmacia urdesa").
    let category = false;
    let byAlias = false;
    for (const i of missing) {
      const c = this.context(e, terms[i]);
      if (c === 0) return null;
      if (c & IN_CATEGORY) category = true;
      if (c & BY_ALIAS) byAlias = true;
      if (c & LOOSELY) loose = true;
    }
    if (found > 0) return finish('context', exact, found, loose, partial);
    // Nada en el nombre: vale solo si una palabra es la categoría ("farmacia", no "urdesa" a secas). Por
    // un alias, que suele ser un tipo más preciso ("catedral" entre las iglesias), vale menos que los
    // que lo tienen en el nombre ("Catedral Metropolitana").
    return category ? finish(byAlias ? 'categoryAlias' : 'category', 0, significant(), loose, 0) : null;
  }

  private sameType(a: number, b: number): boolean {
    return a === b || (this.typeGroup[a] >= 0 && this.typeGroup[a] === this.typeGroup[b]);
  }

  private looseTier(terms: Term[]): Tier {
    return terms.some((t) => t.loose !== null && t.looseTier === 'fuzzy') ? 'fuzzy' : 'substring';
  }

  private penalty(distance: number): number {
    const w = this.cfg.ranking;
    return w.distance * Math.log2(1 + distance / w.distanceScale);
  }

  /** Punto de llegada, distancia y barrio de una entrada vista desde (px, pz). */
  private locate(e: number, px: number, pz: number): { x: number; z: number; distance: number; area: number } {
    const ref = this.entryRef[e];
    switch (this.entryKind[e]) {
      case LANDMARK: {
        const lm = this.landmarks[ref];
        return { x: lm.x, z: lm.z, distance: Math.hypot(lm.x - px, lm.z - pz), area: -1 };
      }
      case AREA: {
        const x = this.areaX[ref];
        const z = this.areaZ[ref];
        return { x, z, distance: Math.hypot(x - px, z - pz), area: this.areaParent[ref] };
      }
      case STREET: {
        // El punto de la calle más cercano al jugador.
        let best = this.sampleStart[ref];
        let bestDistance = Infinity;
        for (let s = this.sampleStart[ref]; s < this.sampleStart[ref + 1]; s++) {
          const d = Math.hypot(this.sampleX[s] - px, this.sampleZ[s] - pz);
          if (d < bestDistance) {
            bestDistance = d;
            best = s;
          }
        }
        return { x: this.sampleX[best], z: this.sampleZ[best], distance: bestDistance, area: this.sampleArea[best] };
      }
      default: {
        const x = this.placeX[ref];
        const z = this.placeZ[ref];
        return { x, z, distance: Math.hypot(x - px, z - pz), area: this.placeArea[ref] };
      }
    }
  }

  /** Entradas cuyo nombre (o categoría y barrio) calza con lo escrito. */
  private collect(terms: Term[], required: number[], px: number, pz: number, top: TopHits, useContext = true): void {
    this.pass = (this.pass + 1) >>> 0 || 1;
    const pass = this.pass;
    const w = this.cfg.ranking;
    const evaluate = (e: number): void => {
      if (this.seen[e] === pass) return;
      this.seen[e] = pass;
      let best: TextScore | null = null;
      let alt = -1;
      for (let n = this.entryNameStart[e]; n < this.entryNameStart[e + 1]; n++) {
        const s = this.scoreName(n, e, terms, required, useContext);
        if (!s) continue;
        if (this.nameAlt[n] >= 0) s.score -= w.altName;
        if (!best || s.score > best.score) {
          best = s;
          alt = this.nameAlt[n];
        }
      }
      if (!best) return;
      const kind = KINDS[this.entryKind[e]];
      const where = this.locate(e, px, pz);
      const score = best.score + w.kinds[kind] + w.importance * this.entryRank[e] - this.penalty(where.distance);
      if (score > top.floor) top.push({ score, kind, id: e, alt, ...where, a: -1, b: -1 });
    };

    // Por nombre: desde la palabra escrita que aparece en menos nombres.
    let pick = -1;
    let fewest = Infinity;
    for (const i of required) {
      const count = this.postings(terms[i]);
      if (count > 0 && count < fewest) {
        fewest = count;
        pick = i;
      }
    }
    if (pick >= 0) this.eachName(terms[pick], (n) => evaluate(this.nameEntry[n]));

    // Por categoría: "farmacia" son todas las farmacias, se llamen como se llamen. Una palabra corta,
    // solo si es idéntica: "c" (se está escribiendo "cornejo") no son todas las de "comida rápida".
    for (const i of required) {
      const t = terms[i];
      const short = t.text.length < this.cfg.minLength.category;
      if (short && t.exact < 0) continue;
      const probe: Term = short ? { ...t, lo: t.exact, hi: t.exact + 1, loose: null } : t;
      for (let c = 0; c < this.categories.length; c++) {
        if (this.hasWord(this.catTok, this.catTokStart[c], this.catTokStart[c + 1], probe) === NONE) continue;
        for (let k = this.catEntStart[c]; k < this.catEntStart[c + 1]; k++) evaluate(this.catEnt[k]);
      }
    }
  }

  /** Cada nombre donde aparece una palabra que calza con `term` (del prefijo o aflojada). */
  private eachName(term: Term, visit: (n: number) => void): void {
    for (let p = this.postStart[term.lo]; p < this.postStart[term.hi]; p++) visit(this.post[p]);
    if (!term.loose) return;
    for (let k = 0; k < term.loose.length; k++) {
      if (!term.loose[k]) continue;
      for (let p = this.postStart[k]; p < this.postStart[k + 1]; p++) visit(this.post[p]);
    }
  }

  /** En cuántos nombres aparecen las palabras que calzan con `term`. */
  private postings(term: Term): number {
    let count = this.postStart[term.hi] - this.postStart[term.lo];
    if (term.loose) {
      for (let k = 0; k < term.loose.length; k++) {
        if (term.loose[k]) count += this.postStart[k + 1] - this.postStart[k];
      }
    }
    return count;
  }

  /**
   * "9 de Octubre y Boyacá": se parte lo escrito en cada separador ("y", "e", "con", "esquina") y
   * se buscan los cruces de las calles de un lado con las del otro. Con el separador al final y el
   * espacio ya escrito ("9 de octubre y ") salen los cruces de esa calle, del más cercano al más
   * lejano, si su nombre ya está completo.
   */
  private crossings(terms: Term[], open: boolean, px: number, pz: number, top: TopHits): void {
    const w = this.cfg.ranking;
    for (let k = 1; k < terms.length; k++) {
      if (!this.separators.has(terms[k].text)) continue;
      const right = terms.slice(k + 1);
      if (!right.length && open) continue;
      const streetsA = this.matchStreets(terms.slice(0, k), !right.length);
      if (!streetsA.size) continue;
      const streetsB = right.length ? this.matchStreets(right, false) : null;
      if (streetsB && !streetsB.size) continue;
      // Se recorren los cruces de las calles del lado que tiene menos.
      const first = !streetsB || streetsA.size <= streetsB.size;
      const near = first ? streetsA : streetsB;
      const far = first ? streetsB : streetsA;
      for (const [s, nearScore] of near) {
        for (let j = this.adjStart[s]; j < this.adjStart[s + 1]; j++) {
          const c = this.adj[j];
          const other = this.crossA[c] === s ? this.crossB[c] : this.crossA[c];
          const farScore = far ? far.get(other) : nearScore;
          if (farScore === undefined) continue;
          // En el nombre, las calles van en el orden en que se escribieron.
          const [a, b] = first ? [s, other] : [other, s];
          const x = this.crossX[c];
          const z = this.crossZ[c];
          const distance = Math.hypot(x - px, z - pz);
          const score = (nearScore + farScore) / 2 + w.kinds.crossing - this.penalty(distance);
          if (score <= top.floor) continue;
          top.push({ score, kind: 'crossing', id: c, alt: -1, x, z, distance, area: this.crossArea[c], a, b });
        }
      }
    }
  }

  /**
   * Calles cuyo nombre (principal o alternativo) calza con estas palabras, con su puntaje de
   * texto; `complete`: solo las de nombre idéntico.
   */
  private matchStreets(terms: Term[], complete: boolean): Map<number, number> {
    const out = new Map<number, number>();
    const required = this.required(terms);
    let pick = -1;
    let fewest = Infinity;
    for (const i of required) {
      const count = this.postings(terms[i]);
      if (count > 0 && count < fewest) {
        fewest = count;
        pick = i;
      }
    }
    if (pick < 0) return out;
    const first = this.base[STREET];
    const last = first + this.streetName.length;
    this.eachName(terms[pick], (n) => {
      const e = this.nameEntry[n];
      if (e < first || e >= last) return;
      const s = this.scoreName(n, e, terms, required, false);
      if (!s || (complete && s.tier !== 'exact')) return;
      const score = s.score - (this.nameAlt[n] >= 0 ? this.cfg.ranking.altName : 0);
      const street = e - first;
      if (score > (out.get(street) ?? -Infinity)) out.set(street, score);
    });
    return out;
  }

  /**
   * Segunda pasada: las palabras del diccionario que contienen lo escrito o que suenan a pocas
   * letras de distancia (1 = calza), o null si no hay. `typing`: la palabra se está escribiendo
   * (es la última), así que se compara con el comienzo de cada una. `sameSound`: solo las que
   * suenan igual, sin letras de más ni de menos.
   */
  private looseMarks(t: Term, typing: boolean, sameSound: boolean): { marks: Uint8Array; tier: Tier } | null {
    const { minLength, fuzzy } = this.cfg;
    if (t.optional || t.text.length < minLength.substring) return null;
    const marks = new Uint8Array(this.dict.length);
    const max = sameSound ? 0 : t.text.length >= fuzzy.longLength ? fuzzy.longMaxEdits : fuzzy.maxEdits;
    const sound = this.norm.phonetic(t.text);
    const typos = t.text.length >= fuzzy.minLength && sound.length > 0;
    let any = false;
    let typo = false;
    for (let k = 0; k < this.dict.length; k++) {
      // Las vacías ("de", "ciudadela") no: parecerse a una no dice nada.
      if ((k >= t.lo && k < t.hi) || this.optionalWord[k] === 1) continue;
      if (!sameSound && this.dict[k].includes(t.text)) {
        marks[k] = 1;
        any = true;
      } else if (typos && this.sound[k][0] === sound[0] && editDistance(sound, this.sound[k], max, typing) <= max) {
        // Con errores, la primera letra (por cómo suena) se respeta: casi nunca es la equivocada.
        marks[k] = 1;
        any = true;
        typo = true;
      }
    }
    return any ? { marks, tier: typo ? 'fuzzy' : 'substring' } : null;
  }

  /** Afloja una palabra escrita; false si no hay ninguna parecida. */
  private loosenWith(t: Term, typing: boolean, sameSound = false): boolean {
    const loose = this.looseMarks(t, typing, sameSound);
    if (!loose) return false;
    t.loose = loose.marks;
    t.looseTier = loose.tier;
    return true;
  }

  /** Afloja las palabras escritas que no existen tal cual (las que existen suelen estar bien escritas). */
  private loosen(terms: Term[], typing: (i: number) => boolean): void {
    terms.forEach((t, i) => {
      if (t.exact < 0) this.loosenWith(t, typing(i));
    });
  }

  /** Los mejores sin repetidos (la misma entrada, o el mismo nombre en el mismo lugar), ya armados. */
  private finish(top: TopHits, words: string[], limit: number): SearchResult[] {
    const hits = top.items.sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    const taken: { key: string; x: number; z: number }[] = [];
    const ids = new Set<string>();
    for (const hit of hits) {
      if (out.length >= limit) break;
      const id = hit.kind === 'crossing' ? `c${hit.id}` : `e${hit.id}`;
      if (ids.has(id)) continue;
      const result = this.result(hit);
      const key = this.norm.tokens(result.name).join(' ');
      if (taken.some((t) => t.key === key && Math.hypot(t.x - hit.x, t.z - hit.z) < this.cfg.dedupeMeters)) continue;
      ids.add(id);
      taken.push({ key, x: hit.x, z: hit.z });
      result.marks = this.marks(result.name, words);
      out.push(result);
    }
    return out;
  }

  private areaText(area: number): string {
    return area >= 0 ? this.areaLabel[area] : '';
  }

  private result(hit: Hit): SearchResult {
    const labels = this.cfg.labels;
    const detail = (...parts: string[]): string => parts.filter(Boolean).join(labels.detailSeparator);
    const base = { marks: [] as [number, number][], x: hit.x, z: hit.z, distance: hit.distance };
    if (hit.kind === 'crossing') {
      const name = `${this.streetName[hit.a]}${labels.crossingJoin}${this.streetName[hit.b]}`;
      const text = detail(labels.crossing, this.areaText(hit.area));
      return { ...base, kind: 'crossing', name, detail: text, icon: 'crossing' };
    }
    const ref = this.entryRef[hit.id];
    switch (hit.kind) {
      case 'landmark':
        return {
          ...base,
          kind: 'landmark',
          name: this.landmarks[ref].name,
          detail: this.landmarks[ref].detail ?? labels.landmark,
          icon: 'landmark',
        };
      case 'area': {
        const text = detail(this.areaKinds[this.areaKind[ref]], this.areaText(this.areaParent[ref]));
        return { ...base, kind: 'area', name: this.areaName[ref], detail: text, icon: 'area' };
      }
      case 'street': {
        // Si calzó un nombre alternativo ("Calle 22 NO"), ese va en el detalle.
        const alt = hit.alt >= 0 ? this.streetAlt[ref][hit.alt] : this.streetKinds[this.streetKind[ref]];
        const text = detail(alt, this.areaText(hit.area));
        return { ...base, kind: 'street', name: this.streetName[ref], detail: text, icon: 'street' };
      }
      default: {
        const [label, group] = this.categories[this.placeCat[ref]];
        // Igual: si calzó otro nombre (la marca: "McDonald's" del local "MAL - ISLA"), va en el detalle.
        const alt = hit.alt >= 0 ? this.placeAlt[ref][hit.alt] : '';
        const text = detail(alt, label, this.areaText(hit.area));
        return { ...base, kind: 'place', name: this.placeName[ref], detail: text, icon: group };
      }
    }
  }

  /** Tramos del nombre que calzan con lo escrito: el comienzo de cada palabra que empieza así. */
  private marks(name: string, words: string[]): [number, number][] {
    const out: [number, number][] = [];
    for (const m of name.matchAll(WORD)) {
      const tokens = this.norm.tokens(m[0]);
      if (!tokens.length) continue;
      const token = tokens[0];
      let best = 0;
      for (const w of words) {
        if (!token.startsWith(w)) continue;
        // Si la normalización cambió el largo ("Av." → "avenida", "Diez" → "10"), va entera.
        const whole = w.length === token.length || token.length !== m[0].length || tokens.length > 1;
        best = Math.max(best, whole ? m[0].length : w.length);
      }
      if (best > 0) out.push([m.index, m.index + best]);
    }
    return out;
  }
}
