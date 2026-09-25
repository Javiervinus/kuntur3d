# El kit: qué piezas hay y cómo se arma un lugar

## Contenido

1. Tipos que ya existen (se reutilizan con otra config)
2. Piezas de arquitectura (`classical.ts`)
3. Juntar piezas (`monumentParts.ts`)
4. Dibujos procedurales (`surfacePatterns.ts`)
5. Piezas de las calles (`downtown.ts`, `medians.ts`, `streetLots.ts`, `signAtlas.ts`)
6. Cómo se arma

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

La interfaz de la config de cada tipo vive junto a su builder, con cada campo comentado.

## 2. Piezas de arquitectura (`src/world/classical.ts`)

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

## 3. Juntar piezas (`src/world/monumentParts.ts`)

- **`Parts`** une las piezas en una geometría y la compacta al unirla. Le da a cada pieza:
  - color;
  - oclusión ambiental por vértice;
  - dibujo procedural;
  - luz propia y reflectores.
- **`Batch`**: lo mismo sin una geometría por pieza. Cuadriláteros, cajas y piezas van directo a
  un búfer; sirve para lo que tiene miles de piezas chicas. `quad(a, b, c, d)` va en sentido
  antihorario visto desde el lado que se ve, y `box` da uv en metros.
- **Ayudantes**:
  - `place`, `strut`, `prism`, `colorsOf` y `glowOf`;
  - `patternOf`: el dibujo por su nombre en la config. Un nombre que no existe falla al cargar,
    en vez de quedar liso.

## 4. Dibujos procedurales (`src/render/surfacePatterns.ts`)

Dibujos con relieve, parametrizados en `monuments.patterns`: `PATTERN.stucco`, `scales`,
`shutter`, `terrazzo`, `tiles`, `glazing`, `pavers`, `bars` (calado), `balusters` (calado),
`hoops` (calado: la cerca baja de arcos de los parterres), `slabs` (losas o placas de
revestimiento con junta), `soil` (tierra con manchas de césped) y `roofTiles` (teja). Un material
nuevo (ladrillo, bloque visto, piedra, madera, zinc) es un `kind` más ahí y sus parámetros en la
config.

`sign` no es un dibujo: lee el atlas de letreros (ver abajo) con las uv que le da cada letrero.

## 5. Piezas de las calles

Todas se piden desde la config de la calle (`config/streets/<calle>.json`, ver
`street-pipeline.md`); aquí, qué hay y dónde vive.

- **Fachadas** (`downtown.ts`), además de pisos, portal, locales, balcones y remate:
  - `roof`: techo inclinado (`gables` en dientes de sierra, `gable` o `hip` a cuatro aguas), con
    alero y teja;
  - `awning`: marquesina inclinada sobre la vereda;
  - `bands`: franjas que salen de la fachada (la banda de color de un banco o una tienda);
  - `facade.cladding`: revestimiento de placas (un dibujo) en vez de ventanas;
  - `signs`: letreros pegados a la fachada, parados en un poste o sobre el techo.
- **Letreros** (`src/render/signAtlas.ts`): cada letrero distinto se dibuja una vez, con su
  texto, letra y colores, en un atlas compartido por todos los monumentos (`monuments.signs`). El
  alto del atlas se recorta a lo que ocupan. Solo el nombre, con una letra genérica: los logos no
  se copian.
- **Parterre** (`medians.ts`): piso con bordillo, cerca baja, postes LED de dos brazos (sus luces
  se suman al alumbrado) y árboles, sobre un contorno que arma `build_street.py` desde los
  transectos.
- **Retiros y carril** (`streetLots.ts`): el patio o parqueadero entre la vereda y el edificio
  (piso, puestos pintados, topes, borde de bordillo, jardinera o reja con sus postes, palmeras y
  autos estacionados) y el carril de parqueo junto al bordillo. Los autos se suman a
  `ParkedCars` y las palmeras a `Palms`: no son geometría propia de la calle.

## 6. Cómo se arma

- **Coordenadas locales**:
  - trabajar con x a lo largo de la fachada principal;
  - generar las fachadas con la misma función, girada;
  - las esquinas son su propia pieza.
- **Instanciar** todo lo repetido (columnas, balaustres, modillones, barrotes) con una versión de
  lejos, y registrar las dos con `near`/`far` y su distancia en `detail`.
- **Oclusión ambiental** por pieza (`ao` constante) o por vértice (según la posición): techos de
  portales, intradoses, fondos de balcones, loggias y pasajes. Es lo que más realismo da por lo
  que cuesta. Sin ella todo se ve plano; con demasiada, negro.
- **Luces de noche**:
  - vidrios y globos con `glow`;
  - el reflector (`flood`) ya alumbra según hacia dónde mira cada cara;
  - los faroles modelados tienen que **alumbrar el piso**: se suman a `Monuments.lanterns`, como
    los de las calles y el parque, y reemplazan a los postes de los datos que caen en su despeje.
- **Despejes**: un lugar con `clear` (polígonos locales) saca de los datos los edificios, árboles
  y postes que reemplaza. Los pisos a ras del suelo no cuentan como ocupados.
- **Pensar en el siguiente**: si el lenguaje del edificio no está en el kit (rejas de casa, techo
  de zinc o teja, portón de garaje, ventanas de aluminio, aires acondicionados), se agregan
  **piezas genéricas** aquí o en un kit hermano, no código de un solo uso. La primera casa tiene
  que dejar un tipo `house` paramétrico: la casa de la próxima persona es solo config y fotos.
