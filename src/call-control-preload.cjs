// M1 step 2 (B 単体実証) → step 3b (実コントロール語彙の実装): cinny `src/app/plugins/call/CallControl.ts`
// の DOM 操作ロジック (querySelector / .click() / MutationObserver) の移植。call view (EC
// WebContentsView) の isolated world で動く独立した preload スクリプト。preload は EC と同一
// レンダラプロセス内にいるため、host (main / shell) からは触れない実 DOM に直接アクセスできる
// (design/native-widget-transport.md §2.2)。
//
// なぜ widget-bridge-preload.cjs から require せず、独立した preload として登録するのか
// (main.cjs の createCallViewIfNeeded() が session.fromPartition(CALL_VIEW_PARTITION)
// .registerPreloadScript({ filePath: .../call-control-preload.cjs, type: "frame" }) で
// 2 本目の preload として登録する):
// call view は sandbox:true で動いている。実測したところ、sandbox 下の preload の require() は
// "electron" 以外のほぼ全て (node: 組み込みモジュール、相対パスの自前ファイル、__dirname も) を
// 解決できない (`Error: module not found: path` 等、`__dirname is not defined`)。そのため
// widget-bridge-preload.cjs から `require("./call-control-preload.cjs")` する分離方法は
// sandbox 下では成立しない。Electron の `session.registerPreloadScript()`
// (絶対パスを main プロセス側で解決して登録する API) を使えば、ファイルとしては完全に分離した
// ままで、call view の同じフレームに 2 本目の preload として読み込ませられる。
// このファイル自身は "electron" の require だけで完結させてあり (それ以外は一切 require しない)、
// これは sandbox 下でも解決できることを widget-bridge-preload.cjs で確認済み。
//
// document / MutationObserver などの DOM グローバルへの参照は必ず関数本体の中 (実際に EC の
// DOM 操作が起きるタイミング) に限定してある。
//
// M1 step 3b (design §3 step 3b 実装要件 3/4、cinny native/NativeCallControl.ts の
// NativeCallControlAction 契約): CallControl.ts の実セレクタを移植し、7 action
// (toggleScreenshare/toggleSpotlight/toggleEmphasis/toggleReactions/toggleSettings/
// setSoundOn/setSoundOff) を実装した。この prototype 環境ではバックエンドが無いため EC は
// ErrorView (Room not found) を描画し、これらのセレクタはいずれも実在しない — 各 handler は
// 対象が見つからなければ例外を投げず `{ok:false, reason:"target_not_found"}` を返す (設計要件どおり)。
// 実 in-call UI に接続された際は、対象がそのまま見つかるようになる想定でセレクタは CallControl.ts と
// 完全に同じ文字列にしてある。
//
// checkbox/radio (spotlight/emphasis) の `checked` は DOM 属性ではなくプロパティのため、
// 属性ベースの MutationObserver だけでは変化を拾えない (CallControl.ts の refreshEmphasisState() と
// 同じ注意点、design §2.2 注記)。そのため各 handler は click 後に明示的に pushCallControlState() で
// 現在の DOM 状態を再読取りして push する (属性 MutationObserver からの push と合わせて二重に
// カバーしている)。
//
// toggleTarget (step 2 の単体実証用、ErrorView.tsx の CloseWidgetButton を対象にした action) は
// smoke 互換のため残してある (下記 invoke() の "toggleTarget" ケース参照) — 実コントロール 7 種とは
// 完全に独立したコードパスで、cinny-shell smoke の onCallControlState 配線確認にも引き続き使う
// (この環境で唯一実在する操作可能ターゲットのため)。

const { ipcRenderer } = require("electron");

