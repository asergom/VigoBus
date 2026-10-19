/* Próximo Vitrasa: búsqueda de direcciones (calle y número): calles de OpenStreetMap y portales de
   OpenStreetMap y del Concello de Vigo. data/direcciones.json se descarga una vez, al primer uso
   (buscar una calle, abrir "Cómo llegar" o acercar el mapa hasta ver los números).
   Si un portal no está en OpenStreetMap, su posición se estima entre los números conocidos
   del mismo lado de la calle; si la calle no tiene ninguno, se usa su punto central. */
(function (root) {
  "use strict";

  // Palabras que no distinguen una calle de otra ("Gran Vía" = "Avenida da Gran Vía").
  // La misma lista está en tools/actualizar_direcciones.py.
  const GEN = new Set(["rua", "r", "calle", "c", "avenida", "avda", "av", "ave", "praza", "plaza", "pza", "pz",
    "camino", "camiño", "estrada", "carretera", "ctra", "travesia", "trav", "tr", "paseo", "pso",
    "rolda", "ronda", "glorieta", "rotonda", "lugar", "subida", "baixada", "bajada", "costa", "cuesta",
    "pasaxe", "pasaje", "corredoira", "vereda",
    "de", "do", "da", "dos", "das", "del", "la", "el", "los", "las", "o", "a", "os", "as", "e", "y"]);

  // Tipo de vía, para que "camiño da Igrexa" prefiera un camiño y no una praza.
  const TIPO = { rua: "rua", r: "rua", calle: "rua", c: "rua", avenida: "avenida", avda: "avenida", av: "avenida",
    ave: "avenida", praza: "praza", plaza: "praza", pza: "praza", pz: "praza", camino: "camino",
    estrada: "estrada", carretera: "estrada", ctra: "estrada", travesia: "travesia", trav: "travesia",
    tr: "travesia", paseo: "paseo", pso: "paseo", rolda: "rolda", ronda: "rolda", subida: "subida",
    baixada: "baixada", bajada: "baixada", glorieta: "glorieta", rotonda: "glorieta", lugar: "lugar" };

  const normTxt = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ]+/g, " ").trim();

  // "Gran Vía 19", "gran via, 19b", "Urzáiz nº 7" → { street, num }; "Urzáiz," → num "" (falta el número).
  function parse(q) {
    const m = q.match(/^(.*?\D)[\s,]+(?:n[º°o.]?\s*)?(\d{1,4})\s*([a-zA-Z])?\s*$/);
    if (m && /[a-zA-ZÀ-ÿ]/.test(m[1])) return { street: m[1].replace(/[\s,]+$/, ""), num: m[2] + (m[3] || "").toUpperCase() };
    const c = q.match(/^(.*\S)\s*,\s*$/);
    if (c) return { street: c[1], num: "" };
    return { street: q, num: null };
  }

  function build(data) {
    const all = [];   // todos los portales conocidos, para dibujar sus números en el mapa
    const streets = data.calles.map(([name, lat, lon, p], i) => {
      const words = normTxt(name).split(" ").filter(Boolean);
      // Lo que va entre paréntesis (la parroquia: "Camiño da Igrexa (Tameiga)") se puede buscar, pero no
      // cuenta para decidir si el nombre escrito está completo.
      const core = normTxt(name.replace(/\(.*?\)/g, " ")).split(" ").filter((w) => w && !GEN.has(w));
      const portals = [];
      for (let k = 0; k < p.length; k += 3) portals.push({ n: String(p[k]), ll: [(lat + p[k + 1]) / 1e5, (lon + p[k + 2]) / 1e5] });
      const s = { i, name, ll: [lat / 1e5, lon / 1e5], words, core: core.length ? core : words, portals, norm: words.join(" "), tipo: TIPO[words[0]] || null };
      portals.forEach((pt) => all.push({ ...pt, s }));
      return s;
    });

    // Portales en una cuadrícula (celdas de ~200 m) para encontrar rápido los que se ven en el mapa.
    const CELL = 0.002;
    const grid = new Map();
    for (const pt of all) {
      const k = `${Math.floor(pt.ll[0] / CELL)}:${Math.floor(pt.ll[1] / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(pt);
    }
    function portalsIn(south, west, north, east) {
      const out = [];
      for (let a = Math.floor(south / CELL); a <= Math.floor(north / CELL); a++) {
        for (let b = Math.floor(west / CELL); b <= Math.floor(east / CELL); b++) {
          for (const pt of grid.get(`${a}:${b}`) || []) {
            if (pt.ll[0] >= south && pt.ll[0] <= north && pt.ll[1] >= west && pt.ll[1] <= east) out.push(pt);
          }
        }
      }
      return out;
    }
    const count = new Map();
    streets.forEach((s) => count.set(s.norm, (count.get(s.norm) || 0) + 1));
    streets.forEach((s) => { s.dup = count.get(s.norm) > 1; });

    // Calles cuyo nombre encaja con lo escrito: cada palabra escrita es el principio de alguna
    // palabra del nombre. Se ordenan por parecido y, a igualdad, por número de portales conocidos.
    function matchStreets(text, limit = 6) {
      const all = normTxt(text).split(" ").filter(Boolean);
      const toks = all.filter((t) => !GEN.has(t));
      if (!toks.length) return [];
      const tipo = all.length && TIPO[all[0]] ? TIPO[all[0]] : null;
      const out = [];
      for (const s of streets) {
        let score = 0, ok = true;
        for (const tk of toks) {
          const w = s.words.find((w) => w.startsWith(tk));
          if (!w) { ok = false; break; }
          score += w === tk ? 3 : 1;
        }
        if (!ok) continue;
        if (s.core[0] && s.core[0].startsWith(toks[0])) score += 4;     // empieza igual
        if (toks.length === s.core.length) score += 2;                  // ni le falta ni le sobra
        if (tipo) score += s.tipo === tipo ? 3 : -1;                    // mismo tipo de vía
        score += Math.min(s.portals.length, 40) / 40;
        out.push({ s, score });
      }
      out.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name, "es"));
      return out.slice(0, limit).map((o) => o.s);
    }

    // Posición de un número en una calle.
    function resolve(s, num) {
      if (!num) return { ll: s.ll, exact: false, centre: true };
      const up = num.toUpperCase();
      const ex = s.portals.find((p) => p.n.toUpperCase() === up);
      if (ex) return { ll: ex.ll, exact: true };
      const n = parseInt(num, 10);
      const known = s.portals.map((p) => ({ v: parseInt(p.n, 10), ll: p.ll })).filter((p) => !isNaN(p.v));
      const same = known.filter((p) => p.v % 2 === n % 2);
      const pool = same.length ? same : known;
      if (!pool.length) return { ll: s.ll, exact: false, centre: true };
      let lo = null, hi = null;
      for (const p of pool) {
        if (p.v <= n && (!lo || p.v > lo.v)) lo = p;
        if (p.v >= n && (!hi || p.v < hi.v)) hi = p;
      }
      if (lo && hi && hi.v !== lo.v) {
        const t = (n - lo.v) / (hi.v - lo.v);
        return { ll: [lo.ll[0] + t * (hi.ll[0] - lo.ll[0]), lo.ll[1] + t * (hi.ll[1] - lo.ll[1])], exact: false };
      }
      return { ll: (lo || hi).ll, exact: false };
    }

    // Números conocidos de una calle que empiezan por lo escrito (para autocompletar).
    function numbersStarting(s, prefix, limit = 4) {
      const up = prefix.toUpperCase();
      return s.portals.map((p) => p.n).filter((n) => n.toUpperCase().startsWith(up) && n.toUpperCase() !== up)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b)).slice(0, limit);
    }

    return { streets, parse, matchStreets, resolve, numbersStarting, portalsIn, fecha: data.fecha };
  }

  let pending = null;
  const api = {
    build, parse, normTxt,
    load(url = "data/direcciones.json") {
      if (!pending) pending = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(build)
        .catch((e) => { pending = null; throw e; });
      return pending;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PV_DIR = api;
})(this);
