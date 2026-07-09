// electron-updater (NsisUpdater) の `verifyUpdateCodeSignature` フックの雛形。
// design/release-pipeline.md §4 のフロー: 自動更新が installer を適用する前に、installer の隣に
// 置かれた `.minisig` を埋め込み公開鍵で検証し、失敗したら適用を中止する。
//
// **electron-updater 本体はまだこのリポジトリに入れていない** (3b で別途配線する — このファイルは
// 検証ロジックの雛形のみで、`autoUpdater.verifyUpdateCodeSignature = ...` の実配線はしない)。
//
// フックの型契約 (electron-updater / electron-builder の NsisUpdater が期待する形):
//   (publisherName: string[] | undefined, installerPath: string) => Promise<string | null>
//   null を返すと「検証成功」として適用に進む。文字列を返すとその文字列が失敗理由として扱われ、
//   適用が中止される。既定の Windows Authenticode 検証の代替として差し替える想定。
// publisherName は使わない — このアプリは Authenticode コード署名をしない方針
// (design/release-pipeline.md §8: 無署名 EXE を配布し SmartScreen 警告は案内で対処)。代わりに
// installer 本体に対する minisign 署名だけを信頼の根拠にする。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { verifyMinisign } = require("./minisign-verify.cjs");

// TODO(運用者の実鍵生成後に差し替え): これはテスト用のプレースホルダ公開鍵であり、
// 対応する秘密鍵は誰も持っていない (全 byte 0 の Ed25519 公開鍵 + 全 byte 0 の key_id — 構造的には
// 正しい minisign 公開鍵ファイルとしてパースできるが、意味のある鍵ではない)。このままでは
// どんな .minisig を渡しても "signature verification failed" 等で必ず拒否される
// (= フェイルクローズ: 実鍵を埋め込むまでは自動更新の適用が一切通らない安全側の既定値)。
// 運用者が design/release-pipeline.md §5 の手順でオフラインに Ed25519 鍵ペアを生成したら、
// `<name>.pub` の中身 (2 行のテキスト) でこの定数を丸ごと置き換える。
// 公開鍵は秘密情報ではないため、差し替え後もリポジトリにコミットして問題ない
// (design/release-pipeline.md §5-2)。
const RELEASE_PUBLIC_KEY = `untrusted comment: PLACEHOLDER - selfmatrix release public key (replace after operator key generation)
RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
`;

// installer のパスから隣接する `<installer>.minisig` を読み、{ ok:true, fileBytes, sigText } か
// { ok:false, reason } を返す。fs 例外を verifyUpdateCodeSignature の外へ漏らさないための薄いラッパ。
function readInstallerAndSignature(installerPath) {
  const sigPath = `${installerPath}.minisig`;

  if (!fs.existsSync(installerPath)) {
    return { ok: false, reason: `installer not found: ${installerPath}` };
  }
  if (!fs.existsSync(sigPath)) {
    return { ok: false, reason: `signature file not found: ${sigPath}` };
  }

  let fileBytes;
  try {
    fileBytes = fs.readFileSync(installerPath);
  } catch (err) {
    return { ok: false, reason: `failed to read installer: ${err.message}` };
  }

  let sigText;
  try {
    sigText = fs.readFileSync(sigPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `failed to read signature file: ${err.message}` };
  }

  return { ok: true, fileBytes, sigText };
}

// verifyUpdateCodeSignature 互換の検証関数を作るファクトリ。公開鍵をパラメータ化してあるのは
// テスト容易性のため (update-signature-verify-probe.cjs はここへ使い捨てのテスト鍵を注入して
// 検証する — 本物の RELEASE_PUBLIC_KEY に対応する秘密鍵は誰も持っていないので、既定のまま では
// 正当な署名を用意しての "成功系" テストができないため)。実運用での配線 (3b) は、引数無しで
// 呼んで得られる `verifyUpdateCodeSignature` (下でエクスポートしている、RELEASE_PUBLIC_KEY を
// 使う既定インスタンス) を `autoUpdater.verifyUpdateCodeSignature` に代入する想定。
function createVerifyUpdateCodeSignature(publicKeyText = RELEASE_PUBLIC_KEY) {
  return async function verifyUpdateCodeSignature(_publisherName, installerPath) {
    const read = readInstallerAndSignature(installerPath);
    if (!read.ok) return read.reason;

    const result = verifyMinisign({
      fileBytes: read.fileBytes,
      sigText: read.sigText,
      publicKeyText,
    });

    return result.ok ? null : result.reason;
  };
}

// 3b (別タスク) で electron-updater 本体を導入したら:
//   const { autoUpdater } = require("electron-updater");
//   autoUpdater.verifyUpdateCodeSignature = verifyUpdateCodeSignature;
//   autoUpdater.allowDowngrade = false; // design/release-pipeline.md §4
// のように配線する。ここではロジックの雛形とテスト (probe) のみを提供する。
const verifyUpdateCodeSignature = createVerifyUpdateCodeSignature();

module.exports = {
  createVerifyUpdateCodeSignature,
  verifyUpdateCodeSignature,
  readInstallerAndSignature,
  RELEASE_PUBLIC_KEY,
};
