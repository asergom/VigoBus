#!/usr/bin/env python3
"""Genera data/direcciones.json: calles con nombre y números de portal para buscar direcciones.

Entradas:
  data/osm/vias.json.gz          OpenStreetMap: vías (de ahí salen las calles con su nombre y posición)
  data/osm/direcciones.json.gz   OpenStreetMap: portales, nwr["addr:housenumber"], con "out center tags"
  data/concello/numeracion.csv.gz  Concello de Vigo: numeración del callejero (portales de Vigo)
                                 (https://datos.vigo.org/data/transporte/calles-numeracion.csv, licencia ODC-BY)
  data/catastro/portales.csv.gz  Catastro: portales de Redondela, Mos y O Porriño (tools/catastro_portales.py, CC-BY 4.0)
  data/paradas.geojson           paradas: solo se guardan los portales a menos de MAX_PARADA de alguna

Calles: de OpenStreetMap. Portales: del Concello (Vigo) y del Catastro (municipios vecinos); los de
OpenStreetMap solo donde no hay ninguno de esos dos (zonas sin datos oficiales). Cada portal oficial va a
la calle de OSM con el mismo nombre más cercana (a menos de CERCA metros); si no hay ninguna, se crea una
calle con el nombre oficial y sin trazado (su punto central es el de sus portales).

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
CATASTRO = os.path.join(RAIZ, "data/catastro/portales.csv.gz")
PARADAS = os.path.join(RAIZ, "data/paradas.geojson")
SALIDA = os.path.join(RAIZ, "data/direcciones.json")
JUNTAS = 500  # metros: tramos con el mismo nombre a menos de esto son la misma calle
CERCA = 400  # metros: un portal oficial va a la calle de OSM con su nombre si está a menos de esto
MAX_PARADA = 2500  # metros: portales más lejos de cualquier parada no hacen falta
CELDA = 0.0015  # grados (~150 m): donde hay portales oficiales no se usan los de OSM (celda y vecinas)

# Tipo de vía del Concello y del Catastro → palabra completa (en gallego, como se rotula).
TIPOS = {"RUA": "Rúa", "AVDA": "Avenida", "CMÑO": "Camiño", "CTRA": "Estrada", "ESTDA": "Estrada",
         "TRVA": "Travesía", "BDA": "Baixada", "SBIDA": "Subida", "PRAZA": "Praza", "BARRO": "Barrio",
         "CXON": "Calexón", "PASEO": "Paseo",
         # Catastro
         "RU": "Rúa", "CL": "Rúa", "AV": "Avenida", "CM": "Camiño", "LG": "Lugar", "ES": "Estrada", "CR": "Estrada",
         "PL": "Polígono", "BO": "Barrio", "PS": "Paseo", "TR": "Travesía", "SU": "Subida", "PZ": "Praza",
         "BJ": "Baixada", "CJ": "Calexón", "GL": "Glorieta", "RD": "Rolda", "AL": "Alameda", "PJ": "Pasaxe"}
# Lugares y barrios: su nombre es el del núcleo, no el de una calle; no se juntan con calles de OSM.
SIN_CALLE = {"LG", "BO", "BARRO", "PL"}
MENORES = {"de", "do", "da", "dos", "das", "del", "la", "el", "los", "las", "e", "y", "o", "a", "os", "as"}


def nombre_concello(tipo, nombre):
    """"CARME (DO)" de tipo RUA → "Rúa do Carme"; "Padre Lorenzo (carmelita)" → "Padre Lorenzo (Carmelita)";
    "REDONDELA (DE)-CHAPELA" de tipo AV → "Avenida de Redondela (Chapela)" (tras el guion, la parroquia)."""
    import re
    nombre = nombre.strip()
    art = ""
    extra = ""
    if "-" in nombre:
        base, _, resto = nombre.partition("-")
        if base.strip() and resto.strip() and not re.search(r"\d", resto):
            nombre, extra = base.strip(), resto.strip()
    m = re.match(r"^(.*?)\s*\((\w+)\)$", nombre)
    if m and m.group(2).lower() in MENORES:
        nombre, art = m.group(1), m.group(2).lower()
    pal = nombre.split()
    if nombre.isupper():  # el Catastro escribe en mayúsculas
        pal = [p.lower() for p in pal]
    lugar = tipo in SIN_CALLE  # en un lugar el artículo es parte del nombre: "Lugar A Pereira"
    if tipo in TIPOS and pal and clave(pal[0]) == clave(TIPOS[tipo]):
        pal = pal[1:]  # "Camiño Camiño Hermida" → "Camiño Hermida"
    pal = [p.lower() if i and p.lower() in MENORES and not lugar else ("(" + p[1:2].upper() + p[2:] if p.startswith("(") else p[:1].upper() + p[1:])
           for i, p in enumerate(pal)]
    if extra:
        extra = " ".join(w.lower() if i and w.lower() in MENORES else w[:1].upper() + w[1:].lower() for i, w in enumerate(extra.split()))
        pal.append(f"({extra})")
    if art and lugar:
        art = art.capitalize()
    return " ".join(([TIPOS[tipo]] if tipo in TIPOS else []) + ([art] if art else []) + pal)


# Abreviaturas del Concello que no son el principio de la palabra completa.
ABREV = {"dr": ("doutor", "doctor"), "sta": ("santa",), "sto": ("santo",), "sr": ("señor", "senor"),
         "pza": ("praza",), "avda": ("avenida",), "mtnez": ("martinez",), "mtez": ("martinez",),
         "fdez": ("fernandez",), "glez": ("gonzalez",), "rguez": ("rodriguez",), "gral": ("general",),
         "sn": ("san",), "pdre": ("padre",), "nra": ("nosa", "nuestra"), "sra": ("señora", "senora")}


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

    # ---- Portales oficiales: Concello (Vigo) y Catastro (municipios vecinos) ----
    paradas = [tuple(reversed(f["geometry"]["coordinates"])) for f in json.load(open(PARADAS, encoding="utf-8"))["features"]]
    celdas_paradas = defaultdict(list)
    for q in paradas:
        celdas_paradas[(int(q[0] / 0.01), int(q[1] / 0.01))].append(q)

    def cerca_de_parada(ll):
        a, b = int(ll[0] / 0.01), int(ll[1] / 0.01)
        return any(dist(ll, q) < MAX_PARADA for da in (-3, -2, -1, 0, 1, 2, 3) for db in (-3, -2, -1, 0, 1, 2, 3)
                   for q in celdas_paradas.get((a + da, b + db), ()))

    grupos_of = defaultdict(list)  # (fuente, codvia) → [(num, ll)]
    nombres_of = {}
    lejos = 0
    for fuente, ruta in (("concello", CONCELLO), ("catastro", CATASTRO)):
        with gzip.open(ruta, "rt", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                num = r["num"].strip()
                if not num:
                    continue
                ll = (float(r["lat"]), float(r["lon"]))
                if not cerca_de_parada(ll):
                    lejos += 1
                    continue
                k = (fuente, r["codvia"])
                grupos_of[k].append((num, ll))
                nombres_of[k] = (r["tipovia"], nombre_concello(r["tipovia"], r["nombre"]))
    oficiales = sum(len(v) for v in grupos_of.values())
    cubierto = set()
    for lst in grupos_of.values():
        for _, ll in lst:
            a, b = int(ll[0] / CELDA), int(ll[1] / CELDA)
            cubierto.update((a + da, b + db) for da in (-1, 0, 1) for db in (-1, 0, 1))

    def flat(a, b):  # distancia aproximada en metros (suficiente a estas escalas)
        return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 82600)

    for c in calles:
        pts = [p for tr in c["tramos"] for p in tr]
        c["caja"] = (min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts))
        c["pts"] = pts
    pornucleo = defaultdict(list)
    for c in calles:
        pornucleo[nucleo(c["nombre"])].append(c)
    m_lat, m_lon = CERCA / 111320, CERCA / 82600

    sin_calle = []
    asignados = defaultdict(int)  # cómo se casó cada portal oficial
    for k, lst in grupos_of.items():
        tipo, nombre = nombres_of[k]
        caja = (min(ll[0] for _, ll in lst) - m_lat, max(ll[0] for _, ll in lst) + m_lat,
                min(ll[1] for _, ll in lst) - m_lon, max(ll[1] for _, ll in lst) + m_lon)
        toca = lambda c: not (c["caja"][1] < caja[0] or c["caja"][0] > caja[1] or c["caja"][3] < caja[2] or c["caja"][2] > caja[3])
        cands, como = [], ""
        if tipo not in SIN_CALLE:
            cands, como = [c for c in pornucleo.get(nucleo(nombre), []) if toca(c)], "nombre"
            if not cands:
                cands, como = [c for c in calles if "tramos" in c and toca(c) and casa_nombre(nombre, c["nombre"])], "parecido"
        sueltos = []
        for num, ll in lst:
            mejor = min(((min(flat(ll, p) for p in c["pts"]), id(c), c) for c in cands), default=None)
            if mejor and mejor[0] < CERCA:
                mejor[2]["portales"].append((num, ll))
                asignados[como] += 1
            else:
                sueltos.append((num, ll))
        if sueltos:
            sin_calle.append((nombre, sueltos))
            asignados["sin calle"] += len(sueltos)
    # Portales oficiales sin calle de OSM: una calle con el nombre oficial (si el mismo nombre sale
    # en sitios separados, una entrada por cada sitio).
    for nombre, lst in sin_calle:
        lat = sum(ll[0] for _, ll in lst) / len(lst)
        lon = sum(ll[1] for _, ll in lst) / len(lst)
        calles.append({"nombre": nombre, "centro": (lat, lon), "portales": lst})

    # ---- Portales de OpenStreetMap: solo donde no hay datos oficiales ----
    porclave = defaultdict(list)
    for c in calles:
        if "tramos" in c:
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
        if not ll or (int(ll[0] / CELDA), int(ll[1] / CELDA)) in cubierto:
            continue
        # "19;21" o "19-21": un portal por número
        for n in num.replace(";", ",").split(","):
            n = n.strip()
            if not n:
                continue
            cands = porclave.get(clave(calle))
            if cands:
                c = min(cands, key=lambda c: min(flat(ll, p) for p in c["pts"][::max(1, len(c["pts"]) // 30)]))
                c["portales"].append((n, ll))
            else:
                sueltas[clave(calle)].append((calle, n, ll))
            usados += 1
    # Portales con el nombre escrito de otra forma: a la calle con el mismo núcleo si está cerca.
    for k, lst in sueltas.items():
        lat = sum(p[2][0] for p in lst) / len(lst)
        lon = sum(p[2][1] for p in lst) / len(lst)
        cerca = [c for c in pornucleo.get(nucleo(lst[0][0]), [])
                 if min(flat((lat, lon), p) for p in c["pts"][::max(1, len(c["pts"]) // 30)]) < 1000]
        if cerca:
            cerca[0]["portales"] += [(n, ll) for _, n, ll in lst]
        else:
            calles.append({"nombre": lst[0][0], "centro": (lat, lon), "portales": [(n, ll) for _, n, ll in lst]})

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
    print(f"Portales oficiales: {oficiales} (y {lejos} lejos de las paradas, fuera); casados con OSM por nombre: "
          f"{asignados['nombre']}, por parecido: {asignados['parecido']}, sin calle: {asignados['sin calle']}")
    print(f"Calles: {len(salida)} ({con} con portales); portales de OSM usados: {usados}")
    with open(os.path.join(RAIZ, "data/direcciones-sin-calle.txt"), "w", encoding="utf-8") as f:
        f.write("# Calles oficiales (Concello/Catastro) sin calle de OSM con el mismo nombre: nombre, portales, lat, lon\n")
        for nombre, lst in sorted(sin_calle, key=lambda x: -len(x[1])):
            f.write(f"{nombre}\t{len(lst)}\t{lst[0][1][0]:.5f}\t{lst[0][1][1]:.5f}\n")
    print(f"{SALIDA}: {tam / 1e3:.0f} KB ({comp / 1e3:.0f} KB comprimido)")


if __name__ == "__main__":
    main()
