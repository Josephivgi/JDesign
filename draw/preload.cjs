const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || "Something went wrong.");
  return res.value;
}

const EVENTS = ["doc:changed", "agent:event", "agent:tool-done", "render:request", "brush:set", "theme:set"];

contextBridge.exposeInMainWorld("jdraw", {
  call,
  on(event, fn) {
    if (!EVENTS.includes(event)) throw new Error("Unknown event " + event);
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
  renderReply(msg) {
    ipcRenderer.send("render:reply", msg);
  },
});
