// M2 自動更新の完全性検証: minisign (Ed25519) 署名フォーマットのパース + 検証。
// Electron 非依存の純関数群 (依存は node:crypto と同ディレクトリの minisign-blake2b.cjs のみ —
// どちらも npm へ新規依存を足さない絶対条件を満たす)。
//
// 背景 (design/release-pipeline.md §4-5): 自動更新 (electron-updater) が installer を適用する前に
// 埋め込み公開鍵で minisign 署名を検証する。GitHub アカウントが乗っ取られても、運用者の手元
// 署名鍵が無ければ改造 installer を配れなくする最後の防衛線。実装は update-signature-verify.cjs
// (electron-updater フックの雛形) から呼ばれる想定。
//
// 参照した仕様: 公式 minisign 署名フォーマット仕様 <https://jedisct1.github.io/minisign/>
// (Signature format セクション)。この仕様ページのフォーマット記述 (行構成・各ブロブの
// バイトレイアウト・trusted comment に対する 2 段目署名の存在) に基づいて実装した。
// **実 minisign バイナリによるクロス検証はできていない** (このセッションのサンドボックスでは
// GitHub Releases からダウンロードした minisign.exe の実行が許可されなかった — scoop/choco も
// 未導入)。そのためテストベクタは全て自家生成 (Node crypto の Ed25519 鍵 + このファイルと対に
// なる probe のエンコーダ) であり、実 minisign が書き出す実ファイルとのバイト単位一致は
// 未確認。minisign-verify-probe.cjs にその旨を明記している。
//
// フォーマット (仕様ページより):
//   公開鍵ファイル (2 行):
//     untrusted comment: <任意文字列>
//     <base64: signature_algorithm(2) || key_id(8) || public_key(32)>  = 42 byte
//   署名ファイル (.minisig, 4 行):
//     untrusted comment: <任意文字列>
//     <base64: signature_algorithm(2) || key_id(8) || signature(64)>   = 74 byte
//     trusted comment: <任意文字列>
//     <base64: global_signature(64)>
//       global_signature = Ed25519(sk, (署名ブロブ74byte) || (trusted comment の生バイト列))
//       — trusted comment 自体の改ざんを検出するための 2 段目の署名。
//   signature_algorithm は 'Ed' (legacy: ファイルの生バイト列に直接署名) または
//   'ED' (prehashed: ファイルの BLAKE2b-512 ハッシュに署名、2026-07 時点の minisign 既定)。
//   公開鍵ブロブの先頭 2 byte は署名方式とは無関係に常に 'Ed' (鍵生成アルゴリズムの識別子)。
"use strict";

const crypto = require("node:crypto");
const { blake2b512 } = require("./minisign-blake2b.cjs");

const KEY_ID_LEN = 8;
const RAW_PUBLIC_KEY_LEN = 32;
const RAW_SIGNATURE_LEN = 64;
const PUBLIC_KEY_BLOB_LEN = 2 + KEY_ID_LEN + RAW_PUBLIC_KEY_LEN; // 42
const SIGNATURE_BLOB_LEN = 2 + KEY_ID_LEN + RAW_SIGNATURE_LEN; // 74
const GLOBAL_SIGNATURE_LEN = 64;

const PUBLIC_KEY_ALG = "Ed"; // 公開鍵ブロブの固定マーカー
const SIG_ALG_LEGACY = "Ed"; // 署名ブロブ: ファイルの生バイト列に直接署名
const SIG_ALG_PREHASHED = "ED"; // 署名ブロブ: BLAKE2b-512(ファイル) に署名 (現行既定)

const UNTRUSTED_PREFIX = "untrusted comment:";
const TRUSTED_PREFIX = "trusted comment:";

function splitLines(text) {
  if (typeof text !== "string") return [];
  // CRLF/LF どちらで書かれていても等価に扱う。
  return text.replace(/\r\n/g, "\n").split("\n");
}

