"""Genera data/lineas.json (recorrido y paradas de cada línea) a partir del GTFS de Vitrasa.

Fuente: portal de datos abiertos del Concello de Vigo
https://datos.vigo.org/data/transporte/gtfs_vigo.zip

Uso:
    python3 tools/actualizar_lineas.py ruta/al/gtfs_vigo.zip

Por cada línea de la lista oficial de paradas (data/oficial/paradas.json) y cada sentido,
toma el recorrido que usan más viajes, lo simplifica y guarda sus paradas en orden.
"""
import csv
import io
import json
import math
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOLERANCIA_M = 4  # simplificación del trazado, en metros

MINUSCULAS = {"por", "de", "do", "da", "dos", "das", "del", "e", "y", "o", "a", "en"}


def norm_linea(n: str) -> str:
    """El GTFS escribe variantes como '11.', '4A-', ' N1' o 'PSA1'."""
    n = n.strip().rstrip(".-").strip()
    return re.sub(r"^PSA(\d)", r"PSA \1", n)


def titulo(s: str) -> str:
    palabras = re.sub(r"\s+", " ", s.replace("–", "-")).strip().lower().split(" ")
    out = []
    for i, w in enumerate(palabras):
        if i > 0 and w in MINUSCULAS:
            out.append(w)
        else:
            out.append(re.sub(r"(^|[(\"'¿/-])(\w)", lambda m: m.group(1) + m.group(2).upper(), w))
    return " ".join(out)


def leer(z: zipfile.ZipFile, nombre: str):
    with z.open(nombre) as f:
        lector = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        lector.fieldnames = [c.strip() for c in lector.fieldnames]
        for fila in lector:
            yield {k: (v or "").strip() for k, v in fila.items()}


def simplificar(puntos, tol):
    """Douglas-Peucker sobre coordenadas proyectadas localmente en metros."""
    if len(puntos) < 3:
        return puntos
    lat0 = math.radians(puntos[0][0])
    xy = [(p[1] * 111320 * math.cos(lat0), p[0] * 110540) for p in puntos]
    keep = [False] * len(puntos)
    keep[0] = keep[-1] = True
    pila = [(0, len(puntos) - 1)]
    while pila:
        a, b = pila.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        idx, dmax = -1, 0.0
        for i in range(a + 1, b):
            px, py = xy[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > dmax:
                idx, dmax = i, d
        if dmax > tol:
            keep[idx] = True
            pila += [(a, idx), (idx, b)]
    return [p for p, k in zip(puntos, keep) if k]


def codificar(puntos):
    """Polilínea codificada (algoritmo de Google, precisión 5)."""
    out, plat, plon = [], 0, 0
    for lat, lon in puntos:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def color_texto(hexcolor: str) -> str:
    r, g, b = (int(hexcolor[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return "#13222C" if lum > 0.55 else "#FFFFFF"


def orden_linea(n: str):
    m = re.match(r"([A-Z]*)\s*(\d*)(.*)", n)
    letras, num, resto = m.groups()
    return (0 if not letras else 1, letras, int(num) if num else 0, resto)


def main(gtfs_zip: str) -> None:
    oficiales = json.loads((ROOT / "data" / "oficial" / "paradas.json").read_text(encoding="utf-8"))
    lineas_actuales = {l.strip() for p in oficiales for l in p["lineas"].split(",") if l.strip()}
    gtfs_a_parada = {p["stop_id"]: str(p["id"]) for p in oficiales}

    z = zipfile.ZipFile(gtfs_zip)
    rutas = {r["route_id"]: r for r in leer(z, "routes.txt")}
    viajes = list(leer(z, "trips.txt"))

    # Viajes de las líneas actuales, por línea y sentido.
    uso = defaultdict(Counter)
    destinos = defaultdict(Counter)
    viajes_forma = defaultdict(list)
    for v in viajes:
        linea = norm_linea(rutas[v["route_id"]]["route_short_name"])
        if linea not in lineas_actuales:
            continue
        clave = (linea, v["direction_id"] or "0")
        uso[clave][v["shape_id"]] += 1
        destinos[(clave, v["shape_id"])][v["trip_headsign"]] += 1
        viajes_forma[v["shape_id"]].append(v["trip_id"])
    viajes_utiles = {t for ts in viajes_forma.values() for t in ts}

    paradas_viaje = defaultdict(list)
    for st in leer(z, "stop_times.txt"):
        if st["trip_id"] in viajes_utiles:
            paradas_viaje[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))

    # Viaje más largo de cada recorrido (algunos viajes son parciales).
    viaje_de = {f: max(ts, key=lambda t: len(paradas_viaje[t])) for f, ts in viajes_forma.items()}
    n_paradas = {f: len(paradas_viaje[t]) for f, t in viaje_de.items()}

    # Recorrido principal de cada sentido: el más usado entre los que hacen
    # el trayecto completo (al menos el 70 % de las paradas del más largo).
    elegidos = {}
    for clave, c in uso.items():
        maximo = max(n_paradas[f] for f in c)
        completos = [f for f in c if n_paradas[f] >= 0.7 * maximo]
        elegidos[clave] = max(completos, key=lambda f: (c[f], n_paradas[f]))
    formas_necesarias = set(elegidos.values())

    formas = defaultdict(list)
    for f in leer(z, "shapes.txt"):
        if f["shape_id"] in formas_necesarias:
            formas[f["shape_id"]].append((int(f["shape_pt_sequence"]), float(f["shape_pt_lat"]), float(f["shape_pt_lon"])))

    # Datos de cada línea: el nombre y el color de la variante principal (sin punto ni guion).
    info = {}
    for r in rutas.values():
        linea = norm_linea(r["route_short_name"])
        if linea in lineas_actuales and (linea not in info or r["route_short_name"].strip() == linea):
            info[linea] = r

    salida = {}
    for linea in sorted({c[0] for c in elegidos}, key=orden_linea):
        r = info[linea]
        color = (r["route_color"] or "D3202F").upper()
        sentidos = []
        for clave in sorted(c for c in elegidos if c[0] == linea):
            forma = elegidos[clave]
            puntos = [(la, lo) for _, la, lo in sorted(formas[forma])]
            ids = [gtfs_a_parada[s] for _, s in sorted(paradas_viaje[viaje_de[forma]]) if s in gtfs_a_parada]
            sentidos.append({
                "destino": titulo(destinos[(clave, forma)].most_common(1)[0][0]),
                "paradas": ids,
                "trazado": codificar(simplificar(puntos, TOLERANCIA_M)),
            })
        salida[linea] = {
            "nombre": titulo(r["route_long_name"]),
            "color": f"#{color}",
            "texto": color_texto(color),
            "sentidos": sentidos,
        }

    destino = ROOT / "data" / "lineas.json"
    destino.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(salida)} líneas escritas en {destino.relative_to(ROOT)} ({destino.stat().st_size // 1024} KB)")
    faltan = sorted(lineas_actuales - set(salida))
    if faltan:
        print("Líneas sin recorrido en el GTFS:", ", ".join(faltan))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "fuentes" / "gtfs_vigo.zip"))