// M1 step 3c-2 (localStorage 契約の実機対応、README「cinny の nativeBridge.ts 契約への適合」節
// 参照): call view (EC) は mainWindow (cinny) とは別の session partition (CALL_VIEW_PARTITION)
// で動いているため、同一オリジンでも localStorage は共有されない (web 版の埋め込み iframe と違い、
// Electron の Storage はオリジンではなく session partition 単位で分離される)。web 版で成立していた
// 「cinny が書く matrix-setting-* を EC が読む」契約 (element-call/src/settings/settings.ts,
// cinny/src/app/features/call/screenShareSettings.ts) をここで橋渡しする: openCallView() が
// state.pendingLocalStorageSnapshot に置いたスナップショットを、EC のバンドルが評価される
// (Setting のコンストラクタが localStorage.getItem() を読む) より確実に前のタイミング — つまり
// この preload 自身のトップレベル評価時点 — で同期的に取得して書き込む。
// ipcRenderer.sendSync は preload の実行をブロックするが、この一度きりの読み出しは軽量であり、
// EC 本体のスクリプト実行がこの preload より後に走ることを保証する Electron の preload 実行順序
// (webPreferences.preload・registerPreloadScript はいずれもページの <script> より必ず先に走る)
// を利用している。
// 診断/evidence 用の ack 込みで、渡されたスナップショットを実際に localStorage へ書き込む
// 共有ヘルパー。H3 (受け入れレビュー修正) で pending スナップショット (preload 実行時の
// 一度きりの sendSync) と live 更新 (共有開始のたびに main が push する
// native:prime-localstorage) の 2 経路がこの書き込みロジックを共有するために抽出した。
function writeLocalStorageSnapshot(snapshot, source) {
  if (!snapshot || typeof snapshot !== "object") return;
  const primedKeys = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value !== "string") continue;
    try {
      localStorage.setItem(key, value);
      primedKeys.push(key);
    } catch (error) {
      // localStorage 自体が使えない (プライベートモード相当) 場合でも EC の動作は継続させる —
      // 契約が使えないだけで致命的ではない。
    }
  }
  // 診断/evidence 用の ack。中身 (値) は送り返さず、キー名だけを報告する (README の
  // 「dev パスワードを証跡に書かない」原則と同様、必要以上の情報を main 側の evidence に
  // 残さないための最小化)。source でどちらの経路由来かを区別できるようにしてある。
  try {
    ipcRenderer.send("native:localstorage-primed", { keys: primedKeys, source });
  } catch (error) {
    // ignore
  }
}

(function primeLocalStorageFromShell() {
  let snapshot;
  try {
    snapshot = ipcRenderer.sendSync("native:get-pending-localstorage-snapshot");
  } catch (error) {
    return;
  }
  writeLocalStorageSnapshot(snapshot, "pending-snapshot");
})();

// H3 (受け入れレビュー修正、major): 「共有開始時に再同期」する live 更新経路。main.cjs の
// updateCallLocalStorage() (cinny の NativeCallControl.toggleScreenshare() がクリック前に
// 呼ぶ transport.updateCallLocalStorage() の main 側実体) がこの call view へ直接 send する。
// 上の primeLocalStorageFromShell() (1 ロード 1 回きりの pending スナップショット、main.cjs の
// H6 コメント参照) とは完全に独立した経路 — state.pendingLocalStorageSnapshot は経由しない。
ipcRenderer.on("native:prime-localstorage", (_event, snapshot) => {
  writeLocalStorageSnapshot(snapshot, "live-update");
});

// M3 step 3 (design/m3-window-ux.md §3-3): main → call view のフッター可視性 push。
// pushCallViewPlacement() (native:call-view-placement、main.cjs) とは受け手が異なる別チャンネル --
// あちらは mainWindow (cinny) 宛て、こちらは call view (この preload) 自身が受信する。main.cjs の
// detachCallView()/attachCallView()/openCallView() が placement 変化のたびに送る
// (pushCallViewFooterVisibility() 参照)。footerVisible/applyFooterVisibility() は下で定義。
ipcRenderer.on("native:set-footer-visible", (_event, visible) => {
  footerVisible = Boolean(visible);
  applyFooterVisibility();
});

const TARGET_SELECTOR = '[role="button"][data-kind="primary"]';

// CallControl.ts (src/app/plugins/call/CallControl.ts) と同一のセレクタ文字列。
const SCREENSHARE_SELECTOR = '[data-testid="incall_screenshare"]';
const LEAVE_SELECTOR = '[data-testid="incall_leave"]';
const SPOTLIGHT_SELECTOR = 'input[value="spotlight"]';
const GRID_SELECTOR = 'input[value="grid"]';
const EMPHASIS_SELECTOR = '[data-testid="emphasis_toggle"]';
const SETTINGS_LEFT_SELECTOR = '[data-testid="settings-bottom-left"]';
const SETTINGS_CENTER_SELECTOR = '[data-testid="settings-bottom-center"]';

