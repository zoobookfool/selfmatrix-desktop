#!/usr/bin/env node
// M2 minisign 署名検証: MinisignNsisUpdater が呼ぶ update-signature-verify.cjs の単体検証 probe。
// plain node 上で完結する (fs/crypto のみ、Electron 非依存)。
//
// RELEASE_PUBLIC_KEY (モジュール内の既定定数 = 運用者の実公開鍵) に対応する秘密鍵は運用者の手元に
// しか無いため、この probe から "正当な署名 -> null" を確かめることはできない (probe は運用者の
// 秘密鍵を持たない = フェイルクローズの確認になる)。そのため createVerifyUpdateCodeSignature(publicKeyText) ファクトリへ、この probe
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
// バージョン束縛 (ダウングレード攻撃対策) のテストベクタは、検証側と同じ正規フォーマッタを使って
// 組み立てる (フォーマットの二重実装によるドリフトを避けるため -- update-trusted-comment.cjs の
// コメント参照)。minisign のワイヤエンベロープ自体は引き続きこの probe が独立にエンコードする。
const { formatTrustedComment } = require("./update-trusted-comment.cjs");

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
// バージョン束縛 (ダウングレード攻撃対策) の「latest.yml が宣言する期待値」役。
const EXPECTED_VERSION = "0.1.0-test";
const EXPECTED_FILE_NAME = path.basename(installerPath);
const EXPECTED = { expectedVersion: EXPECTED_VERSION, expectedFileName: EXPECTED_FILE_NAME };

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
    trustedComment: formatTrustedComment({ version: EXPECTED_VERSION, fileName: EXPECTED_FILE_NAME }),
    privateKey: testKey.privateKey,
  });

  const verifyWithTestKey = createVerifyUpdateCodeSignature(testPublicKeyText);
  const verifyWithOtherKey = createVerifyUpdateCodeSignature(otherPublicKeyText);

  // sanity: 独立に minisign-verify.cjs 単体でも valid と分かっているベクタであることを確認
  // (このテストの土台が壊れていないことの前提チェック)。
  check("sanity_valid_vector_verifies_standalone", verifyMinisign({ fileBytes: installerBytes, sigText: validSigText, publicKeyText: testPublicKeyText }).ok, true);

  (async () => {
    // 1. 正当な installer + .minisig + 正規 trusted comment (version/filename が expected と一致) ->
    //    null (electron-updater 契約: null = 成功、適用へ進む)。
    fs.writeFileSync(sigPath, validSigText, "utf8");
    const resultValid = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check("valid_installer_returns_null", resultValid, null);

    // 1b. trusted comment の version が expected (= latest.yml の updateInfo.version 相当) と食い違う
    //     -> エラー文字列。P1 のダウングレード攻撃対策の本体: 「過去に正規署名された installer +
    //     その正規 .minisig」を新しい version 番号の latest.yml と組み合わせて配る攻撃を検出する。
    const sigTextWrongVersion = encodeSignatureFile({
      comment: "test signature (wrong version)",
      keyId,
      algBytes: "ED",
      fileBytes: installerBytes,
      trustedComment: formatTrustedComment({ version: "9.9.9", fileName: EXPECTED_FILE_NAME }),
      privateKey: testKey.privateKey,
    });
    fs.writeFileSync(sigPath, sigTextWrongVersion, "utf8");
    const resultVersionMismatch = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check(
      "downgrade_version_mismatch_rejected",
      typeof resultVersionMismatch === "string" && resultVersionMismatch.includes("version mismatch"),
      true,
    );
    fs.writeFileSync(sigPath, validSigText, "utf8"); // 復元

    // 1c. trusted comment の installer ファイル名が expected と食い違う -> エラー文字列。
    const sigTextWrongFileName = encodeSignatureFile({
      comment: "test signature (wrong filename)",
      keyId,
      algBytes: "ED",
      fileBytes: installerBytes,
      trustedComment: formatTrustedComment({
        version: EXPECTED_VERSION,
        fileName: "SomeOtherInstaller-0.1.0-test.exe",
      }),
      privateKey: testKey.privateKey,
    });
    fs.writeFileSync(sigPath, sigTextWrongFileName, "utf8");
    const resultFileNameMismatch = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check(
      "filename_mismatch_rejected",
      typeof resultFileNameMismatch === "string" && resultFileNameMismatch.includes("filename mismatch"),
      true,
    );
    fs.writeFileSync(sigPath, validSigText, "utf8"); // 復元

    // 1d. trusted comment が正規フォーマット外 (旧式の自由記述コメント) -> フォーマット強制で拒否
    //     (fail-closed: パースできない = 信用しない)。
    const sigTextLegacyFormat = encodeSignatureFile({
      comment: "test signature (legacy free-form trusted comment)",
      keyId,
      algBytes: "ED",
      fileBytes: installerBytes,
      trustedComment: `timestamp:1735689600\tfile:${EXPECTED_FILE_NAME}`,
      privateKey: testKey.privateKey,
    });
    fs.writeFileSync(sigPath, sigTextLegacyFormat, "utf8");
    const resultLegacyFormat = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check(
      "legacy_trusted_comment_format_rejected",
      typeof resultLegacyFormat === "string" && resultLegacyFormat.includes("update version binding rejected"),
      true,
    );
    fs.writeFileSync(sigPath, validSigText, "utf8"); // 復元

    // 1e. expected (第 3 引数) 自体を渡し忘れた呼び出し -> 有効な署名であっても明示的に拒否する
    //     (呼び忘れでバージョン束縛チェックがまるごと素通りする事故を防ぐため)。
    const resultNoExpectedArg = await verifyWithTestKey(["SelfMatrix"], installerPath);
    check(
      "missing_expected_arg_rejected",
      typeof resultNoExpectedArg === "string" && resultNoExpectedArg.includes("expectedVersion"),
      true,
    );

    // 1f. expected は渡されたが expectedVersion フィールドが欠けている -> 同様に拒否。
    const resultEmptyExpectedVersion = await verifyWithTestKey(["SelfMatrix"], installerPath, {
      expectedFileName: EXPECTED_FILE_NAME,
    });
    check(
      "missing_expected_version_field_rejected",
      typeof resultEmptyExpectedVersion === "string" && resultEmptyExpectedVersion.includes("expectedVersion"),
      true,
    );

    // 1g. expected.expectedFileName フィールドが欠けている -> 同様に拒否 (version だけでなく
    //     filename も渡し忘れ検出の対象にする)。
    const resultEmptyExpectedFileName = await verifyWithTestKey(["SelfMatrix"], installerPath, {
      expectedVersion: EXPECTED_VERSION,
    });
    check(
      "missing_expected_filename_field_rejected",
      typeof resultEmptyExpectedFileName === "string" && resultEmptyExpectedFileName.includes("expectedFileName"),
      true,
    );

    // 2. installer が改ざんされている (署名時と中身が変わった) -> エラー文字列 (適用中止)
    fs.writeFileSync(installerPath, crypto.randomBytes(65536)); // 中身を丸ごと差し替え
    const resultTampered = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check("tampered_installer_returns_error_string", typeof resultTampered === "string" && resultTampered.length > 0, true);
    // 改ざん後も installer を元に戻す (以降のケースのため)。
    fs.writeFileSync(installerPath, installerBytes);

    // 3. .minisig が存在しない -> エラー文字列 (適用中止、例外にはならない)
    fs.rmSync(sigPath, { force: true });
    const resultMissingSig = await verifyWithTestKey(["SelfMatrix"], installerPath, EXPECTED);
    check("missing_signature_file_returns_error_string", typeof resultMissingSig === "string" && resultMissingSig.includes("not found"), true);
    fs.writeFileSync(sigPath, validSigText, "utf8"); // 復元

    // 4. 別の鍵で作った検証関数 (= 埋め込み公開鍵が違う) -> エラー文字列
    const resultWrongKey = await verifyWithOtherKey(["SelfMatrix"], installerPath, EXPECTED);
    check("wrong_embedded_public_key_returns_error_string", typeof resultWrongKey === "string" && resultWrongKey.length > 0, true);

    // 5. installer が存在しない -> エラー文字列 (例外にならない)
    const resultMissingInstaller = await verifyWithTestKey(["SelfMatrix"], path.join(tmpDir, "does-not-exist.exe"), EXPECTED);
    check("missing_installer_returns_error_string", typeof resultMissingInstaller === "string" && resultMissingInstaller.includes("not found"), true);

    // 6. デフォルトエクスポート (RELEASE_PUBLIC_KEY = 運用者の実公開鍵を使う既定インスタンス) は、
    //    このテストが用意する署名 (probe 自身が生成したテスト鍵で署名したもの) を必ず拒否する。
    //    運用者の秘密鍵で署名されていない更新物は通らない = フェイルクローズであることの確認。
    const { verifyUpdateCodeSignature: defaultVerify } = require("./update-signature-verify.cjs");
    const resultDefaultRejectsNonOperatorSig = await defaultVerify(["SelfMatrix"], installerPath);
    check("default_key_rejects_non_operator_signature", typeof resultDefaultRejectsNonOperatorSig === "string" && resultDefaultRejectsNonOperatorSig.length > 0, true);

    // 7. RELEASE_PUBLIC_KEY に**実鍵が埋め込まれている**ことのガード (プレースホルダへの誤 revert /
    //    空鍵の混入を検知)。構造的に妥当な minisign 公開鍵で、key_id が非ゼロであることを確認する。
    const { parsePublicKey } = require("./minisign-verify.cjs");
    const parsedReleaseKey = parsePublicKey(RELEASE_PUBLIC_KEY);
    const releaseKeyIsReal =
      !RELEASE_PUBLIC_KEY.includes("PLACEHOLDER") &&
      !parsedReleaseKey.reason &&
      Buffer.isBuffer(parsedReleaseKey.keyId) &&
      !parsedReleaseKey.keyId.every((b) => b === 0);
    check("release_public_key_is_real_embedded_key", releaseKeyIsReal, true);

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
    task: "M2 update-signature-verify.cjs: minisign file verification end-to-end probe",
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
