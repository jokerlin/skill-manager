import { contextBridge, ipcRenderer } from "electron";
import type { MenuCommand, Prefs, SkmApi, StreamMessage, UpdateState } from "../shared/types";

const api: SkmApi = {
  run: (args, stdin) => ipcRenderer.invoke("skm:run", [...args], stdin),
  stream: (args) => ipcRenderer.invoke("skm:stream", [...args]),
  onStream: (cb) => {
    const h = (_: unknown, m: StreamMessage) => cb(m);
    ipcRenderer.on("skm:stream", h);
    return () => { ipcRenderer.removeListener("skm:stream", h); };
  },
  getPrefs: () => ipcRenderer.invoke("prefs:get"),
  setPrefs: (p: Partial<Prefs>) => ipcRenderer.invoke("prefs:set", p),
  resolvedCommand: () => ipcRenderer.invoke("skm:resolved"),
  systemLocale: () => ipcRenderer.invoke("app:locale"),
  openPath: (p) => ipcRenderer.invoke("app:openPath", p),
  openDir: (p) => ipcRenderer.invoke("app:openDir", p),
  revealPath: (p) => ipcRenderer.invoke("app:revealPath", p),
  onMenu: (cb) => {
    const h = (_: unknown, c: MenuCommand) => cb(c);
    ipcRenderer.on("menu", h);
    return () => { ipcRenderer.removeListener("menu", h); };
  },
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke("app:info"),
  updateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdate: (cb) => {
    const h = (_: unknown, s: UpdateState) => cb(s);
    ipcRenderer.on("update", h);
    return () => { ipcRenderer.removeListener("update", h); };
  },
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
};

contextBridge.exposeInMainWorld("skm", api);
