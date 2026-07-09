// M2 画面共有ソース選択 UI: ネイティブピッカーウィンドウ専用の preload。
//
// 設計判断 (絶対条件): cinny レンダラ (未信頼な federated コンテンツを描画する) に画面キャプチャ
// 能力を一切露出しない。この preload は cinny 用の shell-preload.cjs (window.selfmatrixNative) とは
// 完全に別系統 -- 別の BrowserWindow (source-picker.html)、別の preload ファイル、別の
// contextBridge 名前空間 (window.selfmatrixSourcePicker) であり、cinny レンダラからは触れられない
// (cinny の webContents にはこの preload は一切登録されない)。window.selfmatrixNative の契約
// (claimWidgetTransport のみ) はこの変更で一切広げていない。
//
// sandbox:true 下で動くため、widget-bridge-preload.cjs/call-control-preload.cjs と同じ制約により
// "electron" 以外は require しない (sandbox 下の preload の require() は "electron" 以外をほぼ
// 解決できないことを実測済み -- call-control-preload.cjs 冒頭コメント参照)。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("selfmatrixSourcePicker", {
  // main (openSourcePicker()/createSourcePickerWindow()) が列挙済みのソース一覧 (サムネイル
  // dataURL・名前・id・type 込み) と audioAvailable (システム音声トグルを出してよいか、
  // request.audioRequested && win32 で決まる) を初回ロード後に一度だけ push してくる。
  onInit: (callback) => {
    ipcRenderer.on("source-picker:init", (_event, payload) => callback(payload));
  },
  // ユーザーが 1 件選んで「共有」を押した。main 側の resolveDisplayMediaSelection() が
  // sourceId から実際の source オブジェクトを解決する (このプロセス側は id だけを送り返す --
  // NativeImage 等の複雑なオブジェクトを IPC でやり取りしない)。
  share: (selection) => ipcRenderer.send("source-picker:share", selection),
  // 「キャンセル」または閉じるボタン相当の操作。
  cancel: () => ipcRenderer.send("source-picker:cancel"),
});
