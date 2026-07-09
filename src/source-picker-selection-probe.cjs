#!/usr/bin/env node
// M2 画面共有ソース選択 UI: resolveDisplayMediaSelection() (source-picker-selection.cjs、
// Electron 非依存の純関数) の単体検証 probe。
//
// なぜ Electron を起動しないのか: このロジックはピッカー UI の「選択結果 (sourceId/
// includeSystemAudio) から setDisplayMediaRequestHandler() の callback() 引数を組み立てる」
// 部分だけを担っており、desktopCapturer/BrowserWindow/IPC のいずれにも依存しない。ピッカー UI
// 自体の存在/列挙/実クリックは e2e/native-callflow.e2e.mjs の driveSourcePicker() が実機で検証する
// (「ピッカー UI の存在は E2E で、選択ロジックは probe で、の二段」構成) — ここは plain node で
// 完結する軽量な純関数検証に限定し、npm test (electron を起動する他の smoke/probe と並んで)
// へ組み込む。
const fs = require("node:fs");
const path = require("node:path");
const { resolveDisplayMediaSelection } = require("./source-picker-selection.cjs");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");

const SOURCES = [
  { id: "screen:0:0", name: "Entire screen" },
  { id: "window:1234:0", name: "SelfMatrix" },
  { id: "window:5678:0", name: "Some Other App" },
];

const cases = [];

function record(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
  return pass;
}

// 1. 通常選択 (system audio ON, win32): "loopback" が乗る。
record(
  "select_with_system_audio_win32",
  resolveDisplayMediaSelection(
    SOURCES,
    { canceled: false, sourceId: "window:1234:0", includeSystemAudio: true },
    { platform: "win32" },
  ),
  { canceled: false, video: SOURCES[1], audio: "loopback", reason: null },
);

// 2. system audio OFF: audio:false。
record(
  "select_without_system_audio",
  resolveDisplayMediaSelection(
    SOURCES,
    { canceled: false, sourceId: "window:1234:0", includeSystemAudio: false },
    { platform: "win32" },
  ),
  { canceled: false, video: SOURCES[1], audio: false, reason: null },
);

// 3. system audio ON だが非 win32: audio:false (loopback は win32 限定、main.cjs の従来ロジックと同じ)。
record(
  "select_with_system_audio_non_win32",
  resolveDisplayMediaSelection(
    SOURCES,
    { canceled: false, sourceId: "window:1234:0", includeSystemAudio: true },
    { platform: "darwin" },
  ),
  { canceled: false, video: SOURCES[1], audio: false, reason: null },
);

// 4. screen ソースの選択も同様に解決する。
record(
  "select_screen_source",
  resolveDisplayMediaSelection(
    SOURCES,
    { canceled: false, sourceId: "screen:0:0", includeSystemAudio: false },
    { platform: "win32" },
  ),
  { canceled: false, video: SOURCES[0], audio: false, reason: null },
);

// 5. キャンセル: video:null, audio:false, canceled:true (getDisplayMedia が reject される想定)。
record(
  "cancel",
  resolveDisplayMediaSelection(SOURCES, { canceled: true, reason: "user_canceled" }, { platform: "win32" }),
  { canceled: true, video: null, audio: false, reason: "user_canceled" },
);

// 6. pickerResponse が null/undefined (ウィンドウが閉じられた等の異常系): キャンセル扱いに倒れる。
record(
  "null_response",
  resolveDisplayMediaSelection(SOURCES, null, { platform: "win32" }),
  { canceled: true, video: null, audio: false, reason: "canceled" },
);

// 7. 未知の sourceId (picker HTML 側のバグ等で存在しない id が来た場合): 安全側にキャンセル扱い。
record(
  "unknown_source_id",
  resolveDisplayMediaSelection(
    SOURCES,
    { canceled: false, sourceId: "window:9999:0", includeSystemAudio: true },
    { platform: "win32" },
  ),
  { canceled: true, video: null, audio: false, reason: "source_not_found" },
);

// 8. sources が空配列: 何を選んでも source_not_found。
record(
  "empty_sources",
  resolveDisplayMediaSelection(
    [],
    { canceled: false, sourceId: "window:1234:0", includeSystemAudio: true },
    { platform: "win32" },
  ),
  { canceled: true, video: null, audio: false, reason: "source_not_found" },
);

const pass = cases.every((entry) => entry.pass);

const evidence = {
  pass,
  task: "M2 source picker: resolveDisplayMediaSelection() pure-logic verification",
  note:
    "Electron non-dependent unit check of the selection-resolution logic. Picker UI existence/" +
    "enumeration/real clicks are verified separately by e2e/native-callflow.e2e.mjs's driveSourcePicker().",
  cases,
};

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(
  path.join(evidenceDir, "source-picker-selection-result.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);

if (!pass) {
  console.error(
    "[source-picker-selection-probe] FAIL:",
    JSON.stringify(
      cases.filter((entry) => !entry.pass),
      null,
      2,
    ),
  );
}

process.exit(pass ? 0 : 1);