const state = {
  invokeCount: 0,
};
let mutationObserver = null;

function findTarget() {
  return document.querySelector(TARGET_SELECTOR);
}

function pushState(target, reason) {
  ipcRenderer.send("native:call-control:state", {
    t: Date.now(),
    reason,
    kind: "legacy-target",
    selector: TARGET_SELECTOR,
    pressed: target.getAttribute("data-selfmatrix-pressed") === "true",
  });
}

// CallControl.ts の controlMutationObserver 相当: 対象要素の属性変化を監視し、変化を
// IPC push で host (main 経由 shell) へ伝える。
function observe(target) {
  if (mutationObserver) mutationObserver.disconnect();
  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.attributeName === "data-selfmatrix-pressed") {
        pushState(target, "mutation-observed");
      }
    }
  });
  mutationObserver.observe(target, {
    attributes: true,
    attributeFilter: ["data-selfmatrix-pressed"],
  });
}

// 実クリックイベントを起点に data-selfmatrix-pressed をトグルする (上記コメントの逸脱 3)。
// click() を呼ばずに直接属性を書き換えるコードパスを作らない: これにより「クリック処理を
// no-op 化する」変異は、このリスナー自体が発火しなくなり属性が変化しなくなる形で検知できる。
function ensureClickListener(target) {
  if (target.__selfmatrixCallControlBound) return;
  target.__selfmatrixCallControlBound = true;
  if (!target.hasAttribute("data-selfmatrix-pressed")) {
    target.setAttribute("data-selfmatrix-pressed", "false");
  }
  target.addEventListener("click", () => {
    const next = target.getAttribute("data-selfmatrix-pressed") !== "true";
    target.setAttribute("data-selfmatrix-pressed", String(next));
  });
}

// --- M1 step 3b: 実コントロール 7 種 (design §2.2 のカテゴリ B) -----------------------------

function screenshareButton() {
  return document.querySelector(SCREENSHARE_SELECTOR);
}

function leaveButton() {
  return document.querySelector(LEAVE_SELECTOR);
}

// M1 step 3c-3 (受け入れレビューで発覚、修正): web 版 CallControl.ts と同じ
// `leaveButton().previousElementSibling` ヒューリスティックを移植したが、この EC ビルド
// (element-call/src/components/CallFooter.tsx — SelfMatrix fork でリファクタ済み) の実 DOM を
// 実機確認したところ、end-call ボタンの直前の要素は「reactions ボタン」ではなく screenshare
// ボタンをラップする無関係な `<div>` だった (このビルドにはそもそも reactions 送信ボタン自体が
// 描画されていない — `FooterState.reactionData`/`reactionIdentifier` は型/state 層にしか存在せず
// CallFooter.tsx の JSX では一切参照されない、未配線と見られる)。無条件に previousElementSibling
// を採用すると、この無関係な `<div>` に `.click()` しても何も起きないのに `{ok:true}` を返して
// しまう (偽陽性)。実際にクリック可能なコントロール (BUTTON 要素、または role=button/switch) で
// あることを確認できた場合のみ対象として採用し、そうでなければ target_not_found として正直に
// 報告する。
function reactionsButton() {
  const leave = leaveButton();
  const sibling = leave ? leave.previousElementSibling : null;
  if (!sibling) return null;
  const role = sibling.getAttribute && sibling.getAttribute("role");
  const isClickable = sibling.tagName === "BUTTON" || role === "button" || role === "switch";
  return isClickable ? sibling : null;
}

function spotlightButton() {
  return document.querySelector(SPOTLIGHT_SELECTOR);
}

function gridButton() {
  return document.querySelector(GRID_SELECTOR);
}

function emphasisButton() {
  return document.querySelector(EMPHASIS_SELECTOR);
}

function settingsButton() {
  return document.querySelector(SETTINGS_LEFT_SELECTOR) || document.querySelector(SETTINGS_CENTER_SELECTOR);
}

