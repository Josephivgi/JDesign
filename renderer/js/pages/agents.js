import { api, store, on, refreshHarnesses, setPrefs, defaultHarnessId } from "../store.js";
import { esc, icon, toast, confirmDialog, errorText, initials, timeAgo, openDialog, closeDialog } from "../ui.js";
import { agentIcon } from "../agent-ui.js";

let market = null;
let registry = null;
let registryError = "";
// Kept across visits so a search or filter survives leaving the page.
const view = { query: "", filter: "all" };

function logo(name, iconUrl) {
  const img = iconUrl ? agentIcon(iconUrl) : "";
  return '<span class="agent-logo' + (img ? " has-icon" : "") + '">' + (img || esc(initials(name))) + "</span>";
}

// The state sits on the name line: plain words when the agent is ready, an
// icon plus a label when it is not.
function statusMarkup(item) {
  if (item.available) return '<span class="agent-state">Ready</span>';
  return '<span class="agent-state"><span class="problem">' + icon("alert", "i-sm") + "Not installed</span></span>";
}

// The directory area has three honest states: quiet skeleton cards while the
// list loads, one line plus a Retry when it failed or timed out, and the cards.
// Only the line is a live region, so the button is not announced twice.
function marketState(line, action) {
  return '<div class="market-state"><div class="market-line" role="status">' + line + "</div>" + (action || "") + "</div>";
}

// Same shape as a market card, so the area does not jump when the list lands.
function skeletonCard() {
  return (
    '<div class="market-card is-skeleton" aria-hidden="true">' +
    '<div class="market-head"><span class="skel skel-logo"></span>' +
    '<div class="grow"><div class="row"><span class="skel skel-line skel-name"></span><span class="skel skel-pill"></span></div>' +
    '<span class="skel skel-line skel-by"></span></div></div>' +
    '<div class="skel-desc"><span class="skel skel-line"></span><span class="skel skel-line"></span></div>' +
    '<div class="market-foot"><span class="skel skel-line skel-how"></span><span class="skel skel-btn"></span></div>' +
    "</div>"
  );
}

