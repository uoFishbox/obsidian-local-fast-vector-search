# Local Fast Vector Search Plugin

## 概要

[Obsidian](https://obsidian.md/) 内で [StaticEmbedding モデル](https://huggingface.co/blog/static-embeddings) を推論し、ノートのベクトル化・ベクトル検索や関連ノートのサジェストを高速に行うプラグインです。ミドルレンジ程度の CPU 性能でも比較的軽快に動作します。 Windows, Android, iOS [^1] 環境で動作確認済みです。

このプラグインでは、ベクトル化に用いるテキスト埋め込みモデルとして、日本語に特化した StaticEmbedding モデルである [`hotchpotch/static-embedding-japanese`](https://huggingface.co/hotchpotch/static-embedding-japanese) を利用しています。 [^2]

## 機能

### 関連チャンクの表示 (Related chuks view)

右側のリーフ上に、現在アクティブなノートと関連性の高いチャンクが類似度順に表示されます。

### セマンティック検索 (Search similar notes)

に入力した単語と関連性の高いチャンクが類似度順に表示されます。

**実験的機能：ベクトルの減算**
検索クエリから特定の要素を除く、といった高度な検索が可能です。(例: "料理レシピ -中華風" で中華要素の少ない料理レシピを検索)

> [!NOTE]
> モデルが事前に学習した語彙の範囲外にある専門用語や固有名詞が多いと、分野によっては十分な精度が得られない場合があります。 単語レベルの検索ではその影響を受けやすくなることにご注意ください。

## ダウンロードとセットアップ

1. [BRAT](https://github.com/TfTHacker/obsidian42-brat) に `https://github.com/uoFishbox/obsidian-local-fast-vector-search` を追加してダウンロード。
2. 有効化後に表示されるモーダル上の `Start indexing` を選択。
3. 初回のみ、必要なリソースのダウンロードが開始。ダウンロード完了後、Obsidian が自動でリスタートし、すべてのノートのインデックス作成がバックグラウンドで開始。
4. `Index rebuild process completed successfully!` の通知の表示でインデックス作成が完了。

> [!Warning]
>  **iOS デバイスでの注意**
> 
> iOS デバイスでは、[Self-hosted LiveSync プラグイン](https://github.com/vrtmrz/obsidian-livesync) が先に起動している場合、モデルのロードができない現象が発生しています。詳細は現在調査中ですが、以下の方法でエラーを回避することができます。
>
> -   **初回インデックス作成時**
>     -   一時的に Self-hosted livesync プラグインを無効化してから `rebuild` を行う
> -   **次回以降起動時**
>     -   [Lazy Plugin Loader](https://github.com/alangrainger/obsidian-lazy-plugins) を利用し、Self-hosted livesync プラグインの起動を 0.5 秒程度遅延させ、Local fast vector search プラグインの起動を `instant` にする

[^1]: **iOS デバイスでの注意**を参照
[^2]: `hotchpotch/static-embedding-japanese` を `transformers.js` で[すぐに扱えるように整理を行いました。](https://huggingface.co/cfsdwe/static-embedding-japanese-ONNX-for-js)