// --- M3 step 3 (design/m3-window-ux.md §3-3): EC フッターの出し分け (別窓=表示 / メイン埋め込み=
// 非表示) --------------------------------------------------------------------------------------
//
// web 版 CallControl.ts (cinny/src/app/plugins/call/CallControl.ts の onBodyMutation()) と
// 完全に同じ DOM 辿り方でフッター (CallFooter.tsx が描画する grid コンテナ) を特定する:
// `leaveButton().parentElement.parentElement`。leaveButton = "incall_leave" ボタン (BUTTON) →
// .parentElement = CallFooter.module.css の .buttons (ボタン群のラッパ) →
// .parentElement.parentElement = .footer 自体。
function footerElement() {
  const leave = leaveButton();
  return leave && leave.parentElement ? leave.parentElement.parentElement : null;
}

// main から push される「今フッターを見せるべきか」(design §3-3: attached (メイン埋め込み)=false/
// hidden, detached (別窓)=true/visible)。既定は false -- 新規に作られる call view は
// createCallViewIfNeeded() が必ずまず mainWindow へ addChildView() する (常に attached から始まる)
// ため、この既定値は「push がまだ届いていない最初の一瞬」でも実際の attached 状態と食い違わない。
// フッター自体が実 DOM に現れるのは通話参加後しばらく経ってから (LiveKit 接続後) なので、
// localStorage 契約 (primeLocalStorageFromShell()) のような sendSync 版の pending 値取得は不要
// -- top-level で登録済みの ipcRenderer.on("native:set-footer-visible", ...) が確実にその出現より
// 先に (少なくとも同じくらい早く) 届く。
let footerVisible = false;

// 元実装: CallControl.ts の onBodyMutation() のフッター部分。hidden 時は web 版と同一の
// position:absolute + visibility:hidden (隠れている間はレイアウト上の場所を取らない)。visible 時は
// どちらのインライン override も外し、CallFooter.module.css の既定 (position:sticky、可視) に
// そのまま任せる -- 別窓では EC 自身の通常レイアウトで見えてほしいため、web 版のように無条件で
// position:absolute を強制することはしない (web 版はメイン埋め込み専用でフッターを見せる状態が
// 無いため、position:absolute を外す分岐自体が存在しない)。
function applyFooterVisibility() {
  const controls = footerElement();
  if (!controls) return;
  if (footerVisible) {
    controls.style.removeProperty("position");
    controls.style.removeProperty("visibility");
  } else {
    controls.style.setProperty("position", "absolute");
    controls.style.setProperty("visibility", "hidden");
  }
}

// CallControl.ts の onControlMutation() と同じ計算: screenshare は data-kind 属性、
// spotlight/emphasis は checked プロパティ (属性ではない) を直接読む。
function computeCallControlState() {
  const screenshareBtn = screenshareButton();
  const spotlightBtn = spotlightButton();
  const emphasisBtn = emphasisButton();
  const screenshare = screenshareBtn ? screenshareBtn.getAttribute("data-kind") === "primary" : false;
  const spotlight = spotlightBtn ? Boolean(spotlightBtn.checked) : false;
  // スポットライトモードに切り替わると emphasisButton が DOM から消えるため、その場合は false。
  const emphasis = spotlight ? false : emphasisBtn ? Boolean(emphasisBtn.checked) : false;
  return { screenshare, spotlight, emphasis };
}

// G4 (受け入れレビュー修正、対称化): setSoundOn/setSoundOff だけが他のカテゴリ B action と違い
// push の対象になっていなかった。CallControl.ts の setSound() 相当 (audio 要素の muted 反転) の
// 「実測」値を返す — handleSetSound() の呼び出し引数をそのまま echo するのではなく、実際に
// document 上の <audio> 要素群の muted プロパティを読み直す。複数 audio 要素がある場合は
// 「全て unmuted であって初めて聞こえる」という意味で AND を取る。<audio> が 1 つも無ければ
// (target_not_found で ok:false になる状況と同じ) undefined を返し、呼び出し側で sound
// フィールド自体を push に含めない。
function computeSoundState() {
  const audios = document.querySelectorAll("audio");
  if (audios.length === 0) return undefined;
  return Array.from(audios).every((el) => el.muted === false);
}

