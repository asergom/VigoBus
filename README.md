# Próximo Vitrasa

Mapa de las paradas de Vitrasa en Vigo con los próximos buses de cada parada.

- Busca paradas por nombre o número, y líneas por código o nombre.
- **Líneas**: al elegir una, su recorrido se ilumina en el mapa con el color oficial y sus paradas se tiñen de ese color; el panel muestra las paradas en orden en cada sentido.
- Disponible en español, galego, português, euskara, català, English, français y Deutsch (textos dentro de la propia web).
- **Cerca** muestra las paradas más próximas a tu ubicación con la distancia andando. Sin ubicación, muestra las de la zona del mapa.
- **Favoritas** guarda paradas en el propio dispositivo.
- Cada parada y cada línea tienen enlace propio: `#5660` abre la Gran Vía, 19 y `#linea/C3d` la línea C3d.
- En el móvil, el panel se desliza hacia abajo para ver el mapa casi entero.
- Se puede instalar en el móvil como app y funciona sin conexión. Los tiempos de llegada sí necesitan red.

Es una web estática, sin compilación: se publica tal cual en GitHub Pages o en cualquier hosting.

## Estructura

```
index.html              página
css/app.css             estilos (modo claro y oscuro)
js/app.js               lógica: mapa, búsqueda, cercanía, favoritas, líneas, tiempos
js/i18n.js              textos de la interfaz en los 8 idiomas y banderas
data/paradas.geojson    1.161 paradas: id (número de Vitrasa), nombre y líneas
data/oficial/           lista oficial de paradas descargada del Concello
data/descartadas.csv    paradas de la versión antigua que ya no existen
data/lineas.json        recorrido, color y paradas de las 44 líneas
tools/actualizar_paradas.py   genera paradas.geojson desde la lista oficial
tools/actualizar_lineas.py    genera lineas.json desde el GTFS oficial
vendor/leaflet/         Leaflet 1.9.4
fonts/                  Barlow (licencia OFL)
icons/, manifest.webmanifest, sw.js   app instalable
```

## Tiempos de llegada

Se piden a la API de datos abiertos del Concello de Vigo:

```
https://datos.vigo.org/vci_api_app/api2.jsp?id=<parada>&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA
```

Se refrescan cada 30 segundos mientras la ficha está abierta. Si la petición falla, la ficha lo indica y enlaza a Infobus.

Si el navegador bloqueara esa API por CORS, se puede poner un proxy delante sin tocar el código, definiendo la URL antes de cargar `js/app.js`:

```html
<script>window.PV_API_URL = "https://mi-proxy.example/vitrasa";</script>
```

## Datos

Las paradas salen de la lista oficial del portal de datos abiertos del Concello de Vigo:
https://datos.vigo.org/data/transporte/paradas.json (1.161 paradas con sus líneas).

Para actualizarlas, descarga ese archivo en `data/oficial/paradas.json` y ejecuta:

```
python3 tools/actualizar_paradas.py
```

Después sube `VERSION` en `sw.js` para que las apps instaladas descarguen los datos nuevos.

Los recorridos y colores de las líneas salen del GTFS del Concello
(https://datos.vigo.org/data/transporte/gtfs_vigo.zip). Para actualizarlos:

```
python3 tools/actualizar_paradas.py
python3 tools/actualizar_lineas.py ruta/al/gtfs_vigo.zip
```

`actualizar_lineas.py` guarda, por cada línea y sentido, el recorrido principal y los ramales
necesarios para que la línea pase por todas sus paradas (en el mapa, los ramales se ven con un
trazo más fino). También corrige las líneas de cada parada con los viajes reales del GTFS: en
octubre de 2026 la lista oficial asignaba la C3d a 64 paradas de Urzáiz y Gran Vía por las que
no pasa (comprobado también con los tiempos en vivo).

La capa original de QGIS tenía 935 paradas válidas. Al cruzarla con la lista oficial faltaban 293, y 67 ya no existían (ni en la lista ni en la API de tiempos); están en `data/descartadas.csv`.

## Probar en local

```
python3 -m http.server
```

y abre http://localhost:8000.

## Coste

Todo es gratuito y sin claves: el mapa base es el de OpenStreetMap (con su atribución), los tiempos vienen de la API abierta del Concello de Vigo y Leaflet y Barlow son de código abierto. Para alojarla basta GitHub Pages.

Mapa base © colaboradores de OpenStreetMap.
