// shell 側 (cinny の BrowserWindow 相当) で本物の matrix-widget-api ClientWidgetApi を起動する。
//
// なぜこのファイルは preload ではなく desktop-shell.html の通常の <script> として読み込まれるのか:
// matrix-widget-api の PostmessageTransport は受信を `globalThis.addEventListener("message", ...)`
// に固定している (design/native-widget-transport.md §1.1)。この `globalThis` は
// ClientWidgetApi を構築したコンテキストの global を指す。preload スクリプト (contextIsolation
// 有効時) は実フレームの window に対して postMessage の送受信こそできるものの、preload 自身の
// globalThis が「ページの通常スクリプトが見る globalThis」と同一である保証は Electron の
// ドキュメント上ない (isolated world は DOM を共有するが JS ヒープは分離される)。
// 一方 cinny 本番では ClientWidgetApi は cinny 自身の vite バンドル内、つまりページの通常の
// (nodeIntegration 相当ではない、素の) スクリプトコンテキストで動く。そこでは globalThis は
// 疑いなくそのページの window そのものである。
// 本プロトタイプでもそれに最も近い構成として、ClientWidgetApi をこのページの通常スクリプト
// コンテキストで動かすことにした。ただし本番は vite/rollup がバンドルした ESM import なのに対し、
// ここでは matrix-widget-api が配布する browserify 済み UMD バンドル
// (node_modules/matrix-widget-api/dist/api.js, window.mxwidgets を公開) を <script> タグで
// 素朴に読み込んでいる点が本番との構成差分 (モジュールの中身・挙動は同一、ロード方式のみ異なる)。
//
// nodeIntegration:false のページなので ipcRenderer には直接触れない。shell-preload.cjs が
// contextBridge 経由で公開する window.selfmatrixNative.claimWidgetTransport() を起動時に一度だけ
// 呼び、そこから受け取る sendToView()/openCallView()/closeCallView()/callControlInvoke()/
// onCallControlState() を薄く呼ぶだけで、main プロセスへの実際の IPC 送信は preload 側の責務の
// ままにする (F2b, 受け入れレビュー修正: claim-once の理由は下の IIFE 冒頭のコメント参照)。
//
// M1 step 3b (design §3 step 3b 実装要件 2): cinny 側の nativeBridge.ts 契約に合わせて
// このスクリプトも新契約に追随させた。旧実装は window.selfmatrixNative.ensureCallView() (静的な
// /widget-config.json 方式、main.cjs が固定 URL を組み立てる) を呼んでいたが、新契約では
// このスクリプト自身が (cinny の NativeCallEmbed と同じように) widget.getCompleteUrl() で
// 完成 URL を組み立て、claim 済みトランスポートの openCallView(completeUrl) を呼ぶ。
// notifyWidgetHostReady() は廃止済み — new ClientWidgetApi(...) の直後に openCallView() を
// 呼ぶ、という呼び出し順序そのものが「'message' リスナー登録済み」を保証するため、別途
// 合図を送る必要が無くなった (design の順序不変条件、nativeBridge.ts の openCallView() 契約
// コメント参照)。
(function () {
  "use strict";

  // F2b (受け入れレビュー修正): このページスクリプトは cinny iframe (#cinny-frame) の子コンテンツ
  // より先に実行される — 同じ HTML パース中に <script> はブロッキング実行されるのに対し、iframe の
  // 中身はネットワークフェッチを挟んでから読み込まれるため、ここでの claim は必ず先取りできる。
  // claimWidgetTransport() は初回だけ送信 API を払い出し、2 回目以降は throw する
  // (shell-preload.cjs 参照)。cinny iframe 側からの window.parent.selfmatrixNative 経由の
  // 到達を、ここで先に claim してしまうことで塞ぐ。
  const widgetTransport = window.selfmatrixNative.claimWidgetTransport();

  function createIframeShim(postToView) {
    const listeners = new Map();
    return {
      // ClientWidgetApi のコンストラクタが読むのは contentWindow.postMessage だけ
      // (design/native-widget-transport.md §1.1, §2.1)。iframe は実在しないのでこの最小オブジェクトで足りる。
      contentWindow: {
        postMessage(message) {
          postToView(message);
        },
      },
      // ClientWidgetApi は 'load' を addEventListener するが、widget は waitForIframeLoad:false
      // で生成するため 'load' が発火しないことに実害はない (design §1.1)。呼ばれても記録するだけ。
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    };
  }

  function createNativeWidgetDriver(WidgetDriver) {
    return class NativeWidgetDriver extends WidgetDriver {
      // M1 step 1 は widget-api トランスポート単体の実証が目的なので、要求された capability は
      // 検証なしで全承認する (design 手順1「driver 承認」)。個別の可否判定・ユーザー確認 UI・
      // sendEvent/sendToDevice 等の実装は (B) 以降 / 結合フェーズのスコープ。
      validateCapabilities(requested) {
        return Promise.resolve(new Set(requested));
      }
    };
  }

  async function boot() {
    const mxwidgets = window.mxwidgets;
    if (!mxwidgets) throw new Error("matrix-widget-api UMD bundle (window.mxwidgets) not loaded");

    const config = await fetch("/widget-config.json").then((response) => response.json());

    // M1 step 3b: cinny の CallEmbed.getWidget()/NativeCallEmbed 同様、widget.url テンプレートに
    // 完成 URL 相当のクエリパラメータをあらかじめ埋め込んでおく (この harness には $ 変数を解決する
    // 実際のテンプレート機構が無いので、値はここで直接組み立てる)。widget.getCompleteUrl() は
    // それをそのまま返す (下記)。main.cjs の buildLocalCallUrl() の既定値と同じパラメータ集合。
    const parentUrl = `${window.location.origin}/desktop-shell.html`;
    const params = new URLSearchParams({
      widgetId: config.widgetId,
      parentUrl,
      roomId: config.roomId,
      userId: config.userId,
      deviceId: config.deviceId,
      baseUrl: config.baseUrl,
      intent: "join_existing_voice",
      preload: "true",
      skipLobby: "true",
      disableVideo: "true",
      hideVideoButton: "true",
      theme: "dark",
    });
    const templateUrl = `${window.location.origin}/ec/index.html?${params.toString()}`;

    const widget = new mxwidgets.Widget({
      id: config.widgetId,
      creatorUserId: config.userId,
      type: "m.call",
      url: templateUrl,
      waitForIframeLoad: false,
    });

    const NativeWidgetDriver = createNativeWidgetDriver(mxwidgets.WidgetDriver);
    const driver = new NativeWidgetDriver();
    const shim = createIframeShim((message) => widgetTransport.sendToView(message));
    const clientWidgetApi = new mxwidgets.ClientWidgetApi(widget, shim, driver);

    const listeners = new Set();
    function notify(direction, detail) {
      for (const listener of listeners) {
        try {
          listener(direction, detail);
        } catch (error) {
          console.error("[shell-widget-host] listener failed", error);
        }
      }
    }

    clientWidgetApi.on("ready", () => notify("lifecycle", { event: "ready" }));
    clientWidgetApi.on("capabilitiesNotified", () =>
      notify("lifecycle", { event: "capabilitiesNotified", allowed: Array.from(clientWidgetApi.allowedCapabilities) }),
    );
    // UI ログ用の補助的な観測経路。ClientWidgetApi 自身の transport もこの同じ window の
    // 'message' を購読しているので、ここでの傍受はハンドシェイクの挙動には影響しない。
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      notify("inbound", event.data);
    });

    // M1 step 3b 実装要件 4: call view preload からの state push を UI ログにも流す
    // (手動確認用の補助的な観測経路。onCallControlState() の配線自体はここで初めて動作確認
    // されるわけではなく、cinny-shell smoke がより厳密に検証する — これは harness の手動デモ用)。
    widgetTransport.onCallControlState((pushedState) => notify("call-control-state", pushedState));

    // M1 step 3b (design §3 step 3b 実装要件 2): cinny の NativeCallEmbed コンストラクタと同じ
    // 手順 — widget.getCompleteUrl() で完成 URL を組み立てる。this harness の widget.url は
    // 既にクエリパラメータを含む具体値なので (テンプレート変数を使っていない)、getCompleteUrl() は
    // それをそのまま返す。
    const completeUrl = widget.getCompleteUrl({ currentUserId: config.userId });

    window.selfmatrixWidgetHost = {
      config,
      widget,
      driver,
      clientWidgetApi,
      completeUrl,
      // io.element.join 等のホスト起点カスタム action。本番の CallEmbed も
      // call.transport.send() 経由でこれと同じものを呼ぶ (design §1.3)。
      // F3 (受け入れレビュー修正): 「通話 View 起動」ボタンを押す前に Join/DeviceMute/Hangup を
      // 押すと転送先の call view が無く 10 秒無音タイムアウトになる退行があった
      // (M0 の sendWidgetAction は ensureCallView を内包していたが、M1 step 1 の素通しルータ化で
      // 抜け落ちていた)。送信前に必ず ensureCallView() を await する — 既に起動済みなら
      // main.cjs 側の createCallViewIfNeeded() が即 return するだけで無害。
      // M1 step 3b: この guard は「view を作るだけ (URL はロードしない)」の ensureCallView() の
      // ままにしてある — boot() が既に openCallView(completeUrl) で読み込み済みのはずなので、
      // ここで openCallView() を再度呼んで EC をリロードしてしまわないようにするため。
      async sendAction(action, data) {
        await window.selfmatrixNative.ensureCallView();
        return clientWidgetApi.transport.send(action, data || {});
      },
      onMessage(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      // M1 step 2 (F7, 受け入れレビュー修正): call-control RPC の安全なラッパー。
      // callControlInvoke 自体は claimWidgetTransport() の claim-once 対象 (widgetTransport 変数、
      // このファイルの先頭で一度だけ払い出し済み) に移設済みなので、常時公開のグローバルからは
      // 到達できない。desktop-shell.js の手動ボタンや main.cjs の smoke ヘルパー
      // (invokeCallControlFromShell()) はここ経由でのみ叩く。引数を取らず対象アクションを固定する
      // ことで、公開面を「実在する 1 コントロールのトグル」だけに絞ってある — 対象を実コントロールに
      // 差し替える step 3 でも、この関数の中身 (呼び出す action 名) を差し替えるだけで済む設計。
      callControlToggle() {
        return widgetTransport.callControlInvoke("toggleTarget");
      },
      // M1 step 3b 新設: desktop-shell.js の「通話 View 起動」ボタンから手動で
      // (再) オープンするためのラッパー。boot() 完了時に自動で 1 度呼ばれるのに加え、
      // 手動リロード確認用にも使える (同じ completeUrl での再 loadURL は冪等な reload として扱う)。
      openCall() {
        return widgetTransport.openCallView(completeUrl);
      },
      closeCall() {
        return widgetTransport.closeCallView();
      },
    };

    // M1 step 3b (design §3 step 3b 実装要件 2): cinny の NativeCallEmbed コンストラクタが
    // `new ClientWidgetApi(...)` (上、'message' リスナー登録を同期的に完了させる) の直後に
    // 自分で openCallView() を呼ぶのと同じ手順をここでも踏む。旧 notifyWidgetHostReady() の
    // 合図待ちは、この呼び出し順序そのものが安全性を保証するようになったため不要になった。
    await widgetTransport.openCallView(completeUrl);
  }

  boot().catch((error) => {
    console.error("[shell-widget-host] boot failed", error);
  });
})();
