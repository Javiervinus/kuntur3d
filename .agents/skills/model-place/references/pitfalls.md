# Revisión antes de cerrar y errores conocidos

## Contenido

1. La revisión antes de cerrar
2. Errores que ya costaron tiempo

## 1. La revisión antes de cerrar

Las capturas no muestran todo. En la 9 de Octubre, una revisión del código hecha aparte encontró
unos 25 problemas que ninguna captura había mostrado: techos al revés, caras dobles, valores
prestados de otro campo, un portal que no se caminaba, faroles que no alumbraban. En los centros
comerciales, The Point y Durán City, cinco revisores por tema encontraron techos que no se
pisaban, muros invisibles bajo un vuelo, caras que titilaban y un bucle que podía colgar la carga.

Por eso, antes de dar un lugar por terminado:

1. Lanzar **un revisor independiente**: un subagente sin el contexto de la sesión, con el diff y
   esta lista.
2. Verificar cada hallazgo antes de corregirlo.
3. Después de corregir, volver a mirar en el juego lo que se tocó.

**Geometría**
- **Caras.** Mirar el lugar desde arriba y desde cada lado. Una cara al revés desaparece vista de
  frente.
  - En `Batch.quad`/`tri` el orden es antihorario visto desde afuera.
  - En `sweep`, cada lado va de derecha a izquierda visto desde afuera.
  - En `lathe`, el perfil va de afuera hacia adentro.
- **Caras dobles.** El material calado (`cutout`: rejas, balaustres) ya es de dos caras: una sola
  cara basta. Solo lo opaco que se ve de los dos lados (una bandera) lleva dos.
- **Caras en el mismo plano.** Dos caras que coinciden (el canto de una losa sobre su muro, un
  abanico dentro del rectángulo que ya cierra la punta) o que se separan milímetros (las líneas
  pintadas de una cancha) titilan. Con la cámara del juego, 2 mm dejan de alcanzar a unos 140 m:
  lo pintado encima va a lo de cerca o se separa al menos 1 cm, con su propio campo.
- **Cierres.** `arc` repite el primer punto al final: `.slice(0, -1)` antes de un `sweep`
  cerrado. La revisión y el armado deciden igual si una polilínea cierra.
- **Pocos lados.** Conos, pirámides y troncos de 4 lados van con `faceted`; si no, salen con
  sombreado suave.
- **Interiores.** Lo que se ve por dentro (un macetero, una pila) lleva su pared con `inward`.
- **Encuentros.** Que cada pieza toque lo que sostiene o la sostiene: balaustres al pasamanos,
  molduras sobre su muro, cruces de frente a donde se mira, plafones contra su techo.
- **Instancias.** Ninguna matriz de instancia espeja (determinante negativo).
- **Bucles.** Todo bucle que avanza por un largo de la config lleva un contador entero y un tope.

**Config**
- **Cada medida con su propio campo.** Nada prestado de otro campo (p. ej. el vuelo de una
  pilastra como fondo de un frontón, o `signOffset`, la separación de un letrero, contra el
  parpadeo de dos capas) ni escrito en el código, ni la `ao` de un vano.
- **Campos sin uso** en la config o en la interfaz: se borran.
- **Dibujos** por nombre con `patternOf`, que falla si el nombre no existe.
- **`check()` de un lugar con archivo**: falla con un mensaje claro ante lo que armaría mal, y
  exige lo que tiene un lugar terminado (fuentes, volúmenes).
- **Generadores**: todo script que escribe un archivo de `config/` lee fuentes versionadas y
  tiene `--check`.

**Física** (se verifica con `probe`, ver `browser.md`)
- Todo lo que se camina (portales, arcadas, pasajes, plazas, marquesinas) queda libre para
  alguien parado en el suelo, con el techo a su altura. Se prueba también **caminando** (`walk`):
  la consulta sola no ve los huecos entre piezas.
- Los muros de afuera (el cascarón con los vanos) también atajan: el macizo de la física llega a
  la cara de afuera, no se queda en el núcleo.
