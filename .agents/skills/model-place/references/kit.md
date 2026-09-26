# El kit: qué piezas hay y cómo se arma un lugar

## Contenido

1. Tipos que ya existen (se reutilizan con otra config)
2. Lugares con archivo propio (`placeKit.ts`, `config/sites/`, `config/houses/`)
3. Piezas de arquitectura (`classical.ts`)
4. Juntar piezas (`monumentParts.ts`)
5. Dibujos procedurales (`surfacePatterns.ts`)
6. Piezas de las calles (`downtown.ts`, `medians.ts`, `streetLots.ts`, `signAtlas.ts`)
7. Piezas de los centros comerciales, la torre y la urbanización
8. Casas (`house.ts`, `instances.ts`) y sus scripts
9. Cómo se arma

## 1. Tipos que ya existen

Antes de escribir un builder, mirar si el lugar es de una familia que ya está: se extiende con
config, nunca se copia.

| Tipo | Archivo | Qué arma | Ejemplo en `config/game.json` |
|---|---|---|---|
| `palace` | `palace.ts` | Edificio de manzana con portal que se camina, pasaje, pabellones | `palacioMunicipal` |
| `church` | `church.ts` | Fachada con torres, nave, crucero con cúpula, costado a la calle con locales, convento con arcada, plaza con pila y estatua | `iglesiaSanFrancisco` |
| `column` | `column.ts` | Columna conmemorativa: plataforma, pedestal, estatuas, fuste, capitel, remate y césped con reja | `columnaProceres` |
| `park` | `park.ts` | Paseos, reja con portadas, grupos de bronce, faroles de globos (que alumbran de noche) y mástiles | `parqueCentenario` |
| `street` | `street.ts` + `downtown.ts` + `streetFurniture.ts` + `medians.ts` + `streetLots.ts` | Una calle entera: cuadras, veredas, fachadas por familia, letreros, mobiliario, parterre, retiros y carril de parqueo (ver `street-pipeline.md`) | `nueveDeOctubre`, `rodolfoBaquerizoNazur` |
| `mall` | `mall.ts` + `mallParts.ts` + `mallSite.ts` + `parking.ts` | El exterior de un centro comercial: volúmenes con una fachada distinta por lado, techos, marquesinas que se caminan, letreros, lucernarios, cúpulas y equipos de techo, parqueos en altura y a nivel, puentes, escaleras y lo de alrededor (ver 7) | `mallDelSol`, `sanMarino`, `cityMall`, `paseoShoppingDuran` (`config/sites/<archivo>.json`) |
| `tower` | `tower.ts` + `towerShaft.ts` + `towerBase.ts` | Torre de planta repetida que gira según una tabla: franjas de losa, vidrio por módulo, LED en los cantos, corona, física por tramos; la calle a sus pies y los cuerpos de al lado con `DowntownBuilder` (ver 7) | `thePoint` (`config/sites/the-point.json`) |
| `urbanization` | `urbanization.ts` + `urbanizationParts.ts` + `urbanSocial.ts` + `urbanStreets.ts` + `walls.ts` | Urbanización cerrada: muro perimetral, veredas y postes de las calles internas, zonas (garitas, bulevar, áreas sociales, rotondas) y sus casas repetidas (ver 7 y 8) | `duranCity` (`config/sites/duran-city.json` + `config/houses/duran-city.json`) |
| `house` | `house.ts` | Una casa sola con todo su detalle (la de quien colabora), con el mismo modelo paramétrico de las casas de una urbanización (ver 8) | — (`config/sites/<casa>.json`) |

La interfaz de la config de cada tipo vive junto a su builder, con cada campo comentado.

## 2. Lugares con archivo propio

Los tipos `mall`, `tower`, `urbanization` y `house` comparten una base
(`src/world/placeKit.ts`):

- **La entrada en `config/game.json` → `monuments.list` es corta** (`Place`): `id`, `type`,
  `file`, `lat`/`lon` (el origen del marco local), `headingDeg` (el rumbo del eje x), `exclude` y
  `flood`. Todo lo demás va en `config/sites/<file>.json`, que se carga con `siteFile` (un
  `import.meta.glob`). Cada agente es dueño de su archivo: nadie choca en `game.json`.
