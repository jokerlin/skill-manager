// Dev helper: run the v2 probe against configured hosts and print size/timing. `bun run scripts/probe-v2.ts local mini`
import { loadApp } from "../src/shell/app";
import { agentsOn, runnerFor } from "../src/shell/hosts";
import { probeHost } from "../src/shell/probe";
const app = await loadApp(); if (!app.ok) throw new Error("no app");
for (const id of process.argv.slice(2)) {
  const h = app.value.config.hosts.find((x) => x.id === id);
  if (!h) { console.log(id, "unknown host"); continue; }
  const t0 = Date.now();
  const r = await probeHost(h, agentsOn(app.value.config, h), runnerFor(h));
  if (!r.ok) { console.log(id, "ERR", r.error); continue; }
  const v = r.value;
  console.log(id, `${Date.now() - t0}ms`, JSON.stringify({ tools: v.tools, files: Object.keys(v.files), pcache: v.pluginCache.length, pskills: v.pluginSkills.length, builtins: v.builtins.map((b) => b.name), docs: Object.keys(v.docs).length, docBytes: Object.values(v.docs).reduce((n, d) => n + d.length, 0), entries: Object.fromEntries(Object.entries(v.agentDirs).map(([a, d]) => [a, d.entries.length])), also: Object.fromEntries(Object.entries(v.alsoReads).map(([a, e]) => [a, e.map((x) => x.name)])) }));
}
