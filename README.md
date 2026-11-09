# Map Rewind — 30DayMapChallenge 2026 Day 10「Prompting only」

AIとの対話で地図が変わっていく過程を、工程ごとの画面・プロンプト・応答を対応させて再生する作品です。タイムラインで失敗や修正も含めて振り返れます。

A player for an AI map-making session: the screen, prompt and response at each step, on a timeline that includes failed attempts.

| 画面 | 積層 |
| --- | --- |
| ![Screen view (UI fixture)](docs/screenshot.png) | ![Layers view (UI fixture)](docs/screenshot-layers.png) |

## 現在の状態

- 再生UI、記録・変換ツール、ブラウザ検証は実装済みです。
- 掲載中の記録は **UI確認用fixture** です。画像は合成テストページを実際に撮影したもので、会話文は仮の文章です。AIとの実際の対話記録ではありません。画面上にもその旨を表示しています。
- 地図の題材・使用データ・本番の制作会話は **未決定** です。題材を決めてから本番セッションを記録し、`public/sessions/` に追加します。

## 画面

表示は「画面」と「積層」の2つです（右上で切り替え、`C` キー、`?view=layers`）。

### 積層

工程ごとの画面を水平な層として、工程1を一番下に積み上げます（Day 8「空き家」の国勢調査年の層と同じ見せ方）。

- 各層では、前に撮影した工程から変わった画素を濃く、変わっていない画素を薄く描きます。どの工程で何が加わったか、何が変わったかが層ごとに見えます。選択中の工程の層は、変わっていない画素もやや濃くして地図全体が読めるようにしています。
- 選択中の工程より後の層は、枠だけを薄く描きます。再生すると層が積み上がります。
- 失敗した工程は赤い枠、画像のない工程は枠だけの層です。他の工程の画像では埋めません。
- 右奥の目盛りに工程番号を並べ、クリックするとその工程を開きます。ドラッグで回転、スクロールで拡大縮小します。
- 層の画像は縮小配列 `thumbs.zarr`（600×450）から作ります。three.js（0.186.1）と縮小配列は、積層表示を初めて開いたときにだけ読み込みます。

### 配置

| 位置 | 内容 |
| --- | --- |
| メイン | 選択した工程の地図キャプチャ（Canvasに描画） |
| サイド | その工程までのプロンプト・応答・ツール出力と、工程ごとの短い変更内容 |
| 下部 | 工程番号、前／次、再生／停止、ドラッグできるタイムライン |
| 画面下 | 記録方法、データ出典、モデル |

- 初期表示は英語。右上のボタンで日本語に切り替えます（`?lang=ja` でも指定可）。
- 画像の状態を区別します：読み込み中／表示中／失敗した工程（画像なし）／画像のない工程／取得・復号の失敗（再試行ボタン付き）。失敗した工程に他の工程の画像は表示しません。
- キーボード：← → で工程移動、Home／End、Space で再生／停止。
- `?step=<stepId>` で特定の工程を開きます。`?session=<id>` で記録を切り替えます。
- 幅900px以下では、画像・会話・タイムラインを縦に並べ、タイムラインを画面下に固定します。

## データ

| 記録 | 使用データ |
| --- | --- |
| `ui-fixture` | なし。fixtureページ（`fixtures/ui-fixture/page/`）が描いた合成図形のみ |
| 本番セッション | 未決定。公開条件を確認できるオープンデータを使い、出典とライセンスを `session.source.json` の `dataSources` に記載する |

## モデル情報

- `ui-fixture`：AIを使っていないため、モデル情報はありません（画面上は「not recorded」）。
- 本番セッション：使用したサービス・モデル名・分かる範囲の設定を `session.source.json` の `model`（全体）と各メッセージの `model`（途中で変わる場合）に記録します。分からない項目は空欄にし、推測で埋めません。

## 記録方法

詳細は [docs/recording.md](docs/recording.md)。要点：