// M1 step 3b 実装要件 4: NativeCallControl.ts の onCallControlState 購読が「push による再同期」
// として受け取る形。kind:"call-control" で従来の toggleTarget 系 push (kind:"legacy-target") と
// 区別する (host 側はどちらも受け取り得るので、フィールドの有無で安全に無視できるようにしてある)。
// G4: sound フィールドを追加した (対称化) — computeSoundState() が undefined を返す場合
// (audio 要素が無い) は push に sound キー自体を含めない (nativeBridge.ts の duck typing と
// 同じ「フィールドが無ければ無視される」契約を preload 側でも踏襲する)。
function pushCallControlState(reason) {
  const computed = computeCallControlState();
  const sound = computeSoundState();
  const payload = {
    t: Date.now(),
    reason,
    kind: "call-control",
    screenshare: computed.screenshare,
    spotlight: computed.spotlight,
    emphasis: computed.emphasis,
  };
  if (typeof sound === "boolean") payload.sound = sound;
  ipcRenderer.send("native:call-control:state", payload);
}

// CallControl.ts の controlMutationObserver 相当の一般化版: 実在する対象ボタンの属性変化を
// 監視し、変化のたびに現在の call-control 状態を push する。
// M2 GPT レビュー P2 (CallControl 再マウント耐性) 対応: 直近 observeCallControls() で属性監視を
// 貼った実要素への参照。下の bodyMutationObserver のコールバックが「今の DOM から取り直した要素」と
// これを比較し、実際に参照が変わった (= React が古い要素を破棄し新しい要素を作り直した) ときだけ
// observeCallControls() を再実行する (controlElementsChanged() 参照)。invoke() 経由のクリックは
// screenshareButton() 等が呼び出しのたびに document.querySelector() し直すため、この参照が古くても
// クリック自体の到達には影響しない -- ここで守るのは「native invoke を経由しない自発的な状態変化
// (リモート起因の自動レイアウト切替等) を属性 MutationObserver で拾って push する」経路の方。
let observedControlElements = { screenshare: null, spotlight: null, emphasis: null };

let callControlMutationObserver = null;
function observeCallControls() {
  if (callControlMutationObserver) callControlMutationObserver.disconnect();
  callControlMutationObserver = new MutationObserver(() => pushCallControlState("mutation-observed"));

  const screenshareBtn = screenshareButton();
  observedControlElements.screenshare = screenshareBtn;
  if (screenshareBtn) {
    callControlMutationObserver.observe(screenshareBtn, { attributes: true, attributeFilter: ["data-kind"] });
  }
  const spotlightBtn = spotlightButton();
  observedControlElements.spotlight = spotlightBtn;
  if (spotlightBtn) {
    callControlMutationObserver.observe(spotlightBtn, { attributes: true });
  }
  // checked は attribute ではないため属性監視では変化を拾えないが、要素の出現/消失
  // (grid/spotlight 切り替え) はここで再評価される。実際の checked 変化は各 handler が
  // click 直後に明示 pushCallControlState() することでカバーする (CallControl.ts の
  // refreshEmphasisState() と同じ対策、design §2.2 注記)。
  const emphasisBtn = emphasisButton();
  observedControlElements.emphasis = emphasisBtn;
  if (emphasisBtn) {
    callControlMutationObserver.observe(emphasisBtn, { attributes: true });
  }
}

// 追跡中の 3 要素 (screenshare/spotlight/emphasis) のいずれかが、直近 observeCallControls() が
// 捕まえた参照と現在の DOM 上の実体とで食い違っているか (=作り直された/消えた/現れた) を返す。
// bodyMutationObserver のコールバックがここで「本当に対象が入れ替わったか」を先に確認してから
// observeCallControls() (disconnect + re-observe というやや重い処理) を呼ぶことで、コントロール
// バーとは無関係な childList mutation (配信中の参加者タイル増減等) では何もしないで済む。
function controlElementsChanged() {
  return (
    screenshareButton() !== observedControlElements.screenshare ||
    spotlightButton() !== observedControlElements.spotlight ||
    emphasisButton() !== observedControlElements.emphasis
  );
}

