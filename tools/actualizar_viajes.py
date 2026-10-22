"""Genera data/viajes.json (horarios y tiempos de viaje de cada línea) a partir del GTFS de Vitrasa.

Lo usa el planificador "Cómo llegar" para saber qué buses pasan, cuándo y cuánto tardan.

Uso:
    python3 tools/actualizar_viajes.py ruta/al/gtfs_vigo.zip

Ejecutar después de tools/actualizar_lineas.py (usa data/lineas.json para saber el sentido y el
trazado de cada recorrido).

Formato de salida:
    {
      "v": 1, "fuente": "...", "fecha": "AAAA-MM-DD" (fecha del GTFS),
      "paradas": [ids],                 # índice de parada → número de poste
      "patrones": [                     # cada secuencia distinta de paradas de una línea y sentido
        { "l": "18A", "s": 0,           # línea y sentido (índice en lineas.json)
          "f": -1,                      # trazado: -1 el principal, k el ramal k de ese sentido
          "p": [índices de parada],
          "t": [milésimas del viaje],   # en qué fracción del tiempo total se llega a cada parada
          "h": ["LETRERO", ...],        # letreros de sus viajes (la "ruta" de la API en vivo)
          "v": [dSalida, duración, días, ...] }   # viajes: salida de la 1.ª parada en segundos desde
                                                  # medianoche (en diferencias con el anterior),
                                                  # duración en segundos y días de la semana como
                                                  # máscara (bit 0 domingo … bit 6 sábado)
      ],
      "transbordos": [] }               # lo rellena tools/transbordos.js (a pie, por la red peatonal)

El tiempo hasta la parada k de un viaje es t[k] / 1000 × duración: los viajes tardan más o menos
según la hora (hasta un 25 %), pero el reparto entre paradas se mantiene (error p95 ≈ 1 min).
"""
import csv
import datetime as dt
import io
import json
import math
import statistics
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from actualizar_lineas import leer, norm_linea  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def decodificar(s):
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in range(2):
            res = shift = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 31) << shift
                shift += 5
                if b < 32:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append((lat / 1e5, lon / 1e5))
    return out


def dist_trazado(puntos, ll):
    """Distancia (m) de un punto a una polilínea."""
    lat0 = math.radians(ll[0])
    kx, ky = 111320 * math.cos(lat0), 110540
    px, py = ll[1] * kx, ll[0] * ky
    best = math.inf
    for (a, b), (c, d) in zip(puntos, puntos[1:]):
        ax, ay, bx, by = b * kx, a * ky, d * kx, c * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        u = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) if L2 else 0
        best = min(best, math.hypot(ax + u * dx - px, ay + u * dy - py))
    return best


def segundos(h):
    a, b, c = (int(x) for x in h.split(":"))
    return a * 3600 + b * 60 + c


