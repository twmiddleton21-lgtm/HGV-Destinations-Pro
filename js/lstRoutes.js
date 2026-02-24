import { UI } from "./ui.js";

// LST permitted routes (seeded from the provided Route Plans & Risk Assessment sheets).
//
// We draw the route lines by:
//  1) Geocoding each segment's "From" and "To" label to a lat/lng using Nominatim (cached locally)
//  2) Requesting a routed polyline from OSRM so the line follows roads (cached locally)
//
// This keeps the dataset small and editable while still showing full road-following routes.

const SEED_ROUTES = [
  {
    id: "turners-newmarket-bickers-yard",
    title: "Turners Newmarket → Bickers Yard",
    notes: "High risk: trailer swing oncoming traffic when turning left into yard.",
    segments: [
      { road: "Turners Newmarket", from: "Landwade Rd, Newmarket", to: "A142, Newmarket", risk: "L" },
      { road: "A142", from: "A142, Newmarket", to: "A142/A10, Ely", risk: "L" },
      { road: "A10", from: "A142/A10, Ely", to: "A10/A17, King's Lynn", risk: "L" },
      { road: "A17", from: "A10/A17, King's Lynn", to: "A17/A52, near Grantham", risk: "L" },
      { road: "A52", from: "A17/A52, near Grantham", to: "Bickers Yard", risk: "H" }
    ]
  },
  {
    id: "turners-newmarket-rdc-via-m6",
    title: "Turners Newmarket → RDC (via A14/M6/M1)",
    notes: "High risk: turning right onto A14 slip road (vehicles from behind). Medium: trailer position swing on M6 roundabout (4th exit). Medium: trailer swing when turning right into RDC.",
    segments: [
      { road: "Turners Newmarket", from: "Landwade Rd, Newmarket", to: "A14 slip road from A142, Newmarket", risk: "H" },
      { road: "A14", from: "A14 slip road from A142, Newmarket", to: "A14/A1 junction", risk: "L" },
      { road: "A14", from: "A14/A1 junction", to: "M6", risk: "L" },
      { road: "M6", from: "M6", to: "M6 Junction 1 (A426)", risk: "L" },
      { road: "M6 Roundabout", from: "M6 Junction 1 (A426)", to: "M6 (4th exit)", risk: "M" },
      { road: "M6", from: "M6 (4th exit)", to: "M6/M1", risk: "L" },
      { road: "M1", from: "M6/M1", to: "M1 Junction 14 (A4428)", risk: "L" },
      { road: "A4428", from: "M1 Junction 14 (A4428)", to: "Dockham Way roundabout", risk: "L" },
      { road: "Dockham Way", from: "Dockham Way roundabout", to: "RDC", risk: "M" }
    ]
  }
];

const LS_KEYS = {
  routes: "hgv.lst.routes",
  geocode: "hgv.lst.geocodeCache",
  osrm: "hgv.lst.osrmCache",
  selected: "hgv.lst.selectedRouteIds",
  ui: "hgv.lst.ui"
};

// Bump this when geocoding logic changes so old cached points don't keep producing bad routes.
const GEOCODE_CACHE_VERSION = 2;

// UK-ish bounds used to validate user-entered overrides and protect against
// accidental world-spanning routes caused by ambiguous labels.
const UK_BOUNDS = { minLat: 49.8, maxLat: 60.95, minLng: -8.65, maxLng: 1.8 };

function inUkBounds(lat, lng){
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= UK_BOUNDS.minLat && lat <= UK_BOUNDS.maxLat
    && lng >= UK_BOUNDS.minLng && lng <= UK_BOUNDS.maxLng;
}

function readJSON(key, fallback){
  try{
    const v = localStorage.getItem(key);
    if(!v) return fallback;
    return JSON.parse(v);
  }catch(_e){
    return fallback;
  }
}

function writeJSON(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(_e){ /* ignore */ }
}

function riskColor(risk){
  if(risk === "H") return "#ef4444";
  if(risk === "M") return "#f59e0b";
  return "#22c55e";
}

function riskLabel(risk){
  if(risk === "H") return "High";
  if(risk === "M") return "Medium";
  return "Low";
}

