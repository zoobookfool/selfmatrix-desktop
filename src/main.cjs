let electron = {};
try {
  electron = require("electron");
} catch (error) {
  if (require.main === module) throw error;
}
const {
  app,
  BrowserWindow,
  WebContentsView,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  shell,
  Tray,
  Menu,
  nativeImage,
  screen,
} = electron;
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
// 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2): ローカル制御 API のトークン生成
// (crypto.randomBytes) とトークン照合 (crypto.timingSafeEqual) に使う。--minisign-probe は同じ
// node:crypto を関数内 require で個別に取得している (署名検証専用の隔離された使い方) が、こちらは
// 常駐 HTTP サーバーの認証パスから高頻度に呼ばれるためモジュール冒頭で通常の require にしてある。
const crypto = require("node:crypto");

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

// M2 minisign 署名検証 (--minisign-probe 専用の require): verifyMinisign() 自体は Electron に
// 依存しない純関数だが、その prehashed (BLAKE2b-512) 経路が Electron のメインプロセス上でも実際に
// 正しく動くこと (= plain Node の probe だけでは検証できない、production ランタイム固有の懸念) を
// 確認するのがこの require の目的。runMinisignProbe() 内でのみ使う (require 自体はここで済ませて
// おく方が他の require と一貫する)。
const { verifyMinisign } = require("./minisign-verify.cjs");
const { blake2b512, NATIVE_BLAKE2B512_AVAILABLE } = require("./minisign-blake2b.cjs");

// M2 3b (electron-builder 同梱リソース化 + electron-updater 配線): design/release-pipeline.md §4/§7。
// verifyUpdateCodeSignature (minisign 検証フック本体、既に §3a で実装済みだったが electron-updater
// 未配線だったもの) と、その配線条件 (有効化/適用) を判定する Electron 非依存の純関数群。
// 二重実装を避ける方針は他の *.cjs 純関数モジュールと同じ (widget-bridge-protocol.cjs 等参照)。
const { MinisignNsisUpdater } = require("./minisign-nsis-updater.cjs");
const { runUpdateDownloadProbe } = require("./update-download-probe.cjs");
const { shouldEnableAutoUpdater, shouldApplyUpdateNow } = require("./update-apply-gate.cjs");
const { restoreWindowBounds } = require("./window-bounds.cjs");

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

// M2 minisign 署名検証: --minisign-probe は「Ed25519 検証 + BLAKE2b-512 (prehashed 既定方式) が
// Electron のメインプロセスが実際に同梱する node:crypto ランタイム上で正しく動く」ことを検証する
// 専用モード。plain node 上で走る src/minisign-verify-probe.cjs (npm test に既に組込済み) だけでは
// 足りない理由: plain Node は crypto.createHash('blake2b512') が使えるが、**Electron 43 が同梱する
// crypto にはこれが一切無い** (crypto.getHashes() が空配列を返す — 2026-07-09 実測)。そのため plain
// node の probe は常にネイティブ blake2b 経路を通り、production (Electron main、ネイティブ無し →
// minisign-blake2b.cjs のピュア JS フォールバック) と別のコードパスしか検証できていなかった。
// runMinisignProbe() は他の probe (smoke/tray-probe 等) と異なり、cinny/EC dist の存在確認や
// ウィンドウ/HTTP サーバーの起動を一切必要としない (verifyMinisign() は fs にすら触れない純粋な
// crypto 計算) ため、main() の重いブート経路には乗せず独立に実行する (下部の `if (app) {...}` 分岐
// 参照)。
const isMinisignProbe = process.argv.includes("--minisign-probe");

// M2 3b electron-updater 配線: --update-wiring-probe は「electron-updater の autoUpdater
// シングルトンに verifyUpdateCodeSignature フック (update-signature-verify.cjs) と
// allowDowngrade=false が実際に配線されていること」+「このプロセス (dev/unpacked、
// app.isPackaged===false) では checkForUpdatesAndNotify() が一切呼ばれない (外部通信させない)
// こと」を実測する専用モード。isMinisignProbe と同じ理由 (cinny/EC dist の存在確認や
// ウィンドウ/HTTP サーバーの起動を必要としない) で main() の重いブート経路には乗せず独立に実行する
// (下部の `if (app) {...}` 分岐、runUpdateWiringProbe() 参照)。
const isUpdateWiringProbe = process.argv.includes("--update-wiring-probe");

// 実 NsisUpdater の download task をローカル HTTP provider で駆動し、installer と sidecar
// `.minisig` の取得、正常署名の受理、署名欠落/改ざんの拒否を確認する。package:probe:update-download
// は同じモードを dist/win-unpacked/SelfMatrix.exe から起動し、製品同梱後の経路も検証する。
const isUpdateDownloadProbe = process.argv.includes("--update-download-probe");
const isSingleInstanceProbe = process.argv.includes("--single-instance-probe");

