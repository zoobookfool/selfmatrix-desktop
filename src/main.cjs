let electron = {};
try {
  electron = require("electron");
} catch (error) {
  if (require.main === module) throw error;
}
const { app, BrowserWindow, WebContentsView, desktopCapturer, ipcMain, session, shell, Tray, Menu, nativeImage } =
  electron;
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// Electron 非依存の Widget API bridge 純関数群は widget-bridge-protocol.cjs に集約されている。
// main.cjs はこれらを自前で再実装せず、常にこのモジュールへ委譲する
// (test-harness/cli/widget-protocol.mjs も同じモジュールを直接 require するため、
// 二重実装によるロジックのズレが起きない)。
//
// M1 step 1 以降、main.cjs は「通話 1 本につき 2 チャンネル (native:widget-to-view /
// native:widget-from-view) を素通しするだけの薄いルータ」になった (design/native-widget-transport.md
// §2.1)。responseForWidgetRequest による応答生成はライブ経路から除去済み — 実際の応答は shell
// 側の本物の ClientWidgetApi (src/shell-widget-host.js) が生成する。
const {
  WIDGET_ID,
  WIDGET_ROOM_ID,
  WIDGET_USER_ID,
  WIDGET_DEVICE_ID,
  WIDGET_BASE_URL,
  buildWidgetUrl,
  validateWidgetBridgeMessage,
  validateToViewMessage,
  validateCallViewUrl,
} = require("./widget-bridge-protocol.cjs");

// M2 画面共有ソース選択 UI: 「選択されたソース + ピッカーの応答から setDisplayMediaRequestHandler()
// の callback() 引数を解決する」ロジックは Electron に依存しない純関数として
// source-picker-selection.cjs に切り出してある (widget-bridge-protocol.cjs と同じ方針)。
// main.cjs (ここ) と、plain Node で完結する単体検証 probe (source-picker-selection-probe.cjs) の
// 両方がこれを require する -- 判定ロジックの二重実装によるズレを防ぐ。
const { resolveDisplayMediaSelection } = require("./source-picker-selection.cjs");

// F1 (受け入れレビュー修正): smoke がハンドシェイク完了後に注入する偽メッセージの action 名。
// widgetId をわざと WIDGET_ID と不一致にしてあるので validateWidgetBridgeMessage の
// widget_id_mismatch で必ず拒否される想定 — 拒否されなければ (＝すり抜ければ) smoke は fail する。
const SPOOF_ACTION = "selfmatrix.test.spoof";
const SPOOF_WIDGET_ID = "spoofed-widget-id";

// M1 step 3c-1 受け入れレビュー修正: 通話が非アクティブ (openCallView 前 / closeCallView 後、
// state.activeWidgetId === null) のときは widget メッセージを widgetId 照合せず必ず拒否する
// (fail-closed)。以前の `?? WIDGET_ID` は「未アクティブなのに固定値と一致すれば受理される」fail-open だった。
const NO_ACTIVE_CALL_REJECTION = Object.freeze({
  ok: false,
  reasons: [{ code: "no_active_call", message: "No active call (openCallView not performed)." }],
});

// M1 step 2 (B 単体実証): native:call-control:invoke の correlationId 方式往復管理。
// main は action の意味を解釈しない中継役に徹する (design/native-widget-transport.md §2.2) —
// ここで持つのは「どの応答をどの ipcMain.handle() 呼び出しに戻すか」の相関だけで、
// action や result の中身は一切見ない。
const pendingCallControlInvokes = new Map();
let callControlInvokeSeq = 0;

// call view (EC WebContentsView) の永続パーティション名。createCallViewIfNeeded() の
// WebContentsView 生成と、call-control-preload.cjs を 2 本目の preload として登録する
// session.fromPartition() の両方から同じ文字列を参照する必要があるため定数化した。
// M2 readiness レビュー修正 (GPT 指摘 C/D): "prototype" 名の残りを剥がすため
// "persist:selfmatrix-native-prototype-call" から改名した。session partition 名は Electron 内部の
// 実装詳細であり cinny 側からは一切参照されない (widget-bridge-protocol.cjs の WIDGET_ID 改名コメント
// 参照) ため、cinny 側の追随は不要。
const CALL_VIEW_PARTITION = "persist:selfmatrix-native-call";

// C1 (GPT レビュー P1b, 実バグ修正): session.fromPartition(...).registerPreloadScript() は
// **session パーティション単位で累積登録される** (呼び出しごとに追加され、同じフレーム種別の
// 登録を上書きも重複排除もしない)。createCallViewIfNeeded() 冒頭の早期 return (`if (state.callView)
// return;`) は「同一の WebContentsView インスタンスが存命の間は呼んでも無駄」という意味でしかなく、
// closeCallView() → 再度 openCallView() のように call view を作り直すたびに state.callView は null に
// 戻るため、この早期 return を通過してまた登録処理に到達する。以前のコメント (「call view 1 個の
// 寿命中に一度しか呼ばれないため登録も一度きりで良い」) は誤りで、実際には通話をまたいで累積し、
// 2 本目の通話では call-control-preload.cjs が session に複数登録された状態になり、1 回の RPC に
// 複数のリスナーが反応する (実測されたバグ例: screenshare トグルが「開始→即停止」になる)。
// registerPreloadScript() 自体には「同じ内容ならスキップする」等の冪等性は無い (Electron の契約上、
// 呼べば必ず 1 件追加される) ため、ここではモジュールレベルのフラグでプロセス全体を通して高々 1 回
// しか registerPreloadScript() を呼ばないようにする (call view を何度作り直しても登録は増えない)。
// callViewPreloadRegistrationCount は診断用 (cinny-shell-smoke の回帰検証、runCinnyShellSmoke() の
// callViewPreloadRegistration ステップ参照) — このカウントが 1 を超えたら登録の累積が復活した証拠。
let callViewPreloadRegistered = false;
let callViewPreloadRegistrationCount = 0;

// G3 (受け入れレビュー修正): cinny 側 NativeCallControlAction (cinny/src/app/plugins/call/native/
// NativeCallControl.ts) が宣言する契約語彙 7 種のコピー。文字列そのものは cinny 側の enum の値と
// 手動同期している (main.cjs は cinny のソースを直接 import できないため)。runCinnyShellSmoke() は
// この 7 つを実際に transport.callControlInvoke() で invoke し、call-control-preload.cjs の
// switch 分岐がこの語彙を全て解釈することを検証する — 以前は 7 action のうちどれ 1 つも
// テストから呼ばれていなかった (toggleTarget という単体実証専用の別 action しか invoke されて
// いなかった)。
const CALL_CONTROL_VOCABULARY = [
  "toggleScreenshare",
  "toggleSpotlight",
  "toggleEmphasis",
  "toggleReactions",
  "toggleSettings",
  "setSoundOn",
  "setSoundOff",
];

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");
const isSmoke = process.argv.includes("--smoke");
const isMemoryProbe = process.argv.includes("--memory-probe");
// M1 step 3b 実装要件 5: --cinny-shell はトップフレームモード (mainWindow が
// desktop-shell.html ではなく <origin>/cinny/ を直接ロードする、本番 topology)。
// --cinny-shell-smoke はそのモードで item 7 の自動判定を行う専用フラグで、常に
// トップフレームモードのロードも伴う。
//
// M2 readiness レビュー修正 (GPT 指摘 A): 通常起動 (フラグ無し) の既定はこれまで harness
// モード (desktop-shell.html + cinny を iframe 埋め込み) だった — 製品リポジトリとして公開する
// 以上、通常起動の既定は本番 topology (cinny トップフレーム) であるべきで、旧来の harness は
// 明示的に選んだときだけ出てくる検証専用モードに格下げする。ここで isCinnyShell の既定を反転し、
// 新設した --harness フラグを「明示的に harness へ戻す」唯一の経路にした。
// --cinny-shell / --cinny-shell-smoke は「明示的にトップフレームを要求する」互換フラグとして
// 引き続き認識する (無くても既定で同じ結果になるが、既存の README/E2E がこれらを渡し続けても
// 壊れないようにするため)。smoke/memory-probe は harness 前提のテスト経路 (shell-widget-host.js
// の自動 boot に依存する、runSmoke()/runMemoryProbe() 参照) なので、package.json 側でこれらの
// npm script に --harness を追加した — isSmoke/isMemoryProbe 自体はこの分岐には関与しない
// (あくまで --harness の有無だけで決まる)。
const isHarness = process.argv.includes("--harness");
const isCinnyShellSmoke = process.argv.includes("--cinny-shell-smoke");
const isCinnyShell = isCinnyShellSmoke || process.argv.includes("--cinny-shell") || !isHarness;

// SelfMatrix M1 step 3c-1: ネイティブシェルからの実ログイン → 実 LiveKit join を検証する
// E2E (e2e/native-join.e2e.mjs) 専用モード。--cinny-shell と併用する
// (トポロジは --cinny-shell が決める。このフラグは E2E 計装だけを追加で有効にする)。
// **dev/E2E 実行専用— 本番/通常起動では絶対にこのフラグを渡さないこと。**
const isE2ERealJoin = process.argv.includes("--e2e-real-join");
if (isE2ERealJoin && app) {
  // ローカル dev Matrix/LiveKit スタック (element-call/dev-backend-docker-compose.yml) は
  // 自己署名の開発用 CA (element-call/backend/dev_tls_local-ca.crt) を使っている。この switch
  // 無しでは https://synapse.m.localhost / https://matrix-rtc.m.localhost への接続が TLS
  // エラーで失敗する。dev/E2E 限定 — 本番ビルドではこの分岐自体に到達しない。
  app.commandLine.appendSwitch("ignore-certificate-errors");
  // getUserMedia() のデバイス選択ダイアログ/許可プロンプトを自動承認し、実マイク/カメラの
  // 代わりに合成 (fake) デバイスを使わせる。このワークスペースの絶対条件 (実オーディオ
  // デバイスを検証に使わない) を満たすための必須設定。dev/E2E 限定。
  //
  // M2 画面共有ソース選択 UI (レビュー指摘、実測で確定): 以前ここで使っていた
  // `--use-fake-ui-for-media-stream` は Chromium の FakeMediaStreamUIProxy を有効化するが、この
  // フェイク UI は getUserMedia() だけでなく getDisplayMedia() の権限/選択 UI も丸ごと横取りして
  // 自動解決してしまう (実測: session.setDisplayMediaRequestHandler() のハンドラ関数自体が
  // 一度も呼ばれないまま、fake な video+audio トラックで getDisplayMedia() が即座に resolve する
  // -- Electron の setDisplayMediaRequestHandler は登録した瞬間に画面共有選択 UI を完全に肩代わり
  // するはずだが、`--use-fake-ui-for-media-stream` が Electron のこのフックより先に短絡する)。
  // native-callflow.e2e.mjs がネイティブソースピッカー (source-picker.html) を実際に開いて
  // Playwright で操作する M2 の受け入れ要件と真っ向から矛盾する回帰だった (実バックエンドでの
  // e2e:callflow 実行で発覚: sourcePicker.opened:false のまま screenshare 自体は fake track で
  // 成立してしまっていた)。
  // `--auto-accept-camera-and-microphone-capture` は getUserMedia() の camera/microphone 許可
  // だけを自動承認する、より狭いスコープの Chromium フラグ (Chromium の
  // kAutoAcceptCameraAndMicrophoneCapture switch)。実機検証したところ、この置き換えにより
  // (a) getUserMedia() は従来どおり実プロンプト無しで fake device (下の
  // `use-fake-device-for-media-stream` 由来) に即時解決し、(b) getDisplayMedia() は
  // setDisplayMediaRequestHandler() のハンドラが確実に呼ばれ、ネイティブピッカーが実際に開く
  // (callback() を呼ばずに放置すると Promise が解決せず保留され続けることも確認済み — フェイク
  // UI による短絡が起きていないことの直接証拠)。dev/E2E 限定、本番ビルドではこの分岐自体に
  // 到達しない。
  app.commandLine.appendSwitch("auto-accept-camera-and-microphone-capture");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  // dev Matrix/LiveKit スタックは *.m.localhost (synapse.m.localhost, matrix-rtc.m.localhost,
  // synapse.othersite.m.localhost) を使う。curl はホスト名末尾の ".localhost" を DNS 問い合わせ
  // 無しでループバックへ特別扱いする実装を持つが (実測: `curl -v` が DNS を引かず ::1/127.0.0.1 へ
  // 直接繋いだ)、この開発機の OS リゾルバ (getaddrinfo) と Node の dns.lookup() はどちらもこの
  // 多段サブドメイン形式を解決できない (実測: ENOTFOUND) — Chromium のネットワークスタックが
  // 同じ制約を持つ場合に備え、OS リゾルバに依存せず明示的に 127.0.0.1 へマップする。
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.m.localhost 127.0.0.1");
}

// M2 トレイ常駐: OS のトレイの実クリックは自動化できないため、--tray-probe はトレイ関連ロジック
// (生成/close-to-tray/メニュー/クリックハンドラ) をプログラム的に検証する専用モード。本番相当
// (トレイ生成 + close-to-tray 有効) で起動し、runTrayProbe() が各挙動を直接呼んで
// evidence/tray-probe-result.json に記録する。
const isTrayProbe = process.argv.includes("--tray-probe");

// M2 トレイ常駐 (運用者確定仕様: 閉じるボタン = トレイに最小化、終了はトレイメニューから):
// 有効なのは「本番起動」(フラグ無し既定、または `--cinny-shell` 明示) のときだけ。
// smoke/memory-probe/cinny-shell-smoke はどれも自分の run*() の末尾で app.exit() を呼んで
// ライフサイクルを自己管理しており、E2E (--e2e-real-join) は Playwright の
// electronApp.close() がウィンドウを普通に閉じて window-all-closed 経由の app.quit() で終了する
// 前提で書かれている。close-to-tray (close イベントを preventDefault してウィンドウを隠すだけに
// する) を有効にしたままだと、これらのテストランナーが「ウィンドウを閉じればプロセスが終わる」と
// 期待している契約を壊してしまう。--harness も同じ理由で検証専用モードとして対象外にする。
// --tray-probe はこの一覧に入れず、`isTrayProbe ||` で明示的に有効化する — 「本番相当でトレイ生成
// + close-to-tray を有効化」した状態を検証するのがこのモードの目的そのものであるため。
const isTestRunnerMode = isSmoke || isMemoryProbe || isCinnyShellSmoke || isE2ERealJoin || isHarness;
const trayEnabled = isTrayProbe || !isTestRunnerMode;

// 運用者指示 (2026-07-08「テストはできれば画面に出ないで欲しい」): E2E (--e2e-real-join) 実行中は
// mainWindow/callWindow を「実ウィンドウのまま画面外座標」に開く。
//
// 最小化 (win.minimize())/show:false/オフスクリーンレンダリング (webPreferences.offscreen) は
// どれも「コンポジタが実際にフレームを描画しない」状態を作ってしまう。このワークスペースの
// E2E は配信系 (画面共有/WebRTC) の実挙動を検証するものが多く、
// registerDisplayMediaHandler() のコメントにある通り WGC (Windows Graphics Capture) ベースの
// キャプチャやエンコーダの差分検出はどれも「実際に画面へ描画され続けていること」に依存する —
// 上記のいずれかで代替すると、実際は正常に動いているのに配信系のアサーション (bytesSent の増加
// など) だけが偽 FAIL する。「実ウィンドウとして show:true のまま、画面外の座標に配置する」が
// 唯一安全な方法: DWM は通常のマルチモニタ構成と同様に画面外のウィンドウも変わらず合成し続ける
// ため、WGC/desktopCapturer/webContents.capturePage() はいずれも影響を受けない。
//
// x は大きな負値にして、マルチモニタ構成 (2 台目・3 台目のモニタがどれだけ左右に並んでいても)
// 実モニタの workArea と重ならないようにする。y は 0 以上にしておく (負の y は一部の OS の
// ウィンドウ管理 — タスクバー/スナップ挙動等 — で異常な扱いを受けることがあるため避ける)。
// dev/E2E/memory-probe 専用 -- 通常起動/smoke には一切影響しない。
const E2E_OFFSCREEN_WINDOW_POSITION = Object.freeze({ x: -4000, y: 100 });

// createMainWindow()/createCallWindow() の両方から呼ぶ、テスト実行時専用の位置指定
// BrowserWindow オプション片。対象外のモードでは空オブジェクト (= Electron の既定の中央配置)。
// memory-probe も対象 (2026-07-08 運用者指示「テストは画面に出ないで欲しい」への追随):
// memory-probe の mainWindow は歴史的に show 条件 (!isSmoke && !isCinnyShellSmoke) から漏れて
// 可視のままだった。show:false での非表示化はコンポジタ挙動が変わりメモリ計測の意味がズレるため、
// E2E と同じ「実ウィンドウのまま画面外」で揃える。
function e2eOffscreenBrowserWindowOptions() {
  // M2 トレイ常駐: tray-probe も「テストは画面に出ないで欲しい」の対象に加える。close-to-tray の
  // 実測 (win.isVisible() の遷移) は画面外配置でも変わらず検証できる (E2E/memory-probe と同じ理由)。
  if (!isE2ERealJoin && !isMemoryProbe && !isTrayProbe) return {};
  return { x: E2E_OFFSCREEN_WINDOW_POSITION.x, y: E2E_OFFSCREEN_WINDOW_POSITION.y };
}

// M1 step 3c-1: call view (EC) の main world へ dom-ready 時に注入する RTCPeerConnection
// ラッパ。実 LiveKit 接続が確立したことを、main プロセス外 (e2e スクリプト) から
// electronApp.evaluate() 経由で観測できるようにするための計装。window.RTCPeerConnection を
// Proxy で包み、生成された各インスタンスの connectionState/iceConnectionState の変化を
// window.__selfmatrixPcs (plain object の配列、構造化複製可能) に記録する。生成された
// RTCPeerConnection インスタンス自体は素の `new target(...)` の戻り値そのものなので、
// prototype チェーンは変えていない (instanceof チェックへの影響が無い)。dom-ready は
// document のロード完了時点で発火するため、EC のバンドルが実際に RTCPeerConnection を
// 生成する (LiveKit 接続開始) よりも十分前に注入が完了する。
const E2E_RTC_WRAPPER_SCRIPT = `(() => {
  if (window.__selfmatrixPcs) return;
  window.__selfmatrixPcs = [];
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (!NativeRTCPeerConnection) return;
  let nextId = 0;
  const Wrapped = new Proxy(NativeRTCPeerConnection, {
    construct(target, args) {
      const pc = new target(...args);
      const id = nextId += 1;
      const record = {
        id,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        reachedConnected: false,
        createdAt: Date.now(),
        // M1 step 3c-2 (窓移動無再接続の検証用): 生の RTCPeerConnection への参照を保持しておく。
        // getStats() を呼んで outbound-rtp (screenshare video) の bytesSent / inbound-rtp
        // (audio) の bytesReceived を往復前後で比較するために必要。structured-clone できない
        // フィールドなので、既存の window.__selfmatrixPcs.map((r) => ({...})) の明示的な
        // フィールド列挙 (native-join.e2e.mjs 側) には一切影響しない — 呼び出し側が拾わなければ
        // このフィールドは戻り値に含まれない。
        _pc: pc,
      };
      window.__selfmatrixPcs.push(record);
      const update = () => {
        record.connectionState = pc.connectionState;
        record.iceConnectionState = pc.iceConnectionState;
        if (
          record.connectionState === "connected" ||
          record.iceConnectionState === "connected" ||
          record.iceConnectionState === "completed"
        ) {
          record.reachedConnected = true;
        }
      };
      pc.addEventListener("connectionstatechange", update);
      pc.addEventListener("iceconnectionstatechange", update);
      update();
      return pc;
    },
  });
  window.RTCPeerConnection = Wrapped;
})();`;

