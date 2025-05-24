export interface VectorItem {
	filePath: string;
	chunkOffsetStart: number;
	chunkOffsetEnd: number;
	vector: number[];
	chunk: string;
}

export interface SimilarityResultItem {
	id: number;
	file_path: string;
	chunk_offset_start: number | null;
	chunk_offset_end: number | null;
	chunk: string | null;
	distance: number;
}

export interface SearchOptions {
	efSearch?: number;
	limit?: number;
	excludeFilePaths?: string[];
}

export interface ChunkInfo {
	filePath: string;
	chunkOffsetStart: number;
	chunkOffsetEnd: number;
	text: string;
}