1. 実際の制作会話を工程に分け、各工程に固定の `stepId` を付ける。1工程に複数のメッセージを入れてよい。
2. 画面は 1200×900 CSS px、deviceScaleFactor=1、同じブラウザ・フォント条件で撮る。`tools/capture.mjs` は読み込み・フォント・`window.__mapReady` を待ち、アニメーションを止めて撮影する。手動で保存したPNGも、同じ寸法なら使える。
3. ビルドに失敗した工程は `"status": "error"`、`"capture": null` とし、エラー出力をメッセージとして残す。
4. `tools/build_session.py` で `session.json` と `frames.zarr/` に変換する。APIキー・トークン・メールアドレスらしい文字列があると変換を止める。
5. 会話を後から創作しない。録画や会話の自動取得が使えるとは仮定せず、使えない場合は手動で保存する。

### 保存物

| ファイル | 公開 | 内容 |
| --- | --- | --- |
| `fixtures/<id>/session.source.json` | しない | 工程・メッセージ・キャプチャの対応（変換の入力） |
| `fixtures/<id>/captures/*.png` と `*.capture.json` | しない | 元のキャプチャと撮影条件 |
| `fixtures/<id>/build-report.json` | しない | フレームごとのRGBA SHA-256とサイズ（検証用） |
| `public/sessions/<id>/session.json` | する | 題名、schemaVersion、viewport、steps、Zarrパス |
| `public/sessions/<id>/frames.zarr/` | する | 画面画像の配列（1200×900） |
| `public/sessions/<id>/thumbs.zarr/` | する | 積層表示用の縮小配列（600×450、同じ次元構成） |

元のPNGとコードは再現用にリポジトリへ残し、公開バンドル（`dist/`）にはZarrとJSONだけを入れます。

### session.json の steps

```json
{
  "stepId": "s03-build-failed",
  "frameIndex": null,
  "timestamp": "2026-11-06T11:51:45Z",
  "status": "error",
  "changeSummary": { "en": "Build failed; no screen was captured.", "ja": "ビルド失敗。画面は撮影していない。" },
  "revision": null,
  "messages": [{ "role": "user", "content": "…" }, { "role": "tool", "label": "build", "content": "…" }]
}
```

`frameIndex` は0始まりで、画像のある工程に順番に割り当てます。画像のない工程は `null` です。`stepId` を配列番号として扱いません。`role` は `user`／`assistant`／`tool`／`note` です。

## Zarrの役割と限界

| 項目 | 内容 |
| --- | --- |
| 形式 | Zarr v3、`uint8`、次元 `(step, y, x, channel)`、RGBA |
| shape | `(N, 900, 1200, 4)` |
| chunks | `(1, 900, 1200, 4)`：1工程1チャンク |
| codec | `bytes` → `gzip(level=6)` |
| 読み込み | zarrita 0.7.5 の `FetchStore` で選択した工程のチャンクだけを取得・復号し、Canvasへ描画 |
| 配信 | `session.json` と同じoriginの静的ディレクトリ（GitHub Pages） |
| 縮小配列 | `thumbs.zarr`：shape `(N, 450, 600, 4)`、chunks `(1, 450, 600, 4)`、2×2画素の平均（box）で縮小 |

役割：画面の並びを工程番号で索引し、1枚ずつ取り出すための入れ物です。積層表示では、配列の工程の軸をそのまま高さにして、工程ごとの面（y × x）を積み上げています。1工程を1チャンクにしているので、工程を移動しても全画像は取得しません。隣の1工程だけを先読みし、直近4枚をキャッシュします。操作が速いときは古いリクエストを中断し、遅れて届いた結果で画面を上書きしません。

限界：

