import { DB } from "./db.js";
import { UI } from "./ui.js";
import { AUTH } from "./auth.js";
import { DEST } from "./destinations.js";
import { MediaStore } from "./mediaStore.js";
import { LST_STORE, LST_UTILS } from "./lstRoutes.js";


function escapeHtml(s=""){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

// --- Gemini Vision (local API key mode) helpers for importing LST route sheets ---
const GEMINI_KEY_STORAGE = "hgv.geminiApiKey";

function dataUrlToBase64(dataUrl=""){
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx+1) : dataUrl;
}

function dataUrlToMime(dataUrl=""){
  const m = String(dataUrl).match(/^data:([^;]+);base64,/i);
  return m ? m[1].toLowerCase() : "image/png";
}

function readFileAsDataURL(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(String(r.result||""));
    r.onerror = ()=>reject(r.error || new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
}

function stripCodeFences(s=""){
  return String(s)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

async function geminiExtractRouteJSON({ apiKey, page1DataUrl, page2DataUrl }){
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
  const prompt = `You are extracting data from UK logistics "Route Plans and Risk Assessment" sheets.
Return STRICT JSON ONLY (no markdown, no commentary).

Output schema:
{
  "journeyStart": {"name": string, "postcode": string|null},
  "journeyFinish": {"name": string, "postcode": string|null},
  "segments": [
    {"road": string, "from": string, "to": string, "risk": "L"|"M"|"H"}
  ],
  "notes": string|null
}

Rules:
- The journey start/end MUST come from the "Route Details" table that contains "Journey Start Location" and "Journey End Location" (these include the location name and postcode).
- Postcodes should be normalized like "NN6 7GX" when present.
- "risk" must be only L/M/H.
- Preserve text like "3rd Exit onto A142 to A14 slip" in the "to" field.
- If a field isn't present, use null or empty string but still return valid JSON.`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inline_data: { mime_type: dataUrlToMime(page1DataUrl), data: dataUrlToBase64(page1DataUrl) } },
        { inline_data: { mime_type: dataUrlToMime(page2DataUrl), data: dataUrlToBase64(page2DataUrl) } }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  // Retry a few times on temporary quota/rate failures.
  let lastErr = null;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body)
      });

      if(!res.ok){
        const t = await res.text();
        // 429 / RESOURCE_EXHAUSTED is common; treat it as retryable.
        if(res.status === 429 || res.status === 503){
          lastErr = new Error(`Gemini API ${res.status}: ${t}`);
          const delay = Math.round((800 * Math.pow(2, attempt)) + Math.random()*250);
          await new Promise(r=>setTimeout(r, delay));
          continue;
        }
        throw new Error(`Gemini API error ${res.status}: ${t}`);
      }

      const json = await res.json();
      const text = (json?.candidates?.[0]?.content?.parts || []).map(p=>p.text||"").join("\n");
      return JSON.parse(stripCodeFences(text));
    }catch(err){
      lastErr = err;
      const delay = Math.round((800 * Math.pow(2, attempt)) + Math.random()*250);
      await new Promise(r=>setTimeout(r, delay));
    }
  }
  if(String(lastErr?.message||"").includes("429")){
    throw new Error("Gemini is rate-limiting this key right now (RESOURCE_EXHAUSTED). Wait 1–2 minutes and try again, or reduce batch size (e.g., import 1 route sheet at a time).\n\nTip: Importing lots of sheets quickly can hit quota.");
  }
  throw lastErr || new Error("Gemini request failed");
}

function normalizePostcode(pc){
  if(!pc) return "";
  const s = String(pc).toUpperCase().trim().replace(/\s+/g," ");
  // Best-effort UK postcode normalization
  const m = s.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/);
  return m ? `${m[1]} ${m[2]}` : s;
}

function makeRouteId(start="", end=""){
  const base = `${start} ${end}`.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,60);
  return base || `lst-${Date.now()}`;
}

const AVG_TIP_TIME_OPTIONS = [
  "10–15 mins","15–30 mins","30–45 mins","45–60 mins","1–2 hours","2–3 hours","3–4 hours","4+ hours"
];

const FACILITIES = [
  "Driver parking area","Restroom facilities","Gate Check-In Office","Showers","Canteen / food","Vending machines","Overnight parking","Weighbridge","Fuel station","Secure parking","Toilet access","Waiting room"
];

function slugify(name=""){
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/(^-|-$)/g,"")
    .slice(0,60) || `dest-${Date.now()}`;
}

function dataUrlToStoredAsset(dataUrl){
  // In a pure static app, we can't really upload.
  // For now we keep dataUrl in destination record so it "looks added" immediately.
  return dataUrl;
}

// --- LST route editor live map preview (Leaflet) ---
let __lstPrevMap = null;
let __lstPrevLayer = null;
let __lstPrevTimer = null;
let __lstPrevLastBounds = null;

// Pick-on-map target for coordinate overrides.
// { type: 'seg', rid, idx, key: 'from'|'to' } or { type:'route', rid, key:'start'|'end' }
let __lstPickTarget = null;

// Admin LST route editor: draw segments directly on the preview map
// We persist the toggle via ADMIN._state and store exact coordinate overrides
// (so admins don't have to fight ambiguous road labels).
let __lstDrawState = {
  enabled: false,
  routeId: null,
  risk: 'L',
  chain: false,
  snap: true,
  start: null, // {lat,lng}
  startMarker: null,
  tempLine: null,
  _snapTimer: null,
  _snapKey: null,
};

function destroyLstPreviewMap(){
  if(__lstPrevTimer){ clearTimeout(__lstPrevTimer); __lstPrevTimer = null; }
  if(__lstPrevMap){ try{ __lstPrevMap.remove(); }catch(_e){ /* ignore */ } }
  __lstPrevMap = null;
  __lstPrevLayer = null;
  __lstPrevLastBounds = null;
  // Clear any in-progress draw state
  __lstDrawState.start = null;
  __lstDrawState.startMarker = null;
  __lstDrawState.tempLine = null;
  if(__lstDrawState._snapTimer){ clearTimeout(__lstDrawState._snapTimer); __lstDrawState._snapTimer = null; }
  __lstDrawState._snapKey = null;
}

