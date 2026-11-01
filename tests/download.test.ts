import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetch, downloadFile } from "../desktop/src/main/download";

// A local server with the failure modes seen through a proxy: a connection that trickles, a server that ignores Range,
// and one that goes silent. 20 MB in 8 MiB chunks = 3 chunks; the first request for the middle chunk trickles.
const MiB = 1024 * 1024;
const blob = randomBytes(20_000_000);
const sha = (b: Buffer): string => createHash("sha512").update(b).digest("base64");
let server: ReturnType<typeof Bun.serve>;
let slowServed = 0;
let throttled: string[] = [];
const seen = new Set<number>();

const trickle = (body: Uint8Array): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      await Bun.sleep(100);
      if (i >= body.length) return c.close();
      c.enqueue(body.subarray(i, i + 2000)); // 20 KB/s
      i += 2000;
    },
  });
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/norange") return new Response(blob);
      if (path === "/throttle") {
        // every connection at 4 MB/s, so a single connection holds the one chunk for a while
        const r = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
        if (r === null) return new Response(blob);
        throttled.push(`${r[1]}-${r[2]}`);
        const body = blob.subarray(Number(r[1]), Number(r[2]) + 1);
        let i = 0;
        const stream = new ReadableStream<Uint8Array>({ async pull(c) { await Bun.sleep(10); if (i >= body.length) return c.close(); c.enqueue(body.subarray(i, i + 40_000)); i += 40_000; } });
        return new Response(stream, { status: 206, headers: { "Content-Range": `bytes ${r[1]}-${r[2]}/${blob.length}` } });
      }
      if (path === "/stall") return new Response(new ReadableStream({ start(c) { c.enqueue(blob.subarray(0, 1_000_000)); } }), { status: 206 });
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
      if (m === null) return new Response(blob);
      const a = Number(m[1]);
      const b = Number(m[2]);
      const body = blob.subarray(a, b + 1);
      const headers = { "Content-Range": `bytes ${a}-${b}/${blob.length}` };
      const chunk = Math.floor(a / (8 * MiB));
      const slow = chunk === 1 && !seen.has(chunk);
      seen.add(chunk);
      if (!slow) return new Response(body, { status: 206, headers });
      slowServed += 1;
      return new Response(trickle(body), { status: 206, headers });
    },
  });
});
afterAll(() => server.stop(true));

const connect = (): Fetch => (url, init) => fetch(url, init);
const run = (path: string, extra: Partial<Parameters<typeof downloadFile>[0]> = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "skm-dl-")), "out.zip");
  const opts = { connect, url: `http://127.0.0.1:${server.port}${path}`, size: blob.length, file, workers: 4, chunkSize: 8 * MiB, whole: false, stallMs: 60_000, onBytes: () => {}, ...extra };
  return { file, opts, done: downloadFile(opts) };
};

describe("parallel update download", () => {
  test("a connection that trickles is reopened, also when it holds the last chunk; the file is whole", async () => {
    // before the fix the fast chunks finished in under 5 s, never counted as "the recent best", and the trickling
    // chunk was only compared with itself: 8 MiB at 20 KB/s, about 7 minutes
    const { file, done } = run("/range");
    const t0 = Date.now();
    expect(await done).toEqual({ kind: "ok" });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(slowServed).toBe(1);
    expect(sha(readFileSync(file))).toBe(sha(blob));
  }, 30_000);

  test("idle connections split the open range with the most bytes left; the file is whole", async () => {
    throttled = [];
    const { file, done } = run("/throttle", { chunkSize: blob.length }); // one chunk, four workers
    expect(await done).toEqual({ kind: "ok" });
    expect(throttled[0]).toBe(`0-${blob.length - 1}`);
    expect(throttled.length).toBeGreaterThanOrEqual(4); // the other three took halves instead of waiting
    expect(sha(readFileSync(file))).toBe(sha(blob));
  }, 30_000);

  test("a server that ignores Range answers no-range; one plain request then gets the whole file", async () => {
    const first = run("/norange");
    expect(await first.done).toEqual({ kind: "no-range" });
    const whole = await downloadFile({ ...first.opts, workers: 1, chunkSize: blob.length, whole: true });
    expect(whole).toEqual({ kind: "ok" });
    expect(sha(readFileSync(first.file))).toBe(sha(blob));
  }, 30_000);

  test("a server that goes silent ends as stalled after stallMs", async () => {
    const { done } = run("/stall", { stallMs: 2000 });
    expect(await done).toEqual({ kind: "stalled" });
  }, 30_000);
});