// M3 step 0 スパイク: 別窓 (callWindow) をユーザーが実際に閉じたとき、子 WebContentsView
// (= 生きた RTCPeerConnection) が無再接続でメインへ復帰できるかを実証する専用モード
// (design/m3-window-ux.md §3-1 の最大未検証リスク)。Docker/実バックエンドは不要 --
// 自己ループバックの RTCPeerConnection (src/m3-close-spike-test.html) を call view に
// loadURL() して「生きた通話中の WebContentsView」を再現し、その状態で実際に
// callWindow.close() (win.destroy() ではなく、実ユーザーの X ボタンと同じ 'close'→'closed' の
// イベント列を通す) を呼ぶ。runM3CloseSpikeProbe() 参照。
const isM3CloseSpike = process.argv.includes("--m3-close-spike");
// runM3CloseSpikeProbe() の対照実験 (旧 "closed" ハンドラ、現行 createCallWindow() の初期実装) は
// 意図的に無防備な attachCallView() 呼び出しを再現する (下記 createCallWindow() 参照)。子
// WebContentsView が本当に巻き込み破棄された場合、そこへの addChildView() 等が例外を投げる可能性が
// あり、素の呼び出し元 (win.on("closed", ...) は .catch を持たない fire-and-forget) では
// unhandledRejection になり得る。既定では Node はこれを警告出力するだけで平常続行するが、念のため
// このモードに限り明示的に捕捉して証跡へ積み、プロセスを絶対に道連れにしない (他モードの挙動は
// 一切変えない — isM3CloseSpike のときだけ登録)。
if (isM3CloseSpike) {
  process.on("uncaughtException", (error) => {
    state.m3SpikeAsyncErrors.push({
      t: Date.now(),
      type: "uncaughtException",
      // G6 と同じ方針 (preload-error 参照): stack ではなく message のみを保持する
      // (絶対パスを含み得るスタックトレースを証跡に残さないため)。
      error: String(error && error.message ? error.message : error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    state.m3SpikeAsyncErrors.push({
      t: Date.now(),
      type: "unhandledRejection",
      error: String(reason && reason.message ? reason.message : reason),
    });
  });
}

// M3 step 1/2 (design/m3-window-ux.md §2 サブステップ 1/2、契約拡張 + close=復帰 production 化 +
// 窓サイズ/位置記憶) の検証専用モード。runM3CloseSpikeProbe() (--m3-close-spike, 上) は「close-
// preserve 方式そのものが無再接続復帰を成立させるか」という step 0 の最大リスクの実測に特化して
// おり、popoutCallView()/popinCallView() の claim-once contract 経由の呼び出し (window.
// selfmatrixNative.claimWidgetTransport() → ipcRenderer.invoke() → main の IPC ハンドラ →
// detachCallView()/attachCallView())、onCallViewPlacement() push、callWindow の bounds 永続化は
// 対象外だった。runM3WindowProbe() はこれらの production 経路を実際に駆動して検証する
// (「記録だけ」を禁じるタスク要件どおり、直呼びではなく contract 経由で行う)。
const isM3WindowProbe = process.argv.includes("--m3-window-probe");
if (isM3WindowProbe) {
  process.on("uncaughtException", (error) => {
    state.m3WindowProbeAsyncErrors.push({
      t: Date.now(),
      type: "uncaughtException",
      error: String(error && error.message ? error.message : error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    state.m3WindowProbeAsyncErrors.push({
      t: Date.now(),
      type: "unhandledRejection",
      error: String(reason && reason.message ? reason.message : reason),
    });
  });
}

// 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1/§4.4、運用者確定要件
// 2026-07-12): グローバルホットキー/トレイ導線の検証専用モード。OS のグローバルホットキー実打鍵や
// トレイの実クリックは自動化できないため、tray-probe と同じ方針 (ロジック本体を main プロセス内から
// 直接呼んで機械的に検証する) を踏襲する。runExternalMuteProbe() 参照。
const isExternalMuteProbe = process.argv.includes("--external-mute-probe");

// 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2、運用者確定要件 2026-07-12
// 「A と B の両方を実装する」): localhost 制御 API (Node 組み込み http、127.0.0.1 のみ bind) の
// 検証専用モード。Stream Deck プラグインや自作スクリプトからの実接続は自動化しにくいため、
// isExternalMuteProbe と同じ方針で、この専用モードから実際に 127.0.0.1:<port> へ HTTP リクエストを
// 送って機械的に検証する (runExternalApiProbe() 参照)。選択肢 A と B は「引き金の生成元」だけが違い、
// triggerExternalMuteToggle() 以降の配送経路 (IPC → shell-preload.cjs → cinny) を完全に共有する
// (design §4.4) ため、cinny 側の変更は一切不要。
const isExternalApiProbe = process.argv.includes("--external-api-probe");

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
// M3 step 0 スパイク (--m3-close-spike) もここに加える: runM3CloseSpikeProbe() は自分の末尾で
// app.exit() を呼んでライフサイクルを自己管理する自己完結モードであり (tray-probe 等と同じ形)、
// close-to-tray やトレイ生成は不要 (むしろ callWindow.close() の実測を close-to-tray の横取りから
// 独立させたい)。
// 外部ミュート制御 (--external-mute-probe) も userData 隔離の対象に加える (isExternalMuteProbe の
// コメント参照)。決定的な検証のため実プロファイルの永続化ファイルに一切触れずに済ませたい —
// evidence/.test-userdata (.gitignore 済み) へ隔離することで、開発者の実ホットキー設定を読んでテスト
// 実行のたびに本物の OS グローバルホットキーを誤って登録する事故を防ぐ。
// 選択肢 B (--external-api-probe) も同じ理由で加える: 開発者の実 userData に外部制御 API のトークンが
// 生成されたり、テスト実行のたびに本物の 127.0.0.1 待受ポートが開いてしまう事故を防ぐ。
const isTestRunnerMode =
  isSmoke ||
  isMemoryProbe ||
  isCinnyShellSmoke ||
  isE2ERealJoin ||
  isHarness ||
  isM3CloseSpike ||
  isM3WindowProbe ||
  isExternalMuteProbe ||
  isExternalApiProbe ||
  isUpdateDownloadProbe ||
  isSingleInstanceProbe;
const trayEnabled = isTrayProbe || !isTestRunnerMode;

// グローバルホットキーの起動時自動適用 (applyExternalMuteHotkeyFromPersistedState()) は本番相当の
// 起動でのみ行う。tray-probe は isTestRunnerMode に含まれず (userData が実プロファイルのまま) 実運用
// の永続化ファイルを読んでしまうため、テスト実行のたびに本物の OS グローバルホットキーを登録して
// しまわないよう明示的に除外する。--external-mute-probe 自身は決定的な検証のため呼び出しタイミングを
// runExternalMuteProbe() 側で自分で管理する (main() からは自動的に呼ばない)。
const isExternalMuteHotkeyProductionRun = !isTestRunnerMode && !isTrayProbe;

// 選択肢 B: ローカル制御 API サーバーの起動時自動適用 (applyExternalApiFromPersistedState()) の
// 本番相当ゲート。isExternalMuteHotkeyProductionRun と全く同じ理由・同じ条件式 (tray-probe は実
// userData を読むが本物の待受ポートを勝手に開かせたくない、--external-api-probe 自身は
// runExternalApiProbe() 側で呼び出しタイミングを自己管理する)。
const isExternalApiProductionRun = !isTestRunnerMode && !isTrayProbe;

// M3 step 2 (窓サイズ/位置記憶): app.getPath("userData") は既定でこの OS ユーザーの実プロファイル
// ディレクトリ (例 Windows の %APPDATA%/SelfMatrix) を指す。callWindow の bounds 永続化
// (saveCallWindowState()/loadCallWindowState()、createCallWindow() 参照) はこの配下の JSON
// ファイルへ読み書きするため、無隔離のまま npm test 系のモードを実行すると開発者の実ユーザー
// プロファイルへ検証専用の残骸を書いてしまう (タスク要件「userData に書いたテスト残渣が無いこと」)。
// isTestRunnerMode (tray-probe/minisign-probe/update-wiring-probe は callWindow を一切扱わない
// ため対象外のままでよい) の間だけ userData を evidence/ 配下 (.gitignore 済み、コミットに紛れない)
// の使い捨てディレクトリへ差し替える。app.setPath() は app.whenReady() より前 (このモジュールの
// 同期評価時点) に呼ぶ必要があるため、ここ (isTestRunnerMode 定義直後、どの run*() 関数よりも前)
// で行う。
//
// **重要 (2 インスタンス衝突の回避)**: E2E ハーネス (native-join/native-callflow) は各 Electron
// インスタンスに `--user-data-dir=<mkdtemp>` を渡して userData を per-instance に隔離している。
// この固定パスへの setPath はその per-instance 隔離を上書きしてしまい、alice/bob 2 インスタンスが
// 同じ userData を共有 → 2 個目 (bob) の rust-crypto の IndexedDB/leveldb が 1 個目にロックされて
// cinny が「起動中です」で無限にストールする (実測で確認)。したがって `--user-data-dir` が既に
// 指定されている場合 (= E2E) はここで上書きしない — Electron がその dir を userData として使い、
// 実プロファイルからもインスタンス間からも隔離される。probe 系 (--user-data-dir なし) のときだけ
// evidence/.test-userdata へ隔離して実プロファイル汚染を防ぐ (probe は単一インスタンスなので衝突なし)。
const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
if (app && isTestRunnerMode && !hasExplicitUserDataDir) {
  app.setPath("userData", path.join(evidenceDir, ".test-userdata"));
}

// The lock is scoped by userData, so E2E instances with distinct --user-data-dir values remain
// independent. A normal second launch exits before it can create duplicate servers, windows, or tray state.
const hasSingleInstanceLock = app ? app.requestSingleInstanceLock() : false;
let focusRequestedBySecondInstance = false;
let secondInstanceEventCount = 0;
if (app && !hasSingleInstanceLock) app.exit(0);

// 外部ミュート制御検証 (--external-mute-probe) 専用: 決定的な検証のため、起動のたびに前回実行の
// 残留設定ファイルを消してから始める。evidence/.test-userdata は npm test の各モード間で使い回される
// ため (per-instance の mkdtemp ではない、上のコメント参照)、放置すると「既定 OFF」の検証が前回の
// ON 状態を引きずって偽 PASS/FAIL になる。ファイル名はこの下で定義する
// EXTERNAL_MUTE_HOTKEY_STATE_FILENAME と同一の文字列リテラルを直接使う (関数宣言はホイストされるが、
// このファイル名定数自体は `const` でホイストされないため、ここでは定数を参照せず直書きする)。
if (app && isExternalMuteProbe) {
  try {
    fs.unlinkSync(path.join(app.getPath("userData"), "external-mute-hotkey.json"));
  } catch (error) {
    // 初回実行 (ファイルがまだ存在しない) は正常系。それ以外の失敗もベストエフォートで無視する
    // (この後の runExternalMuteProbe() 側の各アサーションが不整合を検知する)。
  }
}

// 選択肢 B (--external-api-probe) 専用: 上と全く同じ理由で、前回実行が残したトークン/有効化状態
// (external-mute-api.json) を起動のたびに消してから始める。ファイル名はこの下で定義する
// EXTERNAL_API_STATE_FILENAME と同一の文字列リテラルを直接使う理由も上のブロックと同じ (const は
// ホイストされない)。
if (app && isExternalApiProbe) {
  try {
    fs.unlinkSync(path.join(app.getPath("userData"), "external-mute-api.json"));
  } catch (error) {
    // 初回実行 (ファイルがまだ存在しない) は正常系。
  }
}

// M2 3b electron-updater 配線: shouldEnableAutoUpdater() (update-apply-gate.cjs) の isTestMode
// 引数に渡す「これはテスト/検証専用の起動か」の判定。isTestRunnerMode に加えて isTrayProbe/
// isMinisignProbe/isUpdateWiringProbe も含める -- どのモードで実行しても
// checkForUpdatesAndNotify() が外部 (GitHub Releases) へ通信することは絶対に無いようにする
// (テストモードでは更新チェックを一切走らせない、というタスクの絶対条件)。実際には
// app.isPackaged が dev 実行では常に false なので shouldEnableAutoUpdater() はこのフラグを見るまでも
// なく false になるが、将来 dev ビルドを exe化して検証する変更が入っても二重に安全側へ倒すための
// 明示ガード。
const isUpdaterTestMode = isTestRunnerMode || isTrayProbe || isMinisignProbe || isUpdateWiringProbe;

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
  // M3 step 0 スパイク: callWindow を実際に close() する検証であり、画面上に一瞬でも実ウィンドウが
  // 出ることを避けたい (test-run-preferences と同じ運用者方針) ので同じ扱いに加える。
  // M3 step 1/2 検証 (--m3-window-probe) も同じ理由 (callWindow の popout/resize/close を実際に
  // 駆動する) で加える。
  // 外部ミュート制御検証 (--external-mute-probe) も同じ理由 (実 mainWindow.webContents へ実際に
  // IPC を届けて受信を確認する) で加える。
  // 選択肢 B (--external-api-probe) も同じ理由 (127.0.0.1 の実 HTTP サーバー経由で同じ
  // mainWindow.webContents へ IPC を届けて受信を確認する) で加える。
  if (
    !isE2ERealJoin &&
    !isMemoryProbe &&
    !isTrayProbe &&
    !isM3CloseSpike &&
    !isM3WindowProbe &&
    !isExternalMuteProbe &&
    !isExternalApiProbe
  )
    return {};
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

// M2 デスクトップ通知 (通知クリック→前面化): mainWindow の main world (cinny 自身のバンドルが
// 動くコンテキスト) へ dom-ready のたびに注入する window.Notification ラッパ。cinny は Web
// Notification API (`new Notification(...)`) を呼ぶだけで、Electron がそれを自動的に OS ネイティブ
// 通知へ変換する (main.cjs はこの変換自体には一切関与しない、Electron 標準の挙動)。ここで足りて
// いないのは「その通知がクリックされたら selfmatrix-desktop 側でウィンドウを前面化する」導線であり、
// Web Notification の 'click' イベントは通知を生成したレンダラ (=このウィンドウ) 側でしか観測でき
// ない。
//
// cinny 側のコードは一切変更しない (契約 window.selfmatrixNative も広げない、README の絶対条件)。
// 代わりに E2E_RTC_WRAPPER_SCRIPT と全く同じ手法 (Proxy でコンストラクタを包み、生成された各
// インスタンスへ追加の addEventListener を足す) を使う: contextIsolation 下では preload の
// isolated world から window.Notification を直接上書きしても main world (cinny 自身のバンドルが
// 実際に new Notification() する場所) には反映されない (E2E_RTC_WRAPPER_SCRIPT のコメント参照) ため、
// dom-ready 後に webContents.executeJavaScript() で main world へ直接注入する必要がある。
// 追加するのは「既存の (cinny 自身が設定するかもしれない) onclick 等はそのままに、常にもう 1 つ
// click リスナーを足す」だけなので、cinny 自身の通知まわりの挙動 (onclick で室へジャンプする等) を
// 上書き/破壊しない。
//
// contextIsolation 下で main world から main プロセスへ直接 IPC する手段は無い (ipcRenderer は
// preload の isolated world だけが持つ) ため、window.postMessage() で同一オリジンの window 自身へ
// 折り返す -- shell-preload.cjs 側 (isolated world) がこのフレームに対して window 'message'
// リスナーを登録しておき、そこから ipcRenderer.send("native:notification-click") で main プロセスへ
// 中継する (これも native:widget-from-view の逆方向で、既に確立済みの
// postMessage ブリッジパターンを踏襲しているだけ)。この postMessage 経路は window.selfmatrixNative
// の contextBridge 公開面には一切現れない、完全に内部実装の合図。
const NOTIFICATION_CLICK_MESSAGE_TYPE = "selfmatrix:notification-click";
const NOTIFICATION_CLICK_BRIDGE_SCRIPT = `(() => {
  if (window.__selfmatrixNotificationBridgeInstalled) return;
  window.__selfmatrixNotificationBridgeInstalled = true;
  const NativeNotification = window.Notification;
  if (!NativeNotification) return;
  const Wrapped = new Proxy(NativeNotification, {
    construct(target, args) {
      const notification = new target(...args);
      try {
        notification.addEventListener("click", () => {
          window.postMessage({ type: ${JSON.stringify(NOTIFICATION_CLICK_MESSAGE_TYPE)} }, window.location.origin);
        });
      } catch (error) {
        // ベストエフォート -- ここで失敗しても cinny 自身の通知表示/onclick を壊してはならない。
      }
      return notification;
    },
  });
  window.Notification = Wrapped;
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
  // M2 3b electron-updater 配線: autoUpdater の 'update-downloaded' が発火済みかどうか
  // (setupAutoUpdater()/maybeApplyPendingUpdate() 参照)。ダウンロード + minisign 検証まで完了して
  // いても、通話中はこのフラグが true になるだけで quitAndInstall() は呼ばれない。
  updateReady: false,
  // M2 3b electron-updater 配線: maybeCheckForUpdates() が実際に有効化条件を満たしたかどうかの
  // 診断用スナップショット (--update-wiring-probe / evidence 用)。
  autoUpdaterEnabled: false,
  // M3 step 0 スパイク (--m3-close-spike) 専用: uncaughtException/unhandledRejection の捕捉先
  // (isM3CloseSpike の process.on() 登録箇所参照)。他モードでは常に空のまま。
  m3SpikeAsyncErrors: [],
  // M3 step 1/2 検証 (--m3-window-probe) 専用: 同上、isM3WindowProbe の process.on() 登録箇所参照。
  m3WindowProbeAsyncErrors: [],
  // M3 step 1 (契約拡張): claimWidgetTransport() が返す onCallViewPlacement() 購読の main 側実体。
  // detachCallView()/attachCallView()/closeCallView() が計算した computeCallViewAttachedTo() を
  // ここへ積む診断ログ (evidence/probe 用。実際の push 配信は state.mainWindow.webContents.send()
  // が担う — pushCallViewPlacement() 参照)。
  callViewPlacementPushLog: [],
  // 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1): globalShortcut.register() が
  // 実際に成功したアクセラレータ文字列 (例 "Ctrl+Alt+M")。未登録時は null。トレイの「ホットキー」
  // サブメニューの checkbox の checked はこの値 (「実際に登録されているか」の実測) から導出する
  // (永続化ファイルの enabled フラグだけを見ると、register() 失敗時に無言で食い違う — 運用者確定
  // 要件 3 の「無言で効かない状態を作らない」に対応)。プリセット切替時に「旧アクセラレータを
  // unregister する」ためにも使う (どの文字列で登録されているかを main プロセス自身が把握しておく
  // 必要がある)。
  externalMuteHotkeyRegisteredAccelerator: null,
  // 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2): 実際に listen() へ成功した
  // http.Server インスタンス。未起動時は null。トレイの「外部制御 API」サブメニューの checkbox の
  // checked はこの値 (「実際に listen できているか」の実測) から導出する -- externalMuteHotkeyRegisteredAccelerator
  // と同じ理由 (永続化ファイルの enabled だけを見ると、EADDRINUSE 等の listen() 失敗時に無言で
  // 食い違う)。
  externalApiServer: null,
  // 選択肢 B のレート制限 (design §5.2): 認証失敗の連続回数と、ロックアウト解除時刻 (Date.now() の
  // ミリ秒、0 は「ロックアウト中でない」の意味)。認証成功のたびに 0 へリセットされる
  // (authorizeExternalApiRequest() 参照)。
  externalApiConsecutiveAuthFailures: 0,
  externalApiLockoutUntil: 0,
};

// M2 bounds sync: state.callViewBoundsApplyLog の保持上限 (evidence/メモリの肥大化防止。
// E2E のリサイズ連打でも十分な履歴が残る件数)。
const CALL_VIEW_BOUNDS_LOG_LIMIT = 200;

if (app && hasSingleInstanceLock) {
  app.on("second-instance", () => {
    secondInstanceEventCount += 1;
    focusRequestedBySecondInstance = true;
    if (app.isReady()) handleTrayActivate();
  });

  app.on("window-all-closed", () => {
    // M2 トレイ常駐: tray-probe もここに加える。runTrayProbe() は意図的に mainWindow.close() を
    // 呼んで close-to-tray の挙動を実測する (preventDefault() が外れる変異が入ると、この close()
    // は本当にウィンドウを破棄してしまう)。ここで app.quit() してしまうと、evidence を書き出す前に
    // プロセスごと終了してしまい、変異を「検知して FAIL を記録する」ことができなくなる —
    // 他の run*() 系モードと同じく、tray-probe も自分の run 関数 (runTrayProbe()) の末尾で
    // app.exit() を明示的に呼んでライフサイクルを自己管理する。M3 step 0 スパイクも同じ理由で加える
    // (runM3CloseSpikeProbe() が callWindow.close() を実際に呼ぶため、mainWindow が生き残っていても
    // 万一 window-all-closed が発火した場合に evidence 書き出し前で終了させないための保険)。
    // runM3WindowProbe() (--m3-window-probe) も同じ理由 (popoutCallView()/close=復帰の実駆動) で除外。
    // runExternalMuteProbe() (--external-mute-probe) も同じ理由 (自分の末尾で app.exit() を呼んで
    // ライフサイクルを自己管理する) で除外する。
    // runExternalApiProbe() (--external-api-probe) も同じ理由で除外する。
    if (
      !isSmoke &&
      !isMemoryProbe &&
      !isCinnyShellSmoke &&
      !isTrayProbe &&
      !isM3CloseSpike &&
      !isM3WindowProbe &&
      !isExternalMuteProbe &&
      !isExternalApiProbe
    )
      app.quit();
  });

  // 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1、運用者確定要件 2026-07-12
  // 項目4): アプリ終了時に登録済みのグローバルホットキーを必ず解放する。globalShortcut は
  // プロセスが本当に終了すれば OS 側でも自然に解放されるが、「無言で放置しない」の一環として明示的に
  // unregisterAll() する。isSmoke 等の run*Probe() 系は自分の末尾で app.exit() (will-quit を発火
  // させない強制終了) を呼ぶため、runExternalMuteProbe() 側でも同じ後始末を個別に行う
  // (このハンドラだけに依存しない、同ファイル該当コメント参照)。
  // 選択肢 B: 同じ理由でローカル制御 API サーバーも必ず close() する (待受ポートを開いたまま
  // プロセスだけ終了する状態を作らない)。
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopExternalApiServer();
  });
}

// selfmatrix-desktop is developed alongside sibling checkouts of cinny and
// element-call (see README "開発手順"). The default artifact locations are
// therefore resolved relative to this repository's own location
// (<repo>/../cinny/dist, <repo>/../element-call/dist), not to any
// per-machine home directory layout -- this repo is public and must not
// assume a particular developer's folder structure. Set SELFMATRIX_CINNY_DIST
// / SELFMATRIX_EC_DIST to override (absolute or relative to cwd).
//
// M2 3b (electron-builder 同梱リソース化): 上の sibling 解決は **dev/E2E 限定** (app.isPackaged
// === false のときだけ)。製品パッケージ (electron-builder --dir/--win で作った exe、
// app.isPackaged === true) では兄弟ディレクトリ自体が存在しない (README の sibling checkout は
// 開発者のワークスペース構成であり、配布物には含まれない) ため、代わりに electron-builder.yml の
// extraResources が process.resourcesPath 直下に平積みした同梱リソース
// (`<resourcesPath>/cinny-dist`, `<resourcesPath>/ec-dist` -- electron-builder.yml の
// extraResources.to 参照) を見る。dev 分岐の判定式・既定パス・SELFMATRIX_*_DIST 環境変数による
// 上書きはどちらのモードでも一切変更していない (dev/E2E の挙動を壊さないことがこのタスクの
// 絶対条件)。
const PACKAGED_ARTIFACT_DIR_NAMES = Object.freeze({
  SELFMATRIX_CINNY_DIST: "cinny-dist",
  SELFMATRIX_EC_DIST: "ec-dist",
});

function resolveArtifact(envName, relativeParts) {
  if (process.env[envName]) return path.resolve(process.env[envName]);
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, PACKAGED_ARTIFACT_DIR_NAMES[envName]);
  }
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
    if (url.pathname === "/m3-close-spike-test.html") {
      // M3 step 0 スパイク (--m3-close-spike) 専用: 実バックエンド不要の自己ループバック
      // RTCPeerConnection テストページ (desktop-shell.html と同じ静的配信パターン)。
      // runM3CloseSpikeProbe() 以外のモードではこのパスへ到達すること自体が無い。
      serveFile(response, path.join(__dirname, "m3-close-spike-test.html"));
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
  // M2 デスクトップ通知: dom-ready のたびに Notification ラッパを main world へ注入する
  // (NOTIFICATION_CLICK_BRIDGE_SCRIPT のコメント参照)。E2E_RTC_WRAPPER_SCRIPT の注入パターンと
  // 同じ理由で dom-ready を使う -- cinny のバンドルが実際に new Notification() する (通知を出す)
  // よりずっと前に、確実に先回りして注入を終わらせる。cinny/harness どちらのトポロジでも
  // (mainWindow が読み込む文書が何であれ) 常時注入する -- Notification が一度も使われなければ
  // 完全に無害 (window.Notification が無ければ即 return する、スクリプト側のガード参照)。
  // 実測で発覚 (このコミット): このリスナー登録は必ず win.loadURL() より **前** でなければならない
  // -- createCallViewIfNeeded() の dom-ready リスナー登録がロード前に済んでいるのと同じ理由で、
  // 後ろに置くと初回ナビゲーションの dom-ready をレース的に取りこぼす (実機で
  // bridgeInstalled:false を確認済み、tray-probe の notificationClickFocusesWindow で検知できる)。
  win.webContents.on("dom-ready", () => {
    win.webContents.executeJavaScript(NOTIFICATION_CLICK_BRIDGE_SCRIPT, true).catch((error) => {
      state.widgetMessages.push({
        t: Date.now(),
        type: "notification-click-bridge-inject-error",
        error: String(error && error.message ? error.message : error),
      });
    });
  });

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

// M3 step 2 (design/m3-window-ux.md §4「窓サイズ/位置の永続化」、依存追加なし): callWindow の
// bounds ({x,y,width,height}) を app.getPath("userData") 配下の JSON ファイルへ保存/復元する。
// isTestRunnerMode では userData 自体が evidence/.test-userdata へ隔離済み (isTestRunnerMode
// 定義直後の app.setPath() 呼び出し参照) なので、この関数自体はテスト/本番を区別しない。
const CALL_WINDOW_STATE_FILENAME = "call-window-state.json";
// resize/move イベントは連続発火する (ドラッグ中は毎フレーム) ため、そのたびに同期 fs 書き込みを
// 行うと無駄が大きい。最後のイベントから既定時間だけ静止したら 1 回だけ書き込む単純なデバウンス。
const CALL_WINDOW_STATE_SAVE_DEBOUNCE_MS = 400;

function callWindowStateFilePath() {
  return path.join(app.getPath("userData"), CALL_WINDOW_STATE_FILENAME);
}

// 保存されていない/壊れている/不正な値であれば null を返す (呼び出し元はその場合に既定値へ
// フォールバックする) — 永続化ファイルは信頼された自分自身の過去の書き込みだが、手動編集や
// 他バージョンとの互換性崩れに対しても main プロセスを落とさない、という他の入力検証
// (validateCallViewBounds() 等) と同じ fail-safe 方針を踏襲する。
function loadCallWindowState() {
  try {
    const raw = fs.readFileSync(callWindowStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const { x, y, width, height } = parsed;
    const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  } catch (error) {
    return null;
  }
}

function restorableCallWindowBounds(savedBounds) {
  if (!savedBounds || isTestRunnerMode) return savedBounds;
  const primaryDisplay = screen.getPrimaryDisplay();
  const workAreas = [
    primaryDisplay.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primaryDisplay.id)
      .map((display) => display.workArea),
  ];
  return restoreWindowBounds(savedBounds, workAreas);
}

let callWindowStateSaveTimer = null;
function saveCallWindowState(bounds) {
  if (callWindowStateSaveTimer) clearTimeout(callWindowStateSaveTimer);
  callWindowStateSaveTimer = setTimeout(() => {
    callWindowStateSaveTimer = null;
    try {
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(callWindowStateFilePath(), `${JSON.stringify(bounds, null, 2)}\n`, "utf8");
    } catch (error) {
      // ベストエフォート -- 永続化の失敗 (書き込み権限等) で通話/ウィンドウ操作自体を止めない。
      state.widgetMessages.push({
        t: Date.now(),
        type: "call-window-state-save-error",
        error: String(error && error.message ? error.message : error),
      });
    }
  }, CALL_WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

// M3 LATER 項目「通話の別窓の最前面ピン留め」(運用者が実装 GO、design/m3-window-ux.md では
// LATER 扱いだった)。bounds (上記 CALL_WINDOW_STATE_FILENAME) とは別ファイルに分離する —
// bounds は resize/move のたびに高頻度で発火しデバウンス書き込みするのに対し、この設定は
// トレイメニューのクリックでしか変わらない稀な離散イベントであり、同じファイルに相乗りさせると
// resize/move 側の保存のたびにこの値を読み直して merge する処理が要る (さもないとデバウンス
// タイマーの競合で上書き消失し得る)。ファイルを分けることで両者は互いに影響しない。
const CALL_WINDOW_ALWAYS_ON_TOP_FILENAME = "call-window-always-on-top.json";

function callWindowAlwaysOnTopStateFilePath() {
  return path.join(app.getPath("userData"), CALL_WINDOW_ALWAYS_ON_TOP_FILENAME);
}

// loadCallWindowState() と同じ fail-safe 方針: 保存されていない/壊れている/不正な値であれば
// 既定値 (false = OFF) へフォールバックする。
function loadCallWindowAlwaysOnTopEnabled() {
  try {
    const raw = fs.readFileSync(callWindowAlwaysOnTopStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && parsed.alwaysOnTop === true;
  } catch (error) {
    return false;
  }
}

// saveCallWindowState() と異なりデバウンスしない -- こちらは resize/move のような連続イベントでは
// なく、トレイメニューのクリック 1 回につき高々 1 回しか呼ばれないため、デバウンスする理由がない。
function saveCallWindowAlwaysOnTopEnabled(enabled) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      callWindowAlwaysOnTopStateFilePath(),
      `${JSON.stringify({ alwaysOnTop: enabled }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    // ベストエフォート -- 永続化の失敗 (書き込み権限等) でトレイのトグル操作自体を止めない。
    state.widgetMessages.push({
      t: Date.now(),
      type: "call-window-always-on-top-save-error",
      error: String(error && error.message ? error.message : error),
    });
  }
}

// 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1、運用者確定要件 2026-07-12)。
//
// 既定キーバインドの選定理由 (運用者確定要件 1): 運用者の当初の例示は「右Shift+M」だったが、
// Electron の globalShortcut は accelerator の左右修飾キーを区別できない仕様
// (https://www.electronjs.org/docs/latest/api/accelerator) のため「右Shift」だけを狙って登録する
// ことができない。素の "Shift+M" も採用できない -- 修飾キー無しの Shift+M は OS 全体で大文字 M の
// 入力そのもの (他の全アプリのテキスト入力中の Shift+M) を横取りしてしまい実用に耐えない。そのため
// 既定は他アプリと衝突しにくい "Ctrl+Alt+M" 系の組み合わせにする。
//
// プリセット切替 (2026-07-12 運用者要件変更): トレイの「ホットキー」サブメニューから 4 択で切替
// できるようにする。F13/F14 を選択肢に含めるのは、物理キーボードにはほぼ存在せず (Stream Deck や
// 一部の拡張キーボード以外では実キー入力と衝突しない)、かつ Stream Deck の標準「Hotkey」システム
// アクションが仮想的に送出できるキーだから -- Discord ユーザーが F13〜F24 系の余りキーを
// グローバルホットキーに使う慣習 (design/external-mute-control.md §3.2) と同じ発想。
const EXTERNAL_MUTE_HOTKEY_PRESETS = Object.freeze([
  { id: "ctrl+alt+m", accelerator: "Ctrl+Alt+M", radioLabel: "Ctrl+Alt+M" },
  { id: "ctrl+shift+m", accelerator: "Ctrl+Shift+M", radioLabel: "Ctrl+Shift+M" },
  { id: "f13", accelerator: "F13", radioLabel: "F13 (Stream Deck 向け)" },
  { id: "f14", accelerator: "F14", radioLabel: "F14 (Stream Deck 向け)" },
]);
const DEFAULT_EXTERNAL_MUTE_HOTKEY_PRESET_ID = "ctrl+alt+m";
// 運用者要件変更 (2026-07-12): 既定は OFF。ユーザーがトレイから明示的に ON にする。
const DEFAULT_EXTERNAL_MUTE_HOTKEY_STATE = Object.freeze({
  enabled: false,
  preset: DEFAULT_EXTERNAL_MUTE_HOTKEY_PRESET_ID,
});

function findExternalMuteHotkeyPreset(presetId) {
  return (
    EXTERNAL_MUTE_HOTKEY_PRESETS.find((preset) => preset.id === presetId) ||
    EXTERNAL_MUTE_HOTKEY_PRESETS.find((preset) => preset.id === DEFAULT_EXTERNAL_MUTE_HOTKEY_PRESET_ID)
  );
}

// callWindowAlwaysOnTopStateFilePath() と同じ「別ファイルに分離」方針 (bounds のような高頻度書き込み
// と混ぜない) を踏襲するが、こちらはそもそも高頻度書き込みが存在しない設定なので単純にトピックで
// 分けているだけ -- 「有効/無効」と「選択プリセット」の両方を同じ 1 ファイルにまとめて持つ
// (どちらもトレイメニューのクリック 1 回につき高々 1 回しか変わらない離散イベントで、頻度の非対称が
// 無いため分離する理由が無い)。
const EXTERNAL_MUTE_HOTKEY_STATE_FILENAME = "external-mute-hotkey.json";

function externalMuteHotkeyStateFilePath() {
  return path.join(app.getPath("userData"), EXTERNAL_MUTE_HOTKEY_STATE_FILENAME);
}

// loadCallWindowState()/loadCallWindowAlwaysOnTopEnabled() と同じ fail-safe 方針: 保存されていない/
// 壊れている/不正な値であれば既定値へフォールバックする (プリセット ID が現行の 4 択に無い場合も
// 同様、将来プリセットを削除/改名した場合の互換性のため)。
function loadExternalMuteHotkeyState() {
  try {
    const raw = fs.readFileSync(externalMuteHotkeyStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ...DEFAULT_EXTERNAL_MUTE_HOTKEY_STATE };
    const enabled = parsed.enabled === true;
    const presetIsKnown = EXTERNAL_MUTE_HOTKEY_PRESETS.some((preset) => preset.id === parsed.preset);
    const presetId = presetIsKnown ? parsed.preset : DEFAULT_EXTERNAL_MUTE_HOTKEY_PRESET_ID;
    return { enabled, preset: presetId };
  } catch (error) {
    return { ...DEFAULT_EXTERNAL_MUTE_HOTKEY_STATE };
  }
}

// saveCallWindowAlwaysOnTopEnabled() と同じくデバウンスしない (トレイメニューのクリック 1 回につき
// 高々 1 回しか呼ばれない離散イベント)。
function saveExternalMuteHotkeyState(nextState) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      externalMuteHotkeyStateFilePath(),
      `${JSON.stringify(nextState, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    // ベストエフォート -- 永続化の失敗 (書き込み権限等) でトレイのトグル/切替操作自体を止めない。
    state.widgetMessages.push({
      t: Date.now(),
      type: "external-mute-hotkey-save-error",
      error: String(error && error.message ? error.message : error),
    });
  }
}

// design/external-mute-control.md §4.4「配送経路の後半」: 引き金 (ホットキー callback / トレイの
// アクション項目「マイクミュート切り替え」の click) は必ずこの 1 関数に集約する。main プロセスは
// 「押されたことを検知する」役割に徹し、実際のミュート操作は cinny (mainWindow の renderer) 側の
// callEmbedAtom 経由の toggleMicrophone() に委譲する (design §4.1)。将来の選択肢 B (ローカル制御 API)
// もこの同じ関数を再利用する前提の構造 -- 引き金の種類が増えても、この集約点は増やさない。
function triggerExternalMuteToggle() {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send("native:external-mute-toggle");
  }
}

// globalShortcut.register() の戻り値 (成功/失敗) を必ず確認する (design §4.1: 「アクセラレータが
// 既に他アプリに取られている場合はサイレントに失敗する」という Electron の仕様上の挙動があるため)。
// 成功時のみ state.externalMuteHotkeyRegisteredAccelerator を更新する -- 失敗時は「登録されていない」
// ままにしておくことで、トレイの checkbox の checked (この値から導出) が実態と食い違わない。
function registerExternalMuteHotkey(accelerator) {
  const ok = globalShortcut.register(accelerator, triggerExternalMuteToggle);
  if (ok) {
    state.externalMuteHotkeyRegisteredAccelerator = accelerator;
  } else {
    // 運用者確定要件 3: 「無言で効かない状態を作らない」-- 最低限 console へ warn する。
    console.warn(
      `[external-mute] globalShortcut.register("${accelerator}") failed ` +
        "(likely already taken by another app or the OS). External mute hotkey stays disabled.",
    );
  }
  return ok;
}

function unregisterExternalMuteHotkeyIfRegistered() {
  const accelerator = state.externalMuteHotkeyRegisteredAccelerator;
  if (accelerator) {
    globalShortcut.unregister(accelerator);
    state.externalMuteHotkeyRegisteredAccelerator = null;
  }
}

// main() 起動時に一度だけ呼ばれる (isExternalMuteHotkeyProductionRun のときだけ、定義箇所コメント
// 参照)。永続化されている enabled が true のときだけ実際に登録を試みる (既定 OFF なので初回起動時は
// 何もしない)。
function applyExternalMuteHotkeyFromPersistedState() {
  const persisted = loadExternalMuteHotkeyState();
  if (!persisted.enabled) return;
  const preset = findExternalMuteHotkeyPreset(persisted.preset);
  const ok = registerExternalMuteHotkey(preset.accelerator);
  if (!ok) {
    // 登録失敗時は永続化状態も false に落とし、次回起動時に「ON のはずなのに効いていない」という
    // 混乱を残さない (運用者確定要件 3)。
    saveExternalMuteHotkeyState({ enabled: false, preset: preset.id });
  }
}

// トレイの「ホットキー」サブメニュー内 checkbox 項目「ミュート: <プリセット>」の click ハンドラ本体
// (運用者確定要件 3)。現在値は毎回永続化ファイルから実測して反転させる (toggleAutoLaunch()/
// toggleCallWindowAlwaysOnTop() と同じ流儀)。
function toggleExternalMuteHotkeyEnabled() {
  const persisted = loadExternalMuteHotkeyState();
  const preset = findExternalMuteHotkeyPreset(persisted.preset);
  if (persisted.enabled) {
    unregisterExternalMuteHotkeyIfRegistered();
    saveExternalMuteHotkeyState({ enabled: false, preset: preset.id });
    return;
  }
  const ok = registerExternalMuteHotkey(preset.accelerator);
  // register() が失敗した場合は enabled:false のまま永続化する (運用者確定要件 3、
  // registerExternalMuteHotkey() のコメント参照)。
  saveExternalMuteHotkeyState({ enabled: ok, preset: preset.id });
}

// トレイの「ホットキー」サブメニュー内プリセット (radio) 項目の click ハンドラ本体 (2026-07-12
// 運用者要件変更)。ON 状態で切り替える場合は旧アクセラレータを unregister してから新アクセラレータを
// register する -- 失敗時は checkbox 側と同じく enabled を false に落として warn する
// (registerExternalMuteHotkey() が既に warn する)。OFF 状態なら選択の保存のみ行う。
function selectExternalMuteHotkeyPreset(presetId) {
  const persisted = loadExternalMuteHotkeyState();
  if (persisted.preset === presetId) return;
  const nextPreset = findExternalMuteHotkeyPreset(presetId);
  if (!persisted.enabled) {
    saveExternalMuteHotkeyState({ enabled: false, preset: nextPreset.id });
    return;
  }
  unregisterExternalMuteHotkeyIfRegistered();
  const ok = registerExternalMuteHotkey(nextPreset.accelerator);
  saveExternalMuteHotkeyState({ enabled: ok, preset: nextPreset.id });
}

// ============================================================================
// 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2、運用者確定要件 2026-07-12
// 「A と B の両方を実装する」): localhost 制御 API。
//
// v1 でできること (design §4.2「公開する操作の範囲を無害な通話コントロールのみに絞る」):
//   - POST /v1/mute-toggle: 認証 OK なら triggerExternalMuteToggle() (選択肢 A のホットキー
//     callback/トレイのアクション項目と全く同じ関数) を呼ぶ。マイクミュートのトグル 1 操作のみ。
//   - GET  /v1/ping: ペアリング疎通確認用 (認証必須)。
// 現在のミュート状態の取得/push (状態フィードバック) は v1 スコープ外 -- 選択肢 C (公式 Stream Deck
// プラグイン) 検討時に再訪する (design §4.3、状態 push があるとボタンの見た目を状態に追従できる)。
//
// 引き金の生成元が違うだけで、triggerExternalMuteToggle() 以降 (main→renderer IPC → cinny の
// callEmbedAtom 経由の toggleMicrophone()) は選択肢 A と完全に共有する (design §4.4)。cinny 側の
// 変更が一切不要なのはこのため。
// ============================================================================

// 127.0.0.1 のみ bind する固定既定ポート。IANA の dynamic/private port 範囲 (49152-65535、
// https://www.iana.org/assignments/service-names-port-numbers/) の中から選ぶことで、
// レジストリ登録済みのサービス (obs-websocket の既定 4455 等) や開発でよく使われるポート
// (3000/5173/8080 等) との衝突を避ける。可変にする要件はない (LATER: 設定 UI で変更可能にする案は
// design §4.2 のスコープ外) ため、定数 1 つで足りる。
const EXTERNAL_API_DEFAULT_PORT = 58471;

// design §5.2「認証失敗の連続に対するレート制限/一時ロックアウトを設け、総当たりを遅くする」。
// EXTERNAL_API_LOCKOUT_DURATION_MS は `let` で宣言し、runExternalApiProbe() が決定的な検証のため
// テスト実行中だけ短縮値へ一時的に差し替えられるようにしてある (triggerExternalMuteToggle() の
// 一時差し替えパターンと同じ考え方 -- 本番の 60 秒ロックアウトをテストのたびに実際に待つのは
// 現実的でない)。
const EXTERNAL_API_LOCKOUT_THRESHOLD = 5;
let EXTERNAL_API_LOCKOUT_DURATION_MS = 60_000;

// external-mute-hotkey.json と同じ流儀の別ファイル (design §4.2「A の external-mute-hotkey.json と
// 同じ流儀の別ファイル」)。トピックが違う (こちらは認証トークン + API 有効化フラグ) ので分離する。
const EXTERNAL_API_STATE_FILENAME = "external-mute-api.json";
const DEFAULT_EXTERNAL_API_STATE = Object.freeze({ enabled: false, token: null });

function externalApiStateFilePath() {
  return path.join(app.getPath("userData"), EXTERNAL_API_STATE_FILENAME);
}

// loadExternalMuteHotkeyState() と同じ fail-safe 方針 (壊れている/存在しないファイルは既定値へ)。
function loadExternalApiState() {
  try {
    const raw = fs.readFileSync(externalApiStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ...DEFAULT_EXTERNAL_API_STATE };
    const enabled = parsed.enabled === true;
    const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
    return { enabled, token };
  } catch (error) {
    return { ...DEFAULT_EXTERNAL_API_STATE };
  }
}

function saveExternalApiState(nextState) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(externalApiStateFilePath(), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  } catch (error) {
    // ベストエフォート -- 永続化の失敗 (書き込み権限等) でトレイの操作自体を止めない
    // (saveExternalMuteHotkeyState() と同じ方針)。
    state.widgetMessages.push({
      t: Date.now(),
      type: "external-api-state-save-error",
      error: String(error && error.message ? error.message : error),
    });
  }
}

// design §4.2「アプリ初回起動時にランダムなトークンを生成し...」。base64url は URL/HTTP ヘッダの
// どちらに出しても追加のエスケープが要らない (Stream Deck プラグイン設定画面への貼り付け UX にも
// 有利)。32 バイト (256 bit) はブルートフォースに対して十分な長さ (obs-websocket のパスワードより
// 十分長い、design §4.2 のトークン方式の水準に合わせる)。
function generateExternalApiToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// 未生成なら生成して永続化する (トレイの「有効化」checkbox ON / 「トークンをコピー」の両方から
// 呼ばれる、絶対条件「初回有効化時にランダムトークン生成」)。既に生成済みならそれをそのまま返す
// (再生成は regenerateExternalApiToken() の責務、こちらは非破壊)。
function ensureExternalApiToken() {
  const persisted = loadExternalApiState();
  if (persisted.token) return persisted.token;
  const token = generateExternalApiToken();
  saveExternalApiState({ ...persisted, token });
  return token;
}

// トレイの「トークンを再生成」click ハンドラ本体。新トークンを生成・保存する -- 保存後は
// handleExternalApiRequest() が毎リクエスト loadExternalApiState() で最新のトークンを読むため
// (キャッシュしない、下のコメント参照)、サーバー再起動なしに旧トークンは即座に失効する。
function regenerateExternalApiToken() {
  const persisted = loadExternalApiState();
  const token = generateExternalApiToken();
  saveExternalApiState({ ...persisted, token });
  return token;
}

// design §4.2「単純な固定トークンの平文比較でも一定の防御にはなるが、タイミング攻撃を避けるため
// crypto.timingSafeEqual 等の定数時間比較を使う」。
//
// 絶対条件「長さ差でも早期 return しない形に注意」への対応: crypto.timingSafeEqual() は 2 つの
// Buffer の長さが異なると RangeError を投げる仕様のため、素朴な実装は「まず .length を比較し、
// 違えば早期 return する」形になりがちだが、それ自体が「候補トークンの長さ」をタイミングで漏らす
// (別のサイドチャネル)。ここでは比較の前に両方を SHA-256 (32 byte 固定長) へハッシュ化してから
// timingSafeEqual() へ渡すことで、候補トークンの実際の長さに一切依存しない一定長の比較になる
// (長さの分岐が構造的に存在しない)。
//
// `function` 宣言 (const ではない) にしてあるのは、変異ゲート検証 (runExternalApiProbe() の
// mutationGate) がこの関数だけを一時的に「常に true を返す」実装へ差し替え、(c) の
// 「誤トークンは 401」というアサーションが実際に FAIL することを実測してから復元するため
// (triggerExternalMuteToggle の一時差し替えパターンと同じ、外部ミュート制御選択肢 A の
// d_mutationGate 参照)。
function tokensMatch(candidateToken, storedToken) {
  if (typeof candidateToken !== "string" || typeof storedToken !== "string") return false;
  const candidateHash = crypto.createHash("sha256").update(candidateToken, "utf8").digest();
  const storedHash = crypto.createHash("sha256").update(storedToken, "utf8").digest();
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

// design §5.2「認証失敗の連続に対するレート制限」。認証成功で 0 へリセットする
// (authorizeExternalApiRequest() 参照)。
function registerExternalApiAuthFailure() {
  state.externalApiConsecutiveAuthFailures += 1;
  if (state.externalApiConsecutiveAuthFailures >= EXTERNAL_API_LOCKOUT_THRESHOLD) {
    state.externalApiLockoutUntil = Date.now() + EXTERNAL_API_LOCKOUT_DURATION_MS;
    // design §5.2「無音でずっと悪用され続ける状態を避ける」への対応。認証成功済みトークンでは
    // 絶対に届かない値 (トークンそのもの) は一切ログへ出さない。ミリ秒のまま出す (秒へ丸めると
    // runExternalApiProbe() が検証中だけ使う短縮値 (数百 ms) が「0 秒間」と表示され誤解を招くため)。
    console.warn(
      `[external-api] ${EXTERNAL_API_LOCKOUT_THRESHOLD} 回連続で認証に失敗したため、` +
        `${EXTERNAL_API_LOCKOUT_DURATION_MS}ms 間ロックアウトします。`,
    );
  }
}

function resetExternalApiAuthFailures() {
  state.externalApiConsecutiveAuthFailures = 0;
}

// 1 リクエストぶんの認証パイプライン。呼び出し順序がそのままチェックの優先順位:
//   1. レート制限 (ロックアウト中は正しいトークンでも 429 -- design §5.2)
//   2. Origin ヘッダ (design §4.2「ブラウザ経由の到達阻止」: 存在するだけで一律 403、トークンの
//      正誤を問わない -- ブラウザの drive-by JS は Origin を必ず送るが Node スクリプトや
//      Stream Deck プラグインは通常送らない)
//   3. トークン認証 (tokensMatch()、定数時間比較)
// 戻り値: { ok: true } または { ok: false, status, code }。
function authorizeExternalApiRequest(request) {
  if (state.externalApiLockoutUntil > 0 && Date.now() < state.externalApiLockoutUntil) {
    return { ok: false, status: 429, code: "rate_limited" };
  }
  if (typeof request.headers.origin === "string") {
    return { ok: false, status: 403, code: "forbidden_origin" };
  }
  const persisted = loadExternalApiState();
  const authHeader = request.headers.authorization;
  const BEARER_PREFIX = "Bearer ";
  const candidateToken =
    typeof authHeader === "string" && authHeader.startsWith(BEARER_PREFIX)
      ? authHeader.slice(BEARER_PREFIX.length)
      : "";
  if (!persisted.token || !tokensMatch(candidateToken, persisted.token)) {
    registerExternalApiAuthFailure();
    return { ok: false, status: 401, code: "unauthorized" };
  }
  resetExternalApiAuthFailures();
  return { ok: true };
}

function sendExternalApiJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// v1 の公開ルート一覧 (design §4.2「公開する操作の範囲を無害な通話コントロールのみに絞る」)。
// key: pathname, value: 期待する HTTP method。パス自体が未知なら 404、既知だが method が違えば
// 405 -- 絶対条件「それ以外のパス/メソッドは 404/405」。
const EXTERNAL_API_ROUTES = Object.freeze({
  "/v1/ping": "GET",
  "/v1/mute-toggle": "POST",
});

// selfmatrix-desktop のローカル制御 API 本体。127.0.0.1 のみ bind するサーバー (既存の
// startServer() が cinny/EC 静的ファイルを配信するのとは完全に別の http.Server インスタンス --
// 混ぜると製品配信用サーバーの攻撃面が広がってしまうため、意図的に分離してある)。
function handleExternalApiRequest(request, response) {
  // POST の場合、body を読まずに応答してもソケットが壊れることがあるため明示的に drain する
  // (v1 のルートはどちらも request body を一切解釈しない -- 認証はヘッダのみで完結する)。
  request.resume();

  const url = new URL(request.url, `http://127.0.0.1:${EXTERNAL_API_DEFAULT_PORT}`);
  const expectedMethod = EXTERNAL_API_ROUTES[url.pathname];
  if (expectedMethod === undefined) {
    sendExternalApiJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  if (request.method !== expectedMethod) {
    sendExternalApiJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const authResult = authorizeExternalApiRequest(request);
  if (!authResult.ok) {
    sendExternalApiJson(response, authResult.status, { ok: false, error: authResult.code });
    return;
  }

  if (url.pathname === "/v1/ping") {
    sendExternalApiJson(response, 200, { ok: true });
    return;
  }
  // url.pathname === "/v1/mute-toggle" (EXTERNAL_API_ROUTES に列挙された 2 択のうち残る 1 つ)。
  // design §4.4「配送経路は A と共有する」: 選択肢 A のホットキー callback/トレイのアクション項目と
  // 全く同じ triggerExternalMuteToggle() を呼ぶだけ -- ここから先 (main→renderer IPC 以降) は
  // 1 行も選択肢 A と変わらない。
  triggerExternalMuteToggle();
  sendExternalApiJson(response, 200, { ok: true });
}

// design §4.1「登録失敗のハンドリングが必須」と同じ考え方をローカル制御 API にも適用する:
// server.listen() の EADDRINUSE 等の失敗をサイレントに握りつぶさず、console.warn した上で
// Promise<false> を返す (呼び出し元がトレイの checkbox を false のままにできるようにする)。
function startExternalApiServer(port) {
  if (state.externalApiServer) return Promise.resolve(true); // 既に起動済みなら冪等に成功扱い。
  return new Promise((resolve) => {
    const server = http.createServer(handleExternalApiRequest);
    const onListenError = (error) => {
      // 絶対条件「衝突時は EADDRINUSE は console warn + メニューのチェックを外し、無言で
      // 「効かない」状態を作らない」。
      console.warn(
        `[external-api] server.listen(${port}, "127.0.0.1") に失敗しました ` +
          `(${error && error.code ? error.code : error})。外部制御 API は無効のままです。`,
      );
      resolve(false);
    };
    server.once("error", onListenError);
    // design §4.2「127.0.0.1 にのみバインドした...0.0.0.0/LAN 待ち受けは行わない」。host 引数を
    // 明示することが唯一の要件 (省略すると Node は全インターフェースへ bind する)。
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onListenError);
      state.externalApiServer = server;
      resolve(true);
    });
  });
}

// close() 自体は「新規接続の受け付け停止」を同期的に行うが、実際に OS 側がポートを解放し終える
// タイミングは 'close' イベント (全接続終了後) まで確定しない。同一プロセス内で close() 直後に
// 同じポートへ listen() し直す経路 (トグル ON→OFF→ON、runExternalApiProbe() の再起動相当シミュレーション
// h) では、この確定を待たずに次の listen() を呼ぶと新しいソケットへの初回接続が ECONNRESET になる
// ことを実機で確認したため、'close' イベントまで待ってから resolve する Promise を返す。呼び出し元が
// await しなくても (fire-and-forget) 実害はない (production の OFF トグルや will-quit はこの完了を
// 待つ必要が薄い) が、再 listen() の前段では必ず await すること。
function stopExternalApiServer() {
  const server = state.externalApiServer;
  state.externalApiServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// main() 起動時に一度だけ呼ばれる (isExternalApiProductionRun のときだけ、定義箇所コメント参照)。
// applyExternalMuteHotkeyFromPersistedState() と同じ形: 永続化されている enabled が true のときだけ
// 実際に listen() を試みる (既定 OFF なので初回起動時は何もしない)。
async function applyExternalApiFromPersistedState() {
  const persisted = loadExternalApiState();
  if (!persisted.enabled) return;
  const ok = await startExternalApiServer(EXTERNAL_API_DEFAULT_PORT);
  if (!ok) {
    // 登録失敗時は永続化状態も false に落とし、次回起動時に「ON のはずなのに効いていない」という
    // 混乱を残さない (applyExternalMuteHotkeyFromPersistedState() と同じ方針)。
    saveExternalApiState({ ...persisted, enabled: false });
  }
}

// トレイの「外部制御 API」サブメニュー内 checkbox 項目「有効化 (ポート <番号>)」の click ハンドラ
// 本体。toggleExternalMuteHotkeyEnabled() と同じ形 (現在値は毎回永続化ファイルから実測して反転
// させる) だが、listen() が非同期のため async にしてある -- 呼び出し元 (trayMenuTemplate() の
// click) は完了後に refreshTrayMenu() を呼んで checkbox の見た目 (state.externalApiServer の実測
// 値から導出) を最新化する。
async function toggleExternalApiEnabled() {
  const persisted = loadExternalApiState();
  if (persisted.enabled) {
    await stopExternalApiServer();
    saveExternalApiState({ ...persisted, enabled: false });
    return;
  }
  const token = ensureExternalApiToken();
  const ok = await startExternalApiServer(EXTERNAL_API_DEFAULT_PORT);
  // listen() が失敗した場合は enabled:false のまま永続化する (startExternalApiServer() が既に
  // console.warn する、registerExternalMuteHotkey() と同じ方針)。
  saveExternalApiState({ enabled: ok, token });
}

// トレイの「トークンをコピー」click ハンドラ本体。トークン未生成なら生成してからコピーする
// (絶対条件どおり)。Electron の clipboard はシステムクリップボードへ書くだけで、main.cjs はここでも
// トークンの値をログへ出さない。
function copyExternalApiToken() {
  const token = ensureExternalApiToken();
  clipboard.writeText(token);
}

const EXTERNAL_API_SUBMENU_LABEL = "外部制御 API";
const EXTERNAL_API_COPY_TOKEN_LABEL = "トークンをコピー";
const EXTERNAL_API_REGENERATE_TOKEN_LABEL = "トークンを再生成";

function externalApiEnableMenuLabel() {
  return `有効化 (ポート ${EXTERNAL_API_DEFAULT_PORT})`;
}

// M3 step 1 (design §3-5「placement 状態の逆方向 push」): call view の attach 先
// ("main" | "window" | "none"、computeCallViewAttachedTo() が実contentView階層から逆算する値) を
// mainWindow (shell-preload.cjs 経由で cinny) へ push する。detachCallView()/attachCallView()/
// closeCallView() のいずれもユーザー操作 (⧉ ボタン等) 経由とは限らない — 別窓をユーザーが X ボタンで
// 閉じたときの close=復帰 (createCallWindow() の "close" ハンドラ→attachCallView()) は cinny 側が
// 何も呼んでいないのに main 側で勝手に attach が起きる経路であり、cinny UI (⧉ ボタンの状態・
// 「別窓表示中」表示) を実状態に追従させるにはこの push が必須 (onCallControlState とは別チャンネル、
// nativeBridge.ts の onCallViewPlacement() 契約コメント参照)。
function pushCallViewPlacement() {
  const placement = computeCallViewAttachedTo();
  state.callViewPlacementPushLog.push({ t: Date.now(), placement });
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send("native:call-view-placement", placement);
  }
}

// M3 step 3 (design/m3-window-ux.md §3-3): EC フッターの出し分け (別窓=表示 / メイン埋め込み=
// 非表示、Discord 準拠)。pushCallViewPlacement() (mainWindow/cinny 宛て) とは受け手が異なる別
// チャンネル -- こちらは call view (EC) 自身の call-control-preload.cjs 宛て
// (native:set-footer-visible、call-control-preload.cjs 冒頭のフッター節参照)。call view が
// 無い/破棄済みなら何もしない (次に openCallView() が新しい call view を作った際は
// call-control-preload.cjs 側の既定値 (footerVisible=false=hidden) が「常に attached から
// 始まる」invariant と一致しているため、push を取りこぼしても見え方は食い違わない)。
function pushCallViewFooterVisibility() {
  if (!state.callView || state.callView.webContents.isDestroyed()) return;
  const visible = state.callViewState === "detached";
  state.callView.webContents.send("native:set-footer-visible", visible);
}

// M3 step 0 スパイク (design/m3-window-ux.md §3-1): 別窓を**ユーザーが実際に閉じた**ときの挙動。
// `options.closeMode` で 2 方式を切り替えられる (runM3CloseSpikeProbe() が両方を実測して比較する
// ためだけの引数 -- 本番の唯一の呼び出し元 detachCallView() は常に省略、既定の "close-preserve" を
// 使う)。
//
//   - "close-preserve" (既定、design §3-1 の推奨方式、M3 step 0 スパイクで実証済み): 破棄前・
//     キャンセル可能な "close" イベントで event.preventDefault() → attachCallView() で子
//     WebContentsView をメインへ退避 → 退避完了後に win.destroy() で実際に破棄する。
//     mainWindow の close-to-tray (createMainWindow() の "close" ハンドラ) と同型のパターン。
//     callViewState が "detached" のとき (= このウィンドウが実際に call view を持っているとき) に
//     限って横取りする -- 退出ボタン押下 (closeCallView()) が窓 close とほぼ同時のレースでは、
//     closeCallView() が先に callViewState を "none" に落としていれば何もせず通常どおり破棄させる
//     (design §3-1 論点 2)。
//   - "closed-legacy" (対照専用、旧実装をそのまま再現): 破棄後・キャンセル不可の "closed" で
//     attachCallView() を試みるだけ。M3 step 0 スパイク以前の実装そのもの -- Electron が子
//     WebContentsView を親ウィンドウの破棄に巻き込む場合、ここに到達した時点で既に破棄されており
//     無再接続復帰が成立しない、という仮説を実測するための対照。意図的に無防備 (attachCallView() の
//     失敗を捕捉しない) なままにしてある -- 捕捉してしまうと「現行コードがそのまま踏む経路」を
//     忠実に再現できなくなる。isM3CloseSpike 実行時のみ登録されるプロセスレベルの
//     uncaughtException/unhandledRejection ハンドラ (このファイル冒頭、isM3CloseSpike 定義直後)
//     がこの経路の例外を握ってプロセスを道連れにしないようにする。
function createCallWindow(options = {}) {
  const closeMode = options.closeMode === "closed-legacy" ? "closed-legacy" : "close-preserve";
  // M3 step 2 (窓サイズ/位置記憶): 前回保存された bounds があれば既定の 960x640/中央配置の代わりに
  // それを初期値として使う。savedBounds の x/y は e2eOffscreenBrowserWindowOptions() の spread が
  // このオブジェクトリテラルで後勝ちする (下記 ...e2eOffscreenBrowserWindowOptions() の位置に注意) ため、
  // テスト/E2E モードでは savedBounds.x/y があっても画面外配置が必ず優先される — savedBounds.width/
  // height だけは e2eOffscreenBrowserWindowOptions() が触れないフィールドなのでそのまま活きる
  // (「窓サイズ読み戻し」検証はこのプロパティで成立する)。
  const savedBounds = restorableCallWindowBounds(loadCallWindowState());
  const win = new BrowserWindow({
    title: "SelfMatrix Call",
    width: 960,
    height: 640,
    ...(savedBounds
      ? { x: savedBounds.x, y: savedBounds.y, width: savedBounds.width, height: savedBounds.height }
      : {}),
    show: !isSmoke,
    // E2E (--e2e-real-join) 専用: mainWindow と同じ理由で画面外座標に開く (detach/popout 検証
    // (windowMoveReparenting) 中もこの別窓が画面内に現れないようにするため)。savedBounds よりも
    // 後ろに置くことで x/y を確実に上書きする (上のコメント参照)。
    ...e2eOffscreenBrowserWindowOptions(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // createMainWindow() と同じ理由 (上のコメント参照) で常時無効化する。
      backgroundThrottling: false,
    },
  });
  // 通話の別窓の最前面ピン留め: 生成のたびに永続化済みの設定を読み直して適用する -- popout→popin→
  // 再 popout のたびにこの関数は新しい BrowserWindow を作り直す (close ハンドラが
  // state.callWindow = null にする、下記コメント参照) ので、生成時点で毎回読み直さないと 2 回目
  // 以降の別窓に設定が引き継がれない。mainWindow には適用しない (この設定は callWindow 専用)。
  win.setAlwaysOnTop(loadCallWindowAlwaysOnTopEnabled());
  win.on("resize", () => {
    updateCallViewBounds();
    if (!win.isDestroyed()) saveCallWindowState(win.getBounds());
  });
  // M3 step 2: 位置変更は call view の bounds (全面追従、updateCallViewBounds() 参照) には影響しない
  // ので updateCallViewBounds() は呼ばない — 永続化だけを行う。
  win.on("move", () => {
    if (!win.isDestroyed()) saveCallWindowState(win.getBounds());
  });
  if (closeMode === "closed-legacy") {
    win.on("closed", () => {
      state.callWindow = null;
      if (state.callView) attachCallView();
    });
  } else {
    win.on("close", (event) => {
      // close=メイン復帰は detached (別窓で表示中) のときだけ発火する。attached/none のときは
      // 通常のクローズに任せる (closeCallView()/hangup による通話終了経路と競合させないための
      // 状態機械ガード、design §3-2)。この "!==" を反転すると復帰が壊れることを step5 の
      // 変異テスト B で実証済み (native-callflow.e2e.mjs runCloseWindowMainRevert)。
      if (state.callViewState !== "detached" || !state.callView) return;
      event.preventDefault();
      attachCallView()
        .catch((error) => {
          state.widgetMessages.push({
            t: Date.now(),
            type: "call-window-close-attach-error",
            error: String(error && error.message ? error.message : error),
          });
        })
        .finally(() => {
          state.callWindow = null;
          if (!win.isDestroyed()) win.destroy();
        });
    });
    win.on("closed", () => {
      // 保険 (上の "close" ハンドラが preventDefault() し損ねた場合や、OS/アプリ終了経由で直接
      // 破棄された場合でも state.callWindow を必ず追従させる)。
      state.callWindow = null;
    });
  }
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

// M2 3b electron-updater 配線 (design/release-pipeline.md §4/§7)。
//
// 「通話中」の定義: state.callViewState !== "none"。call view が存在する (attached/detached
// いずれか -- attachCallView()/detachCallView() のどちらでも通話自体は継続中) 限り true。
// closeCallView() が通話終了時に必ず state.callViewState = "none" を設定する (同関数末尾参照)。
function isCallActive() {
  return state.callViewState !== "none";
}

// SelfMatrix 専用 NsisUpdater を実際に構築するのはこの関数を呼んだときだけ。main() と
// runUpdateWiringProbe() の両方から呼ばれるため冪等にし、イベントリスナーも重複登録しない。
let autoUpdaterInstance = null;

function setupAutoUpdater() {
  if (autoUpdaterInstance) return autoUpdaterInstance;

  const autoUpdater = new MinisignNsisUpdater();
  // allowDowngrade 無効 (design/release-pipeline.md §4): 古い改造版へのダウングレード誘導を防ぐ。
  autoUpdater.allowDowngrade = false;
  // SelfMatrix は full NSIS installer だけを配布する。web installer の package payload まで別経路で
  // 取得する構成は minisign gate の対象を曖昧にするため、明示的に禁止する。
  autoUpdater.disableWebInstaller = true;
  // installer と sidecar `.minisig` のダウンロード + MinisignNsisUpdater 内の検証まで完了したら
  // 準備完了フラグを立てる
  // だけで、ここでは quitAndInstall() を呼ばない -- 実際に適用してよいかは
  // maybeApplyPendingUpdate() が通話中かどうかを見てから判断する (§7 の核心)。
  autoUpdater.on("update-downloaded", () => {
    state.updateReady = true;
    maybeApplyPendingUpdate();
  });
  autoUpdaterInstance = autoUpdater;
  return autoUpdater;
}

// 通話が終了した (closeCallView()) タイミング、および update-downloaded イベントの両方から呼ばれる。
// 「ダウンロード済みの更新があり、かつ今は通話中でない」ときだけ実際に quitAndInstall() する
// (design/release-pipeline.md §7: 通話中は quitAndInstall を呼ばない → 通話終了後 or 次回起動時に
// 適用)。次回起動時の適用は electron-updater の既定 (autoInstallOnAppQuit) が自然なアプリ終了時に
// カバーする -- ここで明示的に扱うのは「通話が終わった直後に、ユーザーを煩わせず自動で再起動して
// 適用する」攻めのケースだけ。判定ロジック自体は shouldApplyUpdateNow() (update-apply-gate.cjs、
// Electron 非依存の純関数、--update-wiring-probe と probe:update-apply-gate の両方で全分岐検証済み)
// に委譲し、ここでは実際の quitAndInstall() 呼び出しという副作用だけを持つ。
function maybeApplyPendingUpdate() {
  if (!autoUpdaterInstance) return false;
  const enabled = shouldEnableAutoUpdater({
    isPackaged: Boolean(app.isPackaged),
    isCinnyShell,
    isTestMode: isUpdaterTestMode,
  });
  const apply = shouldApplyUpdateNow({
    enabled,
    updateReady: Boolean(state.updateReady),
    callActive: isCallActive(),
  });
  if (apply) autoUpdaterInstance.quitAndInstall();
  return apply;
}

// 起動時に一度だけ呼ばれる (main() 参照)。有効化条件 (本番パッケージ + 本番トポロジ + テスト/probe
// モードでない) を満たすときだけ実際に checkForUpdatesAndNotify() を呼ぶ -- dev (unpacked)・
// smoke/memory/cinny-shell-smoke・E2E・harness・tray-probe・minisign-probe・
// update-wiring-probe のどれで実行しても app.isPackaged は false (または isUpdaterTestMode が
// true) になるため、これらの経路では GitHub Releases への通信は一切発生しない。
function maybeCheckForUpdates() {
  const enabled = shouldEnableAutoUpdater({
    isPackaged: Boolean(app.isPackaged),
    isCinnyShell,
    isTestMode: isUpdaterTestMode,
  });
  state.autoUpdaterEnabled = enabled;
  if (!enabled || !autoUpdaterInstance) return false;
  autoUpdaterInstance.checkForUpdatesAndNotify().catch((error) => {
    state.widgetMessages.push({
      t: Date.now(),
      type: "auto-update-check-error",
      error: String(error && error.message ? error.message : error),
    });
  });
  return true;
}

// M2 自動起動 (opt-in、既定 OFF): Windows のスタートアップ登録は app.setLoginItemSettings() が
// 実際にレジストリ (Run キー相当) へ書き込む。**このプロセス自身が読み書きするのは、ユーザーが
// トレイメニューのチェック項目を実際にクリックしたときだけ** -- 起動時に自動で有効化する経路は
// どこにも無い (既定 OFF)。
//
// currentAutoLaunchEnabled()/setAutoLaunchEnabled() をそれぞれ 1 箇所に集約してあるのは、
// runTrayProbe() (下記) がテスト中に app.getLoginItemSettings/app.setLoginItemSettings 自体を
// スパイに差し替えられるようにするため -- トグルの判定ロジック (toggleAutoLaunch()) はこの 2 関数
// 経由でしか OS 状態に触れないので、スパイに差し替えている間は実レジストリに一切書き込まれない
// (runTrayProbe() の autoLaunchToggle 検証コメント参照)。
function currentAutoLaunchEnabled() {
  return app.getLoginItemSettings().openAtLogin === true;
}

function setAutoLaunchEnabled(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

// トレイメニューのチェック項目の click ハンドラ本体。Electron の Menu は実際にトレイへ設定された
// 後はクリックのたびに menuItem.checked を自動反転してくれるが、trayMenuTemplate() は
// (runTrayProbe() にも同じ定義を渡せるよう) 生のテンプレート配列のままなので、その自動反転には
// 依存しない -- 現在値は毎回 currentAutoLaunchEnabled() で OS から実測して反転させる。これにより
// runTrayProbe() が生テンプレートの click() を直接呼んでも (実際の Menu UI を経由しなくても)
// 本番と全く同じロジックが動く。
function toggleAutoLaunch() {
  setAutoLaunchEnabled(!currentAutoLaunchEnabled());
}

const AUTO_LAUNCH_MENU_LABEL = "PC 起動時に自動起動";

// トレイメニュー「通話の別窓を最前面に固定」の click ハンドラ本体。toggleAutoLaunch() と同じ形
// (現在値は毎回永続化ファイルから実測して反転させる) だが、反映先が OS レジストリではなく
// callWindow.setAlwaysOnTop() である点が異なる: callWindow が生存していれば即座に反映し、無ければ
// 設定の保存だけを行う (次に createCallWindow() が生成する際にそちらが読む、同関数のコメント参照)。
function toggleCallWindowAlwaysOnTop() {
  const next = !loadCallWindowAlwaysOnTopEnabled();
  saveCallWindowAlwaysOnTopEnabled(next);
  if (state.callWindow && !state.callWindow.isDestroyed()) {
    state.callWindow.setAlwaysOnTop(next);
  }
}

const CALL_WINDOW_ALWAYS_ON_TOP_MENU_LABEL = "通話の別窓を最前面に固定";

// 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1 末尾「補助的な最小実装」、
// 運用者確定要件 2026-07-12 項目2): トレイ右クリックメニューのアクション項目。click のたびに
// triggerExternalMuteToggle() (ホットキー callback と全く同じ関数) を呼ぶ -- グローバルホットキーとは
// 独立した経路 (キー衝突の心配が無い)。通話中でなければ cinny 側で自然に no-op になる。
const EXTERNAL_MUTE_ACTION_MENU_LABEL = "マイクミュート切り替え";
// 運用者確定要件 3: ホットキーの発見性のためのサブメニュー。
const EXTERNAL_MUTE_HOTKEY_SUBMENU_LABEL = "ホットキー";

// トレイの右クリックメニュー定義。「将来ミュート制御等を足せる構造にしておく」という要件どおり、
// 項目は配列で持つ (増やす場合はこの配列に追記するだけでよい)。状態を持たない純関数として書いて
// あるので、createTray() が実際にトレイへ設定するのと runTrayProbe()/runExternalMuteProbe() が
// 検証用に取得するのとで常に同じ定義になる (checked/label の初期値だけは
// currentAutoLaunchEnabled()/loadExternalMuteHotkeyState() 等で実際の状態を読むが、これは読み取り
// 専用でありメニュー生成そのものに副作用は無い)。
//
// 外部ミュート制御のホットキー checkbox/プリセット radio はラベルや checked が状態変化のたびに
// 変わる (プリセット切替でラベル文字列自体が変わる) ため、click ハンドラは状態変更後に
// refreshTrayMenu() を呼んでメニュー全体を再構築する -- AUTO_LAUNCH_MENU_LABEL 等の静的ラベル項目は
// Electron の Menu 自身の自動チェック反転に任せているのと対照的 (toggleAutoLaunch() のコメント参照)。
function trayMenuTemplate() {
  const externalMuteState = loadExternalMuteHotkeyState();
  const currentPreset = findExternalMuteHotkeyPreset(externalMuteState.preset);
  return [
    { label: "SelfMatrix を開く", click: () => handleTrayActivate() },
    { type: "separator" },
    { label: EXTERNAL_MUTE_ACTION_MENU_LABEL, click: () => triggerExternalMuteToggle() },
    {
      label: EXTERNAL_MUTE_HOTKEY_SUBMENU_LABEL,
      submenu: [
        {
          label: `ミュート: ${currentPreset.accelerator}`,
          type: "checkbox",
          // 運用者確定要件 3: checked は「ホットキー登録済み」の実測値 (実際に
          // globalShortcut.register() が成功しているか) から導出する。永続化ファイルの enabled を
          // そのまま使わないのは、register() 失敗時 (他アプリとのキー衝突) にも checked が
          // 見た目上 ON のままになってしまう食い違いを避けるため (registerExternalMuteHotkey()の
          // コメント参照)。
          checked: state.externalMuteHotkeyRegisteredAccelerator !== null,
          click: () => {
            toggleExternalMuteHotkeyEnabled();
            refreshTrayMenu();
          },
        },
        { type: "separator" },
        ...EXTERNAL_MUTE_HOTKEY_PRESETS.map((preset) => ({
          label: preset.radioLabel,
          type: "radio",
          checked: preset.id === externalMuteState.preset,
          click: () => {
            selectExternalMuteHotkeyPreset(preset.id);
            refreshTrayMenu();
          },
        })),
      ],
    },
    // 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2): 「ホットキー」サブメニューと
    // 同列の兄弟サブメニュー。localhost 制御 API (Stream Deck プラグイン/自作スクリプト向け) の
    // 有効化とトークン管理をここにまとめる。
    {
      label: EXTERNAL_API_SUBMENU_LABEL,
      submenu: [
        {
          label: externalApiEnableMenuLabel(),
          type: "checkbox",
          // ホットキー checkbox (上) と同じ理由: checked は「実際に listen できているか」の実測値
          // (state.externalApiServer) から導出する。永続化ファイルの enabled だけを見ると、
          // EADDRINUSE 等の listen() 失敗時に checked が見た目上 ON のままになってしまう食い違いを
          // 避けるため。
          checked: state.externalApiServer !== null,
          click: () => {
            toggleExternalApiEnabled()
              .then(() => refreshTrayMenu())
              .catch((error) => {
                // listen()/close() 自体は内部で try/catch 済みで通常は reject しないが、念のため
                // 未処理の Promise rejection でプロセスへ影響が出ないようにする (無言で「効かない」
                // 状態を作らない、という運用者確定要件の精神をここでも踏襲する)。
                console.warn("[external-api] toggleExternalApiEnabled failed:", error);
                refreshTrayMenu();
              });
          },
        },
        { type: "separator" },
        { label: EXTERNAL_API_COPY_TOKEN_LABEL, click: () => copyExternalApiToken() },
        {
          label: EXTERNAL_API_REGENERATE_TOKEN_LABEL,
          click: () => {
            regenerateExternalApiToken();
            refreshTrayMenu();
          },
        },
      ],
    },
    { type: "separator" },
    { label: AUTO_LAUNCH_MENU_LABEL, type: "checkbox", checked: currentAutoLaunchEnabled(), click: () => toggleAutoLaunch() },
    {
      label: CALL_WINDOW_ALWAYS_ON_TOP_MENU_LABEL,
      type: "checkbox",
      checked: loadCallWindowAlwaysOnTopEnabled(),
      click: () => toggleCallWindowAlwaysOnTop(),
    },
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

// 外部ミュート制御のホットキー checkbox/プリセット radio のように、状態変化のたびにラベル/checked が
// 変わる項目を持つメニューを再構築する。AUTO_LAUNCH_MENU_LABEL 等の静的ラベル項目は Electron の Menu
// 自身の自動チェック反転に任せているため、この再構築は無くても実害は無いが (トレイを再度開けば次回の
// trayMenuTemplate() 呼び出しで最新化される)、即座に見た目を合わせるために毎回呼ぶ。tray-probe/
// external-mute-probe のように実 Tray を生成しないモードでは state.tray が null のまま (trayEnabled
// の定義参照) なので no-op になる。
function refreshTrayMenu() {
  if (!state.tray || state.tray.isDestroyed()) return;
  state.tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
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
  // M3 step 3 (design §3 step 3 実装要件 2「openCallView 直後 (通話開始 = attached) は非表示で
  // 初期化」): createCallViewIfNeeded() は call view を必ずまず mainWindow へ addChildView() する
  // (常に attached から始まる) ので、ロード完了後に明示的に push しておく。loadURL() の resolve を
  // 待ってから送る -- call-control-preload.cjs の ipcRenderer.on("native:set-footer-visible", ...)
  // 登録 (トップレベル、preload 実行時) は loadURL() 解決より確実に前に完了しているため、この push
  // は確実に受信される (push 前の一瞬でも既定値 footerVisible=false と一致するため、万一取りこぼしても
  // 見え方は食い違わない)。
  pushCallViewFooterVisibility();
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
  // M2 3b electron-updater 配線 (design/release-pipeline.md §7): 通話が終わった直後に、ダウンロード
  // 済みの更新があれば適用する (無ければ maybeApplyPendingUpdate() 内の shouldApplyUpdateNow() が
  // false を返すだけの no-op)。isCallActive() は state.callViewState を見るため、この代入の直後で
  // なければならない (通話中判定が正しく "非アクティブ" に切り替わった後で呼ぶ必要がある)。
  maybeApplyPendingUpdate();
  // M3 step 1 (placement push): 通話終了 (hangup) も "none" への placement 変化。computeCallViewAttachedTo()
  // は state.callView が null の時点で必ず "none" を返す (関数コメント参照) ので、直上の代入より後で
  // 呼べば正しい値が push される。
  pushCallViewPlacement();
}

function updateCallViewBounds() {
  if (!state.callView) return;
  // M2 bounds sync (Fable 全体レビュー arch-major 解消、タスクの発端となった指摘そのもの):
  // --cinny-shell モードは mainWindow が cinny 本体を直接トップフレームでロードする本番同様の
  // topology (createMainWindow() の isCinnyShell 分岐) であり、cinny 実 UI の実レイアウト座標
  // だけが「実際に call view を表示すべき領域」を知っている。この関数の下のハーネス固定式
  // (x=max(380,width*0.52) 等) は desktop-shell.html (ハーネス、既定/--smoke/--memory-probe) 向けの
  // 近似値に過ぎず、cinny-shell モードでこれを使うと実際の cinny レイアウト (サイドバー幅・チャット
  // 開閉等) とズレる。cinny-shell モードの attached 中は何もしない — 実適用は
  // applyCallViewBoundsFromCinny() ("native:set-call-view-bounds" ハンドラ) 経由の cinny からの
  // push だけが担う (win.on("resize", ...) からの呼び出しも含め、この関数の他の呼び出し元は
  // すべて素通りする)。ハーネスモード (--smoke 等) は影響を受けず従来どおり。
  //
  // M3 step 2 (design §3-4「bounds と detached の相互作用」): ただし detached (別窓 popout) 中は
  // cinny 側に push 経路そのものが無い (nativeBridge.ts の setCallViewBounds() 契約コメント
  // 「detached 中はこのメソッドを呼ぶ状況が現状発生しない」参照) — callWindow 自身の resize から
  // call view を全面 (`{x:0,y:0,width,height}`) に追従させる経路を、cinny-shell モードに限って
  // ここに復活させる。attached 中の cinny push 経路とは完全に分離 (このブロックは detached の
  // ときにしか動かない) しているため、上の「attached 中は cinny の push だけが担う」という不変条件は
  // 変えていない。
  if (isCinnyShell) {
    if (state.callViewState !== "detached") return;
    const detachedOwner = state.callWindow;
    if (!detachedOwner || detachedOwner.isDestroyed()) return;
    const [detachedWidth, detachedHeight] = detachedOwner.getContentSize();
    state.callView.setBounds({ x: 0, y: 0, width: detachedWidth, height: detachedHeight });
    return;
  }

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

// M3 step 0 スパイク: `options.closeMode` は callWindow をまだ持っていない場合のみ
// createCallWindow() へそのまま素通しする (runM3CloseSpikeProbe() が対照実験用に
// "closed-legacy" を渡すためだけの引数。本番の呼び出し元は常に省略する -- createCallWindow() の
// closeMode コメント参照)。
async function detachCallView(options = {}) {
  createCallViewIfNeeded();
  if (!state.callWindow) createCallWindow(options);
  if (state.callViewState !== "detached") {
    state.mainWindow.contentView.removeChildView(state.callView);
    state.callWindow.contentView.addChildView(state.callView);
    state.callViewState = "detached";
    updateCallViewBounds();
    // M3 step 1 (placement push): popoutCallView() (claim-once transport) 経由でも、E2E/harness の
    // 直接呼び出し経由でも、この関数を通る限り必ず push する — 呼び出し元を区別しない (design §3-5
    // のとおり cinny 側は「実際にどこへ動いたか」だけを知る必要がある)。
    pushCallViewPlacement();
    // M3 step 3: 別窓へ移った (detached) ので EC 自身のフッターを表示に切り替える。
    pushCallViewFooterVisibility();
  }
}

async function attachCallView() {
  createCallViewIfNeeded();
  if (state.callViewState !== "attached") {
    state.callWindow?.contentView.removeChildView(state.callView);
    state.mainWindow.contentView.addChildView(state.callView);
    state.callViewState = "attached";
    updateCallViewBounds();
    // M3 (別窓から戻った時の bounds 復帰、design §3-5): detached 中は callView を別窓の全面
    // ({0,0,w,h}) にしているため、メインへ戻した直後は callView がその全面 bounds のまま残る。
    // cinny-shell モードの updateCallViewBounds() は attached 時 no-op (bounds は cinny の
    // setCallViewBounds push が駆動) だが、戻った瞬間は cinny のレイアウトが変化していないため
    // 再 push が走らない。最後に cinny から受け取ったレイアウト bounds をここで再適用して、
    // メインのレイアウト位置/サイズへ確実に復帰させる (未受信なら何もしない)。
    if (state.callViewBoundsFromCinny !== undefined) {
      applyCallViewBoundsFromCinny(state.callViewBoundsFromCinny);
    }
    // M3 step 1 (placement push): createCallWindow() の close=復帰ハンドラもこの関数を呼ぶだけなので、
    // ユーザーが別窓を X ボタンで閉じた場合の「勝手な attach」もここから自動的に push される
    // (design §3-5 の核心 — cinny 側は明示的に何も呼んでいないのに main 側で状態が変わるケース)。
    pushCallViewPlacement();
    // M3 step 3: メインへ戻った (attached) ので EC 自身のフッターを非表示に切り替える (cinny 側
    // バーで操作する通常状態に戻す)。close=復帰 (createCallWindow() の "close" ハンドラ) 経由でも
    // この関数を通るため、ユーザーが別窓を X ボタンで閉じた場合も自動的にフッターが隠れる。
    pushCallViewFooterVisibility();
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
  // M2 デスクトップ通知: shell-preload.cjs (isolated world) が window 'message' で受け取った
  // NOTIFICATION_CLICK_MESSAGE_TYPE の合図をここへ中継してくる。main は「前面化する」以上のことを
  // 一切しない (handleTrayActivate() はトレイクリックと全く同じ関数 -- 実装を二重化しない)。
  // window.selfmatrixNative の contextBridge 公開面には現れないチャンネルなので、cinny 契約は
  // 広がっていない。
  ipcMain.on("native:notification-click", () => {
    handleTrayActivate();
  });

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

  // M3 step 1 (design/m3-window-ux.md §2 サブステップ 1): claimWidgetTransport() が返す
  // popoutCallView()/popinCallView() (nativeBridge.ts 契約) の main 側実体。上の
  // native:detach-call-view/native:attach-call-view (harness トポロジ限定、window.selfmatrixNative
  // 直下の常時公開 API) とは別物 — こちらは claim-once オブジェクト内のメソッドの実体であり、
  // トポロジを問わず (isCinnyShell の内外どちらでも) 常に登録する。呼ぶ関数自体
  // (detachCallView()/attachCallView()) は完全に同一 — 「本番の唯一の呼び出し元 detachCallView() は
  // 常に closeMode を省略する」という createCallWindow() のコメントどおり、ここでも options なしで
  // 呼ぶ (= 常に close-preserve)。
  ipcMain.handle("native:popout-call-view", () => detachCallView());
  ipcMain.handle("native:popin-call-view", () => attachCallView());

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
  // emphasis/reactions/settings) は存在しない — そのため DOM action は例外を投げず
  // `{ok:false, reason:"target_not_found"}` を返す。sound は相手が 0 人でも状態を保持する契約なので
  // audioCount:0 の `{ok:true}` を返すのが正しい。
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
    const isSoundAction = action === "setSoundOn" || action === "setSoundOff";
    vocabulary[action] = {
      result: outcome.result,
      error: outcome.error,
      pass:
        outcome.error === null &&
        Boolean(outcome.result) &&
        (isSoundAction
          ? outcome.result.ok === true && outcome.result.audioCount === 0
          : outcome.result.ok === false && reason === "target_not_found"),
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
    // SelfMatrix M3 step 5 (native-callflow.e2e.mjs の runCloseWindowMainRevert() 用、M3 の受け入れ
    // 条件の核心): 別窓 (state.callWindow) をユーザーが実際に X ボタンで閉じたのと同じ経路 --
    // `win.destroy()` ではなく `win.close()` をそのまま呼ぶ。createCallWindow() が登録した
    // "close" ハンドラ (既定の close-preserve モード) がキャンセル可能な "close" イベントを
    // 実際に受け取り、`event.preventDefault()` → `attachCallView()` (無再接続でメインへ退避) →
    // 完了後に `win.destroy()` する一連の production 経路をそのまま起動する。detachCallView()/
    // attachCallView() の直接呼び出しとは異なるコードパス (close ハンドラそのもの) を通る点が
    // このヘルパーの意味 -- attachCallView() を直接呼ぶだけでは close ハンドラ自体の実装
    // (event.preventDefault() の有無、callViewState !== "detached" 時のガード等) は検証できない。
    closeCallWindow: () => {
      if (!state.callWindow || state.callWindow.isDestroyed()) {
        return { ok: false, reason: "no_call_window" };
      }
      const windowId = state.callWindow.id;
      state.callWindow.close();
      return { ok: true, windowId };
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
//
// M2 デスクトップ通知/自動起動 (以下、この関数に相乗り): OS のトレイ同様、実 OS 通知のクリックや
// 実レジストリへの自動起動登録も自動化テストから直接は起こせない/起こしたくない対象なので、
// 同じ「ロジック本体を直接呼んで機械的に検証する」方針をここに拡張した -- 新しい npm script は
// 増やさず、この 1 モードに追加した (B: notificationClickFocusesWindow, C: autoLaunchToggle 参照)。
async function runTrayProbe() {
  const win = state.mainWindow;

  const trayCreated = Boolean(state.tray) && !state.tray.isDestroyed();
  const applicationMenuRemoved = Menu.getApplicationMenu() === null;

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
  // 外部ミュート制御 選択肢 A (design/external-mute-control.md §4.1、運用者確定要件 2026-07-12):
  // トレイ右クリックメニューにアクション項目「マイクミュート切り替え」とサブメニュー「ホットキー」が
  // 追加されたので、tray-probe のラベル期待値もここで更新する (実際の登録/トグル/プリセット切替の
  // 挙動検証は --external-mute-probe/runExternalMuteProbe() 側の責務、ここではメニュー構造の存在だけ
  // 確認する)。
  const hotkeySubmenuItem = menuTemplate.find((item) => item.label === EXTERNAL_MUTE_HOTKEY_SUBMENU_LABEL);
  const hotkeySubmenuLabels = Array.isArray(hotkeySubmenuItem?.submenu)
    ? hotkeySubmenuItem.submenu.map((item) => item.label ?? null)
    : [];
  // 外部ミュート制御 選択肢 B (design/external-mute-control.md §4.2): サブメニュー「外部制御 API」も
  // 同じ理由でラベル期待値をここに加える (実際の起動/認証/レート制限の挙動検証は
  // --external-api-probe/runExternalApiProbe() 側の責務)。
  const externalApiSubmenuItem = menuTemplate.find((item) => item.label === EXTERNAL_API_SUBMENU_LABEL);
  const externalApiSubmenuLabels = Array.isArray(externalApiSubmenuItem?.submenu)
    ? externalApiSubmenuItem.submenu.map((item) => item.label ?? null)
    : [];
  const contextMenuItems = {
    labels: menuLabels,
    containsOpenLabel: menuLabels.some((label) => typeof label === "string" && label.includes("開く")),
    containsQuitLabel: menuLabels.some((label) => typeof label === "string" && label.includes("終了")),
    containsAutoLaunchLabel: menuLabels.some((label) => label === AUTO_LAUNCH_MENU_LABEL),
    containsExternalMuteActionLabel: menuLabels.some((label) => label === EXTERNAL_MUTE_ACTION_MENU_LABEL),
    containsExternalMuteHotkeySubmenuLabel: menuLabels.some((label) => label === EXTERNAL_MUTE_HOTKEY_SUBMENU_LABEL),
    hotkeySubmenuLabels,
    hotkeySubmenuHasAllPresetRadios: EXTERNAL_MUTE_HOTKEY_PRESETS.every((preset) =>
      hotkeySubmenuLabels.includes(preset.radioLabel),
    ),
    containsExternalApiSubmenuLabel: menuLabels.some((label) => label === EXTERNAL_API_SUBMENU_LABEL),
    externalApiSubmenuLabels,
    externalApiSubmenuHasEnableCheckbox: externalApiSubmenuLabels.includes(externalApiEnableMenuLabel()),
    externalApiSubmenuHasTokenActions:
      externalApiSubmenuLabels.includes(EXTERNAL_API_COPY_TOKEN_LABEL) &&
      externalApiSubmenuLabels.includes(EXTERNAL_API_REGENERATE_TOKEN_LABEL),
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

  // B. notificationClickFocusesWindow: NOTIFICATION_CLICK_BRIDGE_SCRIPT (main world 注入) →
  // shell-preload.cjs の window 'message' 中継 → ipcMain.on("native:notification-click") →
  // handleTrayActivate() という配線をエンドツーエンドで検証する。OS の実通知クリックそのものは
  // 自動化できないため、mainWindow の main world 上で実際に `new Notification()` してから、その
  // インスタンスへ合成の 'click' イベントを dispatch する -- Notification は EventTarget であり、
  // 合成 dispatchEvent は我々のラッパが addEventListener() で足したリスナーを本物の OS クリックと
  // 同じ経路で発火させる (cinny 自身がまだ onclick 等を設定していなくても、ここで足したリスナーは
  // 独立して動く)。ウィンドウを隠した状態から始め、この一連の配線だけで再び可視になることを
  // 実測する。
  let notificationClickFocusesWindow = false;
  let notificationDispatchOutcome = null;
  let notificationProbeAttempts = 0;
  if (!win.isDestroyed()) {
    // 実測で発覚 (このコミット): dom-ready ハンドラの executeJavaScript() 注入は非同期 (IPC 往復) で
    // あり、cinny 本体 (SPA バンドル一式) の dom-ready 到達に数秒かかることがある (実測: このリポジトリ
    // 環境で ~5.7 秒。waitForCallControlInvoke(20000, ...) の G5 コメントにも「EC の ErrorView
    // マウントまで実測 ~9.95 秒」という同種の記録がある — この規模のバンドルロードが数秒〜十数秒
    // かかること自体は既知)。ウィンドウ生成直後にテストする tray-probe はこの起動完了より早く到達し
    // 得るため、「一度だけ試して即座に pass/fail を決める」のではなく、実際の効果 (hide → 合成 click →
    // 前面化) を最大 20 秒 (既存の waitForCallControlInvoke(20000) と水準を揃えた)、間隔を空けて
    // 再試行する。cinny 自身が途中でナビゲーションし直しても、そのたびに dom-ready ハンドラが
    // ブリッジを再注入する (NOTIFICATION_CLICK_BRIDGE_SCRIPT の __selfmatrixNotificationBridgeInstalled
    // ガード参照) ため、次の再試行では新しいドキュメントに対して自然に成功する。
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !notificationClickFocusesWindow) {
      notificationProbeAttempts += 1;
      win.hide();
      // eslint-disable-next-line no-await-in-loop
      await wait(150);
      const hiddenBeforeClick = win.isVisible() === false;
      // eslint-disable-next-line no-await-in-loop
      notificationDispatchOutcome = await win.webContents
        .executeJavaScript(
          `(() => {
            try {
              const n = new Notification("selfmatrix-tray-probe");
              n.dispatchEvent(new Event("click"));
              return {
                ok: true,
                bridgeInstalled: window.__selfmatrixNotificationBridgeInstalled === true,
                permission: (typeof Notification !== "undefined") ? Notification.permission : null,
              };
            } catch (error) {
              return { ok: false, error: String(error && error.message ? error.message : error) };
            }
          })()`,
          true,
        )
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
      // eslint-disable-next-line no-await-in-loop
      await wait(250);
      notificationClickFocusesWindow =
        hiddenBeforeClick &&
        Boolean(notificationDispatchOutcome && notificationDispatchOutcome.ok) &&
        win.isVisible() === true;
    }
  }

  // C. autoLaunchToggle: app.getLoginItemSettings/app.setLoginItemSettings をどちらもスパイへ
  // 差し替えた (メモリ内のフェイク状態だけを更新する) 上で、トレイメニューのチェック項目の click
  // ハンドラ (toggleAutoLaunch()) を 2 回叩き、実際に渡る引数 (openAtLogin: true → false) を
  // 検証する。運用者の絶対条件「テストでレジストリを汚さない」への対応 -- スパイに差し替えている
  // 間、本物の app.setLoginItemSettings は一度も呼ばれない。最後にスパイを元へ戻し、
  // 本物の app.getLoginItemSettings().openAtLogin が false のまま (このテストで一度も実書き込み
  // していないので当然 false のはず) であることまで確認して「残渣ゼロ」を実測する。
  const originalGetLoginItemSettings = app.getLoginItemSettings.bind(app);
  const originalSetLoginItemSettings = app.setLoginItemSettings.bind(app);
  let fakeLoginItemState = { openAtLogin: false };
  const capturedSetLoginItemCalls = [];
  app.getLoginItemSettings = () => ({ ...fakeLoginItemState });
  app.setLoginItemSettings = (settings) => {
    capturedSetLoginItemCalls.push(settings);
    fakeLoginItemState = { ...fakeLoginItemState, ...settings };
  };
  const autoLaunchItem = menuTemplate.find((item) => item.label === AUTO_LAUNCH_MENU_LABEL);
  autoLaunchItem?.click(); // 期待: フェイク state は false → click() は {openAtLogin:true} を渡す
  autoLaunchItem?.click(); // 期待: フェイク state は true (直前の click で更新済み) → 今度は {openAtLogin:false}
  app.getLoginItemSettings = originalGetLoginItemSettings;
  app.setLoginItemSettings = originalSetLoginItemSettings;
  const realRegistryUntouchedAfter = app.getLoginItemSettings().openAtLogin === false;
  const autoLaunchToggle = {
    found: Boolean(autoLaunchItem),
    capturedCalls: capturedSetLoginItemCalls,
    toggleOnArgCorrect: capturedSetLoginItemCalls[0]?.openAtLogin === true,
    toggleOffArgCorrect: capturedSetLoginItemCalls[1]?.openAtLogin === false,
    realRegistryUntouchedAfter,
    pass:
      Boolean(autoLaunchItem) &&
      capturedSetLoginItemCalls.length === 2 &&
      capturedSetLoginItemCalls[0]?.openAtLogin === true &&
      capturedSetLoginItemCalls[1]?.openAtLogin === false &&
      realRegistryUntouchedAfter,
  };

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
      contextMenuItems.containsAutoLaunchLabel &&
      contextMenuItems.containsExternalMuteActionLabel &&
      contextMenuItems.containsExternalMuteHotkeySubmenuLabel &&
      contextMenuItems.hotkeySubmenuHasAllPresetRadios &&
      contextMenuItems.containsExternalApiSubmenuLabel &&
      contextMenuItems.externalApiSubmenuHasEnableCheckbox &&
      contextMenuItems.externalApiSubmenuHasTokenActions &&
      trayClickShowsWindow &&
      notificationClickFocusesWindow &&
      autoLaunchToggle.pass &&
      applicationMenuRemoved &&
      quitMenuReallyQuits,
    trayCreated,
    closeHidesWindow,
    contextMenuItems,
    trayClickShowsWindow,
    notificationClickFocusesWindow,
    notificationDispatchOutcome,
    notificationProbeAttempts,
    autoLaunchToggle,
    applicationMenuRemoved,
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
  // 選択肢 B: このモードでは実際には一度も起動しない想定だが (isExternalApiProductionRun が
  // isTrayProbe を除外している)、念のため二重に安全側へ倒す。
  stopExternalApiServer();
  app.exit(result.pass ? 0 : 1);
}

// mainWindow の main world (shell-preload.cjs 経由で contextBridge 公開された
// window.selfmatrixNative) 側で、claim 済みトランスポートの onExternalMuteToggle() リスナーが
// これまでに受け取った回数を読む。runExternalMuteProbe() の各ステップから繰り返し呼ばれる。
async function readExternalMuteToggleEventCount(win) {
  return win.webContents.executeJavaScript(
    "(window.__selfmatrixExternalMuteToggleEvents || []).length",
    true,
  );
}

// 外部ミュート制御 選択肢 A の検証専用モード (--external-mute-probe, design/external-mute-control.md
// §4.1/§4.4、運用者確定要件 2026-07-12)。OS のグローバルホットキーの実打鍵や Stream Deck の実操作は
// 自動化できないため、tray-probe と同じ方針 (ロジック本体 -- globalShortcut 登録/解除、トレイの click
// ハンドラと同一の引き金関数、mainWindow への IPC 配送 -- を main プロセス内から直接呼んで機械的に
// 検証する) を踏襲する。
//
// 検証する内容 (完了報告の宛先の記号に対応):
//   a. 起動時、既定 (初回インストール相当) では isRegistered(既定アクセラレータ) が false のまま
//      (2026-07-12 運用者要件変更: 既定 ON → 既定 OFF)。
//   b. トレイの「ホットキー」checkbox の click ハンドラと同一の関数 (toggleExternalMuteHotkeyEnabled())
//      で ON/OFF をトグルできる。ON にすると isRegistered が true になり、永続化される (再起動相当
//      ―― globalShortcut.unregisterAll() で一旦解放してから applyExternalMuteHotkeyFromPersistedState()
//      を再実行する -- で復元される)。OFF に戻すと isRegistered が false になり、同様に永続化/復元
//      される。
//   c. トレイのアクション項目「マイクミュート切り替え」の click ハンドラ (= ホットキー callback と
//      全く同じ triggerExternalMuteToggle()) を呼ぶと、mainWindow の renderer 側が実際に
//      native:external-mute-toggle を受信する (window.selfmatrixNative.claimWidgetTransport().
//      onExternalMuteToggle() 経由、shell-preload.cjs の実装を実際に駆動して検証する)。
//   d. 変異ゲート: 「マイクミュート切り替え」項目 → triggerExternalMuteToggle() の配線を一時的に
//      壊し (triggerExternalMuteToggle を no-op へ差し替える)、その状態でクリックしても renderer が
//      受信しない (= 壊れたことを検知できる) ことを確認してから元へ戻し、再び PASS することを確認する。
//   e. プリセット切替 (selectExternalMuteHotkeyPreset()、トレイの radio 項目の click ハンドラと同一)
//      後は isRegistered(新プリセット) が true、isRegistered(旧プリセット) が false になる。
//   f. 選択プリセットが永続化され、再起動相当 (unregisterAll → 再適用) で復元される。
//   g. (前提条件、requirement 4) will-quit ハンドラを合成 emit すると globalShortcut.unregisterAll()
//      が実際に呼ばれ、登録中だったアクセラレータが解放される。
//   h. (前提条件) ホットキー callback とトレイのアクション項目は globalShortcut.register() に渡す
//      時点で同一の関数オブジェクト (triggerExternalMuteToggle) を共有している (design §4.1
//      「同一の関数に集約」の構造的な裏付け)。
async function runExternalMuteProbe() {
  const win = state.mainWindow;
  const DEFAULT_PRESET = findExternalMuteHotkeyPreset(DEFAULT_EXTERNAL_MUTE_HOTKEY_PRESET_ID);
  const ALT_PRESET = findExternalMuteHotkeyPreset("f13");

  // 前提: このプロセス自身は起動時 (main() の isExternalMuteHotkeyProductionRun ゲート、
  // 定義箇所コメント参照) にこの関数を自動的には呼ばない -- 決定的な検証のため、ここから先は
  // すべてこの関数自身が明示的に呼び出しタイミングを制御する。念のため、まだ何も登録されていない
  // (userData のリセットは main() 冒頭で既に実施済み、isExternalMuteProbe の reset ブロック参照)
  // クリーンな状態から始める。
  globalShortcut.unregisterAll();
  state.externalMuteHotkeyRegisteredAccelerator = null;

  // renderer 側の受信を実測するためのリスナーを仕込む (design §4.1 のとおり claim-once の
  // トランスポート経由)。claimWidgetTransport() はこのプロセスで初回なので成功する
  // (NativeCallEmbed 相当の呼び出しはこの probe では一切発生しない)。
  const setupResult = await win.webContents.executeJavaScript(
    `(() => {
      try {
        window.__selfmatrixExternalMuteToggleEvents = [];
        const transport = window.selfmatrixNative.claimWidgetTransport();
        const hasMethod = typeof transport.onExternalMuteToggle === "function";
        if (hasMethod) {
          transport.onExternalMuteToggle(() => {
            window.__selfmatrixExternalMuteToggleEvents.push(Date.now());
          });
        }
        return { ok: true, hasMethod };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    })()`,
    true,
  );

  // a. 既定 OFF (2026-07-12 運用者要件変更): main() が本番起動時に呼ぶのと同じ関数を、リセット済みの
  // (userData 上に設定ファイルが無い) 状態に対して呼ぶ。
  applyExternalMuteHotkeyFromPersistedState();
  const defaultOff = {
    isRegistered: globalShortcut.isRegistered(DEFAULT_PRESET.accelerator),
    persistedEnabled: loadExternalMuteHotkeyState().enabled,
  };
  defaultOff.pass = defaultOff.isRegistered === false && defaultOff.persistedEnabled === false;

  // h. ホットキー callback とトレイのアクション項目クリックが同一の関数を共有していることの構造的
  // 裏付け: globalShortcut.register() に実際に渡されたコールバック参照を捕捉し、
  // triggerExternalMuteToggle (このモジュールスコープの共有関数) と同一オブジェクトであることを
  // 確認する。
  const originalGlobalShortcutRegister = globalShortcut.register.bind(globalShortcut);
  let capturedHotkeyCallback = null;
  globalShortcut.register = (accelerator, callback) => {
    capturedHotkeyCallback = callback;
    return originalGlobalShortcutRegister(accelerator, callback);
  };
  toggleExternalMuteHotkeyEnabled(); // OFF -> ON (副作用は下の toggleOn チェックで確認する)
  globalShortcut.register = originalGlobalShortcutRegister;
  const sharedTriggerFunction = {
    hotkeySharesTriggerFunction: capturedHotkeyCallback === triggerExternalMuteToggle,
  };

  // b. トグル ON: isRegistered true + 永続化 + 再起動相当で復元。
  const toggleOn = {
    isRegisteredAfterToggleOn: globalShortcut.isRegistered(DEFAULT_PRESET.accelerator),
    persistedAfterToggleOn: loadExternalMuteHotkeyState(),
  };
  globalShortcut.unregisterAll(); // 再起動相当の第一歩 (プロセス終了 = OS が解放する状態を模す)
  state.externalMuteHotkeyRegisteredAccelerator = null;
  applyExternalMuteHotkeyFromPersistedState(); // 再起動相当の第二歩 (起動時の自動適用)
  toggleOn.isRegisteredAfterRestart = globalShortcut.isRegistered(DEFAULT_PRESET.accelerator);
  toggleOn.pass =
    toggleOn.isRegisteredAfterToggleOn === true &&
    toggleOn.persistedAfterToggleOn.enabled === true &&
    toggleOn.persistedAfterToggleOn.preset === DEFAULT_PRESET.id &&
    toggleOn.isRegisteredAfterRestart === true;

  // トグル OFF: isRegistered false + 永続化 + 再起動相当で復元 (b の後半、"同じ関数でトグル OFF")。
  toggleExternalMuteHotkeyEnabled(); // ON -> OFF (トレイの checkbox click ハンドラと同一の関数)
  const toggleOff = {
    isRegisteredAfterToggleOff: globalShortcut.isRegistered(DEFAULT_PRESET.accelerator),
    persistedAfterToggleOff: loadExternalMuteHotkeyState(),
  };
  globalShortcut.unregisterAll();
  state.externalMuteHotkeyRegisteredAccelerator = null;
  applyExternalMuteHotkeyFromPersistedState();
  toggleOff.isRegisteredAfterRestart = globalShortcut.isRegistered(DEFAULT_PRESET.accelerator);
  toggleOff.pass =
    toggleOff.isRegisteredAfterToggleOff === false &&
    toggleOff.persistedAfterToggleOff.enabled === false &&
    toggleOff.isRegisteredAfterRestart === false;

  // c/d 用に、再びホットキーを ON にしておく (プリセット切替検証や引き金検証はホットキーが ON の
  // 状態で行うほうが「トレイのアクション項目は独立した経路」という設計意図をより強く検証できる)。
  toggleExternalMuteHotkeyEnabled(); // OFF -> ON

  // c. 引き金関数 (トレイのアクション項目「マイクミュート切り替え」の click ハンドラ、ホットキー
  // callback と共有の triggerExternalMuteToggle()) を呼ぶと mainWindow が実際に受信する。
  const actionItem = trayMenuTemplate().find((item) => item.label === EXTERNAL_MUTE_ACTION_MENU_LABEL);
  const beforeTrigger = await readExternalMuteToggleEventCount(win);
  actionItem.click();
  await wait(200);
  const afterTrigger = await readExternalMuteToggleEventCount(win);
  const triggerDelivery = {
    setupResult,
    beforeTrigger,
    afterTrigger,
    pass: Boolean(setupResult.ok) && Boolean(setupResult.hasMethod) && afterTrigger === beforeTrigger + 1,
  };

  // d. 変異ゲート: 引き金 (トレイのアクション項目) → triggerExternalMuteToggle() → send の配線を
  // 一時的に壊し、FAIL を実測してから復元し、再度 PASS することを確認する。
  const originalTriggerExternalMuteToggle = triggerExternalMuteToggle;
  // eslint-disable-next-line no-func-assign -- 意図的な一時差し替え (mutation gate)。下で必ず復元する。
  triggerExternalMuteToggle = () => {};
  const beforeMutated = await readExternalMuteToggleEventCount(win);
  actionItem.click(); // 壊れた triggerExternalMuteToggle を呼ぶはずだが、何もしないので送信されない
  await wait(200);
  const afterMutated = await readExternalMuteToggleEventCount(win);
  const mutationDetectsFailure = afterMutated === beforeMutated; // 増えていない = 変異を検知できた
  // eslint-disable-next-line no-func-assign -- 復元。
  triggerExternalMuteToggle = originalTriggerExternalMuteToggle;
  const beforeRestored = await readExternalMuteToggleEventCount(win);
  actionItem.click();
  await wait(200);
  const afterRestored = await readExternalMuteToggleEventCount(win);
  const restoredPassesAgain = afterRestored === beforeRestored + 1;
  const mutationGate = {
    beforeMutated,
    afterMutated,
    mutationDetectsFailure,
    beforeRestored,
    afterRestored,
    restoredPassesAgain,
    pass: mutationDetectsFailure && restoredPassesAgain,
  };

  // e/f. プリセット切替 (2026-07-12 運用者要件変更): ホットキーは ON のまま (上の toggleExternalMuteHotkeyEnabled()
  // 呼び出し直後の状態)、既定プリセットから ALT_PRESET (f13) へ切り替える。
  selectExternalMuteHotkeyPreset(ALT_PRESET.id); // トレイの radio 項目の click ハンドラと同一の関数
  const presetSwitch = {
    isRegisteredNewAfterSwitch: globalShortcut.isRegistered(ALT_PRESET.accelerator),
    isRegisteredOldAfterSwitch: globalShortcut.isRegistered(DEFAULT_PRESET.accelerator),
    persistedAfterSwitch: loadExternalMuteHotkeyState(),
  };
  presetSwitch.passE =
    presetSwitch.isRegisteredNewAfterSwitch === true && presetSwitch.isRegisteredOldAfterSwitch === false;

  // f. 再起動相当で選択プリセットが復元される。
  globalShortcut.unregisterAll();
  state.externalMuteHotkeyRegisteredAccelerator = null;
  applyExternalMuteHotkeyFromPersistedState();
  presetSwitch.isRegisteredNewAfterRestart = globalShortcut.isRegistered(ALT_PRESET.accelerator);
  presetSwitch.passF =
    presetSwitch.persistedAfterSwitch.preset === ALT_PRESET.id && presetSwitch.isRegisteredNewAfterRestart === true;
  presetSwitch.pass = presetSwitch.passE && presetSwitch.passF;

  // g. will-quit ハンドラの合成 emit: 実際に globalShortcut.unregisterAll() が呼ばれ、登録中だった
  // アクセラレータが解放されることを確認する (app.quit() 自体は呼ばない -- このプロセスは
  // 自分自身の app.exit() でライフサイクルを自己管理する、他の run*Probe() と同じ方針)。
  const registeredBeforeWillQuit = globalShortcut.isRegistered(ALT_PRESET.accelerator);
  app.emit("will-quit");
  await wait(50);
  const registeredAfterWillQuit = globalShortcut.isRegistered(ALT_PRESET.accelerator);
  const willQuitUnregistersAll = {
    registeredBeforeWillQuit,
    registeredAfterWillQuit,
    pass: registeredBeforeWillQuit === true && registeredAfterWillQuit === false,
  };
  state.externalMuteHotkeyRegisteredAccelerator = null;

  // 後始末: このプロセス自身が持つ「実際に登録した」ものは will-quit の合成 emit で既に解放済み
  // だが、二重に安全側へ倒す。永続化ファイルも既定へ戻し、evidence/.test-userdata に次回実行を
  // 混乱させる残留状態を残さない。
  globalShortcut.unregisterAll();
  saveExternalMuteHotkeyState({ ...DEFAULT_EXTERNAL_MUTE_HOTKEY_STATE });

  const result = {
    pass:
      defaultOff.pass &&
      sharedTriggerFunction.hotkeySharesTriggerFunction &&
      toggleOn.pass &&
      toggleOff.pass &&
      triggerDelivery.pass &&
      mutationGate.pass &&
      presetSwitch.pass &&
      willQuitUnregistersAll.pass,
    a_defaultOff: defaultOff,
    h_sharedTriggerFunction: sharedTriggerFunction,
    b_toggleOn: toggleOn,
    b_toggleOff: toggleOff,
    c_triggerDelivery: triggerDelivery,
    d_mutationGate: mutationGate,
    e_f_presetSwitch: presetSwitch,
    g_willQuitUnregistersAll: willQuitUnregistersAll,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "external-mute-probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[external-mute-probe] FAIL:", JSON.stringify(result, null, 2));
  }

  state.tray?.destroy();
  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

// runExternalApiProbe() 専用の薄い HTTP クライアント。127.0.0.1:<port> へ実際に TCP 接続して
// リクエストを送る (このプロセス自身が同じポートで listen しているサーバーへ、別プロセスを介さず
// 自己ループバックで往復する)。node:http だけで完結させる (このリポジトリの他の箇所と同じく、
// 検証のためだけに新規依存を増やさない)。
function externalApiProbeRequest(method, pathname, { token, origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (origin !== undefined) headers.origin = origin;
    const request = http.request(
      { hostname: "127.0.0.1", port: EXTERNAL_API_DEFAULT_PORT, path: pathname, method, headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (error) {
            json = null;
          }
          resolve({ status: response.statusCode, json });
        });
      },
    );
    // (a) 既定 OFF の検証で使う: サーバーが listen していなければここが 'error' (ECONNREFUSED) で
    // 発火する。resolve() を 1 回だけ呼ぶ (成功パスと排他)。
    request.on("error", (error) => {
      resolve({ status: null, error: String(error && error.code ? error.code : error) });
    });
    request.end();
  });
}

// 選択肢 B の検証専用モード (--external-api-probe, design/external-mute-control.md §4.2/§4.4)。
// Stream Deck プラグインや自作スクリプトからの実接続は自動化しにくいため、tray-probe/
// runExternalMuteProbe() と同じ方針 (ロジック本体を main プロセス内から直接呼び、かつこのプロセス
// 自身が listen している 127.0.0.1:<port> へ実際に HTTP リクエストを送って機械的に検証する) を
// 踏襲する。
//
// 検証する内容 (完了報告の宛先の記号に対応):
//   a. 既定 OFF: サーバーが listen していない (接続拒否)。
//   b. 有効化 (トレイの checkbox click ハンドラと同一の toggleExternalApiEnabled()) →
//      server.address() が 127.0.0.1 (0.0.0.0 でない) + ping が正トークンで 200。
//   c. 誤トークン → 401、かつ renderer への配達が起きない (runExternalMuteProbe() と同じ
//      window.__selfmatrixExternalMuteToggleEvents カウンタを再利用する -- 選択肢 A/B は
//      triggerExternalMuteToggle() 以降を完全共有するため、同じ計測がそのまま使える)。
//   変異ゲート: tokensMatch() を「常に true を返す」実装へ一時的に差し替え、c の
//      「誤トークンは 401 かつ配達されない」が実際に FAIL (200 かつ配達される) することを実測してから
//      復元し、再度 PASS することを確認する。
//   d. 正トークン POST /v1/mute-toggle → 200 + renderer 側で受信。
//   e. 正トークンでも Origin ヘッダ付き → 403。
//   f. 誤トークン連続 5 回 → 6 回目は 429 (正トークンでも 429)。ロックアウト解除後は回復する
//      (EXTERNAL_API_LOCKOUT_DURATION_MS を検証中だけ短縮して実測する、同定数のコメント参照)。
//   g. トークン再生成 (トレイの「トークンを再生成」click ハンドラと同一の
//      regenerateExternalApiToken()) → 旧トークン 401 / 新トークン 200。
//   h. 有効化状態とトークンが再起動相当 (サーバーを閉じてから applyExternalApiFromPersistedState()
//      を再実行する) で復元される。
//
// 絶対条件: 実トークン値を evidence JSON に焼き込まない。以下の各ステップは全てステータスコードや
// 真偽値だけを記録し、生成/送信したトークン文字列そのものを result オブジェクトへ入れない。
async function runExternalApiProbe() {
  const win = state.mainWindow;

  // クリーンな状態から始める (userData のリセットは main() 冒頭の isExternalApiProbe reset ブロック
  // で既に実施済み。ここではメモリ内状態も念のためリセットする)。
  await stopExternalApiServer();
  state.externalApiConsecutiveAuthFailures = 0;
  state.externalApiLockoutUntil = 0;

  // renderer 側の受信計測セットアップ (runExternalMuteProbe() と全く同じ経路 -- claimWidgetTransport()
  // はこのプロセスにとって初回なので成功する)。
  const setupResult = await win.webContents.executeJavaScript(
    `(() => {
      try {
        window.__selfmatrixExternalMuteToggleEvents = [];
        const transport = window.selfmatrixNative.claimWidgetTransport();
        const hasMethod = typeof transport.onExternalMuteToggle === "function";
        if (hasMethod) {
          transport.onExternalMuteToggle(() => {
            window.__selfmatrixExternalMuteToggleEvents.push(Date.now());
          });
        }
        return { ok: true, hasMethod };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    })()`,
    true,
  );

  // a. 既定 OFF。
  const beforeEnablePing = await externalApiProbeRequest("GET", "/v1/ping", { token: "not-enabled-yet" });
  const defaultOff = {
    connectionRefused: beforeEnablePing.status === null,
    errorCode: beforeEnablePing.error ?? null,
    persistedEnabled: loadExternalApiState().enabled,
  };
  defaultOff.pass = defaultOff.connectionRefused === true && defaultOff.persistedEnabled === false;

  // b. 有効化: トレイの checkbox click ハンドラと同一の関数。
  await toggleExternalApiEnabled(); // OFF -> ON (未生成ならトークンも生成される)
  const address = state.externalApiServer ? state.externalApiServer.address() : null;
  const token = loadExternalApiState().token;
  const pingResult = await externalApiProbeRequest("GET", "/v1/ping", { token });
  const enable = {
    serverRunning: Boolean(state.externalApiServer),
    boundAddress: address ? address.address : null,
    pingStatus: pingResult.status,
    pingOk: Boolean(pingResult.json && pingResult.json.ok === true),
  };
  enable.pass =
    enable.serverRunning && enable.boundAddress === "127.0.0.1" && pingResult.status === 200 && enable.pingOk;

  // c. 誤トークン。
  const WRONG_TOKEN_1 = "wrong-token-does-not-match-stored-value";
  const beforeWrongToken = await readExternalMuteToggleEventCount(win);
  const wrongTokenResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: WRONG_TOKEN_1 });
  await wait(200);
  const afterWrongToken = await readExternalMuteToggleEventCount(win);
  const wrongToken = {
    status: wrongTokenResult.status,
    deliveredCount: afterWrongToken - beforeWrongToken,
  };
  wrongToken.pass = wrongToken.status === 401 && wrongToken.deliveredCount === 0;

  // 変異ゲート: tokensMatch() (定数時間比較の本体) を一時的に「常に true」へ差し替え、c のアサーション
  // が実際に FAIL することを実測してから復元し、再度 PASS することを確認する。
  const originalTokensMatch = tokensMatch;
  // eslint-disable-next-line no-func-assign -- 意図的な一時差し替え (mutation gate)。下で必ず復元する。
  tokensMatch = () => true;
  const beforeMutated = await readExternalMuteToggleEventCount(win);
  const mutatedResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: WRONG_TOKEN_1 });
  await wait(200);
  const afterMutated = await readExternalMuteToggleEventCount(win);
  // eslint-disable-next-line no-func-assign -- 復元。
  tokensMatch = originalTokensMatch;
  // mutationBreaksRejection === true は「この変異下では誤トークンが 200 で通り、実際に配達される」
  // ことの実測 -- つまり c の「誤トークンは 401 かつ配達されない」というアサーションはこの変異下で
  // 実際に FAIL する (数値上は「壊れたことを検知できた」の意味で true が望ましい結果)。
  const mutationBreaksRejection = mutatedResult.status === 200 && afterMutated === beforeMutated + 1;
  const beforeRestored = await readExternalMuteToggleEventCount(win);
  const restoredResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: WRONG_TOKEN_1 });
  await wait(200);
  const afterRestored = await readExternalMuteToggleEventCount(win);
  const restoredPassesAgain = restoredResult.status === 401 && afterRestored === beforeRestored;
  const mutationGate = {
    mutatedStatus: mutatedResult.status,
    mutatedDeliveredCount: afterMutated - beforeMutated,
    mutationBreaksRejection,
    restoredStatus: restoredResult.status,
    restoredDeliveredCount: afterRestored - beforeRestored,
    restoredPassesAgain,
    pass: mutationBreaksRejection && restoredPassesAgain,
  };

  // d. 正トークン POST /v1/mute-toggle → 200 + renderer 受信 (成功なので c/変異ゲートで積んだ
  // 連続失敗カウンタもここで 0 へリセットされる、resetExternalApiAuthFailures() 参照)。
  const beforeCorrect = await readExternalMuteToggleEventCount(win);
  const correctResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token });
  await wait(200);
  const afterCorrect = await readExternalMuteToggleEventCount(win);
  const correctToken = {
    status: correctResult.status,
    deliveredCount: afterCorrect - beforeCorrect,
  };
  correctToken.pass = correctResult.status === 200 && correctToken.deliveredCount === 1;

  // e. 正トークンでも Origin ヘッダ付き → 403 (ブラウザ drive-by 拒否、design §4.2)。
  const beforeOrigin = await readExternalMuteToggleEventCount(win);
  const originResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", {
    token,
    origin: "http://external-mute-control-probe.invalid",
  });
  await wait(200);
  const afterOrigin = await readExternalMuteToggleEventCount(win);
  const originRejected = {
    status: originResult.status,
    deliveredCount: afterOrigin - beforeOrigin,
  };
  originRejected.pass = originResult.status === 403 && originRejected.deliveredCount === 0;

  // f. レート制限: 誤トークン連続 5 回 → 6 回目 (誤トークン) は 429、7 回目 (正トークン!) も 429、
  // ロックアウト解除後は回復する。EXTERNAL_API_LOCKOUT_DURATION_MS を検証中だけ短縮する (本番の
  // 60 秒ロックアウトをテストのたびに実際に待つのは非現実的、同定数のコメント参照)。
  state.externalApiConsecutiveAuthFailures = 0;
  state.externalApiLockoutUntil = 0;
  const originalLockoutDurationMs = EXTERNAL_API_LOCKOUT_DURATION_MS;
  const SHORT_LOCKOUT_MS_FOR_TEST = 300;
  EXTERNAL_API_LOCKOUT_DURATION_MS = SHORT_LOCKOUT_MS_FOR_TEST;
  const WRONG_TOKEN_2 = "another-wrong-token-for-rate-limit-test";
  const fiveFailureStatuses = [];
  for (let i = 0; i < EXTERNAL_API_LOCKOUT_THRESHOLD; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 意図的に直列 (連続失敗回数を数える検証のため)。
    const attempt = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: WRONG_TOKEN_2 });
    fiveFailureStatuses.push(attempt.status);
  }
  const sixthWrongTokenResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: WRONG_TOKEN_2 });
  const seventhCorrectTokenResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token });
  await wait(SHORT_LOCKOUT_MS_FOR_TEST + 200); // ロックアウト解除を待つ (短縮定数を使用)
  const recoveredResult = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token });
  EXTERNAL_API_LOCKOUT_DURATION_MS = originalLockoutDurationMs; // 本番の 60 秒へ復元
  const rateLimit = {
    fiveFailureStatuses,
    sixthWrongTokenStatus: sixthWrongTokenResult.status,
    seventhCorrectTokenStatus: seventhCorrectTokenResult.status,
    recoveredStatus: recoveredResult.status,
  };
  rateLimit.pass =
    fiveFailureStatuses.every((status) => status === 401) &&
    rateLimit.sixthWrongTokenStatus === 429 &&
    rateLimit.seventhCorrectTokenStatus === 429 &&
    rateLimit.recoveredStatus === 200;
  state.externalApiConsecutiveAuthFailures = 0;
  state.externalApiLockoutUntil = 0;

  // g. トークン再生成: トレイの「トークンを再生成」click ハンドラと同一の関数。
  const oldToken = loadExternalApiState().token;
  const newToken = regenerateExternalApiToken();
  const oldTokenAfterRegen = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: oldToken });
  const newTokenAfterRegen = await externalApiProbeRequest("POST", "/v1/mute-toggle", { token: newToken });
  const tokenRegeneration = {
    tokensDiffer: oldToken !== newToken,
    oldTokenStatus: oldTokenAfterRegen.status,
    newTokenStatus: newTokenAfterRegen.status,
  };
  tokenRegeneration.pass =
    tokenRegeneration.tokensDiffer &&
    tokenRegeneration.oldTokenStatus === 401 &&
    tokenRegeneration.newTokenStatus === 200;
  state.externalApiConsecutiveAuthFailures = 0;
  state.externalApiLockoutUntil = 0;

  // h. 再起動相当での復元: サーバーを閉じてメモリ状態をリセットし (プロセス終了を模す)、main() が
  // 本番起動時に呼ぶのと同じ applyExternalApiFromPersistedState() を再実行する。close() の完了
  // ('close' イベント) を待ってから listen() し直す (stopExternalApiServer() のコメント参照 --
  // 待たずに同一ポートへ listen() し直すと初回接続が ECONNRESET になることを実機で確認した)。
  await stopExternalApiServer();
  await wait(150);
  const persistedBeforeRestart = loadExternalApiState();
  await applyExternalApiFromPersistedState();
  const addressAfterRestart = state.externalApiServer ? state.externalApiServer.address() : null;
  const pingAfterRestart = await externalApiProbeRequest("GET", "/v1/ping", {
    token: persistedBeforeRestart.token,
  });
  const restartRestore = {
    persistedEnabledBeforeRestart: persistedBeforeRestart.enabled,
    serverRunningAfterRestart: Boolean(state.externalApiServer),
    boundAddressAfterRestart: addressAfterRestart ? addressAfterRestart.address : null,
    pingStatusAfterRestart: pingAfterRestart.status,
    pingAfterRestartErrorCode: pingAfterRestart.error ?? null,
  };
  restartRestore.pass =
    restartRestore.persistedEnabledBeforeRestart === true &&
    restartRestore.serverRunningAfterRestart &&
    restartRestore.boundAddressAfterRestart === "127.0.0.1" &&
    restartRestore.pingStatusAfterRestart === 200;

  const result = {
    pass:
      defaultOff.pass &&
      enable.pass &&
      wrongToken.pass &&
      mutationGate.pass &&
      correctToken.pass &&
      originRejected.pass &&
      rateLimit.pass &&
      tokenRegeneration.pass &&
      restartRestore.pass,
    a_defaultOff: defaultOff,
    b_enable: enable,
    c_wrongToken: wrongToken,
    mutationGate,
    d_correctToken: correctToken,
    e_originRejected: originRejected,
    f_rateLimit: rateLimit,
    g_tokenRegeneration: tokenRegeneration,
    h_restartRestore: restartRestore,
    setupResult,
    port: EXTERNAL_API_DEFAULT_PORT,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };

  // 後始末: サーバーを閉じ、レート制限内部状態と永続化ファイルを既定へ戻す (次回実行の決定性を保つ、
  // runExternalMuteProbe() の後始末と同じ方針)。
  await stopExternalApiServer();
  state.externalApiConsecutiveAuthFailures = 0;
  state.externalApiLockoutUntil = 0;
  saveExternalApiState({ ...DEFAULT_EXTERNAL_API_STATE });

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "external-api-probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[external-api-probe] FAIL:", JSON.stringify(result, null, 2));
  }

  state.tray?.destroy();
  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

