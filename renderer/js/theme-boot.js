// Sets the theme before the stylesheet paints, so a light theme never
// flashes dark at launch. The main process passes the saved theme in the URL.
(function () {
  var t = new URLSearchParams(location.search).get("theme");
  if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
})();
