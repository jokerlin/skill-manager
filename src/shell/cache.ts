import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { EvalItem } from "../core/evalPrompt";

export type EvalCacheEntry = { readonly hash: string; readonly evaluator: string; readonly at: string; readonly item: EvalItem };
type CacheFile = Record<string, EvalCacheEntry>; // key: skill name

const path = (skm: string) => `${skm}/cache/eval.json`;

export const readEvalCache = async (skm: string): Promise<CacheFile> => {
  const text = await readFile(path(skm), "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try { return JSON.parse(text) as CacheFile; } catch { return {}; }
};

export const writeEvalCache = async (skm: string, cache: CacheFile): Promise<void> => {
  await mkdir(`${skm}/cache`, { recursive: true });
  await writeFile(path(skm), JSON.stringify(cache, null, 2));
};
