// M2+ 自動更新のダウングレード攻撃対策: minisign 署名の trusted comment (グローバル署名 =
// Ed25519 over (signature_blob || trusted_comment_text) で改ざん検出される領域) に version と
// installer ファイル名を埋め込み、検証側で updateInfo (latest.yml) と突き合わせるための
// 正規フォーマットのパーサ/フォーマッタ。
//
// 背景: minisign 署名は installer の**バイト列**にしか縛られておらず、latest.yml が宣言する
// **バージョン**には縛られていない。GitHub アカウントが乗っ取られた場合、攻撃者は「過去に正規
// 署名された古い installer + その正規 .minisig」を新しいバージョン番号の latest.yml で配るだけで、
// 署名検証を通過したままサイレントダウングレードを強制できる (electron-updater の
// allowDowngrade=false は latest.yml の自己申告バージョン比較でしかなく、これには効かない)。
// trusted comment に version を埋めて署名対象にすることで、「この installer バイト列は本当に
// この version として運用者が署名した」ことまで検証できるようにする。
//
// フォーマット: `selfmatrix-desktop <version> <installer-filename>`
//   - version: latest.yml / electron-updater の updateInfo.version と同じ表記
//     (先頭 v なしの semver、例 "1.2.3")。
//   - installer-filename: 署名対象 installer のファイル名 (パス無し、例 "SelfMatrix-Setup-1.2.3.exe")。
//
// パーサとフォーマッタをこの 1 箇所に集約し、検証側 (update-signature-verify.cjs) とテスト署名側
// (各 probe のテストベクタ生成) の両方から共有する -- フォーマットを 2 箇所以上に書くと片方だけ
// 更新し忘れてドリフトする事故を防ぐため。
"use strict";

const TRUSTED_COMMENT_PREFIX = "selfmatrix-desktop";

// version / fileName は空白を含まない前提 (semver・通常の installer ファイル名はどちらも空白を
// 含まない)。呼び出し側の取り違えを早期に検出するため、フォーマット時点で軽く弾く。
function formatTrustedComment({ version, fileName }) {
  if (typeof version !== "string" || version.length === 0 || /\s/.test(version)) {
    throw new TypeError("formatTrustedComment: version must be a non-empty string without whitespace");
  }
  if (typeof fileName !== "string" || fileName.length === 0 || /\s/.test(fileName)) {
    throw new TypeError("formatTrustedComment: fileName must be a non-empty string without whitespace");
  }
  return `${TRUSTED_COMMENT_PREFIX} ${version} ${fileName}`;
}

// 正規フォーマットのパース。仕様外の文字列 (旧式の自由記述トラステッドコメント、任意コメント等)
// は ok:false + reason で拒否する -- 呼び出し側 (update-signature-verify.cjs) が fail-closed に
// 倒せるようにするため、例外は投げない。
function parseTrustedComment(text) {
  if (typeof text !== "string") {
    return { ok: false, reason: "trusted comment format: not a string" };
  }
  const trimmed = text.trim();
  const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  if (parts.length !== 3 || parts[0] !== TRUSTED_COMMENT_PREFIX) {
    return {
      ok: false,
      reason: `trusted comment format: expected '${TRUSTED_COMMENT_PREFIX} <version> <installer-filename>', got '${text}'`,
    };
  }
  const [, version, fileName] = parts;
  return { ok: true, version, fileName };
}

module.exports = {
  TRUSTED_COMMENT_PREFIX,
  formatTrustedComment,
  parseTrustedComment,
};
