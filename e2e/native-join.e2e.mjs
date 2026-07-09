#!/usr/bin/env node
/**
 * SelfMatrix M1 step 3c-1 — ネイティブシェルからの実ログイン → 実 LiveKit join E2E。
 *
 * `npm run cinny-shell`(-smoke) までの M1 step 3b は「バックエンド無し」を前提に、cinny の実
 * ログイン画面より先に進めないため widget-api ハンドシェイクを main プロセスから代わりに
 * シミュレートしていた (main.cjs の runCinnyShellSmoke() 冒頭コメント参照)。このスクリプトは
 * 逆に「本物のバックエンド (ローカル dev Matrix/LiveKit スタック) が動いていること」を前提とし、
 * playwright-core の `_electron` API で prototype の Electron を実起動し、
 *   1. cinny のログイン画面で alice として実ログイン
 *   2. 初回起動時のモーダル (FirstRunSetup/VerificationReminder) を閉じる
 *   3. 「Voice Lounge」ボイスルームを (無ければ作成して) 開き、cinny 自身の「参加」ボタンを押す
 *   4. cinny の NativeCallEmbed 経路 (window.selfmatrixNative) 経由で実 Element Call が
 *      call view にロードされ、実 LiveKit SFU に接続することを、main プロセスの内部状態と
 *      call view の DOM/RTCPeerConnection を計装して実測する
 * ところまでを実際に動かして検証する。
 *
 * **前提 (すべて手動/事前に用意しておくこと。npm test には組み込まない理由もここ)**:
 *   - ローカル dev Matrix/LiveKit スタックが起動していること
 *     (`element-call` ディレクトリで `pnpm backend`、Docker が必要)。
 *   - dev ユーザー alice のパスワードを環境変数 `SELFMATRIX_E2E_PASSWORD_ALICE` に設定して
 *     渡すこと。**このスクリプト・証跡・ログにパスワードを平文で書き込むことは絶対にない** —
 *     env 経由でのみ受け取り、Playwright へは `page.fill()` の引数として一度だけ渡す。
 *   - `element-call` ディレクトリで `pnpm install` 済みであること (playwright-core を
 *     glob 解決で借用するため)。
 *
 * 実行手順の詳細は README.md の「E2E: 実ログイン→実 LiveKit join
 * (M1 step 3c-1)」節を参照。
 *
 * **dev/E2E 専用**: Electron 起動引数に `--e2e-real-join` を渡す。main.cjs 側はこのフラグ
 * (isE2ERealJoin) を見て初めて `--ignore-certificate-errors` / `--auto-accept-camera-and-microphone-capture`
 * (getUserMedia の camera/mic 許可のみを自動承認する。M2 レビューで `--use-fake-ui-for-media-stream`
 * が getDisplayMedia() の選択 UI まで丸ごと横取りして画面共有ソースピッカーを迂回してしまうことが
 * 判明したため、より狭いスコープのこのフラグへ差し替えた) / `--use-fake-device-for-media-stream` を
 * appendSwitch する (main.cjs 冒頭のコメント参照) — 実オーディオデバイスは絶対に使わない。
 *
 * M1 step 3c-2/3c-3 (native-callflow.e2e.mjs 実装時のリファクタ): ログイン/モーダル片付け/
 * ルーム参加/main プロセス内部状態の読み取り/サニタイズといった共通ロジックは
 * `e2e/lib/nativeE2ELib.mjs` に切り出した (bob 用の 2 個目の Electron インスタンスでも
 * 一言一句同じ手順が要るため)。このファイル自身の外部動作 (`npm run e2e:join` の
 * 手順・pass 条件・evidence ファイルの形) は変えていない。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import {
  checkBackendReachable,
  deepSanitize,
  dismissBlockingModals,
  evalInCallView,
  fromViewJoinObserved,
  bridgeDetectedFromSnapshot,
  getMainProcessSnapshot,
  loginAsUser,
  makeLogger,
  openVoiceLoungeAndJoin,
  requireEnv,
  resolveElementCallDir,
  resolvePlaywrightCore,
  ROOM_NAME,
  wait,
  waitForCondition,
} from "./lib/nativeE2ELib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativePrototypeDir = path.resolve(__dirname, "..");
const evidenceDir = path.join(nativePrototypeDir, "evidence");

const { log, failFast } = makeLogger("native-join-e2e");

async function main() {
  await checkBackendReachable({ log, failFast });
  const alicePassword = requireEnv("SELFMATRIX_E2E_PASSWORD_ALICE", { failFast });
  const elementCallDir = resolveElementCallDir({ failFast });
  const pwCoreDir = resolvePlaywrightCore(elementCallDir, { failFast });

  log(`resolved playwright-core from element-call's pnpm store (borrowed, not a project dependency).`);

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pw = require(pwCoreDir);
  const electronPath = require("electron"); // this repo's own devDependency
  const os = require("node:os");

  const freshUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfmatrix-e2e-userdata-"));

  const result = {
    startedAt: new Date().toISOString(),
    pass: false,
    room: ROOM_NAME,
    steps: {},
    passConditions: {},
    error: null,
  };

  let electronApp = null;
  let screenshotTaken = false;
  let capturedOrigin = null;

  try {
    log("launching Electron (--cinny-shell --e2e-real-join)...");
    electronApp = await pw._electron.launch({
      executablePath: electronPath,
      cwd: nativePrototypeDir,
      args: ["src/main.cjs", "--cinny-shell", "--e2e-real-join", `--user-data-dir=${freshUserDataDir}`],
      env: { ...process.env },
      timeout: 30000,
    });

    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(20000);

    await loginAsUser(page, "alice", alicePassword, { log });
    result.steps.login = { ok: true };

    await dismissBlockingModals(page, { log });
    result.steps.modalsDismissed = { ok: true };

    const joinOutcome = await openVoiceLoungeAndJoin(page, { log });
    result.steps.openVoiceLoungeAndJoin = joinOutcome;
    if (!joinOutcome.clickedJoin) {
      throw new Error(`could not click cinny's own prescreen Join button (${joinOutcome.reason})`);
    }

    // 1. bridgeDetected: NativeCallEmbed が openCallView() を呼び、URL 検証を通過して
    //    call view がロードされたこと。
    const bridgeDetected = await waitForCondition(
      "bridgeDetected",
      async () => {
        const snapshot = await getMainProcessSnapshot(electronApp);
        return { ok: bridgeDetectedFromSnapshot(snapshot), snapshot };
      },
      15000,
      { log },
    );
    result.passConditions.bridgeDetected = bridgeDetected.ok;

    // 2. realJoinObserved: EC (widget) から io.element.join (fromWidget) が実際に main へ届いた。
    const realJoinObserved = await waitForCondition(
      "realJoinObserved",
      async () => {
        const snapshot = await getMainProcessSnapshot(electronApp);
        return { ok: fromViewJoinObserved(snapshot), snapshot };
      },
      25000,
      { log },
    );
    result.passConditions.realJoinObserved = realJoinObserved.ok;

    // 3. inCallUi: EC の DOM に in-call マーカーが出現。
    const inCallUi = await waitForCondition(
      "inCallUi",
      async () => {
        const evalResult = await evalInCallView(
          electronApp,
          `document.querySelector('[data-testid="incall_leave"]') !== null`,
        );
        return { ok: Boolean(evalResult && evalResult.ok && evalResult.value === true), evalResult };
      },
      30000,
      { log },
    );
    result.passConditions.inCallUi = inCallUi.ok;

    // 4. livekitConnected: 注入した RTCPeerConnection ラッパで、少なくとも 1 接続が
    //    connected/completed に到達した。
    const livekitConnected = await waitForCondition(
      "livekitConnected",
      async () => {
        const evalResult = await evalInCallView(
          electronApp,
          `(window.__selfmatrixPcs || []).map((r) => ({
            id: r.id,
            connectionState: r.connectionState,
            iceConnectionState: r.iceConnectionState,
            reachedConnected: r.reachedConnected,
          }))`,
        );
        const pcs = evalResult && evalResult.ok && Array.isArray(evalResult.value) ? evalResult.value : [];
        return { ok: pcs.some((pc) => pc.reachedConnected), pcs, evalResult };
      },
      30000,
      { log },
    );
    result.passConditions.livekitConnected = livekitConnected.ok;
    result.peerConnections = livekitConnected.pcs ?? [];

    const finalSnapshot = await getMainProcessSnapshot(electronApp);
    capturedOrigin = finalSnapshot?.origin ?? null;
    result.finalSnapshot = {
      callViewState: finalSnapshot?.callViewState ?? null,
      activeWidgetId: finalSnapshot?.activeWidgetId ?? null,
      widgetMessageCount: finalSnapshot?.widgetMessages?.length ?? 0,
      preloadErrorCount: finalSnapshot?.preloadErrors?.length ?? 0,
      // 直近の widgetMessages だけを証跡に残す (SDP/ICE 等の実メディア信号は widget-api を
      // 経由しない -- LiveKit との直接シグナリングであり、ここには載らない)。
      recentWidgetMessages: (finalSnapshot?.widgetMessages ?? []).slice(-30),
    };

    result.pass =
      result.passConditions.bridgeDetected &&
      result.passConditions.realJoinObserved &&
      result.passConditions.inCallUi &&
      result.passConditions.livekitConnected;

    // 5. 証跡スクリーンショット。2 枚撮る:
    //    (a) mainWindow (cinny) 自身 -- BrowserWindow.capturePage() は実測したところ
    //        addChildView() された call view (別 WebContentsView) を合成してくれない
    //        (cinny 自身の Discord 風通話コントロールバー等しか写らない) が、それでも
    //        「実際にボイスルームへ通話中の状態で入っている」cinny 側の見た目の証跡にはなる。
    //    (b) call view (EC) 自身 -- captureCallViewPng() で個別にキャプチャし、EC の実際の
    //        in-call UI (マイクトグル、退出ボタン等) を写す。
    try {
      const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
        const [win] = BrowserWindow.getAllWindows();
        if (!win) return null;
        const image = await win.capturePage();
        return image.toPNG().toString("base64");
      });
      if (pngBase64) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, "native-join.png"), Buffer.from(pngBase64, "base64"));
        screenshotTaken = true;
      }
    } catch (error) {
      result.screenshotError = String(error && error.message ? error.message : error);
    }
    try {
      const callViewCapture = await electronApp.evaluate(() => {
        if (!global.__selfmatrixE2E) return { ok: false, reason: "no_e2e_bridge" };
        return global.__selfmatrixE2E.captureCallViewPng();
      });
      if (callViewCapture && callViewCapture.ok) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceDir, "native-join-callview.png"),
          Buffer.from(callViewCapture.base64, "base64"),
        );
        result.callViewScreenshotTaken = true;
      } else {
        result.callViewScreenshotTaken = false;
        result.callViewScreenshotError = callViewCapture?.reason ?? "unknown";
      }
    } catch (error) {
      result.callViewScreenshotError = String(error && error.message ? error.message : error);
    }
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    log(`ERROR: ${result.error}`);
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
    fs.rmSync(freshUserDataDir, { recursive: true, force: true });
  }

  result.screenshotTaken = screenshotTaken;
  result.finishedAt = new Date().toISOString();

  // サニタイズ: origin (ローカルポート) を <local-port> に置き換える。パスワードは元々どこにも
  // 入れていない (`alicePassword` は page.fill() の引数として一度使うだけで、result オブジェクトの
  // どのフィールドにも代入していない)。個人絶対パス (electronPath/pwCoreDir/nativePrototypeDir 等)
  // も result には積んでいない。capturedOrigin は electronApp を close() する前に取得済みの値を
  // 使う (close 後に electronApp.evaluate() を呼ぶと失敗するため)。
  const sanitized = capturedOrigin ? deepSanitize(result, capturedOrigin) : result;

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "native-join-result.json"), `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");

  log(`pass=${result.pass} -- evidence written to ${path.relative(process.cwd(), evidenceDir)}`);
  log(`passConditions: ${JSON.stringify(result.passConditions)}`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  console.error("[native-join-e2e] unhandled error:", error);
  process.exit(1);
});
