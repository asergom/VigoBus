#!/usr/bin/env python3
"""Genera data/direcciones.json: calles con nombre y números de portal para buscar direcciones.

Entradas:
  data/osm/vias.json.gz          OpenStreetMap: vías (de ahí salen las calles con su nombre y posición)
  data/osm/direcciones.json.gz   OpenStreetMap: portales, nwr["addr:housenumber"], con "out center tags"
  data/concello/numeracion.csv.gz  Concello de Vigo: numeración del callejero
                                 (https://datos.vigo.org/data/transporte/calles-numeracion.csv, licencia ODC-BY)

    python3 tools/actualizar_direcciones.py

Formato de salida:
  {
    "v": 1, "fecha": "AAAA-MM-DD",
    "calles": [
      [nombre, lat, lon, [num, dlat, dlon, num, dlat, dlon, ...]],
      ...
    ]
  }
  lat/lon: punto central de la calle, en enteros de 1e-5 grados.
  Portales: número tal cual ("19", "19B") y posición relativa al centro (1e-5 grados).
  Calles con el mismo nombre en sitios distintos (p. ej. "Rúa Real" en Vigo y en Redondela)
  salen como entradas separadas.

Datos © colaboradores de OpenStreetMap, licencia ODbL.
"""
import csv
import gzip
import json
import math
import os
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIAS = os.path.join(RAIZ, "data/osm/vias.json.gz")
PORTALES = os.path.join(RAIZ, "data/osm/direcciones.json.gz")
CONCELLO = os.path.join(RAIZ, "data/concello/numeracion.csv.gz")
SALIDA = os.path.join(RAIZ, "data/direcciones.json")
JUNTAS = 500  # metros: tramos con el mismo nombre a menos de esto son la misma calle
CERCA = 400  # metros: un portal del Concello va a la calle de OSM con su nombre si está a menos de esto

# Prueba de concepto: los portales del Concello se usan solo en la zona de Avenida das Camelias
# (y en ella sustituyen a los de OSM). Fuera de la zona sigue todo como antes.
ZONA = (42.2200, 42.2355, -8.7345, -8.7260)  # lat mín, lat máx, lon mín, lon máx


def en_zona(ll):
    return ZONA[0] <= ll[0] <= ZONA[1] and ZONA[2] <= ll[1] <= ZONA[3]


# Tipo de vía del Concello → palabra completa (en gallego, como rotula el Concello).
TIPOS = {"RUA": "Rúa", "AVDA": "Avenida", "CMÑO": "Camiño", "CTRA": "Estrada", "ESTDA": "Estrada",
         "TRVA": "Travesía", "BDA": "Baixada", "SBIDA": "Subida", "PRAZA": "Praza", "BARRO": "Barrio",
         "CXON": "Calexón", "PASEO": "Paseo"}
MENORES = {"de", "do", "da", "dos", "das", "del", "la", "el", "los", "las", "e", "y", "o", "a", "os", "as"}


def nombre_concello(tipo, nombre):
    """"CARME (DO)" de tipo RUA → "Rúa do Carme"; "Padre Lorenzo (carmelita)" → "Padre Lorenzo (Carmelita)"."""
    import re
    nombre = nombre.strip()
    art = ""
    m = re.match(r"^(.*?)\s*\((\w+)\)$", nombre)
    if m and m.group(2).lower() in MENORES:
        nombre, art = m.group(1), m.group(2).lower()
    pal = nombre.split()
    pal = [p.lower() if i and p.lower() in MENORES else ("(" + p[1:2].upper() + p[2:] if p.startswith("(") else p[:1].upper() + p[1:])
           for i, p in enumerate(pal)]
    return " ".join(([TIPOS[tipo]] if tipo in TIPOS else []) + ([art] if art else []) + pal)


# Abreviaturas del Concello que no son el principio de la palabra completa.
ABREV = {"dr": ("doutor", "doctor"), "sta": ("santa",), "sto": ("santo",), "sr": ("señor", "senor"),
         "pza": ("praza",), "avda": ("avenida",)}


def casa_nombre(concello, osm):
    """¿Es el mismo nombre? Cada palabra del Concello está en el de OSM, igual, como abreviatura
    (inicial o principio de la palabra) o en ABREV. Sin tipo de vía, artículos ni lo que va entre paréntesis."""
    import re
    a = nucleo(re.sub(r"\(.*?\)", " ", concello)).split()
    b = nucleo(osm).split()
    if not a:
        return False
    for w in a:
        if not any(v == w or v.startswith(w) or v in ABREV.get(w, ()) for v in b):
            return False
    return True


def dist(a, b):
    R, r = 6371000.0, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def clave(nombre):
    """Nombre sin mayúsculas, tildes ni signos: "Rúa de Urzáiz" y "Rúa de Urzaiz" son la misma calle."""
    import unicodedata
    t = unicodedata.normalize("NFD", nombre.lower())
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in t).split())