- Cada pilar y cada jamba de lo que se camina tiene su caja.
- Rejas y bordillos atajan: si se pueden trepar, que tengan el alto de trepar. El grosor de su
  física sale de `ground.wall` (~0,25 m), no del grosor visible.
- Pisos elevados (césped, plazas): un piso a su altura, para no hundirse.
- Un macizo con techo inclinado (`LocalRoof`) va hasta la cumbrera.
- Lo que vuela sobre otro volumen (una torre sobre su podio) va desde su base (`raised`), y lo
  que se apoya en un techo (los postes de una pérgola) registra su física desde su pie.
- Donde llega una escalera a un puente o a una terraza, la baranda tiene su hueco.

**Luz**
- Los faroles modelados alumbran el piso: van en `Monuments.lanterns`. Los plafones de
  marquesinas y soportales, también.
- De noche no queda nada negro donde la gente camina.
- Si la foto de noche muestra la fachada bañada de luz, la entrada de `config/game.json` lleva
  `flood` > 0.

**Terreno**
- Muestrear el suelo en **toda** la huella, no solo en el frente. Si sube metros bajo una
  manzana, lo que da a otra calle queda medio enterrado si arranca de la misma base.
- Si la subida viene de un bulto del relieve (edificios altos que el modelo de elevación ve como
  suelo), se corrige en el pipeline con una zona plana (`terrain.flatZones`), no en el lugar.

**Fidelidad**
- Cada edificio comparado con su foto más nueva **desde el mismo punto y con el mismo lente**
  (`shotPhoto`). Los conteos (vanos, pisos, columnas, locales) dan igual que en la foto.
- Cada registro del inventario con su `source`, y las fechas de las fotos en `sources`.
- Letreros: solo nombres de negocios. Ni teléfonos (son datos de alguien) ni propaganda política
  (partidaria, y queda vieja en meses). Antes de sumar letreros, mirar cuánto del atlas queda.

**Privacidad**
- Una casa o una urbanización privada: sin ficha, sin punto de interés, sin nombres de etapas ni
  de dueños en la interfaz. Los letreros que están en la calle sí.
- Revisar también el buscador (`public/world/search.json`), que toma nombres de OSM y Overture.

**Cierre**
- La consola del juego sin errores.
- `npm run build` pasa.
- En calles, `build_street.py <calle> --check` coincide; en urbanizaciones,
  `build_houses.py <conjunto> --check`; y el generador del lugar, si tiene
  (`config/sites/<lugar>/…py --check`).

## 2. Errores que ya costaron tiempo

**Física**
- **Un macizo del índice de edificios es sólido desde el suelo hasta su techo**, empiece donde
  empiece: el jugador no mira su `y0`. En la arcada del convento de San Francisco, "los pisos de
  arriba como macizo que empieza en el primer piso" dejaba el portal sin poder caminarse. Lo que
  se camina por debajo va con `kit.box`/`circle` con `bottom`. Además, `buildings.index.at`
  devuelve solo el macizo más alto de cada punto.
- **Un muro invisible bajo un vuelo**: las Torres del Mall, con física de macizo, vuelan metros
  más allá de su podio; bajo el vuelo quedaba una pared de 37 m a nivel de la calle, sin nada que
  se viera. Lo que vuela va `raised`. Además, es probable que su planta saliera del techo en el
  satélite, que está corrido (ver "Fotos y medidas").
- **Columnas invisibles**: los postes de una pérgola sobre un techo registraban su física desde
  `-Infinity` y quedaban dentro del parqueo de abajo.
- **Techos que no se pisaban**: los macizos de los malls y de las garitas se registraban con el
  tope en el alero. `roofTop` toma el menor entre el tope y el techo inclinado, así que el techo
  quedaba como una losa plana en el alero y el que trepaba se hundía hasta 4,5 m en las aguas. El
  tope va en la cumbrera. Un techo de pabellón hecho con una sola caja a la altura de la cumbrera
  es el error contrario: se camina flotando sobre las aguas.