// M3 step 0 スパイク (--m3-close-spike, design/m3-window-ux.md §3-1): 別窓をユーザーが実際に閉じた
// とき、子 WebContentsView (= 生きた RTCPeerConnection) が無再接続でメインへ復帰できるかを、
// Docker/実バックエンド無しで実証する。call view に自己ループバック RTCPeerConnection テストページ
// (src/m3-close-spike-test.html) を loadURL し、その状態で実際に callWindow.close() (win.destroy()
// ではなく、実ユーザーの X ボタンと同じ 'close'→'closed' のイベント列を通す) を呼ぶ。

// call view 内で評価する再利用スクリプト。native-callflow.e2e.mjs の PCS_SUMMARY_SCRIPT と同じ形
// (window.__selfmatrixPcs は main.cjs 冒頭の E2E_RTC_WRAPPER_SCRIPT が作る計装データ)。
const M3_SPIKE_STATE_SCRIPT = `(() => {
  const pcs = (window.__selfmatrixPcs || []).map((r) => ({
    id: r.id,
    connectionState: r.connectionState,
    iceConnectionState: r.iceConnectionState,
    reachedConnected: r.reachedConnected,
  }));
  const spike = window.__m3SpikeState || {};
  return {
    pcs,
    dataChannelsOpen: typeof spike.dataChannelsOpen === "function" ? spike.dataChannelsOpen() : false,
    ready: spike.ready === true,
    error: spike.error || null,
    loadMarker: spike.loadMarker || null,
  };
})()`;

