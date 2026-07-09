# リリース手順 (M2 3c)

このリポジトリのリリースは **半自動**: CI (`.github/workflows/release.yml`) がビルド + 完全性検証の
下地までを作り、**署名と公開は運用者が手元で行う**。設計の正本は selfmatrix-workspace の
[`design/release-pipeline.md`](https://github.com/zoobookfool/selfmatrix-workspace/blob/main/design/release-pipeline.md)
(このリポジトリには置かない、リポジトリ間の文書配置ルールは README.md「開発ルール」参照)。

## 1. CI がやること / やらないこと

`v*` タグの push で起動する (`.github/workflows/release.yml`)。

**やること**:

1. desktop 自身 + cinny (`product/discord-style-shell`) + element-call (`product/discord-style-shell`)
   を sibling レイアウトで checkout。
2. cinny を `npm run build:native` でビルド (native シェル検出コードを含む dist。通常の
   `npm run build` ではない — README.md 参照)。
3. element-call を `pnpm build:embedded` でビルド (ウィジェット専用の embedded dist)。
4. desktop を `electron-builder --win nsis --publish never` でパッケージング (NSIS インストーラ +
   `latest.yml` + `.blockmap`)。
5. `actions/attest-build-provenance` で installer に Artifact Attestation を発行。
6. `SHA256SUMS` を生成。
7. **ドラフトリリース**を作成し、installer / `.blockmap` / `latest.yml` / `SHA256SUMS` を添付する。

**やらないこと (意図的)**:

- **minisign 署名はしない**。秘密鍵は運用者のオフライン手元鍵であり、CI にも GitHub Secrets にも
  一切置かない (下記「秘密鍵の取り扱い」)。
- **リリースを publish しない**。ドラフトのまま止める。公開は運用者の手動操作。
- Authenticode コード署名もしない (個人の日本在住開発者には現実的な手段が無い — 下記
  「SmartScreen / AV 誤検知」参照)。

## 2. cinny / element-call の ref ピン

現時点 (`.github/workflows/release.yml` の `CINNY_REF` / `ELEMENT_CALL_REF`) では両方とも
ブランチ名固定: `product/discord-style-shell`。

- cinny 側は native シェル向けの契約 (`window.selfmatrixNative` 検出、`native/` 配下) が
  このブランチに統合済み。
- element-call 側もこのブランチが製品ビルド対象。

**注意**: ブランチ名参照は「タグを打った時点のブランチ先端」を拾う。同じタグを後から再ビルドしても
cinny/element-call 側のコミットが変わっていれば同梱物が変わりうる (再現性が無い)。**本番リリースの
運用が安定してきたら、タグを切る直前に cinny/element-call の HEAD SHA を確認し、
`CINNY_REF`/`ELEMENT_CALL_REF` を SHA 固定へ切り替えることを推奨** (ワークフロー内のコメントにも
同じ注記あり)。

## 3. リリース手順 (ステップバイステップ)

### 3.1 タグを切る (トリガー)

1. `package.json` の `version` をリリースするバージョンに更新してコミットする
   (electron-builder のアーティファクト名 `SelfMatrix-Setup-${version}.exe` はこの値を使う。
   タグ名とバージョン番号がずれないように揃えること)。
2. `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
3. GitHub Actions の `release.yml` が起動する。完了までジョブの進行を確認する。

### 3.2 ドラフトリリースの確認

CI が成功すると、リポジトリの Releases に **draft** (非公開) のリリースができている。
installer (`.exe`) / `.blockmap` / `latest.yml` / `SHA256SUMS` が添付されていることを確認する。

### 3.3 手元で minisign 署名する (オフライン推奨)

鍵がまだ無ければ `design/release-pipeline.md` §5 のランブックに沿って運用者が先に鍵生成を行う
(このリポジトリの `src/update-signature-verify.cjs` に埋め込まれている公開鍵は、実鍵生成が済むまでの
**プレースホルダ** — 対応する秘密鍵は誰も持っていない全ゼロのダミーであり、これが埋め込まれている
限り自動更新の検証は必ず失敗する = フェイルクローズの安全側デフォルト)。

```sh
# installer をドラフトリリースからダウンロードした後
minisign -S -s selfmatrix.sec -m SelfMatrix-Setup-X.Y.Z.exe
# -> SelfMatrix-Setup-X.Y.Z.exe.minisig が生成される
```

### 3.4 初回の実署名だけ: アプリ内検証器のクロスチェック

`design/release-pipeline.md` §5-4 で明記されている未消化のギャップ: アプリ内の minisign 検証器
(`src/minisign-verify.cjs`) は仕様どおりの自家生成テストベクタでは検証済みだが、**実 minisign
バイナリが生成した署名との突き合わせは未実施** (実装時のサンドボックス制約で minisign.exe が
実行できなかったため)。

**初めて実鍵で署名するときは必ず**、生成した `.exe` + `.minisig` + 公開鍵ファイルを
`src/minisign-verify.cjs` の `verifyMinisign()` に渡し、`ok: true` が返ることを一度確認すること
(`src/minisign-verify-probe.cjs` の使い方を参考に、実ファイルを読み込むよう差し替えて実行する)。
ここで失敗したら実 minisign とのフォーマット不一致 (パーサのバグ) なので、公開前に実装側の修正が要る。

### 3.5 公開鍵をアプリへ埋め込む (初回のみ)

鍵生成後、`selfmatrix.pub` の中身 (2 行のテキスト) で `src/update-signature-verify.cjs` の
`RELEASE_PUBLIC_KEY` 定数を置き換える。公開鍵は秘密情報ではないのでコミットしてよい。

### 3.6 `.minisig` をリリースへ添付して publish

1. `SelfMatrix-Setup-X.Y.Z.exe.minisig` をドラフトリリースへ手動アップロードする
   (GitHub の Web UI、または `gh release upload vX.Y.Z SelfMatrix-Setup-X.Y.Z.exe.minisig`)。
2. ドラフトを publish する。**electron-updater は published なリリースの `latest.yml` しか見ない**
   ため、publish のタイミングがそのまま配布開始になる。

## 4. 初回インストールの検証 (TOFU: trust-on-first-use)

minisign の埋め込み公開鍵は 2 回目以降の自動更新を守るが、**最初のインストール**は
利用者自身が以下を確認すること (設計の多層対策 §3 のうち、GitHub 単独に依存しない層):

1. **SHA256SUMS の二系統照合**: リリースに添付された `SHA256SUMS` の値と、別経路
   (運用者が Matrix の運用ルームなど out-of-band に掲示するもの) の値が一致することを確認する。
   両方が同時に改ざんされていない限り、この 2 系統は一致するはず。
2. **Artifact Attestation の検証**: `gh` CLI (ログイン必須、匿名では検証できない) で

   ```sh
   gh attestation verify SelfMatrix-Setup-X.Y.Z.exe --repo zoobookfool/selfmatrix-desktop
   ```

   を実行し、「この公開ソース (このリポジトリ) からこのワークフローがビルドした」ことを確認する。

上記 2 点のうち **2/3 以上**の確認が取れれば TOFU として十分とする (設計 §5-5 のランブック方針)。
以降のバージョンアップは minisign 検証がアプリ内で自動的に守るため、毎回この手順を繰り返す必要はない。

## 5. SmartScreen / アンチウイルス誤検知

Authenticode コード署名をしていないため、初回起動時に Windows SmartScreen が
「発行元不明の実行可能ファイルを実行しますか」という警告を出す。

- 「詳細情報」→「実行」で起動できる。これは署名の有無による既定動作であり、上記の TOFU 確認
  (SHA256SUMS + Attestation) を済ませていれば問題ない。
- 一部のアンチウイルス製品が無署名 Electron アプリを誤検知することがある。誤検知が疑われる場合は
  該当ベンダーへのサンプル提出/誤検知申告を行う (Microsoft Defender の場合は
  Microsoft Security Intelligence の誤検知報告フォームを使う)。

Authenticode 署名を導入しない理由: 個人開発者向けの現実的な選択肢 (Azure Trusted Signing 等) は
日本在住の個人には利用できない (2026-06 時点で公式 FAQ 確認済み、地域制限は米国・カナダのみ)。
minisign + Artifact Attestation + SHA256SUMS の多層対策で代替する方針。

## 6. 秘密鍵の取り扱い (最重要)

- **minisign の秘密鍵 (`selfmatrix.sec`) は運用者の手元マシンのみに存在する。**
- **CI (このワークフロー) にも、GitHub Secrets にも、どのリポジトリにも一切コミット/登録しない。**
- バックアップは運用者のパスワードマネージャ、またはオフライン媒体で行う。
- この方針がある限り、GitHub アカウントが完全に乗っ取られても、攻撃者は改造した installer を
  「正規の自動更新」として配布できない (アプリ側の検証で必ず弾かれる)。

## 7. ロールバック方針

`electron-updater` は `allowDowngrade: false` で運用する (design §4)。問題のあるバージョンを配って
しまった場合は、**古いバージョンへのダウングレードは行わず、修正した新しい上位バージョンを
リリースする** (改造版へのダウングレード誘導を防ぐ設計上のトレードオフ)。

## 8. 実行時に確認が必要な項目 (未検証 / 運用者判断待ち)

- **cinny / element-call の GitHub リポジトリが public であること**: `release.yml` の cross-repo
  checkout はデフォルトの `GITHUB_TOKEN` を使っており、対象が private の場合は checkout が失敗する
  (その場合は別途 PAT/deploy key を Secrets に追加する必要があるが、これは本リポジトリの
  Secrets 追加を伴うため別タスクとして扱うこと)。
- **element-call の embedded ビルドが Windows ランナー上で `NODE_OPTIONS=--max-old-space-size=16384`
  相当のメモリを実際に必要とするか**: 標準の `windows-latest` ランナーのメモリ/CPU割り当てで
  ビルドが完走するかは実行して初めてわかる。初回のタグ push で失敗した場合、大きめの hosted runner
  への切り替えを検討すること。
- **pnpm のスクリプトシェル問題**: element-call の `package.json` スクリプトは POSIX 構文
  (`VAR=value command`) を使っており、Windows の既定シェル (cmd.exe) では解釈できない
  (CLAUDE.md 「Windows での注意」節と同じ問題)。ワークフローでは `pnpm config set scriptShell` で
  Git Bash を明示指定し、かつステップ自体も `shell: bash` で実行しているが、**実際にタグ push で
  CI を走らせて検証したことはまだ無い** — 初回実行時に最優先で確認すること。
- **`CINNY_REF` / `ELEMENT_CALL_REF` を SHA 固定に切り替えるタイミング**: 上記「ref ピン」参照。
- **公開鍵の埋め込み**: `src/update-signature-verify.cjs` の `RELEASE_PUBLIC_KEY` はまだ
  プレースホルダ。実鍵生成 (design §5) が済むまで自動更新の検証は意図的に必ず失敗する。