const state = {
  origin: null,
  server: null,
  mainWindow: null,
  // M2 トレイ常駐: trayEnabled のときだけ createTray() が設定する。テスト/E2E モードでは
  // ずっと null のまま (createTray() 自体が呼ばれない、main() 参照)。
  tray: null,
  callWindow: null,
  callView: null,
  callViewState: "none",
  // M2 画面共有ソース選択 UI: ネイティブピッカーウィンドウ (source-picker.html) の現在のインスタンス。
  // cinny 用の mainWindow/callView とは完全に別系統 (別 preload、別 contextBridge 名前空間) --
  // openSourcePicker()/createSourcePickerWindow() 参照。
  sourcePickerWindow: null,
  // M1 step 3c-1: 現在アクティブな通話の widgetId (openCallView() が検証済み URL から読み取って
  // 設定する。closeCallView() でリセット)。from-view/to-view のバリデーションはこの値と照合する。
  // 未アクティブ時 (null) は NO_ACTIVE_WIDGET_ID センチネルと照合され必ず拒否される (fail-closed。
  // 3c-1 受け入れレビュー指摘: `?? WIDGET_ID` の fail-open フォールバックを廃止) — 詳細は
  // widget-bridge-protocol.cjs の validateToViewMessage() コメント参照。
  activeWidgetId: null,
  widgetMessages: [],
  // M1 step 2 (B 単体実証): native:call-control:* (invoke 要求/応答/MutationObserver state push) の
  // 全メッセージをここに記録する。widgetMessages と同じ「main は中継するだけ、判定は別関数に外出し」
  // という方針を踏襲する。
  callControlMessages: [],
  // 診断用 (call view 側 preload の読み込み時例外を記録。createCallViewIfNeeded() 参照)。
  preloadErrors: [],
  navigationEvents: [],
  // M1 step 3c-2/3c-3: openCallView() 呼び出し元 (cinny の NativeCallEmbed) が任意で渡す
  // localStorage スナップショット (matrix-setting-* 等)。call view の session partition は
  // mainWindow (cinny) と別物 (CALL_VIEW_PARTITION) なので localStorage は共有されず、web 版で
  // 成立していた「cinny が書く matrix-setting-* を EC が読む」契約がそのままでは native では
  // 壊れる (同一オリジンでも session partition が異なれば Storage は分離される)。openCallView()
  // がここへ格納し、call-control-preload.cjs が dom-ready 前 (preload 実行時) に
  // native:get-pending-localstorage-snapshot (sendSync) で読み出して EC のバンドルが評価される
  // より前に localStorage へ書き込む。
  pendingLocalStorageSnapshot: {},
  // 診断用: 上記スナップショットが実際に call view 側へ配達された記録 (evidence 用)。
  localStorageBridgeEvents: [],
  // M2 bounds sync (Fable 全体レビュー arch-major 解消): cinny の NativeCallEmbed.setPlacement()
  // (nativeBridge.ts の setCallViewBounds() 契約) から最後に届いた有効な値。null は「隠すべき」の
  // 意味 (applyCallViewBoundsFromCinny() 参照)。未受信時は undefined のまま。
  callViewBoundsFromCinny: undefined,
  // 適用履歴 (E2E/診断用、__selfmatrixE2E snapshot に載せる)。無制限に増え続けないよう
  // applyCallViewBoundsFromCinny() 側で上限を設けてトリムする。
  callViewBoundsApplyLog: [],
};

// M2 bounds sync: state.callViewBoundsApplyLog の保持上限 (evidence/メモリの肥大化防止。
// E2E のリサイズ連打でも十分な履歴が残る件数)。
const CALL_VIEW_BOUNDS_LOG_LIMIT = 200;

if (app) {
  app.on("window-all-closed", () => {
    // M2 トレイ常駐: tray-probe もここに加える。runTrayProbe() は意図的に mainWindow.close() を
    // 呼んで close-to-tray の挙動を実測する (preventDefault() が外れる変異が入ると、この close()
    // は本当にウィンドウを破棄してしまう)。ここで app.quit() してしまうと、evidence を書き出す前に
    // プロセスごと終了してしまい、変異を「検知して FAIL を記録する」ことができなくなる —
    // 他の run*() 系モードと同じく、tray-probe も自分の run 関数 (runTrayProbe()) の末尾で
    // app.exit() を明示的に呼んでライフサイクルを自己管理する。
    if (!isSmoke && !isMemoryProbe && !isCinnyShellSmoke && !isTrayProbe) app.quit();
  });
}

// selfmatrix-desktop is developed alongside sibling checkouts of cinny and
// element-call (see README "開発手順"). The default artifact locations are
// therefore resolved relative to this repository's own location
// (<repo>/../cinny/dist, <repo>/../element-call/dist), not to any
// per-machine home directory layout -- this repo is public and must not
// assume a particular developer's folder structure. Set SELFMATRIX_CINNY_DIST
// / SELFMATRIX_EC_DIST to override (absolute or relative to cwd).
function resolveArtifact(envName, relativeParts) {
  if (process.env[envName]) return path.resolve(process.env[envName]);
  return path.resolve(appRoot, "..", ...relativeParts);
}

const cinnyDist = resolveArtifact("SELFMATRIX_CINNY_DIST", ["cinny", "dist"]);
const ecDist = resolveArtifact("SELFMATRIX_EC_DIST", ["element-call", "dist"]);

// M2 homeserver 選択制 (運用者確定仕様: 自サーバーをアプリに焼き込まない。接続先はユーザーが
// 手入力する。候補として提示するのは matrix.org のみ):
//
// cinny dist に含まれる config.json (`cinnyDist/config.json`、cinny リポジトリ直下の
// config.json からコピーされたもの) は **ローカル dev 専用**の設定であり、
// homeserverList が synapse.m.localhost/synapse.othersite.m.localhost (このワークスペースの
// ローカル Matrix スタックのドメイン) を指し、hideExplore:true も付いている。この dev config を
// 製品起動でそのまま配信すると、(a) 存在しない自サーバードメインが製品ホームサーバー選択肢に
// 残ってしまう、(b) Explore タブが既定で隠れてしまう — どちらも製品要件に反する。
// 一方 E2E (--e2e-real-join、e2e/native-join.e2e.mjs 等) は実際に
// https://synapse.m.localhost へログインする検証であり、この dev config が無いと成立しない。
//
// そのためこのリポジトリは cinny/dist の config.json 自体には一切手を触れず (dev 専用設定は
// cinny 側の管轄)、代わりに「配信するファイルを選ぶ」層をここに用意する。実際の切り替えは
// startServer() の /config.json ルートが resolveCinnyConfigPath() を呼んで行う。
//
// resources/cinny-config.production.json (このリポジトリ内、新規) が製品 config の実体:
// homeserverList は matrix.org のみ (自サーバードメインは一切含まない)、
// allowCustomHomeservers:true でユーザーが任意のサーバー URL を手入力できる。cinny の
// ClientConfig 型 (cinny/src/app/hooks/useClientConfig.ts) 準拠。hideExplore は付けない
// (cinny の既定=表示のまま)。
const PRODUCTION_CINNY_CONFIG_PATH = path.join(appRoot, "resources", "cinny-config.production.json");
const DEV_CINNY_CONFIG_PATH = path.join(cinnyDist, "config.json");

// E2E (--e2e-real-join) のときだけ従来どおり dev config (synapse 向け) を返す。
// それ以外の全モード (フラグ無しの通常起動、--cinny-shell、--cinny-shell-smoke、
// --harness/--smoke/--memory-probe 等) は製品 config を返す — harness 系モードは実際には
// cinny 本体をロードしないため config.json が要求されることは無いが、万一要求されても
// dev config (自サーバードメイン入り) を漏らさないよう安全側の製品 config を既定にする。
function resolveCinnyConfigPath() {
  return isE2ERealJoin ? DEV_CINNY_CONFIG_PATH : PRODUCTION_CINNY_CONFIG_PATH;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg") return "audio/ogg";
  // M1 step 3c-1: cinny (matrix-js-sdk の rust crypto) は起動時に .wasm を
  // WebAssembly.compileStreaming()/instantiateStreaming() で読み込む。これは Content-Type が
  // 厳密に "application/wasm" であることを要求し (それ以外だと
  // "Incorrect response MIME type. Expected 'application/wasm'." で失敗する)、この判定漏れが
  // 無いと cinny はログイン後ずっと「起動中です」のまま進行しなくなる (実測)。
  if (ext === ".wasm") return "application/wasm";
  return "application/octet-stream";
}

function resolveStatic(root, subpath, fallbackIndex = false) {
  const clean = subpath.replace(/^\/+/, "");
  let filePath = path.resolve(root, clean || "index.html");
  const rootResolved = path.resolve(root);
  if (!isInsidePath(rootResolved, filePath)) return null;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath) && fallbackIndex) {
    filePath = path.join(rootResolved, "index.html");
  }
  if (!isInsidePath(rootResolved, filePath) || !fs.existsSync(filePath)) return null;
  return filePath;
}

function isInsidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function serveFile(response, filePath) {
  response.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    // M1 step 3c-1 (実測で発覚した修正): cinny の React Router は build.config.ts の
    // base:'/' により basename="/" で組み立てられており、「オリジンのルートを cinny 自身が
    // 占有する」ことを前提にした相対パスでルーティングする。以前は --cinny-shell モードでも
    // mainWindow を `${origin}/cinny/` へロードしていたため、cinny のルータは実際の pathname
    // (例: `/cinny/lobby`) をそのまま解釈し、"cinny" を `:spaceIdOrAlias` パラメータとして
    // 誤マッチさせ、存在しない space の lobby ルートに迷い込んでいた (実機テストで実測)。
    // ルート ("/") はモード次第で出し分ける: --cinny-shell (-smoke) は cinny の index.html を
    // 直接ルートで配信し (isCinnyShell)、それ以外 (既定/--smoke/--memory-probe) は従来どおり
    // harness (desktop-shell.html) を配信する。`/desktop-shell.html` という明示パスは
    // モードによらず常に harness を指す (cinny 埋め込みモードの iframe が参照するため)。
    if (url.pathname === "/") {
      if (isCinnyShell) {
        serveFile(response, path.join(cinnyDist, "index.html"));
      } else {
        serveFile(response, path.join(__dirname, "desktop-shell.html"));
      }
      return;
    }
    if (url.pathname === "/desktop-shell.html") {
      serveFile(response, path.join(__dirname, "desktop-shell.html"));
      return;
    }
    if (url.pathname === "/desktop-shell.js") {
      serveFile(response, path.join(__dirname, "desktop-shell.js"));
      return;
    }
    if (url.pathname === "/shell-widget-host.js") {
      serveFile(response, path.join(__dirname, "shell-widget-host.js"));
      return;
    }
    if (url.pathname === "/vendor/matrix-widget-api.js") {
      // このリポジトリに pinned dependency として追加した matrix-widget-api の browserify 済み
      // UMD バンドル (window.mxwidgets を公開)。shell-widget-host.js の冒頭コメント参照:
      // ClientWidgetApi をページの通常スクリプトコンテキストで動かすため <script> で読み込む。
      serveFile(response, path.join(appRoot, "node_modules", "matrix-widget-api", "dist", "api.js"));
      return;
    }
    if (url.pathname === "/widget-config.json") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          widgetId: WIDGET_ID,
          roomId: WIDGET_ROOM_ID,
          userId: WIDGET_USER_ID,
          deviceId: WIDGET_DEVICE_ID,
          baseUrl: WIDGET_BASE_URL,
        }),
      );
      return;
    }
    if (url.pathname === "/health.json") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, cinnyDist, ecDist }));
      return;
    }

    // M2 homeserver 選択制 (PRODUCTION_CINNY_CONFIG_PATH 定義箇所のコメント参照): cinny
    // (build.config.ts の base:'/') は config.json を常にオリジンルート相対 ("/config.json"、
    // ClientConfigLoader.tsx の `${BASE_URL}/config.json`) で fetch するため、--cinny-shell
    // (cinny がトップフレームでルートを占有する、本番同様のトポロジ) で実際に踏まれるのは
    // このルートのみ。/cinny/config.json (harness の /cinny/ iframe embed 経路向け。現状
    // desktop-shell.js は実際には cinny をロードしないため到達しないが、将来 harness が本物の
    // cinny を埋め込むよう変わっても dev config を漏らさないための保険) にも同じ切り替えを
    // 適用しておく。cinny/dist の config.json ファイル自体はここでも書き換えない
    // (resolveCinnyConfigPath() が読むだけ)。
    if (url.pathname === "/config.json" || url.pathname === "/cinny/config.json") {
      const configPath = resolveCinnyConfigPath();
      if (fs.existsSync(configPath)) return serveFile(response, configPath);
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (url.pathname.startsWith("/cinny/")) {
      const filePath = resolveStatic(cinnyDist, url.pathname.slice("/cinny/".length), true);
      if (filePath) return serveFile(response, filePath);
    }
    if (url.pathname.startsWith("/ec/")) {
      const filePath = resolveStatic(ecDist, url.pathname.slice("/ec/".length), true);
      if (filePath) return serveFile(response, filePath);
    }
    // M1 step 3b 実装要件 4: cinny の CallEmbed.ts/NativeCallEmbed.ts は無改造では
    // `<origin>/public/element-call/index.html` (web 版と同じ base) で完成 URL を組み立てる。
    // シェルの静的サーバにこのエイリアス route を追加し、EC dist をそこでも配信することで
    // cinny 側コードを一切変更せずに URL がそのまま解決するようにする。openCallView() の URL
    // 検証 (widget-bridge-protocol.cjs の EC_BASE_PATHS) にもこの prefix を含めてある。
    if (url.pathname.startsWith("/public/element-call/")) {
      const filePath = resolveStatic(ecDist, url.pathname.slice("/public/element-call/".length), true);
      if (filePath) return serveFile(response, filePath);
    }
    // EC の base path (上の 2 ブロック) はここまでに一致すれば必ず return 済み。ファイルが
    // 見つからなかった場合 (壊れた/未知の /ec/, /public/element-call/ パス) も、下の cinny
    // ルートフォールバックへ絶対にフォールスルーさせない (シャドーイング防止、実装要件参照)。
    if (url.pathname.startsWith("/ec/") || url.pathname.startsWith("/public/element-call/")) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    // M1 step 3c-1: cinny の dist/index.html (build.config.ts の base:'/' 設定) は
    // /assets/*.js, /config.json, /sw.js, /public/locales/*.json 等をサイトルート相対の絶対
    // パスで参照する。--cinny-shell モードは上で "/" 自体を cinny の index.html にしたので
    // これらのリクエストは実質そのまま cinny 向けだが、harness モード (cinny を /cinny/ 配下の
    // iframe として埋め込む、既定/--smoke/--memory-probe) では harness 自身が "/" を占有して
    // いるため、この 2 番目のフォールバックが無いと同じ 404 が起きる (トップフレームモードで
    // 実際にログイン画面等を操作するには解決が必須だった — バックエンド無しの smoke/
    // cinny-shell-smoke は window.selfmatrixNative の存在と URL 文字列しか見ないため、このバグは
    // 今まで顕在化していなかった)。既知の他ルート (/, /desktop-shell.*, /vendor/...,
    // /widget-config.json, /health.json, /cinny/*, /ec/*, /public/element-call/*) は上で先に
    // 判定済みなので、ここに到達するのはそのどれでもないパスのみ — cinny dist をルート相対でも
    // フォールバック配信する (SPA の index.html フォールバックはしない: 本当に存在しないパスは
    // 404 のままにする)。
    const cinnyRootFile = resolveStatic(cinnyDist, url.pathname, false);
    if (cinnyRootFile) return serveFile(response, cinnyRootFile);

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      state.origin = `http://127.0.0.1:${address.port}`;
      state.server = server;
      resolve(server);
    });
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    title: "SelfMatrix",
    width: 1400,
    height: 860,
    show: !isSmoke && !isCinnyShellSmoke,
    // E2E (--e2e-real-join) 専用: 画面外座標に開く (E2E_OFFSCREEN_WINDOW_POSITION のコメント参照)。
    // isE2ERealJoin でなければ e2eOffscreenBrowserWindowOptions() は {} を返すので無影響。
    ...e2eOffscreenBrowserWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      // M2 セキュリティ監査 (「shell の API 露出面整理」、sandbox 再評価): 以前は sandbox:false
      // だった。harness トポロジでは shell-widget-host.js が本物の ClientWidgetApi をこの
      // フレームの通常ページスクリプトとして構築する都合があったが、これは preload の Node 権限
      // (nodeIntegration/sandbox) とは無関係 — <script> で読み込まれるページスクリプトは
      // nodeIntegration:false の時点で常に Node 非統合であり、sandbox はあくまで preload 自身が
      // 使える Node API の範囲と OS レベルのプロセスサンドボックスを絞るだけで、ページ側の
      // DOM/JS 実行には影響しない。実際、call view (createCallViewIfNeeded() 参照) の
      // widget-bridge-preload.cjs/call-control-preload.cjs はどちらも sandbox:true 下で
      // require("electron") のみを使って動作済み (call-control-preload.cjs 冒頭コメント参照)。
      // shell-preload.cjs も require("electron") 以外は使わないため、sandbox:true でも
      // contextBridge.exposeInMainWorld()/ipcRenderer は変わらず動く。本番 topology
      // (--cinny-shell、cinny がトップフレーム) で mainWindow の Node 権限面を追加で絞れる
      // 実利があるため sandbox:true 化した。smoke (harness 前提)・cinny-shell-smoke の両方が
      // green のままであることを確認済み (完了報告の検証出力参照)。
      sandbox: true,
      // M2 セキュリティ監査 (契約外 API の露出面整理): shell-preload.cjs へ「このウィンドウが
      // 本番 topology (cinny トップフレーム) なのか harness トポロジなのか」を伝える唯一の経路。
      // preload は contextIsolation 下でも Node 権限を保つため process.argv を読めるが、main
      // プロセス自身の process.argv (Electron 起動時のコマンドライン全体、--smoke 等を含む) を
      // そのままレンダラ側 process.argv として引き継ぐ保証は無い (Electron の内部実装詳細に
      // 依存させたくない) — 代わりに additionalArguments で明示的に 1 個だけフラグを渡す。
      additionalArguments: [`--selfmatrix-shell-topology=${isCinnyShell ? "cinny-shell" : "harness"}`],
      // Chromium は非表示/最小化/occluded 判定したウィンドウの timer/requestAnimationFrame を
      // 間引く (Electron の既定は間引く=true)。この画面外配置 (E2E) や将来のユーザーによる最小化/
      // タブ切り替え中でも、通話中の keep-alive 描画や WebRTC 関連タイマーは止めたくないため、
      // E2E 限定にせず常時無効化しておく (害としては非表示時の消費電力がわずかに増える程度で、
      // 通話アプリとしては妥当なトレードオフ)。
      backgroundThrottling: false,
    },
  });
  // M1 step 3b 実装要件 5: --cinny-shell (/--cinny-shell-smoke) はトップフレームモード —
  // mainWindow が harness (desktop-shell.html + cinny iframe) ではなく cinny 本体を直接
  // トップフレームでロードする、本番同様の topology。既定/--smoke/--memory-probe は
  // 従来どおり desktop-shell.html (harness) を維持する。preload (shell-preload.cjs) は
  // どちらのモードでも同一 — window.selfmatrixNative は常にこの preload が公開する
  // (ただし M2 セキュリティ監査以降、公開されるメソッドの集合は additionalArguments で渡した
  // トポロジによって変わる。shell-preload.cjs 冒頭のコメント参照)。
  //
  // M1 step 3c-1 (実機テストで発覚、修正): 以前はここで `${origin}/cinny/` (パスプレフィックス
  // 付き) をロードしていたが、cinny の React Router は basename="/" (build.config.ts の
  // base:'/') で組み立てられており「自分がオリジンのルートを占有している」ことを前提にルーティング
  // する。プレフィックス付きでロードすると、cinny のルータは実際の pathname (例: `/cinny/lobby`)
  // をそのまま解釈してしまい、"cinny" を `:spaceIdOrAlias` パラメータとして誤マッチさせ、
  // 存在しない space の lobby ルートに迷い込む (実機ログインで実際に再現/特定した)。
  // --cinny-shell モードではオリジンのルート ("/") 自体を cinny の index.html として配信する
  // よう startServer() 側も変更したので、ここも合わせてルートをロードする。
  win.loadURL(isCinnyShell ? `${state.origin}/` : `${state.origin}/desktop-shell.html`);
  state.mainWindow = win;
  win.on("resize", updateCallViewBounds);

  // M2 トレイ常駐 (運用者確定仕様: 閉じるボタン = トレイに最小化、終了はトレイメニューから):
  // trayEnabled (本番起動、または --tray-probe) のときだけ close イベントを横取りする。
  // app.isQuitting (トレイメニュー「終了」= quitFromTray() が立てる) が既に true のときだけ
  // 本当に閉じさせ、それ以外は preventDefault() してウィンドウを隠すだけに留める。
  // window-all-closed 側 (上の app.on("window-all-closed", ...) 参照、isTrayProbe を含む各
  // テスト/probe モードでしか app.quit() しない) と対で、トレイ常駐中はウィンドウが 0 枚でも
  // プロセスが生存し続ける。テスト/E2E モード (trayEnabled===false) ではこのリスナー自体を
  // 登録しないため、close は従来どおり普通にウィンドウを破棄する。
  if (trayEnabled) {
    win.on("close", (event) => {
      if (app.isQuitting) return;
      event.preventDefault();
      win.hide();
    });
  }

  // C3 (Fable レビュー #2, セキュリティ修正): mainWindow は cinny (または harness) をホストし、
  // 強力な window.selfmatrixNative bridge (shell-preload.cjs) を持つ。call view には G7
  // (createCallViewIfNeeded() 参照) でナビゲーション封じ込めを付けていたが、mainWindow には
  // 何も無かった — トップレベル遷移が起きると同じ preload が別オリジンのページに対しても
  // 再注入され、bridge がそちらでも再露出し得る。
  // cinny は SPA (React Router、pushState/hash によるルーティング) であり、Electron の仕様上
  // "will-navigate"/"will-redirect" は in-page navigation では発火しない (ユーザー操作/ページ自身の
  // window.location 変更/リンククリック/サーバリダイレクトなどのトップレベル遷移でのみ発火する) —
  // そのため以下の制限は cinny の通常のルーティング動作を妨げない。
  //
  // B (M2 readiness レビュー修正、GPT 指摘 B): 上の C3 修正は same-origin かどうかしか見ておらず
  // 広すぎた。startServer() は同一 origin で cinny 自身の他に /ec/・/public/element-call/ (EC dist)・
  // /desktop-shell.html (harness)・/vendor/ (matrix-widget-api バンドル) も配信しており、mainWindow が
  // これらへトップレベル document 遷移すると、mainWindow が持つ shell-preload.cjs の bridge が
  // (same-origin なので) そのまま意図しないページ上に再注入されてしまう。cinny 自身の React Router は
  // オリジン配下の任意のパス (個々の room/space パス等) を使い得るため、cinny の path を厳密な
  // allow-list にはできない — 代わりに「cinny の document ではないと分かっている既知の配信先」だけを
  // block する block-list にし、過剰に締めて cinny 自身の初回ロードや通常のルーティングを壊さない
  // ようにした。/ec/・/public/element-call/・/vendor/ はトポロジ (production/harness) に関わらず常に
  // 「cinny の document ではない」ため常時 block する。/desktop-shell.html だけは harness トポロジ
  // (isCinnyShell === false) では mainWindow 自身の正当な document (この関数の win.loadURL() 参照) な
  // ので、その場合に限り許可する。
  const NON_CINNY_DOCUMENT_PATH_PREFIXES = Object.freeze(["/ec/", "/public/element-call/", "/vendor/"]);
  const isAllowedMainWindowDocumentNavigation = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return false;
    }
    if (parsed.origin !== state.origin) return false;
    if (NON_CINNY_DOCUMENT_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) return false;
    if (parsed.pathname === "/desktop-shell.html") return !isCinnyShell;
    return true;
  };
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedMainWindowDocumentNavigation(url)) {
      event.preventDefault();
      state.widgetMessages.push({ t: Date.now(), type: "main-window-navigation-blocked", url, via: "will-navigate" });
    }
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedMainWindowDocumentNavigation(url)) {
      event.preventDefault();
      state.widgetMessages.push({ t: Date.now(), type: "main-window-navigation-blocked", url, via: "will-redirect" });
    }
  });
  // http(s) の外部リンク (メッセージ内リンク等) はシステムの既定ブラウザへ逃がし、Electron 側では
  // 新規ウィンドウを常に deny する (bridge を持つ無防備な新規 BrowserWindow を生成させないため)。
  // それ以外のスキーム (javascript: 等) は何もせず deny のみ。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  return win;
}