function ensureLstPreviewMap(container){
  const host = container.querySelector('#lstEditMap');
  if(!host) return null;
  // Recreate if host changed or map not initialised
  if(__lstPrevMap && __lstPrevMap._container === host) return __lstPrevMap;
  destroyLstPreviewMap();
  if(typeof window.L === 'undefined') return null;
  const L = window.L;
  __lstPrevMap = L.map(host, { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(__lstPrevMap);
  __lstPrevLayer = L.layerGroup().addTo(__lstPrevMap);
  // UK overview default
  __lstPrevMap.setView([54.5, -3.2], 6);

  // Attach draw handlers once per map instance
  attachLstDrawHandlers(__lstPrevMap, container);
  return __lstPrevMap;
}

function attachLstDrawHandlers(map, container){
  if(map.__lstDrawHandlersAttached) return;
  map.__lstDrawHandlersAttached = true;

  const L = window.L;

  const clearTemp = ()=>{
    if(__lstDrawState._snapTimer){ clearTimeout(__lstDrawState._snapTimer); __lstDrawState._snapTimer = null; }
    __lstDrawState._snapKey = null;
    if(__lstDrawState.startMarker){ try{ map.removeLayer(__lstDrawState.startMarker); }catch(_e){} }
    if(__lstDrawState.tempLine){ try{ map.removeLayer(__lstDrawState.tempLine); }catch(_e){} }
    __lstDrawState.startMarker = null;
    __lstDrawState.tempLine = null;
    __lstDrawState.start = null;
  };

  map.on('click', async (e)=>{
    // Pick-on-map for coordinate overrides (independent of draw mode)
    if(__lstPickTarget){
      const { lat, lng } = e.latlng;
      const routes = LST_STORE.get();
      if(__lstPickTarget.type === 'seg'){
        const r = routes.find(x=>x.id===__lstPickTarget.rid);
        const seg = r?.segments?.[__lstPickTarget.idx];
        if(seg){
          const key = __lstPickTarget.key;
          seg[`${key}Coords`] = { lat, lng };
          // If the label is empty, add a friendly pinned label.
          if(!String(seg?.[key]||'').trim()) seg[key] = `Pinned (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
          LST_STORE.save(routes);
          try{ window.dispatchEvent(new CustomEvent('hgv:lstRoutes-changed')); }catch(_e){}
          UI.showToast(`Pinned ${key.toUpperCase()} coordinates.`, 'ok');
          __lstPickTarget = null;
          try{ ADMIN.render(container); }catch(_e){}
          return;
        }
      }
      if(__lstPickTarget.type === 'route'){
        const r = routes.find(x=>x.id===__lstPickTarget.rid);
        if(r){
          const key = __lstPickTarget.key;
          r[`${key}Coords`] = { lat, lng };
          LST_STORE.save(routes);
          try{ window.dispatchEvent(new CustomEvent('hgv:lstRoutes-changed')); }catch(_e){}
          UI.showToast(`Pinned ${key === 'start' ? 'START' : 'END'} coordinates.`, 'ok');
          __lstPickTarget = null;
          try{ ADMIN.render(container); }catch(_e){}
          return;
        }
      }
      // If something went wrong, clear pick mode.
      __lstPickTarget = null;
    }

    if(!__lstDrawState.enabled) return;
    if(!__lstDrawState.routeId) return;
    const { lat, lng } = e.latlng;

    // First click sets start
    if(!__lstDrawState.start){
      __lstDrawState.start = { lat, lng };
      __lstDrawState.startMarker = L.circleMarker([lat, lng], {
        radius: 7,
        weight: 2,
        color: '#fff',
        fillColor: '#1a73e8',
        fillOpacity: 0.95
      }).addTo(map);
      setLstPreviewStatus(container, 'Draw mode: click an end point…');
      return;
    }

    // Second click creates segment (or next segment if chain mode)
    const from = __lstDrawState.start;
    const to = { lat, lng };
    const routes = LST_STORE.get();
    const route = routes.find(r=>r.id===__lstDrawState.routeId);
    if(!route){
      clearTemp();
      setLstPreviewStatus(container, 'Draw mode: route not found.');
      return;
    }
    if(!Array.isArray(route.segments)) route.segments = [];

    const newSeg = {
      road: '',
      from: `Pinned (${from.lat.toFixed(5)}, ${from.lng.toFixed(5)})`,
      to: `Pinned (${to.lat.toFixed(5)}, ${to.lng.toFixed(5)})`,
      risk: __lstDrawState.risk || 'L',
      fromCoords: { lat: from.lat, lng: from.lng },
      toCoords: { lat: to.lat, lng: to.lng },
    };

    // Optional: snap to road (store routed geometry so it always draws accurately)
    if(__lstDrawState.snap){
      try{
        const coords = await LST_UTILS.osrmRoute(
          { lat: from.lat, lng: from.lng },
          { lat: to.lat, lng: to.lng }
        );
        if(Array.isArray(coords) && coords.length >= 2){
          newSeg.geometry = coords; // OSRM GeoJSON coords: [lng, lat]
        }
      }catch(_e){ /* ignore */ }
    }

    route.segments.push(newSeg);
    LST_STORE.save(routes);
    try{ window.dispatchEvent(new CustomEvent('hgv:lstRoutes-changed')); }catch(_e){}

    if(__lstDrawState.chain){
      // Keep drawing: new start becomes previous end
      if(__lstDrawState.startMarker){
        try{ __lstDrawState.startMarker.setLatLng([to.lat, to.lng]); }catch(_e){}
      }
      if(__lstDrawState.tempLine){
        try{ map.removeLayer(__lstDrawState.tempLine); }catch(_e){}
      }
      __lstDrawState.tempLine = null;
      __lstDrawState.start = { lat: to.lat, lng: to.lng };
      setLstPreviewStatus(container, 'Segment added. Click the next point to continue…');
    }else{
      clearTemp();
      setLstPreviewStatus(container, 'Segment added. Click to set a new start point…');
    }

    // Re-render so the new segment appears in the list.
    try{ ADMIN.render(container); }catch(_e){ /* ignore */ }
  });

  map.on('mousemove', (e)=>{
    if(!__lstDrawState.enabled) return;
    if(!__lstDrawState.start) return;
    const a = __lstDrawState.start;
    const b = e.latlng;

    // Default straight preview
    const straight = [[a.lat, a.lng], [b.lat, b.lng]];

    // If snap is enabled, debounce a routed preview so the line follows the road while drawing.
    if(__lstDrawState.snap){
      const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
      if(key !== __lstDrawState._snapKey){
        __lstDrawState._snapKey = key;
        if(__lstDrawState._snapTimer) clearTimeout(__lstDrawState._snapTimer);
        __lstDrawState._snapTimer = setTimeout(async ()=>{
          __lstDrawState._snapTimer = null;
          try{
            const coords = await LST_UTILS.osrmRoute(
              { lat: a.lat, lng: a.lng },
              { lat: b.lat, lng: b.lng }
            );
            const latlngs = Array.isArray(coords) && coords.length >= 2
              ? coords.map(c=>[c[1], c[0]])
              : straight;
            if(__lstDrawState.tempLine){
              __lstDrawState.tempLine.setLatLngs(latlngs);
              __lstDrawState.tempLine.setStyle({ dashArray: Array.isArray(coords) ? null : '6,8', opacity: 0.65 });
            }else{
              __lstDrawState.tempLine = L.polyline(latlngs, {
                color: '#1a73e8',
                weight: 3,
                opacity: 0.65,
                dashArray: Array.isArray(coords) ? null : '6,8'
              }).addTo(map);
            }
          }catch(_e){
            // fall back to straight preview
          }
        }, 280);
      }
      // Ensure there's at least a straight line immediately
      if(!__lstDrawState.tempLine){
        __lstDrawState.tempLine = L.polyline(straight, {
          color: '#1a73e8',
          weight: 3,
          opacity: 0.6,
          dashArray: '6,8'
        }).addTo(map);
      }
      return;
    }

    if(__lstDrawState.tempLine){
      __lstDrawState.tempLine.setLatLngs(straight);
    }else{
      __lstDrawState.tempLine = L.polyline(straight, {
        color: '#1a73e8',
        weight: 3,
        opacity: 0.6,
        dashArray: '6,8'
      }).addTo(map);
    }
  });

  map.__lstDrawClearTemp = clearTemp;
}

function setLstPreviewStatus(container, text){
  const el = container.querySelector('#lstPreviewStatus');
  if(el) el.textContent = text;
}

function scheduleLstPreviewRedraw(container, routeId, delayMs=450){
  if(__lstPrevTimer) clearTimeout(__lstPrevTimer);
  __lstPrevTimer = setTimeout(()=>{
    __lstPrevTimer = null;
    drawLstPreview(container, routeId);
  }, delayMs);
}

async function drawLstPreview(container, routeId){
  const map = ensureLstPreviewMap(container);
  if(!map || !__lstPrevLayer) return;
  // If the editor has been re-rendered/removed while async work is running, Leaflet can throw.
  const isMapLive = ()=>{
    try{ return !!(map && map._container && map._container.isConnected); }catch(_e){ return false; }
  };
  const routes = LST_STORE.get();
  const route = routes.find(r=>r.id===routeId);
  if(!route){
    setLstPreviewStatus(container, 'Route not found.');
    return;
  }

  setLstPreviewStatus(container, 'Drawing preview…');
  __lstPrevLayer.clearLayers();
  __lstPrevLastBounds = null;

  const L = window.L;
  const bounds = L.latLngBounds([]);

  const segs = Array.isArray(route.segments) ? route.segments : [];
  for(let i=0;i<segs.length;i++){
    const seg = segs[i];
    try{
      if(!seg?.from || !seg?.to){
        continue;
      }
      let latlngs = null;
      if(Array.isArray(seg?.geometry) && seg.geometry.length >= 2){
        latlngs = seg.geometry.map(c=>[c[1], c[0]]);
      }else{
        const from = await LST_UTILS.resolveEndpoint(seg, 'from');
        const to = await LST_UTILS.resolveEndpoint(seg, 'to');
        const coords = await LST_UTILS.osrmRoute(from, to);
        latlngs = Array.isArray(coords) && coords.length >= 2
          ? coords.map(c=>[c[1], c[0]])
          : [[from.lat, from.lng], [to.lat, to.lng]];
      }

      const poly = L.polyline(latlngs, {
        color: LST_UTILS.riskColor(seg?.risk || 'L'),
        weight: 5,
        opacity: 0.9
      });
      poly.addTo(__lstPrevLayer);
      try{ bounds.extend(poly.getBounds()); }catch(_e){ /* ignore */ }
    }catch(_e){
      // keep going; show a lightweight hint
      continue;
    }
  }

  if(!isMapLive()) return;

  if(bounds.isValid()){
    __lstPrevLastBounds = bounds;
    try{ map.fitBounds(bounds.pad(0.12)); }catch(_e){ /* ignore */ }
    setLstPreviewStatus(container, 'Preview ready.');
  }else{
    try{ map.setView([54.5, -3.2], 6); }catch(_e){ /* ignore */ }
    setLstPreviewStatus(container, 'Add segment labels (From/To) to preview the route.');
  }
}

const HGV_ADMIN_RECENT = "hgv_admin_recent_edits_v1";
function getRecentEdits(){
  try{ return JSON.parse(localStorage.getItem(HGV_ADMIN_RECENT) || "[]"); }catch{return []}
}
function setRecentEdits(arr){ localStorage.setItem(HGV_ADMIN_RECENT, JSON.stringify(arr.slice(0,20))); }
function recordRecentEdit(destId){
  const now = Date.now();
  const arr = getRecentEdits().filter(x=>x && x.id !== destId);
  arr.unshift({id: destId, t: now});
  setRecentEdits(arr);
}
function formatAgo(ms){
  const s=Math.floor(ms/1000); if(s<60) return `${s}s ago`;
  const m=Math.floor(s/60); if(m<60) return `${m}m ago`;
  const h=Math.floor(m/60); if(h<48) return `${h}h ago`;
  const d=Math.floor(h/24); return `${d}d ago`;
}


function renderRecentEdits(container){
  const host = container.querySelector("#recentEditsList");
  if(!host) return;
  const all = DB.getDestinations() || [];
  const byId = new Map(all.map(d=>[d.id,d]));
  const now = Date.now();
  const items = getRecentEdits().slice(0,4).map(x=>({meta:x, dest: byId.get(x.id)})).filter(x=>x.dest);
  if(items.length===0){
    host.innerHTML = `<div class="small" style="opacity:.8">No recent edits yet.</div>`;
    return;
  }
  host.innerHTML = items.map(({meta, dest})=>`
    <div class="recentItem">
      <div class="thumb"><img data-media="${(dest.photos?.[0]?.url)||"assets/images/placeholders/entrance-1.png"}" src="assets/images/placeholders/entrance-1.png" alt=""></div>
      <div class="meta">
        <div class="title">${dest.name || "Untitled"}</div>
        <div class="small addr">${dest.address || ""}</div>
        <div class="small" style="opacity:.75">${formatAgo(now - (meta.t||now))}</div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" data-edit-dest="${dest.id}" style="padding:.55rem .75rem; border-radius:12px">Edit</button>
      </div>
    </div>
  `).join("");
}

export const ADMIN = {
  async _promptChangePassword(){
    const body = `
      <div class="small" style="margin-bottom:.6rem">For security, set a new password now.</div>
      <div style="display:grid; gap:.6rem">
        <input class="input" id="oldPw" type="password" placeholder="Old password" autocomplete="current-password">
        <input class="input" id="newPw" type="password" placeholder="New password" autocomplete="new-password">
        <input class="input" id="newPw2" type="password" placeholder="Confirm new password" autocomplete="new-password">
      </div>
    `;
    const ok = await UI.confirm({title:"Change password", body, okText:"Update", cancelText:"Cancel"});
    if(!ok) return false;

    const oldPw = document.querySelector("#oldPw")?.value || "";
    const newPw = document.querySelector("#newPw")?.value || "";
    const newPw2 = document.querySelector("#newPw2")?.value || "";
    if(newPw.length < 6){ UI.showToast("Password must be at least 6 characters", "danger"); return false; }
    if(newPw !== newPw2){ UI.showToast("Passwords do not match", "danger"); return false; }
    return await AUTH.changeOwnPassword(oldPw, newPw);
  },


  async render(container){
    if(!AUTH.isAdmin()){
      container.innerHTML = `
        <div style="min-height: calc(100dvh - 140px); display:grid; place-items:center; padding: 1rem;">
          <div class="card" style="width:min(520px, 100%); padding: 1.1rem;">
            <div style="display:flex; align-items:center; gap:.9rem">
              <div class="brandMark" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7h11v9H3V7Z" stroke="#1b1206" stroke-width="2"/>
                  <path d="M14 10h4l3 3v3h-7v-6Z" fill="#1b1206" opacity=".15"/>
                  <path d="M14 10h4l3 3v3h-7v-6Z" stroke="#1b1206" stroke-width="2"/>
                  <circle cx="7" cy="18" r="2" fill="#1b1206"/>
                  <circle cx="17" cy="18" r="2" fill="#1b1206"/>
                </svg>
              </div>
              <div>
                <div style="font-weight:950; font-size:1.35rem; letter-spacing:-0.02em">HGV <span style="color:var(--accent)">Destinations</span> Admin</div>
                <div class="small">Sign in to review community submissions</div>
              </div>
            </div>

            <div class="hr" style="margin: 1rem 0"></div>

            <div style="display:grid; gap:.7rem">
              <div>
                <div class="label">Username</div>
                <input class="input" id="username" placeholder="admin" autocomplete="username">
              </div>

              <div>
                <div class="label">Password</div>
                <input class="input" id="password" type="password" placeholder="••••••••" autocomplete="current-password">
              </div>

              <button class="btn btn-primary" id="loginBtn" style="width:100%">Login</button>

              <div class="small" style="opacity:.9">
                Tip: Admin is hidden — open Settings, then tap Settings 5 times to open this screen.
              </div>
            </div>
          </div>
        </div>
      `;
      container.querySelector("#loginBtn").addEventListener("click", async ()=>{
        const username = container.querySelector("#username").value.trim();
        const password = container.querySelector("#password").value;
        const res = await AUTH.login(username, password);
        if(res.ok){
          // If first login or after reset, prompt to change password
          if(res.mustChange && typeof ADMIN._promptChangePassword === 'function'){
            await ADMIN._promptChangePassword(container);
          }
          ADMIN.render(container);
        }
      });
      container.querySelector("#password").addEventListener("keydown", async (e)=>{
        if(e.key === "Enter"){
          const username = container.querySelector("#username").value.trim();
          const password = container.querySelector("#password").value;
          const res = await AUTH.login(username, password);
          if(res.ok){
            if(res.mustChange && typeof ADMIN._promptChangePassword === 'function'){
              await ADMIN._promptChangePassword(container);
            }
            ADMIN.render(container);
          }
        }
      });
      return;
    }

    
    const subs = Array.isArray(DB.getSubmissions()) ? DB.getSubmissions() : [];
    if(!ADMIN._state || typeof ADMIN._state !== "object"){
      ADMIN._state = {
        tab:"submissions",
        filter:"pending",
        lstQuery:"",
        lstEdit:null,
        lstDrawEnabled:false,
        lstDrawRisk:'L',
        lstDrawChain:true,
        lstDrawSnap:true
      };
    }
    const tabState = ADMIN._state;
    const locQuery = (tabState.locQuery || "").trim();
    const qNorm = locQuery.toUpperCase().replace(/\s+/g, "");
    const allLocations = DB.getDestinations() || [];
    const filtered = !locQuery ? allLocations : allLocations.filter(d=>{
      const hay = `${d.name||""} ${d.address||""} ${(d.tags||[]).join(" ")} ${(d.category||"")}`.toUpperCase();
      const hayNoSpace = hay.replace(/\s+/g, "");
      return hay.includes(locQuery.toUpperCase()) || hayNoSpace.includes(qNorm);
    });

    const destinations = DB.getDestinations() || [];
    const pending = subs.filter(s=>s.status==="pending");
    const approved = subs.filter(s=>s.status==="approved");
    const rejected = subs.filter(s=>s.status==="rejected");
    const lstRoutes = Array.isArray(LST_STORE.get?.()) ? LST_STORE.get() : [];

    const list = tabState.filter==="pending" ? pending
              : tabState.filter==="approved" ? approved
              : tabState.filter==="rejected" ? rejected
              : pending;

    const tabBtn = (key,label)=>`
      <button class="chip ${tabState.tab===key?"active":""}" data-tab="${key}">${label}</button>
    `;
    const filterBtn = (key,label)=>`
      <button class="chip ${tabState.filter===key?"active":""}" data-filter="${key}">${label}</button>
    `;

    const submissionCard = (s)=>{
      const p = s.payload;
      const thumb = p.photos?.[0]?.dataUrl || "assets/images/placeholders/entrance-1.png";
      const when = new Date(s.createdAt).toLocaleString();
      const who = p.submittedBy || "Community";
      return `
        <div class="listItem" style="align-items:center">
          <div class="thumb"><img data-media="${thumb}" src="assets/images/placeholders/entrance-1.png" alt=""></div>
          <div style="flex:1; min-width:0">
            <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap">
              <div style="font-weight:950; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${p.name}</div>
              <span class="pill ${s.status}">${s.status}</span>
            </div>
            <div class="small" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${p.address}</div>
            <div class="small">Submitted: ${when}</div>
          </div>
          <button class="btn btn-primary" data-review="${s.id}" style="padding:.55rem .75rem; border-radius:12px">Review</button>
        </div>
      `;
    };

    container.innerHTML = `
      <div style="padding:1rem">
        <div class="card" style="padding:1rem">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap">
            <div style="display:flex; align-items:center; gap:.8rem">
              <div class="brandMark" aria-hidden="true" style="width:40px;height:40px;border-radius:14px">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7h11v9H3V7Z" stroke="#1b1206" stroke-width="2"/>
                  <path d="M14 10h4l3 3v3h-7v-6Z" fill="#1b1206" opacity=".15"/>
                  <path d="M14 10h4l3 3v3h-7v-6Z" stroke="#1b1206" stroke-width="2"/>
                  <circle cx="7" cy="18" r="2" fill="#1b1206"/>
                  <circle cx="17" cy="18" r="2" fill="#1b1206"/>
                </svg>
              </div>
              <div>
                <div class="h1" style="margin:0">HGV Destinations <span style="color:var(--accent)">Admin</span></div>
                <div class="small">Review submissions • Manage locations • Admin tools</div>
              </div>
            </div>
            <button class="btn btn-ghost" id="logoutBtn">Logout</button>
          </div>

          <div class="hr" style="margin:1rem 0"></div>
              <div class="card" style="margin:1rem 0; padding:1rem">
                <div class="h3">Admin security</div>
                <div class="small" style="margin-top:.25rem">Optional Face ID / fingerprint gate for opening Admin tools on this device.</div>
                <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-top:.75rem; flex-wrap:wrap">
                  <div class="small">Require biometrics for Admin</div>
                  <label class="switch">
                    <input type="checkbox" id="adminBioToggleAdmin">
                    <span class="slider"></span>
                  </label>
                </div>
                <div style="display:flex; gap:.6rem; margin-top:.75rem; flex-wrap:wrap">
                  <button class="btn" id="adminBioSetupAdmin">Set up biometrics</button>
                  <button class="btn" id="adminBioClearAdmin">Clear biometrics</button>
                </div>
              </div>


          <div class="filterRow" style="justify-content:space-between; align-items:center">
            <div class="filterRow">
              ${tabBtn("submissions","New Submissions")}
              ${tabBtn("locations","Locations Management")}
              ${tabBtn("lstRoutes","LST Routes")}
              ${tabBtn("admins","Admins")}
              ${tabBtn("settings","Settings")}
            </div>
            <div class="small">
              Destinations: <b>${destinations.length}</b> • Pending: <b>${pending.length}</b>
            </div>
          </div>
        </div>

        <div style="margin-top:1rem">
          ${tabState.tab==="submissions" ? `
            <div class="card-soft" style="padding:1rem">
              <div style="display:flex; justify-content:space-between; gap:1rem; align-items:flex-end; flex-wrap:wrap">
                <div>
                  <div class="h2">Submissions</div>
                  <div class="small">Approve to publish into destinations.</div>
                </div>
                <div class="filterRow">
                  ${filterBtn("pending",`Pending (${pending.length})`)}
                  ${filterBtn("approved",`Approved (${approved.length})`)}
                  ${filterBtn("rejected",`Rejected (${rejected.length})`)}
                </div>
              </div>

              <div style="display:grid; gap:.6rem; margin-top: .9rem">
                ${list.map(submissionCard).join("") || `<div class="small">No items here.</div>`}
              </div>
            </div>
          ` : ""}

          ${tabState.tab==="locations" ? `
            <div class="card-soft" style="padding:1rem">
              <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-end">
                <div>
                  <div class="h2">Locations Management</div>
                  <div class="small">Add or remove destinations (local prototype).</div>
                </div>
                <div class="adminLocToolsTop">
                  <input class="input" id="locSearch" placeholder="Search locations…" value="${locQuery.replace(/"/g,"&quot;")}">
                  <button class="btn btn-ghost" id="locClear">Clear</button>
                </div>
                <button class="btn btn-primary" id="addLocationBtn">+ Add new location</button>
              </div>

              <div class="hr" style="margin:1rem 0"></div>

              <div class="card recentEditsCard" style="margin-bottom:1rem">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap">
                  <div>
                    <div style="font-weight:950; font-size:1.05rem">Recently edited</div>
                    <div class="small" style="opacity:.85">Quick access to your last 4 updates on this device.</div>
                  </div>
                  <button class="btn btn-ghost" id="recentClear" style="border-radius:14px">Clear</button>
                </div>
                <div id="recentEditsList" class="recentEditsList" style="margin-top:.8rem"></div>
              </div>

              <div style="display:grid; gap:.6rem">
                ${filtered.slice(0,200).map(d=>`
                  <div class="listItem adminDestRow">
                    <div class="thumb"><img data-media="${(d.photos?.[0]?.url)||"assets/images/placeholders/entrance-1.png"}" src="assets/images/placeholders/entrance-1.png" alt=""></div>
                    <div class="meta">
                      <div class="title">${d.name}</div>
                      <div class="small addr">${d.address}</div>
                    </div>
                    <div class="actions">
                      <button class="btn btn-ghost" data-edit-dest="${d.id}" style="padding:.55rem .75rem; border-radius:12px">Edit</button>
                      <button class="btn btn-ghost" data-delete-dest="${d.id}" style="padding:.55rem .75rem; border-radius:12px">Delete</button>
                    </div>
                  </div>
                `).join("") || `<div class="small">No destinations loaded.</div>`}
              </div>
            </div>
          ` : ""}

          ${tabState.tab==="lstRoutes" ? `
            <div class="card-soft" style="padding:1rem">
              <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-end">
                <div>
                  <div class="h2">LST Routes</div>
                  <div class="small">Edit permitted LST routes and set risk colours per segment (saved locally on this device).</div>
                </div>
                <div class="filterRow" style="gap:.5rem">
                  <button class="btn btn-ghost" id="lstAddRouteBtn">+ Add route</button>
                  <button class="btn btn-ghost" id="lstExportRoutesBtn">Export routes (GitHub)</button>
                  <button class="btn btn-ghost" id="lstResetRoutesBtn">Reset to seed</button>
                </div>
              </div>

              <div class="hr" style="margin:1rem 0"></div>

              <div class="small" style="opacity:.85; margin-bottom:.75rem">
                Methods to ensure accuracy: you can (1) edit labels (From/To) for geocoding, and (2) set exact coordinates overrides for any From/To if a label is ambiguous.
              </div>

              <div class="card" style="padding:1rem; border-radius:18px; margin-bottom:1rem">
                <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-end">
                  <div>
                    <div style="font-weight:950">Import from route sheets (Gemini Vision)</div>
                    <div class="small" style="opacity:.85">Upload the two-page route sheets (Journey page + Table page). The app will scan them with Gemini 2.0 Flash and create routes.</div>
                  </div>
                </div>
                <div class="hr" style="margin:.9rem 0"></div>

                <div style="display:grid; gap:.7rem">
                  <div style="display:flex; gap:.6rem; align-items:center; flex-wrap:wrap">
                    <input class="input" id="lstGeminiKey" type="password" placeholder="Paste Gemini API key (stored locally on this device)" style="flex:1; min-width:260px">
                    <button class="btn btn-ghost" id="lstGeminiSaveKey">Save key</button>
                    <button class="btn btn-ghost" id="lstGeminiClearKey">Clear</button>
                  </div>

                  <div style="display:flex; gap:.6rem; align-items:center; flex-wrap:wrap">
                    <input class="input" id="lstGeminiFiles" type="file" accept="image/*" multiple style="flex:1; min-width:260px">
                    <label class="small" style="display:flex; align-items:center; gap:.4rem; user-select:none">
                      <input type="checkbox" id="lstGeminiPair" checked>
                      Pair pages (recommended)
                    </label>
                    <button class="btn" id="lstGeminiImport">Scan & create routes</button>
                  </div>

                  <div class="small muted" id="lstGeminiStatus">Tip: Select images in order (page 1 then page 2). Pair mode will group them 2-by-2.</div>
                </div>
              </div>

              <div style="display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.75rem">
                <input class="input" id="lstSearch" placeholder="Search routes…" value="${escapeHtml(tabState.lstQuery||"")}" style="flex:1; min-width:240px">
                <button class="btn btn-ghost" id="lstClearSearch">Clear</button>
              </div>

              <div id="lstAdminRoutes" class="lstAdminRoutes">
                ${tabState.lstEdit ? (()=>{
                  const r = lstRoutes.find(x=>x.id===tabState.lstEdit);
                  if(!r) return `<div class="small">Route not found.</div>`;
                  return `
                    <div class="filterRow" style="gap:.5rem; margin-bottom:.75rem">
                      <button class="btn btn-ghost" id="lstBackToList">← Back to routes</button>
                    </div>

                    <div class="card lstRouteEditor" data-lst-route-id="${r.id}" style="padding:1rem; margin-bottom:.8rem">
                      <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-start">
                        <div style="flex:1; min-width:240px">
                          <div class="label">Route title</div>
                          <input class="input" data-lst-field="title" value="${escapeHtml(r.title||"")}" placeholder="e.g. Turners Newmarket → RDC">
                          <div class="label" style="margin-top:.6rem">Notes</div>
                          <textarea class="input" data-lst-field="notes" rows="2" placeholder="Short risk notes…">${escapeHtml(r.notes||"")}</textarea>

                          <div class="hr" style="margin:.9rem 0"></div>
                          <div class="label">Journey start / end (anchors)</div>
                          <div class="small muted" style="margin-bottom:.5rem">These help keep routing in the correct area. Add postcodes where possible. Use 📍 to pin exact start/end if a sheet label is vague.</div>
                          <div style="display:grid; grid-template-columns:1fr 1fr; gap:.6rem">
                            <div>
                              <div class="label" style="margin-bottom:.25rem">Start</div>
                              <div class="lstEndpoint">
                                <input class="input" data-lst-field="startLabel" value="${escapeHtml(r.startLabel||"")}" placeholder="e.g. Turners, Newmarket">
                                <button class="btn btn-ghost" data-lst-route-coords="start" title="Pin start on map">📍</button>
                              </div>
                              <input class="input" data-lst-field="startPostcode" value="${escapeHtml(r.startPostcode||"")}" placeholder="Postcode (e.g. CB8 7NR)" style="margin-top:.4rem">
                            </div>
                            <div>
                              <div class="label" style="margin-bottom:.25rem">End</div>
                              <div class="lstEndpoint">
                                <input class="input" data-lst-field="endLabel" value="${escapeHtml(r.endLabel||"")}" placeholder="e.g. Tesco DC, Hinckley">
                                <button class="btn btn-ghost" data-lst-route-coords="end" title="Pin end on map">📍</button>
                              </div>
                              <input class="input" data-lst-field="endPostcode" value="${escapeHtml(r.endPostcode||"")}" placeholder="Postcode (e.g. LE10 3BT)" style="margin-top:.4rem">
                            </div>
                          </div>

                          <div class="small muted" style="margin-top:.35rem">Route id: <code>${escapeHtml(r.id||"")}</code></div>
                        </div>
                        <div style="display:flex; gap:.5rem; align-items:flex-start; flex-wrap:wrap; justify-content:flex-end">
                          <button class="btn btn-ghost" data-lst-add-seg="${r.id}">+ Segment</button>
                          <button class="btn btn-ghost" id="lstDrawToggle" type="button">✏️ Draw</button>
                          <button class="btn btn-ghost" id="lstDrawChain" type="button" title="Draw multiple segments by clicking points">🔗 Chain</button>
                          <button class="btn btn-ghost" id="lstDrawSnap" type="button" title="Snap drawn segments to the road (OSRM)">🛣️ Snap</button>
                          <select class="input" id="lstDrawRisk" title="Risk for drawn segments" style="max-width:140px">
                            <option value="L">Draw: Low</option>
                            <option value="M">Draw: Medium</option>
                            <option value="H">Draw: High</option>
                          </select>
                          <button class="btn btn-ghost" data-lst-del-route="${r.id}">Delete</button>
                        </div>
                      </div>

                      <div class="hr" style="margin:1rem 0"></div>

                      <div class="lstSegTable" data-lst-seg-table="${r.id}">
                        <div class="lstSegHead">
                          <div></div>
                          <div>Road</div>
                          <div>From</div>
                          <div>To</div>
                          <div>Risk</div>
                          <div></div>
                        </div>
                        ${(Array.isArray(r.segments)?r.segments:[]).map((s, sIdx)=>`
                          <div class="lstSegRow" data-lst-route="${r.id}" data-lst-seg-index="${sIdx}">
                            <div class="lstDragHandle" draggable="true" title="Drag to reorder" aria-label="Reorder">⋮⋮</div>
                            <input class="input" data-lst-seg="road" value="${escapeHtml(s.road||"")}" placeholder="A14">
                            <div class="lstEndpoint">
                              <input class="input" data-lst-seg="from" value="${escapeHtml(s.from||"")}" placeholder="From label…">
                              <button class="btn btn-ghost" data-lst-coords="from" title="Set exact coordinates">📍</button>
                            </div>
                            <div class="lstEndpoint">
                              <input class="input" data-lst-seg="to" value="${escapeHtml(s.to||"")}" placeholder="To label…">
                              <button class="btn btn-ghost" data-lst-coords="to" title="Set exact coordinates">📍</button>
                            </div>
                            <select class="input" data-lst-seg="risk" style="max-width:110px">
                              <option value="L" ${s.risk==="L"?"selected":""}>Low</option>
                              <option value="M" ${s.risk==="M"?"selected":""}>Medium</option>
                              <option value="H" ${s.risk==="H"?"selected":""}>High</option>
                            </select>
                            <div style="display:flex; gap:.4rem; justify-content:flex-end">
                              <button class="btn btn-ghost" data-lst-test="${r.id}:${sIdx}">Test</button>
                              <button class="btn btn-ghost" data-lst-del-seg="${r.id}:${sIdx}">Remove</button>
                            </div>
                          </div>
                        `).join("")}
                      </div>

                      <div class="hr" style="margin:1rem 0"></div>

                      <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap">
                        <div>
                          <div style="font-weight:950">Preview map</div>
                          <div class="small" style="opacity:.85">Live preview of the route as you edit segments.</div>
                        </div>
                        <div class="filterRow" style="gap:.5rem">
                          <button class="btn btn-ghost" id="lstPreviewRefresh">Refresh</button>
                          <button class="btn btn-ghost" id="lstPreviewCentre">Centre</button>
                        </div>
                      </div>
                      <div class="small muted" id="lstPreviewStatus" style="margin:.5rem 0 .6rem">Ready.</div>
                      <div id="lstEditMap" class="lstEditMap" data-lst-edit-map="${r.id}"></div>

                      <div class="adminEditorFooter" style="margin-top:1rem">
                        <button class="btn btn-ghost" id="lstCancelEdit">Cancel</button>
                        <button class="btn" id="lstSaveEdit">Save changes</button>
                      </div>
                    </div>
                  `;
                })() : (()=>{
                  const q=(tabState.lstQuery||"").trim().toLowerCase();
                  const filtered = q ? lstRoutes.filter(r=>((r.title||"")+" "+(r.notes||"")+" "+(r.id||"")).toLowerCase().includes(q)) : lstRoutes;
                  return filtered.map(r=>`
                    <div class="recentItem" style="padding:.85rem" data-lst-route-card="${r.id}">
                      <div class="meta">
                        <div class="title lstRouteTitle">${escapeHtml(r.title||"Untitled route")}</div>
                        <div class="small addr">${escapeHtml((r.notes||"")||"No notes")}</div>
                        <div class="small muted" style="margin-top:.15rem">Segments: ${(Array.isArray(r.segments)?r.segments.length:0)}</div>
                      </div>
                      <div class="actions">
                        <button class="btn btn-ghost" data-lst-edit-route="${r.id}" style="padding:.55rem .75rem; border-radius:12px">Edit</button>
                        <button class="btn btn-ghost" data-lst-del-route="${r.id}" style="padding:.55rem .75rem; border-radius:12px">Delete</button>
                      </div>
                    </div>
                  `).join("") || `<div class="small">No routes match your search.</div>`;
                })()}
              </div>

                      <div class="small muted" id="lstAdminStatus" style="margin-top:.75rem">Tip: Use “Test” to verify a segment resolves inside the UK. Use 📍 to set exact coords if geocoding is ambiguous. Drag ⋮⋮ to reorder segments. Use ✏️ Draw to add segments by clicking points on the preview map. Turn on 🔗 Chain to build multi-segment routes quickly. Turn on 🛣️ Snap to store road-following geometry (most accurate).</div>
            </div>
          ` : ""}

          
          ${tabState.tab==="admins" ? `
            <div class="card-soft" style="padding:1rem">
              <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-end">
                <div>
                  <div class="h2">Admins</div>
                  <div class="small">View admin users and reset passwords.</div>
                </div>
                <button class="btn btn-ghost" id="changeOwnBtn">Change my password</button>
              </div>

              <div class="hr" style="margin:1rem 0"></div>

              <div style="display:grid; gap:.6rem" id="adminList"></div>

              <div class="small" style="margin-top:.9rem">
                Security note: this is client-side only. For real security, admin management must be server-side.
              </div>
            </div>
          ` : ""}
${tabState.tab==="settings" ? `
            <div class="card-soft" style="padding:1rem">
              <div class="h2">Admin Tools</div>
              <div class="small" style="margin-top:.25rem">Export/import or reset prototype data.</div>

              <div class="hr" style="margin:1rem 0"></div>

              <div style="display:flex; gap:.6rem; flex-wrap:wrap">
                <button class="btn btn-ghost" id="exportBtn">Export data</button>
                <button class="btn btn-ghost" id="exportSeedBtn">Export seed (GitHub)</button>
                <button class="btn btn-ghost" id="importBtn">Import data</button>
                <button class="btn btn-ghost" id="resetBtn">Reset local data</button>
              </div>

              <div class="small" style="margin-top:.8rem">
                Tip: Use <b>Export seed (GitHub)</b> to download an updated <code>destinations.seed.json</code> you can commit to your repo so all users get the changes.
              </div>
            </div>
          ` : ""}
        </div>
      </div>
    `;

    container.querySelector("#logoutBtn").addEventListener("click", ()=>{
      AUTH.logout();
      ADMIN.render(container);
    });

    container.querySelectorAll("[data-tab]").forEach(b=>{
      b.addEventListener("click", ()=>{
        tabState.tab = b.dataset.tab;
        ADMIN.render(container);
      });
    });
    container.querySelectorAll("[data-filter]").forEach(b=>{
      b.addEventListener("click", ()=>{
        tabState.filter = b.dataset.filter;
        ADMIN.render(container);
      });
    });

    // Locations management
    const addBtn = container.querySelector("#addLocationBtn");
    if(addBtn){
      addBtn.addEventListener("click", async ()=>{
        const body = `
          <div class="small" style="margin-bottom:.6rem">Add a destination directly (published immediately).</div>
          <div style="display:grid; gap:.6rem">
            <input class="input" id="d_name" placeholder="Name">
            <input class="input" id="d_address" placeholder="Address">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:.6rem">
              <input class="input" id="d_lat" placeholder="Lat" inputmode="decimal">
              <input class="input" id="d_lon" placeholder="Lon" inputmode="decimal">
            </div>
            <textarea class="input" id="d_gate" placeholder="Gate info"></textarea>
          </div>
        `;
        const ok = await UI.confirm({title:"Add new location", body, okText:"Add", cancelText:"Cancel"});
        if(!ok) return;

        const name = document.querySelector("#d_name")?.value?.trim() || "";
        const address = document.querySelector("#d_address")?.value?.trim() || "";
        const lat = Number(document.querySelector("#d_lat")?.value?.trim());
        const lon = Number(document.querySelector("#d_lon")?.value?.trim());
        const gateInfo = document.querySelector("#d_gate")?.value?.trim() || "";

        if(!name || !address || !Number.isFinite(lat) || !Number.isFinite(lon) || !gateInfo){
          UI.showToast("Fill name, address, lat/lon and gate info.", "danger");
          return;
        }
        await DEST.ensureLoaded();
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,60) || `dest-${Date.now()}`;
        DEST.upsertDestination({
          id, name, address, lat, lon,
          category: "Admin",
          hours: "Hours unknown",
          gateInfo,
          facilities: [],
          tags: ["Admin"],
          photos: [{caption:"Main entrance", url:"assets/images/placeholders/entrance-1.png"}],
          notes: ""
        });
        UI.showToast("Destination added.", "ok");
        ADMIN.render(container);
      });
    }

    
    
    
    const locSearchEl = container.querySelector("#locSearch");
    const locClearEl = container.querySelector("#locClear");
    if(locSearchEl){
      locSearchEl.addEventListener("input", ()=>{
        tabState.locQuery = locSearchEl.value;
        ADMIN.render(container);
        const el2 = container.querySelector("#locSearch");
        if(el2){ el2.focus(); el2.selectionStart = el2.selectionEnd = el2.value.length; }
      });
    }
    if(locClearEl){
      locClearEl.addEventListener("click", ()=>{
        tabState.locQuery = "";
        ADMIN.render(container);
      });
    }

    renderRecentEdits(container);

    // LST Routes editor

    // LST Routes admin list/search + editor
    const lstSearch = container.querySelector('#lstSearch');
    const lstClearSearch = container.querySelector('#lstClearSearch');
    if(lstSearch){
      lstSearch.addEventListener('input', ()=>{
        tabState.lstQuery = lstSearch.value;
        ADMIN.render(container);
        const el = container.querySelector('#lstSearch');
        if(el){ el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      });
    }
    if(lstClearSearch){
      lstClearSearch.addEventListener('click', ()=>{ tabState.lstQuery=''; ADMIN.render(container); });
    }
    const lstBack = container.querySelector('#lstBackToList');
    if(lstBack){
      lstBack.addEventListener('click', ()=>{ tabState.lstEdit=null; ADMIN.render(container); });
    }
    const lstCancelEdit = container.querySelector('#lstCancelEdit');
    if(lstCancelEdit){
      lstCancelEdit.addEventListener('click', ()=>{ tabState.lstEdit=null; ADMIN.render(container); });
    }
    const lstSaveEdit = container.querySelector('#lstSaveEdit');
    if(lstSaveEdit){
      lstSaveEdit.addEventListener('click', ()=>{
        const routes = LST_STORE.get();
        LST_STORE.save(routes);
        try{ window.dispatchEvent(new CustomEvent('hgv:lstRoutes-changed')); }catch(_e){}
        if(container.querySelector('#lstAdminStatus')) container.querySelector('#lstAdminStatus').textContent = 'Saved.';
        UI.showToast('Route saved.', 'success');
      });
    }

    // Live preview map (only while editing a route)
    if(tabState.tab === 'lstRoutes' && tabState.lstEdit){
      // Sync draw-state with current route + persisted admin state
      __lstDrawState.routeId = tabState.lstEdit;
      __lstDrawState.enabled = !!tabState.lstDrawEnabled;
      __lstDrawState.risk = tabState.lstDrawRisk || 'L';
      __lstDrawState.chain = tabState.lstDrawChain !== false;
      __lstDrawState.snap = tabState.lstDrawSnap !== false;

      // Init + first draw
      setTimeout(()=>{
        ensureLstPreviewMap(container);
        drawLstPreview(container, tabState.lstEdit);
      }, 0);

      // Draw mode UI
      const btnDraw = container.querySelector('#lstDrawToggle');
      const btnChain = container.querySelector('#lstDrawChain');
      const btnSnap = container.querySelector('#lstDrawSnap');
      const selDrawRisk = container.querySelector('#lstDrawRisk');
      if(selDrawRisk){
        selDrawRisk.value = __lstDrawState.risk || 'L';
        selDrawRisk.addEventListener('change', ()=>{
          tabState.lstDrawRisk = selDrawRisk.value;
          __lstDrawState.risk = tabState.lstDrawRisk;
        });
      }
      if(btnDraw){
        const updateBtn = ()=>{
          btnDraw.classList.toggle('is-active', !!tabState.lstDrawEnabled);
          btnDraw.classList.toggle('btn-primary', !!tabState.lstDrawEnabled);
          btnDraw.textContent = tabState.lstDrawEnabled ? '✏️ Drawing…' : '✏️ Draw';
        };
        updateBtn();
        btnDraw.addEventListener('click', ()=>{
          tabState.lstDrawEnabled = !tabState.lstDrawEnabled;
          __lstDrawState.enabled = !!tabState.lstDrawEnabled;
          updateBtn();
          const map = ensureLstPreviewMap(container);
          if(map && map.__lstDrawClearTemp){
            map.__lstDrawClearTemp();
          }
          setLstPreviewStatus(container, tabState.lstDrawEnabled ? 'Draw mode: click a start point…' : 'Ready.');
        });
      }

      if(btnChain){
        const updateChain = ()=>{
          btnChain.classList.toggle('is-active', !!tabState.lstDrawChain);
          btnChain.classList.toggle('btn-primary', !!tabState.lstDrawChain);
          btnChain.textContent = tabState.lstDrawChain ? '🔗 Chain on' : '🔗 Chain';
        };
        updateChain();
        btnChain.addEventListener('click', ()=>{
          tabState.lstDrawChain = !tabState.lstDrawChain;
          __lstDrawState.chain = !!tabState.lstDrawChain;
          updateChain();
        });
      }

      if(btnSnap){
        const updateSnap = ()=>{
          btnSnap.classList.toggle('is-active', !!tabState.lstDrawSnap);
          btnSnap.classList.toggle('btn-primary', !!tabState.lstDrawSnap);
          btnSnap.textContent = tabState.lstDrawSnap ? '🛣️ Snap on' : '🛣️ Snap';
        };
        updateSnap();
        btnSnap.addEventListener('click', ()=>{
          tabState.lstDrawSnap = !tabState.lstDrawSnap;
          __lstDrawState.snap = !!tabState.lstDrawSnap;
          updateSnap();
        });
      }

      const btnRefresh = container.querySelector('#lstPreviewRefresh');
      if(btnRefresh){
        btnRefresh.addEventListener('click', ()=> drawLstPreview(container, tabState.lstEdit));
      }
      const btnCentre = container.querySelector('#lstPreviewCentre');
      if(btnCentre){
        btnCentre.addEventListener('click', ()=>{
          const map = ensureLstPreviewMap(container);
          if(!map) return;
          if(__lstPrevLastBounds && __lstPrevLastBounds.isValid()){
            map.fitBounds(__lstPrevLastBounds.pad(0.12));
          }else{
            map.setView([54.5, -3.2], 6);
          }
        });
      }
    }else{
      // Leaving editor: clean up the Leaflet instance to avoid "already initialized" errors.
      destroyLstPreviewMap();
    }
    container.querySelectorAll('[data-lst-edit-route]').forEach(btn=>{
      btn.addEventListener('click', ()=>{ tabState.lstEdit = btn.dataset.lstEditRoute; ADMIN.render(container); });
    });

    // Segment drag + drop reordering (drag the handle)
    let dragState = null; // {rid, fromIndex}
    container.querySelectorAll('.lstDragHandle').forEach(handle=>{
      handle.addEventListener('dragstart', (e)=>{
        const row = handle.closest('.lstSegRow');
        if(!row) return;
        dragState = { rid: row.dataset.lstRoute, fromIndex: Number(row.dataset.lstSegIndex) };
        e.dataTransfer.effectAllowed = 'move';
        try{ e.dataTransfer.setData('text/plain', `${dragState.rid}:${dragState.fromIndex}`); }catch(_){ }
        row.classList.add('isDragging');
      });
      handle.addEventListener('dragend', ()=>{
        const row = handle.closest('.lstSegRow');
        if(row) row.classList.remove('isDragging');
        dragState = null;
      });
    });

    container.querySelectorAll('.lstSegRow').forEach(row=>{
      row.addEventListener('dragover', (e)=>{
        if(!dragState) return;
        if(row.dataset.lstRoute !== dragState.rid) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('isDragOver');
      });
      row.addEventListener('dragleave', ()=> row.classList.remove('isDragOver'));
      row.addEventListener('drop', (e)=>{
        if(!dragState) return;
        e.preventDefault();
        row.classList.remove('isDragOver');
        const rid = row.dataset.lstRoute;
        const toIndex = Number(row.dataset.lstSegIndex);
        const fromIndex = dragState.fromIndex;
        if(!rid || !Number.isFinite(toIndex) || !Number.isFinite(fromIndex)) return;
        if(toIndex === fromIndex) return;
        const routes = LST_STORE.get();
        const route = routes.find(r=>r.id===rid);
        if(!route || !Array.isArray(route.segments)) return;
        const seg = route.segments.splice(fromIndex, 1)[0];
        route.segments.splice(toIndex, 0, seg);
        LST_STORE.save(routes);
        tabState.lstEdit = rid;
        ADMIN.render(container);
      });
    });

    const lstHost = container.querySelector("#lstAdminRoutes");
    const lstStatus = container.querySelector("#lstAdminStatus");
    const setLstStatus = (t)=>{ if(lstStatus) lstStatus.textContent = t; };

    const saveLstRoutes = (routes)=>{
      LST_STORE.save(routes);
      try{ window.dispatchEvent(new CustomEvent("hgv:lstRoutes-changed")); }catch(_e){ /* ignore */ }
    };

    const downloadJson = (filename, obj)=>{
      const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 500);
    };

    async function geocodePreview(label){
      const UK_VIEWBOX = "-8.6500,49.8000,1.8000,60.9500";
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&bounded=1&viewbox=${UK_VIEWBOX}&q=${encodeURIComponent(label)}`;
      const res = await fetch(url, {headers:{"Accept":"application/json"}}).catch(()=>null);
      if(!res || !res.ok) return null;
      const data = await res.json().catch(()=>null);
      const hit = Array.isArray(data) ? data[0] : null;
      if(!hit) return null;
      return { lat:Number(hit.lat), lng:Number(hit.lon), name: hit.display_name };
    }

    async function openCoordsModal({routeId, segIndex, key, current}){
      const body = `
        <div class="small" style="margin-bottom:.6rem">Set an exact coordinate override for <b>${escapeHtml(key.toUpperCase())}</b>. This prevents ambiguous labels mapping to the wrong place.</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:.6rem">
          <div>
            <div class="label">Latitude</div>
            <input class="input" id="lstLat" inputmode="decimal" placeholder="52.12345" value="${current?.lat ?? ""}">
          </div>
          <div>
            <div class="label">Longitude</div>
            <input class="input" id="lstLng" inputmode="decimal" placeholder="-1.23456" value="${current?.lng ?? ""}">
          </div>
        </div>
        <div style="display:flex; gap:.5rem; margin-top:.75rem; flex-wrap:wrap">
          <button class="btn btn-ghost" id="lstCoordsClear">Clear override</button>
          <button class="btn btn-ghost" id="lstCoordsPreview">Preview label geocode</button>
        </div>
        <div class="small muted" id="lstCoordsHint" style="margin-top:.6rem">Tip: If you don’t know coords, click “Preview label geocode” first, then copy the coordinates you want to lock in.</div>
      `;
      const ok = await UI.confirm({title:"Set coordinates", body, okText:"Save", cancelText:"Cancel"});
      if(!ok) return { action:"cancel" };

      const lat = Number(document.querySelector("#lstLat")?.value?.trim());
      const lng = Number(document.querySelector("#lstLng")?.value?.trim());
      const clear = window.__lstCoordsClear === true;
      window.__lstCoordsClear = false;
      if(clear) return { action:"clear" };
      if(!Number.isFinite(lat) || !Number.isFinite(lng)){
        UI.showToast("Enter valid lat/lng or click Clear override.", "danger");
        return { action:"invalid" };
      }
      return { action:"save", lat, lng };
    }

    // Hook extra buttons inside the coords modal (needs document-level because modal is appended to body)
    if(!ADMIN._lstModalHook){
      ADMIN._lstModalHook = true;
      document.addEventListener("click", async (e)=>{
      const t = e.target;
      if(!(t instanceof HTMLElement)) return;
      if(t.id === "lstCoordsClear"){
        e.preventDefault();
        window.__lstCoordsClear = true;
        UI.showToast("Override will be cleared when you click Save.", "info");
      }
      if(t.id === "lstCoordsPreview"){
        e.preventDefault();
        const hint = document.querySelector("#lstCoordsHint");
        const editor = document.querySelector(".modalBody")?.closest(".modal");
        // Best-effort: find the segment row that launched the modal and use its label.
        // If not found, show a generic message.
        if(hint) hint.textContent = "Checking…";
        // We can’t reliably know which label here; this is a lightweight helper only.
        if(hint) hint.textContent = "Preview runs from the segment label using the Test button in the table.";
      }
      }, {capture:true});
    }

    if(lstHost){
      // Save on input changes
      lstHost.addEventListener("input", (e)=>{
        const el = e.target;
        if(!(el instanceof HTMLElement)) return;
        const routeEl = el.closest(".lstRouteEditor");
        if(!routeEl) return;

        const routeId = routeEl.getAttribute("data-lst-route-id");
        const routes = LST_STORE.get();
        const r = routes.find(x=>x.id===routeId);
        if(!r) return;

        if(el.hasAttribute("data-lst-field")){
          const f = el.getAttribute("data-lst-field");
          r[f] = el.value;
          saveLstRoutes(routes);
          setLstStatus("Saved.");
          if(tabState.lstEdit === routeId) scheduleLstPreviewRedraw(container, routeId);
        }

        const segRow = el.closest("[data-lst-seg-row]");
        if(segRow && el.hasAttribute("data-lst-seg")){
          const [rid, idxStr] = segRow.getAttribute("data-lst-seg-row").split(":");
          const idx = Number(idxStr);
          const rr = routes.find(x=>x.id===rid);
          const seg = rr?.segments?.[idx];
          if(seg){
            const sf = el.getAttribute("data-lst-seg");
            seg[sf] = el.value;
            saveLstRoutes(routes);
            setLstStatus("Saved.");
            if(tabState.lstEdit === rid) scheduleLstPreviewRedraw(container, rid);
          }
        }
      });

      lstHost.addEventListener("change", (e)=>{
        const el = e.target;
        if(!(el instanceof HTMLElement)) return;
        const segRow = el.closest("[data-lst-seg-row]");
        if(segRow && el.hasAttribute("data-lst-seg")){
          const [rid, idxStr] = segRow.getAttribute("data-lst-seg-row").split(":");
          const idx = Number(idxStr);
          const routes = LST_STORE.get();
          const rr = routes.find(x=>x.id===rid);
          const seg = rr?.segments?.[idx];
          if(seg){
            const sf = el.getAttribute("data-lst-seg");
            seg[sf] = el.value;
            saveLstRoutes(routes);
            setLstStatus("Saved.");
            if(tabState.lstEdit === rid) scheduleLstPreviewRedraw(container, rid);
          }
        }
      });

      lstHost.addEventListener("click", async (e)=>{
        const btn = e.target instanceof HTMLElement ? e.target.closest("button") : null;
        if(!btn) return;

        // Add segment
        if(btn.hasAttribute("data-lst-add-seg")){
          const routeId = btn.getAttribute("data-lst-add-seg");
          const routes = LST_STORE.get();
          const r = routes.find(x=>x.id===routeId);
          if(r){
            r.segments = Array.isArray(r.segments) ? r.segments : [];
            r.segments.push({ road:"", from:"", to:"", risk:"L" });
            saveLstRoutes(routes);
            ADMIN.render(container);
          }
        }

        // Remove segment
        if(btn.hasAttribute("data-lst-del-seg")){
          const [rid, idxStr] = btn.getAttribute("data-lst-del-seg").split(":");
          const idx = Number(idxStr);
          const routes = LST_STORE.get();
          const r = routes.find(x=>x.id===rid);
          if(r?.segments?.[idx]){
            const ok = await UI.confirm({title:"Remove segment", body:"Remove this segment?", okText:"Remove", cancelText:"Cancel"});
            if(!ok) return;
            r.segments.splice(idx,1);
            saveLstRoutes(routes);
            ADMIN.render(container);
          }
        }

        // Delete route
        if(btn.hasAttribute("data-lst-del-route")){
          const rid = btn.getAttribute("data-lst-del-route");
          const ok = await UI.confirm({title:"Delete route", body:"Delete this entire route?", okText:"Delete", cancelText:"Cancel"});
          if(!ok) return;
          const routes = LST_STORE.get().filter(r=>r.id!==rid);
          saveLstRoutes(routes);
          ADMIN.render(container);
        }

        // Coords override button inside a segment row
        // Click: pick on map. Shift+Click: enter lat/lng manually.
        if(btn.hasAttribute("data-lst-coords")){
          const key = btn.getAttribute("data-lst-coords"); // from / to
          const segRow = btn.closest("[data-lst-seg-row]");
          if(!segRow) return;
          const [rid, idxStr] = segRow.getAttribute("data-lst-seg-row").split(":");
          const idx = Number(idxStr);
          const routes = LST_STORE.get();
          const r = routes.find(x=>x.id===rid);
          const seg = r?.segments?.[idx];
          if(!seg) return;
          // Shift+click opens the manual modal.
          if(e.shiftKey){
            const cur = seg?.[`${key}Coords`] || null;
            const res = await openCoordsModal({routeId:rid, segIndex:idx, key, current:cur});
            if(res.action === "save"){
              seg[`${key}Coords`] = { lat: res.lat, lng: res.lng };
              saveLstRoutes(routes);
              UI.showToast("Coordinates saved.", "ok");
              ADMIN.render(container);
            }else if(res.action === "clear"){
              delete seg[`${key}Coords`];
              saveLstRoutes(routes);
              UI.showToast("Override cleared.", "ok");
              ADMIN.render(container);
            }
            return;
          }

          // Normal click: pick on map
          __lstPickTarget = { type:'seg', rid, idx, key };
          UI.showToast(`Click on the preview map to pin ${key.toUpperCase()} location. (Shift+Click 📍 for manual coords)`, 'info');
          setLstStatus(`Pick mode: click map to set ${key.toUpperCase()} coords for segment ${idx+1}.`);
          return;
        }

        // Route-level start/end pin (anchors)
        if(btn.hasAttribute('data-lst-route-coords')){
          const key = btn.getAttribute('data-lst-route-coords'); // start/end
          const editor = btn.closest('.lstRouteEditor');
          const rid = editor?.getAttribute('data-lst-route-id');
          if(!rid) return;
          // Shift+click opens manual lat/lng modal.
          if(e.shiftKey){
            const routes = LST_STORE.get();
            const r = routes.find(x=>x.id===rid);
            if(!r) return;
            const cur = r?.[`${key}Coords`] || null;
            const res = await openCoordsModal({routeId:rid, segIndex:-1, key, current:cur});
            if(res.action === 'save'){
              r[`${key}Coords`] = { lat: res.lat, lng: res.lng };
              saveLstRoutes(routes);
              UI.showToast('Coordinates saved.', 'ok');
              ADMIN.render(container);
            }else if(res.action === 'clear'){
              delete r[`${key}Coords`];
              saveLstRoutes(routes);
              UI.showToast('Override cleared.', 'ok');
              ADMIN.render(container);
            }
            return;
          }

          __lstPickTarget = { type:'route', rid, key };
          UI.showToast(`Click on the preview map to pin ${key === 'start' ? 'START' : 'END'} location. (Shift+Click 📍 for manual coords)`, 'info');
          setLstStatus(`Pick mode: click map to set ${key.toUpperCase()} coords.`);
          return;
        }

        // Test segment
        if(btn.hasAttribute("data-lst-test")){
          const [rid, idxStr] = btn.getAttribute("data-lst-test").split(":");
          const idx = Number(idxStr);
          const routes = LST_STORE.get();
          const seg = routes.find(r=>r.id===rid)?.segments?.[idx];
          if(!seg) return;
          setLstStatus("Testing segment…");
          const a = seg.fromCoords ? seg.fromCoords : await geocodePreview(seg.from);
          const b = seg.toCoords ? seg.toCoords : await geocodePreview(seg.to);
          if(!a || !b){
            setLstStatus("Test failed: could not geocode one end. Try making labels more specific (town/county), or set coords with 📍.");
            return;
          }
          setLstStatus(`OK: ${seg.road} — From (${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}) → To (${b.lat.toFixed(5)}, ${b.lng.toFixed(5)})`);
        }
      });
    }

    const addRouteBtn = container.querySelector("#lstAddRouteBtn");
    if(addRouteBtn){
      addRouteBtn.addEventListener("click", async ()=>{
        const body = `
          <div style="display:grid; gap:.6rem">
            <input class="input" id="lstNewTitle" placeholder="Route title">
            <textarea class="input" id="lstNewNotes" rows="2" placeholder="Notes"></textarea>
          </div>
        `;
        const ok = await UI.confirm({title:"Add route", body, okText:"Add", cancelText:"Cancel"});
        if(!ok) return;
        const title = document.querySelector("#lstNewTitle")?.value?.trim() || "New route";
        const notes = document.querySelector("#lstNewNotes")?.value?.trim() || "";
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,60) || `lst-${Date.now()}`;
        const routes = LST_STORE.get();
        routes.unshift({ id, title, notes, segments: [] });
        saveLstRoutes(routes);
        ADMIN.render(container);
      });
    }

    const exportRoutesBtn = container.querySelector("#lstExportRoutesBtn");
    if(exportRoutesBtn){
      exportRoutesBtn.addEventListener("click", ()=>{
        downloadJson("lstRoutes.seed.json", LST_STORE.exportSeed());
        UI.showToast("Routes exported.", "ok");
      });
    }

    const resetRoutesBtn = container.querySelector("#lstResetRoutesBtn");
    if(resetRoutesBtn){
      resetRoutesBtn.addEventListener("click", async ()=>{
        const ok = await UI.confirm({title:"Reset routes", body:"Reset LST routes back to the built-in seed?", okText:"Reset", cancelText:"Cancel"});
        if(!ok) return;
        LST_STORE.reset();
        UI.showToast("Routes reset.", "ok");
        ADMIN.render(container);
      });
    }

    // Gemini import (local API key mode)
    const gemKeyInput = container.querySelector("#lstGeminiKey");
    const gemSaveBtn = container.querySelector("#lstGeminiSaveKey");
    const gemClearBtn = container.querySelector("#lstGeminiClearKey");
    const gemFilesInput = container.querySelector("#lstGeminiFiles");
    const gemPair = container.querySelector("#lstGeminiPair");
    const gemImportBtn = container.querySelector("#lstGeminiImport");
    const gemStatus = container.querySelector("#lstGeminiStatus");

    const setGemStatus = (msg)=>{ if(gemStatus) gemStatus.textContent = msg; };
    if(gemKeyInput){
      const saved = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
      if(saved) gemKeyInput.value = saved;
    }
    if(gemSaveBtn && gemKeyInput){
      gemSaveBtn.addEventListener("click", ()=>{
        const k = gemKeyInput.value.trim();
        if(!k){ UI.showToast("Paste your Gemini API key first.", "danger"); return; }
        localStorage.setItem(GEMINI_KEY_STORAGE, k);
        UI.showToast("Gemini key saved on this device.", "ok");
        setGemStatus("Key saved. Select route sheet images to import.");
      });
    }
    if(gemClearBtn && gemKeyInput){
      gemClearBtn.addEventListener("click", async ()=>{
        const ok = await UI.confirm({title:"Clear Gemini key", body:"Remove the saved Gemini API key from this device?", okText:"Clear", cancelText:"Cancel"});
        if(!ok) return;
        localStorage.removeItem(GEMINI_KEY_STORAGE);
        gemKeyInput.value = "";
        UI.showToast("Gemini key cleared.", "ok");
        setGemStatus("Key cleared.");
      });
    }

    if(gemImportBtn && gemFilesInput){
      gemImportBtn.addEventListener("click", async ()=>{
        const apiKey = (gemKeyInput?.value || localStorage.getItem(GEMINI_KEY_STORAGE) || "").trim();
        if(!apiKey){
          UI.showToast("Paste your Gemini API key first.", "danger");
          return;
        }
        const files = Array.from(gemFilesInput.files || []).sort((a,b)=>a.name.localeCompare(b.name));
        if(!files.length){
          UI.showToast("Select one or more images to import.", "danger");
          return;
        }
        const pairMode = !!gemPair?.checked;
        if(pairMode && (files.length % 2 !== 0)){
          UI.showToast("Pair mode is on: please select an even number of images (page 1 + page 2).", "danger");
          return;
        }

        const ok = await UI.confirm({
          title:"Import routes",
          body:`This will scan ${pairMode ? (files.length/2) : files.length} route sheet${(pairMode?(files.length/2):files.length)===1?"":"s"} and create routes locally on this device. Continue?`,
          okText:"Import",
          cancelText:"Cancel"
        });
        if(!ok) return;

        gemImportBtn.disabled = true;
        try{
          let created = 0;
          const routes = LST_STORE.get();

          const jobs = [];
          if(pairMode){
            for(let i=0;i<files.length;i+=2) jobs.push([files[i], files[i+1]]);
          }else{
            // Single images not recommended; still attempt by sending same image twice.
            for(const f of files) jobs.push([f, f]);
          }

          for(let j=0;j<jobs.length;j++){
            const [p1, p2] = jobs[j];
            setGemStatus(`Scanning ${j+1}/${jobs.length}: ${p1.name}${pairMode?` + ${p2.name}`:""} …`);
            const page1 = await readFileAsDataURL(p1);
            const page2 = await readFileAsDataURL(p2);

            const extracted = await geminiExtractRouteJSON({ apiKey, page1DataUrl: page1, page2DataUrl: page2 });

            const startName = extracted?.journeyStart?.name || "";
            const endName = extracted?.journeyFinish?.name || "";
            const title = `${startName || "Route"} → ${endName || "Destination"}`.trim();

            const newRoute = {
              id: makeRouteId(startName, endName) + `-${Date.now()}-${j}`,
              title,
              notes: extracted?.notes || "",
              startLabel: startName || "",
              startPostcode: normalizePostcode(extracted?.journeyStart?.postcode || ""),
              endLabel: endName || "",
              endPostcode: normalizePostcode(extracted?.journeyFinish?.postcode || ""),
              segments: Array.isArray(extracted?.segments) ? extracted.segments.map(s=>({
                road: (s?.road || "").trim(),
                from: (s?.from || "").trim(),
                to: (s?.to || "").trim(),
                // Optional free-text note captured from instruction-like cells.
                comment: (s?.comment || "").trim(),
                risk: (["L","M","H"].includes(String(s?.risk||"").toUpperCase()) ? String(s.risk).toUpperCase() : "L")
              })).filter(s=>s.road || s.from || s.to || s.comment) : []
            };

            // Normalize sheet-style instruction text so mapping stays reliable:
            // - If a cell is turn-by-turn instruction ("At roundabout take 3rd exit onto A17"),
            //   move it into segment.comment and keep only the road token (A17) for mapping.
            // - If no road token exists, clear the label so the map can fall back to
            //   next segment / journey end.
            try{
              const isInstructionLike = (v)=>{
                const s = String(v||"").trim();
                if(!s) return true;
                if(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i.test(s)) return false; // postcode
                if(/^(at|take|then|turn|continue|bear|keep|follow|exit|slip)\b/i.test(s)) return true;
                if(/\b(roundabout|flyover|1st|2nd|3rd|4th|5th)\b/i.test(s) && /\b(exit|take|onto|into)\b/i.test(s)) return true;
                return false;
              };
              const roadTok = (v)=>{
                const m = String(v||"").match(/\b([AM]\d{1,3})(?:\s*\/\s*([AM]?\d{1,3}))?\b/i);
                if(!m) return "";
                if(m[2]) return `${m[1].toUpperCase()}/${String(m[2]).toUpperCase()}`;
                return m[1].toUpperCase();
              };

              const noteLines = [];
              for(const seg of newRoute.segments){
                // Clean TO
                if(seg.to && isInstructionLike(seg.to)){
                  const tok = roadTok(seg.to);
                  const instr = seg.to;
                  seg.comment = [seg.comment, instr].filter(Boolean).join(" • ");
                  if(seg.road) noteLines.push(`${seg.road}: ${instr}`);
                  seg.to = tok || "";
                }
                // Clean FROM
                if(seg.from && isInstructionLike(seg.from)){
                  const tok = roadTok(seg.from);
                  const instr = seg.from;
                  seg.comment = [seg.comment, instr].filter(Boolean).join(" • ");
                  if(seg.road) noteLines.push(`${seg.road} (from): ${instr}`);
                  seg.from = tok || "";
                }
              }
              if(noteLines.length){
                const extra = noteLines.slice(0, 25).join("\n");
                newRoute.notes = [newRoute.notes, extra].filter(Boolean).join("\n");
              }
            }catch(_e){ /* ignore */ }

            // Anchor the first/last segment to the journey start/end (helps routing stay in the right area).
            try{
              const spc = newRoute.startPostcode;
              const epc = newRoute.endPostcode;
              if(newRoute.segments.length){
                const first = newRoute.segments[0];
                const last = newRoute.segments[newRoute.segments.length-1];
                if(spc && newRoute.startLabel && !/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i.test(first.from)){
                  first.from = `${newRoute.startLabel} ${spc}`.trim();
                }
                if(epc && newRoute.endLabel && !/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i.test(last.to)){
                  last.to = `${newRoute.endLabel} ${epc}`.trim();
                }
              }
            }catch(_e){ /* ignore */ }

            if(!newRoute.segments.length){
              console.warn("Gemini extracted no segments", extracted);
              setGemStatus(`Warning: ${p1.name} produced no segments (skipped).`);
              continue;
            }

            routes.unshift(newRoute);
            created++;

            // Gentle pacing to avoid rate limits
            await new Promise(r=>setTimeout(r, 250));
          }

          LST_STORE.save(routes);
          UI.showToast(`Imported ${created} route${created===1?"":"s"}.`, "ok");
          setGemStatus(`Done. Imported ${created} route${created===1?"":"s"}.`);
          ADMIN.render(container);
        }catch(err){
          console.error(err);
          UI.showToast("Import failed. Check console for details.", "danger");
          setGemStatus(`Import failed: ${err?.message || err}`);
        }finally{
          gemImportBtn.disabled = false;
        }
      });
    }

    // Ensure any thumbnails that use data-media="idb:..." resolve in admin lists
    // (Locations list + recent edits + submissions thumbs)
    try{ MediaStore.hydrate(container); }catch(_e){ /* ignore */ }

    container.querySelectorAll("[data-edit-dest]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const id = b.dataset.editDest;
        const all = DB.getDestinations() || [];
        const d = all.find(x=>x.id===id);
        if(!d) return;

        // Build facilities checkboxes
        const facSet = new Set(d.facilities||[]);
        const facHtml = FACILITIES.map(f=>`
          <label class="checkRow">
            <input type="checkbox" value="${escapeHtml(f)}" ${facSet.has(f)?"checked":""}>
            <span>${escapeHtml(f)}</span>
          </label>
        `).join("");

        // Photos UI
        const photos = Array.isArray(d.photos) ? d.photos.slice() : [];
        const photosHtml = photos.map((ph,idx)=>`
          <div class="photoRow" data-photo-idx="${idx}">
            <img src="${escapeHtml(ph.url||"assets/images/placeholders/entrance-1.png")}" alt="">
            <input class="input" data-caption value="${escapeHtml(ph.caption||"Photo")}" placeholder="Caption">
            <button class="btn btn-ghost" data-remove-photo="${idx}">Remove</button>
          </div>
        `).join("");

        const body = `
          <div class="adminEditForm">
            <div class="field">
              <div class="label">Name</div>
              <input class="input" id="e_name" value="${escapeHtml(d.name||"")}">
            </div>

            <div class="field">
              <div class="label">Address</div>
              <input class="input" id="e_address" value="${escapeHtml(d.address||"")}">
              <div class="small">Tip: keep it like “Street, Town, Postcode”.</div>
            </div>

            <div class="row2">
              <div class="field">
                <div class="label">Category</div>
                <input class="input" id="e_category" value="${escapeHtml(d.category||"")}">
              </div>
              <div class="field">
                <div class="label">Hours</div>
                <div class="small" style="margin-top:-.15rem">Set opening times by day. If all days are 24h, it will save as <b>24/7</b>.</div>
                <div class="hoursGrid" id="e_hoursGrid"></div>
              </div>
            </div>

            <div class="field">
              <div class="label">Average tip time</div>
              <div class="dd" id="avgTipDD">
                <button class="input ddBtn" type="button" id="e_avgTipBtn"></button>
                <div class="ddMenu" id="e_avgTipMenu"></div>
                <input type="hidden" id="e_avgTipTime">
              </div>
            </div>

            <div class="row2">
              <div class="field">
                <div class="label">Latitude</div>
                <input class="input" id="e_lat" inputmode="decimal" value="${d.lat ?? ""}">
              </div>
              <div class="field">
                <div class="label">Longitude</div>
                <input class="input" id="e_lon" inputmode="decimal" value="${d.lon ?? ""}">
              </div>
            </div>

            <div class="field">
              <div class="label">Gate / entry info</div>
              <textarea class="input" id="e_gate" rows="3">${escapeHtml(d.gateInfo||"")}</textarea>
            </div>

            <div class="field">
              <div class="label">Notes</div>
              <textarea class="input" id="e_notes" rows="3">${escapeHtml(d.notes||"")}</textarea>
            </div>

            <div class="field">
              <div class="label">Facilities</div>
              <div class="checks">${facHtml}</div>
            </div>

            <div class="field">
              <div class="label">Photos</div>
              <div class="small">Main image is used on cards. You can replace each photo individually.</div>

              <div class="mainPhoto">
                <img id="e_mainImg" data-media="${escapeHtml((photos[0]?.url)||"assets/images/placeholders/entrance-1.png")}" src="assets/images/placeholders/entrance-1.png" alt="">
                <div style="display:grid; gap:.5rem">
                  <div class="small" style="opacity:.9">Main image</div>
                  <button class="btn btn-ghost" type="button" id="e_mainPickBtn">Choose image</button>
                  <div class="small" id="e_mainPickName" style="opacity:.75">No file chosen</div>
                  <input id="e_mainUpload" type="file" accept="image/*" style="display:none">
                </div>
              </div>

              <div class="hr" style="margin:.9rem 0; opacity:.35"></div>

              <div style="display:flex; justify-content:space-between; align-items:end; gap:.6rem">
                <div>
                  <div class="small" style="opacity:.9">Additional photos</div>
                  <div class="small" style="opacity:.7">Caption + Replace + Remove.</div>
                </div>
                <button class="btn btn-ghost" type="button" id="e_addPhotoSlot">Add photo</button>
              </div>

              <div class="photosList" id="e_photosList"></div>
            </div>

            <div class="field">
              <div class="label">Tags</div>
              <input class="input" id="e_tags" value="${escapeHtml((d.tags||[]).join(", "))}" placeholder="comma separated">
            </div>
          </div>
        `;

        // open modal (custom overlay) so we can handle file uploads inside
        const overlay = document.createElement("div");
        overlay.className = "modalOverlay";
        overlay.innerHTML = `
          <div class="modal" style="max-width: 720px">
            <div class="modalHeader">
              <div class="h2">Edit destination</div>
              <div class="small" style="margin-top:.2rem">Update details, facilities and photos.</div>
            </div>
            <div class="modalBody">${body}</div>
            <div class="modalFooter">
              <button class="btn btn-ghost" id="cancelEdit">Cancel</button>
              <button class="btn btn-primary" id="saveEdit">Save changes</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        document.body.classList.add("modal-open");

        const close = ()=>{ overlay.remove(); document.body.classList.remove("modal-open"); };
        overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(); });
        // Prevent scrolling the page behind the modal
        overlay.addEventListener("wheel", (e)=>{ e.preventDefault(); }, {passive:false});
        overlay.addEventListener("touchmove", (e)=>{ e.preventDefault(); }, {passive:false});
        // Allow scrolling inside the modal body
        const modalBody = overlay.querySelector(".modalBody");

        // Hours editor (Mon–Sun)
        const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
        const hoursGrid = overlay.querySelector("#e_hoursGrid");
        const existingHours = (d.hours||"").trim();
        const initAll24 = /24\s*\/\s*7|24\s*-\s*7|open\s*24/i.test(existingHours);

        function renderHoursGrid(){
          if(!hoursGrid) return;
          hoursGrid.innerHTML = DAYS.map((day,i)=>`
            <div class="hoursRow" data-day="${day}">
              <div class="day">${day}</div>
              <label class="pill"><input type="checkbox" class="chk24" ${initAll24?"checked":""}> 24h</label>
              <label class="pill"><input type="checkbox" class="chkClosed"> Closed</label>
              <input type="time" class="tOpen" value="${initAll24?"00:00":""}" ${initAll24?"disabled":""}>
              <span class="to">–</span>
              <input type="time" class="tClose" value="${initAll24?"23:59":""}" ${initAll24?"disabled":""}>
            </div>
          `).join("");

          hoursGrid.querySelectorAll(".hoursRow").forEach(row=>{
            const chk24 = row.querySelector(".chk24");
            const chkClosed = row.querySelector(".chkClosed");
            const tOpen = row.querySelector(".tOpen");
            const tClose = row.querySelector(".tClose");

            const sync = ()=>{
              if(chkClosed.checked){
                chk24.checked = false;
                tOpen.disabled = true; tClose.disabled = true;
                tOpen.value = ""; tClose.value = "";
                return;
              }

    const recentClear = container.querySelector("#recentClear");
    if(recentClear){
      recentClear.addEventListener("click", ()=>{
        localStorage.removeItem(HGV_ADMIN_RECENT);
        ADMIN.render(container);
      });
    }
              if(chk24.checked){
                chkClosed.checked = false;
                tOpen.disabled = true; tClose.disabled = true;
                tOpen.value = "00:00"; tClose.value = "23:59";
              }else{
                tOpen.disabled = false; tClose.disabled = false;
                if(!tOpen.value) tOpen.value = "06:00";
                if(!tClose.value) tClose.value = "18:00";
              }
            };

            chk24.addEventListener("change", sync);
            chkClosed.addEventListener("change", sync);
            sync();
          });
        }

        function buildHoursString(){
          if(!hoursGrid) return existingHours || "Hours unknown";
          const rows = Array.from(hoursGrid.querySelectorAll(".hoursRow"));
          const dayStates = rows.map(r=>{
            const day = r.dataset.day;
            const is24 = r.querySelector(".chk24").checked;
            const isClosed = r.querySelector(".chkClosed").checked;
            const open = r.querySelector(".tOpen").value;
            const close = r.querySelector(".tClose").value;
            return {day, is24, isClosed, open, close};
          });

          // If every day 24h -> 24/7
          if(dayStates.every(d=>d.is24)) return "24/7";

          return dayStates.map(d=>{
            if(d.isClosed) return `${d.day} Closed`;
            if(d.is24) return `${d.day} 24h`;
            const o = d.open || "??:??";
            const c = d.close || "??:??";
            return `${d.day} ${o}–${c}`;
          }).join("; ");
        }

        renderHoursGrid();

        // Themed dropdown for Average tip time
        const ddBtn = overlay.querySelector("#e_avgTipBtn");
        const ddMenu = overlay.querySelector("#e_avgTipMenu");
        const ddVal = overlay.querySelector("#e_avgTipTime");
        const initial = (d.avgTipTime||"").trim() || "Unknown";
        ddVal.value = initial === "Unknown" ? "" : initial;

        function setDD(v){
          ddVal.value = v === "Unknown" ? "" : v;
          ddBtn.textContent = v;
          Array.from(ddMenu.querySelectorAll(".ddItem")).forEach(it=>{
            it.classList.toggle("active", it.dataset.value===v);
          });
        }

        ddMenu.innerHTML = ["Unknown", ...AVG_TIP_TIME_OPTIONS].map(v=>`
          <div class="ddItem" data-value="${escapeHtml(v)}">${escapeHtml(v)}</div>
        `).join("");
        ddMenu.querySelectorAll(".ddItem").forEach(it=>{
          it.addEventListener("click", ()=>{
            const v = it.dataset.value;
            setDD(v);
            ddMenu.classList.remove("open");
          });
        });

        ddBtn.addEventListener("click", ()=>{
          ddMenu.classList.toggle("open");
        });

        overlay.addEventListener("click", (e)=>{
          if(!overlay.querySelector("#avgTipDD")?.contains(e.target)){
            ddMenu.classList.remove("open");
          }
        });

        setDD(initial);


        if(modalBody){
          modalBody.addEventListener("wheel", (e)=>{ e.stopPropagation(); }, {passive:true});
          modalBody.addEventListener("touchmove", (e)=>{ e.stopPropagation(); }, {passive:true});
        }
        overlay.querySelector("#cancelEdit").addEventListener("click", close);

        // handle remove photo
        const listEl = overlay.querySelector("#e_photosList");

        // Persist photo changes immediately (so picking/replacing images doesn't get "lost")
        // even if the modal is closed before pressing Save.
        const persistPhotosOnly = ()=>{
          try{
            const allNow = DB.getDestinations() || [];
            const i = allNow.findIndex(x=>x.id===id);
            if(i>=0){
              allNow[i] = {...allNow[i], photos};
              DB.saveDestinations(allNow);
            }
          }catch(_e){ /* ignore */ }
        };

        const setImgResolved = async (imgEl, rawUrl)=>{
          if(!imgEl) return;
          imgEl.setAttribute("data-media", rawUrl || "");
          imgEl.src = "assets/images/placeholders/entrance-1.png";
          MediaStore.hydrate(imgEl.parentElement || imgEl);
        };

        const renderPhotos = ()=>{
          // Ensure we always have a main slot
          if(!Array.isArray(photos)) photos = [];
          if(!photos[0]) photos[0] = {caption:"Main entrance", url:"assets/images/placeholders/entrance-1.png"};

          const extras = photos.slice(1);

          if(extras.length === 0){
            listEl.innerHTML = `<div class="small" style="opacity:.8">No additional photos yet. Tap <b>Add photo</b> to add one.</div>`;
            return;
          }

          listEl.innerHTML = extras.map((ph,offset)=>{
            const idx = offset + 1; // real index in photos[]
            return `
              <div class="photoRow" data-photo-idx="${idx}">
                <button type="button" class="photoPick" data-pick-photo="${idx}" title="Click to choose / replace photo">
                  <img data-media="${escapeHtml(ph.url||"assets/images/placeholders/entrance-1.png")}" src="assets/images/placeholders/entrance-1.png" alt="">
                </button>
                <input class="input" data-caption value="${escapeHtml(ph.caption||"Photo")}" placeholder="Caption">
                <button class="btn btn-ghost" type="button" data-remove-photo="${idx}">Remove</button>
                <input class="input" type="file" accept="image/*" data-file-photo="${idx}" style="display:none">
              </div>
            `;
          }).join("");

          MediaStore.hydrate(listEl);

          // Replace image by clicking the thumbnail (or using the hidden file input)
          listEl.querySelectorAll("[data-pick-photo]").forEach(btn=>{
            btn.addEventListener("click", ()=>{
              const i = Number(btn.dataset.pickPhoto);
              listEl.querySelector(`[data-file-photo="${i}"]`)?.click();
            });
          });

          listEl.querySelectorAll("[data-file-photo]").forEach(inp=>{
            inp.addEventListener("change", async ()=>{
              const file = (inp.files||[])[0];
              if(!file) return;
              const i = Number(inp.dataset.filePhoto);
              try{
                const ref = await MediaStore.saveFile(file);
                if(photos[i]) photos[i].url = ref;
                const rowImg = listEl.querySelector(`.photoRow[data-photo-idx="${i}"] img`);
                await setImgResolved(rowImg, ref);
                persistPhotosOnly();
              }catch{
                UI.showToast("Could not read that image.", "danger");
              }
            });
          });

          // Remove extra photo
          listEl.querySelectorAll("[data-remove-photo]").forEach(btn=>{
            btn.addEventListener("click", ()=>{
              const i = Number(btn.dataset.removePhoto);
              if(i <= 0) return; // never remove main from the extra list
              photos.splice(i,1);
              persistPhotosOnly();
              renderPhotos();
            });
          });

          // Update caption live (persist on blur)
          listEl.querySelectorAll(".photoRow").forEach(row=>{
            const i = Number(row.dataset.photoIdx);
            const cap = row.querySelector("[data-caption]");
            if(!cap) return;
            cap.addEventListener("input", ()=>{
              if(photos[i]) photos[i].caption = cap.value.trim() || "Photo";
            });
            cap.addEventListener("blur", ()=>{
              if(photos[i]) photos[i].caption = cap.value.trim() || "Photo";
              persistPhotosOnly();
            });
          });
        };
        // Main image upload (photos[0])
        const mainUploadEl = overlay.querySelector("#e_mainUpload");
        const mainPickBtn = overlay.querySelector("#e_mainPickBtn");
        const mainPickName = overlay.querySelector("#e_mainPickName");

        if(mainPickBtn && mainUploadEl){
          mainPickBtn.addEventListener("click", ()=>mainUploadEl.click());
        }

        mainUploadEl.addEventListener("change", async (e)=>{
          const file = (e.target.files||[])[0];
          if(!file) return;
          try{
            const ref = await MediaStore.saveFile(file);
            if(!photos.length) photos.push({caption:"Main entrance", url:ref});
            else photos[0].url = ref;
            const img = overlay.querySelector("#e_mainImg");
            await setImgResolved(img, ref);
            if(mainPickName) mainPickName.textContent = file.name;
            persistPhotosOnly();
          }catch{
            UI.showToast("Could not read that image.", "danger");
          }
        });

        
        // Clicking the main image opens the file picker
        const mainImgEl = overlay.querySelector("#e_mainImg");
        if(mainImgEl){
          mainImgEl.style.cursor = "pointer";
          mainImgEl.title = "Click to choose / replace main image";
          mainImgEl.addEventListener("click", ()=>mainUploadEl?.click());
        }

// Add a new extra photo slot
        overlay.querySelector("#e_addPhotoSlot").addEventListener("click", ()=>{
          photos.push({caption:"Photo", url:"assets/images/placeholders/entrance-1.png"});
          persistPhotosOnly();
          renderPhotos();
          // Auto-open picker for the new slot
          const newIdx = photos.length - 1;
          listEl.querySelector(`[data-file-photo="${newIdx}"]`)?.click();
        });

        renderPhotos();

        // hydrate main + any idb: images
        MediaStore.hydrate(overlay);

        overlay.querySelector("#saveEdit").addEventListener("click", ()=>{
          const name = overlay.querySelector("#e_name").value.trim();
          const address = overlay.querySelector("#e_address").value.trim();
          const category = overlay.querySelector("#e_category").value.trim();
          const hours = buildHoursString();
          const avgTipTime = overlay.querySelector("#e_avgTipTime").value.trim();
          const latRaw = overlay.querySelector("#e_lat").value.trim();
          const lonRaw = overlay.querySelector("#e_lon").value.trim();
          const lat = latRaw==="" ? null : Number(latRaw);
          const lon = lonRaw==="" ? null : Number(lonRaw);
          const gateInfo = overlay.querySelector("#e_gate").value.trim();
          const notes = overlay.querySelector("#e_notes").value.trim();
          const tags = overlay.querySelector("#e_tags").value.split(",").map(s=>s.trim()).filter(Boolean).slice(0,8);

          // facilities
          const facilities = Array.from(overlay.querySelectorAll(".checks input[type=checkbox]:checked"))
            .map(i=>i.value).slice(0,24);

          // captions update
          Array.from(listEl.querySelectorAll(".photoRow")).forEach(row=>{
            const idx = Number(row.dataset.photoIdx);
            const cap = row.querySelector("[data-caption]")?.value?.trim() || "Photo";
            if(photos[idx]) photos[idx].caption = cap;
          });
          // Ensure main caption exists
          if(photos[0] && !photos[0].caption) photos[0].caption = "Main entrance";

          if(!name || !address){
            UI.showToast("Name and address are required.", "danger");
            return;
          }
          if((lat!==null && !Number.isFinite(lat)) || (lon!==null && !Number.isFinite(lon))){
            UI.showToast("Lat/Lon must be numbers (or empty).", "danger");
            return;
          }

          const idx = all.findIndex(x=>x.id===id);
          all[idx] = {
            ...d,
            name,
            address,
            category: category || d.category || "Destination",
            hours: hours || d.hours || "Hours unknown",
            avgTipTime,
            lat,
            lon,
            gateInfo,
            notes,
            tags,
            facilities,
            photos
          };
          DB.saveDestinations(all);
          recordRecentEdit(id);
          UI.showToast("Updated.", "ok");
          close();
          ADMIN.render(container);
        });
      });
    });


container.querySelectorAll("[data-delete-dest]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const id = b.dataset.deleteDest;
        const ok = await UI.confirm({title:"Delete destination?", body:`<div class="small">This removes it from local destinations.</div>`, okText:"Delete", cancelText:"Cancel"});
        if(!ok) return;
        const all = DB.getDestinations() || [];
    const locQuery = (container.querySelector("#locSearch")?.value || "").trim();
    const qNorm = locQuery.toUpperCase().replace(/\s+/g,"");
    const list = !locQuery ? all : all.filter(d=>{
      const hay = `${d.name||""} ${d.address||""} ${(d.tags||[]).join(" ")} ${(d.category||"")}`.toUpperCase();
      const hayNoSpace = hay.replace(/\s+/g,"");
      return hay.includes(locQuery.toUpperCase()) || hayNoSpace.includes(qNorm);
    });
        DB.saveDestinations(all.filter(d=>d.id!==id));
        UI.showToast("Deleted.", "ok");
        ADMIN.render(container);
      });
    });

    // Admin tools tab buttons
    const exportBtn = container.querySelector("#exportBtn");
    if(exportBtn){
      exportBtn.addEventListener("click", ()=>{
        const payload = {
          exportedAt: Date.now(),
          destinations: DB.getDestinations() || [],
          submissions: DB.getSubmissions() || []
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "hgv-admin-export.json";
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // Export a file compatible with the app seed (assets/data/destinations.seed.json)
    // so admins can commit/push it to GitHub and ship updates to all users.
    const exportSeedBtn = container.querySelector("#exportSeedBtn");
    if(exportSeedBtn){
      exportSeedBtn.addEventListener("click", ()=>{
        const seed = {
          exportedAt: Date.now(),
          destinations: DB.getDestinations() || []
        };
        const blob = new Blob([JSON.stringify(seed, null, 2)], {type:"application/json"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "destinations.seed.json";
        a.click();
        URL.revokeObjectURL(url);
        UI.showToast("Seed exported (destinations.seed.json)", "ok");
      });
    }
    const importBtn = container.querySelector("#importBtn");
    if(importBtn){
      importBtn.addEventListener("click", async ()=>{
        const ok = await UI.confirm({title:"Import?", body:`<div class="small">This will overwrite local destinations/submissions.</div>`, okText:"Continue", cancelText:"Cancel"});
        if(!ok) return;
        const input = document.createElement("input");
        input.type = "file"; input.accept="application/json";
        input.onchange = async ()=>{
          const file = input.files?.[0];
          if(!file) return;
          try{
            const data = JSON.parse(await file.text());
            if(data.destinations) DB.saveDestinations(data.destinations);
            if(data.submissions) DB.saveSubmissions(data.submissions);
            UI.showToast("Imported. Reloading…", "ok", 1600);
            setTimeout(()=>location.reload(), 900);
          }catch{
            UI.showToast("Import failed.", "danger");
          }
        };
        input.click();
      });
    }
    const resetBtn = container.querySelector("#resetBtn");
    if(resetBtn){
      resetBtn.addEventListener("click", async ()=>{
        const ok = await UI.confirm({title:"Reset local data?", body:`<div class="small">This clears localStorage for this app.</div>`, okText:"Reset", cancelText:"Cancel"});
        if(!ok) return;
        localStorage.clear();
        UI.showToast("Reset done. Reloading…", "ok", 1600);
        setTimeout(()=>location.reload(), 900);
      });
    }

    
    // Admins tab: list admins + reset passwords
    if(tabState.tab === "admins"){
      try{
        const admins = await AUTH.listAdmins();
        const host = container.querySelector("#adminList");
        if(host){
          host.innerHTML = admins.map(a=>`
            <div class="listItem" style="align-items:center">
              <div style="width:44px;height:44px;border-radius:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);display:grid;place-items:center;font-weight:950">
                🛡️
              </div>
              <div style="flex:1; min-width:0">
                <div style="font-weight:950">${a.username}</div>
                <div class="small">Updated: ${new Date(a.updatedAt||a.createdAt).toLocaleString()}</div>
              </div>
              <button class="btn btn-primary" data-reset-admin="${a.username}" style="padding:.55rem .75rem; border-radius:12px">Reset</button>
            </div>
          `).join("");
        }

        container.querySelectorAll("[data-reset-admin]").forEach(b=>{
          b.addEventListener("click", async ()=>{
            const user = b.dataset.resetAdmin;
            const body = `
              <div class="small" style="margin-bottom:.6rem">Set a new password for <b>${user}</b>.</div>
              <div style="display:grid; gap:.6rem">
                <input class="input" id="pw1" type="password" placeholder="New password" autocomplete="new-password">
                <input class="input" id="pw2" type="password" placeholder="Confirm new password" autocomplete="new-password">
              </div>
            `;
            const ok = await UI.confirm({title:"Reset password", body, okText:"Reset", cancelText:"Cancel"});
            if(!ok) return;
            const pw1 = document.querySelector("#pw1")?.value || "";
            const pw2 = document.querySelector("#pw2")?.value || "";
            if(pw1.length < 6){ UI.showToast("Password must be at least 6 characters", "danger"); return; }
            if(pw1 !== pw2){ UI.showToast("Passwords do not match", "danger"); return; }
            await AUTH.resetPassword(user, pw1);
            ADMIN.render(container);
          });
        });

        const changeOwnBtn = container.querySelector("#changeOwnBtn");
        if(changeOwnBtn){
          changeOwnBtn.addEventListener("click", async ()=>{
            await ADMIN._promptChangePassword(container);
          });
        }
      }catch(e){
        console.error(e);
      }
    }

// Review click handlers (same logic as before but single modal step)
    container.querySelectorAll("[data-review]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const subId = btn.dataset.review;
        const all = DB.getSubmissions();
        const sub = all.find(s=>s.id===subId);
        if(!sub) return;
        const p = sub.payload;

        const photos = (p.photos||[]).slice(0,6).map(ph=>`<img src="${ph.dataUrl}" style="width:96px;height:64px;object-fit:cover;border-radius:14px;border:1px solid rgba(255,255,255,.10)">`).join("");
        const body = `
          <div class="card-soft" style="padding:.8rem">
            <div style="font-weight:950">${p.name}</div>
            <div class="small">${p.address}</div>
            <div class="small" style="margin-top:.35rem">Lat/Lon: ${p.lat}, ${p.lon}</div>
            <div class="small" style="margin-top:.35rem"><b>Gate:</b> ${p.gateInfo}</div>
            ${p.notes?`<div class="small" style="margin-top:.35rem"><b>Notes:</b> ${p.notes}</div>`:""}
            ${(p.facilities?.length)?`<div style="margin-top:.5rem; display:flex; gap:.4rem; flex-wrap:wrap">${p.facilities.map(f=>`<span class="badge">✅ ${f}</span>`).join("")}</div>`:""}
          </div>
          ${photos?`<div style="margin-top:.7rem; display:flex; gap:.6rem; flex-wrap:wrap">${photos}</div>`:""}
          <div class="hr" style="margin:.9rem 0"></div>
          <div style="display:flex; gap:.6rem; justify-content:flex-end; flex-wrap:wrap">
            <button class="btn btn-ghost" id="rej">Reject</button>
            <button class="btn btn-primary" id="app">Approve & Publish</button>
          </div>
        `;

        // custom modal overlay so we can handle two buttons inside
        const overlay = document.createElement("div");
        overlay.className = "modalOverlay";
        overlay.innerHTML = `
          <div class="modal">
            <div class="modalHeader">
              <div class="h2">Review submission</div>
              <div class="small" style="margin-top:.2rem">Choose approve or reject.</div>
            </div>
            <div class="modalBody">${body}</div>
          </div>
        `;
        document.body.appendChild(overlay);
        document.body.classList.add("modal-open");
        const close = ()=>{ overlay.remove(); document.body.classList.remove("modal-open"); };
        overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(); });
        // Prevent scrolling the page behind the modal
        overlay.addEventListener("wheel", (e)=>{ e.preventDefault(); }, {passive:false});
        overlay.addEventListener("touchmove", (e)=>{ e.preventDefault(); }, {passive:false});
        // Allow scrolling inside the modal body
        const modalBody = overlay.querySelector(".modalBody");
        if(modalBody){
          modalBody.addEventListener("wheel", (e)=>{ e.stopPropagation(); }, {passive:true});
          modalBody.addEventListener("touchmove", (e)=>{ e.stopPropagation(); }, {passive:true});
        }

        overlay.querySelector("#rej").addEventListener("click", ()=>{
          const all2 = DB.getSubmissions();
          const s2 = all2.find(x=>x.id===subId);
          if(!s2) return close();
          s2.status="rejected";
          DB.saveSubmissions(all2);
          close();
          UI.showToast("Rejected.", "danger");
          ADMIN.render(container);
        });

        overlay.querySelector("#app").addEventListener("click", async ()=>{
          await DEST.ensureLoaded();
          const id = p.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,60) || `dest-${Date.now()}`;
          const dest = {
            id,
            name: p.name,
            address: p.address,
            lat: p.lat,
            lon: p.lon,
            category: "Community",
            hours: p.hours || "Hours unknown",
            avgTipTime: p.avgTipTime || "",
            gateInfo: p.gateInfo,
            facilities: p.facilities || [],
            tags: ["Community"],
            photos: (p.photos||[]).map((ph,i)=>({caption: i===0?"Main entrance":"Photo", url: ph.dataUrl})),
            notes: p.notes || ""
          };
          DEST.upsertDestination(dest);

          const all2 = DB.getSubmissions();
          const s2 = all2.find(x=>x.id===subId);
          if(s2){ s2.status="approved"; DB.saveSubmissions(all2); }
          close();
          UI.showToast("Published to destinations.", "ok");
          ADMIN.render(container);
        });
      });
    });
  }
};