/* Próximo Vitrasa: rutas a pie con la red peatonal propia (data/peatonal.json).
   Sin servicios externos: la red se descarga una vez y la ruta se calcula en el propio dispositivo.
   Red: © colaboradores de OpenStreetMap, licencia ODbL. */
(function (root) {
  "use strict";

  const KLAT = 110540;                 // metros por grado de latitud (aprox.)
  const CELL = 0.002;                  // tamaño de celda del índice espacial, en grados (~200 m)
  const MAX_SNAP = 600;                // más lejos de una calle no se considera dentro de la red (m)
  // Al elegir la ruta, las pistas y sendas de tierra cuentan algo más largas de lo que son,
  // para preferir calles y aceras si el rodeo es pequeño. La distancia mostrada es la real.
  const FACTOR = [1, 1, 1.25];        // por tipo: normal, escaleras, sin asfaltar

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function decodePolyline(str, out) {
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lng += d;
      }
      out.push(lat / 1e5, lng / 1e5);
    }
  }

  // Montículo binario de mínimos sobre (coste, nodo).
  function Heap(cap) {
    let keys = new Float64Array(cap), vals = new Int32Array(cap), n = 0;
    return {
      get size() { return n; },
      push(k, v) {
        if (n === keys.length) {
          const k2 = new Float64Array(n * 2); k2.set(keys); keys = k2;
          const v2 = new Int32Array(n * 2); v2.set(vals); vals = v2;
        }
        let i = n++;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (keys[p] <= k) break;
          keys[i] = keys[p]; vals[i] = vals[p]; i = p;
        }
        keys[i] = k; vals[i] = v;
      },
      pop() {
        const top = vals[0];
        const k = keys[--n], v = vals[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && keys[c + 1] < keys[c]) c++;
          if (keys[c] >= k) break;
          keys[i] = keys[c]; vals[i] = vals[c]; i = c;
        }
        keys[i] = k; vals[i] = v;
        return top;
      },
    };
  }

  function build(data) {
    // Cruces
    const N = data.nodos.length / 2;
    const nlat = new Float64Array(N), nlon = new Float64Array(N);
    let la = 0, lo = 0;
    for (let i = 0; i < N; i++) {
      la += data.nodos[2 * i]; lo += data.nodos[2 * i + 1];
      nlat[i] = la / 1e5; nlon[i] = lo / 1e5;
    }
    // Tramos: extremos, longitud y forma completa (incluidos los extremos).
    const E = data.aristas.length / 4;
    const ea = new Int32Array(E), eb = new Int32Array(E), elen = new Float64Array(E), etype = new Uint8Array(E);
    const eoff = new Int32Array(E + 1);
    const pts = [];
    for (let e = 0; e < E; e++) {
      const a = data.aristas[4 * e], b = data.aristas[4 * e + 1];
      ea[e] = a; eb[e] = b; elen[e] = data.aristas[4 * e + 2] / 10; etype[e] = data.aristas[4 * e + 3];
      eoff[e] = pts.length / 2;
      pts.push(nlat[a], nlon[a]);
      if (data.formas[e]) decodePolyline(data.formas[e], pts);
      pts.push(nlat[b], nlon[b]);
    }
    eoff[E] = pts.length / 2;
    const P = Float64Array.from(pts);

    // Adyacencia compacta: para cada cruce, sus tramos.
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(2 * E), fill = deg.slice(0, N);
    for (let e = 0; e < E; e++) { adj[fill[ea[e]]++] = e; adj[fill[eb[e]]++] = e; }

    // Índice espacial: qué tramos pasan por cada celda.
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (let i = 0; i < P.length; i += 2) {
      if (P[i] < minLat) minLat = P[i]; if (P[i] > maxLat) maxLat = P[i];
      if (P[i + 1] < minLon) minLon = P[i + 1]; if (P[i + 1] > maxLon) maxLon = P[i + 1];
    }
    const GW = Math.ceil((maxLon - minLon) / CELL) + 1, GH = Math.ceil((maxLat - minLat) / CELL) + 1;
    const cells = new Map();
    for (let e = 0; e < E; e++) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let p = eoff[e]; p < eoff[e + 1]; p++) {
        const cx = Math.floor((P[2 * p + 1] - minLon) / CELL), cy = Math.floor((P[2 * p] - minLat) / CELL);
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      }
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = cy * GW + cx;
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(e);
      }
    }

    // Punto de la red más cercano: tramo, posición a lo largo de él y distancia.
    function snap(lat, lon) {
      const kx = 111320 * Math.cos(lat * Math.PI / 180);
      const cx = Math.floor((lon - minLon) / CELL), cy = Math.floor((lat - minLat) / CELL);
      const ringM = CELL * Math.min(KLAT, kx);
      let best = null, bestD = Infinity;
      const seen = new Set();
      for (let r = 0; r < 6; r++) {
        if (best && bestD < (r - 1) * ringM) break;
        for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || x < 0 || y < 0 || x >= GW || y >= GH) continue;
          const l = cells.get(y * GW + x);
          if (!l) continue;
          for (const e of l) {
            if (seen.has(e)) continue;
            seen.add(e);
            for (let p = eoff[e]; p < eoff[e + 1] - 1; p++) {
              const ax = (P[2 * p + 1] - lon) * kx, ay = (P[2 * p] - lat) * KLAT;
              const bx = (P[2 * p + 3] - lon) * kx, by = (P[2 * p + 2] - lat) * KLAT;
              const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
              const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
              const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(qx, qy);
              if (d < bestD) { bestD = d; best = { e, p, t }; }
            }
          }
        }
      }
      if (!best || bestD > MAX_SNAP) return null;
      // Fracción recorrida del tramo según su forma, aplicada a la longitud real.
      const { e, p, t } = best;
      let along = 0, total = 0;
      for (let q = eoff[e]; q < eoff[e + 1] - 1; q++) {
        const s = haversine(P[2 * q], P[2 * q + 1], P[2 * q + 2], P[2 * q + 3]);
        if (q < p) along += s; else if (q === p) along += s * t;
        total += s;
      }
      const f = total ? along / total : 0;
      const slat = P[2 * p] + t * (P[2 * p + 2] - P[2 * p]), slon = P[2 * p + 1] + t * (P[2 * p + 3] - P[2 * p + 1]);
      return { e, p, t, ll: [slat, slon], off: bestD, da: f * elen[e], db: (1 - f) * elen[e] };
    }

    // Forma del tramo e desde el cruce "from", opcionalmente recortada.
    function edgeCoords(e, fromA) {
      const out = [];
      for (let q = eoff[e]; q < eoff[e + 1]; q++) out.push([P[2 * q], P[2 * q + 1]]);
      return fromA ? out : out.reverse();
    }
    // Trozo de forma entre el punto ajustado y uno de los extremos del tramo.
    function partial(s, toA) {
      const out = [s.ll];
      if (toA) for (let q = s.p; q >= eoff[s.e]; q--) out.push([P[2 * q], P[2 * q + 1]]);
      else for (let q = s.p + 1; q < eoff[s.e + 1]; q++) out.push([P[2 * q], P[2 * q + 1]]);
      return out;
    }

    const dist = new Float64Array(N).fill(Infinity);
    const prevE = new Int32Array(N);
    const touched = [];

    // Ruta más corta a pie entre dos puntos [lat, lon].
    function route(from, to) {
      const s = snap(from[0], from[1]), g = snap(to[0], to[1]);
      if (!s || !g) return null;
      for (const i of touched) dist[i] = Infinity;
      touched.length = 0;
      const tlat = g.ll[0], tlon = g.ll[1];
      const h = (i) => haversine(nlat[i], nlon[i], tlat, tlon);
      const goal = new Map([[ea[g.e], g.da], [eb[g.e], g.db]]);   // cruce → metros hasta el destino
      const heap = Heap(1024);
      const relax = (i, d, viaE) => {
        if (d < dist[i]) {
          if (dist[i] === Infinity) touched.push(i);
          dist[i] = d; prevE[i] = viaE; heap.push(d + h(i), i);
        }
      };
      const fs = FACTOR[etype[s.e]], fg = FACTOR[etype[g.e]];
      for (const k of goal.keys()) goal.set(k, goal.get(k) * fg);
      relax(ea[s.e], s.da * fs, -1);
      relax(eb[s.e], s.db * fs, -1);
      // Mismo tramo: ir directamente por él.
      let best = s.e === g.e ? Math.abs(s.da - g.da) * fs : Infinity, bestNode = -2;
      while (heap.size) {
        const u = heap.pop();
        const du = dist[u];
        if (du + h(u) >= best) break;
        if (goal.has(u) && du + goal.get(u) < best) { best = du + goal.get(u); bestNode = u; }
        for (let k = deg[u]; k < deg[u + 1]; k++) {
          const e = adj[k];
          const v = ea[e] === u ? eb[e] : ea[e];
          relax(v, du + elen[e] * FACTOR[etype[e]], e);
        }
      }
      if (best === Infinity) return null;

      // Reconstruir la geometría y la distancia real.
      let coords, real;
      if (bestNode === -2) {
        real = Math.abs(s.da - g.da);
        // Origen y destino en el mismo tramo.
        coords = [s.ll];
        const lo = s.da <= g.da ? s : g, hi = lo === s ? g : s;
        const mid = [];
        for (let q = lo.p + 1; q <= hi.p; q++) mid.push([P[2 * q], P[2 * q + 1]]);
        coords = [lo.ll, ...mid, hi.ll];
        if (lo !== s) coords.reverse();
      } else {
        const chain = [];
        let u = bestNode;
        real = 0;
        while (prevE[u] !== -1) {
          const e = prevE[u];
          const v = ea[e] === u ? eb[e] : ea[e];   // de v se llegó a u
          chain.push(edgeCoords(e, ea[e] === v));
          real += elen[e];
          u = v;
        }
        chain.reverse();
        real += u === ea[s.e] ? s.da : s.db;
        real += bestNode === ea[g.e] ? g.da : g.db;
        coords = partial(s, u === ea[s.e]);
        for (const c of chain) coords.push(...c.slice(1));
        const tail = partial(g, bestNode === ea[g.e]).reverse();
        coords.push(...tail.slice(1));
      }
      return {
        dist: real,              // metros por la red, de punto ajustado a punto ajustado
        coords,
        from: s.ll, to: g.ll,
        offFrom: s.off, offTo: g.off,   // metros desde el punto pedido hasta la calle más cercana
        explored: touched.length,
      };
    }

    return { route, snap, nodes: N, edges: E, fecha: data.fecha };
  }

  let pending = null;
  const api = {
    build,
    // Carga la red una sola vez, solo cuando hace falta.
    load(url = "data/peatonal.json") {
      if (!pending) pending = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(build)
        .catch((e) => { pending = null; throw e; });
      return pending;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PV_PEATON = api;
})(this);
