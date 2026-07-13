// MinisignNsisUpdater が取得した installer と隣接 `.minisig` を埋め込み公開鍵で検証する。
// 失敗理由の文字列/null という契約は electron-updater の署名検証と同じだが、stock NsisUpdater の
// publisherName 早期 return を通さず、SelfMatrix 専用 updater から必ず直接呼ばれる。
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
const { parseTrustedComment } = require("./update-trusted-comment.cjs");

// SelfMatrix リリース更新検証用の公開鍵 (Ed25519、minisign 形式)。key_id = 671E2DDA2737FAE3。
// 運用者が 2026-07-09 にオフラインで生成した鍵ペアの公開鍵側。対応する秘密鍵
// (minisign.key) は運用者の手元のみに存在し、このリポジトリにも GitHub Secrets にも CI にも
// 置かない (design/release-pipeline.md §5)。公開鍵は秘密情報ではないためコミットして問題ない。
// この鍵で署名されていない (= 運用者の秘密鍵で署名されていない) 更新物は
// verifyUpdateCodeSignature が拒否する — GitHub アカウントが乗っ取られても、この秘密鍵が
// 無ければ自動更新経由で改造バイナリを配れない、という「GitHub 非依存の信頼の根」。
const RELEASE_PUBLIC_KEY = `untrusted comment: minisign public key 671E2DDA2737FAE3
RWTj+jcn2i0eZ0jv7Ggj7q6CHh735wm6FcyjqWDEkaeJP6zP/tw2Vc0W
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
// 使う既定インスタンス) を MinisignNsisUpdater が呼ぶ。
//
// 返す検証関数は electron-updater 型の 2 引数契約 (publisherName, installerPath) => Promise<string|null>
// に対して第 3 引数 `expected` を追加している (契約を壊さない拡張 — electron-updater 自身が直接
// このフックを 2 引数で呼ぶ経路は使っておらず、MinisignNsisUpdater.verifySignature が必ず自分で
// 呼び出すので、3 引数目を渡す配線側も自前で用意できる)。
//
// バージョン束縛 (ダウングレード攻撃対策、design/release-pipeline.md の P1 指摘): expected は
// { expectedVersion, expectedFileName } の形で、electron-updater が latest.yml から読んだ
// updateInfo.version / installer ファイル名を渡す。trusted comment (署名済みで改ざん検出済み) を
// update-trusted-comment.cjs の正規フォーマットとしてパースし、
//   (a) パース不能 (フォーマット外 = 旧式署名や任意コメント) -> 拒否
//   (b) version 不一致 -> 拒否 (「過去に正規署名された古い installer + 正規 .minisig」を新しい
//       version 番号の latest.yml と組み合わせて配る攻撃を検出する本体)
//   (c) filename 不一致 -> 拒否
// のいずれかで fail-closed に倒す。expected 自体が渡されない (呼び忘れ) 場合も、チェックが
// 素通りしてバージョン束縛が骨抜きになるのを避けるため明示的に拒否する。
function createVerifyUpdateCodeSignature(publicKeyText = RELEASE_PUBLIC_KEY) {
  return async function verifyUpdateCodeSignature(_publisherName, installerPath, expected) {
    const read = readInstallerAndSignature(installerPath);
    if (!read.ok) return read.reason;

    const result = verifyMinisign({
      fileBytes: read.fileBytes,
      sigText: read.sigText,
      publicKeyText,
    });
    if (!result.ok) return result.reason;

    const expectedVersion = expected && expected.expectedVersion;
    const expectedFileName = expected && expected.expectedFileName;
    if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
      return (
        "update version binding missing: expectedVersion was not supplied to signature " +
        "verification (fail-closed; downgrade-attack defense requires it)"
      );
    }
    if (typeof expectedFileName !== "string" || expectedFileName.length === 0) {
      return (
        "update version binding missing: expectedFileName was not supplied to signature " +
        "verification (fail-closed; downgrade-attack defense requires it)"
      );
    }

    const parsedComment = parseTrustedComment(result.trustedComment);
    if (!parsedComment.ok) {
      return `update version binding rejected: ${parsedComment.reason}`;
    }
    if (parsedComment.version !== expectedVersion) {
      return (
        `update version mismatch: installer trusted comment declares version ` +
        `'${parsedComment.version}' but update metadata declares '${expectedVersion}' ` +
        `(possible downgrade attack)`
      );
    }
    if (parsedComment.fileName !== expectedFileName) {
      return (
        `update filename mismatch: installer trusted comment declares file ` +
        `'${parsedComment.fileName}' but update metadata declares '${expectedFileName}'`
      );
    }

    return null;
  };
}

const verifyUpdateCodeSignature = createVerifyUpdateCodeSignature();

module.exports = {
  createVerifyUpdateCodeSignature,
  verifyUpdateCodeSignature,
  readInstallerAndSignature,
  RELEASE_PUBLIC_KEY,
};
