# Lugares modelados

Los lugares que la gente reconoce se construyen uno por uno. Usan piezas procedurales (no hay
modelos externos) y van en su posición y a su escala. Cada uno es una entrada de
`config/game.json` → `monuments`. Los íconos del centro llevan ahí mismo sus formas, colores y
luces. Las calles, los centros comerciales, las torres y las urbanizaciones llevan ahí solo dónde
están y el nombre de su archivo, que vive en `config/streets/` o en `config/sites/`. Se pisan y
no se atraviesan.

## Contenido

1. [Íconos](#íconos)
2. [Centros comerciales](#centros-comerciales)
3. [Urbanizaciones](#urbanizaciones)
4. [Calles](#calles)
5. [Cómo se modela un lugar](#cómo-se-modela-un-lugar)
6. [Costo](#costo)

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
- **The Point**, en Puerto Santa Ana: la torre de oficinas de 36 pisos y 136,5 m
  (`src/world/tower.ts`, un tipo paramétrico de torre):
  - el fuste de franjas blancas redondeadas y vidrio oscuro, con la planta de 32 × 32 m y las
    esquinas redondeadas, que gira piso a piso como en las fotos;
  - de noche, las líneas LED en los cantos de las losas y la corona azul;
  - la corona, con su anillo sobre aletas, la pérgola y la terraza con baranda de vidrio;
  - al pie, la terraza sobre su zócalo con el soportal de las vitrinas, la rampa y las escaleras;
    la marquesina de la entrada con las letras THE POINT sobre el carril de dejar pasajeros; el
    anexo de oficinas y la torre de parqueo con su rampa helicoidal.

  Se sube a la terraza por la rampa o las escaleras, se camina el soportal y bajo la marquesina,
  y el malecón pasa por el lado del río.

## Centros comerciales

Se modela el exterior de cada centro comercial: sus volúmenes, una fachada distinta por lado, los
techos, las entradas, los parqueaderos y lo de alrededor (`src/world/mall.ts`, un tipo
paramétrico de centro comercial). No tienen interiores: cada entrada termina en su puerta de
vidrio. Los letreros llevan solo el nombre de cada tienda, con una letra genérica, y de noche se
encienden con las vitrinas.

- **Mall del Sol**, entre la Juan Tanca Marengo y la Joaquín Orrantia (unos 400 m de punta a
  punta):
  - el portal del arco naranja, con el rosetón, el letrero MALL DEL SOL, las cuatro antenas y la
    marquesina colgada de su pilar;
  - el muro curvo del oeste con sus paneles de colores y el piso de vidrio de arriba; el bloque
    del suroeste con la terraza de Portela; el frente de Megamaxi; la cuña norte; las dos Torres
    del Mall sobre su podio;
  - en los techos, los lucernarios con la cúpula del cruce, los equipos de aire y las antenas;
  - tres parqueos en altura, con autos en cada piso y rampas que se suben caminando;
  - la plaza de la entrada con la fuente, las rejas, las jardineras con palmeras, las paradas de
    bus y los dos puentes peatonales.

  Se camina bajo las marquesinas del portal, de Megamaxi y de la entrada oeste.
- **San Marino Shopping**, en la esquina de la Francisco de Orellana y la Carlos Luis Plaza
  Dañín, de estilo colonial español y misión californiana:
  - la torre del reloj con su esfera, el tambor y la cupulita, con piedra rústica y rombos en
    relieve;
  - la rotonda de la esquina con la cúpula azul, la pérgola y la balaustrada, y la torre Casa Res;
  - los bloques de tres pisos con techos de teja, balcones de hierro y frontones curvos; el
    frontón de De Prati con las bocas del parqueo; la torre Zara con su mirador de arcos;
  - el patio de parqueo del frente con sus palmeras, la reja con portones y los postes de
    reflectores en cruz. De noche, los reflectores bañan la fachada crema.

  Se sube por las gradas de Zara a la placita y se sigue a la explanada de De Prati.
- **CityMall**, en la Benjamín Carrión, en la Alborada, con la fachada renovada en diciembre de
  2025:
  - el frente curvo con la franja de rayas amarillas y verdes bajo la viga, los paneles rojos de
    Kywi y ETAFASHION y el muro de MEGAMAXI;
  - el tambor de Marathon con su cáscara cobre, en la esquina suroeste;
  - al noreste, la galería con el panel de CityMall y multicines, el pórtico cobre de City Garden
    y los cines con su lucernario;
  - atrás, el podio del parqueo a nivel de la calle, con sus rejas;
  - de noche, los paneles rojos y las rayas encendidos.

  Se camina bajo las marquesinas del frente, el voladizo de Kywi y el pórtico.
- **Paseo Shopping Durán**, en el km 3,5 de la vía Durán-Boliche, junto al terminal terrestre: una
  sola planta de unos 290 m de frente.
  - la esquina sureste en L de mosaico rojo, la caja gris de Supercines con su letrero azul de
    letras amarillas y las cajas blancas de las dos entradas, con sus marquesinas rojas;
  - al medio, el portal ciego (sin entrada) entre dos bloques de mosaico rojo, con las letras EL
    PASEO Shopping DURÁN;
  - sobre los locales, los voladizos azules y verdes, escalonados y de borde redondeado, sobre
    columnas que se abren en Y y siguen como mástiles con sus tensores;
  - al noroeste, el Hipermarket (Mi Comisariato, Ferrisariato, Río Store y Mi Juguetería) con su
    esquina roja;
  - atrás, la bodega con sus andenes, las naves (una de tres aguas, con remates en diente de
    sierra), los paneles solares y los equipos de aire;
  - el parqueadero a nivel, con unos 390 puestos y sus autos, las torres de vigilancia, las filas
    de motos junto a la reja, los paraderos de techo curvo, la valla de dos caras con sus
    reflectores y los postes de luz. De noche se encienden los letreros, los plafones de los
    voladizos, las puertas, las casetas de las torres y la valla.

  Se entra por los pasos peatonales y el acceso de autos de la reja, y se camina bajo los
  voladizos y las marquesinas de las entradas.

## Urbanizaciones

- **Durán City**, una urbanización cerrada de Durán (`src/world/urbanization.ts` y las casas de
  `src/world/house.ts`):
  - el bulevar de entrada con su parterre, el monolito con el nombre y los postes;
  - tres etapas amuralladas, cada una con su garita (torre, aleros sobre los carriles, portones y
    plumas), su área social (casa club, piscinas, canchas con sus líneas y cerramientos, juegos
    infantiles) y sus calles internas con veredas, bordillos y postes;
  - unas 1.480 casas de 14 modelos, cada una en su lote medido en la foto satelital, con los
    colores de su etapa, su mano (el modelo o su espejo) y el color de techo que se ve desde
    arriba. Las que están en obra van como bloque sin enlucir y sin techo.

  Se entra por el bulevar y los carriles de las garitas; los muros y las rejas atajan.

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
- **Tipos paramétricos.** Palacio, iglesia, columna, parque, calle, centro comercial (`mall`),
  torre (`tower`), urbanización (`urbanization`) y casa (`house`). Los cuatro últimos llevan su
  config en un archivo propio, `config/sites/<lugar>.json`, y comparten una base
  (`src/world/placeKit.ts`): la física y el nivel de detalle por pedazos, y los letreros, luces,
  árboles, palmeras y autos que suman a los de la ciudad.
- **Kit de piezas**:
  - arquitectura (`src/world/classical.ts`, `src/world/monumentParts.ts`): molduras barridas,
    muros con vanos, columnas corintias, balaustres, cúpulas con nervios, arcos apuntados,
    figuras, escudos y techos de teja;
  - centros comerciales (`mallParts.ts`, `mallSite.ts`, `parking.ts`): fachadas por lado,
    marquesinas que se caminan, lucernarios, cúpulas, equipos de techo, parqueos en altura con
    rampas, parqueaderos a nivel, puentes peatonales, paradas, rejas, vallas, torres de
    vigilancia y filas de motos;
  - torres (`towerShaft.ts`, `towerBase.ts`): el fuste que gira según una tabla, la corona, y la
    terraza, las escaleras y la marquesina de la calle;
  - urbanizaciones (`urbanizationParts.ts`, `urbanSocial.ts`, `urbanStreets.ts`, `walls.ts`):
    garitas, pabellones, portones, plumas, piscinas, canchas, juegos, veredas de las calles
    internas y muros o vallas corridas;
  - casas (`house.ts`): volúmenes, techo, vanos contados, zócalo, tejadillos, balcones,
    cerramiento, tanques y aires, todo desde la config.
- **Materiales** (`src/render/surfacePatterns.ts`): cada vértice lleva su oclusión ambiental y un
  dibujo procedural con relieve (revoque, escamas, cortinas metálicas, terrazo, baldosas, losas,
  teja, piedra rústica, rombos, mosaico de placas de colores, franjas pintadas, plancha ondulada,
  bloque en hiladas y, calados, la malla de alambre y los hilos de un cerco). De noche, los
  reflectores alumbran según la orientación de cada cara.
- **Casas repetidas.** Van instanciadas por celdas: cada modelo se arma una vez, cada casa lleva
  el color de sus paredes por instancia y la otra mano comparte la geometría. A media distancia se
  dibujan sin lo fino; de lejos, cuatro mallas para toda la urbanización (muros, muros de las
  casas en obra, hastiales y aguas), con una caja y su techo por casa. Los lotes salen de un
  script versionado en la skill, a partir de las fuentes de `config/houses/<conjunto>/`.
- **Física**: los volúmenes macizos entran al índice de edificios y se trepan; los que tienen
  techo inclinado se pisan por sus aguas. Los aleros, bóvedas, portales y marquesinas son
  obstáculos elevados que dejan caminar por debajo.
- **Configuración**: todos los valores van en `config/`, nunca en el código.

## Costo

Medido con copias en la vista más cargada de cada lugar, a resolución 2× y con sombras: 10 copias
en los primeros cinco; 30 en los centros comerciales, The Point y Durán City, cuyas corridas dieron
~0,56-0,57 ms para el Palacio.

| Lugar | GPU | Geometría |
|---|---|---|
| Palacio Municipal | ~0,66 ms | 7,9 MB |
| Av. 9 de Octubre (18 cuadras) | ~0,45 ms | ~26 MB |
| Iglesia de San Francisco y su plaza | ~0,15 ms | 3,6 MB |
| Parque Centenario y la Columna | ~0,11 ms | 4 MB |
| Principal de la Alborada | ~0,4 × la 9 de Octubre | 8,6 MB + ~6 MB del atlas de letreros |
| Mall del Sol | ~0,22 ms | 4 MB |
| San Marino Shopping | ~0,16 ms | 2,7 MB |
| CityMall | ~0,12 ms | 2,6 MB |
| Paseo Shopping Durán | ~0,18 ms visto desde arriba (a la altura de los ojos, dentro del ruido) | 1,6 MB |
| The Point | ~0,08 ms desde la base, ~0,10 ms a 300 m | 2,9 MB |
| Durán City | ~0,65 ms | 4,4 MB (3 de geometría y 1,3 de instancias) |

En los centros comerciales, The Point y Durán City:
- **Llamadas de dibujo** en la vista (pasada principal + sombras): Mall del Sol 62 + 91, San
  Marino 71 + 102, CityMall 71 + 78, Paseo Shopping Durán 76 + 118, The Point 21 + 26 y Durán
  City 71 + 184 (el Palacio, 15 + 14). Suman de 0,1 ms (The Point) a 0,8 ms (Durán City) de CPU
  por cuadro.
- **Durán City**: las casas de las cuatro celdas de cerca cuestan ~0,42 ms, ~0,07 de ellos en
  sombras; las veredas, ~0,07 ms y 1,2 MB. The Point: el fuste pesa 2 MB.
- **Atlas de letreros**: con sus letreros pasa de 2048 × 527 a 2048 × 821 px (~+3,2 MB); los del
  Paseo lo llevan a 944 de los 1024 px del tope (`monuments.signs.size`).
- **Descarga**: su config suma 589 kB al JavaScript principal (121 kB con gzip).

Las técnicas que mantienen ese costo bajo:
- las piezas repetidas van instanciadas, con una versión simple para la distancia;
- las casas repetidas van por celdas; a media distancia se dibujan sin lo fino, y de lejos toda
  la urbanización son cuatro mallas de pocos triángulos por casa, que son también las que
  proyectan en la cascada lejana de la sombra;
- los adornos chicos no proyectan sombra;
- los pisos de la urbanización se triangulan sobre su contorno y se parten solo donde el relieve
  lo pide, y sus losas no proyectan sombra (caería debajo de ellas);
- los volúmenes grandes se parten en cuadrantes o pedazos, para que la cámara y las sombras
  descarten lo que no ven, y lo chico de cada pedazo se esconde según la distancia a él;
- las piezas que se juntan con `Parts` se sueldan, y los atributos de cada vértice se guardan
  compactos.

El Palacio se arma en ~80 ms durante la carga; la 9 de Octubre, la iglesia y el parque, juntos,
en ~140 ms; Mall del Sol, San Marino y CityMall, en ~90 ms, y The Point, en ~20 ms. Con el juego
ya cargado, Paseo Shopping Durán se arma en ~17 ms y Durán City en ~55 ms.
