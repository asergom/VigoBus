/* Próximo Vitrasa: posición estimada del próximo bus sobre el trazado de su línea.
   La API del Concello da, para cada bus que se acerca a una parada, los metros que le faltan.
   Posición del bus = distancia de la parada a lo largo del trazado − esos metros.
   También funciona en Node (module.exports) para las pruebas. */
(function (root) {
  "use strict";

  const KLAT = 110540;                 // metros por grado de latitud (aprox.)
  const NEAR = 50;                     // una parada se considera "sobre" el trazado a menos de esto (m)

  function decode(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  // Trazado preparado: puntos, coordenadas planas en metros y distancia acumulada.
  function prepare(pts) {
    const klon = KLAT * Math.cos((pts[0][0] * Math.PI) / 180);
    const xy = pts.map(([la, lo]) => [lo * klon, la * KLAT]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return { pts, xy, cum, klon, length: cum[cum.length - 1] };
  }

  // Proyección de un punto sobre el tramo i: distancia al trazado y distancia recorrida hasta él.
  function projSeg(sh, i, p) {
    const [ax, ay] = sh.xy[i], [bx, by] = sh.xy[i + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)) : 0;
    const off = Math.hypot(ax + u * dx - p[0], ay + u * dy - p[1]);
    return { off, along: sh.cum[i] + u * Math.sqrt(L2), seg: i };
  }

  // Proyección desde el tramo "from" en adelante: la primera pasada cercana (<NEAR m) y, dentro
  // de ella, el punto más próximo. Así, en recorridos que pasan dos veces por el mismo sitio
  // (circulares, ida y vuelta por la misma calle) se toma la pasada que toca según el orden.
  function project(sh, ll, from = 0) {
    const p = [ll[1] * sh.klon, ll[0] * KLAT];
    let best = null, firstNear = null;
    for (let i = from; i < sh.xy.length - 1; i++) {
      const r = projSeg(sh, i, p);
      if (!best || r.off < best.off) best = r;
      if (r.off < NEAR) {
        if (!firstNear || r.off < firstNear.off) firstNear = r;
      } else if (firstNear) break;              // fin de la primera pasada cercana
    }
    return firstNear || best;
  }

  // Distancia a lo largo del trazado de cada parada de la lista, en su orden.
  function stopsAlong(sh, lls) {
    let seg = 0, prev = 0;
    return lls.map((ll) => {
      const r = project(sh, ll, seg);
      seg = r.seg;
      r.along = prev = Math.max(prev, r.along);   // nunca hacia atrás (paradas casi juntas)
      return r;
    });
  }

  // Punto del trazado a una distancia dada, con el rumbo (grados desde el norte, en sentido horario).
  function pointAt(sh, d) {
    const { cum, pts, xy } = sh;
    d = Math.max(0, Math.min(sh.length, d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const L = cum[hi] - cum[lo], u = L ? (d - cum[lo]) / L : 0;
    const ll = [pts[lo][0] + u * (pts[hi][0] - pts[lo][0]), pts[lo][1] + u * (pts[hi][1] - pts[lo][1])];
    const bearing = (Math.atan2(xy[hi][0] - xy[lo][0], xy[hi][1] - xy[lo][1]) * 180) / Math.PI;
    return { ll, bearing: (bearing + 360) % 360 };
  }

  // Trazado y distancia de la parada para un sentido de una línea.
  // dir: { paradas, trazado, otras, ramales }; llOf(id) → [lat, lon].
  // Si la parada está en el recorrido principal se recorren sus paradas en orden hasta ella
  // (la última vez que aparece, por si el recorrido es circular); si solo la atiende un ramal,
  // se usa el ramal que pasa más cerca.
  function locateStop(dir, stopId, llOf) {
    const k = dir.paradas.lastIndexOf(stopId);
    if (k >= 0) {
      const sh = prepare(decode(dir.trazado));
      const res = stopsAlong(sh, dir.paradas.slice(0, k + 1).map(llOf));
      // Circular (empieza y acaba en la misma parada): un bus que aún no llegó a la cabecera
      // está terminando la vuelta anterior por este mismo trazado.
      const circular = dir.paradas.length > 2 && dir.paradas[0] === dir.paradas[dir.paradas.length - 1];
      return { shape: sh, along: res[k].along, off: res[k].off, branch: -1, circular };
    }
    let out = null;
    (dir.ramales || []).forEach((r, i) => {
      const sh = prepare(decode(r));
      const p = project(sh, llOf(stopId));
      if (!out || p.off < out.off) out = { shape: sh, along: p.along, off: p.off, branch: i };
    });
    return out;
  }

  // Estado del bus a partir de un dato de la API ({minutos, metros}), "min" minutos después de recibirlo.
  // Devuelve { state: "route", d, ll, bearing } o { state: "depot" } si aún no ha salido de cabecera.
  function busAt(loc, est, min = 0) {
    const metros = Number(est.metros), minutos = Number(est.minutos);
    if (!isFinite(metros) || metros < 0) return null;
    const len = loc.shape.length;
    // Más metros que el recorrido hasta la parada: el bus aún está terminando su viaje anterior
    // (en una circular, la vuelta anterior, que sí se puede dibujar).
    const wrap = loc.circular && metros <= loc.along + len;
    if (metros > loc.along + 30 && !wrap) return { state: "depot" };
    const speed = minutos > 0 ? metros / minutos : 0;            // m/min
    const left = Math.max(0, metros - speed * min);
    let d = loc.along - left;
    d = wrap && d < 0 ? d + len : Math.max(0, d);
    return { state: "route", d, left, ...pointAt(loc.shape, d) };
  }

  const api = { decode, prepare, project, stopsAlong, pointAt, locateStop, busAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PV_BUS = api;
})(typeof window !== "undefined" ? window : this);
