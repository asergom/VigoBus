/* Próximo Vitrasa: planificador de viajes en bus de A a B (directos y con uno o más transbordos).
   Usa data/viajes.json (horarios del GTFS) para elegir las opciones y, después, la web corrige la
   espera con los tiempos en vivo de la API (retime). Todo se calcula en el propio dispositivo.
   También funciona en Node (module.exports) para las pruebas. */
(function (root) {
  "use strict";

  const WALK = 75 / 60;          // metros por segundo a pie (4,5 km/h)
  const TRANSFER = 60;           // margen para cambiar de bus (s)
  const HORIZON = 4 * 3600;      // se buscan buses que salgan como mucho 4 h después de ahora…
  const LONG_HORIZON = 30 * 3600; // …y, si no hay ninguno, hasta el día siguiente (de madrugada)
  // Coste para ordenar opciones: tiempo hasta llegar + castigo por andar y por transbordar.
  const WALK_PENALTY = 0.5;      // cada minuto andando cuenta como 1,5 min
  const TRANSFER_PENALTY = 300;  // un transbordo cuenta como 5 min más
  // Preferencias de ruta (11): pesos del coste. "fast", la de siempre.
  const PREFS = {
    fast: { walk: WALK_PENALTY, transfer: TRANSFER_PENALTY },
    transfers: { walk: WALK_PENALTY, transfer: 1200 },   // cada transbordo cuenta como 20 min
    walk: { walk: 2, transfer: TRANSFER_PENALTY },      // cada minuto andando cuenta como 3
  };
  const MAX_OPTIONS = 5;
  const WIDE_OPTIONS = 8;
  const CUTOFF = 25 * 60;        // se descartan opciones que cuestan 25 min más que la mejor
  const WALK_SLACK = 5 * 60;     // el bus tiene que ahorrar más de 5 min frente a ir andando
  const MAX_WAIT = 3600;         // espera máxima en un transbordo

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
      return { n, l: p.l, s: p.s, f: p.f, p: p.p, t: p.t.map((x) => x / 1000), dep, dur, mask, maxDur, h: p.h || null };
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
    // maxTransfers: transbordos como máximo (1: directos y con un transbordo; 2: hasta tres buses).
    // Siempre se devuelve al menos la mejor opción en bus si existe alguna (aunque andar sea más
    // rápido o salga dentro de muchas horas): ver pick().
    function search(opts) {
      if (opts.arriveBy) return searchArriveBy(opts);
      const out = searchWithin(opts, HORIZON);
      return out.length ? out : searchWithin(opts, LONG_HORIZON);
    }
    // raw: devolver todas las opciones encontradas, sin elegir (para "llegar a las").
    function searchWithin({ origins, dests, walk = Infinity, time = new Date(), maxTransfers = 1, prefer = "fast" }, horizon, raw = false) {
      const w = PREFS[prefer] || PREFS.fast;
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
      // Mejor llegada en bus hasta ahora (para podar). No cuenta ir andando: aunque andar sea más
      // rápido, hay que encontrar las buenas opciones en bus.
      let bestArr = Infinity;
      const keep = (j) => {
        j.w = w;
        j.score = j.arr - now + w.walk * j.walkM / WALK + w.transfer * j.transfers;
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
          const sc = arr + w.walk * m / WALK;
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
          const nt = nextTrip(pt, tr, k, tau, now + horizon);
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
              const nt = nextTrip(pt2, tr2, k2, tau2, tau2 + MAX_WAIT);
              if (!nt) continue;
              const d = bestDrop(pt2, tr2, nt.q, k2);
              if (!d) continue;
              const walkM = f.mo + m2 + d.m;
              const key = `${pt.l}|${pt.s}>${pt2.l}|${pt2.s}`;
              const sc = d.arr - now + w.walk * walkM / WALK + w.transfer;
              const old = best.get(key);
              if (old && old.score <= sc) continue;
              const l1 = busLeg(pt, tr, q, k, x), l2 = busLeg(pt2, tr2, nt.q, k2, d.j);
              keep({ key, legs: [{ type: "walk", m: f.mo, to: f.o }, l1, { type: "walk", m: m2, from: l1.alight, to: s2, transfer: true }, l2,
                { type: "walk", m: d.m, from: l2.alight }], dep: l1.dep - f.mo / WALK, arr: d.arr, walkM, transfers: 1 });
            }
          }
        }
      }

      // RAPTOR: la llegada más temprana con 1, 2… buses. Encuentra lo que la enumeración de arriba
      // no ve (más de un transbordo) y, con 0–1 transbordos, a veces una combinación mejor.
      raptor({ origins, dests, now, trips, rounds: maxTransfers + 1, keep, busLeg, horizon,
        limit: () => (bestArr - now) * 1.6 + 600 + now });

      // Salir lo más tarde posible en las opciones con transbordo (menos espera en el cambio).
      for (const j of best.values()) if (j.transfers) laterFirst(j, trips, now);

      return raw ? [...best.values()] : pick([...best.values()], now, walk, true);
    }

    // "Llegar a las X" (10). time: ahora (o desde cuándo se puede salir); arriveBy: Date de llegada.
    // Se busca hacia delante desde 3 h antes (o desde ahora) y cada opción se retrasa todo lo
    // posible: el último bus, el más tardío que llega a tiempo; los anteriores, los más tardíos que
    // enlazan. Se ordenan por lo tarde que se puede salir (y las mismas preferencias de ruta).
    // Los tiempos van en segundos desde la medianoche del día de la búsqueda, como siempre, y cada
    // opción lleva "arriveBy" (la hora pedida en esos segundos).
    function searchArriveBy(opts) {
      const time = opts.time || new Date();
      const start = new Date(Math.max(time.getTime(), opts.arriveBy.getTime() - 3 * 3600 * 1000));
      const base = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const now = (start - base) / 1000, T = (opts.arriveBy - base) / 1000;
      const trips = tripsFor(start);
      // Varias búsquedas, cada vez más cerca de la hora de llegada: cada una puede encontrar otras
      // paradas de subida o bajada con las que se sale más tarde. Por combinación, la más tardía.
      const best = new Map();
      const starts = [180, 120, 75, 40].map((back) => new Date(Math.max(time.getTime(), opts.arriveBy.getTime() - back * 60000)));
      const tried = new Set();
      const run = (from) => {
        if (tried.has(from.getTime())) return;
        tried.add(from.getTime());
        const off = (from - start) / 1000;
        for (const j of searchWithin({ ...opts, time: from }, HORIZON, true)) {
          // Los tiempos de cada búsqueda van desde la medianoche de su día: se pasan al de "start".
          const shift = off - ((from - new Date(from.getFullYear(), from.getMonth(), from.getDate())) / 1000 - now);
          if (shift) { j.dep += shift; j.arr += shift; j.legs.forEach((l) => { if (l.type === "bus") { l.dep += shift; l.arr += shift; l.tripDep += shift; } }); }
          if (!shiftToArriveBy(j, trips, now, T)) continue;
          const w = j.w || PREFS.fast;
          j.arriveBy = T;
          j.score = T - j.dep + w.walk * j.walkM / WALK + w.transfer * j.transfers;
          const old = best.get(j.key);
          if (!old || j.score < old.score) best.set(j.key, j);
        }
      };
      starts.forEach(run);
      // Afinado: desde 2 min después de la salida de las 3 mejores, por si se puede salir aún más tarde.
      [...best.values()].sort((x, y) => x.score - y.score).slice(0, 3)
        .forEach((j) => run(new Date(base.getTime() + (j.dep + 120) * 1000)));
      return pick([...best.values()], now, opts.walk == null ? Infinity : opts.walk, true);
    }
    // Retrasa el último bus al viaje más tardío que llega a tiempo y, después, los anteriores.
    // Devuelve false si ni el viaje encontrado llega a tiempo.
    function shiftToArriveBy(j, trips, now, T) {
      const legs = j.legs, last = legs[legs.length - 1];
      let li = legs.length - 2;
      while (li > 0 && legs[li].type !== "bus") li--;
      const l = legs[li];
      const need = T + 59 - last.m / WALK;   // "llega a las 15:00" vale aunque sean las 15:00:40
      const prevBus = legs.slice(0, li).reverse().find((x) => x.type === "bus");
      const ready = prevBus ? prevBus.arr + legs[li - 1].m / WALK + TRANSFER : now + legs[0].m / WALK;
      const pt = pats[l.pat], tr = trips(pt);
      let best = null;
      for (let q = 0; q < tr.dep.length; q++) {
        const dep = tr.dep[q] + pt.t[l.from] * tr.dur[q], arr = tr.dep[q] + pt.t[l.to] * tr.dur[q];
        if (dep >= ready && arr <= need && (!best || dep > best.dep)) best = { q, dep, arr };
      }
      if (!best) return false;
      Object.assign(l, { dep: best.dep, arr: best.arr, tripDep: tr.dep[best.q], dur: tr.dur[best.q] });
      laterFirst(j, trips, now);
      j.arr = l.arr + last.m / WALK;
      j.dep = legs[1].dep - legs[0].m / WALK;
      return true;
    }

    // RAPTOR (Delling, Pajor y Werneck, 2012), por rondas: en la ronda k se conocen las llegadas
    // más tempranas a cada parada con k buses. En cada ronda se recorren solo los recorridos que
    // pasan por paradas mejoradas en la anterior y, después, los transbordos a pie (≤300 m).
    // Una parada solo se guarda si mejora su mejor llegada de cualquier ronda anterior.
    // No se vuelve a subir a la misma línea de la que uno se acaba de bajar (como en la enumeración).
    function raptor({ origins, dests, now, trips, rounds, keep, busLeg, limit, horizon }) {
      const S = ids.length;
      const best = new Float64Array(S).fill(Infinity);   // mejor llegada a cada parada (todas las rondas)
      let prev = new Float64Array(S).fill(Infinity);     // llegadas de la ronda anterior
      let prevLine = new Array(S).fill(null);            // línea con la que se llegó (ronda anterior)
      const startWalk = new Map();
      let marked = new Set();
      for (const [o, mo] of origins) {
        const tau = now + mo / WALK;
        if (tau < prev[o]) { prev[o] = best[o] = tau; startWalk.set(o, mo); marked.add(o); }
      }
      const R = [];   // por ronda: llegada en bus, de qué viaje, y si se llegó andando desde otra parada
      for (let k = 1; k <= rounds && marked.size; k++) {
        const bus = new Float64Array(S).fill(Infinity);
        const pPat = new Int32Array(S).fill(-1), pQ = new Int32Array(S), pFrom = new Int32Array(S), pTo = new Int32Array(S);
        const cur = new Float64Array(S).fill(Infinity);   // llegada de esta ronda (en bus o andando)
        const wFrom = new Int32Array(S).fill(-1), wM = new Float64Array(S);
        const curLine = new Array(S).fill(null);          // línea del último bus (en bus o andando después)
        const busLine = new Array(S).fill(null);          // línea del bus con el que se llegó a la parada
        const cap = limit();
        // Recorridos que hay que mirar y desde qué posición.
        const queue = new Map();
        for (const s of marked) for (const [n, k0] of at[s]) if (!(queue.get(n) <= k0)) queue.set(n, k0);
        const reached = new Set();
        for (const [n, k0] of queue) {
          const pt = pats[n], tr = trips(pt);
          let q = -1, from = -1;
          for (let i = k0; i < pt.p.length; i++) {
            const s = pt.p[i];
            if (q >= 0) {
              const arr = tr.dep[q] + pt.t[i] * tr.dur[q];
              if (arr < best[s] && arr < bus[s] && arr <= cap) {
                bus[s] = cur[s] = best[s] = arr;
                pPat[s] = n; pQ[s] = q; pFrom[s] = from; pTo[s] = i; curLine[s] = busLine[s] = pt.l;
                reached.add(s);
              }
            }
            // ¿Se puede subir aquí a un viaje anterior al que se lleva?
            if (prev[s] < Infinity && prevLine[s] !== pt.l) {
              const ready = prev[s] + (k > 1 ? TRANSFER : 0);
              const curAt = q >= 0 ? tr.dep[q] + pt.t[i] * tr.dur[q] : Infinity;
              if (ready <= curAt) {
                const nt = nextTrip(pt, tr, i, ready, k > 1 ? ready + MAX_WAIT : now + horizon);
                if (nt && nt.at < curAt) { q = nt.q; from = i; }
              }
            }
          }
        }
        // Transbordos a pie desde las paradas a las que se ha llegado en bus.
        const next = new Set(reached);
        for (const s of reached) {
          for (const [s2, m] of transfers[s]) {
            if (!m) continue;
            const a = bus[s] + m / WALK;
            if (a < best[s2] && a < cur[s2]) { cur[s2] = best[s2] = a; wFrom[s2] = s; wM[s2] = m; curLine[s2] = busLine[s]; next.add(s2); }
          }
        }
        R.push({ bus, pPat, pQ, pFrom, pTo, cur, wFrom, wM });
        prev = cur;
        prevLine = curLine;
        marked = next;
      }

      // Opciones: llegadas en bus a cada parada de destino, en cada ronda.
      const legsTo = (k, s) => {   // tramos hasta llegar a s en bus en la ronda k (k desde 1)
        const r = R[k - 1], pt = pats[r.pPat[s]], tr = trips(pt);
        const leg = busLeg(pt, tr, r.pQ[s], r.pFrom[s], r.pTo[s]);
        const b = leg.board;
        if (k === 1) return [{ type: "walk", m: startWalk.get(b), to: b }, leg];
        const p = R[k - 2];
        const before = p.wFrom[b] >= 0 ? p.wFrom[b] : b;
        const m = p.wFrom[b] >= 0 ? p.wM[b] : 0;
        return [...legsTo(k - 1, before), { type: "walk", m, from: before, to: b, transfer: true }, leg];
      };
      R.forEach((r, i) => {
        for (const [d, md] of dests) {
          if (!(r.bus[d] < Infinity)) continue;
          const legs = legsTo(i + 1, d);
          const buses = legs.filter((l) => l.type === "bus");
          legs.push({ type: "walk", m: md, from: d });
          const walkM = legs.reduce((a, l) => a + (l.type === "walk" ? l.m : 0), 0);
          keep({ key: buses.map((l) => `${l.line}|${l.dir}`).join(">"), legs, dep: buses[0].dep - legs[0].m / WALK,
            arr: r.bus[d] + md / WALK, walkM, transfers: i });
        }
      });
    }

    // Con transbordos, cada bus el más tardío que aún llega a tiempo al siguiente (de atrás
    // hacia delante): menos espera en los cambios, la misma llegada.
    function laterFirst(j, trips, now) {
      const legs = j.legs;
      for (let i = legs.length - 2; i >= 1; i--) {
        const l1 = legs[i];
        if (l1.type !== "bus") continue;
        const nextBus = legs.slice(i + 1).find((l) => l.type === "bus");
        if (!nextBus) continue;
        const w1 = legs[i + 1];
        const need = nextBus.dep - w1.m / WALK - TRANSFER;
        const prevBus = legs.slice(0, i).reverse().find((l) => l.type === "bus");
        const ready = prevBus ? prevBus.arr + legs[i - 1].m / WALK + TRANSFER : now + legs[0].m / WALK;
        const pt = pats[l1.pat], tr = trips(pt);
        let pick = null;
        for (let q = 0; q < tr.dep.length; q++) {
          const dep = tr.dep[q] + pt.t[l1.from] * tr.dur[q], arr = tr.dep[q] + pt.t[l1.to] * tr.dur[q];
          if (dep >= ready && arr <= need && (!pick || dep > pick.dep)) pick = { q, dep, arr };
        }
        if (pick && pick.dep > l1.dep) Object.assign(l1, { dep: pick.dep, arr: pick.arr, tripDep: tr.dep[pick.q], dur: tr.dur[pick.q] });
      }
      j.dep = legs[1].dep - legs[0].m / WALK;
    }

    // Elegir las opciones que se enseñan. Se quita una opción si otra sale igual o más tarde,
    // llega igual o antes, se anda menos y no tiene más transbordos (es peor en todo), o si ir
    // andando todo el camino llega como mucho 5 min más tarde.
    // Con "wide" (antes de consultar los tiempos en vivo) se guardan hasta 8 y solo se quitan las
    // que llegan 10 min más tarde que otra mejor en todo lo demás: la espera real puede cambiarlo.
    function pick(list, now, walk, wide = false) {
      const walkArr = walk < Infinity ? now + walk / WALK : Infinity;
      const all = list.filter((j) => !j.broken);
      // "Llegar a las": compensa si deja salir más de 5 min más tarde que andando.
      const T = all.length ? all[0].arriveBy : null;
      const walkDep = T != null && walk < Infinity ? T - walk / WALK : -Infinity;
      const worth = T != null ? (j) => j.dep - WALK_SLACK > walkDep : (j) => j.arr + WALK_SLACK < walkArr;
      const slower = T != null ? (j) => j.dep <= walkDep : (j) => j.arr >= walkArr;
      list = all.filter(worth);
      // Si ninguna opción en bus compensa frente a andar, se enseña igualmente la mejor (marcada
      // "slower"); antes de los tiempos en vivo se guardan unas pocas, porque la espera real cambia.
      if (!list.length && all.length) {
        return all.sort((a, b) => a.score - b.score).slice(0, wide ? 3 : 1).map((j) => ({ ...j, slower: slower(j) }));
      }
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
      // "Llegar a las": se sale cuando toca (no ya), así que se cuenta desde la salida prevista.
      let t = j.arriveBy != null ? Math.max(s0, j.dep) : s0, prevBus = false;
      for (const leg of out.legs) {
        if (leg.type === "walk") { t += leg.m / WALK; continue; }
        const pt = pats[leg.pat], tr = trips(pt);
        const ready = t + (prevBus ? TRANSFER : 0);
        const list = live ? live(leg) : null;
        const cands = list ? list.map((e) => ({ e, at: now + Number(e.minutos) * 60 })).filter((x) => isFinite(x.at) && x.at >= ready - 30) : [];
        // "Llegar a las": el bus en vivo que corresponde al previsto (como mucho 10 min de diferencia);
        // si no, el primero que se pueda coger.
        const est = j.arriveBy != null
          ? cands.filter((x) => Math.abs(x.at - leg.dep) <= 600).sort((a, b) => Math.abs(a.at - leg.dep) - Math.abs(b.at - leg.dep))[0]
          : cands.sort((a, b) => a.at - b.at)[0];
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
          if (j.arriveBy != null && leg.dep >= ready - 30) {
            // "Llegar a las": se mantiene el viaje previsto si aún se puede coger.
          } else {
            const nt = nextTrip(pt, tr, leg.from, ready, Math.max(ready + HORIZON, leg.dep + HORIZON));
            if (!nt) { out.broken = true; return out; }
            leg.dep = nt.at;
            leg.arr = tr.dep[nt.q] + pt.t[leg.to] * tr.dur[nt.q];
          }
          leg.doubtful = list != null && list.length === 0 && leg.dep - now < 90 * 60;
        }
        t = leg.arr;
        prevBus = true;
      }
      out.arr = t;
      const first = out.legs.find((l) => l.type === "bus");
      out.dep = first.dep - out.legs[0].m / WALK;
      const w = j.w || PREFS.fast;
      const doubt = out.legs.some((l) => l.doubtful) ? 1200 : 0;
      if (j.arriveBy != null) {
        out.late = out.arr > j.arriveBy + 60;   // con los buses en vivo ya no llega a tiempo
        out.score = j.arriveBy - out.dep + w.walk * out.walkM / WALK + w.transfer * out.transfers + doubt + (out.late ? 3600 : 0);
      } else out.score = out.arr - s0 + w.walk * out.walkM / WALK + w.transfer * out.transfers + doubt;
      return out;
    }

    // ---------- Horarios de una parada (datos publicados de Vitrasa) ----------
    // Pasos programados por la parada s (índice) en un tipo de día (bit de dayBit): uno por viaje,
    // con la hora en segundos desde la medianoche (puede pasar de 24 h en viajes de madrugada).
    // No cuenta la parada en la que termina el recorrido: ahí no se puede subir.
    function stopPasses(s, bit) {
      const out = [];
      for (const [n, k] of at[s]) {
        const pt = pats[n];
        if (k === pt.p.length - 1) continue;
        for (let q = 0; q < pt.dep.length; q++) {
          if (pt.mask[q] & bit) out.push({ pat: n, line: pt.l, dir: pt.s, f: pt.f, t: pt.dep[q] + pt.t[k] * pt.dur[q] });
        }
      }
      return out.sort((a, b) => a.t - b.t);
    }
    // Próximos pasos por la parada s a partir de "time" (Date), como mucho "horizon" segundos
    // después (y "back" segundos antes); "at" en segundos desde la medianoche del día de "time".
    function upcoming(s, time = new Date(), horizon = 3 * 3600, back = 60) {
      const base = new Date(time.getFullYear(), time.getMonth(), time.getDate());
      const now = (time - base) / 1000;
      const trips = tripsFor(time);
      const out = [];
      for (const [n, k] of at[s]) {
        const pt = pats[n];
        if (k === pt.p.length - 1) continue;
        const tr = trips(pt);
        for (let q = 0; q < tr.dep.length; q++) {
          const a = tr.dep[q] + pt.t[k] * tr.dur[q];
          if (a >= now - back && a <= now + horizon) out.push({ pat: n, line: pt.l, dir: pt.s, f: pt.f, at: a });
        }
      }
      return out.sort((a, b) => a.at - b.at);
    }

    // ¿Lleva a la parada de bajada un bus en vivo con este letrero, que pasa por la de subida a la
    // hora "when" (Date)? Se miran los viajes del horario de esa línea y sentido con ese letrero que
    // pasan por la subida a esa hora (±20 min): si todos llegan a la bajada, sí; si ninguno, no; si
    // unos sí y otros no, no se sabe cuál es ("mixed": la web usa entonces el horario). Sin viajes a
    // esa hora, solo por el letrero.
    // Devuelve "yes", "no", "mixed" o "unknown" (letrero que no aparece en el horario).
    const normTxt = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
    // Ventana para emparejar un bus en vivo con los viajes del horario. Amplia a propósito: un bus
    // retrasado puede parecerse en hora al viaje siguiente, así que no se desempata por la hora más
    // cercana (probado: con retrasos de 6 min o más aceptaría buses que no llegan). Con ±20 min no
    // se acepta ninguno malo con retrasos de hasta 20 min; se pierde el dato en vivo en ~4 % de las
    // situaciones con un letrero ambiguo (se usa el horario).
    const MATCH_WINDOW = 1200;
    const goes = (pt, board, alight) => { const a = pt.p.indexOf(board); return a >= 0 && pt.p.indexOf(alight, a + 1) > a; };
    function liveReaches(leg, ruta, when) {
      const r = normTxt(ruta);
      const mine = (pt) => pt.l === leg.line && pt.s === leg.dir && pt.h && pt.h.some((x) => normTxt(x) === r);
      const near = upcoming(leg.board, when, MATCH_WINDOW, MATCH_WINDOW).filter((x) => mine(pats[x.pat]));
      if (near.length) {
        const ok = near.map((x) => goes(pats[x.pat], leg.board, leg.alight));
        return ok.every(Boolean) ? "yes" : ok.some(Boolean) ? "mixed" : "no";
      }
      const all = pats.filter((pt) => mine(pt) && pt.p.includes(leg.board));
      if (!all.length) return pats.some(mine) ? "no" : "unknown";
      const ok = all.map((pt) => goes(pt, leg.board, leg.alight));
      return ok.every(Boolean) ? "yes" : ok.some(Boolean) ? "mixed" : "no";
    }

    return { ids, index, pats, at, transfers, search, retime, choose, stopPasses, upcoming, liveReaches, fecha: data.fecha, WALK };
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
