#!/usr/bin/env node
// M2 minisign 署名検証: minisign-verify.cjs (Electron 非依存の純関数) の単体検証 probe。
// source-picker-selection-probe.cjs と同じ理由で plain node 上で完結させる (このロジック自体は
// fs/crypto にしか触れず、Electron の Window/IPC には依存しない)。
//
// **実 minisign バイナリによるクロス検証はできていない** — このセッションでは GitHub Releases
// から入手した公式 minisign.exe (win64) の実行がサンドボックスに拒否された (scoop/choco も未導入)。
// そのためここのテストベクタは全て自家生成: Node crypto で Ed25519 鍵を生成し、下の
// encodePublicKeyFile()/encodeSignatureFile() で minisign 公式仕様
// <https://jedisct1.github.io/minisign/> の Signature format セクション記載のワイヤ形式へ
// 手動でエンコードしている (= minisign-verify.cjs のパーサと "同じ仕様書から独立に" 書いた
// エンコーダなので、ラウンドトリップが通ることは「仕様の記述通りに実装できている」ことの
// 一定の裏付けにはなるが、実 minisign 実装とのバイト単位一致の確証ではない)。
//
// もう一つの検証対象: minisign-blake2b.cjs のピュア JS BLAKE2b-512 実装。Electron 43 のメイン
// プロセスには blake2b512 のネイティブ実装が無いことが実測で判明した (minisign-blake2b.cjs の
// コメント参照) ため、ピュア JS 実装が本番相当の経路になる。ここでは plain Node のネイティブ
// 実装 (`crypto.createHash('blake2b512')`) をオラクルとして、空/ブロック境界/複数ブロック/
// 数十 KB のランダム入力でバイト単位一致を確認する。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { verifyMinisign, parsePublicKey, parseSignatureFile } = require("./minisign-verify.cjs");
const { blake2b512, blake2b512PureJs, NATIVE_BLAKE2B512_AVAILABLE } = require("./minisign-blake2b.cjs");

const appRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(appRoot, "evidence");

const cases = [];

function check(name, result, expectedOk, reasonIncludes) {
  const okMatches = result && result.ok === expectedOk;
  const reasonMatches =
    !reasonIncludes || (result && typeof result.reason === "string" && result.reason.includes(reasonIncludes));
  const pass = Boolean(okMatches && reasonMatches);
  cases.push({
    name,
    pass,
    expectedOk,
    reasonMustInclude: reasonIncludes || null,
    actual: result,
  });
  if (!pass) {
    console.error(`[minisign-verify-probe] FAIL ${name}:`, JSON.stringify(result));
  }
  return pass;
}

function checkBool(name, actual, expected) {
  const pass = actual === expected;
  cases.push({ name, pass, expected, actual });
  if (!pass) {
    console.error(`[minisign-verify-probe] FAIL ${name}: expected=${expected} actual=${actual}`);
  }
  return pass;
}

// ---- テストベクタのエンコーダ (minisign-verify.cjs のパーサとは独立に、仕様書の記述だけを
// 見て書いた。パーサ側のコードは一切参照/コピーしていない) ----

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

// base64 行 (sigText/pubKeyText の中の 1 行) の中身を 1 byte 反転させた新テキストを返す。
function tamperBase64Line(text, lineIndex, byteIndexWithinBlob) {
  const lines = text.split("\n");
  const blob = Buffer.from(lines[lineIndex], "base64");
  lines[lineIndex] = flipByte(blob, byteIndexWithinBlob).toString("base64");
  return lines.join("\n");
}

// ==== 1. BLAKE2b-512 ピュア JS 実装のネイティブとのクロス検証 (ブロック境界を重点的に) ====

if (!NATIVE_BLAKE2B512_AVAILABLE) {
  console.error(
    "[minisign-verify-probe] WARNING: this Node runtime has no native blake2b512 -- cross-validation " +
      "oracle unavailable here, skipping (the pure-JS implementation was validated in the environment " +
      "used to build it; see report).",
  );
} else {
  const lengths = [0, 1, 2, 16, 63, 64, 65, 127, 128, 129, 130, 255, 256, 257, 1000, 4096, 65536];
  for (const len of lengths) {
    const buf = crypto.randomBytes(len);
    const native = crypto.createHash("blake2b512").update(buf).digest();
    const pure = blake2b512PureJs(buf);
    checkBool(`blake2b512_pure_matches_native_len_${len}`, pure.equals(native), true);
  }
  // wrapper 自体 (native があるときは native を使う経路) も一致することを確認。
  const buf = crypto.randomBytes(4096);
  checkBool(
    "blake2b512_wrapper_matches_native",
    blake2b512(buf).equals(crypto.createHash("blake2b512").update(buf).digest()),
    true,
  );
}

