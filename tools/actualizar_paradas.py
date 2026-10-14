"""Genera data/paradas.geojson a partir de la lista oficial de paradas de Vitrasa.

Fuente: portal de datos abiertos del Concello de Vigo
https://datos.vigo.org/data/transporte/paradas.json

Uso:
    python3 tools/actualizar_paradas.py data/oficial/paradas.json

Escribe data/paradas.geojson con: id (número de parada de Vitrasa), nombre y líneas.
Después hay que ejecutar tools/actualizar_lineas.py, que corrige las líneas de cada parada
con los viajes reales del GTFS.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def limpiar_nombre(nombre: str) -> str:
    n = nombre.strip()
    # En el original, el número de portal va separado por dos espacios: "Rúa de Barcelona  18".
    n = re.sub(r"\s{2,}(?=\S)", ", ", n)
    n = re.sub(r"\s+", " ", n)
    n = re.sub(r"\s*,\s*", ", ", n)
    n = re.sub(r"\(\s+", "(", n)
    n = re.sub(r"\s+\)", ")", n)
    return n


def limpiar_lineas(lineas: str) -> list[str]:
    vistas = []
    for l in (lineas or "").split(","):
        l = l.strip()
        if l and l not in vistas:
            vistas.append(l)
    return vistas


def main(origen: str) -> None:
    oficiales = json.loads(Path(origen).read_text(encoding="utf-8"))
    features = []
    for p in oficiales:
        features.append({
            "type": "Feature",
            "properties": {
                "id": str(p["id"]),
                "nombre": limpiar_nombre(p["nombre"]) or f"Parada {p['id']}",
                "lineas": limpiar_lineas(p.get("lineas")),
            },
            "geometry": {"type": "Point", "coordinates": [round(p["lon"], 6), round(p["lat"], 6)]},
        })
    ids = [f["properties"]["id"] for f in features]
    assert len(ids) == len(set(ids)), "Hay números de parada repetidos"
    features.sort(key=lambda f: f["properties"]["nombre"].lower())
    destino = ROOT / "data" / "paradas.geojson"
    destino.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"{len(features)} paradas escritas en {destino.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data" / "oficial" / "paradas.json"))