function createCallWindow() {
  const win = new BrowserWindow({
    title: "SelfMatrix Call",
    width: 960,
    height: 640,
    show: !isSmoke,
    // E2E (--e2e-real-join) 専用: mainWindow と同じ理由で画面外座標に開く (detach/popout 検証
    // (windowMoveReparenting) 中もこの別窓が画面内に現れないようにするため)。
    ...e2eOffscreenBrowserWindowOptions(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // createMainWindow() と同じ理由 (上のコメント参照) で常時無効化する。
      backgroundThrottling: false,
    },
  });
  win.on("resize", updateCallViewBounds);
  win.on("closed", () => {
    state.callWindow = null;
    if (state.callView) attachCallView();
  });
  state.callWindow = win;
  return win;
}

// M2 トレイ常駐 (Discord 風: 閉じるボタン = トレイに最小化、終了はトレイメニューから、右クリックで
// メニュー)。この一群はトレイ本体・アイコン・メニュー・クリック挙動を扱う。有効化は trayEnabled
// (本番起動、または --tray-probe) のときだけ -- main() の呼び出し箇所参照。

// ブランドアイコンは UI/デザイン工程 (後で GPT/人) が用意する想定の**差し替え前提プレースホルダ**。
// PNG ファイルを新規に追加する代わりに nativeImage.createFromBitmap() で生ビットマップ (BGRA、
// ヘッダ/メタデータなし) を直接組み立てる — ファイル資産にすると出自や埋め込みメタデータ (Exif 等)
// の心配が生じるが、この方式はメタデータという概念自体が存在しないため個人情報混入の余地が無い。
// 16x16 の単色円 (自作の簡易図形、他所の素材の流用ではない)。alpha は 0 か 255 のみを使うため、
// premultiplied/straight どちらの解釈でも見え方が変わらない。
function createPlaceholderTrayIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 1;
  // BGRA の各バイト (nativeImage.createFromBitmap() が要求するネイティブ内部フォーマット)。
  // 色そのものに意味は無い — 最終的なブランドアイコンで必ず差し替わる想定のプレースホルダ。
  const blue = 0xc8;
  const green = 0x6a;
  const red = 0x5a;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const inside = dx * dx + dy * dy <= radius * radius;
      const offset = (y * size + x) * 4;
      buffer[offset] = blue;
      buffer[offset + 1] = green;
      buffer[offset + 2] = red;
      buffer[offset + 3] = inside ? 0xff : 0x00;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

// トレイの左クリック/ダブルクリック挙動 (Discord 準拠: クリックでウィンドウを前面化するだけ、
// トグルにはしない — トグルだと「クリックしたら隠れた」という事故が起きやすいため)。
// tray.on("click"/"double-click", ...) と runTrayProbe() の両方から同じ関数参照を呼べるよう、
// named function として切り出してある (「tray の click ハンドラを直接呼ぶ」検証に使う)。
function handleTrayActivate() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// トレイメニュー「終了」の実体。close-to-tray (createMainWindow() の close ハンドラ) は
// app.isQuitting が立っていない限り preventDefault() + hide() するだけなので、本当に終了する
// ときはここで先にフラグを立ててから app.quit() する。
function quitFromTray() {
  app.isQuitting = true;
  app.quit();
}

// トレイの右クリックメニュー定義。「将来ミュート制御等を足せる構造にしておく」という要件どおり、
// 項目は配列で持つ (増やす場合はこの配列に追記するだけでよい)。状態を持たない純関数として書いて
// あるので、createTray() が実際にトレイへ設定するのと runTrayProbe() が検証用に取得するのとで
// 常に同じ定義になる。
function trayMenuTemplate() {
  return [
    { label: "SelfMatrix を開く", click: () => handleTrayActivate() },
    { type: "separator" },
    { label: "終了", click: () => quitFromTray() },
  ];
}

function createTray() {
  const tray = new Tray(createPlaceholderTrayIcon());
  tray.setToolTip("SelfMatrix");
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.on("click", handleTrayActivate);
  // Windows は 1 回のクリックで "click"、素早い連続クリックで追加の "double-click" も発火する。
  // どちらも同じ「前面化するだけ」の挙動にする (Discord と同様)。
  tray.on("double-click", handleTrayActivate);
  state.tray = tray;
  return tray;
}

// M1 step 3b: harness/smoke 用の既定 widget パラメータで完成 URL を組み立てる汎用ヘルパー。
// URL 組み立てと assertSameOrigin 呼び出しは buildWidgetUrl() 内にある。ここはその薄い委譲。
// `overrides.ecPath`/`overrides.parentPath` で EC dist の base path / parentUrl の path を
// 差し替えられる (既定は従来どおり "/ec/index.html" / "/desktop-shell.html")。
// cinny-shell smoke (runCinnyShellSmoke()) はここへ ecPath: "/public/element-call/index.html",
// parentPath: "/cinny/" を渡し、「cinny が実際に組み立てる URL」形状 (エイリアス route 経由) を
// 再現した「正当な URL」テストケースを作る。
function buildLocalCallUrl(overrides = {}) {
  return buildWidgetUrl({
    callOrigin: state.origin,
    parentOrigin: state.origin,
    widgetId: WIDGET_ID,
    roomId: WIDGET_ROOM_ID,
    userId: WIDGET_USER_ID,
    deviceId: WIDGET_DEVICE_ID,
    baseUrl: WIDGET_BASE_URL,
    intent: "join_existing_voice",
    preload: "true",
    skipLobby: "true",
    disableVideo: "true",
    hideVideoButton: "true",
    theme: "dark",
    ...overrides,
  });
}

// M1 step 3b: WebContentsView 自体の生成 (URL のロードは伴わない)。detachCallView()/
// attachCallView() (シェル内部の窓移動デモ、cinny の契約には含まれない — design §2.3 の
// 「CallPopout はネイティブでは不要、M3 の再親子付けで置き換え」参照) がガードとして呼ぶ。
// 実際の EC ロードは openCallView(url) の責務に分離した (旧 ensureCallView() は生成とロードの
// 両方を一度にやっていたが、新契約では URL は呼び出し元 (cinny/harness) が渡すものであり、
// main が独自に組み立てて先読みロードしてはならない)。
function createCallViewIfNeeded() {
  if (state.callView) return;

  // M1 step 2 (B 単体実証): CallControl 相当の DOM 操作ロジック (call-control-preload.cjs) を
  // 2 本目の preload として同じ call view partition/session に登録する。webPreferences.preload
  // (widget-bridge-preload.cjs) からの require では分離できなかった理由は
  // call-control-preload.cjs 冒頭のコメント参照 (sandbox 下の preload の require() は
  // "electron" 以外を解決できないことを実測で確認した)。session.registerPreloadScript() は
  // ファイルとしての分離を保ったまま、同じフレームに追加の preload を読み込ませられる。
  // C1 (GPT レビュー P1b 修正): registerPreloadScript() は session パーティション単位で累積登録
  // されるため (CALL_VIEW_PARTITION 定数の直後のコメント参照)、この関数自体は call view を
  // 作り直すたびに再入し得る (早期 return は「同一インスタンス生存中の再入」しか防がない) —
  // モジュールレベルのフラグ (callViewPreloadRegistered) でプロセス全体を通して高々 1 回だけ実行する。
  if (!callViewPreloadRegistered) {
    callViewPreloadRegistered = true;
    callViewPreloadRegistrationCount += 1;
    session.fromPartition(CALL_VIEW_PARTITION).registerPreloadScript({
      filePath: path.join(__dirname, "call-control-preload.cjs"),
      type: "frame",
    });
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "widget-bridge-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: CALL_VIEW_PARTITION,
    },
  });
  state.callView = view;
  state.callViewState = "attached";
  view.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    state.navigationEvents.push({ t: Date.now(), url, isInPlace, isMainFrame });
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    state.widgetMessages.push({ t: Date.now(), type: "render-process-gone", details });
  });
  // 診断用: call view 側のいずれかの preload (widget-bridge-preload.cjs /
  // call-control-preload.cjs) が読み込み時に例外を投げた場合、smoke は「対象が見つからず
  // タイムアウトし続ける」形でしか失敗が見えず原因追跡が難しい。preload-error を記録しておく。
  // G6 (受け入れレビュー修正): 以前は preloadPath (絶対パス) と error.stack (絶対パスを含み得る
  // スタックトレース) をそのまま積んでおり、evidence の deepSanitizeEvidence()/
  // sanitizeEvidenceMessage() はどちらも origin 文字列の置換しかしないため、preloadErrors は
  // サニタイズ対象外の絶対パス漏洩経路になっていた。捕捉時点で basename のみ/message のみに
  // 落としてしまうことで、そもそも絶対パスやスタックトレースを state に保持しないようにする。
  view.webContents.on("preload-error", (_event, preloadPath, error) => {
    state.preloadErrors.push({
      t: Date.now(),
      preloadPath: path.basename(preloadPath),
      error: String(error && error.message ? error.message : error),
    });
  });

  // M1 step 3c-1 (E2E 実 LiveKit join 検証専用): dom-ready のたびに RTCPeerConnection
  // 監視ラッパを main world へ注入する。dom-ready は EC のバンドルが実際に接続処理を始める
  // (ユーザー操作/自動 join を経た後) よりずっと前に発火するため、注入漏れなく先回りできる。
  if (isE2ERealJoin) {
    view.webContents.on("dom-ready", () => {
      view.webContents.executeJavaScript(E2E_RTC_WRAPPER_SCRIPT, true).catch((error) => {
        state.widgetMessages.push({
          t: Date.now(),
          type: "e2e-rtc-wrapper-inject-error",
          error: String(error && error.message ? error.message : error),
        });
      });
    });
  }

  // G7 (受け入れレビュー修正): 初回ロード (openCallView() の loadURL()、同じ URL 検証を
  // 通過済み) 後の call view には、何のナビゲーション制限も無かった。`webContents.loadURL()` は
  // "will-navigate"/"will-redirect" を発火させない (Electron の仕様: これらはユーザー操作や
  // ページ自身の window.location 変更/リンククリック/サーバリダイレクトのみで発火する) ため、
  // ここでの検証は openCallView() の URL 検証と二重にはならず、「ロードされた EC コンテンツが
  // (侵害されていた場合や不具合で) 自発的に他所へ遷移しようとする」経路を塞ぐためのもの。
  // openCallView() と同じ validateCallViewUrl() を再利用し、不合格なら preventDefault() で
  // 実際のナビゲーションを止め、openCallView() と同じ type:"call-view-url-rejected" として
  // widgetMessages に記録する (runCinnyShellSmoke() 等の既存の rejection 判定と同じ形状、
  // via フィールドで発生源を区別できるようにしてある)。EC 内部の SPA 遷移 (pushState/hash) は
  // in-page navigation として will-navigate の対象外のため、既存 smoke の hardNavigationCount
  // 判定 (did-start-navigation ベース) には影響しない。
  view.webContents.on("will-navigate", (event, url) => {
    const validation = validateCallViewUrl(url, { expectedOrigin: state.origin });
    if (!validation.ok) {
      event.preventDefault();
      state.widgetMessages.push({
        t: Date.now(),
        type: "call-view-url-rejected",
        url,
        validation,
        via: "will-navigate",
      });
    }
  });
  view.webContents.on("will-redirect", (event, url) => {
    const validation = validateCallViewUrl(url, { expectedOrigin: state.origin });
    if (!validation.ok) {
      event.preventDefault();
      state.widgetMessages.push({
        t: Date.now(),
        type: "call-view-url-rejected",
        url,
        validation,
        via: "will-redirect",
      });
    }
  });
  // G7: call view から window.open()/target=_blank 等で新規ウィンドウを開かせる必要は無い
  // (design の想定する EC 埋め込みは常にこの WebContentsView 内で完結する) ため、常に deny する。
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  state.mainWindow.contentView.addChildView(view);
  updateCallViewBounds();
}

// M1 step 3b 実装要件 1/2 (design §3 step 3b): claimWidgetTransport() が返す
// openCallView(completeWidgetUrl) の main 側実装。cinny レンダラ (相対的に低信頼) が
// 組み立てた URL を無検証で loadURL しない — 同一オリジンかつ EC dist の既知 base
// (widget-bridge-protocol.cjs の EC_BASE_PATHS: "/ec/" または "/public/element-call/") 配下の
// pathname であることを検証する。不合格な場合は例外を投げて claim 済みトランスポート越しの
// Promise を reject させ、`{type:"call-view-url-rejected", url}` を widgetMessages に記録する
// (call view は絶対にロードしない)。
// M1 step 3c-2 (localStorage 契約の実機対応): `localStorageSnapshot` は任意の追加引数
// (呼び出し元 cinny の NativeCallEmbed が渡す `matrix-setting-*` 等のスナップショット、
// nativeBridge.ts の openCallView() 契約拡張)。従来どおり 1 引数 (url のみ) で呼んでも壊れない
// (省略時は空スナップショット扱い — 既存の smoke/cinny-shell-smoke/harness の呼び出し元は無改造)。
async function openCallView(url, localStorageSnapshot) {
  const validation = validateCallViewUrl(url, { expectedOrigin: state.origin });
  if (!validation.ok) {
    // 他の widgetMessages エントリ (from-view/to-view の origin フィールド等) と同じ方針で、
    // ここでは生の値のまま積む。サニタイズは evidence 書き出し時 (sanitizeEvidenceMessage()) に
    // まとめて行う — こうしておくと、ライブな state.widgetMessages を直接照合する
    // runCinnyShellSmoke() 側は「main に実際に渡された生の URL」と単純比較でき、
    // サニタイズ後の文字列同士を突き合わせる余計な結合を避けられる。
    state.widgetMessages.push({
      t: Date.now(),
      type: "call-view-url-rejected",
      url,
      validation,
    });
    throw new Error(
      `native:open-call-view: rejected URL (${validation.reasons.map((reason) => reason.code).join(", ")})`,
    );
  }

  // M1 step 3c-1: 検証済み URL から実際の widgetId を読み取り、from-view/to-view のバリデーション
  // (native:widget-from-view / native:widget-to-view の ipcMain ハンドラ) がこの通話中はこの値と
  // 照合するようにする。
  // C2 (GPT レビュー P1a + Fable レビュー #5 修正): validateCallViewUrl() が widgetId を必須化した
  // ため (widget_id_missing で reject される)、ここに到達した時点で widgetId は検証済みかつ必ず
  // 存在する。以前の `|| WIDGET_ID` は「URL に widgetId が無い (通常は起き得ない) 場合」への
  // fail-open フォールバックだったが、検証を通過した URL に対してこの分岐が発火することはあり得ず、
  // 万一検証がバイパスされた場合にも固定値へすり替えて処理を継続してしまう不要な安全網だったため
  // 削除する。
  state.activeWidgetId = new URL(url).searchParams.get("widgetId");

  // M1 step 3c-2: このロード (これから始まる loadURL) 用の localStorage スナップショットを
  // 置いておく。call-control-preload.cjs が dom-ready 前 (preload 実行時、EC バンドルの評価より
  // 必ず先) に native:get-pending-localstorage-snapshot (sendSync) で同期的に読み出す。
  // plain object 以外 (undefined 等、旧来の 1 引数呼び出し) は空スナップショット扱いにする。
  // 多重防御 (3c-2 受け入れレビュー): cinny 側 collectNativeCallLocalStorageSnapshot() も
  // matrix-setting-* に絞っているが、cinny レンダラは相対的に低信頼なので main の中継点でも
  // 同じ prefix allow-list を強制する — 契約外のキー (トークン等) が call view の localStorage に
  // 流れ込む経路をシェル単独でも塞ぐ。値は string のみ許可。
  state.pendingLocalStorageSnapshot = {};
  if (localStorageSnapshot && typeof localStorageSnapshot === "object") {
    for (const [key, value] of Object.entries(localStorageSnapshot)) {
      if (typeof key === "string" && key.startsWith("matrix-setting-") && typeof value === "string") {
        state.pendingLocalStorageSnapshot[key] = value;
      }
    }
  }

  createCallViewIfNeeded();
  await state.callView.webContents.loadURL(url);
}

