// Electron 非依存の Matrix Widget API bridge 純関数群。
// main.cjs (Electron 依存) と test-harness/cli/widget-protocol.mjs (Node CLI) の両方から
// require される。electron モジュールへの依存や try/catch シムはここに置かない。

const WIDGET_ID = "selfmatrix-native-prototype-call";

// validateCallViewUrl() の widgetId allow-list (M1 step 3c-1 受け入れレビュー修正)。
// prototype 自身の合成 WIDGET_ID と、cinny CallEmbed が使う固定 widget id "call-embed" のみを
// 正当な値として扱う。新しい正当値が増えたらここに追加する (単一の正本)。
const KNOWN_WIDGET_IDS = Object.freeze([WIDGET_ID, "call-embed"]);

// EC dist へ渡す固定パラメータ群。main.cjs の ecUrl() と、shell 側の widget-config.json
// エンドポイント (shell-widget-host.js が本物の matrix-widget-api Widget を構築する際に使う) の
// 両方から参照される単一の正本。リテラルの重複を避けるためここに集約する。
const WIDGET_ROOM_ID = "!prototype:selfmatrix.test";
const WIDGET_USER_ID = "@prototype:selfmatrix.test";
const WIDGET_DEVICE_ID = "NATIVEPROTOTYPE";
const WIDGET_BASE_URL = "https://matrix.example.invalid";

function assertSameOrigin(callUrl, parentUrl) {
  const callOrigin = new URL(callUrl).origin;
  const parentOrigin = new URL(parentUrl).origin;
  if (callOrigin !== parentOrigin) {
    throw new Error(`Widget parentUrl origin must match call view origin: ${parentOrigin} !== ${callOrigin}`);
  }
}

// M1 step 3b: シェル静的サーバが EC dist を配信する既知の base path 群。
// `/ec/` は M0/M1 step 1-2 から使われてきた prototype 固有の path。`/public/element-call/` は
// step 3b で追加したエイリアス (design/native-widget-transport.md step 3b 実装要件 1/4) — cinny 本体
// (`CallEmbed.ts`/`NativeCallEmbed.ts`) は web 版と同じ `<origin>/public/element-call/index.html` を
// 無改造で組み立てるため、シェル側がこの path を EC dist へエイリアスする必要がある。
// openCallView() の URL 検証 (validateCallViewUrl) はこの両方を許可 prefix として扱う。
const EC_BASE_PATHS = ["/ec/", "/public/element-call/"];

// callOrigin / parentOrigin を別々に受け取れる純関数。production の ecUrl() は両方に
// 同じ origin (state.origin) を渡す薄い呼び出しになる。test-harness はここへ意図的に
// 異なる origin を渡し、assertSameOrigin が実際に呼ばれていることを検証する。
// M1 step 3b: ecPath/parentPath を差し替え可能にした (デフォルトは既存の "/ec/index.html" /
// "/desktop-shell.html" のまま、既存呼び出し元の挙動は不変)。cinny-shell モードの smoke は
// ecPath: "/public/element-call/index.html" (エイリアス route) / parentPath: "/cinny/" を渡して
// 「cinny が実際に組み立てる URL」形状を再現する。
function buildWidgetUrl({
  callOrigin,
  parentOrigin = callOrigin,
  widgetId,
  roomId,
  userId,
  deviceId,
  baseUrl,
  intent,
  preload,
  skipLobby,
  disableVideo,
  hideVideoButton,
  theme,
  ecPath = "/ec/index.html",
  parentPath = "/desktop-shell.html",
}) {
  const parentUrl = `${parentOrigin}${parentPath}`;
  const callUrl = `${callOrigin}${ecPath}`;
  assertSameOrigin(callUrl, parentUrl);
  const params = new URLSearchParams({
    widgetId,
    parentUrl,
    roomId,
    userId,
    deviceId,
    baseUrl,
    intent,
    preload: String(preload),
    skipLobby: String(skipLobby),
    disableVideo: String(disableVideo),
    hideVideoButton: String(hideVideoButton),
    theme,
  });
  return `${callUrl}?${params.toString()}`;
}

