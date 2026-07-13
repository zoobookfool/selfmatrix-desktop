#!/usr/bin/env node
/**
 * SelfMatrix M1 step 3c-2/3c-3 — 2 ユーザー通話 + 配信 + 窓移動無再接続 + 7 語彙実 DOM 検証の E2E。
 *
 * native-join.e2e.mjs (M1 step 3c-1) が実証した「alice 1 人の実ログイン→実 LiveKit join」の先を
 * 検証する。本物のローカル dev Matrix/LiveKit スタックが起動していることを前提に、
 * playwright-core の `_electron` API で prototype の Electron を **2 プロセス** (alice/bob それぞれ
 * 独立した Electron インスタンス、HTTP サーバは各プロセスがポート 0 バインドするため衝突しない)
 * 実起動し、以下を実際に動かして検証する:
 *
 *   1. alice が native-join と同じ経路 (cinny 実ログイン → Voice Lounge → 参加) で join する。
 *   2. bob (2 人目) を 2 個目の Electron インスタンスで同じ経路で join させ、alice 側から見て
 *      2 ユーザー通話が成立したことを実測する (参加者タイル数 + inbound-rtp audio 増加)。
 *   3. alice 側の claim 済み transport から互換 RPC の 7 語彙
 *      (toggleScreenshare/toggleSpotlight/toggleEmphasis/toggleReactions/toggleSettings/
 *      setSoundOff/setSoundOn) を実行し、実 in-call DOM への到達と `onCallControlState` push に
 *      よる再同期 (main の中継記録 + cinny 自身の DOM の両方) を確認する。
 *   4. alice が screenshare 中の状態で、通話 view をメインウィンドウ⇔別ウィンドウ間で 10 往復
 *      (SelfMatrix M3 step 5、M3 の受け入れ条件そのもの — design/m3-window-ux.md §4「通話中の窓
 *      出し入れ 10 往復で切断ゼロ」)、`__selfmatrixE2E.detachCallView()/attachCallView()` の直接
 *      呼び出しで再親子付けし、無再接続 (新規 RTCPeerConnection ゼロ・接続維持・メディア継続・bob
 *      側無影響) であることを実測する。10 往復とも、main.cjs の実際の contentView 階層
 *      (`callViewAttachedTo`, state 文字列とは独立した積極的証拠) が detach 後に "window"、
 *      attach 後に "main" へ実際に遷移したことも確認する (H1、受け入れレビュー修正 -- state だけ
 *      書き換えて実体を動かさない no-op 化回帰の検知)。
 *   4.5 Element Call の共通通話バーにある別窓/戻す/固定/全画面ボタンを実クリックし、
 *      trusted preload → validated IPC → WebContentsView reparenting の製品経路と無再接続を検証する。
 *   4.6 (SelfMatrix M3 step 5、M3 の最重要判定) 別窓をユーザーが実際に閉じたとき
 *      (`__selfmatrixE2E.closeCallWindow()` = `state.callWindow.close()`、win.destroy() ではない
 *      実 X ボタンと同じ経路) の「メインへの自動復帰・無再接続・通話継続 (dispose 誤発火なし)」を
 *      実測する (`runCloseWindowMainRevert()`)。
 *   5. cinny (mainWindow) と call view (別 session partition) 間の `matrix-setting-*`
 *      localStorage 契約が分離後も生きるかを実測する (M1 step 3c-2 で発見・修正した契約: 詳細は
 *      README とこのファイル内 `verifyLocalStorageContract()` のコメント参照)。
 *   6. 共通通話バーで画質/FPS を変更し、同じ Element Call renderer が次回共有へ設定を
 *      適用することと、ネイティブ共有元ピッカーを通ることを実測する。
 *
 * **絶対条件 (native-join.e2e.mjs と同一)**: 実オーディオデバイス不使用 (fake media)、
 * dev パスワードは環境変数からのみ (`SELFMATRIX_E2E_PASSWORD_ALICE`/`_BOB`)、証跡・ログに
 * パスワードや個人絶対パスを書かない。
 *
 * ログイン/モーダル片付け/ルーム参加/main プロセス内部状態の読み取り/サニタイズといった alice・bob
 * 共通のロジックは `e2e/lib/nativeE2ELib.mjs` に集約されている (native-join.e2e.mjs もこれを使う)。
 *
 * pass 判定は全条件の論理積 (`result.pass`) のみが exit code を左右する — 記録用フィールドが
 * 途中にあっても、それ単体で pass を左右することはない。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import {
  bridgeDetectedFromSnapshot,
  checkBackendReachable,
  deepSanitize,
  dismissBlockingModals,
  driveSourcePicker,
  evalInCallView,
  fromViewJoinObserved,
  getMainProcessSnapshot,
  launchNativePrototype,
  loginAsUser,
  makeLogger,
  openVoiceLoungeAndJoin,
  requireEnv,
  resolveElementCallDir,
  ROOM_NAME,
  wait,
  waitForCondition,
} from "./lib/nativeE2ELib.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativePrototypeDir = path.resolve(__dirname, "..");
const evidenceDir = path.join(nativePrototypeDir, "evidence");

const { log, failFast } = makeLogger("native-callflow-e2e");

// SelfMatrix M3 step 5 (M3 の受け入れ条件そのもの、design/m3-window-ux.md §4): 「通話中の窓出し入れ
// 10 往復で切断ゼロ」を満たすため、M1/M3 step 3 まで使っていた 3 往復から引き上げた。判定ロジック
// (runWindowMoveReparenting() 側) は不変 -- ラウンド数だけがここで変わる。
const REPARENT_ROUND_TRIPS = 10;
const REPARENT_SETTLE_MS = 800;

// ---- call view 内で評価する再利用スクリプト群 ---------------------------------------------

const PCS_SUMMARY_SCRIPT = `(window.__selfmatrixPcs || []).map((r) => ({
  id: r.id,
  connectionState: r.connectionState,
  iceConnectionState: r.iceConnectionState,
  reachedConnected: r.reachedConnected,
}))`;

// M1 step 3c-2: outbound-rtp (screenshare video) の bytesSent と inbound-rtp (audio) の
// bytesReceived を、注入済み RTCPeerConnection ラッパが保持する生の pc 参照 (r._pc,
// main.cjs の E2E_RTC_WRAPPER_SCRIPT 参照) から getStats() で実測する。LiveKit は publish 用/
// subscribe 用に複数の RTCPeerConnection を使う実装のため、全 pc にわたって集計する。
const RTP_STATS_SCRIPT = `(async () => {
  const pcs = window.__selfmatrixPcs || [];
  let audioBytesReceived = 0;
  let videoBytesReceived = 0;
  let videoBytesSent = 0;
  let audioBytesSent = 0;
  for (const r of pcs) {
    if (!r._pc || typeof r._pc.getStats !== "function") continue;
    let stats;
    try {
      stats = await r._pc.getStats();
    } catch (e) {
      continue;
    }
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        audioBytesReceived += report.bytesReceived || 0;
      } else if (report.type === "inbound-rtp" && report.kind === "video") {
        videoBytesReceived += report.bytesReceived || 0;
      } else if (report.type === "outbound-rtp" && report.kind === "video") {
        videoBytesSent += report.bytesSent || 0;
      } else if (report.type === "outbound-rtp" && report.kind === "audio") {
        audioBytesSent += report.bytesSent || 0;
      }
    });
  }
  return { audioBytesReceived, videoBytesReceived, videoBytesSent, audioBytesSent, pcCount: pcs.length };
})()`;

// M2 画面共有ソース選択 UI: 「システム音声トグル ON で audio track が乗ったこと」を実測するための
// スクリプト。RTP_STATS_SCRIPT (bytesSent/bytesReceived の累積カウンタ) は alice の通常の
// マイク音声も screenshare のシステム音声も区別なく合算してしまうため、代わりに現在 "live" な
// audio/video sender の本数を数える -- ピッカーでシステム音声を ON にした screenshare 開始の
// 前後でこの本数を比較し、audio sender が実際に増えたことを確認する。
const SENDER_KIND_COUNT_SCRIPT = `(() => {
  const pcs = window.__selfmatrixPcs || [];
  let audio = 0;
  let video = 0;
  for (const r of pcs) {
    if (!r._pc || typeof r._pc.getSenders !== "function") continue;
    for (const sender of r._pc.getSenders()) {
      if (!sender.track || sender.track.readyState !== "live") continue;
      if (sender.track.kind === "audio") audio += 1;
      if (sender.track.kind === "video") video += 1;
    }
  }
  return { audio, video };
})()`;

// M1 step 3c-3 (実機確認して判明): `MediaView.tsx` 自体は root 要素に
// `data-testid="videoTile"` を付けるが、実際にグリッドへ配置する呼び出し元
// (`PinnableTile.tsx` 経由) がスプレッド展開で `data-testid="tile_pin"` に上書きする
// (JSX の属性展開順序でスプレッドが後勝ちになるため)。実 DOM (2 ユーザー通話) を実測して
// 確認済み — `videoTile` は実際には出現しない。
function participantTileCountScript() {
  return `document.querySelectorAll('[data-testid="tile_pin"]').length`;
}

// ---- 個人ユーザー (alice/bob) の起動〜in-call 到達までを共通化 -------------------------------

async function launchAndJoin(username, password, elementCallDir) {
  const { electronApp, userDataDir } = await launchNativePrototype({ nativePrototypeDir, elementCallDir });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(20000);

  await loginAsUser(page, username, password, { log });
  await dismissBlockingModals(page, { log });

  return { electronApp, userDataDir, page };
}

async function waitForInCall(electronApp, label) {
  const conditions = {};

  const bridgeDetected = await waitForCondition(
    `${label}.bridgeDetected`,
    async () => {
      const snapshot = await getMainProcessSnapshot(electronApp);
      return { ok: bridgeDetectedFromSnapshot(snapshot) };
    },
    15000,
    { log },
  );
  conditions.bridgeDetected = bridgeDetected.ok;

  const realJoinObserved = await waitForCondition(
    `${label}.realJoinObserved`,
    async () => {
      const snapshot = await getMainProcessSnapshot(electronApp);
      return { ok: fromViewJoinObserved(snapshot) };
    },
    25000,
    { log },
  );
  conditions.realJoinObserved = realJoinObserved.ok;

  const inCallUi = await waitForCondition(
    `${label}.inCallUi`,
    async () => {
      const evalResult = await evalInCallView(
        electronApp,
        `document.querySelector('[data-testid="incall_leave"]') !== null`,
      );
      return { ok: Boolean(evalResult && evalResult.ok && evalResult.value === true) };
    },
    30000,
    { log },
  );
  conditions.inCallUi = inCallUi.ok;

  const livekitConnected = await waitForCondition(
    `${label}.livekitConnected`,
    async () => {
      const evalResult = await evalInCallView(electronApp, PCS_SUMMARY_SCRIPT);
      const pcs = evalResult && evalResult.ok && Array.isArray(evalResult.value) ? evalResult.value : [];
      return { ok: pcs.some((pc) => pc.reachedConnected) };
    },
    30000,
    { log },
  );
  conditions.livekitConnected = livekitConnected.ok;

  conditions.pass = conditions.bridgeDetected && conditions.realJoinObserved && conditions.inCallUi && conditions.livekitConnected;
  return conditions;
}

// M1 step 3c-2 (媒体継続性の実測を安定させるための対策): screenshare の内容適応エンコーダは
// 「変化なし」を検知するとほぼ即座にフレーム送出を止める (実測、main.cjs の
// registerDisplayMediaHandler コメント参照)。cinny 自身の window (SelfMatrix タイトル) が
// getDisplayMedia() のキャプチャ対象として優先されるようにした (同コメント) 上で、ここで
// その window 上に絶えず変化するオーバーレイを描画し、エンコーダに継続的な差分ソースを与える。
async function startKeepAliveOverlay(page) {
  await page.evaluate(() => {
    if (window.__selfmatrixE2EKeepAlive) return;
    const el = document.createElement("div");
    el.id = "selfmatrix-e2e-keepalive";
    el.style.cssText =
      "position:fixed;top:0;left:0;width:64px;height:64px;z-index:2147483647;pointer-events:none;";
    document.body.appendChild(el);
    let hue = 0;
    const timer = setInterval(() => {
      hue = (hue + 37) % 360;
      el.style.background = `hsl(${hue}, 95%, 50%)`;
      el.textContent = String(Date.now());
    }, 120);
    window.__selfmatrixE2EKeepAlive = timer;
  });
}

async function invokeAliceCallControl(aliceApp, action) {
  return aliceApp.evaluate((_e, act) => {
    if (!global.__selfmatrixE2E || typeof global.__selfmatrixE2E.invokeCallControl !== "function") {
      return { ok: false, reason: "no_e2e_bridge" };
    }
    return global.__selfmatrixE2E.invokeCallControl(act);
  }, action);
}

async function latestStatePush(aliceApp, sinceT) {
  const snapshot = await getMainProcessSnapshot(aliceApp);
  const pushes = (snapshot?.callControlMessages ?? []).filter(
    (m) => m.direction === "state-push" && m.kind === "call-control" && m.t >= sinceT,
  );
  return pushes.length > 0 ? pushes[pushes.length - 1] : null;
}

async function getCallViewAttribute(electronApp, testid, attribute) {
  return evalInCallView(
    electronApp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="${testid}"]`)});
      return element ? element.getAttribute(${JSON.stringify(attribute)}) : null;
    })()`,
  ).then((result) => (result?.ok ? result.value : null));
}

async function getCallViewChecked(electronApp, selector) {
  return evalInCallView(
    electronApp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element && "checked" in element ? Boolean(element.checked) : null;
    })()`,
  ).then((result) => (result?.ok ? result.value : null));
}

async function clickCallViewControl(electronApp, testid) {
  return evalInCallView(
    electronApp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(`[data-testid="${testid}"]`)});
      if (!element) return { ok: false, reason: "target_not_found" };
      element.click();
      return { ok: true };
    })()`,
  );
}

async function clickCallViewSelector(electronApp, selector) {
  return evalInCallView(
    electronApp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, reason: "target_not_found" };
      element.click();
      return { ok: true };
    })()`,
  );
}

// M2 画面共有ソース選択 UI: screenshare を開始すると main.cjs のネイティブピッカーが実際に開く
// (registerDisplayMediaHandler()、旧来の「E2E は自 window を無言で自動選択する」ヒューリスティックは
// このコミットで撤去され、E2E も本物のピッカーを Playwright で操作する経路に一本化された)。
// invokeAliceCallControl() 自体は call-control-preload.cjs の handleToggleScreenshare() が
// target.click() を同期的に呼んで即座に返す (EC 自身の getDisplayMedia() 解決は待たない) ため、
// invoke の Promise とピッカーを掴んで操作する処理は並行して進める -- ピッカーが開く前に
// invoke だけ待ってしまうと、この後の wait(1200) 相当の猶予の間にピッカーが開いたままになり
// 待機がタイムアウトしてしまう。
//
// この関数は「toggleScreenshare 語彙の実証」と「M2 ネイティブピッカー自体の実証」を兼ねる:
// ピッカーが開いたこと・ソース一覧が非空であること・"SelfMatrix" タイルを選んで共有できたこと・
// システム音声トグル ON で実際に audio sender が増えたこと (available なとき) を実測する。
async function toggleScreenshareViaNativePicker(aliceApp, alicePage) {
  // 実 getDisplayMedia() が動き出す前に、キャプチャ対象になる cinny 自身の window 上へ
  // keep-alive オーバーレイを仕込んでおく (main.cjs の registerDisplayMediaHandler コメント、
  // startKeepAliveOverlay() コメント参照)。
  await startKeepAliveOverlay(alicePage);
  const before = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");
  const sendersBefore = (await evalInCallView(aliceApp, SENDER_KIND_COUNT_SCRIPT)).value ?? { audio: 0, video: 0 };
  const t0 = Date.now();

  const invokePromise = invokeAliceCallControl(aliceApp, "toggleScreenshare");
  const sourcePicker = await driveSourcePicker(aliceApp, { log }, { includeSystemAudio: true });
  const invoke = await invokePromise;

  await wait(1500);
  const push = await latestStatePush(aliceApp, t0);
  const after = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");
  const sendersAfter = (await evalInCallView(aliceApp, SENDER_KIND_COUNT_SCRIPT)).value ?? { audio: 0, video: 0 };

  const screenshareStarted =
    Boolean(invoke.ok && invoke.result && invoke.result.ok === true) &&
    Boolean(push && push.screenshare === true) &&
    after === "true";

  // systemAudioTrackAdded は systemAudioAvailable (=EC がこの getDisplayMedia 要求で
  // audioRequested:true を送ってきた、win32 限定) のときだけ意味を持つ。この EC ビルドが
  // audioRequested:true を送らない環境では null のまま (pass のスコープ外にする -- toggleReactions
  // 等の既知の環境ギャップと同じ「実在しない前提条件はスコープ外」パターン、runCallControlVocabulary()
  // コメント参照)。
  const systemAudioTrackAdded = sourcePicker.systemAudioAvailable ? sendersAfter.audio > sendersBefore.audio : null;

  return {
    before,
    after,
    invoke,
    statePush: push,
    screenshareStarted,
    sourcePicker,
    sendersBefore,
    sendersAfter,
    systemAudioTrackAdded,
    pass:
      Boolean(sourcePicker.opened) &&
      Boolean(sourcePicker.tilesSeen) &&
      (sourcePicker.sourceCount ?? 0) > 0 &&
      Boolean(sourcePicker.tileFound) &&
      Boolean(sourcePicker.shared) &&
      screenshareStarted &&
      (systemAudioTrackAdded === null || systemAudioTrackAdded === true),
  };
}

// M1 step 3c-3: 7 語彙のうち screenshare/spotlight/emphasis/sound は onCallControlState の
// push で main.cjs 側 (callControlMessages) にも、cinny 自身の再描画 (aria-pressed) にも実際に
// 反映されることを二重に確認する。settings/reactions は CallControlState に対応フィールドが
// 無く push を伴わない元実装 (CallControl.ts) のままなので、push/DOM 再同期の確認対象にしない
// (call-control-preload.cjs 冒頭コメント、cinny の NativeCallControl.ts 参照)。
async function runCallControlVocabulary(aliceApp, alicePage) {
  const vocabulary = {};
  let sourcePickerVerification = null;

  // 1. toggleScreenshare — 配信を開始する (この後の窓移動テストでも ON のまま使う)。M2: ネイティブ
  //    ソースピッカー経由 (toggleScreenshareViaNativePicker() 参照、ピッカー自体の実証も兼ねる)。
  {
    sourcePickerVerification = await toggleScreenshareViaNativePicker(aliceApp, alicePage);
    vocabulary.toggleScreenshare = {
      invoke: sourcePickerVerification.invoke,
      before: sourcePickerVerification.before,
      after: sourcePickerVerification.after,
      statePush: sourcePickerVerification.statePush,
      pass: sourcePickerVerification.screenshareStarted,
    };
  }

  // 2. toggleEmphasis — spotlight に切り替える前 (grid モード) にテストする必要がある
  //    (spotlight 中は emphasis の DOM 要素自体が消える、call-control-preload.cjs 参照)。
  {
    const before = await getCallViewChecked(aliceApp, '[data-testid="emphasis_toggle"]');
    const t0 = Date.now();
    const invoke = await invokeAliceCallControl(aliceApp, "toggleEmphasis");
    await wait(1000);
    const push = await latestStatePush(aliceApp, t0);
    const after = await getCallViewChecked(aliceApp, '[data-testid="emphasis_toggle"]');
    vocabulary.toggleEmphasis = {
      invoke,
      before,
      after,
      statePush: push,
      pass:
        Boolean(invoke.ok && invoke.result && invoke.result.ok === true) &&
        Boolean(push && push.emphasis === true) &&
        after === true,
    };
  }

  // 3. toggleSpotlight — spotlight へ切り替え、押し戻して grid へ戻す (レイアウトを汚さない)。
  {
    const t0 = Date.now();
    const invokeOn = await invokeAliceCallControl(aliceApp, "toggleSpotlight");
    await wait(1000);
    const pushOn = await latestStatePush(aliceApp, t0);
    const afterOn = await getCallViewChecked(aliceApp, 'input[value="spotlight"]');

    const t1 = Date.now();
    const invokeBack = await invokeAliceCallControl(aliceApp, "toggleSpotlight");
    await wait(1000);
    const pushBack = await latestStatePush(aliceApp, t1);
    const afterBack = await getCallViewChecked(aliceApp, 'input[value="spotlight"]');

    vocabulary.toggleSpotlight = {
      invokeOn,
      invokeBack,
      afterOn,
      afterBack,
      statePushOn: pushOn,
      statePushBack: pushBack,
      pass:
        Boolean(invokeOn.ok && invokeOn.result && invokeOn.result.ok === true) &&
        Boolean(pushOn && pushOn.spotlight === true) &&
        afterOn === true &&
        Boolean(invokeBack.ok && invokeBack.result && invokeBack.result.ok === true) &&
        Boolean(pushBack && pushBack.spotlight === false) &&
        afterBack === false,
    };
  }

  // 4. toggleReactions — 既知の環境ギャップ (詳細は README/報告参照): この EC ビルド
  //    (element-call/src/components/CallFooter.tsx, SelfMatrix fork でリファクタ済み) の footer
  //    には reactions 送信ボタン自体が描画されていない (FooterState.reactionData/
  //    reactionIdentifier は型/state 層にしか存在せず、CallFooter.tsx の JSX では未参照 — dead
  //    props と見られる)。call-control-preload.cjs の reactionsButton() を実機確認したところ、
  //    元の `leaveButton().previousElementSibling` ヒューリスティックは無関係な screenshare
  //    ラッパー div にヒットしていた (このコミットで target_not_found を正直に返すよう修正済み —
  //    call-control-preload.cjs 参照)。実クリック対象が無い以上 {ok:true} にはなり得ないため、
  //    ここでは「action 文字列が語彙として認識されている (unknown_action ではない)」ことだけを
  //    pass 条件にする — この 1 語彙に限り、実 DOM 到達の証明を対象コントロール不在という
  //    環境上の理由でスコープから除外する (native fork 固有の問題ではなく、web 版でも同じ
  //    DOM/コンポーネント構成である以上同様に起こるはずの、EC 本体側の未配線)。
  {
    const invoke = await invokeAliceCallControl(aliceApp, "toggleReactions");
    const reason = invoke.ok && invoke.result ? invoke.result.reason : undefined;
    vocabulary.toggleReactions = {
      invoke,
      knownGap: true,
      knownGapNote:
        "This EC build does not render a reactions button in the footer (FooterState.reactionData/" +
        "reactionIdentifier are unused in CallFooter.tsx's JSX) -- confirmed via source inspection, " +
        "not native-shell specific. call-control-preload.cjs correctly reports target_not_found " +
        "instead of misclicking the neighbouring screenshare wrapper div.",
      // H4 (受け入れレビュー修正、minor): 旧判定は reason !== "unknown_action" だけだったため、
      // call-control-preload.cjs の invoke() 内で例外が発生し reason:"exception" が返ってきても
      // pass:true になってしまっていた (invoke.ok は RPC 往復自体の成否であり、action 自身が
      // 例外で失敗したことを見逃す)。"exception" も明示的に不合格として弾く。
      pass: Boolean(invoke.ok) && reason !== "unknown_action" && reason !== "exception",
    };
  }

  // 5. toggleSettings — パネル開閉 (開いたら閉じる、状態を汚さない)。CallControlState に
  //    対応フィールドが無く push を伴わない (元実装どおり)。
  // 実機確認して判明した食い違い: web 版 CallControl.ts / cinny の CallControls.tsx はどちらも
  // toggleSettings() を「同じボタンを押すたびに開閉が反転する」前提で 1 つの action に統合している
  // (design のカテゴリ B と同型) が、実 EC (element-call/src/settings/SettingsModal.tsx) の設定画面は
  // Compound の Dialog (open/onDismiss で制御) であり、トリガーボタンの 2 回目のクリックは
  // (モーダルに焦点/オーバーレイが奪われるため) ダイアログを閉じない — 実機で 2 回 invoke しても
  // 設定画面が開いたままであることを確認済み (native 固有ではなく EC 本体側の設計、web 版でも同型に
  // 起こるはずの挙動)。テストの後始末としては 2 回目の toggleSettings invoke (契約どおりの 7 語彙の
  // 1 つとして実行すること自体は必須) に加えて、Dialog の標準的な閉じ方 (Escape キー、Radix Dialog
  // の既定動作) で実際に閉じたことまで確認する。
  {
    const invokeOpen = await invokeAliceCallControl(aliceApp, "toggleSettings");
    await wait(500);
    const invokeClose = await invokeAliceCallControl(aliceApp, "toggleSettings");
    await wait(500);
    const stillOpenAfterInvoke = await evalInCallView(
      aliceApp,
      `document.querySelector('[role="dialog"]') !== null`,
    );
    // Dialog の 2 回目クリックでは閉じないことを実機確認済み (上のコメント参照) -- Escape で
    // 実際に閉じ、後片付けする。
    await evalInCallView(
      aliceApp,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`,
    );
    await wait(500);
    const closedAfterEscape = await evalInCallView(
      aliceApp,
      `document.querySelector('[role="dialog"]') === null`,
    );
    vocabulary.toggleSettings = {
      invokeOpen,
      invokeClose,
      knownGap:
        Boolean(stillOpenAfterInvoke.ok && stillOpenAfterInvoke.value === true) &&
        Boolean(closedAfterEscape.ok && closedAfterEscape.value === true),
      knownGapNote:
        "A second toggleSettings() invoke does not close the Compound Dialog-based settings modal " +
        "(confirmed: dialog was still present via [role=dialog] right after the 2nd invoke) -- " +
        "closed via Escape (Dialog's standard dismissal) for test cleanup instead. Same underlying " +
        "EC component is shared with the web build, so this is not native-shell specific.",
      // H5 (受け入れレビュー修正、minor): 旧判定は invoke の RPC 往復成否 (ok:true) だけを見ており、
      // ダイアログが実際に開いた/Escape で実際に閉じたことまでは確認していなかった (knownGap には
      // 記録していたが pass には反映されていなかった)。stillOpenAfterInvoke/closedAfterEscape を
      // pass の AND に組み込み、「実際にダイアログが開閉した」ことを実測させる (knownGap 記録は
      // そのまま維持する)。
      pass:
        Boolean(invokeOpen.ok && invokeOpen.result && invokeOpen.result.ok === true) &&
        Boolean(invokeClose.ok && invokeClose.result && invokeClose.result.ok === true) &&
        Boolean(stillOpenAfterInvoke.ok && stillOpenAfterInvoke.value === true) &&
        Boolean(closedAfterEscape.ok && closedAfterEscape.value === true),
    };
  }

  // 6. setSoundOff / 7. setSoundOn — 既定 (CallControlState の初期値) は sound:true なので、
  //    off にしてから on に戻す (往復で状態を汚さない)。
  {
    const t0 = Date.now();
    const invokeOff = await invokeAliceCallControl(aliceApp, "setSoundOff");
    await wait(1000);
    const pushOff = await latestStatePush(aliceApp, t0);
    vocabulary.setSoundOff = {
      invoke: invokeOff,
      statePush: pushOff,
      pass:
        Boolean(invokeOff.ok && invokeOff.result && invokeOff.result.ok === true) &&
        Boolean(pushOff && pushOff.sound === false),
    };

    const t1 = Date.now();
    const invokeOn = await invokeAliceCallControl(aliceApp, "setSoundOn");
    await wait(1000);
    const pushOn = await latestStatePush(aliceApp, t1);
    vocabulary.setSoundOn = {
      invoke: invokeOn,
      statePush: pushOn,
      pass:
        Boolean(invokeOn.ok && invokeOn.result && invokeOn.result.ok === true) &&
        Boolean(pushOn && pushOn.sound === true),
    };
  }

  const pass = Object.values(vocabulary).every((entry) => entry.pass);
  return { vocabulary, pass, sourcePickerVerification };
}

// Compatibility RPC coverage above proves the retained bridge vocabulary.
// This separate check clicks the Element Call controls that native users
// actually see in both main and popout placements.
async function runRealClickVocabulary(aliceApp) {
  const vocabulary = {};

  // The native product now uses Element Call's footer in both placements, so
  // these checks click the controls users actually see rather than Cinny's
  // compatibility RPC toolbar.
  {
    const before = await getCallViewChecked(aliceApp, '[data-testid="emphasis_toggle"]');
    const click = await clickCallViewControl(aliceApp, "emphasis_toggle");
    await wait(500);
    const after = await getCallViewChecked(aliceApp, '[data-testid="emphasis_toggle"]');
    vocabulary.emphasis = {
      click,
      before,
      after,
      pass: Boolean(click?.ok && click.value?.ok && before !== after && after === true),
    };
  }

  {
    const before = await getCallViewChecked(aliceApp, 'input[value="spotlight"]');
    const clickOn = await clickCallViewSelector(aliceApp, 'input[value="spotlight"]');
    await wait(500);
    const afterOn = await getCallViewChecked(aliceApp, 'input[value="spotlight"]');
    const clickBack = await clickCallViewSelector(aliceApp, 'input[value="grid"]');
    await wait(500);
    const afterBack = await getCallViewChecked(aliceApp, 'input[value="spotlight"]');
    vocabulary.spotlight = {
      clickOn,
      clickBack,
      before,
      afterOn,
      afterBack,
      pass:
        Boolean(clickOn?.ok && clickOn.value?.ok) &&
        Boolean(clickBack?.ok && clickBack.value?.ok) &&
        afterOn === true &&
        afterBack === false,
    };
  }

  {
    const settingsClick = await evalInCallView(
      aliceApp,
      `(() => {
        const button = document.querySelector('[data-testid="settings-bottom-left"]') ||
          document.querySelector('[data-testid="settings-bottom-center"]');
        if (!button) return { ok: false, reason: "target_not_found" };
        button.click();
        return { ok: true };
      })()`,
    );
    await wait(500);
    const dialogOpened = await evalInCallView(
      aliceApp,
      `document.querySelector('[role="dialog"]') !== null`,
    );
    await evalInCallView(
      aliceApp,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`,
    );
    await wait(500);
    const dialogClosed = await evalInCallView(
      aliceApp,
      `document.querySelector('[role="dialog"]') === null`,
    );
    vocabulary.settings = {
      settingsClick,
      dialogOpened,
      dialogClosed,
      pass:
        Boolean(settingsClick?.ok && settingsClick.value?.ok) &&
        Boolean(dialogOpened.ok && dialogOpened.value === true) &&
        Boolean(dialogClosed.ok && dialogClosed.value === true),
    };
  }

  {
    const before = await getCallViewAttribute(aliceApp, "incall_sound", "aria-checked");
    const clickOff = await clickCallViewControl(aliceApp, "incall_sound");
    await wait(500);
    const afterOff = await getCallViewAttribute(aliceApp, "incall_sound", "aria-checked");
    const clickOn = await clickCallViewControl(aliceApp, "incall_sound");
    await wait(500);
    const afterOn = await getCallViewAttribute(aliceApp, "incall_sound", "aria-checked");
    vocabulary.sound = {
      clickOff,
      clickOn,
      before,
      afterOff,
      afterOn,
      pass:
        Boolean(clickOff?.ok && clickOff.value?.ok) &&
        Boolean(clickOn?.ok && clickOn.value?.ok) &&
        afterOff === "false" &&
        afterOn === "true",
    };
  }

  const pass = Object.values(vocabulary).every((entry) => entry.pass);
  return { vocabulary, pass };
}

// M1 step 3c-2 (実機で発覚、対応): この EC ビルドは SelfMatrix の「視聴オプトイン」仕様
// (element-call/src/room/WatchableStreamsBar.tsx, UI 設計合意 v1.4) により、配信 (screenshare)
// は他参加者が明示的に「視聴」ボタン (`data-testid="watch_stream"`) を押すまで購読/描画されない
// (Discord の「配信を見る」相当 — 見ていない配信にはタイルすら割かない設計)。実測したところ、
// 誰も見ていない screenshare は LiveKit のパブリッシャー側が simulcast レイヤーを即座に
// non-active にし、outbound-rtp の bytesSent が初回キーフレーム分だけで頭打ちになる (これは
// SFU の需要ベース帯域制御として正しい挙動)。「配信中に media が流れ続けること」を意味のある形で
// 実測するには、bob 側で実際に「視聴」を opt-in させる必要がある。
async function optInBobToWatchScreenshare(bobApp) {
  const seen = await waitForCondition(
    "bob.watchStreamButtonVisible",
    async () => {
      const r = await evalInCallView(bobApp, `document.querySelector('[data-testid="watch_stream"]') !== null`);
      return { ok: Boolean(r && r.ok && r.value === true) };
    },
    15000,
    { log },
  );
  if (!seen.ok) {
    return { ok: false, reason: "watch_stream_button_not_found" };
  }
  const clickResult = await evalInCallView(
    bobApp,
    `(() => {
      const btn = document.querySelector('[data-testid="watch_stream"]');
      if (!btn) return { ok: false, reason: "target_not_found" };
      btn.click();
      return { ok: true };
    })()`,
  );
  await wait(1500);
  return { ok: Boolean(clickResult && clickResult.ok && clickResult.value && clickResult.value.ok), clickResult };
}

// M1 step 3c-2 (窓移動無再接続、M1 の核心): 通話 view を main window ⇔ 別ウィンドウ間で
// REPARENT_ROUND_TRIPS 回再親子付けし、無再接続であることを実測する。
async function runWindowMoveReparenting(aliceApp, bobApp) {
  const navBefore = (await getMainProcessSnapshot(aliceApp))?.navigationEvents ?? [];
  const hardNavBefore = navBefore.filter((e) => e.isMainFrame && !e.isInPlace).length;
  const pcsBefore = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const statsBefore = (await evalInCallView(aliceApp, RTP_STATS_SCRIPT)).value ?? {};
  const bobPcsBefore = (await evalInCallView(bobApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const bobInCallBefore = await evalInCallView(bobApp, `document.querySelector('[data-testid="incall_leave"]') !== null`);

  const roundTrips = [];
  for (let i = 0; i < REPARENT_ROUND_TRIPS; i += 1) {
    const detach = await aliceApp.evaluate(() => global.__selfmatrixE2E.detachCallView());
    await wait(REPARENT_SETTLE_MS);
    // H1 (受け入れレビュー修正、major): detach.callViewState/attach.callViewState は main.cjs の
    // state.callViewState (文字列) を読んだだけであり、「state だけ書き換えて実際は
    // removeChildView()/addChildView() を呼ばない」no-op 化回帰があっても値は正常に見えてしまう。
    // main.cjs の computeCallViewAttachedTo() (state ではなく実際の contentView.children から
    // 逆算した値、getMainProcessSnapshot() 経由で読める callViewAttachedTo) を別途取得し、
    // detach 後に実際に "window" 側へ、attach 後に実際に "main" 側へ動いたことを実測する。
    const afterDetachSnapshot = await getMainProcessSnapshot(aliceApp);
    const attachedToAfterDetach = afterDetachSnapshot?.callViewAttachedTo ?? null;
    const attach = await aliceApp.evaluate(() => global.__selfmatrixE2E.attachCallView());
    await wait(REPARENT_SETTLE_MS);
    const afterAttachSnapshot = await getMainProcessSnapshot(aliceApp);
    const attachedToAfterAttach = afterAttachSnapshot?.callViewAttachedTo ?? null;
    const detachActuallyMoved = attachedToAfterDetach === "window";
    const attachActuallyMoved = attachedToAfterAttach === "main";
    roundTrips.push({
      i: i + 1,
      detach,
      attach,
      attachedToAfterDetach,
      attachedToAfterAttach,
      detachActuallyMoved,
      attachActuallyMoved,
      pass: detachActuallyMoved && attachActuallyMoved,
    });
    log(
      `window-move round trip ${i + 1}/${REPARENT_ROUND_TRIPS} done ` +
        `(detach=${detach.callViewState}/attachedTo=${attachedToAfterDetach}, ` +
        `attach=${attach.callViewState}/attachedTo=${attachedToAfterAttach}).`,
    );
  }

  await wait(1500); // 少し media が流れる猶予をおいてから after を測る

  const navAfter = (await getMainProcessSnapshot(aliceApp))?.navigationEvents ?? [];
  const hardNavAfter = navAfter.filter((e) => e.isMainFrame && !e.isInPlace).length;
  const pcsAfter = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const statsAfter = (await evalInCallView(aliceApp, RTP_STATS_SCRIPT)).value ?? {};
  const bobPcsAfter = (await evalInCallView(bobApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const bobInCallAfter = await evalInCallView(bobApp, `document.querySelector('[data-testid="incall_leave"]') !== null`);

  const sameIdSet = (a, b) => {
    const idsA = a.map((p) => p.id).sort().join(",");
    const idsB = b.map((p) => p.id).sort().join(",");
    return idsA === idsB;
  };
  const isLive = (pc) =>
    pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";

  // noReload/pcStable (受け入れレビューで発覚、修正): LiveKit エンジンは実測したところ、実際に
  // 使われる publish/subscribe 用 RTCPeerConnection とは別に、一度も negotiate されず
  // signalingState:"closed" のまま残る PC を生成することがある (connectionState は生涯 "new" の
  // まま — 初期接続時のフォールバック/プリフライト起因と見られ、窓移動より前から既にこの状態)。
  // 「新規 RTCPeerConnection の生成ゼロ」は id 集合が窓移動の前後で完全一致することで判定する
  // (これは生死を問わない — 1 個でも増減すれば新規生成/破棄が起きたことになる)。「既存 PC が
  // connected を維持」は窓移動前に実際に connected だった PC (isLive) だけを対象にする —
  // 生涯 negotiate されない PC にまで connected を要求すると、窓移動と無関係な LiveKit 内部の
  // 未使用 PC の存在だけで無関係に false になってしまう。
  const noReload = hardNavAfter === hardNavBefore && pcsAfter.length === pcsBefore.length && sameIdSet(pcsBefore, pcsAfter);
  const liveBefore = pcsBefore.filter(isLive);
  const liveAfterById = new Map(pcsAfter.map((pc) => [pc.id, pc]));
  const pcStable =
    noReload &&
    liveBefore.length > 0 &&
    liveBefore.every((pc) => {
      const after = liveAfterById.get(pc.id);
      return after && isLive(after);
    });
  const mediaContinues =
    (statsAfter.videoBytesSent ?? 0) > (statsBefore.videoBytesSent ?? 0) &&
    (statsAfter.audioBytesReceived ?? 0) > (statsBefore.audioBytesReceived ?? 0);
  const bobLiveBefore = bobPcsBefore.filter(isLive);
  const bobLiveAfterById = new Map(bobPcsAfter.map((pc) => [pc.id, pc]));
  const bobUnaffected =
    Boolean(bobInCallBefore.ok && bobInCallBefore.value === true) &&
    Boolean(bobInCallAfter.ok && bobInCallAfter.value === true) &&
    bobLiveBefore.length > 0 &&
    bobLiveBefore.every((pc) => {
      const after = bobLiveAfterById.get(pc.id);
      return after && isLive(after);
    });

  // H1 (受け入れレビュー修正、major): 3 往復全部が実際に contentView 階層を動かしたこと
  // (roundTrips[].pass、computeCallViewAttachedTo() 由来) を pass の AND に追加する。
  const allRoundTripsActuallyMoved = roundTrips.every((rt) => rt.pass);

  return {
    roundTrips,
    measurements: {
      hardNavBefore,
      hardNavAfter,
      pcsBefore,
      pcsAfter,
      statsBefore,
      statsAfter,
      bobPcsBefore,
      bobPcsAfter,
    },
    noReload,
    pcStable,
    mediaContinues,
    bobUnaffected,
    allRoundTripsActuallyMoved,
    pass: noReload && pcStable && mediaContinues && bobUnaffected && allRoundTripsActuallyMoved,
  };
}

// Element Call's footer is the shared native call bar. It must remain visible
// before, during, and after a WebContentsView reparent operation.
//
// 「popoutCallView()/popinCallView() で駆動する」という設計文書の記述に対し、この E2E は
// windowMoveReparenting/boundsSync/callRespawn と同じ既存パターンに揃えて
// `global.__selfmatrixE2E.detachCallView()/attachCallView()` (main プロセス内部の
// detachCallView()/attachCallView() を直接呼ぶ E2E 専用窓口) を使う -- cinny 側にはまだ
// popout 導線 UI が無い (design §2 のサブステップ 4、このタスクの範囲外) ため、cinny 自身の
// ⧉ ボタンをクリックする経路が存在しない。ただし main.cjs の
// `ipcMain.handle("native:popout-call-view", () => detachCallView())` /
// `ipcMain.handle("native:popin-call-view", () => attachCallView())` は options 無しで
// detachCallView()/attachCallView() を呼ぶだけなので、ここで直接呼ぶのと**完全に同じコードパス**
// (フッター push を含む) が実行される。
//
// 判定は「メイン埋め込み時は visibility:hidden」「別窓時は visibility:visible かつ実際に画面上に
// 大きさを持つ (getBoundingClientRect)」の両方を、attach 前後で AND を取る -- computeCallViewAttachedTo()
// (H1 と同じ「state 文字列ではなく実体」方針) と組み合わせて、「実際に窓が動いていないのに
// フッターだけ表示に切り替わった」ような食い違いも検知できるようにしてある。
const FOOTER_VISIBILITY_SCRIPT = `(() => {
  const leave = document.querySelector('[data-testid="incall_leave"]');
  const controls = leave && leave.parentElement ? leave.parentElement.parentElement : null;
  if (!controls) return { found: false };
  const style = window.getComputedStyle(controls);
  const rect = controls.getBoundingClientRect();
  return {
    found: true,
    visibility: style.visibility,
    position: style.position,
    rectHasSize: rect.width > 0 && rect.height > 0,
  };
})()`;

async function readFooterState(aliceApp) {
  return evalInCallView(aliceApp, FOOTER_VISIBILITY_SCRIPT);
}

function footerVisibleAsExpected(readResult) {
  return Boolean(
    readResult &&
      readResult.ok &&
      readResult.value &&
      readResult.value.found &&
      readResult.value.visibility === "visible" &&
      readResult.value.rectHasSize === true,
  );
}

async function runFooterVisibilityToggle(aliceApp) {
  const beforeSnapshot = await getMainProcessSnapshot(aliceApp);
  const attachedBefore = beforeSnapshot?.callViewAttachedTo ?? null;
  const footerAttached = await readFooterState(aliceApp);

  // popoutCallView() 相当 (see comment above -- same main.cjs code path).
  const detach = await aliceApp.evaluate(() => global.__selfmatrixE2E.detachCallView());
  const footerAfterDetach = await waitForCondition(
    "footerVisibilityToggle.visibleAfterDetach",
    async () => {
      const read = await readFooterState(aliceApp);
      return { ok: footerVisibleAsExpected(read), read };
    },
    10000,
    { log },
  );
  const afterDetachSnapshot = await getMainProcessSnapshot(aliceApp);
  const attachedAfterDetach = afterDetachSnapshot?.callViewAttachedTo ?? null;

  // popinCallView() 相当 (see comment above -- same main.cjs code path).
  const attach = await aliceApp.evaluate(() => global.__selfmatrixE2E.attachCallView());
  const footerAfterAttach = await waitForCondition(
    "footerVisibilityToggle.visibleAfterAttach",
    async () => {
      const read = await readFooterState(aliceApp);
      return { ok: footerVisibleAsExpected(read), read };
    },
    10000,
    { log },
  );
  const afterAttachSnapshot = await getMainProcessSnapshot(aliceApp);
  const attachedAfterAttach = afterAttachSnapshot?.callViewAttachedTo ?? null;

  const pass =
    attachedBefore === "main" &&
    footerVisibleAsExpected(footerAttached) &&
    attachedAfterDetach === "window" &&
    footerAfterDetach.ok &&
    attachedAfterAttach === "main" &&
    footerAfterAttach.ok;

  return {
    attachedBefore,
    footerWhileAttachedBefore: footerAttached,
    detach,
    attachedAfterDetach,
    footerWhileDetached: footerAfterDetach.read,
    attach,
    attachedAfterAttach,
    footerWhileAttachedAfter: footerAfterAttach.read,
    pass,
  };
}

// ---- SelfMatrix M3 step 5 (M3 の受け入れ条件そのもの、design/m3-window-ux.md §4) -------------

// 窓移動の id 集合/生死判定は runWindowMoveReparenting() と同じ考え方 (「新規 RTCPeerConnection
// ゼロ」は id 集合の完全一致、「既存 PC が connected を維持」は事前に connected だった PC だけを
// 対象にする) を 2 箇所 (runRealPopoutPopinClick()/runCloseWindowMainRevert()) で使い回すための
// 共有ヘルパー。
function pcIdSet(pcs) {
  return pcs.map((pc) => pc.id).sort().join(",");
}
function isPcLive(pc) {
  return (
    pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed"
  );
}
function livePcsStillLive(before, afterById) {
  return before.length > 0 && before.every((pc) => {
    const after = afterById.get(pc.id);
    return after && isPcLive(after);
  });
}

// M3 step 5 (2): cinny 自身の実 ⧉ ボタンを実クリックし、production 配線
// (CallControls.tsx の onClick → useCallEmbed.ts の useNativeCallPopoutToggle() →
// NativeCallEmbed.popout()/popin() (cinny/src/app/plugins/call/native/NativeCallEmbed.ts) →
// transport.popoutCallView()/popinCallView() (nativeBridge.ts) → IPC →
// main.cjs の detachCallView()/attachCallView()) をエンドツーエンドで検証する。
//
// runWindowMoveReparenting()/runFooterVisibilityToggle() はどちらも
// `global.__selfmatrixE2E.detachCallView()/attachCallView()` を main プロセス内から直接呼んでおり、
// cinny 側の TS 層 (CallControls.tsx の onClick から NativeCallEmbed.popout() までの配線) を
// 一切経由しない -- その配線が壊れていても上記 2 つの判定は素通りしてしまう。この関数はその穴を
// 塞ぐ: alicePage 上の実ボタン (`[data-testid="call_popout"]` → 別窓へ移った後は
// `[data-testid="call_popin"]`、CallControls.tsx の popoutButtonTestId 参照) を実際に
// Playwright でクリックし、(a) main.cjs 側の実体 (computeCallViewAttachedTo()、H1 と同じ
// 「state ではなく実体から逆算」方針) が実際に "window"→"main" と遷移すること、(b) その間
// RTCPeerConnection が 1 つも作り直されず (id 集合不変)、事前に connected だった PC が
// connected を維持すること (無再接続) の両方を実測する。
async function runRealPopoutPopinClick(aliceApp) {
  const beforeSnapshot = await getMainProcessSnapshot(aliceApp);
  const attachedBefore = beforeSnapshot?.callViewAttachedTo ?? null;
  const pcsBefore = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const liveBefore = pcsBefore.filter(isPcLive);

  // 1. Click the shared footer's native popout button.
  const popoutButtonVisible =
    (await getCallViewAttribute(aliceApp, "native_call_popout", "data-testid")) ===
    "native_call_popout";
  const popoutClick = popoutButtonVisible
    ? await clickCallViewControl(aliceApp, "native_call_popout")
    : null;

  const afterPopout = await waitForCondition(
    "realPopoutPopinClick.attachedToWindow",
    async () => {
      const snap = await getMainProcessSnapshot(aliceApp);
      return { ok: snap?.callViewAttachedTo === "window", attachedTo: snap?.callViewAttachedTo ?? null };
    },
    10000,
    { log },
  );
  const pcsAfterPopout = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const noReconnectAfterPopout = pcIdSet(pcsBefore) === pcIdSet(pcsAfterPopout);
  const stillConnectedAfterPopout = livePcsStillLive(
    liveBefore,
    new Map(pcsAfterPopout.map((pc) => [pc.id, pc])),
  );

  const pinBefore = await getCallViewAttribute(aliceApp, "native_call_pin", "aria-pressed");
  const pinClick = await clickCallViewControl(aliceApp, "native_call_pin");
  await wait(400);
  const pinAfter = await getCallViewAttribute(aliceApp, "native_call_pin", "aria-pressed");
  const pinRestoreClick = await clickCallViewControl(aliceApp, "native_call_pin");
  await wait(400);
  const pinRestored = await getCallViewAttribute(aliceApp, "native_call_pin", "aria-pressed");

  const fullscreenBefore = await getCallViewAttribute(
    aliceApp,
    "native_call_fullscreen",
    "aria-pressed",
  );
  const fullscreenClick = await clickCallViewControl(aliceApp, "native_call_fullscreen");
  await wait(800);
  const fullscreenAfter = await getCallViewAttribute(
    aliceApp,
    "native_call_fullscreen",
    "aria-pressed",
  );
  const fullscreenRestoreClick = await clickCallViewControl(
    aliceApp,
    "native_call_fullscreen",
  );
  await wait(800);
  const fullscreenRestored = await getCallViewAttribute(
    aliceApp,
    "native_call_fullscreen",
    "aria-pressed",
  );
  const windowControlsPass =
    Boolean(pinClick?.ok && pinClick.value?.ok) &&
    Boolean(pinRestoreClick?.ok && pinRestoreClick.value?.ok) &&
    pinAfter !== pinBefore &&
    pinRestored === pinBefore &&
    Boolean(fullscreenClick?.ok && fullscreenClick.value?.ok) &&
    Boolean(fullscreenRestoreClick?.ok && fullscreenRestoreClick.value?.ok) &&
    fullscreenAfter !== fullscreenBefore &&
    fullscreenRestored === fullscreenBefore;

  // 2. The same footer now exposes the explicit return-to-SelfMatrix action.
  const popinButtonVisible =
    (await getCallViewAttribute(aliceApp, "native_call_popin", "data-testid")) ===
    "native_call_popin";
  const popinClick = popinButtonVisible
    ? await clickCallViewControl(aliceApp, "native_call_popin")
    : null;

  const afterPopin = await waitForCondition(
    "realPopoutPopinClick.attachedToMain",
    async () => {
      const snap = await getMainProcessSnapshot(aliceApp);
      return { ok: snap?.callViewAttachedTo === "main", attachedTo: snap?.callViewAttachedTo ?? null };
    },
    10000,
    { log },
  );
  const pcsAfterPopin = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const noReconnectAfterPopin = pcIdSet(pcsBefore) === pcIdSet(pcsAfterPopin);
  const stillConnectedAfterPopin = livePcsStillLive(
    liveBefore,
    new Map(pcsAfterPopin.map((pc) => [pc.id, pc])),
  );

  const pass =
    attachedBefore === "main" &&
    popoutButtonVisible &&
    Boolean(popoutClick?.ok && popoutClick.value?.ok) &&
    afterPopout.ok &&
    noReconnectAfterPopout &&
    stillConnectedAfterPopout &&
    windowControlsPass &&
    popinButtonVisible &&
    Boolean(popinClick?.ok && popinClick.value?.ok) &&
    afterPopin.ok &&
    noReconnectAfterPopin &&
    stillConnectedAfterPopin;

  return {
    attachedBefore,
    popoutButtonVisible,
    popoutClick,
    attachedAfterPopout: afterPopout.attachedTo,
    noReconnectAfterPopout,
    stillConnectedAfterPopout,
    windowControls: {
      pinBefore,
      pinAfter,
      pinRestored,
      fullscreenBefore,
      fullscreenAfter,
      fullscreenRestored,
      pass: windowControlsPass,
    },
    popinButtonVisible,
    popinClick,
    attachedAfterPopin: afterPopin.attachedTo,
    noReconnectAfterPopin,
    stillConnectedAfterPopin,
    measurements: { pcsBefore, pcsAfterPopout, pcsAfterPopin },
    pass,
  };
}

// M3 step 5 (3, M3 の受け入れ条件の核心): 別窓をユーザーが実際に閉じたとき
// (`state.callWindow.close()` -- `win.destroy()` ではない、実際の X ボタンと同じキャンセル可能な
// "close" イベント経路) の「メインへの自動復帰・無再接続・通話継続」を実測する。
// main.cjs の createCallWindow() は既定 (close-preserve) で、この "close" イベントを
// `event.preventDefault()` した上で `attachCallView()` を待ち、完了後に `win.destroy()` する
// (design/m3-window-ux.md §3-1)。cinny 側は popinCallView() を一度も呼んでいないのに main 側だけで
// "main" へ勝手に復帰する経路であり、runRealPopoutPopinClick() の実クリック popin とは別の
// コードパスを通る -- E2E からこれを起こすには「実際に close イベントを発火させる」窓口が
// main.cjs 側の __selfmatrixE2E に無かったため、このコミットで `closeCallWindow()`
// (= `state.callWindow.close()` をそのまま呼ぶだけ) を追加した (main.cjs 参照)。
//
// 判定の核心 (M3 の最重要判定): `callViewState !== "none"` -- closeCallView()/hangup が
// (close ハンドラの実装ミス等で) 誤発火していないこと。誤発火すれば isCallActive() の定義
// (main.cjs 参照) どおり "none" に落ちるため、確実に検知できる。
async function runCloseWindowMainRevert(aliceApp, bobApp) {
  const callViewStateBefore = (await getMainProcessSnapshot(aliceApp))?.callViewState ?? null;

  // 1. popout: 別窓へ (ここで検証したいのは close=復帰の状態機械であって popout 自体の配線では
  //    ないため、windowMoveReparenting()/footerVisibilityToggle() と同じ直接呼び出しで移す)。
  await aliceApp.evaluate(() => global.__selfmatrixE2E.detachCallView());
  await wait(REPARENT_SETTLE_MS);
  const attachedAfterPopout = (await getMainProcessSnapshot(aliceApp))?.callViewAttachedTo ?? null;

  const pcsBeforeClose = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const liveBeforeClose = pcsBeforeClose.filter(isPcLive);
  const bobPcsBeforeClose = (await evalInCallView(bobApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const bobLiveBeforeClose = bobPcsBeforeClose.filter(isPcLive);
  const bobInCallBeforeClose = await evalInCallView(
    bobApp,
    `document.querySelector('[data-testid="incall_leave"]') !== null`,
  );

  // 2. 実クローズ: state.callWindow.close() をそのまま呼ぶ E2E 専用窓口。
  const closeResult = await aliceApp.evaluate(() => global.__selfmatrixE2E.closeCallWindow());

  const revertedToMain = await waitForCondition(
    "closeWindowMainRevert.attachedToMain",
    async () => {
      const snap = await getMainProcessSnapshot(aliceApp);
      return { ok: snap?.callViewAttachedTo === "main", snapshot: snap };
    },
    10000,
    { log },
  );
  const afterCloseSnapshot = revertedToMain.snapshot ?? (await getMainProcessSnapshot(aliceApp));
  const attachedAfterClose = afterCloseSnapshot?.callViewAttachedTo ?? null;
  const callViewStateAfterClose = afterCloseSnapshot?.callViewState ?? null;

  await wait(500); // PC/DOM が落ち着く猶予 (windowMoveReparenting() の afterラウンド待ちと同水準)。

  const pcsAfterClose = (await evalInCallView(aliceApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const noReconnect = pcIdSet(pcsBeforeClose) === pcIdSet(pcsAfterClose);
  const pcStable = noReconnect && livePcsStillLive(liveBeforeClose, new Map(pcsAfterClose.map((pc) => [pc.id, pc])));

  // dispose 誤発火検知 (M3 の最重要判定、上のコメント参照)。
  const callDidNotEnd = callViewStateAfterClose !== "none";

  const bobPcsAfterClose = (await evalInCallView(bobApp, PCS_SUMMARY_SCRIPT)).value ?? [];
  const bobInCallAfterClose = await evalInCallView(
    bobApp,
    `document.querySelector('[data-testid="incall_leave"]') !== null`,
  );
  const bobUnaffected =
    Boolean(bobInCallBeforeClose.ok && bobInCallBeforeClose.value === true) &&
    Boolean(bobInCallAfterClose.ok && bobInCallAfterClose.value === true) &&
    livePcsStillLive(bobLiveBeforeClose, new Map(bobPcsAfterClose.map((pc) => [pc.id, pc])));

  const pass =
    attachedAfterPopout === "window" &&
    Boolean(closeResult && closeResult.ok) &&
    revertedToMain.ok &&
    attachedAfterClose === "main" &&
    noReconnect &&
    pcStable &&
    callDidNotEnd &&
    bobUnaffected;

  return {
    callViewStateBefore,
    attachedAfterPopout,
    closeResult,
    attachedAfterClose,
    callViewStateAfterClose,
    callDidNotEnd,
    noReconnect,
    pcStable,
    bobUnaffected,
    measurements: { pcsBeforeClose, pcsAfterClose, bobPcsBeforeClose, bobPcsAfterClose },
    pass,
  };
}

// M1 step 3c-2 (localStorage 契約の実機確認): cinny (mainWindow) と call view は session
// partition が異なるため (src/main.cjs の CALL_VIEW_PARTITION)、web 版で
// 成立していた「cinny が書く matrix-setting-* を EC が読む」契約 (screenShareSettings.ts /
// element-call/src/settings/settings.ts) が分離後も生きるかは自明ではない -- 実測する。
// このコミット時点でブリッジ (main.cjs の pendingLocalStorageSnapshot / openCallView() 第 2 引数 /
// call-control-preload.cjs の primeLocalStorageFromShell()、cinny の
// collectNativeCallLocalStorageSnapshot()) を実装済みなので、ここでは「実装したブリッジが
// 実機で機能しているか」を検証する。値は実際にスクリーンシェア画質ピッカーが書く実キーを使う
// (screenShareSettings.ts の SCREEN_SHARE_QUALITY_KEY/SCREEN_SHARE_FPS_KEY と同一)。
//
// **タイミングが重要**: `collectNativeCallLocalStorageSnapshot()` は cinny の
// `NativeCallEmbed` コンストラクタ (= cinny 自身の「参加」ボタンを押した瞬間) で一度だけ
// スナップショットを取る (`openCallView()` の呼び出しと同時)。そのため、テスト対象の値は
// **join する前** に localStorage へ書き込んでおかなければならない — join 後に書き込んでも
// 既に送信済みのスナップショットには反映されない (受け入れレビューで実際に踏んだ罠: 最初の
// 実装は in-call になってから値を設定していたため、常に空スナップショットになっていた)。
const LOCAL_STORAGE_CONTRACT_TEST_VALUES = { quality: "720", fps: 30 };

async function primeLocalStorageBeforeJoin(alicePage) {
  const { quality, fps } = LOCAL_STORAGE_CONTRACT_TEST_VALUES;
  await alicePage.evaluate(
    ({ quality: q, fps: f }) => {
      localStorage.setItem("matrix-setting-screen-share-quality", JSON.stringify(q));
      localStorage.setItem("matrix-setting-screen-share-fps", JSON.stringify(f));
    },
    { quality, fps },
  );
}

async function verifyLocalStorageContract(aliceApp) {
  const TEST_QUALITY = LOCAL_STORAGE_CONTRACT_TEST_VALUES.quality;
  const TEST_FPS = LOCAL_STORAGE_CONTRACT_TEST_VALUES.fps;

  const readBack = await evalInCallView(
    aliceApp,
    `({
      quality: localStorage.getItem('matrix-setting-screen-share-quality'),
      fps: localStorage.getItem('matrix-setting-screen-share-fps'),
    })`,
  );

  const snapshot = await getMainProcessSnapshot(aliceApp);
  const bridgeEvents = snapshot?.localStorageBridgeEvents ?? [];
  const primedKeys = bridgeEvents.flatMap((e) => e.keys ?? []);

  const matched =
    Boolean(readBack.ok) &&
    readBack.value?.quality === JSON.stringify(TEST_QUALITY) &&
    readBack.value?.fps === JSON.stringify(TEST_FPS);

  return {
    writtenInCinny: { quality: TEST_QUALITY, fps: TEST_FPS },
    readBackFromCallView: readBack,
    bridgeEvents,
    primedKeys,
    note:
      "Electron session partitions isolate localStorage even for the same origin -- cinny " +
      "(mainWindow, default session) and the call view (CALL_VIEW_PARTITION) do NOT share " +
      "localStorage automatically, unlike same-origin iframes in the web build. This was " +
      "confirmed broken by architecture (verified via isolated probe before the fix existed) " +
      "and is now bridged via NativeCallEmbed.ts's collectNativeCallLocalStorageSnapshot() -> " +
      "openCallView()'s 2nd arg -> main.cjs's pendingLocalStorageSnapshot -> " +
      "call-control-preload.cjs's primeLocalStorageFromShell() (writes before the EC bundle's " +
      "Setting classes read localStorage at module-evaluation time).",
    pass: matched,
  };
}

// H3 (受け入れレビュー修正、major): 「共有開始のたびに localStorage を再同期する」live 契約の
// 実機検証。verifyLocalStorageContract() は join 時点の 1 回きりのスナップショット (pending
// snapshot 経路) しか検証しておらず、通話中の画質/FPS 変更が反映されることまでは確認していなかった。
//
// 重要: この検証は `invokeAliceCallControl(aliceApp, "toggleScreenshare")` (main プロセスの
// invokeCallControl() を直接叩く、call-control-preload.cjs の DOM click だけを起こす経路) を
// 使ってはならない -- それは main 側の RPC 中継を直接叩くだけで、cinny の
// NativeCallControl.toggleScreenshare() (H3 の live 再同期ロジック本体、
// collectNativeCallLocalStorageSnapshot() -> transport.updateCallLocalStorage() を実際に
// 呼ぶ場所) を一切経由しない。そのため cinny 自身の実 UI (Controls.tsx の ScreenShareButton と
// その画質/FPS ピッカー、alicePage 上の要素) を実際にクリックして検証する。
//
// ScreenShareButton の画質/FPS ピッカーは「共有していない」ときにしか開かない
// (Controls.tsx の handleClick: enabled なら即 toggle、そうでなければ popout を開く) ため、
// この関数を呼ぶ時点で screenshare が既に ON であること前提に、一旦オフにしてから新しい
// 設定 (LOCAL_STORAGE_CONTRACT_TEST_VALUES とは異なる値) でオンに戻す (off→on)。
// 選択肢は Controls.tsx の SCREEN_SHARE_QUALITIES ('720'|'1080'|'source') /
// SCREEN_SHARE_FPS_OPTIONS (15|30|60) が実際に描画するチップ (data-testid="ssq_<value>"/
// "ssf_<value>") に一致する値でなければならない -- primeLocalStorageBeforeJoin() が使う
// 720/30 とは異なる組み合わせ (1080/15) を選ぶ。
const MID_CALL_SETTINGS_SYNC_VALUES = { quality: "1080", fps: 15 };

async function verifyMidCallSettingsSync(_alicePage, aliceApp) {
  // 1. Stop the active share using the shared Element Call footer.
  await clickCallViewControl(aliceApp, "incall_screenshare");
  await wait(1000);
  const afterOff = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");

  // 2. Change quality/FPS in the same footer, then start a fresh share.
  await clickCallViewControl(aliceApp, "screenshare_options");
  await clickCallViewControl(
    aliceApp,
    `ss_quality_${MID_CALL_SETTINGS_SYNC_VALUES.quality}`,
  );
  await clickCallViewControl(aliceApp, `ss_fps_${MID_CALL_SETTINGS_SYNC_VALUES.fps}`);
  await clickCallViewControl(aliceApp, "incall_screenshare");
  const midCallPicker = await driveSourcePicker(aliceApp, { log }, { includeSystemAudio: true });
  await wait(1500);
  const afterOn = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");

  const readBack = await evalInCallView(
    aliceApp,
    `({
      quality: localStorage.getItem('matrix-setting-screen-share-quality'),
      fps: localStorage.getItem('matrix-setting-screen-share-fps'),
    })`,
  );

  const matched =
    Boolean(readBack.ok) &&
    readBack.value?.quality === JSON.stringify(MID_CALL_SETTINGS_SYNC_VALUES.quality) &&
    readBack.value?.fps === JSON.stringify(MID_CALL_SETTINGS_SYNC_VALUES.fps);

  return {
    writtenInCallView: MID_CALL_SETTINGS_SYNC_VALUES,
    afterOff,
    afterOn,
    readBackFromCallView: readBack,
    midCallPicker,
    note:
      "Drives the production Element Call screen-share menu used in both native placements. " +
      "The setting and getDisplayMedia call now live in one renderer, eliminating the old " +
      "Cinny-to-call-view timing dependency while still exercising the native source picker.",
    pass:
      afterOff === "false" &&
      afterOn === "true" &&
      matched &&
      Boolean(midCallPicker.opened && midCallPicker.shared),
  };
}

// SelfMatrix GPT レビュー P1b 回帰確認: 通話跨ぎ (join → hangup → 再 join)。
// C1 (このワークスペースの M1 全体レビュー即時修正、main.cjs の callViewPreloadRegistrationCount
// コメント参照) は「session.fromPartition(...).registerPreloadScript() はプロセス全体を通して
// 高々 1 回しか呼ばない」という不変条件を実装で固定したが、これまで E2E からは main プロセス内部の
// モジュールスコープ変数を直接読む手段が無く (getSnapshot() に露出していなかった -- このコミットで
// 追加した)、実際に 1 通話終えて同じプロセスで再度参加した後もこの不変条件が保たれているかを
// E2E レベルで確認していなかった。
//
// この関数は alice が cinny 自身の切断ボタン (`[data-testid="call_hangup"]`、実クリック -- この
// コミットで CallControls.tsx に追加。元は testid が無かった) で通話を退出し、同じ Electron
// プロセスで再度参加するところまでを実際に駆動し、以下を実測する。再 join は cinny 自身の
// "参加" ボタンへの実クリックである点は native-join.e2e.mjs/openVoiceLoungeAndJoin() と同じだが、
// alice は退出後も同じ room を表示したままなので、そのヘルパーが行うサイドバー room 項目の
// 再クリックは行わない (実機確認で判明したつまずき -- 下のコード内コメント参照)。
//   1. 退出後、実際に main 側の call view が破棄される (state.callViewState === "none")。
//   2. 同じプロセスで再度 "参加" を押して実 in-call 状態まで到達できる -- これ自体が
//      getOrClaimWidgetTransport() のキャッシュ (nativeBridge.ts の G2 修正コメント参照) が
//      2 通話目でも claim-once ガードに例外を投げられていないことの証明になる (例外が起きれば
//      NativeCallEmbed のコンストラクタが同期的に throw し、"参加" クリック自体が in-call まで
//      到達しない)。
//   3. callViewPreloadRegistrationCount が通話をまたいでも 1 のまま (C1 の E2E レベル回帰確認)。
//   4. 再 join 後、cinny 自身の screenshare ボタンを実クリック 1 セット (アイコン → 画質/FPS
//      ピッカー → 配信を開始) で操作すると、実際に 1 回だけ反転する。call-control-preload.cjs が
//      call view の同一フレームに二重登録されていた場合、1 回の RPC 往復で実クリックが 2 回発生し
//      「開始→即停止」になる (aria-pressed が反転しない/action-toggleScreenshare の state push が
//      2 件になる) -- before/after の aria-pressed と push 件数の両方で判定する。
async function runCallRespawn(aliceApp, alicePage) {
  const registrationBeforeSnapshot = await getMainProcessSnapshot(aliceApp);
  const registrationCountBeforeHangup =
    registrationBeforeSnapshot?.callViewPreloadRegistrationCount ?? null;

  // 1. alice 自身の切断ボタン (実クリック) で退出する。
  await clickCallViewControl(aliceApp, "incall_leave");

  const callViewClosed = await waitForCondition(
    "callRespawn.callViewClosed",
    async () => {
      const snapshot = await getMainProcessSnapshot(aliceApp);
      return { ok: snapshot?.callViewState === "none" };
    },
    20000,
    { log },
  );

  const backToPrescreen = await waitForCondition(
    "callRespawn.backToPrescreen",
    async () => {
      const visible = await alicePage
        .getByRole("button", { name: "参加", exact: true })
        .isVisible()
        .catch(() => false);
      return { ok: visible };
    },
    20000,
    { log },
  );

  // つまずき (実機確認、2 回再現): hangup 直後は "参加" ボタンが可視状態のまま長時間 disabled の
  // ままになることがあった。当初 openVoiceLoungeAndJoin() をそのまま再利用していたが、そのヘルパーは
  // 「サイドバーの "Voice Lounge" 項目を毎回クリックしてから join ボタンを探す」実装になっている
  // (元々 alice/bob が別の画面から room を開いて初めて join するケース向け)。実機確認したところ、
  // 一度 in-call まで到達済みで **既にその room を表示したまま**の alice に対してこの
  // サイドバー再クリックを行うと、`isEnabled()` の事前チェックが一時的に true を観測した直後でも
  // (`callRespawn.joinButtonEnabled: OK` のログの直後に) join ボタンの click() 自体が
  // 45000ms 経っても "not enabled" のまま失敗し続けた -- サイドバー再クリックのたびに
  // canJoin の再計算 (もしくは室再選択に伴う一時的な disabled 状態) がリセットされていたと見られる。
  // alice は退出後も同じ room を表示したままなので、そもそもサイドバーの再クリックは不要 --
  // 直接 "参加" ボタンだけを待って実クリックする (openVoiceLoungeAndJoin() は変更していない --
  // alice/bob の初回 join は今までどおりそちらを使う)。
  const joinButton = alicePage.getByRole("button", { name: "参加", exact: true });
  const joinButtonEnabled = await waitForCondition(
    "callRespawn.joinButtonEnabled",
    async () => {
      const enabled = await joinButton.isEnabled().catch(() => false);
      return { ok: enabled };
    },
    45000,
    { log },
  );

  // 2. 同じプロセスで再度参加する (サイドバー再クリックを挟まず、join ボタンだけを直接クリックする
  //    -- 上のつまずきコメント参照)。
  let rejoinOutcome;
  if (!joinButtonEnabled.ok) {
    rejoinOutcome = { clickedJoin: false, reason: "join_button_never_enabled" };
  } else {
    try {
      await joinButton.click({ timeout: 45000 });
      rejoinOutcome = { clickedJoin: true, reason: null };
    } catch (error) {
      rejoinOutcome = { clickedJoin: false, reason: String(error && error.message ? error.message : error) };
    }
  }
  const rejoinInCall = rejoinOutcome.clickedJoin
    ? await waitForInCall(aliceApp, "alice-respawn")
    : { pass: false, reason: "rejoin_join_button_not_clicked" };

  // 3. 登録カウントが通話をまたいでも 1 のまま。
  const registrationAfterSnapshot = await getMainProcessSnapshot(aliceApp);
  const registrationCountAfterRejoin =
    registrationAfterSnapshot?.callViewPreloadRegistrationCount ?? null;
  const registrationStable =
    registrationCountBeforeHangup === 1 && registrationCountAfterRejoin === 1;

  // 4. screenshare が実クリックで 1 回だけ反転する (二重リスナー回帰の検知)。
  let screenshareSingleToggle = { pass: false, reason: "not_in_call" };
  if (rejoinInCall.pass) {
    const before = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");
    const t0 = Date.now();
    await clickCallViewControl(aliceApp, "screenshare_options");
    await clickCallViewControl(aliceApp, "ss_quality_720");
    await clickCallViewControl(aliceApp, "ss_fps_30");
    await clickCallViewControl(aliceApp, "incall_screenshare");
    // M2 画面共有ソース選択 UI: 通話跨ぎ後の再共有もネイティブピッカーを実際に経由する
    // (バイパスしない -- 選ばないと getDisplayMedia が解決せず after が反転しない)。
    const respawnPicker = await driveSourcePicker(aliceApp, { log }, { includeSystemAudio: true });
    await wait(1500);
    const after = await getCallViewAttribute(aliceApp, "incall_screenshare", "aria-checked");
    const snapshot = await getMainProcessSnapshot(aliceApp);
    const pushesSinceClick = (snapshot?.callControlMessages ?? []).filter(
      (m) =>
        m.direction === "state-push" &&
        m.kind === "call-control" &&
        m.screenshare === true &&
        m.t >= t0,
    );
    screenshareSingleToggle = {
      before,
      after,
      pushCount: pushesSinceClick.length,
      pushes: pushesSinceClick,
      respawnPicker,
      pass:
        before !== after &&
        after === "true" &&
        pushesSinceClick.length === 1 &&
        Boolean(respawnPicker.opened && respawnPicker.shared),
    };
  }

  const pass =
    callViewClosed.ok &&
    backToPrescreen.ok &&
    Boolean(rejoinOutcome.clickedJoin) &&
    rejoinInCall.pass &&
    registrationStable &&
    screenshareSingleToggle.pass;

  return {
    registrationCountBeforeHangup,
    registrationCountAfterRejoin,
    registrationStable,
    callViewClosed: callViewClosed.ok,
    backToPrescreen: backToPrescreen.ok,
    joinButtonEnabled: joinButtonEnabled.ok,
    rejoinOutcome,
    rejoinInCall,
    screenshareSingleToggle,
    pass,
  };
}

// ---- M2 bounds sync (Fable 全体レビュー arch-major 解消) の実機検証 ---------------------------
//
// 背景: web 版では useCallEmbedPlacementSync (cinny/src/app/hooks/useCallEmbed.ts) が CallView 内の
// 実レイアウト座標を毎フレーム計算し、CallEmbedProvider の position:fixed div
// (data-call-embed-container、iframe 実体入り) に反映する。native では実描画が別プロセスの
// WebContentsView (main.cjs の state.callView) にあり、この座標を渡すチャンネルが存在しなかった
// (main.cjs の updateCallViewBounds() はハーネス専用の固定式のまま) -- 実 cinny UI 上でビデオが
// 正しい位置/サイズに出ることは一度も検証されていなかった。この節はそれを実機で検証する。
//
// 検証対象:
//   1. join 後: cinny 自身が計算した実 rect (data-call-embed-container の
//      getBoundingClientRect()) と、main.cjs が実際に state.callView へ適用した bounds
//      (__selfmatrixE2E.getSnapshot().callViewActualBounds -- state 変数ではなく Electron の
//      View.getBounds() を直接読んだ値、H1 と同じ「実体から逆算した積極的証拠」の方針) が
//      許容誤差 (±3px) で一致すること。
//   2. レイアウト変化への追従: ウィンドウリサイズ (__selfmatrixE2E.resizeMainWindow()) と、
//      cinny 自身の実 UI 操作 (チャットパネル開閉 -- Controls.tsx の ChatButton
//      [data-testid="call_control_chat"]、features/room/Room.tsx の
//      `{callView && chat && (<CallChatView/>)}` が CallView と横並びで追加されコンテナ幅が
//      実際に縮む、実在する操作であることをソースで確認済み) の両方で再一致すること。
//   3. detach (別窓) 中は追従判定をスキップする (nativeBridge.ts の setCallViewBounds() 契約:
//      popout 自体を native ではまだ提供していないため cinny は detach 中このメソッドを呼ばないが、
//      念のため main.cjs 側は callViewState!=="attached" を無視する防御を持つ -- ここではその
//      防御が実際に効いていること (callViewBoundsApplyLog に reason:"not-attached" が記録される
//      こと) を確認する)。attach 復帰後に再一致することを確認する。

const BOUNDS_TOLERANCE_PX = 3;
const BOUNDS_POLL_TIMEOUT_MS = 10000;
const BOUNDS_POLL_INTERVAL_MS = 200;

// cinny 自身が実際に計算した「call view を表示すべき領域」を読む。data-call-embed-container div は
// (web/native 問わず) useCallEmbedPlacementSync が毎フレーム同期しているので、この div の実測
// getBoundingClientRect() が「cinny が実際に計算した値」の一次証跡になる (native シェルへ push
// される値と同じ計算元 -- CallView.tsx の callContainerRef の rect)。visibility:hidden でも
// レイアウトには参加する (display:none ではない) ため、callVisible の真偽によらず読める。
async function readCinnyCallContainerRect(alicePage) {
  return alicePage.evaluate(() => {
    const el = document.querySelector("[data-call-embed-container]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
}

function boundsClose(cinnyRect, shellBounds, tolerancePx) {
  if (!cinnyRect || !shellBounds) return false;
  return (
    Math.abs(cinnyRect.left - shellBounds.x) <= tolerancePx &&
    Math.abs(cinnyRect.top - shellBounds.y) <= tolerancePx &&
    Math.abs(cinnyRect.width - shellBounds.width) <= tolerancePx &&
    Math.abs(cinnyRect.height - shellBounds.height) <= tolerancePx
  );
}

// cinny 側 (data-call-embed-container の実測矩形) と shell 側 (main.cjs が実際に state.callView へ
// 適用した getBounds()、callViewVisible が実際に true) を、requestAnimationFrame/IPC の伝搬猶予を
// 見込んでポーリング比較する。
async function waitForBoundsMatch(aliceApp, alicePage, label) {
  const started = Date.now();
  let last = { cinnyRect: null, shellBounds: null, shellVisible: null };
  while (Date.now() - started < BOUNDS_POLL_TIMEOUT_MS) {
    const cinnyRect = await readCinnyCallContainerRect(alicePage);
    const snapshot = await getMainProcessSnapshot(aliceApp);
    const shellBounds = snapshot?.callViewActualBounds ?? null;
    const shellVisible = snapshot?.callViewVisible ?? null;
    last = { cinnyRect, shellBounds, shellVisible };
    if (shellVisible === true && boundsClose(cinnyRect, shellBounds, BOUNDS_TOLERANCE_PX)) {
      log(`boundsSync.${label}: matched (cinnyRect=${JSON.stringify(cinnyRect)}, shellBounds=${JSON.stringify(shellBounds)}).`);
      return { ok: true, ...last };
    }
    await wait(BOUNDS_POLL_INTERVAL_MS);
  }
  log(
    `boundsSync.${label}: NOT matched within ${BOUNDS_POLL_TIMEOUT_MS}ms ` +
      `(cinnyRect=${JSON.stringify(last.cinnyRect)}, shellBounds=${JSON.stringify(last.shellBounds)}, ` +
      `shellVisible=${last.shellVisible}).`,
  );
  return { ok: false, ...last };
}

async function runBoundsSync(aliceApp, alicePage) {
  const boundsSync = {};

  // 1. join 後の初期一致。
  boundsSync.initial = await waitForBoundsMatch(aliceApp, alicePage, "initial");

  // 2. ウィンドウリサイズへの追従 (mainWindow の content サイズを直接変える --
  //    __selfmatrixE2E.resizeMainWindow()、main.cjs 参照。実ユーザーのウィンドウリサイズと同じ
  //    実イベント経路 -- setContentSize() は OS ネイティブの枠を除いた実描画領域を直接指定する)。
  const resizeOutcome = await aliceApp.evaluate(() => global.__selfmatrixE2E.resizeMainWindow(1150, 700));
  boundsSync.resizeInvoked = resizeOutcome;
  await wait(500);
  boundsSync.afterWindowResize = await waitForBoundsMatch(aliceApp, alicePage, "afterWindowResize");

  // 3. A second real window resize confirms repeated layout updates, without
  // relying on the removed duplicate call-chat button.
  const secondResizeOutcome = await aliceApp.evaluate(() =>
    global.__selfmatrixE2E.resizeMainWindow(1250, 740),
  );
  boundsSync.secondResizeInvoked = secondResizeOutcome;
  await wait(500);
  boundsSync.afterSecondResize = await waitForBoundsMatch(
    aliceApp,
    alicePage,
    "afterSecondResize",
  );

  // 4. Main-window bounds updates are intentionally ignored while the call
  // view belongs to the popout. Resize twice to exercise that production path
  // while restoring the same main layout before reattaching.
  const beforeDetachLogLen = (await getMainProcessSnapshot(aliceApp))?.callViewBoundsApplyLog?.length ?? 0;
  await aliceApp.evaluate(() => global.__selfmatrixE2E.detachCallView());
  await wait(REPARENT_SETTLE_MS);
  await aliceApp.evaluate(() => global.__selfmatrixE2E.resizeMainWindow(1000, 650));
  await wait(500);
  await aliceApp.evaluate(() => global.__selfmatrixE2E.resizeMainWindow(1250, 740));
  await wait(500);
  const duringDetachSnapshot = await getMainProcessSnapshot(aliceApp);
  const duringDetachLog = (duringDetachSnapshot?.callViewBoundsApplyLog ?? []).slice(beforeDetachLogLen);
  const ignoredWhileDetached = duringDetachLog.some((entry) => entry.applied === false && entry.reason === "not-attached");
  boundsSync.duringDetach = { ignoredWhileDetached, entriesSinceDetach: duringDetachLog };

  // 5. attach 復帰後、再一致することを確認する (detach 前と正味同じレイアウトに戻してあるので、
  //    reattach 自体が cinny 側の再 push を伴わなくても、shell 側が保持している最後の適用値は
  //    detach 前のまま正しい)。
  await aliceApp.evaluate(() => global.__selfmatrixE2E.attachCallView());
  await wait(REPARENT_SETTLE_MS);
  boundsSync.afterReattach = await waitForBoundsMatch(aliceApp, alicePage, "afterReattach");

  // 6. ウィンドウサイズを元に戻す (後続ステップ/証跡スクリーンショットへの影響を避ける)。
  await aliceApp.evaluate(() => global.__selfmatrixE2E.resizeMainWindow(1400, 860));
  await wait(500);
  boundsSync.afterWindowRestore = await waitForBoundsMatch(aliceApp, alicePage, "afterWindowRestore");

  const pass =
    boundsSync.initial.ok &&
    boundsSync.afterWindowResize.ok &&
    boundsSync.afterSecondResize.ok &&
    boundsSync.duringDetach.ignoredWhileDetached &&
    boundsSync.afterReattach.ok &&
    boundsSync.afterWindowRestore.ok;

  return { ...boundsSync, pass };
}

async function main() {
  await checkBackendReachable({ log, failFast });
  const alicePassword = requireEnv("SELFMATRIX_E2E_PASSWORD_ALICE", { failFast });
  const bobPassword = requireEnv("SELFMATRIX_E2E_PASSWORD_BOB", { failFast });
  const elementCallDir = resolveElementCallDir({ failFast });

  const result = {
    startedAt: new Date().toISOString(),
    pass: false,
    room: ROOM_NAME,
    steps: {},
    passConditions: {},
    error: null,
  };

  let aliceApp = null;
  let bobApp = null;
  let aliceUserDataDir = null;
  let bobUserDataDir = null;
  let capturedOrigin = null;

  try {
    // ---- 1. alice: native-join と同じ経路で join --------------------------------------------
    log("launching alice's Electron instance (--cinny-shell --e2e-real-join)...");
    const alice = await launchAndJoin("alice", alicePassword, elementCallDir);
    aliceApp = alice.electronApp;
    aliceUserDataDir = alice.userDataDir;
    const alicePage = alice.page;

    // localStorage 契約テスト用の値は、cinny の NativeCallEmbed が openCallView() 呼び出しと
    // 同時にスナップショットを取る「参加」ボタンクリックより **前** に書き込んでおく必要がある
    // (verifyLocalStorageContract() 冒頭コメント参照)。
    await primeLocalStorageBeforeJoin(alicePage);

    const aliceJoinOutcome = await openVoiceLoungeAndJoin(alicePage, { log });
    result.steps.aliceJoin = aliceJoinOutcome;
    if (!aliceJoinOutcome.clickedJoin) {
      throw new Error(`alice could not click cinny's own prescreen Join button (${aliceJoinOutcome.reason})`);
    }

    const aliceInCall = await waitForInCall(aliceApp, "alice");
    result.passConditions.alice = aliceInCall;
    if (!aliceInCall.pass) {
      throw new Error(`alice did not reach a real in-call state: ${JSON.stringify(aliceInCall)}`);
    }
    log("alice is in-call.");

    // ---- 2. bob: 2 個目の Electron インスタンスで同じ経路で join ------------------------------
    log("launching bob's Electron instance (2nd process, --cinny-shell --e2e-real-join)...");
    const bob = await launchAndJoin("bob", bobPassword, elementCallDir);
    bobApp = bob.electronApp;
    bobUserDataDir = bob.userDataDir;
    const bobPage = bob.page;

    const bobJoinOutcome = await openVoiceLoungeAndJoin(bobPage, { log });
    result.steps.bobJoin = bobJoinOutcome;
    if (!bobJoinOutcome.clickedJoin) {
      throw new Error(`bob could not click cinny's own prescreen Join button (${bobJoinOutcome.reason})`);
    }

    const bobInCall = await waitForInCall(bobApp, "bob");
    result.passConditions.bob = bobInCall;
    if (!bobInCall.pass) {
      throw new Error(`bob did not reach a real in-call state: ${JSON.stringify(bobInCall)}`);
    }
    log("bob is in-call.");

    // ---- 3. 2 ユーザー通話成立の判定 ----------------------------------------------------------
    const tileCountCondition = await waitForCondition(
      "twoUserCall.participantTileCount",
      async () => {
        const evalResult = await evalInCallView(aliceApp, participantTileCountScript());
        return { ok: evalResult.ok && evalResult.value === 2, count: evalResult.ok ? evalResult.value : null };
      },
      30000,
      { log },
    );
    const statsT0 = (await evalInCallView(aliceApp, RTP_STATS_SCRIPT)).value ?? {};
    await wait(3000);
    const statsT1 = (await evalInCallView(aliceApp, RTP_STATS_SCRIPT)).value ?? {};
    const audioIncreasing = (statsT1.audioBytesReceived ?? 0) > (statsT0.audioBytesReceived ?? 0);

    const twoUserCallEstablished = {
      participantTileCount: tileCountCondition.count,
      participantTileCountPass: tileCountCondition.ok,
      statsT0,
      statsT1,
      audioIncreasing,
      pass: tileCountCondition.ok && audioIncreasing,
    };
    result.passConditions.twoUserCallEstablished = twoUserCallEstablished;
    log(`twoUserCallEstablished: ${JSON.stringify({ tiles: twoUserCallEstablished.participantTileCount, audioIncreasing })}`);
    if (!twoUserCallEstablished.pass) {
      throw new Error(`two-user call was not established: ${JSON.stringify(twoUserCallEstablished)}`);
    }

    // ---- 3.5 M2 bounds sync (Fable 全体レビュー arch-major 解消) の実機確認。screenshare や
    //          window-move の前、通話成立直後のまっさらな状態 (chat 閉/既定ウィンドウサイズ) で
    //          行う -- 終了時にウィンドウサイズ/chat 状態を元に戻すので以降のステップに影響しない。
    const boundsSync = await runBoundsSync(aliceApp, alicePage);
    result.passConditions.boundsSync = boundsSync;
    log(
      `boundsSync: initial=${boundsSync.initial.ok} afterWindowResize=${boundsSync.afterWindowResize.ok} ` +
        `afterChatOpen=${boundsSync.afterChatOpen.ok} afterChatClose=${boundsSync.afterChatClose.ok} ` +
        `duringDetach.ignored=${boundsSync.duringDetach.ignoredWhileDetached} afterReattach=${boundsSync.afterReattach.ok}`,
    );

    // ---- 4. localStorage 契約の実機確認 (screenshare 開始前に検証しておく) --------------------
    const localStorageContract = await verifyLocalStorageContract(aliceApp);
    result.passConditions.localStorageContract = localStorageContract;
    log(`localStorageContract.pass=${localStorageContract.pass}`);

    // ---- 5. 7 語彙の実 in-call DOM 検証 + state push 再同期 -----------------------------------
    const callControlResult = await runCallControlVocabulary(aliceApp, alicePage);
    result.passConditions.callControlVocabulary = callControlResult;
    log(`callControlVocabulary.pass=${callControlResult.pass}`);

    // ---- 5.1 M2 画面共有ソース選択 UI: ネイティブピッカーが実際に開いたこと・ソース一覧が非空・
    //          "SelfMatrix" タイルを選んで共有できたこと・システム音声トグル ON で audio track が
    //          乗ったことを実測する (上の toggleScreenshare 語彙検証と同じ操作から得られた結果を
    //          再利用する -- 二重に screenshare を開始しない)。--------------------------------
    const sourcePickerVerification = callControlResult.sourcePickerVerification;
    result.passConditions.sourcePicker = sourcePickerVerification;
    const pickerUi = sourcePickerVerification?.sourcePicker;
    log(
      `sourcePicker: opened=${pickerUi?.opened} sourceCount=${pickerUi?.sourceCount} ` +
        `tileFound=${pickerUi?.tileFound} shared=${pickerUi?.shared} ` +
        `systemAudioAvailable=${pickerUi?.systemAudioAvailable} ` +
        `systemAudioTrackAdded=${sourcePickerVerification?.systemAudioTrackAdded} pass=${sourcePickerVerification?.pass}`,
    );

    // ---- 5.5 M1 全体レビュー test-critical #3: spotlight/emphasis/settings/sound を cinny 自身の
    //          実 UI クリックで駆動する (screenshare は下の H3 ステップで、reactions は cinny 側に
    //          ボタンが無いため対象外)。-------------------------------------------------------
    const realClickResult = await runRealClickVocabulary(aliceApp, alicePage);
    result.passConditions.realClickVocabulary = realClickResult;
    log(`realClickVocabulary.pass=${realClickResult.pass}`);

    // ---- 6. H3: 通話中の画質/FPS 設定変更が call view の localStorage に「共有再開のたびに」
    //         反映される live 契約の実機確認 (cinny 自身の実 UI クリック経由)。screenshare は
    //         上のステップ 5 で ON のまま -- ここで off→on し直す (bob の視聴 opt-in はこの後、
    //         新しいストリームに対して行う)。--------------------------------------------------
    const midCallSettingsSync = await verifyMidCallSettingsSync(alicePage, aliceApp);
    result.passConditions.midCallSettingsSync = midCallSettingsSync;
    log(`midCallSettingsSync.pass=${midCallSettingsSync.pass}`);

    // ---- 7. bob に配信の視聴を opt-in させる (SelfMatrix の視聴オプトイン仕様、
    //         「media が流れ続けること」を意味のある形で実測するために必要) --------------------
    const bobWatchOptIn = await optInBobToWatchScreenshare(bobApp);
    result.passConditions.bobWatchOptIn = bobWatchOptIn;
    log(`bobWatchOptIn.ok=${bobWatchOptIn.ok}`);

    // ---- 8. 配信中の窓移動無再接続 (3 往復) ---------------------------------------------------
    const windowMove = await runWindowMoveReparenting(aliceApp, bobApp);
    result.passConditions.windowMoveReparenting = windowMove;
    log(
      `windowMoveReparenting: noReload=${windowMove.noReload} pcStable=${windowMove.pcStable} ` +
        `mediaContinues=${windowMove.mediaContinues} bobUnaffected=${windowMove.bobUnaffected} ` +
        `allRoundTripsActuallyMoved=${windowMove.allRoundTripsActuallyMoved}`,
    );

    // ---- 8.5. The shared Element Call call bar stays visible across reparenting. -----------------
    const footerVisibilityToggle = await runFooterVisibilityToggle(aliceApp);
    result.passConditions.footerVisibilityToggle = footerVisibilityToggle;
    log(
      `footerVisibilityToggle: attachedBefore=${footerVisibilityToggle.attachedBefore} ` +
        `visibleBefore=${footerVisibleAsExpected(footerVisibilityToggle.footerWhileAttachedBefore)} ` +
        `attachedAfterDetach=${footerVisibilityToggle.attachedAfterDetach} ` +
        `visibleWhileDetached=${footerVisibleAsExpected(footerVisibilityToggle.footerWhileDetached)} ` +
        `attachedAfterAttach=${footerVisibilityToggle.attachedAfterAttach} ` +
        `visibleAfterReattach=${footerVisibleAsExpected(footerVisibilityToggle.footerWhileAttachedAfter)} ` +
        `pass=${footerVisibilityToggle.pass}`,
    );

    // ---- 8.6 Shared footer window controls: popout/pin/fullscreen/popin. --------------------------
    const realPopoutPopinClick = await runRealPopoutPopinClick(aliceApp);
    result.passConditions.realPopoutPopinClick = realPopoutPopinClick;
    log(
      `realPopoutPopinClick: attachedBefore=${realPopoutPopinClick.attachedBefore} ` +
        `popoutButtonVisible=${realPopoutPopinClick.popoutButtonVisible} ` +
        `attachedAfterPopout=${realPopoutPopinClick.attachedAfterPopout} ` +
        `noReconnectAfterPopout=${realPopoutPopinClick.noReconnectAfterPopout} ` +
        `stillConnectedAfterPopout=${realPopoutPopinClick.stillConnectedAfterPopout} ` +
        `popinButtonVisible=${realPopoutPopinClick.popinButtonVisible} ` +
        `attachedAfterPopin=${realPopoutPopinClick.attachedAfterPopin} ` +
        `noReconnectAfterPopin=${realPopoutPopinClick.noReconnectAfterPopin} ` +
        `stillConnectedAfterPopin=${realPopoutPopinClick.stillConnectedAfterPopin} ` +
        `pass=${realPopoutPopinClick.pass}`,
    );

    // ---- 8.7 SelfMatrix M3 step 5 (M3 の受け入れ条件の核心): 別窓を実際に閉じたときのメイン復帰・
    //          通話継続 (dispose 誤発火なし)。realPopoutPopinClick 直後 (call view は "main" に
    //          attached で終わる) に行う。-----------------------------------------------------
    const closeWindowMainRevert = await runCloseWindowMainRevert(aliceApp, bobApp);
    result.passConditions.closeWindowMainRevert = closeWindowMainRevert;
    log(
      `closeWindowMainRevert: attachedAfterPopout=${closeWindowMainRevert.attachedAfterPopout} ` +
        `closeResult.ok=${closeWindowMainRevert.closeResult?.ok} ` +
        `attachedAfterClose=${closeWindowMainRevert.attachedAfterClose} ` +
        `callViewStateAfterClose=${closeWindowMainRevert.callViewStateAfterClose} ` +
        `callDidNotEnd=${closeWindowMainRevert.callDidNotEnd} ` +
        `noReconnect=${closeWindowMainRevert.noReconnect} ` +
        `pcStable=${closeWindowMainRevert.pcStable} ` +
        `bobUnaffected=${closeWindowMainRevert.bobUnaffected} ` +
        `pass=${closeWindowMainRevert.pass}`,
    );

    // ---- 9. 証跡スクリーンショット (2 ユーザー + 配信 + 窓移動の「本来の」通話状態を、次の
    //         callRespawn ステップで alice が退出する前に残しておく) ---------------------------
    const finalSnapshot = await getMainProcessSnapshot(aliceApp);
    capturedOrigin = finalSnapshot?.origin ?? null;

    async function captureCallView(electronApp, filename) {
      try {
        const capture = await electronApp.evaluate(() => {
          if (!global.__selfmatrixE2E) return { ok: false, reason: "no_e2e_bridge" };
          return global.__selfmatrixE2E.captureCallViewPng();
        });
        if (capture && capture.ok) {
          fs.mkdirSync(evidenceDir, { recursive: true });
          fs.writeFileSync(path.join(evidenceDir, filename), Buffer.from(capture.base64, "base64"));
          return true;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    result.screenshots = {
      // 2 ユーザータイル + 配信中の状態 (この時点で screenshare は ON のまま)。
      aliceTwoUserScreenshare: await captureCallView(aliceApp, "native-callflow-alice-2user-screenshare.png"),
      bobCallView: await captureCallView(bobApp, "native-callflow-bob-callview.png"),
    };
    // 別窓移動中 (detached 状態) の様子も 1 枚残す。
    await aliceApp.evaluate(() => global.__selfmatrixE2E.detachCallView());
    await wait(REPARENT_SETTLE_MS);
    result.screenshots.aliceDetachedMidMove = await captureCallView(aliceApp, "native-callflow-alice-detached.png");
    await aliceApp.evaluate(() => global.__selfmatrixE2E.attachCallView());
    await wait(REPARENT_SETTLE_MS);

    // ---- 10. GPT レビュー P1b 回帰確認: 通話跨ぎ (alice が実クリックで退出 → 同じプロセスで
    //          再度参加)。証跡スクリーンショットを撮り終えた後に行う (この後 alice の通話は
    //          一旦終わり、call view が破棄・再生成される) -----------------------------------
    const callRespawn = await runCallRespawn(aliceApp, alicePage);
    result.passConditions.callRespawn = callRespawn;
    log(
      `callRespawn: callViewClosed=${callRespawn.callViewClosed} registrationStable=${callRespawn.registrationStable} ` +
        `(before=${callRespawn.registrationCountBeforeHangup}, after=${callRespawn.registrationCountAfterRejoin}) ` +
        `screenshareSingleToggle=${callRespawn.screenshareSingleToggle.pass}`,
    );

    result.pass =
      result.passConditions.alice.pass &&
      result.passConditions.bob.pass &&
      result.passConditions.twoUserCallEstablished.pass &&
      result.passConditions.boundsSync.pass &&
      result.passConditions.localStorageContract.pass &&
      result.passConditions.callControlVocabulary.pass &&
      Boolean(result.passConditions.sourcePicker?.pass) &&
      result.passConditions.realClickVocabulary.pass &&
      result.passConditions.midCallSettingsSync.pass &&
      result.passConditions.bobWatchOptIn.ok &&
      result.passConditions.windowMoveReparenting.pass &&
      result.passConditions.footerVisibilityToggle.pass &&
      result.passConditions.realPopoutPopinClick.pass &&
      result.passConditions.closeWindowMainRevert.pass &&
      result.passConditions.callRespawn.pass;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    log(`ERROR: ${result.error}`);
  } finally {
    if (aliceApp) await aliceApp.close().catch(() => {});
    if (bobApp) await bobApp.close().catch(() => {});
    if (aliceUserDataDir) fs.rmSync(aliceUserDataDir, { recursive: true, force: true });
    if (bobUserDataDir) fs.rmSync(bobUserDataDir, { recursive: true, force: true });
  }

  result.finishedAt = new Date().toISOString();

  const sanitized = capturedOrigin ? deepSanitize(result, capturedOrigin) : result;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "native-callflow-result.json"),
    `${JSON.stringify(sanitized, null, 2)}\n`,
    "utf8",
  );

  log(`pass=${result.pass} -- evidence written to ${path.relative(process.cwd(), evidenceDir)}`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  console.error("[native-callflow-e2e] unhandled error:", error);
  process.exit(1);
});
