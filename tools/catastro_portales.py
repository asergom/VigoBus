#!/usr/bin/env python3
"""Convierte las direcciones INSPIRE del Catastro (A.ES.SDGC.AD.<mun>.zip) en un CSV como el del Concello.

    python3 tools/catastro_portales.py AD.36045.zip AD.36033.zip AD.36039.zip

Salida: data/catastro/portales.csv.gz con columnas nombre,tipovia,codvia,num,lon,lat,municipio
(codvia = municipio.código de vía del Catastro). Se descartan las direcciones sin número ("S-N").
Si un mismo número tiene varias posiciones, se prefiere la de la entrada ("Entrance") a la de la parcela.

Fuente: Dirección General del Catastro, servicio INSPIRE de direcciones (gratuito, CC-BY 4.0).
https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/
"""
import csv
import gzip
import io
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, "data/catastro/portales.csv.gz")
NS = {"gml": "http://www.opengis.net/gml/3.2", "AD": "urn:x-inspire:specification:gmlas:Addresses:3.0",
      "GN": "urn:x-inspire:specification:gmlas:GeographicalNames:3.0", "xlink": "http://www.w3.org/1999/xlink",
      "base": "urn:x-inspire:specification:gmlas:BaseTypes:3.2"}
GMLID = "{http://www.opengis.net/gml/3.2}id"
HREF = "{http://www.w3.org/1999/xlink}href"


def utm_a_geo(x, y, huso=29):
    """ETRS89 / UTM (EPSG:258xx) → latitud y longitud (GRS80), fórmulas de Krüger. Error < 1 mm."""
    a, f = 6378137.0, 1 / 298.257222101
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64)
    beta = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480]
    delta = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15]
    xi = y / (0.9996 * A)
    eta = (x - 500000) / (0.9996 * A)
    xi_p = xi - sum(b * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j, b in enumerate(beta))
    eta_p = eta - sum(b * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j, b in enumerate(beta))
    chi = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    lat = chi + sum(d * math.sin(2 * (j + 1) * chi) for j, d in enumerate(delta))
    lon0 = math.radians(huso * 6 - 183)
    lon = lon0 + math.atan2(math.sinh(eta_p), math.cos(xi_p))
    return math.degrees(lat), math.degrees(lon)


def leer(zip_path):
    z = zipfile.ZipFile(zip_path)
    gml = next(n for n in z.namelist() if re.match(r"A\.ES\.SDGC\.AD\.\d+\.gml$", n))
    mun = gml.split(".")[4]
    raiz = ET.parse(io.BytesIO(z.read(gml))).getroot()
    calles = {}
    for tn in raiz.iter("{%s}ThoroughfareName" % NS["AD"]):
        txt = tn.find(".//GN:text", NS)
        calles[tn.get(GMLID)] = (txt.text or "").strip() if txt is not None else ""
    portales = {}
    for ad in raiz.iter("{%s}Address" % NS["AD"]):
        num = (ad.find(".//AD:LocatorDesignator/AD:designator", NS).text or "").strip()
        m = re.match(r"^0*(\d+)\s*([A-Z])?$", num)
        if not m:
            continue   # "S-N" (sin número) u otros
        num = m.group(1) + (m.group(2) or "")
        x, y = map(float, ad.find(".//gml:pos", NS).text.split())
        spec = ad.find(".//AD:specification", NS).text
        via = next((c.get(HREF)[1:] for c in ad.findall("AD:component", NS) if ".TN." in (c.get(HREF) or "")), None)
        if not via or via not in calles:
            continue
        nombre = calles[via]
        tipo, _, resto = nombre.partition(" ")
        clave = (via, num)
        if clave in portales and portales[clave][0] == "Entrance" and spec != "Entrance":
            continue
        lat, lon = utm_a_geo(x, y)
        portales[clave] = (spec, [resto.strip(), tipo, f"{mun}.{via.rsplit('.', 1)[1]}", num, f"{lon:.5f}", f"{lat:.5f}", mun])
    return [p[1] for p in portales.values()]


def main():
    filas = []
    for z in sys.argv[1:]:
        f = leer(z)
        print(f"{os.path.basename(z)}: {len(f)} portales con número")
        filas += f
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with gzip.open(SALIDA, "wt", encoding="utf-8", newline="") as out:
        w = csv.writer(out)
        w.writerow(["nombre", "tipovia", "codvia", "num", "lon", "lat", "municipio"])
        w.writerows(sorted(filas, key=lambda r: (r[6], r[2], int(re.match(r"\d+", r[3]).group()), r[3])))
    print(f"{SALIDA}: {len(filas)} portales ({os.path.getsize(SALIDA) / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