- **Cada tipo es un `PlaceType<F>`**, registrado en `PLACE_TYPES` (`monuments.ts`):
  - `check(f, where)`: los JSON no se validan al compilar. `check` falla al cargar con un mensaje
    claro: claves que faltan, un estilo, acabado o dibujo que no existe, un largo ≤ 0 que dejaría
    un bucle sin fin. Conviene que exija también lo que un lugar terminado tiene (fuentes,
    volúmenes): así un esqueleto vacío no pasa por un lugar hecho;
  - `signs(f)`, `lights(f)` y `clear(f)`: funciones puras que `Monuments` pide antes de armar,
    para el atlas de letreros, el alumbrado de la ciudad (`PlaceLight`: pie, alto, brazo,
    potencia, LED o sodio) y los despejes;
  - `build(f, kit)`.
- **El `PlaceKit`** que recibe `build`:
  - `root`, `terrain(x, z)` y `flood`;
  - `materials.stone` (el material de los monumentos), `materials.paint` (el mismo, con la
    máscara de pintura: ver 4) y `finish(f)`, el material con otro acabado (vidrio, metal,
    calado), uno por acabado distinto y compartido entre lugares;
  - la física y el LOD del lugar entero (`block`, `box`, `circle`, `ground`, `near`, `far`);
  - `site(x, z)`: un pedazo con su propia física y su propio LOD (un volumen de un mall, una
    celda de casas, una celda de muro). Una consulta de la física no recorre el lugar entero, y
    lo chico se esconde según la distancia a su pedazo, no al centro del lugar;
  - `block(outline, y0, top, roof?)`: el macizo del índice de edificios, con su techo inclinado
    (`LocalRoof`: a dos o cuatro aguas) para que se pise por sus aguas. `top` va en la cumbrera;
  - `tree`, `palm` y `car`, que van a los árboles, palmeras y autos de la ciudad. `car` solo sabe
    del suelo: los autos de los pisos altos de un parqueo van como instancias quietas, con su
    propia caja de física;
  - `signRect` y `signOffset` para los letreros del atlas;
  - `lotKit(site, batches, ground)`: lo que piden `buildRetiro` y `buildLane` (`streetLots.ts`)
    para armar hileras de parqueo en un pedazo.
- **`config/houses/<conjunto>.json`** (`HouseSet`, `houseSet(name)` en `instances.ts`): los
  modelos, los esquemas de color, las piezas comunes y los lotes de las casas de una
  urbanización. La urbanización lo nombra en `houses`. Lo escribe un script (ver 8).
- **Generadores**: un archivo de `config/sites/` se escribe a mano o con un script al lado, en
  `config/sites/<lugar>/`, que lee fuentes versionadas en esa carpeta y tiene `--check`: el de
  Durán City es `python3 config/sites/duran-city/config.py [--check]`, desde `trazado.json`.
  `config/sites/the-point/geometry.py` solo imprime los polígonos que se derivan de lo medido,
  para pegarlos en el JSON.
- **Un tipo nuevo**: la interfaz de su archivo con cada campo comentado, su `check`, sus
  funciones puras y `build`, en su propio archivo, sumado a `PLACE_TYPES`. Las mallas llevan
  nombre `<id>-<parte>` (así se miden por partes con `__mp.gpu`).

## 3. Piezas de arquitectura (`src/world/classical.ts`)

- **Muros y losas**: `wall` (un muro con arcos, puertas y ventanas) y `slab` (una losa con
  huecos).
- **Vanos**: `archHole`, `rectHole`, `roundHole` y `pointedHole` (lanceta gótica); `archPath`
  da el recorrido de un arco, para su marco.
- **Molduras**: `sweep` (moldura barrida por un recorrido, con ingletes) y `bend` (curva una pieza
  plana alrededor de una esquina redondeada).
- **Columnas y balaustres**: `corinthianColumn` (fuste, capitel y su versión simple de lejos),
  `baluster` y `balusterFar`.
