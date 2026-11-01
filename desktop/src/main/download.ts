import { open } from "node:fs/promises";
import { type Chunk, type Pace, planChunks, rangeHeader, slowWorkers, splitPoint } from "./update-core";

/**
 * Download one file over several connections, each in its own in-memory session. Measured through a local proxy:
 * one connection got anywhere from 0 to 3 MB/s, the 142 MB update took 9 min 38 s at 246 KB/s, and four parallel
 * range requests got 3.3 to 4.8 MB/s. Requests that share a session also share Chromium's connection to the host,
 * so they do not run in parallel (4 requests in the default session moved 9 to 33 KB/s in total); hence one session
 * per worker. A worker whose connection is much slower than the others reopens it in a new session and goes on from
 * where it stopped.
 *
 * No Electron import: the caller passes `connect`, which returns a fetch with its own connection pool (in the app,
 * `session.fromPartition(...).fetch`), so the tests run it under bun against a local server.
 */

/** A fetch whose connections are not shared with any other `connect()` result. */
export type Fetch = (url: string, init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }) => Promise<Response>;

export type DownloadResult =
  | { readonly kind: "ok" }
  | { readonly kind: "stalled" }
  | { readonly kind: "no-range" }
  | { readonly kind: "failed"; readonly message: string };

type ChunkResult =
  | { readonly kind: "done" }
  | { readonly kind: "reopen"; readonly at: number; readonly end: number }
  | { readonly kind: "retry"; readonly at: number; readonly end: number; readonly message: string }
  | { readonly kind: "no-range" }
  | { readonly kind: "stopped" };

type Worker = {
  readonly id: number;
  fetch: Fetch;
  ctl: AbortController | null;
  reopen: boolean;
  chunk: Chunk | null;
  pos: number;
  /** When the first byte arrived on this connection, or null while it waits (redirect and TLS through a proxy: median 2.1 s, up to 4.9 s). */
  firstAt: number | null;
  /** Where this worker stops; lowered when an idle worker takes the second half of its range. */
  limit: number;
  openedAt: number;
  samples: { readonly t: number; readonly pos: number }[];
};

const WINDOW_MS = 5000;
/** Below 256 KiB left, a reopen (about 2 s to the first byte) costs more than it saves. */
const SLOW = { minAgeMs: 5000, ratio: 0.25, minRemaining: 256 * 1024 };
/** The smallest half an idle connection takes from another. */
const MIN_SPLIT = 512 * 1024;
/** How long a finished chunk's speed is the yardstick for the connections still open at the end. */
const FINISHED_MS = 10_000;
const MAX_REOPENS = 32;
const MAX_RETRIES = 3;