- **`monuments.wallTop` no ve los macizos**: dice "libre" dentro de un muro. Para esos, el
  índice de edificios (`probe` mira los dos). Y su altura es la de los **pies**: le suma el alto
  de una persona.
- **Muros que se atravesaban**: el macizo del convento se registraba medio metro adentro del muro
  de afuera, así que se podía entrar en la pared. El macizo de la física va hasta la cara de
  afuera.
- **Mallas que se atravesaban corriendo**: las vallas de las canchas tenían 7 cm de física (su
  grosor visible). El jugador prueba un solo punto por cuadro y avanza de a saltos. Las barandas
  de The Point, con 12 cm, igual. Se usa `ground.wall`.
- **Un arco que se camina sin cajas en las jambas**: se atravesaba la pared al lado del arco.
- **La cabeza contra la losa del parqueo**: quien subía la rampa chocaba a 1,06 m con la losa del
  nivel de arriba. La losa se abre sobre la rampa que llega a ella, y las rampas apiladas suben en
  el mismo sentido (`checkDeck`).
- **Una baranda corrida donde llegan las escaleras**: las del puente sobre la Orrantia llegaban a
  su costado y la baranda de la física no dejaba subir.
- **Piscinas que se pisaban**: el piso de la terraza contaba como piso sobre el agua. Un piso con
  huecos registra su física por triángulo.
- **Autos que se atravesaban**: `PlaceKit.car` solo pone autos sobre el terreno; los de los pisos
  altos de un parqueo son instancias quietas y no tenían física. Cada uno lleva su caja.
- **Consultas lentas en celdas grandes**: en las celdas de casas de 120 m, una consulta de la
  física probaba cientos de piezas. La física va en celdas más chicas que las del LOD
  (`physicsCell`).
- **Casas en obra que se pisaban en el aire**: entraban como un macizo lleno hasta el alto de sus
  muros, así que quien trepaba quedaba sobre una losa invisible y por los vanos no se entraba. Lo
  que está abierto arriba registra su física muro por muro.
- **Los pisos de una plaza sacaban los árboles de los datos** que crecían en ella: los pisos a ras
  del suelo no cuentan como ocupados. Para despejar algo a propósito está `clear`.

**Capturas y pruebas en el juego**
- **La cámara enterrada** en una captura a pie de calle: la base del monumento (`m.position.y`)
  vale 0 en la mayoría. Las alturas se miden desde el suelo de cada punto
  (`heightmap.sample`, como hace `shotAt`).
- **El personaje en la foto**: `avatar().root.visible = false` no sirve, porque el juego lo repone
  en cada cuadro. Se usa la primera persona (`g.follow.firstPerson = true`).
- **Teletransportarse dentro de un portal deja al jugador en la azotea**: el teletransporte busca
  el piso más alto. Para probar un portal, se entra caminando desde afuera.
- **Un jugador que no camina** en ninguna dirección: apareció dentro de un auto estacionado, o la
  pestaña está en segundo plano. Correr el punto de partida o traer la pestaña al frente.
- **Nada calzaba con la foto** aunque la cámara estaba en su punto: la foto de Mapillary abarcaba
  86° y el juego 58°. Igualar el lente (`shotPhoto` o `lens`).
- **Los transectos se perdían a medio medir**: se editaba `config/` con el servidor prendido y la
  página recargaba. Servidor apagado mientras se escribe; se mide sin tocar nada.
- **La GPU de un lugar liviano daba negativa**: con 10 copias opacas, City Mall y The Point
  salían por debajo de cero (la GPU baja el reloj con poca carga). Se repite con 30. Las copias
  transparentes dan la cota alta del costo por píxel, que depende de cuánta pantalla tapa el
  lugar.
- **`__mp.memory` y las instancias**: no cuenta `instanceMatrix` ni `instanceColor`, y suma dos
  veces los atributos que comparten las variantes de una casa (8,3 MB contra 7,9 en Durán City).