function m3SpikePcLive(pc) {
  return (
    pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed"
  );
}

// call view の現在の window.__m3SpikeState/window.__selfmatrixPcs を読む。view が無い/破棄済みなら
// ok:false を返すだけで例外にはしない (呼び出し側のポーリングループを単純にするため、他の
// __selfmatrixE2E ヘルパーと同じ方針)。
async function readM3SpikeState(view) {
  if (!view || view.webContents.isDestroyed()) {
    return { ok: false, connected: false, reason: "no-view-or-destroyed" };
  }
  try {
    const value = await view.webContents.executeJavaScript(M3_SPIKE_STATE_SCRIPT, true);
    const pcs = value.pcs || [];
    const allLive = pcs.length >= 2 && pcs.every(m3SpikePcLive);
    return {
      ok: true,
      connected: allLive && value.dataChannelsOpen === true,
      pcs,
      dataChannelsOpen: value.dataChannelsOpen,
      loadMarker: value.loadMarker,
      error: value.error,
    };
  } catch (error) {
    return { ok: false, connected: false, reason: String(error && error.message ? error.message : error) };
  }
}

async function waitForM3SpikeConnected(view, timeoutMs) {
  const started = Date.now();
  let last = { ok: false, connected: false, reason: "timeout" };
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    last = await readM3SpikeState(view);
    if (last.ok && last.connected) return last;
    // eslint-disable-next-line no-await-in-loop
    await wait(150);
  }
  return last;
}

