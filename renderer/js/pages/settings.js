import { api, store, on, emit, setPrefs, harnessById, refreshSnapshot } from "../store.js";
import { esc, icon, toast, showMenu, confirmDialog, promptDialog, openDialog, closeDialog, formatBytes, errorText, debounce, timeAgo } from "../ui.js";

// Skills carry a `title` and an `about` line for people; the name and
// description are written for agents. Older skills fall back to a tidied name.
function skillMeta(text, key) {
  const m = String(text || "").match(new RegExp("^" + key + ":[ \\t]*(.+)$", "m"));
  return m ? m[1].trim() : "";
}
function skillTitle(name, title) {
  if (title) return title;
  const s = String(name || "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function skillAbout(about, description) {
  if (about) return about;
  // Agent text: keep the first sentence, drop tool names.
  return String(description || "").replace(/\b(cutline|cards)_[a-z_]+\b/g, "JV tools").split(/(?<=\.)\s/)[0];
}

const VOICE_TOOL_DETAIL = (a) => {
  // SSML pauses and JSON summaries are for agents, not for this list.
  const raw = a.text ? a.text : "";
  const plain = String(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? "\u201c" + plain + "\u201d" : "";
};
import { openAgentMenu, agentAvatar } from "../agent-ui.js";
import { speak, stopSpeaking } from "../voice.js";

const SECTIONS = [
  { id: "general", label: "General", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "chat", label: "Chat", icon: "message" },
  { id: "instructions", label: "Instructions and rules", icon: "book" },
  { id: "skills", label: "Skills", icon: "layers" },
  { id: "plugins", label: "Plugins", icon: "puzzle" },
  { id: "voice", label: "Voice and music", icon: "mic" },
  { id: "storage", label: "Storage", icon: "drive" },
  { id: "about", label: "About", icon: "info" },
];

// Mono is the ink of the theme (black in light, white in dark), so its swatch
// follows the text token instead of a fixed black.
const ACCENTS = [
  ["mono", "var(--text)"], ["iris", "#7c6cff"], ["blue", "#3b82f6"], ["teal", "#14b8a6"], ["green", "#22c55e"], ["amber", "#f59e0b"], ["rose", "#f43f5e"],
];

let current = "general";

function progressPct(p) {
  if (!p || !p.total) return 0;
  const share = Number.isFinite(p.percent) ? p.percent / 100 : 0;
  return Math.round(Math.min(1, ((Number(p.done) || 0) + share) / p.total) * 100);
}

const toggle = (key, on) => '<label class="switch"><input type="checkbox" data-pref-bool="' + key + '"' + (on ? " checked" : "") + "><span></span></label>";
const seg = (key, value, options) =>
  '<div class="seg" data-pref-seg="' + key + '">' + options.map(([v, label, ic]) => '<button data-v="' + v + '" aria-pressed="' + (value === v) + '"' + (value === v ? ' class="is-on"' : "") + ">" + (ic ? icon(ic, "i-sm") : "") + esc(label) + "</button>").join("") + "</div>";
const row = (title, sub, control) =>
  '<div class="set-row"><div class="label"><strong>' + esc(title) + "</strong>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>" + control + "</div>";

export function renderSettings(main, section) {
  if (section && SECTIONS.some((s) => s.id === section)) current = section;
  main.innerHTML =
    '<div class="page"><div class="page-inner"><div class="page-head"><div class="grow"><h1>Settings</h1></div></div>' +
    '<div class="settings"><nav class="settings-nav" data-snav></nav><section class="settings-pane" data-pane-host></section></div></div></div>';
  const nav = main.querySelector("[data-snav]");
  // Each section mounts into its own fresh element. A section whose request
  // finishes after the user moved on paints into a detached node, never over
  // the section now on screen.
  const host = main.querySelector("[data-pane-host]");
  const pane = host;
  let cleanup = null;

  const show = (id) => {
    current = id;
    if (cleanup) cleanup();
    cleanup = null;
    nav.innerHTML = SECTIONS.map((s) => '<button data-sec="' + s.id + '"' + (s.id === current ? ' class="is-on" aria-current="page"' : "") + ">" + icon(s.icon) + esc(s.label) + "</button>").join("");
    const fn = PANES[current] || PANES.general;
    const section = document.createElement("div");
    section.setAttribute("data-pane", current);
    host.replaceChildren(section);
    cleanup = fn(section) || null;
  };
  nav.addEventListener("click", (event) => {
    const b = event.target.closest("[data-sec]");
    if (b) show(b.dataset.sec);
  });
  // Shared pref controls in any pane.
  pane.addEventListener("change", (event) => {
    const b = event.target.closest("[data-pref-bool]");
    if (b) void setPrefs({ [b.dataset.prefBool]: b.checked });
  });
  pane.addEventListener("click", (event) => {
    const segBtn = event.target.closest("[data-pref-seg] [data-v]");
    if (segBtn) {
      const key = segBtn.closest("[data-pref-seg]").dataset.prefSeg;
      segBtn.parentElement.querySelectorAll("[data-v]").forEach((x) => {
        x.classList.toggle("is-on", x === segBtn);
        x.setAttribute("aria-pressed", String(x === segBtn));
      });
      void setPrefs({ [key]: segBtn.dataset.v });
    }
  });
  show(current);
  return () => cleanup && cleanup();
}

// ---------- panes ----------

// The last ElevenLabs key check, kept for this app session so the Voice page
// does not call ElevenLabs on every visit.
let lastKeyCheck = null;

const PANES = {
  general(pane) {
    const paint = () => {
      const def = store.prefs.defaultAgent || "";
      const h = harnessById(def);
      pane.innerHTML =
        "<h2>General</h2><p class=\"lead\">How JV starts work.</p>" +
        '<div class="set-group">' +
        row("Default agent", "Used for new projects and new chats. You can switch agents in any chat, and add or remove agents on the Agents page.",
          '<div class="row">' + (def ? '<button class="btn btn-sm btn-ghost" data-def-reset title="Use the first agent that is ready">Reset</button>' : "") +
          '<button class="picker is-boxed" data-def-agent>' + (def ? agentAvatar(def) : "") + "<span>" + esc(h ? h.name : "First installed agent") + "</span>" + icon("chevDown", "i-sm chev") + "</button></div>") +
        row("Connect agents when a chat opens", "Starts the chat's agent in the background so it is ready when you type.", toggle("autoConnect", store.prefs.autoConnect !== false)) +
        row("Slop check", "Turns down the default AI look in cards, animations and copy, and checks the result after each turn.", toggle("slopGate", store.prefs.slopGate !== false)) +
        "</div>";
      pane.querySelector("[data-def-agent]").addEventListener("click", (event) =>
        openAgentMenu(event.currentTarget, def, async (id) => {
          await setPrefs({ defaultAgent: id });
          paint();
        }),
      );
      const reset = pane.querySelector("[data-def-reset]");
      if (reset) reset.addEventListener("click", async () => {
        await setPrefs({ defaultAgent: "" });
        paint();
      });
    };
    paint();
    const off = on("harnesses", paint);
    return off;
  },

  appearance(pane) {
    const p = store.prefs;
    pane.innerHTML =
      "<h2>Appearance</h2><p class=\"lead\">Make JV look the way you like.</p>" +
      '<div class="set-group">' +
      row("Theme", "System follows your Windows setting.", seg("theme", p.theme || "system", [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]])) +
      row("Accent color", "Used for buttons, selection, and highlights.",
        '<div class="swatches" data-accents>' + ACCENTS.map(([id, hex]) => '<button class="swatch' + ((p.accent || "mono") === id ? " is-on" : "") + '" data-accent="' + id + '" aria-pressed="' + ((p.accent || "mono") === id) + '" style="background:' + hex + '" title="' + id.charAt(0).toUpperCase() + id.slice(1) + '" aria-label="' + id.charAt(0).toUpperCase() + id.slice(1) + '"></button>').join("") + "</div>") +
      row("Density", "Compact fits more on smaller screens.", seg("density", p.density || "comfortable", [["comfortable", "Comfortable"], ["compact", "Compact"]])) +
      "</div>";
    pane.querySelector("[data-accents]").addEventListener("click", (event) => {
      const b = event.target.closest("[data-accent]");
      if (!b) return;
      pane.querySelectorAll("[data-accent]").forEach((x) => {
        x.classList.toggle("is-on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      void setPrefs({ accent: b.dataset.accent });
    });
  },

  chat(pane) {
    const st = { voices: null, hasKey: false, testing: false };
    const paint = () => {
      const p = store.prefs;
      const winVoice = p.windowsVoice || "";
      pane.innerHTML =
        "<h2>Chat</h2><p class=\"lead\">How conversations with agents look and behave.</p>" +
        '<div class="set-group">' +
        row("Send with", "The other combination adds a new line.", seg("sendKey", p.sendKey || "enter", [["enter", "Enter"], ["ctrl-enter", "Ctrl + Enter"]])) +
        row("Chat text size", "Changes the text in the chat panel only.",
          '<div class="chat-size-cell"><span class="chat-size-sample" aria-hidden="true">The agent writes here.</span>' +
          seg("chatTextSize", p.chatTextSize || "md", [["sm", "Small"], ["md", "Medium"], ["lg", "Large"]]) + "</div>") +
        row("Show agent thinking", "Shows the agent's reasoning when it shares it. Off keeps the chat short.", toggle("showThinking", p.showThinking === true)) +
        row("Expand tool steps", "Lists every tool call instead of a one line summary.", toggle("showToolDetails", Boolean(p.showToolDetails))) +
        "</div>" +
        '<div class="set-group" data-voice-group><div class="set-group-title">Talking with the agent</div>' +
        row("Read replies aloud", "Speaks the agent's answer when it finishes. The speaker button at the top of the chat turns this on and off too.", toggle("speakReplies", Boolean(p.speakReplies))) +
        row("Reply voice", p.replyVoice === "elevenlabs"
          ? "Uses your default ElevenLabs voice and spends characters. Long replies are cut to about 900 characters."
          : "Voices built into Windows. Free and offline.",
          seg("replyVoice", p.replyVoice || "windows", [["windows", "Windows"], ["elevenlabs", "ElevenLabs"]])) +
        (p.replyVoice === "elevenlabs" ? "" : row("Windows voice", "Add more in Windows Settings > Time & language > Speech.",
          '<div class="voice-row"><button class="btn btn-sm" data-voice-test' + (st.testing ? " disabled" : "") + ">" + icon(st.testing ? "loader" : "play", st.testing ? "i-sm spin" : "i-sm") + "Test</button>" +
          '<button class="picker is-boxed" data-win-voice><span>' + esc(winVoice || "Windows default") + "</span>" + icon("chevDown", "i-sm chev") + "</button></div>")) +
        row("Voice input", "The mic button in the chat types what you say. Auto uses ElevenLabs when a key is saved" + (st.hasKey ? " (it is)" : " (none is, so Windows)") + ". Windows is offline and free.",
          seg("micEngine", p.micEngine || "auto", [["auto", "Auto"], ["windows", "Windows"], ["elevenlabs", "ElevenLabs"]])) +
        row("Send right after talking", "Off puts your words in the box so you can fix them first.", toggle("micAutoSend", Boolean(p.micAutoSend))) +
        "</div>";
      pane.querySelector("[data-voice-test]")?.addEventListener("click", async () => {
        st.testing = true;
        paint();
        const r = await speak("Hi, I'm your editing agent. I'll read my replies like this.", { engine: store.prefs.replyVoice, quiet: true });
        st.testing = false;
        paint();
        if (r && r.ok === false && r.error) toast("Test failed: " + r.error, true);
      });
      pane.querySelector("[data-win-voice]")?.addEventListener("click", async (event) => {
        const anchor = event.currentTarget;
        if (!st.voices) st.voices = await api.voiceWindowsVoices().catch(() => []);
        const items = [{ label: "Windows default", onSelect: () => pick("") }].concat((st.voices || []).map((name) => ({ label: name, onSelect: () => pick(name) })));
        showMenu(anchor, items, { width: 260 });
      });
    };
    const pick = async (name) => {
      stopSpeaking();
      await setPrefs({ windowsVoice: name });
      paint();
    };
    paint();
    api.elevenlabsStatus().then((s) => {
      st.hasKey = Boolean(s && s.configured);
      if (pane.isConnected) paint();
    }).catch(() => {});
    const off = on("prefs", () => {
      if (pane.isConnected && !pane.contains(document.activeElement)) paint();
      else if (pane.isConnected) setTimeout(paint, 0);
    });
    return () => {
      off();
      stopSpeaking();
    };
  },

  instructions(pane) {
    const st = { text: "", saved: "", max: 0, rules: [], savedRules: "[]" };
    // One line tall from the stylesheet; taller only when the words wrap.
    const fitRule = (t) => {
      t.style.height = "";
      if (t.scrollHeight > t.clientHeight + 2) t.style.height = t.scrollHeight + 2 + "px";
    };
    const fitRules = () => pane.querySelectorAll("[data-rule-text]").forEach(fitRule);
    const paintRules = () => {
      const list = pane.querySelector("[data-rules]");
      list.innerHTML = st.rules.length
        ? st.rules.map((r, i) =>
            '<div class="rule"><div class="seg" data-rule-type="' + i + '"><button data-t="do" aria-pressed="' + (r.type === "do") + '"' + (r.type === "do" ? ' class="is-on"' : "") + '>Do</button><button data-t="dont" aria-pressed="' + (r.type === "dont") + '"' + (r.type === "dont" ? ' class="is-on"' : "") + ">Don't</button></div>" +
            // A box that grows with the rule, so a long one shows all its words.
            '<textarea class="textarea" rows="1" data-rule-text="' + i + '" aria-label="Rule ' + (i + 1) + '" maxlength="' + (st.maxText || 300) + '">' + esc(r.text) + "</textarea>" +
            '<button class="icon-btn" data-rule-del="' + i + '" title="Remove rule" aria-label="Remove rule ' + (i + 1) + '">' + icon("trash") + "</button></div>").join("")
        : '<p class="faint">No rules yet. Add one to tell every agent what to always or never do.</p>';
      list.querySelectorAll("[data-rule-text]").forEach(fitRule);
      dirtyCheck();
    };
    pane.innerHTML =
      "<h2>Instructions and rules</h2><p class=\"lead\">Sent with every message to every agent. Agents can suggest changes, but only you can approve them. Changes save when you press Save or leave this page.</p>" +
      '<div class="set-group"><div class="set-block"><div class="field"><label>Your instructions</label>' +
      '<textarea class="textarea" data-instr rows="8" placeholder="For example: My channel is about strategy games. Keep captions short and use my brand color #7c6cff."></textarea>' +
      '<div class="row"><span class="field-help grow" data-instr-count></span></div></div></div></div>' +
      '<div class="set-group"><div class="set-group-title">Rules</div><div class="set-block"><div class="rules" data-rules></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn btn-sm" data-rule-add>' + icon("plus", "i-sm") + 'Add rule</button></div></div></div>' +
      '<div class="row"><span class="faint grow" data-dirty style="font-size:var(--fs-sm)"></span><button class="btn btn-primary" data-save-all disabled>Save</button></div>';
    const ta = pane.querySelector("[data-instr]");
    const textDirty = () => st.text !== st.saved;
    const rulesDirty = () => JSON.stringify(st.rules) !== st.savedRules;
    function dirtyCheck() {
      const dirty = textDirty() || rulesDirty();
      pane.querySelector("[data-save-all]").disabled = !dirty;
      pane.querySelector("[data-dirty]").textContent = dirty ? "Unsaved changes" : "";
    }
    const count = () => {
      pane.querySelector("[data-instr-count]").textContent = st.text.length + (st.max ? " / " + st.max : "") + " characters";
      dirtyCheck();
    };
    ta.addEventListener("input", () => {
      st.text = ta.value;
      count();
    });
    // One Save for both. Leaving the page saves too, so nothing is lost.
    const saveAll = async (quiet) => {
      const tasks = [];
      if (textDirty()) tasks.push(api.saveUserInstructions(st.text).then((r) => {
        st.saved = r.text;
        if (pane.isConnected && ta.value === st.text) { st.text = r.text; ta.value = st.text; }
      }));
      if (rulesDirty()) tasks.push(api.saveUserRules(st.rules.filter((x) => x.text.trim()).map((x) => ({ type: x.type, text: x.text.trim() }))).then((r) => {
        st.rules = r.rules.map((x) => ({ type: x.type, text: x.text }));
        st.savedRules = JSON.stringify(st.rules);
      }));
      if (!tasks.length) return;
      try {
        await Promise.all(tasks);
        toast(quiet ? "Instructions and rules saved" : "Saved");
      } catch (error) {
        toast(errorText(error), true);
      }
      if (pane.isConnected) { count(); paintRules(); }
    };
    pane.querySelector("[data-save-all]").addEventListener("click", () => saveAll(false));
    pane.querySelector("[data-rules]").addEventListener("input", (event) => {
      const t = event.target.closest("[data-rule-text]");
      if (!t) return;
      // A rule is one line of words: a pasted line break becomes a space.
      if (/[\r\n]/.test(t.value)) t.value = t.value.replace(/\s*[\r\n]+\s*/g, " ");
      st.rules[Number(t.dataset.ruleText)].text = t.value;
      fitRule(t);
      dirtyCheck();
    });
    pane.querySelector("[data-rules]").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.closest("[data-rule-text]")) event.preventDefault();
    });
    window.addEventListener("resize", fitRules);
    pane.querySelector("[data-rules]").addEventListener("click", (event) => {
      const del = event.target.closest("[data-rule-del]");
      if (del) {
        st.rules.splice(Number(del.dataset.ruleDel), 1);
        paintRules();
        return;
      }
      const tb = event.target.closest("[data-rule-type] [data-t]");
      if (tb) {
        st.rules[Number(tb.parentElement.dataset.ruleType)].type = tb.dataset.t;
        paintRules();
      }
    });
    pane.querySelector("[data-rule-add]").addEventListener("click", () => {
      st.rules.push({ type: "do", text: "" });
      paintRules();
      const inputs = pane.querySelectorAll("[data-rule-text]");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    const load = async () => {
      try {
        const [ins, rules] = await Promise.all([api.getUserInstructions(), api.userRules()]);
        st.text = st.saved = ins.text || "";
        st.max = ins.maxLength || 0;
        if (st.max) ta.maxLength = st.max;
        ta.value = st.text;
        st.rules = (rules.rules || []).map((x) => ({ type: x.type, text: x.text }));
        st.savedRules = JSON.stringify(st.rules);
        st.maxText = rules.maxText;
        count();
        paintRules();
      } catch (error) {
        toast(errorText(error), true);
      }
    };
    void load();
    const off = on("instructions-changed", () => {
      if (st.text === st.saved) void load();
    });
    return () => {
      off();
      window.removeEventListener("resize", fitRules);
      void saveAll(true);
    };
  },

  skills(pane) {
    const st = { user: [], bundled: [], editing: null, draft: "", max: 0 };
    const paint = () => {
      if (st.editing) {
        const s = st.editing;
        // A customized built-in skill goes back to JV's version; a skill you made is deleted.
        const builtin = st.bundled.some((b) => b.name === s.name);
        pane.innerHTML =
          '<div class="row" style="margin-bottom:12px"><button class="btn btn-ghost btn-sm" data-back>' + icon("chevLeft", "i-sm") + "Skills</button><span class=\"grow\"></span>" +
          (builtin
            ? '<button class="btn btn-sm" data-remove>' + icon("undo", "i-sm") + "Reset to built in</button>"
            : '<button class="btn btn-danger btn-sm" data-remove>' + icon("trash", "i-sm") + "Delete skill</button>") +
          '<button class="btn btn-primary btn-sm" data-save disabled>Save</button></div>' +
          "<h2>" + esc(skillTitle(s.name, skillMeta(s.text, "title"))) + '</h2><p class="lead">Agents read these notes when a task matches. Write them as plain instructions. The lines between the two --- marks name the skill: title and about are what you see here, description is what agents see.</p>' +
          '<textarea class="textarea mono" data-text rows="24" style="min-height:420px;font-size:var(--fs-sm)">' + esc(s.text) + "</textarea>";
        const ta = pane.querySelector("[data-text]");
        if (st.max) ta.maxLength = st.max;
        ta.addEventListener("input", () => {
          st.draft = ta.value;
          pane.querySelector("[data-save]").disabled = st.draft === s.text;
        });
        pane.querySelector("[data-back]").addEventListener("click", () => {
          st.editing = null;
          paint();
        });
        pane.querySelector("[data-save]").addEventListener("click", async () => {
          try {
            await api.saveUserSkill({ id: s.id, text: st.draft, expectedText: s.text });
            toast("Skill saved");
            await load();
            st.editing = st.user.find((x) => x.id === s.id) || null;
            paint();
          } catch (error) {
            toast(errorText(error), true);
          }
        });
        pane.querySelector("[data-remove]").addEventListener("click", async () => {
          const ok = builtin
            ? await confirmDialog({ title: "Reset this skill?", body: "Your changes are removed and agents use JV's built in version again.", confirm: "Reset", danger: true })
            : await confirmDialog({ title: "Delete this skill?", body: "Agents stop using it. This cannot be undone.", confirm: "Delete", danger: true });
          if (!ok) return;
          try {
            await api.removeUserSkill({ id: s.id, expectedText: s.text });
            st.editing = null;
            await load();
            paint();
          } catch (error) {
            toast(errorText(error), true);
          }
        });
        return;
      }
      const userNames = new Set(st.user.map((s) => s.name));
      pane.innerHTML =
        '<div class="row"><h2 class="grow">Skills</h2><button class="btn btn-primary btn-sm" data-new>' + icon("plus", "i-sm") + "New skill</button></div>" +
        '<p class="lead">Skills teach agents how to do a kind of edit. Agents read the matching one before they start.</p>' +
        '<div class="section-title" style="margin-top:0">Your skills <span class="count">' + st.user.length + "</span></div>" +
        '<div class="set-group">' +
        (st.user.length
          ? st.user.map((s) => row(skillTitle(s.name, skillMeta(s.text, "title")), skillAbout(skillMeta(s.text, "about"), s.description), '<button class="btn btn-sm btn-ghost" data-edit="' + esc(s.id) + '">Edit</button>')).join("")
          : '<div class="set-block faint">None yet. Press New skill to write one, or customize a built in skill below.</div>') +
        "</div>" +
        '<div class="section-title">Built in <span class="count">' + st.bundled.length + "</span></div>" +
        '<div class="set-group">' +
        st.bundled.map((s) => row(skillTitle(s.name, s.title), skillAbout(s.about, s.description), userNames.has(s.name) ? '<span class="pill">Customized</span>' : '<button class="btn btn-sm btn-ghost" data-custom="' + esc(s.name) + '">Customize</button>')).join("") +
        "</div>";
      pane.querySelectorAll("[data-edit]").forEach((b) =>
        b.addEventListener("click", () => {
          st.editing = st.user.find((x) => x.id === b.dataset.edit);
          st.draft = st.editing ? st.editing.text : "";
          paint();
        }),
      );
      pane.querySelector("[data-new]").addEventListener("click", async () => {
        const name = await promptDialog({ title: "New skill", label: "Skill name", placeholder: "My intro style", confirm: "Create" });
        if (!name) return;
        const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!slug) return toast("Use letters or numbers in the name.", true);
        await create({ name: slug });
      });
      pane.querySelectorAll("[data-custom]").forEach((b) => b.addEventListener("click", () => create({ name: b.dataset.custom, bundledName: b.dataset.custom })));
    };
    const create = async (payload) => {
      try {
        await api.createUserSkill(payload);
        await load();
        st.editing = st.user.find((x) => x.name === payload.name) || st.user[st.user.length - 1] || null;
        st.draft = st.editing ? st.editing.text : "";
        paint();
      } catch (error) {
        toast(errorText(error), true);
      }
    };
    const load = async () => {
      try {
        const [u, b] = await Promise.all([api.userSkills(), api.bundledSkills()]);
        st.user = (u && u.skills) || [];
        st.max = (u && u.maxLength) || 0;
        st.bundled = b || [];
      } catch (error) {
        toast(errorText(error), true);
      }
    };
    pane.innerHTML = '<p class="faint">Loading skills...</p>';
    load().then(paint);
  },

  voice(pane) {
    const st = { status: null, voices: [], models: [], test: lastKeyCheck, busy: "", history: null, playing: "", replacing: false, tryText: "Hi, this is how your voiceovers will sound in JV." };
    let audio = null;
    // Activity rows logged before the jeditor_ rename carry the old prefix, so
    // both spellings get a friendly label.
    const TOOL_LABEL = {
      jeditor_tts: "Voiceover",
      jeditor_music: "Music",
      jeditor_elevenlabs_voices: "Listed voices",
      jeditor_elevenlabs_setup: "Checked setup",
      cutline_tts: "Voiceover",
      cutline_music: "Music",
      cutline_elevenlabs_voices: "Listed voices",
      cutline_elevenlabs_setup: "Checked setup",
    };
    const TIER_NAMES = { free: "Free", starter: "Starter", creator: "Creator", pro: "Pro", scale: "Scale", business: "Business", payg: "Pay as you go", enterprise: "Enterprise" };
    const PERMS = [
      ["voices_read", "Voices", "Needed for voiceovers"],
      ["models_read", "Models", "Lets you pick the speech quality"],
      ["user_read", "User", "Shows your plan and characters left"],
      ["music_generation", "Music Generation", "Optional, for background music"],
    ];
    const historyMarkup = () => {
      const h = st.history;
      if (!h) return '<p class="faint" style="font-size:var(--fs-sm)">Loading...</p>';
      if (h.error) return '<p class="problem bad" style="font-size:var(--fs-sm)">' + icon("alertCircle", "i-sm") + esc(h.error) + "</p>";
      if (!h.length) return '<p class="faint" style="font-size:var(--fs-sm)">No agent has used ElevenLabs yet.</p>';
      return '<ul class="el-history is-labeled">' + h.slice(0, 25).map((a) => {
        const perm = String(a.tool || "").startsWith("permission:");
        const label = perm ? "Permission " + (a.ok === false ? "denied" : "answered") : TOOL_LABEL[a.tool] || String(a.tool || "").replace(/^(?:cutline|jeditor)_/, "").replace(/_/g, " ");
        const voice = a.voiceId ? st.voices.find((v) => v.id === a.voiceId) : null;
        const detail = VOICE_TOOL_DETAIL(a);
        const why = a.ok === false && !perm ? String(a.error || a.summary || "").replace(/^\s*[{[][\s\S]*$/, "").slice(0, 140) : "";
        const text = why || (detail ? detail.slice(0, 160) : "");
        const agent = a.harness ? (harnessById(a.harness) || {}).name || a.harness.charAt(0).toUpperCase() + a.harness.slice(1) : "";
        return "<li><strong class=\"el-label\">" + esc(label) + "</strong>" +
          '<small class="el-detail">' + (a.ok === false && !perm ? '<span class="problem bad">' + icon("alertCircle", "i-sm") + "Failed</span> " : "") + esc(text) + "</small>" +
          '<small class="faint el-meta">' + esc([agent, voice ? voice.name.split(" - ")[0] : "", a.at ? timeAgo(a.at) : ""].filter(Boolean).join(" · ")) + "</small></li>";
      }).join("") + "</ul>";
    };
    let leaveTimer = 0;
    let previewReq = 0; // bumps on every stop, so audio still loading is dropped
    const stopPreview = () => {
      previewReq++;
      clearInterval(leaveTimer);
      if (audio) {
        audio.pause();
        URL.revokeObjectURL(audio.src);
        audio = null;
      }
      st.playing = "";
    };
    // Plays base64 MP3 from the main process; leaving the pane stops it.
    const playBase64 = async (res, which) => {
      const bytes = Uint8Array.from(atob(res.dataBase64), (c) => c.charCodeAt(0));
      audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: res.mime || "audio/mpeg" })));
      audio.addEventListener("ended", () => {
        stopPreview();
        if (pane.isConnected) paint();
      });
      st.playing = which;
      await audio.play();
      leaveTimer = setInterval(() => {
        if (!pane.isConnected) stopPreview();
      }, 400);
    };
    const permList = (perms) =>
      '<ul class="el-perms' + (perms ? "" : " is-plain") + '">' + PERMS.map(([key, label, why]) => {
        const state = perms ? perms[key] : "";
        // Before a key is checked the list is a plain checklist with no marks.
        const mark = !perms ? "" : state === "ok" ? icon("check", "i-sm") : state === "missing" ? icon("xCircle", "i-sm") : icon("clock", "i-sm");
        const text = state === "ok" ? "" : state === "missing" ? "Missing" : key === "music_generation" && perms ? "Not checked yet" : "";
        return '<li class="' + (state === "missing" ? "is-missing" : state === "ok" ? "is-ok" : "") + '">' + mark + "<span><strong>" + esc(label) + "</strong><small>" + esc(why) + "</small></span>" + (text ? '<span class="faint">' + esc(text) + "</span>" : "") + "</li>";
      }).join("") + "</ul>";
    const keyForm = (label) =>
      '<div class="row el-key-row"><input class="input grow" type="password" data-key placeholder="Paste your ElevenLabs API key" autocomplete="off" spellcheck="false"><button class="btn btn-primary" data-save-key' + (st.busy === "save" ? " disabled" : "") + ">" + (st.busy === "save" ? icon("loader", "i-sm spin") : "") + "<span>" + esc(label) + "</span></button></div>";
    const accountLine = (t) => {
      if (!t) return st.busy === "test" ? icon("loader", "i-sm spin") + " Checking the key..." : "Not checked yet.";
      if (!t.ok) return "";
      const parts = ["Key works"];
      if (t.tier) parts.push("plan: " + (TIER_NAMES[t.tier] || t.tier.charAt(0).toUpperCase() + t.tier.slice(1).replace(/_/g, " ")));
      if (Number.isFinite(t.characterLimit)) parts.push((t.characterCount || 0).toLocaleString() + " of " + t.characterLimit.toLocaleString() + " characters used this month");
      return esc(parts.join(", ")) + ".";
    };
    const flagMarkup = (t) => {
      if (!t) return "";
      if (t.error) return '<p class="problem bad el-flag">' + icon("alertCircle", "i-sm") + esc(t.error) + "</p>";
      if (!t.flag) return "";
      return '<div class="el-flag notice' + (t.flag.level === "error" ? " is-bad" : "") + '">' + icon(t.flag.level === "error" ? "alertCircle" : "alert", "i-sm") + "<div><strong>" + esc(t.flag.title) + "</strong><div>" + esc(t.flag.message) + "</div></div></div>";
    };
    const setupMarkup = () =>
      '<div class="set-group el-setup">' +
      '<div class="set-group-title">Set up ElevenLabs</div>' +
      '<ol class="el-steps">' +
      "<li><span class=\"step-n\">1</span><div><strong>Make an API key</strong>" +
      "<p>Sign in at ElevenLabs (the free plan works), open API keys, and choose Create key. Turn on these permissions:</p>" +
      permList(null) +
      '<button class="btn" data-open-keys>' + icon("external", "i-sm") + "<span>Open ElevenLabs API keys</span></button></div></li>" +
      '<li><span class="step-n">2</span><div><strong>Paste the key here</strong><p>JV checks it right away. It is stored on this computer only.</p>' + keyForm("Save and check") + flagMarkup(st.test) + "</div></li>" +
      '<li><span class="step-n">3</span><div><strong>Pick a voice and try it</strong><p>Comes next, once the key works.</p></div></li>' +
      "</ol></div>";
    const paint = () => {
      const s = st.status || {};
      const voice = st.voices.find((v) => v.id === s.voiceId);
      const model = st.models.find((m) => m.id === s.model);
      const t = st.test;
      const chars = st.tryText.trim().length;
      pane.innerHTML =
        '<h2>Voice and music</h2><p class="lead">Agents use your ElevenLabs account for voiceovers and music beds. Each one uses characters from your ElevenLabs plan.</p>' +
        (!s.configured
          ? setupMarkup()
          : '<div class="set-group">' +
            '<div class="set-group-title">ElevenLabs account</div>' +
            row("Connected", "Key ends in " + (s.keyTail || "****") + (s.source === "env" ? ", read from ELEVENLABS_API_KEY" : ""),
              '<div class="row"><button class="btn btn-sm" data-test' + (st.busy === "test" ? " disabled" : "") + ">" + (st.busy === "test" ? icon("loader", "i-sm spin") : icon("refresh", "i-sm")) + "<span>Check again</span></button>" +
              (s.source !== "env" ? '<button class="btn btn-sm" data-replace>Replace key</button><button class="btn btn-sm btn-danger" data-clear>Remove</button>' : "") + "</div>") +
            '<div class="set-block"><p class="el-account">' + accountLine(t) + "</p>" + flagMarkup(t) + (t && t.permissions ? permList(t.permissions) : "") +
            (st.replacing ? '<div style="margin-top:12px">' + keyForm("Save new key") + "</div>" : "") + "</div></div>" +
            '<div class="set-group"><div class="set-group-title">Voice</div>' +
            row("Default voice", "Used for voiceovers. An agent can still use another voice when you ask for one.", '<div class="row">' +
              (voice && voice.preview ? '<button class="icon-btn" data-preview aria-label="' + (st.playing === "sample" ? "Stop sample" : "Play a sample of this voice") + '" title="' + (st.playing === "sample" ? "Stop sample" : "Play sample") + '">' + icon(st.playing === "sample" ? "stop" : "play") + "</button>" : "") +
              '<button class="picker is-boxed" data-voice><span>' + esc(voice ? voice.name : s.voiceName || (st.voices.length ? "ElevenLabs default" : "Loading voices...")) + "</span>" + icon("chevDown", "i-sm chev") + "</button></div>") +
            row("Speech quality", "The ElevenLabs speech model. This is not the agent's AI model.", '<button class="picker is-boxed" data-model><span>' + esc(model ? model.name : s.model || "Default") + "</span>" + icon("chevDown", "i-sm chev") + "</button>") +
            '<div class="set-block el-try"><label class="field-label" for="el-try">Try it</label><div class="row"><input id="el-try" class="input grow" data-try-text maxlength="200" value="' + esc(st.tryText) + '">' +
            '<button class="btn" data-try' + (st.busy === "try" || !chars ? " disabled" : "") + ">" + (st.busy === "try" ? icon("loader", "i-sm spin") : icon(st.playing === "try" ? "stop" : "play", "i-sm")) + "<span>" + (st.playing === "try" ? "Stop" : "Speak") + "</span></button></div>" +
            '<p class="field-help" data-try-cost>Uses ' + chars + " characters from your plan. Nothing is saved to your library.</p></div>" +
            "</div>") +
        '<div class="set-group">' +
        row("When an agent wants a voiceover or music", "Ask me shows the script first so you can say no.",
          '<div class="seg" data-access>' + [["ask", "Ask me"], ["always", "Always allow"], ["never", "Never"]].map(([v, l]) => '<button data-v="' + v + '" aria-pressed="' + ((s.agentAccess || "ask") === v) + '"' + ((s.agentAccess || "ask") === v ? ' class="is-on"' : "") + ">" + l + "</button>").join("") + "</div>") +
        "</div>" +
        '<details class="set-group el-history-wrap" data-history' + (st.historyOpen ? " open" : "") + '><summary class="set-group-title">Recent agent use</summary><div class="set-block">' + historyMarkup() + "</div></details>";
      wire();
    };
    const runTest = async () => {
      st.busy = "test";
      paint();
      try {
        st.test = await api.elevenlabsTest();
      } catch (error) {
        st.test = { ok: false, error: errorText(error) };
      }
      lastKeyCheck = st.test;
      st.busy = "";
      if (pane.isConnected) paint();
    };
    const wire = () => {
      const details = pane.querySelector("[data-history]");
      details.addEventListener("toggle", () => {
        st.historyOpen = details.open;
        if (details.open && !st.history) void loadHistory();
      });
      const openKeys = pane.querySelector("[data-open-keys]");
      if (openKeys) openKeys.addEventListener("click", () => api.openExternal("https://elevenlabs.io/app/settings/api-keys").catch((e) => toast(errorText(e), true)));
      const preview = pane.querySelector("[data-preview]");
      if (preview) preview.addEventListener("click", async () => {
        if (st.playing) {
          const was = st.playing;
          stopPreview();
          paint();
          if (was === "sample") return;
        }
        const v = st.voices.find((x) => x.id === (st.status || {}).voiceId);
        if (!v || !v.preview) return;
        const req = previewReq;
        st.playing = "sample";
        paint();
        try {
          const res = await api.elevenlabsVoicePreview({ url: v.preview });
          if (req !== previewReq || !pane.isConnected) return;
          await playBase64(res, "sample");
        } catch (error) {
          if (req !== previewReq) return;
          stopPreview();
          toast(errorText(error), true);
        }
        if (pane.isConnected) paint();
      });
      const tryInput = pane.querySelector("[data-try-text]");
      if (tryInput) tryInput.addEventListener("input", () => {
        st.tryText = tryInput.value;
        const n = st.tryText.trim().length;
        pane.querySelector("[data-try-cost]").textContent = "Uses " + n + " characters from your plan. Nothing is saved to your library.";
        pane.querySelector("[data-try]").disabled = !n || st.busy === "try";
      });
      const tryBtn = pane.querySelector("[data-try]");
      if (tryBtn) tryBtn.addEventListener("click", async () => {
        if (st.playing === "try") {
          stopPreview();
          paint();
          return;
        }
        stopPreview();
        const req = previewReq;
        st.busy = "try";
        paint();
        try {
          const res = await api.elevenlabsTry({ text: st.tryText });
          st.busy = "";
          if (req !== previewReq || !pane.isConnected) return;
          await playBase64(res, "try");
        } catch (error) {
          st.busy = "";
          if (req === previewReq) toast(errorText(error), true);
        }
        if (pane.isConnected) paint();
      });
      const save = pane.querySelector("[data-save-key]");
      if (save) {
        const keyInput = pane.querySelector("[data-key]");
        const doSave = async () => {
          const key = keyInput.value.trim();
          if (!key) {
            keyInput.focus();
            return;
          }
          st.busy = "save";
          paint();
          try {
            await api.elevenlabsSave({ apiKey: key, verify: true });
            st.replacing = false;
            st.busy = "";
            await load(true);
            await runTest();
            if (st.test && st.test.ok && !st.test.flag) toast("ElevenLabs is set up");
          } catch (error) {
            st.busy = "";
            st.test = { ok: false, error: errorText(error) };
            if (pane.isConnected) paint();
          }
        };
        save.addEventListener("click", doSave);
        keyInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void doSave();
        });
      }
      const test = pane.querySelector("[data-test]");
      if (test) test.addEventListener("click", () => void runTest());
      const replace = pane.querySelector("[data-replace]");
      if (replace) replace.addEventListener("click", () => {
        st.replacing = !st.replacing;
        paint();
        const k = pane.querySelector("[data-key]");
        if (k) k.focus();
      });
      const clear = pane.querySelector("[data-clear]");
      if (clear) clear.addEventListener("click", async () => {
        const ok = await confirmDialog({ title: "Remove the ElevenLabs key?", body: "Agents can no longer make voiceovers or music until you add a key again.", confirm: "Remove", danger: true });
        if (!ok) return;
        await api.elevenlabsClear().catch((e) => toast(errorText(e), true));
        st.test = null;
        lastKeyCheck = null;
        await load(false);
      });
      const voiceBtn = pane.querySelector("[data-voice]");
      if (voiceBtn) voiceBtn.addEventListener("click", (event) => {
        showMenu(event.currentTarget, st.voices.length ? st.voices.map((v) => ({
          label: v.name, sub: v.category || (v.labels && Object.values(v.labels).slice(0, 3).join(", ")) || "", checked: v.id === (st.status || {}).voiceId,
          onSelect: async () => {
            await api.elevenlabsSetVoice({ voiceId: v.id, voiceName: v.name }).catch((e) => toast(errorText(e), true));
            await load(false);
          },
        })) : [{ label: "No voices loaded", disabled: true }], { search: "Search voices", width: 300, align: "end" });
      });
      const modelBtn = pane.querySelector("[data-model]");
      if (modelBtn) modelBtn.addEventListener("click", (event) => {
        showMenu(event.currentTarget, st.models.length ? st.models.map((m) => ({
          label: m.name, sub: String(m.description || "").slice(0, 80), checked: m.id === (st.status || {}).model,
          onSelect: async () => {
            await api.elevenlabsSetModel({ model: m.id }).catch((e) => toast(errorText(e), true));
            await load(false);
          },
        })) : [{ label: "No models loaded", disabled: true }], { width: 320, align: "end" });
      });
      pane.querySelector("[data-access]").addEventListener("click", async (event) => {
        const b = event.target.closest("[data-v]");
        if (!b) return;
        await api.elevenlabsSetAccess({ mode: b.dataset.v }).catch((e) => toast(errorText(e), true));
        await load(false);
      });
    };
    const loadHistory = async () => {
      try {
        const res = await api.elevenlabsHistory();
        st.history = (res && res.actions) || [];
      } catch (error) {
        st.history = { error: errorText(error) };
      }
      if (pane.isConnected) paint();
    };
    const load = async (lists) => {
      try {
        st.status = await api.elevenlabsStatus();
        store.elevenlabsReady = Boolean(st.status && st.status.configured);
        paint();
        if (st.status.configured && (lists || !st.voices.length)) {
          const [v, m] = await Promise.all([api.elevenlabsVoices().catch(() => ({ voices: [] })), api.elevenlabsModels().catch(() => ({ models: [] }))]);
          st.voices = v.voices || [];
          st.models = m.models || [];
        }
      } catch (error) {
        toast(errorText(error), true);
      }
      if (pane.isConnected) paint();
    };
    pane.innerHTML = '<p class="faint">Loading...</p>';
    void load(true).then(() => {
      // The account line needs one check per app session; later visits reuse it.
      if (st.status && st.status.configured && !st.test) void runTest();
    });
    return stopPreview;
  },

  plugins(pane) {
    const st = { list: null, error: "" };
    const STATUS = {
      on: "On",
      off: "Off",
      changed: "Changed since you turned it on. Check the code, then turn it on again.",
      broken: "plugin.js is missing",
    };
    const makePlugin = () => {
      emit("navigate", { page: "home" });
      setTimeout(() => {
        const box = document.querySelector("[data-launch-input]");
        if (!box) return;
        box.value = "/plugin ";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }, 60);
    };
    const showCode = async (p, approve) => {
      let full;
      try {
        full = await api.pluginsRead({ id: p.id });
      } catch (error) {
        toast(errorText(error), true);
        return false;
      }
      return new Promise((resolve) => {
        let answered = false;
        const dlg = openDialog({
          title: (approve ? "Turn on " : "") + full.name,
          wide: true,
          body:
            (approve ? '<p class="dialog-text">Plugins can do anything JV can, like reading your projects and library. Turn it on only if you trust what it does. If it changes later, it turns off until you check it again.</p>' : "") +
            '<p class="faint" style="margin:8px 0">' + esc([full.description, full.author ? "Made by " + agentName(full.author) : "", formatBytes(full.size)].filter(Boolean).join(" · ")) + "</p>" +
            '<pre class="code-view selectable"><code>' + esc(full.code) + "</code></pre>",
          foot: approve ? '<button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary" data-yes>Turn on</button>' : '<button class="btn" data-no>Close</button>',
          onClose: () => {
            if (!answered) resolve(false);
          },
        });
        dlg.querySelector("[data-no]").addEventListener("click", () => closeDialog());
        const yes = dlg.querySelector("[data-yes]");
        if (yes) yes.addEventListener("click", () => {
          answered = true;
          resolve(true);
          closeDialog();
        });
      });
    };
    const showErrors = (p) => {
      openDialog({
        title: "Errors from " + p.name,
        wide: true,
        body: p.errors.length
          ? '<p class="dialog-text">Ask an agent to fix it, for example: "Fix the ' + esc(p.name) + ' plugin". Agents can read these errors.</p>' +
            p.errors.slice().reverse().map((e) => '<div class="plugin-err"><small class="faint">' + esc(timeAgo(e.at)) + (e.count > 1 ? " · " + e.count + " times" : "") + '</small><pre class="selectable">' + esc(e.message) + "</pre></div>").join("")
          : '<p class="dialog-text">No errors recorded.</p>',
        foot: '<button class="btn" data-no>Close</button>',
      }).querySelector("[data-no]").addEventListener("click", () => closeDialog());
    };
    const agentName = (id) => (harnessById(id) || {}).name || String(id || "").split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const paint = () => {
      const list = st.list;
      pane.innerHTML =
        '<div class="row" style="align-items:flex-start"><div class="grow"><h2>Plugins</h2><p class="lead">Plugins add commands, pages and buttons to JV. Agents make them, and you choose which ones run.</p></div>' +
        '<button class="btn btn-primary" data-make>' + icon("plus", "i-sm") + "<span>Make a plugin</span></button></div>" +
        (st.error ? '<p class="problem bad">' + icon("alertCircle", "i-sm") + esc(st.error) + "</p>" : "") +
        (!list
          ? '<p class="faint">Loading plugins...</p>'
          : !list.length
            ? '<div class="set-group"><div class="empty">' + icon("puzzle", "i-xl") + "<h3>No plugins yet</h3><p>Ask an agent for one, for example: add a word count button to projects, or a page that lists my longest videos.</p></div></div>"
            : '<div class="set-group">' + list.map((p) => {
                const meta = [p.author ? "Made by " + agentName(p.author) : "", p.updatedAt ? "updated " + timeAgo(p.updatedAt) : "", formatBytes(p.size)].filter(Boolean).join(" · ");
                const errs = p.errors.reduce((n, e) => n + (e.count || 1), 0);
                return '<div class="set-row plugin-row" data-plugin="' + esc(p.id) + '"><div class="label"><strong>' + esc(p.name) + "</strong>" +
                  (p.description ? "<small>" + esc(p.description) + "</small>" : "") +
                  '<small class="faint">' + esc(meta) + "</small>" +
                  (p.status === "changed" || p.status === "broken" ? '<small class="problem warn">' + icon("alert", "i-sm") + esc(STATUS[p.status]) + "</small>" : "") +
                  (errs ? '<button class="link-btn problem bad" data-errors>' + icon("alertCircle", "i-sm") + errs + (errs === 1 ? " error" : " errors") + ", show</button>" : "") +
                  "</div>" +
                  '<label class="switch" title="' + (p.status === "on" ? "Turn off" : "Turn on") + '"><input type="checkbox" data-plugin-toggle aria-label="' + esc(p.name) + ' on"' + (p.status === "on" ? " checked" : "") + (p.status === "broken" ? " disabled" : "") + "><span></span></label>" +
                  '<button class="icon-btn" data-plugin-more title="Plugin options" aria-label="Options for ' + esc(p.name) + '">' + icon("more") + "</button></div>";
              }).join("") + "</div>" +
              '<p class="field-help">Plugins are kept in your JV data folder. <button class="link-btn" data-open-folder>Open the plugins folder</button></p>');
      wire();
    };
    const find = (el) => (st.list || []).find((p) => p.id === el.closest("[data-plugin]").dataset.plugin);
    const changed = () => emit("plugins-changed", {});
    const wire = () => {
      pane.querySelector("[data-make]").addEventListener("click", makePlugin);
      const folder = pane.querySelector("[data-open-folder]");
      if (folder) folder.addEventListener("click", () => api.pluginsOpenFolder({}).catch((e) => toast(errorText(e), true)));
      pane.querySelectorAll("[data-plugin-toggle]").forEach((box) => box.addEventListener("change", async () => {
        const p = find(box);
        if (!p) return;
        const want = box.checked;
        // Turning on is the approval: it shows the code first.
        if (want && !(await showCode(p, true))) {
          box.checked = false;
          return;
        }
        try {
          await api.pluginsSetEnabled({ id: p.id, enabled: want });
          toast(want ? p.name + " is on" : p.name + " is off");
        } catch (error) {
          toast(errorText(error), true);
        }
        changed();
        await load();
      }));
      pane.querySelectorAll("[data-errors]").forEach((b) => b.addEventListener("click", () => {
        const p = find(b);
        if (p) showErrors(p);
      }));
      pane.querySelectorAll("[data-plugin-more]").forEach((b) => b.addEventListener("click", (event) => {
        const p = find(b);
        if (!p) return;
        showMenu(event.currentTarget, [
          { label: "View code", icon: "file", onSelect: () => void showCode(p, false) },
          { label: "Show errors", icon: "alertCircle", disabled: !p.errors.length, onSelect: () => showErrors(p) },
          { label: "Open its folder", icon: "folder", onSelect: () => api.pluginsOpenFolder({ id: p.id }).catch((e) => toast(errorText(e), true)) },
          "sep",
          {
            label: "Remove plugin",
            icon: "trash",
            danger: true,
            onSelect: async () => {
              const ok = await confirmDialog({ title: "Remove " + p.name + "?", body: "Its code and saved data are deleted. An agent can make it again later.", confirm: "Remove", danger: true });
              if (!ok) return;
              try {
                await api.pluginsRemove({ id: p.id });
                toast(p.name + " removed");
              } catch (error) {
                toast(errorText(error), true);
              }
              changed();
              await load();
            },
          },
        ], { align: "end" });
      }));
    };
    const load = async () => {
      try {
        st.list = await api.pluginsList();
        st.error = "";
      } catch (error) {
        st.list = st.list || [];
        st.error = errorText(error);
      }
      if (pane.isConnected) paint();
    };
    // An agent writing a plugin while this page is open shows up at once.
    const off = on("plugins-changed", () => void load());
    paint();
    void load();
    return off;
  },

  storage(pane) {
    // Mixed from tokens, so caches stay visible on the card in dark and light
    // (the plain surface token vanished into the dark card).
    const COLORS = { video: "var(--accent)", render: "var(--ok)", image: "var(--text-2)", audio: "var(--warn)", leftover: "var(--danger)", cache: "color-mix(in oklab, var(--text-3) 45%, var(--bg-3))", other: "var(--text-3)" };
    const st = { report: null, job: null, imp: null, importing: null };
    const paint = () => {
      const r = st.report;
      const job = st.job;
      const plan = r && r.plan;
      const save = plan ? (plan.videos.estimateBytes || 0) + (plan.images.estimateBytes || 0) + (plan.copies.estimateBytes || 0) + (plan.caches.estimateBytes || 0) : 0;
      pane.innerHTML =
        "<h2>Storage</h2><p class=\"lead\">Everything stays on this computer.</p>" +
        '<div class="set-group"><div class="set-block">' +
        (r
          ? '<div class="row"><strong style="font-size:var(--fs-lg)">' + esc(formatBytes(r.totalBytes)) + '</strong><span class="faint">used</span><span class="grow"></span><button class="btn btn-sm btn-ghost" data-rescan>' + icon("refresh", "i-sm") + "Rescan</button></div>" +
            '<div class="storage-bar">' + r.categories.map((c) => '<span style="width:' + Math.max(0.5, (c.bytes / Math.max(1, r.totalBytes)) * 100) + "%;background:" + (COLORS[c.id] || "var(--text-3)") + '" title="' + esc(c.label) + '"></span>').join("") + "</div>" +
            '<div class="legend">' + r.categories.map((c) => '<span><i style="background:' + (COLORS[c.id] || "var(--text-3)") + '"></i>' + esc(c.label) + " " + esc(formatBytes(c.bytes)) + "</span>").join("") + "</div>"
          : '<span class="faint">' + icon("loader", "i-sm spin") + ' Measuring how much space JV uses. This can take a minute on a big library.</span>') +
        "</div>" +
        (job && job.running
          ? '<div class="set-block"><div class="row"><span class="grow">' + esc((job.progress && job.progress.label) || "Working") + '</span><button class="btn btn-sm" data-cancel>Cancel</button></div>' +
            '<div class="progress" style="margin-top:8px"><span style="width:' + progressPct(job.progress) + '%"></span></div></div>'
          : r ? row("Make files smaller", save ? "Re-encodes videos and images without visible loss, removes duplicate copies and caches. About " + formatBytes(save) + " can be saved. You confirm first." : "Re-encodes videos and images without visible loss, and removes duplicate copies and caches. You confirm first.",
              '<button class="btn btn-primary" data-optimize>Free up space</button>') : "") +
        (job && !job.running && job.finishedAt ? '<div class="set-block faint" style="font-size:var(--fs-sm)">' + (job.error ? '<span class="problem bad">' + icon("alertCircle", "i-sm") + esc(job.error) + "</span>" : "Last run finished " + esc(timeAgo(job.finishedAt)) + ".") + "</div>" : "") +
        "</div>" +
        (r && r.leftovers && r.leftovers.length
          ? '<div class="set-group"><div class="set-group-title">Leftover files</div>' +
            r.leftovers.map((g) => row(g.label + " · " + formatBytes(g.bytes), plainNote(g.note), '<div class="row"><button class="btn btn-sm" data-open-left="' + esc(g.id) + '" title="Open the folder so you can see the files first">' + icon("folder", "i-sm") + 'Show files</button><button class="btn btn-sm btn-danger" data-del-left="' + esc(g.id) + '">Delete</button></div>')).join("") + "</div>"
          : "") +
        // Import only matters while JV is empty and a Cutline library exists.
        (st.importing || (st.imp && st.imp.exists && st.imp.canImport) ? '<div class="set-group"><div class="set-group-title">Bring over Cutline Desktop</div>' : "<!--") +
        (st.importing
          ? '<div class="set-block"><div class="row"><span class="grow">Copying ' + esc(formatBytes(st.importing.done)) + " of " + esc(formatBytes(st.importing.total)) + '</span></div><div class="progress" style="margin-top:8px"><span style="width:' + Math.round((st.importing.done / Math.max(1, st.importing.total)) * 100) + '%"></span></div></div>'
          : st.imp && st.imp.exists
            ? row("Import your Cutline library", st.imp.canImport ? "Copies projects, chats, media, skills, and settings (" + formatBytes(st.imp.bytes) + "). Cutline Desktop keeps its own copy." : "Import works only while JV has no projects or media of its own.",
                '<button class="btn" data-import' + (st.imp.canImport ? "" : " disabled") + ">" + icon("download") + "Import</button>")
            : "") +
        (st.importing || (st.imp && st.imp.exists && st.imp.canImport) ? "</div>" : "-->") +
        '<div class="set-group">' + row("Data folder", "Where JV keeps your library, projects, and chats.", '<button class="btn" data-folder>' + icon("folder") + "Open folder</button>") + "</div>";
      // Notes from the scanner use internal words; say it plainly.
      function plainNote(note) {
        return String(note || "")
          .replace(/no library row points at/gi, "no library item uses")
          .replace(/library rows?/gi, "library items")
          .replace(/,? ?the Recorder agent, which is no longer in the app/gi, " an old recording feature");
      }
      wire();
    };
    const wire = () => {
      const q = (s) => pane.querySelector(s);
      if (q("[data-rescan]")) q("[data-rescan]").addEventListener("click", () => load());
      if (q("[data-optimize]")) q("[data-optimize]").addEventListener("click", async () => {
        const plan = st.report && st.report.plan;
        const parts = plan
          ? [[plan.videos, "videos re-encoded smaller"], [plan.images, "images re-encoded smaller"], [plan.copies, "duplicate copies removed"], [plan.caches, "caches cleared"]]
              .filter(([p]) => p && (p.count || p.estimateBytes))
              .map(([p, what]) => (p.count ? p.count + " " : "") + what + (p.estimateBytes ? " (about " + formatBytes(p.estimateBytes) + ")" : ""))
          : [];
        const ok = await confirmDialog({
          title: "Free up space?",
          body: "JV will change files in your library:\n" + (parts.length ? parts.map((x) => "- " + x).join("\n") : "- videos and images re-encoded smaller\n- duplicate copies and caches removed") + "\n\nThe originals are replaced and this cannot be undone. Projects keep working.",
          confirm: "Free up space",
          danger: true,
        });
        if (!ok) return;
        try {
          st.job = await api.storageOptimizeStart({});
          paint();
        } catch (error) {
          toast(errorText(error), true);
        }
      });
      if (q("[data-cancel]")) q("[data-cancel]").addEventListener("click", () => api.storageOptimizeCancel());
      pane.querySelectorAll("[data-open-left]").forEach((b) => b.addEventListener("click", () => api.storageLeftoverOpen({ id: b.dataset.openLeft }).catch((e) => toast(errorText(e), true))));
      pane.querySelectorAll("[data-del-left]").forEach((b) =>
        b.addEventListener("click", async () => {
          const ok = await confirmDialog({ title: "Delete these files?", body: "They are not used by any project or library item. This cannot be undone.", confirm: "Delete", danger: true });
          if (!ok) return;
          try {
            await api.storageLeftoverDelete({ id: b.dataset.delLeft, mode: "all" });
            toast("Deleted");
            await load();
          } catch (error) {
            toast(errorText(error), true);
          }
        }),
      );
      if (q("[data-folder]")) q("[data-folder]").addEventListener("click", () => api.openDataFolder().catch((e) => toast(errorText(e), true)));
      if (q("[data-import]")) q("[data-import]").addEventListener("click", async () => {
        const ok = await confirmDialog({ title: "Import from Cutline Desktop?", body: "JV copies " + formatBytes(st.imp.bytes) + " and restarts when it finishes. Close Cutline Desktop first so its files are not changing.", confirm: "Import" });
        if (!ok) return;
        st.importing = { done: 0, total: st.imp.bytes };
        paint();
        const off = api.onImportProgress((m) => {
          st.importing = m;
          paint();
        });
        try {
          await api.cutlineImport();
          toast("Import finished. Restarting...");
          setTimeout(() => api.relaunch(), 600);
        } catch (error) {
          st.importing = null;
          toast(errorText(error), true);
          paint();
        } finally {
          off();
        }
      });
    };
    // Each part paints as it arrives: measuring a big Cutline library can
    // take a while and must not hold up the storage report.
    const load = () => {
      const part = (call, key) =>
        call()
          .then((value) => {
            st[key] = value;
            paint();
          })
          .catch((error) => toast(errorText(error), true));
      void part(() => api.storageReport(), "report");
      void part(() => api.storageOptimizeStatus(), "job");
      void part(() => api.cutlineImportStatus(), "imp");
    };
    paint();
    void load();
    return on("storage-job", (m) => {
      if (m && m.status) st.job = m.status;
      if (m && m.type === "done") void load();
      else paint();
    });
  },

  about(pane) {
    pane.innerHTML = "<h2>About</h2><p class=\"lead\">JV, an AI video editor that works with the AI agents on your computer.</p><div class=\"set-group\"><div class=\"set-block\" data-kv>Loading...</div></div>";
    api.about().then((a) => {
      pane.querySelector("[data-kv]").innerHTML =
        '<dl class="kv">' +
        "<dt>Version</dt><dd>" + esc(a.version) + "</dd>" +
        "<dt>Electron</dt><dd>" + esc(a.electron) + "</dd>" +
        "<dt>Chromium</dt><dd>" + esc(a.chrome) + "</dd>" +
        "<dt>Node</dt><dd>" + esc(a.node) + "</dd>" +
        "</dl>" +
        '<p class="faint" style="font-size:var(--fs-sm);margin-top:10px">Your data folder is under Storage. Agent errors are on the Agents page.</p>';
    }).catch(() => {});
  },
};