// base64 を厳密にデコードする。Node の Buffer.from(str,'base64') は不正な文字を黙って読み飛ばし
// たり途中で打ち切ったりする (壊れた/切り詰められた base64 を検出できない) ため、デコード後に
// 再エンコードして入力と一致するかを確認することで破損を検出する。
function decodeBase64Strict(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, "base64");
  const reencoded = buf.toString("base64");
  if (reencoded.replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) return null;
  return buf;
}

// 公開鍵ファイル (2 行) をパースする。
function parsePublicKey(publicKeyText) {
  const lines = splitLines(publicKeyText);
  if (lines.length < 2 || !lines[0].startsWith(UNTRUSTED_PREFIX)) {
    return {
      ok: false,
      reason: "public key format: expected 'untrusted comment:' line followed by a base64 line",
    };
  }

  const blob = decodeBase64Strict(lines[1]);
  if (!blob) {
    return { ok: false, reason: "public key format: base64 decode failed on key line" };
  }
  if (blob.length !== PUBLIC_KEY_BLOB_LEN) {
    return {
      ok: false,
      reason: `public key format: expected ${PUBLIC_KEY_BLOB_LEN}-byte blob, got ${blob.length}`,
    };
  }

  const algBytes = blob.subarray(0, 2).toString("ascii");
  if (algBytes !== PUBLIC_KEY_ALG) {
    return { ok: false, reason: `public key format: unsupported key algorithm marker '${algBytes}'` };
  }

  return {
    ok: true,
    keyId: blob.subarray(2, 2 + KEY_ID_LEN),
    rawPublicKey: blob.subarray(2 + KEY_ID_LEN, PUBLIC_KEY_BLOB_LEN),
  };
}

// 署名ファイル (.minisig, 4 行) をパースする。
function parseSignatureFile(sigText) {
  const lines = splitLines(sigText);
  if (
    lines.length < 4 ||
    !lines[0].startsWith(UNTRUSTED_PREFIX) ||
    !lines[2].startsWith(TRUSTED_PREFIX)
  ) {
    return {
      ok: false,
      reason:
        "signature format: expected 4 lines (untrusted comment / base64 sig / trusted comment / base64 global sig)",
    };
  }

  const sigBlob = decodeBase64Strict(lines[1]);
  if (!sigBlob) {
    return { ok: false, reason: "signature format: base64 decode failed on signature line" };
  }
  if (sigBlob.length !== SIGNATURE_BLOB_LEN) {
    return {
      ok: false,
      reason: `signature format: expected ${SIGNATURE_BLOB_LEN}-byte blob, got ${sigBlob.length}`,
    };
  }

  const algBytes = sigBlob.subarray(0, 2).toString("ascii");
  if (algBytes !== SIG_ALG_LEGACY && algBytes !== SIG_ALG_PREHASHED) {
    return { ok: false, reason: `signature format: unsupported signature algorithm '${algBytes}'` };
  }

  const globalSignature = decodeBase64Strict(lines[3]);
  if (!globalSignature) {
    return { ok: false, reason: "signature format: base64 decode failed on global signature line" };
  }
  if (globalSignature.length !== GLOBAL_SIGNATURE_LEN) {
    return {
      ok: false,
      reason: `signature format: expected ${GLOBAL_SIGNATURE_LEN}-byte global signature, got ${globalSignature.length}`,
    };
  }

  // "trusted comment: " の後ろの生テキストがグローバル署名の対象。プレフィックス直後に半角
  // スペースが 1 つある想定 (実 minisign の出力書式) だが、無くても壊れず動くようフォールバックする。
  const trustedComment = lines[2].slice(TRUSTED_PREFIX.length).replace(/^ /, "");

  return {
    ok: true,
    algBytes,
    keyId: sigBlob.subarray(2, 2 + KEY_ID_LEN),
    signature: sigBlob.subarray(2 + KEY_ID_LEN, SIGNATURE_BLOB_LEN),
    signatureBlobRaw: sigBlob, // 74 byte 丸ごと (グローバル署名が保護する対象の前半)
    trustedComment,
    globalSignature,
  };
}

