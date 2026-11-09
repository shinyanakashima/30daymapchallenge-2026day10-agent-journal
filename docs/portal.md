# ポータル掲載用の説明

ポータル（`shinyanakashima/30daymapchallenge`）の `public/data/2026/works.json` の Day 10 に追加する内容の案です。題材が決まるまでは `status` を `building` とし、本番の記録を公開してから `published` に変えます。題名と説明の「題材」部分は、題材が決まってから書き足します。

## 日本語

- 題名：Map Rewind
- 説明：AIとの対話で地図を作り、工程ごとの画面とプロンプト・応答をタイムラインで再生する。失敗した工程も含めて振り返れる。工程ごとの画面を層として積み上げ、各工程で変わった部分を立体的に見ることもできる。記録はブラウザの中でGitにコミットし、Zarrもブラウザで作る。
- 画像の代替テキスト：Map Rewindの画面
- タグ：Zarr、3D、AI

## English

- Title: Map Rewind
- Description: A map made by talking to an AI, replayed step by step with the screen, prompt and response at each step, failed attempts included. The screens can also be stacked as layers, showing what changed at each step. Each step is a Git commit made in the browser, and the Zarr array is built there too.
- Thumbnail alt: Screenshot of Map Rewind
- Tags: Zarr, 3D, AI

## works.json の projects 案

```json
{
  "id": "map-rewind",
  "title": "Map Rewind",
  "description": "AIとの対話で地図を作り、工程ごとの画面とプロンプト・応答をタイムラインで再生する。失敗した工程も含めて振り返れる。工程ごとの画面を層として積み上げ、各工程で変わった部分を立体的に見ることもできる。記録はブラウザの中でGitにコミットし、Zarrもブラウザで作る。",
  "status": "building",
  "thumbnail": "images/2026/works/map-rewind.jpg",
  "thumbnailAlt": "Map Rewindの画面",
  "appUrl": "https://shinyanakashima.github.io/30daymapchallenge-2026day10-agent-journal/",
  "repoUrl": "https://github.com/shinyanakashima/30daymapchallenge-2026day10-agent-journal",
  "articleUrl": null,
  "videoUrl": null,
  "tags": ["Zarr", "3D", "AI"],
  "publishedAt": null,
  "updatedAt": "2026-11-06",
  "en": {
    "title": "Map Rewind",
    "description": "A map made by talking to an AI, replayed step by step with the screen, prompt and response at each step, failed attempts included. The screens can also be stacked as layers, showing what changed at each step. Each step is a Git commit made in the browser, and the Zarr array is built there too.",
    "tags": ["Zarr", "3D", "AI"],
    "thumbnailAlt": "Screenshot of Map Rewind"
  }
}
```

サムネイルは本番の記録で `docs/screenshot-layers.png`（積層表示）を撮り直してから作る案です。現在の画面画像は UI確認用fixture のものです。
