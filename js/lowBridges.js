import { UI } from "./ui.js";
import { BridgesStore } from "./bridgesStore.js";
import { debounce, escapeHtml } from "./utils.js";

let __bridgeMap = null;
let __bridgeLayer = null;
let __userLayer = null;
let __bridges = [];
let __selected = null; // bridge id

function hasLeaflet(){
  return typeof window !== "undefined" && typeof window.L !== "undefined";
}

function normalizeStr(s){
  return (s||"").toString().trim().toLowerCase();
}

function parseMaxheight(raw){
  const s = (raw||"").toString().trim();
  if(!s) return { raw:"", m:null, ft:null, inch:null };
  // Common patterns:
  // "4.2 m", "4.2m", "13'6"", "13 ft 6 in", "13-6", "13' 6"
  let m = null, ft = null, inch = null;

  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*m\b/i);
  if(mMatch){
    m = parseFloat(mMatch[1]);
  }

  const ftInMatch = s.match(/(\d+)\s*(?:ft|')\s*(\d+)?\s*(?:in|\")?/i);
  if(ftInMatch){
    ft = parseInt(ftInMatch[1],10);
    inch = ftInMatch[2] ? parseInt(ftInMatch[2],10) : 0;
  } else {
    // "13-6"
    const dash = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if(dash){
      ft = parseInt(dash[1],10);
      inch = parseInt(dash[2],10);
    }
  }

  if(m==null && ft!=null){
    m = ((ft*12 + (inch||0)) * 0.0254);
  }
  if(m!=null && ft==null){
    const totalIn = m / 0.0254;
    ft = Math.floor(totalIn/12);
    inch = Math.round(totalIn - ft*12);
  }

  return { raw:s, m: (m!=null && isFinite(m)) ? Math.round(m*100)/100 : null, ft, inch };
}

function heightLabel(b){
  if(b?.height_m!=null) return `${b.height_m} m`;
  if(b?.height_ft!=null) return `${b.height_ft}'${String(b.height_in||0).padStart(2,"0")}"`;
  if(b?.maxheight_raw) return b.maxheight_raw;
  return "Height unknown";
}

function bridgeIconHtml(b){
  const h = heightLabel(b);
  return `
    <div class="bridge-marker">
      <div class="bridge-marker-top"></div>
      <div class="bridge-marker-label">${h}</div>
    </div>
  `;
}

function makeBridgeIcon(b){
  return L.divIcon({
    className:"",
    html: bridgeIconHtml(b),
    iconSize:[46,46],
    iconAnchor:[23,46],
    popupAnchor:[0,-44]
  });
}

async function ensureSeedLoaded(){
  try{
    const c = await BridgesStore.count();
    if(c>0) return;
    const res = await fetch("assets/data/low_bridges.seed.json", { cache:"no-store" });
    if(!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data?.bridges) ? data.bridges : [];
    if(list.length) await BridgesStore.putMany(list);
  }catch(_e){}
}

function destroyMap(){
  try{
    if(__bridgeMap){
      __bridgeMap.remove();
      __bridgeMap = null;
    }
  }catch(_e){}
  __bridgeLayer = null;
  __userLayer = null;
}

function fitToUK(){
  if(!__bridgeMap) return;
  __bridgeMap.fitBounds([[49.8,-8.6],[60.9,1.9]]);
}

function initUserLocation(){
  if(!__bridgeMap || !__userLayer) return;
  if(!navigator.geolocation) return;

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

  let marker = null;
  let last = null;
  let follow = false;

  const btn = document.getElementById("bridgesCentreMe");
  if(btn){
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      follow = true;
      try{
        const pos = await new Promise((resolve,reject)=>{
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:12000, maximumAge:5000 });
        });
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        __bridgeMap.flyTo([lat,lng], Math.max(__bridgeMap.getZoom(), 14), { duration:0.8 });
      }catch(err){
        UI.showToast("Location not available", "danger");
      }
    };
  }

  navigator.geolocation.watchPosition((pos)=>{
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const heading = (pos.coords.heading != null && isFinite(pos.coords.heading)) ? pos.coords.heading : null;

    last = {lat,lng,heading};
    if(!marker){
      marker = L.marker([lat,lng], { icon:userLocationIcon, interactive:false }).addTo(__userLayer);
    }else{
      marker.setLatLng([lat,lng]);
    }
    // rotate heading arrow
    try{
      const el = marker.getElement()?.querySelector(".user-location-heading");
      if(el && heading!=null) el.style.transform = `rotate(${heading}deg)`;
    }catch(_e){}
    if(follow){
      __bridgeMap.panTo([lat,lng], { animate:true, duration:0.6 });
    }
  }, ()=>{}, { enableHighAccuracy:true, maximumAge:4000, timeout:20000 });
}

