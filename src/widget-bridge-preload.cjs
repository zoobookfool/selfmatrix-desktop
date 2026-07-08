const { ipcRenderer } = require("electron");

// M1 step 2 (B 単体実証) の注記: CallControl 相当の DOM 操作ロジックは call-control-preload.cjs に
// 分離してあるが、このファイルからは require しない。call view は sandbox:true で動いており、
// 実測の結果 sandbox 下の preload の require() は "electron" 以外 (node: 組み込みや相対パスの
// 自前ファイルを含む) を解決できない (`Error: module not found: path` 等)。そのため
// call-control-preload.cjs は main.cjs が `session.fromPartition(CALL_VIEW_PARTITION)
// .registerPreloadScript()` で「2 本目の独立した preload」として登録する方式にした
// (詳細は main.cjs の ensureCallView() 冒頭コメントと call-control-preload.cjs 冒頭コメント参照)。
// 同一フレームの preload はこのファイルと並行して読み込まれるが、互いの変数を共有しないので
// (electron の require もそれぞれが独立して行う)、ここでの変更は不要。

// EC (widget) はこの WebContentsView のトップレベル window で動く (実 iframe には入っていない)
// ため window.parent === window の自己ループで postMessage する。ここではその 'message' を
// そのまま素通しで main へ転送する (M0 から流用、ロジック変更なし)。
//
// F4 (受け入れレビュー修正) 「echo」についての注記: 下の ipcRenderer.on("native:widget-to-view", ...)
// は shell から中継されたメッセージをこの同じ window へ window.postMessage する。その postMessage は
// この window 自身が発火源であり、直後にこの addEventListener("message", ...) 自身にも 'message'
// イベントとして届く (event.source === window になる) ため、to-view で受け取ったメッセージが
// そのまま from-view としてもう一度 main へ転送される「echo」が必ず発生する。これは無害:
// matrix-widget-api の PostmessageTransport は方向フィルタ (`request.api !== invertedDirection`) と
// `outboundRequests` の requestId 照合で、自分が送ったリクエスト/応答の echo を握り潰すよう
// 設計されている (design/native-widget-transport.md「残存リスク」節でライブラリ実コードを確認済み)。
// **test-harness/cli/widget-protocol.mjs はこの loopback 自体を「preload が実際に転送したか」の
// 観測点として利用している (response-loopback イベント) ため、ここで echo を抑制する変更を
// 加えてはならない。**
window.addEventListener("message", (event) => {
  const data = event.data;
  if (
    !data ||
    typeof data !== "object" ||
    (data.api !== "fromWidget" && data.api !== "toWidget") ||
    !data.requestId ||
    !data.widgetId
  ) {
    return;
  }

  ipcRenderer.send("native:widget-from-view", {
    data,
    origin: event.origin,
    sourceIsSelf: event.source === window,
  });
});

// shell (host) 側から中継される、widget 宛てのメッセージを window へ折り返す。
// M0 まではリクエスト用/レスポンス用に別チャンネル (widget-api-to-widget / widget-api-response) を
// 使っていたが、どちらも「shell がこの window に届けたい生の Widget API オブジェクト」という点で
// 中継としては同一のため、design/native-widget-transport.md §2.1 の 2 チャンネル構成
// (native:widget-to-view / native:widget-from-view) に合わせて 1 本に統合した。
// 中身が toWidget リクエストか、fromWidget リクエストへの応答 (`.response` 付き) かは
// matrix-widget-api の PostmessageTransport.handleMessage 側が判別するので、ここでは中身を見ない。
ipcRenderer.on("native:widget-to-view", (_event, message) => {
  window.postMessage(message, window.location.origin);
});