// CallControl.ts の bodyMutationObserver 相当: in-call コントロールバー自体の出現/消失
// (React マウント/アンマウント) を検知して observeCallControls() を再実行する。
//
// M2 GPT レビュー P2 (再マウント耐性、実バグ修正): 以前は { childList:true, subtree:false } で
// document.body の**直接の子要素**の増減だけを監視していた。この EC ビルド (React) は通常 body
// 直下のルートコンテナ自体を差し替えない -- 設定モーダル開閉・レイアウト切替・配信開始停止・
// ロビー⇔通話遷移などの「深い」再マウントは、body から数階層下がった場所で起きる childList
// mutation でしかなく、subtree:false ではそもそも検知対象外だった。結果として
// observeCallControls() が一度貼った属性 MutationObserver は、その後に対象要素が破棄され
// 新しい要素に差し替わっても再実行されないままになり (detach 済みの古い要素を監視し続けるだけ)、
// 「コントロールバー差し替えを取りこぼす」(このコミットのタスク記述どおり) 状態になっていた。
// 修正: subtree:true にして「call view (EC 埋め込み専用の隔離された WebContentsView、cinny 本体の
// チャット UI 等は含まれない) の DOM 内で起きるあらゆる階層の childList mutation」を検知対象に
// する。call view はコントロール UI 専用ページなので対象を広げても実害は限定的だが、それでも
// 配信中は参加者タイルの増減等で mutation 頻度が上がり得るため、コールバック内では
// controlElementsChanged() で「追跡中の 3 要素が実際に入れ替わったか」を先に確認し、変わって
// いなければ observeCallControls() の再実行自体をスキップする (過剰な MutationObserver の
// disconnect/re-observe によるパフォーマンス劣化を避けつつ、実際の差し替えは確実に拾う)。
let bodyMutationObserver = null;
function ensureBodyObserver() {
  if (bodyMutationObserver) return;
  if (!document.body) return;
  bodyMutationObserver = new MutationObserver(() => {
    // M3 step 3: フッター可視性は screenshare/spotlight/emphasis (controlElementsChanged() の
    // 追跡対象) とは独立に、body mutation のたびに無条件で再適用する -- フッター自身の DOM ノードが
    // 再マウント (differs from the 3 tracked control elements) で差し替わっても、直近の
    // footerVisible を確実に再適用するため (controlElementsChanged() のガードに相乗りすると、
    // 3 要素は変わらずフッターだけ差し替わったケースを取りこぼす)。
    applyFooterVisibility();
    if (controlElementsChanged()) observeCallControls();
  });
  bodyMutationObserver.observe(document.body, { childList: true, subtree: true });
  observeCallControls();
  applyFooterVisibility();
}

function clickAndReport(target, action) {
  if (!target) {
    return { ok: false, reason: "target_not_found", action };
  }
  target.click();
  return { ok: true, action };
}

// 元実装: CallControl.ts の toggleScreenshare()。
function handleToggleScreenshare() {
  const result = clickAndReport(screenshareButton(), "toggleScreenshare");
  if (result.ok) pushCallControlState("action-toggleScreenshare");
  return result;
}

// 元実装: CallControl.ts の toggleSpotlight() (spotlight 中なら grid ボタンを click)。
function handleToggleSpotlight() {
  const spotlightBtn = spotlightButton();
  const currentlySpotlight = Boolean(spotlightBtn && spotlightBtn.checked);
  const target = currentlySpotlight ? gridButton() : spotlightBtn;
  const result = clickAndReport(target, "toggleSpotlight");
  // checked はプロパティなので、click() 直後にここで明示的に再読取りして push する
  // (CallControl.ts の refreshEmphasisState() と同じ対策)。
  if (result.ok) pushCallControlState("action-toggleSpotlight");
  return result;
}

// 元実装: CallControl.ts の toggleEmphasis() (要素が無ければ no-op)。host 側
// (NativeCallControl.ts) が spotlight 中は呼ばない guard を持つが、preload 側でも
// 「要素が無ければ target_not_found」という形で自然に安全になる (spotlight 中は
// emphasisButton 自体が DOM から消える)。
function handleToggleEmphasis() {
  const result = clickAndReport(emphasisButton(), "toggleEmphasis");
  if (result.ok) pushCallControlState("action-toggleEmphasis");
  return result;
}

// 元実装: CallControl.ts の toggleReactions()。CallControlState に対応フィールドが無く、
// 元実装も emitStateUpdate() を呼ばないため、ここでも state push はしない。
function handleToggleReactions() {
  return clickAndReport(reactionsButton(), "toggleReactions");
}

// 元実装: CallControl.ts の toggleSettings()。toggleReactions 同様、state push なし。
function handleToggleSettings() {
  return clickAndReport(settingsButton(), "toggleSettings");
}

