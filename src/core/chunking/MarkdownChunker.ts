import {
	split as splitSentencesInternal,
	SentenceSplitterSyntax,
} from "sentence-splitter";
import type { Chunk } from "./types";
import {
	MAX_CHUNK_SIZE,
	MAX_SENTENCE_CHARS,
	MIN_SENTENCE_CHARS,
} from "../../shared/constants/appConstants";

interface SentenceWithOffset {
	text: string;
	startOffset: number;
	endOffset: number;
	rawStartOffset: number;
	rawEndOffset: number;
}

interface CacheEntry {
	chunks: Chunk[];
	timestamp: number;
}

export class MarkdownChunker {
	private static cache = new Map<string, CacheEntry>();
	private static readonly MAX_CACHE_SIZE = 100;
	private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5分

	private static async computeHash(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	private static cleanupCache(): void {
		const now = Date.now();
		const entriesToDelete: string[] = [];

		for (const [hash, entry] of this.cache.entries()) {
			if (now - entry.timestamp > this.CACHE_TTL_MS) {
				entriesToDelete.push(hash);
			}
		}

		entriesToDelete.forEach((hash) => this.cache.delete(hash));

		// キャッシュサイズ制限を超えた場合、古いエントリーから削除
		if (this.cache.size > this.MAX_CACHE_SIZE) {
			const sortedEntries = Array.from(this.cache.entries()).sort(
				(a, b) => a[1].timestamp - b[1].timestamp
			);
			const deleteCount = this.cache.size - this.MAX_CACHE_SIZE;
			for (let i = 0; i < deleteCount; i++) {
				this.cache.delete(sortedEntries[i][0]);
			}
		}
	}

	public static clearCache(): void {
		this.cache.clear();
	}

	public static async chunkMarkdown(noteContent: string): Promise<Chunk[]> {
		const { hash, chunks: cachedChunks } = await this.tryGetCachedChunks(
			noteContent
		);
		if (cachedChunks) {
			return cachedChunks;
		}

		const { processedText, frontmatterLength } =
			this.removeFrontmatter(noteContent);
		const sanitizedText = this.sanitizeMarkdown(processedText);
		if (!sanitizedText.trim()) {
			return [];
		}

		const sentences = this.splitIntoSentences(sanitizedText);
		const chunks = this.buildChunks(sentences, frontmatterLength);

		this.storeChunksInCache(hash, chunks);
		return chunks;
	}

	private static async tryGetCachedChunks(
		content: string
	): Promise<{ hash: string; chunks: Chunk[] | null }> {
		const hash = await this.computeHash(content);
		const entry = this.cache.get(hash);
		if (!entry) {
			return { hash, chunks: null };
		}
		const now = Date.now();
		if (now - entry.timestamp > this.CACHE_TTL_MS) {
			return { hash, chunks: null };
		}
		return { hash, chunks: this.cloneChunks(entry.chunks) };
	}

	private static sanitizeMarkdown(text: string): string {
		const withoutTables = this.preprocessMarkdownTables(text);
		return this.removeUrls(withoutTables);
	}

	private static buildChunks(
		sentences: SentenceWithOffset[],
		frontmatterLength: number
	): Chunk[] {
		const chunks: Chunk[] = [];
		let currentChunk = "";
		let chunkStartRaw = -1;
		let chunkEndRaw = -1;

		const flushCurrentChunk = () => {
			if (!currentChunk) {
				return;
			}
			chunks.push(
				this.createChunk(currentChunk, chunkStartRaw, chunkEndRaw)
			);
			currentChunk = "";
			chunkStartRaw = -1;
			chunkEndRaw = -1;
		};

		for (const sentence of sentences) {
			const sentenceStartRaw =
				frontmatterLength + sentence.rawStartOffset;
			const sentenceEndRaw = frontmatterLength + sentence.rawEndOffset;

			if (sentence.text.length > MAX_CHUNK_SIZE) {
				flushCurrentChunk();
				chunks.push(
					this.createChunk(
						sentence.text,
						sentenceStartRaw,
						sentenceEndRaw
					)
				);
				continue;
			}

			const mergedText = currentChunk
				? `${currentChunk} ${sentence.text}`
				: sentence.text;
			if (mergedText.length <= MAX_CHUNK_SIZE) {
				currentChunk = mergedText;
				if (chunkStartRaw === -1) {
					chunkStartRaw = sentenceStartRaw;
				}
				chunkEndRaw = sentenceEndRaw;
				continue;
			}

			flushCurrentChunk();
			currentChunk = sentence.text;
			chunkStartRaw = sentenceStartRaw;
			chunkEndRaw = sentenceEndRaw;
		}

		flushCurrentChunk();
		return chunks;
	}

	private static storeChunksInCache(hash: string, chunks: Chunk[]): void {
		this.cache.set(hash, {
			chunks: this.cloneChunks(chunks),
			timestamp: Date.now(),
		});
		this.cleanupCache();
	}

	private static cloneChunks(chunks: Chunk[]): Chunk[] {
		return chunks.map((chunk) => ({
			text: chunk.text,
			originalOffsetStart: chunk.originalOffsetStart,
			originalOffsetEnd: chunk.originalOffsetEnd,
			contributingSegmentIds: chunk.contributingSegmentIds
				? [...chunk.contributingSegmentIds]
				: [],
		}));
	}

	private static createChunk(
		text: string,
		startRaw: number,
		endRaw: number
	): Chunk {
		return {
			text,
			originalOffsetStart: startRaw,
			originalOffsetEnd: endRaw,
			contributingSegmentIds: [],
		};
	}

	private static preprocessMarkdownTables(text: string): string {
		const lines = text.split("\n");
		const processedLines = lines.map((line) => {
			// テーブル行かどうかを簡易的にチェック (e.g., "| a | b |")
			if (!/^\s*\|.*\|\s*$/.test(line)) {
				return line;
			}

			// ヘッダー区切り行 (e.g., "|---|:--:|--|") は空白で埋める
			if (/^\s*\|(?:\s*:?-+:?\s*\|)+/.test(line)) {
				return " ".repeat(line.length);
			}

			// 通常のテーブル行: '|' をスペースに置換して、内容を擬似的に抽出
			return line.replace(/\|/g, " ");
		});
		return processedLines.join("\n");
	}

	private static removeUrls(text: string): string {
		// http:// または https:// で始まるURLを空白で置換
		const URL_REGEX = /https?:\/\/[^\s\)>\]]+/g;
		return text.replace(URL_REGEX, (match) => " ".repeat(match.length));
	}

	private static removeFrontmatter(text: string): {
		processedText: string;
		frontmatterLength: number;
	} {
		const FRONTMATTER_REGEX =
			/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]+/;
		const fmMatch = text.match(FRONTMATTER_REGEX);

		if (fmMatch) {
			return {
				processedText: text.substring(fmMatch[0].length),
				frontmatterLength: fmMatch[0].length,
			};
		}

		return { processedText: text, frontmatterLength: 0 };
	}

	private static splitIntoSentences(text: string): SentenceWithOffset[] {
		const nodes = splitSentencesInternal(text);
		const results: SentenceWithOffset[] = [];
		for (const node of nodes) {
			if (!node || node.type !== SentenceSplitterSyntax.Sentence) {
				continue;
			}
			const range = node.range;
			if (!range || range.length !== 2) {
				continue;
			}
			const [rangeStart, rangeEnd] = range;
			if (
				typeof rangeStart !== "number" ||
				typeof rangeEnd !== "number" ||
				rangeEnd <= rangeStart
			) {
				continue;
			}
			let expandedRangeStart = rangeStart;
			while (expandedRangeStart > 0) {
				const prevChar = text.charAt(expandedRangeStart - 1);
				if (prevChar === "\n" || prevChar === "\r") {
					break;
				}
				if (prevChar !== " " && prevChar !== "\t") {
					break;
				}
				expandedRangeStart--;
			}
			const rawSentence = text.slice(expandedRangeStart, rangeEnd);
			const trimmedLeading =
				rawSentence.length - rawSentence.trimStart().length;
			const trimmedTrailing =
				rawSentence.length - rawSentence.trimEnd().length;
			const trimmedSentence = rawSentence.slice(
				trimmedLeading,
				trimmedTrailing > 0 ? -trimmedTrailing : undefined
			);
			if (!trimmedSentence) {
				continue;
			}
			const baseStartOffset = expandedRangeStart + trimmedLeading;
			// 長すぎる文はさらに分割
			if (trimmedSentence.length > MAX_SENTENCE_CHARS) {
				this.splitSentenceByMaxLength(
					trimmedSentence,
					baseStartOffset,
					expandedRangeStart,
					rangeEnd,
					results
				);
			} else {
				results.push({
					text: trimmedSentence,
					startOffset: baseStartOffset,
					endOffset: baseStartOffset + trimmedSentence.length,
					rawStartOffset: expandedRangeStart,
					rawEndOffset: rangeEnd,
				});
			}
		}
		return results;
	}

	private static splitSentenceByMaxLength(
		sentenceText: string,
		baseStartOffset: number,
		baseRawStartOffset: number,
		rangeEnd: number,
		output: SentenceWithOffset[]
	): void {
		let cursor = 0;
		while (cursor < sentenceText.length) {
			let segmentEnd = Math.min(
				cursor + MAX_SENTENCE_CHARS,
				sentenceText.length
			);
			if (segmentEnd < sentenceText.length) {
				segmentEnd = this.findSplitIndex(
					sentenceText,
					cursor,
					segmentEnd
				);
			}
			segmentEnd = Math.max(segmentEnd, cursor + MIN_SENTENCE_CHARS);
			const segmentRaw = sentenceText.slice(cursor, segmentEnd);
			const trimmedLeading =
				segmentRaw.length - segmentRaw.trimStart().length;
			const trimmedTrailing =
				segmentRaw.length - segmentRaw.trimEnd().length;
			const segmentText = segmentRaw.slice(
				trimmedLeading,
				trimmedTrailing > 0 ? -trimmedTrailing : undefined
			);
			if (segmentText.length > 0) {
				const segmentStartOffset =
					baseStartOffset + cursor + trimmedLeading;
				const segmentEndOffset =
					segmentStartOffset + segmentText.length;
				const segmentRawStartOffset =
					cursor === 0
						? baseRawStartOffset
						: baseStartOffset + cursor;
				const segmentRawEndOffset = (() => {
					const calculated =
						baseStartOffset + cursor + segmentRaw.length;
					const isLastSegment = segmentEnd >= sentenceText.length;
					return isLastSegment ? rangeEnd : calculated;
				})();
				output.push({
					text: segmentText,
					startOffset: segmentStartOffset,
					endOffset: segmentEndOffset,
					rawStartOffset: segmentRawStartOffset,
					rawEndOffset: Math.min(segmentRawEndOffset, rangeEnd),
				});
			}
			cursor = segmentEnd;
		}
	}

	private static findSplitIndex(
		text: string,
		cursor: number,
		preferredEnd: number
	): number {
		for (let i = preferredEnd; i > cursor; i--) {
			if (i - cursor < MIN_SENTENCE_CHARS) {
				continue;
			}
			const char = text.charAt(i - 1);
			if (this.isPreferredSplitCharacter(char)) {
				return i;
			}
		}
		return Math.max(cursor + MIN_SENTENCE_CHARS, preferredEnd);
	}

	private static isPreferredSplitCharacter(char: string): boolean {
		if (!char) {
			return false;
		}
		return /\s/.test(char) || "。、，．,.!?！？；：".includes(char);
	}
}