- **Adornos**: `urn`, `condor`, `bracket`, `wreath`, `gableTop` (remate de hastial con
  contracurvas) y `shield` (escudo).
- **Torneados y cúpulas**: `domeProfile` + `rib`, `lathe`, `arc` y `combine`.
- **Estatuas**: `figure` (una figura de pie; devuelve dónde quedan las manos, para lo que
  sostienen).
- **Arreglos de geometría**: `faceted` (caras planas para lo que tiene pocos lados: pirámides,
  troncos) e `inward` (la misma pieza vista desde adentro, como la pared interior de un
  macetero).

## 4. Juntar piezas (`src/world/monumentParts.ts`)

- **`Parts`** une las piezas en una geometría, suelda los vértices de las que vienen sin índice y
  la compacta al unirla. Le da a cada pieza:
  - color;
  - oclusión ambiental por vértice;
  - dibujo procedural;
  - luz propia y reflectores.
- **`Batch`**: lo mismo sin una geometría por pieza. Cuadriláteros, cajas y piezas van directo a
  un búfer; sirve para lo que tiene miles de piezas chicas. `quad(a, b, c, d)` va en sentido
  antihorario visto desde el lado que se ve, y `box` da uv en metros. Compacta pero no suelda:
  cada cuadrilátero lleva sus 4 vértices y cada `tri` (los pisos de `pave`) o pieza sin índice,
  3 por triángulo. `Batch.flood` lleva la base del reflector y del pie sucio del revoque: se fija
  al suelo local de lo que arma.
- **Máscara de pintura**: `Surface.paint` (0…1) dice cuánto se tiñe una pieza con el color de su
  instancia. Va con el material `paint` del `PlaceKit` (`Finish.paint`, lo pone el código): en
  una `InstancedMesh` con `instanceColor`, la pared de cada casa lleva su color y el techo, los
  marcos y las ventanas no. Comparte el byte de `led` (una pieza no lleva las dos cosas). El
  material `paint` mide además el pie sucio del revoque desde la base de cada instancia.
- **Ayudantes**:
  - `place`, `strut`, `prism`, `colorsOf` y `glowOf`;
  - `patternOf`: el dibujo por su nombre en la config. Un nombre que no existe falla al cargar,
    en vez de quedar liso.

## 5. Dibujos procedurales (`src/render/surfacePatterns.ts`)

Dibujos con relieve, parametrizados en `monuments.patterns`: `PATTERN.stucco`, `scales`,
`shutter`, `terrazzo`, `tiles`, `glazing`, `pavers`, `bars` (calado), `balusters` (calado),
`hoops` (calado: la cerca baja de arcos de los parterres), `slabs` (losas o placas de
revestimiento con junta), `soil` (tierra con manchas de césped) y `roofTiles` (teja). Y los de
los centros comerciales, la torre y la urbanización:

| Dibujo | N.º | Qué es |
|---|---|---|
| `rubble` | 15 | Mampostería de piedra irregular: cada piedra con su tono, su tinte y su abombado |
| `diamonds` | 16 | Placas con rombos en relieve (ranuras en diagonal) |
| `mosaic` | 17 | Mosaico de placas con junta hundida: cada placa toma uno de los tres colores de la config según su peso (`colors`, `weights`), con su tono; el color de la pieza los tiñe (blanco = tal cual) y la `scale` de la piel ajusta el tamaño de placa |
| `stripes` | 18 | Franjas pintadas a lo largo de u: el bordillo amarillo y negro de un acceso |
| `corrugated` | 20 | Plancha ondulada (fibrocemento, zinc), con chorreados de mugre |
| `blocks` | 21 | Bloque, ladrillo o piedra en hiladas trabadas |
| `chainLink` | 22 | Calado: malla de alambre en rombos (canchas, cerramientos) |
| `wires` | 23 | Calado: hilos horizontales de un cerco eléctrico o de alambre |

- `corrugated` y `blocks` se miden desde el origen de la malla, orientados como el mundo, con la
  normal de sus vértices: sirven en piezas instanciadas y escaladas, siguen de una instancia a la
  de al lado y no se vuelven ruido lejos del origen. En `blocks`, las uv de la pieza van fijas en
  1 y su `scale` dice cuánto mide cada pieza respecto del bloque de la config; su `tone` va de
  bloque parejo (0) a piedra (1).
