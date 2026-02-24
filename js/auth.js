import { CONFIG } from "./config.js";
import { DB } from "./db.js";
import { UI } from "./ui.js";

async function sha256(text){
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b=>b.toString(16).padStart(2,"0")).join("");
}

function now(){ return Date.now(); }

async function ensureAdminStore(){
  let admins = DB.getAdmins();
  if(admins && admins.length) return admins;

  const username = CONFIG.DEFAULT_ADMIN?.username || "admin";
  const password = CONFIG.DEFAULT_ADMIN?.password || "admin123";
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b=>b.toString(16).padStart(2,"0")).join("");
  const hash = await sha256(`${saltHex}:${password}`);

  admins = [{
    id: "admin-1",
    username,
    passwordHash: hash,
    salt: saltHex,
    createdAt: now(),
    updatedAt: now(),
    mustChange: false
  }];

  DB.saveAdmins(admins);
  return admins;
}


// DEFAULT_ADMIN_BOOTSTRAP
async function ensureDefaultAdmin(){
  let admins = DB.getAdmins();
  if(admins && admins.length) return;

  const enc = new TextEncoder();
  const saltArr = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(saltArr).map(b=>b.toString(16).padStart(2,"0")).join("");

  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${salt}:admin123`));
  const hash = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,"0")).join("");

  admins = [{
    id: "admin-1",
    username: "admin",
    passwordHash: hash,
    salt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mustChange: false
  }];

  DB.saveAdmins(admins);
}

export const AUTH = {
  async ensure(){
    await ensureDefaultAdmin();
    await ensureAdminStore();
  },
  isAdmin(){
    const s = DB.getAdminSession();
    if(!s) return false;
    return (Date.now() - s.ts) < (12*60*60*1000);
  },
  currentAdmin(){
    const s = DB.getAdminSession();
    return s?.username || null;
  },
  async login(username, password){
    await ensureAdminStore();
    const admins = DB.getAdmins() || [];
    const u = (username||"").trim().toLowerCase();
    const admin = admins.find(a => (a.username||"").toLowerCase() === u);
    if(!admin){
      UI.showToast("Unknown username", "danger");
      return {ok:false};
    }
    const hash = await sha256(`${admin.salt}:${password}`);
    if(hash !== admin.passwordHash){
      UI.showToast("Incorrect password", "danger");
      return {ok:false};
    }
    DB.setAdminSession({ts: Date.now(), username: admin.username});
    UI.showToast("Admin mode enabled", "ok");
    return {ok:true, mustChange: !!admin.mustChange, username: admin.username};
  },
  logout(){
    DB.clearAdminSession();
    UI.showToast("Logged out");
  },

  // Admin management
  async listAdmins(){
    await ensureAdminStore();
    return DB.getAdmins() || [];
  },

  async resetPassword(targetUsername, newPassword){
    await ensureAdminStore();
    if(!AUTH.isAdmin()){
      UI.showToast("Admin login required", "danger");
      return false;
    }
    const admins = DB.getAdmins() || [];
    const u = (targetUsername||"").trim().toLowerCase();
    const idx = admins.findIndex(a => (a.username||"").toLowerCase() === u);
    if(idx < 0){
      UI.showToast("Admin not found", "danger");
      return false;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt).map(b=>b.toString(16).padStart(2,"0")).join("");
    admins[idx].salt = saltHex;
    admins[idx].passwordHash = await sha256(`${saltHex}:${newPassword}`);
    admins[idx].updatedAt = now();
    admins[idx].mustChange = true;
    DB.saveAdmins(admins);
    UI.showToast(`Password reset for ${admins[idx].username}`, "ok");
    return true;
  },

  async changeOwnPassword(oldPassword, newPassword){
    await ensureAdminStore();
    if(!AUTH.isAdmin()){
      UI.showToast("Admin login required", "danger");
      return false;
    }
    const username = AUTH.currentAdmin();
    const admins = DB.getAdmins() || [];
    const idx = admins.findIndex(a => a.username === username);
    if(idx < 0) return false;

    const admin = admins[idx];
    const oldHash = await sha256(`${admin.salt}:${oldPassword}`);
    if(oldHash !== admin.passwordHash){
      UI.showToast("Old password incorrect", "danger");
      return false;
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt).map(b=>b.toString(16).padStart(2,"0")).join("");
    admins[idx].salt = saltHex;
    admins[idx].passwordHash = await sha256(`${saltHex}:${newPassword}`);
    admins[idx].updatedAt = now();
    admins[idx].mustChange = false;
    DB.saveAdmins(admins);
    UI.showToast("Password updated", "ok");
    return true;
  }
};
