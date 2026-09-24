# El kit: qué piezas hay y cómo se arma un lugar

## Contenido

1. Tipos que ya existen (se reutilizan con otra config)
2. Piezas de arquitectura (`classical.ts`)
3. Juntar piezas (`monumentParts.ts`)
4. Dibujos procedurales (`surfacePatterns.ts`)
5. Cómo se arma

## 1. Tipos que ya existen

Antes de escribir un builder, mirar si el lugar es de una familia que ya está: se extiende con
config, nunca se copia.

| Tipo | Archivo | Qué arma | Ejemplo en `config/game.json` |
|---|---|---|---|
| `palace` | `palace.ts` | Edificio de manzana con portal que se camina, pasaje, pabellones | `palacioMunicipal` |
| `church` | `church.ts` | Fachada con torres, nave, crucero con cúpula, costado a la calle con locales, convento con arcada, plaza con pila y estatua | `iglesiaSanFrancisco` |
| `column` | `column.ts` | Columna conmemorativa: plataforma, pedestal, estatuas, fuste, capitel, remate y césped con reja | `columnaProceres` |
| `park` | `park.ts` | Paseos, reja con portadas, grupos de bronce, faroles de globos (que alumbran de noche) y mástiles | `parqueCentenario` |
| `street` | `street.ts` + `downtown.ts` + `streetFurniture.ts` | Una calle entera: cuadras, veredas, fachadas por familia y mobiliario (ver `street-pipeline.md`) | `nueveDeOctubre` |

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
`shutter`, `terrazzo`, `tiles`, `glazing`, `pavers`, `bars` (calado) y `balusters` (calado). Un
material nuevo (ladrillo, bloque visto, piedra, madera, zinc) es un `kind` más ahí y sus
parámetros en la config.

## 5. Cómo se arma

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