def main(gtfs_zip):
    oficiales = json.loads((ROOT / "data" / "oficial" / "paradas.json").read_text(encoding="utf-8"))
    gtfs_a_parada = {p["stop_id"]: str(p["id"]) for p in oficiales}
    lineas = json.loads((ROOT / "data" / "lineas.json").read_text(encoding="utf-8"))
    gj = json.loads((ROOT / "data" / "paradas.geojson").read_text(encoding="utf-8"))
    coords = {f["properties"]["id"]: (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in gj["features"]}
    lineas_parada = {f["properties"]["id"]: set(f["properties"]["lineas"]) for f in gj["features"]}

    z = zipfile.ZipFile(gtfs_zip)
    rutas = {r["route_id"]: r for r in leer(z, "routes.txt")}
    viajes = list(leer(z, "trips.txt"))

    # Días de cada servicio → máscara de días de la semana (bit 0 domingo, como getDay() en JS).
    dias = defaultdict(int)
    fechas = set()
    for r in leer(z, "calendar_dates.txt"):
        if r["exception_type"] != "1":
            continue
        d = dt.datetime.strptime(r["date"], "%Y%m%d").date()
        fechas.add(d)
        dias[r["service_id"]] |= 1 << ((d.weekday() + 1) % 7)
    for r in leer(z, "calendar.txt") if "calendar.txt" in z.namelist() else []:
        nombres = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        for i, n in enumerate(nombres):
            if r.get(n) == "1":
                dias[r["service_id"]] |= 1 << i
    if len({(d.weekday()) for d in fechas}) < 7:
        print("Aviso: el GTFS no cubre los 7 días de la semana")

    # Sentido de cada (línea, direction_id): mismo orden que en lineas.json.
    dir_ids = defaultdict(set)
    for v in viajes:
        linea = norm_linea(rutas[v["route_id"]]["route_short_name"])
        if linea in lineas:
            dir_ids[linea].add(v["direction_id"] or "0")
    sentido = {(l, d): i for l, ds in dir_ids.items() for i, d in enumerate(sorted(ds))}

    info = {}
    for v in viajes:
        linea = norm_linea(rutas[v["route_id"]]["route_short_name"])
        if linea in lineas and dias[v["service_id"]]:
            info[v["trip_id"]] = (linea, sentido[(linea, v["direction_id"] or "0")], dias[v["service_id"]], v["trip_headsign"].strip())

    horas = defaultdict(list)
    for st in leer(z, "stop_times.txt"):
        if st["trip_id"] in info:
            horas[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], segundos(st["arrival_time"] or st["departure_time"])))

    # Agrupar viajes por línea, sentido y secuencia de paradas.
    grupos = defaultdict(list)
    letreros = defaultdict(set)   # letreros de los viajes de cada grupo
    for tid, hs in horas.items():
        hs.sort()
        hs = [(s, gtfs_a_parada[g], t) for s, g, t in hs if g in gtfs_a_parada]
        if len(hs) < 2:
            continue
        linea, s, mask, letrero = info[tid]
        clave = (linea, s, tuple(p for _, p, _ in hs))
        grupos[clave].append(([t for *_, t in hs], mask))
        if letrero:
            letreros[clave].add(letrero)

    ids = sorted({p for (_, _, ps) in grupos for p in ps}, key=lambda x: (len(x), x))
    idx = {p: i for i, p in enumerate(ids)}

    patrones = []
    errores = []
    for (linea, s, ps), vs in sorted(grupos.items(), key=lambda kv: (kv[0][0], kv[0][1], -len(kv[1]))):
        # Viajes repetidos (mismo horario en distintos servicios): se unen sus días.
        unicos = {}
        for ts, mask in vs:
            k = (ts[0], ts[-1] - ts[0])
            if k in unicos:
                unicos[k] = (unicos[k][0], unicos[k][1] | mask)
            else:
                unicos[k] = (ts, mask)
        vs = sorted(unicos.values(), key=lambda x: x[0][0])
        fr = []
        for k in range(len(ps)):
            vals = [(ts[k] - ts[0]) / (ts[-1] - ts[0]) for ts, _ in vs if ts[-1] > ts[0]]
            fr.append(round(1000 * statistics.median(vals)) if vals else round(1000 * k / (len(ps) - 1)))
        for k in range(1, len(fr)):          # nunca hacia atrás
            fr[k] = max(fr[k], fr[k - 1])
        for ts, _ in vs:
            dur = ts[-1] - ts[0]
            errores += [abs(fr[k] / 1000 * dur - (ts[k] - ts[0])) for k in range(len(ps))]

        # Trazado de lineas.json que mejor sigue estas paradas (principal o un ramal).
        dirl = lineas[linea]["sentidos"][s]
        formas = [dirl["trazado"]] + dirl.get("ramales", [])
        mejor, f_elegida = math.inf, -1
        muestra = [coords[p] for p in ps if p in coords]
        for k, f in enumerate(formas):
            pts = decodificar(f)
            d = statistics.mean(sorted(dist_trazado(pts, ll) for ll in muestra)[: max(1, int(len(muestra) * 0.9))])
            if d < mejor - 1:
                mejor, f_elegida = d, k - 1
        if mejor > 60:
            print(f"Aviso: {linea} sentido {s} ({len(ps)} paradas) se aleja {mejor:.0f} m de sus trazados")

        plano, prev = [], 0
        for ts, mask in vs:
            plano += [ts[0] - prev, ts[-1] - ts[0], mask]
            prev = ts[0]
        patrones.append({"l": linea, "s": s, "f": f_elegida, "p": [idx[p] for p in ps], "t": fr, "v": plano,
                         "h": sorted(letreros[(linea, s, ps)])})

    # Paradas donde el GTFS dice que para una línea que la parada no anuncia (o al revés): solo aviso.
    sin_anunciar = sum(1 for pt in patrones for i in pt["p"] if pt["l"] not in lineas_parada.get(ids[i], set()))
    if sin_anunciar:
        print(f"Aviso: {sin_anunciar} paradas de recorridos no anuncian esa línea")

    salida = {
        "v": 1,
        "fuente": "GTFS de Vitrasa (datos.vigo.org)",
        "fecha": min(fechas).isoformat() if fechas else "",
        "paradas": ids,
        "patrones": patrones,
        "transbordos": [],
    }
    destino = ROOT / "data" / "viajes.json"
    # Conservar los transbordos ya calculados si las paradas no han cambiado.
    if destino.exists():
        viejo = json.loads(destino.read_text(encoding="utf-8"))
        if viejo.get("paradas") == ids:
            salida["transbordos"] = viejo.get("transbordos", [])
    destino.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_viajes = sum(len(p["v"]) // 3 for p in patrones)
    errores.sort()
    print(f"{len(patrones)} recorridos, {n_viajes} viajes, {len(ids)} paradas → {destino.relative_to(ROOT)} "
          f"({destino.stat().st_size // 1024} KB); error del modelo de tiempos: p50 {errores[len(errores) // 2]:.0f} s, "
          f"p95 {errores[int(len(errores) * 0.95)]:.0f} s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "fuentes" / "gtfs_vigo.zip"))
