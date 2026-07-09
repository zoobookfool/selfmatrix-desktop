// BLAKE2b-512 のピュア JS 実装 (RFC 7693 準拠) + Node crypto ネイティブ実装への委譲。
//
// なぜこれが要るのか (M2 minisign 署名検証タスクでの実測で判明した事実):
//   plain Node (このリポジトリの probe を走らせる `node` コマンド、Node v24 系) では
//   `crypto.createHash('blake2b512')` が動く。しかし **Electron 43 が同梱する Node/BoringSSL
//   ランタイムでは blake2b512 が一切登録されていない** (`crypto.getHashes()` が空配列を返し、
//   `createHash('blake2b512')` は `Digest method not supported` で例外になる — 2026-07-09 に
//   `electron src/main.cjs` 相当の実行で実測確認済み)。desktop アプリの自動更新検証は
//   Electron のメインプロセスで動く (design/release-pipeline.md §4) ため、ネイティブ実装だけに
//   依存すると **本番環境でだけ minisign の既定署名方式 (prehashed 'ED') の検証が全滅する**
//   という落とし穴になる。npm へ新規依存を足せない制約 (絶対条件) もあるため、ここでは
//   ネイティブ実装を優先しつつ (`blake2b512()`)、使えない環境では自前のピュア JS 実装
//   (`blake2b512PureJs()`) にフォールバックする。
//
// ピュア JS 実装の正しさの確認方法: このファイル単体では正解データを持たない (RFC のテスト
// ベクタを手で書き写すのはミスの温床になるため避けた)。代わりに minisign-verify-probe.cjs が
// **plain Node 上のネイティブ実装 (`crypto.createHash('blake2b512')`) をオラクルとして**、
// 空/1 byte/ブロック境界 (127/128/129 byte)/複数ブロック/数 MB のランダム入力で
// `blake2b512PureJs()` の出力が完全一致することをバイト単位で検証している (npm test に組込)。
// ブロック境界前後を重点的に突いているのはパディング/最終ブロックフラグ/カウンタまわりの
// オフバイエラーが典型的な実装ミスの温床だから。
"use strict";

const crypto = require("node:crypto");

const MASK64 = (1n << 64n) - 1n;
const BLOCK_BYTES = 128;

// RFC 7693 §2.6: BLAKE2b の初期化ベクタ (SHA-512 の IV の小数部由来定数と同一)。
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

// RFC 7693 §2.7: メッセージワードの並び替えテーブル (12 ラウンド分)。ラウンド 10/11 はラウンド
// 0/1 の並びを再利用する仕様どおり (BLAKE2b はユニークな並びを 10 個しか持たない)。
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

// 無鍵 / ソルト無し / パーソナライズ無し / 逐次モード (fanout=1, depth=1) / digest_length=64 の
// 64-byte パラメータブロックを 8 個の 64-bit リトルエンディアン語として見たとき、非ゼロなのは
// 語 0 の下位 4 byte (digest_length=0x40, key_length=0, fanout=1, depth=1) だけ。
// 語0 = 0x40 | (0<<8) | (1<<16) | (1<<24) = 0x01010040。他の語は全部ゼロなので IV とのXORは無変化。
const PARAM_XOR_H0 = 0x01010040n;

function rotr64(x, n) {
  const bn = BigInt(n);
  return ((x >> bn) | (x << (64n - bn))) & MASK64;
}

function mixG(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & MASK64;
  v[d] = rotr64(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & MASK64;
  v[b] = rotr64(v[b] ^ v[c], 63);
}

// 1 個の 128-byte ブロックを圧縮して h (8 x 64-bit の連鎖値配列) を更新する。
// t: これまでに処理した総メッセージバイト数 (パディング分は含まない)。
// isLast: 最後のブロックなら true (メッセージ長がブロックサイズちょうどでも最後のブロックは
//   isLast=true で圧縮する — BLAKE2 は追加の空ブロックを必要としない仕様)。
function compressBlock(h, block, t, isLast) {
  const m = new Array(16);
  for (let i = 0; i < 16; i += 1) {
    m[i] = block.readBigUInt64LE(i * 8);
  }

  const v = new Array(16);
  for (let i = 0; i < 8; i += 1) v[i] = h[i];
  for (let i = 0; i < 8; i += 1) v[8 + i] = IV[i];

  // t は理論上 128-bit カウンタ (RFC 7693) だが、現実のファイルサイズは 2^64 byte を超えない
  // ため上位語は常に 0。仕様どおりの分割だけ残しておく。
  v[12] ^= t & MASK64;
  v[13] ^= (t >> 64n) & MASK64;
  if (isLast) v[14] ^= MASK64;

  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round];
    mixG(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    mixG(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    mixG(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    mixG(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    mixG(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    mixG(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    mixG(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    mixG(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i += 1) {
    h[i] = (h[i] ^ v[i] ^ v[i + 8]) & MASK64;
  }
}

// BLAKE2b-512 (無鍵、salt/personal 無し) をピュア JS で計算する。依存は BigInt 演算のみ
// (node:crypto にすら依存しない) — Electron のようにネイティブ blake2b512 が無い環境向けの
// 最終フォールバック。
function blake2b512PureJs(data) {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError("blake2b512PureJs: data must be a Buffer");
  }

  const h = IV.slice();
  h[0] ^= PARAM_XOR_H0;

  const len = data.length;

  if (len === 0) {
    compressBlock(h, Buffer.alloc(BLOCK_BYTES), 0n, true);
  } else {
    let offset = 0;
    let t = 0n;
    while (offset < len) {
      const remaining = len - offset;
      const isLast = remaining <= BLOCK_BYTES;
      const chunkLen = isLast ? remaining : BLOCK_BYTES;
      let block;
      if (chunkLen === BLOCK_BYTES) {
        block = data.subarray(offset, offset + BLOCK_BYTES);
      } else {
        block = Buffer.alloc(BLOCK_BYTES);
        data.copy(block, 0, offset, offset + chunkLen);
      }
      t += BigInt(chunkLen);
      compressBlock(h, block, t, isLast);
      offset += chunkLen;
    }
  }

  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i += 1) {
    out.writeBigUInt64LE(h[i] & MASK64, i * 8);
  }
  return out;
}

// ネイティブ blake2b512 が使える環境かどうかはプロセス起動後不変なので一度だけ判定する。
const NATIVE_BLAKE2B512_AVAILABLE = crypto.getHashes().includes("blake2b512");

// BLAKE2b-512 を計算する。ネイティブ (`crypto.createHash('blake2b512')`) が使えればそちらを
// 使い (高速)、使えない環境 (Electron 43 のメインプロセス実測— 上のコメント参照) では
// ピュア JS 実装に自動フォールバックする。
function blake2b512(data) {
  if (NATIVE_BLAKE2B512_AVAILABLE) {
    try {
      return crypto.createHash("blake2b512").update(data).digest();
    } catch {
      // フォールスルーしてピュア JS 実装を試す (念のための保険。通常はここに来ない)。
    }
  }
  return blake2b512PureJs(data);
}

module.exports = {
  blake2b512,
  blake2b512PureJs,
  NATIVE_BLAKE2B512_AVAILABLE,
};
