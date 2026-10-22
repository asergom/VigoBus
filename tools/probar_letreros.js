// Prueba del emparejamiento de buses en vivo (PV_PLAN.liveReaches): busca en el horario del miércoles
// las situaciones en que el mismo letrero hace viajes que llegan a una parada de bajada y otros que
// no, simula cada viaje como bus en vivo con retrasos de 0 a 20 min y comprueba que nunca se acepta
// un bus que no llega al destino. Uso: node tools/probar_letreros.js (código 1 si alguno se acepta).
const path = require("path");
const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "js/planificador.js")).build(require(path.join(ROOT, "data/viajes.json")));
const goes = (pt, b, a) => { const i = pt.p.indexOf(b); return i >= 0 && pt.p.indexOf(a, i + 1) > i; };
const base = new Date(2026, 0, 7).getTime(), bit = 1 << 3;   // un miércoles cualquiera
const casos = [];
for (let s = 0; s < P.ids.length; s++) {
  const byKey = new Map();
  for (const x of P.stopPasses(s, bit)) {
    const pt = P.pats[x.pat];
    for (const h of pt.h || []) { const k = `${pt.l}|${pt.s}|${h}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(x); }
  }
  for (const [k, xs] of byKey) {
    const pats = [...new Set(xs.map((x) => x.pat))];
    if (pats.length < 2) continue;
    const alights = new Set();
    pats.forEach((n) => { const p = P.pats[n].p; p.slice(p.indexOf(s) + 1).forEach((a) => alights.add(a)); });
    for (const a of alights) {
      const reach = new Map(pats.map((n) => [n, goes(P.pats[n], s, a)]));
      if (new Set(reach.values()).size < 2) continue;
      for (const x of xs) casos.push({ leg: { line: P.pats[x.pat].l, dir: P.pats[x.pat].s, board: s, alight: a }, h: k.split("|")[2], t: x.t, truth: reach.get(x.pat) });
    }
  }
}
const muestra = casos.filter((_, i) => i % Math.max(1, Math.floor(casos.length / 3000)) === 0);
let malos = 0, buenos = 0, perdidos = 0;
const ej = [];
for (const cs of muestra) for (const min of [0, 3, -3, 6, -6, 10, -10, 15, 20]) {
  const r = P.liveReaches(cs.leg, cs.h, new Date(base + (cs.t + min * 60) * 1000));
  const ok = r === "yes" || r === "unknown";
  if (ok && !cs.truth) { malos++; if (ej.length < 5) ej.push(`${cs.leg.line} "${cs.h}" ${P.ids[cs.leg.board]}→${P.ids[cs.leg.alight]} retraso ${min}`); }
  else if (ok) buenos++; else if (cs.truth) perdidos++;
}
console.log(`letreros ambiguos: ${casos.length} situaciones, ${muestra.length} probadas; buses que no llegan aceptados: ${malos}; buenos aceptados ${buenos}, perdidos ${perdidos} (${(100 * perdidos / Math.max(1, buenos + perdidos)).toFixed(1)} %)`);
if (malos) { console.error("Se aceptan buses en vivo que no llegan al destino:\n  " + ej.join("\n  ")); process.exit(1); }
