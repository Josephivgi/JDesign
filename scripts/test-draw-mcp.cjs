// Draw MCP server regression: mutating-tool coverage, sequential batch order
// (new_drawing before draw), pick-tool artifact hook, session cleanup.
const { createMcpServer, mutatingToolNames } = require("../draw/lib/mcp-server.cjs");

const calls = [];
const artifacts = [];
const store = {
  list: () => docs,
  getDoc: (id) => docs.find((d) => d.id === id),
  projectOf: () => "p1",
  apply: async (docId, ops) => { calls.push("apply:" + docId); return { ids: ["i1"] }; },
};
let docs = [];
let seq = 0;
const host = {
  store,
  listDrawings: () => docs,
  projectOf: () => "p1",
  newDrawing: (o) => { const d = { id: "d" + ++seq, name: o.name || "Drawing", updated: Date.now(), layers: [] }; docs.push(d); calls.push("new:" + d.id); return d; },
  beforeTool: (ctx, docId, name) => calls.push("before:" + name + ":" + docId),
  onTool: (id, name, args, err, ctx) => { calls.push("on:" + name + ":" + id); if (!err && mutatingToolNames().has(name)) artifacts.push(name + ":" + id); },
};

(async () => {
  const mcp = createMcpServer(host);
  await mcp.listen();
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + mcp.token, "x-jdraw-project": "p1", "x-jdraw-chat-id": "c1" };
  const post = (body) => fetch(mcp.url, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json());

  // 1. Batch ordering: new_drawing then draw must run in order.
  const replies = await post([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "new_drawing", arguments: { name: "A" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_palette", arguments: { colors: ["#e5484d"] } } },
  ]);
  const order = calls.slice(0, 4).join(",");
  console.log("call order:", order, "| call2 reply:", JSON.stringify(replies[1] && replies[1].result));
  const inOrder = order === "new:d1,on:new_drawing:d1,before:set_palette:d1,apply:d1";

  // 2. Mutation coverage: the derived set must cover every real mutator and
  //    hold no ghosts.
  const mut = mutatingToolNames();
  const names = new Set(mcp.tools().map((t) => t.name));
  const realMutators = ["draw", "draw_svg", "edit_items", "arrange", "fill_area", "delete_items", "recolor", "set_palette", "canvas", "layers", "finish_drawing", "new_drawing"];
  const missing = realMutators.filter((n) => !mut.has(n));
  const ghosts = [...mut].filter((n) => !names.has(n) && n !== "new_drawing" && n !== "list_drawings" && n !== "open_drawing");
  console.log("mutating:", [...mut].sort().join(" "));
  console.log("missing mutators:", missing.length ? missing.join(",") : "none", "| ghosts:", ghosts.length ? ghosts.join(",") : "none");

  // 3. Artifact hook fired for new_drawing and draw.
  console.log("artifacts:", artifacts.join(","));
  const artifactsOk = artifacts.includes("new_drawing:d1") && artifacts.includes("set_palette:d1");

  // 4. tools/list carries no internal flags.
  const list = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const leaked = list.result.tools.filter((t) => "mutates" in t);
  console.log("flag leak:", leaked.length ? leaked.map((t) => t.name).join(",") : "none");

  const ok = inOrder && !missing.length && !ghosts.length && artifactsOk && !leaked.length;
  console.log(ok ? "PASS" : "FAIL");
  setTimeout(() => process.exit(ok ? 0 : 1), 100).unref();
})().catch((e) => { console.log("FAIL", e); process.exit(1); });