async function waitForM3SpikeCondition(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await wait(100);
  }
  return predicate();
}

// 1 ラウンド分 (シナリオ a〜d 全ステップ) を実行する。closeMode==="close-preserve" (採用方式) では
// 無再接続復帰の成立 (survived===true) を、closeMode==="closed-legacy" (対照、現行実装の再現) では
// 不成立 (survived===false) を期待する -- 期待どおりだったかどうかが round.pass。
async function runM3CloseSpikeRound(closeMode) {
  const round = { closeMode, expectSurvive: closeMode === "close-preserve" };
  try {
    // (a) callView 作成 → 自己ループバック接続確立。webContents.id と (did-start-navigation 由来の)
    // ナビゲーション回数を基準値として記録する。
    createCallViewIfNeeded();
    const testUrl = `${state.origin}/m3-close-spike-test.html`;
    await state.callView.webContents.loadURL(testUrl);
    const webContentsIdInitial = state.callView.webContents.id;
    const navCountAtLoad = state.navigationEvents.length;

    // E2E_RTC_WRAPPER_SCRIPT (M1 step 3c-1 計装) を先に注入してから window.__m3StartSpike() を呼ぶ --
    // window.RTCPeerConnection を計装で包み終えた後に pc1/pc2 を生成させることで、dom-ready
    // タイミングに依存せず両方が確実に window.__selfmatrixPcs に記録されるようにしてある
    // (m3-close-spike-test.html 冒頭コメント参照)。
    await state.callView.webContents.executeJavaScript(E2E_RTC_WRAPPER_SCRIPT, true);
    round.startResult = await state.callView.webContents.executeJavaScript("window.__m3StartSpike()", true);

    const initialConnect = await waitForM3SpikeConnected(state.callView, 15000);
    round.initialConnect = initialConnect;
    round.webContentsIdInitial = webContentsIdInitial;
    if (!initialConnect.ok || !initialConnect.connected) {
      round.pass = false;
      round.reason = "initial-connect-failed";
      return round;
    }
    const loadMarkerInitial = initialConnect.loadMarker;

    // (b) detachCallView(): メイン → callWindow へ再親子付け (対照実験のときだけ closeMode を
    // "closed-legacy" として素通しする -- detachCallView()/createCallWindow() コメント参照)。
    await detachCallView({ closeMode });
    await wait(400);
    const stateAfterDetach = await readM3SpikeState(state.callView);
    const afterDetach = {
      attachedTo: computeCallViewAttachedTo(),
      webContentsId: state.callView.webContents.id,
      webContentsDestroyed: state.callView.webContents.isDestroyed(),
      navCount: state.navigationEvents.length,
      connected: Boolean(stateAfterDetach.ok && stateAfterDetach.connected),
      loadMarker: stateAfterDetach.loadMarker,
    };
    round.afterDetach = afterDetach;
    const detachOk =
      afterDetach.attachedTo === "window" &&
      afterDetach.webContentsId === webContentsIdInitial &&
      !afterDetach.webContentsDestroyed &&
      afterDetach.navCount === navCountAtLoad &&
      afterDetach.connected &&
      afterDetach.loadMarker === loadMarkerInitial;
    round.detachOk = detachOk;
    if (!detachOk) {
      round.pass = false;
      round.reason = "detach-step-failed";
      return round;
    }

    // (c) 実際にユーザーが X ボタンを押すのと同じ経路で callWindow を close する
    // (win.destroy() ではなく win.close() -- createCallWindow() の closeMode 分岐参照)。
    const callWindowRef = state.callWindow;
    const callWindowIdBeforeClose = callWindowRef ? callWindowRef.id : null;
    callWindowRef.close();
    const windowDestroyed = await waitForM3SpikeCondition(() => !callWindowRef || callWindowRef.isDestroyed(), 8000);
    // close-preserve は preventDefault() 後に attachCallView() の完了を待ってから win.destroy() する
    // ため、破棄自体は少し遅れて起きる -- 破棄検知後さらに一呼吸置いて後続の非同期処理
    // (updateCallViewBounds 等) が収まるのを待つ。
    await wait(300);

    // (d) close 後の判定。
    const callViewStillReferenced = Boolean(state.callView);
    const webContentsDestroyedAfterClose = callViewStillReferenced ? state.callView.webContents.isDestroyed() : true;
    const attachedToAfterClose = computeCallViewAttachedTo();
    const stateAfterClose =
      callViewStillReferenced && !webContentsDestroyedAfterClose
        ? await readM3SpikeState(state.callView)
        : { ok: false, connected: false, reason: "destroyed-or-missing" };
    const afterClose = {
      windowDestroyed,
      callWindowIdBeforeClose,
      callViewStillReferenced,
      webContentsDestroyedAfterClose,
      webContentsId: callViewStillReferenced && !webContentsDestroyedAfterClose ? state.callView.webContents.id : null,
      attachedTo: attachedToAfterClose,
      navCount: state.navigationEvents.length,
      connected: Boolean(stateAfterClose.ok && stateAfterClose.connected),
      loadMarker: stateAfterClose.loadMarker ?? null,
      callViewState: state.callViewState,
      asyncErrorsSoFar: state.m3SpikeAsyncErrors.length,
    };
    round.afterClose = afterClose;

    const survived =
      windowDestroyed &&
      callViewStillReferenced &&
      !webContentsDestroyedAfterClose &&
      attachedToAfterClose === "main" &&
      afterClose.webContentsId === webContentsIdInitial &&
      afterClose.navCount === navCountAtLoad &&
      afterClose.connected &&
      afterClose.loadMarker === loadMarkerInitial &&
      state.callViewState !== "none";

    round.survived = survived;
    round.pass = survived === round.expectSurvive;
    return round;
  } catch (error) {
    round.pass = false;
    round.error = String(error && error.message ? error.message : error);
    return round;
  } finally {
    // 次ラウンドをクリーンな状態から始める。closeCallView() は callView/callWindow の現在の状態
    // (destroyed 済みの WebContentsView・null な callWindow 等) に関わらず安全に後始末できる設計
    // (closeCallView() 自身のコメント参照)。
    try {
      await closeCallView();
    } catch (error) {
      state.widgetMessages.push({
        t: Date.now(),
        type: "m3-close-spike-round-cleanup-error",
        error: String(error && error.message ? error.message : error),
      });
    }
    if (state.callWindow && !state.callWindow.isDestroyed()) {
      try {
        state.callWindow.destroy();
      } catch (error) {
        // ベストエフォート -- 後始末の失敗自体は round の pass/fail には影響させない。
      }
    }
    state.callWindow = null;
  }
}

