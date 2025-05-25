import { ChunkInfo, ChunkingOptions } from "./types";

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
	chunkSize: 1024,
	removeFrontmatter: true,
};

export class TextChunker {
	private options: ChunkingOptions;

	constructor(options: Partial<ChunkingOptions> = {}) {
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

		const chunks: ChunkInfo[] = [];
		const fileName = this.extractTitleFromPath(filePath);

		for (let i = 0; i < processedText.length; i += this.options.chunkSize) {
			const chunkContent = processedText.substring(
				i,
				i + this.options.chunkSize
			);
			if (chunkContent.length > 0) {
				chunks.push({
					chunk: `${fileName}: ${chunkContent}`,
					metadata: {
						filePath: filePath || "",
						startPosition: frontmatterLength + i,
						endPosition:
							frontmatterLength + i + chunkContent.length,
						createdAt: new Date(),
					},
				});
			}
		}
		return chunks;
	}

	private extractTitleFromPath(filePath?: string): string {
		if (!filePath) return "";
		const fileName = filePath.split(/[/\\]/).pop();
		if (!fileName) return "";
		const titleMatch = fileName.match(/^(.*)\.[^.]+$/);
		return titleMatch ? titleMatch[1] : fileName; // 拡張子がない場合はファイル名全体を返す
	}
}
