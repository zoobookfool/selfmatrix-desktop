// SelfMatrix M1 step 3c-4 task B: アプリ単位音声キャプチャのスパイク — 実測プローブ。
//
// 目的: この開発機に実際に入っている Electron 43.0.0 / Chromium 150 のビルドに対して、
// 「ドキュメントに書かれていない/見落としている per-window・per-process 音声 API が無いか」を
// 文書調査だけでなく実際のオブジェクトへのリフレクションで確認する。加えて
// `desktopCapturer.getSources()` が返す実際の source オブジェクトの形状 (audio 関連フィールドが
// 本当に存在しないか) を実測する。結論は spikes/app-audio-capture-spike.md に記録した
// (実測 vs 文書からの推定の区別もそちらに明記)。
//
// npm test には含めない (音声デバイス依存が薄いプローブだが、system-audio-probe と同じ運用に揃える)。
let electron = {};
try {
  electron = require("electron");
} catch (error) {
  if (require.main === module) throw error;
}
const { app, desktopCapturer, session } = electron;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");

// audio/loopback/process 関連らしき名前を持つメソッド/プロパティを、プロトタイプチェーンを
// たどって収集する。ドキュメントに載っていない非公開/実験的 API が生えていないかの実測用。
function collectMatchingMemberNames(obj, pattern) {
  const names = new Set();
  let current = obj;
  while (current) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (pattern.test(name)) names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return Array.from(names).sort();
}

function sanitizeString(value) {
  if (typeof value !== "string") return value;
  const home = os.homedir();
  return home ? value.split(home).join("<home>") : value;
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

  const audioLikePattern = /audio|loopback|process/i;

  // session インスタンス (defaultSession) 自体と、そのプロトタイプチェーン上のメソッド名を走査。
  const sessionMemberNames = collectMatchingMemberNames(session.defaultSession, audioLikePattern);

  // desktopCapturer モジュールオブジェクト自体の直接プロパティ (関数はこれのみ、プロトタイプ継承は無い想定)。
  const desktopCapturerMemberNames = collectMatchingMemberNames(desktopCapturer, audioLikePattern).filter(
    (name) => name !== "constructor",
  );

  // 実際に desktopCapturer.getSources() を screen/window 両方で呼び、返ってきた source
  // オブジェクトのフィールド形状を実測する (audio 関連フィールドが存在するかどうか)。
  let screenSourceKeys = null;
  let windowSourceKeys = null;
  let sourcesError = null;
  try {
    const [screenSources, windowSources] = await Promise.all([
      desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }),
      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 } }),
    ]);
    screenSourceKeys = screenSources[0] ? Object.keys(screenSources[0]).sort() : [];
    windowSourceKeys = windowSources[0] ? Object.keys(windowSources[0]).sort() : [];
  } catch (error) {
    sourcesError = String(error && error.message ? error.message : error);
  }

  const evidence = deepSanitize({
    task: "M1 step 3c-4 task B: per-app/per-window audio capture API surface reflection",
    method: "measured (reflection over the actually-installed Electron build + a real desktopCapturer.getSources() call), not doc-derived",
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    sessionMemberNamesMatchingAudioLikePattern: sessionMemberNames,
    desktopCapturerMemberNamesMatchingAudioLikePattern: desktopCapturerMemberNames,
    desktopCapturerSourceShape: {
      screenSourceKeys,
      windowSourceKeys,
      sourcesError,
      note:
        "If per-window/per-app audio scoping existed as a documented-or-not field on a DesktopCapturerSource, " +
        "it would show up as an extra key here (beyond id/name/display_id/thumbnail/appIcon). None was found.",
    },
    conclusion:
      "No member name matching /audio|loopback|process/i beyond the documented " +
      "setDisplayMediaRequestHandler audio field (\"loopback\"/\"loopbackWithMute\"/WebFrameMain) was found " +
      "on session.defaultSession or the desktopCapturer module in this Electron 43.0.0 build. " +
      "DesktopCapturerSource objects carry no audio-related field. This is consistent with (but does not by " +
      "itself prove for all Electron internals) the documentation-based finding that Electron has no " +
      "per-application/per-window audio capture API as of v43.",
  });

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "app-audio-capture-api-surface-result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );

  app.exit(0);
}

if (app) {
  main().catch((error) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "app-audio-capture-api-surface-result.json"),
      `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
      "utf8",
    );
    console.error(error);
    app.exit(1);
  });
} else if (require.main === module) {
  throw new Error("app-audio-capture-probe requires Electron. Use `electron src/app-audio-capture-probe.cjs`.");
}