// H3 (受け入れレビュー修正、major): 「共有開始時に再同期」する live localStorage 契約。
// 背景: web 版の実契約 (element-call の LocalMember.ts) は EC が **共有開始のたびに**
// Setting.getStoredValue() で localStorage を再読込する。openCallView() の第 2 引数
// (pendingLocalStorageSnapshot 経由、H6 で 1 ロード 1 回きりに強化) は「join 時点」の
// スナップショットを 1 回渡すだけなので、通話中の画質/FPS 設定変更 (screenShareSettings.ts)
// は反映されないままだった。この関数は cinny の NativeCallControl.toggleScreenshare() が
// クリック直前 (transport.callControlInvoke() より前) に呼ぶ transport.updateCallLocalStorage()
// の main 側実体で、現在アクティブな call view へ直接スナップショットを送り届ける —
// pendingLocalStorageSnapshot / state.pendingLocalStorageSnapshot には一切触れない独立経路
// (H6 のコメント参照。pending 経路は「preload 実行時に一度だけ sendSync で取りに行く」プル型、
// この live 経路は「main が能動的に push する」プッシュ型で、混同しないよう完全に分離してある)。
// 多重防御 (openCallView() と同じ方針): cinny 側 collectNativeCallLocalStorageSnapshot() も
// matrix-setting-* に絞っているが、cinny レンダラは相対的に低信頼なので main の中継点でも
// 同じ prefix allow-list を強制する。
function updateCallLocalStorage(snapshot) {
  if (!state.callView || state.callView.webContents.isDestroyed()) {
    return { ok: false, reason: "no_call_view" };
  }
  const filtered = {};
  if (snapshot && typeof snapshot === "object") {
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof key === "string" && key.startsWith("matrix-setting-") && typeof value === "string") {
        filtered[key] = value;
      }
    }
  }
  state.callView.webContents.send("native:prime-localstorage", filtered);
  return { ok: true, keys: Object.keys(filtered) };
}

// M1 step 3b 新設: 通話 View を閉じる (NativeCallEmbed の dispose/hangup 時に呼ばれる想定、
// nativeBridge.ts の closeCallView() 契約)。次回 openCallView() が呼ばれれば
// createCallViewIfNeeded() が新しい WebContentsView を作り直す。
async function closeCallView() {
  if (!state.callView) return;
  const owner = state.callViewState === "detached" ? state.callWindow : state.mainWindow;
  if (owner && !owner.isDestroyed()) {
    try {
      owner.contentView.removeChildView(state.callView);
    } catch (error) {
      state.widgetMessages.push({ t: Date.now(), type: "close-call-view-detach-error", error: String(error) });
    }
  }
  if (!state.callView.webContents.isDestroyed()) {
    state.callView.webContents.close();
  }
  state.callView = null;
  state.callViewState = "none";
  state.activeWidgetId = null;
}

function updateCallViewBounds() {
  if (!state.callView) return;
  // M2 bounds sync (Fable 全体レビュー arch-major 解消、タスクの発端となった指摘そのもの):
  // --cinny-shell モードは mainWindow が cinny 本体を直接トップフレームでロードする本番同様の
  // topology (createMainWindow() の isCinnyShell 分岐) であり、cinny 実 UI の実レイアウト座標
  // だけが「実際に call view を表示すべき領域」を知っている。この関数の下のハーネス固定式
  // (x=max(380,width*0.52) 等) は desktop-shell.html (ハーネス、既定/--smoke/--memory-probe) 向けの
  // 近似値に過ぎず、cinny-shell モードでこれを使うと実際の cinny レイアウト (サイドバー幅・チャット
  // 開閉等) とズレる。cinny-shell モードでは何もしない — 実適用は
  // applyCallViewBoundsFromCinny() ("native:set-call-view-bounds" ハンドラ) 経由の cinny からの
  // push だけが担う (win.on("resize", updateCallViewBounds) からの呼び出しも含め、この関数の
  // 他の呼び出し元はすべて素通りする)。ハーネスモード (--smoke 等) は影響を受けず従来どおり。
  if (isCinnyShell) return;

  const owner = state.callViewState === "detached" ? state.callWindow : state.mainWindow;
  if (!owner || owner.isDestroyed()) return;
  const [width, height] = owner.getContentSize();
  if (state.callViewState === "detached") {
    state.callView.setBounds({ x: 0, y: 0, width, height });
  } else {
    const x = Math.max(380, Math.floor(width * 0.52));
    state.callView.setBounds({ x, y: 118, width: Math.max(360, width - x - 18), height: Math.max(260, height - 136) });
  }
}

// M2 bounds sync: plain object かどうか (配列/null を除く) の判定。
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// M2 bounds sync: cinny (レンダラ、相対的に低信頼) から届く bounds の入力検証。
// plain object / 有限数値 / 非負サイズ、null は許容 (「隠す」の意味、nativeBridge.ts の
// setCallViewBounds() 契約参照)。不正な値は無視して安全側に倒す (main プロセスを落とさない)。
function validateCallViewBounds(rawBounds) {
  if (rawBounds === null) return { ok: true, bounds: null };
  if (!isPlainObject(rawBounds)) return { ok: false, reason: "not-a-plain-object" };
  const { x, y, width, height } = rawBounds;
  const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return { ok: false, reason: "non-finite-number" };
  }
  if (width < 0 || height < 0) return { ok: false, reason: "negative-size" };
  return { ok: true, bounds: { x, y, width, height } };
}

function boundsEqual(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function pushCallViewBoundsLog(entry) {
  state.callViewBoundsApplyLog.push(entry);
  if (state.callViewBoundsApplyLog.length > CALL_VIEW_BOUNDS_LOG_LIMIT) {
    state.callViewBoundsApplyLog.splice(0, state.callViewBoundsApplyLog.length - CALL_VIEW_BOUNDS_LOG_LIMIT);
  }
}

// M2 bounds sync (Fable 全体レビュー arch-major 解消): claim 済みトランスポートの
// setCallViewBounds() (nativeBridge.ts 契約) の main 側実体。cinny の
// NativeCallEmbed.setPlacement() が useCallEmbedPlacementSync 経由で push してくる実レイアウト
// 座標を、実際の WebContentsView (state.callView) へ適用する。
//
// 適用条件 (タスク要件どおり): state.callViewState === "attached" のときだけ実際に
// setBounds()/setVisible() を呼ぶ。detached (別窓 popout) 中は無視する -- 別窓のレイアウトは
// callWindow 側の責務 (M3 スコープ、nativeBridge.ts の setCallViewBounds() 契約コメント参照)。
// null 受信時は setVisible(false) で隠す (setBounds(0 サイズ) ではなく明示的な可視性 API を使う --
// Electron の View.setBounds() のドキュメント上の注意 (「border の cutout 部分はクリックを奪う」)
// を踏まえ、0 サイズでも境界の扱いが実装依存になりうる可視性の抜け穴を避けるため)。
//
// 過剰送信の抑制は主に送信元 (cinny の NativeCallEmbed.setPlacement()、同値スキップ +
// requestAnimationFrame まとめ) が担うが、ここでも実際の View.getBounds() (state 変数ではなく
// Electron 自身が保持する実値) と比較し、同値なら setBounds() 自体を呼ばない防御を二重に持たせる
// (View.setBounds() は同じ値を渡しても内部で再レイアウト/repaint が走り得るため、送信元側の
// 抑制をすり抜けた場合の保険)。
function applyCallViewBoundsFromCinny(rawBounds) {
  const validation = validateCallViewBounds(rawBounds);
  const entry = { t: Date.now(), received: rawBounds };

  if (!validation.ok) {
    entry.applied = false;
    entry.reason = validation.reason;
    pushCallViewBoundsLog(entry);
    return;
  }

  state.callViewBoundsFromCinny = validation.bounds;

  if (state.callViewState !== "attached" || !state.callView) {
    entry.applied = false;
    entry.reason = state.callViewState !== "attached" ? "not-attached" : "no-call-view";
    pushCallViewBoundsLog(entry);
    return;
  }

  if (validation.bounds === null) {
    state.callView.setVisible(false);
    entry.applied = true;
    entry.action = "hide";
    pushCallViewBoundsLog(entry);
    return;
  }

  if (!state.callView.getVisible()) {
    state.callView.setVisible(true);
  }

  const current = state.callView.getBounds();
  if (boundsEqual(current, validation.bounds)) {
    entry.applied = false;
    entry.reason = "same-as-current-shell-side-dedup";
    pushCallViewBoundsLog(entry);
    return;
  }

  state.callView.setBounds(validation.bounds);
  entry.applied = true;
  entry.action = "setBounds";
  pushCallViewBoundsLog(entry);
}

async function detachCallView() {
  createCallViewIfNeeded();
  if (!state.callWindow) createCallWindow();
  if (state.callViewState !== "detached") {
    state.mainWindow.contentView.removeChildView(state.callView);
    state.callWindow.contentView.addChildView(state.callView);
    state.callViewState = "detached";
    updateCallViewBounds();
  }
}

async function attachCallView() {
  createCallViewIfNeeded();
  if (state.callViewState !== "attached") {
    state.callWindow?.contentView.removeChildView(state.callView);
    state.mainWindow.contentView.addChildView(state.callView);
    state.callViewState = "attached";
    updateCallViewBounds();
  }
}

// H1 (受け入れレビュー修正、major): detachCallView()/attachCallView() が「実際に窓を移動させた」
// ことの積極的証拠。state.callViewState は本関数がここまでで書き換えるただの文字列であり、万一
// removeChildView()/addChildView() の呼び出し自体を no-op 化する回帰 (state だけ書き換えて実体は
// 動かさない類) が入っても、state.callViewState を読むだけの判定では検知できない。この関数は
// state を一切見ず、実際の contentView 階層 (mainWindow.contentView.children /
// callWindow.contentView.children に state.callView が実際に含まれているか) から逆算して
// "main" | "window" | "none" を返す。E2E (native-callflow.e2e.mjs の runWindowMoveReparenting())
// はこれを detach 後に "window"、attach 後に "main" になることの実測に使う。
function computeCallViewAttachedTo() {
  if (!state.callView) return "none";
  const inMain = Boolean(
    state.mainWindow &&
      !state.mainWindow.isDestroyed() &&
      state.mainWindow.contentView.children.includes(state.callView),
  );
  const inWindow = Boolean(
    state.callWindow &&
      !state.callWindow.isDestroyed() &&
      state.callWindow.contentView.children.includes(state.callView),
  );
  // 正常な detachCallView()/attachCallView() では常にどちらか片方だけが true になるはず。
  // 両方 true (二重添付) / 両方 false (どこにも無い) はどちらも異常な中間状態なので "none" に
  // 丸める -- E2E 側の "window"/"main" 期待値とは一致せず、確実に不合格として検知される。
  if (inMain && !inWindow) return "main";
  if (inWindow && !inMain) return "window";
  return "none";
}

// M1 step 3b: shell/harness/smoke が「call view が (createCallViewIfNeeded()/openCallView() を
// 経て) attached 状態になる」のを待つための共通ヘルパー。新契約では EC の読み込みは呼び出し元
// (cinny の NativeCallEmbed、または harness の shell-widget-host.js) が
// `new ClientWidgetApi(...)` 直後に自発的に openCallView() を呼ぶことで起きる (design §3 step 3b
// 実装要件 2)。main 側の smoke/memory-probe はもう自分で ensureCallView() を能動的に呼ばず、
// この自発的な呼び出しが実際に起きるのを待つだけにする — これは「シェルは薄いルータで、
// 通話 View を開く判断はレンダラ側が握る」という新契約をより忠実に検証することになる。
async function waitForCallViewAttached(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (state.callViewState === "attached" && state.callView) return true;
    await wait(100);
  }
  return false;
}

// runSmoke() が main プロセス内から shell 側の本物の ClientWidgetApi へ toWidget カスタム
// action (io.element.join 等) を送らせるための薄いヘルパー。main 自身はもう Widget API リクエスト
// を組み立てない — page-context の window.selfmatrixWidgetHost.sendAction() (実体は
// clientWidgetApi.transport.send()) を executeJavaScript 経由で叩くだけ。EC には実 LiveKit
// バックエンドが無いため応答が返らない可能性があり、そのため await はせず (.catch で握り潰す)
// 「送信できたか」だけを見る。既存 M0 smoke の sawJoinRequest と同じ役割。
function sendWidgetActionFromShell(action, data) {
  const payload = JSON.stringify(data || {});
  return state.mainWindow.webContents.executeJavaScript(
    `window.selfmatrixWidgetHost.sendAction(${JSON.stringify(action)}, ${payload}).catch(() => {})`,
    true,
  );
}

// M1 step 2 (B 単体実証): runSmoke() が shell 側の window.selfmatrixWidgetHost.callControlToggle()
// を executeJavaScript 経由で叩く薄いヘルパー。sendWidgetActionFromShell() と同じパターン:
// main 自身は RPC の中身を組み立てない。
// F7 (受け入れレビュー修正): 以前は window.selfmatrixNative.callControlInvoke(action) を常時公開の
// selfmatrixNative から直接叩いていたが、これは claimWidgetTransport() が塞いだはずの「同一オリジン
// iframe (cinny 埋め込み) から window.parent 経由で送信 API に触れられる」経路をこの新チャンネルで
// 再発させていた。callControlInvoke は claimWidgetTransport() が返すオブジェクトへ移設し、host は
// shell-widget-host.js が公開する window.selfmatrixWidgetHost.callControlToggle() 経由でのみ叩く
// (詳細は shell-preload.cjs / shell-widget-host.js のコメント参照)。
function invokeCallControlFromShell() {
  return state.mainWindow.webContents.executeJavaScript(
    `window.selfmatrixWidgetHost.callControlToggle()`,
    true,
  );
}

// EC 側の React マウント (ErrorView 到達までの非同期チェーン) 完了を待つため、対象コントロールが
// 見つかるまで invoke を再試行する。call-control-preload.cjs の invoke() は対象が無ければ
// 副作用なしで { ok:false, reason:"target_not_found" } を返すだけなので、再試行は安全に冪等。
// M1 step 3b: invokeFn を差し替え可能にした (既定は harness の
// window.selfmatrixWidgetHost.callControlToggle() 経由)。cinny-shell smoke (shell-widget-host.js が
// 存在しないトップフレームモード) は claim 済みトランスポートの callControlInvoke() を直接叩く
// invokeFn を渡して同じ再試行ロジックを再利用する。
async function waitForCallControlInvoke(timeoutMs = 10000, invokeFn = invokeCallControlFromShell) {
  const started = Date.now();
  let lastResult = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastResult = await invokeFn();
      lastError = null;
      if (lastResult && lastResult.ok) return { result: lastResult, error: null };
    } catch (error) {
      lastError = error;
    }
    await wait(300);
  }
  return { result: lastResult, error: lastError };
}

// M1 step 2 の受け入れ判定。4 つの pass フィールドはそれぞれ独立した変異観点に対応する
// (完了報告の変異テスト観点参照):
//   - rpcRoundTrip: shell→main→callView→main→shell の往復が correlationId 相関込みで完走したこと。
//     main.cjs の relay (ipcMain.handle/ipcMain.on の correlationId 相関) を壊すと確実に false になる。
//   - domChanged: 実際に対象要素の data-selfmatrix-pressed 属性が click 前後で変化したこと。
//     call-control-preload.cjs の click() 呼び出しを no-op化すると before===after になり false になる。
//   - statePushSeen: MutationObserver 由来の state push (reason:"mutation-observed") が
//     main まで届いたこと。call-control-preload.cjs の observe() 登録を削除すると、click 自体は
//     成功して domChanged は true のままでも push が届かず false になる。
//   - realClickConfirmed (F6, 受け入れレビュー修正): domChanged/statePushSeen は preload 自身が
//     付ける合成属性 data-selfmatrix-pressed の自己完結観測に過ぎない。call-control-preload.cjs の
//     invoke() 内で target.click() を「属性を直接トグルするだけのコード」に置き換える回帰が入っても、
//     preload が自分で属性を書き換えて自分の MutationObserver で気付くだけなので domChanged/
//     statePushSeen は変化せず検知できない。これを塞ぐため、click() が本当に EC 本体 (ErrorView の
//     CloseWidgetButton) の React onClick を発火させたことの独立した傍証として、invoke 実行後に
//     EC が実際に送信した io.element.close (from-view、validateWidgetBridgeMessage を通過し受理
//     されたもの。widget-message-rejected は数えない) の出現を確認する。この傍証は
//     「クリック → CloseWidgetButton の onClick → widget.api.transport.send(Close)」という
//     EC 側の実装に依存している。
//     **この判定は M1 step 2 の対象 (ErrorView.tsx の CloseWidgetButton) に固有の傍証である**。
//     step 3 で対象を実コントロール (画面共有トグル等) に差し替える際は、io.element.close の代わりに
//     その対象が実際に送信する widget action / DOM 状態変化など、対象固有の独立シグナルに
//     置き換えること。
function analyzeCallControl(invokeResult, invokeError, invokeStartedAt) {
  const statePushes = state.callControlMessages.filter((message) => message.direction === "state-push");
  const mutationPushes = statePushes.filter((message) => message.reason === "mutation-observed");

  const rpcRoundTrip = invokeError === null && Boolean(invokeResult) && invokeResult.ok === true;
  const domChanged =
    rpcRoundTrip &&
    typeof invokeResult.before === "string" &&
    typeof invokeResult.after === "string" &&
    invokeResult.before !== invokeResult.after;
  const statePushSeen = mutationPushes.length > 0;
  const realClickConfirmed = acceptedWidgetMessages().some(
    (message) =>
      message.direction === "from-view" &&
      message.data?.action === "io.element.close" &&
      typeof invokeStartedAt === "number" &&
      message.t >= invokeStartedAt,
  );

  return {
    pass: rpcRoundTrip && domChanged && statePushSeen && realClickConfirmed,
    rpcRoundTrip,
    domChanged,
    statePushSeen,
    realClickConfirmed,
    invokeError: invokeError ? String(invokeError.message || invokeError) : null,
    targetSelector: invokeResult?.selector ?? null,
    targetFound: Boolean(invokeResult?.ok || (invokeResult && invokeResult.reason !== "target_not_found")),
    action: invokeResult?.action ?? null,
    before: invokeResult?.before ?? null,
    after: invokeResult?.after ?? null,
    statePushCount: statePushes.length,
    mutationPushCount: mutationPushes.length,
    statePushes,
  };
}

// M1 step 2 (B 単体実証) → M1 step 3c-3 (E2E からの直接駆動用に抽出): shell (host) → callView
// preload への RPC 本体。ipcMain.handle("native:call-control:invoke") はこれを薄く呼ぶだけに
// なった。correlationId を発行して pendingCallControlInvokes で相関を取り、call view preload
// からの native:call-control:invoke-result で resolve する — main は action の中身を一切
// 解釈しない (design §2.2)。
// M1 step 3c-3: native-callflow.e2e.mjs が `global.__selfmatrixE2E.invokeCallControl(action)`
// 経由でこの同じ関数を直接呼ぶ (setupE2EIntrospection() 参照)。cinny の実 NativeCallEmbed が
// 既に claim 済みの transport をもう一度 claim することはできない (claim-once) ため、E2E は
// 「cinny が window.selfmatrixWidgetHost 相当を経由して呼ぶのと同じ main 側の実体」をここから
// 直接叩く — call view 側で実行される内容 (call-control-preload.cjs の invoke()) は完全に同一。
function invokeCallControl(action) {
  return new Promise((resolve, reject) => {
    if (!state.callView) {
      reject(new Error("native:call-control:invoke: call view is not attached"));
      return;
    }
    callControlInvokeSeq += 1;
    const correlationId = `call-control-${callControlInvokeSeq}-${Date.now()}`;
    const timer = setTimeout(() => {
      pendingCallControlInvokes.delete(correlationId);
      reject(new Error(`native:call-control:invoke timed out waiting for correlationId ${correlationId}`));
    }, 5000);
    pendingCallControlInvokes.set(correlationId, { resolve, reject, timer });
    state.callControlMessages.push({ t: Date.now(), direction: "to-view", correlationId, action });
    state.callView.webContents.send("native:call-control:invoke", { correlationId, action });
  });
}

