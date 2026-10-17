#!/usr/bin/env python3
"""Genera data/peatonal.json: la red de calles y caminos por los que se puede ir a pie.

Entrada: las vías de OpenStreetMap de la zona de Vitrasa, en el formato JSON de Overpass
(data/osm/vias.json.gz, descargado con el GitHub Action "Descargar OSM").

    python3 tools/actualizar_peatonal.py [data/osm/vias.json.gz]

Qué vías se usan: las mismas reglas generales que el perfil "a pie" de OSRM (el que usa
routing.openstreetmap.de), para que los resultados sean comparables:
  - calles, aceras, sendas, escaleras, zonas peatonales, pistas, etc.;
  - autovías y vías rápidas solo si están marcadas como transitables a pie;
  - fuera las vías privadas, prohibidas a peatones, en obras o en proyecto.

Formato de salida (compacto, para que la web lo cargue rápido):
  {
    "v": 1,
    "fuente": "...", "fecha": "AAAA-MM-DD",
    "nodos": [lat0, lon0, dlat1, dlon1, ...],   cruces; enteros en 1e-5 grados, diferencias
    "aristas": [a, b, metros*10, tipo, ...],     4 enteros por tramo entre dos cruces
    "formas": ["polilínea", ...]                  puntos intermedios de cada tramo (Google, precisión 5)
  }
  tipo: 0 normal, 1 escaleras, 2 sin asfaltar (pistas, sendas de tierra...).

Datos © colaboradores de OpenStreetMap, licencia ODbL (https://www.openstreetmap.org/copyright).
El archivo generado es una base de datos derivada y se distribuye con la misma licencia.
"""
import datetime
import gzip
import json
import math
import os
import sys
from collections import defaultdict

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRADA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RAIZ, "data/osm/vias.json.gz")
SALIDA = os.path.join(RAIZ, "data/peatonal.json")

# ---------- Reglas de acceso a pie (inspiradas en el perfil foot.lua de OSRM) ----------
PERMITIDAS = {
    "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
    "unclassified", "residential", "road", "living_street", "service", "track", "path",
    "steps", "pedestrian", "platform", "footway", "pier", "corridor",
}
SOLO_CON_PERMISO = {"trunk", "trunk_link", "motorway", "motorway_link", "cycleway", "bridleway", "busway"}
SI_PIE = {"yes", "designated", "permissive", "official"}
NO_PIE = {"no", "private", "use_sidepath", "discouraged"}
NO_ACCESO = {"no", "private", "agricultural", "forestry", "delivery", "military"}


ASFALTO = {"paved", "asphalt", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett",
           "cobblestone", "unhewn_cobblestone", "metal", "wood", "chipseal", "bricks"}
TIERRA = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "mud",
          "sand", "pebblestone", "rock", "woodchips", "grass_paver"}


def tipo_via(tags):
    """0 normal, 1 escaleras, 2 sin asfaltar (la web las evita un poco al elegir ruta)."""
    h, sup = tags.get("highway"), tags.get("surface", "")
    if h == "steps":
        return 1
    if sup in TIERRA:
        return 2
    if h in ("track", "path", "bridleway") and sup not in ASFALTO:
        return 2
    return 0


def transitable(tags):
    h = tags.get("highway")
    if not h or h in ("construction", "proposed", "abandoned", "razed", "platform_edge"):
        return False
    if tags.get("area") == "yes" and h not in ("pedestrian", "footway", "platform", "service", "living_street"):
        return False
    foot = tags.get("foot", "")
    if foot in NO_PIE:
        return False
    if h in SOLO_CON_PERMISO:
        return foot in SI_PIE
    if h not in PERMITIDAS:
        return foot in SI_PIE
    if tags.get("access") in NO_ACCESO and foot not in SI_PIE:
        return False
    return True