function haversineMetersSimple(a, b){
  const toRad = (deg) => (deg * Math.PI) / 180;
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

// Many route sheets include turn-by-turn instructions in the "To" column
// (e.g. "At roundabout take 3rd exit onto A17"). These are useful as notes
// but are not reliable geocoding targets. We treat these as instructions,
// extract any road token for mapping, and otherwise fall back to the next
// segment/route endpoint.
function isInstructionLikeLabel(v){
  const s = String(v || "").trim();
  if(!s) return true;
  // Contains a postcode? treat as a real place anchor.
  if(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i.test(s)) return false;
  // Starts with instruction words.
  if(/^(at|take|then|turn|continue|bear|keep|follow|exit|slip)\b/i.test(s)) return true;
  // Common phrases.
  if(/\b(roundabout|flyover|1st|2nd|3rd|4th|5th)\b/i.test(s) && /\b(exit|take|onto|into)\b/i.test(s)) return true;
  return false;
}

function extractRoadToken(v){
  const s = String(v || "");
  const m = s.match(/\b([AM]\d{1,3})(?:\s*\/\s*([AM]?\d{1,3}))?\b/i);
  if(!m) return "";
  // If we captured A17/A47 style, keep as "A17/A47".
  if(m[2]) return `${m[1].toUpperCase()}/${String(m[2]).toUpperCase()}`;
  return m[1].toUpperCase();
}

function isRoadOnlyLabel(v){
  const s = String(v || "").trim();
  if(!s) return false;
  // Exact road token only (optionally with slash). No extra context.
  return /^[AM]\d{1,3}(?:\s*\/\s*[AM]?\d{1,3})?$/i.test(s);
}

function effectiveLabelForEndpoint(route, segs, i, key){
  const seg = segs[i];
  const raw = String(seg?.[key] ?? "").trim();
  // Road-only labels (e.g. "A17", "M6", "A17/A47") are too ambiguous to geocode.
  // Treat them as non-anchors so we fall back to a nearby place/postcode or pinned coords.
  if(isRoadOnlyLabel(raw)) return "";
  if(!isInstructionLikeLabel(raw)) return raw;

  // If instruction text contains a road token, use that as the anchor.
  const tok = extractRoadToken(raw);
  if(tok) return tok;

  // If this is the last segment "to" endpoint, prefer the route end label/postcode.
  if(key === "to" && i === segs.length - 1){
    return String(route?.endPostcode || route?.endLabel || "").trim() || raw;
  }
  // If this is the first segment "from" endpoint, prefer the route start label/postcode.
  if(key === "from" && i === 0){
    return String(route?.startPostcode || route?.startLabel || "").trim() || raw;
  }

  // Otherwise fall back to neighbouring segment labels.
  if(key === "to" && i + 1 < segs.length){
    const nextFrom = String(segs[i+1]?.from ?? "").trim();
    const nextTok = extractRoadToken(nextFrom) || extractRoadToken(segs[i+1]?.road);
    return (!isInstructionLikeLabel(nextFrom) && nextFrom) ? nextFrom : (nextTok || String(segs[i+1]?.road || "").trim() || raw);
  }
  if(key === "from" && i - 1 >= 0){
    const prevTo = String(segs[i-1]?.to ?? "").trim();
    const prevTok = extractRoadToken(prevTo) || extractRoadToken(segs[i-1]?.road);
    return (!isInstructionLikeLabel(prevTo) && prevTo) ? prevTo : (prevTok || String(segs[i-1]?.road || "").trim() || raw);
  }

  return raw;
}

async function geocodePlace(label, hint){
  const cache = readJSON(LS_KEYS.geocode, {});
  if(cache && cache.__v !== GEOCODE_CACHE_VERSION){
    // Reset cache when logic changes.
    try{ localStorage.removeItem(LS_KEYS.geocode); }catch(_e){ /* ignore */ }
  }
  const freshCache = (cache && cache.__v === GEOCODE_CACHE_VERSION) ? cache : { __v: GEOCODE_CACHE_VERSION };
  const k = String(label || "").trim().toLowerCase();
  if(!k) throw new Error("Missing geocode label");
  if(freshCache[k]){
    const c = freshCache[k];
    if(inUkBounds(c?.lat, c?.lng)){
      return c;
    }
    // purge bad cached entries from older versions
    try{ delete freshCache[k]; writeJSON(LS_KEYS.geocode, freshCache); }catch(_e){ /* ignore */ }
  }

  // NOTE: Nominatim frequently blocks browser requests from localhost (CORS) and
  // rate-limits aggressively (429). We use Photon (Komoot) instead which supports
  // CORS for browser apps and works well for UK place/postcode lookups.
  // https://photon.komoot.io/
  const UK_BBOX = "-8.6500,49.8000,1.8000,60.9500"; // west,south,east,north

  // tiny throttle to reduce accidental burst rate-limits when many segments are selected
  await new Promise(r=>setTimeout(r, 220));

  const normalizeQ = (q) => {
    const s = String(q || "").trim();
    if(!s) return s;
    // Improve matching for typical sheet shorthand.
    return s
      .replace(/[\/]/g, " ")
      .replace(/\bnear\b/gi, " ")
      .replace(/\bJn\b/gi, "Junction")
      .replace(/\bJnc\b/gi, "Junction")
      .replace(/\bRdbt\b/gi, "Roundabout")
      .replace(/\bR\/A\b/gi, "Roundabout")
      .replace(/\s{2,}/g, " ");
  };

  const tryFetch = async(q) => {
    const qq = normalizeQ(q);
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(qq)}&limit=5&bbox=${UK_BBOX}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } }).catch(()=>null);
    if(!res || !res.ok) return null;
    const data = await res.json().catch(()=>null);
    const feats = data?.features;
    if(!Array.isArray(feats) || !feats.length) return null;
    const candidates = feats.filter(f=>{
      const c = f?.geometry?.coordinates;
      const lng = Number(c?.[0]);
      const lat = Number(c?.[1]);
      return inUkBounds(lat, lng);
    });

    if(!candidates.length) return null;

    // If we have a hint (previous endpoint), pick the closest candidate.
    if(hint && Number.isFinite(hint.lat) && Number.isFinite(hint.lng)){
      let best = candidates[0];
      let bestD = Infinity;
      for(const f of candidates){
        const c = f?.geometry?.coordinates;
        const pt = { lat: Number(c?.[1]), lng: Number(c?.[0]) };
        const d = haversineMetersSimple(hint, pt);
        if(d < bestD){ bestD = d; best = f; }
      }
      // Safety: if the best match is still far away from our hint, reject it.
      // This prevents "A14"/"M6" style labels jumping to a different region and
      // making the route span huge distances.
      const MAX_HINT_DISTANCE_M = 120_000; // 120km
      if(bestD > MAX_HINT_DISTANCE_M) return null;
      return best;
    }

    return candidates[0];
  };

  // First try: add UK bias, then raw. (Photon bbox already constrains)
  const hit = await tryFetch(`${label}, UK`) || await tryFetch(label);
  if(!hit) throw new Error(`No match for: ${label}`);

  const c = hit?.geometry?.coordinates;
  const out = {
    lat: Number(c?.[1]),
    lng: Number(c?.[0]),
    displayName: hit?.properties?.name || hit?.properties?.label || label
  };

  // Hard safety check to stop routes drawing across the world.
  if(!inUkBounds(out.lat, out.lng)){
    throw new Error(`Geocode out of UK bounds for: ${label}`);
  }
  freshCache[k] = out;
  writeJSON(LS_KEYS.geocode, freshCache);
  return out;
}