function setupIpc() {
  // M2 セキュリティ監査 (「shell の API 露出面整理」): get-status/ensure-call-view/
  // detach-call-view/attach-call-view の 4 チャンネルは harness (desktop-shell.js /
  // shell-widget-host.js) だけが叩く実装で、cinny 側の契約 (nativeBridge.ts の
  // SelfmatrixNativeBridge = claimWidgetTransport のみ) には現れず、cinny 本体からも一度も
  // 呼ばれない (全数調査の結果は完了報告参照)。shell-preload.cjs は本番 topology
  // (isCinnyShell) では window.selfmatrixNative にこれらのメソッドをそもそも公開しない
  // (shell-preload.cjs 冒頭コメント参照) — 呼び出し口が無いのだから、ipcMain 側のチャンネル
  // 登録自体も本番プロセスでは行わず、harness トポロジのときだけ登録する (登録された
  // チャンネルは preload/contextBridge を介さない限りレンダラから到達できないので二重の
  // 意味は薄いが、「そもそも存在しない」方が監査上も明快なため揃える)。
  // runSmoke()/runMemoryProbe() (harness トポロジでのみ実行される、package.json 参照) の
  // detachCallView()/attachCallView() 呼び出しはこの IPC チャンネルを経由しない main.cjs
  // モジュールスコープ関数への直接呼び出しであり、影響を受けない。E2E
  // (__selfmatrixE2E.detachCallView() 等) も同様に直接呼び出しで、これらのチャンネルには
  // 依存しない。
  if (!isCinnyShell) {
    ipcMain.handle("native:get-status", () => ({
      origin: state.origin,
      callViewState: state.callViewState,
      widgetMessageCount: state.widgetMessages.length,
      cinnyDist,
      ecDist,
    }));
    // M1 step 3b: window.selfmatrixNative.ensureCallView() は「create-only」ガードのまま残す
    // (harness の detach/attach デモや sendWidgetActionFromShell() の F3 対策が使う想定)。
    // URL 付きのロードは claim 済みトランスポートの openCallView() に一本化した。
    ipcMain.handle("native:ensure-call-view", () => createCallViewIfNeeded());
    ipcMain.handle("native:detach-call-view", () => detachCallView());
    ipcMain.handle("native:attach-call-view", () => attachCallView());
  }

  // M1 step 3b (design §3 step 3b 実装要件 1/2): claimWidgetTransport() が返す
  // openCallView(completeWidgetUrl)/closeCallView() の main 側実体。
  // M1 step 3c-2: 第 2 引数 (localStorageSnapshot) は任意 — 省略した既存呼び出し元
  // (harness/smoke) は undefined のまま openCallView() に渡り、空スナップショット扱いになる。
  ipcMain.handle("native:open-call-view", (_event, url, localStorageSnapshot) =>
    openCallView(url, localStorageSnapshot),
  );
  ipcMain.handle("native:close-call-view", () => closeCallView());

  // M1 step 3c-2 (localStorage 契約の実機対応、README「cinny の nativeBridge.ts 契約への適合」
  // 節参照): call-control-preload.cjs が dom-ready より前 (preload 実行時) に同期的に読み出す
  // ための sendSync 専用ハンドラ。openCallView() が state.pendingLocalStorageSnapshot に置いた
  // 値をそのまま返す (main は中身を解釈しない中継役、design の方針を踏襲)。
  // H6 (受け入れレビュー修正、minor): 返却後に state.pendingLocalStorageSnapshot をクリアする —
  // この sendSync は「preload 実行時に一度だけ読み出される」契約 (1 ロード 1 回きり) であり、
  // 返した値をいつまでも state に保持し続ける必要は無い (読み出し面の最小化)。H3 の live 更新経路
  // (updateCallLocalStorage()) はこの pending スナップショットを一切経由しない完全に独立した
  // 経路 (call view へ直接 send するだけ) なので、ここでクリアしても live 経路には影響しない。
  ipcMain.on("native:get-pending-localstorage-snapshot", (event) => {
    event.returnValue = state.pendingLocalStorageSnapshot || {};
    // H6 (受け入れレビュー修正、minor): 素朴に「読んだら常にクリア」すると回帰する ——
    // 実測したところ、call view の WebContentsView は生成直後に内部的な空ドキュメント
    // (about:blank 相当、event.sender.getURL() === "") を一瞬経由してから実際の
    // loadURL(url) 先へ遷移する。"frame" 型の registerPreloadScript はこの空ドキュメントと
    // 後続の実ナビゲーション先の両方でこの sendSync ハンドラを叩く (同一 frameId で 2 回連続、
    // 数 ms 差で発生することを実機で確認済み)。空ドキュメント側の読み出し (1 回目、
    // getURL() === "") でクリアしてしまうと、EC バンドルが実際に評価される本番の
    // ナビゲーション側 (2 回目、getURL() が実 URL) が空スナップショットしか受け取れなくなり、
    // join 時の localStorage 契約が常に空になる回帰が実際に起きた。getURL() が非空になった
    // (=実ナビゲーション先が確定した) 読み出しでのみクリアすることで、「1 回きり」の対象を
    // 空ドキュメントの空振り読み出しではなく「実ロード 1 回」に正しく限定する。
    if (event.sender.getURL()) {
      state.pendingLocalStorageSnapshot = {};
    }
  });
  // H3 (受け入れレビュー修正、major): cinny の NativeCallControl.toggleScreenshare() が RPC 実行
  // 前に呼ぶ transport.updateCallLocalStorage() の main 側ハンドラ。updateCallLocalStorage()
  // コメント参照 — pending スナップショット (上のハンドラ) とは独立した「共有開始のたびに再同期」
  // する live 経路。
  ipcMain.handle("native:update-call-localstorage", (_event, snapshot) => updateCallLocalStorage(snapshot));
  // call-control-preload.cjs が実際に localStorage へ書き込んだ後の確認 ack (診断/evidence 用)。
  // main は書き込みの成否を検証しない (preload 側の try/catch がそれぞれの setItem を守る) —
  // ここではどのキーが対象になったかを記録するだけ。
  ipcMain.on("native:localstorage-primed", (_event, payload) => {
    state.localStorageBridgeEvents.push({ t: Date.now(), ...payload });
  });

  // M2 bounds sync (Fable 全体レビュー arch-major 解消): claim 済みトランスポートの
  // setCallViewBounds() (nativeBridge.ts 契約) の main 側入口。fire-and-forget なので ipcMain.on
  // (invoke ではない、shell-preload.cjs の ipcRenderer.send と対で使う)。入力検証・適用条件・
  // 同値スキップはすべて applyCallViewBoundsFromCinny() 側の責務。
  ipcMain.on("native:set-call-view-bounds", (_event, bounds) => {
    applyCallViewBoundsFromCinny(bounds);
  });

  // callView → shell 方向。call view の未信頼な (EC/widget) コンテキストから来るメッセージなので
  // M0 で確立した origin / widgetId / sourceIsSelf===true の検証を継続適用する。拒否された
  // メッセージは shell へ転送しない (widget-message-rejected として記録するのみ)。
  ipcMain.on("native:widget-from-view", (_event, message) => {
    // M1 step 3c-1: 固定 WIDGET_ID ではなく、その通話が実際に openCallView() で検証された
    // widgetId (state.activeWidgetId) と照合する。未アクティブ時 (null) は照合せず必ず拒否
    // (fail-closed、NO_ACTIVE_CALL_REJECTION コメント参照)。
    const validation = state.activeWidgetId === null
      ? NO_ACTIVE_CALL_REJECTION
      : validateWidgetBridgeMessage(message, {
          expectedOrigin: state.origin,
          expectedWidgetId: state.activeWidgetId,
        });
    if (!validation.ok) {
      state.widgetMessages.push({
        t: Date.now(),
        type: "widget-message-rejected",
        direction: "from-view",
        validation,
        data: message?.data,
      });
      return;
    }

    state.widgetMessages.push({ t: Date.now(), direction: "from-view", ...message });
    // 素通し転送: 生の Widget API メッセージ (message.data) だけを shell へ渡す。shell-preload.cjs
    // がこれを window.postMessage で折り返し、ClientWidgetApi の transport が本物の 'message'
    // イベントとして受け取る。
    state.mainWindow?.webContents.send("native:widget-from-view", message.data);
  });

  // shell → callView 方向。送信元は shell 自身の ClientWidgetApi (信頼できるホスト実装) なので
  // M0 由来の origin/sourceIsSelf 検証は不要だが、F2a (受け入れレビュー修正) で widgetId/api 方向
  // だけの最低限の形状検証を追加した。同一オリジンで埋め込まれた cinny iframe の子コンテンツが
  // window.parent 経由で送信 API に触れられる面が (F2b の claim-once とは別に) 理論上あるため
  // (design/native-widget-transport.md「残存リスク」節)、main.cjs 側でも防御を多重化する。
  // 不合格でも main.cjs は「解釈しないルータ」のままであり、応答内容の生成はしない — 転送するか
  // 拒否するかだけを判定する。
  ipcMain.on("native:widget-to-view", (_event, message) => {
    const validation = state.activeWidgetId === null
      ? NO_ACTIVE_CALL_REJECTION
      : validateToViewMessage(message, state.activeWidgetId);
    if (!validation.ok) {
      state.widgetMessages.push({
        t: Date.now(),
        type: "widget-message-rejected",
        direction: "to-view",
        validation,
        data: message,
      });
      return;
    }

    state.widgetMessages.push({ t: Date.now(), direction: "to-view", data: message });
    state.callView?.webContents.send("native:widget-to-view", message);
  });

  // M1 step 2 (B 単体実証): shell (host) → callView preload への RPC。ipcRenderer.invoke 側
  // (shell-preload.cjs の callControlInvoke) はこの handle が返す Promise をそのまま受け取る。
  // ここから先 (main → callView) は webContents.send/ipcRenderer.send の fire-and-forget しか
  // 無いため、correlationId を発行して pendingCallControlInvokes で相関を取り、call view preload
  // からの native:call-control:invoke-result で resolve する。call view が無い/応答が無ければ
  // reject/timeout する — main は action の中身を一切解釈しない (design §2.2)。
  ipcMain.handle("native:call-control:invoke", (_event, action) => invokeCallControl(action));

  // callView preload (call-control-preload.cjs) からの応答。correlationId が pending map に
  // 無ければ (未知/期限切れ) 記録するだけで何もしない — ここでも中身の解釈はしない。
  ipcMain.on("native:call-control:invoke-result", (_event, payload) => {
    const { correlationId, result } = payload || {};
    state.callControlMessages.push({ t: Date.now(), direction: "from-view", correlationId, result });
    const pending = pendingCallControlInvokes.get(correlationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCallControlInvokes.delete(correlationId);
    pending.resolve(result);
  });

  // call-control-preload.cjs の MutationObserver 由来の state push。素通し転送で shell (host)
  // 側の window にも中継する (design §2.2 の StateUpdate 相当。widget-to-view/from-view と同じ
  // 「main は中継するだけ」の形)。
  ipcMain.on("native:call-control:state", (_event, payload) => {
    state.callControlMessages.push({ t: Date.now(), direction: "state-push", ...payload });
    state.mainWindow?.webContents.send("native:call-control:state", payload);
  });
}

// M2 画面共有ソース選択 UI (Discord 風サムネイルピッカー + system audio トグル):
//
// 設計判断 (絶対条件、遵守): ソース選択 UI は cinny レンダラ内ダイアログにしない。cinny レンダラ
// (未信頼な federated コンテンツを描画する) には画面キャプチャ能力を一切露出しない — desktop
// 自身の信頼された HTML (source-picker.html) を、desktop 自身が生成する別の BrowserWindow に
// ロードして表示する。ピッカー ⇔ main の通信は専用の preload (source-picker-preload.cjs、
// window.selfmatrixSourcePicker) で行い、cinny 用の window.selfmatrixNative
// (shell-preload.cjs、claimWidgetTransport のみ) とは完全に別系統 — この変更は
// window.selfmatrixNative の契約を一切広げていない (cinny-shell-smoke の contractSurfaceGate が
// 引き続き ["claimWidgetTransport"] のままであることで実証する)。
//
// 旧実装 (M1 step 3c-3 まで) は「最初の screen: ソースを無言で自動選択 (通常モード) /
// "SelfMatrix" を名前に含む自 window を自動選択 (E2E、content-adaptive エンコーダ対策)」という
// 暫定挙動だった。M2 でこのピッカーが実装されたことに伴い、両モードとも「本物のピッカーを開いて
// ユーザー (または E2E スクリプト) の選択を待つ」経路に統一する — E2E も自動バイパスしない
// (e2e/native-callflow.e2e.mjs の driveSourcePicker() が Playwright でピッカーを実際に操作し、
// "SelfMatrix" を名前に含む自 window のタイルを選ぶことで、旧ヒューリスティックと同じ実質効果
// (content-adaptive エンコーダに継続的な差分ソースを与える) を実ピッカー経由で再現する)。
//
// 1 リクエストにつき 1 ピッカーウィンドウ、多重には開かない (pendingSourcePickerRequest が
// 既に埋まっていれば新規要求は即キャンセル扱いにする -- fail-closed)。
let pendingSourcePickerRequest = null; // { resolve: (pickerResponse) => void } | null

function resolvePendingSourcePickerRequest(response) {
  const pending = pendingSourcePickerRequest;
  if (!pending) return;
  pendingSourcePickerRequest = null;
  pending.resolve(response);
}

function closeSourcePickerWindow() {
  const win = state.sourcePickerWindow;
  state.sourcePickerWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

// sources (desktopCapturer.getSources() の生の結果、NativeImage 込み) と request
// (setDisplayMediaRequestHandler のハンドラに渡される DisplayMediaRequest) からピッカー
// ウィンドウを構築する。E2E offscreen モード (isE2ERealJoin) では e2eOffscreenBrowserWindowOptions()
// により mainWindow/callWindow と同じ「実ウィンドウのまま画面外」に開く (E2E_OFFSCREEN_WINDOW_POSITION
// コメント参照 -- WGC/desktopCapturer に影響しないことが実証済みの方式)。
function createSourcePickerWindow(sources, request) {
  const parent = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
  const win = new BrowserWindow({
    title: "SelfMatrix - 画面を共有",
    width: 780,
    height: 580,
    show: true,
    parent,
    modal: Boolean(parent),
    autoHideMenuBar: true,
    ...e2eOffscreenBrowserWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "source-picker-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  state.sourcePickerWindow = win;

  // システム音声トグルは win32 かつ EC 自身が audio を要求したときだけ提示する (main.cjs の従来の
  // 判定式 `request.audioRequested && process.platform === "win32"` をそのまま踏襲。実際に
  // "loopback" を選ぶかどうかの最終判定は resolveDisplayMediaSelection() 一箇所に集約してある)。
  const audioAvailable = Boolean(request.audioRequested) && process.platform === "win32";
  const initPayload = {
    audioAvailable,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith("screen:") ? "screen" : "window",
      thumbnailDataUrl:
        source.thumbnail && typeof source.thumbnail.isEmpty === "function" && !source.thumbnail.isEmpty()
          ? source.thumbnail.toDataURL()
          : null,
    })),
  };

  win.webContents.on("did-finish-load", () => {
    if (state.sourcePickerWindow === win) win.webContents.send("source-picker:init", initPayload);
  });

  // OS のタイトルバー「閉じる」等、共有/キャンセル以外の経路でウィンドウが消えた場合もキャンセル
  // 扱いにする (pendingSourcePickerRequest は share/cancel ハンドラで既に消費済みなら no-op)。
  win.on("closed", () => {
    if (state.sourcePickerWindow === win) state.sourcePickerWindow = null;
    resolvePendingSourcePickerRequest({ canceled: true, reason: "window_closed" });
  });

  win.loadFile(path.join(__dirname, "source-picker.html"));
  return win;
}

// sources/request からピッカー UI を実際に開き、ユーザーの選択 (または取消) を待つ。
// 戻り値は resolveDisplayMediaSelection() の pickerResponse 引数の形そのもの
// (source-picker-selection.cjs 参照)。
function openSourcePicker(sources, request) {
  return new Promise((resolve) => {
    if (pendingSourcePickerRequest) {
      // 多重に開かない: 既に別の要求を処理中なら、この新しい要求は無視 (キャンセル扱い) する。
      resolve({ canceled: true, reason: "picker_already_open" });
      return;
    }
    pendingSourcePickerRequest = { resolve };
    createSourcePickerWindow(sources, request);
  });
}

// ピッカーウィンドウ (source-picker-preload.cjs) からの応答用 IPC。cinny の mainWindow/call view は
// この preload を一切ロードしないため、window.selfmatrixNative 経由ではこれらのチャンネルへ絶対に
// 到達できない (contextBridge を介さない ipcMain チャンネル名自体は到達性を持たないが、念のため
// event.sender を現在のピッカーウィンドウの webContents と突き合わせて多重防御する)。
function setupSourcePickerIpc() {
  ipcMain.on("source-picker:share", (event, selection) => {
    if (!pendingSourcePickerRequest) return;
    if (!state.sourcePickerWindow || event.sender !== state.sourcePickerWindow.webContents) return;
    const sourceId = selection && typeof selection.sourceId === "string" ? selection.sourceId : null;
    const includeSystemAudio = Boolean(selection && selection.includeSystemAudio);
    resolvePendingSourcePickerRequest(
      sourceId ? { canceled: false, sourceId, includeSystemAudio } : { canceled: true, reason: "no_source_selected" },
    );
    closeSourcePickerWindow();
  });
  ipcMain.on("source-picker:cancel", (event) => {
    if (!pendingSourcePickerRequest) return;
    if (!state.sourcePickerWindow || event.sender !== state.sourcePickerWindow.webContents) return;
    resolvePendingSourcePickerRequest({ canceled: true, reason: "user_canceled" });
    closeSourcePickerWindow();
  });
}

// M1 step 3c-3 (受け入れレビューで発覚、修正): `setDisplayMediaRequestHandler` は Session
// インスタンスごとに独立している。以前はここで `session.defaultSession` にしか登録しておらず、
// これは mainWindow (cinny, パーティション未指定=デフォルトセッション) の getDisplayMedia() しか
// カバーしない。call view (EC) は `CALL_VIEW_PARTITION` という**別の** session パーティションで
// 動いている (createCallViewIfNeeded() 参照) ため、EC 側で実際に screenshare を開始した際の
// getDisplayMedia() 要求は call view 自身のセッションのハンドラを探しに行き、登録が無ければ選択
// ダイアログを試みて失敗する。両方の session に同じロジックを登録する。
function registerDisplayMediaHandler(targetSession) {
  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } })
      .then((sources) =>
        openSourcePicker(sources, request).then((pickerResponse) => ({ sources, pickerResponse })),
      )
      .then(({ sources, pickerResponse }) => {
        const selection = resolveDisplayMediaSelection(sources, pickerResponse, { platform: process.platform });
        // 診断/evidence 用: どのソースが実際に選ばれたか (または取消されたか) を記録する
        // (サムネイル画像などの重い/機微なデータは積まない)。
        state.widgetMessages.push({
          t: Date.now(),
          type: "display-media-source-selected",
          sourceId: selection.video?.id ?? null,
          sourceName: selection.video?.name ?? null,
          canceled: selection.canceled,
          cancelReason: selection.canceled ? selection.reason : null,
          audioMode: selection.audio,
          availableSourceCount: sources.length,
        });
        if (selection.canceled || !selection.video) {
          callback({});
          return;
        }
        callback({ video: selection.video, audio: selection.audio });
      })
      .catch((error) => {
        state.widgetMessages.push({
          t: Date.now(),
          type: "display-media-handler-error",
          error: String(error && error.message ? error.message : error),
        });
        callback({});
      });
  });
}