async function runM3CloseSpikeProbe() {
  // 対照 (旧 "closed" 方式) を先に実測してから採用方式 (新 "close" 方式) を実測する。対照側で
  // Electron が子 view を巻き込み破棄する場合でも、後始末 (closeCallView()/callWindow.destroy()) は
  // state ベースの防御的コードなので、採用方式のラウンドは独立してクリーンな状態から始まる。
  const legacyRound = await runM3CloseSpikeRound("closed-legacy");
  const preserveRound = await runM3CloseSpikeRound("close-preserve");

  // 採用方式 (close-preserve) が実際に無再接続復帰を成立させたことが GO の必須条件。対照
  // (closed-legacy) は「期待どおり失敗した (survived===false)」ことを比較データとして記録するだけで
  // pass/fail のゲートにはしない -- 採用方式さえ動いていれば GO の判断は揺るがない (対照側だけ生き
  // 残り採用側が失敗するケースは、採用方式が対照の退避を包含する上位互換である以上あり得ない)。
  const pass = preserveRound.pass === true && preserveRound.survived === true;

  const result = {
    pass,
    adoptedCloseMode: "close-preserve",
    rounds: { legacy: legacyRound, preserve: preserveRound },
    comparison: {
      legacySurvived: legacyRound.survived ?? null,
      preserveSurvived: preserveRound.survived ?? null,
      legacyMatchedNoGoHypothesis: legacyRound.survived === false,
      preserveMatchedGoHypothesis: preserveRound.survived === true,
    },
    asyncErrors: state.m3SpikeAsyncErrors,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "m3-close-spike-result.json"),
    `${JSON.stringify(deepSanitizeEvidence(result), null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[m3-close-spike] FAIL:", JSON.stringify(result, null, 2));
  }

  state.sourcePickerWindow?.destroy();
  state.callWindow?.destroy();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

// M3 step 1/2 検証 (--m3-window-probe, design/m3-window-ux.md §2 サブステップ 1/2): 契約拡張
// (popoutCallView()/popinCallView()/onCallViewPlacement()) と close=復帰 production 化 + 窓
// サイズ/位置記憶を、production の呼び出し経路で駆動して検証する。runM3CloseSpikeProbe() との違い:
// あちらは main プロセスのモジュールスコープ関数 (detachCallView() 等) を直接呼ぶが、こちらは常に
// mainWindow (本番 topology、cinny 実バンドルがトップフレーム) の中で
// `window.selfmatrixNative.claimWidgetTransport()` を実際に claim し、そこから返る transport の
// `popoutCallView()`/`popinCallView()`/`onCallViewPlacement()` を呼ぶ — cinny-shell-smoke
// (runCinnyShellSmoke()) が transport.sendToView() 等を叩くのと同じやり方で、「契約 → IPC →
// detachCallView()/attachCallView()」という production の全経路を通す。
//
// pass/fail は各ステップの結果を素朴に記録するだけでなく (「記録だけ」を禁じるタスク要件)、
// steps.*.pass を AND した m3WindowProbeStepsPass() で判定する。どれか 1 ステップでも失敗すれば
// 以降のステップは実行せず即座に FAIL 終了する (m3-close-spike の「detach-step-failed 等で早期
// return する」構造と同じ)。
function m3WindowProbeStepsPass(steps) {
  const values = Object.values(steps);
  return values.length > 0 && values.every((step) => step && step.pass === true);
}

async function finishM3WindowProbe(steps, failReason) {
  const pass = failReason ? false : m3WindowProbeStepsPass(steps);
  const result = {
    pass,
    failReason: failReason || null,
    steps,
    // pushCallViewPlacement() が積む診断ログ (main 側の視点。cinny 側視点の履歴は各 steps.*.placementsSoFar
    // に別途記録済み — こちらは「main が実際に何回・何を push したか」の独立した証跡)。
    placementPushLog: state.callViewPlacementPushLog,
    asyncErrors: state.m3WindowProbeAsyncErrors,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "m3-window-probe-result.json"),
    `${JSON.stringify(deepSanitizeEvidence(result), null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[m3-window-probe] FAIL:", JSON.stringify(result, null, 2));
  }

  try {
    await closeCallView();
  } catch (error) {
    // ベストエフォート -- 後始末の失敗自体は pass/fail に影響させない (runM3CloseSpikeRound() の
    // finally ブロックと同じ方針)。
  }
  state.sourcePickerWindow?.destroy();
  if (state.callWindow && !state.callWindow.isDestroyed()) state.callWindow.destroy();
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy();
  state.server?.close();
  app.exit(result.pass ? 0 : 1);
}

async function runM3WindowProbe() {
  const win = state.mainWindow;
  const steps = {};

  try {
    // 0. cinny (本番 topology) のロード完了を待ってから、claim-once transport を 1 回だけ claim し、
    //    onCallViewPlacement() を購読する。runCinnyShellSmoke() の item 1/2 と同じやり方。
    await win.webContents.executeJavaScript(
      `(document.readyState === "complete" ? Promise.resolve() : new Promise((resolve) => {
        window.addEventListener("load", () => resolve(), { once: true });
      }))`,
      true,
    );
    const claimResult = await win.webContents.executeJavaScript(
      `(() => {
        try {
          window.__selfmatrixM3WindowProbe = {
            transport: window.selfmatrixNative.claimWidgetTransport(),
            placements: [],
          };
          window.__selfmatrixM3WindowProbe.unsubscribe =
            window.__selfmatrixM3WindowProbe.transport.onCallViewPlacement((placement) => {
              window.__selfmatrixM3WindowProbe.placements.push({ t: Date.now(), placement });
            });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) };
        }
      })()`,
      true,
    );
    steps.claim = { ...claimResult, pass: claimResult.ok === true };
    if (!steps.claim.pass) return await finishM3WindowProbe(steps, "claim-step-failed");

    // 1. call view (RTC 自己ループバック、m3-close-spike-test.html) を確立する。契約検証の対象は
    //    popout/popin/placement/close-revert/bounds であり、call view の作り方自体は
    //    m3-close-spike と揃えて最小化する (production では openCallView() が同じ役割を担う)。
    createCallViewIfNeeded();
    const testUrl = `${state.origin}/m3-close-spike-test.html`;
    await state.callView.webContents.loadURL(testUrl);
    const webContentsIdInitial = state.callView.webContents.id;
    await state.callView.webContents.executeJavaScript(E2E_RTC_WRAPPER_SCRIPT, true);
    const startResult = await state.callView.webContents.executeJavaScript("window.__m3StartSpike()", true);
    const initialConnect = await waitForM3SpikeConnected(state.callView, 15000);
    steps.initialConnect = {
      startResult,
      ...initialConnect,
      pass: initialConnect.ok === true && initialConnect.connected === true,
    };
    if (!steps.initialConnect.pass) return await finishM3WindowProbe(steps, "initial-connect-failed");
    const loadMarkerInitial = initialConnect.loadMarker;

    // 2. popoutCallView() (契約 → IPC → detachCallView()、既定 = close-preserve): 無再接続で別窓へ。
    const popoutResult = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popoutCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const afterPopout = await readM3SpikeState(state.callView);
    const attachedToAfterPopout = computeCallViewAttachedTo();
    const placementsAfterPopout = await win.webContents.executeJavaScript(
      "window.__selfmatrixM3WindowProbe.placements.map((p) => p.placement)",
      true,
    );
    steps.popout = {
      popoutResult,
      attachedTo: attachedToAfterPopout,
      webContentsId: state.callView.webContents.id,
      connected: Boolean(afterPopout.ok && afterPopout.connected),
      loadMarker: afterPopout.loadMarker,
      placementsSoFar: placementsAfterPopout,
      pass:
        popoutResult.ok === true &&
        attachedToAfterPopout === "window" &&
        state.callView.webContents.id === webContentsIdInitial &&
        Boolean(afterPopout.ok && afterPopout.connected) &&
        afterPopout.loadMarker === loadMarkerInitial &&
        Array.isArray(placementsAfterPopout) &&
        placementsAfterPopout.includes("window"),
    };
    if (!steps.popout.pass) return await finishM3WindowProbe(steps, "popout-step-failed");

    // 3. 窓サイズ/位置記憶: OS のマウスドラッグは自動化できないため (tray-probe 等と同じ方針)、
    //    win.setBounds() を直接呼んで「実ユーザーがリサイズ/移動した」のと同じ実イベント
    //    (resize/move) を発火させる。x は E2E_OFFSCREEN_WINDOW_POSITION (-4000) と同じ「画面外」
    //    帯に収め、テスト実行中に実ウィンドウが画面内へ動かないようにする (test-run-preferences の
    //    運用者方針)。デフォルト (960x640 / 中央配置) や E2E オフスクリーン既定値 (-4000,100) の
    //    どちらとも異なる値にして、後続の read-back 検証が偶然の一致でないことを担保する。
    const customBounds = { x: -3800, y: 133, width: 811, height: 622 };
    const callWindowBeforeClose = state.callWindow;
    callWindowBeforeClose.setBounds(customBounds);
    // Windows の DPI/フレーム丸め (実測: setBounds({width:811,...}) が getBounds() で 812 として
    // 読み戻る等) により、要求した customBounds と OS が実際に適用した値は 1px 単位でズレ得る。
    // 「要求値どおりに保存/復元されたか」ではなく「OS が実際に適用した値どおりに保存/復元されたか」
    // を検証対象にする — setBounds() 直後 (デバウンス待ちより前) に実値を読み直して基準にする。
    const actualWindowBoundsAfterSet = callWindowBeforeClose.getBounds();
    const [actualContentWidthAfterSet, actualContentHeightAfterSet] = callWindowBeforeClose.getContentSize();
    // saveCallWindowState() のデバウンス (CALL_WINDOW_STATE_SAVE_DEBOUNCE_MS) より確実に長く待つ。
    await wait(CALL_WINDOW_STATE_SAVE_DEBOUNCE_MS + 400);
    const callViewBoundsAfterResize = state.callView.getBounds();
    let persistedRaw = null;
    try {
      persistedRaw = JSON.parse(fs.readFileSync(callWindowStateFilePath(), "utf8"));
    } catch (error) {
      persistedRaw = null;
    }
    const loadedBackViaFunction = loadCallWindowState();
    steps.boundsPersistenceWrite = {
      customBounds,
      actualWindowBoundsAfterSet,
      callViewBoundsAfterResize,
      persistedRaw,
      loadedBackViaFunction,
      pass:
        callViewBoundsAfterResize.x === 0 &&
        callViewBoundsAfterResize.y === 0 &&
        callViewBoundsAfterResize.width === actualContentWidthAfterSet &&
        callViewBoundsAfterResize.height === actualContentHeightAfterSet &&
        Boolean(persistedRaw) &&
        persistedRaw.x === actualWindowBoundsAfterSet.x &&
        persistedRaw.y === actualWindowBoundsAfterSet.y &&
        persistedRaw.width === actualWindowBoundsAfterSet.width &&
        persistedRaw.height === actualWindowBoundsAfterSet.height &&
        Boolean(loadedBackViaFunction) &&
        loadedBackViaFunction.width === actualWindowBoundsAfterSet.width &&
        loadedBackViaFunction.height === actualWindowBoundsAfterSet.height,
    };
    if (!steps.boundsPersistenceWrite.pass) return await finishM3WindowProbe(steps, "bounds-persistence-write-failed");

    // 4. popinCallView() (契約 → IPC → attachCallView()): 無再接続往復の後半 + placement push "main"。
    const popinResult = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popinCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const afterPopin = await readM3SpikeState(state.callView);
    const attachedToAfterPopin = computeCallViewAttachedTo();
    const placementsAfterPopin = await win.webContents.executeJavaScript(
      "window.__selfmatrixM3WindowProbe.placements.map((p) => p.placement)",
      true,
    );
    steps.popin = {
      popinResult,
      attachedTo: attachedToAfterPopin,
      webContentsId: state.callView.webContents.id,
      connected: Boolean(afterPopin.ok && afterPopin.connected),
      loadMarker: afterPopin.loadMarker,
      placementsSoFar: placementsAfterPopin,
      pass:
        popinResult.ok === true &&
        attachedToAfterPopin === "main" &&
        state.callView.webContents.id === webContentsIdInitial &&
        Boolean(afterPopin.ok && afterPopin.connected) &&
        afterPopin.loadMarker === loadMarkerInitial &&
        Array.isArray(placementsAfterPopin) &&
        placementsAfterPopin.length >= 2 &&
        placementsAfterPopin[placementsAfterPopin.length - 1] === "main",
    };
    if (!steps.popin.pass) return await finishM3WindowProbe(steps, "popin-step-failed");

    // 5. close=復帰 (production): 契約経由で再度 popout し、今度は「ユーザーが別窓の X ボタンを押す」
    //    のと同じ経路 (win.close() -- win.destroy() ではない) を直接発火させる。cinny 側は
    //    popinCallView() を一度も呼んでいないのに main 側で勝手に "main" へ復帰する経路そのものを
    //    検証する (design §3-1/§3-2 の状態機械保護、design §3-5 の逆方向 push の両方がここで揃う)。
    const popoutAgain = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popoutCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const attachedToAfterSecondPopout = computeCallViewAttachedTo();
    const callWindowForClose = state.callWindow;
    const callWindowIdBeforeClose = callWindowForClose ? callWindowForClose.id : null;
    callWindowForClose.close();
    const windowDestroyed = await waitForM3SpikeCondition(
      () => !callWindowForClose || callWindowForClose.isDestroyed(),
      8000,
    );
    await wait(300);
    const afterCloseRevert = await readM3SpikeState(state.callView);
    const attachedToAfterCloseRevert = computeCallViewAttachedTo();
    const placementsAfterCloseRevert = await win.webContents.executeJavaScript(
      "window.__selfmatrixM3WindowProbe.placements.map((p) => p.placement)",
      true,
    );
    steps.closeRevert = {
      popoutAgain,
      attachedToAfterSecondPopout,
      windowDestroyed,
      callWindowIdBeforeClose,
      attachedToAfterCloseRevert,
      webContentsId: state.callView ? state.callView.webContents.id : null,
      webContentsDestroyed: state.callView ? state.callView.webContents.isDestroyed() : true,
      connected: Boolean(afterCloseRevert.ok && afterCloseRevert.connected),
      loadMarker: afterCloseRevert.loadMarker,
      callViewState: state.callViewState,
      placementsSoFar: placementsAfterCloseRevert,
      pass:
        popoutAgain.ok === true &&
        attachedToAfterSecondPopout === "window" &&
        windowDestroyed === true &&
        Boolean(state.callView) &&
        !state.callView.webContents.isDestroyed() &&
        state.callView.webContents.id === webContentsIdInitial &&
        attachedToAfterCloseRevert === "main" &&
        Boolean(afterCloseRevert.ok && afterCloseRevert.connected) &&
        afterCloseRevert.loadMarker === loadMarkerInitial &&
        state.callViewState !== "none" &&
        Array.isArray(placementsAfterCloseRevert) &&
        placementsAfterCloseRevert[placementsAfterCloseRevert.length - 1] === "main",
    };
    if (!steps.closeRevert.pass) return await finishM3WindowProbe(steps, "close-revert-step-failed");

    // 6. 窓サイズ read-back: close=復帰で state.callWindow は null に戻っている
    //    (createCallWindow() の close ハンドラ参照)。再度 popoutCallView() すれば createCallWindow()
    //    が新しい BrowserWindow を作り直す — そのときに step 3 で永続化した bounds
    //    (actualWindowBoundsAfterSet — OS 適用後の実値、customBounds そのものではない点は step 3
    //    コメント参照) が実際に初期 bounds として復元されることを、新しいウィンドウの実
    //    win.getBounds() から確認する (x/y は e2eOffscreenBrowserWindowOptions() が常にオフスクリーン
    //    座標で上書きする -- テストが実ウィンドウを画面内に出さないための意図的な仕様、
    //    createCallWindow() のコメント参照 -- のでここでは width/height のみを比較する。x/y の
    //    永続化そのものは step 3 で persistedRaw/loadedBackViaFunction により既に確認済み)。
    const popoutThirdTime = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popoutCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const newCallWindow = state.callWindow;
    const newCallWindowBounds = newCallWindow && !newCallWindow.isDestroyed() ? newCallWindow.getBounds() : null;
    // Windows の DPI/フレーム丸めは既存ウィンドウへの setBounds() (step 3) だけでなく、新規
    // BrowserWindow 生成時の初期 bounds 適用でも独立に ±1px 程度発生し得る (実測: 623 で保存した
    // 高さが新規生成後に 624 として読める、等)。JSON ファイルへの保存値そのものはバイト単位で正確
    // であること (persistedRaw/loadedBackViaFunction, step 3) を既に確認済みなので、ここでは「新規
    // ウィンドウが前回保存サイズの近傍で復元されたか」を小さな許容誤差 (OS 丸めの範囲を十分に
    // カバーしつつ、明らかな未適用 (例: 既定の 960x640 のまま) は確実に弾ける値) で判定する。
    const BOUNDS_READBACK_TOLERANCE_PX = 4;
    const widthDelta = newCallWindowBounds ? Math.abs(newCallWindowBounds.width - actualWindowBoundsAfterSet.width) : Infinity;
    const heightDelta = newCallWindowBounds
      ? Math.abs(newCallWindowBounds.height - actualWindowBoundsAfterSet.height)
      : Infinity;
    steps.boundsReadBack = {
      popoutThirdTime,
      newCallWindowId: newCallWindow ? newCallWindow.id : null,
      isNewWindowInstance: Boolean(newCallWindow) && newCallWindow.id !== callWindowIdBeforeClose,
      newCallWindowBounds,
      widthDelta,
      heightDelta,
      pass:
        popoutThirdTime.ok === true &&
        Boolean(newCallWindow) &&
        newCallWindow.id !== callWindowIdBeforeClose &&
        Boolean(newCallWindowBounds) &&
        widthDelta <= BOUNDS_READBACK_TOLERANCE_PX &&
        heightDelta <= BOUNDS_READBACK_TOLERANCE_PX,
    };
    // 元は最終ステップだったため早期 return が無かったが、以下の追加ステップがこのステップの
    // 成功 (newCallWindow が生きていること) を前提にするので、他ステップと同じ fail-fast へ揃える。
    if (!steps.boundsReadBack.pass) return await finishM3WindowProbe(steps, "bounds-read-back-failed");

    // 7. 通話の別窓の最前面ピン留め (M3 LATER 項目、運用者が実装 GO)。まず「既定 OFF」を検証する。
    //    直前の callWindow (step 6 で作られたもの) の isAlwaysOnTop() をそのまま読むだけでは、
    //    それが生成された時点の設定しか見えず「今の既定値」の検証にならない。evidence/.test-userdata
    //    は test-runner モード間で共有される (isTestRunnerMode 定義直後のコメント参照) ため、設定
    //    ファイル自体をまず消してから、close=復帰 (step 5/6 と同じ close-preserve の win.close()) で
    //    実際に破棄させ、再度 popoutCallView() で createCallWindow() に新しい BrowserWindow を
    //    作らせた上で確認する -- 過去の実行の残骸に依存しない決定的な検証にするため。
    try {
      fs.unlinkSync(callWindowAlwaysOnTopStateFilePath());
    } catch (error) {
      // 無ければ何もしない (初回実行では当然存在しない) -- loadCallWindowState() と同じ fail-safe。
    }
    const windowBeforeDefaultCheck = state.callWindow;
    windowBeforeDefaultCheck.close();
    const defaultCheckWindowDestroyed = await waitForM3SpikeCondition(
      () => !windowBeforeDefaultCheck || windowBeforeDefaultCheck.isDestroyed(),
      8000,
    );
    await wait(300);
    const popoutForDefaultCheck = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popoutCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const alwaysOnTopDefaultWindow = state.callWindow;
    const alwaysOnTopDefaultValue =
      Boolean(alwaysOnTopDefaultWindow) && !alwaysOnTopDefaultWindow.isDestroyed()
        ? alwaysOnTopDefaultWindow.isAlwaysOnTop()
        : null;
    steps.alwaysOnTopDefault = {
      defaultCheckWindowDestroyed,
      popoutForDefaultCheck,
      isNewWindowInstance: Boolean(alwaysOnTopDefaultWindow) && alwaysOnTopDefaultWindow.id !== windowBeforeDefaultCheck.id,
      alwaysOnTopDefaultValue,
      pass:
        defaultCheckWindowDestroyed === true &&
        popoutForDefaultCheck.ok === true &&
        Boolean(alwaysOnTopDefaultWindow) &&
        alwaysOnTopDefaultWindow.id !== windowBeforeDefaultCheck.id &&
        alwaysOnTopDefaultValue === false,
    };
    if (!steps.alwaysOnTopDefault.pass) return await finishM3WindowProbe(steps, "always-on-top-default-failed");

    // 8. トレイの click ハンドラと同じ関数を直接呼ぶ (tray-probe の autoLaunchToggle 検証と同じ
    //    流儀: trayMenuTemplate() は状態を持たない純関数なので、実トレイを作らないこのモード
    //    (trayEnabled=false, isTestRunnerMode 参照) からも同じ click 関数参照をそのまま呼べる)。
    //    1 回目で true、2 回目で false に戻ることを確認する。
    const findAlwaysOnTopMenuItem = () =>
      trayMenuTemplate().find((item) => item.label === CALL_WINDOW_ALWAYS_ON_TOP_MENU_LABEL);
    const menuItemFound = Boolean(findAlwaysOnTopMenuItem());
    findAlwaysOnTopMenuItem()?.click();
    const afterFirstToggle = state.callWindow.isAlwaysOnTop();
    findAlwaysOnTopMenuItem()?.click();
    const afterSecondToggle = state.callWindow.isAlwaysOnTop();
    steps.alwaysOnTopToggle = {
      menuItemFound,
      afterFirstToggle,
      afterSecondToggle,
      pass: menuItemFound && afterFirstToggle === true && afterSecondToggle === false,
    };
    if (!steps.alwaysOnTopToggle.pass) return await finishM3WindowProbe(steps, "always-on-top-toggle-failed");

    // 9. 永続化の検証: 設定を true にした状態で callWindow を実際に破棄→再生成し、生成直後
    //    (setAlwaysOnTop() を明示的に呼び直す前) から true になっていることを見る -- step 7 と同じ
    //    close=復帰 + 再 popout の経路。
    findAlwaysOnTopMenuItem()?.click(); // step 8 の終値 (false) → true
    const alwaysOnTopBeforeRecreate = state.callWindow.isAlwaysOnTop();
    const windowBeforeRecreate = state.callWindow;
    windowBeforeRecreate.close();
    const recreateSourceDestroyed = await waitForM3SpikeCondition(
      () => !windowBeforeRecreate || windowBeforeRecreate.isDestroyed(),
      8000,
    );
    await wait(300);
    const popoutForRecreate = await win.webContents.executeJavaScript(
      `window.__selfmatrixM3WindowProbe.transport.popoutCallView()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))`,
      true,
    );
    await wait(300);
    const recreatedWindow = state.callWindow;
    const alwaysOnTopAfterRecreate =
      Boolean(recreatedWindow) && !recreatedWindow.isDestroyed() ? recreatedWindow.isAlwaysOnTop() : null;
    steps.alwaysOnTopPersistAcrossRecreate = {
      alwaysOnTopBeforeRecreate,
      recreateSourceDestroyed,
      popoutForRecreate,
      isNewWindowInstance: Boolean(recreatedWindow) && recreatedWindow.id !== windowBeforeRecreate.id,
      alwaysOnTopAfterRecreate,
      pass:
        alwaysOnTopBeforeRecreate === true &&
        recreateSourceDestroyed === true &&
        popoutForRecreate.ok === true &&
        Boolean(recreatedWindow) &&
        recreatedWindow.id !== windowBeforeRecreate.id &&
        alwaysOnTopAfterRecreate === true,
    };

    // 後始末: evidence/.test-userdata は test-runner モード間で共有される (上記コメント参照)。
    // このステップが true のまま終わっても次回実行時は step 7 の unlinkSync が既定 OFF 検証を
    // 決定的にするので実害は無いが、他 probe が誤ってこの設定ファイルを読む余地を残さないよう
    // pass/fail に関係なくベストエフォートで既定へ戻しておく。
    try {
      saveCallWindowAlwaysOnTopEnabled(false);
      if (state.callWindow && !state.callWindow.isDestroyed()) state.callWindow.setAlwaysOnTop(false);
    } catch (error) {
      // ベストエフォート。
    }

    return await finishM3WindowProbe(steps, null);
  } catch (error) {
    steps.uncaught = { error: String(error && error.message ? error.message : error), pass: false };
    return await finishM3WindowProbe(steps, "uncaught-error");
  }
}

// M2 minisign 署名検証: --minisign-probe の本体。plain node 版 probe (minisign-verify-probe.cjs)
// と意図して独立にテストベクタを組み立てる (検証ロジックのバグをテストコード側のバグで隠す
// リスクを避けるため、他の probe との使い回しはしない)。ここで確かめたいことは 3 つだけ:
//   1. この Electron プロセスの node:crypto に blake2b512 が本当に無い
//      (NATIVE_BLAKE2B512_AVAILABLE === false であること自体を実測する — Electron が将来
//      blake2b512 をネイティブに持つようになったらこの assertion は書き換えが要る、という意味で
//      「今の Electron 43 の事実」のスナップショットである点に注意)。
//   2. その状態で prehashed (BLAKE2b-512, 現行既定) の正当な署名が ok:true になる
//      (= minisign-blake2b.cjs のピュア JS フォールバックを経由して実際に検証が成立している)。
//   3. ファイル改ざんは ok:false になる (= フォールバック経路でも検証が「何でも通す」ザルになって
//      いない)。
// legacy ('Ed') 経路も同じ 2 点 (正当 -> true / 改ざん -> false) を併せて確認する (Ed25519 自体は
// BLAKE2b と無関係だが、Electron の node:crypto 上で Ed25519 + JWK raw key 変換が動くこと自体は
// legacy 経路でしか単独確認できないため)。
async function runMinisignProbe() {
  await app.whenReady();
  const crypto = require("node:crypto");

  function rawPublicKeyBytes(publicKeyObject) {
    const jwk = publicKeyObject.export({ format: "jwk" });
    return Buffer.from(jwk.x, "base64url");
  }
  function encodePublicKeyFile({ comment, keyId, publicKeyObject }) {
    const raw = rawPublicKeyBytes(publicKeyObject);
    const blob = Buffer.concat([Buffer.from("Ed", "ascii"), keyId, raw]);
    return `untrusted comment: ${comment}\n${blob.toString("base64")}\n`;
  }
  function encodeSignatureFile({ comment, keyId, algBytes, fileBytes, trustedComment, privateKey }) {
    const message = algBytes === "ED" ? blake2b512(fileBytes) : fileBytes;
    const signature = crypto.sign(null, message, privateKey);
    const sigBlob = Buffer.concat([Buffer.from(algBytes, "ascii"), keyId, signature]);
    const globalMessage = Buffer.concat([sigBlob, Buffer.from(trustedComment, "utf8")]);
    const globalSignature = crypto.sign(null, globalMessage, privateKey);
    return (
      `untrusted comment: ${comment}\n${sigBlob.toString("base64")}\n` +
      `trusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`
    );
  }
  function flipByte(buf, index) {
    const copy = Buffer.from(buf);
    copy[index] = copy[index] ^ 0xff;
    return copy;
  }

  const keyPair = crypto.generateKeyPairSync("ed25519"); // 使い捨て。プロセス内のみ、どこにも書き出さない。
  const keyId = crypto.randomBytes(8);
  const fileBytes = crypto.randomBytes(8192); // installer に見立てたダミーバイナリ
  const tamperedFileBytes = flipByte(fileBytes, 4096);
  const publicKeyText = encodePublicKeyFile({
    comment: "minisign electron probe test key (self-generated, not real minisign output)",
    keyId,
    publicKeyObject: keyPair.publicKey,
  });

  const algResults = {};
  for (const algBytes of ["ED", "Ed"]) {
    const trustedComment = `timestamp:1735689600\tfile:SelfMatrix-Setup-0.1.0.exe\talg:${algBytes}`;
    const sigText = encodeSignatureFile({
      comment: "minisign electron probe test signature",
      keyId,
      algBytes,
      fileBytes,
      trustedComment,
      privateKey: keyPair.privateKey,
    });
    const validResult = verifyMinisign({ fileBytes, sigText, publicKeyText });
    const tamperedResult = verifyMinisign({ fileBytes: tamperedFileBytes, sigText, publicKeyText });
    algResults[algBytes] = {
      validOk: validResult.ok === true,
      validResult,
      tamperedRejected: tamperedResult.ok === false,
      tamperedResult,
    };
  }

  const result = {
    pass:
      NATIVE_BLAKE2B512_AVAILABLE === false &&
      algResults.ED.validOk &&
      algResults.ED.tamperedRejected &&
      algResults.Ed.validOk &&
      algResults.Ed.tamperedRejected,
    // このプロセス (Electron のメインプロセス) の node:crypto に blake2b512 が無いことの実測。
    // false であること自体が「prehashed 経路は minisign-blake2b.cjs のピュア JS フォールバックを
    // 通っている」ことの証拠になる (native が使えるなら fallback は経由されず、この probe は
    // production の懸念点を検証したことにならない)。
    nativeBlake2b512Available: NATIVE_BLAKE2B512_AVAILABLE,
    prehashed: algResults.ED,
    legacy: algResults.Ed,
    electron: process.versions.electron,
    node: process.versions.node,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "minisign-electron-probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[minisign-electron-probe] FAIL:", JSON.stringify(result, null, 2));
  }

  app.exit(result.pass ? 0 : 1);
}

