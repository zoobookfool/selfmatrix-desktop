/**
 * SelfMatrix M1 step 3c-2/3c-3 — native-join.e2e.mjs (step 3c-1) と
 * native-callflow.e2e.mjs (step 3c-2/3c-3) が共有するヘルパー群。
 *
 * どちらのスクリプトも「本物のローカル dev Matrix/LiveKit スタックが起動していること」を前提に
 * playwright-core の `_electron` API で prototype の Electron を実起動し、cinny の実ログイン画面
 * から Voice Lounge へ実際に join するところまでを自動操作する — この土台部分 (バックエンド疎通
 * 確認、playwright-core の借用解決、ログイン、初回起動モーダルの片付け、ルーム参加、
 * main プロセス内部状態の読み取り) は 2 人目 (bob) のユーザーでも一言一句同じなので、ここに集約して
 * 2 箇所での実装のズレを防ぐ。native-join.e2e.mjs 単体の動作 (`npm run e2e:join`) は不変。
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// This file lives at <repo>/e2e/lib/, so the repo root is two levels up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export const HOMESERVER = "https://synapse.m.localhost";
export const ROOM_NAME = "Voice Lounge";

export const JA_LOGIN_ERROR_PATTERN = /正しくありません|ログインに失敗しました|見つかりませんでした/;

export function makeLogger(tag) {
  function log(message) {
    console.log(`[${tag}] ${message}`);
  }
  function failFast(message) {
    console.error(`[${tag}] FAIL (precondition): ${message}`);
    process.exit(1);
  }
  return { log, failFast };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 0. 事前条件チェック -----------------------------------------------------------------

// Node の dns.lookup() (OS getaddrinfo 経由) はこの開発機では "*.m.localhost" のような多段
// サブドメインを解決できない (実測: ENOTFOUND -- curl はホスト名末尾 ".localhost" を DNS 問い合わせ
// 無しでループバックへ特別扱いする実装を持つため curl 単体では気付きにくい)。main.cjs 側は
// Chromium 向けに `--host-resolver-rules` で同じマッピングを強制しているのに合わせ、この
// 事前条件チェックでも同じ前提 (*.m.localhost -> 127.0.0.1) を明示する。
export function localhostAwareLookup(hostname, options, callback) {
  if (hostname.endsWith(".m.localhost") || hostname === "localhost") {
    // Node's net/tls "Happy Eyeballs" connect path calls custom lookup functions with
    // options.all=true and expects an array of {address, family} back -- a single
    // (address, family) tuple (the plain dns.lookup() shape) is only valid when options.all
    // is falsy. Support both shapes so this works regardless of Node's internal connect path.
    if (options && typeof options === "object" && options.all) {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      callback(null, "127.0.0.1", 4);
    }
    return;
  }
  require("node:dns").lookup(hostname, options, callback);
}

export function httpsGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, lookup: localhostAwareLookup }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

export async function checkBackendReachable({ log, failFast }) {
  let response;
  try {
    response = await httpsGetJson(`${HOMESERVER}/_matrix/client/versions`);
  } catch (error) {
    failFast(
      `dev Matrix backend is unreachable at ${HOMESERVER} (${error.message}). ` +
        "Start it first: in the element-call checkout, run `pnpm backend` (requires Docker), " +
        "then re-run this script. See README.md.",
    );
    return;
  }
  if (response.status !== 200) {
    failFast(
      `dev Matrix backend at ${HOMESERVER} responded with unexpected status ${response.status} ` +
        "for /_matrix/client/versions. Is the right docker compose stack running?",
    );
  }
  log(`backend reachable: ${HOMESERVER} (_matrix/client/versions -> ${response.status})`);
}

export function requireEnv(name, { failFast }) {
  const value = process.env[name];
  if (!value) {
    failFast(
      `${name} is required (the dev user's password). Never hardcode it — pass it as an ` +
        `environment variable, e.g. (PowerShell) $env:${name}="..."; npm run e2e:join`,
    );
  }
  return value;
}

// selfmatrix-desktop is developed alongside a sibling `../element-call` checkout (see README
// "開発手順"). The default is resolved relative to this repo's own location, not to any
// per-machine home directory layout (this repo is public).
export function resolveElementCallDir({ failFast }) {
  const dir = process.env.SELFMATRIX_ELEMENT_CALL_DIR || path.resolve(repoRoot, "..", "element-call");
  if (!fs.existsSync(dir)) {
    failFast(
      `element-call checkout not found at ${dir}. Clone it as a sibling of this repo ('../element-call'), ` +
        "or set SELFMATRIX_ELEMENT_CALL_DIR to override.",
    );
  }
  return dir;
}

// playwright-core is not a selfmatrix-desktop dependency (this repo only depends on
// `electron` directly). Rather than adding a second copy, we borrow the one already installed
// under element-call's pnpm store. The exact pnpm-hashed version directory name varies, so
// resolve it by glob rather than hardcoding a version.
export function resolvePlaywrightCore(elementCallDir, { failFast }) {
  const pnpmDir = path.join(elementCallDir, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) {
    failFast(`${pnpmDir} not found. Run \`pnpm install\` in the element-call checkout first.`);
  }
  const match = fs.readdirSync(pnpmDir).find((name) => name.startsWith("playwright-core@"));
  if (!match) {
    failFast(`No playwright-core@* directory found under ${pnpmDir}. Run \`pnpm install\` in element-call first.`);
  }
  const pwCoreDir = path.join(pnpmDir, match, "node_modules", "playwright-core");
  if (!fs.existsSync(path.join(pwCoreDir, "index.js"))) {
    failFast(`Resolved playwright-core at ${pwCoreDir} but its index.js is missing.`);
  }
  return pwCoreDir;
}

// ---- cinny UI 操作ヘルパー ---------------------------------------------------------------

export async function loginAsUser(page, username, password, { log }) {
  log(`waiting for cinny login form (user: ${username})...`);
  await page.locator('input[name="usernameInput"]').waitFor({ state: "visible", timeout: 30000 });
  await page.locator('input[name="usernameInput"]').fill(username);
  await page.locator('input[name="passwordInput"]').fill(password);
  log("submitting login form...");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const errorVisible = await page
      .getByText(JA_LOGIN_ERROR_PATTERN)
      .first()
      .isVisible()
      .catch(() => false);
    if (errorVisible) {
      const text = await page.getByText(JA_LOGIN_ERROR_PATTERN).first().innerText().catch(() => "(unknown)");
      throw new Error(`cinny reported a login error: ${text}`);
    }
    const stillOnLoginForm = (await page.locator('input[name="usernameInput"]').count()) > 0;
    if (!stillOnLoginForm) {
      log("login form is gone -- authenticated shell should be mounting.");
      return;
    }
    await wait(300);
  }
  throw new Error("timed out waiting for cinny to leave the login screen after submitting credentials");
}

export async function dismissBlockingModals(page, { log }) {
  const firstRunSetup = page.locator('[data-testid="first_run_setup"]');
  const firstRunSeen = await firstRunSetup
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (firstRunSeen) {
    log('FirstRunSetup modal detected -- picking "Discord style" and dismissing.');
    await page.locator('[data-testid="fr_discord_style"]').click();
    await firstRunSetup.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  } else {
    log("FirstRunSetup modal did not appear within timeout (already dismissed previously, or skipped).");
  }

  const laterButton = page.getByRole("button", { name: "後で", exact: true });
  const laterSeen = await laterButton
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (laterSeen) {
    log('VerificationReminder modal detected -- clicking "後で" (Later).');
    await laterButton.click();
  } else {
    log("VerificationReminder modal did not appear within timeout (already dismissed previously, or skipped).");
  }
}

// Voice Lounge を (既存なら再利用、無ければ作成して) 開き、cinny 自身のプリスクリーンで
// 「参加」を押すところまで進める。戻り値の `clickedJoin` が false の場合、EC 側の実 join は
// 検証できていない (evidence に理由を残し、後続の pass 条件はすべて false になる)。
//
// 注意 (native-callflow.e2e.mjs の runCallRespawn() で実機確認): このヘルパーは「別画面から
// room を開いて初めて join する」ケース向けで、サイドバーの room 項目を毎回クリックしてから
// join ボタンを探す。**既にその room を表示したまま**の状態 (例: 通話跨ぎで hangup 直後、
// 同じ room の prescreen に戻ったところ) でこれを再利用すると、サイドバー再クリックのたびに
// join ボタンが (画面奥の canJoin 再計算待ちと見られる理由で) 一時的に disabled へ戻り続け、
// クリックが安定しないことがあった -- そのケースでは本ヘルパーを使わず、join ボタンだけを
// 直接待ってクリックすること (runCallRespawn() 参照)。
export async function openVoiceLoungeAndJoin(page, { log }, roomName = ROOM_NAME) {
  // 既存部屋の検出は寛容に待つ (60s): 2 個目の Electron インスタンス (bob) はログイン直後に
  // ここへ来るうえ、alice のインスタンス + 実通話が CPU を消費している中で初回同期 +
  // rust-crypto 初期化 + サイドバー描画をするため、単独なら ~18s で見える部屋が競合下では
  // 30s を超えることがある (実測)。dev ユーザー (alice/bob) はどちらも Voice Lounge の正規
  // メンバーなので部屋は必ず存在する — 短いタイムアウトで諦めて作成フォールバックに落ちると、
  // 実際にはメンバーなのに壊れた作成 UI を踏んで失敗する。visible になれば即 return するので
  // 余分な待ちは発生しない。
  const existingRoom = page.getByText(roomName, { exact: true }).first();
  const alreadyExists = await existingRoom
    .waitFor({ state: "visible", timeout: 60000 })
    .then(() => true)
    .catch(() => false);

  let created = false;
  if (alreadyExists) {
    log(`existing "${roomName}" room found in the sidebar -- opening it.`);
    await existingRoom.click();
  } else {
    log(`no existing "${roomName}" room -- creating one.`);
    await page.getByRole("button", { name: "チャンネルを作成", exact: true }).click();
    await page
      .locator('button[aria-pressed]')
      .filter({ hasText: "ボイスルーム" })
      .first()
      .click();
    await page.locator('input[name="nameInput"]').fill(roomName);
    await page.getByRole("button", { name: "作成", exact: true }).click();
    created = true;
  }

  const joinButton = page.getByRole("button", { name: "参加", exact: true });
  const joinButtonSeen = await joinButton
    .waitFor({ state: "visible", timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  if (!joinButtonSeen) {
    return { created, clickedJoin: false, reason: "prescreen_join_button_not_found" };
  }
  log('clicking cinny\'s own "参加" (Join) button -- this constructs NativeCallEmbed.');
  await joinButton.click();
  return { created, clickedJoin: true, reason: null };
}

// ---- M2 画面共有ソース選択 UI (ネイティブピッカー) を Playwright で駆動するヘルパー ----------------
//
// main.cjs の registerDisplayMediaHandler() は M2 でネイティブピッカー方式に変わった。E2E は
// (自動バイパスせず) 実際にピッカーウィンドウを掴んで操作する -- native-callflow.e2e.mjs の
// 旧「"SelfMatrix" を含む自 window を無言で自動選択する」ヒューリスティックと同じ実質効果を、
// 実ピッカー UI 経由で再現する (content-adaptive エンコーダに継続的な差分ソースを与えるため)。
//
// ピッカーは source-picker.html + source-picker-preload.cjs (cinny 用の window.selfmatrixNative
// とは完全に別系統) が実装する別の BrowserWindow で、以下のセレクタを持つ (main.cjs の
// createSourcePickerWindow()/source-picker.html 参照):
//   - タブ: #picker-tab-screen / #picker-tab-window
//   - タイル: .picker-tile[data-source-id][data-source-name][data-source-type]
//   - システム音声チェックボックス: #picker-system-audio (audioAvailable のときだけ表示される)
//   - ボタン: #picker-share / #picker-cancel

export async function waitForSourcePickerWindow(electronApp, { log }, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of electronApp.windows()) {
      let url = "";
      try {
        url = page.url();
      } catch {
        continue;
      }
      if (url.includes("source-picker.html")) return page;
    }
    await wait(250);
  }
  log("waitForSourcePickerWindow: timed out waiting for the native source picker window to open.");
  return null;
}

// ピッカーウィンドウを見つけ、`sourceNameContains` を名前に含むタイルを選択し (無ければ
// ウィンドウ/画面タブを切り替えて再探索する)、`includeSystemAudio` が真ならシステム音声
// チェックボックスを ON にしてから「共有」を押す。戻り値は診断用の実測フィールド一式。
export async function driveSourcePicker(
  electronApp,
  { log },
  { sourceNameContains = "SelfMatrix", includeSystemAudio = true, timeoutMs = 15000 } = {},
) {
  const page = await waitForSourcePickerWindow(electronApp, { log }, timeoutMs);
  if (!page) {
    return { opened: false, reason: "picker_window_not_found" };
  }
  log("source picker window opened -- driving it via Playwright.");

  const tilesSeen = await page
    .locator("[data-picker-tile]")
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!tilesSeen) {
    return { opened: true, tilesSeen: false, sourceCount: 0, tileFound: false, reason: "no_tiles_rendered" };
  }

  const sourceCount = await page.locator("[data-picker-tile]").count();

  const findTile = () => page.locator(`[data-picker-tile][data-source-name*="${sourceNameContains}"]`).first();
  let tile = findTile();
  let tileFound = (await tile.count()) > 0;
  if (!tileFound) {
    // 既定タブに対象が無ければ、もう一方のタブへ切り替えて再探索する (alice 自身の window は
    // "window" タイプのソースであり、既定タブが "screen" のときはここに来る)。
    await page.locator("#picker-tab-window").click().catch(() => {});
    tile = findTile();
    tileFound = await tile
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!tileFound) {
    return { opened: true, tilesSeen, sourceCount, tileFound: false, reason: "target_source_not_found" };
  }

  await tile.click();

  const systemAudioCheckbox = page.locator("#picker-system-audio");
  const systemAudioAvailable = await systemAudioCheckbox.isVisible().catch(() => false);
  let systemAudioChecked = false;
  if (systemAudioAvailable && includeSystemAudio) {
    await systemAudioCheckbox.check().catch(() => {});
    systemAudioChecked = await systemAudioCheckbox.isChecked().catch(() => false);
  }

  const shareEnabled = await page
    .locator("#picker-share")
    .isEnabled()
    .catch(() => false);
  await page.locator("#picker-share").click();

  return {
    opened: true,
    tilesSeen,
    sourceCount,
    tileFound: true,
    shareEnabled,
    systemAudioAvailable,
    systemAudioChecked,
    shared: true,
  };
}

// ---- main プロセス側の状態を electronApp.evaluate() 経由で覗くヘルパー ------------------------

export async function getMainProcessSnapshot(electronApp) {
  return electronApp.evaluate(() => {
    if (!global.__selfmatrixE2E) return null;
    return global.__selfmatrixE2E.getSnapshot();
  });
}

export async function evalInCallView(electronApp, code) {
  return electronApp.evaluate(
    (_electron, jsCode) => {
      if (!global.__selfmatrixE2E) return { ok: false, reason: "no_e2e_bridge" };
      return global.__selfmatrixE2E.evalInCallView(jsCode);
    },
    code,
  );
}

export function fromViewJoinObserved(snapshot) {
  if (!snapshot) return false;
  return snapshot.widgetMessages.some(
    (message) =>
      message.direction === "from-view" &&
      message.type !== "widget-message-rejected" &&
      message.data &&
      message.data.api === "fromWidget" &&
      message.data.action === "io.element.join",
  );
}

export function bridgeDetectedFromSnapshot(snapshot) {
  if (!snapshot) return false;
  const rejected = snapshot.widgetMessages.some((message) => message.type === "call-view-url-rejected");
  return snapshot.callViewState === "attached" && !rejected;
}

export async function waitForCondition(label, checkFn, timeoutMs, { log }, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await checkFn();
    if (last.ok) {
      log(`${label}: OK.`);
      return last;
    }
    await wait(intervalMs);
  }
  log(`${label}: NOT observed within ${timeoutMs}ms.`);
  return last ?? { ok: false };
}

export function sanitizeOrigin(str, origin) {
  if (typeof str !== "string" || !origin) return str;
  const replacement = origin.replace(/:\d+$/, ":<local-port>");
  return str
    .replaceAll(origin, replacement)
    .replaceAll(encodeURIComponent(origin), encodeURIComponent(replacement));
}

// widgetMessages には MatrixRTC の get_openid 応答 (LiveKit JWT 発行用の短命 (1h) OpenID
// bearer token) がそのまま含まれる。パスワードでも長期クレデンシャルでもないが、念のため
// 証跡には残さない (defense in depth)。
export const REDACT_KEYS = new Set(["access_token"]);

export function deepSanitize(value, origin, key) {
  if (typeof value === "string") {
    if (key && REDACT_KEYS.has(key)) return "<redacted>";
    return sanitizeOrigin(value, origin);
  }
  if (Array.isArray(value)) return value.map((item) => deepSanitize(item, origin));
  if (value && typeof value === "object") {
    const out = {};
    for (const [nestedKey, nested] of Object.entries(value)) out[nestedKey] = deepSanitize(nested, origin, nestedKey);
    return out;
  }
  return value;
}

// 実行のたびに新規の userData ディレクトリを使う: cinny の Matrix セッションは IndexedDB に
// 永続化されるため、既定の userData を使い回すと 2 回目以降の実行でログイン画面を経由せず
// 自動的にセッション復元されてしまい、「実ログイン」を検証できなくなる。
export function freshUserDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// prototype の Electron を playwright-core の _electron API で実起動する共通ヘルパー。
export async function launchNativePrototype({ nativePrototypeDir, elementCallDir, extraArgs = [], env = {} }) {
  const pwCoreDir = resolvePlaywrightCore(elementCallDir, makeLogger("native-e2e-lib"));
  const pw = require(pwCoreDir);
  const electronPath = require("electron"); // this repo's own devDependency
  const userDataDir = freshUserDataDir("selfmatrix-e2e-userdata-");
  const electronApp = await pw._electron.launch({
    executablePath: electronPath,
    cwd: nativePrototypeDir,
    args: ["src/main.cjs", "--cinny-shell", "--e2e-real-join", `--user-data-dir=${userDataDir}`, ...extraArgs],
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { electronApp, userDataDir };
}
