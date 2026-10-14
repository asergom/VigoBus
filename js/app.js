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

  // ---------- Idioma ----------
  const I18N = window.PV_I18N;
  const LANG_KEY = "pv:idioma";
  function pickLang() {
    try { const saved = localStorage.getItem(LANG_KEY); if (saved && I18N.dict[saved]) return saved; } catch { /* sin almacenamiento */ }
    const nav = (navigator.languages || [navigator.language || "es"]).map((l) => l.slice(0, 2).toLowerCase());
    return nav.find((l) => I18N.dict[l]) || "es";
  }
  let lang = pickLang();
  function t(key, params = {}) {
    const str = (I18N.dict[lang] && I18N.dict[lang][key]) || I18N.dict.es[key] || key;
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ""));
  }
  const flagSvg = (code) => I18N.langs.find((l) => l.code === code).flag;

  // ---------- Utilidades ----------
  const panel = document.getElementById("panel");
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
    return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(m / 1000)} km`;
  }
  const walkMin = (m) => Math.max(1, Math.round(m / 75)); // ~4,5 km/h

  const LOWER = new Set(["por", "de", "do", "da", "dos", "das", "del", "e", "y", "o", "a", "en"]);
  function titleCase(s) {
    return s.replace(/\s+/g, " ").trim().toLowerCase().split(" ")
      .map((w, i) => (i > 0 && LOWER.has(w)) ? w : w.replace(/^(\(?)(\p{L})/u, (_, p, c) => p + c.toUpperCase()))
      .join(" ");
  }

  // Polilínea codificada (algoritmo de Google, precisión 5).
  function decodePolyline(str) {
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

  // Chapa de línea con su color oficial (si se conoce).
  function lineStyle(code) {
    const l = lines && lines[code];
    return l ? ` style="--lc:${l.color};--lt:${l.texto}"` : "";
  }
  function lineChip(code, cls = "chip") {
    const tappable = lines && lines[code];
    const tag = tappable ? "button" : "i";
    const attrs = tappable ? ` type="button" data-line="${esc(code)}" aria-label="${esc(t("see_line", { code }))}"` : "";
    return `<${tag} class="${cls}"${attrs}${lineStyle(code)}>${esc(code)}</${tag}>`;
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
  let lines = null;               // data/lineas.json: recorrido y paradas de cada línea
  let active = null;              // línea iluminada: { code, dir }

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
    setTimeout(() => toast(t("file_warning")), 800);
  }

  const css = getComputedStyle(document.documentElement);
  const RED = css.getPropertyValue("--bus").trim() || "#D3202F";
  const INK = css.getPropertyValue("--ink").trim() || "#13222C";
  const renderer = L.canvas({ padding: 0.3, tolerance: 6 });

  // Icono de parada (señal con un autobús). Rojo normal, azul ría en favoritas
  // y, con una línea elegida, del color oficial de esa línea.
  const stopSvg = (bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="${bg}" stroke="#fff" stroke-width="2.5"/><g fill="${fg}"><path d="M10.2 7.5h11.6a2.7 2.7 0 0 1 2.7 2.7v11.3a1.6 1.6 0 0 1-1.6 1.6H9.1a1.6 1.6 0 0 1-1.6-1.6V10.2a2.7 2.7 0 0 1 2.7-2.7z"/><rect x="9.6" y="23" width="3.2" height="2.6" rx="1"/><rect x="19.2" y="23" width="3.2" height="2.6" rx="1"/></g><g fill="${bg}"><rect x="9.8" y="10.4" width="12.4" height="5.6" rx="1.2"/><rect x="12.5" y="8.3" width="7" height="1.2" rx=".6"/><circle cx="11.2" cy="19.4" r="1.3"/><circle cx="20.8" cy="19.4" r="1.3"/></g></svg>`;
  const sizeFor = (z) => (z <= 12 ? 12 : z === 13 ? 16 : z === 14 ? 20 : z === 15 ? 26 : 30);
  const iconCache = new Map();
  function iconFor(s, z) {
    let bg = "#D3202F", fg = "#FFFFFF";
    const l = active && lines && lines[active.code];
    if (l && active.stops.has(s.id)) { bg = l.color; fg = l.texto; }
    else if (favs.includes(s.id)) bg = "#13222C";
    const size = sizeFor(z) + (l && active.stops.has(s.id) ? 4 : 0), k = `${bg}|${fg}|${size}`;
    if (!iconCache.has(k)) {
      iconCache.set(k, L.icon({
        iconUrl: `data:image/svg+xml,${encodeURIComponent(stopSvg(bg, fg))}`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: "stop-icon",
      }));
    }
    return iconCache.get(k);
  }
  const refreshIcon = (s) => s.marker.setIcon(iconFor(s, map.getZoom()));
  const lineGroup = L.layerGroup().addTo(map);

  const selRing = L.circleMarker(VIGO, { renderer, radius: 22, weight: 3, color: RED, fill: false, interactive: false });
  let meMarker = null;

  map.on("zoomend", () => {
    const z = map.getZoom();
    stops.forEach((s) => s.marker.setIcon(iconFor(s, z)));
    selRing.setRadius(sizeFor(z) / 2 + 7);
  });
  map.on("moveend", () => { if (mode === "near" && !me && !current && !active) renderNear(); });

  // Centra un punto en la zona del mapa que no tapa el panel.
  function focusOn(ll, zoom) {
    const z = Math.max(zoom || map.getZoom(), 16);
    const p = map.project(ll, z);
    const panel = $("#panel");
    // En móvil se usa la altura final del panel, no la de mitad de animación.
    const st = panel.dataset.state;
    const h = st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : st === "min" ? 92 : Math.max(260, innerHeight * 0.46);
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
        s.marker = L.marker(s.ll, { icon: iconFor(s, map.getZoom()), keyboard: false, alt: s.name })
          .on("click", () => navigate(s.id, { replace: !!current }))
          .addTo(map);
        if (canHover) s.marker.bindTooltip(() => `${esc(s.name)} (${esc(s.id)})`, { direction: "top", offset: [0, -6] });
        byId.set(s.id, s);
        return s;
      });
      // Encuadre inicial: el centro de Vigo, donde está la mayoría de paradas.
      map.setView(VIGO, 14);
      route();
    })
    .catch(() => {
      $("#list-note").textContent = t("stops_error");
    });

  fetch("data/lineas.json")
    .then((r) => r.json())
    .then((d) => {
      lines = d;
      // Con las líneas ya cargadas: abrir un enlace #linea/… o dar color a las chapas visibles.
      if (location.hash.startsWith("#linea/")) route();
      else if (current) $("#stop-lines").innerHTML = current.lines.map((l) => lineChip(l)).join("");
      else render();
    })
    .catch(() => { lines = {}; });

  // ---------- Lista ----------
  function stopItem(s, extra) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-id="${esc(s.id)}">
      <span class="name">${extra.nameHtml || esc(s.name)}</span>
      <span class="sub">${esc(t("stop_n", { id: s.id }))}${extra.sub ? ` · ${esc(extra.sub)}` : ""}</span>
      ${s.lines.length && !extra.noLines ? `<span class="lines">${s.lines.map((l) => `<i${lineStyle(l)}>${esc(l)}</i>`).join("")}</span>` : ""}
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
      const items = nearest(me, NEAR_COUNT).map(({ s, d }) => stopItem(s, { dist: d, sub: t("walk", { n: walkMin(d) }) }));
      fillList(items, "");
    } else {
      const c = map.getCenter();
      const items = nearest([c.lat, c.lng], NEAR_COUNT).map(({ s }) => stopItem(s, {}));
      const p = document.createElement("span");
      p.append(`${t("area_note")} `);
      const b = document.createElement("button");
      b.type = "button"; b.textContent = t("use_location");
      b.onclick = locate;
      p.append(b);
      fillList(items, p);
    }
  }

  function renderFav() {
    const list = favs.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) {
      fillList([], t("no_favs"));
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
    // Líneas: por código ("18" → 18A, 18B, 18H; "c3" → C3d, C3i) o por nombre ("hospital").
    const compact = nq.replace(/ /g, "");
    const lineRes = !lines ? [] : Object.keys(lines).filter((code) => {
      const c = norm(code).replace(/ /g, "");
      return c === compact || (compact.length >= 1 && c.startsWith(compact) && /\d|^[a-z]{1,3}$/.test(compact)) ||
        (tokens.length && tokens.every((tk) => norm(lines[code].nombre).includes(tk)) && compact.length >= 3);
    });
    const shown = res.slice(0, 60);
    const items = [];
    if (lineRes.length) {
      items.push(groupHead(t("res_lines")));
      lineRes.forEach((code) => items.push(lineItem(code, highlight(lines[code].nombre, tokens))));
      if (shown.length) items.push(groupHead(t("res_stops")));
    }
    shown.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), dist: me ? haversine(me, s.ll) : null })));
    fillList(items,
      res.length || lineRes.length ? (res.length > shown.length ? t("many", { n: res.length }) : "") : t("no_results", { q }));
  }

  function lineItem(code, nameHtml) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-line="${esc(code)}" class="line-row">
      <span class="badge"${lineStyle(code)}>${esc(code)}</span>
      <span class="name">${nameHtml || esc(lines[code].nombre)}</span>
    </button>`;
    return li;
  }
  function groupHead(text) {
    const li = document.createElement("li");
    li.className = "group-head";
    li.textContent = text;
    return li;
  }

  function renderLines() {
    if (!lines) { fillList([], t("loading_lines")); return; }
    const items = Object.keys(lines).map((code) => lineItem(code));
    fillList(items, items.length ? "" : t("lines_error"));
  }

  const TABS = ["near", "fav", "lines"];
  function render() {
    const q = $("#q").value.trim();
    if (q) { mode = "search"; renderSearch(q); return; }
    if (mode === "search") mode = TABS.find((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true") || "near";
    if (mode === "fav") renderFav();
    else if (mode === "lines") renderLines();
    else renderNear();
  }

  function setTab(which) {
    TABS.forEach((t) => $(`#tab-${t}`).setAttribute("aria-selected", t === which));
    mode = which;
    render();
  }

  // ---------- Ubicación ----------
  function locate() {
    if (!("geolocation" in navigator)) { toast(t("geo_unsupported")); return; }
    const btn = $("#locate");
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("busy");
        me = [pos.coords.latitude, pos.coords.longitude];
        const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] });
        if (meMarker) meMarker.setLatLng(me); else meMarker = L.marker(me, { icon, interactive: false, keyboard: false }).addTo(map);
        if (location.hash) navigate("");
        $("#q").value = "";
        setTab("near");
        if (haversine(me, VIGO) > 25000) {
          toast(t("geo_far"));
          const [n] = nearest(me, 1);
          if (n) focusOn(n.s.ll, 14);
        } else {
          focusOn(me, 16);
        }
      },
      (err) => {
        btn.classList.remove("busy");
        toast(err.code === 1 ? t("geo_denied") : t("geo_error"));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // ---------- Navegación ----------
  // El estado vive en la dirección: "" inicio, "#5660" parada, "#linea/18A" línea.
  // Así el botón Atrás del móvil y los enlaces compartidos funcionan solos.
  function navigate(hash, { replace = false } = {}) {
    const url = hash ? `#${hash}` : location.pathname + location.search;
    if (replace || !hash) history.replaceState({ d: 0 }, "", url);
    else history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, "", url);
    route();
  }
  function goBack() {
    if (history.state && history.state.d > 0) history.back();   // popstate llama a route()
    else navigate(current && active ? `linea/${active.code}` : "", { replace: true });
  }
  function route() {
    if (!stops.length) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith("linea/")) {
      const code = h.slice(6);
      if (!lines) return;                      // se reintenta al cargar las líneas
      if (lines[code]) { showLine(code); return; }
      toast(t("no_line", { code }));
    } else if (h && byId.has(h)) {
      showStop(h); return;
    } else if (h) {
      toast(t("no_stop", { id: h }));
    }
    showHome();
  }
  addEventListener("popstate", route);

  function showView(id) {
    ["home", "line", "stop"].forEach((v) => ($(`#${v}`).hidden = v !== id));
  }

  function leaveStop() {
    if (!current) return;
    current = null;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    selRing.remove();
  }

  function showHome() {
    leaveStop();
    clearLine();
    showView("home");
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = "peek";
    document.title = "Próximo Vitrasa";
    render();
  }

  // ---------- Línea iluminada ----------
  function clearLine() {
    if (!active) return;
    const was = active.stops;
    active = null;
    lineGroup.clearLayers();
    stops.forEach((s) => { s.marker.setOpacity(1).setZIndexOffset(0); if (was.has(s.id)) refreshIcon(s); });
  }

  function drawLine() {
    const l = lines[active.code];
    lineGroup.clearLayers();
    stops.forEach((s) => {
      const on = active.stops.has(s.id);
      s.marker.setOpacity(on ? 1 : 0.12).setZIndexOffset(on ? 500 : 0);
      if (on) refreshIcon(s);
    });
    // Primero el sentido no elegido (más tenue) y encima el elegido, con borde para verse en cualquier fondo.
    const order = l.sentidos.map((d, i) => i).sort((a, b) => (a === active.dir) - (b === active.dir));
    order.forEach((i) => {
      const pts = decodePolyline(l.sentidos[i].trazado);
      const main = i === active.dir;
      L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: main ? 0.35 : 0.15, interactive: false }).addTo(lineGroup);
      L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: main ? 1 : 0.6, interactive: false }).addTo(lineGroup);
      L.polyline(pts, { renderer, color: l.color, weight: 6, opacity: main ? 1 : 0.45, interactive: false,
        dashArray: main ? null : "2 9", lineCap: "round" }).addTo(lineGroup);
    });
  }

  function fitLine() {
    const l = lines[active.code];
    const pts = l.sentidos.flatMap((d) => decodePolyline(d.trazado));
    const r = panel.getBoundingClientRect();
    const opts = isDesktop()
      ? { paddingTopLeft: [r.right + 24, 24], paddingBottomRight: [24, 24] }
      : { paddingTopLeft: [16, 16], paddingBottomRight: [16, Math.max(260, innerHeight * 0.46) + 16] };
    map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom: 16 });
  }

  function showLine(code) {
    leaveStop();
    const changed = !active || active.code !== code;
    if (changed) {
      clearLine();
      active = { code, dir: 0, stops: new Set(lines[code].sentidos.flatMap((d) => d.paradas)) };
    }
    const l = lines[code];
    showView("line");
    const badge = $("#line-badge");
    badge.textContent = code;
    badge.style.setProperty("--lc", l.color);
    badge.style.setProperty("--lt", l.texto);
    $("#line-name").textContent = l.nombre;
    $("#line-dirs").hidden = l.sentidos.length < 2;
    $("#line-dirs").innerHTML = l.sentidos.map((d, i) =>
      `<button role="tab" type="button" data-dir="${i}" aria-selected="${i === active.dir}">${esc(t("towards", { dest: d.destino }))}</button>`).join("");
    renderLineStops();
    document.title = `${t("line_n", { code })} · Próximo Vitrasa`;
    if (!isDesktop()) panel.dataset.state = "peek";
    drawLine();
    if (changed) fitLine();
  }

  function renderLineStops() {
    const l = lines[active.code];
    const ids = l.sentidos[active.dir].paradas;
    const list = $("#line-stops");
    list.style.setProperty("--lc", l.color);
    list.replaceChildren(...ids.map((id) => byId.get(id)).filter(Boolean).map((s) =>
      stopItem(s, { dist: me ? haversine(me, s.ll) : null, noLines: true })));
    $("#line-stops").scrollTop = 0;
  }

  // ---------- Ficha de parada ----------
  function showStop(id) {
    const s = byId.get(id);
    if (current !== s) leaveStop();
    current = s;
    showView("stop");
    $("#stop-name").textContent = s.name;
    $("#stop-id").innerHTML = esc(t("stop_n", { id: "\u0000" })).replace("\u0000", `<strong>${esc(s.id)}</strong>`);
    $("#stop-lines").innerHTML = s.lines.map((l) => lineChip(l)).join("");
    $("#stop-dist").textContent = me ? ` · ${fmtDist(haversine(me, s.ll))}, ${t("walk", { n: walkMin(haversine(me, s.ll)) })}` : "";
    $("#infobus").href = INFOBUS_URL(s.id);
    updateFavBtn();
    document.title = `${s.name} · Próximo Vitrasa`;
    if (!isDesktop()) panel.dataset.state = "stop";
    selRing.setLatLng(s.ll).addTo(map);
    focusOn(s.ll);
    loadArrivals(true);
  }

  function updateFavBtn() {
    const on = current && favs.includes(current.id);
    const b = $("#fav");
    b.setAttribute("aria-pressed", !!on);
    b.setAttribute("aria-label", on ? t("fav_remove") : t("fav_add"));
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
    if (first) { box.innerHTML = skeleton(); lastUpdate = null; showUpdated(); }
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const url = `${API_URL}?id=${encodeURIComponent(s.id)}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA`;
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      // La API puede responder en Latin-1 sin avisar: si no es UTF-8 válido, se lee como Windows-1252
      // para que las tildes y la ñ no salgan como "�".
      const buf = await r.arrayBuffer();
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch { text = new TextDecoder("windows-1252").decode(buf); }
      const data = JSON.parse(text);
      if (seq !== reqSeq) return;
      // El nombre oficial sustituye a los genéricos tipo "Parada 1234".
      const official = data.parada && data.parada[0] && data.parada[0].nombre;
      if (official && /^Parada \d/.test(s.name)) $("#stop-name").textContent = titleCase(official);
      renderArrivals(data.estimaciones || []);
      lastUpdate = new Date();
      showUpdated();
    } catch (e) {
      if (seq !== reqSeq) return;
      lastArrivals = null;
      box.innerHTML = `<div class="state"><strong>${esc(t("times_error"))}</strong>
        ${esc(t("times_error_body", { infobus: "\u0000" })).replace("\u0000",
          `<a href="${INFOBUS_URL(s.id)}" target="_blank" rel="noopener">Infobus</a>`)}</div>`;
      lastUpdate = null;
      showUpdated();
    } finally {
      clearTimeout(timeout);
    }
    if (seq === reqSeq && current === s) refreshTimer = setTimeout(() => { if (!document.hidden) loadArrivals(false); }, REFRESH_MS);
  }

  let lastUpdate = null;
  let lastArrivals = null;          // para volver a pintar al cambiar de idioma
  function showUpdated() {
    $("#updated").textContent = lastUpdate
      ? t("updated", { time: lastUpdate.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }) : "";
  }

  function renderArrivals(list) {
    lastArrivals = list;
    const box = $("#arrivals");
    if (!list.length) {
      box.innerHTML = `<div class="state"><strong>${esc(t("empty"))}</strong> ${esc(t("empty_body"))}</div>`;
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
      const eta = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                         : `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
      const next = g.mins[1] != null ? `<small>${esc(t("next", { n: g.mins[1] }))}</small>` : "";
      return `<div class="arrival">
        ${lineChip(g.linea, "badge")}
        <span class="route"><b>${esc(g.ruta)}</b>${next}</span>
        ${eta}
      </div>`;
    }).join("");
  }

  // ---------- Eventos ----------
  // Paradas y líneas se abren desde cualquier lista o chapa del panel.
  $("#panel").addEventListener("click", (e) => {
    const stop = e.target.closest("button[data-id]");
    if (stop) { $("#q").blur(); navigate(stop.dataset.id); return; }
    const line = e.target.closest("button[data-line]");
    if (line) { $("#q").blur(); navigate(`linea/${line.dataset.line}`); return; }
    const dir = e.target.closest("button[data-dir]");
    if (dir && active) {
      active.dir = Number(dir.dataset.dir);
      $("#line-dirs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === dir));
      renderLineStops();
      drawLine();
    }
  });
  $("#back").addEventListener("click", goBack);
  $("#line-back").addEventListener("click", goBack);
  $("#fav").addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    saveFavs();
    updateFavBtn();
    refreshIcon(current);
    toast(favs.includes(id) ? t("fav_added") : t("fav_removed"));
  });
  $("#refresh").addEventListener("click", () => loadArrivals(false));
  $("#tab-near").addEventListener("click", () => setTab("near"));
  $("#tab-fav").addEventListener("click", () => setTab("fav"));
  $("#tab-lines").addEventListener("click", () => setTab("lines"));
  $("#locate").addEventListener("click", locate);

  let qTimer;
  $("#q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (location.hash) navigate(""); else render(); }, 120);
  });
  $("#q").addEventListener("focus", () => { if (!isDesktop()) $("#panel").dataset.state = "full"; });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = $("#list button[data-id]"); if (first) first.click(); }
    if (e.key === "Escape") { e.target.value = ""; render(); }
  });

  // Hoja inferior (móvil): deslizar hacia abajo la reduce hasta dejar casi todo el mapa a la vista;
  // hacia arriba la amplía. Tocar el asa alterna entre minimizada y normal.
  const baseState = () => (current ? "stop" : "peek");
  function setPanel(state) {
    if (isDesktop()) return;
    panel.dataset.state = state;
    if (state !== "full") $("#q").blur();
  }
  $("#grip").addEventListener("click", () => setPanel(panel.dataset.state === "min" ? baseState() : "min"));
  let y0 = null, t0 = 0;
  panel.addEventListener("touchstart", (e) => {
    // Solo desde la cabecera del panel, para no interferir con el desplazamiento de las listas.
    if (!e.target.closest(".grip, .brand, .stop-head, .tabs, .dirs, .stop-foot")) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  panel.addEventListener("touchend", (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (Math.abs(dy) < 30 || Date.now() - t0 > 800) return;
    const st = panel.dataset.state;
    if (dy > 0) setPanel(st === "full" ? baseState() : "min");
    else setPanel(st === "min" ? baseState() : "full");
  });
  // Tocar la cabecera con el panel minimizado lo vuelve a abrir.
  panel.addEventListener("click", (e) => {
    if (panel.dataset.state === "min" && !e.target.closest(".lang, .grip")) setPanel(baseState());
  }, true);
  panel.addEventListener("transitionend", () => map.invalidateSize());

  document.addEventListener("visibilitychange", () => { if (!document.hidden && current) loadArrivals(false); });

  // ---------- Idioma: textos fijos y desplegable con banderas ----------
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $("#lang-btn .flag").innerHTML = flagSvg(lang);
    $("#lang-code").textContent = lang.toUpperCase();
    $("#lang-menu").innerHTML = I18N.langs.map((l) =>
      `<li role="option" aria-selected="${l.code === lang}"><button type="button" data-lang="${l.code}" lang="${l.code}">
        <svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${l.flag}</svg><span>${esc(l.name)}</span></button></li>`).join("");
  }
  function toggleLangMenu(open) {
    const menu = $("#lang-menu");
    const show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    $("#lang-btn").setAttribute("aria-expanded", show);
    if (show) (menu.querySelector('[aria-selected="true"] button') || menu.querySelector("button")).focus();
  }
  function setLang(code) {
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch { /* sin almacenamiento */ }
    applyStatic();
    // Volver a pintar lo que está a la vista con el idioma nuevo.
    if (current) {
      showStop(current.id);
      if (lastArrivals) renderArrivals(lastArrivals);
    } else if (active) showLine(active.code);
    else render();
  }
  $("#lang-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleLangMenu(); });
  $("#lang-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    toggleLangMenu(false);
    $("#lang-btn").focus();
    if (b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".lang")) toggleLangMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#lang-menu").hidden) { toggleLangMenu(false); $("#lang-btn").focus(); }
  });
  applyStatic();

  // ---------- App instalable ----------
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