- `stripes`, `corrugated`, `chainLink` y `wires` se funden en su tono promedio (o en un tramado)
  cuando ya caben en un píxel: sin muaré.
- `chainLink` y `wires` van con un acabado calado (`cutout`).

Un material nuevo es un `kind` más: su número en `PATTERN`, la rama `kind == N` del GLSL y sus
parámetros en `monuments.patterns`, los tres con el mismo número. Con varios agentes en paralelo,
el número se reserva antes (ver `pitfalls.md`).

`sign` no es un dibujo: lee el atlas de letreros (ver abajo) con las uv que le da cada letrero.

## 6. Piezas de las calles

Todas se piden desde la config de la calle (`config/streets/<calle>.json`, ver
`street-pipeline.md`); aquí, qué hay y dónde vive. Varias sirven para cualquier lugar.

- **Fachadas** (`downtown.ts`), además de pisos, portal, locales, balcones y remate:
  - `roof`: techo inclinado (`gables` en dientes de sierra, `gable` o `hip` a cuatro aguas), con
    alero y teja;
  - `awning`: marquesina inclinada sobre la vereda;
  - `bands`: franjas que salen de la fachada (la banda de color de un banco o una tienda);
  - `facade.cladding`: revestimiento de placas (un dibujo) en vez de ventanas;
  - `signs`: letreros pegados a la fachada, parados en un poste o sobre el techo.

  `DowntownBuilder` también arma los cuerpos de al lado de una torre: solo pide un
  `DowntownKit`.
- **Letreros** (`src/render/signAtlas.ts`): cada letrero distinto se dibuja una vez, con su
  texto, letra y colores, en un atlas compartido por las calles y los lugares
  (`monuments.signs`). El alto del atlas se recorta a lo que ocupan, con un tope
  (`monuments.signs.size`). Solo el nombre, con una letra genérica: los logos no se copian.
- **Veredas** (`pavement` en `street.ts`, exportada, con su `PavedStyle`): la losa a su alto
  sobre el terreno, en tramos que lo siguen, con el bordillo en los lados que dan a la calzada.
  La usan las calles y los pisos de los malls.
- **Parterre** (`medians.ts`): piso con bordillo, cerca baja, postes LED (sus luces se suman al
  alumbrado) y árboles, sobre un contorno que arma `build_street.py` desde los transectos.
- **Postes de N brazos** (`lampModel(lamps, colors, sides)` y `lampLightsAt` en `medians.ts`):
  el fuste, un brazo con su luminaria hacia cada lado de `sides` (±1 = hacia ±z del poste:
  `[-1, 1]` es el del parterre, `[1]` el de un brazo) y sus luces. `LampStyle` es lo común. En
  los malls, `turns` repite el juego de brazos girado: `[0, 90]` con dos lados es una cruz.
- **Retiros y carril** (`streetLots.ts`): el patio o parqueadero entre la vereda y el edificio
  (piso, puestos pintados, topes, borde de bordillo, jardinera o reja con sus postes, palmeras y
  autos estacionados) y el carril de parqueo junto al bordillo. Los autos se suman a
  `ParkedCars` y las palmeras a `Palms`: no son geometría propia de la calle. Un lugar los arma
  con `kit.lotKit`, la misma fábrica que usan las calles (`lotKit` en `street.ts`): las hileras
  de un parqueadero de mall son retiros.

## 7. Piezas de los centros comerciales, la torre y la urbanización

Todo en el marco local del lugar, con cada medida en su `config/sites/<lugar>.json`.