**Fotos y medidas**
- **Las fotos de kaartcam de 2016 (Mapillary) son ojo de pez**: salen de una GoPro. Su `hfov` de
  ~85° no calza en `shotPhoto`; se acerca más un lente de ~110° con la cámara corrida a mano, y
  aun así los pares quedan aproximados.
- **Las panorámicas de kaart_2 (2023) vienen torcidas y corridas**:
  - el horizonte, 3-7° inclinado: se nivela con la `computed_rotation` de la API de Mapillary, o
    se despeja con una persona o un taxi de alto conocido (dos ecuaciones: cabeza y pies);
  - la posición calculada (SfM), 5-20 m corrida, y en una secuencia de City Mall, 80 m. Se prueba
    también la del GPS crudo contra el juego (en el tambor de City Mall calzó esa). El GPS crudo
    se atrasa a lo largo de la vía, pero de través es coherente;
  - el lente de `camera_parameters` (~130°) no calzaba con el ancho medido del Paseo Shopping
    Durán: calzó el de la ficha técnica de la cámara (139°, equidistante).
- **Street View**: el `fov` del enlace es el campo de visión **vertical**:
  f = (alto de la vista / 2) / tan(fov / 2).
- **El satélite corre los techos**: la toma de Esri (GeoEye-1, precisión declarada de 8,5 m) es
  oblicua y corre cada techo 0,15-0,3 m por metro de alto. En San Marino, el "ala" que parecía
  salir delante de De Prati era el techo de la torre Zara, y la torre del reloj estaba 5 m más al
  norte. Se mide el corrimiento con algo de alto conocido y se confirma con `shotPhoto` antes de
  modelar.
- **El giro de una torre se mide por su silueta**: en The Point, el ancho aparente de la torre,
  franja por franja, en una foto nítida, comparado con el modelo desde la misma cámara. Así salió
  que las esquinas son un redondeo tangente (el ajuste a OSM y al satélite decía un cuadrado
  recortado por un círculo) y que los tres pisos de arriba no giran. Las fuentes dicen 6° por
  piso; lo medido son 6,6° por franja.
- **OSM corrido en una urbanización**: los ejes de las calles internas de Durán City estaban
  corridos 1,3-3,6 m del satélite; en una etapa, ~5 m, con un eje central que no existe; la
  calzada norte del bulevar, ~4 m, y dos muros perimetrales, fuera de lugar. Las veredas van
  sobre los ejes medidos y la corrección se anota para OSM. Las vías del juego salen de OSM: su
  dibujo queda corrido respecto de las veredas hasta que se corrija ahí.
- **Etiquetas de OSM que no son**: una cancha de vóley playa que es un área de juegos, casas
  marcadas como departamentos. Manda el satélite; se anota para corregir OSM.
- **Un render no es lo construido**: el de la fachada nueva de CityMall (septiembre de 2025)
  tenía lamas marrones y lo construido es rojo. Manda la foto de lo que está.
- **Fotos de Commons de licencia dudosa**: las mejores fotos de 2026 de The Point estaban subidas
  como CC0 por alguien que no era el autor. Solo sirven para mirar: no van a la ficha ni al repo.
  El EXIF de Commons también puede mentir (el rumbo de la foto de Mall del Sol daba 209° y mira a
  ~300°).
- **La hoja de medidas envejece al comparar**: lo que se corrige en el juego (el tambor de
  CityMall, 5,5 m más al este y 3,5 m más alto) va al `source` de la config; desde ahí, la hoja
  del caché ya no manda.

**Geometría**
- **Paredes interiores de un pasaje que asomaban por la fachada**: su origen tiene que ser el
  borde del pasaje, no el centro del edificio.
