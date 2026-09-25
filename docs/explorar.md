# Explorar la ciudad

## Contenido

1. [Controles](#controles)
2. [Pantallas táctiles](#pantallas-táctiles)
3. [El personaje](#el-personaje)
4. [El carro](#el-carro)
5. [Buscador](#buscador)
6. [Lugares con historia](#lugares-con-historia)
7. [HUD, pausa y mapa](#hud-pausa-y-mapa)

## Controles

| Tecla | Acción |
|---|---|
| W A S D | Caminar (W contra un muro: trepar) |
| Shift | Correr |
| Espacio | Saltar / soltarse del muro |
| H | Abrir o cerrar el ala delta (desde el suelo, sube con una térmica) |
| W / S planeando | Picar / encabritar · A / D: girar |
| F | Subir o bajar del carro (si está lejos, aparece al lado) |
| W / S / A / D manejando | Acelerar / frenar y reversa / girar |
| Espacio manejando | Freno de mano |
| C | Primera o tercera persona (manejando: vista desde el asiento) |
| − / + | Velocidad a pie (×0,5 a ×16); manejando, el empuje extra del carro (×1 a ×3) |
| T o clic en el reloj | Hora siguiente: mañana, mediodía, tarde, noche |
| M o clic en el minimapa | Abrir o cerrar el mapa |
| Esc o P | Pausa y menú; otra vez, o un clic en la ciudad, para seguir |
| ↑ / ↓ o rueda | Zoom de la cámara |
| Clic + mouse | Mirar (con el puntero capturado; soltarlo también pausa) |

Las teclas se definen en `config/game.json` → `controls`. La leyenda de la pantalla cambia según
lo que se esté haciendo (a pie, planeando, manejando), y la lista completa está en el menú de
pausa → CONTROLES.

Al recargar la página se retoma el mismo punto, y el carro si se iba manejando. Un link con
`?lat=&lon=` tiene prioridad. El estado se guarda en el navegador (`config/game.json` → `resume`).

## Pantallas táctiles

En el celular, o en cualquier pantalla táctil, aparecen controles para los dedos
(`src/ui/touch.ts`, `config/game.json` → `touch`):

- **Joystick** a la izquierda: aparece donde se apoya el dedo y es analógico. Empujado a medias
  camina, y al borde corre; manejando, acelera, frena y gira en proporción.
- **Mirar**: arrastrar un dedo por el resto de la pantalla. **Dos dedos** acercan o alejan la
  cámara y el mapa.
- **Botones** a la derecha, según lo que se esté haciendo: SALTAR, PLANEAR, CARRO y, manejando,
  FRENO y BAJAR. Arriba, MENÚ y CÁMARA. El − / + del velocímetro cambia la velocidad.
- El HUD se compacta y la pestaña CONTROLES explica los gestos. Por dentro, los controles
  táctiles presionan las mismas teclas virtuales que el teclado (`Input.setVirtual`).

**Perfil de memoria** (`config/game.json` → `profiles.mobile`, aplicado por
`src/core/profile.ts` antes de que arranque el resto). Safari en iPhone cierra la pestaña si pasa
su límite de memoria. En pantallas táctiles se reducen:
- la resolución (1,5×) y las sombras (1024);
- los radios de carga de edificios, árboles, calles y terreno;
- la imagen satelital y la vista general (2048 px).

En un vuelo de 70 s a 300 m, las texturas bajan de ~262 a ~70 MB y la geometría de ~200 a
~170 MB.

## El personaje

Un humano de 1,75 m con proporciones reales:
- camina a 5 km/h, corre a 14 km/h y salta ~45 cm con gravedad real;
- nada a ~3 km/h, trepa edificios, planea y maneja;
- con − / + la velocidad va de ×0,5 a ×16: corriendo a ×16 son ~225 km/h, para cruzar la ciudad
  a pie.

Las piernas tienen una cadencia máxima creíble (`config/assets.json` → `maxStrideRate`, 1,8 veces
la normal). Por encima de esa velocidad mantienen el ritmo y el cuerpo se desliza.

El modelo es *Universal Base Characters* con animaciones de *Universal Animation Library*, de
Quaternius (CC0). Va armado en un solo `.glb` de ~1 MB, con texturas WebP y solo las 8
animaciones que se usan. La ropa (camiseta, jean, zapatillas) es procedural: se pinta en el
shader sobre la pose de reposo, con una leve holgura en el shader de vértices.

Cada personaje es una entrada de `config/game.json` → `characters.roster`, con su modelo,
estatura, movimiento y habilidades (`abilities`: trepar, planear, manejar). Para agregar otro:
- una entrada más, con su modelo en `config/assets.json`;
- una tecla en `controls.keys.character` para cambiar entre personajes;
- una habilidad nueva es un modo más en `src/player/controller.ts`.

## El carro

Un sedán procedural de 4,35 m: carrocería hueca con interior, conductor animado, y luces de
freno y reversa. La física es un modelo dinámico de vehículo:

- potencia limitada por P/v y por la tracción delantera;
- curva de neumático tipo Pacejka por eje, con círculo de fricción y sensibilidad a la carga;
- transferencia de peso, arrastre aerodinámico, rodadura y pendiente del terreno;
- paso fijo de 120 Hz, con la pose interpolada entre pasos;
- ABS, reparto de frenado (EBD), control de tracción y control de estabilidad (ESC). Cuando
  actúa el ESC, el HUD muestra CONTROL DE ESTABILIDAD;
- freno de mano que bloquea las ruedas traseras, para derrapar;
- con teclado, el giro a fondo usa el agarre disponible a cada velocidad.

Medido en un simulador con el mismo código (`config/game.json` → `vehicles.car`):

| Prueba | Resultado |
|---|---|
| 0–100 km/h | ~10 s |
| Velocidad máxima | 180 km/h |
| Frenado de 100 a 0 | ~45 m |
| Esquina de 90° a 50 km/h | ~19 × 15 m |
| Frenada a fondo en curva a 90 km/h | deriva ~4° |

Además:
- **Empuje extra** (− / +): ×1,5, ×2 y ×3 suben el tope a 270, 360 y 540 km/h, empujando el
  chasis sin gastar el agarre de las llantas.
- **Primera persona**: el interior (tablero, volante, paneles, techo) se dibuja en una segunda
  pasada con su propio plano cercano, para que nada salga recortado.
- **Superficie bajo cada rueda**, leída de las mismas texturas que dibujan las calles. Asfalto,
  concreto y adoquín dan agarre pleno. Tierra, parques y canchas dan menos agarre y más
  resistencia; en tierra el tope es de ~70 km/h.
- **Edificios**: choque con impulso; no se trepan.
- **Agua**: frena con la profundidad, y a partir de ~55 cm el motor se ahoga. Se vuelve a pedir
  el carro con F lejos del agua.
- Al teletransportarse manejando, el carro va también si cabe en el destino.

El carro y los demás personajes se preparan en segundo plano apenas carga el mundo (descarga y
compilación de shaders), para que usarlos la primera vez no produzca tirones.

## Buscador

Acepta:

- **Links de Google Maps** tal como se copian:
  - el de "Compartir" (`maps.app.goo.gl/…`);
  - el de la barra de direcciones (`google.com/maps/place/…`);
  - `?q=`, `api=1&query=` y rutas (`/maps/dir/…`, que llevan al destino);
  - links de Apple Maps.

  Del link se usa, en este orden: el pin del lugar, las coordenadas, el Plus Code o el centro de
  la vista. Si solo trae un nombre o una dirección, se busca dentro de la zona.
- **Plus Codes** (`R448+4P Guayaquil` o `6792R448+4P`).
- **Coordenadas** (`-2.1906, -79.8788`).
- **Calles, esquinas, negocios y barrios**, con sugerencias al escribir ("9 de octubre y
  boyacá", "urdesa", "farmacia"):
  - el índice es local (paso `search`: `public/world/search.json`, ~0,6 MB con gzip); se carga al
    enfocar la caja y busca en un worker;
  - ignora tildes y mayúsculas, entiende abreviaturas ("av.", "cdla.") y tolera errores de
    tipeo;
  - ordena por coincidencia, por tipo (lugares emblemáticos y barrios antes que negocios) y por
    cercanía;
  - si el punto cae dentro de un edificio o en el agua, se llega a la vereda más cercana;
  - si el índice no encuentra nada, Enter busca en Nominatim (direcciones con número), con un
    máximo de una consulta por segundo, como pide su política de uso.

Los negocios de Overture se cruzan con los lugares con nombre de OSM. Cuando son el mismo
(nombre igual o casi, y cerca) se usa la posición de OSM, que en Guayaquil suele ser más exacta
en los lugares importantes. Los que solo están en OSM se suman (`config/region.json` →
`search.osmPlaces`). Tablas de texto en `config/region.json` → `search.text`; pesos en
`config/game.json` → `search`.

Al llegar queda un **pin rojo con un haz de luz** en el punto exacto, también en el minimapa. El
botón de la mira, junto al buscador, lleva a la **ubicación actual** del dispositivo. Si el
dispositivo está fuera de la zona, dice a cuántos kilómetros queda.

Los links cortos `maps.app.goo.gl` se expanden en el servidor: en desarrollo,
`server/mapLinkResolver.ts`, que solo sigue redirecciones de los dominios cortos de Google; en
producción, el Worker con el mismo código ([publicar.md](publicar.md)).

## Lugares con historia

Los lugares reconstruidos con detalle tienen un **marcador** con las tres estrellas de la
bandera de Guayaquil, visible de lejos, y un rombo celeste en el minimapa. Entre ellos están el
Malecón 2000, La Perla, la Torre Morisca, el Palacio Municipal, La Rotonda, la iglesia de San
Francisco, el Parque Centenario, Las Peñas y el faro, los estadios, los puentes, la Aerovía y la
estación del tren de Durán.

- Al **llegar**, se abre a un costado su **ficha**:
  - una foto de Wikimedia Commons con su crédito y licencia;
  - el año, la historia en pocas líneas y un "¿Sabías que…?";
  - las fuentes.

  Después de un rato se recoge en una píldora. Un clic en un marcador abre la ficha de lejos,
  con el botón **IR AQUÍ**.
- En el **buscador** aparecen primero, con su categoría ("Noria · Malecón 2000"), y también por
  su nombre popular ("iguanas" → Parque Seminario).
- En la pausa → **LUGARES** están todos, agrupados por tipo, con su miniatura y su distancia.
- Al entrar a un **barrio**, su nombre aparece arriba con la parroquia y el cantón (límites
  administrativos de OSM) y, cuando existe, una línea sobre su origen.

Los textos se verifican contra fuentes (Alcaldía, El Universo, Wikipedia con citas); un dato en
el que las fuentes no coinciden no se usa. El contenido está en `config/places.json`. El paso
`places` del pipeline ubica cada ficha, corre el punto de llegada fuera del agua y de los
edificios, y descarga las fotos. Apariencia y tiempos en `config/game.json` → `places`.

## HUD, pausa y mapa

Todo va en las esquinas, para no tapar la ciudad:

- **Arriba a la izquierda**: el barrio, con su parroquia y cantón.
- **Arriba al centro**: el buscador.
- **Arriba a la derecha**: el **minimapa**. Es un mapa dibujado (calles por jerarquía, parques,
  agua, la Aerovía y los lugares), no la foto satelital, que a esa escala no se lee. Gira con la
  cámara (la **N** marca el norte), se aleja con la velocidad y, si el destino de una búsqueda
  queda fuera, su pin se queda en el borde. Debajo, el **reloj**: la hora sobre un arco que va de
  la salida a la puesta del sol reales de Guayaquil ese día.
- **Abajo a la izquierda**: las teclas disponibles en ese momento.
- **Abajo a la derecha**: el velocímetro, con la actividad (caminando, corriendo, trepando,
  planeando, nadando, manejando), el multiplicador y la altura sobre el suelo en el aire.
- **Pausa** (Esc o P): el mundo se congela (tráfico, peatones, agua, reloj). El menú tiene
  **LUGARES**, **HORA**, **CONTROLES**, **COMPARTIR** y **CRÉDITOS**. En COMPARTIR están el link
  al punto (`?lat=&lon=`) y el mismo punto en Google Maps.
- **Mapa** (M o un clic en el minimapa): el mismo mapa en grande, con la ciudad en pausa:
  - se arrastra, la rueda acerca hacia el cursor y **CENTRAR EN MÍ** vuelve a la posición;
  - los nombres de barrios, parroquias y cantones aparecen según el zoom;
  - un clic en un lugar ofrece **IR AQUÍ**, y en cualquier otro punto **TELETRANSPORTARME
    AQUÍ**.

El mapa no descarga nada. Se dibuja en el navegador (canvas 2D, `src/ui/mapLayers.ts`) con capas
que ya están cargadas (la red del tráfico para las calles, el agua, la Aerovía), más los parques
simplificados del paso `roads` (`map.json`, ~120 kB).

Cómo se dibuja:
- Va en cuadros de 256 px por nivel de zoom, con índice espacial y un tope de milisegundos por
  cuadro de animación. Primero dibuja los cuadros que se verían vacíos, del centro hacia afuera.
- Los cuadros visibles no se liberan nunca, y se guardan algunos de repuesto
  (`map.spareTiles`).
- Mientras falta un cuadro, se muestra lo que haya de los niveles vecinos.
- Con el mapa grande abierto se mantienen los dos niveles más lejanos de toda la ciudad
  (`big.baseLevels`), para que no quede ningún hueco.

En una pantalla de 1728 × 1080 a 2×, el mapa grande queda completo en ~60 ms. Cada redibujo al
arrastrar cuesta ~0,5 ms, el minimapa ~0,01 ms por cuadro y cada cuadro nuevo ~0,3 ms. Colores,
anchos de vía y zooms en `config/game.json` → `map` y `minimap`; textos en `hud`.
