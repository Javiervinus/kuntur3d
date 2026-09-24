# Revisión antes de cerrar y errores conocidos

## Contenido

1. La revisión antes de cerrar
2. Errores que ya costaron tiempo

## 1. La revisión antes de cerrar

Las capturas no muestran todo. En la 9 de Octubre, una revisión del código hecha aparte encontró
unos 25 problemas que ninguna captura había mostrado: techos al revés, caras dobles, valores
prestados de otro campo, un portal que no se caminaba, faroles que no alumbraban.

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
- **Cierres.** `arc` repite el primer punto al final: `.slice(0, -1)` antes de un `sweep`
  cerrado.
- **Pocos lados.** Conos, pirámides y troncos de 4 lados van con `faceted`; si no, salen con
  sombreado suave.
- **Interiores.** Lo que se ve por dentro (un macetero, una pila) lleva su pared con `inward`.
- **Encuentros.** Que cada pieza toque lo que sostiene o la sostiene: balaustres al pasamanos,
  molduras sobre su muro, cruces de frente a donde se mira.

**Config**
- **Cada medida con su propio campo.** Nada prestado de otro campo (p. ej. el vuelo de una
  pilastra como fondo de un frontón) ni escrito en el código, ni la `ao` de un vano.
- **Campos sin uso** en la config o en la interfaz: se borran.
- **Dibujos** por nombre con `patternOf`, que falla si el nombre no existe.

**Física** (se verifica con `probe`, ver `browser.md`)
- Todo lo que se camina (portales, arcadas, pasajes, plazas) queda libre para alguien parado en el
  suelo, con el techo a su altura. Se prueba también **caminando** (`walk`): la consulta sola no
  ve los huecos entre piezas.
- Los muros de afuera (el cascarón con los vanos) también atajan: el macizo de la física llega a
  la cara de afuera, no se queda en el núcleo.
- Cada pilar y cada jamba de lo que se camina tiene su caja.
- Rejas y bordillos atajan: si se pueden trepar, que tengan el alto de trepar.
- Pisos elevados (césped, plazas): un piso a su altura, para no hundirse.

**Luz**
- Los faroles modelados alumbran el piso: van en `Monuments.lanterns`.
- De noche no queda nada negro donde la gente camina.

**Terreno**
- Muestrear el suelo en **toda** la huella, no solo en el frente. El modelo de elevación puede
  subir metros bajo una manzana: en San Francisco sube 2,5 m de la plaza al fondo. Así, lo que da
  a otra calle queda medio enterrado si arranca de la misma base.

**Cierre**
- La consola del juego sin errores.
- `npm run build` pasa.
- En calles, `build_street.py <calle> --check` coincide.

## 2. Errores que ya costaron tiempo

**Física**
- **Un macizo del índice de edificios es sólido desde el suelo hasta su techo**, empiece donde
  empiece: el jugador no mira su `y0`. En la arcada del convento de San Francisco, "los pisos de
  arriba como macizo que empieza en el primer piso" dejaba el portal sin poder caminarse. Lo que
  se camina por debajo va con `kit.box`/`circle` con `bottom`. Además, `buildings.index.at`
  devuelve solo el macizo más alto de cada punto.
- **`monuments.wallTop` no ve los macizos**: dice "libre" dentro de un muro. Para esos, el
  índice de edificios (`probe` mira los dos). Y su altura es la de los **pies**: le suma el alto
  de una persona.
- **Muros que se atravesaban**: el macizo del convento se registraba medio metro adentro del muro
  de afuera, así que se podía entrar en la pared. El macizo de la física va hasta la cara de
  afuera.
- **Un arco que se camina sin cajas en las jambas**: se atravesaba la pared al lado del arco.
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

**Terreno**
- **Puertas flotando ~1 m**: el bulto del terreno. Las puertas son muescas desde la base del muro
  y se rellenan desde el suelo local.

**Luz y color**
- **Techos de portal negros u oliva**: oclusión ambiental muy baja o cielo raso muy oscuro.
  Ajustar con una foto del portal a la vista.
- **De noche la fachada quedaba plana y lavada**: el reflector tiene que seguir la orientación de
  cada cara y multiplicarse por la oclusión.

**Memoria**
- **32 MB de geometría**: `TessellateModifier` generaba de más. Cortar solo a lo largo de x
  (`bend` usa `sliceX`), soldar y compactar dejó 7,9 MB.
- **Una advertencia en la consola**: `toNonIndexed` sobre una geometría que ya no tiene índice.
  Aplicar la limpieza directo a la `ExtrudeGeometry`.

**Datos y fuentes**
- **El punto de OSM de un monumento puede estar corrido unos metros** (la Columna de los
  Próceres, ~3,5 m): mirar en el satélite (`satellite.py`) dónde cae el pedestal y dónde se
  cruzan los paseos, y usar eso.
- **En el satélite, los edificios altos se ven inclinados**: el techo aparece corrido respecto de
  la base. Las huellas y los frentes se miden donde el edificio toca el suelo, no en el techo.
- **La recta del cordón de una cuadra que no es calle** (un bulevar peatonal, una plaza) sale
  absurda. `build_street.py` avisa; ver `street-pipeline.md`, sección 8.
- **Un lugar que se renovó hace poco** (la Plaza San Francisco, diciembre de 2025): buscar
  noticias de la obra antes de dar por buenas fotos viejas.

**Herramientas**
- **Prettier reformateó un archivo entero**: el proyecto no usa formateador; no correr ninguno.
- **Los scripts de la calle quedaron solo en una carpeta temporal**: todo lo que arma un archivo
  de `config/` vive en el repo (`scripts/street/`) con sus fuentes versionadas.