// ==== 2. minisign wire format の往復検証 (自家生成テストベクタ) ====

const keyA = crypto.generateKeyPairSync("ed25519");
const keyB = crypto.generateKeyPairSync("ed25519"); // 別の鍵 (wrong-key テスト用)
const keyIdA = crypto.randomBytes(8);
const keyIdB = crypto.randomBytes(8);

const fileBytes = crypto.randomBytes(2048); // installer に見立てたダミーファイル
const tamperedFileBytes = flipByte(fileBytes, 1000);

const pubKeyTextA = encodePublicKeyFile({
  comment: "minisign public key TEST VECTOR (self-generated, not real minisign output)",
  keyId: keyIdA,
  publicKeyObject: keyA.publicKey,
});
const pubKeyTextB = encodePublicKeyFile({
  comment: "minisign public key TEST VECTOR B (self-generated)",
  keyId: keyIdB,
  publicKeyObject: keyB.publicKey,
});
// keyB の鍵材料に keyA の key_id を強制的に付け替えたもの (= key_id ゲートを素通りさせて、
// Ed25519 検証そのものが独立に弾くことを確認するための追加ケース)。
const pubKeyTextB_withKeyIdA = encodePublicKeyFile({
  comment: "minisign public key TEST VECTOR B with A's key_id (forced collision, for defense-in-depth test)",
  keyId: keyIdA,
  publicKeyObject: keyB.publicKey,
});

for (const algBytes of ["ED", "Ed"]) {
  const label = algBytes === "ED" ? "prehashed" : "legacy";
  const trustedComment = `timestamp:1735689600\tfile:SelfMatrix-Setup-0.1.0.exe\talg:${algBytes}`;

  const sigTextA = encodeSignatureFile({
    comment: "signature from minisign secret key TEST VECTOR",
    keyId: keyIdA,
    algBytes,
    fileBytes,
    trustedComment,
    privateKey: keyA.privateKey,
  });

  // (1) 正当な組み合わせ -> ok:true
  check(
    `${label}_valid_signature_verifies`,
    verifyMinisign({ fileBytes, sigText: sigTextA, publicKeyText: pubKeyTextA }),
    true,
  );

  // (2) ファイル改ざん (1 byte) -> ok:false, 署名検証失敗
  check(
    `${label}_tampered_file_rejected`,
    verifyMinisign({ fileBytes: tamperedFileBytes, sigText: sigTextA, publicKeyText: pubKeyTextA }),
    false,
    "signature verification failed",
  );

  // (3) 別の鍵 (key_id も別) -> ok:false, key_id 不一致
  check(
    `${label}_wrong_key_different_key_id_rejected`,
    verifyMinisign({ fileBytes, sigText: sigTextA, publicKeyText: pubKeyTextB }),
    false,
    "key id mismatch",
  );

  // (3b) 別の鍵だが key_id だけ一致するよう細工 -> key_id ゲートは通過するが Ed25519 検証で弾かれる
  check(
    `${label}_wrong_key_same_key_id_rejected_by_signature_math`,
    verifyMinisign({ fileBytes, sigText: sigTextA, publicKeyText: pubKeyTextB_withKeyIdA }),
    false,
    "signature verification failed",
  );

  // (4) 署名の 1 byte 改ざん (signature blob 内、署名本体 64 byte の先頭を反転)
  //     行1 = "untrusted comment: ..." (index 0), 行2 = base64 signature blob (index 1)。
  //     signature blob = alg(2) + key_id(8) + signature(64) なので、署名本体を壊すには offset 10 以降。
  const sigTextA_tamperedSig = tamperBase64Line(sigTextA, 1, 10);
  check(
    `${label}_tampered_signature_byte_rejected`,
    verifyMinisign({ fileBytes, sigText: sigTextA_tamperedSig, publicKeyText: pubKeyTextA }),
    false,
    "signature verification failed",
  );

  // (5) trusted comment 改ざん -> 本体署名は通るが global signature (trusted comment 保護) が弾く
  const sigTextA_tamperedTrustedComment = sigTextA.replace(
    `trusted comment: ${trustedComment}`,
    `trusted comment: ${trustedComment} TAMPERED`,
  );
  check(
    `${label}_tampered_trusted_comment_rejected`,
    verifyMinisign({ fileBytes, sigText: sigTextA_tamperedTrustedComment, publicKeyText: pubKeyTextA }),
    false,
    "trusted comment verification failed",
  );
}

// ==== 3. 形式不正 (行数不足 / base64 破損) は例外にせず ok:false + reason で返す ====

check("malformed_sig_too_few_lines", verifyMinisign({ fileBytes, sigText: "just one line", publicKeyText: pubKeyTextA }), false, "format");

