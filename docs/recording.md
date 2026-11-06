# 本番セッションの記録手順

再生する対話は実際の制作会話に限ります。後から会話を書き起こして作り直したり、要約で置き換えたりしません（長い応答を省略する場合は、省略したことを本文に書く）。

## 0. 始める前に決めること

- 地図の題材と使用データ。公開条件（ライセンス、出典表記、再配布の可否）を確認できるオープンデータに限る。個人の旅行記録などは使わない。
- 使うAIサービスとモデル。分かる範囲で名前と設定を控える。
- 会話の保存方法。下の「会話の取得」から、実際に使えるものを事前に試しておく。
- 画面の撮影方法。`tools/capture.mjs` を使うか、手動で撮るか。

## 1. 工程の区切り

1回の「依頼 → 応答 → 画面の確認」を1工程の目安にします。

- 複数のメッセージ（追加の指示、ツール出力、エラー）を1工程にまとめてよい。
- 各工程に固定の `stepId` を付ける（例 `s07-fix-legend`）。後から工程を並べ替えても変えない。
- ビルドや描画に失敗して画面がない工程は `"status": "error"`、`"capture": null`。エラー出力は `role: "tool"` のメッセージとして残す。
- 失敗した工程に、直前の成功画面を流用しない。
- エラー画面そのものを撮った場合は、`"status": "error"` のまま `capture` を指定してよい。

## 2. 画面の撮影

条件：1200×900 CSS px、deviceScaleFactor=1、同じブラウザとフォント。

自動（推奨）：

```sh
node tools/capture.mjs http://localhost:5173/ fixtures/<id>/captures/s07.png
```

- 読み込み完了、`document.fonts.ready`、`window.__mapReady` を待ってから撮る。地図ページ側で、描画が終わったら `window.__mapReady = true`（または描画完了で解決するPromise）を設定する。MapLibreなら `map.once('idle', …)` で設定する。
- CSSのアニメーションとトランジションを止めて撮る。
- `s07.png.capture.json` に URL、時刻、ブラウザのバージョンを保存する。

手動：Chrome DevTools のデバイスツールバーで 1200×900、DPR 1 にして「スクリーンショットをキャプチャ」。寸法が違うと変換スクリプトが止まる。

## 3. 会話の取得

自動取得が使えるとは仮定しません。使う前に、実際に取り出せるかを確認します。

| 方法 | 確認すること |
| --- | --- |
| 画面からコピーして保存 | 常に使える。工程ごとに `messages/s07-user.md` などへ保存し、`contentFile` で参照する |
| サービスのデータエクスポート | 対象の会話が含まれるか、形式（JSON等）、時刻が残るか |
| CLIツールのローカル記録 | 保存場所と形式、ツール呼び出しやファイル差分が含まれるか |

どの方法でも、`session.source.json` に工程ごとに整理して入れます。

## 4. session.source.json

`fixtures/ui-fixture/session.source.json` を見本にします。本番では `"kind": "production"` にします。

```json
{
  "schemaVersion": 1,
  "id": "production-2026",
  "kind": "production",
  "title": { "en": "…", "ja": "…" },
  "model": { "provider": "…", "name": "…", "notes": "…" },
  "recording": { "en": "…", "ja": "…" },
  "dataSources": [{ "name": { "en": "…", "ja": "…" }, "license": "CC BY 4.0", "url": "https://…" }],
  "steps": [
    {
      "stepId": "s01-base",
      "timestamp": "2026-11-08T01:23:00Z",
      "status": "success",
      "capture": "captures/s01.png",
      "revision": "a1b2c3d",
      "changeSummary": { "en": "…", "ja": "…" },
      "messages": [
        { "role": "user", "contentFile": "messages/s01-user.md" },
        { "role": "assistant", "contentFile": "messages/s01-assistant.md", "model": "…" }
      ]
    }
  ]
}
```

`revision` は、その工程の地図コードのコミットが分かれば記入します。

## 5. 公開前の確認

- APIキー、トークン、メールアドレス、個人名、社内の情報、ローカルのパスを除く。`build_session.py` は代表的なキーの形式とメールアドレスを検出すると止まるが、すべては検出できないので、本文を必ず読んで確認する。
- 伏せた箇所は `[redacted]` と書く。

## 6. 変換と確認

```sh
python tools/build_session.py fixtures/<id> public/sessions/<id>
npm run build
node scripts/verify-browser.mjs <id> --source fixtures/<id>
npm run screenshot -- <stepId> <id>
```

`public/sessions/index.json` の `default` を本番の `id` に変えます。fixture は残しますが、本番と並べて紹介しません。

README の「データ」「モデル情報」「Zarrの役割と限界」の数値を、本番の記録で書き直します。