// M1 step 3b 実装要件 1: openCallView(completeWidgetUrl) の URL 検証。cinny レンダラ
// (相対的に低信頼) が組み立てた URL をシェルが無検証で loadURL しないための関門。
// 拒否理由は validateWidgetBridgeMessage 等と同じ形状 ({ok, reasons: [{code, message, ...}]}) に揃える。
function validateCallViewUrl(url, { expectedOrigin, basePaths = EC_BASE_PATHS } = {}) {
  if (typeof url !== "string" || url.length === 0) {
    return {
      ok: false,
      reasons: [{ code: "invalid_url", message: "Call view URL must be a non-empty string." }],
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      ok: false,
      reasons: [{ code: "invalid_url", message: `Call view URL failed to parse: ${String(error && error.message ? error.message : error)}` }],
    };
  }

  const reasons = [];

  if (expectedOrigin) {
    const expected = new URL(expectedOrigin).origin;
    if (parsed.origin !== expected) {
      reasons.push({
        code: "origin_mismatch",
        message: `Call view URL origin does not match the shell's own origin: ${parsed.origin} !== ${expected}`,
        expectedOrigin: expected,
        actualOrigin: parsed.origin,
      });
    }
  }

  const matchesKnownBase = basePaths.some((base) => parsed.pathname.startsWith(base));
  if (!matchesKnownBase) {
    reasons.push({
      code: "base_path_mismatch",
      message: `Call view URL path is not under a known EC dist base: ${parsed.pathname}`,
      basePaths,
      actualPathname: parsed.pathname,
    });
  }

  // M1 step 3c-1 受け入れレビュー修正 (allow-list) → C2 (GPT レビュー P1a + Fable レビュー #5 修正)
  // で必須化: main.cjs はこの URL の widgetId クエリを、その通話中の from-view/to-view メッセージの
  // 照合期待値 (state.activeWidgetId) として採用する。以前は widgetId が「有れば」allow-list と
  // 照合していたが、欠落自体は許容していた (widgetId なしの URL でも base_path/origin さえ合えば
  // 通っていた) — widgetId が無いまま通ると state.activeWidgetId が null 相当になり、以後の
  // fail-closed 照合 (NO_ACTIVE_CALL_REJECTION) と衝突する未定義動作の余地があった。ここで widgetId
  // 自体を必須にし、欠落は widget_id_missing として明示的に reject する。既知の値の allow-list
  // (widget_id_not_allowed) はそのまま維持: これが無いと「低信頼側が URL に書いた任意の値を、同じ
  // 低信頼側発メッセージの照合期待値に使う」という設計上のトートロジーになる。既知の値: prototype
  // 自身の WIDGET_ID と cinny CallEmbed の固定 widget id "call-embed"。
  const widgetIdParam = parsed.searchParams.get("widgetId");
  if (widgetIdParam === null || widgetIdParam === "") {
    reasons.push({
      code: "widget_id_missing",
      message: "Call view URL must include a non-empty widgetId query parameter.",
    });
  } else if (!KNOWN_WIDGET_IDS.includes(widgetIdParam)) {
    reasons.push({
      code: "widget_id_not_allowed",
      message: `Call view URL widgetId is not in the known allow-list: ${widgetIdParam}`,
      allowedWidgetIds: KNOWN_WIDGET_IDS,
      actualWidgetId: widgetIdParam,
    });
  }

  // C2 (GPT レビュー P1a 修正): 従来 parentUrl は matrix-widget-api 自身のクエリパラメータとして
  // URL に含まれるだけで、shell 側では一切検証していなかった。widget.getCompleteUrl() が組み立てる
  // このパラメータは呼び出し元 (cinny の CallEmbed.getWidget()/prototype の buildWidgetUrl()) が
  // 必ず設定する契約値であり、shell 自身の origin と一致するはずのもの — ここで欠落/別 origin を
  // 拒否することで「call view に低信頼な parentUrl を無検証で渡さない」を widgetId と同じ強さで
  // 保証する。
  const parentUrlParam = parsed.searchParams.get("parentUrl");
  if (parentUrlParam === null || parentUrlParam === "") {
    reasons.push({
      code: "parent_url_missing",
      message: "Call view URL must include a non-empty parentUrl query parameter.",
    });
  } else if (expectedOrigin) {
    let parentOrigin = null;
    try {
      parentOrigin = new URL(parentUrlParam).origin;
    } catch (error) {
      reasons.push({
        code: "parent_url_missing",
        message: `Call view URL parentUrl failed to parse: ${String(error && error.message ? error.message : error)}`,
      });
    }
    if (parentOrigin !== null) {
      const expected = new URL(expectedOrigin).origin;
      if (parentOrigin !== expected) {
        reasons.push({
          code: "parent_url_origin_mismatch",
          message: `Call view URL parentUrl origin does not match the shell's own origin: ${parentOrigin} !== ${expected}`,
          expectedOrigin: expected,
          actualOrigin: parentOrigin,
        });
      }
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, reasons: [] };
}

function createWidgetRequest(action, data, requestId) {
  return {
    api: "toWidget",
    widgetId: WIDGET_ID,
    requestId,
    action,
    data,
  };
}

function isWidgetApiMessage(data) {
  return (
    data &&
    typeof data === "object" &&
    (data.api === "fromWidget" || data.api === "toWidget") &&
    typeof data.requestId === "string" &&
    typeof data.widgetId === "string" &&
    typeof data.action === "string"
  );
}

// M1 step 1 以降、このスタブ応答はライブ経路 (main.cjs のルータ) からは呼ばれない。
// 実際の応答は shell 側の本物の ClientWidgetApi / CallWidgetDriver 相当
// (src/shell-widget-host.js の NativeWidgetDriver) が生成する
// (design/native-widget-transport.md §2.1)。この純関数は test-harness/cli/widget-protocol.mjs が
// widget-bridge-preload.cjs の応答折り返し配線 (request→response のラウンドトリップ形状) を単体で
// 検証するためだけに残してある。
function responseForWidgetRequest(request) {
  switch (request.action) {
    case "supported_api_versions":
      return { supported_versions: [] };
    case "content_loaded":
    case "io.element.device_mute":
    case "im.vector.hangup":
    case "org.matrix.msc2974.request_capabilities":
      return {};
    case "get_openid":
      return { state: "blocked" };
    default:
      return { error: { message: `Unknown widget action: ${request.action}` } };
  }
}

// 拒否理由は「先勝ち 1 件」ではなく、検出できたものを全部 reasons に積んで返す。
// 呼び出し側は ok===false のとき reasons (常に配列、最低 1 件) を見る。
function validateWidgetBridgeMessage(message, expected) {
  if (!message || typeof message !== "object") {
    return {
      ok: false,
      reasons: [{ code: "invalid_message", message: "Bridge message must be an object." }],
    };
  }

  const reasons = [];

  if (!isWidgetApiMessage(message.data)) {
    reasons.push({ code: "invalid_widget_api_message", message: "Message does not match Widget API shape." });
  }

  if (message.sourceIsSelf !== true) {
    reasons.push({
      code: "source_not_self",
      message: "Bridge message did not originate from the call view's own window (postMessage source mismatch).",
    });
  }

  if (expected.expectedWidgetId && message.data && message.data.widgetId !== expected.expectedWidgetId) {
    reasons.push({
      code: "widget_id_mismatch",
      message: `Unexpected widgetId: ${message.data.widgetId}`,
      expectedWidgetId: expected.expectedWidgetId,
      actualWidgetId: message.data.widgetId,
    });
  }

  if (expected.expectedOrigin && message.origin !== expected.expectedOrigin) {
    reasons.push({
      code: "origin_mismatch",
      message: `Unexpected widget origin: ${message.origin}`,
      expectedOrigin: expected.expectedOrigin,
      actualOrigin: message.origin,
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, reasons: [] };
}

// shell (信頼できるホスト自身の ClientWidgetApi) → callView 方向の形状検証。
// F2a: この方向は送信元が shell 自身の実装のため M0 由来の validateWidgetBridgeMessage
// (sourceIsSelf / origin チェック) は不要だが、widgetId と api 方向だけは最低限確認する。
// design/native-widget-transport.md の「残存リスク」節にある通り、prototype は cinny を同一
// オリジン iframe として埋め込むため、その子フレームが window.parent 経由で送信 API に触れる
// 余地がある (F2b の claim-once はこれを閉じる主対策、こちらは防御多重化の形状検証)。
// host は toWidget のリクエスト (capabilities ask, notify_capabilities, io.element.join 等) と、
// fromWidget リクエストへの応答 (api は "fromWidget" のまま .response が付く) の両方を送るため、
// api は "toWidget" / "fromWidget" のどちらも許容する。
//
// M1 step 3c-1: `expectedWidgetId` を引数化した (既定値は従来どおりの固定 WIDGET_ID なので、
// 引数を渡さない既存の呼び出し元 (test-harness/cli/widget-protocol.mjs) の挙動は変わらない)。
// 従来はここが常に prototype 固有の固定 WIDGET_ID とだけ比較していたが、これは
// prototype 自身が組み立てる合成 widget (buildLocalCallUrl()/widget-config.json、常に
// widgetId===WIDGET_ID) でしか成立しない前提だった。cinny 本体の実 NativeCallEmbed は
// 自分自身の widget (`CallEmbed.getWidget()` が生成する `widgetId: 'call-embed'`) を使うため、
// このチェックを固定値のままにすると実 cinny 経由の to-view メッセージが全て
// widget_id_mismatch で拒否され、ハンドシェイクそのものが成立しなくなる。呼び出し元
// (main.cjs) が `openCallView()` で検証済みの URL から実際の widgetId を読み取り、通話ごとに
// ここへ渡すことで、どちらの経路 (prototype 合成 widget / cinny 実 widget) でも正しく機能する。
function validateToViewMessage(message, expectedWidgetId = WIDGET_ID) {
  if (!message || typeof message !== "object") {
    return {
      ok: false,
      reasons: [{ code: "invalid_message", message: "To-view message must be an object." }],
    };
  }

  const reasons = [];

  if (message.widgetId !== expectedWidgetId) {
    reasons.push({
      code: "widget_id_mismatch",
      message: `Unexpected widgetId: ${message.widgetId}`,
      expectedWidgetId,
      actualWidgetId: message.widgetId,
    });
  }

  if (message.api !== "toWidget" && message.api !== "fromWidget") {
    reasons.push({
      code: "invalid_api_direction",
      message: `Unexpected api for a to-view message: ${message.api}`,
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, reasons: [] };
}

module.exports = {
  WIDGET_ID,
  KNOWN_WIDGET_IDS,
  WIDGET_ROOM_ID,
  WIDGET_USER_ID,
  WIDGET_DEVICE_ID,
  WIDGET_BASE_URL,
  EC_BASE_PATHS,
  assertSameOrigin,
  buildWidgetUrl,
  createWidgetRequest,
  isWidgetApiMessage,
  responseForWidgetRequest,
  validateWidgetBridgeMessage,
  validateToViewMessage,
  validateCallViewUrl,
};