// An agent that is not on this computer: the command when the hint carries one,
// so the row reads as a state with a next step instead of a raw paragraph.
function installHint(text) {
  if (!text) return "";
  const cmd = String(text).match(/`([^`]+)`|((?:npm|npx|pip|uvx|curl|winget|brew|irm)\s[^\n]+)/);
  const command = cmd ? (cmd[1] || cmd[2]).trim() : "";
  if (!command) return '<p class="faint selectable">' + esc(text) + "</p>";
  return '<div class="row agent-command"><code class="selectable">' + esc(command) + "</code>" +
    '<button class="btn btn-sm btn-ghost" data-copy-hint="' + esc(command) + '">' + icon("copy", "i-sm") + "Copy</button></div>";
}

const METHOD_LABEL = {
  npx: "npm package",
  binary: "Download",
  uvx: "Runs with uv",
};

const ago = (ms) => timeAgo(Number(ms || 0));
// "Augment Code <support@augmentcode.com>" -> "Augment Code".
const authorName = (a) => String(a || "").replace(/<[^>]*>/g, "").replace(/\(?\S+@\S+\)?/g, "").trim();
// Agents tested end to end with JV's video tools.
const WORKS_WELL = new Set(["claude-code", "claude-agent", "claude-code-acp", "opencode", "codex", "codex-acp", "gemini", "gemini-cli", "factory-droid", "droid", "cursor", "devin"]);

function progressText(p) {
  if (!p) return "Installing";
  if (p.phase === "npm") return "Installing with npm";
  if (p.phase === "unpack") return "Unpacking";
  if (p.phase === "download") {
    if (p.total) return "Downloading " + Math.min(99, Math.round((p.done / p.total) * 100)) + "%";
    return p.done ? "Downloading " + (p.done / 1048576).toFixed(1) + " MB" : "Downloading";
  }
  return "Installing";
}

export function renderAgents(main) {
  main.innerHTML = '<div class="page"><div class="page-inner" data-inner></div></div>';
  const inner = main.querySelector("[data-inner]");
  const progress = new Map();
  let disposed = false;
  let registryTimer = 0;

  const marketCard = (a) => {
    const p = progress.get(a.id);
    const busy = Boolean(p) || a.installing;
    let action;
    if (busy) action = '<button class="btn btn-sm" disabled>' + icon("loader", "i-sm spin") + esc(progressText(p)) + "</button>";
    else if (a.update) action = '<button class="btn btn-sm btn-primary" data-install="' + esc(a.id) + '">Update to ' + esc(a.version) + "</button>";
    else if (a.added) action = '<span class="muted" style="font-size:var(--fs-sm)">Added</span>';
    else if (!a.method && !a.builtin) action = '<span class="faint" style="font-size:var(--fs-sm)">Not for this computer</span>';
    else action = '<button class="btn btn-sm" data-install="' + esc(a.id) + '">' + icon("plus", "i-sm") + "Add</button>";
    const how = a.builtin ? "Already on this computer" : METHOD_LABEL[a.method] || "";
    const by = a.authors.map(authorName).filter(Boolean).join(", ");
    return (
      '<div class="market-card" data-market="' + esc(a.id) + '">' +
      '<div class="market-head">' + logo(a.name, a.icon) +
      '<div class="grow" style="min-width:0"><div class="row" style="gap:6px"><strong class="ellipsis">' + esc(a.name) + "</strong>" +
      (a.version ? '<span class="faint" style="font-size:var(--fs-xs)">' + esc(a.installedVersion && a.update ? a.installedVersion : a.version) + "</span>" : "") +
      (WORKS_WELL.has(a.id) ? '<span class="pill pill-accent" title="Tested with JV video editing">Works well with JV</span>' : "") + "</div>" +
      (by ? '<div class="faint ellipsis" style="font-size:var(--fs-xs)" title="' + esc(by) + '">' + esc(by) + "</div>" : "") + "</div></div>" +
      '<p class="market-desc">' + esc(a.description) + "</p>" +
      '<div class="market-foot"><span class="faint" style="font-size:var(--fs-xs)">' + esc(how) + "</span>" +
      '<div class="row" style="gap:6px">' +
      (a.website ? '<button class="icon-btn icon-btn-sm" data-site="' + esc(a.website) + '" title="Website" aria-label="' + esc(a.name) + ' website">' + icon("external", "i-sm") + "</button>" : "") +
      action + "</div></div></div>"
    );
  };

  const filtered = () => {
    const list = (registry && registry.agents) || [];
    const q = view.query.trim().toLowerCase();
    const out = list.filter((a) => {
      if (view.filter === "ready" && !a.builtin && !a.added) return false;
      if (view.filter === "updates" && !a.update) return false;
      if (!q) return true;
      return (a.name + " " + a.id + " " + a.description + " " + a.authors.join(" ")).toLowerCase().includes(q);
    });
    // Agents known to work well with JV come first.
    return out.sort((x, y) => Number(WORKS_WELL.has(y.id)) - Number(WORKS_WELL.has(x.id)));
  };

  const retryButton = (label) => '<button class="btn" data-registry-retry>' + icon("refresh", "i-sm") + label + "</button>";
  const wireRetry = (grid) => {
    const retry = grid.querySelector("[data-registry-retry]");
    if (retry) retry.addEventListener("click", () => void retryRegistry());
  };

  const paintGrid = () => {
    const grid = inner.querySelector("[data-market-grid]");
    if (!grid) return;
    if (!registry) {
      grid.innerHTML = registryError
        ? marketState(
            icon("alert", "i-sm") + " <span>Could not reach the agent directory.</span>" +
              '<span class="faint ellipsis" title="' + esc(registryError) + '">' + esc(registryError) + "</span>",
            retryButton("Retry"),
          )
        : marketState('<span class="faint">' + icon("loader", "i-sm spin") + " Loading the agent directory...</span>") +
          Array.from({ length: 6 }, skeletonCard).join("");
      wireRetry(grid);
      return;
    }
    if (!(registry.agents || []).length) {
      grid.innerHTML = marketState(
        '<span class="faint">The agent directory came back empty. Refresh to ask again.</span>',
        retryButton("Refresh"),
      );
      wireRetry(grid);
      return;
    }
    const list = filtered();
    grid.innerHTML = list.length
      ? list.map(marketCard).join("")
      : marketState(
          '<span class="faint">' + (view.query ? "No agents match " + esc(view.query) + "." : "No agent here fits that filter.") + "</span>",
          '<button class="btn" data-market-clear>' + (view.query ? "Clear search" : "Show all agents") + "</button>",
        );
    const clear = grid.querySelector("[data-market-clear]");
    if (clear) clear.addEventListener("click", () => {
      view.query = "";
      view.filter = "all";
      const q = inner.querySelector("[data-market-q]");
      if (q) q.value = "";
      inner.querySelectorAll("[data-filter]").forEach((x) => {
        const on = x.dataset.filter === "all";
        x.classList.toggle("is-on", on);
        x.setAttribute("aria-pressed", String(on));
      });
      paintGrid();
    });
    grid.querySelectorAll("[data-install]").forEach((b) => b.addEventListener("click", () => install(b.dataset.install)));
    grid.querySelectorAll("[data-site]").forEach((b) => b.addEventListener("click", () => void api.openExternal(b.dataset.site)));
  };

  const paint = () => {
    // Ready agents first: a not-installed one should not top the list.
    // Ready agents are yours; built-in ones that are not installed are listed
    // once below with how to install them, not as broken rows.
    const removable = (h) => h.id.startsWith("registry-") || ((market && market.custom) || []).some((c) => c.id === h.id) || ((market && market.catalog) || []).some((c) => c.id === h.id && c.added);
    const harnesses = store.harnesses.filter((h) => h.available || removable(h));
    const missing = store.harnesses.filter((h) => !h.available && !removable(h));
    // Installed on this computer but not added yet (Claude Code, for example).
    const found = registry ? registry.agents.filter((a) => a.builtin && !a.added && !harnesses.some((h) => h.id === a.harnessId || h.id === a.builtin)) : [];
    const catalog = (market && market.catalog) || [];
    const custom = (market && market.custom) || [];
    const added = new Set(harnesses.map((h) => h.id));
    // The agent new chats use, even when no default was ever picked.
    const def = defaultHarnessId();
    const updates = registry ? registry.agents.filter((a) => a.update).length : 0;
    inner.innerHTML =
      '<div class="page-head"><div class="grow"><h1>Agents</h1><p>Agents are the AI helpers that edit your videos. JV finds the ones installed on this computer and connects them for you, with nothing to set up.</p></div>' +
      '<button class="btn" data-refresh title="Look for agents on this computer and update the directory">' + icon("refresh") + "Refresh</button></div>" +
      '<div class="section-title" style="margin-top:0">Your agents <span class="count">' + harnesses.length + "</span></div>" +
      '<div class="card">' +
      (harnesses.length
        ? harnesses.map((h) =>
            '<div class="agent-row">' + logo(h.name, h.icon) +
            '<div class="grow"><div class="row agent-name"><strong' + (h.command ? ' title="' + esc(h.command) + '"' : "") + ">" + esc(h.name) + "</strong>" + statusMarkup(h) + (def === h.id ? '<span class="pill pill-accent" title="New projects and chats start with this agent">Default</span>' : "") + "</div>" +
            "<p>" + esc(h.description || "") + "</p>" +
            (h.available ? "" : installHint(h.install) + '<p class="faint">Press Refresh after you install it.</p>') + "</div>" +
            '<div class="agent-actions">' +
            (h.available && def !== h.id ? '<button class="btn btn-sm" data-default="' + esc(h.id) + '">Make default</button>' : "") +
            (h.id.startsWith("registry-") || custom.some((c) => c.id === h.id) || catalog.some((c) => c.id === h.id && c.added)
              ? '<button class="btn btn-sm btn-ghost" data-remove="' + esc(h.id) + '">Remove</button>' : "") +
            "</div></div>").join("")
        : '<div class="empty">' + icon("bot", "i-xl") + "<h3>No agents yet</h3><p>Add one found on this computer, or one from the directory below.</p></div>") +
      "</div>" +
      (found.length
        ? '<div class="section-title">Found on this computer <span class="count">' + found.length + "</span></div>" +
          '<div class="card">' + found.map((a) =>
            '<div class="agent-row">' + logo(a.name, a.icon) +
            '<div class="grow"><strong>' + esc(a.name) + "</strong><p>Installed on this computer. Add it to use it in JV.</p></div>" +
            '<div class="agent-actions"><button class="btn btn-sm" data-install="' + esc(a.id) + '">' + icon("plus", "i-sm") + "Add</button></div></div>").join("") + "</div>"
        : "") +
      (missing.length
        ? '<details class="advanced" style="margin-top:14px"><summary>' + icon("chevDown", "i-sm chev") + 'Not on this computer <span class="faint">' + missing.length + "</span></summary>" +
          '<div class="card">' + missing.map((h) =>
            '<div class="agent-row">' + logo(h.name, h.icon) +
            '<div class="grow"><strong>' + esc(h.name) + "</strong><p>" + esc(h.description || "") + "</p>" + installHint(h.install) +
            '<p class="faint">Install it, then press Refresh.</p></div><div class="agent-actions"></div></div>').join("") + "</div></details>"
        : "") +
      '<div class="section-title">Get more agents' + (registry ? ' <span class="count">' + registry.agents.length + "</span>" : "") + "</div>" +
      '<p class="muted" style="font-size:var(--fs-sm);margin:-6px 0 12px">General AI agents from the public agent directory. The ones marked Works well with JV are tested with video editing. Add installs one for JV only; most need a free or paid account with their maker' +
      (registry ? ". Updated " + esc(ago(registry.fetchedAt)) + (registry.stale ? ", offline copy" : "") : "") + ".</p>" +
      '<div class="market-tools">' +
      '<label class="search grow">' + icon("search") + '<input class="input" type="search" data-market-q placeholder="Search agents" aria-label="Search agents" value="' + esc(view.query) + '"></label>' +
      '<div class="seg" role="group" aria-label="Show">' +
      [["all", "All"], ["ready", "On this computer"], ["updates", "Updates" + (updates ? " (" + updates + ")" : "")]]
        .map(([k, label]) => '<button type="button" data-filter="' + k + '" class="' + (view.filter === k ? "is-on" : "") + '" aria-pressed="' + (view.filter === k) + '">' + esc(label) + "</button>").join("") +
      "</div></div>" +
      '<div class="market-grid" data-market-grid></div>' +
      (registryError && catalog.length
        ? '<div class="section-title">Built-in list</div><div class="card">' +
          catalog.map((c) =>
            '<div class="agent-row">' + logo(c.name) +
            '<div class="grow"><strong>' + esc(c.name) + "</strong><p>" + esc(c.description || "") + "</p>" +
            (c.available ? "<code>" + esc(c.commandLabel || "") + "</code>" : installHint(c.install)) + "</div>" +
            '<div class="agent-actions">' +
            (c.added || added.has(c.id)
              ? '<span class="muted" style="font-size:var(--fs-sm)">Added</span>'
              : '<button class="btn btn-sm" data-add="' + esc(c.id) + '">' + icon("plus", "i-sm") + "Add</button>") +
            "</div></div>").join("") + "</div>"
        : "") +
      '<div class="section-title">Troubleshooting</div>' +
      '<div class="card"><div class="agent-row" style="grid-template-columns:1fr auto"><div><strong>Agent errors</strong><p>Recent agent failures, useful when an agent keeps failing.</p></div>' +
      '<button class="btn btn-sm" data-errors>' + icon("file", "i-sm") + "Show errors</button></div></div>" +
      // Developers only: kept folded so it does not read as a required step.
      '<details class="advanced"><summary>' + icon("chevDown", "i-sm chev") + "Advanced: add an agent by command</summary>" +
      '<form class="card card-pad" data-custom style="display:grid;gap:12px;grid-template-columns:1fr 1fr 1fr auto;align-items:end">' +
      '<div class="field"><label>Name</label><input class="input" name="name" placeholder="My agent" required></div>' +
      '<div class="field"><label>Command</label><input class="input" name="command" placeholder="my-agent" required></div>' +
      '<div class="field"><label>Arguments</label><input class="input" name="args" placeholder="--acp"></div>' +
      '<button class="btn" type="submit">' + icon("plus") + "Add</button>" +
      '<p class="field-help" style="grid-column:1/-1">Any program that speaks the Agent Client Protocol over stdio works here.</p>' +
      "</form></details>";
    wire();
    paintGrid();
  };

  const loadRegistry = async (refresh) => {
    // A directory that never answers used to leave the area loading forever.
    // The timer turns that into the same one line plus Retry as a failure.
    clearTimeout(registryTimer);
    registryTimer = setTimeout(() => {
      if (disposed || registry) return;
      registryError = "The agent directory did not answer. Check your connection and try again.";
      paintGrid();
    }, 20000);
    try {
      registry = await api.acpRegistry({ refresh });
      registryError = "";
    } catch (error) {
      registryError = errorText(error);
    } finally {
      clearTimeout(registryTimer);
    }
  };

  // Retry from the grid keeps the search and filter the person had set.
  const retryRegistry = async () => {
    registry = null;
    registryError = "";
    paintGrid();
    await loadRegistry(true);
    if (disposed) return;
    paintGrid();
    if (registryError) inner.querySelector("[data-registry-retry]")?.focus();
  };

  const reload = async (refresh) => {
    try {
      const [, m] = await Promise.all([refreshHarnesses(), api.acpMarketplace(), loadRegistry(refresh)]);
      market = m;
    } catch (error) {
      toast(errorText(error), true);
    }
    if (!disposed) paint();
  };

  async function install(id) {
    const a = registry && registry.agents.find((x) => x.id === id);
    if (!a || progress.has(id)) return;
    progress.set(id, { phase: a.method === "binary" ? "download" : a.method === "npx" ? "npm" : "check" });
    paintGrid();
    try {
      const result = await api.acpRegistryInstall({ id });
      toast(a.name + (a.update ? " updated" : " added") + (result && result.builtin ? ", using the copy on this computer" : ""));
    } catch (error) {
      toast(a.name + ": " + errorText(error), true);
    }
    // The card keeps its progress label until the fresh list is in; clearing
    // it first flashed "Add" on a card that was already installed.
    await reload(false);
    progress.delete(id);
    if (!disposed) paintGrid();
  }

  const showErrors = async () => {
    let res;
    try {
      res = await api.agentErrors({ limit: 50 });
    } catch (error) {
      return toast(errorText(error), true);
    }
    const list = (res && res.entries) || [];
    const dlg = openDialog({
      title: "Agent errors",
      wide: true,
      body: list.length
        ? '<ul class="el-history">' + list.slice().reverse().map((e) =>
            "<li><div><strong>" + esc((store.harnesses.find((h) => h.id === e.harness) || {}).name || e.harness || "Agent") + '</strong><small class="el-detail selectable" style="white-space:normal">' + esc(String(e.message || "").slice(0, 600)) + "</small></div>" +
            '<small class="faint">' + esc(timeAgo(e.at)) + "</small></li>").join("") + "</ul>"
        : '<p>No agent errors so far.</p>',
      foot: '<button class="btn btn-ghost" data-err-file>' + icon("folder", "i-sm") + 'Open the log file</button><span class="grow"></span><button class="btn" data-err-close>Close</button>',
    });
    dlg.querySelector("[data-err-file]").addEventListener("click", () => api.agentErrorsReveal().catch((e) => toast(errorText(e), true)));
    dlg.querySelector("[data-err-close]").addEventListener("click", () => closeDialog());
  };

  const wire = () => {
    inner.querySelector("[data-refresh]").addEventListener("click", () => reload(true).then(() => toast("Agent list updated")));
    inner.querySelector("[data-errors]").addEventListener("click", showErrors);
    inner.querySelectorAll(".card [data-install]").forEach((b) => b.addEventListener("click", () => install(b.dataset.install)));
    inner.querySelectorAll("[data-copy-hint]").forEach((b) => b.addEventListener("click", () => api.copyText(b.dataset.copyHint).then(() => toast("Copied"))));
    const q = inner.querySelector("[data-market-q]");
    q.addEventListener("input", () => {
      view.query = q.value;
      paintGrid();
    });
    inner.querySelectorAll("[data-filter]").forEach((b) =>
      b.addEventListener("click", () => {
        view.filter = b.dataset.filter;
        inner.querySelectorAll("[data-filter]").forEach((x) => {
          x.classList.toggle("is-on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        });
        paintGrid();
      }),
    );
    inner.querySelectorAll("[data-add]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await api.acpAgentAdd({ catalogId: b.dataset.add });
          toast("Agent added");
        } catch (error) {
          toast(errorText(error), true);
        }
        await reload(false);
      }),
    );
    inner.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", async () => {
        const h = store.harnesses.find((x) => x.id === b.dataset.remove);
        const ok = await confirmDialog({ title: "Remove " + (h ? h.name : "agent") + "?", body: "Its running chats stop. Chats it already had stay readable.", confirm: "Remove", danger: true });
        if (!ok) return;
        try {
          await api.acpAgentRemove({ id: b.dataset.remove });
        } catch (error) {
          toast(errorText(error), true);
        }
        await reload(false);
      }),
    );
    inner.querySelectorAll("[data-default]").forEach((b) =>
      b.addEventListener("click", async () => {
        await setPrefs({ defaultAgent: b.dataset.default });
        paint();
      }),
    );
    inner.querySelector("[data-custom]").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const args = String(data.get("args") || "").trim();
      try {
        await api.acpAgentAdd({ custom: { name: String(data.get("name")).trim(), command: String(data.get("command")).trim(), args: args ? args.split(/\s+/) : [] } });
        toast("Agent added");
        form.reset();
      } catch (error) {
        toast(errorText(error), true);
      }
      await reload(false);
    });
  };

  paint();
  void reload(false);
  const offHarness = on("harnesses", () => {
    // Repainting the whole page would drop focus from the search box.
    if (inner.contains(document.activeElement) && document.activeElement.matches("[data-market-q]")) return;
    paint();
  });
  const offProgress = api.onAcpRegistryProgress
    ? api.onAcpRegistryProgress((p) => {
        if (!progress.has(p.id) || p.phase === "done") return;
        progress.set(p.id, p);
        const card = inner.querySelector('[data-market="' + CSS.escape(p.id) + '"] .market-foot button[disabled]');
        if (card) card.innerHTML = icon("loader", "i-sm spin") + esc(progressText(p));
      })
    : () => {};
  return () => {
    disposed = true;
    clearTimeout(registryTimer);
    offHarness();
    offProgress();
  };
}
