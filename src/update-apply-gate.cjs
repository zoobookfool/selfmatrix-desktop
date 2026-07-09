// M2 3b (electron-builder 同梱リソース化 + electron-updater 配線): Electron 非依存の純関数群。
// main.cjs (Electron 依存) と update-apply-gate-probe.cjs (plain Node の単体検証 probe) の
// 両方から require される -- source-picker-selection.cjs / widget-bridge-protocol.cjs と同じ
// 「判定ロジックを二重実装しない」方針。
//
// design/release-pipeline.md §4/§7 の 2 つの判断をここに集約する:
//   1. shouldEnableAutoUpdater: 自動更新のチェック/適用サブシステムをそもそも有効にしてよいか。
//      本番パッケージ (app.isPackaged) かつ本番トポロジ (isCinnyShell) かつテスト/probe モード
//      ではないときだけ true。dev (unpacked)・harness・smoke/memory/cinny-shell-smoke・
//      E2E (--e2e-real-join)・tray-probe・update-wiring-probe 等はどれも isTestMode:true を渡す
//      ため、外部ネットワーク (GitHub Releases への問い合わせ) には一切出ない。
//   2. shouldApplyUpdateNow: ダウンロード済み更新を今すぐ適用 (quitAndInstall) してよいか。
//      有効化されていて、更新が既にダウンロード済みで、かつ通話中 (callActive) でないときだけ true
//      -- 「通話中は quitAndInstall を呼ばない」(design/release-pipeline.md §7) の実体。

"use strict";

// isPackaged: app.isPackaged (製品パッケージとして起動しているか)。
// isCinnyShell: 本番トポロジ (cinny がトップフレーム) で起動しているか -- main.cjs の isCinnyShell。
// isTestMode: smoke/memory-probe/cinny-shell-smoke/e2e-real-join/harness/tray-probe/
//   update-wiring-probe 等、テスト・検証専用の起動モードかどうか。
function shouldEnableAutoUpdater({ isPackaged, isCinnyShell, isTestMode }) {
  return Boolean(isPackaged) && Boolean(isCinnyShell) && !isTestMode;
}

// enabled: shouldEnableAutoUpdater() の結果。
// updateReady: electron-updater の 'update-downloaded' が既に発火済みか (ダウンロード + minisign
//   検証まで完了している = 適用の準備ができている)。
// callActive: 通話が進行中か (main.cjs の isCallActive(), state.callViewState !== "none")。
function shouldApplyUpdateNow({ enabled, updateReady, callActive }) {
  return Boolean(enabled) && Boolean(updateReady) && !callActive;
}

module.exports = { shouldEnableAutoUpdater, shouldApplyUpdateNow };