function setupDisplayMediaHandler() {
  registerDisplayMediaHandler(session.defaultSession);
  registerDisplayMediaHandler(session.fromPartition(CALL_VIEW_PARTITION));
}

function sanitizeEvidenceString(value) {
  if (typeof value !== "string" || !state.origin) return value;
  return value
    .replaceAll(encodeURIComponent(state.origin), "http%3A%2F%2F127.0.0.1%3A%3Clocal-port%3E")
    .replaceAll(state.origin, "http://127.0.0.1:<local-port>");
}

function sanitizeEvidenceMessage(message) {
  return {
    ...message,
    origin: sanitizeEvidenceString(message.origin),
    // M1 step 3b: call-view-url-rejected エントリの url フィールドも同じ方針でサニタイズする
    // (message.url が無いエントリでは sanitizeEvidenceString(undefined) === undefined のまま)。
    url: sanitizeEvidenceString(message.url),
  };
}

// M1 step 3b (item 9, cinny-shell-result.json 新設): call-view-url-rejected エントリは
// `validation.reasons[].message/expectedOrigin/actualOrigin` に生の origin (127.0.0.1:<port>) が
// 埋め込まれる。sanitizeEvidenceMessage() は浅い (トップレベル origin/url だけ) サニタイズなので、
// この新しい evidence ファイル用に再帰的に文字列を洗う専用ヘルパーを用意した。既存の
// evidence ファイル (smoke/handshake/call-control/memory-result.json) の出力形状は変えたくない
// ため、既存の sanitizeEvidenceMessage() 呼び出し箇所には手を入れず、cinny-shell-result.json の
// 書き出しにだけこちらを使う。
function deepSanitizeEvidence(value) {
  if (typeof value === "string") return sanitizeEvidenceString(value);
  if (Array.isArray(value)) return value.map((item) => deepSanitizeEvidence(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = deepSanitizeEvidence(nested);
    }
    return out;
  }
  return value;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bridge の検証で拒否されたメッセージ (widget-message-rejected) は「action が観測された」判定から
// 除外する。拒否メッセージにも data.action は残っているため、これを除外しないと
// widgetId/origin/sourceIsSelf 検証が壊れて全メッセージが拒否されていても pass:true になり得る。
function acceptedWidgetMessages() {
  return state.widgetMessages.filter((message) => message.type !== "widget-message-rejected");
}

async function waitForWidgetAction(action, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (acceptedWidgetMessages().some((message) => message.data?.action === action)) return true;
    await wait(100);
  }
  return false;
}

// F1 (受け入れレビュー修正): 拒否記録 (widget-message-rejected) 側で action の出現を待つ。
// waitForWidgetAction は acceptedWidgetMessages() (拒否を除外したもの) しか見ないため、
// スプーフ注入がちゃんと拒否されたことを確認するにはこちらが要る。
async function waitForRejectedAction(action, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (
      state.widgetMessages.some(
        (message) => message.type === "widget-message-rejected" && message.data?.action === action,
      )
    ) {
      return true;
    }
    await wait(100);
  }
  return false;
}

// F1: ハンドシェイク完了後に call view (EC の window) へ偽の fromWidget メッセージを直接
// window.postMessage する。widget-bridge-preload.cjs は window.addEventListener("message", ...) で
// これを拾い (source===window なので sourceIsSelf:true になる)、native:widget-from-view で main へ
// 転送する。widgetId が WIDGET_ID と不一致なので validateWidgetBridgeMessage の widget_id_mismatch
// で必ず拒否されるはず — 拒否されず shell 側へ転送されてしまえば (=すり抜ければ) F1 が検知する。
function injectSpoofedFromViewMessage() {
  const spoofMessage = {
    api: "fromWidget",
    widgetId: SPOOF_WIDGET_ID,
    requestId: "spoof-test-1",
    action: SPOOF_ACTION,
    data: {},
  };
  return state.callView.webContents.executeJavaScript(
    `window.postMessage(${JSON.stringify(spoofMessage)}, window.location.origin)`,
    true,
  );
}

// F2b: shell-preload.cjs の claimWidgetTransport() が二重呼び出しで throw することを、shell の
// page-context (desktop-shell.html) から実際に呼んでみて確認する。shell-widget-host.js が起動時に
// 一度 claim 済みのはずなので、ここでの 2 回目の呼び出しは必ず throw するはず — throw しなければ
// (＝claim-once が機能していなければ) claimGuard:false として記録し smoke を fail させる。
function verifyClaimGuard() {
  return state.mainWindow.webContents.executeJavaScript(
    `(() => {
      try {
        window.selfmatrixNative.claimWidgetTransport();
        return false;
      } catch (error) {
        return true;
      }
    })()`,
    true,
  );
}

// M1 step 1 のハンドシェイク解析: state.widgetMessages (main のルータが実際に中継した全メッセージ)
// だけを根拠に、応答が本物の ClientWidgetApi 由来であること (スタブでないこと) と、capability
// 交渉が (要求→driver 承認→notify) まで実際に往復したことを判定する。
// 各フィールドが何を保証するかは reviews 側の変異テスト観点 (完了報告参照) に対応させてある:
//   - supportedVersionsReal: シムの postMessage やルータ転送を壊すと to-view 側にこの応答自体が
//     現れなくなる。応答はあってもスタブに戻すと supported_versions が空配列に戻る。
//   - capabilitiesNegotiated: どちらか片方向でもルータ転送が壊れると Capabilities 往復
//     (toWidget ask → fromWidget reply → toWidget notify) が完成せず notify_capabilities 自体が
//     現れない。driver.validateCapabilities が空集合を返すよう壊されると notify は現れるが
//     approved が空になる。
//   - actionSequence には echo エントリ (widget-bridge-preload.cjs のコメント参照) が混ざる。
//     to-view 系のフィールド (sawJoinRequest 等) は「host が送った」という記録に過ぎず、EC 側が
//     実際に受け取ったことの証明ではない — 受信の担保は capabilitiesNegotiated が
//     (toWidget ask → fromWidget reply → toWidget notify) の往復完走を見ている点に依っている。
//   - spoofRejected/spoofLeaked/unexpectedRejectedCount (F1, 受け入れレビュー修正): 変異テストで
//     「main.cjs の from-view 検証を if (false) でバイパスしても両 npm test が green のまま」という
//     すり抜けが実測されたため追加した。rejectedMessageCount は既存 (M0 由来) の集計だが、それ単体は
//     「0 件だと全部素通し」なのか「本当に不正メッセージが無かった」のかを区別できず pass 判定にも
//     使われていなかった。runSmoke() が実際に 1 件スプーフを注入することで、
//     「拒否ロジックが本当に効いている」ことを毎回実証する。
function analyzeHandshake() {
  const accepted = acceptedWidgetMessages();
  const toView = accepted.filter((message) => message.direction === "to-view");
  const fromView = accepted.filter((message) => message.direction === "from-view");
  const rejected = state.widgetMessages.filter((message) => message.type === "widget-message-rejected");

  const supportedVersionsReply = toView.find(
    (message) => message.data?.action === "supported_api_versions" && message.data?.response,
  );
  const capabilitiesAsk = toView.find((message) => message.data?.action === "capabilities" && !message.data?.response);
  const capabilitiesReply = fromView.find(
    (message) => message.data?.action === "capabilities" && message.data?.response,
  );
  const notifyCapabilities = toView.find((message) => message.data?.action === "notify_capabilities");
  const contentLoadedAck = toView.find((message) => message.data?.action === "content_loaded" && message.data?.response);

  const supportedVersionsCount = supportedVersionsReply?.data?.response?.supported_versions?.length ?? 0;
  const approvedCapabilities = notifyCapabilities?.data?.data?.approved ?? [];
  const requestedCapabilities = capabilitiesReply?.data?.response?.capabilities ?? [];

  const actionSequence = accepted
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((message) => `${message.direction}:${message.data?.action}${message.data?.response ? ":response" : ""}`);

  // F1: 拒否記録のうち、意図的に注入したスプーフ (data.action === SPOOF_ACTION) を分離する。
  // それ以外の拒否は正規トラフィックの誤拒否リグレッションを意味するので unexpectedRejectedCount に
  // 集計する (0 であるべき)。
  const spoofRejectedEntries = rejected.filter((message) => message.data?.action === SPOOF_ACTION);
  const spoofRejected = spoofRejectedEntries.length > 0;
  // 受理側 (accepted) に spoof action が紛れ込んでいたら、拒否ロジックが素通ししている証拠。
  const spoofLeaked = accepted.some((message) => message.data?.action === SPOOF_ACTION);
  const unexpectedRejectedCount = rejected.length - spoofRejectedEntries.length;

  return {
    // stub (widget-bridge-protocol.cjs#responseForWidgetRequest) always answered
    // supported_api_versions with `{ supported_versions: [] }`. The real ClientWidgetApi answers
    // with matrix-widget-api's non-empty CurrentApiVersions list, so a non-empty array here is
    // only possible if the live route is exercising the real library, not the removed stub.
    // F4 (受け入れレビュー修正): スタブ自体は M1 step 1 でライブ経路から既に撤去済み — この判定は
    // 「スタブに戻っていないか」ではなく「実 host (shell-widget-host.js の本物の ClientWidgetApi) が
    // 現に非空の応答を返したか」を毎回確認するリグレッション検知として機能している。
    supportedVersionsIsReal: {
      pass: Boolean(supportedVersionsReply) && supportedVersionsCount > 0,
      supportedVersionsCount,
      note: "Stub always returned supported_versions: []; real ClientWidgetApi returns CurrentApiVersions (non-empty).",
    },
    capabilitiesNegotiated: {
      pass:
        Boolean(capabilitiesAsk) &&
        Boolean(capabilitiesReply) &&
        Boolean(notifyCapabilities) &&
        approvedCapabilities.length > 0,
      capabilitiesAskSeen: Boolean(capabilitiesAsk),
      capabilitiesReplySeen: Boolean(capabilitiesReply),
      requestedCapabilityCount: requestedCapabilities.length,
      notifyCapabilitiesSeen: Boolean(notifyCapabilities),
      approvedCapabilityCount: approvedCapabilities.length,
    },
    contentLoadedAcked: Boolean(contentLoadedAck),
    rejectedMessageCount: rejected.length,
    spoofRejected,
    spoofLeaked,
    unexpectedRejectedCount,
    actionSequence,
  };
}

async function runSmoke() {
  // M1 step 3b: もう main が能動的に ensureCallView() で通話 View を作ってロードしない。
  // shell-widget-host.js の boot() が claim 済みトランスポートの openCallView(completeUrl) を
  // 自発的に呼ぶのを待つだけにする (waitForCallViewAttached() コメント参照) — これは cinny 本番の
  // NativeCallEmbed コンストラクタが行う手順と同型。
  const callViewAttached = await waitForCallViewAttached();
  if (!callViewAttached) {
    throw new Error(
      "runSmoke(): call view never reached the attached state. shell-widget-host.js's boot() " +
        "never called openCallView() (see shell-widget-host.js).",
    );
  }
  const sawContentLoaded = await waitForWidgetAction("content_loaded");
  // capability 交渉 (content_loaded の ack を契機に beginCapabilities() が自動発火する) が
  // 往復し終える猶予。EC 側の応答を待つだけなので固定 wait ではなく安全側に長めを確保。
  await wait(1000);
  await detachCallView();
  await wait(250);
  await attachCallView();
  await wait(250);
  await detachCallView();
  await wait(250);
  await attachCallView();
  await sendWidgetActionFromShell("io.element.join", { audioInput: null, videoInput: null });
  await wait(500);

  // F1: ハンドシェイクが一通り済んだ後 (analyzeHandshake() より前) にスプーフを注入し、
  // 拒否記録が現れるのを待つ。memory probe には注入しない (現行のまま)。
  await injectSpoofedFromViewMessage();
  const spoofRejectionObserved = await waitForRejectedAction(SPOOF_ACTION);

  // F2b: claim-once ガードが機能していること (2 回目の claimWidgetTransport() が throw すること) を
  // 実際に呼んで確認する。
  const claimGuard = await verifyClaimGuard();

  // M1 step 2 (B 単体実証): shell から call-control RPC を叩き、call view preload 内の実 DOM
  // (対象コントロールの特定と選定理由は call-control-preload.cjs 冒頭コメント参照) を実際にクリック
  // させる。EC の React マウント (ErrorView 到達までの非同期チェーン) 完了まで再試行する。
  // F6: realClickConfirmed の判定基準時刻として、最初の invoke 試行開始時刻を記録しておく
  // (analyzeCallControl() コメント参照)。
  // G5 (受け入れレビュー修正): 既定の 10000ms は実測 (~9.95s、EC の ErrorView マウントまでの
  // 内部ネットワークタイムアウト待ち) に対して際どい。runCinnyShellSmoke() 側の同種の待機
  // (waitForCallControlInvoke(20000, ...)) と同じ 20000ms を明示的に渡し、水準を揃える。
  const callControlInvokeStartedAt = Date.now();
  const callControlOutcome = await waitForCallControlInvoke(20000);
  // MutationObserver → IPC push → main 中継が届くまでの猶予。
  await wait(500);
  const callControl = analyzeCallControl(callControlOutcome.result, callControlOutcome.error, callControlInvokeStartedAt);

  const hardNavigationCount = state.navigationEvents.filter((event) => event.isMainFrame && !event.isInPlace).length;
  const sawJoinRequest = acceptedWidgetMessages().some(
    (message) => message.direction === "to-view" && message.data?.api === "toWidget" && message.data?.action === "io.element.join",
  );
  const handshake = analyzeHandshake();

  const result = {
    pass:
      Boolean(sawContentLoaded) &&
      state.callViewState === "attached" &&
      handshake.supportedVersionsIsReal.pass &&
      handshake.capabilitiesNegotiated.pass &&
      // C4 (Fable test#4 修正、PARTIALLY→完了): analyzeHandshake() が算出する contentLoadedAcked
      // (host の本物の ClientWidgetApi が content_loaded に実際に応答したか) は今まで evidence に
      // 記録されるだけで pass 判定には使われていなかった。sawContentLoaded/上の
      // "content_loaded" some() チェックはどちらも「content_loaded という action が出現したか」
      // (要求の到達) しか見ておらず、host 側の応答生成自体が壊れても (=host が何も返さなくなっても)
      // これらは true のままになり得る — contentLoadedAcked は「to-view 方向に実際に応答
      // (response 付き) が流れたか」を見るため、応答生成の破壊を検知できる。
      handshake.contentLoadedAcked &&
      acceptedWidgetMessages().some((message) => message.data?.action === "content_loaded") &&
      sawJoinRequest &&
      hardNavigationCount === 1 &&
      Boolean(spoofRejectionObserved) &&
      handshake.spoofRejected &&
      !handshake.spoofLeaked &&
      handshake.unexpectedRejectedCount === 0 &&
      Boolean(claimGuard) &&
      callControl.pass,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    origin: state.origin.replace(/:\d+$/, ":<local-port>"),
    hardNavigationCount,
    sawJoinRequest,
    sawContentLoaded,
    handshake,
    claimGuard,
    callControl,
    cinnyDistExists: fs.existsSync(path.join(cinnyDist, "index.html")),
    ecDistExists: fs.existsSync(path.join(ecDist, "index.html")),
    callViewState: state.callViewState,
    preloadErrors: state.preloadErrors,
    widgetMessages: state.widgetMessages.map((message) => ({
      ...sanitizeEvidenceMessage(message),
    })),
    callControlMessages: state.callControlMessages,
    navigationEvents: state.navigationEvents.map((event) => ({
      ...event,
      url: sanitizeEvidenceString(event.url),
    })),
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "smoke-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  // M1 step 1 の主目的 (widget-api トランスポート単体の実証) に絞った、より読みやすい専用証跡。
  // 内容は smoke-result.json のサブセットで、pass 判定に関わるフィールドと実メッセージ列だけを残す。
  const handshakeResult = {
    pass: result.pass,
    transportContext:
      "ClientWidgetApi runs in desktop-shell.html's ordinary page-script context (window.mxwidgets from " +
      "matrix-widget-api's browserified dist/api.js, loaded via <script src=/vendor/matrix-widget-api.js>), " +
      "not in a preload script. See shell-widget-host.js header comment for why.",
    sawContentLoaded,
    supportedVersionsIsReal: handshake.supportedVersionsIsReal,
    capabilitiesNegotiated: handshake.capabilitiesNegotiated,
    contentLoadedAcked: handshake.contentLoadedAcked,
    rejectedMessageCount: handshake.rejectedMessageCount,
    spoofRejected: handshake.spoofRejected,
    spoofLeaked: handshake.spoofLeaked,
    unexpectedRejectedCount: handshake.unexpectedRejectedCount,
    claimGuard,
    sawJoinRequest,
    hardNavigationCount,
    actionSequence: handshake.actionSequence,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "handshake-result.json"),
    `${JSON.stringify(handshakeResult, null, 2)}\n`,
    "utf8",
  );

  // M1 step 2 (B 単体実証) 専用の証跡。選定した対象コントロールの特定情報とクリック前後の実測値、
  // 3 つの pass フィールドの根拠 (analyzeCallControl() 参照) をまとめる。
  const callControlResult = {
    pass: callControl.pass,
    deviationsFromDesign:
      "(1) prototype はバックエンド無しのため EC は ErrorView (Room not found) を描画し、ロビー/" +
      "在室 UI (マイク/カメラトグル) には到達しない — CallControl.ts の data-testid セレクタは実在しない。" +
      "(2) CallControl.ts 精読の結果、そもそも toggleMicrophone/toggleVideo は DOM クリックではなく " +
      "widget action (ElementWidgetActions.DeviceMute 経由の transport.send) で実装されており、" +
      "querySelector/.click() が使われるのは screenshare/spotlight/grid/emphasis/reactions/settings 側のみ" +
      "だった。(3) 対象は実在する唯一の操作可能コントロール (ErrorView.tsx の CloseWidgetButton, " +
      '[role="button"][data-kind="primary"], data-testid 無し) を採用。(4) このボタン自身の属性は EC 側では ' +
      "click しても変化しない (host が io.element.close を処理しないため) ので、実クリックイベントを " +
      "起点に preload が data-selfmatrix-pressed 属性を独自にトグルして観測対象にした。詳細は " +
      "call-control-preload.cjs 冒頭コメント参照。(5) 実クリックが EC 本体の DOM に届いたことは、preload " +
      "自身の合成属性観測 (domChanged/statePushSeen) だけでは自己完結してしまい検知できないため、独立" +
      "した傍証として invoke 実行後に受理された io.element.close (from-view) の出現を realClickConfirmed " +
      "として pass 条件に組み込んでいる (F6, 受け入れレビュー修正)。",
    callControlToCallControlTsMapping:
      "screenshareButton ([data-testid=incall_screenshare], 属性 data-kind を監視) / spotlightButton " +
      "(input[value=spotlight], 属性を監視) と同型のパターン (querySelector → .click() → attributes " +
      "MutationObserver) を、実在する唯一の対象 (CloseWidgetButton) に適用した。real な in-call UI に " +
      "差し替わる際は TARGET_SELECTOR と観測属性名を差し替えるだけで良い設計にしてある " +
      "(call-control-preload.cjs)。注意: spotlightButton/emphasisButton は <input> の checkbox/radio で、" +
      "実際に監視すべき checked は DOM 属性ではなくプロパティのため、属性ベースの MutationObserver では " +
      "変化を拾えない (CallControl.ts は click 直後に refreshEmphasisState() で明示的に再読込している)。" +
      "step 3 でこれらの対象に適用する際は同じ対策 (click 後の明示再読取り等) が必要。",
    targetSelector: callControl.targetSelector,
    targetFound: callControl.targetFound,
    action: callControl.action,
    before: callControl.before,
    after: callControl.after,
    rpcRoundTrip: callControl.rpcRoundTrip,
    domChanged: callControl.domChanged,
    statePushSeen: callControl.statePushSeen,
    realClickConfirmed: callControl.realClickConfirmed,
    statePushCount: callControl.statePushCount,
    mutationPushCount: callControl.mutationPushCount,
    invokeError: callControl.invokeError,
    statePushes: callControl.statePushes,
    callControlMessages: state.callControlMessages,
    preloadErrors: state.preloadErrors,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "call-control-result.json"),
    `${JSON.stringify(callControlResult, null, 2)}\n`,
    "utf8",
  );

  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  state.mainWindow?.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