- **Centros comerciales** (`mallParts.ts`):
  - pieles con nombre (`Skins`: color, material, dibujo, oclusión, luz; `open` = sin superficie);
  - la cáscara de un volumen, con una fachada distinta por lado (`MallFace`): franjas, vanos y
    miradores, parteluces, paneles de colores, arcos con rosetón (`rise` rebajados, `repeat` en
    arcada, `out` sobre un relieve), relieves que siguen la fachada (`follow`), balcones,
    faldones de teja y toldos de capota;
  - techos `flat`, `gable`, `hip`, `shed`, `vault` y `sawtooth`, y el cielo raso de un volumen que
    vuela (`soffit`);
  - física por volumen: `block` (macizo), `raised` (desde su base: se pasa por debajo) o `none`;
    `polyBoxes` parte una planta con huecos en franjas de física;
  - marquesinas por una quebrada, con postes, tensores y plafones: se caminan por debajo y se
    pisan encima, y uno de cada `lamps.light.every` plafones va al alumbrado. En una recta, `nose`
    redondea el borde de afuera (la lámina baja en un cuarto de elipse hasta el pie del canto, y
    los costados siguen ese perfil). Los postes pueden abrirse arriba en dos puntales en Y
    (`posts.y`) y arrancar sobre un techo (`posts.foot`): su física va desde ese pie, no desde el
    suelo;
  - letreros pegados a un volumen, sueltos, en poste o en tótem; en tiras por una curva
    (`follow`), estirados (`stretch`) y con `res` baja si son grandes. Las letras sueltas
    (`depth` 0) van con el acabado calado `letters`;
  - lucernarios (`vault`, `ridge`, `flat`), cúpulas y medias cúpulas, equipos de aire
    instanciados, paneles solares y antenas;
  - dos capas que se tapan (el paño de un arco delante de su muro, el ventilador sobre su equipo)
    se separan `detail.film` (al menos 1 cm);
  - `Bins` junta los búferes por material y LOD, con mallas `<lugar>-<pedazo>-<material>[-near]`.
- **Alrededores de un mall** (`mallSite.ts`): puentes peatonales con armadura (con `gaps` en la
  baranda donde llega una escalera), escaleras, rejas, bolardos, jardineras, pisos con bordillo,
  paradas, fuentes, postes de luz (con sus luces), autos sueltos, palmeras y árboles. Además:
  - vallas en poste (`billboards`): la cara lisa (el texto de un anuncio, si va, es un letrero
    suelto delante de ella), otra cara atrás con `back` (con su piel en `skins.back` si es otro
    anuncio) y `reflectors`, focos en brazos sobre el borde de arriba de cada cara, que se
    encienden con su piel;
  - torres de vigilancia (`towers`, opcional): el poste y, a lo largo de él, cajas con franjas
    de otra piel arriba y abajo (`rims`) y faldones acampanados (`flare`), cada pieza con su
    física;
  - motos (`motos`, opcional): un modelo instanciado para todas, solo de cerca y sin sombra, con
    el color de cada una por instancia (la máscara de pintura), en filas con qué parte de los
    lugares está ocupada (`share`); la física va por tramo seguido de motos.
- **Parqueos** (`parking.ts`): en altura, losas por nivel abiertas sobre sus rampas, columnas en
  grilla, rampas que se suben caminando, líneas de puestos (a `stalls.lift` sobre la losa) y autos
  quietos instanciados en los pisos altos, cada uno con su caja de física (`checkDeck` exige que
  las rampas apiladas suban en el mismo sentido); a nivel, hileras de retiros de `streetLots.ts`.
- **Torre** (`towerShaft.ts`):
  - `PlanShape`: un rectángulo con las esquinas redondeadas de una de dos maneras, nunca las dos:
    redondeo tangente (`plan.fillet`) o recortadas por un círculo concéntrico (`plan.radius`);
  - el fuste por pisos, con la tabla de giro `twist` ([nivel, grados] por tramos), franjas de
    losa de perfil redondeado, vidrio por módulo con ventanas encendidas al azar y LED en los
    cantos;
  - la corona (anillo sobre aletas, anillo interior con costillas, terraza, baranda de vidrio,
    cuartos de máquinas y mástiles) y la física por tramos (un macizo en la línea de las vitrinas
    y cajas pisables cada tantos pisos).

  `towerBase.ts`, para cualquier edificio: terraza sobre zócalo con baranda calada y tramos
  abiertos, escaleras y rampas que se ajustan al terreno, marquesina con letreros en el canto,
  jardineras, bordillos pintados, pisos y letreros sueltos.
