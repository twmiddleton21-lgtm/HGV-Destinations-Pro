import { UI } from "./ui.js";

export const BRIDGES = {
  render(){
    return UI.card(`
      <div class="pageTitleRow">
        <div>
          <div class="h1">Low Bridges</div>
          <div class="small">Store bridge restrictions and safe alternatives.</div>
        </div>
      </div>

      <div class="card-soft" style="margin-top:1rem">
        <div style="padding:1rem">
          <div class="small">This is a placeholder screen for bridge data.</div>
          <div class="muted" style="margin-top:.75rem">Add: height, location, notes, diversion route.</div>
        </div>
      </div>
    `);
  }
};
