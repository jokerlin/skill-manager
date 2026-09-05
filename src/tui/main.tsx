import React from "react";
import { render } from "ink";
import { appErrorText, loadApp } from "../shell/app";
import { readEvalCache } from "../shell/cache";
import { App } from "./App";
import { realIo } from "./io";

export const runTui = async (): Promise<void> => {
  const app = await loadApp();
  if (!app.ok) {
    process.stderr.write(`error: ${appErrorText(app.error)}\n`);
    process.exit(1);
  }
  const evals = await readEvalCache(app.value.skmHome);
  const { waitUntilExit } = render(<App app={app.value} io={realIo(app.value)} evals={evals} />, { exitOnCtrlC: true });
  await waitUntilExit();
};
