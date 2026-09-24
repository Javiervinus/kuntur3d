# Kuntur 3D

**Ciudades reales en 3D en el navegador, con datos abiertos.** La primera es Guayaquil · Durán.

Un exploratorio de la ciudad inspirado en [San Francisco: The Game](https://sf.thijs.gg/):
caminar, manejar, trepar edificios y planear con ala delta sobre **todo Guayaquil** (de Pascuales
y Monte Sinaí al Guasmo, con el Suburbio y la Isla Trinitaria), **Samborondón** y
**Durán** (hasta las urbanizaciones de la vía a Tambo). Unos 28 × 26 km, ~540 mil
edificios, los íconos del Malecón, puentes, tráfico por las calles reales y gente por sus
veredas, de día y de noche. Todo con **datos abiertos y $0**.

- **Pruébalo:** https://kuntur3d.javiervinueza.workers.dev
- **Aporta:** reporta un edificio que está mal, pide tu ciudad o manda código. Ver
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Licencia:** código abierto [AGPL-3.0](LICENSE) con crédito obligatorio (ver
  [NOTICE.md](NOTICE.md)). Creado por Javier Vinueza.

## Correr

```bash
npm install
npm run data   # descarga y procesa los datos (~15 min la primera vez; luego mucho menos con caché)
npm run dev    # http://localhost:5173
```

`npm run data` necesita [uv](https://docs.astral.sh/uv/) (instala solo sus dependencias de Python)
y el Node.js del proyecto (arma los modelos humanos con `pipeline/build_model.ts`).
Se pueden rehacer pasos sueltos: `uv run pipeline/build_world.py --steps imagery,trees`.
Genera ~190 MB en `public/world/` y deja ~400 MB de caché en `pipeline/.cache/`
(descargas reutilizables; se puede borrar y se vuelve a bajar).

| Paso | Qué hace |
|---|---|
| `water` | Ríos y esteros de Overture → polígonos locales |
| `terrain` | Copernicus DEM → relieve sin los "bultos" de los edificios (y, en las zonas planas, sin los de las manzanas densas del centro); el agua queda hundida. Se guarda en 16 bits (menos de 4 mm de error), como diferencias por fila y con gzip: 4,7 MB en vez de 29 MB |
| `buildings` | Overture + Google Open Buildings 2.5D → huellas con altura (y los que faltan) |
| `imagery` | Esri World Imagery → vista general y tiles |
| `roads` | OSM → ejes de calles, parques, canchas, cruces y postes de alumbrado; los parques simplificados del mapa (`map.json`) |
| `bridges` | OSM → puentes en 3D (tablero, pilas, rampas, postes) y los muelles de los malecones con sus palmeras |
| `aerial` | Teleféricos de OSM (la Aerovía) → torres con su altura, estaciones y bocas del cable |
| `traffic` | OSM → red de tramos entre cruces para el tráfico (sentido, carriles, velocidad, puentes) |
| `walks` | OSM + `roads` + muelles → red peatonal (veredas a cada lado, senderos, paseos junto al agua) |
| `roofs` | Foto + forma → techos de teja o losa |
| `shops` | Negocios de Overture Places (los mismos del buscador) + calles → locales con su nombre en las plantas bajas y calles comerciales (ver Fachadas) |
| `skyline` | Los edificios altos de toda la ciudad en grupos → el horizonte lejano |
| `trees` | Meta/WRI → árboles con su altura real |
| `ao` | Edificios + copas + relieve → cielo visible desde el suelo (oclusión ambiental) |
| `landmarks` | Nominatim → lugares icónicos (la lista de LUGARES y el mapa) |
| `places` | `config/places.json` + límites de OSM → dónde está cada ficha (y su llegada), fotos de Wikimedia Commons (y su miniatura para la lista de LUGARES) y barrios para el título de zona |
| `search` | Calles, esquinas y barrios de OSM + negocios de Overture Places validados con los de OSM (y los que solo tiene OSM) → índice del buscador (`search.json`) |
| `assets` | El personaje (humano) y los peatones (hombre y mujer, con sus peinados y niveles de detalle) |

`npm run data` los corre en ese orden; si se rehace uno, conviene correr los que dependen
de él (p. ej. `roofs`, `shops` y `skyline` después de `buildings`; `skyline` después de `shops`).

La app se usa con el servidor de Vite (`npm run dev` o `npm run preview`): además de
servir la página, expande los links cortos de Google Maps y hace de proxy con caché de
la imagen satelital de alta resolución (ver abajo). Publicado no hace falta (ver
[Publicar](#publicar)).

## Publicar

Está en **https://kuntur3d.javiervinueza.workers.dev**: un Worker de Cloudflare
(`wrangler.jsonc`) en la cuenta personal, plan gratis. La dirección vieja
(`guayaquil-3d.javiervinueza.workers.dev`) redirige a esta. Para subir una versión nueva:

```bash
npm run deploy   # typecheck + vite build + wrangler deploy
```

- La página y los datos del mundo (`dist/`, con lo de `public/` que genera `npm run data`; no
  están en el repo) van como *assets* estáticos. Cloudflare los sirve desde su red, que tiene
  nodos en Guayaquil y Quito, sin pasar por el Worker: esas visitas son **gratis y sin
  límite**. Wrangler sube solo los archivos que cambiaron (la primera vez, 9 500 en ~35 s).
- El Worker (`server/cloudflare/worker.ts`) solo recibe lo que no es un archivo: la ruta que
  expande los links cortos de Google Maps (`server/edge/resolveMapLink.ts`, el mismo código que
  el plugin de Vite). El plan gratis trae 100 mil por día.
- Los tiles satelitales se piden directo a Esri, que permite CORS, en vez de pasar por el proxy.
- `public/_headers`: los archivos de `/assets` (con hash en el nombre) quedan en caché un año.
- Vista previa al compartir el link (WhatsApp, Facebook, X…): título, descripción e imagen
  (`public/og.jpg`, 1200 × 630) salen de `config/game.json` → `app.share` y los escribe en el HTML
  el plugin `server/shareMeta.ts` al armar la app.
- Límites del plan gratis: 20 000 archivos (hoy ~9 500) y 25 MB por archivo. Por eso el relieve
  se guarda comprimido (paso `terrain`: 4,7 MB en vez de 29 MB), lo que además acortó la
  primera carga.
- Los datos del mundo no están en Git. El CI de GitHub (`.github/workflows/ci.yml`) solo revisa
  tipos y arma la app; para publicar desde CI habría que generar los datos ahí o alojarlos aparte
  (`worldUrl` en `config/game.json`).

## Controles

| Tecla | Acción |
|---|---|
| W A S D | Caminar (W contra un muro = trepar) |
| Shift | Correr |
| Espacio | Saltar / soltarse del muro |
| H | Abrir/cerrar el ala delta (desde el suelo sube con una térmica) |
| W / S planeando | Picar / encabritar · A / D gira |
| F | Subir / bajar del carro (si está lejos, aparece a tu lado) |
| W / S / A / D manejando | Acelerar / frenar y reversa / girar |
| Espacio manejando | Freno de mano (derrapes) |
| C | Primera / tercera persona (manejando: vista desde el asiento) |
| − / + | Velocidad a pie (×0,5 a ×16); manejando, el "empujón" del carro (×1 a ×3) |
| T (o clic en el reloj) | Hora siguiente: mañana, mediodía, tarde, noche |
| M (o clic en el minimapa) | Abrir / cerrar el mapa |
| Esc o P | Pausa (y su menú) · otra vez, o clic en la ciudad, para seguir |
| ↑ / ↓ o rueda | Zoom de cámara |
| Clic + mouse | Mirar (pointer lock; soltar el mouse también pausa) |

Las teclas salen de `config/game.json` → `controls` y la leyenda de la pantalla cambia
según lo que estés haciendo (a pie, planeando, manejando). La lista completa está en la
pausa → CONTROLES.

Al recargar retomas donde quedaste (y en el carro, si ibas manejando); un link con
`?lat=&lon=` manda sobre eso. Se guarda en el navegador (`config/game.json` → `resume`).

**En el celular** (o cualquier pantalla táctil) aparecen controles para los dedos
(`src/ui/touch.ts`, `config/game.json` → `touch`):

- **Joystick** a la izquierda: nace donde apoyas el dedo y es analógico (360°, empujar a medias
  camina y al borde corre; manejando, acelera, frena y gira según cuánto lo empujes).
- **Mirar**: arrastrar un dedo por el resto de la pantalla; **dos dedos** acercan o alejan la cámara
  (y el mapa grande).
- **Botones** a la derecha según lo que estés haciendo (SALTAR, PLANEAR, CARRO; manejando FRENO y
  BAJAR) y arriba MENÚ y CÁMARA. El − / + del velocímetro cambia la velocidad.
- El HUD se compacta, las fichas de lugares llegan recogidas en la píldora y la pestaña
  CONTROLES explica los gestos. Por dentro todo aprieta las mismas teclas que el teclado
  (`Input.setVirtual`), así el resto del juego no distingue.
- **Perfil de memoria** (`config/game.json` → `profiles.mobile`, aplicado por `src/core/profile.ts`
  antes de que arranque el resto): Safari en iPhone cierra la pestaña si pasa su límite de
  memoria ("Ocurrió un problema varias veces"), lo que pasaba planeando. En pantallas táctiles
  baja la resolución (1,5×), las sombras (1024), los radios de carga (edificios, árboles, calles,
  terreno), la imagen satelital (menos texturas y caché) y la vista general (2048 px). Medido en
  un vuelo de 70 s a 300 m: texturas de ~262 a ~70 MB y geometría de ~200 a ~170 MB.

### El personaje

Un **humano** (1,75 m, proporciones reales): camina a 5 km/h, corre a 14 km/h, salta ~45 cm
con gravedad real, nada a ~3 km/h, trepa edificios, planea y maneja. Con − / + se le sube
la velocidad de ×0,5 a ×16 (corriendo a ×16 van ~225 km/h, para cruzar la ciudad a pie).
Las piernas no pasan de una cadencia creíble (`config/assets.json` → `maxStrideRate`, 1,8
veces la normal): más rápido que eso mantienen ese ritmo y el cuerpo se desliza, en vez de
agitarse como un borrón.

Modelo *Universal Base Characters* + animaciones *Universal Animation Library* de
Quaternius (CC0), armados en un solo `.glb` de ~1 MB (texturas WebP, solo las 8 animaciones
que se usan). La ropa (camiseta, jean, zapatillas) es procedural: se pinta en el shader
sobre la pose de reposo y se "infla" un poco en el shader de vértices para que tenga holgura.

El personaje es una entrada de `config/game.json` → `characters.roster`: modelo, estatura,
cómo se mueve y qué sabe hacer (`abilities`: trepar, planear, manejar). Agregar otro (p. ej.
un Superman que vuele) es otra entrada más su modelo en `config/assets.json`, y una tecla en
`controls.keys.character` para cambiar (hoy vacía: con uno solo no hay nada que elegir); una
habilidad nueva es un modo más en `src/player/controller.ts` con su bandera.

### El carro

Sedán procedural (4,35 m, carrocería hueca con interior, conductor sentado con su animación
de manejo, luces de freno y reversa). La física es un modelo dinámico de vehículo, no un
atajo: potencia limitada por P/v y por la tracción delantera, curva de neumático tipo
Pacejka por eje con círculo de fricción y sensibilidad a la carga, transferencia de peso,
arrastre aerodinámico y rodadura, pendiente del terreno, paso fijo de 120 Hz con la pose
dibujada interpolada entre pasos (sin eso se veía "a trozos"). Trae lo que trae un sedán
moderno: ABS, reparto de frenado (EBD), control de tracción y control de estabilidad (ESC:
si la cola se sale frena una rueda y corta motor; en el HUD sale CONTROL DE ESTABILIDAD). El
freno de mano bloquea las traseras y sigue sirviendo para derrapar. Con teclado, el volante
a fondo usa el agarre disponible a esa velocidad (a 120 km/h no te cruza).

Medido en un simulador con el mismo código (flat world, `config/game.json` → `vehicles.car`):
0–100 km/h en ~10 s, máxima 180 km/h, frenado de 100 a 0 en ~45 m; esquina de 90° a 50 km/h
en ~19 × 15 m; frenar a fondo en plena curva a 90 km/h deriva ~4° (antes: trompo).

- **Empujón** (− / +): ×1,5, ×2 y ×3 suben el tope (270, 360 y 540 km/h) y suman empuje
  directo al chasis, sin gastar el agarre de las llantas.
- **Primera persona**: el interior (tablero con relojes, volante, paneles, techo) se dibuja
  en una segunda pasada con su propio plano cercano, así nada sale recortado; la vista va
  pegada al carro y el mouse mira alrededor. Te ves las manos en el volante.
- **Superficie bajo cada rueda** (de las mismas texturas que dibujan las calles): asfalto,
  concreto y adoquín a fondo; camino de tierra, parques, canchas y tierra fuera de calle con
  menos agarre y más resistencia, que frena de forma progresiva (tierra ~70 km/h de tope).
- **Edificios**: choque con impulso (rebota y gira si le pegas a una esquina); no se trepan.
- **Agua**: frena con la profundidad y, pasado ~55 cm, el motor se ahoga y queda estancado.
  Bájate (F) y vuelve a pedirlo (F) lejos del agua.
- Si te teletransportas manejando, el carro va contigo si cabe en el destino.

Todos los números están en `config/game.json` → `vehicles.car`. El carro (y los otros
personajes, si se agregan) se preparan en segundo plano apenas carga el mundo (descarga y
compilación de shaders en paralelo), así usarlos por primera vez no da tirones.

### Buscador: lugares, links de Google Maps y tu ubicación

El buscador acepta:

- **Links de Google Maps**, tal cual se copian: el de "Compartir" (`maps.app.goo.gl/…`),
  el de la barra de direcciones (`google.com/maps/place/…`), `?q=`, `api=1&query=`,
  rutas (`/maps/dir/…`, va al destino) y también links de Apple Maps. Se usa, en este
  orden, el pin exacto del lugar, las coordenadas, el Plus Code, el centro de la vista y,
  si el link solo trae un nombre o dirección, se geocodifica dentro de la zona.
- **Plus Codes** (`R448+4P Guayaquil` o `6792R448+4P`).
- **Coordenadas** (`-2.1906, -79.8788`).
- **Calles, esquinas, negocios y barrios**, con sugerencias mientras escribes: "9 de octubre
  y boyacá", "urdesa", "kfc", "farmacia". Salen de un índice local, sin APIs (paso `search`:
  `public/world/search.json`, ~0,6 MB con gzip; se carga al enfocar la caja y busca en un
  worker). No importan tildes ni mayúsculas, entiende abreviaturas ("av.", "cdla.") y errores
  de tipeo ("burguer king", "hospita luis bernasa"). Ordena por coincidencia, tipo (lugares
  icónicos y barrios antes que negocios) y cercanía. Si el punto cae dentro de un edificio o
  en el agua, se llega a la vereda más cercana. Flechas y Enter eligen, Esc cierra.
  Si el índice no tiene nada, Enter busca en Nominatim (direcciones con número de casa).
  Los negocios de Overture se cruzan con los lugares con nombre de OSM: si son el mismo (nombre
  igual o casi, cerca), queda la posición de OSM, que en Guayaquil suele estar bien en los lugares
  importantes (el Hospital Luis Vernaza estaba a 800 m); los que solo tiene OSM se suman
  (`config/region.json` → `search.osmPlaces`).
  Tablas de texto en `config/region.json` → `search.text`; pesos en `config/game.json` → `search`.

Al llegar queda un **pin rojo con un haz de luz** en el punto exacto (también en el
minimapa). El botón de la mira junto al buscador te lleva a **tu ubicación actual**
(el navegador pide permiso la primera vez; si estás fuera de la zona te dice a
cuántos km quedas).

Los links cortos `maps.app.goo.gl` se expanden en el servidor de Vite
(`server/mapLinkResolver.ts`, solo sigue redirecciones de los dominios cortos de
Google) y, publicado, en el Worker de Cloudflare con el mismo código
(`server/edge/resolveMapLink.ts`). En otro hosting estático habría que pegar el link largo.

En el **mapa** (M) un clic en cualquier punto ofrece **TELETRANSPORTARME AQUÍ**, y en la
pausa → **COMPARTIR** están **COPIAR LINK** (la posición, `?lat=&lon=`) y el mismo punto en
Google Maps (ver [HUD, pausa y mapa](#hud-pausa-y-mapa)).

### Lugares con historia

Los lugares reconstruidos con cuidado (el Malecón 2000, La Perla, la Torre Morisca, el
Palacio Municipal y su pasaje, el Hemiciclo de La Rotonda, la iglesia de San Francisco, el Parque Centenario y su Columna, Las Peñas y el faro, los estadios, los puentes, la Aerovía, la
estación del tren de Durán…) tienen un **marcador** con las tres estrellas de la bandera de
Guayaquil, visible de lejos (el nombre aparece de cerca o al pasar el cursor; si dos se montan
en pantalla, queda el más cercano) y un rombo celeste en el minimapa.

- Al **llegar**, se abre a un costado (sin tapar la vista) su **ficha**: foto de Wikimedia
  Commons con su crédito y licencia, el año, la historia en pocas líneas, un "¿Sabías que…?" y
  las fuentes. Después de un rato se recoge en una píldora que la vuelve a abrir; al irse, se
  cierra. Un clic en un marcador abre la ficha de lejos, con el botón **IR AQUÍ**.
- En el **buscador** salen primero, con su categoría ("Noria · Malecón 2000"), y también se
  encuentran por su nombre popular ("iguanas" → Parque Seminario).
- En la pausa → **LUGARES** están todos, agrupados por tipo (`config/places.json` →
  `categories`), con su miniatura y a cuánto quedan; en el **mapa**, con su nombre.
- Al entrar a un **barrio**, su nombre aparece arriba con la parroquia y el cantón (límites
  administrativos de OSM) y, en los que lo tienen, una línea sobre su origen.

Los textos están verificados contra fuentes (Alcaldía, El Universo, Wikipedia con citas…):
donde las fuentes no coinciden, el dato no se usa. Todo el contenido está en
`config/places.json` (lugares y lemas de los barrios); el paso `places` del pipeline ubica
cada ficha (un lugar de `landmarks`, un ícono de `monuments` o coordenadas), corre la llegada
fuera del agua y de los edificios igual que los demás lugares, y baja las fotos. Apariencia y
tiempos en `config/game.json` → `places`.

### HUD, pausa y mapa

Pensado para no tapar la ciudad: todo va en las esquinas y el centro queda libre.

- **Arriba a la izquierda**, el barrio donde estás, con su parroquia y cantón.
- **Arriba al centro**, el buscador.
- **Arriba a la derecha**, el **minimapa**: un mapa dibujado (calles por jerarquía, parques,
  agua, la Aerovía y los lugares), no la foto satelital, que a esa escala no se leía. Gira
  con la cámara (lo de arriba es lo que tienes adelante; la **N** marca el norte), se aleja
  cuando vas rápido y, si el destino de la búsqueda queda fuera de la vista, su pin se queda
  en el borde, del lado donde está. Debajo, el **reloj**: la hora con el sol (o la luna) sobre un arco que
  va de la salida a la puesta real del sol en Guayaquil ese día; un clic o T pasa a la hora
  siguiente.
- **Abajo a la izquierda**, las teclas de lo que puedes hacer ahora; **abajo a la derecha**, el
  velocímetro con lo que estás haciendo (caminando, corriendo, trepando, planeando, nadando,
  manejando), el multiplicador y la altura sobre el suelo cuando vas por el aire.
- **Pausa** (Esc o P, o al soltar el mouse): el mundo se congela entero (tráfico, peatones,
  agua, reloj) y se oscurece un poco sin taparse. "En pausa" arriba y, a la izquierda, un menú
  con **LUGARES** (un clic te lleva), **HORA** (las cuatro, con su cielo), **CONTROLES**,
  **COMPARTIR** y **CRÉDITOS**. Esc otra vez o un clic en la ciudad para seguir.
- **Mapa** (M, o un clic en el minimapa): el mismo mapa en grande, con el juego en pausa. Se
  arrastra para moverse, la rueda acerca hacia el cursor (o los botones − / +) y **CENTRAR EN MÍ** vuelve
  a tu posición. Los nombres de barrios, parroquias y cantones salen según el zoom sin
  montarse con los de los lugares. Un clic en un lugar → **IR AQUÍ**; en cualquier otro punto
  → **TELETRANSPORTARME AQUÍ**.

El mapa no descarga nada: se dibuja en el navegador (canvas 2D, `src/ui/mapLayers.ts`) con
capas que el juego ya tiene cargadas (la red del tráfico para las calles, el agua, la
Aerovía) más los parques simplificados del paso `roads` (`map.json`, ~120 kB). Va en
cuadros de 256 px por nivel de zoom, con índice espacial y un tope de milisegundos por frame
para dibujar los que faltan: primero los que se verían vacíos, del centro hacia afuera.
Los cuadros que una vista está mostrando no se sueltan nunca, aunque la pantalla sea grande. Antes
había un tope fijo: con el zoom alejado se pedían más cuadros que ese tope, se soltaban cuadros a
la vista y el mapa titilaba rearmando ~2 800 por segundo. Aparte se guardan unos pocos de
repuesto (`map.spareTiles`). Mientras falta uno se ve lo que haya de los niveles vecinos
(al acercar, el de arriba estirado; al alejar, los de abajo achicados). Con el mapa grande
abierto se tienen además los dos niveles más lejanos para toda la ciudad (`big.baseLevels`,
20 cuadros), así ningún hueco queda vacío. Medido en una pantalla de 1728 × 1080 a 2×: el
mapa grande queda completo en ~60 ms, cada redibujo al arrastrar cuesta ~0,5 ms, el
minimapa ~0,01 ms por frame y cada cuadro nuevo ~0,3 ms (~1,6 ms en el zoom más lejano).
Colores, anchos por tipo de vía y zooms en `config/game.json` → `map` y `minimap`; textos y
tarjetas de hora en `hud`.

## Cómo funciona (y por qué se ve "feo pero decente")

El juego de San Francisco usa la malla fotogramétrica de Apple Maps, que no existe
para Guayaquil (ni Apple ni Google tienen cobertura 3D fotorrealista en Ecuador).
Este prototipo reconstruye la ciudad a partir de capas abiertas y usa la foto
satelital como "truco" en todo lo que puede:

| Capa | Fuente | Truco |
|---|---|---|
| Suelo | Esri World Imagery: cerca z18 (~0,6 m/px) y z17 bajo demanda; lejos, una vista general de todo el mundo (7 m/px) | Se dibuja casi sin iluminar (la foto ya trae sol y sombras reales); solo una parte recibe luz para que caigan nuestras sombras. De cerca, el color de la foto decide el detalle: **pasto** donde es verde, **tierra con piedritas** donde es cálida. Parques y canchas de OSM encima (ver abajo). |
| Relieve | Copernicus DEM GLO-30 | Es un DSM (incluye edificios): una apertura morfológica quita los bultos sin borrar los cerros. En un centro denso quedaban bultos de manzanas enteras (~4 m sobre la 9 de Octubre, que es plana); en las zonas planas (`config/region.json` → `terrain.flatZones`, hoy el centro, sin los cerros) se usa una ventana más grande, que solo baja el suelo. Se probó GEDTM30 (el DTM global de OpenGeoHub, sin edificios): en el centro trae bultos aún mayores. |
| Edificios | Overture Maps (OSM + Google Open Buildings + Microsoft) + los que solo ve Google Open Buildings 2.5D | Alturas de Google Open Buildings 2.5D (satélite + IA). Fachadas procedurales en shader (galpones con lámina y portones) y **techos con la foto satelital proyectada**: de teja a dos o cuatro aguas donde la foto muestra teja, losa con tanque de agua en el resto (ver abajo). |
| Calles | OpenStreetMap (Overpass) | Se dibujan nítidas **encima** de la foto (que de cerca es borrosa y trae los carros aplastados): calzada por material, veredas con bordillo, líneas de carril y pasos cebra. Ver abajo. |
| Árboles | Meta/WRI Global Canopy Height v2 (altura de copas a 1,2 m) | Cada copa es un máximo local del mapa de alturas, con su altura real y su radio; el color sale de la foto. Nunca sobre la calzada. |
| Agua | Polígonos de Overture | Semitransparente sobre la foto del río: se ve el Guayas turbio de verdad. |

### Calles

El paso `roads` del pipeline baja de OSM (Overpass, con servidores alternos y caché) las
~45 mil vías de la zona, los estacionamientos, las plazas peatonales y los cruces
peatonales, y deja por chunk los ejes con:

- **Ancho** según el tipo de vía (`config/region.json` → `roads.classes`), o `width`/`lanes`
  de OSM cuando existen; **carriles y sentido** para las líneas pintadas.
- **Material** (asfalto, hormigón, adoquín, tierra): la etiqueta `surface` de OSM cuando
  existe (~53 % de las vías); si no, un clasificador de vecinos más cercanos que combina
  el color de la foto a lo largo del eje con el material de las calles etiquetadas de
  alrededor (los barrios suelen ser parejos). Acierta ~81 % en validación cruzada; donde
  duda, usa el material típico del tipo de vía. Cada calle guarda además su **tono**
  (más clara o más gastada según la foto).
- **Veredas** por lado según las etiquetas `sidewalk*` de OSM, o el ancho típico del tipo de vía.
- **Estacionamiento y veredas medidos contra las fachadas**: OSM casi nunca trae el ancho de
  la calzada ni si se estaciona (5 vías de 46 mil), así que cada 6 m del eje se tira una recta
  de 25 m a cada lado hasta el edificio más cercano (~1 millón de rectas, unos 7 s). Donde cabe
  un carril de estacionamiento (2,2 m) más una vereda mínima, y según la probabilidad de la
  clase de vía, se agrega ese carril por fuera de los de circulación (las líneas pintadas
  siguen en la circulación); en las cuadras de fachada continua y alta, como el centro, la
  vereda llega hasta la fachada, y ya no queda entre la vereda y el edificio una franja de foto
  con las sombras de la toma satelital. En las avenidas de doble calzada, el lado del parterre
  (donde la recta cruza la otra calzada, que va al revés) queda sin estacionamiento ni vereda.
  Las etiquetas `parking:*` y `sidewalk*` de OSM mandan. Todo en `config/region.json` →
  `roads.parking`.
- **Autos estacionados** en esos carriles (~263 mil, `parking.bin`): uno cada 6,2 m con la
  ocupación de su cuadra, sin tapar cruces, pasos peatonales, entradas de garaje ni las puntas
  de la vía, mirando hacia donde se circula por su lado. Ninguno queda **sobre una calzada**:
  cada puesto se prueba con el rectángulo del auto más grande que se estaciona contra la
  calzada de las demás vías (donde el carril de estacionamiento se mete en otra calle) y
  contra la de la suya, con 30 cm de tolerancia (en las curvas cerradas el auto recto se sale
  al carril). Así se fueron 5.250 autos que estaban parados en medio de la calle
  (`config/region.json` → `roads.parking.spots`). En el juego
  (`src/world/parkedCars.ts`) se dibujan los que están a menos de 320 m, con los modelos y
  pinturas del tráfico (más taxis amarillos), asentados en la pendiente, sin luces de noche, y
  son obstáculos para el jugador y su carro.
- **Intersecciones** entre vías pintadas (ahí se cortan las líneas) y **cruces peatonales**
  (nodos `crossing` de OSM → pasos cebra).

En el juego, un worker (`src/world/roadWorker.ts`) convierte cada chunk en texturas de
**distancia con signo** (1,25 m por texel): distancia al borde por material, distancia al
eje, posición a lo largo del eje, carriles, cajas de intersección y cruces. El shader del
terreno reconstruye bordes y líneas finas a cualquier zoom a partir de esas distancias, y
funde todo con la foto a partir de ~400 m de la cámara (de lejos la foto se ve bien).
Colores, patrones (losas, adoquines, huellas en la tierra), líneas y cebras se ajustan en
`config/game.json` → `roads`.

Límites: la geometría de OSM puede estar corrida 1-3 m respecto a la foto y los anchos son
estimados. Los puentes no se pintan en el suelo: se construyen en 3D (ver abajo).

### Parques y canchas

El mismo paso `roads` baja de OSM (consulta aparte, con su propia caché) ~1.800 parques,
jardines y áreas verdes y ~1.270 canchas (`config/region.json` → `grounds`). El worker de
calles los rasteriza en dos texturas más por chunk:

- **Parques** (Malecón 2000, parques del centro, plazas de ciudadelas): donde la foto no es
  verde se dibujan baldosas grandes con el tono de la foto; donde es verde, pasto.
- **Canchas**: cada una guarda su rectángulo orientado, y el shader pinta las **líneas
  reglamentarias** escaladas a su tamaño: fútbol (círculo central, áreas, punto penal),
  básquet (zona, triple), vóley/ecuavóley (líneas de ataque), tenis (singles, saque) o solo
  contorno y media cancha. El césped lleva franjas de corte; la superficie sale de `surface`
  de OSM o, si falta, de la foto.

Colores, baldosas, anchos de línea y distancias en `config/game.json` → `roads.parks`,
`roads.pitches` y `terrain.ground`.

### Techos

El paso `roofs` mira cada edificio con forma de casa (rectangular, de hasta ~3 pisos, entre
25 y 450 m²) y toma el color de la foto en el centro del techo: si es **teja** (tono
rojo-naranja con saturación suficiente) le toca techo inclinado; si no, **losa plana**. En la
ciudadela de Durán sale ~50 % de teja; en el Suburbio ~7 % y en el Guasmo ~1 %, que es lo que
se ve en la foto. En total, ~44 mil techos de teja de ~515 mil edificios.

- **Teja**: a dos aguas (con hastiales) o a cuatro aguas, cumbrera a lo largo del lado largo,
  pendiente de 18° a 30° y alero con canto. La altura medida queda a media agua. Se puede
  caminar sobre las aguas y aterrizar en ellas.
- **Losa**: con **tanque de agua** en ~la mitad de las casas bajas (negro, azul o blanco), en
  una esquina donde quepa.

Parámetros del reconocimiento en `config/region.json` → `buildings.roofs`; forma del alero y
tanques en `config/game.json` → `buildings`. Si se rehace el paso `buildings`, hay que correr
`roofs` de nuevo (`npm run data` ya los corre en orden).

### Edificios que faltan y alturas

Las huellas de Overture vienen de modelos que se saltan sobre todo **galpones grandes** (hasta
5 ha) y casas sueltas nuevas: quedaban como foto aplastada. El paso `buildings` compara el
mapa de **presencia** de Open Buildings 2.5D con las huellas y vectoriza cada mancha sin
huella (~25 mil edificios, ~10 km²), recortada contra las huellas vecinas y regularizada a
rectángulo cuando lo es (`config/region.json` → `buildings.fill`).

Alturas: el percentil 75 del raster de Open Buildings dentro de cada huella es lo que mejor
calza con los pisos de OSM de Guayaquil (error típico ~2,8 m, sin sesgo). Las torres de más
de ~60 m salen más bajas de lo real cuando OSM no trae su altura; los colores de fachada son
inventados (ninguna fuente abierta los tiene). Las huellas grandes y bajas (≥ 2000 m²,
≤ 20 m) se dibujan como **galpón**: lámina con nervios, zócalo, franja alta de ventanas y
portones enrollables.

**Contornos que no son un edificio.** Algunas huellas grandes de Overture son en realidad el
contorno de una manzana, un patio de carros o un barrio entero (Las Peñas era un solo bloque).
Si adentro Open Buildings ve varios techos separados y ninguno ocupa más de la mitad, la huella
se descarta y esos techos entran como edificios propios: 190 huellas, 2,27 km²
(`config/region.json` → `buildings.outline`).

**Casas escalonadas en las laderas.** En los cerros (Santa Ana, del Carmen, las lomas del
noroeste) una huella suele cubrir varias casas que suben por la pendiente; con una sola base
quedaban muros de 15 m del lado de abajo. Donde el suelo bajo una huella sube más de 3,5 m, se
le ajusta un plano a la ladera y se corta en terrazas a lo largo de la pendiente y en casas de
~7 m de frente a lo largo de las curvas de nivel (desfasadas fila a fila, como en el cerro);
cada pieza toma su propia altura de Open Buildings. Quedan 5 831 huellas partidas en 36 517
casas (`buildings.terrace`).

**Edificios que se pisan.** Overture trae huellas superpuestas: una parte de un edificio
mapeada aparte en OSM, o contornos imprecisos de casas vecinas que se montan unos
centímetros. Donde dos comparten un tramo de pared, las dos paredes quedan en el mismo plano
y titilaban a cuadros (se peleaban la profundidad). Pasaba en 628 lugares, por ejemplo en el
edificio amarillo frente a La Perla, que tenía un rectángulo más bajo metido adentro. A cada
huella se le resta lo que ocupan las de techo más alto que la pisan (a igual techo gana la
de más área). La silueta de la ciudad queda igual y no queda pared repetida: el de adentro
más bajo desaparece (su techo ya quedaba escondido), el podio de una torre queda como un
anillo alrededor y la franja que se pisan dos casas queda para la más alta. Se recorta sobre
la misma grilla de 10 cm con que se guardan los anillos, así el redondeo no los deforma. Se
recortan 48 530 huellas (casi todas por centímetros) y se quitan 83; lo mismo entre las filas
de las graderías, cuyos escalones se montan uno sobre otro (`buildings.overlaps`). Quedan 0
pares con pared compartida (antes 628).

### Fachadas

Todo sale de un solo shader, sin texturas de fachada: cada edificio elige su estilo con una
semilla propia.

- **Ventanas** con marco, repisa y un **cuarto detrás** (paredes, piso y cortinas, con
  profundidad falsa que se mueve con la cámara), rejas en los pisos bajos de casas y edificios
  bajos, aires acondicionados y el chorreado de la humedad bajo las repisas y desde el pretil.
- **Locales solo donde hay negocios** (paso `shops`): los ~10 mil negocios de calle de Overture
  Places (los mismos del buscador; farmacias, tiendas, comida, bancos, ferreterías, talleres…,
  sin oficinas, colegios ni iglesias) van al edificio que los contiene o al que tienen a menos de
  8 m, con el letrero corrido al muro que da a la calle (no al medianero). Cada uno es un local
  con su **nombre real** en el letrero (mayúsculas, sin tildes salvo la Ñ, con números y `& ' - .`;
  hasta 20 letras, cortado por palabras; se prefiere la marca y se quitan la sucursal y el centro
  comercial: "Tía Guasmo Hospital" → TIA, "Pizza Hut Vergeles" → PIZZA HUT, "Mi Comisariato
  Alborada" → MI COMISARIATO, "La Casa Del Cangrejo" entero) y el aspecto de su tipo: la farmacia
  verde con luz fría, la comida y el bar con luz cálida, la ferretería y el taller abiertos con
  su cortina metálica enrollada arriba, el banco con escritorio; una cadena lleva el mismo color
  en todas sus sucursales.
- **Calles y zonas comerciales**: donde Overture muestra muchos negocios juntos (≥ 5 edificios
  con negocios y ≥ 15 % de los edificios en 110 m, o ≥ 3 edificios con negocios en 90 m de la
  misma calle) toda la planta baja son locales: los que Overture no tiene llevan una palabra
  genérica de los tipos que más hay alrededor (FARMACIA, CEVICHERIA, BAZAR, CYBER, VIVERES…) y
  alguno está vacío. Fuera de eso, el local ocupa solo su tramo del muro (un piso de alto, para
  que las ventanas de arriba sigan alineadas) y los barrios sin negocios quedan con ventanas,
  puertas y rejas. Letras en una fuente de 5×5; de lejos o de costado se funden en su tono
  promedio para no parpadear.
- **Horarios**: de noche cada local abre o cierra según el horario típico de su tipo (hora local
  del juego): bancos hasta las 17 h, tiendas hasta las 20 h, bares hasta la madrugada, algunas
  farmacias 24 h; parte de los letreros queda encendida con el local cerrado.
- Sin draws ni atributos nuevos: cada chunk trae en su JSON la lista `s` (edificio, si es
  comercial, tipos de alrededor y, por negocio, posición, tipo y letrero) y `sn` (los nombres);
  el worker arma una tabla por chunk (textura RGBA16UI de 256 de ancho: cabecera por edificio,
  tramos del muro y letras, ~11 KB por chunk en el centro) y el número de registro viaja en la
  parte fraccionaria de `aFacade.w` junto al azar del edificio.
- **Portales** en el centro: casi todos los edificios de más de un piso dentro del polígono de
  `portales.polygon` (del Malecón a la avenida Quito y de la calle Loja a la avenida Olmedo) tienen la planta
  baja como galería techada, igual que en Guayaquil: columnas y viga al frente y, por cada vano,
  el corredor con su piso de baldosa, el cielo raso con una lámpara y los locales en el muro del
  fondo, todo en profundidad falsa (el mismo truco que los cuartos). Adentro llega una parte de
  la luz del día; de noche, cada lámpara (alguna quemada) alumbra el piso, los locales y, con lo
  que rebota, el cielo raso.
- **Torres de vidrio**: muro cortina con parteluces, antepecho en cada losa y oficinas detrás.

Fuente, palabras, colores y medidas en `config/game.json` → `buildings.facade` (los portales, en
`buildings.facade.portales`; los tipos de local con sus colores, luz, interior, frente y horario,
en `buildings.facade.shops.kinds`). Qué negocios cuentan, cómo se arma el texto del letrero y qué
es una calle comercial: `config/region.json` → `shops`.

### Árboles

El paso `trees` baja el mapa de altura de copas de Meta/WRI v2 (2026, 1,2 m por píxel,
imágenes 2011-2019) recortado a la zona, busca las copas como máximos locales (la ventana
crece con la altura) y reparte el área de copa entre ellas para dar el radio. Se descartan
las que caen en el agua o en un edificio (el mapa es anterior a muchas construcciones) y las
que hoy la foto muestra como superficie clara. Los troncos que caen sobre la calzada se
corren al borde de la calle; la copa sigue tapándola, como en las avenidas arboladas.
~600 mil árboles, con alturas reales (mediana ~11 m, tope de 35 m).

En pantalla cada copa es una masa de hojas con bultos, no una esfera. Tiene un perfil más
lleno que una elipse, la base más plana y pliegues oscuros entre bultos. Las hojas salen de
un ruido 3D en metros del mundo, con racimos y grano fino: una textura de 32³ que se lee una
vez por octava. Ese ruido varía el color y, con su relieve, la luz. La base de la copa es
más oscura, porque la tapan sus propias hojas, y la luz del sol atraviesa las hojas, así que
vista desde la calle la copa no es una mancha negra. De lejos el detalle se funde para que no centellee.

A menos de 110 m de la cámara, las copas llevan más caras y el tronco se abre en ramas.
Todas van en una sola malla que se rearma cada 5 m de movimiento. Más allá se usan las de
cada chunk, con menos caras, que son también las que proyectan la sombra. En la vista más
cargada, con una copa que llena la pantalla, el shader de hojas cuesta ~0,4 ms por capa de
copas a resolución 2×; las sombras de todos los árboles, ~0,35 ms. La configuración está en
`config/game.json` → `trees` (`canopyShape`, `leaves`, `near`, `branches`).

### Puentes y malecones

El paso `bridges` arma en 3D las ~600 vías de OSM marcadas como puente: ~380 de carros
(Puente de la Unidad Nacional, pasos elevados), ~190 peatonales y ~30 escalinatas. Cada una
lleva su tablero con el perfil de altura (que sube por rampas desde el suelo y respeta el
gálibo sobre el agua), pilas, barandas o muretes según el tipo, y postes de luz. Se caminan,
se manejan y el tráfico va por encima.

Los **malecones** (Malecón 2000, Puerto Santa Ana, Malecón del Salado, Jardines del Malecón,
Malecón Eloy Alfaro y Malecón del Guasmo) salen del borde real del agua junto a los paseos
de OSM: un muelle a la altura de la orilla (mediana del relieve de tierra adentro, con tope
sobre el agua y pendiente suave), con baranda del lado del río, postes LED que alumbran el
paseo y una hilera de **palmeras** que se mecen con la brisa. Todo en `config/region.json` →
`bridges` (incluido `quays`) y `config/game.json` → `bridges` y `palms`.

### Íconos

Construidos a mano con piezas procedurales (sin modelos externos), en su lugar y a su escala:

- **La Perla**, la rueda moscovita del Malecón: estructura con rayos y cabinas que giran, y
  de noche los LED de colores que recorren la rueda (con su reflejo en el metal).
- **Torre Morisca**: base octogonal con arcos de herradura, reloj que marca la **hora del
  juego** y cúpula.
- **Hemiciclo de La Rotonda**: gradas, columnas, banderas y las estatuas de Bolívar y San
  Martín.
- **Faro del Cerro Santa Ana**: franjas en espiral, galería, linterna y haces que giran de
  noche.
- **Palacio Municipal** (Maccaferri, 1924-1929): la manzana entera, en su huella de OSM
  (63,6 × 58,5 m). Portales en arcada que se caminan (baldosas, locales con cortina metálica o
  vidriera, faroles colgados), balcón corrido con balaustrada, logia de columnas corintias de dos
  pisos, entablamento con modillones y dentículos, ático con jarrones, esquinas redondeadas con
  sus **cuatro cúpulas de escamas** (nervios que de noche se encienden celestes, lucarnas y
  óculos), un pabellón con frontón y gran arco al centro de cada fachada (cóndores en los
  extremos, el escudo de Guayaquil en los tímpanos de 10 de Agosto y Clemente Ballén), las dos
  banderas en la esquina del Malecón y el **Pasaje Arosemena**: se entra por el gran arco del
  Malecón o de Pichincha, bajo la bóveda de vidrio con costillas de hierro (su sombra cae en el
  piso de terrazo), balcones de hierro, faroles de globo y la cúpula octogonal del crucero. Se
  trepa como cualquier edificio (desde el portal o el pasaje) y se camina por la terraza.
- **Avenida 9 de Octubre**, del Malecón al Parque Centenario (~840 m, 18 cuadras): los 66
  edificios de sus frentes, cada uno con su huella de OSM y una entrada de config
  (`config/streets/nueve-de-octubre.json`) sobre unas pocas familias de fachada paramétricas
  (`src/world/downtown.ts`): portal guayaquileño con columnas, pisos de ventanas, losas y
  balcones corridos, esquinas redondeadas *streamline*, muro cortina, aletas, retículas,
  brutalista y neoclásico, con podio y torre retranqueada donde la hay (La Previsora, el Banco
  Central, San Francisco 300). Veredas de baldosa terracota con su bordillo, que siguen el
  terreno, y el mobiliario de la regeneración (`src/world/streetFurniture.ts`): los **faroles de
  hierro de dos linternas con la estrella celeste de Guayaquil** (78, en cada esquina y cada
  ~27 m; de noche alumbran en lugar de los postes genéricos), árboles en macetero de acero o en
  alcorque con rejilla (entran a los árboles de la ciudad) y bancas de listones.
- **Iglesia de San Francisco y Plaza Rocafuerte** (`src/world/church.ts`, un tipo de iglesia
  paramétrico para las que vengan): fachada de dos cuerpos con columnas, frontones y ventanas
  en arco, las **dos torres** de tres cuerpos (campanario, ventana con frontón, reloj que se
  enciende de noche) con sus cúpulas de nervios; nave, crucero con cúpula sobre tambor y ábside;
  el costado sobre la avenida con los locales, ventanales apuntados, pretil calado, pináculos y
  el hastial con el escudo franciscano; las alas del convento, y en la plaza la pila con sus
  surtidores y Vicente Rocafuerte sobre su pedestal. Con los colores de hoy: blanco con
  molduras y cúpulas azules.
- **Parque Centenario y la Columna de los Próceres** (`src/world/column.ts`,
  `src/world/park.ts`): la columna de 27 m sobre su plataforma con escalinatas, zócalo en talud,
  pedestal de granito rosado con medallones y placas, los próceres de bronce y las alegorías de
  las esquinas, el fuste de bronce con los grupos que suben en espiral, el panel y el sol dorados,
  el capitel de mármol y la Libertad con la antorcha sobre el cóndor; su óvalo de césped con
  reja baja. El parque: los paseos de losas y la plaza circular, la reja de lanzas con las
  portadas de cada entrada (postes de globos con su cóndor), los grupos de bronce sobre
  pedestales de mármol, faroles de globos y los dos mástiles con la bandera. Los árboles son los
  de los datos (la plaza circular queda despejada).

Se pisan (La Perla tiene su plataforma, las gradas de La Rotonda) y no se atraviesan. Formas,
colores y luces en `config/game.json` → `monuments`.

**Cómo se arma un ícono con arquitectura** (el Palacio, y los que vengan: la Gobernación, la
Biblioteca, Correos…). El procedimiento completo, de la investigación a la medición, está en
`.agents/skills/model-place/SKILL.md`. En corto:

- **Medidas reales**: la huella y el rumbo de las fachadas salen de OSM; las alturas, de fotos
  de Wikimedia Commons con una escala conocida (un carro, una persona) y de la foto satelital,
  que también muestra el techo (cúpulas, pasaje). Todo número va a la config, nada en el código.
- **Kit de piezas** (`src/world/classical.ts`): molduras barridas por cualquier recorrido (con
  ingletes), muros con arcos, puertas y ventanas, piezas curvadas para las esquinas redondeadas,
  columnas corintias (basa ática, fuste con éntasis, capitel con hojas y volutas), balaustres,
  jarrones, cóndores, ménsulas, frontones, coronas con estrella y cúpulas con nervios.
- **Material** (`src/render/surfacePatterns.ts`): cada vértice trae su **oclusión ambiental**
  (loggias, cielos rasos, portales, el fondo del pasaje) y un **dibujo procedural** con relieve:
  revoque con manchas y chorreado de humedad, escamas de las cúpulas, cortinas metálicas,
  terrazo y baldosas. De noche los reflectores alumbran según hacia dónde mira cada cara (muros y
  aleros sí, techos casi nada), así el relieve no se aplana.
- **Física**: los macizos entran al índice de edificios (se trepan); los aleros y bóvedas son
  obstáculos que empiezan en altura (debajo se camina) y la cámara no los atraviesa.
- **Rendimiento**: las piezas repetidas van instanciadas (1 015 dentículos, 970 balaustres, 56
  columnas…) con su versión simple de lejos (capiteles sin hojas desde 150 m, balaustres
  prismáticos desde 110 m); los adornos chicos no proyectan sombra; el macizo va en cuadrantes
  para que la cámara y las sombras descarten lo que no ven; los vértices se sueldan y sus
  atributos se guardan compactos (normales en 8 bits, luz en half float): 7,9 MB de geometría en
  vez de 32. Se arma en ~80 ms en la carga. Medido con 10 copias en la vista más cargada (la
  esquina del Malecón, resolución 2×): ~0,66 ms de GPU por palacio, sombras incluidas; lejos o
  fuera de cuadro, casi nada.
- **Terreno**: el relieve de los datos traía un bulto bajo el palacio (el DEM ve el edificio; la
  zona plana del centro lo achicó) y baja hacia el Malecón; la base va a la mediana de la vereda
  y cada puerta arranca de su suelo, así del lado del Malecón no quedan flotando.

**Calles y zonas** (la 9 de Octubre): no se modela cada edificio como el Palacio. Se recorre la
calle y se inventaría cada frente (tipo, pisos, portal, colores), y cada edificio es una
entrada de config sobre una familia de fachada; las veredas, los faroles, los árboles y las
bancas salen de reglas por cuadra. Las fuentes de la calle están versionadas en
`config/streets/nueve-de-octubre/` (el eje y las cuadras, el inventario de los 66 edificios y la
calzada medida en el juego), y `build_street.py` (en `.agents/skills/model-place/scripts/street/`,
con OSM y los datos del mundo) arma con ellas `config/streets/nueve-de-octubre.json`; el flujo
completo, para extenderla o hacer otra, está en la skill (`references/street-pipeline.md`). Cada cuadra es su propio lugar de la física y del detalle
(se descarta junta), y la calle despeja de los datos los edificios, árboles y postes que
reemplaza (`clear`). Piezas nuevas del kit: vanos de arco apuntado (`pointedHole`, `archPath`
para su marco), figuras de pie para estatuas (`figure`, que devuelve dónde quedan las manos
para lo que sostienen), remates de hastial (`gableTop`) y escudos (`shield`), piezas de caras
planas (`faceted`) o vistas desde adentro (`inward`), pisos que siguen el terreno (`pave`) y en
los dibujos procedurales la carpintería de las ventanas, adoquines, barrotes y balaustres
calados.
Rendimiento, medido con 10 copias en la vista más cargada de cada una (resolución 2×, sombras
incluidas): la avenida entera ~0,45 ms de GPU y 26,8 MB (unos 1,5 MB por cuadra, un quinto de
la manzana del Palacio), la iglesia con su plaza ~0,15 ms y 3,6 MB, el parque con la Columna
~0,11 ms y 4 MB. Se arman en ~140 ms en la carga.

### Estadios

Las huellas de un estadio son sus tribunas, y dibujadas como edificio salían como oficinas
con ventanas y locales. El paso `buildings` toma cada `leisure=stadium` de OSM con su cancha
adentro y rehace las tribunas **fila por fila**: franjas de 0,85 m de fondo que siguen el
contorno de la cancha (o del hueco de la tribuna que la rodea), la primera a 2,2 m sobre el
césped y cada una más alta hasta llegar a la altura medida de la tribuna. Se dibujan con su
propio estilo: hormigón con la nariz de cada grada marcada y los **asientos con el color real**
sacado de la foto satelital (el amarillo del Monumental, el azul del Capwell), sin ventanas ni
locales. Salen así el Monumental, el Capwell, el Modelo Alberto Spencer, el Christian Benítez,
el Pablo Sandiford y la Plaza de Toros: 46 huellas, 613 filas (`config/region.json` →
`buildings.stadiums`; colores y medidas en `config/game.json` → `buildings.stands`).

### Horizonte lejano

Desde lejos (un vuelo, la otra orilla en Durán) la ciudad se ve entera: el paso `skyline`
junta los edificios de más de 9 m de toda la ciudad (~30 mil) en 44 grupos. Se dibujan con
el mismo material que los cercanos (sin saltos al acercarse) y se ocultan por chunk donde
ya cargó el detalle; los medianos, solo hasta media distancia.

### De noche

- **Alumbrado público**: ~112 mil postes a lo largo de las calles reales (sodio naranja y LED
  blanco en las avenidas nuevas; algunos apagados), más los de puentes y malecones. Un worker
  pinta la luz que cae al suelo en un mapa fino alrededor del jugador y otro grueso de toda
  la ciudad; muros, árboles, carros y personajes la reciben. De lejos, cada luminaria es un
  punto de luz.
- **Ventanas encendidas**, vitrinas y letreros de los locales, el resplandor naranja de la
  ciudad en el cielo y las nubes, luna y estrellas.
- **Reflejos en el río**: cada luminaria cerca del agua deja su columna de luz sobre las olas,
  estirada hacia quien mira (modelo físico del destello, como el del sol en el mar, con
  Fresnel y tope en el brillo de la propia luz), con crestas que corren. Desde el río, el
  Malecón se ve con sus columnas doradas y, bajo La Perla, la de colores de sus LED (que giran
  y cambian con la rueda). `config/game.json` → `water.glints`.
- Faros y luces de freno de los carros (ver abajo).

### Tráfico

Carros, **taxis amarillos**, SUVs, camionetas y buses circulan por la derecha en su carril
por las calles reales alrededor del jugador (~400 m; más en las avenidas, menos en los
barrios). El paso `traffic` arma la red desde OSM: ~78 mil tramos entre cruces con su sentido
(incluidas las de un solo sentido), carriles, velocidad (`maxspeed` o la del tipo de vía) y si
van por un puente. Los carriles de OSM (`lanes`) se recortan a los que caben en el ancho con
que se dibuja la calle (`config/region.json` → `traffic.laneFitTolerance`): en 158 vías OSM
decía más de los que hay, y el carril de más pasaba por encima de los autos estacionados.

- Manejan con el modelo del conductor inteligente (IDM): aceleran hasta su velocidad,
  guardan distancia, frenan para doblar según la curva y **se detienen si te paras en la
  calle** (o ante tu carro).
- En los cruces pasan por **turnos de acceso**, como un semáforo que se adapta: pasan juntos
  los que vienen por la misma calle; si alguien espera por otra, al rato se le cede el paso.
- **Cuánto tráfico lleva cada calle.** No hay aforos abiertos para toda la ciudad, así que se
  estiman como en los modelos de transporte: el paso `traffic` simula ~24 mil viajes por el
  camino más rápido, entre orígenes y destinos elegidos según lo construido alrededor (Open
  Buildings: dónde vive y trabaja la gente), y cuenta cuántos pasan por cada tramo y sentido.
  La Perimetral, las Américas o la 9 de Octubre se llenan y las calles de barrio quedan
  tranquilas; los carros aparecen y eligen salida en proporción a ese flujo
  (`config/region.json` → `traffic.flow`, y `config/game.json` → `traffic.flow`).
- **Según la hora**: una curva horaria con las horas pico de la mañana (7-8) y de la tarde
  (17-19); de madrugada casi no hay carros (`traffic.hourly`).
- Eligen salida al azar (prefieren seguir derecho y las calles más transitadas); los buses
  solo van por avenidas.
- Luz de freno siempre; de noche, faros y luces de atrás con halos que se ven de lejos solo
  del lado al que apuntan.
- Los vehículos son procedurales (~250 triángulos cada uno), un solo dibujo por tipo.
  Tipos, colores, densidad y manejo en `config/game.json` → `traffic`.

### Peatones

Gente caminando por las veredas y senderos reales alrededor del jugador (~170 m): más en el
Malecón y las avenidas del centro, menos en los barrios, y según la hora (de madrugada casi
nadie). El paso `walks` arma la red peatonal: las veredas de cada calle a cada lado, con el
ancho con que se dibujan, los senderos (footway, pedestrian…), los puentes peatonales y los
paseos junto al agua de los malecones (los muelles de `bridges`, unidos a los senderos de
alrededor). En cada punta de un tramo sabe cuánto antes parar para no pisar la calzada de las
otras calles del cruce.

- Caminan por su derecha a su ritmo; en las esquinas doblan por su vereda o **cruzan la
  calle**: esperan en el borde a que no vengan carros (y los carros frenan ante quien cruza).
- Algunos se detienen un rato y otros **conversan de a dos**; se detienen ante el jugador y,
  si no se mueve, se dan la vuelta.
- Hombres y mujeres (*Universal Base Characters*, CC0) con estaturas de Ecuador, 3-4
  peinados, tono de piel, color de pelo y ropa de cada uno (camiseta, bividí o manga larga;
  jean, pantalón o short; zapatillas o sandalias), pintada en el shader como la del jugador.
- La animación va en la GPU: los huesos de cada cuadro están horneados en una textura, y cada
  persona lee el suyo (cambios de clip con mezcla). La velocidad de la zancada se mide del pie
  apoyado en el clip, así los pies no patinan. Tres niveles de detalle por distancia (de 15-18
  mil triángulos de cerca a ~1 200 de lejos, hechos con meshoptimizer en `assets`); sombras
  solo los cercanos.
- ~0,15 ms de GPU con unas 30 personas a la vista y ~0,2 ms de CPU con cien. Densidad, ropa,
  colores y comportamiento en `config/game.json` → `pedestrians`.

### Carga por partes

El mundo está partido en chunks de 500 m. Al inicio solo se cargan el relieve, la vista
general, el agua y el personaje; lo demás se pide según dónde estés:

- **Edificios** (radio que crece con la altura, con tope total de edificios en memoria):
  la geometría se arma en *web workers* (`src/world/buildingWorker.ts`) para no trabar.
- **Terreno detallado**: mallas por chunk cerca; lejos, una malla general que se recorta
  en el shader donde ya hay detalle.
- **Imagen satelital**: en desarrollo el juego pide los tiles a `/api/tiles/z/x/y` (servidor
  de Vite, `server/tileProxy.ts`), que los descarga una vez y los guarda en la misma caché del
  pipeline; publicado, directo a la fuente (`imagery.urlTemplate`). Solo se baja lo que se
  visita, y solo tiles dentro de la zona. Un worker
  (`src/world/imageryWorker.ts`) los decodifica y los pega recortados al chunk, así que el
  hilo principal solo sube la textura a la GPU.
- **Árboles**: por chunk, solo cerca de la cámara. Los de menos de 110 m se copian a una
  malla detallada que sigue a la cámara. Cada árbol se dibuja una sola vez: el corte
  cerca/lejos se hace en el shader, sin tocar las mallas de los chunks.
- **Calles**: por chunk, hasta ~700 m del jugador; se rasterizan en workers (20-70 ms por chunk).
- **Horizonte lejano y tráfico**: se cargan ya jugando, detrás de la pantalla de carga (sus
  shaders se compilan antes de mostrarlos).

Los radios, topes y niveles de zoom están en `config/game.json` (`streaming`, `imagery`).

### Rendimiento

La meta es 60 fps parejos también en equipos modestos, sin bajar la calidad de lo que se ve:

- **Tope de 60 fps** en cualquier pantalla (`render.frameCap`). El limitador mide el
  refresco real: en pantallas de ~60 Hz no salta nada (forzar 60,000 exactos en un monitor
  de 60,02 Hz metería un tirón cada pocos segundos); en 120 Hz dibuja uno sí y uno no; en
  144 Hz alterna para promediar exacto. Menos trabajo por segundo = menos calor y batería.
- **Resolución adaptativa** (`quality`): si la GPU no llega a los 60 fps, baja la resolución
  interna por escalones (y al final el mapa de sombras); cuando sobra margen, la sube. Con
  el tiempo real de GPU (`EXT_disjoint_timer_query_webgl2`) distingue si el cuello es la GPU
  o el procesador y predice si el escalón de arriba cabe antes de subir. En un equipo que
  llega holgado no cambia nada.
- **Sin compilaciones en pleno juego**: los shaders de personajes, planeadores y carro
  (incluidas sus variantes de sombra) se compilan en la pantalla de carga, y los ya
  compilados no se destruyen aunque la carga por partes libere todos sus materiales (antes,
  cruzar el río a Durán recompilaba edificios y terreno: 15-30 ms de tirón).
- **Ajuste de color dentro del tone mapping** (`render.grading`) en vez de un `filter` CSS
  sobre el canvas, que costaba una pasada extra de pantalla completa por frame.
- **Imagen satelital recortada al chunk**: ~47 % menos VRAM que componer tiles enteros.
- **Lo que no se ve no se manda a la GPU**: el horizonte lejano es un `BatchedMesh` por grupo
  que apaga cada chunk donde ya hay detalle; las palmeras van por celdas con distancia de
  dibujo; los reflejos del río solo mandan las luminarias cuya estela puede caer en la vista
  (primero por celdas en la CPU, luego una por una en la GPU) y se afinan en punta donde ya no
  se ven (~0,15 ms en la vista más cargada del Malecón). El tráfico cuesta ~0,2 ms de CPU por
  cuadro con ~160 vehículos.

Banco de pruebas (solo en desarrollo): en la consola del navegador, `await __gye.bench()`
recorre siempre la misma ruta (`config/bench.json`: quieto en el centro, vuelo rápido,
manejo, llegada a Durán) y reporta fps, percentiles de tiempo de frame, frames largos,
tiempo de GPU, draw calls y memoria.

## Estructura

```
config/region.json   zona (bbox), fuentes de datos, lugares, parámetros del pipeline
config/game.json     render, cámara, personajes, vehículos, controles, colores, streaming
config/assets.json   modelos de personajes y peatones (de dónde salen, animaciones, poses, ropa)
config/places.json   lugares con ficha (historia, fuentes, foto, dónde están) y lemas de los barrios
config/streets/      calles modeladas: <calle>.json (lo que lee el juego) y <calle>/ (sus fuentes:
                     eje y cuadras, inventario de fachadas, calzada medida)
.agents/skills/      skills para agentes; model-place trae los scripts de calles y los ayudantes
                     de consola del juego
pipeline/            build_world.py → public/world/ (manifest + binarios + texturas);
                     build_model.ts arma un .glb desde piezas glTF (y sus niveles de detalle)
src/world/           terreno, edificios (+colisiones), calles, agua y sus reflejos, árboles,
                     puentes y malecones, palmeras, íconos (y el kit de arquitectura clásica con
                     que se arman el Palacio Municipal, las iglesias y la Columna), calles
                     modeladas con sus fachadas y mobiliario (la 9 de Octubre), alumbrado,
                     tráfico, autos estacionados,
                     peatones, texturas por chunk
src/player/          personajes, controlador (caminar/trepar/nadar/planear), cámara, avatar, ropa, ala delta
src/vehicles/        carro: modelo procedural, física y subir/bajar
src/ui/              HUD, buscador, minimapa y mapa (capas vectoriales en canvas), pausa, reloj,
                     fichas de lugares y títulos de barrio
src/render/          cielo y luces, materiales, ajuste de color, calidad adaptativa, tope de fps,
                     precompilación de shaders, cabina en primera persona
src/dev/             banco de pruebas de rendimiento (solo en desarrollo)
src/core/            geo (UTM ↔ lat/lon), links de mapas, Plus Codes, ubicación del dispositivo
server/              endpoints de Vite: links cortos de Google Maps y proxy de tiles satelitales;
                     server/edge/ y server/cloudflare/: la misma función, publicada en el Worker
```

Para otra zona basta con cambiar `bbox`, `projection` (zona UTM) y `landmarks` en
`config/region.json` y volver a correr `npm run data`.

## Licencias y límites

- El código es **AGPL-3.0 o posterior** con términos adicionales de crédito (sección 7): toda
  versión debe mostrar "Kuntur 3D, creado por Javier Vinueza" en sus créditos, las modificadas
  deben marcarse como distintas y el nombre no viene con la licencia. Detalle en
  [NOTICE.md](NOTICE.md). Los textos de las fichas y el material propio van con CC BY-SA 4.0.
- Imagen satelital de Esri: uso personal / no comercial con atribución (la versión
  publicada es un prototipo sin fines comerciales). Para algo comercial conviene cambiarla (p. ej. Sentinel-2 cloudless de EOX, más
  borrosa) en `imagery.urlTemplate`. Donde la foto de Esri es de menor resolución
  (p. ej. partes del Suburbio) los techos y el suelo se ven pixelados.
- Nominatim: máximo 1 búsqueda por segundo (ya está limitado en el código).
- Fotos de las fichas: Wikimedia Commons con licencias libres (CC BY-SA / CC BY; ninguna NC ni
  ND). Cada ficha muestra autor y licencia con enlace a la página de la foto, como piden.
- Créditos completos en la pausa → CRÉDITOS (en la esquina inferior derecha va la versión corta,
  `config/game.json` → `hud.shortCredits`).

## Siguientes pasos posibles

- Más íconos con el mismo kit: la Gobernación (al frente del Palacio, en la Plaza de la
  Administración), la Biblioteca y el Museo Municipal, Correos, la Catedral y la 9 de Octubre
  del Parque Centenario a la Av. Quito (la Casa de la Cultura y la Corte Provincial).
- Más zonas planas (`terrain.flatZones`) si aparecen bultos de edificios en otros barrios densos.
- Vendedores ambulantes y gente sentada en las bancas del Malecón.
- Semáforos visibles en los cruces.
- Que tu carro choque con el tráfico (hoy los vehículos frenan ante ti pero no hay choque).
- Metrovía por sus troncales, con sus paradas.
- Más rendimiento: sombras en cascada más baratas, imagen satelital comprimida en GPU
  (BC7/ASTC al vuelo) y, a futuro, migrar a WebGPU pasando los materiales a TSL.
- Imagen z19 solo para los chunks cercanos.
- Multijugador.
