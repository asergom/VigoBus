#!/usr/bin/env python3
"""Genera data/direcciones.json: calles con nombre y números de portal para buscar direcciones.

Entradas (OpenStreetMap, zona de Vitrasa, formato JSON de Overpass):
  data/osm/vias.json.gz          vías (de ahí salen las calles con su nombre y posición)
  data/osm/direcciones.json.gz   portales: nwr["addr:housenumber"], con "out center tags"

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
import gzip
import json
import math
import os
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIAS = os.path.join(RAIZ, "data/osm/vias.json.gz")
PORTALES = os.path.join(RAIZ, "data/osm/direcciones.json.gz")
SALIDA = os.path.join(RAIZ, "data/direcciones.json")
JUNTAS = 500  # metros: tramos con el mismo nombre a menos de esto son la misma calle


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
        if not calle or not num:
            continue
        ll = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"]) if "center" in e else None
        if not ll:
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

    salida = []
    for c in sorted(calles, key=lambda c: c["nombre"]):
        clat, clon = round(c["centro"][0] * 1e5), round(c["centro"][1] * 1e5)
        visto, plano = set(), []
        for n, ll in sorted(c["portales"], key=lambda p: p[0]):
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
    print(f"Calles: {len(salida)} ({con} con portales); portales usados: {usados}")
    print(f"{SALIDA}: {tam / 1e3:.0f} KB ({comp / 1e3:.0f} KB comprimido)")


if __name__ == "__main__":
    main()
