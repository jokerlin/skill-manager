import type { ApplyEvent, ConfigPatch, ConfigSummary, HarnessReport, HostPlan, HostStatus, PluginsReport, RunResult, SkillRow, UpstreamUpdateResult, UpstreamsReport } from "@shared/types";

/** A failed CLI call, as a value. */
export type SkmError = { readonly kind: "not-found" } | { readonly kind: "failed"; readonly code: number | null; readonly message: string } | { readonly kind: "decode"; readonly message: string };

export type Res<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SkmError };

export const errorText = (e: SkmError): string => {
  switch (e.kind) {
    case "not-found":
      return "skm CLI not found";
    case "failed":
      return e.message.trim().replace(/^error:\s*/i, "") || `skm exited ${e.code ?? "?"}`;
    case "decode":
      return `unexpected skm output: ${e.message}`;
  }
};

const fromRun = (r: RunResult): Res<string> =>
  r.ok ? { ok: true, value: r.stdout } : { ok: false, error: r.notFound ? { kind: "not-found" } : { kind: "failed", code: r.code, message: r.stderr } };

const json = async <T>(args: readonly string[]): Promise<Res<T>> => {
  const r = fromRun(await window.skm.run(args));
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.value) as T };
  } catch (e) {
    return { ok: false, error: { kind: "decode", message: `${e instanceof Error ? e.message : String(e)}: ${r.value.slice(0, 160)}` } };
  }
};

const host = (h?: string): string[] => (h === undefined ? [] : ["--host", h]);

export const skm = {
  config: () => json<ConfigSummary>(["config", "--json"]),
  skills: () => json<SkillRow[]>(["ls", "--json"]),
  status: (o: { cached: boolean; host?: string }) => json<HostStatus[]>(["status", "--json", ...(o.cached ? ["--cached"] : []), ...host(o.host)]),
  plan: (o: { host?: string } = {}) => json<HostPlan[]>(["plan", "--json", "--cached", ...host(o.host)]),
  plugins: () => json<PluginsReport>(["plugins", "--json", "--cached"]),
  scope: async (name: string, cell: string, on: boolean, plugin = false): Promise<Res<string>> =>
    fromRun(await window.skm.run(["scope", ...(plugin ? ["--plugin"] : []), name, cell, on ? "on" : "off"])),
  patchConfig: async (p: ConfigPatch): Promise<Res<string>> => fromRun(await window.skm.run(["config", "patch"], JSON.stringify(p))),
  harness: (o: { cached: boolean; host?: string }) => json<HarnessReport>(["harness", "--json", ...(o.cached ? ["--cached"] : []), ...host(o.host)]),
  upstreams: (o: { cached: boolean }) => json<UpstreamsReport>(["upstream", "--json", ...(o.cached ? ["--cached"] : [])]),
  /** Writes from the local mirror (--cached), so what lands is the version the app showed. */
  upstreamUpdate: (skills: readonly string[], o: { force: boolean }) =>
    json<UpstreamUpdateResult>(["upstream", "update", ...skills, "-y", "--json", "--cached", ...(o.force ? ["--force"] : [])]),
};

/** Run a streamed `--events` command; resolves with the exit code once it ends. */
export const streamEvents = async (args: readonly string[], onEvent: (e: ApplyEvent) => void, onText: (line: string) => void): Promise<{ code: number | null; stderr: string }> => {
  // subscribe before starting so no line can arrive unheard; messages for other ids are ignored
  let id: string | undefined;
  const early: Parameters<Parameters<typeof window.skm.onStream>[0]>[0][] = [];
  return new Promise((resolve) => {
    const handle = (m: (typeof early)[number]) => {
      if (id === undefined) return void early.push(m);
      if (m.id !== id) return;
      if (m.kind === "end") {
        off();
        resolve({ code: m.code, stderr: m.stderr });
        return;
      }
      try {
        const e = JSON.parse(m.line) as ApplyEvent;
        if (typeof e === "object" && e !== null && "type" in e) onEvent(e);
        else onText(m.line);
      } catch {
        onText(m.line);
      }
    };
    const off = window.skm.onStream(handle);
    void window.skm.stream(args).then((started) => {
      id = started;
      early.splice(0).forEach(handle);
    });
  });
};
