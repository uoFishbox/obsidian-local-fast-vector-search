// ===== Base Types =====
export interface BaseRequest {
	id: string;
	type: string;
}

export interface BaseResponse {
	id: string;
	type: string;
	payload?: any;
}

// ===== Request Types =====
export interface InitializeRequest extends BaseRequest {
	type: "initialize";
	payload?: {
		settings?: any;
	};
}

export interface VectorizeSentencesRequest extends BaseRequest {
	type: "vectorizeSentences";
	payload: {
		sentences: string[];
	};
}

import type {
	ChunkInfo,
	SearchOptions,
	SimilarityResultItem,
} from "../../core/storage/types";

export interface VectorizeAndStoreRequest extends BaseRequest {
	type: "vectorizeAndStore";
	payload: {
		chunks: ChunkInfo[];
	};
}

export interface BulkVectorizeAndLoadRequest extends BaseRequest {
	type: "bulkVectorizeAndLoad";
	payload: {
		chunks: ChunkInfo[];
	};
}

export interface SearchRequest extends BaseRequest {
	type: "search";
	payload: {
		query: string;
		negativeQuery?: string;
		limit?: number;
		options?: SearchOptions;
	};
}

export interface RebuildDbRequest extends BaseRequest {
	type: "rebuildDb";
	payload?: {
		clearExisting?: boolean;
	};
}

export interface EnsureIndexesRequest extends BaseRequest {
	type: "ensureIndexes";
	payload?: {};
}

export interface TestSimilarityRequest extends BaseRequest {
	type: "testSimilarity";
	payload?: any;
}

export interface CloseDbRequest extends BaseRequest {
	type: "closeDb";
	payload?: any;
}

export interface DeleteVectorsByFilePathRequest extends BaseRequest {
	type: "deleteVectorsByFilePath";
	payload: {
		filePath: string;
	};
}

export interface AverageVectorsRequest extends BaseRequest {
	type: "averageVectors";
	payload: {
		vectors: number[][];
	};
}

export interface SearchSimilarByVectorRequest extends BaseRequest {
	type: "searchSimilarByVector";
	payload: {
		vector: number[];
		limit?: number;
		options?: SearchOptions;
	};
}

export interface GetVectorsByFilePathRequest extends BaseRequest {
	type: "getVectorsByFilePath";
	payload: {
		filePath: string;
	};
}

export interface UpdateFilePathRequest extends BaseRequest {
	type: "updateFilePath";
	payload: {
		oldPath: string;
		newPath: string;
	};
}

export type WorkerRequest =
	| InitializeRequest
	| VectorizeSentencesRequest
	| VectorizeAndStoreRequest
	| BulkVectorizeAndLoadRequest
	| SearchRequest
	| RebuildDbRequest
	| EnsureIndexesRequest
	| TestSimilarityRequest
	| CloseDbRequest
	| DeleteVectorsByFilePathRequest
	| AverageVectorsRequest
	| SearchSimilarByVectorRequest
	| GetVectorsByFilePathRequest
	| UpdateFilePathRequest;

// ===== Response Types =====
export interface AverageVectorsResponse extends BaseResponse {
	type: "averageVectorsResult";
	payload: number[];
}

export interface SearchSimilarByVectorResponse extends BaseResponse {
	type: "searchSimilarByVectorResult";
	payload: SimilarityResultItem[];
}

export interface InitializedResponse extends BaseResponse {
	type: "initialized";
	payload: boolean;
}

export interface VectorizeSentencesResponse extends BaseResponse {
	type: "vectorizeSentencesResult";
	payload: number[][];
}

export interface VectorizeAndStoreResponse extends BaseResponse {
	type: "vectorizeAndStoreResponse";
	payload: {
		count: number;
	};
}

export interface BulkVectorizeAndLoadResponse extends BaseResponse {
	type: "bulkVectorizeAndLoadResponse";
	payload: {
		count: number;
	};
}

export interface SearchResult extends BaseResponse {
	type: "searchResult";
	payload: SimilarityResultItem[];
}

export interface RebuildDbResponse extends BaseResponse {
	type: "rebuildDbResponse";
	payload: boolean;
}

export interface EnsureIndexesResponse extends BaseResponse {
	type: "ensureIndexesResponse";
	payload: {
		success: boolean;
		message?: string;
	};
}

export interface TestSimilarityResponse extends BaseResponse {
	type: "testSimilarityResponse";
	payload: string;
}

export interface DbClosedResponse extends BaseResponse {
	type: "dbClosedResponse";
	payload: boolean;
}

export interface DeleteVectorsByFilePathResponse extends BaseResponse {
	type: "deleteVectorsByFilePathResponse";
	payload: {
		count: number;
	};
}

export interface GetVectorsByFilePathResponse extends BaseResponse {
	type: "getVectorsByFilePathResult";
	payload: number[][];
}

export interface UpdateFilePathResponse extends BaseResponse {
	type: "updateFilePathResponse";
	payload: {
		count: number;
	};
}

export interface ErrorResponse extends BaseResponse {
	type: "errorResponse";
	payload: string;
}

export interface StatusResponse extends BaseResponse {
	type: "status";
	payload: {
		level: "info" | "warn" | "error" | "verbose";
		message: string;
		args?: any[];
	};
}

export interface ProgressResponse extends BaseResponse {
	type: "progress";
	payload: any;
}

export type WorkerResponse =
	| InitializedResponse
	| VectorizeSentencesResponse
	| VectorizeAndStoreResponse
	| BulkVectorizeAndLoadResponse
	| SearchResult
	| RebuildDbResponse
	| EnsureIndexesResponse
	| TestSimilarityResponse
	| DbClosedResponse
	| DeleteVectorsByFilePathResponse
	| AverageVectorsResponse
	| SearchSimilarByVectorResponse
	| GetVectorsByFilePathResponse
	| UpdateFilePathResponse
	| ErrorResponse
	| StatusResponse
	| ProgressResponse;
