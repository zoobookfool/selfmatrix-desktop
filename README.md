# SelfMatrix Desktop

SelfMatrix のネイティブデスクトップシェル (Electron)。Matrix クライアント [cinny](https://github.com/zoobookfool/selfmatrix-cinny) をトップフレームとして起動し、通話 (Element Call) は同一ウィンドウ内に別の `WebContentsView` として重ねて表示する。ブラウザ版 (cinny が Element Call を iframe として埋め込む構成) と機能的に等価な体験を、ネイティブアプリとして提供することが目的。

このリポジトリは selfmatrix-workspace 内の検証用スパイク `native-prototype` を卒業した製品リポジトリ。M1 (基本トポロジ・widget-api ブリッジ・call-control 中継・2 ユーザー通話 + 画面共有 + 窓移動再接続の実 E2E) までの検証ゲートが全て green だった状態から移植している。今後の実装 (M2 以降) はこのリポジトリで行う。

## アーキテクチャ概要

- **トップフレームは cinny 本体。** ブラウザ版のような `<origin>/cinny/` 以下へのパスプレフィックスは無く、cinny の React Router がオリジンのルートを直接占有する (フラグ無しの通常起動が既定でこのトポロジになる。内部的には `--cinny-shell` と呼ぶ)。
- **通話は iframe ではなく `WebContentsView`。** Element Call (ウィジェット専用ビルド `@element-hq/element-call-embedded` 相当の dist) を、cinny のウィンドウに `addChildView()` で重ねて表示する。cinny の実レイアウト (通話バーの位置・サイズ) に追従させるための bounds 同期も実装済み。
- **契約 (プロトコル) の正本は cinny 側。** iframe が存在しないネイティブ環境で `matrix-widget-api` のハンドシェイクや call-control 操作を成立させるための契約 (`window.selfmatrixNative` / `NativeCallControlAction` など) は、cinny fork の [`src/app/plugins/call/native/nativeBridge.ts`](https://github.com/zoobookfool/selfmatrix-cinny) が定義する。このリポジトリの役割は、その契約が要求する **shell 側の実装** を提供することに限られる — 契約自体を変更する場合は cinny 側から始めること。
- **shell 側の実装 (`src/`)**:
  - `main.cjs` — Electron メインプロセス。cinny/EC の dist を配信するローカル HTTP サーバ、`BrowserWindow`/`WebContentsView` のライフサイクル、widget-api メッセージの素通し中継 (`native:widget-to-view` / `native:widget-from-view`)、call-control の correlationId 方式 RPC 中継、通話 URL の検証 (`openCallView`) を持つ。
  - `widget-bridge-protocol.cjs` — Electron に依存しない純関数群 (URL 検証・メッセージ検証)。`main.cjs` はここへ委譲するだけで、判定ロジックを二重実装しない。
  - `shell-preload.cjs` / `shell-widget-host.js` — cinny 側 (mainWindow) の preload と、本物の `ClientWidgetApi` を動かす通常スクリプト。`claimWidgetTransport()` が通話 1 本につき 1 回だけ払い出す transport オブジェクトが `window.selfmatrixNative` として cinny から見える。
  - `call-control-preload.cjs` — 通話 View (Element Call) 側の preload。screenshare/spotlight/emphasis/reactions/settings/sound の実 DOM 操作を担当し、host からは RPC 経由でのみ駆動される。
  - `desktop-shell.html` / `desktop-shell.js` — cinny を iframe として埋め込む harness モード (`--harness` を明示指定したとき、または `--smoke`/`--memory-probe` などバックエンド無しでの自動検証用に使う。本番トポロジ (既定の起動、`--cinny-shell` 相当) とは別)。
  - `system-audio-probe.cjs` / `app-audio-capture-probe.cjs` — システム音声 (loopback) キャプチャとアプリ単位音声キャプチャの実機確認用スタンドアロン Electron スクリプト (`npm test` には含まれない)。

## 開発手順

このリポジトリは cinny と element-call の**兄弟ディレクトリ (sibling checkout)** として開発する前提。

```text
<workspace root>/
├── cinny/            # https://github.com/zoobookfool/selfmatrix-cinny
├── element-call/      # https://github.com/zoobookfool/selfmatrix-element-call
└── selfmatrix-desktop/ # このリポジトリ
```

成果物 (dist) の既定の解決先はこのリポジトリ自身の場所を基準にした相対パスであり (`../cinny/dist`, `../element-call/dist`)、特定の開発者のホームディレクトリ構成には依存しない。環境変数で上書きできる:

```powershell
$env:SELFMATRIX_CINNY_DIST = "C:\path\to\cinny\dist"
$env:SELFMATRIX_EC_DIST = "C:\path\to\element-call\dist"
```

事前に cinny (`npm run build:native`) と element-call (`pnpm build:embedded`) をそれぞれのリポジトリでビルドしておくこと。dist が見つからない場合は、起動時にどちらのビルドが足りないかを示すエラーで落ちる (`../cinny/dist をビルドしてください` 相当の案内付き)。

**cinny は必ず `npm run build:native` でビルドすること (`npm run build` ではない)。** SelfMatrix M2 で、cinny の web ビルド (`npm run build`) は native シェル検出コード (`window.selfmatrixNative` 検出、`src/app/plugins/call/native/**`) をセキュリティ対策として tree-shake で完全に除去するようになった (悪意ある拡張/サプライチェーン汚染が `window.selfmatrixNative` を植え込んでも web ビルドでは一切反応しない)。そのため通常の `npm run build` で作った cinny dist を配信すると、native シェル (このリポジトリ) が要求する `window.selfmatrixNative` 検出そのものが cinny 側に存在せず、**通話ホストが cinny-shell トポロジで成立しない** (`createCallEmbed()` が常に web 版 `CallEmbed` を返し、`WebContentsView` 経由の `NativeCallEmbed` に切り替わらない)。`npm run build:native` (`vite build --mode native`、`.env.native` の `VITE_SELFMATRIX_NATIVE=true` を読み込む) でビルドした dist だけがこのリポジトリと組み合わせて動作する。

```powershell
npm install
npm start            # 本番同様のトポロジ (cinny 本体をトップフレームで直接ロード) — 既定
npm run harness       # harness モード (desktop-shell.html + cinny を iframe 埋め込み、検証用)
```

`npm run cinny-shell` は `npm start` と同じ結果になる (`--cinny-shell` は「明示的に本番トポロジを要求する」互換フラグとして残してあるだけで、フラグ無しの既定と挙動は変わらない)。

## テストと E2E の実行方法

### スモークテスト (バックエンド不要)

```powershell
npm test              # smoke + memory + cinny-shell-smoke をまとめて実行
npm run smoke
npm run memory
npm run cinny-shell-smoke
```

`npm test` は Electron の実起動を伴う (headless CI で xvfb 等の準備が無い環境では失敗する)。結果は `evidence/*.json` に出力されるが、このリポジトリでは `evidence/` は `.gitignore` 済み — コミットしない (下記「証跡の扱い」参照)。

### E2E (実ログイン→実 LiveKit join、バックエンドが必要)

`npm test` には含まれない、独立した実行系:

```powershell
npm run e2e:join       # alice 1 人の実ログイン→実 LiveKit join
npm run e2e:callflow   # alice/bob 2 ユーザー通話 + 画面共有 + 窓移動再接続 + call-control 7 語彙 + 通話跨ぎ回帰
```

前提:

1. element-call の兄弟チェックアウトでローカル dev Matrix/LiveKit バックエンドを起動する (`element-call` ディレクトリで `pnpm backend`、Docker が必要)。`https://synapse.m.localhost/.well-known/matrix/client` の `org.matrix.msc4143.rtc_foci` が引ければ準備完了。
2. `element-call` ディレクトリで `pnpm install` 済みであること (`playwright-core` をこのリポジトリの依存に追加せず、element-call の pnpm store から glob 解決で借用するため)。
3. dev ユーザー (alice、`e2e:callflow` はさらに bob) のパスワードを、その場限りの環境変数として渡す。**ファイルやコマンド履歴に平文で残さないこと**:

```powershell
$env:SELFMATRIX_E2E_PASSWORD_ALICE = "..."
$env:SELFMATRIX_E2E_PASSWORD_BOB = "..."   # e2e:callflow のみ必要
npm run e2e:join
npm run e2e:callflow
```

終了コード 0/1 で pass/fail が分かる。証跡は `evidence/native-join-result.json` / `evidence/native-callflow-result.json` (パスワード・個人絶対パスを含まないようサニタイズ済み) とスクリーンショット。

### 音声プローブ (任意、音声デバイス依存のため `npm test` には含めない)

```powershell
npm run probe:system-audio        # システム音声 (loopback) キャプチャの実機確認
npm run probe:app-audio-capture   # アプリ単位音声キャプチャに相当する API の有無を調査
```

## 開発ルール: 作業文書の置き場所

ロードマップ・要件・fork 戦略・スパイク記録・UI 設計メモ・レビュー記録などの**作業文書は [selfmatrix-workspace](https://github.com/zoobookfool/selfmatrix-workspace) 側が正本**であり、このリポジトリには置かない。このリポジトリが持つドキュメントは、目的・アーキテクチャ・開発/テスト手順 (=このファイル) に限定する。

## 証跡 (evidence) の扱い

`npm test` / `npm run e2e:*` / 各種 probe は `evidence/*.json` (+ スクリーンショット) にローカルで結果を書き出すが、このリポジトリでは `.gitignore` によりコミット対象外にしている。検証の証跡を残す文化自体は selfmatrix-workspace 側の管轄であり、この製品リポジトリでは将来的に CI (自動テスト実行 + 結果の可視化) がその役割を代替する想定。

## ライセンスと fork 元

- ライセンス: [AGPL-3.0-only](./LICENSE)。
- このリポジトリのソースは selfmatrix-workspace の `native-prototype` (M1 検証済み時点、全ゲート green) を移植したもの。関連リポジトリ:
  - [zoobookfool/selfmatrix](https://github.com/zoobookfool/selfmatrix) — 親プロジェクト
  - [zoobookfool/selfmatrix-cinny](https://github.com/zoobookfool/selfmatrix-cinny) — cinny fork
  - [zoobookfool/selfmatrix-element-call](https://github.com/zoobookfool/selfmatrix-element-call) — Element Call fork
  - [zoobookfool/selfmatrix-workspace](https://github.com/zoobookfool/selfmatrix-workspace) — 作業文書・スパイク記録の正本
