// Prueba del planificador (js/planificador.js) con los datos del repositorio: busca viajes entre
// puntos al azar (siempre los mismos) a varias horas de un miércoles, con hasta 2 transbordos, y
// comprueba que cada opción es coherente: empieza y acaba andando desde paradas de origen y
// destino, cada bus sale después de poder llegar a su parada, los transbordos enlazan bien y dan
// al menos 1 min, no se repite línea seguida, la llegada cuadra y retime() no la rompe.
// Uso: node tools/probar_planificador.js [número de trayectos]   (termina con código 1 si falla)
const path = require("path"), fs = require("fs");
const repo = path.join(__dirname, "..");
const R = (p) => require(path.join(repo, p));
const peaton = R("js/peaton.js").build(R("data/peatonal.json"));
const P = R("js/planificador.js").build(R("data/viajes.json"));
const paradas = JSON.parse(fs.readFileSync(path.join(repo, "data/paradas.geojson"), "utf8")).features.map((f) => ({ id: String(f.properties.id), ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
const hav = (a, b) => { const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r; const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
function stopsAround(ll) { for (const max of [1000, 1600]) { const dist = peaton.around(ll, max); const out = new Map();
  for (const s of paradas) { const i = P.index.get(s.id); if (i == null || hav(ll, s.ll) > max) continue; const m = dist(s.ll); if (m <= max) out.set(i, m); } if (out.size) return out; } return new Map(); }
let seed = 777; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const jitter = (ll) => [ll[0] + (rnd() - 0.5) * 0.012, ll[1] + (rnd() - 0.5) * 0.016];
const W = P.WALK;
let n = 0, n3 = 0, errores = [], retimeOk = 0, retimeMal = 0, sameLine = 0;
const N = Number(process.argv[2] || 400);
for (let i = 0; i < N; i++) {
  const a = jitter(paradas[Math.floor(rnd() * paradas.length)].ll), b = jitter(paradas[Math.floor(rnd() * paradas.length)].ll);
  if (hav(a, b) < 1500) continue;
  const o = stopsAround(a), d = stopsAround(b);
  const time = new Date(2026, 9, 21, 7 + Math.floor(rnd() * 15), Math.floor(rnd() * 60));
  const base = new Date(2026, 9, 21).getTime(), now = (time - base) / 1000;
  for (const j of P.search({ origins: o, dests: d, walk: Infinity, time, maxTransfers: 2 })) {
    n++; if (j.transfers === 2) n3++;
    const L = j.legs, bad = (m) => errores.push(`${m} :: ${L.map((l) => l.type === "bus" ? `${l.line}[${l.from}->${l.to}] ${l.dep|0}-${l.arr|0}` : `walk ${l.m|0}`).join(" | ")}`);
    if (L[0].type !== "walk" || L[L.length - 1].type !== "walk") bad("no empieza/termina andando");
    if (!o.has(L[0].to) || o.get(L[0].to) !== L[0].m) bad("primer tramo a pie no casa con origen");
    if (!d.has(L[L.length - 1].from)) bad("bajada no es parada de destino");
    const buses = L.filter((l) => l.type === "bus");
    if (buses.length !== j.transfers + 1) bad("nº de buses ≠ transbordos+1");
    if (buses[0].dep < now + L[0].m / W - 1) bad("sale antes de poder llegar a la parada");
    let t = now;
    for (let k = 0; k < L.length; k++) {
      const l = L[k];
      if (l.type === "walk") { t += l.m / W; continue; }
      if (l.from >= l.to) bad("posición de subida ≥ bajada");
      const pt = P.pats[l.pat];
      if (pt.p[l.from] !== l.board || pt.p[l.to] !== l.alight) bad("parada de subida/bajada no casa con el recorrido");
      if (k > 1) {
        const w = L[k - 1];
        if (!w.transfer || w.from !== L[k - 2].alight || w.to !== l.board) bad("tramo de transbordo mal enlazado");
        if (l.dep < L[k - 2].arr + w.m / W + 60 - 1) bad("no da tiempo al transbordo");
        if (l.line === L[k - 2].line) { sameLine++; bad("misma línea seguida"); }
      }
      if (l.dep < t - 1) bad("bus sale antes de llegar");
      t = l.arr;
    }
    if (Math.abs(t - j.arr) > 2) bad(`llegada no cuadra ${t} vs ${j.arr}`);
    const rt = P.retime(j, () => null, time, time);
    if (rt.broken || !(rt.arr > 0)) retimeMal++; else retimeOk++;
  }
}
console.log(`opciones: ${n} (con 3 buses: ${n3}); errores: ${errores.length}; misma línea seguida: ${sameLine}; retime ok ${retimeOk}, roto ${retimeMal}`);
if (errores.length || retimeMal || !n3) console.log([...new Set(errores.map((e) => e.split(" :: ")[0]))].map((k) => `${k}: ${errores.filter((e) => e.startsWith(k)).length}\n   ej: ${errores.find((e) => e.startsWith(k))}`).join("\n"));

if (errores.length || retimeMal || !n || !n3) { console.error("El planificador da viajes incoherentes (o ninguno con 3 buses)."); process.exit(1); }