- **Un hueco sobre el gran arco**: faltaba la masa (losa) del pabellón de atrás.
- **Molduras metidas en el muro**: `sweep` saca el perfil hacia `eje × tramo`.
  - Con el eje hacia arriba, cada lado se recorre de derecha a izquierda visto desde afuera.
  - Alrededor de un vano (el eje es la normal de la cara), se va de la jamba izquierda, por la
    clave, a la derecha.
- **Un torno (`lathe`) al revés** (el borde de una pila): el perfil va de afuera hacia adentro,
  para que las caras miren afuera, arriba y al centro.
- **Lancetas con una "bandera" suelta**: el arco izquierdo de `archPath` tenía mal el ángulo.
- **Techos a dos aguas invisibles desde arriba**: los cuadriláteros estaban en sentido horario.
- **Una media cúpula que desaparecía**: con 180°, la cara del corte miraba hacia adentro. Cada
  corte lleva su propia normal hacia afuera.
- **Aleros huecos**: un techo inclinado hecho solo con la cara de arriba no se ve desde abajo; el
  alero lleva su cielo y su canto.
- **Casas espejadas invisibles**: three.js corrige el orden de las caras por objeto, no por
  instancia, así que una matriz que espeja deja la casa de adentro. La otra mano es la misma
  geometría con el índice al revés (`mirroredIndex`, `houseVariant`). Las copias de lejos se
  ubicaban con la matriz espejada y 564 casas salían de adentro: como las piezas de lejos son
  simétricas, van sin espejo.
- **`instanceColor` tiñe todo el color por vértice**: techo, marcos y ventanas incluidos. De ahí
  la máscara de pintura (`Surface.paint` con el material `paint`).
- **Una malla con todas las casas nunca se descarta**: su esfera mide ~1 km. Van por celdas. Lo
  mismo con una pieza larga (la reja de 295 m del frente del Paseo): se parte en tramos.
- **Un bucle que se colgaba**: los trazos de pintura de un bordillo avanzaban con
  `floor(run / dash)`. Con un `dash` que no es potencia de 2 (0,3, 0,6), el paso quedaba en
  ~1e-16 y la carga se colgaba. Un contador entero y lo que falta del trazo.
- **Pintura bajo el piso**: las cebras y los reductores se medían desde el terreno y quedaban bajo
  el adoquín de la zona. Van sobre el piso que las contiene.

**Terreno**
- **Puertas flotando ~1 m**: el bulto del terreno. Las puertas son muescas desde la base del muro
  y se rellenan desde el suelo local.
- **Un bulto de 4 m sobre la 9 de Octubre**, que en la realidad es plana: la iglesia de San
  Francisco quedaba en su ladera, con 2,5 m de tierra hacia el fondo, y la arcada y los últimos
  locales medio enterrados. Eran manzanas enteras de torres, más anchas que la ventana con que
  el paso `terrain` quita los edificios. Se corrigió con la zona plana `centro` en
  `config/region.json`: una ventana de 250 m, que solo baja el suelo, con los cerros fuera. Se
  probó GEDTM30 (un DTM global sin edificios) y en el centro era peor.
- **El techo de un mall es relieve**: el modelo de elevación dejaba bultos de hasta 15 m bajo los
  malls. Una zona plana por mall, con la ventana mayor que su lado corto, y una sola corrida del
  pipeline para todas (`terrain` y los pasos que leen el relieve). Una zona plana baja el suelo
  aunque el lugar no esté modelado.
- **Una plaza más baja que en la realidad**: junto a The Point, el modelo de elevación deja la
  plaza del malecón 1,8 m bajo la terraza, contra 0,6-0,8 m en las fotos. Se corrige en el
  pipeline, no en el lugar.

**Luz y color**
- **Techos de portal negros u oliva**: oclusión ambiental muy baja o cielo raso muy oscuro.
  Ajustar con una foto del portal a la vista.
- **De noche la fachada quedaba plana y lavada**: el reflector tiene que seguir la orientación de
  cada cara y multiplicarse por la oclusión.
- **San Marino oscuro de noche**: con `flood` 0, la fachada crema quedaba negra, y la foto de
  noche la mostraba bañada por reflectores.