async function main() {
  await app.whenReady();
  // SelfMatrix is a Discord-style application shell, so Electron's default
  // File/Edit/View/Window application menu is not part of the product UI.
  // Removing the application menu also removes it from call popout windows.
  Menu.setApplicationMenu(null);
  if (!fs.existsSync(path.join(cinnyDist, "index.html"))) {
    throw new Error(
      `Cinny dist not found: ${cinnyDist}\n` +
        (app.isPackaged
          ? // M2 3b: 製品パッケージでこのエラーに到達するのは electron-builder.yml の
            // extraResources (cinny の `../cinny/dist` -> `resources/cinny-dist`) が正しく
            // 同梱されなかった場合のみ (パッケージングの不備) -- 開発者向けの sibling checkout
            // 案内は製品パッケージには存在しない `../cinny` を指すため無意味であり、代わりに
            // パッケージング側の問題であることが分かる文言にする。
            "This is a packaged build (app.isPackaged=true) — the bundled cinny dist is missing or corrupt. " +
              "Rebuild with electron-builder after ensuring a sibling '../cinny' checkout has a fresh " +
              "'npm run build:native' output (electron-builder.yml extraResources copies '../cinny/dist' to " +
              "'resources/cinny-dist' at package time)."
          : // SelfMatrix M2: cinny の web ビルド (`npm run build`) は native シェル検出コードを
            // tree-shake で除去するため、この native シェルと組み合わせるには
            // `npm run build:native` (VITE_SELFMATRIX_NATIVE=true) でビルドした dist が必要
            // (README.md 「開発手順」参照)。
            "Build it first: in a sibling '../cinny' checkout, run 'npm run build:native' (output goes to '../cinny/dist'). Do NOT use plain 'npm run build' — it tree-shakes out the native bridge this shell requires.\n" +
              "Or point SELFMATRIX_CINNY_DIST at an existing build:native output directory."),
    );
  }
  if (!fs.existsSync(path.join(ecDist, "index.html"))) {
    throw new Error(
      `Element Call dist not found: ${ecDist}\n` +
        (app.isPackaged
          ? "This is a packaged build (app.isPackaged=true) — the bundled Element Call dist is missing or " +
              "corrupt. Rebuild with electron-builder after ensuring a sibling '../element-call' checkout has a " +
              "fresh 'pnpm build:embedded' output (electron-builder.yml extraResources copies " +
              "'../element-call/dist' to 'resources/ec-dist' at package time)."
          : "Build it first: in a sibling '../element-call' checkout, run 'pnpm build:embedded' (output goes to '../element-call/dist').\n" +
              "Or point SELFMATRIX_EC_DIST at an existing build directory."),
    );
  }

  setupIpc();
  setupSourcePickerIpc();
  setupDisplayMediaHandler();
  setupE2EIntrospection();
  await startServer();
  createMainWindow();
  if (focusRequestedBySecondInstance) handleTrayActivate();
  // M2 トレイ常駐: trayEnabled (本番起動、または --tray-probe) のときだけ生成する。
  // テスト/E2E モード (isSmoke/isMemoryProbe/isCinnyShellSmoke/isE2ERealJoin/isHarness) では
  // 呼ばれない (trayEnabled の定義参照)。
  if (trayEnabled) createTray();
  // M2 3b electron-updater 配線: フックの配線自体 (verifyUpdateCodeSignature/allowDowngrade の
  // 代入、update-downloaded リスナー登録) はネットワークに一切触れないため、どのモードで起動しても
  // 無条件に行う。実際に外部 (GitHub Releases) へ問い合わせる checkForUpdatesAndNotify() は
  // maybeCheckForUpdates() 内部の shouldEnableAutoUpdater() が判定し、本番パッケージ + 本番トポロジ
  // + テスト/probe モードでない場合だけ呼ばれる (isUpdaterTestMode の定義箇所参照)。
  setupAutoUpdater();
  maybeCheckForUpdates();
  // 外部ミュート制御 選択肢 A: 本番相当の起動でのみ、永続化された enabled: true を実際の
  // globalShortcut 登録へ反映する (isExternalMuteHotkeyProductionRun の定義箇所コメント参照)。
  if (isExternalMuteHotkeyProductionRun) applyExternalMuteHotkeyFromPersistedState();
  // 選択肢 B: 同じく本番相当の起動でのみ、永続化された enabled: true を実際の listen() へ反映する
  // (isExternalApiProductionRun の定義箇所コメント参照)。
  if (isExternalApiProductionRun) await applyExternalApiFromPersistedState();
  if (isSmoke) await runSmoke();
  if (isMemoryProbe) await runMemoryProbe();
  if (isCinnyShellSmoke) await runCinnyShellSmoke();
  if (isTrayProbe) await runTrayProbe();
  if (isM3CloseSpike) await runM3CloseSpikeProbe();
  if (isM3WindowProbe) await runM3WindowProbe();
  if (isExternalMuteProbe) await runExternalMuteProbe();
  if (isExternalApiProbe) await runExternalApiProbe();
}

