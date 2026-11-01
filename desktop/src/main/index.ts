import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, ipcMain, nativeTheme, shell } from "electron";
import pkg from "../../package.json";
import type { AppInfo, MenuCommand, Prefs, StreamMessage, UpdateState } from "../shared/types";
import { readPrefs, sanitize, writePrefs } from "./prefs";
import { resolveCommand, runSkm, streamSkm } from "./skm";
import { repoSlug } from "./update-core";
import { createUpdater } from "./updater";

const APP_NAME = "Skill Manager";

const prefsFile = (): string => join(app.getPath("userData"), "prefs.json");
let prefs: Prefs | undefined;
const legacyPrefsFile = (): string => join(app.getPath("appData"), "skm", "prefs.json");
const getPrefs = async (): Promise<Prefs> => (prefs ??= await readPrefs(prefsFile(), legacyPrefsFile()));
const command = async () => resolveCommand((await getPrefs()).skmCommand);

const applyTheme = (p: Prefs): void => { nativeTheme.themeSource = p.theme; };

let win: BrowserWindow | undefined;

const send = (channel: string, payload: unknown): void => { win?.webContents.send(channel, payload); };
const menu = (c: MenuCommand) => () => send("menu", c);

// SKM_UPDATE_API points the updater at another GitHub-compatible API (a fork's mirror, GitHub Enterprise, a local test server)
const updater = createUpdater({ repo: repoSlug(pkg.repository.url), api: process.env["SKM_UPDATE_API"] ?? "https://api.github.com", publicKey: (pkg as { updatePublicKey?: string }).updatePublicKey ?? null, onChange: (s: UpdateState) => send("update", s) });
/** "Check automatically" means once per launch; About → Check for updates covers the rest. */
const checkOnLaunch = (p: Prefs): void => {
  if (p.autoUpdate && app.isPackaged) void updater.check();
};

const appInfo = (): AppInfo => ({
  name: APP_NAME,
  version: app.getVersion(),
  author: pkg.author.name,
  homepage: pkg.homepage,
  electron: process.versions.electron ?? "",
  platform: process.platform,
  arch: process.arch,
});

const buildMenu = (): void => {
  const loc = prefs?.locale ?? "system";
  const zh = loc === "zh" || (loc === "system" && app.getLocale().startsWith("zh"));
  const L = (en: string, cn: string): string => (zh ? cn : en);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: L(`About ${APP_NAME}`, `关于 ${APP_NAME}`), click: menu("about") },
        { label: L("Check for Updates…", "检查更新…"), click: () => { send("menu", "about"); void updater.check(); } },
        { type: "separator" },
        { label: L("Settings…", "设置…"), accelerator: "CmdOrCtrl+,", click: menu("settings") },
        { type: "separator" },
        { role: "hide", label: L(`Hide ${APP_NAME}`, `隐藏 ${APP_NAME}`) },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: L(`Quit ${APP_NAME}`, `退出 ${APP_NAME}`) },
      ],
    },
    { role: "editMenu" },
    {
      label: L("View", "视图"),
      submenu: [
        { label: L("Skills", "技能"), accelerator: "CmdOrCtrl+1", click: menu("view-skills") },
        { label: L("Plugins", "插件"), accelerator: "CmdOrCtrl+2", click: menu("view-plugins") },
        { label: L("Hosts", "主机"), accelerator: "CmdOrCtrl+3", click: menu("view-hosts") },
        { type: "separator" },
        { label: L("Command Palette…", "命令面板…"), accelerator: "CmdOrCtrl+K", click: menu("palette") },
        { label: L("Refresh Hosts", "刷新主机"), accelerator: "CmdOrCtrl+R", click: menu("refresh") },
        { label: L("Review Changes…", "审阅变更…"), accelerator: "CmdOrCtrl+Shift+Enter", click: menu("review") },
        { label: L("Apply Changes", "应用变更"), accelerator: "CmdOrCtrl+Enter", click: menu("apply") },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = async (): Promise<void> => {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
    webPreferences: { preload: join(__dirname, "../preload/index.cjs"), sandbox: true, contextIsolation: true },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
};

ipcMain.handle("skm:run", async (_e, args: string[], stdin?: string) => runSkm(await command(), args, stdin));
ipcMain.handle("skm:stream", async (e, args: string[]) => {
  const id = randomUUID();
  const cmd = await command();
  const post = (m: StreamMessage) => { if (!e.sender.isDestroyed()) e.sender.send("skm:stream", m); };
  // start after the id is returned so the renderer has subscribed
  setImmediate(() => streamSkm(cmd, args, (line) => post({ id, kind: "line", line }), (code, stderr) => post({ id, kind: "end", code, stderr })));
  return id;
});
ipcMain.handle("prefs:get", () => getPrefs());
ipcMain.handle("app:info", () => appInfo());
ipcMain.handle("update:state", () => updater.state());
ipcMain.handle("update:check", () => updater.check());
ipcMain.handle("update:download", () => updater.download());
ipcMain.handle("update:install", () => updater.install());
ipcMain.handle("app:openExternal", async (_e, url: string) => { if (/^https:\/\//.test(url)) await shell.openExternal(url); });
ipcMain.handle("prefs:set", async (_e, patch: Partial<Prefs>) => {
  prefs = sanitize({ ...(await getPrefs()), ...patch });
  await writePrefs(prefsFile(), prefs);
  applyTheme(prefs);
  buildMenu();
  return prefs;
});
ipcMain.handle("skm:resolved", async () => (await command())?.join(" ") ?? null);
ipcMain.handle("app:locale", () => app.getLocale());
ipcMain.handle("app:openPath", async (_e, p: string) => { await shell.openPath(p); });
ipcMain.handle("app:openDir", async (_e, p: string) => { await mkdir(p, { recursive: true }); await shell.openPath(p); });
ipcMain.handle("app:revealPath", (_e, p: string) => { shell.showItemInFolder(p); });

app.setName(APP_NAME);
app.whenReady().then(async () => {
  const p = await getPrefs();
  applyTheme(p);
  buildMenu();
  await createWindow();
  checkOnLaunch(p);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
