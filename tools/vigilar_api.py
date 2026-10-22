"""Vigilancia de la API de tiempos en vivo de Vitrasa (la usa el Action diario vigilar-api.yml).

Lee las respuestas ya descargadas de unas pocas paradas y comprueba que la API sigue como la
entiende la web (js/app.js):
  - el texto es UTF-8 o windows-1252 y es JSON, sin caracteres estropeados ("Ã©", "�");
  - trae una lista "estimaciones" y cada bus tiene linea, ruta, minutos y metros (números);
  - cada línea existe en data/lineas.json y, en las paradas por las que pasan los dos sentidos
    de la línea (las únicas en que la web lo necesita), su "ruta" (letrero) casa con el destino o
    con uno de los letreros de alguno de esos sentidos, con la misma normalización que goesTo().

Uso: python3 tools/vigilar_api.py <carpeta>
  En la carpeta, <parada>.json con la respuesta y, si la descarga falló, <parada>.error.
Escribe el informe en <carpeta>/informe.md y termina con código 1 si hay algo que revisar.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAMPOS = ("linea", "ruta", "minutos", "metros")
ESTROPEADO = re.compile("Ã[\u0080-¿]|Â[\u0080-¿]|�")


def norm(s):  # igual que norm() de app.js
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9ñ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_linea(c):  # igual que normLine() de app.js
    c = re.sub(r"[.\-]+$", "", str(c).strip()).strip()
    return re.sub(r"^PSA(\d)", r"PSA \1", c)


def decodificar(buf):  # igual que fetchEstimates() de app.js
    try:
        return buf.decode("utf-8"), "UTF-8"
    except UnicodeDecodeError:
        return buf.decode("cp1252", errors="replace"), "windows-1252"


def es_numero(v):
    try:
        float(str(v).replace(",", "."))
        return True
    except ValueError:
        return False


def revisar(carpeta, lineas):
    graves, avisos, resumen = [], [], []
    def sentidos_en(code, id_):  # sentidos de la línea que pasan por la parada (como dirThrough)
        return [d for d in lineas[code]["sentidos"] if id_ in d["paradas"] or id_ in d.get("otras", [])]

    paradas = sorted({p.name.split(".")[0] for p in carpeta.iterdir() if p.suffix in (".json", ".error")})
    fallos, buses = [], 0
    for id_ in paradas:
        err = carpeta / f"{id_}.error"
        if err.exists():
            fallos.append(id_)
            resumen.append(f"| {id_} | no se pudo descargar: {err.read_text(encoding='utf-8').strip()[:120]} |")
            continue
        texto, cod = decodificar((carpeta / f"{id_}.json").read_bytes())
        try:
            datos = json.loads(texto)
        except json.JSONDecodeError as e:
            graves.append(f"Parada {id_}: la respuesta no es JSON ({e}). Empieza por: `{texto[:80]!r}`")
            continue
        if ESTROPEADO.search(texto):
            graves.append(f"Parada {id_}: hay caracteres estropeados en el texto ({cod}): `{ESTROPEADO.search(texto).group()}`")
        est = datos.get("estimaciones") if isinstance(datos, dict) else None
        if not isinstance(est, list):
            claves = list(datos)[:8] if isinstance(datos, dict) else type(datos).__name__
            graves.append(f"Parada {id_}: no hay lista `estimaciones` (llega: {claves})")
            continue
        buses += len(est)
        resumen.append(f"| {id_} | {len(est)} buses, {cod} |")
        for e in est:
            faltan = [c for c in CAMPOS if not isinstance(e, dict) or c not in e]
            if faltan:
                graves.append(f"Parada {id_}: un bus sin {', '.join(faltan)}: `{json.dumps(e, ensure_ascii=False)[:120]}`")
                continue
            for c in ("minutos", "metros"):
                if not es_numero(e[c]):
                    graves.append(f"Parada {id_}: `{c}` no es un número: `{e[c]!r}` (línea {e['linea']})")
            code = norm_linea(e["linea"])
            if code not in lineas:
                avisos.append(f"Parada {id_}: la línea `{e['linea']}` no está en lineas.json")
                continue
            aqui = sentidos_en(code, id_)
            if len(aqui) > 1 and norm(e["ruta"]) not in {norm(x) for d in aqui for x in [d["destino"], *d.get("letreros", [])]}:
                avisos.append(f"Parada {id_}: el letrero `{e['ruta']}` de la línea {code} no casa con ningún sentido "
                              f"(la web no sabrá hacia dónde va ese bus)")

    if paradas and len(fallos) == len(paradas):
        graves.append("No se pudo descargar ninguna parada: la API no responde o ha cambiado de dirección.")
    elif len(fallos) >= 2:
        avisos.append(f"No se pudieron descargar {len(fallos)} de {len(paradas)} paradas: {', '.join(fallos)}")
    if paradas and len(fallos) < len(paradas) and buses == 0:
        avisos.append("Ninguna parada devolvió buses (a esta hora debería haberlos): puede que la API falle sin dar error.")
    return graves, list(dict.fromkeys(avisos)), resumen


def main(carpeta):
    carpeta = Path(carpeta)
    lineas = json.loads((ROOT / "data" / "lineas.json").read_text(encoding="utf-8"))
    graves, avisos, resumen = revisar(carpeta, lineas)
    partes = ["| Parada | Resultado |", "|---|---|", *resumen, ""]
    if graves:
        partes += ["### Cambios graves (la web puede dejar de mostrar tiempos)", *[f"- {g}" for g in graves], ""]
    if avisos:
        partes += ["### Avisos", *[f"- {a}" for a in avisos], ""]
    if not graves and not avisos:
        partes.append("Todo bien: la API mantiene su forma y todos los letreros casan con lineas.json.")
    informe = "\n".join(partes)
    (carpeta / "informe.md").write_text(informe + "\n", encoding="utf-8")
    print(informe)
    return 1 if graves or avisos else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