// raw 32-byte Ed25519 公開鍵を Node の KeyObject に変換する。
// SPKI DER を手組みする方法 (固定 12-byte prefix `302a300506032b6570032100` + raw32) もあるが、
// ここでは RFC 8037 (OKP JWK) 経由にした — マジックナンバーの DER prefix を手で書く必要がなく
// 誤りにくい。`crypto.createPublicKey({ key: {kty:'OKP', crv:'Ed25519', x}, format:'jwk' })` は
// Node v24 系および Electron 43 同梱の Node の両方で動作確認済み。
function publicKeyObjectFromRaw(rawPublicKey) {
  if (!Buffer.isBuffer(rawPublicKey) || rawPublicKey.length !== RAW_PUBLIC_KEY_LEN) {
    throw new TypeError(`publicKeyObjectFromRaw: expected ${RAW_PUBLIC_KEY_LEN}-byte raw key`);
  }
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawPublicKey.toString("base64url") },
    format: "jwk",
  });
}

function verifyEd25519(publicKeyObject, message, signature) {
  try {
    return crypto.verify(null, message, publicKeyObject, signature);
  } catch {
    return false;
  }
}

// メイン API。
// 引数:
//   fileBytes: 検証対象ファイルの内容 (Buffer)。
//   sigText: .minisig ファイルの中身 (文字列)。
//   publicKeyText: 埋め込み公開鍵ファイルの中身 (文字列)。
// 戻り値: { ok: true } | { ok: false, reason: string }
//   reason は形式不正 / アルゴリズム不明 / key_id 不一致 / 署名検証失敗 / trusted comment
//   検証失敗、のどれかを文字列で区別する (呼び出し側が electron-updater のエラー文字列に
//   そのまま使える粒度)。
function verifyMinisign({ fileBytes, sigText, publicKeyText }) {
  if (!Buffer.isBuffer(fileBytes)) {
    return { ok: false, reason: "invalid input: fileBytes must be a Buffer" };
  }

  const pubkey = parsePublicKey(publicKeyText);
  if (!pubkey.ok) return { ok: false, reason: pubkey.reason };

  const sig = parseSignatureFile(sigText);
  if (!sig.ok) return { ok: false, reason: sig.reason };

  if (
    pubkey.keyId.length !== sig.keyId.length ||
    !crypto.timingSafeEqual(pubkey.keyId, sig.keyId)
  ) {
    return { ok: false, reason: "key id mismatch: signature was not made with the embedded public key" };
  }

  let publicKeyObject;
  try {
    publicKeyObject = publicKeyObjectFromRaw(pubkey.rawPublicKey);
  } catch (err) {
    return { ok: false, reason: `public key format: not a valid Ed25519 key (${err.message})` };
  }

  const message = sig.algBytes === SIG_ALG_PREHASHED ? blake2b512(fileBytes) : fileBytes;

  if (!verifyEd25519(publicKeyObject, message, sig.signature)) {
    return { ok: false, reason: "signature verification failed: file content does not match signature" };
  }

  // trusted comment の改ざん検出 (2 段目署名)。signature_blob(74byte) || trusted_comment(生バイト)
  // に対する Ed25519 署名を検証する。ここが通らないファイル本体署名は有効でも trusted comment
  // (バージョン番号や日時など運用上の意味を持つ文字列) が差し替えられている可能性がある。
  const globalMessage = Buffer.concat([sig.signatureBlobRaw, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verifyEd25519(publicKeyObject, globalMessage, sig.globalSignature)) {
    return {
      ok: false,
      reason: "trusted comment verification failed: trusted comment or signature block was tampered with",
    };
  }

  return { ok: true };
}

module.exports = {
  verifyMinisign,
  parsePublicKey,
  parseSignatureFile,
  publicKeyObjectFromRaw,
  PUBLIC_KEY_ALG,
  SIG_ALG_LEGACY,
  SIG_ALG_PREHASHED,
  KEY_ID_LEN,
  RAW_PUBLIC_KEY_LEN,
  RAW_SIGNATURE_LEN,
};
