#!/usr/bin/env node
// M2 minisign 署名検証: update-signature-verify.cjs (electron-updater の verifyUpdateCodeSignature
// フック雛形) の単体検証 probe。plain node 上で完結する (fs/crypto のみ、Electron 非依存)。
//
// RELEASE_PUBLIC_KEY (モジュール内の既定プレースホルダ定数) に対応する秘密鍵は誰も持っていない
// ため、既定のまま "正当な署名 -> null" を確かめることはできない (これはフェイルクローズとして
// 意図した挙動)。そのため createVerifyUpdateCodeSignature(publicKeyText) ファクトリへ、この probe
// が使い捨てで生成した Ed25519 テスト鍵を注入し、同一のロジック (実運用と全く同じコードパス) を
// テスト鍵で end-to-end 検証する。秘密鍵はプロセス内で生成され、どこにも書き出さない
// (「テスト鍵の秘密鍵をコミットしない」絶対条件を満たす — ソース上に鍵材料が literal で
// 残らない)。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createVerifyUpdateCodeSignature, RELEASE_PUBLIC_KEY } = require("./update-signature-verify.cjs");
const { verifyMinisign } = require("./minisign-verify.cjs");
const { blake2b512 } = require("./minisign-blake2b.cjs");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");

const cases = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  cases.push({ name, pass, expected, actual });
  if (!pass) console.error(`[update-signature-verify-probe] FAIL ${name}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  return pass;
}

// ---- 使い捨てテスト鍵 + テストベクタのエンコード (minisign-verify-probe.cjs と同じ手順を再掲。
// モジュール間で二重実装になるが、probe 同士でロジックを共有すると "検証ロジックのバグを
// テストコード側のバグで隠す" リスクがあるため、意図して独立に書いている) ----
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfmatrix-minisign-probe-"));
const installerPath = path.join(tmpDir, "SelfMatrix-Setup-0.1.0-test.exe");
const sigPath = `${installerPath}.minisig`;

try {
  const testKey = crypto.generateKeyPairSync("ed25519");
  const otherKey = crypto.generateKeyPairSync("ed25519");
  const keyId = crypto.randomBytes(8);
  const otherKeyId = crypto.randomBytes(8);

  const installerBytes = crypto.randomBytes(65536); // 実 installer に見立てたダミーバイナリ
  fs.writeFileSync(installerPath, installerBytes);

  const testPublicKeyText = encodePublicKeyFile({
    comment: "update-signature-verify-probe test key",
    keyId,
    publicKeyObject: testKey.publicKey,
  });
  const otherPublicKeyText = encodePublicKeyFile({
    comment: "update-signature-verify-probe wrong key",
    keyId: otherKeyId,
    publicKeyObject: otherKey.publicKey,
  });

  const validSigText = encodeSignatureFile({
    comment: "test signature",
    keyId,
    algBytes: "ED", // prehashed = 現行 minisign 既定
    fileBytes: installerBytes,
    trustedComment: "timestamp:1735689600\tfile:SelfMatrix-Setup-0.1.0-test.exe",
    privateKey: testKey.privateKey,
  });

  const verifyWithTestKey = createVerifyUpdateCodeSignature(testPublicKeyText);
  const verifyWithOtherKey = createVerifyUpdateCodeSignature(otherPublicKeyText);

  // sanity: 独立に minisign-verify.cjs 単体でも valid と分かっているベクタであることを確認
  // (このテストの土台が壊れていないことの前提チェック)。
  check("sanity_valid_vector_verifies_standalone", verifyMinisign({ fileBytes: installerBytes, sigText: validSigText, publicKeyText: testPublicKeyText }).ok, true);

  (async () => {
    // 1. 正当な installer + .minisig -> null (electron-updater 契約: null = 成功、適用へ進む)
    fs.writeFileSync(sigPath, validSigText, "utf8");
    const resultValid = await verifyWithTestKey(["SelfMatrix"], installerPath);
    check("valid_installer_returns_null", resultValid, null);

    // 2. installer が改ざんされている (署名時と中身が変わった) -> エラー文字列 (適用中止)
    fs.writeFileSync(installerPath, crypto.randomBytes(65536)); // 中身を丸ごと差し替え
    const resultTampered = await verifyWithTestKey(["SelfMatrix"], installerPath);
    check("tampered_installer_returns_error_string", typeof resultTampered === "string" && resultTampered.length > 0, true);
    // 改ざん後も installer を元に戻す (以降のケースのため)。
    fs.writeFileSync(installerPath, installerBytes);

    // 3. .minisig が存在しない -> エラー文字列 (適用中止、例外にはならない)
    fs.rmSync(sigPath, { force: true });
    const resultMissingSig = await verifyWithTestKey(["SelfMatrix"], installerPath);
    check("missing_signature_file_returns_error_string", typeof resultMissingSig === "string" && resultMissingSig.includes("not found"), true);
    fs.writeFileSync(sigPath, validSigText, "utf8"); // 復元

    // 4. 別の鍵で作った検証関数 (= 埋め込み公開鍵が違う) -> エラー文字列
    const resultWrongKey = await verifyWithOtherKey(["SelfMatrix"], installerPath);
    check("wrong_embedded_public_key_returns_error_string", typeof resultWrongKey === "string" && resultWrongKey.length > 0, true);

    // 5. installer が存在しない -> エラー文字列 (例外にならない)
    const resultMissingInstaller = await verifyWithTestKey(["SelfMatrix"], path.join(tmpDir, "does-not-exist.exe"));
    check("missing_installer_returns_error_string", typeof resultMissingInstaller === "string" && resultMissingInstaller.includes("not found"), true);

    // 6. デフォルトエクスポート (RELEASE_PUBLIC_KEY を使う既定インスタンス) はプレースホルダのため
    //    誰も対応する秘密鍵を持っておらず、正当な署名を用意できない = 必ず拒否される
    //    (フェイルクローズであることの確認。実鍵に差し替わるまでは自動更新が絶対に通らない)。
    const { verifyUpdateCodeSignature: defaultVerify } = require("./update-signature-verify.cjs");
    const resultDefaultPlaceholder = await defaultVerify(["SelfMatrix"], installerPath);
    check("default_placeholder_key_always_rejects", typeof resultDefaultPlaceholder === "string" && resultDefaultPlaceholder.length > 0, true);
    check("release_public_key_placeholder_is_all_zero_marker", RELEASE_PUBLIC_KEY.includes("PLACEHOLDER"), true);

    finish();
  })().catch((err) => {
    console.error("[update-signature-verify-probe] unexpected exception:", err);
    cases.push({ name: "no_unexpected_exception", pass: false, error: String(err && err.stack || err) });
    finish();
  });
} catch (err) {
  console.error("[update-signature-verify-probe] setup failed:", err);
  cases.push({ name: "probe_setup", pass: false, error: String(err && err.stack || err) });
  finish();
}

function finish() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 一時ディレクトリの掃除失敗は致命的ではない (OS の一時領域なので放置されても実害は小さい)。
  }

  const pass = cases.every((entry) => entry.pass);

  const evidence = {
    pass,
    task: "M2 update-signature-verify.cjs: verifyUpdateCodeSignature hook stub end-to-end probe",
    note:
      "Uses createVerifyUpdateCodeSignature(publicKeyText) with an in-process, never-persisted " +
      "Ed25519 test key so the exact production code path (verifyMinisign + file I/O) is exercised " +
      "without ever writing a secret key to disk or source.",
    cases,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "update-signature-verify-result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );

  if (!pass) {
    console.error(
      "[update-signature-verify-probe] FAIL cases:",
      JSON.stringify(
        cases.filter((entry) => !entry.pass),
        null,
        2,
      ),
    );
  }

  process.exit(pass ? 0 : 1);
}
