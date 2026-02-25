import { DB } from "./db.js";
import { UI } from "./ui.js";
import { AUTH } from "./auth.js";

const NAV_OPTIONS = [
  {value:"tomtom", label:"TomTom (preferred)"},
  {value:"google", label:"Google Maps"},
  {value:"apple", label:"Apple Maps"}
];
const UNIT_OPTIONS = [
  {value:"mi", label:"Miles (mi)"},
  {value:"km", label:"Kilometres (km)"}
];
const THEME_OPTIONS = [
  {value:"dark", label:"Dark (default)"},
  {value:"light", label:"Light (coming soon)"}
];

export const SETTINGS = {
  render(container){
    const s = DB.getSettings() || { navApp:"tomtom", units:"mi", theme:"dark" };
    const isAdmin = AUTH.isAdmin();

    container.innerHTML = `
      <div style="padding:1rem">
        <div class="card" style="padding:1rem">
          <div class="h1">Settings</div>
          <div class="small" style="opacity:.85;margin-top:.25rem">Build: v28 + Driver Mode + Admin Biometrics</div>
          <div class="small" style="margin-top:.25rem">Set your preferred satnav + app options.</div>

          
            <div class="settingRow">
              <div class="kv">
                <div class="k">Driver mode</div>
                <div class="v">Bigger buttons + simplified layout for driving.</div>
              </div>
              <div class="actions">
                <label class="switch">
                  <input type="checkbox" id="driverModeToggle" ${s.driverMode ? "checked" : ""}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>

            ${isAdmin ? `
            <div class="settingRow">
              <div class="kv">
                <div class="k">Face ID / Biometrics (Admin)</div>
                <div class="v">Require Face ID / fingerprint to enter Admin tools on this device.</div>
              </div>
              <div class="actions" style="display:flex;gap:.5rem;align-items:center;justify-content:flex-end">
                <label class="switch">
                  <input type="checkbox" id="adminBioToggle" ${s.adminBiometric ? "checked" : ""}>
                  <span class="slider"></span>
                </label>
                <button class="btn" id="adminBioEnrollBtn" type="button">Set up</button>
              </div>
            </div>
            ` : ``}
<div class="hr" style="margin:1rem 0"></div>

          <div class="settingsGrid">
            <div class="settingRow">
              <div class="kv">
                <div class="k">Data</div>
                <div class="v">${isAdmin ? "Export/import (backup) or reset local data." : "Reset local data on this device."}</div>
              </div>
              <div style="display:flex; gap:.5rem; flex-wrap:wrap; justify-content:flex-end">
                ${isAdmin ? `
                  <button class="btn btn-ghost" id="exportBtn">Export</button>
                  <button class="btn btn-ghost" id="importBtn">Import</button>
                ` : ``}
                <button class="btn btn-ghost" id="resetBtn">Reset</button>
              </div>
            </div>

            <div class="settingRow">
              <div class="kv">
                <div class="k">About</div>
                <div class="v">HGV Destinations Pro • Prototype build</div>
              </div>
              <button class="btn btn-ghost" id="aboutBtn">View</button>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; margin-top:1rem">
            <button class="btn btn-primary" id="saveBtn">Save settings</button>
          </div>
        </div>
      </div>
    `;


    // Driver mode toggle
    const driverT = container.querySelector("#driverModeToggle");
    if(driverT){
      driverT.addEventListener("change", () => {
        const s2 = DB.getSettings() || {};
        s2.driverMode = !!driverT.checked;
        DB.saveSettings(s2);
        document.body.classList.toggle("driver-mode", !!s2.driverMode);
        UI.showToast(s2.driverMode ? "Driver mode enabled" : "Driver mode disabled", "ok");
      });
    }

    // Admin biometrics (Face ID / fingerprint) toggle + enroll
    const bioT = container.querySelector("#adminBioToggle");
    const bioBtn = container.querySelector("#adminBioEnrollBtn");
    if(bioT){
      bioT.addEventListener("change", () => {
        const s2 = DB.getSettings() || {};
        s2.adminBiometric = !!bioT.checked;
        DB.saveSettings(s2);
        UI.showToast(s2.adminBiometric ? "Biometrics required for Admin" : "Biometrics disabled", "ok");
      });
    }
    if(bioBtn){
      bioBtn.addEventListener("click", async () => {
        try{
          const ok = await AUTH.enrollBiometric();
          if(ok) UI.showToast("Biometrics set up on this device", "ok");
        }catch(e){
          console.error(e);
          UI.showToast("Biometric setup failed", "danger");
        }
      });
    }


    const navApp = container.querySelector("#navApp");
    const units = container.querySelector("#units");
    const theme = container.querySelector("#theme");

    const _el1 = container.querySelector("#saveBtn");
    if(_el1) _el1.addEventListener("click", ()=>{
      const newS = {
        navApp: navApp.value,
        units: units.value,
        theme: theme.value
      };
      DB.saveSettings(newS);
      UI.showToast("Settings saved", "ok");
    });

    const _el2 = container.querySelector("#aboutBtn");
    if(_el2) _el2.addEventListener("click", ()=>{
      UI.modal({
        title: "About",
        body: `<div class="small">
          This is a static prototype. Destinations/submissions are stored locally in your browser.
          <br><br>
          For production: add server storage, real admin auth, and photo hosting.
        </div>`,
        okText: "Close",
        variant: "alert"
      });
    });

    const exportBtn = container.querySelector("#exportBtn");
    if(exportBtn) exportBtn.addEventListener("click", ()=>{
      const payload = {
        exportedAt: Date.now(),
        destinations: DB.getDestinations() || [],
        submissions: DB.getSubmissions() || [],
        settings: DB.getSettings()
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "hgv-destinations-pro-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      UI.showToast("Exported backup file.", "ok");
    });

    const _el3 = container.querySelector("#importBtn");
    if(_el3) _el3.addEventListener("click", async ()=>{
      const ok = await UI.confirm({
        title: "Import backup?",
        body: `<div class="small">This will replace your local destinations/submissions/settings with the backup file.</div>`,
        okText: "Continue",
        cancelText: "Cancel"
      });
      if(!ok) return;

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = async ()=>{
        const file = input.files?.[0];
        if(!file) return;
        try{
          const text = await file.text();
          const data = JSON.parse(text);
          if(data.destinations) DB.saveDestinations(data.destinations);
          if(data.submissions) DB.saveSubmissions(data.submissions);
          if(data.settings) DB.saveSettings(data.settings);
          UI.showToast("Imported successfully. Reloading…", "ok", 1800);
          setTimeout(()=>location.reload(), 900);
        }catch(e){
          UI.showToast("Import failed (invalid file).", "danger");
        }
      };
      input.click();
    });

    const _el4 = container.querySelector("#resetBtn");
    if(_el4) _el4.addEventListener("click", async ()=>{
      const ok = await UI.confirm({
        title: "Reset local data?",
        body: `<div class="small">This clears destinations, submissions and settings stored in this browser.</div>`,
        okText: "Reset",
        cancelText: "Cancel"
      });
      if(!ok) return;
      localStorage.clear();
      UI.showToast("Reset done. Reloading…", "ok", 1800);
      setTimeout(()=>location.reload(), 900);
    });
  }
};