check(
  "malformed_pubkey_too_few_lines",
  verifyMinisign({ fileBytes, sigText: encodeSignatureFile({ comment: "c", keyId: keyIdA, algBytes: "ED", fileBytes, trustedComment: "t", privateKey: keyA.privateKey }), publicKeyText: "untrusted comment: only one line" }),
  false,
  "format",
);

check(
  "malformed_sig_corrupted_base64_chars",
  (() => {
    const validSig = encodeSignatureFile({
      comment: "c",
      keyId: keyIdA,
      algBytes: "ED",
      fileBytes,
      trustedComment: "t",
      privateKey: keyA.privateKey,
    });
    const lines = validSig.split("\n");
    lines[1] = `${lines[1].slice(0, 5)}!!!!${lines[1].slice(9)}`; // '!' は base64 に存在しない文字
    return verifyMinisign({ fileBytes, sigText: lines.join("\n"), publicKeyText: pubKeyTextA });
  })(),
  false,
  "format",
);

check(
  "malformed_sig_truncated_base64",
  (() => {
    const validSig = encodeSignatureFile({
      comment: "c",
      keyId: keyIdA,
      algBytes: "ED",
      fileBytes,
      trustedComment: "t",
      privateKey: keyA.privateKey,
    });
    const lines = validSig.split("\n");
    lines[1] = lines[1].slice(0, Math.floor(lines[1].length / 2)); // 半分に切り詰める -> 長さ不一致
    return verifyMinisign({ fileBytes, sigText: lines.join("\n"), publicKeyText: pubKeyTextA });
  })(),
  false,
);

check(
  "malformed_pubkey_corrupted_base64",
  (() => {
    const lines = pubKeyTextA.split("\n");
    lines[1] = `${lines[1].slice(0, 3)}###${lines[1].slice(6)}`;
    return verifyMinisign({ fileBytes, sigText: encodeSignatureFile({ comment: "c", keyId: keyIdA, algBytes: "ED", fileBytes, trustedComment: "t", privateKey: keyA.privateKey }), publicKeyText: lines.join("\n") });
  })(),
  false,
  "format",
);

// unsupported algorithm marker (壊れたアルゴリズムマーカー) も例外にならず ok:false になることを確認。
check(
  "malformed_unsupported_sig_algorithm",
  (() => {
    const validSig = encodeSignatureFile({
      comment: "c",
      keyId: keyIdA,
      algBytes: "ED",
      fileBytes,
      trustedComment: "t",
      privateKey: keyA.privateKey,
    });
    // signature blob の先頭 2 byte ('E','D') を 'X','X' に書き換える。
    const lines = validSig.split("\n");
    const blob = Buffer.from(lines[1], "base64");
    blob[0] = 0x58; // 'X'
    blob[1] = 0x58; // 'X'
    lines[1] = blob.toString("base64");
    return verifyMinisign({ fileBytes, sigText: lines.join("\n"), publicKeyText: pubKeyTextA });
  })(),
  false,
  "unsupported signature algorithm",
);

// ==== 4. parsePublicKey / parseSignatureFile を直接使う API 利用者向けの最低限の健全性確認 ====
checkBool("parsePublicKey_direct_ok", parsePublicKey(pubKeyTextA).ok, true);
checkBool(
  "parseSignatureFile_direct_ok",
  parseSignatureFile(
    encodeSignatureFile({ comment: "c", keyId: keyIdA, algBytes: "ED", fileBytes, trustedComment: "t", privateKey: keyA.privateKey }),
  ).ok,
  true,
);

// ==== 結果集計 ====

const pass = cases.every((entry) => entry.pass);

const evidence = {
  pass,
  task: "M2 minisign-verify.cjs: format parsing + Ed25519 verification + BLAKE2b-512 cross-validation",
  note:
    "Test vectors are self-generated (Node crypto Ed25519 keys, hand-encoded to the minisign wire " +
    "format per https://jedisct1.github.io/minisign/ Signature format section). Cross-validation " +
    "against a real minisign binary was NOT possible in this sandbox (execution of a downloaded " +
    "minisign.exe was denied; scoop/choco unavailable). BLAKE2b-512 pure-JS fallback (required " +
    "because Electron 43's bundled crypto lacks native blake2b512 -- confirmed by direct check) is " +
    "cross-validated against Node's native blake2b512 across block-boundary lengths.",
  nativeBlake2bAvailableInThisRuntime: NATIVE_BLAKE2B512_AVAILABLE,
  cases,
};

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "minisign-verify-result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (!pass) {
  console.error(
    "[minisign-verify-probe] FAIL cases:",
    JSON.stringify(
      cases.filter((entry) => !entry.pass),
      null,
      2,
    ),
  );
}

process.exit(pass ? 0 : 1);
