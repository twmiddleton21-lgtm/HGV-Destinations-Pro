import { UI } from "./ui.js";
import { DEST } from "./destinations.js";
import { DB } from "./db.js";
import { escapeHtml } from "./utils.js";
import { MediaStore } from "./mediaStore.js";

function buildTomTomUrl(lat, lon, label){
  // Best effort: TomTom deep-linking varies by platform/app.
  // We'll try tomtom:// first; if it fails the user still can use Maps fallback buttons.
  const safeLabel = encodeURIComponent(label || "Destination");
  return `tomtom://navigate?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${safeLabel}`;
}
function buildGoogleMapsUrl(lat, lon){
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
}
function buildAppleMapsUrl(lat, lon){
  return `http://maps.apple.com/?daddr=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
}

export const DEST_VIEW = {
  render(container, {id}){
    const d = DEST.getById(id);
    const hasCoords = Number.isFinite(d?.lat) && Number.isFinite(d?.lon);
    if(!d){
      container.innerHTML = `<div class="card" style="padding:1rem">Destination not found.</div>`;
      return;
    }
    const mainPhoto = d.photos?.[0]?.url || "";
    const settings = DB.getSettings();
    const tomtomUrl = hasCoords ? buildTomTomUrl(d.lat, d.lon, d.name) : null;
    const gmapsUrl = buildGoogleMapsUrl(d.lat, d.lon);
    const amapsUrl = buildAppleMapsUrl(d.lat, d.lon);

    container.innerHTML = `
      <div class="grid2" style="padding: 1rem; gap: 1rem;">
        <section class="card" style="overflow:hidden">
          <div style="height: 220px; position:relative; background: rgba(255,255,255,.05); border-bottom: 1px solid rgba(255,255,255,.10)">
            <button id="destBackBtn" class="btn btn-ghost" type="button" style="position:absolute; top:12px; left:12px; z-index:5; padding:.5rem .7rem; border-radius:14px; backdrop-filter: blur(10px)">← Back</button>
            ${mainPhoto ? `<img data-media="${escapeHtml(mainPhoto)}" src="assets/images/placeholders/entrance-1.png" alt="Entrance photo" style="width:100%;height:100%;object-fit:cover">` : ""}
          </div>
          <div style="padding: 1rem;">
            <div class="h1">${escapeHtml(d.name)}</div>
            <div class="small" style="margin-top:.2rem">${escapeHtml(d.address || "")}</div>
            <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.8rem">
              <span class="badge">📍 ${escapeHtml(d.category || "Destination")}</span>
              <span class="badge">🕒 ${escapeHtml(d.hours || "Hours unknown")}</span>
            </div>

            <div style="display:flex; gap:.6rem; flex-wrap:wrap; margin-top: 1rem">
              <button class="btn btn-primary" id="btnPrimaryNav" ${hasCoords ? "" : "disabled"}>Navigate</button>
              ${hasCoords ? `
              <a class="btn btn-ghost" href="${escapeHtml(gmapsUrl)}" target="_blank" rel="noreferrer">Open in Google Maps</a>
              <a class="btn btn-ghost" href="${escapeHtml(amapsUrl)}" target="_blank" rel="noreferrer">Open in Apple Maps</a>
              ` : `<div class="small" style="opacity:.9">Navigation disabled (coordinates not added yet).</div>`}
            </div>

            <div class="hr" style="margin: 1rem 0"></div>

            <div class="h2">Gate info</div>
            <div class="small" style="margin-top:.35rem">${escapeHtml(d.gateInfo || "—")}</div>

            <div class="h2" style="margin-top: 1rem">Facilities</div>
            <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem">
              ${(d.facilities||[]).map(f=>`<span class="badge">✅ ${escapeHtml(f)}</span>`).join("") || `<span class="badge">—</span>`}
            </div>

            ${d.notes ? `
              <div class="h2" style="margin-top:1rem">Notes</div>
              <div class="small" style="margin-top:.35rem">${escapeHtml(d.notes)}</div>
            ` : ""}

            ${(d.tags?.length) ? `
              <div style="margin-top:1rem; display:flex; gap:.45rem; flex-wrap:wrap">
                ${d.tags.map(t=>`<span class="badge">#${escapeHtml(t)}</span>`).join("")}
              </div>` : ""}
          </div>
        </section>

        <aside class="card-soft" style="padding:1rem">
          <div class="h2">Additional photos</div>
          <div class="small" style="margin-top:.25rem">Tap to view full size.</div>
          <div class="gallery" style="margin-top:.8rem">
            ${(d.photos||[]).slice(0,9).map((p,i)=>`
              <button class="thumb" data-photo="${i}" style="width:100%; height:auto; padding:0; border:none; background:none">
                <img data-media="${escapeHtml(p.url)}" src="assets/images/placeholders/entrance-1.png" alt="${escapeHtml(p.caption||"Photo")}">
              </button>
            `).join("")}
          </div>

          <div class="hr" style="margin: 1rem 0"></div>

          <div class="h2">Coordinates</div>
          <div class="small" style="margin-top:.25rem">${d.lat}, ${d.lon}</div>
        </aside>
      </div>
    `;

    // TomTom attempt: try deep link; if not installed, user stays and can use other buttons.
    const primaryBtn = container.querySelector("#btnPrimaryNav");
    const primary = settings.navApp || "tomtom";
    primaryBtn.textContent = primary==="google" ? "Open in Google Maps" : primary==="apple" ? "Open in Apple Maps" : "Navigate with TomTom";

    primaryBtn.addEventListener("click", ()=>{
      const url = primary==="google" ? gmapsUrl : primary==="apple" ? amapsUrl : tomtomUrl;
      if(!url){ UI.showToast("Coordinates not set for this location yet.", "danger"); return; }
      const w = window.open(url, "_blank");
      if(!w){
        // popup blocked, fallback to same window
        window.location.href = url;
      }
      // also show a helpful message
      UI.showToast(primary==="google"?"Opening Google Maps…":primary==="apple"?"Opening Apple Maps…":"Opening TomTom… If it doesn't open, use the other map buttons.");
    });

    // Back button (prefer browser history; fallback to home)
    const backBtn = container.querySelector("#destBackBtn");
    if(backBtn){
      backBtn.addEventListener("click", ()=>{
        try{
          if(window.history.length > 1) window.history.back();
          else window.location.hash = "#/";
        }catch{
          window.location.hash = "#/";
        }
      });
    }

    container.querySelectorAll("[data-photo]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = Number(btn.dataset.photo);
        const p = d.photos?.[idx];
        if(!p) return;
        UI.modal({
          title: p.caption || "Photo",
          body: `<img data-media="${escapeHtml(p.url)}" src="assets/images/placeholders/entrance-1.png" style="width:100%;border-radius:16px;border:1px solid rgba(255,255,255,.10)" alt="">`,
          okText: "Close",
          variant: "alert"
        });

        // hydrate inside modal
        try{ MediaStore.hydrate(document.body); }catch(_e){ /* ignore */ }
      });
    });

    // hydrate any idb: images
    MediaStore.hydrate(container);
  }
};