- **PNGより小さくなるとは限りません。** fixtureの3枚では、非圧縮 4,320,000 B/枚に対し、gzipチャンクは 46,425〜62,529 B、元のPNGは 35,705〜53,320 B で、gzipチャンクの方が約1.2〜1.3倍大きくなりました（合計 163,245 B 対 133,123 B）。本番の画像でも測り直して記載します。
- 地図の写真やタイル（空間的に詳細な面）が多い画面では、gzipの圧縮率は下がる見込みです。必要になったら圧縮方式や sharding を測定の上で検討します。最初からは導入していません。
- これは画面ピクセルの配列で、地理参照付きラスタではありません。CRSや座標は持たせていません。
- 会話本文は `session.json` に保存し、Zarrには入れていません。
- 積層の層は縮小配列から作るため、細い線や文字は粗くなります。積層表示を開くと縮小配列を全工程分取得します（fixtureでは3枚で計61,298 B）。工程が100を超える場合は、取得方法を測って見直します。
- 「変わった画素」は、前に撮影した画面とのRGBの差の合計が24を超えた画素です。地図を少し動かしただけでも画面全体が「変わった」と判定されるので、本番では工程ごとに地図の範囲を固定して撮るとよく見えます。
- 欠けたチャンクを zarrita は既定で fill_value（透明な黒）として返すため、このアプリでは欠けたチャンクをエラーとして扱います。
- 検証はChromium（Playwright同梱版）で行いました。gzip の復号はブラウザ標準の `DecompressionStream` を使います。他のブラウザでは未検証です。

## 再現方法

閲覧だけならPythonは不要です。

```sh
npm ci
npm run dev          # 開発サーバー
npm run build        # dist/ を生成（GitHub Pages 用、相対パス）
```

記録の変換（Python 3.11以上）：

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r tools/requirements.txt
node tools/capture.mjs "fixtures/ui-fixture/page/index.html?v=1" fixtures/ui-fixture/captures/frame-1.png
python tools/build_session.py fixtures/ui-fixture public/sessions/ui-fixture
```

検証（Playwright と Chromium が必要）：

```sh
npm run build
npm run verify       # docs/verification.json を出力
npm run screenshot   # docs/screenshot.png（1200×900、deviceScaleFactor=1）
VIEW=layers OUT=docs/screenshot-layers.png npm run screenshot -- s05-review
```

## 検証結果

`docs/verification.json`（Chromium 153、`ui-fixture`）：31項目すべて合格。

- 最初・中間・最後の画像：ブラウザのCanvasから読み戻したRGBAのSHA-256と寸法が、元PNGをPillowでRGBA化したものと一致。
- 成功・失敗（画像なし）・画像なしの工程で、表示中の工程、会話、画像が対応。
- 1枚目の応答だけを1.5秒遅らせて次の工程へ移っても、古い画像で上書きされない。高速なキー操作とタイムラインのドラッグ後も、選択中の工程の画像が表示される。
- 初期ロードで取得するチャンクは選択工程と隣の1工程のみ。全工程を順に移動しても各チャンクは1回だけ取得。使わない圧縮方式（zstd、blosc、lz4）のコードは読み込まない。
- 壊れたチャンク・欠けたチャンクは「読み込めませんでした」と再試行ボタンを表示。存在しない記録はエラー表示。
- Home／End、Spaceでの再生と停止、日本語切り替え、モバイル幅（390px）で横スクロールなし・縦並び。
- 積層：`C` キーで切り替わる。three.js は積層表示を開くまで読み込まない。縮小配列を各1回だけ取得し、高解像度の画像は追加で取得しない。縮小配列はブラウザで復号すると変換時のhashと一致する。目盛りのクリックでその工程が開き、それより後の層は枠だけになる。ドラッグで回転しても工程は変わらない。

## ファイル構成

```
src/                 再生UI（Vite + TypeScript、React不使用）
  frames.ts          Zarr読み込み、キャッシュ、先読み、中断
  stack.ts           積層表示（three.js、OrbitControls、CSS2DRenderer）
  session.ts         session.json の型と検証
tools/
  capture.mjs        1200×900、DPR 1 の撮影
  build_session.py   session.source.json + PNG → session.json + frames.zarr + thumbs.zarr
scripts/
  verify-browser.mjs ブラウザ検証
  screenshot.mjs     docs/screenshot.png の撮影
fixtures/ui-fixture/ UI確認用fixtureの元データ（公開しない）
public/sessions/     公開する記録
docs/                記録手順、ポータル向け説明、検証結果、画面画像
```

## ライセンス

コードは MIT（[LICENSE](LICENSE)）。本番セッションで使うデータは、それぞれの提供元のライセンスに従います。
