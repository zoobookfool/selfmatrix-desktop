// SelfMatrix M1 step 3c-4: system audio (loopback) 付き画面共有の実機確認プローブ。
//
// 目的 (native-milestones.md M1 step 3c-4 / M2 前提決定 3): main.cjs の
// registerDisplayMediaHandler() が Windows で `audio: "loopback"` を setDisplayMediaRequestHandler
// のコールバックに指定すると、renderer 側の
// `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` が実際に audio track を
// 含む MediaStream を返すことを実機 (このワークスペースの Windows 開発機) で確認する。
//
// なぜ main.cjs を直接使わず別ファイルにしたか: main.cjs の main() は cinny/EC の dist
// (SELFMATRIX_CINNY_DIST / SELFMATRIX_EC_DIST、既定は Documents/DiscordSub 配下) が存在することを
// 前提にした重い起動シーケンス (静的サーバ、mainWindow への cinny ロード、widget bridge 一式) を
// 持つ。今回検証したいのは `setDisplayMediaRequestHandler` → `getDisplayMedia()` という
// Electron/Chromium 単体の経路であり、cinny/EC 本体を経由する必要が無い。運用ルール
// (native-milestones.md「実行可能コードの workspace 運用ルール」1: 置けるのは検証入口だけ) に
// 沿い、独立した薄いスタンドアロン Electron スクリプトとして実装した。
//
// audio 判定式は main.cjs の registerDisplayMediaHandler() と完全に一致させてある:
//   `request.audioRequested && process.platform === "win32" ? "loopback" : false`
// (main.cjs 側を変更していないので、二重実装によるズレが実害を持つとすれば「この判定式が
// 将来 main.cjs 側だけ変わって食い違う」ことだが、この行は 1 行で変更が滅多に無く、
// 万一ズレても本プローブが不合格になるだけで安全側に倒れる)。
//
// 絶対条件の遵守:
// - マイクは使わない (getUserMedia は一切呼ばない)。loopback はシステム全体の「出力」ミックスを
//   読み取るキャプチャであり、実オーディオデバイスの入出力設定 (既定デバイス選択、音量等) を
//   一切変更しない。
// - 無音で良い (実スピーカー出力は不要)。pass 条件は「audio track が存在し live で、
//   AnalyserNode で数秒間サンプリングしてもクラッシュしないこと」であり、可聴音の有無は問わない。
//
// npm test には含めない (音声デバイス依存のため、package.json の "probe:system-audio" は
// 独立スクリプト)。
let electron = {};
try {
  electron = require("electron");
} catch (error) {
  if (require.main === module) throw error;
}
const { app, BrowserWindow, desktopCapturer, session } = electron;
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");
const probeHtmlPath = path.join(__dirname, "system-audio-probe.html");

// setDisplayMediaRequestHandler が実際に呼ばれた際の内部診断 (main.cjs の
// widgetMessages 相当。ここでは通話 1 本の使い切りプローブなので単純な object で十分)。
const displayMediaDiag = {
  called: false,
  audioRequestedSeen: null,
  sourceSelected: null,
  audioModeUsed: null,
  handlerError: null,
};

// main.cjs の registerDisplayMediaHandler() と同じロジック (ファイル冒頭コメント参照)。
function registerDisplayMediaHandler(targetSession) {
  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    displayMediaDiag.called = true;
    desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => {
        const source = sources[0];
        const audioMode = request.audioRequested && process.platform === "win32" ? "loopback" : false;
        displayMediaDiag.audioRequestedSeen = request.audioRequested;
        displayMediaDiag.sourceSelected = Boolean(source);
        displayMediaDiag.audioModeUsed = audioMode;
        callback({ video: source, audio: audioMode });
      })
      .catch((error) => {
        displayMediaDiag.handlerError = String(error && error.message ? error.message : error);
        callback({});
      });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(probeHtmlPath).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

// 実測 (2026-07-08、このプローブの初回実行): `webContents.sendInputEvent()` によるマウス
// クリック注入は、この開発機のように自動化スクリプトが裏で起動したウィンドウが実際の OS
// フォーカスを得られない環境では配達されず (`displayMediaDiag.called` が false のまま
// タイムアウトすることを実測で確認)、Windows のフォーカス奪取防止の影響とみられる。
// 一方、このリポジトリの既存 E2E (native-callflow.e2e.mjs 経由の call-control-preload.cjs
// `clickAndReport()` の `target.click()`) は素の DOM 合成クリック (isTrusted:false) だけで
// EC の実スクリーンシェア (getDisplayMedia 呼び出し) を確実に成功させている実績がある
// (evidence/native-callflow-result.json の videoBytesSent 増加で確認済み) — この Electron 環境の
// `setDisplayMediaRequestHandler` 経路は transient user activation の有無を問わないとみられる
// (代替 UI ピッカーが存在しないためと考えられる)。よってここでも同じ素の `.click()` を使う。
async function clickStartButton(win) {
  await win.webContents.executeJavaScript(`document.getElementById("start").click()`, true);
}

async function waitForProbeResult(win, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await win.webContents.executeJavaScript("window.__probeResult", true);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

// evidence はコミット対象 (native-milestones.md の運用ルール 3) なので、秘匿情報 (このマシンの
// ユーザー名を含む絶対パス、ローカル IPv4 等) が万一 audioTrackLabel 等の文字列フィールドに
// 混入していても機械的に伏せる。origin (127.0.0.1:<port>) は毎回変わるだけで秘匿情報ではないが、
// 同じ方針で伏せておく。
function sanitizeString(value) {
  if (typeof value !== "string") return value;
  let out = value.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ipv4>");
  const home = os.homedir();
  if (home) out = out.split(home).join("<home>");
  return out;
}

function deepSanitize(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => deepSanitize(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = deepSanitize(nested);
    return out;
  }
  return value;
}

async function main() {
  await app.whenReady();
  registerDisplayMediaHandler(session.defaultSession);

  const { server, origin } = await startServer();
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await win.loadURL(`${origin}/`);
  win.focus();

  let probeResult = null;
  let probeError = null;
  try {
    await clickStartButton(win);
    probeResult = await waitForProbeResult(win, 12000);
    if (!probeResult) probeError = "timed out waiting for window.__probeResult";
  } catch (error) {
    probeError = String(error && error.message ? error.message : error);
  }

  const audioTrackCount = probeResult && probeResult.ok ? probeResult.audioTrackCount : 0;
  const pass = Boolean(
    probeResult &&
      probeResult.ok &&
      audioTrackCount >= 1 &&
      probeResult.audioTrackReadyStateInitial === "live" &&
      probeResult.analyserSampledWithoutCrash === true,
  );

  const evidence = deepSanitize({
    pass,
    task: "M1 step 3c-4 task A: system audio (loopback) real-machine check",
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    displayMediaHandlerDiag: displayMediaDiag,
    probeResult,
    probeError,
    note:
      "loopback captures the system-wide output mix. No real speaker output is required or asserted " +
      "(pass depends on audio track presence/liveness/AnalyserNode sampling, not audible sound). " +
      "No microphone (getUserMedia) was used; no real audio device input/output setting was changed.",
  });

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "system-audio-result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );

  win.destroy();
  server.close();
  app.exit(pass ? 0 : 1);
}

if (app) {
  main().catch((error) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "system-audio-result.json"),
      `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
      "utf8",
    );
    console.error(error);
    app.exit(1);
  });
} else if (require.main === module) {
  throw new Error("system-audio-probe requires Electron. Use `electron src/system-audio-probe.cjs`.");
}
