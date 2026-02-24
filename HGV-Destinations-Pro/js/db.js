import { CONFIG } from "./config.js";
import { safeJsonParse } from "./utils.js";

function get(key, fallback){
  return safeJsonParse(localStorage.getItem(key), fallback);
}
function set(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

export const DB = {
  async loadSeed(){
    const res = await fetch(CONFIG.DATA_URL, {cache:"no-store"});
    if(!res.ok) throw new Error("Seed data failed to load.");
    return await res.json();
  },
  getDestinations(){
    const d = get(CONFIG.STORAGE_KEYS.DESTINATIONS, null);
    return Array.isArray(d) ? d : null;
  },
  saveDestinations(destinations){
    set(CONFIG.STORAGE_KEYS.DESTINATIONS, destinations);
    // Broadcast a change so other modules (search/admin) can refresh in-memory caches
    // without requiring a full page reload.
    try{
      window.dispatchEvent(new CustomEvent('hgv:destinations-changed'));
    }catch(_e){ /* ignore */ }
  },
  
  
  getAdmins(){
    const a = get(CONFIG.STORAGE_KEYS.ADMINS, null);
    return Array.isArray(a) ? a : null;
  },
  saveAdmins(admins){
    set(CONFIG.STORAGE_KEYS.ADMINS, admins);
  },
  getSettings(){
    const def = {
      navApp: "tomtom", // tomtom | google | apple
      units: "mi",      // mi | km
      theme: "dark"     // dark | light (light placeholder)
    };
    const s = get(CONFIG.STORAGE_KEYS.SETTINGS, def);
    // If localStorage contains "null" or invalid structure, fall back to defaults
    if(!s || typeof s !== "object") return def;
    return {...def, ...s};
  },
  saveSettings(settings){
    set(CONFIG.STORAGE_KEYS.SETTINGS, settings);
  },
  getSubmissions(){
    const s = get(CONFIG.STORAGE_KEYS.SUBMISSIONS, []);
    return Array.isArray(s) ? s : [];
  },
  saveSubmissions(subs){
    set(CONFIG.STORAGE_KEYS.SUBMISSIONS, subs);
  },
  getAdminSession(){
    return get(CONFIG.STORAGE_KEYS.ADMIN_SESSION, null);
  },
  setAdminSession(session){
    set(CONFIG.STORAGE_KEYS.ADMIN_SESSION, session);
  },
  clearAdminSession(){
    localStorage.removeItem(CONFIG.STORAGE_KEYS.ADMIN_SESSION);
  },
  getFavourites(){
    const f = get(CONFIG.STORAGE_KEYS.FAVOURITES, []);
    return Array.isArray(f) ? f : [];
  },
  saveFavourites(favs){
    set(CONFIG.STORAGE_KEYS.FAVOURITES, Array.isArray(favs) ? favs : []);
  },

};
