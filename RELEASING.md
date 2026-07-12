# リリース手順

SelfMatrix Desktop のリリースは半自動です。GitHub Actions が固定済みソースの検証、NSISビルド、
provenance、チェックサム、ドラフトリリースまで行い、運用者がオフライン鍵で署名して公開します。
設計の正本は selfmatrix-workspace の
[`design/release-pipeline.md`](https://github.com/zoobookfool/selfmatrix-workspace/blob/main/design/release-pipeline.md)です。

## 1. 信頼する入力

- desktop 自身はリリースタグのコミットを使います。
- Cinny と Element Call は [`product-lock.json`](product-lock.json) の完全な40文字SHAだけを使います。
- `scripts/release-inputs.cjs` は次を fail-closed で検証します。
  - タグ `vX.Y.Z` と `package.json` の `version` が一致すること。
  - Cinny/Element Call の実checkoutが lock と一致すること。
  - Cinny `.selfmatrix/element-call-ref` と desktop の Element Call lock が一致すること。
- Actions はすべてcommit SHA固定です。バージョン更新時はActionsのSHAもレビュー対象にします。

## 2. CI が行うこと

`.github/workflows/release.yml` は `v*` タグで起動し、次を順番に実行します。

1. 上記3リポジトリの入力固定を検証する。
2. Element Call の lint、unit、production audit、embedded buildを実行する。
3. Cinny の typecheck、ESLint、production audit、web/native build guardを実行する。
4. desktop の production audit と `npm test` を実行する。
5. NSIS installerを生成し、unpacked製品から実 `NsisUpdater` の署名検証プローブを実行する。
6. desktop/Cinny/Element Call のSHAを `BUILD-MANIFEST.json` に保存する。
7. Artifact Attestation と `SHA256SUMS` を生成する。
8. installer、blockmap、`latest.yml`、manifest、checksumsをdraft releaseへ添付する。

CIは秘密鍵を保持せず、minisign署名もリリース公開も行いません。

## 3. タグを作る前

1. Cinny `.selfmatrix/element-call-ref` を採用するElement Call commitへ更新し、両方をPushします。
2. `product-lock.json` をPush済みのCinny/Element Call commitへ更新します。
3. `package.json` の `version` を更新します。
4. mainの Product CIが成功していることを確認します。
5. `node scripts/release-inputs.cjs --tag vX.Y.Z --verify-siblings` を実行します。

タグ作成:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグとpackage versionが違う場合、release workflowはビルド前に失敗します。

## 4. オフライン署名と公開

公開鍵は `src/update-signature-verify.cjs` に実鍵として埋め込み済みです
(`key_id = 671E2DDA2737FAE3`)。対応する秘密鍵は運用者の手元だけに置き、GitHub Secrets、CI、
リポジトリへ保存しません。

1. draft releaseから `SelfMatrix-Setup-X.Y.Z.exe` を取得します。
2. attestationと`SHA256SUMS`を確認します。
3. オフライン環境で署名します。

```sh
minisign -S -s selfmatrix.sec -m SelfMatrix-Setup-X.Y.Z.exe
```

4. 初回公開時は、実minisign binaryが作った `.minisig` をアプリ内検証器へ渡し `ok: true` を確認します。
5. `SelfMatrix-Setup-X.Y.Z.exe.minisig` をdraft releaseへ添付します。
6. `.minisig` のファイル名がinstaller名へ正確に `.minisig` を足したものか確認します。
7. draftをpublishします。

**`.minisig` が無い状態ではpublishしないでください。** アプリはinstaller URLに `.minisig` を足した
sidecarを同じreleaseから取得し、署名欠落・不一致・改ざんをすべて拒否します。`latest.yml` とinstaller
だけ公開しても自動更新はfail-closedで失敗します。

## 5. 初回公開後の確認

初回だけ、別のWindows環境で次を実施します。

1. installerを新規インストールできる。
2. `BUILD-MANIFEST.json` が意図した3 commitを示す。
3. Aboutが `Desktop X.Y.Z / Client 4.12.3` と同梱commitを表示する。
4. 1つ前の版から公開版へ自動更新できる。
5. テスト用draftで `.minisig` 欠落または改ざん時に更新が拒否される。
6. 通話中に更新がダウンロードされても即時再起動せず、通話終了後に適用される。

リポジトリ内では正常・署名欠落・改ざんの実 `NsisUpdater` 経路を packaged app から検証済みですが、
公開GitHub Releaseと実minisign binaryを使う確認はこの初回手順で完了させます。

## 6. 初回インストールの確認

minisignの埋め込み公開鍵が守るのは2回目以降の自動更新です。最初のinstallerは次を別経路で確認します。

- リリース添付の`SHA256SUMS`と運用ルーム等へ掲示した値を照合する。
- `minisign -Vm SelfMatrix-Setup-X.Y.Z.exe -P '<public-key>'` を実行する。
- `gh attestation verify SelfMatrix-Setup-X.Y.Z.exe --repo zoobookfool/selfmatrix-desktop` を実行する。

## 7. ロールバック

`allowDowngrade=false` のため、古い版を自動更新として再配布しません。問題があるreleaseは非公開化し、
修正版をより大きいversionで再ビルド・再署名します。既存タグやrelease assetの上書きは禁止です。

## 8. 残る運用確認

- 初回tag workflowの実走。
- 実minisign binaryとのクロスチェック。
- 公開Releaseを使う旧版からの自動更新。
- SmartScreen/アンチウイルス表示と友達向け導線の実機確認。
