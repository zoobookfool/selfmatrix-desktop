const { contextBridge, ipcRenderer } = require("electron");

// main が call view から受け取り検証済みの (validateWidgetBridgeMessage 通過済みの) 生の
// Widget API メッセージをここへ中継してくる。matrix-widget-api の PostmessageTransport は
// inboundWindow (= このページの globalThis) への本物の 'message' イベントでしか受信できない
// (design/native-widget-transport.md §1.1, §2.1) ため、window.postMessage で折り返して
// 本物の DOM イベントとして着地させる。preload の window は contextIsolation 下でも実際の
// フレームの window であり (widget-bridge-preload.cjs で同型の折り返しが M0 から動作実績あり)、
// shell-widget-host.js が構築する ClientWidgetApi のトランスポートはこのページの通常スクリプト
// コンテキストで動いているため、ここで postMessage したイベントは globalThis.addEventListener
// ("message", ...) で直接受け取れる。
ipcRenderer.on("native:widget-from-view", (_event, message) => {
  window.postMessage(message, window.location.origin);
});

// M1 step 3b 実装要件 4: call view preload (call-control-preload.cjs) からの
// MutationObserver 由来 state push (native:call-control:state, main.cjs が素通し転送) を
// onCallControlState() で登録されたリスナー全員へ配る。design §2.2 の「main は解釈しない
// 中継役」という方針をここでも踏襲する: shell-preload.cjs もこの push の中身 (action 種別や
// フィールド構成) を一切解釈せず、structured-clone 可能な plain object のまま右から左へ流す。
// 意味解釈 (どのフィールドが CallControlState のどの項目に対応するか) は cinny 側の
// NativeCallControl.ts の責務。
// リスナー登録はここ (preload モジュールスコープ) で 1 度きり — claimWidgetTransport() が
// 複数回呼ばれる (=throw する) ことはないが、仮に将来 claim-once を外しても登録が二重化
// しないようにするため、ipcRenderer.on 自体はモジュールロード時に固定し、実際の配信先
// (callControlStateListeners) だけを claim 済みトランスポートの onCallControlState() 経由で
// 登録/解除できるようにする。
const callControlStateListeners = new Set();
ipcRenderer.on("native:call-control:state", (_event, payload) => {
  for (const listener of callControlStateListeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error("[shell-preload] onCallControlState listener threw: ", error);
    }
  }
});