function evidenceFileForMode() {
  if (isCinnyShellSmoke) return "cinny-shell-result.json";
  if (isMemoryProbe) return "memory-result.json";
  if (isTrayProbe) return "tray-probe-result.json";
  if (isM3CloseSpike) return "m3-close-spike-result.json";
  if (isM3WindowProbe) return "m3-window-probe-result.json";
  if (isExternalMuteProbe) return "external-mute-probe-result.json";
  if (isExternalApiProbe) return "external-api-probe-result.json";
  return "smoke-result.json";
}

// M2 3b electron-updater 配線: --update-wiring-probe 専用モード。isMinisignProbe と同じ理由で
// main() の重いブート経路 (cinny/EC dist 存在確認・HTTP サーバー・ウィンドウ生成) を経由しない。
//
// 検証する内容:
  //   1. setupAutoUpdater() が stock singleton ではなく MinisignNsisUpdater を構築し、
  //      allowDowngrade=false / disableWebInstaller=true を設定すること。
//   2. このプロセス自身は dev/unpacked 実行 (app.isPackaged===false) であり、
//      isUpdaterTestMode も true (--update-wiring-probe 自体が isUpdaterTestMode に含まれる) なので
//      maybeCheckForUpdates() を呼んでも checkForUpdatesAndNotify() が実際には一切呼ばれない
//      (外部通信させない) こと -- autoUpdater.checkForUpdatesAndNotify をスパイに差し替えて実測する。
//   3. shouldEnableAutoUpdater()/shouldApplyUpdateNow() (update-apply-gate.cjs) の主要な分岐
//      (本番パッケージ+本番トポロジ+非テストのときだけ有効化される、通話中は適用しない等) を、
//      このプロセスでは作れない app.isPackaged===true のケースも含めて合成入力で検証する
//      (全分岐の網羅は probe:update-apply-gate 側、ここでは配線が実際にこの純関数を使っている
//      ことの統合的な確認に絞る)。
async function runUpdateWiringProbe() {
  await app.whenReady();

  const autoUpdater = setupAutoUpdater();

  // 実 electron-updater 実装 (ネットワークへ問い合わせる) は決して呼ばない (外部通信させない
  // 絶対条件) -- スパイに差し替え、呼ばれてはならない経路をこの probe が実際に踏んだかどうかだけを
  // 記録する no-op にする。
  let checkForUpdatesAndNotifyCalled = false;
  autoUpdater.checkForUpdatesAndNotify = () => {
    checkForUpdatesAndNotifyCalled = true;
    return Promise.resolve(null);
  };

  const calledForThisProcess = maybeCheckForUpdates();

  const hookWiring = {
    minisignNsisUpdater: autoUpdater instanceof MinisignNsisUpdater,
    allowDowngradeFalse: autoUpdater.allowDowngrade === false,
    webInstallerDisabled: autoUpdater.disableWebInstaller === true,
  };
  hookWiring.pass =
    hookWiring.minisignNsisUpdater && hookWiring.allowDowngradeFalse && hookWiring.webInstallerDisabled;

  const noNetworkCallInTestMode = {
    isPackaged: Boolean(app.isPackaged),
    isUpdaterTestMode,
    autoUpdaterEnabled: state.autoUpdaterEnabled,
    maybeCheckForUpdatesReturnedFalse: calledForThisProcess === false,
    checkForUpdatesAndNotifyCalled,
    pass:
      state.autoUpdaterEnabled === false &&
      calledForThisProcess === false &&
      checkForUpdatesAndNotifyCalled === false,
  };

  // 合成入力での分岐検証 (このプロセス自身の app.isPackaged は常に false だが、
  // shouldEnableAutoUpdater()/shouldApplyUpdateNow() は Electron 非依存の純関数なので
  // 実行環境と無関係に全分岐を検証できる -- probe:update-apply-gate と重複するが、「main.cjs が
  // 実際にこの関数を正しい引数で使っている」ことまで確認する意図で意図的に薄く再掲する)。
  const gateMatrix = [
    { isPackaged: true, isCinnyShell: true, isTestMode: false, expectEnabled: true },
    { isPackaged: false, isCinnyShell: true, isTestMode: false, expectEnabled: false },
    { isPackaged: true, isCinnyShell: false, isTestMode: false, expectEnabled: false },
    { isPackaged: true, isCinnyShell: true, isTestMode: true, expectEnabled: false },
  ].map((testCase) => {
    const enabled = shouldEnableAutoUpdater(testCase);
    return { ...testCase, enabled, pass: enabled === testCase.expectEnabled };
  });
  const gateMatrixPass = gateMatrix.every((entry) => entry.pass);

  const applyMatrix = [
    { enabled: true, updateReady: true, callActive: false, expectApply: true },
    { enabled: true, updateReady: true, callActive: true, expectApply: false },
    { enabled: true, updateReady: false, callActive: false, expectApply: false },
    { enabled: false, updateReady: true, callActive: false, expectApply: false },
  ].map((testCase) => {
    const apply = shouldApplyUpdateNow(testCase);
    return { ...testCase, apply, pass: apply === testCase.expectApply };
  });
  const applyMatrixPass = applyMatrix.every((entry) => entry.pass);

  const result = {
    pass: hookWiring.pass && noNetworkCallInTestMode.pass && gateMatrixPass && applyMatrixPass,
    hookWiring,
    noNetworkCallInTestMode,
    gateMatrix,
    applyMatrix,
    electron: process.versions.electron,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "update-wiring-probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  if (!result.pass) {
    console.error("[update-wiring-probe] FAIL:", JSON.stringify(result, null, 2));
  }

  app.exit(result.pass ? 0 : 1);
}

async function runUpdateDownloadProbeMode() {
  await app.whenReady();
  const result = await runUpdateDownloadProbe();
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "update-download-probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  if (!result.pass) {
    console.error("[update-download-probe] FAIL:", JSON.stringify(result, null, 2));
  }
  app.exit(result.pass ? 0 : 1);
}

async function runSingleInstanceProbeMode() {
  await app.whenReady();
  const prefix = "--single-instance-probe-dir=";
  const directoryArgument = process.argv.find((value) => value.startsWith(prefix));
  if (!directoryArgument) throw new Error("--single-instance-probe-dir is required");
  const probeDir = path.resolve(directoryArgument.slice(prefix.length));
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "ready"), "ready\n", "utf8");

  const deadline = Date.now() + 10_000;
  while (secondInstanceEventCount === 0 && Date.now() < deadline) {
    await wait(50);
  }
  const result = {
    pass: secondInstanceEventCount === 1 && state.mainWindow === null && state.tray === null,
    secondInstanceEventCount,
    mainWindowCreated: state.mainWindow !== null,
    trayCreated: state.tray !== null,
  };
  fs.writeFileSync(path.join(probeDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  app.exit(result.pass ? 0 : 1);
}

if (app) {
  if (!hasSingleInstanceLock) {
    // app.exit(0) was requested immediately after the lock failed. Do not enter any run mode.
  } else {
    // --minisign-probe / --update-wiring-probe は main() の重いブート経路 (cinny/EC dist 存在確認・
    // HTTP サーバー・ウィンドウ生成) を必要としない (各 run*Probe() 冒頭のコメント参照) ため、main() を
    // 経由せず独立に起動する。
    if (isSingleInstanceProbe) {
      runSingleInstanceProbeMode().catch((error) => {
        console.error(error);
        app.exit(1);
      });
    } else if (isMinisignProbe) {
      runMinisignProbe().catch((error) => {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceDir, "minisign-electron-probe-result.json"),
          `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
          "utf8",
        );
        console.error(error);
        app.exit(1);
      });
    } else if (isUpdateWiringProbe) {
      runUpdateWiringProbe().catch((error) => {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceDir, "update-wiring-probe-result.json"),
          `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
          "utf8",
        );
        console.error(error);
        app.exit(1);
      });
    } else if (isUpdateDownloadProbe) {
      runUpdateDownloadProbeMode().catch((error) => {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceDir, "update-download-probe-result.json"),
          `${JSON.stringify({ pass: false, error: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
          "utf8",
        );
        console.error(error);
        app.exit(1);
      });
    } else {
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
    }
  }
} else if (require.main === module) {
  throw new Error("selfmatrix-desktop requires Electron. Use `electron src/main.cjs`.");
}
