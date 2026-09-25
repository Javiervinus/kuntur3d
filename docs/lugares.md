# Lugares modelados

Los lugares que la gente reconoce se construyen uno por uno. Usan piezas procedurales (no hay
modelos externos) y van en su posición y a su escala. Cada uno es una entrada de
`config/game.json` → `monuments`, con sus formas, colores y luces. Se pisan y no se atraviesan.

## Contenido

1. [Íconos](#íconos)
2. [Calles](#calles)
3. [Cómo se modela un lugar](#cómo-se-modela-un-lugar)
4. [Costo](#costo)

## Íconos

- **La Perla**, la rueda moscovita del Malecón. Tiene rayos y cabinas que giran, y de noche los LED
  de colores que recorren la rueda.
- **Torre Morisca**. Tiene base octogonal con arcos de herradura, cúpula y un reloj que marca la
  hora del día en el mundo.
- **Hemiciclo de La Rotonda**. Tiene gradas, columnas, banderas y las estatuas de Bolívar y San
  Martín.
- **Faro del cerro Santa Ana**. Tiene franjas en espiral, galería, linterna y haces que giran de
  noche.
- **Palacio Municipal** (Maccaferri, 1924-1929). Ocupa la manzana entera, en su huella de OSM de
  63,6 × 58,5 m:
  - portales en arcada que se caminan, con baldosas, locales y faroles colgados;
  - balcón corrido con balaustrada y logia de columnas corintias de dos pisos;
  - entablamento con modillones y dentículos, y ático con jarrones;
  - esquinas redondeadas con cuatro cúpulas de escamas, cuyos nervios se encienden de noche;
  - un pabellón con frontón y gran arco al centro de cada fachada, con cóndores y el escudo de
    Guayaquil;
  - el **Pasaje Arosemena**, con su bóveda de vidrio y costillas de hierro, balcones, faroles de
    globo y la cúpula octogonal del crucero. Se entra por el gran arco del Malecón o de
    Pichincha.

  Se trepa como cualquier edificio y se camina por la terraza.
- **Iglesia de San Francisco y Plaza Rocafuerte** (`src/world/church.ts`, un tipo paramétrico de
  iglesia):
  - fachada de dos cuerpos y las dos torres, con campanario, reloj y cúpulas de nervios;
  - nave, crucero con cúpula sobre tambor, y ábside;
  - el costado sobre la avenida, con los locales, los ventanales apuntados, los pináculos y el
    escudo franciscano;
  - las alas del convento;
  - en la plaza, la pila con sus surtidores y Vicente Rocafuerte sobre su pedestal.

  Tiene los colores actuales: blanco, con molduras y cúpulas azules.
- **Parque Centenario y Columna de los Próceres** (`src/world/column.ts`, `src/world/park.ts`):
  - la columna de 27 m, con su plataforma, el pedestal de granito rosado, los próceres de bronce
    y las alegorías;
  - el fuste con los grupos en espiral y la Libertad sobre el cóndor;
  - en el parque, los paseos de losas, la plaza circular, la reja de lanzas con sus portadas,
    los grupos de bronce, los faroles de globos y los mástiles con la bandera.

## Calles

Una calle se modela con cada uno de sus edificios. Cada edificio lleva lo suyo (pisos, vanos,
alturas, colores, letreros y retiro), medido en las fotos más recientes y en el satélite.

- **Av. 9 de Octubre**, del Malecón al Parque Centenario (~840 m, 18 cuadras, 66 edificios):
  - portal guayaquileño, balcones corridos, esquinas *streamline*, muro cortina, retículas,
    brutalismo y neoclásico;
  - torres retranqueadas donde las hay (La Previsora, el Banco Central);
  - veredas de baldosa terracota;
  - los faroles de hierro de dos linternas con la estrella de Guayaquil (78, que alumbran de
    noche), árboles en macetero y bancas.
- **Av. Rodolfo Baquerizo Nazur**, la principal de la Alborada, de la Egas Miranda a la Benjamín
  Carrión (~570 m, 45 edificios y 13 lotes):
  - el Pizza Hut, con su portal de columnas blancas que se camina;
  - los bancos Internacional, Pichincha y Guayaquil, y el McDonald's;
  - el Santuario de La Alborada, la capilla con su torre y el Centro Comercial La Alborada;
  - cada local con su letrero (el nombre del negocio en una tipografía genérica, sin logos), que
    se enciende de noche;
  - delante de los locales, parqueaderos con puestos, topes, autos y palmeras, o patios y
    jardineras con rejas;
  - en el medio, el parterre con su cerca baja y los postes LED de dos brazos.

Cada calle tiene sus fuentes versionadas en `config/streets/<calle>/`: el eje y las cuadras
(`spec.json`), el inventario de edificios (`inventory.json`) y la calzada medida en la app
(`transects.json`). El script `build_street.py` genera a partir de ellas
`config/streets/<calle>.json`. En la app:
- cada edificio se arma sobre una familia de fachada paramétrica (`src/world/downtown.ts`);
- el mobiliario sale de reglas por cuadra (`src/world/streetFurniture.ts`);
- los parterres se arman en `src/world/medians.ts`, y los retiros y los carriles de parqueo en
  `src/world/streetLots.ts`;
- los letreros van en un atlas compartido (`src/render/signAtlas.ts`).

Cada cuadra es su propio objeto de física y de nivel de detalle. La calle quita de los datos los
edificios, árboles y postes que reemplaza (`clear`).

## Cómo se modela un lugar

El procedimiento completo está en
[`.agents/skills/model-place/SKILL.md`](../.agents/skills/model-place/SKILL.md). Sirve para un
edificio, para una calle con todos sus edificios o para un lugar a partir de fotos propias, y
exige que el resultado sea fiel a cómo está el lugar hoy. En resumen:

- **Medidas reales.** La planta sale de OSM y del satélite. Las alturas y los detalles salen de
  fotos con una escala conocida. Se prefieren las fotos más recientes: Mapillary, Wikimedia
  Commons o fotos propias.
- **Comparación desde el mismo punto.** Cada foto de referencia tiene su captura de la app desde
  la misma posición y con el mismo lente (`__mp.shotPhoto`).
- **Kit de piezas** (`src/world/classical.ts`, `src/world/monumentParts.ts`): molduras barridas,
  muros con vanos, columnas corintias, balaustres, cúpulas con nervios, arcos apuntados,
  figuras, escudos y techos de teja.
- **Materiales** (`src/render/surfacePatterns.ts`): cada vértice lleva su oclusión ambiental y un
  dibujo procedural con relieve (revoque, escamas, cortinas metálicas, terrazo, baldosas, losas,
  teja). De noche, los reflectores alumbran según la orientación de cada cara.
- **Física**: los volúmenes macizos entran al índice de edificios y se trepan. Los aleros,
  bóvedas y portales son obstáculos elevados que dejan caminar por debajo.
- **Configuración**: todos los valores van en `config/`, nunca en el código.

## Costo

Medido con 10 copias en la vista más cargada de cada lugar, a resolución 2× y con sombras:

| Lugar | GPU | Geometría |
|---|---|---|
| Palacio Municipal | ~0,66 ms | 7,9 MB |
| Av. 9 de Octubre (18 cuadras) | ~0,45 ms | ~26 MB |
| Iglesia de San Francisco y su plaza | ~0,15 ms | 3,6 MB |
| Parque Centenario y la Columna | ~0,11 ms | 4 MB |
| Principal de la Alborada | ~0,4 × la 9 de Octubre | 8,6 MB + ~6 MB del atlas de letreros |

Las técnicas que mantienen ese costo bajo:
- las piezas repetidas van instanciadas, con una versión simple para la distancia;
- los adornos chicos no proyectan sombra;
- los volúmenes grandes se parten en cuadrantes, para que la cámara y las sombras descarten lo
  que no ven;
- los vértices se sueldan y sus atributos se guardan compactos.

El Palacio se arma en ~80 ms durante la carga; la 9 de Octubre, la iglesia y el parque, juntos,
en ~140 ms.
