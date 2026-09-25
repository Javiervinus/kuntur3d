# Cómo aportar a Kuntur 3D

Kuntur 3D es tu ciudad en 3D, hecha entre todos. Hay tres formas de aportar y solo la última
necesita programar. Todo se hace en español (si escribes en inglés también te entendemos).

## 1. Contar qué está mal o qué falta (sin programar)

Abre un [issue](../../issues/new/choose) con el formulario que corresponda:

- **Un edificio o lugar está mal / agrega mi casa**: la altura, la forma, el color o el nombre no
  cuadran, o falta algo. Lo más útil es el **link al punto exacto**: en la app, `Esc` → COMPARTIR →
  copiar link. Si puedes, suma fotos tuyas recientes (los archivos originales, que traen dónde y
  hacia dónde se tomaron) y cuántos pisos tiene.
- **Error**: algo se rompe, se ve raro o va lento.
- **Quiero mi ciudad**: para sumar otra ciudad.
- **Idea**: algo que te gustaría ver.

Para preguntas o para mostrar tu barrio usa [Discussions](../../discussions).

## 2. Corregir el mapa en OpenStreetMap

Las calles, los nombres y muchos edificios salen de [OpenStreetMap](https://www.openstreetmap.org).
Si corriges ahí la altura de un edificio (`building:levels` = pisos), el nombre de un lugar o una
calle, el arreglo aparece en Kuntur 3D la próxima vez que se generen los datos, y de paso le sirve a
todo el mundo. Es la forma más duradera de aportar.

## 3. Código y datos por pull request

### Preparar el proyecto

```bash
npm install
npm run data   # genera el mundo desde config/region.json (necesita uv; ~15 min la primera vez)
npm run dev
```

Los pasos del pipeline están descritos en
[docs/como-funciona.md](docs/como-funciona.md#pipeline-de-datos).

### Reglas

- **Nada hardcodeado.** Los valores (distancias, colores, textos, fuentes de datos) van en
  `config/*.json`, no escritos en el código.
- **Que compile.** `npm run build` (revisa tipos y arma la app) tiene que pasar; lo corre también
  GitHub en cada PR.
- **Muestra el cambio.** Si se ve distinto, pon capturas de antes y después y el link al punto.
- **Datos limpios.** Nada copiado de Google Maps, Google Earth, Street View ni otras fuentes que no
  lo permitan: solo datos abiertos, fotos tuyas o material con licencia libre (y su crédito).
- **Un tema por PR.** Los PR chicos se revisan rápido.
- **IA sí, a tu nombre.** Puedes usar Claude, Codex u otros agentes; tú respondes por lo que envías:
  que lo hayas probado y lo entiendas.

### Modelar un lugar

Para traer con detalle un monumento, una calle con cada uno de sus edificios o tu casa (con tus
fotos), sigue el procedimiento de
[`.agents/skills/model-place/SKILL.md`](.agents/skills/model-place/SKILL.md): investigar con las
fuentes más actuales, medir, modelar lo más fiel posible, comparar con fotos desde el mismo punto
y con el mismo lente, y medir cuánto cuesta. Es una skill:
Codex y los agentes que leen `.agents/skills` la encuentran ahí, y Claude Code por el enlace de
`.claude/skills`. Se activa sola cuando le pides a tu agente modelar un lugar.

### Flujo

1. Haz un fork y una rama para tu cambio.
2. Abre el PR contra `main` y completa la plantilla.
3. Se revisa, se conversa y se une a `main` (en un solo commit).

## Licencia de los aportes

Lo que aportes entra con la misma licencia del proyecto: el código con la AGPL-3.0 (y los términos
de [NOTICE.md](NOTICE.md)) y el contenido (textos de fichas, fotos, modelos) con CC BY-SA 4.0. Solo
envía lo que tengas derecho a compartir así.

## Convivencia

Este proyecto sigue el [Código de Conducta](CODE_OF_CONDUCT.md). Trata a los demás como te gustaría
que traten a tu barrio.
