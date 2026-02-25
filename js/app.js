import { CONFIG } from "./config.js";
import { DB } from "./db.js";
import { UI } from "./ui.js";
import { NAV } from "./nav.js";
import { DEST } from "./destinations.js";
import { DEST_VIEW } from "./destinationView.js";
import { SUBMIT } from "./submit.js";
import { ADMIN } from "./admin.js";
import { AUTH } from "./auth.js";
import { SETTINGS } from "./settings.js";
import { debounce, escapeHtml } from "./utils.js";
import { LST } from "./lstRoutes.js";
import { BRIDGES } from "./lowBridges.js";
import { MediaStore } from "./mediaStore.js";

const ROUTES = {
  home: "home",
  destination: "destination",
  submit: "submit",
  admin: "admin",
  lst: "lst",
  bridges: "bridges",
  settings: "settings"
};

const state = {
  route: ROUTES.home,
  params: {}
};

function el(id){ return document.getElementById(id); }

function setRoute(route, params={}){
  // If we're leaving Admin, force-refresh destinations from localStorage so the
  // public Search reflects the latest edits immediately.
  if(state.route === ROUTES.admin && route !== ROUTES.admin){
    try{
      const latest = DB.getDestinations();
      if(Array.isArray(latest)) DEST.state.destinations = latest;
    }catch(_e){ /* ignore */ }
  }
  // auto logout if admin is closed
  if(state.route === ROUTES.admin && route !== ROUTES.admin && AUTH.isAdmin()){
    AUTH.logout();
  }
  state.route = route;
  state.params = params;
  NAV.setActive(route);
  render();
  // Keep simple history:
  const url = new URL(window.location.href);
  url.hash = route === ROUTES.destination ? `#destination/${params.id}` : `#${route}`;
  history.replaceState({}, "", url);
}

function parseHash(){
  const h = (location.hash || "").replace("#","");
  if(!h) return {route: ROUTES.home, params:{}};
  if(h.startsWith("destination/")){
    return {route: ROUTES.destination, params:{id: h.split("/")[1]}};
  }
  if(Object.values(ROUTES).includes(h)) return {route:h, params:{}};
  return {route: ROUTES.home, params:{}};
}

function renderHeader(){
  el("appTitle").textContent = CONFIG.APP_NAME;
  updateHeaderAction();
}

function updateHeaderAction(){
  const host = document.getElementById("headerAction");
  if(!host) return;
  host.innerHTML = "";
}



// === Leaflet favourites map ===
let __favMap = null;
let __favLayer = null;
let __userLayer = null;
let __geoWatchId = null;
let __followUser = false;
let __userMarker = null;
let __userCircle = null;
let __lastRawPos = null;
let __lastSmoothPos = null;
let __lastHeadingDeg = null;

