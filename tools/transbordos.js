/* Calcula los transbordos a pie entre paradas cercanas y los guarda en data/viajes.json.
   Uso (después de tools/actualizar_viajes.py):  node tools/transbordos.js
   Distancia por la red peatonal propia (data/peatonal.json), no en línea recta: así no se proponen
   transbordos que obligan a rodear una autovía o la vía del tren. */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const PEATON = require(path.join(ROOT, "js", "peaton.js"));

const MAX = 300;          // metros a pie como máximo entre las dos paradas de un transbordo

const viajes = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "viajes.json"), "utf8"));
const gj = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "paradas.geojson"), "utf8"));
const ll = new Map(gj.features.map((f) => [f.properties.id, [f.geometry.coordinates[1], f.geometry.coordinates[0]]]));
const net = PEATON.build(JSON.parse(fs.readFileSync(path.join(ROOT, "data", "peatonal.json"), "utf8")));

const ids = viajes.paradas;
const pts = ids.map((id) => ll.get(id));
const snaps = pts.map((p) => net.snap(p[0], p[1]));
const R = 6371000, rad = Math.PI / 180;
const recta = (a, b) => {
  const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad), y = (b[0] - a[0]) * rad;
  return Math.hypot(x, y) * R;
};

const t0 = Date.now();
const out = [];
let pares = 0;
for (let i = 0; i < ids.length; i++) {
  const dist = net.around(pts[i], MAX + 200);
  for (let j = 0; j < ids.length; j++) {
    if (i === j || recta(pts[i], pts[j]) > MAX) continue;
    const m = dist(pts[j], snaps[j]);
    if (m <= MAX) { out.push(i, j, Math.round(m)); pares++; }
  }
}
viajes.transbordos = out;
fs.writeFileSync(path.join(ROOT, "data", "viajes.json"), JSON.stringify(viajes));
console.log(`${pares} transbordos a pie (≤${MAX} m) entre ${ids.length} paradas en ${Date.now() - t0} ms`);