async function memorySnapshot(label) {
  await wait(700);
  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetSizeKB: metric.memory.workingSetSize,
    peakWorkingSetSizeKB: metric.memory.peakWorkingSetSize,
    privateBytesKB: metric.memory.privateBytes,
  }));
  return {
    label,
    processCount: metrics.length,
    totalWorkingSetSizeKB: metrics.reduce((sum, metric) => sum + (metric.workingSetSizeKB || 0), 0),
    totalPrivateBytesKB: metrics.reduce((sum, metric) => sum + (metric.privateBytesKB || 0), 0),
    metrics,
  };
}

async function injectSyntheticViewerStreams() {
  await waitForCallViewAttached();
  return state.callView.webContents.executeJavaScript(
    `(() => {
      const streams = [];
      for (let index = 0; index < 2; index += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d");
        let frame = 0;
        const timer = setInterval(() => {
          ctx.fillStyle = index === 0 ? "#5865f2" : "#2b2d31";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#ffffff";
          ctx.font = "64px sans-serif";
          ctx.fillText("SelfMatrix stream " + (index + 1) + " / " + frame, 80, 160);
          frame += 1;
        }, 1000 / 30);
        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.style.width = "320px";
        video.style.height = "180px";
        video.style.position = "fixed";
        video.style.left = "16px";
        video.style.top = (16 + index * 196) + "px";
        video.srcObject = canvas.captureStream(30);
        document.body.append(video);
        streams.push({ timer, tracks: video.srcObject.getTracks().length });
      }
      window.__selfmatrixMemoryProbeStreams = streams;
      return streams.map((stream) => ({ tracks: stream.tracks }));
    })()`,
    true,
  );
}

