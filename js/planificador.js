/* Próximo Vitrasa: planificador de viajes en bus de A a B (directos y con un transbordo).
   Usa data/viajes.json (horarios del GTFS) para elegir las opciones y, después, la web corrige la
   espera con los tiempos en vivo de la API (retime). Todo se calcula en el propio dispositivo.
   También funciona en Node (module.exports) para las pruebas. */
(function (root) {
  "use strict";

  const WALK = 75 / 60;          // metros por segundo a pie (4,5 km/h)
  const TRANSFER = 60;           // margen para cambiar de bus (s)
  const HORIZON = 4 * 3600;      // se buscan buses que salgan como mucho 4 h después de ahora
  // Coste para ordenar opciones: tiempo hasta llegar + castigo por andar y por transbordar.
  const WALK_PENALTY = 0.5;      // cada minuto andando cuenta como 1,5 min
  const TRANSFER_PENALTY = 300;  // un transbordo cuenta como 5 min más
  const MAX_OPTIONS = 5;
  const WIDE_OPTIONS = 8;
  const CUTOFF = 25 * 60;        // se descartan opciones que cuestan 25 min más que la mejor
  const WALK_SLACK = 5 * 60;     // el bus tiene que ahorrar más de 5 min frente a ir andando

  // Festivos con horario de domingo: nacionales, de Galicia y de Vigo (los fijos), más Jueves
  // y Viernes Santo.
  const FIXED_HOLIDAYS = new Set(["01-01", "01-06", "03-28", "05-01", "05-17", "07-25", "08-15", "10-12", "11-01", "12-06", "12-08", "12-25"]);
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  function isHoliday(d) {
    const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (FIXED_HOLIDAYS.has(md)) return true;
    const e = easter(d.getFullYear()).getTime(), day = 86400000;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.abs(t - (e - 3 * day)) < day / 2 || Math.abs(t - (e - 2 * day)) < day / 2;
  }
  // Bit del tipo de día (0 domingo … 6 sábado; los festivos, como domingo).
  const dayBit = (d) => 1 << (isHoliday(d) ? 0 : d.getDay());

  function build(data) {
    const ids = data.paradas;
    const index = new Map(ids.map((id, i) => [id, i]));
    const pats = data.patrones.map((p, n) => {
      const len = p.v.length / 3;
      const dep = new Int32Array(len), dur = new Int32Array(len), mask = new Uint8Array(len);
      let prev = 0, maxDur = 0;
      for (let k = 0; k < len; k++) {
        dep[k] = prev += p.v[3 * k];
        dur[k] = p.v[3 * k + 1];
        mask[k] = p.v[3 * k + 2];
        if (dur[k] > maxDur) maxDur = dur[k];
      }
      return { n, l: p.l, s: p.s, f: p.f, p: p.p, t: p.t.map((x) => x / 1000), dep, dur, mask, maxDur };
    });
    // Recorridos que pasan por cada parada: [patrón, posición].
    const at = ids.map(() => []);
    pats.forEach((pt, n) => pt.p.forEach((s, k) => at[s].push([n, k])));
    const transfers = ids.map((_, i) => [[i, 0]]);
    for (let k = 0; k < data.transbordos.length; k += 3) transfers[data.transbordos[k]].push([data.transbordos[k + 1], data.transbordos[k + 2]]);

    // Viajes de cada recorrido para una búsqueda: los de ayer (los que pasan de medianoche), hoy y
    // mañana, con la salida en segundos desde la medianoche de hoy.
    function tripsFor(date) {
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const days = [-1, 0, 1].map((o) => ({ o: o * 86400, bit: dayBit(new Date(day.getTime() + o * 86400000 + 3600000 * 12)) }));
      const cache = new Map();
      return (pt) => {
        let r = cache.get(pt.n);
        if (r) return r;
        const list = [];
        for (const { o, bit } of days) {
          for (let k = 0; k < pt.dep.length; k++) if (pt.mask[k] & bit) list.push([pt.dep[k] + o, pt.dur[k]]);
        }
        list.sort((a, b) => a[0] - b[0]);
        r = { dep: list.map((x) => x[0]), dur: list.map((x) => x[1]) };
        cache.set(pt.n, r);
        return r;
      };
    }

    // Primer viaje que pasa por la posición k del recorrido no antes de "tau".
    // Devuelve { q: índice del viaje, at: hora de paso } o null.
    function nextTrip(pt, tr, k, tau, limit = Infinity) {
      const { dep, dur } = tr;
      const f = pt.t[k];
      let lo = 0, hi = dep.length;
      const from = tau - f * pt.maxDur;
      while (lo < hi) { const m = (lo + hi) >> 1; if (dep[m] < from) lo = m + 1; else hi = m; }
      let best = null;
      for (let q = lo; q < dep.length; q++) {
        if (dep[q] > (best ? best.at : limit)) break;
        const a = dep[q] + f * dur[q];
        if (a >= tau && (!best || a < best.at)) best = { q, at: a };
      }
      return best && best.at <= limit ? best : null;
    }

    // Búsqueda. origins / dests: Map(índice de parada → metros a pie desde A / hasta B).
    // walk: metros andando de A a B (o Infinity). time: Date de salida.
    function search({ origins, dests, walk = Infinity, time = new Date() }) {
      const base = new Date(time.getFullYear(), time.getMonth(), time.getDate());
      const now = Math.round((time - base) / 1000);
      const trips = tripsFor(time);
      // Paradas de destino de cada recorrido, en orden: [posición, metros].
      const destOf = new Map(), lastDest = new Map();
      for (const [s, m] of dests) for (const [n, k] of at[s]) {
        if (!destOf.has(n)) destOf.set(n, []);
        destOf.get(n).push([k, m]);
        lastDest.set(n, Math.max(lastDest.get(n) || 0, k));
      }
      const best = new Map();       // línea(s) → mejor opción
      let bestArr = walk < Infinity ? now + walk / WALK : Infinity;
      const keep = (j) => {
        j.score = j.arr - now + WALK_PENALTY * j.walkM / WALK + TRANSFER_PENALTY * j.transfers;
        const old = best.get(j.key);
        if (!old || j.score < old.score) best.set(j.key, j);
        if (j.arr < bestArr) bestArr = j.arr;
      };
      // Mejor bajada de un viaje entre las paradas de destino después de la posición k.
      const bestDrop = (pt, tr, q, k) => {
        let out = null;
        for (const [j, m] of destOf.get(pt.n) || []) {
          if (j <= k) continue;
          const arr = tr.dep[q] + pt.t[j] * tr.dur[q] + m / WALK;
          const sc = arr + WALK_PENALTY * m / WALK;
          if (!out || sc < out.sc) out = { j, m, arr, sc };
        }
        return out;
      };
      const busLeg = (pt, tr, q, k, j) => ({
        type: "bus", pat: pt.n, line: pt.l, dir: pt.s, from: k, to: j, board: pt.p[k], alight: pt.p[j],
        dep: tr.dep[q] + pt.t[k] * tr.dur[q], arr: tr.dep[q] + pt.t[j] * tr.dur[q],
        tripDep: tr.dep[q], dur: tr.dur[q], stops: j - k,
      });

      const firsts = [];
      for (const [o, mo] of origins) {
        const tau = now + mo / WALK;
        for (const [n, k] of at[o]) {
          const pt = pats[n], tr = trips(pt);
          const nt = nextTrip(pt, tr, k, tau, now + HORIZON);
          if (!nt) continue;
          firsts.push({ o, mo, pt, tr, q: nt.q, k });
          // Directo.
          const d = bestDrop(pt, tr, nt.q, k);
          if (d) {
            const leg = busLeg(pt, tr, nt.q, k, d.j);
            keep({ key: `${pt.l}|${pt.s}`, legs: [{ type: "walk", m: mo, to: o }, leg, { type: "walk", m: d.m, from: leg.alight }],
              dep: leg.dep - mo / WALK, arr: d.arr, walkM: mo + d.m, transfers: 0 });
          }
        }
      }
      // Con un transbordo: bajar en cualquier parada posterior, andar hasta otra cercana (o
      // quedarse en la misma) y coger otra línea que llegue a una parada de destino.
      for (const f of firsts) {
        const { pt, tr, q, k } = f;
        for (let x = k + 1; x < pt.p.length; x++) {
          const ax = tr.dep[q] + pt.t[x] * tr.dur[q];
          if (ax - now > (bestArr - now) * 1.6 + 600) break;   // ya no puede salir a cuenta
          for (const [s2, m2] of transfers[pt.p[x]]) {
            const tau2 = ax + m2 / WALK + TRANSFER;
            for (const [n2, k2] of at[s2]) {
              const pt2 = pats[n2];
              if (pt2.l === pt.l || !(lastDest.get(n2) > k2)) continue;
              const tr2 = trips(pt2);
              const nt = nextTrip(pt2, tr2, k2, tau2, tau2 + 3600);
              if (!nt) continue;
              const d = bestDrop(pt2, tr2, nt.q, k2);
              if (!d) continue;
              const walkM = f.mo + m2 + d.m;
              const key = `${pt.l}|${pt.s}>${pt2.l}|${pt2.s}`;
              const sc = d.arr - now + WALK_PENALTY * walkM / WALK + TRANSFER_PENALTY;
              const old = best.get(key);
              if (old && old.score <= sc) continue;
              const l1 = busLeg(pt, tr, q, k, x), l2 = busLeg(pt2, tr2, nt.q, k2, d.j);
              keep({ key, legs: [{ type: "walk", m: f.mo, to: f.o }, l1, { type: "walk", m: m2, from: l1.alight, to: s2, transfer: true }, l2,
                { type: "walk", m: d.m, from: l2.alight }], dep: l1.dep - f.mo / WALK, arr: d.arr, walkM, transfers: 1 });
            }
          }
        }
      }

      // Salir lo más tarde posible en las opciones con transbordo (menos espera en el cambio).
      for (const j of best.values()) if (j.transfers) laterFirst(j, trips, now);

      return pick([...best.values()], now, walk, true);
    }

    // Con transbordo, el primer bus más tardío que aún llega a tiempo al segundo.
    function laterFirst(j, trips, now) {
      const [w0, l1, w1, l2] = j.legs;
      const pt = pats[l1.pat], tr = trips(pt);
      const need = l2.dep - w1.m / WALK - TRANSFER;
      let pick = null;
      for (let q = 0; q < tr.dep.length; q++) {
        const dep = tr.dep[q] + pt.t[l1.from] * tr.dur[q], arr = tr.dep[q] + pt.t[l1.to] * tr.dur[q];
        if (dep >= now + w0.m / WALK && arr <= need && (!pick || dep > pick.dep)) pick = { q, dep, arr };
      }
      if (pick && pick.dep > l1.dep) {
        Object.assign(l1, { dep: pick.dep, arr: pick.arr, tripDep: tr.dep[pick.q], dur: tr.dur[pick.q] });
        j.dep = l1.dep - w0.m / WALK;
      }
    }

    // Elegir las opciones que se enseñan. Se quita una opción si otra sale igual o más tarde,
    // llega igual o antes, se anda menos y no tiene más transbordos (es peor en todo), o si ir
    // andando todo el camino llega como mucho 5 min más tarde.
    // Con "wide" (antes de consultar los tiempos en vivo) se guardan hasta 8 y solo se quitan las
    // que llegan 10 min más tarde que otra mejor en todo lo demás: la espera real puede cambiarlo.
    function pick(list, now, walk, wide = false) {
      const walkArr = walk < Infinity ? now + walk / WALK : Infinity;
      list = list.filter((j) => !j.broken && j.arr + WALK_SLACK < walkArr);
      // Un transbordo para acabar cogiendo una línea que ya se puede coger directamente (y que
      // llega más o menos a la vez) no aporta nada: "15A una parada y luego el H2" frente al H2.
      const lastLine = (j) => j.legs[j.legs.length - 2].line;
      const directs = list.filter((j) => !j.transfers);
      list = list.filter((j) => !j.transfers || !directs.some((o) => lastLine(o) === lastLine(j) && o.arr <= j.arr + 120));
      list.sort((a, b) => a.score - b.score);
      const out = [];
      // El margen amplio solo cuando el primer bus es distinto: es la espera que más cambia en vivo.
      const first = (j) => `${j.legs[1].line}|${j.legs[1].board}`;
      for (const j of list) {
        if (out.length >= (wide ? WIDE_OPTIONS : MAX_OPTIONS) || j.score > list[0].score + CUTOFF * (wide ? 1.4 : 1)) break;
        if (!out.some((o) => {
          const margin = wide && first(o) !== first(j) ? 600 : -60;
          return o.dep >= j.dep - 60 && o.arr <= j.arr - margin && o.walkM <= j.walkM + 50 && o.transfers <= j.transfers;
        })) out.push(j);
      }
      return out;
    }
    // Selección final, con las opciones ya corregidas por los tiempos en vivo.
    function choose(list, time = new Date(), walk = Infinity) {
      const base = new Date(time.getFullYear(), time.getMonth(), time.getDate());
      return pick(list.slice(), (time - base) / 1000, walk);
    }

    // Corrige una opción con los tiempos en vivo. live(leg) → lista de { minutos, metros, ... } de
    // los buses de esa línea y sentido en la parada de subida, [] si la API no da ninguno y null
    // si no se sabe (sin respuesta). Devuelve una copia con dep/arr nuevos y, en cada tramo en bus,
    // "live": el dato usado (o null si se usa el horario).
    // time: ahora (los minutos de la API cuentan desde aquí); start: hora de salida pedida (la
    // misma que en search). Con salida más tarde, solo sirven los buses en vivo que pasan después.
    function retime(j, live, time = new Date(), start = time) {
      const base = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const now = (time - base) / 1000;
      const s0 = Math.max(now, (start - base) / 1000);
      const trips = tripsFor(start);
      const out = { ...j, legs: j.legs.map((l) => ({ ...l })) };
      let t = s0, prevBus = false;
      for (const leg of out.legs) {
        if (leg.type === "walk") { t += leg.m / WALK; continue; }
        const pt = pats[leg.pat], tr = trips(pt);
        const ready = t + (prevBus ? TRANSFER : 0);
        const list = live ? live(leg) : null;
        const est = list && list.map((e) => ({ e, at: now + Number(e.minutos) * 60 }))
          .filter((x) => isFinite(x.at) && x.at >= ready - 30).sort((a, b) => a.at - b.at)[0];
        leg.liveKnown = list != null;
        leg.live = est ? est.e : null;
        if (est) {
          // Duración del viaje: la del viaje programado que pasa más cerca de esa hora.
          let q = 0, dmin = Infinity;
          for (let k = 0; k < tr.dep.length; k++) {
            const d = Math.abs(tr.dep[k] + pt.t[leg.from] * tr.dur[k] - est.at);
            if (d < dmin) { dmin = d; q = k; }
          }
          const dur = tr.dur.length ? tr.dur[q] : leg.dur;
          leg.dep = est.at;
          leg.arr = est.at + (pt.t[leg.to] - pt.t[leg.from]) * dur;
        } else {
          // Sin dato en vivo que sirva: el horario (si la API respondió y no da ningún bus en
          // su horizonte de unos 100 min, el programado se marca como dudoso).
          const nt = nextTrip(pt, tr, leg.from, ready, ready + HORIZON);
          if (!nt) { out.broken = true; return out; }
          leg.dep = nt.at;
          leg.arr = tr.dep[nt.q] + pt.t[leg.to] * tr.dur[nt.q];
          leg.doubtful = list != null && list.length === 0 && leg.dep - now < 90 * 60;
        }
        t = leg.arr;
        prevBus = true;
      }
      out.arr = t;
      const first = out.legs.find((l) => l.type === "bus");
      out.dep = first.dep - out.legs[0].m / WALK;
      out.score = out.arr - s0 + WALK_PENALTY * out.walkM / WALK + TRANSFER_PENALTY * out.transfers + (out.legs.some((l) => l.doubtful) ? 1200 : 0);
      return out;
    }

    return { ids, index, pats, at, transfers, search, retime, choose, fecha: data.fecha, WALK };
  }

  let pending = null;
  const api = {
    build, isHoliday, dayBit, WALK,
    load(url = "data/viajes.json") {
      if (!pending) pending = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(build)
        .catch((e) => { pending = null; throw e; });
      return pending;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PV_PLAN = api;
})(this);
