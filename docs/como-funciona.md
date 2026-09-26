# Cómo funciona

No existe una malla 3D fotorrealista de Ecuador: Apple y Google no tienen cobertura
fotogramétrica en el país. Kuntur 3D reconstruye la ciudad a partir de capas abiertas, y usa la
foto satelital donde más aporta.

## Contenido

1. [Fuentes de datos](#fuentes-de-datos)
2. [Pipeline de datos](#pipeline-de-datos)
3. [Calles](#calles)
4. [Parques y canchas](#parques-y-canchas)
5. [Edificios](#edificios)
6. [Techos](#techos)
7. [Fachadas](#fachadas)
8. [Estadios](#estadios)
9. [Árboles](#árboles)
10. [Puentes y malecones](#puentes-y-malecones)
11. [Horizonte lejano](#horizonte-lejano)
12. [Noche](#noche)
13. [Tráfico](#tráfico)
14. [Peatones](#peatones)
15. [Carga por partes](#carga-por-partes)
16. [Rendimiento](#rendimiento)

Los lugares modelados a mano (íconos, centros comerciales, urbanizaciones y calles) están en
[lugares.md](lugares.md).

## Fuentes de datos

| Capa | Fuente | Uso |
|---|---|---|
| Suelo | Esri World Imagery: z18 (~0,6 m/px) y z17 cerca; una vista general de 7 m/px lejos | Se dibuja casi sin iluminar, porque la foto ya trae el sol y las sombras reales; solo una parte recibe luz para mostrar las sombras propias. De cerca, el color de la foto decide el detalle: pasto donde es verde, tierra con piedras donde es cálida. |
| Relieve | Copernicus DEM GLO-30 | Es un modelo de superficie (incluye edificios). Una apertura morfológica quita los bultos de los edificios sin borrar los cerros. En las zonas planas y densas (`config/region.json` → `terrain.flatZones`, hoy el centro) se usa una ventana mayor, que solo baja el suelo. |
| Edificios | Overture Maps (OSM, Google Open Buildings, Microsoft) y Google Open Buildings 2.5D | Huellas de Overture, alturas de Open Buildings 2.5D (satélite + IA), y los edificios que solo Open Buildings detecta. |
| Calles | OpenStreetMap | Se dibujan nítidas encima de la foto satelital, que de cerca es borrosa: calzada por material, veredas, carriles y pasos cebra. |
| Árboles | Meta y WRI, High Resolution Canopy Height Maps v2 | Cada copa con su altura real y su radio; el color sale de la foto. |
| Agua | Overture Maps | Semitransparente sobre la foto del río. |

Límites de las fuentes:
- Donde la foto de Esri tiene menor resolución (partes del Suburbio), el suelo y los techos se
  ven pixelados.
- Se evaluó GEDTM30 (el modelo de terreno global de OpenGeoHub, sin edificios) como alternativa
  al DEM de Copernicus. En el centro trae bultos mayores, así que no se usa.

## Pipeline de datos

`npm run data` corre `pipeline/build_world.py`, que genera ~190 MB en `public/world/` y guarda
~400 MB de descargas reutilizables en `pipeline/.cache/`. Los pasos se pueden rehacer sueltos:
`uv run pipeline/build_world.py --steps imagery,trees`.

| Paso | Qué hace |
|---|---|
| `water` | Ríos y esteros de Overture → polígonos locales |
| `terrain` | Copernicus DEM → relieve sin los bultos de los edificios, con el agua hundida. Se guarda en 16 bits (menos de 4 mm de error), como diferencias por fila y con gzip: 4,7 MB en vez de 29 MB |
| `buildings` | Overture + Google Open Buildings 2.5D → huellas con altura, incluidos los edificios que faltan |
| `imagery` | Esri World Imagery → vista general y tiles |
| `roads` | OSM → ejes de calles, parques, canchas, cruces y postes de alumbrado; parques simplificados para el mapa (`map.json`) |
| `bridges` | OSM → puentes en 3D (tablero, pilas, rampas, postes) y los muelles de los malecones con sus palmeras |
| `aerial` | Teleféricos de OSM (la Aerovía) → torres con su altura, estaciones y cable |
| `traffic` | OSM → red de tramos entre cruces para el tráfico (sentido, carriles, velocidad, puentes) |
| `walks` | OSM + `roads` + muelles → red peatonal (veredas a cada lado, senderos, paseos junto al agua) |
| `roofs` | Foto + forma → techos de teja o losa |
| `shops` | Negocios de Overture Places + calles → locales con su nombre en las plantas bajas y calles comerciales |
| `skyline` | Los edificios altos de toda la ciudad, en grupos → el horizonte lejano |
| `trees` | Meta/WRI → árboles con su altura real |
| `ao` | Edificios + copas + relieve → cielo visible desde el suelo (oclusión ambiental) |
| `landmarks` | Nominatim → lugares emblemáticos (la lista de LUGARES y el mapa) |
| `places` | `config/places.json` + límites de OSM → ubicación de cada ficha, fotos de Wikimedia Commons y barrios |
| `search` | Calles, esquinas y barrios de OSM + negocios de Overture Places validados con OSM → índice del buscador (`search.json`) |
| `assets` | El personaje y los peatones, con sus peinados y niveles de detalle |

Los pasos corren en ese orden. Al rehacer uno, conviene rehacer también los que dependen de él:
`roofs`, `shops` y `skyline` después de `buildings`, y `skyline` después de `shops`.

En desarrollo, el servidor de Vite (`npm run dev` o `npm run preview`) además expande los links
cortos de Google Maps y hace de proxy con caché de la imagen satelital. En producción esas
funciones las cubre el Worker ([publicar.md](publicar.md)).

## Calles

El paso `roads` descarga de OSM (Overpass, con servidores alternos y caché) las ~45 mil vías de
la zona, los estacionamientos, las plazas peatonales y los cruces peatonales. Por cada parte del
mundo guarda los ejes con:

- **Ancho** según el tipo de vía (`config/region.json` → `roads.classes`), o `width`/`lanes` de
  OSM cuando existen; **carriles y sentido** para las líneas pintadas.
- **Material** (asfalto, hormigón, adoquín, tierra). Sale de la etiqueta `surface` de OSM cuando
  existe (~53 % de las vías). Si no, lo decide un clasificador de vecinos más cercanos, que
  combina el color de la foto a lo largo del eje con el material de las calles etiquetadas
  alrededor; acierta ~81 % en validación cruzada. Cuando duda, usa el material típico del tipo de
  vía. Cada calle guarda además su **tono**, más claro o más gastado según la foto.
- **Veredas** por lado, según las etiquetas `sidewalk*` de OSM o el ancho típico del tipo de vía.
- **Estacionamiento y veredas medidos contra las fachadas.** OSM casi nunca trae el ancho de la
  calzada ni si se estaciona, así que cada 6 m del eje se traza una recta de 25 m a cada lado
  hasta el edificio más cercano (~1 millón de rectas, ~7 s).
  - Donde cabe un carril de estacionamiento (2,2 m) más una vereda mínima, se agrega ese carril,
    según la probabilidad de la clase de vía.
  - En las cuadras de fachada continua, la vereda llega hasta la fachada.
  - En las avenidas de doble calzada, el lado del parterre queda sin estacionamiento ni vereda.
  - Las etiquetas `parking:*` y `sidewalk*` de OSM tienen prioridad.

  Todo en `config/region.json` → `roads.parking`.
- **Autos estacionados** en esos carriles (~263 mil, `parking.bin`):
  - uno cada 6,2 m, según la ocupación de su cuadra;
  - sin tapar cruces, pasos peatonales, entradas de garaje ni las puntas de la vía;
  - mirando hacia donde se circula por su lado;
  - cada puesto se prueba contra la calzada de todas las vías, con 30 cm de tolerancia, para que
    ningún auto quede sobre una calzada (`roads.parking.spots`).

  En la app (`src/world/parkedCars.ts`) se dibujan los que están a menos de 320 m, con los
  modelos y las pinturas del tráfico, y son obstáculos.
- **Intersecciones** entre vías pintadas, donde se cortan las líneas, y **cruces peatonales**
  (nodos `crossing` de OSM → pasos cebra).

En el cliente, un worker (`src/world/roadWorker.ts`) convierte cada parte en texturas de
**distancia con signo** de 1,25 m por texel: distancia al borde por material, distancia al eje,
posición a lo largo del eje, carriles, intersecciones y cruces. El shader del terreno reconstruye
bordes y líneas finas a cualquier zoom a partir de esas distancias, y a partir de ~400 m de la
cámara las funde con la foto. Colores, patrones (losas, adoquines, huellas en la tierra), líneas y
cebras se configuran en `config/game.json` → `roads`.

Límites: la geometría de OSM puede estar corrida 1-3 m respecto de la foto, y los anchos son
estimados. Los puentes no se pintan en el suelo; se construyen en 3D.

## Parques y canchas

El paso `roads` descarga también ~1.800 parques y áreas verdes y ~1.270 canchas
(`config/region.json` → `grounds`). El worker de calles los rasteriza en dos texturas más por
parte:

- **Parques**: baldosas grandes con el tono de la foto donde no es verde, y pasto donde lo es.
- **Canchas**: cada una guarda su rectángulo orientado, y el shader pinta las líneas
  reglamentarias escaladas a su tamaño: fútbol, básquet, vóley y ecuavóley, tenis, o solo el
  contorno y la media cancha. El césped lleva franjas de corte. La superficie sale de `surface`
  de OSM o de la foto.

Configuración en `config/game.json` → `roads.parks`, `roads.pitches` y `terrain.ground`.

## Edificios

**Alturas.** El percentil 75 del raster de Open Buildings dentro de cada huella es lo que mejor
calza con los pisos de OSM en Guayaquil (error típico ~2,8 m, sin sesgo). Las torres de más de
~60 m quedan más bajas que en la realidad cuando OSM no trae su altura. Los colores de fachada se
generan: ninguna fuente abierta los tiene.

**Edificios faltantes.** Las huellas de Overture omiten sobre todo galpones grandes (de hasta
5 ha) y casas nuevas. El paso `buildings` compara el mapa de presencia de Open Buildings 2.5D con
las huellas y vectoriza cada mancha sin huella: ~25 mil edificios, ~10 km². Cada una se recorta
contra las huellas vecinas y se regulariza a rectángulo cuando corresponde
(`config/region.json` → `buildings.fill`).

**Galpones.** Las huellas grandes y bajas (≥ 2000 m², ≤ 20 m) se dibujan como galpón: lámina con
nervios, zócalo, franja alta de ventanas y portones enrollables.

**Contornos que no son un edificio.** Algunas huellas de Overture son el contorno de una
manzana, de un patio o de un barrio entero. Si dentro Open Buildings detecta varios techos
separados y ninguno ocupa más de la mitad, la huella se descarta y esos techos entran como
edificios propios: 190 huellas, 2,27 km² (`buildings.outline`).

**Casas escalonadas en las laderas.** En los cerros, una huella suele cubrir varias casas que
suben por la pendiente. Donde el suelo bajo una huella sube más de 3,5 m, se le ajusta un plano a
la ladera y se corta en terrazas a lo largo de la pendiente y en casas de ~7 m de frente a lo
largo de las curvas de nivel, desfasadas fila a fila. Cada pieza toma su propia altura de Open
Buildings: 5 831 huellas partidas en 36 517 casas (`buildings.terrace`).

**Huellas superpuestas.** Cuando dos huellas comparten un tramo de pared, las dos paredes quedan
en el mismo plano y se pelean la profundidad. A cada huella se le resta lo que ocupan las de techo
más alto que la pisan (a igual techo gana la de más área), sobre la misma grilla de 10 cm con que
se guardan los contornos. Así:
- la silueta de la ciudad no cambia;
- el edificio bajo contenido en otro desaparece;
- el podio de una torre queda como un anillo alrededor.

Se recortan 48 530 huellas y se quitan 83; no queda ningún par con pared compartida
(`buildings.overlaps`).

## Techos

El paso `roofs` analiza cada edificio con forma de casa: rectangular, de hasta ~3 pisos, entre 25
y 450 m². Toma el color de la foto en el centro del techo. Si es teja (tono rojo-naranja con
saturación suficiente), le asigna techo inclinado; si no, losa plana. Resultan ~44 mil techos de
teja de ~515 mil edificios, con variaciones fieles a la foto: ~50 % de teja en las ciudadelas de
Durán, ~7 % en el Suburbio y ~1 % en el Guasmo.

- **Teja**: a dos o cuatro aguas, con la cumbrera a lo largo del lado largo, pendiente de 18° a
  30° y alero con canto. La altura medida queda a media agua. Se puede caminar y aterrizar sobre
  las aguas.
- **Losa**: con tanque de agua (negro, azul o blanco) en ~la mitad de las casas bajas.

Reconocimiento en `config/region.json` → `buildings.roofs`; alero y tanques en
`config/game.json` → `buildings`. Si se rehace `buildings`, hay que rehacer `roofs`.

## Fachadas

Todas las fachadas salen de un solo shader, sin texturas. Cada edificio elige su estilo con una
semilla propia.

- **Ventanas** con marco, repisa y un **cuarto detrás** (paredes, piso y cortinas, con
  profundidad simulada que se mueve con la cámara), rejas en los pisos bajos, aires
  acondicionados y manchas de humedad bajo las repisas y desde el pretil.
- **Locales donde hay negocios** (paso `shops`). Son los ~10 mil negocios de calle de Overture
  Places: farmacias, tiendas, comida, bancos, ferreterías, talleres; sin oficinas, colegios ni
  iglesias.
  - Cada negocio va al edificio que lo contiene o al que tiene a menos de 8 m, con el letrero en
    el muro que da a la calle.
  - El letrero lleva su nombre real, de hasta 20 letras. Se prefiere la marca y se quitan la
    sucursal y el centro comercial: "Pizza Hut Vergeles" → PIZZA HUT.
  - Cada tipo tiene su aspecto: la farmacia verde con luz fría, la comida con luz cálida, la
    ferretería abierta con su cortina enrollada, el banco con escritorio.
  - Una cadena lleva el mismo color en todas sus sucursales.
- **Calles comerciales**: donde hay muchos negocios juntos (≥ 5 edificios con negocios y ≥ 15 %
  de los edificios en 110 m, o ≥ 3 en 90 m de la misma calle), toda la planta baja son locales.
  Los que Overture no tiene llevan una palabra genérica de los tipos más comunes alrededor
  (FARMACIA, CEVICHERIA, BAZAR, VIVERES…). Fuera de esas zonas, el local ocupa solo su tramo de
  muro. Las letras usan una fuente de 5 × 5 y de lejos se funden en su tono promedio.
- **Horarios**: de noche, cada local abre o cierra según el horario típico de su tipo (bancos
  hasta las 17 h, tiendas hasta las 20 h, bares hasta la madrugada, algunas farmacias 24 h).
- **Datos por parte**: cada parte del mundo trae en su JSON las listas `s` (edificios y negocios)
  y `sn` (nombres). El worker arma una tabla RGBA16UI de 256 de ancho por parte (~11 KB en el
  centro), y el número de registro viaja en `aFacade.w`, sin draws ni atributos adicionales.
- **Portales** en el centro, dentro de `portales.polygon`: casi todos los edificios de más de un
  piso tienen la planta baja como galería techada. Tienen columnas, el corredor con su piso de
  baldosa, el cielo raso con una lámpara por vano y los locales al fondo, todo con profundidad
  simulada. De noche cada lámpara alumbra el piso, los locales y el cielo raso.
- **Torres de vidrio**: muro cortina con parteluces, antepecho en cada losa y oficinas detrás.

Configuración en `config/game.json` → `buildings.facade` (portales en
`buildings.facade.portales`; tipos de local en `buildings.facade.shops.kinds`) y en
`config/region.json` → `shops`.

## Estadios

Las huellas de un estadio son sus tribunas. El paso `buildings` toma cada `leisure=stadium` de
OSM con su cancha y rehace las tribunas **fila por fila**: franjas de 0,85 m de fondo que siguen
el contorno de la cancha, la primera a 2,2 m sobre el césped, hasta la altura medida de la
tribuna. Se dibujan en hormigón con la nariz de cada grada marcada y los **asientos con el color
real** sacado de la foto. Así se construyen el Monumental, el Capwell, el Modelo Alberto Spencer,
el Christian Benítez, el Pablo Sandiford y la Plaza de Toros: 46 huellas, 613 filas
(`config/region.json` → `buildings.stadiums`; `config/game.json` → `buildings.stands`).

## Árboles

El paso `trees` descarga el mapa de altura de copas de Meta/WRI v2 (1,2 m por píxel, imágenes de
2011-2019). Busca las copas como máximos locales, con una ventana que crece con la altura, y
reparte el área de copa entre ellas para dar el radio. Se descartan las copas que caen en el
agua, en un edificio o sobre una superficie que hoy la foto muestra despejada. Los troncos sobre
la calzada se corren al borde de la calle. Resultan ~600 mil árboles con alturas reales (mediana
~11 m, máximo 35 m).

Cada copa es una masa de hojas con bultos: perfil más lleno que una elipse, base más plana y
pliegues oscuros. Las hojas salen de un ruido 3D en metros del mundo (una textura de 32³) que
varía el color y la luz. La base es más oscura, y la luz del sol atraviesa las hojas. De lejos,
el detalle se funde para que no centellee.

A menos de 110 m de la cámara, las copas tienen más caras y el tronco se abre en ramas, en una
sola malla que se rearma cada 5 m de movimiento. Más lejos se usan las mallas de cada parte, que
también proyectan las sombras. En la vista más cargada, el shader de hojas cuesta ~0,4 ms por
capa de copas a resolución 2×, y las sombras de todos los árboles ~0,35 ms. Configuración en
`config/game.json` → `trees`.

## Puentes y malecones

El paso `bridges` construye en 3D las ~600 vías de OSM marcadas como puente: ~380 vehiculares
(el Puente de la Unidad Nacional, los pasos elevados), ~190 peatonales y ~30 escalinatas. Cada
una tiene:
- su tablero, con un perfil de altura que sube por rampas desde el suelo y respeta el gálibo
  sobre el agua;
- pilas;
- barandas o muretes según el tipo;
- postes de luz.

Se caminan, se manejan y el tráfico pasa por encima.

Los **malecones** (Malecón 2000, Puerto Santa Ana, Malecón del Salado, Jardines del Malecón,
Malecón Eloy Alfaro y Malecón del Guasmo) salen del borde real del agua junto a los paseos de
OSM. Cada uno es un muelle a la altura de la orilla, con baranda del lado del río, postes LED y
una hilera de palmeras que se mecen con la brisa. Configuración en `config/region.json` →
`bridges` (incluido `quays`) y `config/game.json` → `bridges` y `palms`.

## Horizonte lejano

El paso `skyline` agrupa los edificios de más de 9 m de toda la ciudad (~30 mil) en 44 grupos, que
se ven desde lejos: en un vuelo o desde la otra orilla. Usan el mismo material que los edificios
cercanos, para que no haya saltos al acercarse, y se ocultan en cada parte donde ya cargó el
detalle.

## Noche

- **Alumbrado público**: ~112 mil postes a lo largo de las calles reales, con sodio naranja y LED
  blanco en las avenidas nuevas, más los de puentes y malecones. Un worker pinta la luz que cae
  al suelo en un mapa fino alrededor de la cámara y en otro grueso de toda la ciudad. Muros,
  árboles, carros y personajes reciben esa luz, y de lejos cada luminaria es un punto de luz.
- **Ventanas encendidas**, vitrinas y letreros, el resplandor de la ciudad en el cielo y las
  nubes, la luna y las estrellas.
- **Reflejos en el río**: cada luminaria cerca del agua deja una columna de luz sobre las olas,
  estirada hacia quien mira. Usa un modelo físico del destello, con Fresnel y crestas que
  corren. Configuración en `config/game.json` → `water.glints`.
- Faros y luces de freno de los vehículos.

## Tráfico

Carros, taxis amarillos, SUVs, camionetas y buses circulan por la derecha, en su carril, por las
calles reales alrededor de la cámara: ~400 m, más en las avenidas y menos en los barrios.

El paso `traffic` arma la red desde OSM: ~78 mil tramos entre cruces, con su sentido, sus
carriles, su velocidad (`maxspeed` o la del tipo de vía) y si van por un puente. Los carriles de
OSM se recortan a los que caben en el ancho con que se dibuja la calle
(`config/region.json` → `traffic.laneFitTolerance`).

- **Conducción**: modelo del conductor inteligente (IDM). Los vehículos aceleran hasta su
  velocidad, guardan distancia, frenan antes de doblar según la curva y se detienen ante una
  persona o un carro en la calle.
- **Cruces**: turnos de acceso, como un semáforo adaptativo.
- **Flujo por calle**: no hay aforos abiertos de toda la ciudad, así que se estima como en los
  modelos de transporte. El paso `traffic` simula ~24 mil viajes por el camino más rápido, entre
  orígenes y destinos ponderados por lo construido alrededor (Open Buildings), y cuenta cuántos
  pasan por cada tramo y sentido. Las avenidas principales se llenan y las calles de barrio
  quedan tranquilas (`config/region.json` → `traffic.flow`; `config/game.json` →
  `traffic.flow`).
- **Hora del día**: una curva horaria con picos de mañana (7-8 h) y de tarde (17-19 h), y muy poco
  tráfico de madrugada (`traffic.hourly`).
- **Rutas**: en cada cruce eligen salida al azar, con preferencia por seguir derecho y por las
  calles más transitadas; los buses solo van por avenidas.
- **Luces**: luz de freno siempre; de noche, faros y luces traseras con halos direccionales.
- **Modelos**: vehículos procedurales de ~250 triángulos, un solo dibujo por tipo.

Configuración en `config/game.json` → `traffic`.

## Peatones

Gente camina por las veredas y senderos reales alrededor de la cámara (~170 m). Hay más en el
Malecón y en las avenidas del centro, menos en los barrios, y la cantidad cambia según la hora.

El paso `walks` arma la red peatonal: las veredas de cada calle a cada lado, los senderos, los
puentes peatonales y los paseos junto al agua. En cada extremo de un tramo, la red sabe dónde
parar para no pisar la calzada de las otras calles del cruce.

- **Comportamiento**:
  - caminan por su derecha a su ritmo;
  - en las esquinas doblan o cruzan la calle, esperando a que no vengan carros; los carros frenan
    ante quien cruza;
  - algunos se detienen o conversan de a dos;
  - ante la persona que explora se detienen y, si no se mueve, se dan la vuelta.
- **Aspecto**: hombres y mujeres (*Universal Base Characters*, CC0) con estaturas de Ecuador,
  varios peinados, y tono de piel, pelo y ropa propios de cada uno.
- **Animación**: va en la GPU. Los huesos de cada cuadro están horneados en una textura, y la
  velocidad de la zancada se mide en el clip para que los pies no patinen. Tienen tres niveles de
  detalle, de 15-18 mil triángulos a ~1 200. Solo los cercanos proyectan sombra.
- **Costo**: ~0,15 ms de GPU con unas 30 personas a la vista, y ~0,2 ms de CPU con cien.

Configuración en `config/game.json` → `pedestrians`.

## Carga por partes

El mundo está dividido en partes (*chunks*) de 500 m. Al inicio se cargan solo el relieve, la vista
general, el agua y el personaje; lo demás se pide según la posición:

- **Edificios**: un radio que crece con la altura, con un tope de edificios en memoria. La
  geometría se arma en web workers (`src/world/buildingWorker.ts`).
- **Terreno**: mallas detalladas cerca y una malla general lejos, recortada en el shader donde ya
  hay detalle.
- **Imagen satelital**: solo se descargan los tiles de lo que se visita, dentro de la zona. En
  desarrollo pasan por el proxy del servidor (`server/tileProxy.ts`), que los guarda en la caché
  del pipeline; en producción se piden directo a la fuente (`imagery.urlTemplate`). Un worker
  (`src/world/imageryWorker.ts`) los decodifica y los recorta a cada parte.
- **Árboles**: por parte, solo cerca de la cámara. El corte entre cerca y lejos se hace en el
  shader.
- **Calles**: por parte, hasta ~700 m; se rasterizan en workers (20-70 ms por parte).
- **Horizonte lejano y tráfico**: se cargan después, con sus shaders compilados antes de
  mostrarse.

Radios, topes y niveles de zoom en `config/game.json` → `streaming` e `imagery`.

## Rendimiento

La meta es 60 fps estables en equipos modestos, sin reducir la calidad visible:

- **Tope de 60 fps** en cualquier pantalla (`render.frameCap`). El limitador mide el refresco
  real del monitor: a ~60 Hz no descarta cuadros, a 120 Hz dibuja uno de cada dos y a 144 Hz
  alterna para promediar 60.
- **Resolución adaptativa** (`quality`): si la GPU no llega a 60 fps, baja la resolución interna
  por escalones y, al final, el mapa de sombras. Cuando sobra margen, la sube. Usa el tiempo real
  de GPU (`EXT_disjoint_timer_query_webgl2`) para distinguir si el límite es la GPU o el
  procesador, y predice si el escalón siguiente cabe antes de subir.
- **Sin compilaciones durante la exploración**: los shaders de personajes, planeadores y carro,
  con sus variantes de sombra, se compilan en la pantalla de carga, y los programas compilados se
  conservan aunque la carga por partes libere sus materiales.
- **Ajuste de color dentro del tone mapping** (`render.grading`), sin una pasada extra de
  pantalla completa.
- **Imagen satelital recortada a cada parte**: ~47 % menos memoria de video que con tiles
  enteros.
- **Solo se envía a la GPU lo que se ve**:
  - el horizonte lejano es un `BatchedMesh` por grupo que apaga las partes con detalle;
  - las palmeras se agrupan en celdas con distancia de dibujo;
  - los reflejos del río solo envían las luminarias cuya estela puede caer en la vista (~0,15 ms
    en la vista más cargada del Malecón);
  - el tráfico cuesta ~0,2 ms de CPU por cuadro con ~160 vehículos.

**Banco de pruebas** (solo en desarrollo): en la consola del navegador, `await __gye.bench()`
recorre una ruta fija (`config/bench.json`: quieto en el centro, vuelo rápido, manejo y llegada a
Durán). Reporta fps, percentiles del tiempo de cuadro, cuadros largos, tiempo de GPU, draw calls
y memoria.