# ---------- Geometría ----------
def dist(a, b):
    """Distancia en metros entre dos puntos (lat, lon)."""
    R, r = 6371000.0, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def simplificar(pts, tol=1.5):
    """Douglas-Peucker con tolerancia en metros (proyección local plana)."""
    if len(pts) <= 2:
        return pts
    k = math.cos(math.radians(pts[0][0]))
    xy = [(p[1] * 111320 * k, p[0] * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    pila = [(0, len(pts) - 1)]
    while pila:
        i, j = pila.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        mejor, idx = -1.0, -1
        for m in range(i + 1, j):
            x, y = xy[m]
            if L2 == 0:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
            if d > mejor:
                mejor, idx = d, m
        if mejor > tol:
            keep[idx] = True
            pila += [(i, idx), (idx, j)]
    return [p for p, k_ in zip(pts, keep) if k_]


def codificar(pts):
    """Polilínea de Google (precisión 5)."""
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def main():
    with gzip.open(ENTRADA, "rt", encoding="utf-8") as f:
        osm = json.load(f)
    fecha = (osm.get("osm3s", {}).get("timestamp_osm_base") or "")[:10] or datetime.date.today().isoformat()

    coord = {}
    vias = []
    for e in osm["elements"]:
        if e["type"] == "node":
            coord[e["id"]] = (e["lat"], e["lon"])
        elif e["type"] == "way":
            vias.append(e)
    usadas = [w for w in vias if transitable(w.get("tags", {}))]
    print(f"Vías en la descarga: {len(vias)}; transitables a pie: {len(usadas)}")

    # Cruces: extremos de cada vía y nodos compartidos por varias vías.
    uso = defaultdict(int)
    for w in usadas:
        for n in w["nodes"]:
            uso[n] += 1
    cruce = set()
    for w in usadas:
        cruce.add(w["nodes"][0])
        cruce.add(w["nodes"][-1])
    cruce |= {n for n, c in uso.items() if c > 1}

    # Tramos entre cruces.
    tramos = []  # (a, b, [nodos osm], tipo)
    for w in usadas:
        tipo = tipo_via(w["tags"])
        nodos = [n for n in w["nodes"] if n in coord]
        ini = 0
        for i in range(1, len(nodos)):
            if nodos[i] in cruce or i == len(nodos) - 1:
                seg = nodos[ini:i + 1]
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    tramos.append([seg[0], seg[-1], seg, tipo])
                elif len(seg) >= 3:  # bucle cerrado (p. ej. plaza): partirlo en dos
                    mid = len(seg) // 2
                    cruce.add(seg[mid])
                    tramos.append([seg[0], seg[mid], seg[:mid + 1], tipo])
                    tramos.append([seg[mid], seg[-1], seg[mid:], tipo])
                ini = i

    # Componente conexa más grande (las islas sueltas no sirven para ir a ningún sitio).
    adj = defaultdict(list)
    for t in tramos:
        adj[t[0]].append(t[1])
        adj[t[1]].append(t[0])
    visto, mejor = set(), set()
    for n in adj:
        if n in visto:
            continue
        comp, pila = {n}, [n]
        visto.add(n)
        while pila:
            u = pila.pop()
            for v in adj[u]:
                if v not in visto:
                    visto.add(v)
                    comp.add(v)
                    pila.append(v)
        if len(comp) > len(mejor):
            mejor = comp
    tramos = [t for t in tramos if t[0] in mejor]
    print(f"Componente principal: {len(mejor)} cruces de {len(adj)}")

    # Unir tramos encadenados (nodos con exactamente dos tramos del mismo tipo).
    inc = defaultdict(list)
    for i, t in enumerate(tramos):
        inc[t[0]].append(i)
        inc[t[1]].append(i)
    vivo = [True] * len(tramos)
    for n in list(inc):
        lst = [i for i in inc[n] if vivo[i]]
        if len(lst) != 2 or lst[0] == lst[1]:
            continue
        i, j = lst
        ti, tj = tramos[i], tramos[j]
        if ti[3] != tj[3]:
            continue
        a = ti[2] if ti[1] == n else ti[2][::-1]   # termina en n
        b = tj[2] if tj[0] == n else tj[2][::-1]   # empieza en n
        seg = a + b[1:]
        if seg[0] == seg[-1]:
            continue
        tramos[i] = [seg[0], seg[-1], seg, ti[3]]
        vivo[j] = False
        for extremo in (tj[0], tj[1]):
            if extremo != n:
                inc[extremo] = [i if x == j else x for x in inc[extremo]]
        inc[n] = []
    tramos = [t for t, v in zip(tramos, vivo) if v]

    # Quitar duplicados (mismo par de cruces): se queda el más corto.
    porpar = {}
    for t in tramos:
        pts = [coord[n] for n in t[2]]
        L = sum(dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
        clave = (min(t[0], t[1]), max(t[0], t[1]))
        if clave not in porpar or L < porpar[clave][0]:
            porpar[clave] = (L, t, pts)

    # Numeración compacta de cruces, ordenados para que las diferencias sean pequeñas.
    usados = sorted({n for L, t, p in porpar.values() for n in (t[0], t[1])},
                    key=lambda n: (round(coord[n][0] * 200), coord[n][1]))
    idx = {n: i for i, n in enumerate(usados)}
    nodos, plat, plon = [], 0, 0
    for n in usados:
        lat, lon = round(coord[n][0] * 1e5), round(coord[n][1] * 1e5)
        nodos += [lat - plat, lon - plon]
        plat, plon = lat, lon

    aristas, formas = [], []
    total = 0.0
    for L, t, pts in porpar.values():
        inter = simplificar(pts)[1:-1]
        aristas += [idx[t[0]], idx[t[1]], max(1, round(L * 10)), t[3]]
        formas.append(codificar(inter) if inter else "")
        total += L

    salida = {
        "v": 1,
        "fuente": "© colaboradores de OpenStreetMap (ODbL), vías de la zona de Vitrasa",
        "fecha": fecha,
        "nodos": nodos,
        "aristas": aristas,
        "formas": formas,
    }
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(salida, f, separators=(",", ":"), ensure_ascii=False)
    tam = os.path.getsize(SALIDA)
    comp = len(gzip.compress(open(SALIDA, "rb").read(), 9))
    print(f"Red peatonal: {len(usados)} cruces, {len(formas)} tramos, {total / 1000:.0f} km")
    print(f"{SALIDA}: {tam / 1e6:.2f} MB ({comp / 1e6:.2f} MB comprimido)")


if __name__ == "__main__":
    main()
