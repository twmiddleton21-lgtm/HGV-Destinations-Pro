import { DB } from "./db.js";
import { UI } from "./ui.js";
import { uid, escapeHtml } from "./utils.js";

const FACILITY_OPTIONS = [
  "Driver parking","Overnight parking","Restrooms","Showers","Canteen","Vending","Cafe nearby","Security gate","Weighbridge","Fuel nearby"
];

function readFilesAsDataUrls(files){
  const list = Array.from(files || []);
  return Promise.all(list.slice(0,6).map(f => new Promise((res, rej)=>{
    const r = new FileReader();
    r.onload = ()=>res({name:f.name, dataUrl:r.result});
    r.onerror = ()=>rej(new Error("File read failed"));
    r.readAsDataURL(f);
  })));
}

export const SUBMIT = {
  render(container){
    container.innerHTML = `
      <div style="padding:1rem">
        <div class="card" style="padding:1rem">
          <div class="h1">Add new destination</div>
          <div class="small" style="margin-top:.25rem">Fill the template and submit it for admin review.</div>

          <div class="hr" style="margin:1rem 0"></div>

          <div class="formGrid">
            <div>
              <div class="label">Destination name</div>
              <input class="input" id="name" placeholder="e.g., Tesco RDC Daventry">
            </div>

            <div>
              <div class="label">Address</div>
              <input class="input" id="address" placeholder="Street, City, Postcode">
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:.75rem">
              <div>
                <div class="label">Latitude</div>
                <input class="input" id="lat" inputmode="decimal" placeholder="52.1234">
              </div>
              <div>
                <div class="label">Longitude</div>
                <input class="input" id="lon" inputmode="decimal" placeholder="-1.2345">
              </div>
            </div>

            <div>
              <div class="label">Hours</div>
              <input class="input" id="hours" placeholder="Open 24/7, or Mon–Fri 06:00–18:00">
            </div>

            <div>
              <div class="label">Gate info</div>
              <textarea class="input" id="gateInfo" placeholder="Main entrance directions, no-left-turns, where security is, etc."></textarea>
            </div>

            <div>
              <div class="label">Facilities (tick all that apply)</div>
              <div class="checkGrid" id="facilities"></div>
            </div>

            <div>
              <div class="label">Notes (optional)</div>
              <textarea class="input" id="notes" placeholder="Queues, booking refs, tricky turns, height limits, etc."></textarea>
            </div>

            <div class="dropzone">
              <div style="display:flex; justify-content:space-between; gap:.8rem; align-items:center; flex-wrap:wrap">
                <div>
                  <div style="font-weight:900">Photos</div>
                  <div class="small">Add entrance + gate photos (up to 6). They will be submitted for review.</div>
                </div>
                <input type="file" id="photos" accept="image/*" multiple>
              </div>
              <div id="photoPreview" style="margin-top:.75rem; display:flex; gap:.6rem; flex-wrap:wrap"></div>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:.6rem; margin-top:.25rem">
              <button class="btn btn-primary" id="submitBtn">Submit for review</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // facilities
    const facWrap = container.querySelector("#facilities");
    FACILITY_OPTIONS.forEach((f,i)=>{
      const id = `fac_${i}`;
      const el = document.createElement("label");
      el.className = "check";
      el.innerHTML = `<input type="checkbox" id="${id}" value="${escapeHtml(f)}"> <span style="font-weight:800">${escapeHtml(f)}</span>`;
      facWrap.appendChild(el);
    });

    let photoData = [];
    container.querySelector("#photos").addEventListener("change", async (e)=>{
      try{
        photoData = await readFilesAsDataUrls(e.target.files);
        const prev = container.querySelector("#photoPreview");
        prev.innerHTML = photoData.map(p=>`
          <img src="${p.dataUrl}" alt="" style="width:96px;height:64px;object-fit:cover;border-radius:14px;border:1px solid rgba(255,255,255,.10)">
        `).join("");
      }catch(err){
        UI.showToast("Could not read photos", "danger");
      }
    });

    container.querySelector("#submitBtn").addEventListener("click", async ()=>{
      const name = container.querySelector("#name").value.trim();
      const address = container.querySelector("#address").value.trim();
      const lat = Number(container.querySelector("#lat").value.trim());
      const lon = Number(container.querySelector("#lon").value.trim());
      const hours = container.querySelector("#hours").value.trim();
      const gateInfo = container.querySelector("#gateInfo").value.trim();
      const notes = container.querySelector("#notes").value.trim();

      if(!name || !address || !Number.isFinite(lat) || !Number.isFinite(lon) || !gateInfo){
        UI.showToast("Please fill name, address, lat/lon and gate info.", "danger");
        return;
      }

      const facilities = Array.from(facWrap.querySelectorAll("input[type=checkbox]:checked")).map(x=>x.value);

      const submission = {
        id: uid("sub"),
        status: "pending",
        createdAt: Date.now(),
        payload: {
          name, address, lat, lon,
          hours: hours || "Hours unknown",
          gateInfo,
          notes,
          facilities,
          photos: photoData.map((p, idx)=>({caption: idx===0?"Main entrance":"Photo", dataUrl: p.dataUrl}))
        }
      };

      const subs = DB.getSubmissions();
      subs.unshift(submission);
      DB.saveSubmissions(subs);

      UI.showToast("Submitted! An admin will review it.", "ok");
      // Reset
      container.querySelector("#name").value = "";
      container.querySelector("#address").value = "";
      container.querySelector("#lat").value = "";
      container.querySelector("#lon").value = "";
      container.querySelector("#hours").value = "";
      container.querySelector("#gateInfo").value = "";
      container.querySelector("#notes").value = "";
      facWrap.querySelectorAll("input[type=checkbox]").forEach(x=>x.checked=false);
      container.querySelector("#photos").value = "";
      container.querySelector("#photoPreview").innerHTML = "";
      photoData = [];
    });
  }
};