# Palabras que no distinguen una calle de otra ("Gran Vía" = "Avenida da Gran Vía").
# La misma lista está en js/direcciones.js.
GENERICAS = {"rua", "r", "calle", "c", "avenida", "avda", "av", "ave", "praza", "plaza", "pza", "pz",
             "camino", "camiño", "estrada", "carretera", "ctra",
             "travesia", "trav", "tr", "paseo", "pso", "rolda", "ronda", "glorieta", "rotonda", "lugar",
             "subida", "baixada", "bajada", "costa", "cuesta", "pasaxe", "pasaje", "corredoira", "vereda",
             "de", "do", "da", "dos", "das", "del", "la", "el", "los", "las", "o", "a", "os", "as", "e", "y"}


def nucleo(nombre):
    import unicodedata
    t = unicodedata.normalize("NFD", nombre.lower())
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    t = "".join(ch if ch.isalnum() or ch == "ñ" else " " for ch in t)
    pal = [w for w in t.split() if w not in GENERICAS]
    return " ".join(pal) or " ".join(t.split())


def main():
    with gzip.open(VIAS, "rt", encoding="utf-8") as f:
        osm = json.load(f)
    fecha = (osm.get("osm3s", {}).get("timestamp_osm_base") or "")[:10]
    coord = {e["id"]: (e["lat"], e["lon"]) for e in osm["elements"] if e["type"] == "node"}

    # Tramos con nombre, agrupados por nombre.
    tramos = defaultdict(list)
    for w in osm["elements"]:
        if w["type"] != "way":
            continue
        nombre = w.get("tags", {}).get("name")
        h = w.get("tags", {}).get("highway")
        if not nombre or h in ("proposed", "construction", "abandoned", "razed", "platform", "service",
                                  "cycleway", "corridor", "bus_stop", "elevator", "platform_edge"):
            continue
        pts = [coord[n] for n in w["nodes"] if n in coord]
        if len(pts) >= 2:
            tramos[clave(nombre)].append((nombre, pts))

    # Unir los tramos cercanos con el mismo nombre en una sola calle.
    calles = []  # {nombre, pts: [[...], ...]}
    for k, lst in tramos.items():
        padre = list(range(len(lst)))

        def raiz(i):
            while padre[i] != i:
                padre[i] = padre[padre[i]]
                i = padre[i]
            return i

        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                if raiz(i) == raiz(j):
                    continue
                a, b = lst[i][1], lst[j][1]
                # comparar extremos y algunos puntos intermedios (suficiente para tramos contiguos)
                ma = a[::max(1, len(a) // 6)] + [a[-1]]
                mb = b[::max(1, len(b) // 6)] + [b[-1]]
                if min(dist(p, q) for p in ma for q in mb) < JUNTAS:
                    padre[raiz(i)] = raiz(j)
        grupos = defaultdict(list)
        for i, (nombre, pts) in enumerate(lst):
            grupos[raiz(i)].append((nombre, pts))
        for g in grupos.values():
            # El nombre más repetido; a igualdad, el que lleva tildes ("Urzáiz" mejor que "Urzaiz").
            nombre = max((n for n, _ in g), key=lambda n: (sum(1 for m, _ in g if m == n), sum(ord(ch) > 127 for ch in n)))
            calles.append({"nombre": nombre, "tramos": [p for _, p in g], "portales": []})

    # Centro de cada calle: punto a mitad del tramo más largo.
    for c in calles:
        largo = max(c["tramos"], key=lambda p: sum(dist(p[i], p[i + 1]) for i in range(len(p) - 1)))
        L = sum(dist(largo[i], largo[i + 1]) for i in range(len(largo) - 1))
        acc = 0.0
        c["centro"] = largo[0]
        for i in range(len(largo) - 1):
            s = dist(largo[i], largo[i + 1])
            if acc + s >= L / 2:
                t = (L / 2 - acc) / s if s else 0
                c["centro"] = (largo[i][0] + t * (largo[i + 1][0] - largo[i][0]),
                               largo[i][1] + t * (largo[i + 1][1] - largo[i][1]))
                break
            acc += s

    # Portales: a la calle con su nombre más cercana; si no hay ninguna, se crea con ellos.
    porclave = defaultdict(list)
    for c in calles:
        porclave[clave(c["nombre"])].append(c)
    with gzip.open(PORTALES, "rt", encoding="utf-8") as f:
        portales = json.load(f)["elements"]
    sueltas = defaultdict(list)
    usados = 0
    for e in portales:
        t = e.get("tags", {})
        calle, num = t.get("addr:street"), t.get("addr:housenumber", "").strip()
        if not num:
            continue
        ll = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"]) if "center" in e else None
        if not ll:
            continue
        if en_zona(ll):  # en la zona de prueba mandan los portales del Concello
            continue
        if not calle:
            continue
        # "19;21" o "19-21": un portal por número
        for n in num.replace(";", ",").split(","):
            n = n.strip()
            if not n:
                continue
            cands = porclave.get(clave(calle))
            if cands:
                c = min(cands, key=lambda c: min(dist(ll, p) for tr in c["tramos"] for p in tr[::max(1, len(tr) // 8)]))
                c["portales"].append((n, ll))
            else:
                sueltas[clave(calle)].append((calle, n, ll))
            usados += 1
    # Portales con el nombre escrito de otra forma: a la calle con el mismo núcleo si está cerca.
    pornucleo = defaultdict(list)
    for c in calles:
        pornucleo[nucleo(c["nombre"])].append(c)
    for k, lst in sueltas.items():
        lat = sum(p[2][0] for p in lst) / len(lst)
        lon = sum(p[2][1] for p in lst) / len(lst)
        cerca = [c for c in pornucleo.get(nucleo(lst[0][0]), [])
                 if min(dist((lat, lon), p) for tr in c["tramos"] for p in tr[::max(1, len(tr) // 8)]) < 1000]
        if cerca:
            cerca[0]["portales"] += [(n, ll) for _, n, ll in lst]
        else:
            calles.append({"nombre": lst[0][0], "centro": (lat, lon), "portales": [(n, ll) for _, n, ll in lst]})

    # Portales del Concello de Vigo (solo dentro de la zona de prueba): a la calle de OSM con el
    # mismo nombre más cercana (a menos de CERCA metros); si no hay ninguna, se crea con su nombre.
    del_concello = 0
    sin_calle = defaultdict(list)
    posibles = {}
    margen = CERCA / 111000

    def cerca_zona(c):
        return any(ZONA[0] - margen <= p[0] <= ZONA[1] + margen and ZONA[2] - margen * 1.4 <= p[1] <= ZONA[3] + margen * 1.4
                   for tr in c["tramos"] for p in tr)
    with gzip.open(CONCELLO, "rt", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            num = r["num"].strip()
            if not num:
                continue
            ll = (float(r["lat"]), float(r["lon"]))
            if not en_zona(ll):
                continue
            nombre = nombre_concello(r["tipovia"], r["nombre"])
            if nombre not in posibles:
                # Calles de OSM cerca de la zona con un nombre que casa (primero las de nombre idéntico).
                exactas = [c for c in pornucleo.get(nucleo(nombre), []) if "tramos" in c and cerca_zona(c)]
                posibles[nombre] = exactas or [c for c in calles if "tramos" in c and cerca_zona(c)
                                               and casa_nombre(nombre, c["nombre"])]
            cands = []
            for c in posibles[nombre]:
                d = min(dist(ll, p) for tr in c["tramos"] for p in tr)
                if d < CERCA:
                    cands.append((d, id(c), c))
            if cands:
                min(cands)[2]["portales"].append((num, ll))
            else:
                sin_calle[(r["codvia"], nombre)].append((num, ll))
            del_concello += 1
    for (_, nombre), lst in sin_calle.items():
        lat = sum(ll[0] for _, ll in lst) / len(lst)
        lon = sum(ll[1] for _, ll in lst) / len(lst)
        calles.append({"nombre": nombre, "centro": (lat, lon), "portales": lst})
        print(f"  Calle del Concello sin calle en OSM: {nombre} ({len(lst)} portales)")

    salida = []
    for c in sorted(calles, key=lambda c: c["nombre"]):
        clat, clon = round(c["centro"][0] * 1e5), round(c["centro"][1] * 1e5)
        visto, plano = set(), []
        orden = lambda p: (int("".join(ch for ch in p[0] if ch.isdigit()) or 0), p[0])
        for n, ll in sorted(c["portales"], key=orden):
            if n.upper() in visto:
                continue
            visto.add(n.upper())
            plano += [n, round(ll[0] * 1e5) - clat, round(ll[1] * 1e5) - clon]
        salida.append([c["nombre"], clat, clon, plano])

    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "fecha": fecha, "calles": salida}, f, separators=(",", ":"), ensure_ascii=False)
    con = sum(1 for s in salida if s[3])
    tam = os.path.getsize(SALIDA)
    comp = len(gzip.compress(open(SALIDA, "rb").read(), 9))
    print(f"Calles: {len(salida)} ({con} con portales); portales de OSM: {usados}; del Concello: {del_concello}")
    print(f"{SALIDA}: {tam / 1e3:.0f} KB ({comp / 1e3:.0f} KB comprimido)")


if __name__ == "__main__":
    main()
