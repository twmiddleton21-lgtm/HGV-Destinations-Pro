// bridgesStore.js
// Stores low bridge data in IndexedDB (to avoid localStorage quota).
// Each record: { id, lat, lng, name, road, maxheight_raw, height_m, height_ft, height_in, source, updatedAt }

const DB_NAME = "hgv-bridges";
const DB_VERSION = 1;
const STORE = "bridges";

let _dbPromise = null;

function openDb(){
  if(_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE)){
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("updatedAt", "updatedAt", { unique:false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function txDone(tx){
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const BridgesStore = {
  async putMany(items){
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    for(const it of items){
      try{ os.put(it); }catch(_e){}
    }
    await txDone(tx);
    return true;
  },
  async getAll(){
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const os = tx.objectStore(STORE);
    const req = os.getAll();
    const res = await new Promise((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error);
    });
    await txDone(tx);
    return res;
  },
  async clear(){
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
    return true;
  },
  async count(){
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    const res = await new Promise((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result||0);
      req.onerror=()=>reject(req.error);
    });
    await txDone(tx);
    return res;
  }
};
