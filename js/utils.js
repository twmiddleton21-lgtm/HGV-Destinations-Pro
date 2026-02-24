export function uid(prefix="id"){
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
export function clamp(n, a, b){return Math.min(b, Math.max(a,n));}
export function debounce(fn, ms=250){
  let t=null;
  return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
}
export function safeJsonParse(str, fallback){
  try{ return JSON.parse(str); }catch{ return fallback; }
}
export function fmtDistanceKm(km){
  if(km == null || Number.isNaN(km)) return "";
  return km < 1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`;
}
export function escapeHtml(s=""){
  return s.replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
