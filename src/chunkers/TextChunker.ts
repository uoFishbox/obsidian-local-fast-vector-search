export interface ChunkMetadata {
	filePath: string;
	startPosition: number;
	endPosition: number;
	createdAt: Date;
	tags?: string[];
}

export interface ChunkInfo {
	chunk: string;
	metadata: ChunkMetadata;
}

export interface ChunkingOptions {
	chunkSize?: number; // サイズベースチャンキング時の目標チャンクサイズ（文字数）
	minChunkSize?: number; // サイズベースチャンキング時の最小チャンクサイズ（文字数）
	removeFrontmatter?: boolean; // フロントマターを削除するかどうか
	sentenceBasedChunking?: boolean; // 文ベースのチャンキングを有効にするか
	sentencesPerChunk?: number; // 文ベースチャンキング時の1チャンクあたりの文の数
	sentenceJoiner?: string; // 文ベースチャンキング時に文を結合する文字列
}

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
	chunkSize: 200,
	minChunkSize: 50,
	removeFrontmatter: true,
	sentenceBasedChunking: true,
	sentencesPerChunk: 3,
	sentenceJoiner: "",
};

// 文分割の結果を保持するインターフェース
interface SentenceInfo {
	text: string; // 文のテキスト内容
	start: number; // 元のテキストにおける開始位置
	end: number; // 元のテキストにおける終了位置
}

export class TextChunker {
	private options: ChunkingOptions;

	constructor(options: ChunkingOptions = {}) {
		this.options = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
	}

