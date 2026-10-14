/* Próximo Vitrasa: mapa de paradas y próximos buses en Vigo. */
(() => {
  "use strict";

  // ---------- Configuración ----------
  // Tiempos en vivo: API de datos abiertos del Concello de Vigo.
  // Si el navegador la bloquea (CORS), se puede poner aquí la URL de un proxy
  // definiendo window.PV_API_URL antes de cargar este script.
  const API_URL = window.PV_API_URL || "https://datos.vigo.org/vci_api_app/api2.jsp";
  const INFOBUS_URL = (id) => `https://infobus.vitrasa.es:8002/Default.aspx?parada=${encodeURIComponent(id)}`;
  const REFRESH_MS = 30000;
  const NEAR_COUNT = 15;
  const FAV_KEY = "pv:favoritas";
  const VIGO = [42.2286, -8.7226];

  // ---------- Utilidades ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  const isDesktop = () => matchMedia("(min-width: 860px)").matches;
  const canHover = matchMedia("(hover: hover)").matches;

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  }
  const walkMin = (m) => Math.max(1, Math.round(m / 75)); // ~4,5 km/h

  const LOWER = new Set(["por", "de", "do", "da", "dos", "das", "del", "e", "y", "o", "a", "en"]);
  function titleCase(s) {
    return s.replace(/\s+/g, " ").trim().toLowerCase().split(" ")
      .map((w, i) => (i > 0 && LOWER.has(w)) ? w : w.replace(/^(\(?)(\p{L})/u, (_, p, c) => p + c.toUpperCase()))
      .join(" ");
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Estado ----------
  let stops = [];                 // {id, name, key, ll:[lat,lon], marker}
  const byId = new Map();
  let favs = loadFavs();
  let me = null;                  // [lat, lon] del usuario
  let mode = "near";              // near | fav | search
  let current = null;             // parada abierta
  let refreshTimer = null;
  let fetchCtl = null;
  let reqSeq = 0;                 // descarta respuestas de peticiones antiguas
  let pushed = false;             // si la ficha añadió una entrada al historial

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; }
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* sin almacenamiento */ }
  }

  // ---------- Mapa ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true })
    .setView(VIGO, 14);
  map.attributionControl.setPrefix(false);
  if (isDesktop()) L.control.zoom({ position: "topleft" }).addTo(map);

  // Mapa base de OpenStreetMap: gratuito y sin clave. En modo oscuro se oscurece con CSS.
  // OpenStreetMap exige saber desde qué web se piden los mapas (cabecera Referer).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">Colaboradores de OpenStreetMap</a>',
  }).addTo(map);

  // Abierta como archivo (file://) no hay web de origen y OpenStreetMap bloquea el mapa.
  if (location.protocol === "file:") {
    setTimeout(() => toast("Abre la web desde un servidor (por ejemplo, GitHub Pages) para que se vea el mapa."), 800);
  }

  const css = getComputedStyle(document.documentElement);
  const RED = css.getPropertyValue("--bus").trim() || "#D3202F";
  const INK = css.getPropertyValue("--ink").trim() || "#13222C";
  const renderer = L.canvas({ padding: 0.3, tolerance: 6 });

  // Icono de parada: tamaño según el zoom; las favoritas, en azul ría.
  const sizeFor = (z) => (z <= 12 ? 12 : z === 13 ? 16 : z === 14 ? 20 : z === 15 ? 26 : 30);
  const iconCache = new Map();
  function iconFor(s, z) {
    const fav = favs.includes(s.id), size = sizeFor(z), k = `${fav}|${size}`;
    if (!iconCache.has(k)) {
      iconCache.set(k, L.icon({
        iconUrl: fav ? "icons/parada-fav.svg" : "icons/parada.svg",
        iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: "stop-icon",
      }));
    }
    return iconCache.get(k);
  }
  const refreshIcon = (s) => s.marker.setIcon(iconFor(s, map.getZoom()));

  const selRing = L.circleMarker(VIGO, { renderer, radius: 22, weight: 3, color: RED, fill: false, interactive: false });
  let meMarker = null;

  map.on("zoomend", () => {
    const z = map.getZoom();
    stops.forEach((s) => s.marker.setIcon(iconFor(s, z)));
    selRing.setRadius(sizeFor(z) / 2 + 7);
  });
  map.on("moveend", () => { if (mode === "near" && !me && !current) renderNear(); });

  // Centra un punto en la zona del mapa que no tapa el panel.
  function focusOn(ll, zoom) {
    const z = Math.max(zoom || map.getZoom(), 16);
    const p = map.project(ll, z);
    const panel = $("#panel");
    // En móvil se usa la altura final del panel, no la de mitad de animación.
    const st = panel.dataset.state;
    const h = st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : Math.max(260, innerHeight * 0.46);
    const shift = isDesktop() ? L.point(-panel.getBoundingClientRect().right / 2, 0) : L.point(0, h / 2);
    map.setView(map.unproject(p.add(shift), z), z, { animate: true });
  }

  // ---------- Datos ----------
  fetch("data/paradas.geojson")
    .then((r) => r.json())
    .then((gj) => {
      stops = gj.features.map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const s = { id: f.properties.id, name: f.properties.nombre, lines: f.properties.lineas || [], ll: [lat, lon] };
        s.key = norm(`${s.name} ${s.id}`);
        s.marker = L.marker(s.ll, { icon: iconFor(s, map.getZoom()), keyboard: false, alt: `Parada ${s.id}` })
          .on("click", () => openStop(s.id))
          .addTo(map);
        if (canHover) s.marker.bindTooltip(() => `${esc(s.name)} (${esc(s.id)})`, { direction: "top", offset: [0, -6] });
        byId.set(s.id, s);
        return s;
      });
      if (!fromHash()) {
        // Encuadre inicial: el centro de Vigo, donde está la mayoría de paradas.
        map.setView(VIGO, 14);
        render();
      }
    })
    .catch(() => {
      $("#list-note").textContent = "No se pudieron cargar las paradas. Recarga la página para volver a intentarlo.";
    });

  // ---------- Lista ----------
  function stopItem(s, extra) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-id="${esc(s.id)}">
      <span class="name">${extra.nameHtml || esc(s.name)}</span>
      <span class="sub">Parada ${esc(s.id)}${extra.sub ? ` · ${esc(extra.sub)}` : ""}</span>
      ${s.lines.length ? `<span class="lines">${s.lines.map((l) => `<i>${esc(l)}</i>`).join("")}</span>` : ""}
      ${extra.dist != null ? `<span class="dist">${fmtDist(extra.dist)}</span>` : ""}
    </button>`;
    return li;
  }

  function fillList(items, note) {
    const ul = $("#list");
    ul.replaceChildren(...items);
    const n = $("#list-note");
    if (note instanceof Node) n.replaceChildren(note); else n.textContent = note || "";
  }

  function nearest(origin, n) {
    return stops.map((s) => ({ s, d: haversine(origin, s.ll) }))
      .sort((a, b) => a.d - b.d).slice(0, n);
  }

  function renderNear() {
    if (!stops.length) return;
    if (me) {
      const items = nearest(me, NEAR_COUNT).map(({ s, d }) => stopItem(s, { dist: d, sub: `${walkMin(d)} min andando` }));
      fillList(items, "");
    } else {
      const c = map.getCenter();
      const items = nearest([c.lat, c.lng], NEAR_COUNT).map(({ s }) => stopItem(s, {}));
      const p = document.createElement("span");
      p.append("Paradas en esta zona del mapa. ");
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Usar mi ubicación";
      b.onclick = locate;
      p.append(b);
      fillList(items, p);
    }
  }

  function renderFav() {
    const list = favs.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) {
      fillList([], "Aún no tienes favoritas. Abre una parada y toca la estrella para tenerla siempre a mano.");
      return;
    }
    fillList(list.map((s) => stopItem(s, { dist: me ? haversine(me, s.ll) : null })), "");
  }

  function highlight(name, tokens) {
    // Subraya las coincidencias sin tener en cuenta tildes.
    const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const ranges = [];
    tokens.forEach((t) => { const i = plain.indexOf(t); if (i >= 0) ranges.push([i, i + t.length]); });
    if (!ranges.length) return esc(name);
    ranges.sort((a, b) => b[0] - a[0]);
    const out = name;
    const parts = [];
    let end = out.length;
    ranges.forEach(([a, b]) => { if (b > end) return; parts.unshift(esc(out.slice(b, end))); parts.unshift(`<mark>${esc(out.slice(a, b))}</mark>`); end = a; });
    parts.unshift(esc(out.slice(0, end)));
    return parts.join("");
  }

  function renderSearch(q) {
    const nq = norm(q);
    const tokens = nq.split(" ").filter(Boolean);
    let res;
    if (/^\d+[a-z]?$/.test(nq)) {
      res = stops.filter((s) => s.id.toLowerCase().startsWith(nq))
        .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
    } else {
      res = stops.filter((s) => tokens.every((t) => s.key.includes(t)));
      res.sort((a, b) => (a.key.startsWith(tokens[0]) ? 0 : 1) - (b.key.startsWith(tokens[0]) ? 0 : 1) || a.name.localeCompare(b.name, "es"));
    }
    const shown = res.slice(0, 60);
    fillList(
      shown.map((s) => stopItem(s, { nameHtml: highlight(s.name, tokens), dist: me ? haversine(me, s.ll) : null })),
      res.length ? (res.length > shown.length ? `${res.length} paradas. Afina la búsqueda para ver menos.` : "") :
        `No hay paradas que coincidan con «${q}». Prueba con otra calle o con el número del poste.`
    );
  }

  function render() {
    const q = $("#q").value.trim();
    if (q) { mode = "search"; renderSearch(q); return; }
    if (mode === "search") mode = $("#tab-fav").getAttribute("aria-selected") === "true" ? "fav" : "near";
    mode === "fav" ? renderFav() : renderNear();
  }

  function setTab(which) {
    $("#tab-near").setAttribute("aria-selected", which === "near");
    $("#tab-fav").setAttribute("aria-selected", which === "fav");
    mode = which;
    render();
  }

  // ---------- Ubicación ----------
  function locate() {
    if (!("geolocation" in navigator)) { toast("Este navegador no permite obtener tu ubicación."); return; }
    const btn = $("#locate");
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("busy");
        me = [pos.coords.latitude, pos.coords.longitude];
        const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] });
        if (meMarker) meMarker.setLatLng(me); else meMarker = L.marker(me, { icon, interactive: false, keyboard: false }).addTo(map);
        if (current) { pushed = false; clearHash(); closeStop(); }
        $("#q").value = "";
        setTab("near");
        if (haversine(me, VIGO) > 25000) {
          toast("Estás lejos de Vigo. Estas son las paradas más cercanas a ti.");
          const [n] = nearest(me, 1);
          if (n) focusOn(n.s.ll, 14);
        } else {
          focusOn(me, 16);
        }
      },
      (err) => {
        btn.classList.remove("busy");
        toast(err.code === 1 ? "Permite el acceso a la ubicación en el navegador para ver las paradas cercanas."
                             : "No se pudo obtener tu ubicación. Inténtalo de nuevo.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // ---------- Ficha de parada ----------
  function openStop(id, { fromHashChange = false } = {}) {
    const s = byId.get(id);
    if (!s) { toast(`No existe la parada ${id} en el mapa.`); return; }
    if (!fromHashChange && location.hash !== `#${id}`) {
      // Volver atrás en el móvil cierra la ficha en vez de salir de la web.
      if (current) history.replaceState(null, "", `#${id}`);
      else { history.pushState(null, "", `#${id}`); pushed = true; }
    }
    current = s;
    $("#home").hidden = true;
    $("#stop").hidden = false;
    $("#stop-name").textContent = s.name;
    $("#stop-id").textContent = s.id;
    $("#stop-lines").innerHTML = s.lines.map((l) => `<i>${esc(l)}</i>`).join("");
    $("#stop-dist").textContent = me ? ` · ${fmtDist(haversine(me, s.ll))}, ${walkMin(haversine(me, s.ll))} min andando` : "";
    $("#infobus").href = INFOBUS_URL(s.id);
    updateFavBtn();
    document.title = `${s.name} · Próximo Vitrasa`;
    if (!isDesktop()) $("#panel").dataset.state = "stop";
    selRing.setLatLng(s.ll).addTo(map);
    focusOn(s.ll);
    loadArrivals(true);
  }

  function closeStop() {
    current = null;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    selRing.remove();
    $("#stop").hidden = true;
    $("#home").hidden = false;
    if ($("#panel").dataset.state === "stop") $("#panel").dataset.state = "peek";
    document.title = "Próximo Vitrasa";
    render();
  }

  function updateFavBtn() {
    const on = current && favs.includes(current.id);
    const b = $("#fav");
    b.setAttribute("aria-pressed", !!on);
    b.setAttribute("aria-label", on ? "Quitar de favoritas" : "Guardar en favoritas");
  }

  function skeleton() {
    return Array.from({ length: 4 }, () =>
      `<div class="arrival skeleton" aria-hidden="true"><span class="badge">00</span><span class="route"><b>&nbsp;</b></span><span class="eta"><b>00</b></span></div>`
    ).join("");
  }

  async function loadArrivals(first) {
    const s = current;
    if (!s) return;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    const ctl = (fetchCtl = new AbortController());
    const seq = ++reqSeq;
    const box = $("#arrivals");
    if (first) { box.innerHTML = skeleton(); $("#updated").textContent = ""; }
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const url = `${API_URL}?id=${encodeURIComponent(s.id)}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA`;
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      if (seq !== reqSeq) return;
      // El nombre oficial sustituye a los genéricos tipo "Parada 1234".
      const official = data.parada && data.parada[0] && data.parada[0].nombre;
      if (official && /^Parada \d/.test(s.name)) $("#stop-name").textContent = titleCase(official);
      renderArrivals(data.estimaciones || []);
      $("#updated").textContent = `Actualizado a las ${new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (e) {
      if (seq !== reqSeq) return;
      box.innerHTML = `<div class="state"><strong>No se pudieron cargar los tiempos.</strong>
        Comprueba la conexión y vuelve a intentarlo, o consulta la parada en
        <a href="${INFOBUS_URL(s.id)}" target="_blank" rel="noopener">Infobus</a>.</div>`;
      $("#updated").textContent = "";
    } finally {
      clearTimeout(timeout);
    }
    if (seq === reqSeq && current === s) refreshTimer = setTimeout(() => { if (!document.hidden) loadArrivals(false); }, REFRESH_MS);
  }

  function renderArrivals(list) {
    const box = $("#arrivals");
    if (!list.length) {
      box.innerHTML = `<div class="state"><strong>No hay buses previstos ahora mismo.</strong>
        Puede que ninguna línea pase por esta parada a esta hora.</div>`;
      return;
    }
    // Agrupa por línea y destino; muestra el próximo y el siguiente.
    const groups = new Map();
    list.forEach((b) => {
      const linea = String(b.linea).trim();
      const ruta = titleCase(String(b.ruta || ""));
      const k = `${linea}|${ruta}`;
      if (!groups.has(k)) groups.set(k, { linea, ruta, mins: [] });
      groups.get(k).mins.push(Number(b.minutos));
    });
    const rows = [...groups.values()]
      .map((g) => ({ ...g, mins: g.mins.filter((m) => !isNaN(m)).sort((a, b) => a - b) }))
      .filter((g) => g.mins.length)
      .sort((a, b) => a.mins[0] - b.mins[0]);

    box.innerHTML = rows.map((g) => {
      const m = g.mins[0];
      const eta = m <= 0 ? `<span class="eta now"><b>Llegando</b></span>`
                         : `<span class="eta"><b>${m}</b><span>min</span></span>`;
      const next = g.mins[1] != null ? `<small>Después, en ${g.mins[1]} min</small>` : "";
      return `<div class="arrival">
        <span class="badge" aria-label="Línea ${esc(g.linea)}">${esc(g.linea)}</span>
        <span class="route"><b>${esc(g.ruta)}</b>${next}</span>
        ${eta}
      </div>`;
    }).join("");
  }

  // ---------- Navegación por #parada ----------
  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && byId.has(id)) { openStop(id, { fromHashChange: true }); return true; }
    return false;
  }
  addEventListener("hashchange", () => { if (!fromHash() && current) { pushed = false; closeStop(); } });

  // ---------- Eventos ----------
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) { $("#q").blur(); openStop(b.dataset.id); }
  });
  const clearHash = () => history.replaceState(null, "", location.pathname + location.search);
  $("#back").addEventListener("click", () => {
    if (pushed) { pushed = false; history.back(); }   // el hashchange cierra la ficha
    else { clearHash(); closeStop(); }
  });
  $("#fav").addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    saveFavs();
    updateFavBtn();
    refreshIcon(current);
    toast(favs.includes(id) ? "Guardada en favoritas" : "Quitada de favoritas");
  });
  $("#refresh").addEventListener("click", () => loadArrivals(false));
  $("#tab-near").addEventListener("click", () => setTab("near"));
  $("#tab-fav").addEventListener("click", () => setTab("fav"));
  $("#locate").addEventListener("click", locate);

  let qTimer;
  $("#q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (current) { pushed = false; clearHash(); closeStop(); } else render(); }, 120);
  });
  $("#q").addEventListener("focus", () => { if (!isDesktop()) $("#panel").dataset.state = "full"; });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = $("#list button[data-id]"); if (first) first.click(); }
    if (e.key === "Escape") { e.target.value = ""; render(); }
  });

  // Hoja inferior: tocar o deslizar el asa la amplía o la reduce.
  const panel = $("#panel");
  $("#grip").addEventListener("click", () => {
    panel.dataset.state = panel.dataset.state === "full" ? (current ? "stop" : "peek") : "full";
  });
  let y0 = null;
  [$("#grip"), $(".brand")].forEach((el) => {
    el.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      if (dy < -30) panel.dataset.state = "full";
      if (dy > 30) { panel.dataset.state = current ? "stop" : "peek"; $("#q").blur(); }
      y0 = null;
    });
  });
  panel.addEventListener("transitionend", () => map.invalidateSize());

  document.addEventListener("visibilitychange", () => { if (!document.hidden && current) loadArrivals(false); });

  // ---------- App instalable ----------
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
