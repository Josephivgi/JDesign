const { contextBridge, ipcRenderer, webUtils } = require("electron");

let captureSetupStatusInflight = null;
let listCaptureSourcesInflight = null;

contextBridge.exposeInMainWorld("cutline", {
  snapshot: () => ipcRenderer.invoke("snapshot"),
  bundledSkills: () => ipcRenderer.invoke("bundled-skills"),
  userSkills: () => ipcRenderer.invoke("user-skills-list"),
  saveUserSkill: (payload) => ipcRenderer.invoke("user-skill-save", payload),
  createUserSkill: (payload) => ipcRenderer.invoke("user-skill-create", payload),
  removeUserSkill: (payload) => ipcRenderer.invoke("user-skill-remove", payload),
  getUserInstructions: () => ipcRenderer.invoke("user-instructions-get"),
  saveUserInstructions: (text) => ipcRenderer.invoke("user-instructions-save", text),
  userRules: () => ipcRenderer.invoke("user-rules-get"),
  saveUserRules: (rules) => ipcRenderer.invoke("user-rules-save", { rules }),
  userRulesDraft: () => ipcRenderer.invoke("user-rules-draft-get"),
  saveUserRulesDraft: (draft) => ipcRenderer.invoke("user-rules-draft-save", { draft }),
  // The accent applyLook just set on <html> rides along, so the Draw studio follows it.
  setChrome: (payload) => ipcRenderer.invoke("set-chrome", Object.assign({}, payload, { accent: document.documentElement.dataset.accent || "mono" })),
  setStudio: (to) => ipcRenderer.invoke("studio-switch", to),
  currentStudio: () => ipcRenderer.invoke("studio-current"),
  onStudioChanged: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("studio-changed", listen);
    return () => ipcRenderer.removeListener("studio-changed", listen);
  },
  onStudioTheme: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("studio-theme", listen);
    return () => ipcRenderer.removeListener("studio-theme", listen);
  },
  pickFiles: (kind) => ipcRenderer.invoke("pick-files", kind),
  addFiles: (payload) => ipcRenderer.invoke("add-files", payload),
  // Byte progress while dropped files copy into the library, so the page can
  // show a real bar instead of a silent wait.
  onAddFilesProgress: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("add-files-progress", listen);
    return () => ipcRenderer.removeListener("add-files-progress", listen);
  },
  addBuffer: (payload) => ipcRenderer.invoke("add-buffer", payload),
  addTakeFile: (payload) => ipcRenderer.invoke("add-take-file", payload),
  takeWriteStart: (payload) => ipcRenderer.invoke("take-write-start", payload),
  takeWriteChunk: (payload) => ipcRenderer.invoke("take-write-chunk", payload),
  takeWriteFinish: (payload) => ipcRenderer.invoke("take-write-finish", payload),
  takeWriteAbort: (payload) => ipcRenderer.invoke("take-write-abort", payload),
  listCaptureSources: () => {
    if (listCaptureSourcesInflight) return listCaptureSourcesInflight;
    listCaptureSourcesInflight = ipcRenderer
      .invoke("list-capture-sources")
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => [])
      .finally(() => {
        listCaptureSourcesInflight = null;
      });
    return listCaptureSourcesInflight;
  },
  captureSourceThumbnails: (payload) => ipcRenderer.invoke("capture-source-thumbnails", payload),
  setCaptureSource: (payload) => ipcRenderer.invoke("set-capture-source", payload),
  setCaptureIntent: (payload) => ipcRenderer.invoke("set-capture-intent", payload),
  resetCaptureConsent: (payload) => ipcRenderer.invoke("reset-capture-consent", payload),
  captureSetupStatus: (payload) => {
    if (payload && payload.full) {
      return ipcRenderer.invoke("capture-setup-status", { full: true });
    }
    if (captureSetupStatusInflight) return captureSetupStatusInflight;
    captureSetupStatusInflight = ipcRenderer.invoke("capture-setup-status").finally(() => {
      captureSetupStatusInflight = null;
    });
    return captureSetupStatusInflight;
  },
  ensureCaptureAccess: (payload) => ipcRenderer.invoke("ensure-capture-access", payload),
  openCaptureSettings: (payload) => ipcRenderer.invoke("open-capture-settings", payload),
  waitCaptureAccess: (payload) => ipcRenderer.invoke("wait-capture-access", payload),
  cancelCaptureWait: (payload) => ipcRenderer.invoke("cancel-capture-wait", payload),
  promptCaptureAccess: (payload) => ipcRenderer.invoke("prompt-capture-access", payload),
  reportCaptureDenied: (payload) => ipcRenderer.invoke("report-capture-denied", payload),
  markCaptureApproved: (payload) => ipcRenderer.invoke("mark-capture-approved", payload),
  saveRecordCenterPrefs: (payload) => ipcRenderer.invoke("save-record-center-prefs", payload),
  startCountdownOverlay: (payload) => ipcRenderer.invoke("start-countdown-overlay", payload),
  stopCountdownOverlay: () => ipcRenderer.invoke("stop-countdown-overlay"),
  logRecorder: (payload) => ipcRenderer.send("recorder-log", payload),
  onCountdownTick: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-tick", listen);
    return () => ipcRenderer.removeListener("countdown-tick", listen);
  },
  onCountdownFinished: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-finished", listen);
    return () => ipcRenderer.removeListener("countdown-finished", listen);
  },
  onCountdownBounds: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-bounds", listen);
    return () => ipcRenderer.removeListener("countdown-bounds", listen);
  },
  onRecordingOverlayStop: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("recording-overlay-stop", listen);
    return () => ipcRenderer.removeListener("recording-overlay-stop", listen);
  },
  onRecordingOverlayPause: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("recording-overlay-pause", listen);
    return () => ipcRenderer.removeListener("recording-overlay-pause", listen);
  },
  onOverlayClosed: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-overlay-closed", listen);
    return () => ipcRenderer.removeListener("countdown-overlay-closed", listen);
  },
  onOverlaySetTarget: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-set-target", listen);
    return () => ipcRenderer.removeListener("overlay-set-target", listen);
  },
  overlayRecordNow: () => ipcRenderer.send("countdown-overlay-start"),
  prewarmRecorderBar: () => ipcRenderer.send("prewarm-recorder-bar"),
  onOverlayNudgeDelay: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-nudge-delay", listen);
    return () => ipcRenderer.removeListener("overlay-nudge-delay", listen);
  },
  onOverlayNudgeFps: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-nudge-fps", listen);
    return () => ipcRenderer.removeListener("overlay-nudge-fps", listen);
  },
  onOverlayToggleSound: (handler) => {
    const listen = () => handler();
    ipcRenderer.on("overlay-toggle-sound", listen);
    return () => ipcRenderer.removeListener("overlay-toggle-sound", listen);
  },
  updateCountdownOverlay: (payload) => ipcRenderer.invoke("update-countdown-overlay", payload),
  updateLibraryItem: (id, patch) => ipcRenderer.invoke("update-library-item", { id, patch }),
  deleteLibraryItem: (id) => ipcRenderer.invoke("delete-library-item", id),
  mediaCleanupScan: (payload) => ipcRenderer.invoke("media-cleanup-scan", payload),
  mediaCleanupDelete: (payload) => ipcRenderer.invoke("media-cleanup-delete", payload),
  mediaCleanupDeleteMany: (payload) => ipcRenderer.invoke("media-cleanup-delete-many", payload),
  storageReport: () => ipcRenderer.invoke("storage-report"),
  storageOptimizeStart: (payload) => ipcRenderer.invoke("storage-optimize-start", payload),
  storageOptimizeCancel: () => ipcRenderer.invoke("storage-optimize-cancel"),
  storageOptimizeStatus: () => ipcRenderer.invoke("storage-optimize-status"),
  storageLeftoverDelete: (payload) => ipcRenderer.invoke("storage-leftover-delete", payload),
  storageLeftoverOpen: (payload) => ipcRenderer.invoke("storage-leftover-open", payload),
  // Progress of the free-up-space job, and a note whenever it swapped a file
  // so open pages pick up the new size.
  onStorageJob: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("storage-job", listen);
    return () => ipcRenderer.removeListener("storage-job", listen);
  },
  updateFinishedItem: (id, patch) => ipcRenderer.invoke("update-finished-item", { id, patch }),
  deleteFinishedItem: (id) => ipcRenderer.invoke("delete-finished-item", id),
  openFinishedItem: (id) => ipcRenderer.invoke("open-finished-item", id),
  exportFinishedItem: (id) => ipcRenderer.invoke("export-finished-item", id),
  createLink: (refs) => ipcRenderer.invoke("create-link", { refs }),
  deleteLink: (id) => ipcRenderer.invoke("delete-link", id),
  saveCard: (card) => ipcRenderer.invoke("save-card", card),
  deleteCard: (id) => ipcRenderer.invoke("delete-card", id),
  listCardTemplates: () => ipcRenderer.invoke("list-card-templates"),
  listCardTemplateStore: () => ipcRenderer.invoke("list-card-template-store"),
  installCardTemplate: (payload) => ipcRenderer.invoke("install-card-template", payload),
  saveCardTemplate: (payload) => ipcRenderer.invoke("save-card-template", payload),
  renderCard: (payload) => ipcRenderer.invoke("render-card", payload),
  cardHtmlDocument: (payload) => ipcRenderer.invoke("card-html-document", payload),
  exportCardPng: (payload) => ipcRenderer.invoke("export-card-png", payload),
  composeFinished: (payload) => ipcRenderer.invoke("compose-finished", payload),
  elevenlabsStatus: () => ipcRenderer.invoke("elevenlabs-status"),
  elevenlabsSave: (payload) => ipcRenderer.invoke("elevenlabs-save", payload),
  elevenlabsClear: () => ipcRenderer.invoke("elevenlabs-clear"),
  elevenlabsTest: () => ipcRenderer.invoke("elevenlabs-test"),
  elevenlabsVoices: () => ipcRenderer.invoke("elevenlabs-voices"),
  elevenlabsVoicePreview: (payload) => ipcRenderer.invoke("elevenlabs-voice-preview", payload),
  elevenlabsModels: () => ipcRenderer.invoke("elevenlabs-models"),
  elevenlabsSetModel: (payload) => ipcRenderer.invoke("elevenlabs-set-model", payload),
  elevenlabsTts: (payload) => ipcRenderer.invoke("elevenlabs-tts", payload),
  elevenlabsMusic: (payload) => ipcRenderer.invoke("elevenlabs-music", payload),
  elevenlabsSetVoice: (payload) => ipcRenderer.invoke("elevenlabs-set-voice", payload),
  elevenlabsSetAccess: (payload) => ipcRenderer.invoke("elevenlabs-set-access", payload),
  elevenlabsHistory: () => ipcRenderer.invoke("elevenlabs-history"),
  elevenlabsTry: (payload) => ipcRenderer.invoke("elevenlabs-try", payload),
  voiceTranscribe: (payload) => ipcRenderer.invoke("voice-transcribe", payload),
  voiceSpeak: (payload) => ipcRenderer.invoke("voice-speak", payload),
  voiceWindowsVoices: () => ipcRenderer.invoke("voice-windows-voices"),
  pluginsList: () => ipcRenderer.invoke("plugins-list"),
  pluginsRead: (payload) => ipcRenderer.invoke("plugins-read", payload),
  pluginsSetEnabled: (payload) => ipcRenderer.invoke("plugins-set-enabled", payload),
  pluginsRemove: (payload) => ipcRenderer.invoke("plugins-remove", payload),
  pluginsError: (payload) => ipcRenderer.invoke("plugins-error", payload),
  pluginsDataGet: (payload) => ipcRenderer.invoke("plugins-data-get", payload),
  pluginsDataSet: (payload) => ipcRenderer.invoke("plugins-data-set", payload),
  pluginsOpenFolder: (payload) => ipcRenderer.invoke("plugins-open-folder", payload),
  addCardImage: (payload) => ipcRenderer.invoke("add-card-image", payload),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  agentErrors: (payload) => ipcRenderer.invoke("agent-errors", payload),
  agentErrorsReveal: () => ipcRenderer.invoke("agent-errors-reveal"),
  editorChats: (payload) => ipcRenderer.invoke("editor-chats", payload),
  editorChatGet: (payload) => ipcRenderer.invoke("editor-chat-get", payload),
  editorChatCreate: (payload) => ipcRenderer.invoke("editor-chat-create", payload),
  editorChatActive: (payload) => ipcRenderer.invoke("editor-chat-active", payload),
  editorChatOpen: (payload) => ipcRenderer.invoke("editor-chat-open", payload),
  editorChatAppend: (payload) => ipcRenderer.invoke("editor-chat-append", payload),
  editorChatSave: (payload) => ipcRenderer.invoke("editor-chat-save", payload),
  editorChatDelete: (payload) => ipcRenderer.invoke("editor-chat-delete", payload),
  editorChatUpdate: (payload) => ipcRenderer.invoke("editor-chat-update", payload),
  aiProjects: () => ipcRenderer.invoke("ai-projects-list"),
  aiProjectGet: (payload) => ipcRenderer.invoke("ai-project-get", payload),
  aiProjectCreate: (payload) => ipcRenderer.invoke("ai-project-create", payload),
  aiProjectUpdate: (payload) => ipcRenderer.invoke("ai-project-update", payload),
  aiProjectRestorePrevious: (payload) => ipcRenderer.invoke("ai-project-restore-previous", payload),
  aiProjectRender: (payload) => ipcRenderer.invoke("ai-project-render", payload),
  aiProjectEditTimeline: (payload) => ipcRenderer.invoke("ai-project-edit-timeline", payload),
  aiProjectTakeUserEdits: (payload) => ipcRenderer.invoke("ai-project-take-user-edits", payload),
  aiProjectAddAssets: (payload) => ipcRenderer.invoke("ai-project-add-assets", payload),
  aiProjectAddFinished: (payload) => ipcRenderer.invoke("ai-project-add-finished", payload),
  aiProjectRemoveAsset: (payload) => ipcRenderer.invoke("ai-project-remove-asset", payload),
  aiProjectDelete: (payload) => ipcRenderer.invoke("ai-project-delete", payload),
  copyText: (text) => ipcRenderer.invoke("clipboard-write-text", text),
  acpHarnesses: () => ipcRenderer.invoke("acp-harnesses"),
  acpSession: (payload) => ipcRenderer.invoke("acp-session", payload),
  acpStart: (payload) => ipcRenderer.invoke("acp-start", payload),
  acpAuthenticate: (payload) => ipcRenderer.invoke("acp-authenticate", payload),
  acpPrompt: (payload) => ipcRenderer.invoke("acp-prompt", payload),
  acpCancel: (payload) => ipcRenderer.invoke("acp-cancel", payload),
  acpPermissionAnswer: (payload) => ipcRenderer.invoke("acp-permission-answer", payload),
  acpStop: (payload) => ipcRenderer.invoke("acp-stop", payload),
  acpHandoff: (payload) => ipcRenderer.invoke("acp-handoff", payload),
  acpModels: (payload) => ipcRenderer.invoke("acp-models", payload),
  acpSlashCommands: (payload) => ipcRenderer.invoke("acp-slash-commands", payload),
  animationPresets: () => ipcRenderer.invoke("animation-presets"),
  animationPresetThumbs: (payload) => ipcRenderer.invoke("animation-preset-thumbs", payload),
  animationPresetRender: (payload) => ipcRenderer.invoke("animation-preset-render", payload),
  animationPresetStill: (payload) => ipcRenderer.invoke("animation-preset-still", payload),
  animationPresetMotion: (payload) => ipcRenderer.invoke("animation-preset-motion", payload),
  acpModelsCache: () => ipcRenderer.invoke("acp-models-cache"),
  acpModelsCacheSet: (payload) => ipcRenderer.invoke("acp-models-cache-set", payload),
  acpMarketplace: () => ipcRenderer.invoke("acp-marketplace"),
  acpAgentAdd: (payload) => ipcRenderer.invoke("acp-agent-add", payload),
  acpAgentRemove: (payload) => ipcRenderer.invoke("acp-agent-remove", payload),
  acpRegistry: (payload) => ipcRenderer.invoke("acp-registry", payload),
  acpRegistryInstall: (payload) => ipcRenderer.invoke("acp-registry-install", payload),
  onAcpRegistryProgress: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("acp-registry-progress", listen);
    return () => ipcRenderer.removeListener("acp-registry-progress", listen);
  },
  onAcpEvent: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("acp-event", listen);
    return () => ipcRenderer.removeListener("acp-event", listen);
  },
  onBridgeCommand: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("bridge-command", listen);
    return () => ipcRenderer.removeListener("bridge-command", listen);
  },
  // The MCP bridge broadcasts "workspace-changed" when an agent mutates the
  // workspace, so an open page can repaint without a reopen.
  onAgentEvent: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("agent-event", listen);
    return () => ipcRenderer.removeListener("agent-event", listen);
  },
  bridgeCommandReply: (payload) => ipcRenderer.invoke("bridge-command-reply", payload),
  // JV
  prefs: () => ipcRenderer.invoke("jeditor-prefs-get"),
  setPrefs: (patch) => ipcRenderer.invoke("jeditor-prefs-set", patch),
  about: () => ipcRenderer.invoke("jeditor-about"),
  openDataFolder: () => ipcRenderer.invoke("jeditor-open-data-folder"),
  cutlineImportStatus: () => ipcRenderer.invoke("jeditor-cutline-import-status"),
  cutlineImport: () => ipcRenderer.invoke("jeditor-cutline-import"),
  relaunch: () => ipcRenderer.invoke("jeditor-relaunch"),
  onImportProgress: (handler) => {
    const listen = (_event, message) => handler(message);
    ipcRenderer.on("jeditor-import-progress", listen);
    return () => ipcRenderer.removeListener("jeditor-import-progress", listen);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      return "";
    }
  },
});
