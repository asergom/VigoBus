"""Genera data/sitios.json: sitios importantes con nombre (de OpenStreetMap) para el buscador.

Uso: python3 tools/actualizar_sitios.py
Lee data/osm/sitios.json.gz (descarga de Overpass que hace el Action mensual) y data/paradas.geojson.

Se quedan los sitios a menos de 2,5 km de alguna parada, sin repetir (mismo nombre a menos de
400 m: uno solo). Cada sitio: [nombre, lat·1e5, lon·1e5, tipo, "otros nombres"], donde tipo es un
índice de TIPOS (la web lo enseña como texto debajo del nombre) y "otros nombres" son alias y la
traducción al castellano de las palabras gallegas del nombre, para que "playa de Samil" encuentre
"Praia de Samil". El buscador no los dibuja en el mapa: solo son resultados de texto.
"""
import gzip
import json
import math
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUENTE = ROOT / "data" / "osm" / "sitios.json.gz"
SALIDA = ROOT / "data" / "sitios.json"
CERCA = 2500        # metros a la parada más cercana
JUNTOS = 400        # mismo nombre más cerca que esto: el mismo sitio

# Tipos (el orden es el índice que va en el fichero; la web tiene los textos en los 8 idiomas).
TIPOS = ["hospital", "salud", "estacion", "aeropuerto", "universidad", "colegio", "playa", "parque",
         "deporte", "comercio", "mercado", "museo", "cultura", "hotel", "mirador", "publico", "puerto", "otro"]
REGLAS = [
    ("amenity", {"hospital"}, "hospital"), ("amenity", {"clinic", "doctors"}, "salud"),
    ("railway", {"station"}, "estacion"), ("amenity", {"bus_station", "ferry_terminal"}, "estacion"),
    ("aeroway", {"aerodrome", "terminal"}, "aeropuerto"),
    ("amenity", {"university"}, "universidad"), ("amenity", {"school", "college"}, "colegio"),
    ("natural", {"beach"}, "playa"), ("leisure", {"park"}, "parque"),
    ("leisure", {"stadium", "sports_centre", "water_park"}, "deporte"), ("leisure", {"marina"}, "puerto"),
    ("shop", {"mall", "department_store"}, "comercio"), ("amenity", {"marketplace"}, "mercado"),
    ("tourism", {"museum", "gallery", "attraction", "zoo"}, "museo"),
    ("amenity", {"theatre", "cinema", "library", "arts_centre", "community_centre", "conference_centre", "exhibition_centre"}, "cultura"),
    ("tourism", {"hotel"}, "hotel"), ("tourism", {"viewpoint"}, "mirador"),
    ("amenity", {"townhall", "courthouse", "police", "post_office", "fire_station"}, "publico"), ("office", {"government"}, "publico"),
]
# Palabras gallegas frecuentes en los nombres → castellano (se añaden como "otros nombres").
GL_ES = {"praia": "playa", "colexio": "colegio", "aeroporto": "aeropuerto", "igrexa": "iglesia", "concello": "ayuntamiento",
         "universidade": "universidad", "porto": "puerto", "estacion": "estacion", "biblioteca": "biblioteca", "praza": "plaza",
         "saude": "salud", "xulgados": "juzgados", "mercado": "mercado", "pavillon": "pabellon", "escola": "escuela",
         "instituto": "instituto", "museo": "museo", "parque": "parque", "deportivo": "deportivo", "complexo": "complejo",
         "centro": "centro", "hospital": "hospital", "policinica": "policlinica", "cidade": "ciudad", "rua": "calle", "auditorio": "auditorio",
         "illas": "islas", "monte": "monte", "faro": "faro", "farol": "faro", "miradoiro": "mirador", "garda": "guardia", "correos": "correos"}
# Nombres populares que no están en el nombre de OSM: nombre exacto en OSM → otros nombres.
ALIAS = {
    "Vigo-Urzáiz": "Estación de tren Urzáiz estación de tren de Vigo renfe ave",
    "Vigo-Guixar": "Estación de tren Guixar renfe",
    "Aeroporto de Vigo": "Peinador",
    "Campus Universitario das Lagoas-Marcosende": "Universidad de Vigo Universidade de Vigo campus Uvigo",
    "Estadio Abanca-Balaídos": "Estadio de Balaídos Celta",
    "Abanca-Balaídos": "Estadio de Balaídos Celta",
    "Hospital Álvaro Cunqueiro": "Cunqueiro Hospital Cunqueiro",
    "Hospital do Meixoeiro": "Meixoeiro",
    "Hospital Ribera Povisa": "Povisa",
    "Centro Comercial Vialia Estación de Vigo": "Vialia",
    "Estación de Autobuses de Vigo (EI)": "Estación de autobuses",
    "Estación Marítima de Ría": "barcos Cíes Cangas Moaña",
}


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9ñ ]+", " ", s)).strip()


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 82600)


def main():
    els = json.load(gzip.open(FUENTE, "rt", encoding="utf-8"))["elements"]
    paradas = [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
               for f in json.loads((ROOT / "data" / "paradas.geojson").read_text(encoding="utf-8"))["features"]]
    celdas = {}
    for p in paradas:
        celdas.setdefault((int(p[0] / 0.02), int(p[1] / 0.02)), []).append(p)
    def cerca_de_parada(ll):
        a, b = int(ll[0] / 0.02), int(ll[1] / 0.02)
        return any(dist(ll, p) <= CERCA for da in (-2, -1, 0, 1, 2) for db in (-2, -1, 0, 1, 2) for p in celdas.get((a + da, b + db), []))

    # Más importantes primero (relaciones y vías antes que nodos), para quedarse con ellas al quitar repetidos.
    orden = {"relation": 0, "way": 1, "node": 2}
    els = sorted(els, key=lambda e: (orden.get(e["type"], 3), e["id"]))
    sitios, vistos = [], {}
    for e in els:
        t = e.get("tags", {})
        nombre = (t.get("name") or "").strip()
        if not nombre:
            continue
        ll = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"]) if "center" in e else None
        if not ll or not cerca_de_parada(ll):
            continue
        tipo = next((ti for k, vals, ti in REGLAS if t.get(k) in vals), "otro")
        clave = norm(nombre)
        if any(dist(ll, o) < JUNTOS for o in vistos.get(clave, [])):
            continue
        vistos.setdefault(clave, []).append(ll)
        extra = [ALIAS.get(nombre, "")]
        extra += [GL_ES[w] for w in clave.split() if w in GL_ES and GL_ES[w] != w]
        sitios.append([nombre, round(ll[0] * 1e5), round(ll[1] * 1e5), TIPOS.index(tipo), " ".join(x for x in extra if x).strip()])
    sitios.sort(key=lambda s: (norm(s[0]), s[1], s[2]))
    fecha = json.load(gzip.open(FUENTE, "rt", encoding="utf-8")).get("osm3s", {}).get("timestamp_osm_base", "")[:10]
    SALIDA.write_text(json.dumps({"v": 1, "fecha": fecha, "tipos": TIPOS, "sitios": sitios}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    por = {}
    for s in sitios:
        por[TIPOS[s[3]]] = por.get(TIPOS[s[3]], 0) + 1
    print(f"{len(sitios)} sitios ({len(els)} elementos en OSM) → {SALIDA.relative_to(ROOT)} ({SALIDA.stat().st_size // 1024} KB): {por}")


if __name__ == "__main__":
    main()