- **Plafones que brillan pero no alumbran**: bajo las marquesinas de los malls, el piso quedaba
  con la luz de los postes lejanos. Lo que se enciende bajo un techo va también al alumbrado.
- **Luces al ras del suelo**: los reflectores de piso del monolito de una entrada iban al
  alumbrado, que solo alumbra desde `minHeight`: no alumbraban nada y sumaban su flujo. Un
  letrero bañado usa el reflector de los monumentos (`flood`).
- **El pie sucio del revoque no aparecía**: en un `Batch` sin su base (`flood[1]`) se mide desde
  0, y el terreno de Durán está a ~3 m. Cada `Batch` lleva la base de su suelo.
- **La calle se prendía de golpe**: las piezas de lejos de las casas iban apagadas y, al pasar una
  celda al detalle, sus ventanas se encendían todas juntas. Los muros de lejos llevan la luz
  promedio de las ventanas y apliques de cerca. Las ventanas encendidas siguen horneadas en el
  modelo: todas las casas de un modelo prenden las mismas.
- **Dibujos que se volvían ruido lejos del origen**: `corrugated` y `blocks` sacaban la dirección
  de la cara con `dFdx`/`dFdy` sobre la posición del mundo. En Durán City, a ~12 km del origen, el
  redondeo de float32 los dejaba como ruido por píxel, sin juntas ni ondas. Un dibujo medido en el
  mundo se mide desde el origen de su malla (todas sus instancias, desde el mismo), con la normal
  del vértice.

**GPU**
- **Sombras de más**: las casas de Durán City proyectaban con todo su detalle en las dos cascadas
  (~0,27 ms). En la lejana, cuyo texel es más grande que ese detalle, van las piezas de lejos, y
  más allá de `detail.mid` las casas se dibujan sin lo fino. Las losas de las veredas tampoco
  proyectan: su sombra cae debajo de ellas.

**Memoria**
- **32 MB de geometría**: `TessellateModifier` generaba de más. Cortar solo a lo largo de x
  (`bend` usa `sliceX`), soldar y compactar dejó 7,9 MB.
- **Una advertencia en la consola**: `toNonIndexed` sobre una geometría que ya no tiene índice.
  Aplicar la limpieza directo a la `ExtrudeGeometry`.
- **Veredas de 4,3 MB**: en Durán City, `pave()` partía cada polígono en una grilla de 5 m y
  `Batch.build` no suelda (2,6 vértices por triángulo): más de la mitad de la memoria del lugar.
  Los pisos de la urbanización se triangulan sobre su contorno y se parten solo donde el terreno
  lo pide (`paveFit`).

**Datos y fuentes**
- **El punto de OSM de un monumento puede estar corrido unos metros** (la Columna de los
  Próceres, ~3,5 m): mirar en el satélite (`satellite.py`) dónde cae el pedestal y dónde se
  cruzan los paseos, y usar eso.
- **En el satélite, los edificios altos se ven inclinados**: el techo aparece corrido respecto de
  la base. Las huellas y los frentes se miden donde el edificio toca el suelo, no en el techo.
- **La recta del cordón de una cuadra que no es calle** (un bulevar peatonal, una plaza) sale
  absurda. `build_street.py` avisa; ver `street-pipeline.md`, sección 9.
- **Un lugar que se renovó hace poco** (la Plaza San Francisco, diciembre de 2025; la fachada de
  CityMall, diciembre de 2025): buscar noticias de la obra antes de dar por buenas fotos viejas.
- **Una urbanización en el buscador**: el paso `search` del pipeline tomó de OSM y Overture el
  nombre de la urbanización y el de un área social, aunque no tienen ficha.

**Letreros**
- **El atlas compartido se llena**: con los malls, la torre y la urbanización pasó de 42 a 112
  caras y de 527 a 821 px de alto, y con el Paseo, a 944, con un tope de 1024
  (`monuments.signs.size`). Los letreros grandes van con `res` baja.
