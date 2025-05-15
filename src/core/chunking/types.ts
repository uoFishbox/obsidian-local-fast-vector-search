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