function initFavMap(){
  const mapEl = document.getElementById("favMap");
  if(!mapEl) return;
  if(!window.L){
    mapEl.innerHTML = '<div class="small" style="padding:1rem">Map unavailable offline.</div>';
    return;
  }
  // Home view re-renders replace the map container. Recreate the Leaflet map
  // cleanly to avoid "Map container is already initialized" errors.
  if(__favMap){
    try{ __favMap.remove(); }catch(_e){ /* ignore */ }
    __favMap = null;
    __favLayer = null;
    __userLayer = null;
    if(__geoWatchId != null && navigator.geolocation){
      try{ navigator.geolocation.clearWatch(__geoWatchId); }catch(_e){ /* ignore */ }
    }
    __geoWatchId = null;
  }
  __favMap = L.map(mapEl, { zoomControl:true }).setView([54.2,-2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(__favMap);
  __favLayer = L.layerGroup().addTo(__favMap);
  __userLayer = L.layerGroup().addTo(__favMap);
  initUserLocation();
  refreshFavMap();
  const fitBtn = document.getElementById("fitFavMapBtn");
  if(fitBtn) fitBtn.onclick = () => fitFavMap();

  const locateBtn = document.getElementById("locateMeBtn");
  if(locateBtn){
    locateBtn.onclick = () => {
      // Toggle follow mode. When enabling, immediately center once.
      __followUser = !__followUser;
      locateBtn.classList.toggle("active", __followUser);
      if(__lastSmoothPos){
        __favMap.panTo([__lastSmoothPos.lat, __lastSmoothPos.lng], { animate:true, duration:0.6 });
        if(__favMap.getZoom() < 14) __favMap.setZoom(14);
      }
    };
  }
}

function initUserLocation(){
  if(!__favMap || !__userLayer) return;
  if(!navigator.geolocation) return;

  // Google/Apple-style blue dot with heading arrow.
  const userLocationIcon = L.divIcon({
    className: "",
    html: `
      <div class="user-location-marker">
        <div class="user-location-pulse"></div>
        <div class="user-location-dot"></div>
        <div class="user-location-heading" aria-hidden="true"></div>
      </div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function haversineMeters(a, b){
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const s1 = Math.sin(dLat/2);
    const s2 = Math.sin(dLng/2);
    const h = s1*s1 + Math.cos(lat1)*Math.cos(lat2)*s2*s2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingDeg(a, b){
    const φ1 = toRad(a.lat);
    const φ2 = toRad(b.lat);
    const λ1 = toRad(a.lng);
    const λ2 = toRad(b.lng);
    const y = Math.sin(λ2-λ1) * Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
    const θ = Math.atan2(y, x);
    return (toDeg(θ) + 360) % 360;
  }

  function applyHeading(deg){
    __lastHeadingDeg = deg;
    const el = __userMarker?._icon?.querySelector?.(".user-location-heading");
    if(el) el.style.transform = `rotate(${deg}deg)`;
  }

  function smoothPosition(raw){
    if(!__lastSmoothPos) return raw;

    const dist = haversineMeters(__lastSmoothPos, raw);
    const acc = Number.isFinite(raw.acc) ? raw.acc : 50;
    const prevAcc = __lastRawPos?.acc ?? acc;

    // reject tiny jitter when accuracy worsens
    if(dist < 6 && acc > prevAcc + 10) return __lastSmoothPos;

    // Alpha: 0.15 (smooth) .. 0.75 (snappy)
    const alpha = clamp(1 - (acc / 120), 0.15, 0.75);
    return {
      lat: __lastSmoothPos.lat + (raw.lat - __lastSmoothPos.lat) * alpha,
      lng: __lastSmoothPos.lng + (raw.lng - __lastSmoothPos.lng) * alpha,
      acc: raw.acc
    };
  }

  // Track previous smoothed position for bearing.
  let lastSmoothForBearing = null;

  const renderPos = (pos) => {
    const raw = {
      lat: Number(pos.coords.latitude),
      lng: Number(pos.coords.longitude),
      acc: Number(pos.coords.accuracy),
      heading: Number(pos.coords.heading),
      speed: Number(pos.coords.speed)
    };
    if(!Number.isFinite(raw.lat) || !Number.isFinite(raw.lng)) return;

    const sm = smoothPosition(raw);
    __lastRawPos = raw;
    __lastSmoothPos = { lat: sm.lat, lng: sm.lng };

    if(Number.isFinite(raw.acc) && raw.acc > 0){
      if(__userCircle){
        __userCircle.setLatLng([sm.lat, sm.lng]).setRadius(raw.acc);
      }else{
        __userCircle = L.circle([sm.lat, sm.lng], {
          radius: raw.acc,
          weight: 1,
          fillOpacity: 0.12
        }).addTo(__userLayer);
      }
    }

    if(__userMarker){
      __userMarker.setLatLng([sm.lat, sm.lng]);
    }else{
      __userMarker = L.marker([sm.lat, sm.lng], {
        keyboard:false,
        icon: userLocationIcon,
        zIndexOffset: 1000
      }).addTo(__userLayer);
      __userMarker.bindPopup(`<b>Your location</b><br>${sm.lat.toFixed(5)}, ${sm.lng.toFixed(5)}`);
    }

    // Heading arrow: prefer native; else derive from movement.
    const nativeHeading = Number.isFinite(raw.heading) ? raw.heading : null;
    let head = nativeHeading;
    if(head == null && lastSmoothForBearing && __lastSmoothPos){
      const moved = haversineMeters(lastSmoothForBearing, __lastSmoothPos);
      if(moved > 8) head = bearingDeg(lastSmoothForBearing, __lastSmoothPos);
    }
    if(head != null) applyHeading(head);
    lastSmoothForBearing = __lastSmoothPos;

    // Smooth camera follow mode.
    if(__followUser && __favMap && __lastSmoothPos){
      __favMap.panTo([__lastSmoothPos.lat, __lastSmoothPos.lng], { animate:true, duration:0.6 });
    }
  };

  // One-shot initial position
  navigator.geolocation.getCurrentPosition(
    renderPos,
    (_err) => { /* ignore if blocked/denied */ },
    { enableHighAccuracy:true, maximumAge:60_000, timeout:8_000 }
  );

  // Keep it updated while the map exists.
  __geoWatchId = navigator.geolocation.watchPosition(
    renderPos,
    (_err) => { /* ignore */ },
    { enableHighAccuracy:true, maximumAge:60_000, timeout:10_000 }
  );
}

function favPoints(){
  // Favourites are stored as destination ids.
  const ids = DB.getFavourites ? DB.getFavourites() : [];
  const favs = (Array.isArray(ids) ? ids : [])
    .map(id => DEST.getById(id))
    .filter(Boolean);
  return favs
    .map(d => ({
      d,
      lat: Number(d.latitude ?? d.lat),
      lng: Number(d.longitude ?? d.lng ?? d.lon)
    }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function refreshFavMap(){
  if(!__favMap || !__favLayer) return;
  __favLayer.clearLayers();
  const pts = favPoints();
  pts.forEach(({d,lat,lng})=>{
    const m=L.marker([lat,lng]).addTo(__favLayer);
    m.bindPopup(`<b>${escapeHtml(d.name||"Destination")}</b><br>${escapeHtml(d.address||"")}`);
  });
  // If there are no markers, default to a UK overview.
  if(!pts.length){
    __favMap.setView([54.2,-2.5], 6);
  }
}

function fitFavMap(){
  if(!__favMap) return;
  const pts=favPoints();
  if(!pts.length){ __favMap.setView([54.2,-2.5], 6); return; }
  const bounds=L.latLngBounds(pts.map(p=>[p.lat,p.lng]));
  __favMap.fitBounds(bounds.pad(0.25));
}

function renderHome(container){
  // local paging to keep UI fast with large datasets
  let limit = 10;

  const categories = ["All", ...Array.from(new Set(DEST.state.destinations.map(d=>d.category).filter(Boolean))).sort()];

  container.innerHTML = `
    <div class="hero">
      <!-- Search -->
      <div class="card" style="padding:1rem">
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap">
          <div>
            <div class="h1">Find a destination</div>
            <div class="small" style="margin-top:.25rem">Search RDCs, depots, yards — then open a destination to navigate.</div>
          </div>
          <button class="btn btn-primary" id="addBtn">+ Submit destination</button>
        </div>

        <div style="margin-top:1rem" class="searchBar">
          <input class="input" id="searchInput" placeholder="Search name, address, tags, postcode…">
          <button class="btn btn-ghost" id="clearBtn">Clear</button>
        </div>

        <div class="filterRow" style="margin-top:.8rem" id="catChips">
          ${categories.map(c=>`<button class="chip ${DEST.state.category===c?"active":""}" data-cat="${c}">${c}</button>`).join("")}
        </div>

        <!-- Results (inside Search card) -->
        <div style="margin-top:1rem" class="card-soft" id="resultsCard">
          <div style="padding: .9rem 1rem; display:flex; justify-content:space-between; gap:1rem; align-items:center; flex-wrap:wrap">
            <div class="h2">Results</div>
            <div class="small" id="resultsMeta"></div>
          </div>
          <div class="hr"></div>
          <div style="padding: .8rem; display:grid; gap:.6rem" id="results"></div>
          <div style="padding: .8rem; padding-top:0" id="resultsFooter"></div>
        </div>
      </div>

      <!-- Favourites -->
      <div style="margin-top:1rem" class="card-soft" id="favCard">
        <div style="padding: .9rem 1rem; display:flex; justify-content:space-between; gap:1rem; align-items:center; flex-wrap:wrap">
          <div>
            <div class="h2">Favourites</div>
            <div class="small" style="margin-top:.15rem">Save up to 5 destinations for quick access.</div>
          </div>
          <button class="btn btn-ghost" id="clearFavsBtn" title="Clear favourites">Clear</button>
        </div>
        <div class="hr"></div>
        <div style="padding: .8rem; display:grid; gap:.6rem" id="favsList"></div>
      </div>

      <!-- Map -->
      <div style="margin-top:1rem" class="card-soft" id="favMapCard">
        <div style="padding:.9rem 1rem; display:flex; justify-content:space-between; gap:1rem; align-items:center; flex-wrap:wrap">
          <div>
            <div class="h2">Map</div>
            <div class="small">Your favourites (markers shown where coordinates exist).</div>
          </div>
          <button class="btn btn-ghost" id="fitFavMapBtn">Centre</button>
        </div>
        <div class="hr"></div>
        <div style="padding:.8rem">
          <div class="favMapWrap">
            <div id="favMap" class="favMap"></div>
            <button class="locateFab" id="locateMeBtn" title="Locate me">
              <span class="locateFabIcon" aria-hidden="true">◎</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector("#addBtn").addEventListener("click", ()=>setRoute(ROUTES.submit));

  const searchInput = container.querySelector("#searchInput");
  searchInput.value = DEST.state.query;

  const resultsEl = container.querySelector("#results");
  const metaEl = container.querySelector("#resultsMeta");
  const resultsCardEl = container.querySelector("#resultsCard");
  const favsEl = container.querySelector("#favsList");
  const favCardEl = container.querySelector("#favCard");
  const clearFavsBtn = container.querySelector("#clearFavsBtn");

  function getFavIds(){
    // stored as array of destination ids
    const ids = DB.getFavourites();
    return Array.isArray(ids) ? ids : [];
  }
  function setFavIds(ids){
    const unique = [];
    for(const id of (ids||[])){
      if(!unique.includes(id)) unique.push(id);
      if(unique.length>=5) break;
    }
    DB.saveFavourites(unique);
  }
  function isFav(id){
    return getFavIds().includes(id);
  }
  function toggleFav(id){
    const ids = getFavIds();
    const idx = ids.indexOf(id);
    if(idx>=0){
      ids.splice(idx,1);
    }else{
      ids.unshift(id);
    }
    setFavIds(ids);
    renderFavs();
    renderResults(false); // refresh stars
    refreshFavMap();
  }

  function renderFavs(){
    const ids = getFavIds();
    const items = ids.map(id=>DEST.getById(id)).filter(Boolean);
    if(!items.length){
      favsEl.innerHTML = `<div class="small" style="opacity:.85">No favourites yet. Tap ☆ on a destination to save it.</div>`;
      favCardEl.style.display = "";
      clearFavsBtn.disabled = true;
      return;
    }
    clearFavsBtn.disabled = false;
    favsEl.innerHTML = items.map(d=>`
      <button class="listItem favItem" data-open="${d.id}" style="text-align:left">
        <div class="thumb">
          <img data-media="${(d.photos?.[0]?.url)||"assets/images/placeholders/entrance-1.png"}" src="assets/images/placeholders/entrance-1.png" alt="">
        </div>
        <div style="flex:1; min-width:0">
          <div style="font-weight:950; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${d.name}</div>
          <div class="small" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${d.address}</div>
        </div>
        <div class="listActions">
          <span class="favStar" data-fav="${d.id}" title="Remove favourite">★</span>
          <span style="margin-left:.35rem; color:var(--muted); font-weight:900">›</span>
        </div>
      </button>
    `).join("");

    MediaStore.hydrate(favsEl);

    // open handlers
    favsEl.querySelectorAll("[data-open]").forEach(btn=>{
      btn.addEventListener("click", ()=>setRoute(ROUTES.destination, {id: btn.dataset.open}));
    });
    // fav toggle handlers (remove)
    favsEl.querySelectorAll("[data-fav]").forEach(el=>{
      el.addEventListener("click", (e)=>{
        e.preventDefault(); e.stopPropagation();
        toggleFav(el.dataset.fav);
      });
    });
  }

  clearFavsBtn.addEventListener("click", ()=>{
    setFavIds([]);
    renderFavs();
    renderResults(false);
    refreshFavMap();
  });

  const footerEl = container.querySelector("#resultsFooter");

  function renderResults(resetLimit=false){
    if(resetLimit) limit = 10;

    // Only populate results when the user is actively searching.
    // When the search box is empty, keep the Results card visible with a prompt.
    const q = (DEST.state.query || "").trim();
    const isSearching = q.length > 0;
    if(!isSearching){
      resultsCardEl.style.display = "";
      metaEl.textContent = "";
      resultsEl.innerHTML = `<div class="small" style="padding: .6rem; opacity:.9">Search For Results</div>`;
      footerEl.innerHTML = "";
      return;
    }

    resultsCardEl.style.display = "";

    const all = DEST.list();
    const shown = all.slice(0, limit);

    // Always show the total results for the current search/category.
    // (Avoid "Showing X of Y" as requested.)
    metaEl.textContent = `${all.length} result${all.length===1?"":"s"}`;

    resultsEl.innerHTML = shown.map(d=>`
      <button class="listItem" data-open="${d.id}" style="text-align:left">
        <div class="thumb">
          <img data-media="${(d.photos?.[0]?.url)||"assets/images/placeholders/entrance-1.png"}" src="assets/images/placeholders/entrance-1.png" alt="">
        </div>
        <div style="flex:1; min-width:0">
          <div style="font-weight:950; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${d.name}</div>
          <div class="small" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${d.address}</div>
          <div style="display:flex; gap:.45rem; flex-wrap:wrap; margin-top:.4rem">
            <span class="badge">📍 ${d.category||"Destination"}</span>
            <span class="badge">🕒 ${d.hours||"Hours"}</span>
          </div>
        </div>
        <div class="listActions">
          <span class="favStar" data-fav="${d.id}" title="Favourite">${isFav(d.id) ? "★" : "☆"}</span>
          <span style="margin-left:.35rem; color:var(--muted); font-weight:900">›</span>
        </div>
      </button>
    `).join("") || `<div class="small" style="padding: .6rem">No results. Try a different search.</div>`;

    MediaStore.hydrate(resultsEl);

    // favourite toggles
    resultsEl.querySelectorAll("[data-fav]").forEach(el=>{
      el.addEventListener("click", (e)=>{
        e.preventDefault(); e.stopPropagation();
        toggleFav(el.dataset.fav);
      });
    });

    resultsEl.querySelectorAll("[data-open]").forEach(btn=>{
      btn.addEventListener("click", ()=>setRoute(ROUTES.destination, {id: btn.dataset.open}));
    });

    if(all.length > shown.length){
      footerEl.innerHTML = `<button class="btn btn-ghost" id="loadMoreBtn" style="width:100%">Load more</button>`;
      footerEl.querySelector("#loadMoreBtn").addEventListener("click", ()=>{
        limit += 10;
        renderResults(false);
      });
    }else{
      footerEl.innerHTML = "";
    }
  }

  const onSearch = debounce(()=>{
    DEST.state.query = searchInput.value;
    renderResults(true);
  }, 120);

  searchInput.addEventListener("input", onSearch);

  container.querySelector("#clearBtn").addEventListener("click", ()=>{
    DEST.state.query = "";
    DEST.state.category = "All";
    searchInput.value = "";
    container.querySelectorAll("[data-cat]").forEach(ch=>ch.classList.toggle("active", ch.dataset.cat==="All"));
    renderResults(true);
    searchInput.focus();
  });

  container.querySelectorAll("[data-cat]").forEach(ch=>{
    ch.addEventListener("click", ()=>{
      DEST.state.category = ch.dataset.cat;
      container.querySelectorAll("[data-cat]").forEach(b=>b.classList.toggle("active", b.dataset.cat===DEST.state.category));
      renderResults(true);
      if(document.activeElement === searchInput) searchInput.focus();
    });
  });

  renderFavs();
  renderResults(true);

  // Initialise the map once the DOM exists.
  initFavMap();
}

function render(){
  const view = el("view");
  if(state.route === ROUTES.home){
    renderHome(view);
  }else if(state.route === ROUTES.destination){
    DEST_VIEW.render(view, state.params);
  }else if(state.route === ROUTES.submit){
    SUBMIT.render(view);
  }else if(state.route === ROUTES.admin){
    ADMIN.render(view);
  }else if(state.route === ROUTES.lst){
    LST.render(view);
  }else if(state.route === ROUTES.bridges){
    view.innerHTML = "";
    BRIDGES.render().then((html)=>{ view.innerHTML = html; }).catch((e)=>{ console.error(e); view.innerHTML = UI.card(`<div class="h2">Low Bridges</div><div class="small muted">Failed to load.</div>`); });
  }else if(state.route === ROUTES.settings){
    SETTINGS.render(view);
  }
}

function initHiddenAdmin(){
  const brand = el("brand");
  // Logo: single tap -> Home
  brand.addEventListener("click", ()=>{
    setRoute(ROUTES.home);
  });

  // Bottom nav handling (no inline onclick in HTML)
  const navButtons = Array.from(document.querySelectorAll(".navBtn"));
  const settingsBtn = document.querySelector('.navBtn[data-route="settings"]');

  // Default nav: go to route
  navButtons.forEach(btn=>{
    const route = btn.dataset.route;
    if(route && route !== "settings"){
      btn.addEventListener("click", ()=>{
        setRoute(route);
      });
    }
  });

  // Secret admin: ONLY works when you're already on Settings.
  // Once on Settings, tap Settings 5 additional times quickly -> Admin login.
  if(!settingsBtn) return;

  let taps = [];
  settingsBtn.addEventListener("click", ()=>{
    if(state.route !== ROUTES.settings){
      taps = [];
      setRoute(ROUTES.settings);
      return;
    }

    const now = Date.now();
    const windowMs = CONFIG.ADMIN_TAP_TO_OPEN_MS || 2500;
    taps = taps.filter(t => now - t < windowMs);
    taps.push(now);

    if(taps.length >= 5){
      taps = [];
      setRoute(ROUTES.admin);
      return;
    }
    // stay on settings, no-op
  });
}


async function showLoadingThenStart(){
  const splash = el("splash");
  const shell = el("appShell");

  splash.classList.remove("hidden");
  shell.classList.add("hidden");

  // simulate minimum splash time
  const minMs = 900;
  const t0 = Date.now();

  try{
    await DEST.ensureLoaded();
    await AUTH.ensure();
  // Apply Driver Mode preference
  try{ const s = DB.getSettings() || {}; document.body.classList.toggle('driver-mode', !!s.driverMode); }catch(e){}

  }catch(err){
    console.error(err);
    UI.showToast("Could not load destinations data.", "danger", 3500);
  }

  const elapsed = Date.now()-t0;
  if(elapsed < minMs) await new Promise(r=>setTimeout(r, minMs - elapsed));

  splash.classList.add("hidden");
  shell.classList.remove("hidden");

  renderHeader();
  initHiddenAdmin();

  const parsed = parseHash();
  state.route = parsed.route;
  state.params = parsed.params;
  NAV.setActive(state.route);
  render();
}

window.addEventListener("hashchange", ()=>{
  const parsed = parseHash();
  setRoute(parsed.route, parsed.params);
});

// If admin edits destinations while the app is open, refresh the current view
// so searches immediately reflect the changes.
try{
  window.addEventListener('hgv:destinations-changed', () => {
    // Re-render current route; DEST cache is refreshed by destinations.js listener.
    render();
  });
}catch(_e){ /* ignore */ }

window.addEventListener("DOMContentLoaded", showLoadingThenStart);