- **Un recuadro detrás de las letras sueltas**: un letrero de letras sueltas (`depth` 0) dibujaba
  su fondo sobre la fachada, con su sombra. Va con el acabado calado `letters`.

**Calles**
- **Los ajustes de los retiros no llegaban al juego** (rejas, entradas, palmeras): el script
  anidaba su `set` dos veces, y `--check` coincidía igual, porque compara el archivo consigo
  mismo. Hoy la validación del inventario ataja las claves que sobran; aun así, mirar en el juego
  que cada ajuste se ve.
- **Edificios y lotes armados dos veces**: un registro exacto (`x` + `z`) o un lote cerca del
  límite entre dos cuadras salía en las dos. Las caras se peleaban y una reja quedaba en medio de
  la vereda de la cuadra vecina. Hoy cada registro va a una sola cuadra; si aparece un id
  terminado en `-2`, revisar.
- **Un letrero tapado por la caja genérica de los locales**: la familia pone, con `shops.sign`,
  una caja de color a la altura del letrero de cada local. Un letrero propio a esa altura va con
  `"shops": {"sign": [0, 0, 0]}`.
- **Autos y maceteros en las entradas de los parqueaderos**, y palmeras donde se estaciona: el
  carril, el mobiliario y las palmeras respetan las entradas (`gaps`) y las líneas de los
  puestos. Mirarlo en el juego igual. En los malls, también los portones: el del patio de San
  Marino tenía encima una jardinera y un puesto.
- **La capilla de la Alborada era blanca en las fotos de 2023 y hoy es de ladrillo**: manda lo más
  nuevo que haya (Street View, fotos propias), y se anota qué foto quedó vieja.
- **Comparar al final**: en la Alborada se modelaron los 570 m antes de comparar, y los errores
  aparecieron todos al final. Se compara cuadra por cuadra.
- **Una calzada de los datos que no es la real** (el parterre de la Alborada: ~6 m en el juego y
  ~2 m de verdad): la calzada sale de OSM y no se arregla desde la calle. Se anota como pendiente
  de los datos de vías.
- **Autos de los datos bajo una marquesina**: los autos estacionados de `parking.bin` no miran
  los despejes; junto a The Point, uno quedó en el carril de dejar pasajeros. Se anota como
  pendiente de los datos de vías.

**Herramientas y trabajo en paralelo**
- **Prettier reformateó un archivo entero**: el proyecto no usa formateador; no correr ninguno.
- **Los scripts de la calle quedaron solo en una carpeta temporal**: todo lo que arma un archivo
  de `config/` vive en el repo (`scripts/street/`) con sus fuentes versionadas. El generador de la
  urbanización leía todavía su fuente del caché del pipeline, y el de la torre imprimía bloques
  para pegar a mano: sin fuentes versionadas ni `--check`, no se pueden rehacer ni comparar.
- **Un esqueleto que pasaba por lugar hecho**: el archivo del Paseo Shopping Durán quedó vacío,
  con su entrada y su zona plana, y `check()` lo aceptó.
- **Dos agentes, el mismo número de dibujo**: los números de `PATTERN` se reservan antes de
  repartir, y al juntar se revisan `PATTERN`, las ramas `kind == N` del GLSL y
  `monuments.patterns`.
- **Una clave obligatoria nueva** en un `check()` (la lista `site.cars` de los malls) rompe los
  archivos de los otros worktrees: al juntar, se agrega en todos.
- **Herramientas pisadas**: un agente sobrescribió las de otro en un scratchpad compartido. Cada
  agente trabaja en su carpeta.
- **Sin navegador**: un arnés de node (esbuild, un kit falso y un rasterizador por software) sirve
  para revisar geometría, caras, física y memoria, y para comprobar que lo que ya estaba sale
  igual (una huella de todas las mallas antes y después). El GLSL solo se parsea: los dibujos se
  prueban en la GPU del juego.
