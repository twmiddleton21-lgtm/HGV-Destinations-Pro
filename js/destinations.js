import { DB } from "./db.js";

export const DEST = {
  state: {
    destinations: [],
    query: "",
    category: "All"
  },
  async ensureLoaded(){
    let data = DB.getDestinations();
    if(!data){
      const seed = await DB.loadSeed();
      data = seed.destinations || [];
      DB.saveDestinations(data);
    }
    DEST.state.destinations = data;
    return data;
  },
  list(){
    const raw = (DEST.state.query || "").trim();
    const q = raw.toLowerCase();
    const qNoSpaceUpper = raw.replace(/\s+/g,"").toUpperCase();
    const cat = DEST.state.category;

    // heuristic: postcode-like if contains both letters and digits and length >= 5
    const looksLikePostcode = (qNoSpaceUpper.length >= 5) && /[A-Z]/.test(qNoSpaceUpper) && /\d/.test(qNoSpaceUpper);

    return DEST.state.destinations
      .filter(d => cat==="All" ? true : (d.category===cat))
      .filter(d => {
        if(!raw) return true;

        const name = (d.name||"").toLowerCase();
        const address = (d.address||"").toLowerCase();
        const tags = (d.tags||[]).join(" ").toLowerCase();
        const notes = (d.notes||"").toLowerCase();
        const category = (d.category||"").toLowerCase();

        const textHit =
          name.includes(q) ||
          address.includes(q) ||
          tags.includes(q) ||
          notes.includes(q) ||
          category.includes(q);

        if(textHit) return true;

        // postcode search without spaces
        if(looksLikePostcode){
          const addrNoSpace = (d.address||"").replace(/\s+/g,"").toUpperCase();
          return addrNoSpace.includes(qNoSpaceUpper);
        }
        return false;
      })
      .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  },
  getById(id){
    return DEST.state.destinations.find(d=>d.id===id) || null;
  },
  upsertDestination(dest){
    const idx = DEST.state.destinations.findIndex(d=>d.id===dest.id);
    if(idx>=0) DEST.state.destinations[idx] = dest;
    else DEST.state.destinations.push(dest);
    DB.saveDestinations(DEST.state.destinations);
  }
};

// Keep the in-memory list in sync when admin tools modify destinations.
// (Admin saves go through DB.saveDestinations which dispatches this event.)
try{
  window.addEventListener('hgv:destinations-changed', () => {
    const latest = DB.getDestinations();
    if(Array.isArray(latest)) DEST.state.destinations = latest;
  });
}catch(_e){ /* ignore */ }
