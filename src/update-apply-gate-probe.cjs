#!/usr/bin/env node
// M2 3b: shouldEnableAutoUpdater()/shouldApplyUpdateNow() (update-apply-gate.cjs、Electron 非依存の
// 純関数) の単体検証 probe。plain node 上で完結する (source-picker-selection-probe.cjs と同じ方針)。
//
// なぜ Electron を起動しないのか: この 2 関数はブール値の組み合わせだけを扱う純粋な判定ロジックで、
// app/autoUpdater のいずれにも依存しない。実際の autoUpdater オブジェクトへのフック配線
// (verifyUpdateCodeSignature の差し込み・allowDowngrade) と「テストモードでは
// checkForUpdatesAndNotify() を一切呼ばない」ことの実測は、Electron ランタイムを要するため
// `--update-wiring-probe` (main.cjs, `npm run update-wiring-probe`) 側の責務。ここでは
// 「有効化条件」「適用 (quitAndInstall) 条件」の判定ロジック自体を全分岐網羅で検証する。
const fs = require("node:fs");
const path = require("node:path");
const { shouldEnableAutoUpdater, shouldApplyUpdateNow } = require("./update-apply-gate.cjs");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");

const cases = [];
function record(name, actual, expected) {
  const pass = actual === expected;
  cases.push({ name, pass, actual, expected });
  if (!pass) {
    console.error(`[update-apply-gate-probe] FAIL ${name}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
  return pass;
}

// ---- shouldEnableAutoUpdater: 全 8 分岐 (isPackaged x isCinnyShell x isTestMode) を網羅する ----
const enableMatrix = [
  { isPackaged: true, isCinnyShell: true, isTestMode: false, expected: true }, // 唯一 true になる組み合わせ (本番パッケージ + 本番トポロジ + テストモードでない)
  { isPackaged: false, isCinnyShell: true, isTestMode: false, expected: false }, // dev/unpacked (npm start 等) -- 通常起動でも isPackaged=false なので更新チェックはしない
  { isPackaged: true, isCinnyShell: false, isTestMode: false, expected: false }, // 本番パッケージだが harness トポロジ (--harness) -- 検証専用モードなので更新チェックしない
  { isPackaged: true, isCinnyShell: true, isTestMode: true, expected: false }, // 本番パッケージでも smoke/cinny-shell-smoke/tray-probe 等のテストモードでは絶対に外部通信しない
  { isPackaged: false, isCinnyShell: false, isTestMode: true, expected: false },
  { isPackaged: false, isCinnyShell: true, isTestMode: true, expected: false },
  { isPackaged: true, isCinnyShell: false, isTestMode: true, expected: false },
  { isPackaged: false, isCinnyShell: false, isTestMode: false, expected: false },
];
enableMatrix.forEach((testCase, index) => {
  const actual = shouldEnableAutoUpdater(testCase);
  record(`shouldEnableAutoUpdater_case_${index}_${JSON.stringify(testCase)}`, actual, testCase.expected);
});

// ---- shouldApplyUpdateNow: 全 8 分岐 (enabled x updateReady x callActive) を網羅する ----
const applyMatrix = [
  { enabled: true, updateReady: true, callActive: false, expected: true }, // 唯一 true: 有効化済み + ダウンロード済み + 通話していない
  { enabled: true, updateReady: true, callActive: true, expected: false }, // design/release-pipeline.md §7: 通話中は quitAndInstall を呼ばない (本タスクの核心条件)
  { enabled: true, updateReady: false, callActive: false, expected: false }, // まだダウンロード完了していない
  { enabled: false, updateReady: true, callActive: false, expected: false }, // 有効化されていない (dev/テストモード) では準備ができていても適用しない
  { enabled: false, updateReady: false, callActive: true, expected: false },
  { enabled: false, updateReady: true, callActive: true, expected: false },
  { enabled: true, updateReady: false, callActive: true, expected: false },
  { enabled: false, updateReady: false, callActive: false, expected: false },
];
applyMatrix.forEach((testCase, index) => {
  const actual = shouldApplyUpdateNow(testCase);
  record(`shouldApplyUpdateNow_case_${index}_${JSON.stringify(testCase)}`, actual, testCase.expected);
});

const pass = cases.every((entry) => entry.pass);

const evidence = {
  pass,
  task: "M2 3b update-apply-gate.cjs: shouldEnableAutoUpdater()/shouldApplyUpdateNow() full branch coverage",
  cases,
};

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(
  path.join(evidenceDir, "update-apply-gate-result.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);

if (!pass) {
  console.error(
    "[update-apply-gate-probe] FAIL cases:",
    JSON.stringify(
      cases.filter((entry) => !entry.pass),
      null,
      2,
    ),
  );
}

process.exit(pass ? 0 : 1);