export const downloadFile = async (o: {
  readonly connect: () => Fetch;
  readonly url: string;
  readonly size: number;
  readonly file: string;
  readonly workers: number;
  readonly chunkSize: number;
  /** Accept a 200 answer with the whole file; only for a single worker with a single chunk. */
  readonly whole: boolean;
  readonly stallMs: number;
  readonly onBytes: (got: number) => void;
}): Promise<DownloadResult> => {
  const fh = await open(o.file, "w");
  const queue: Chunk[] = planChunks(o.size, o.chunkSize);
  let got = 0;
  let lastByteAt = Date.now();
  let end: DownloadResult | null = null; // set once: stalled, no-range or failed stops every worker
  let reopens = 0;
  let finished: { readonly t: number; readonly rate: number }[] = [];
  const retries = new Map<number, number>(); // chunk start → failed attempts
  const stop = (r: DownloadResult): void => {
    if (end !== null) return;
    end = r;
    workers.forEach((w) => w.ctl?.abort());
  };

  const fetchChunk = async (w: Worker, c: Chunk): Promise<ChunkResult> => {
    const ctl = new AbortController();
    w.ctl = ctl;
    w.reopen = false;
    w.chunk = c;
    w.pos = c.start;
    w.limit = c.end;
    w.openedAt = Date.now();
    w.firstAt = null;
    w.samples = [];
    const interrupted = (): ChunkResult => (end !== null ? { kind: "stopped" } : w.reopen ? { kind: "reopen", at: w.pos, end: w.limit } : { kind: "retry", at: w.pos, end: w.limit, message: "connection closed" });
    try {
      const res = await w.fetch(o.url, { headers: o.whole ? {} : { Range: rangeHeader(c) }, signal: ctl.signal });
      if (res.status === 200 && !o.whole) {
        await res.body?.cancel();
        return { kind: "no-range" };
      }
      if ((o.whole ? res.status !== 200 : res.status !== 206) || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "retry", at: c.start, end: w.limit, message: `HTTP ${res.status}` };
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (w.firstAt === null) {
          w.firstAt = Date.now();
          w.samples = [{ t: w.firstAt, pos: w.pos }];
        }
        const n = Math.min(value.length, w.limit - w.pos);
        if (n > 0) {
          await fh.write(value, 0, n, w.pos);
          // the limit can drop while the write is pending; bytes past it belong to (and are counted by) the other worker
          got += n - Math.max(0, w.pos + n - w.limit);
          w.pos += n;
          lastByteAt = Date.now();
          o.onBytes(got);
        }
        if (w.pos >= w.limit) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      if (w.pos < w.limit) return interrupted();
      const now = Date.now();
      if (w.firstAt !== null && now > w.firstAt) finished = [...finished.filter((f) => now - f.t <= FINISHED_MS), { t: now, rate: ((w.limit - c.start) * 1000) / (now - w.firstAt) }];
      return { kind: "done" };
    } catch (e) {
      return ctl.signal.aborted ? interrupted() : { kind: "retry", at: w.pos, end: w.limit, message: e instanceof Error ? e.message : String(e) };
    } finally {
      w.ctl = null;
      w.chunk = null;
    }
  };

  // the queue first; when it is empty, the second half of the open range with the most bytes left
  const steal = (): Chunk | undefined => {
    const s = splitPoint(workers.filter((w) => w.chunk !== null).map((w) => ({ id: w.id, pos: w.pos, limit: w.limit })), MIN_SPLIT);
    const w = s === null ? undefined : workers[s.id];
    if (s === null || w === undefined) return undefined;
    const to = w.limit;
    w.limit = s.mid;
    return { start: s.mid, end: to };
  };
  const next = (): Chunk | undefined => queue.shift() ?? steal();

  const work = async (w: Worker): Promise<void> => {
    for (let c = next(); c !== undefined && end === null; c = next()) {
      const r = await fetchChunk(w, c);
      switch (r.kind) {
        case "done":
        case "stopped":
          break;
        case "no-range":
          stop({ kind: "no-range" });
          break;
        case "reopen":
          w.fetch = o.connect();
          queue.unshift({ start: r.at, end: r.end });
          break;
        case "retry": {
          const n = (retries.get(c.start) ?? 0) + 1;
          retries.set(c.start, n);
          if (n > MAX_RETRIES) stop({ kind: "failed", message: `download failed: ${r.message}` });
          w.fetch = o.connect();
          queue.unshift({ start: r.at, end: r.end });
          break;
        }
      }
    }
  };

  const workers: Worker[] = Array.from({ length: Math.max(1, o.workers) }, (_, id) => ({
    id, fetch: o.connect(), ctl: null, reopen: false, chunk: null, pos: 0, firstAt: null, limit: 0, openedAt: 0, samples: [],
  }));

  // speed since the first byte, over the last WINDOW_MS; a connection still waiting for its first byte runs at 0
  const pace = (w: Worker, now: number): Pace | null => {
    if (w.chunk === null) return null;
    const base = { id: w.id, ageMs: now - w.openedAt, remaining: w.limit - w.pos };
    if (w.firstAt === null) return { ...base, rate: 0 };
    w.samples = [...w.samples.filter((s) => now - s.t <= WINDOW_MS), { t: now, pos: w.pos }];
    const first = w.samples[0] ?? { t: now, pos: w.pos };
    const span = Math.max(1, Math.min(WINDOW_MS, now - w.firstAt));
    return { ...base, rate: ((w.pos - first.pos) * 1000) / span };
  };
  const monitor = setInterval(() => {
    const now = Date.now();
    if (now - lastByteAt > o.stallMs) return stop({ kind: "stalled" });
    const paces = workers.flatMap((w) => { const p = pace(w, now); return p === null ? [] : [p]; });
    if (reopens >= MAX_REOPENS) return;
    // finished chunks are the yardstick only while some connections are idle (the end of the download)
    const idleBest = workers.some((w) => w.chunk === null) ? Math.max(0, ...finished.filter((f) => now - f.t <= FINISHED_MS).map((f) => f.rate)) : 0;
    for (const id of slowWorkers(paces, idleBest, SLOW)) {
      const w = workers[id];
      if (w === undefined || w.ctl === null) continue;
      reopens += 1;
      w.reopen = true;
      w.ctl.abort();
    }
  }, 1000);

  try {
    await Promise.all(workers.map(work));
  } finally {
    clearInterval(monitor);
    await fh.close();
  }
  return end ?? (got === o.size ? { kind: "ok" } : { kind: "failed", message: `downloaded ${got} of ${o.size} bytes` });
};
