// Browser / search engine catalog for the built-in agent browser.
// The user picks one engine in the setup wizard; the choice is persisted in
// agents-setup.json and read lazily by the browser server.
//
// Each entry: { id, label, homeUrl, searchUrl }. searchUrl holds "%s" where the
// encoded query is substituted. The blank option has an empty searchUrl and
// opens about:blank.

"use strict";

const ENGINES = [
  {
    id: "bing",
    label: "Bing",
    homeUrl: "https://www.bing.com/",
    searchUrl: "https://www.bing.com/search?q=%s",
  },
  {
    id: "google",
    label: "Google",
    homeUrl: "https://www.google.com/",
    searchUrl: "https://www.google.com/search?q=%s",
  },
];

const DEFAULT_ENGINE = "bing";

function normalizeEngineId(id) {
  const value = typeof id === "string" ? id.trim() : "";
  return ENGINES.some((engine) => engine.id === value) ? value : DEFAULT_ENGINE;
}

function resolveEngine(id) {
  const normalized = normalizeEngineId(id);
  return ENGINES.find((engine) => engine.id === normalized) || ENGINES[0];
}

function engineList() {
  return ENGINES.map((engine) => ({ id: engine.id, label: engine.label }));
}

function searchUrlFor(id, query, site) {
  const engine = resolveEngine(id);
  const base = String(engine.searchUrl || "");
  if (!base) return "";
  let text = query == null ? "" : String(query);
  if (site) text = text + " site:" + site;
  return base.replace("%s", encodeURIComponent(text));
}

module.exports = {
  ENGINES,
  DEFAULT_ENGINE,
  normalizeEngineId,
  resolveEngine,
  engineList,
  searchUrlFor,
};
