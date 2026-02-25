import { uid } from "./utils.js";

export const UI = {
  toastEl: null,
  showToast(message, kind="info", ms=2400){
    UI.hideToast();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role","status");
    el.innerHTML = `
      <div style="display:flex; gap:.6rem; align-items:flex-start;">
        <div style="width:10px; height:10px; margin-top:.4rem; border-radius:999px; background:${kind==="ok"?"var(--ok)":kind==="danger"?"var(--danger)":"var(--accent)"}"></div>
        <div style="flex:1">
          <div style="font-weight:900"> ${message}</div>
        </div>
      </div>`;
    document.body.appendChild(el);
    UI.toastEl = el;
    setTimeout(()=>UI.hideToast(), ms);
  },
  hideToast(){
    if(UI.toastEl){ UI.toastEl.remove(); UI.toastEl = null; }
  },
  async confirm({title="Confirm", body="Are you sure?", okText="OK", cancelText="Cancel"}){
    return await UI.modal({title, body, okText, cancelText, variant:"confirm"});
  },
  async modal({title="Dialog", body="", okText="OK", cancelText="Cancel", variant="alert"}){
    return new Promise(resolve=>{
      const overlay = document.createElement("div");
      overlay.className = "modalOverlay";
      const id = uid("modal");
      overlay.innerHTML = `
        <div class="modal" id="${id}">
          <div class="modalHeader">
            <div class="h2">${title}</div>
            <div class="small" style="margin-top:.25rem">${variant==="confirm"?"":" "}</div>
          </div>
          <div class="modalBody">${body}</div>
          <div class="modalFooter">
            ${variant==="confirm"?`<button class="btn btn-ghost" data-cancel>${cancelText}</button>`:""}
            <button class="btn btn-primary" data-ok>${okText}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (val)=>{ overlay.remove(); resolve(val); };
      overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(false); });
      overlay.querySelector("[data-ok]").addEventListener("click",()=>close(true));
      const cancel = overlay.querySelector("[data-cancel]");
      if(cancel) cancel.addEventListener("click",()=>close(false));
    });
  }

  // Small helper used by the Fleet-style pages.
  // Returns an HTML string for a standard app "card".
  ,card({
    title = "",
    subtitle = "",
    right = "",
    body = "",
    className = "",
    bodyClass = "",
    id = ""
  } = {}){
    const safeId = id ? `id="${id}"` : "";
    return `
      <section class="card ${className}" ${safeId}>
        ${(title || subtitle || right) ? `
          <div class="cardHeader" style="display:flex; align-items:flex-start; justify-content:space-between; gap:1rem;">
            <div>
              ${title ? `<div class="h2" style="margin:0">${title}</div>` : ""}
              ${subtitle ? `<div class="small" style="margin-top:.15rem">${subtitle}</div>` : ""}
            </div>
            ${right ? `<div>${right}</div>` : ""}
          </div>
        ` : ""}
        <div class="cardBody ${bodyClass}">
          ${body}
        </div>
      </section>
    `.trim();
  }
};