// 元実装: CallControl.ts の setSound() (iframe の contentDocument 内の <audio> 要素の
// muted を直接操作)。対象が 1 つも無い場合は target_not_found を返す (例外にしない)。
// G4 (受け入れレビュー修正、対称化): 成功時、他のカテゴリ B action と同様 pushCallControlState()
// を呼ぶ (以前は setSoundOn/setSoundOff だけ push が無かった)。
function handleSetSound(soundOn, action) {
  const audios = document.querySelectorAll("audio");
  if (audios.length === 0) {
    return { ok: false, reason: "target_not_found", action };
  }
  audios.forEach((el) => {
    // eslint-disable-next-line no-param-reassign
    el.muted = !soundOn;
  });
  pushCallControlState(`action-${action}`);
  return { ok: true, action, audioCount: audios.length };
}

// -------------------------------------------------------------------------------------------

function invoke(action) {
  switch (action) {
    // M1 step 2 の単体実証用 action (ErrorView.tsx の CloseWidgetButton)。step 3b でも
    // smoke 互換 (onCallControlState 配線確認の実経路) のためそのまま残してある — 実コントロール
    // 7 種とは独立したコードパス。
    case "toggleTarget": {
      const target = findTarget();
      if (!target) {
        return { ok: false, reason: "target_not_found", selector: TARGET_SELECTOR, action };
      }
      ensureClickListener(target);
      observe(target);
      const before = target.getAttribute("data-selfmatrix-pressed");
      target.click();
      state.invokeCount += 1;
      const after = target.getAttribute("data-selfmatrix-pressed");
      return {
        ok: true,
        action,
        selector: TARGET_SELECTOR,
        before,
        after,
        invokeCount: state.invokeCount,
      };
    }
    case "toggleScreenshare":
      ensureBodyObserver();
      return handleToggleScreenshare();
    case "toggleSpotlight":
      ensureBodyObserver();
      return handleToggleSpotlight();
    case "toggleEmphasis":
      ensureBodyObserver();
      return handleToggleEmphasis();
    case "toggleReactions":
      ensureBodyObserver();
      return handleToggleReactions();
    case "toggleSettings":
      ensureBodyObserver();
      return handleToggleSettings();
    case "setSoundOn":
      return handleSetSound(true, action);
    case "setSoundOff":
      return handleSetSound(false, action);
    default:
      return { ok: false, reason: "unknown_action", action };
  }
}

// M3 step 3 (design §3-3 実装要件「初期化タイミング」): フッター出し分けは通話開始直後 (最初の
// コントロールクリックより前) から要る。ensureBodyObserver() はこれまで toggleScreenshare 等の
// invoke() 初回呼び出し時にしか起動されておらず (上の switch 文の各 case 参照)、それだと「ユーザーが
// 最初に何かクリックするまでフッターが (本来隠れているべきなのに) 一瞬見えてしまう」ちらつきが
// 起き得る。DOMContentLoaded (Electron の dom-ready 相当 -- 初期 HTML パース完了直後、EC の
// React バンドルが実行され始める前後のタイミング) で確実に一度 ensureBodyObserver() を起動して
// おく。document が無い環境 (このファイルを Node 単体で require するテストハーネス等) では
// typeof チェックで安全に何もしない -- ファイル冒頭コメントの方針 (DOM グローバル参照は関数本体の
// 中に限定) を維持する。
(function scheduleEnsureBodyObserver() {
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureBodyObserver(), { once: true });
  } else {
    ensureBodyObserver();
  }
})();

// RPC: main.cjs の ipcMain.handle("native:call-control:invoke") が correlationId 付きで
// webContents.send してくるリクエストに応答する。main は action の意味を解釈しない中継役に
// 徹し (design/native-widget-transport.md §2.2)、実際の DOM 操作はすべてここで完結する。
ipcRenderer.on("native:call-control:invoke", (_event, request) => {
  const { correlationId, action } = request || {};
  let result;
  try {
    result = invoke(action);
  } catch (error) {
    result = {
      ok: false,
      reason: "exception",
      message: String(error && error.message ? error.message : error),
    };
  }
  ipcRenderer.send("native:call-control:invoke-result", { correlationId, result });
});
