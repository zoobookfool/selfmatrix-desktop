const logEl = document.getElementById("log");
const readyDot = document.getElementById("ready-dot");
const originEl = document.getElementById("origin");
const callStateEl = document.getElementById("call-state");
const bridgeStateEl = document.getElementById("bridge-state");

let bridgeMessageCount = 0;

function log(message, data) {
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  logEl.textContent = `${new Date().toLocaleTimeString()} ${message}${suffix}\n${logEl.textContent}`.slice(0, 6000);
}

async function refreshStatus() {
  const status = await window.selfmatrixNative.getStatus();
  originEl.textContent = `origin: ${status.origin}`;
  callStateEl.textContent = `call view: ${status.callViewState}`;
  bridgeStateEl.textContent = `bridge: ${bridgeMessageCount} messages`;
  readyDot.classList.toggle("ready", status.callViewState !== "none");
}

// M1 step 3b: 通話 View は shell-widget-host.js の boot() が起動時に自動で
// openCallView(completeUrl) を呼んでロード済みのはず。このボタンは手動での再オープン
// (同じ URL での reload) 用の手段として残す — window.selfmatrixNative.ensureCallView() は
// もう URL をロードしない「create-only」ガードに変わったため、これを直接呼んでも EC は
// ロードされない (新契約では URL 駆動の openCallView() 経由が必須)。
document.getElementById("ensure-call").addEventListener("click", async () => {
  log("open call view (openCallView)");
  await window.selfmatrixWidgetHost.openCall();
  await refreshStatus();
});

document.getElementById("detach-call").addEventListener("click", async () => {
  log("detach call view");
  await window.selfmatrixNative.detachCallView();
  await refreshStatus();
});

document.getElementById("attach-call").addEventListener("click", async () => {
  log("attach call view");
  await window.selfmatrixNative.attachCallView();
  await refreshStatus();
});

// M1 step 1 以降、toWidget のカスタム action はもう main 経由のスタブでは送らない。
// shell-widget-host.js が起動した本物の ClientWidgetApi の transport.send() を直接呼ぶ
// (本番の CallEmbed が call.transport.send() を呼ぶのと同じ経路。design §1.3)。
document.getElementById("join-call").addEventListener("click", async () => {
  log("send join");
  try {
    await window.selfmatrixWidgetHost.sendAction("io.element.join", { audioInput: null, videoInput: null });
  } catch (error) {
    log("join request did not resolve (expected without a live LiveKit backend)", { error: String(error) });
  }
});

document.getElementById("mute-call").addEventListener("click", async () => {
  log("send device mute request");
  try {
    await window.selfmatrixWidgetHost.sendAction("io.element.device_mute", {
      audio_enabled: true,
      video_enabled: false,
    });
  } catch (error) {
    log("device_mute request did not resolve", { error: String(error) });
  }
});

document.getElementById("hangup-call").addEventListener("click", async () => {
  log("send hangup");
  try {
    await window.selfmatrixWidgetHost.sendAction("im.vector.hangup", {});
  } catch (error) {
    log("hangup request did not resolve", { error: String(error) });
  }
});

// M1 step 2 (B 単体実証): call view preload (call-control-preload.cjs) の対象コントロールを
// RPC 経由でクリックする手動トリガー。詳細は call-control-preload.cjs 冒頭コメント参照。
// F7 (受け入れレビュー修正): callControlInvoke は claimWidgetTransport() の claim-once 対象へ
// 移設済みのため、常時公開の window.selfmatrixNative からは触れない。shell-widget-host.js が
// 公開する window.selfmatrixWidgetHost.callControlToggle() 経由で叩く (join-call 等の
// window.selfmatrixWidgetHost.sendAction() 呼び出しと同じ経路)。
document.getElementById("call-control-toggle").addEventListener("click", async () => {
  log("call control invoke: toggleTarget");
  try {
    const result = await window.selfmatrixWidgetHost.callControlToggle();
    log("call control result", result);
  } catch (error) {
    log("call control invoke failed", { error: String(error) });
  }
});

function attachWidgetHostLogging() {
  if (!window.selfmatrixWidgetHost) {
    setTimeout(attachWidgetHostLogging, 50);
    return;
  }
  window.selfmatrixWidgetHost.onMessage((direction, data) => {
    bridgeMessageCount += 1;
    log(`widget ${direction} ${data?.action || "?"}`, { response: Boolean(data?.response) });
    void refreshStatus();
  });
}

attachWidgetHostLogging();
void refreshStatus();
