// M2 画面共有ソース選択 UI: Electron 非依存の純関数群。
// main.cjs (Electron 依存) と source-picker-selection-probe.cjs (plain Node の単体検証 probe) の
// 両方から require される -- widget-bridge-protocol.cjs と同じ「判定ロジックを二重実装しない」方針。
//
// 設計判断 (desktop-e2e タスクの絶対条件): ソース選択 UI は cinny レンダラ内ダイアログにしない。
// desktop 自身のネイティブピッカーウィンドウ (source-picker.html + source-picker-preload.cjs) が
// ユーザーの選択結果を main.cjs へ運んでくるが、「列挙されたソースの中から選ばれた 1 件を実際に
// 解決し、setDisplayMediaRequestHandler() の callback() へ渡す最終引数を組み立てる」ロジック自体は
// Electron の Window/IPC には一切依存しないため、ここへ切り出して機械的に単体検証できるようにした。

// sources: desktopCapturer.getSources() が返す配列と互換 (少なくとも `id`/`name` を持つオブジェクト
//   の配列であればよい -- probe は素の plain object 配列で呼ぶ)。
// pickerResponse: source-picker-preload.cjs 経由で picker window から届く選択結果。
//   - キャンセル: { canceled: true, reason?: string } | null | undefined
//   - 選択: { canceled: false, sourceId: string, includeSystemAudio: boolean }
// options.platform: 既定は process.platform。probe から明示的に上書きして win32/非 win32 の両方を
//   Electron 無しで検証できるようにしてある。
//
// 戻り値: { canceled, video, audio, reason }
//   - video: 一致した source オブジェクト (見つからなければ null)。
//   - audio: "loopback" (システム音声 ON かつ win32) | false。
//     main.cjs の従来ロジック (registerDisplayMediaHandler()) と同じ式を維持する:
//     `includeSystemAudio && platform === "win32" ? "loopback" : false`。
function resolveDisplayMediaSelection(sources, pickerResponse, options = {}) {
  const platform = options.platform || process.platform;
  const list = Array.isArray(sources) ? sources : [];

  if (!pickerResponse || pickerResponse.canceled || typeof pickerResponse.sourceId !== "string") {
    return {
      canceled: true,
      video: null,
      audio: false,
      reason: pickerResponse && typeof pickerResponse.reason === "string" ? pickerResponse.reason : "canceled",
    };
  }

  const video = list.find((source) => source && source.id === pickerResponse.sourceId) || null;
  if (!video) {
    return { canceled: true, video: null, audio: false, reason: "source_not_found" };
  }

  const audio = Boolean(pickerResponse.includeSystemAudio) && platform === "win32" ? "loopback" : false;
  return { canceled: false, video, audio, reason: null };
}

module.exports = { resolveDisplayMediaSelection };