function resolveOverride(coords){
  const lat = Number(coords?.lat);
  const lng = Number(coords?.lng);
  if(inUkBounds(lat, lng)) return { lat, lng, displayName: "Override" };
  return null;
}

async function resolveEndpoint(seg, key, hint, labelOverride){
  // Supports optional admin-entered coordinate overrides:
  //   seg.fromCoords = {lat, lng}
  //   seg.toCoords   = {lat, lng}
  const override = resolveOverride(seg?.[`${key}Coords`]);
  if(override) return override;
  const raw = String(labelOverride ?? seg?.[key] ?? "").trim();
  // If label missing/empty, fall back to hint if we have one.
  if(!raw){
    if(hint && Number.isFinite(hint.lat) && Number.isFinite(hint.lng)) return hint;
    throw new Error("Missing geocode label");
  }
  return await geocodePlace(raw, hint);
}

async function osrmRoute(from, to){
  const cache = readJSON(LS_KEYS.osrm, {});
  const k = `${from.lng.toFixed(6)},${from.lat.toFixed(6)}|${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  if(cache[k]){
    const coords = cache[k];
    const looksSane = Array.isArray(coords) && coords.length >= 2 && coords.every(c=>Array.isArray(c) && c.length>=2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if(looksSane){
      // Basic sanity bounds (UK-ish). If it's wildly outside, drop it.
      let minLat=90,maxLat=-90,minLng=180,maxLng=-180;
      for(const c of coords){
        const lng = c[0];
        const lat = c[1];
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
      }
      const within = (minLat > 45 && maxLat < 62 && minLng > -12 && maxLng < 5);
      if(within) return coords;
    }
    try{ delete cache[k]; writeJSON(LS_KEYS.osrm, cache); }catch(_e){ /* ignore */ }
  }

  // small throttle to reduce 429s when drawing many segments
  await new Promise(r=>setTimeout(r, 180));
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  // OSRM public demo is usually reliable, but can be rate-limited/offline.
  // If routing fails we gracefully fall back to a straight line so the UI still works.
  const res = await fetch(url, { headers: { "Accept": "application/json" } }).catch(()=>null);
  if(!res || !res.ok) return null;
  const data = await res.json().catch(()=>null);
  const coords = data?.routes?.[0]?.geometry?.coordinates;
  if(!Array.isArray(coords) || coords.length < 2) return null;
  cache[k] = coords;

  // Keep cache bounded to avoid unbounded localStorage growth.
  const keys = Object.keys(cache);
  if(keys.length > 250){
    for(let i=0;i<50;i++) delete cache[keys[i]];
  }
  writeJSON(LS_KEYS.osrm, cache);
  return coords;
}

let __lstMap = null;
let __routeLayer = null;
let __loading = false;

// User location (LST map)
let __lstUserLayer = null;
let __lstGeoWatchId = null;
let __lstFollowUser = false;
let __lstUserMarker = null;
let __lstUserCircle = null;
let __lstLastRawPos = null;
let __lstLastSmoothPos = null;
let __lstLastHeadingDeg = null;

function destroyMap(){
  if(__lstMap){
    try{ __lstMap.remove(); }catch(_e){ /* ignore */ }
  }
  __lstMap = null;
  __routeLayer = null;

  __lstUserLayer = null;
  __lstUserMarker = null;
  __lstUserCircle = null;
  __lstFollowUser = false;
  __lstLastRawPos = null;
  __lstLastSmoothPos = null;
  __lstLastHeadingDeg = null;
  if(__lstGeoWatchId != null && navigator.geolocation){
    try{ navigator.geolocation.clearWatch(__lstGeoWatchId); }catch(_e){ /* ignore */ }
  }
  __lstGeoWatchId = null;
}

function initLstUserLocation(){
  if(!__lstMap || !__lstUserLayer) return;
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
    __lstLastHeadingDeg = deg;
    const el = __lstUserMarker?._icon?.querySelector?.(".user-location-heading");
    if(el) el.style.transform = `rotate(${deg}deg)`;
  }

  function smoothPosition(raw){
    if(!__lstLastSmoothPos) return raw;

    const dist = haversineMeters(__lstLastSmoothPos, raw);
    const acc = Number.isFinite(raw.acc) ? raw.acc : 50;
    const prevAcc = __lstLastRawPos?.acc ?? acc;

    // reject tiny jitter when accuracy worsens
    if(dist < 6 && acc > prevAcc + 10) return __lstLastSmoothPos;

    // Alpha: 0.15 (smooth) .. 0.75 (snappy)
    const alpha = clamp(1 - (acc / 120), 0.15, 0.75);
    return {
      lat: __lstLastSmoothPos.lat + (raw.lat - __lstLastSmoothPos.lat) * alpha,
      lng: __lstLastSmoothPos.lng + (raw.lng - __lstLastSmoothPos.lng) * alpha,
      acc: raw.acc
    };
  }

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
    __lstLastRawPos = raw;
    __lstLastSmoothPos = { lat: sm.lat, lng: sm.lng };

    if(Number.isFinite(raw.acc) && raw.acc > 0){
      if(__lstUserCircle){
        __lstUserCircle.setLatLng([sm.lat, sm.lng]).setRadius(raw.acc);
      }else{
        __lstUserCircle = L.circle([sm.lat, sm.lng], {
          radius: raw.acc,
          weight: 1,
          fillOpacity: 0.12
        }).addTo(__lstUserLayer);
      }
    }

    if(__lstUserMarker){
      __lstUserMarker.setLatLng([sm.lat, sm.lng]);
    }else{
      __lstUserMarker = L.marker([sm.lat, sm.lng], {
        keyboard:false,
        icon: userLocationIcon,
        zIndexOffset: 1000
      }).addTo(__lstUserLayer);
      __lstUserMarker.bindPopup(`<b>Your location</b><br>${sm.lat.toFixed(5)}, ${sm.lng.toFixed(5)}`);
    }

    const nativeHeading = Number.isFinite(raw.heading) ? raw.heading : null;
    let head = nativeHeading;
    if(head == null && lastSmoothForBearing && __lstLastSmoothPos){
      const moved = haversineMeters(lastSmoothForBearing, __lstLastSmoothPos);
      if(moved > 8) head = bearingDeg(lastSmoothForBearing, __lstLastSmoothPos);
    }
    if(head != null) applyHeading(head);
    lastSmoothForBearing = __lstLastSmoothPos;

    if(__lstFollowUser && __lstMap && __lstLastSmoothPos){
      __lstMap.panTo([__lstLastSmoothPos.lat, __lstLastSmoothPos.lng], { animate:true, duration:0.6 });
    }
  };

  // Start watching.
  try{
    __lstGeoWatchId = navigator.geolocation.watchPosition(
      renderPos,
      ()=>{},
      { enableHighAccuracy:true, maximumAge:2000, timeout:15000 }
    );
  }catch(_e){
    // ignore
  }
}

function ensureSeedRoutes(){
  const existing = readJSON(LS_KEYS.routes, null);
  if(existing && Array.isArray(existing) && existing.length) return existing;
  writeJSON(LS_KEYS.routes, SEED_ROUTES);
  return SEED_ROUTES;
}

function buildLegend(){
  return `
    <div class="lstLegend">
      <div class="lstLegendRow"><span class="lstLegendSwatch" style="background:${riskColor("L")}"></span> Low</div>
      <div class="lstLegendRow"><span class="lstLegendSwatch" style="background:${riskColor("M")}"></span> Medium</div>
      <div class="lstLegendRow"><span class="lstLegendSwatch" style="background:${riskColor("H")}"></span> High</div>
    </div>
  `;
}

async function drawRoutesOnMap({routeIds}){
  if(!__lstMap || !__routeLayer) return;
  if(__loading) return;
  __loading = true;

  const status = document.getElementById("lstStatus");
  const setStatus = (t)=>{ if(status) status.textContent = t; };

  try{
    __routeLayer.clearLayers();

    const all = ensureSeedRoutes();
    const routes = all.filter(r => routeIds.includes(r.id));
    if(!routes.length){
      setStatus("Select a route to display.");
      return;
    }

    setStatus("Building routes… (first load can take a moment)");

    const bounds = [];

    const toRad = (deg)=> (deg * Math.PI) / 180;
    const haversineKm = (a, b)=>{
      const R = 6371;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const lat1 = toRad(a.lat);
      const lat2 = toRad(b.lat);
      const s1 = Math.sin(dLat/2);
      const s2 = Math.sin(dLng/2);
      const h = s1*s1 + Math.cos(lat1)*Math.cos(lat2)*s2*s2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };

    for(const r of routes){
      // Use previous resolved endpoint as a "hint" to keep ambiguous lookups near the correct area.
      // This prevents some junction-style labels (A14/A1, M6 Jn 1, etc.) from resolving to the wrong UK location.
      let prev = null;

      // If routes include start/end metadata (from the Gemini importer), use it as the initial anchor.
      // This makes the first geocode far more reliable and reduces UK-wide jumps.
      const startAnchorLabel = (r.startPostcode || r.startLabel || "").trim();
      if(startAnchorLabel){
        try{
          if(r.startCoords && inUkBounds(r.startCoords.lat, r.startCoords.lng)){
            prev = { lat: Number(r.startCoords.lat), lng: Number(r.startCoords.lng) };
          }else{
            prev = await geocodePlace(startAnchorLabel, null);
          }
        }catch(_e){
          prev = null;
        }
      }
      let failedSegments = 0;
      const segs = Array.isArray(r.segments) ? r.segments : [];

      const nextAnchorLabel = (idx)=>{
        // Prefer an upcoming segment label that contains a postcode or looks like a place.
        for(let k=idx+1;k<segs.length;k++){
          const a = String(segs[k]?.from||"").trim();
          const b = String(segs[k]?.to||"").trim();
          const pick = (v)=>{
            if(!v) return "";
            if(isRoadOnlyLabel(v)) return "";
            if(!isInstructionLikeLabel(v)) return v;
            // If instruction text includes a postcode, keep it.
            if(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i.test(v)) return v;
            return "";
          };
          const p1 = pick(a);
          if(p1) return p1;
          const p2 = pick(b);
          if(p2) return p2;
        }
        return String(r.endPostcode || r.endLabel || "").trim();
      };

      for(let i=0; i<segs.length; i++){
        const seg = segs[i];
        try{
          let coords = null;
          let latlngs = null;

          // If admin stored exact routed geometry (via "Snap to road" drawing), use it directly.
          if(Array.isArray(seg?.geometry) && seg.geometry.length >= 2){
            coords = seg.geometry;
            latlngs = coords.map(c => [c[1], c[0]]);
            // Update hint for next segment.
            const last = coords[coords.length - 1];
            const lng = Number(last?.[0]);
            const lat = Number(last?.[1]);
            if(inUkBounds(lat, lng)) prev = { lat, lng };
          }else{
            // Normalize labels for mapping. Many sheets place turn-by-turn instructions
            // in the "To" column (e.g. "At roundabout take 3rd exit onto A17").
            // Those should not be used for geocoding; instead we extract a road token
            // or fall back to the next segment / route endpoint.
            const fromLabel = effectiveLabelForEndpoint(r, segs, i, "from");
            let toLabel = effectiveLabelForEndpoint(r, segs, i, "to");
            if(!toLabel) toLabel = nextAnchorLabel(i);

            setStatus(`Geocoding: ${(fromLabel||"(chain)")} → ${(toLabel||"(next)")}`);
            // Anchor chaining:
            // - Prefer previous segment end as the FROM point (this keeps segments connected)
            // - If we don't yet have a previous point, resolve FROM using either the segment label or route start.
            const looksLikeRoadOnly = (v)=>{
              const s = String(v||"").trim();
              if(!s) return true;
              return /^[AM]\d+\b/i.test(s) || /^A\d+\/?A?\d*\b/i.test(s) || /^M\d+\b/i.test(s) || /\bJn\b/i.test(s);
            };

            // Prefer pinned coords if present.
            let a = prev;
            if(!a){
              if(seg.fromCoords && inUkBounds(seg.fromCoords.lat, seg.fromCoords.lng)){
                a = { lat:Number(seg.fromCoords.lat), lng:Number(seg.fromCoords.lng) };
              }else if(fromLabel && !looksLikeRoadOnly(fromLabel)){
                a = await geocodePlace(fromLabel, null);
              }
            }

            if(!a) throw new Error('Missing geocode label');

            // Resolve TO near the FROM point.
            const b = (seg.toCoords && inUkBounds(seg.toCoords.lat, seg.toCoords.lng))
              ? { lat:Number(seg.toCoords.lat), lng:Number(seg.toCoords.lng) }
              : (toLabel ? await geocodePlace(toLabel, a) : null);
            if(!b || !inUkBounds(b.lat, b.lng)) throw new Error(`Bad endpoint for: ${seg.road}`);

            // Guardrail: reject wildly long jumps (usually a bad geocode).
            const km = haversineKm(a, b);
            if(km > 180) throw new Error(`Unrealistic segment jump (${km.toFixed(0)}km)`);

            // Only advance the chain when TO resolved.
            prev = b;

            setStatus(`Routing: ${seg.road}`);
            coords = await osrmRoute(a, b);
            latlngs = coords
              ? coords.map(c => [c[1], c[0]])
              : [[a.lat, a.lng], [b.lat, b.lng]];
          }
          latlngs.forEach(ll => bounds.push(ll));

          const line = L.polyline(latlngs, {
            color: riskColor(seg.risk),
            weight: 6,
            opacity: 0.9,
            // If routing failed, show a subtle dashed line to indicate fallback.
            dashArray: coords ? null : "10 10"
          }).addTo(__routeLayer);

          line.bindPopup(`
            <div style="font-weight:900">${r.title}</div>
            <div class="small" style="margin-top:.25rem">${seg.road}</div>
            <div class="small" style="margin-top:.25rem"><b>${riskLabel(seg.risk)}</b> risk</div>
            <div class="small" style="margin-top:.25rem">${seg.from} → ${seg.to}</div>
            ${seg.comment ? `<div class="small muted" style="margin-top:.25rem">${seg.comment}</div>` : ""}
            ${coords ? "" : "<div class=\"small muted\" style=\"margin-top:.25rem\">(Offline / routing unavailable — straight-line fallback)</div>"}
          `);
        }catch(e){
          console.warn("LST segment failed", r?.id, seg?.road, e);
          // Continue drawing remaining segments instead of failing the whole map.
          failedSegments++;
        }
      }

      // Fallback: if one or more segments failed, draw a single route from Journey Start → Journey End
      // so the user always sees *something* while admins can pin/fix ambiguous segments.
      if(failedSegments > 0){
        try{
          const start = (r.startCoords && inUkBounds(r.startCoords.lat, r.startCoords.lng))
            ? { lat:Number(r.startCoords.lat), lng:Number(r.startCoords.lng) }
            : await geocodePlace((r.startPostcode || r.startLabel || '').trim(), null);

          const end = (r.endCoords && inUkBounds(r.endCoords.lat, r.endCoords.lng))
            ? { lat:Number(r.endCoords.lat), lng:Number(r.endCoords.lng) }
            : await geocodePlace((r.endPostcode || r.endLabel || '').trim(), start);

          if(start && end && inUkBounds(start.lat, start.lng) && inUkBounds(end.lat, end.lng)){
            setStatus(`Fallback routing: ${r.title}`);
            const coords = await osrmRoute(start, end);
            const latlngs = coords ? coords.map(c=>[c[1], c[0]]) : [[start.lat,start.lng],[end.lat,end.lng]];
            latlngs.forEach(ll => bounds.push(ll));
            const line = L.polyline(latlngs, {
              color: '#9aa0a6',
              weight: 5,
              opacity: 0.6,
              dashArray: coords ? '10 10' : '6 10'
            }).addTo(__routeLayer);
            line.bindPopup(`
              <div style="font-weight:900">${r.title}</div>
              <div class="small" style="margin-top:.25rem"><b>Fallback</b> start → end (some segments need review)</div>
              <div class="small muted" style="margin-top:.25rem">Admin tip: use 📍 pick-on-map to pin ambiguous FROM/TO points.</div>
            `);
          }
        }catch(_e){ /* ignore */ }
      }
    }

    if(bounds.length){
      __lstMap.fitBounds(bounds, { padding:[18,18] });
      setStatus("Ready.");
    }else{
      setStatus("No segments could be drawn (check internet access for geocoding/routing). ");
    }
  }catch(e){
    console.error(e);
    setStatus("Couldn’t build routes. This map needs internet access (OpenStreetMap + OSRM). ");
  }finally{
    __loading = false;
  }
}

function initLstMap(){
  const mapEl = document.getElementById("lstMap");
  if(!mapEl) return;
  if(!window.L){
    mapEl.innerHTML = '<div class="small" style="padding:1rem">Map unavailable offline.</div>';
    return;
  }

  destroyMap();
  __lstMap = L.map(mapEl, { zoomControl:true }).setView([54.2,-2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(__lstMap);
  __routeLayer = L.layerGroup().addTo(__lstMap);
  __lstUserLayer = L.layerGroup().addTo(__lstMap);
  initLstUserLocation();

  // Draw only what the user has selected. Default: nothing (prevents massive geocode bursts).
  const savedSel = readJSON(LS_KEYS.selected, []);
  const selected = Array.isArray(savedSel) ? savedSel : [];
  drawRoutesOnMap({routeIds:selected});

  const centreBtn = document.getElementById("centreLstMapBtn");
  if(centreBtn){
    centreBtn.onclick = () => {
      try{
        const b = __routeLayer.getBounds?.();
        if(b && b.isValid && b.isValid()){
          __lstMap.fitBounds(b, { padding:[18,18] });
        }else{
          __lstMap.setView([54.2,-2.5], 6);
        }
      }catch(_e){
        __lstMap.setView([54.2,-2.5], 6);
      }
    };
  }

  const locateBtn = document.getElementById("locateMeLstBtn");
  if(locateBtn){
    locateBtn.onclick = () => {
      __lstFollowUser = !__lstFollowUser;
      locateBtn.classList.toggle("active", __lstFollowUser);
      if(__lstLastSmoothPos){
        __lstMap.panTo([__lstLastSmoothPos.lat, __lstLastSmoothPos.lng], { animate:true, duration:0.6 });
        if(__lstMap.getZoom() < 14) __lstMap.setZoom(14);
      }
    };
  }

  // Hooked by the routes list renderer (below).
}

export const LST = {
  render(container){
    const routes = ensureSeedRoutes();

    const uiState = readJSON(LS_KEYS.ui, { q:"", page:1, pageSize:10 });
    const q0 = String(uiState?.q || "");
    const page0 = Math.max(1, Number(uiState?.page || 1));
    const pageSize0 = Math.min(50, Math.max(10, Number(uiState?.pageSize || 10)));

    const selectedSet = new Set((readJSON(LS_KEYS.selected, []) || []).filter(Boolean));

    const routeHaystack = (r) => {
      const segText = Array.isArray(r?.segments) ? r.segments.map(s=>`${s.road||""} ${s.from||""} ${s.to||""}`).join(" ") : "";
      return [
        r?.title,
        r?.notes,
        r?.startLabel,
        r?.startPostcode,
        r?.endLabel,
        r?.endPostcode,
        segText
      ].filter(Boolean).join(" ").toLowerCase();
    };

    const allWithHay = routes.map(r=>({ r, hay: routeHaystack(r) }));

    const filterRoutes = (query) => {
      const qq = String(query||"").trim().toLowerCase();
      if(!qq) return allWithHay.map(x=>x.r);
      return allWithHay.filter(x=>x.hay.includes(qq)).map(x=>x.r);
    };

    container.innerHTML = UI.card({
      title: "LST Routes",
      subtitle: "Permitted routes (from Route Plans & Risk Assessment sheets).",
      right: `<button class="btn btn-ghost" id="centreLstMapBtn">Centre</button>`,
      body: `
        <div class="card-soft" style="padding:1rem">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem">
            <div>
              <div class="h3" style="margin:0">Map</div>
              <div class="small">Lines are coloured by risk rating (L/M/H).</div>
            </div>
            ${buildLegend()}
          </div>
          <div class="mapWrap" style="margin-top:.75rem">
            <div class="favMapWrap">
              <div id="lstMap" class="map"></div>
              <button class="locateFab" id="locateMeLstBtn" title="Locate me">
                <span class="locateFabIcon" aria-hidden="true">◎</span>
              </button>
            </div>
          </div>
          <div class="small muted" id="lstStatus" style="margin-top:.6rem">Loading…</div>
          <div class="small muted" style="margin-top:.5rem">
            This map uses Photon (place/postcode search) + OSRM routing to draw road-following lines (cached on this device).
          </div>
        </div>

        <div class="card-soft goldGlow" style="padding:1rem; margin-top:1rem">
          <div class="h3" style="margin:0">Routes</div>
          <div class="small" style="margin-top:.25rem">Search by place name or postcode. Select one or more routes to display.</div>

          <div style="display:flex; gap:.75rem; align-items:center; margin-top:.75rem; flex-wrap:wrap">
            <input class="input" id="lstRouteSearch" placeholder="Search place or postcode…" value="${q0.replace(/"/g, '&quot;')}">
            <button class="btn btn-ghost" id="lstRouteClearBtn">Clear</button>

            <div class="small muted" style="margin-left:auto">Page size</div>
            <select class="input" id="lstPageSize" style="width:110px">
              ${[10,20,30,40,50].map(n=>`<option value="${n}" ${n===pageSize0?"selected":""}>${n}</option>`).join("")}
            </select>
          </div>

          <div style="display:flex; gap:.75rem; align-items:center; justify-content:space-between; margin-top:.75rem; flex-wrap:wrap">
            <div class="small muted" id="lstRouteCount"></div>
            <div style="display:flex; gap:.5rem; align-items:center">
              <button class="btn btn-ghost" id="lstSelectAllBtn">Select all</button>
              <button class="btn btn-ghost" id="lstDeselectAllBtn">Deselect all</button>
              <button class="btn" id="lstPrevBtn">Prev</button>
              <button class="btn" id="lstNextBtn">Next</button>
            </div>
          </div>

          <div class="lstRouteList" id="lstRouteResults" style="margin-top:.75rem"></div>
        </div>
      `
    });

    const renderResults = () => {
      const q = String(document.getElementById("lstRouteSearch")?.value || "");
      const pageSize = Math.min(50, Math.max(10, Number(document.getElementById("lstPageSize")?.value || 10)));
      const all = filterRoutes(q);
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      let page = Math.max(1, Math.min(pages, Number(readJSON(LS_KEYS.ui, {}).page || page0)));

      const start = (page - 1) * pageSize;
      const items = all.slice(start, start + pageSize);

      const countEl = document.getElementById("lstRouteCount");
      if(countEl){
        const shown = items.length;
        countEl.textContent = total ? `Showing ${start+1}-${start+shown} of ${total}` : "No routes";
      }

      const list = document.getElementById("lstRouteResults");
      if(list){
        list.innerHTML = items.map(r=>{
          const checked = selectedSet.has(r.id);
          const sub = r?.notes || "";
          return `
            <label class="lstRouteToggle">
              <input type="checkbox" data-lst-route="${r.id}" ${checked?"checked":""}>
              <div style="min-width:0">
                <div class="lstRouteTitleOneLine">${r.title}</div>
                <div class="small" style="margin-top:.15rem">${sub}</div>
              </div>
            </label>
          `;
        }).join("") || `<div class="small muted" style="padding:.75rem">Search for results</div>`;

        // hook checkboxes
        Array.from(list.querySelectorAll("input[data-lst-route]")).forEach(ch=>{
          ch.addEventListener("change", ()=>{
            const id = ch.dataset.lstRoute;
            if(ch.checked) selectedSet.add(id);
            else selectedSet.delete(id);
            writeJSON(LS_KEYS.selected, Array.from(selectedSet));
            drawRoutesOnMap({ routeIds: Array.from(selectedSet) });
          });
        });
      }

      const ui = { q, page, pageSize };
      writeJSON(LS_KEYS.ui, ui);

      // enable/disable paging
      const prevBtn = document.getElementById("lstPrevBtn");
      const nextBtn = document.getElementById("lstNextBtn");
      if(prevBtn) prevBtn.disabled = page <= 1;
      if(nextBtn) nextBtn.disabled = page >= pages;

      // Wire paging (idempotent)
      if(prevBtn && !prevBtn.__wired){
        prevBtn.__wired = true;
        prevBtn.addEventListener("click", ()=>{
          const cur = readJSON(LS_KEYS.ui, ui);
          writeJSON(LS_KEYS.ui, { ...cur, page: Math.max(1, (cur.page||1) - 1) });
          renderResults();
        });
      }
      if(nextBtn && !nextBtn.__wired){
        nextBtn.__wired = true;
        nextBtn.addEventListener("click", ()=>{
          const cur = readJSON(LS_KEYS.ui, ui);
          writeJSON(LS_KEYS.ui, { ...cur, page: (cur.page||1) + 1 });
          renderResults();
        });
      }

      // Select all / deselect all (current page)
      const selAll = document.getElementById("lstSelectAllBtn");
      const desAll = document.getElementById("lstDeselectAllBtn");
      if(selAll && !selAll.__wired){
        selAll.__wired = true;
        selAll.addEventListener("click", ()=>{
          for(const r of items) selectedSet.add(r.id);
          writeJSON(LS_KEYS.selected, Array.from(selectedSet));
          renderResults();
          drawRoutesOnMap({ routeIds: Array.from(selectedSet) });
        });
      }
      if(desAll && !desAll.__wired){
        desAll.__wired = true;
        desAll.addEventListener("click", ()=>{
          for(const r of items) selectedSet.delete(r.id);
          writeJSON(LS_KEYS.selected, Array.from(selectedSet));
          renderResults();
          drawRoutesOnMap({ routeIds: Array.from(selectedSet) });
        });
      }
    };

    setTimeout(()=>{
      initLstMap();
      renderResults();

      const search = document.getElementById("lstRouteSearch");
      const clearBtn = document.getElementById("lstRouteClearBtn");
      const pageSizeSel = document.getElementById("lstPageSize");
      if(search){
        let t = null;
        search.addEventListener("input", ()=>{
          if(t) clearTimeout(t);
          t = setTimeout(()=>{
            const cur = readJSON(LS_KEYS.ui, {});
            writeJSON(LS_KEYS.ui, { ...cur, q: search.value, page: 1 });
            renderResults();
          }, 120);
        });
      }
      if(clearBtn){
        clearBtn.addEventListener("click", ()=>{
          if(search) search.value = "";
          const cur = readJSON(LS_KEYS.ui, {});
          writeJSON(LS_KEYS.ui, { ...cur, q: "", page: 1 });
          renderResults();
        });
      }
      if(pageSizeSel){
        pageSizeSel.addEventListener("change", ()=>{
          const cur = readJSON(LS_KEYS.ui, {});
          writeJSON(LS_KEYS.ui, { ...cur, pageSize: Number(pageSizeSel.value||10), page: 1 });
          renderResults();
        });
      }
    }, 0);
  }
};

// Admin + other modules can use this lightweight store API.
// We intentionally keep the persisted schema simple:
//  {
//    id, title, notes,
//    segments: [{road, from, to, risk, fromCoords?, toCoords?}]
//  }
export const LST_STORE = {
  seed(){
    return JSON.parse(JSON.stringify(SEED_ROUTES));
  },
  get(){
    return ensureSeedRoutes();
  },
  save(routes){
    if(!Array.isArray(routes)) return;
    writeJSON(LS_KEYS.routes, routes);
  },
  reset(){
    writeJSON(LS_KEYS.routes, JSON.parse(JSON.stringify(SEED_ROUTES)));
  },
  exportSeed(){
    return {
      exportedAt: new Date().toISOString(),
      routes: ensureSeedRoutes()
    };
  }
};

// Minimal map/routing helpers exported for admin preview tooling.
// These use the same caches and UK safety checks as the public LST map.
export const LST_UTILS = {
  riskColor,
  riskLabel,
  inUkBounds,
  resolveEndpoint,
  osrmRoute
};
