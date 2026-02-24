// mediaStore.js
// Stores user-uploaded images in IndexedDB to avoid blowing localStorage quota.
// Destinations store only lightweight references like: "idb:<photoId>".

const DB_NAME = "hgv-media";
const DB_VERSION = 1;
const STORE = "photos";

let _dbPromise = null;
let _urlCache = new Map(); // photoId -> objectURL

function openDb(){
  if(_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE)){
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
  return _dbPromise;
}

function makeId(){
  return `ph_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function put(photoId, blob){
  const db = await openDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, photoId);
    tx.oncomplete = ()=>resolve(true);
    tx.onerror = ()=>reject(tx.error);
  });
}

async function get(photoId){
  const db = await openDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(photoId);
    req.onsuccess = ()=>resolve(req.result || null);
    req.onerror = ()=>reject(req.error);
  });
}

export const MediaStore = {
  isIdbUrl(url){
    return typeof url === "string" && url.startsWith("idb:");
  },
  idFromUrl(url){
    return String(url || "").slice(4);
  },

  async saveFile(file){
    const photoId = makeId();
    await put(photoId, file);
    return `idb:${photoId}`;
  },

  async resolveUrl(url){
    if(!MediaStore.isIdbUrl(url)) return url;
    const photoId = MediaStore.idFromUrl(url);
    if(_urlCache.has(photoId)) return _urlCache.get(photoId);
    const blob = await get(photoId);
    if(!blob) return "";
    const objectUrl = URL.createObjectURL(blob);
    _urlCache.set(photoId, objectUrl);
    return objectUrl;
  },

  // Replaces <img data-media="..."></img> with a resolved src.
  hydrate(root){
    const scope = root || document;
    const imgs = scope.querySelectorAll?.("img[data-media]") || [];
    imgs.forEach(img=>{
      const raw = img.getAttribute("data-media") || "";
      if(!raw) return;
      if(!MediaStore.isIdbUrl(raw)){
        img.src = raw;
        return;
      }
      MediaStore.resolveUrl(raw).then(resolved=>{
        if(resolved) img.src = resolved;
      }).catch(()=>{/* ignore */});
    });
  },
};
