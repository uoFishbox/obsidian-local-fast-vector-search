import { describe, it, expect, beforeEach } from "vitest";
import { MarkdownChunker } from "./MarkdownChunker";
import type { Chunk } from "./types";

describe("MarkdownChunker", () => {
	beforeEach(() => {
		// 各テスト前にキャッシュをクリア
		MarkdownChunker.clearCache();
	});

	describe("基本的なチャンク分割", () => {
		it("空のコンテンツは空の配列を返す", async () => {
			const result = await MarkdownChunker.chunkMarkdown("");
			expect(result).toEqual([]);
		});

		it("空白のみのコンテンツは空の配列を返す", async () => {
			const result = await MarkdownChunker.chunkMarkdown("   \n\n  ");
			expect(result).toEqual([]);
		});

		it("単一の文章を正しくチャンク化する", async () => {
			const content = "これはテストです。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].text).toBe("これはテストです。");
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("複数の文章を適切に結合する", async () => {
			const content = "最初の文です。次の文です。三番目の文です。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			expect(result[0].text).toContain("最初の文です。");
		});
	});

	describe("フロントマター処理", () => {
		it("フロントマターを除去する", async () => {
			const content = `---
title: Test
tags: [test, markdown]
---

これはコンテンツです。`;
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].text).toBe("これはコンテンツです。");
			// フロントマター分のオフセットが考慮されている
			expect(result[0].originalOffsetStart).toBeGreaterThan(30);
		});

		it("フロントマターがない場合も正常に動作する", async () => {
			const content = "通常のテキストです。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].originalOffsetStart).toBe(0);
		});
	});

	describe("URL処理", () => {
		it("URLを除去する", async () => {
			const content = "これは https://example.com のリンクです。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].text).not.toContain("https://");
			expect(result[0].text).toContain("これは");
			expect(result[0].text).toContain("のリンクです。");
		});

		it("複数のURLを除去する", async () => {
			const content =
				"最初のリンク http://example.com と二番目のリンク https://test.com です。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].text).not.toContain("http://");
			expect(result[0].text).not.toContain("https://");
		});
	});

	describe("Markdownテーブル処理", () => {
		it("基本的なテーブルをスペース区切りのテキストに変換する", async () => {
			const content = `| ヘッダー1 | ヘッダー2 |
|---|---|
| 値1 | 値2 |`;
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];
			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("ヘッダー1 ヘッダー2 値1 値2");
			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("ヘッダー区切り行はチャンクに含まれない", async () => {
			const content = `| A | B |\n|:--|--:|\n| 1 | 2 |`;
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];
			expect(chunk.text).not.toContain("---");
			expect(chunk.text).not.toContain(":-");
			expect(chunk.text).not.toContain("-:");
			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("A B 1 2");
			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("テーブルの前後のテキストは保持される", async () => {
			const content = `前の文。
| Col1 | Col2 |
|---|---|
| Val1 | Val2 |
後の文。`;
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];
			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe(
				"前の文。 Col1 Col2 Val1 Val2 後の文。"
			);
			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("セル内の空白はトリムされるように扱われる", async () => {
			const content = "|  spaced a   |   spaced b  |";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];
			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("spaced a spaced b");
			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("テーブルがないMarkdownは影響を受けない", async () => {
			const content = "これは通常の文章です。テーブルはありません。";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			expect(result[0].text).toBe(
				"これは通常の文章です。 テーブルはありません。"
			);
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("オフセットがずれないことを確認する", async () => {
			const prefix = "前置きのテキスト。\n";
			const table = `| a | b |\n|---|---|\n| c | d |`;
			const content = prefix + table;

			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			const chunk = result[0];

			// チャンクがテーブルの内容を含む（スペースで区切られている）
			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toContain("a");
			expect(normalizedText).toContain("b");
			expect(normalizedText).toContain("c");
			expect(normalizedText).toContain("d");

			// オフセットが元のコンテンツと厳密に一致する
			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);

			// チャンクのオフセット範囲から元のテキストを切り出すと、テーブルが含まれている
			const originalSlice = content.substring(
				chunk.originalOffsetStart,
				chunk.originalOffsetEnd
			);
			expect(originalSlice).toBe(content);
		});
	});

	describe("長文の処理", () => {
		it("MAX_CHUNK_SIZEを超える文章を分割する", async () => {
			// 1000文字を超える長い文章
			const longSentence = "あ".repeat(1100) + "。";
			const result = await MarkdownChunker.chunkMarkdown(longSentence);

			// 複数のチャンクに分割される
			expect(result.length).toBeGreaterThan(1);
			// 各チャンクのサイズが適切
			result.forEach((chunk) => {
				expect(chunk.text.length).toBeLessThanOrEqual(1100);
			});
		});

		it("複数の文章が適切にチャンクに配分される", async () => {
			// 各文は短いが、合計で1000文字を超える
			const sentences = Array(20)
				.fill(0)
				.map((_, i) => `これは${i + 1}番目の文章です。`)
				.join("");
			const result = await MarkdownChunker.chunkMarkdown(sentences);

			expect(result.length).toBeGreaterThan(0);
			// 全てのチャンクのテキストを結合すると元のテキストの内容を含む
			const combinedText = result.map((c) => c.text).join(" ");
			expect(combinedText).toContain("1番目の文章です。");
			expect(combinedText).toContain("20番目の文章です。");
		});
	});

	describe("オフセット計算", () => {
		it("正しいオフセット情報を保持する", async () => {
			const content = "最初の文。二番目の文。三番目の文。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			result.forEach((chunk) => {
				// オフセットが有効な範囲内
				expect(chunk.originalOffsetStart).toBeGreaterThanOrEqual(0);
				expect(chunk.originalOffsetEnd).toBeLessThanOrEqual(
					content.length
				);
				expect(chunk.originalOffsetEnd).toBeGreaterThan(
					chunk.originalOffsetStart
				);

				// チャンクテキストが元のコンテンツに含まれる内容であることを確認
				// (チャンク化の過程で文と文の間にスペースが挿入されるため完全一致ではない)
				const words = chunk.text.split(" ");
				words.forEach((word) => {
					if (word.trim()) {
						expect(content).toContain(word.trim());
					}
				});
			});
		});

		it("フロントマター考慮後のオフセットが正しい", async () => {
			const frontmatter = `---
title: Test
---

`;
			const content = "これはテストです。";
			const fullContent = frontmatter + content;
			const result = await MarkdownChunker.chunkMarkdown(fullContent);

			expect(result).toHaveLength(1);
			// フロントマター分のオフセットが加算されている
			expect(result[0].originalOffsetStart).toBe(frontmatter.length);
			expect(result[0].originalOffsetEnd).toBe(fullContent.length);
		});
	});

	describe("キャッシュ機能", () => {
		it("同じコンテンツは2回目以降キャッシュから返される", async () => {
			const content = "キャッシュテスト用の文章です。";

			// 1回目の呼び出し
			const result1 = await MarkdownChunker.chunkMarkdown(content);

			// 2回目の呼び出し（キャッシュから取得）
			const result2 = await MarkdownChunker.chunkMarkdown(content);

			// 結果が同じ
			expect(result1).toEqual(result2);
			// ただし異なるオブジェクト（ディープコピー）
			expect(result1).not.toBe(result2);
		});

		it("異なるコンテンツは別々にキャッシュされる", async () => {
			const content1 = "最初のコンテンツです。";
			const content2 = "二番目のコンテンツです。";

			const result1 = await MarkdownChunker.chunkMarkdown(content1);
			const result2 = await MarkdownChunker.chunkMarkdown(content2);

			expect(result1[0].text).not.toBe(result2[0].text);
		});

		it("clearCache()でキャッシュがクリアされる", async () => {
			const content = "キャッシュクリアテストです。";

			await MarkdownChunker.chunkMarkdown(content);
			MarkdownChunker.clearCache();

			// キャッシュクリア後も正常に動作
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
		});
	});

	describe("Chunk型の検証", () => {
		it("返されるChunkが正しい型構造を持つ", async () => {
			const content = "型チェック用のテストです。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);

			const chunk: Chunk = result[0];
			expect(typeof chunk.text).toBe("string");
			expect(typeof chunk.originalOffsetStart).toBe("number");
			expect(typeof chunk.originalOffsetEnd).toBe("number");
			expect(Array.isArray(chunk.contributingSegmentIds)).toBe(true);
		});
	});

	describe("エッジケース", () => {
		it("改行のみのコンテンツを処理できる", async () => {
			const content = "\n\n\n";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toEqual([]);
		});

		it("特殊文字を含むテキストを処理できる", async () => {
			const content = "特殊文字: !@#$%^&*()_+-=[]{}|;:',.<>?/~`。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			expect(result[0].text).toContain("特殊文字");
		});

		it("日本語、英語、数字の混在テキストを処理できる", async () => {
			const content = "これはTest123です。This is テスト456。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			const allText = result.map((c) => c.text).join(" ");
			expect(allText).toContain("Test123");
			expect(allText).toContain("テスト456");
		});

		it("絵文字を含むテキストを処理できる", async () => {
			const content = "これはテストです🎉✨。絵文字を含みます😊。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe("引用ブロックとコールアウトの処理", () => {
		it("基本的な引用ブロックをパースし、オフセットを維持する", async () => {
			const content = "> これは引用です。";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			expect(result[0].text.trim()).toBe("これは引用です。");
			// "> "を含まない
			expect(result[0].text.startsWith("> ")).toBe(false);
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("複数行の引用ブロックを結合してパースする", async () => {
			const content = "> 最初の行。\n> 二番目の行。";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const normalizedText = result[0].text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("最初の行。 二番目の行。");
			// "> "を含まない
			expect(result[0].text.startsWith("> ")).toBe(false);
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("基本的なコールアウトをパースし、オフセットを維持する", async () => {
			const content = "> [!NOTE] Title\n> Contents";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const normalizedText = result[0].text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("Title Contents");
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("ハイフンを含むコールアウトタイプをパースする", async () => {
			const content = "> [!info-box] Custom Title\n> Details here.";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const normalizedText = result[0].text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("Custom Title Details here.");
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("入れ子の引用ブロックをパースする", async () => {
			const content = ">> 入れ子の引用です。";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			expect(result[0].text.trim()).toBe("入れ子の引用です。");
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("引用符やコールアウトがないテキストは影響を受けない", async () => {
			const content =
				"これは通常のテキストです。 > や [!NOTE] はありません。";
			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			expect(result[0].text).toBe(
				"これは通常のテキストです。 > や [!NOTE] はありません。"
			);
		});

		it("オフセットがずれないことを厳密に確認する", async () => {
			const prefix = "前の文章。\n";
			const callout = "> [!IMPORTANT] 重要\n> これは重要な情報です。";
			const suffix = "\n後の文章。";
			const content = prefix + callout + suffix;

			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];

			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe(
				"前の文章。 重要 これは重要な情報です。 後の文章。"
			);

			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);

			const originalSlice = content.substring(
				chunk.originalOffsetStart,
				chunk.originalOffsetEnd
			);
			expect(originalSlice).toBe(content);
		});
	});

	describe("画像埋め込みリンクの処理", () => {
		it("基本的な画像リンクを除去し、オフセットを維持する", async () => {
			const content =
				"これはテキストです。![alt text](image.png)続きのテキスト。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			const chunk = result[0];

			expect(chunk.text).not.toContain("![alt text](image.png)");

			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe(
				"これはテキストです。 続きのテキスト。"
			);

			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("X.com のような埋め込みリンクも除去する", async () => {
			const content =
				"ツイートです。![x.com](https://x.com/imay3927/status/1880436093478375604)続き。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			const chunk = result[0];

			expect(chunk.text).not.toContain("![x.com]");

			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("ツイートです。 続き。");

			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("複数の画像リンクを処理する", async () => {
			const content = "![img1](1.png) テキスト ![img2](2.png)";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			const chunk = result[0];

			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("テキスト");

			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);
		});

		it("画像リンクがないテキストは影響を受けない", async () => {
			const content = "これは画像リンクのない普通のテキストです。";
			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result).toHaveLength(1);
			expect(result[0].text).toBe(
				"これは画像リンクのない普通のテキストです。"
			);
			expect(result[0].originalOffsetStart).toBe(0);
			expect(result[0].originalOffsetEnd).toBe(content.length);
		});

		it("オフセットがずれないことを厳密に確認する", async () => {
			const prefix = "前の文章。\n";
			const imageLink = "![alt text|100](path/to/image.png)";
			const suffix = "\n後の文章。";
			const content = prefix + imageLink + suffix;

			const result = await MarkdownChunker.chunkMarkdown(content);
			expect(result).toHaveLength(1);
			const chunk = result[0];

			const normalizedText = chunk.text
				.split(/\s+/)
				.filter((w) => w)
				.join(" ");
			expect(normalizedText).toBe("前の文章。 後の文章。");

			expect(chunk.originalOffsetStart).toBe(0);
			expect(chunk.originalOffsetEnd).toBe(content.length);

			const originalSlice = content.substring(
				chunk.originalOffsetStart,
				chunk.originalOffsetEnd
			);
			expect(originalSlice).toBe(content);
		});
	});

	describe("実践的なMarkdownコンテンツ", () => {
		it("見出しを含むMarkdownを処理できる", async () => {
			const content = `# タイトル

## セクション1
これは最初のセクションです。

## セクション2
これは二番目のセクションです。`;

			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			const allText = result.map((c) => c.text).join(" ");
			expect(allText).toContain("タイトル");
			expect(allText).toContain("セクション1");
			expect(allText).toContain("セクション2");
		});

		it("リストを含むMarkdownを処理できる", async () => {
			const content = `リスト項目:
- 項目1
- 項目2
- 項目3`;

			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
			const allText = result.map((c) => c.text).join(" ");
			expect(allText).toContain("項目1");
			expect(allText).toContain("項目2");
			expect(allText).toContain("項目3");
		});

		it("コードブロックを含むMarkdownを処理できる", async () => {
			const content = `説明文です。

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`

続きの文章です。`;

			const result = await MarkdownChunker.chunkMarkdown(content);

			expect(result.length).toBeGreaterThan(0);
		});
	});
});