function clearBridgeLayer(){
  if(__bridgeLayer) __bridgeLayer.clearLayers();
}

function renderBridgesOnMap(list){
  if(!__bridgeMap || !__bridgeLayer) return;
  clearBridgeLayer();
  for(const b of list){
    if(typeof b.lat !== "number" || typeof b.lng !== "number") continue;
    const m = L.marker([b.lat,b.lng], { icon: makeBridgeIcon(b) });
    const html = `
      <div style="min-width:220px">
        <div style="font-weight:700;margin-bottom:.25rem">${escapeHtml(b.name||"Low bridge")}</div>
        <div class="small muted">${escapeHtml(b.road||"")}</div>
        <div style="margin-top:.35rem"><b>Max height:</b> ${escapeHtml(heightLabel(b))}</div>
        ${b.maxheight_raw && b.height_m==null ? `<div class="small muted">Raw: ${escapeHtml(b.maxheight_raw)}</div>` : ""}
        <div class="small muted" style="margin-top:.35rem">Source: ${escapeHtml(b.source||"")}</div>
      </div>
    `;
    m.bindPopup(html);
    __bridgeLayer.addLayer(m);
  }
}

function renderList(list){
  const box = document.getElementById("bridgesList");
  const countEl = document.getElementById("bridgesCount");
  if(countEl) countEl.textContent = `${list.length} bridge${list.length===1?"":"s"}`;
  if(!box) return;
  if(!list.length){
    box.innerHTML = `<div class="muted" style="padding:.75rem 0">No bridges found. Try searching or load from OSM.</div>`;
    return;
  }
  box.innerHTML = list.slice(0, 200).map(b => `
    <button class="bridge-row" data-id="${escapeHtml(b.id)}">
      <div class="bridge-row-main">
        <div class="bridge-row-title">${escapeHtml(b.name || "Low bridge")}</div>
        <div class="bridge-row-sub">${escapeHtml([b.road, heightLabel(b)].filter(Boolean).join(" • "))}</div>
      </div>
      <div class="bridge-row-chip">${escapeHtml(heightLabel(b))}</div>
    </button>
  `).join("");

  box.querySelectorAll(".bridge-row").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.preventDefault();
      const id = btn.getAttribute("data-id");
      const b = list.find(x=>x.id===id);
      if(!b || !__bridgeMap) return;
      __bridgeMap.flyTo([b.lat,b.lng], Math.max(__bridgeMap.getZoom(), 15), { duration:0.7 });
    });
  });
}

function applyFilter(){
  const q = normalizeStr(document.getElementById("bridgesSearch")?.value);
  let list = __bridges.slice();
  if(q){
    list = list.filter(b=>{
      const hay = normalizeStr([b.name,b.road,b.maxheight_raw,b.height_m,b.height_ft,b.height_in].join(" "));
      return hay.includes(q);
    });
  }
  renderList(list);
  renderBridgesOnMap(list);
}

async function loadAllBridges(){
  await ensureSeedLoaded();
  __bridges = await BridgesStore.getAll();
  // sort by updated desc
  __bridges.sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0));
  applyFilter();
}