- **Urbanización**:
  - `urbanizationParts.ts`: `Frame` (el marco de una zona), techos de teja (su física: sobre un
    macizo, su `LocalRoof`; sobre postes, rectángulos anidados a la altura de sus aguas, que se
    pisan por las aguas y dejan pasar por debajo), pabellones sobre postes (aleros de garita,
    casas club), casetas y torres, portones corredizos, plumas, reductores y cebras (sobre el
    piso de su zona), bolardos, letreros de panel (con `floodlights`, focos de piso que lo bañan
    con el reflector de los monumentos, no con el alumbrado) y pisos con bordillo pintado;
  - `urbanSocial.ts`: piscinas de cualquier forma, canchas con sus líneas, arcos, tableros, red y
    cerramiento, y juegos infantiles;
  - `urbanStreets.ts`: las veredas de las calles internas, a los lados del eje medido de cada
    calle según su sección tipo, cortadas en los cruces, con la franja verde de atrás y los
    postes de un lado. Las calles mismas vienen de OSM;
  - los pisos (veredas, franjas verdes, pisos de las zonas) van con `paveFit` y `curbed`: el
    contorno triangulado y cada lado partido solo donde el terreno se separa de la recta más de
    `ground.tolerance` m (y ningún lado más largo que `ground.maxEdge`), así que en lo plano
    quedan pocos triángulos grandes. Las losas no proyectan sombra (caería debajo de ellas); los
    cantos de los bordillos, sí.
- **Muros y vallas** (`walls.ts`): `WallStyle` (paño macizo o calado, hiladas de paneles, franja
  pintada que sube y baja de hilada, pilares instanciados, remate de cerco eléctrico, alambre o
  malla, y el largo de los tramos de la física), `WallRun` (una polilínea abierta o cerrada, sus
  lados sin muro y de qué lado queda el afuera) y `WallBuilder`, que parte cada tramo en celdas
  con su física y su LOD. La física va del grosor del paño o de los pilares, nunca menos que el
  `ground.wall` del lugar: una malla de canchas se atravesaría corriendo. Lo usan el muro
  perimetral, las canchas y los cerramientos.

## 8. Casas (`house.ts`, `instances.ts`) y sus scripts

- **El modelo** (`HouseModel`, `buildHouse`): volúmenes de uno o más pisos con sus retranqueos y
  volados; techo a dos aguas (cumbrera paralela a la calle o hastial a la calle), a una agua o
  losa; vanos contados con su moldura, derrame y relleno (ventana corrediza, puerta de tableros,
  portón); paños de color o de piedra, bruñas, zócalo, tejadillos, apliques, balcones, pisos,
  cerramiento del frente, jardineras, tanques, aires y el pilar del medidor. Todo en el marco de
  la casa (x a lo largo del frente, z hacia el fondo). Devuelve la geometría de cerca y la huella
  y el techo para la física. Las piezas de lejos (`farPieces`) son unitarias y se escalan por
  instancia: la caja de los muros, los hastiales y las aguas con su cielo (18 triángulos por
  casa), y la caja sin luz de las casas en obra.
- **Una casa sola** (tipo `house`, `HouseFile`): el modelo con sus colores, su mano y los puntos
  donde se mide el suelo. La casa de la próxima persona es su `config/sites/<casa>.json` y sus
  fotos.