// F2b (受け入れレビュー修正): この prototype は cinny を同一オリジンの iframe として埋め込んでいる
// (desktop-shell.html の #cinny-frame)。同一オリジンなので、cinny の iframe コンテンツ内の JS は
// ブラウザ標準の同一オリジンアクセスとして `window.parent.selfmatrixNative` に触れられる —
// これは contextIsolation とは別レイヤーの経路で、design/native-widget-transport.md の
// 「残存リスク」節に記録済み。sendToView 等を直接 exposeInMainWorld すると iframe 側から自由に
// widget メッセージを送信 API に流し込めてしまうため、「初回呼び出しでだけ送信 API を払い出し、
// 以後は throw する」claim-once 方式に変える。ページスクリプト (shell-widget-host.js、または
// --cinny-shell モードでは cinny 本体のバンドル) は iframe の子コンテンツより先に実行される
// (HTML パース順序で <script> がブロッキング実行されるのに対し、iframe の中身の読み込み・実行には
// ネットワークフェッチが挟まるため確実に後になる) ため、起動時に先取り (claim) しきってしまえる。
//
// M1 step 3b (3a レビューからの引き継ぎ、design §3 step 3b 実装要件 2): cinny 側の
// `nativeBridge.ts` (`SelfmatrixNativeWidgetTransport`) 契約に合わせて形状を変更した。
//   - `notifyWidgetHostReady` を廃止した。旧実装は main.cjs 側の `ensureCallView()` が
//     この合図を待ってから EC の読み込みを開始していたが、新契約では EC のロード開始
//     (`openCallView`) はそもそも呼び出し元 (cinny の `NativeCallEmbed` / harness の
//     `shell-widget-host.js`) が `new ClientWidgetApi(...)` (同期的に 'message' リスナー登録を
//     完了させる) の直後に自分で呼ぶ形に変わったため、順序不変条件は呼び出し順序そのものが
//     保証するようになり、別チャンネルでの合図待ちが不要になった (design §3 step 3b 実装要件 2)。
//   - `ensureCallView`/`detachCallView`/`attachCallView` の静的フロー (`/widget-config.json` 読込 +
//     main.cjs が固定 URL を組み立てる) の代わりに、呼び出し元が組み立てた完成 URL を渡す
//     `openCallView(completeWidgetUrl)` / `closeCallView()` を claim 済みトランスポートに統合した。
//   - `onCallControlState(listener)` を新設した (design §3 step 3b 実装要件 4)。call view 側
//     preload の MutationObserver 由来 push を購読できるようにする。
let widgetTransportClaimed = false;
function claimWidgetTransport() {
  if (widgetTransportClaimed) {
    throw new Error(
      "selfmatrixNative widget transport already claimed. claimWidgetTransport() may only be called once " +
        "per shell window (F2b claim-once guard).",
    );
  }
  widgetTransportClaimed = true;
  return {
    // shell 側の本物の ClientWidgetApi (iframe シムの contentWindow.postMessage) から呼ばれる
    // 素通し送信。main はここに検証を挟まず call view へそのまま転送する: 送信元はこのプロセス
    // 自身の信頼できる ClientWidgetApi 実装であり、call view (未信頼な EC/widget コンテキスト) からの
    // spoofing 経路とは非対称なため (validateWidgetBridgeMessage が対象とするのは call view→shell の
    // 方向のみ)。F2a で main.cjs 側にも widgetId/api 方向の形状検証を追加し、こちらは防御を多重化した。
    sendToView: (message) => ipcRenderer.send("native:widget-to-view", message),
    // M1 step 3b (design §3 step 3b 実装要件 1/2): 通話 View を完成 URL でロードするよう
    // main プロセスへ依頼する。main.cjs の openCallView() が同一オリジン + EC dist の既知
    // base (`/ec/` または `/public/element-call/`) prefix を検証してから初めて loadURL する
    // (nativeBridge.ts の openCallView() 契約コメント、design の URL 検証要件参照)。不合格なら
    // ここで reject する (call view は絶対にロードされない)。
    // M1 step 3c-2: 第 2 引数 (localStorageSnapshot、任意) は cinny の NativeCallEmbed が
    // collectNativeCallLocalStorageSnapshot() で集めた matrix-setting-* のスナップショット。
    // ここでは中身を解釈せずそのまま main へ渡すだけ (design の「中継するだけ」方針をここでも
    // 踏襲する) — main.cjs の openCallView()/state.pendingLocalStorageSnapshot と
    // call-control-preload.cjs の primeLocalStorageFromShell() 参照。
    openCallView: (completeWidgetUrl, localStorageSnapshot) =>
      ipcRenderer.invoke("native:open-call-view", completeWidgetUrl, localStorageSnapshot),
    // M1 step 3b: 通話 View を閉じる (NativeCallEmbed の dispose/hangup 時に呼ばれる想定)。
    closeCallView: () => ipcRenderer.invoke("native:close-call-view"),
    // M1 step 2 (B 単体実証): NativeCallControl 相当の RPC 入口。ipcMain.handle 側 (main.cjs) が
    // correlationId を発行して call view preload (call-control-preload.cjs) と往復するので、
    // ここは ipcRenderer.invoke を薄く呼ぶだけで済む (往復の相関はすべて main.cjs 側の責務)。
    // F7 (受け入れレビュー修正): 当初はこの RPC を claim-once の外、selfmatrixNative に常時公開して
    // いた ("この RPC はユーザーが通話 UI 上のボタンを直接クリックするのと機能的に同値だから安全"
    // という理由づけだったが、これは F2b の claimWidgetTransport() が塞いだはずの「同一オリジン
    // iframe (cinny 埋め込み) から window.parent.selfmatrixNative 経由で送信 API に触れられる」経路を
    // この新チャンネルで再発させていた。実コントロール (画面共有トグル等) に対象が差し替わる step 3
    // では「ユーザー操作なしに他フレームから操作を起こせる面」になり得るため、送信 API
    // (sendToView/openCallView/closeCallView) と同じ claim-once の対象に統合し、常時公開から外す。
    // host 側 (shell-widget-host.js) はここから受け取ったこの関数を使い、window.selfmatrixWidgetHost に
    // 安全なラッパー (callControlToggle()) を公開する。到達境界の再設計は design の「残存リスク」節と
    // 合わせて M2 セキュリティ監査で見直すこと。
    callControlInvoke: (action) => ipcRenderer.invoke("native:call-control:invoke", action),
    // H3 (受け入れレビュー修正、major): 「共有開始時に再同期」する live localStorage 契約の
    // host 側入口。main.cjs の updateCallLocalStorage() (native:update-call-localstorage) を
    // 薄く呼ぶだけ — cinny 側 NativeCallControl.toggleScreenshare() がこれを await してから
    // callControlInvoke() の RPC を実行する契約 (nativeBridge.ts の updateCallLocalStorage()
    // 契約コメント参照)。
    updateCallLocalStorage: (snapshot) => ipcRenderer.invoke("native:update-call-localstorage", snapshot),
    // M1 step 3b 新設 (design §3 step 3b 実装要件 4): call view preload からの state push
    // (native:call-control:state) を購読する。listener はこのファイル冒頭の
    // callControlStateListeners に登録され、ipcRenderer.on ハンドラ (モジュールスコープで 1 度だけ
    // 登録済み) から呼ばれる。戻り値は unsubscribe 関数 (nativeBridge.ts の契約どおり)。
    onCallControlState: (listener) => {
      callControlStateListeners.add(listener);
      return () => {
        callControlStateListeners.delete(listener);
      };
    },
    // M2 (Fable 全体レビュー arch-major 解消、bounds 同期): cinny の NativeCallEmbed.setPlacement()
    // が計算した call view の実際の表示領域を main へ push する。fire-and-forget (nativeBridge.ts の
    // setCallViewBounds() 契約どおり、戻り値なし) なので ipcRenderer.send (invoke ではない) を使う。
    // main 側の実体は applyCallViewBoundsFromCinny() (main.cjs の "native:set-call-view-bounds"
    // ハンドラ) — 入力検証・callViewState==="attached" ゲート・同値スキップはすべてそちら側の責務。
    setCallViewBounds: (bounds) => ipcRenderer.send("native:set-call-view-bounds", bounds),
  };
}

