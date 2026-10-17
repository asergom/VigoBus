# Próximo Vitrasa

Mapa de las paradas de Vitrasa en Vigo con los próximos buses de cada parada.

- Busca paradas por nombre o número, y líneas por código o nombre.
- **Líneas**: al elegir una, su recorrido se ilumina en el mapa con el color oficial y sus paradas se tiñen de ese color; el panel muestra las paradas en orden en cada sentido.
- Disponible en español, galego, português, euskara, català, English, français y Deutsch (textos dentro de la propia web).
- **Cerca** muestra las paradas más próximas a tu ubicación con la distancia andando. Sin ubicación, muestra las de la zona del mapa.
- **Favoritas** guarda paradas en el propio dispositivo.
- **Cómo llegar**: indica desde dónde y hasta dónde quieres ir (una calle con su número, una parada, tu ubicación o un punto del mapa; las direcciones se van proponiendo mientras escribes) y la web calcula la ruta a pie, con distancia y tiempo. La ruta se calcula en el propio dispositivo con una red de calles de OpenStreetMap guardada en la web, sin servicios externos. Desde cada parada, "Cómo llegar aquí" la pone como destino.
- Cada parada y cada línea tienen enlace propio: `#5660` abre la Gran Vía, 19 y `#linea/C3d` la línea C3d. Una ruta también: `#ir/p5660/42.23700,-8.72060` (parada → punto).
- En el móvil, el panel se desliza hacia abajo para ver el mapa casi entero.
- Se puede instalar en el móvil como app y funciona sin conexión. Los tiempos de llegada sí necesitan red.

Es una web estática, sin compilación: se publica tal cual en GitHub Pages o en cualquier hosting.

## Estructura

```
index.html              página
css/app.css             estilos (modo claro y oscuro)
js/app.js               lógica: mapa, búsqueda, cercanía, favoritas, líneas, tiempos
js/i18n.js              textos de la interfaz en los 8 idiomas y banderas
js/peaton.js            rutas a pie con la red peatonal propia
js/direcciones.js       búsqueda de direcciones (calle y número)
data/paradas.geojson    1.161 paradas: id (número de Vitrasa), nombre y líneas
data/oficial/           lista oficial de paradas descargada del Concello
data/descartadas.csv    paradas de la versión antigua que ya no existen
data/lineas.json        recorrido, color y paradas de las 44 líneas
data/peatonal.json      red peatonal: calles, aceras y caminos de la zona de Vitrasa (OpenStreetMap)
data/direcciones.json   calles con nombre y números de portal (OpenStreetMap)
data/osm/vias.json.gz   vías de OpenStreetMap descargadas, de las que sale la red peatonal
data/osm/direcciones.json.gz   portales de OpenStreetMap descargados
tools/actualizar_paradas.py   genera paradas.geojson desde la lista oficial
tools/actualizar_lineas.py    genera lineas.json desde el GTFS oficial
tools/actualizar_peatonal.py  genera peatonal.json desde las vías de OpenStreetMap
tools/actualizar_direcciones.py  genera direcciones.json desde las vías y portales de OpenStreetMap
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

### Red peatonal

`data/peatonal.json` sale de las vías de OpenStreetMap de la zona de Vitrasa (de Teis y Bouzas
hasta Porriño), descargadas con Overpass:

```
[out:json][timeout:300];(way["highway"](42.135,-8.835,42.290,-8.610););(._;>;);out body;
```

Guarda el resultado comprimido en `data/osm/vias.json.gz` y ejecuta:

```
python3 tools/actualizar_peatonal.py
```

El script se queda con las vías por las que se puede ir a pie (mismas reglas generales que el
perfil a pie de OSRM), une los tramos, descarta islas sueltas y guarda la red en un formato
compacto (unos 39.000 cruces, 0,7 MB comprimido). Al elegir la ruta, las pistas y sendas de
tierra cuentan un 25 % más largas para preferir calles y aceras; la distancia mostrada es la
real. El tiempo se calcula a 4,5 km/h, sin tener en cuenta las cuestas por ahora.

Comprobación (octubre de 2026): en 12 rutas de 300 m a 8,6 km por todo Vigo, la distancia
coincide con la de routing.openstreetmap.de con una diferencia media del 2,5 %, siempre algo
más corta. Haciendo que OpenStreetMap siga la misma ruta, sus tramos miden lo mismo (±1 %): la
diferencia viene de que su servicio no busca el camino más corto, sino que prefiere ciertos
tipos de vía.

### Direcciones

`data/direcciones.json` reúne las calles con nombre de la red de OpenStreetMap (3.425) y los
portales que tiene OpenStreetMap en la zona (4.403, en 638 calles). Se descargan con Overpass:

```
[out:json][timeout:300];(nwr["addr:housenumber"](42.135,-8.835,42.290,-8.610););out center tags;
```

Guarda el resultado comprimido en `data/osm/direcciones.json.gz` y ejecuta:

```
python3 tools/actualizar_direcciones.py
```

La búsqueda no distingue tildes ni el tipo de vía escrito de otra forma ("calle Urzaiz 7" encuentra
"Rúa de Urzáiz, 7"). Si el portal está en OpenStreetMap se usa su posición; si no, se estima entre
los números conocidos más cercanos del mismo lado de la calle (comprobado quitando cada portal
conocido: mediana de 10 m de error, 88 % a menos de 50 m) y, si la calle no tiene ninguno, se usa su
punto central. En esos casos la web avisa de que la posición es aproximada. OpenStreetMap tiene
todavía pocos portales en Vigo; completarlos con el Catastro queda como mejora futura.

## Probar en local

```
python3 -m http.server
```

y abre http://localhost:8000.

## Coste

Todo es gratuito y sin claves: el mapa base es el de OpenStreetMap (con su atribución), los tiempos vienen de la API abierta del Concello de Vigo y Leaflet y Barlow son de código abierto. Para alojarla basta GitHub Pages.

Mapa base y red peatonal © colaboradores de OpenStreetMap. La red peatonal (`data/peatonal.json`
y `data/osm/`) es una base de datos derivada de OpenStreetMap y se distribuye con la licencia
ODbL (https://opendatacommons.org/licenses/odbl/).