	// フロントマターを削除する（オプション）
	private removeFrontmatterIfExists(text: string): {
		processedText: string;
		frontmatterLength: number;
	} {
		if (this.options.removeFrontmatter) {
			const fmMatch = text.match(
				/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]+/
			);
			if (fmMatch) {
				return {
					processedText: text.substring(fmMatch[0].length),
					frontmatterLength: fmMatch[0].length,
				};
			}
		}
		return { processedText: text, frontmatterLength: 0 };
	}

	public chunkText(text: string, filePath?: string): ChunkInfo[] {
		if (!text) {
			return [];
		}

		const { processedText, frontmatterLength } =
			this.removeFrontmatterIfExists(text);

		if (!processedText.trim()) {
			return [];
		}

		const chunks = this.options.sentenceBasedChunking
			? this.chunkBySentences(processedText, filePath, frontmatterLength)
			: this.chunkBySize(processedText, filePath, frontmatterLength);

		return chunks;
	}

	// サイズベースでチャンキングを行うメソッド
	private chunkBySize(
		text: string,
		filePath?: string,
		offset: number = 0
	): ChunkInfo[] {
		const chunks: ChunkInfo[] = [];
		const chunkSize = this.options.chunkSize!;
		const minChunkSize = this.options.minChunkSize!;

		let remainingText = text;
		let currentAbsoluteCursor = offset; // 元のテキスト（フロントマター削除後）における現在のカーソル位置

		while (remainingText.length > 0) {
			const leadingSpacesLength =
				remainingText.length - remainingText.trimStart().length;
			const effectiveText = remainingText.trimStart();
			const currentChunkEffectiveStart =
				currentAbsoluteCursor + leadingSpacesLength;

			if (effectiveText.length === 0) break; // 残りが空白文字のみなら終了

			// テキストがチャンクサイズ以下なら全て追加して終了
			if (effectiveText.length <= chunkSize) {
				chunks.push({
					chunk: effectiveText,
					metadata: {
						filePath: filePath || "",
						startPosition: currentChunkEffectiveStart,
						endPosition:
							currentChunkEffectiveStart + effectiveText.length,
						createdAt: new Date(),
					},
				});
				break;
			}

			let splitPointInEffectiveText: number; // effectiveText 内での分割ポイント（長さ）

			// 探索対象の文字列 (最大 chunkSize)
			const chunkToSearchIn = effectiveText.substring(0, chunkSize);

			// 条件1: chunkSizeで区切ると残りがminChunkSize未満になる場合
			if (effectiveText.length - chunkSize < minChunkSize) {
				// chunkSizeより手前で、残りがminChunkSizeを満たすように区切れるか探す
				let preferredSplitPoint = this.findSentenceEnd(
					chunkToSearchIn, // chunkSize までの範囲で探す
					minChunkSize,
					effectiveText.length // 分割前の effectiveText 全体の長さ
				);

				if (
					preferredSplitPoint > 0 &&
					effectiveText.length - preferredSplitPoint >= minChunkSize
				) {
					splitPointInEffectiveText = preferredSplitPoint;
				} else {
					// 適切な区切りが見つからない、または区切ると残りが小さすぎる場合は、effectiveText 全体をチャンクに
					splitPointInEffectiveText = effectiveText.length;
				}
			} else {
				// 通常ケース: chunkSize 付近で最適な分割ポイントを探す
				splitPointInEffectiveText = this.findSentenceEnd(
					chunkToSearchIn,
					minChunkSize,
					effectiveText.length
				);

				if (splitPointInEffectiveText <= 0) {
					// 適切な区切りが見つからなかった
					splitPointInEffectiveText = chunkSize; // chunkSize で強制分割
				}
			}

			const rawChunkContent = effectiveText.substring(
				0,
				splitPointInEffectiveText
			);
			const finalChunkContent = rawChunkContent.trim(); // チャンク末尾の空白も除去

			if (finalChunkContent.length > 0) {
				// チャンク先頭の空白を考慮して開始位置を調整
				const chunkStartOffsetInRaw = rawChunkContent.indexOf(
					finalChunkContent[0] || ""
				);
				const actualChunkStart =
					currentChunkEffectiveStart +
					(chunkStartOffsetInRaw === -1 ? 0 : chunkStartOffsetInRaw);

				chunks.push({
					chunk: finalChunkContent,
					metadata: {
						filePath: filePath || "",
						startPosition: actualChunkStart,
						endPosition:
							actualChunkStart + finalChunkContent.length,
						createdAt: new Date(),
					},
				});
			}

			currentAbsoluteCursor +=
				leadingSpacesLength + splitPointInEffectiveText;
			remainingText = effectiveText.substring(splitPointInEffectiveText);
		}

		return chunks.filter((chunkInfo) => chunkInfo.chunk.length > 0);
	}

	private findSentenceEnd(
		chunkToSearch: string,
		minSizeForRemaining: number,
		originalEffectiveTextLength: number
	): number {
		let bestSplitLength = 0;

		// 優先順位1: 改行
		for (let i = chunkToSearch.length - 1; i >= 0; i--) {
			if (chunkToSearch[i] === "\n") {
				const potentialSplitLength = i + 1; // 改行文字を含む長さ
				if (
					originalEffectiveTextLength - potentialSplitLength >=
					minSizeForRemaining
				) {
					bestSplitLength = Math.max(
						bestSplitLength,
						potentialSplitLength
					);
				}
			}
		}
		if (bestSplitLength > 0) return bestSplitLength; // 改行で見つかればそれを最優先

		// 優先順位2: 文末記号 (。！？)
		const sentenceEnders = ["。", "！", "？"];
		for (let i = chunkToSearch.length - 1; i >= 0; i--) {
			if (sentenceEnders.includes(chunkToSearch[i])) {
				const potentialSplitLength = i + 1; // 文末記号を含む長さ
				if (
					originalEffectiveTextLength - potentialSplitLength >=
					minSizeForRemaining
				) {
					bestSplitLength = Math.max(
						bestSplitLength,
						potentialSplitLength
					);
				}
			}
		}
		if (bestSplitLength > 0) return bestSplitLength;

		// 優先順位3: 読点 (、) - 他に区切りがない場合のフォールバック
		// あまり短いチャンクにならないように、例えば chunkToSearch の半分程度の長さは確保する
		const minAcceptableSplitLengthForComma = Math.max(
			1,
			Math.floor(chunkToSearch.length * 0.5)
		);
		for (let i = chunkToSearch.length - 1; i >= 0; i--) {
			if (chunkToSearch[i] === "、") {
				const potentialSplitLength = i + 1; // 読点を含む長さ
				if (
					potentialSplitLength >= minAcceptableSplitLengthForComma &&
					originalEffectiveTextLength - potentialSplitLength >=
						minSizeForRemaining
				) {
					bestSplitLength = Math.max(
						bestSplitLength,
						potentialSplitLength
					);
				}
			}
		}
		return bestSplitLength; // 読点で見つかったもの、または0
	}

	// 文ベースでチャンキングを行うメソッド
	private chunkBySentences(
		text: string,
		filePath?: string,
		offset: number = 0
	): ChunkInfo[] {
		const sentencesPerChunk = this.options.sentencesPerChunk!;
		const sentenceJoiner = this.options.sentenceJoiner!;
		const sentenceInfos = this.splitToSentences(text, offset);
		const chunks: ChunkInfo[] = [];

		if (sentenceInfos.length === 0) return [];

		// 文の数が指定数以下なら、全てを1つのチャンクにまとめる
		if (sentenceInfos.length <= sentencesPerChunk) {
			const combinedText = sentenceInfos
				.map((s) => s.text)
				.join(sentenceJoiner);
			if (combinedText.trim().length > 0) {
				return [
					{
						chunk: combinedText,
						metadata: {
							filePath: filePath || "",
							startPosition: sentenceInfos[0].start,
							endPosition:
								sentenceInfos[sentenceInfos.length - 1].end,
							createdAt: new Date(),
						},
					},
				];
			}
			return [];
		}

		// 指定された数の文ごとにチャンクを作成
		for (let i = 0; i < sentenceInfos.length; i += sentencesPerChunk) {
			const sentenceGroup = sentenceInfos.slice(i, i + sentencesPerChunk);
			if (sentenceGroup.length > 0) {
				const chunkText = sentenceGroup
					.map((s) => s.text)
					.join(sentenceJoiner);
				if (chunkText.trim().length > 0) {
					chunks.push({
						chunk: chunkText,
						metadata: {
							filePath: filePath || "",
							startPosition: sentenceGroup[0].start,
							endPosition:
								sentenceGroup[sentenceGroup.length - 1].end,
							createdAt: new Date(),
						},
					});
				}
			}
		}
		return chunks;
	}

	// 文章を文に分割するメソッド (日本語向けに改善)
	// offset は、元のテキスト（フロントマター削除前）に対する text の開始オフセット
	private splitToSentences(text: string, offset: number = 0): SentenceInfo[] {
		if (!text.trim()) return [];
		const sentences: SentenceInfo[] = [];
		let sentenceStartIndexInText = 0; // text 内での現在の文の開始インデックス

		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			let isEndOfSentence = false;

			if (["。", "！", "？"].includes(char)) {
				isEndOfSentence = true;
			} else if (char === "\n") {
				// 改行の場合も文の区切りとする
				isEndOfSentence = true;
			}

			// テキストの末尾の場合も現在の文を処理
			if (isEndOfSentence || i === text.length - 1) {
				const currentSentenceEndIndexInText = i;
				// 文の範囲は sentenceStartIndexInText から currentSentenceEndIndexInText (文末記号を含む) まで
				const rawSentence = text.substring(
					sentenceStartIndexInText,
					currentSentenceEndIndexInText + 1
				);
				const trimmedSentence = rawSentence.trim();

				if (trimmedSentence.length > 0) {
					// 元のテキストにおける trimmedSentence の正確な開始位置を計算
					const offsetInRaw = rawSentence.indexOf(trimmedSentence);
					const actualStartInOriginal =
						offset + sentenceStartIndexInText + offsetInRaw;
					const actualEndInOriginal =
						actualStartInOriginal + trimmedSentence.length;

					sentences.push({
						text: trimmedSentence,
						start: actualStartInOriginal,
						end: actualEndInOriginal,
					});
				}
				sentenceStartIndexInText = currentSentenceEndIndexInText + 1; // 次の文の開始
			}
		}
		return sentences.filter((s) => s.text.length > 0);
	}
}

export function splitTextToSentences(
	text: string,
	filePath?: string
): string[] {
	const sentenceChunker = new TextChunker({ sentencesPerChunk: 3 });
	return sentenceChunker
		.chunkText(text, filePath)
		.map((chunkInfo) => chunkInfo.chunk);
}