// M2 セキュリティ監査 (「shell の API 露出面整理」): getStatus/ensureCallView/detachCallView/
// attachCallView は cinny 側の契約 (nativeBridge.ts の SelfmatrixNativeBridge = claimWidgetTransport
// のみ) に一切現れず、cinny 本体からも呼ばれない harness/デモ由来の残骸だった。全数調査の結果:
//   - getStatus/detachCallView/attachCallView を実際に呼ぶのは desktop-shell.js (harness UI の
//     ボタンハンドラ) だけ。
//   - ensureCallView を実際に呼ぶのは shell-widget-host.js の sendAction() (harness の
//     ClientWidgetApi ラッパ) だけ。
//   - どちらも harness トポロジ (desktop-shell.html がトップフレーム、cinny は同一オリジンの
//     iframe として埋め込まれるだけ) でしか読み込まれないスクリプトで、本番 topology
//     (--cinny-shell、cinny 自身がトップフレーム) では配信すらされない。
// これらは claim-once (claimWidgetTransport()) の外側に常時公開されていたため、本番 topology では
// cinny のフレーム内で動く任意のコード (侵害された依存/プラグイン等、cinny 自身の契約外) が
// ユーザー操作なしに detach/attach (WebContentsView 再親子付け) や call view 生成を起こせる面に
// なっていた。main.cjs の createMainWindow() が additionalArguments 経由でこのウィンドウの
// トポロジ (--selfmatrix-shell-topology=cinny-shell|harness) を渡してくるので、harness トポロジの
// ときだけこの 4 メソッドを追加する — 本番 topology では window.selfmatrixNative は
// claimWidgetTransport 一本だけになる。
//
// E2E (__selfmatrixE2E.detachCallView()/attachCallView() 等、main.cjs の setupE2EIntrospection()
// 参照) はこの window.selfmatrixNative 経由の bridge ではなく、playwright-core の
// electronApp.evaluate() で main プロセスのモジュールスコープ関数を直接呼ぶ別経路なので、
// この変更の影響を受けない。E2E は常に --cinny-shell (本番 topology) で起動する
// (e2e/native-join.e2e.mjs, e2e/lib/nativeE2ELib.mjs 参照) ため、むしろこのゲートにより
// window.selfmatrixNative 経由でも harness 専用 API に触れられないことが本番相当の条件で
// 保証される。
const isHarnessTopology = process.argv.includes("--selfmatrix-shell-topology=harness");

const selfmatrixNativeApi = { claimWidgetTransport };
if (isHarnessTopology) {
  selfmatrixNativeApi.getStatus = () => ipcRenderer.invoke("native:get-status");
  selfmatrixNativeApi.ensureCallView = () => ipcRenderer.invoke("native:ensure-call-view");
  selfmatrixNativeApi.detachCallView = () => ipcRenderer.invoke("native:detach-call-view");
  selfmatrixNativeApi.attachCallView = () => ipcRenderer.invoke("native:attach-call-view");
}

contextBridge.exposeInMainWorld("selfmatrixNative", selfmatrixNativeApi);
