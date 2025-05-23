// 統合ワーカーの型定義

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

export interface VectorizeAndStoreRequest extends BaseRequest {
	type: "vectorizeAndStore";
	payload: {
		documents: Array<{
			id: string;
			content: string;
			metadata?: Record<string, any>;
		}>;
	};
}

export interface SearchRequest extends BaseRequest {
	type: "search";
	payload: {
		query: string;
		limit?: number;
		threshold?: number;
	};
}

export interface RebuildDbRequest extends BaseRequest {
	type: "rebuildDb";
	payload?: {
		clearExisting?: boolean;
	};
}

export interface TestSimilarityRequest extends BaseRequest {
	type: "testSimilarity";
	payload?: any;
}

export interface CloseDbRequest extends BaseRequest {
	type: "closeDb";
	payload?: any;
}

// ユニオン型でリクエストをまとめる
export type WorkerRequest =
	| InitializeRequest
	| VectorizeSentencesRequest
	| VectorizeAndStoreRequest
	| SearchRequest
	| RebuildDbRequest
	| TestSimilarityRequest
	| CloseDbRequest;

// ===== Response Types =====
export interface InitializedResponse extends BaseResponse {
	type: "initialized";
	payload: boolean;
}

export interface VectorizeSentencesResponse extends BaseResponse {
	type: "vectorizeSentencesResult";
	payload: number[][];
}

export interface VectorizeAndStoreResponse extends BaseResponse {
	type: "vectorizeAndStoreResult";
	payload: {
		success: boolean;
		processedCount: number;
		errors?: string[];
	};
}

export interface SearchResult extends BaseResponse {
	type: "searchResult";
	payload: {
		results: Array<{
			id: string;
			content: string;
			score: number;
			metadata?: Record<string, any>;
		}>;
	};
}

export interface RebuildDbResponse extends BaseResponse {
	type: "rebuildDbResult";
	payload: {
		success: boolean;
		message: string;
	};
}

export interface TestSimilarityResponse extends BaseResponse {
	type: "testSimilarityResult";
	payload: string;
}

export interface DbClosedResponse extends BaseResponse {
	type: "dbClosed";
	payload: boolean;
}

export interface ErrorResponse extends BaseResponse {
	type: "error";
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

// ユニオン型でレスポンスをまとめる
export type WorkerResponse =
	| InitializedResponse
	| VectorizeSentencesResponse
	| VectorizeAndStoreResponse
	| SearchResult
	| RebuildDbResponse
	| TestSimilarityResponse
	| DbClosedResponse
	| ErrorResponse
	| StatusResponse
	| ProgressResponse;