- **Casas repetidas** (`instances.ts`, `buildHouses`):
  - cada modelo se arma una vez; cada esquema de colores (el de una etapa) lo pinta, y la pared de
    cada casa lleva su color por instancia (la máscara de pintura);
  - la otra mano es la misma geometría con el índice al revés (`houseVariant` + `mirroredIndex`):
    ninguna matriz de instancia espeja;
  - van por celdas de `cell` m: una `InstancedMesh` por modelo, esquema y mano en cada celda, con
    su LOD (`detail.near`, desde el centro de la celda). Más allá de `detail.mid` (de la cámara al
    punto más cercano de la celda) se dibujan sin lo fino (cantos de molduras, tubos, barandas,
    ménsulas): el modelo lleva eso al final de su índice y se corta el rango de dibujo;
  - la física (un macizo por casa, con su techo, y con `physics.boxes` las cajas de su cierre, su
    pilar y sus tejadillos) va en celdas más chicas, de `physicsCell` m: una consulta recorre unas
    decenas de piezas, no cientos;
  - más allá del detalle, cuatro mallas de lejos para toda la urbanización (muros, muros de las
    casas en obra, hastiales y aguas), que esconden en el mismo cuadro las casas de las celdas que
    se ven de cerca. De noche, los muros de lejos llevan la luz promedio de las ventanas y apliques
    de cerca, repartida en cada cara;
  - sombras (`detail.shadows`): las casas de cerca proyectan en la cascada cercana; en la lejana,
    las piezas de lejos de todas las casas;
  - las ventanas encendidas van en el modelo: todas las casas de un modelo prenden las mismas;
  - las casas en obra son sus muros de bloque sin enlucir y sin techo, con la física muro por muro.
- **Scripts** (`.agents/skills/model-place/scripts/urbanization/`, con `uv run` desde la raíz;
  sus parámetros en `defaults.json`):
  - `build_houses.py <conjunto> [--check | --report]` arma `config/houses/<conjunto>.json` desde
    `config/houses/<conjunto>/`: `spec.json` (qué modelos, esquemas de color y reparto por
    etapa), `modelos.json` (las medidas de cada modelo) y `lotes.json` (una entrada por casa,
    medida en el satélite). A cada lote le da su modelo, su mano, el color de sus paredes y de su
    techo, y su posición (sin pasar el muro de su etapa, que lee de `config/sites/<conjunto>.json`),
    con semillas estables: el mismo lote da siempre lo mismo. `--check` compara, `--report`
    muestra el reparto;
  - `lot_states.py <conjunto> [--check]` revisa el estado de cada lote (construida, en obra, lote
    vacío) contra el mosaico satelital de la investigación y lo escribe en `lotes.json`. El mosaico
    queda en el caché del pipeline (no se versiona): el estado que escribe sí.

## 9. Cómo se arma

- **Coordenadas locales**:
  - trabajar con x a lo largo de la fachada principal;
  - generar las fachadas con la misma función, girada;
  - las esquinas son su propia pieza.
- **Instanciar** todo lo repetido (columnas, balaustres, modillones, barrotes, pilares, postes,
  equipos, casas) con una versión de lejos, y registrar las dos con `near`/`far` y su distancia
  en `detail`.
  - Una `InstancedMesh` calcula una sola esfera para todas sus instancias: con cientos repartidas
    en un lugar grande no se descarta nunca. Se parte por celdas, cada una con su `site`.
  - Nada instanciado espeja: three.js da vuelta las caras por objeto, no por instancia. La otra
    mano es otra geometría (o el mismo búfer con el índice al revés); lo simétrico va sin espejo.
- **Oclusión ambiental** por pieza (`ao` constante) o por vértice (según la posición): techos de
  portales, intradoses, fondos de balcones, loggias, pasajes, cielos rasos de marquesinas y
  aleros. Es lo que más realismo da por lo que cuesta. Sin ella todo se ve plano; con demasiada,
  negro.
- **Luces de noche**:
  - vidrios y globos con `glow`;
  - el reflector (`flood`) ya alumbra según hacia dónde mira cada cara;
  - los faroles modelados y los plafones de marquesinas y soportales tienen que **alumbrar el
    piso**: se suman a `Monuments.lanterns` (en un lugar con archivo, desde su `lights`), como los
    de las calles y el parque, y reemplazan a los postes de los datos que caen en su despeje.
- **Despejes**: un lugar con `clear` (polígonos locales) saca de los datos los edificios, árboles
  y postes que reemplaza. Los pisos a ras del suelo no cuentan como ocupados.
- **Pensar en el siguiente**: si el lenguaje del edificio no está en el kit, se agregan **piezas
  genéricas** aquí o en un kit hermano, opcionales y con su config, no código de un solo uso. Lo
  que ya estaba tiene que salir igual (en los malls se comprobó con una huella de todas las
  mallas antes y después).