async function fetchOverpassByBounds(bounds){
  const b = bounds; // Leaflet LatLngBounds
  const s = b.getSouth(); const w = b.getWest(); const n = b.getNorth(); const e = b.getEast();
  const query = `
[out:json][timeout:25];
(
  node["maxheight"](${s},${w},${n},${e});
  way["maxheight"](${s},${w},${n},${e});
);
out center tags;
  `.trim();
  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, {
    method:"POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if(!res.ok) throw new Error("Overpass failed ("+res.status+")");
  return await res.json();
}

function overpassToBridges(data){
  const els = Array.isArray(data?.elements) ? data.elements : [];
  const out = [];
  const now = Date.now();
  for(const el of els){
    const id = `osm:${el.type}:${el.id}`;
    const tags = el.tags || {};
    const raw = tags.maxheight || "";
    if(!raw) continue;
    const parsed = parseMaxheight(raw);
    const lat = (el.type==="node") ? el.lat : (el.center?.lat);
    const lng = (el.type==="node") ? el.lon : (el.center?.lon);
    if(typeof lat !== "number" || typeof lng !== "number") continue;

    // Basic "bridge-ish" name
    const name = tags.name || tags["bridge:name"] || tags["tunnel:name"] || "Low bridge";
    const road = tags.ref || tags["addr:street"] || tags.highway || tags["bridge:ref"] || "";

    out.push({
      id,
      name,
      road,
      lat,
      lng,
      maxheight_raw: parsed.raw,
      height_m: parsed.m,
      height_ft: parsed.ft,
      height_in: parsed.inch,
      source: "OSM/Overpass",
      updatedAt: now
    });
  }
  return out;
}

async function loadFromOsmInView(){
  if(!__bridgeMap) return;
  const status = document.getElementById("bridgesStatus");
  try{
    if(status) status.textContent = "Loading from OSM…";
    const data = await fetchOverpassByBounds(__bridgeMap.getBounds());
    const items = overpassToBridges(data);
    if(!items.length){
      if(status) status.textContent = "No maxheight bridges found in this view.";
      return;
    }
    await BridgesStore.putMany(items);
    await loadAllBridges();
    if(status) status.textContent = `Added/updated ${items.length} bridges from OSM.`;
  }catch(err){
    console.warn(err);
    if(status) status.textContent = "OSM load failed. Try zooming in and retry.";
    UI.showToast("OSM load failed (try smaller area)", "danger");
  }
}

function initMap(){
  const mapEl = document.getElementById("bridgesMap");
  if(!mapEl) return;

  if(!hasLeaflet()){
    mapEl.innerHTML = '<div style="padding:1rem">Map unavailable offline.</div>';
    return;
  }

  destroyMap();
  __bridgeMap = L.map(mapEl, { zoomControl:true }).setView([54.2,-2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(__bridgeMap);

  __bridgeLayer = L.layerGroup().addTo(__bridgeMap);
  __userLayer = L.layerGroup().addTo(__bridgeMap);
  initUserLocation();

  const btnUK = document.getElementById("bridgesCentreUK");
  if(btnUK){
    btnUK.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); fitToUK(); };
  }
  const btnOSM = document.getElementById("bridgesLoadOsm");
  if(btnOSM){
    btnOSM.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); loadFromOsmInView(); };
  }

  // prevent map click-through behind floating buttons
  // (Handled by CSS .mapFabWrap)
}

export const BRIDGES = {
  async render(){
    // UI
    const html = UI.card(`
      <div class="pageTitleRow">
        <div>
          <div class="h1">Low Bridges</div>
          <div class="small">UK low bridge restrictions (max height).</div>
        </div>
        <div class="row" style="gap:.5rem">
          <button id="bridgesCentreUK" class="btn">UK</button>
        </div>
      </div>

      <div class="card-soft" style="margin-top:1rem">
        <div class="cardHeader">
          <div>
            <div class="h2">Map</div>
            <div class="small muted">Tap a marker for details. Load maxheight bridges from OpenStreetMap in the current view.</div>
          </div>
          <div class="row" style="gap:.5rem">
            <button id="bridgesLoadOsm" class="btn">Load in view</button>
          </div>
        </div>

        <div class="mapWrap">
          <div id="bridgesMap" class="mapCanvas"></div>

          <div class="mapFabWrap" aria-hidden="false">
            <button id="bridgesCentreMe" class="mapFab" title="Centre on me" aria-label="Centre on me">
              <span class="mapFabIcon">⦿</span>
            </button>
          </div>
        </div>

        <div style="padding:.75rem 1rem">
          <div id="bridgesStatus" class="small muted">Ready.</div>
        </div>
      </div>

      <div class="card-soft bridgesSearchCard" style="margin-top:1rem">
        <div class="cardHeader">
          <div>
            <div class="h2">Bridges</div>
            <div class="small muted">Search by road, place name, postcode, or height.</div>
          </div>
          <div class="small" id="bridgesCount">0 bridges</div>
        </div>

        <div style="padding:0 1rem 1rem 1rem">
          <div class="row" style="gap:.75rem; align-items:stretch">
            <input id="bridgesSearch" class="input" placeholder="Search road, town, postcode, height…" style="flex:1" />
            <button id="bridgesClear" class="btn">Clear</button>
          </div>

          <div id="bridgesList" class="bridgesList" style="margin-top:1rem"></div>
        </div>
      </div>
    `);

    // mount
    setTimeout(async ()=>{
      initMap();
      await loadAllBridges();

      const s = document.getElementById("bridgesSearch");
      if(s){
        s.addEventListener("input", debounce(applyFilter, 150));
      }
      const c = document.getElementById("bridgesClear");
      if(c){
        c.addEventListener("click",(e)=>{
          e.preventDefault();
          if(s) s.value = "";
          applyFilter();
        });
      }
    }, 0);

    return html;
  }
};
