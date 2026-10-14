# Próximo Vitrasa

Mapa de las paradas de Vitrasa en Vigo con los próximos buses de cada parada.

- Busca paradas por nombre o por número.
- **Cerca** muestra las paradas más próximas a tu ubicación con la distancia andando. Sin ubicación, muestra las de la zona del mapa.
- **Favoritas** guarda paradas en el propio dispositivo.
- Cada parada tiene enlace propio: `https://…/#5660` abre directamente la Gran Vía, 19.
- Se puede instalar en el móvil como app y funciona sin conexión. Los tiempos de llegada sí necesitan red.

Es una web estática, sin compilación: se publica tal cual en GitHub Pages o en cualquier hosting.

## Estructura

```
index.html              página
css/app.css             estilos (modo claro y oscuro)
js/app.js               lógica: mapa, búsqueda, cercanía, favoritas, tiempos
data/paradas.geojson    935 paradas: id (código Vitrasa) y nombre
data/revisar.csv        puntos descartados de los datos originales, para revisar
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

`data/paradas.geojson` sale de la capa original de QGIS (996 puntos), limpiada así:

- Se quitan 30 puntos sin nombre ni código.
- Se recuperan códigos que estaban escritos en el nombre ("Parada 20012", "14106").
- Los códigos 1280 y 5660 estaban repetidos. Se mantuvo el punto que coincide con la API oficial (Avda. Castelao 41 y Gran Vía 19) y el otro pasó a revisión.
- Los puntos con nombre pero sin código no pueden mostrar tiempos, así que están en `data/revisar.csv` para completarlos.

Para añadir o corregir una parada, edita el GeoJSON: `{"id": "5660", "nombre": "Gran Vía, 19"}` y sus coordenadas `[lon, lat]`. Después sube `VERSION` en `sw.js` para que las apps instaladas descarguen los datos nuevos.

## Probar en local

```
python3 -m http.server
```

y abre http://localhost:8000.

## Coste

Todo es gratuito y sin claves: el mapa base es el de OpenStreetMap (con su atribución), los tiempos vienen de la API abierta del Concello de Vigo y Leaflet y Barlow son de código abierto. Para alojarla basta GitHub Pages.

Mapa base © colaboradores de OpenStreetMap.