async function runMemoryProbe() {
  const snapshots = [];
  await wait(700);
  snapshots.push(await memorySnapshot("shell-only"));

  // M1 step 3b: shell-widget-host.js の boot() が自発的に openCallView() を呼ぶのを待つ
  // (runSmoke() と同じ変更理由。waitForCallViewAttached() コメント参照)。
  await waitForCallViewAttached();
  const sawContentLoaded = await waitForWidgetAction("content_loaded");
  snapshots.push(await memorySnapshot("call-view-booted"));

  const syntheticStreams = await injectSyntheticViewerStreams();
  snapshots.push(await memorySnapshot("call-view-with-2-synthetic-viewer-streams"));

  const result = {
    pass: snapshots.length === 3 && syntheticStreams.length === 2 && Boolean(sawContentLoaded),
    sawContentLoaded,
    note: "Third snapshot uses two local canvas capture streams in the call renderer. Real LiveKit decode remains an M1 gate.",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    snapshots,
    syntheticStreams,
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "memory-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  state.mainWindow?.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

// M1 step 3b 実装要件 7: cinny-shell smoke。--cinny-shell-smoke モードは mainWindow が cinny 本体を
// 直接トップフレームでロードする (createMainWindow() の isCinnyShell 分岐、本番同様の topology)。
// このプロトタイプにはバックエンドが無いため、cinny 自身がログイン画面から先に進んで実際に
// NativeCallEmbed を構築することは無い。そのためこの smoke は「本番で NativeCallEmbed がやるはず
// のこと」を main プロセスから executeJavaScript 経由で代わりに実行し、shell-preload.cjs が
// window.selfmatrixNative として公開する契約そのもの (design/native-widget-transport.md の
// nativeBridge.ts 契約) を直接検証する。claim-once のため、claim は一度だけ行い、以降の全ステップは
// 同じ transport インスタンス (window.__selfmatrixShellSmoke) を使い回す。
async function runCinnyShellSmoke() {
  const win = state.mainWindow;

  // 1. cinny が top frame でロード完了し、window.selfmatrixNative が main world に存在すること。
  await win.webContents.executeJavaScript(
    `(document.readyState === "complete" ? Promise.resolve() : new Promise((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    }))`,
    true,
  );
  const bridgePresent = await win.webContents.executeJavaScript(
    `typeof window.selfmatrixNative !== "undefined" && typeof window.selfmatrixNative.claimWidgetTransport === "function"`,
    true,
  );
  const topFrameUrl = win.webContents.getURL();
  // M1 step 3c-1: createMainWindow() は --cinny-shell モードで `${origin}/` (ルート直下、
  // /cinny/ プレフィックスなし) をロードするよう変更した (cinny の React Router basename="/"
  // との不一致で誤ルーティングが起きるのを実機で確認したため、上の win.loadURL() コメント参照)。
  const cinnyTopFrame = topFrameUrl === `${state.origin}/`;

  // 1b. (M2 セキュリティ監査「shell の API 露出面整理」): 本番 topology で window.selfmatrixNative
  // に実際に公開されているキー集合を実測する。cinny 側の契約 (nativeBridge.ts の
  // SelfmatrixNativeBridge) が要求するのは claimWidgetTransport だけで、getStatus/ensureCallView/
  // detachCallView/attachCallView は harness (desktop-shell.js/shell-widget-host.js) 専用の
  // 残骸だった — shell-preload.cjs は additionalArguments 経由のトポロジ判定
  // (--selfmatrix-shell-topology) が harness のときだけこの 4 メソッドを追加する
  // (shell-preload.cjs 冒頭コメント参照)。この smoke は常に --cinny-shell-smoke (本番 topology、
  // createMainWindow() の isCinnyShell 分岐) で起動するため、ここで実測したキー集合が
  // ["claimWidgetTransport"] 以外の何かを含んでいれば、契約外 API が本番 topology の cinny
  // フレームへ漏れ出す回帰が起きたことを意味し、この smoke は FAIL する。
  const exposedSelfmatrixNativeKeys = await win.webContents.executeJavaScript(
    `Object.keys(window.selfmatrixNative).sort()`,
    true,
  );
  const contractSurfaceGate = {
    exposedKeys: exposedSelfmatrixNativeKeys,
    pass:
      Array.isArray(exposedSelfmatrixNativeKeys) &&
      exposedSelfmatrixNativeKeys.length === 1 &&
      exposedSelfmatrixNativeKeys[0] === "claimWidgetTransport",
  };

  // 1c. M2 homeserver 選択制 (運用者確定仕様: 自サーバーを焼き込まない。候補は matrix.org のみ。
  // カスタムホームサーバー入力を許可する): この smoke は常に --cinny-shell-smoke (E2E ではない) で
  // 起動するため、startServer() の "/config.json" ルート (resolveCinnyConfigPath() 定義箇所参照) は
  // 製品 config (resources/cinny-config.production.json) を返しているはず。「配信された実際の
  // レスポンス」を cinny と同じ経路 (fetch("/config.json"), ClientConfigLoader.tsx 参照) で取得し、
  // 中身を検証する — cinny の ClientConfig 型 (cinny/src/app/hooks/useClientConfig.ts) に合わせて
  // homeserverList・allowCustomHomeservers・hideExplore を見る。
  const servedCinnyConfig = await win.webContents.executeJavaScript(
    `fetch("/config.json").then((response) => response.json())`,
    true,
  );
  const servedHomeserverList = Array.isArray(servedCinnyConfig && servedCinnyConfig.homeserverList)
    ? servedCinnyConfig.homeserverList
    : [];
  // dev config (cinny/dist/config.json) が指す自サーバードメイン/ローカルスタックの痕跡。
  // これらのいずれかが homeserverList に混入していれば、E2E 以外のモードで dev config が漏れて
  // いる (=モード分岐が壊れている) ことを意味する。
  const FORBIDDEN_HOMESERVER_SUBSTRINGS = ["synapse", "mesugaki", ".localhost"];
  const forbiddenHomeserverEntries = servedHomeserverList.filter((entry) =>
    FORBIDDEN_HOMESERVER_SUBSTRINGS.some((needle) => String(entry).toLowerCase().includes(needle)),
  );
  const homeserverConfigGate = {
    homeserverList: servedHomeserverList,
    forbiddenHomeserverEntries,
    allowCustomHomeservers: servedCinnyConfig ? servedCinnyConfig.allowCustomHomeservers : undefined,
    hideExplore: servedCinnyConfig ? servedCinnyConfig.hideExplore : undefined,
    pass:
      Boolean(servedCinnyConfig) &&
      servedHomeserverList.length === 1 &&
      servedHomeserverList[0] === "matrix.org" &&
      forbiddenHomeserverEntries.length === 0 &&
      servedCinnyConfig.allowCustomHomeservers === true &&
      servedCinnyConfig.hideExplore !== true,
  };

  // 2. 通話 1 本分の transport を一度だけ claim し (real NativeCallEmbed のコンストラクタが
  // claimWidgetTransport() を呼ぶのと同じ操作)、以降の全ステップで使い回す。onCallControlState()
  // の購読もここで一度だけ登録する (design §3 step 3b 実装要件 4 の受信側)。
  // cinny 自身の NativeCallEmbed は openCallView() の前に本物の ClientWidgetApi を構築するが、
  // このプロトタイプにはバックエンドが無くログイン画面より先に進めないため、この smoke は
  // NativeCallEmbed が本来やるはずのこと (claim + ClientWidgetApi 構築) を代わりに行う。
  // ClientWidgetApi が無いと EC からの supported_api_versions/capabilities リクエストに誰も
  // 応答せず、EC がローディング画面のまま進行しなくなる (実測で確認済み — shell-widget-host.js の
  // boot() が harness モードで同じ役割を果たしている理由と同じ)。iframe シム/driver は
  // shell-widget-host.js のものと同じ最小実装をこの page-context スクリプト文字列内に複製している
  // (executeJavaScript の文字列注入という制約上、モジュールとして共有require できないため)。
  await win.webContents.executeJavaScript(
    `(async () => {
      window.__selfmatrixShellSmoke = {
        transport: window.selfmatrixNative.claimWidgetTransport(),
        pushes: [],
      };
      window.__selfmatrixShellSmoke.unsubscribe = window.__selfmatrixShellSmoke.transport.onCallControlState(
        (pushedState) => { window.__selfmatrixShellSmoke.pushes.push(pushedState); },
      );

      if (!window.mxwidgets) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/vendor/matrix-widget-api.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("failed to load /vendor/matrix-widget-api.js"));
          document.head.appendChild(script);
        });
      }
      const mxwidgets = window.mxwidgets;
      const widget = new mxwidgets.Widget({
        id: ${JSON.stringify(WIDGET_ID)},
        creatorUserId: ${JSON.stringify(WIDGET_USER_ID)},
        type: "m.call",
        url: window.location.origin + "/public/element-call/index.html",
        waitForIframeLoad: false,
      });
      class NativeWidgetDriver extends mxwidgets.WidgetDriver {
        validateCapabilities(requested) {
          return Promise.resolve(new Set(requested));
        }
      }
      const driver = new NativeWidgetDriver();
      const shim = {
        contentWindow: {
          postMessage(message) { window.__selfmatrixShellSmoke.transport.sendToView(message); },
        },
        addEventListener() {},
        removeEventListener() {},
      };
      // new ClientWidgetApi(...) はコンストラクタ内で同期的に 'message' リスナー登録を完了する
      // (design §1.1)。以降の openCallView() 呼び出し (悪性 URL も含む、本物の EC ロードは
      // 起きなくても害はない) はすべてこの後に行われるため、順序不変条件を満たす。
      window.__selfmatrixShellSmoke.clientWidgetApi = new mxwidgets.ClientWidgetApi(widget, shim, driver);
      return true;
    })()`,
    true,
  );

  // 3. claim ガード: 2 回目の claimWidgetTransport() は throw する。
  const claimGuard = await win.webContents.executeJavaScript(
    `(() => {
      try {
        window.selfmatrixNative.claimWidgetTransport();
        return false;
      } catch (error) {
        return true;
      }
    })()`,
    true,
  );

  // 4. URL 検証ゲート: 悪性 URL 2 種 (別オリジン / EC base 外の同一オリジン path) が
  // openCallView() で reject され、call-view-url-rejected が main.cjs に記録され、実際には
  // ロードされない (call view が生成すらされない) ことを確認する。
  const maliciousUrls = {
    crossOrigin: `https://evil.selfmatrix.invalid/public/element-call/index.html?widgetId=${WIDGET_ID}`,
    sameOriginWrongPath: `${state.origin}/cinny/index.html?widgetId=${WIDGET_ID}`,
  };
  const urlValidationGate = {};
  for (const [label, badUrl] of Object.entries(maliciousUrls)) {
    const before = state.widgetMessages.length;
    const outcome = await win.webContents.executeJavaScript(
      `window.__selfmatrixShellSmoke.transport.openCallView(${JSON.stringify(badUrl)})
        .then(() => ({ rejected: false }))
        .catch((error) => ({ rejected: true, message: String(error && error.message ? error.message : error) }))`,
      true,
    );
    // state.widgetMessages/navigationEvents は生の (未サニタイズの) 値を保持している
    // (sanitizeEvidenceMessage() は evidence 書き出し時にだけ適用される) ので、ここでの照合も
    // 生の badUrl と比較する。表示用の url フィールドだけ sanitizeEvidenceString() を通す。
    const rejectionRecord = state.widgetMessages
      .slice(before)
      .find((message) => message.type === "call-view-url-rejected" && message.url === badUrl);
    const navigatedToBadUrl = state.navigationEvents.some((event) => event.url === badUrl);
    urlValidationGate[label] = {
      url: sanitizeEvidenceString(badUrl),
      rejectedByPromise: Boolean(outcome && outcome.rejected),
      rejectionRecorded: Boolean(rejectionRecord),
      navigatedToBadUrl,
      callViewCreated: state.callView !== null,
      pass:
        Boolean(outcome && outcome.rejected) &&
        Boolean(rejectionRecord) &&
        !navigatedToBadUrl &&
        state.callView === null,
    };
  }

  // 5. 正当な EC URL: /public/element-call/ エイリアス経由で組み立てる (/ec/ ではなくこちらを
  // 使うのは、エイリアス route を削除する変異にもこのテストが反応するようにするため — 実装要件の
  // 変異耐性節参照)。openCallView() が resolve し、EC からの content_loaded (from-view) が main に
  // 到達することを確認する。
  // M1 step 3c-1: parentPath は cinny が実際にロードされている場所 ("/", ルート直下) に合わせる
  // (win.loadURL() コメント参照)。
  const validUrl = buildLocalCallUrl({
    ecPath: "/public/element-call/index.html",
    parentPath: "/",
  });
  const validOpenOutcome = await win.webContents.executeJavaScript(
    `window.__selfmatrixShellSmoke.transport.openCallView(${JSON.stringify(validUrl)})
      .then(() => ({ resolved: true }))
      .catch((error) => ({ resolved: false, message: String(error && error.message ? error.message : error) }))`,
    true,
  );
  const sawContentLoaded = await waitForWidgetAction("content_loaded");
  const validOpenCallView = {
    resolved: Boolean(validOpenOutcome && validOpenOutcome.resolved),
    sawContentLoaded,
    pass: Boolean(validOpenOutcome && validOpenOutcome.resolved) && sawContentLoaded,
  };

  // 6. onCallControlState 配線: toggleTarget (ErrorView の CloseWidgetButton — step 2 の単体実証
  // 用の action。call-control-preload.cjs 冒頭コメント参照。実 in-call コントロールが無いこの環境で
  // 唯一実在する操作可能ターゲットなので、配線の実経路確認にそのまま流用する) を invoke し、
  // call view preload の MutationObserver push が main を経由して shell 窓の onCallControlState
  // リスナー (window.__selfmatrixShellSmoke.pushes) まで実際に届くことを確認する。
  const pushesBefore = await win.webContents.executeJavaScript(
    `window.__selfmatrixShellSmoke.pushes.length`,
    true,
  );
  // 実測 (runSmoke() の callControl.statePushes[].t - content_loaded.t) では EC が
  // ErrorView (Room not found) をマウントするまでに content_loaded から ~12.5 秒かかる
  // (WIDGET_BASE_URL が解決不能な `matrix.example.invalid` のため、EC 内部のネットワーク
  // タイムアウトを待つ形になっていると見られる)。runSmoke() ではこの前に detach/attach 等の
  // 待機がいくつも挟まるため実質の猶予が足りていたが、ここでは content_loaded 直後から
  // リトライを始めるため、確実に間に合うよう timeout を長めに確保する。
  const invokeOutcome = await waitForCallControlInvoke(20000, () =>
    win.webContents.executeJavaScript(
      `window.__selfmatrixShellSmoke.transport.callControlInvoke("toggleTarget")`,
      true,
    ),
  );
  await wait(500);
  const pushesAfter = await win.webContents.executeJavaScript(
    `window.__selfmatrixShellSmoke.pushes.length`,
    true,
  );
  const onCallControlStateWiring = {
    invokeOk: Boolean(invokeOutcome.result && invokeOutcome.result.ok),
    invokeError: invokeOutcome.error ? String(invokeOutcome.error.message || invokeOutcome.error) : null,
    lastInvokeResult: invokeOutcome.result,
    pushesBefore,
    pushesAfter,
    pass: Boolean(invokeOutcome.result && invokeOutcome.result.ok) && pushesAfter > pushesBefore,
  };

  // 7. (G3, 受け入れレビュー修正) NativeCallControlAction 7 語彙を全て実際に
  // transport.callControlInvoke() で invoke する。このプロトタイプにはバックエンドが無く、
  // EC は ErrorView (Room not found) しか描画しないため in-call UI (screenshare/spotlight/
  // emphasis/reactions/settings/sound の実コントロール) は存在しない — そのため各 action は
  // 例外を投げず `{ok:false, reason:"target_not_found"}` を返すのが正しい挙動。
  // call-control-preload.cjs の switch 分岐からその action の case が抜け落ちると default 節
  // (`{ok:false, reason:"unknown_action"}`) に落ちるため、reason が "unknown_action" になった
  // 場合は語彙の欠落 (=cinny 側の契約を満たしていない) と判定して FAIL にする。例外/タイムアウト
  // (invoke 自体が reject する) も FAIL にする。
  // 実際にセレクタが実 in-call DOM (real screenshare/spotlight/... コントロール) と一致し
  // ok:true になることの検証は、バックエンド接続後の実 EC UI を要する step 3c のスコープであり、
  // ここでは「語彙 (action 文字列) の到達性」のみを保証する。
  const vocabulary = {};
  for (const action of CALL_CONTROL_VOCABULARY) {
    let outcome;
    try {
      const invokeResult = await win.webContents.executeJavaScript(
        `window.__selfmatrixShellSmoke.transport.callControlInvoke(${JSON.stringify(action)})`,
        true,
      );
      outcome = { result: invokeResult, error: null };
    } catch (error) {
      outcome = { result: null, error: String(error && error.message ? error.message : error) };
    }
    const reason =
      outcome.result && typeof outcome.result === "object" ? outcome.result.reason : undefined;
    vocabulary[action] = {
      result: outcome.result,
      error: outcome.error,
      pass:
        outcome.error === null &&
        Boolean(outcome.result) &&
        outcome.result.ok === false &&
        reason === "target_not_found",
    };
  }
  const vocabularyPass = Object.values(vocabulary).every((entry) => entry.pass);

  // 8. (C1, GPT レビュー P1b 修正の回帰検証) closeCallView() → 同じ URL で openCallView() を
  // 再度呼び、通話を作り直しても call-control-preload.cjs の registerPreloadScript() 登録が
  // プロセス全体で 1 回のままであることを確認する (createCallViewIfNeeded() 冒頭のコメント参照)。
  // 修正前の実装 (早期 return 頼みだった版) では、この 2 回目の openCallView() で
  // callViewPreloadRegistrationCount が 2 になる — 実際にモジュールレベルのフラグを外す変異を
  // 当てて 2 になることを確認した (検証記録は完了報告参照)。main.cjs は runCinnyShellSmoke() と
  // 同一プロセス・同一モジュールスコープで動くため、IPC 越しの計装を新設せずモジュールスコープ変数
  // callViewPreloadRegistrationCount を直接読める。
  await win.webContents.executeJavaScript(
    `window.__selfmatrixShellSmoke.transport.closeCallView()`,
    true,
  );
  const secondOpenOutcome = await win.webContents.executeJavaScript(
    `window.__selfmatrixShellSmoke.transport.openCallView(${JSON.stringify(validUrl)})
      .then(() => ({ resolved: true }))
      .catch((error) => ({ resolved: false, message: String(error && error.message ? error.message : error) }))`,
    true,
  );
  const callViewPreloadRegistration = {
    registrationCount: callViewPreloadRegistrationCount,
    secondOpenResolved: Boolean(secondOpenOutcome && secondOpenOutcome.resolved),
    pass:
      callViewPreloadRegistrationCount === 1 && Boolean(secondOpenOutcome && secondOpenOutcome.resolved),
  };

  // 9. (C3, Fable レビュー #2 修正の回帰検証) mainWindow のナビゲーション封じ込めが効いていること。
  // webContents.loadURL() を main プロセスから直接呼ぶと (call view の G7 と同様) will-navigate 自体が
  // 発火しないため、代わりにページ内スクリプトから window.location.href への直接代入を行う —
  // これは「トップレベルページの遷移要求」としてブラウザ自身が起こすのと同じ経路であり、
  // createMainWindow() の will-navigate ハンドラが実際に発火する。preventDefault() でブロックされて
  // いれば別オリジンへは遷移しないはず。
  // 注意 (実測で判明): cinny は SPA なので起動シーケンス中に pushState/replaceState で自分の
  // ルートを書き換えることがあり、これは will-navigate の対象外 (このファイル冒頭のコメント参照)
  // なので `topFrameUrl` (手順 1 で取得した初回 URL) 自体は同一オリジン内でも変化し得る —
  // 「手順 1 の URL と完全一致し続けること」は cinny の正常な SPA ルーティングを偽陽性で
  // fail させてしまうため誤った判定基準だった。ここでは「別オリジンへは実際に遷移していない
  // (=同一オリジンのままである)」ことだけを見る。window.open() 側は setWindowOpenHandler が常に
  // {action:"deny"} を返すため、レンダラ側の window.open() 呼び出しは null を返す (about:blank を
  // 使い、http(s) 外部リンクの shell.openExternal() 分岐が実ブラウザを起動して smoke を
  // 不安定にしないようにしてある)。
  const crossOriginNavTarget = "https://evil.selfmatrix.invalid/pwned.html";
  const navBefore = state.widgetMessages.length;
  await win.webContents
    .executeJavaScript(`window.location.href = ${JSON.stringify(crossOriginNavTarget)}`, true)
    .catch(() => {});
  await wait(300);
  const navBlockedRecord = state.widgetMessages
    .slice(navBefore)
    .find((message) => message.type === "main-window-navigation-blocked" && message.url === crossOriginNavTarget);
  const windowOpenOutcome = await win.webContents
    .executeJavaScript(
      `(() => ({ popupIsNull: window.open("about:blank", "_blank") === null }))()`,
      true,
    )
    .catch((error) => ({ error: String(error && error.message ? error.message : error) }));
  const urlAfterNavAttempt = win.webContents.getURL();
  const topFrameStillSameOrigin = (() => {
    try {
      return new URL(urlAfterNavAttempt).origin === state.origin;
    } catch (error) {
      return false;
    }
  })();

  // B (M2 readiness レビュー修正、GPT 指摘 B の回帰検証): 上のクロスオリジン検証と同型で、
  // 「同一オリジンだが cinny の document ではない既知の配信先 (/ec/)」へのトップレベル遷移も
  // block されることを確認する。createMainWindow() の isAllowedMainWindowDocumentNavigation() が
  // same-origin かどうかだけで判定していた旧実装ではこのケースは許可されてしまっていた
  // (同一オリジンのため) — この smoke はその回帰を検知する。
  const sameOriginEcNavTarget = `${state.origin}/ec/index.html`;
  const ecNavBefore = state.widgetMessages.length;
  await win.webContents
    .executeJavaScript(`window.location.href = ${JSON.stringify(sameOriginEcNavTarget)}`, true)
    .catch(() => {});
  await wait(300);
  const ecNavBlockedRecord = state.widgetMessages
    .slice(ecNavBefore)
    .find((message) => message.type === "main-window-navigation-blocked" && message.url === sameOriginEcNavTarget);
  const urlAfterEcNavAttempt = win.webContents.getURL();

  const mainWindowNavigationContainment = {
    crossOriginNavAttemptedUrl: sanitizeEvidenceString(crossOriginNavTarget),
    crossOriginNavBlocked: Boolean(navBlockedRecord),
    topFrameStillSameOrigin,
    topFrameNotAtMaliciousUrl: urlAfterNavAttempt !== crossOriginNavTarget,
    windowOpenBlocked: Boolean(windowOpenOutcome && windowOpenOutcome.popupIsNull === true),
    sameOriginEcPathNavAttemptedUrl: sanitizeEvidenceString(sameOriginEcNavTarget),
    sameOriginEcPathNavBlocked: Boolean(ecNavBlockedRecord),
    sameOriginEcPathNotNavigated: urlAfterEcNavAttempt !== sameOriginEcNavTarget,
    pass:
      Boolean(navBlockedRecord) &&
      topFrameStillSameOrigin &&
      urlAfterNavAttempt !== crossOriginNavTarget &&
      Boolean(windowOpenOutcome && windowOpenOutcome.popupIsNull === true) &&
      Boolean(ecNavBlockedRecord) &&
      urlAfterEcNavAttempt !== sameOriginEcNavTarget,
  };

  const result = {
    pass:
      bridgePresent &&
      cinnyTopFrame &&
      contractSurfaceGate.pass &&
      homeserverConfigGate.pass &&
      Boolean(claimGuard) &&
      Object.values(urlValidationGate).every((check) => check.pass) &&
      validOpenCallView.pass &&
      onCallControlStateWiring.pass &&
      vocabularyPass &&
      callViewPreloadRegistration.pass &&
      mainWindowNavigationContainment.pass,
    bridgePresent,
    cinnyTopFrame,
    contractSurfaceGate,
    homeserverConfigGate,
    claimGuard,
    urlValidationGate: deepSanitizeEvidence(urlValidationGate),
    validOpenCallView,
    onCallControlStateWiring,
    vocabulary,
    callViewPreloadRegistration,
    mainWindowNavigationContainment,
    callViewState: state.callViewState,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    preloadErrors: state.preloadErrors,
    widgetMessages: deepSanitizeEvidence(state.widgetMessages),
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "cinny-shell-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  state.mainWindow?.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

// M1 step 3c-1: native-join.e2e.mjs (playwright-core の electronApp.evaluate()) がこの
// プロセス外から main プロセスの内部状態を読める窓口。main プロセスの `state`/`callView` は
// このモジュールのスコープ内変数であり、electronApp.evaluate() に渡す関数はこのプロセスの
// グローバルスコープで実行される (ただしモジュールスコープ変数へは直接触れない) ため、
// dev/E2E 限定でここだけ `global` 経由に橋渡しする。既存の全 smoke/cinny-shell-smoke パスは
// この窓口に一切依存しない (isE2ERealJoin でのみ有効化)。
function setupE2EIntrospection() {
  if (!isE2ERealJoin) return;
  global.__selfmatrixE2E = {
    // 主要な main 側状態のスナップショット (widgetMessages 等は生の値のまま — サニタイズは
    // e2e スクリプト側が証跡書き出し時に行う)。
    getSnapshot: () => ({
      origin: state.origin,
      callViewState: state.callViewState,
      // H1 (受け入れレビュー修正): state.callViewState (文字列) とは独立に、実際の contentView
      // 階層から逆算した "main" | "window" | "none"。computeCallViewAttachedTo() コメント参照。
      callViewAttachedTo: computeCallViewAttachedTo(),
      activeWidgetId: state.activeWidgetId,
      widgetMessages: state.widgetMessages,
      navigationEvents: state.navigationEvents,
      preloadErrors: state.preloadErrors,
      // M1 step 3c-3: native-callflow.e2e.mjs が call-control RPC 往復と state push 中継を
      // main プロセス内部から直接検証するために追加。
      callControlMessages: state.callControlMessages,
      // M1 step 3c-2: localStorage 契約ブリッジの実測記録 (call-control-preload.cjs が実際に
      // どのキーを primed したかの ack)。
      localStorageBridgeEvents: state.localStorageBridgeEvents,
      // M1 全体レビュー test-critical #3 対応 (通話跨ぎ回帰、native-callflow.e2e.mjs の
      // runCallRespawn()): C1 (GPT レビュー P1b) が固定した
      // 「registerPreloadScript() はプロセス全体を通して高々 1 回」という不変条件を、
      // 実際に 1 回通話が終わって再度参加した後も E2E から直接確認できるようにする。
      // cinny-shell-smoke は自分自身の内部 result オブジェクトでこれを見ているだけで
      // __selfmatrixE2E からは読めなかった (このコミットまでのギャップ)。
      callViewPreloadRegistrationCount,
      // M2 bounds sync (Fable 全体レビュー arch-major 解消): cinny から最後に届いた bounds
      // (適用の成否によらず、受理した生の値)、と適用履歴 (applyCallViewBoundsFromCinny() 参照)。
      callViewBoundsFromCinny: state.callViewBoundsFromCinny ?? null,
      callViewBoundsApplyLog: state.callViewBoundsApplyLog,
      // H1 と同じ方針 (state 文字列ではなく実体から逆算した積極的証拠): state.callView の
      // 実際の Electron View.getBounds()/getVisible() を直接読む。native-callflow.e2e.mjs の
      // boundsSync 検証はこれと cinny 自身の [data-call-embed-container] の
      // getBoundingClientRect() を突き合わせる (どちらも「シェルが実際に適用した値」/
      // 「cinny が実際に計算した値」であり、内部の state.callViewBoundsFromCinny だけを見ると
      // 「記録したが実際には setBounds() を呼んでいない」回帰を見逃す)。
      callViewActualBounds:
        state.callView && !state.callView.webContents.isDestroyed() ? state.callView.getBounds() : null,
      callViewVisible:
        state.callView && !state.callView.webContents.isDestroyed() ? state.callView.getVisible() : null,
    }),
    // call view (EC) の main world で任意の式を評価する。call view が無ければ ok:false を
    // 返すだけで例外にはしない (e2e スクリプト側のポーリングループが単純になる)。
    evalInCallView: async (code) => {
      if (!state.callView || state.callView.webContents.isDestroyed()) {
        return { ok: false, reason: "no_call_view" };
      }
      try {
        const value = await state.callView.webContents.executeJavaScript(code, true);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    },
    // M1 step 3c-1: BrowserWindow.capturePage() (mainWindow 自身) は addChildView() された
    // call view (別 WebContentsView) を合成してくれない (実測: cinny 自身の UI しか写らない) ので、
    // call view の実体を別画像として個別にキャプチャする専用ヘルパーを用意する。
    captureCallViewPng: async () => {
      if (!state.callView || state.callView.webContents.isDestroyed()) {
        return { ok: false, reason: "no_call_view" };
      }
      try {
        const image = await state.callView.webContents.capturePage();
        return { ok: true, base64: image.toPNG().toString("base64") };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    },
    // M1 step 3c-3: native-callflow.e2e.mjs が実 in-call コントロール 7 語彙を invoke する窓口。
    // cinny の実 NativeCallEmbed が既に claim 済みの transport をもう一度 claim することはできない
    // (claim-once) ため、E2E は main 側の invokeCallControl() 実体をここから直接呼ぶ (call view 側
    // で実行される内容は cinny 経由の呼び出しと完全に同一 — invokeCallControl() コメント参照)。
    invokeCallControl: async (action) => {
      try {
        const result = await invokeCallControl(action);
        return { ok: true, result };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    },
    // M1 step 3c-2 (窓移動無再接続の検証): main window ⇔ call window 間の再親子付けを直接駆動する。
    // 既存の window.selfmatrixNative.detachCallView()/attachCallView() (shell-preload.cjs 経由の
    // IPC) と全く同じ main 側の実体 (detachCallView()/attachCallView()) をそのまま呼ぶだけ —
    // WebContentsView 自体を作り直さない (createCallViewIfNeeded() の早期 return) ため、
    // 再親子付けはナビゲーション/再読み込みを一切伴わない。
    detachCallView: async () => {
      await detachCallView();
      return { ok: true, callViewState: state.callViewState };
    },
    attachCallView: async () => {
      await attachCallView();
      return { ok: true, callViewState: state.callViewState };
    },
    // M2 bounds sync (native-callflow.e2e.mjs の runBoundsSync() 用): mainWindow の content
    // サイズを直接変える。ウィンドウリサイズへの追従 (cinny の ResizeObserver → setPlacement() →
    // このプロセスの native:set-call-view-bounds) を実測するための駆動源。setContentSize() は
    // OS ネイティブのウィンドウ枠を除いた実描画領域を直接指定するため、電子window.resize と同じ
    // 実イベントが cinny のレンダラ側で発火する (実ユーザーのウィンドウリサイズと等価)。
    resizeMainWindow: (width, height) => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        return { ok: false, reason: "no_main_window" };
      }
      state.mainWindow.setContentSize(width, height);
      return { ok: true };
    },
  };
}

// M2 トレイ常駐の検証専用モード (--tray-probe)。OS のトレイの実クリック/右クリックは自動化
// できないため、ロジック本体 (close ハンドラ/トレイのクリックハンドラ/メニュー項目の click
// ハンドラ) を main プロセス内から直接呼んで機械的に検証する。他の run*() と同じく、最後に
// evidence を書いて app.exit() でライフサイクルを自己完結させる (window-all-closed からの
// app.quit() はこのモードでは無効化してある — 上の app.on("window-all-closed", ...) のコメント
// 参照)。
async function runTrayProbe() {
  const win = state.mainWindow;

  const trayCreated = Boolean(state.tray) && !state.tray.isDestroyed();

  // closeHidesWindow: 合成 emit ではなく本物の win.close() を呼ぶ。close ハンドラの
  // event.preventDefault() が外れる変異が入った場合、この呼び出しは実際にウィンドウを破棄して
  // しまう (window-all-closed も isTrayProbe を除外してあるので app.quit() は呼ばれず、この
  // プロセス自体は生き残る — 「破棄されてしまった」という事実だけを検知して FAIL を記録できる)。
  win.close();
  await wait(200);
  const closeHidesWindow = !win.isDestroyed() && win.isVisible() === false && app.isQuitting !== true;

  // contextMenuItems: 実際にトレイへ設定したのと同じ定義 (trayMenuTemplate()、状態を持たない
  // 純関数) をもう一度取得してラベル一覧を記録する。createTray() が使ったものと常に同じ形になる。
  const menuTemplate = trayMenuTemplate();
  const menuLabels = menuTemplate.map((item) => item.label ?? null);
  const contextMenuItems = {
    labels: menuLabels,
    containsOpenLabel: menuLabels.some((label) => typeof label === "string" && label.includes("開く")),
    containsQuitLabel: menuLabels.some((label) => typeof label === "string" && label.includes("終了")),
  };

  // trayClickShowsWindow: closeHidesWindow のステップで隠した (または壊れて破棄された)
  // ウィンドウに対し、トレイの click ハンドラそのもの (tray.on("click", handleTrayActivate) と
  // 全く同じ関数参照) を直接呼ぶ。破棄されている場合は win.isVisible() が例外を投げるため、
  // 安全側に倒して false のまま記録する。
  let trayClickShowsWindow = false;
  if (!win.isDestroyed()) {
    handleTrayActivate();
    await wait(100);
    trayClickShowsWindow = win.isVisible() === true;
  }

  // quitMenuReallyQuits: 「終了」メニュー項目の click ハンドラ (quitFromTray()) を直接呼ぶ。
  // 実プロセスを本当に殺す前に「app.isQuitting フラグが立ったか」「app.quit() が呼ばれたか」を
  // 確認したいので、app.quit() を一時的にスパイへ差し替えてから呼び、確認後に元へ戻す —
  // このモード自身の終了は末尾の app.exit() が担う (本物の app.quit() を素通しすると、
  // evidence を書き出す前にプロセスが終了しかねない)。
  const originalQuit = app.quit.bind(app);
  let quitWasCalled = false;
  app.quit = () => {
    quitWasCalled = true;
  };
  const quitItem = menuTemplate.find((item) => typeof item.label === "string" && item.label.includes("終了"));
  quitItem.click();
  app.quit = originalQuit;
  const quitMenuReallyQuits = quitWasCalled && app.isQuitting === true;

  const result = {
    // 記録するフィールドは全て pass の論理積に使う (記録専用の飾りフィールドは作らない)。
    pass:
      trayCreated &&
      closeHidesWindow &&
      contextMenuItems.containsOpenLabel &&
      contextMenuItems.containsQuitLabel &&
      trayClickShowsWindow &&
      quitMenuReallyQuits,
    trayCreated,
    closeHidesWindow,
    contextMenuItems,
    trayClickShowsWindow,
    quitMenuReallyQuits,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "tray-probe-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  state.tray?.destroy();
  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(path.join(cinnyDist, "index.html"))) {
    throw new Error(
      `Cinny dist not found: ${cinnyDist}\n` +
        // SelfMatrix M2: cinny の web ビルド (`npm run build`) は native シェル検出コードを
        // tree-shake で除去するため、この native シェルと組み合わせるには
        // `npm run build:native` (VITE_SELFMATRIX_NATIVE=true) でビルドした dist が必要
        // (README.md 「開発手順」参照)。
        "Build it first: in a sibling '../cinny' checkout, run 'npm run build:native' (output goes to '../cinny/dist'). Do NOT use plain 'npm run build' — it tree-shakes out the native bridge this shell requires.\n" +
        "Or point SELFMATRIX_CINNY_DIST at an existing build:native output directory.",
    );
  }
  if (!fs.existsSync(path.join(ecDist, "index.html"))) {
    throw new Error(
      `Element Call dist not found: ${ecDist}\n` +
        "Build it first: in a sibling '../element-call' checkout, run 'pnpm build:embedded' (output goes to '../element-call/dist').\n" +
        "Or point SELFMATRIX_EC_DIST at an existing build directory.",
    );
  }

  setupIpc();
  setupSourcePickerIpc();
  setupDisplayMediaHandler();
  setupE2EIntrospection();
  await startServer();
  createMainWindow();
  // M2 トレイ常駐: trayEnabled (本番起動、または --tray-probe) のときだけ生成する。
  // テスト/E2E モード (isSmoke/isMemoryProbe/isCinnyShellSmoke/isE2ERealJoin/isHarness) では
  // 呼ばれない (trayEnabled の定義参照)。
  if (trayEnabled) createTray();
  if (isSmoke) await runSmoke();
  if (isMemoryProbe) await runMemoryProbe();
  if (isCinnyShellSmoke) await runCinnyShellSmoke();
  if (isTrayProbe) await runTrayProbe();
}

function evidenceFileForMode() {
  if (isCinnyShellSmoke) return "cinny-shell-result.json";
  if (isMemoryProbe) return "memory-result.json";
  if (isTrayProbe) return "tray-probe-result.json";
  return "smoke-result.json";
}

if (app) {
  main().catch((error) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, evidenceFileForMode()),
      `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
      "utf8",
    );
    console.error(error);
    app.exit(1);
  });
} else if (require.main === module) {
  throw new Error("selfmatrix-desktop requires Electron. Use `electron src/main.cjs`.");
}
