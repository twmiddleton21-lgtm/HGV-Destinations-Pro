export const NAV = {
  setActive(route){
    document.querySelectorAll(".navBtn").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.route === route);
    });
  }
};
