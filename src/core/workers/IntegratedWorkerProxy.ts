import { LoggerService } from "../../shared/services/LoggerService";
import {
	type WorkerRequest,
	type WorkerResponse,
	type VectorizeAndStoreResponse,
	type SearchResult,
	type RebuildDbResponse,
	type DeleteVectorsByFilePathResponse,
	type BulkVectorizeAndLoadResponse,
	type EnsureIndexesResponse,
	type GetVectorsByFilePathResponse,
} from "../../shared/types/integrated-worker";
import IntegratedWorkerCode from "./IntegratedWorker.worker?worker";
import type {
	ChunkInfo,
	SearchOptions,
	SimilarityResultItem,
} from "../../core/storage/types";

export class IntegratedWorkerProxy {
	private worker: Worker;
	private requestPromises: Map<
		string,
		{ resolve: (value: any) => void; reject: (reason?: any) => void }
	> = new Map();
	private isWorkerInitialized: boolean = false;
	private initializationPromise: Promise<boolean>;
	private logger: LoggerService | null;
	constructor(logger: LoggerService | null) {
		this.logger = logger;
		this.worker = new IntegratedWorkerCode();
		this.setupWorkerListeners();

		// Worker の初期化完了を待つ Promise を作成
		this.initializationPromise = new Promise((resolve, reject) => {
			const checkInitialization = (event: MessageEvent) => {
				const data = event.data as WorkerResponse;
				if (data.type === "initialized") {
					this.worker.removeEventListener(
						"message",
						checkInitialization
					);
					this.isWorkerInitialized = data.payload;
					if (this.isWorkerInitialized) {
						this.logger?.verbose_log(
							"IntegratedWorkerProxy: Worker initialization successful."
						);
						resolve(true);
					} else {
						this.logger?.error(
							"IntegratedWorkerProxy: Worker initialization failed."
						);
						reject(new Error("Worker initialization failed."));
					}
				} else if (
					data.type === "errorResponse" &&
					!this.isWorkerInitialized
				) {
					// 初期化中のエラー
					this.worker.removeEventListener(
						"message",
						checkInitialization
					);
					this.logger?.error(
						"IntegratedWorkerProxy: Received error during initialization:",
						data.payload
					);
					reject(
						new Error(
							`Worker initialization error: ${data.payload}`
						)
					);
				}
			};
			this.worker.addEventListener("message", checkInitialization);

			this.worker.postMessage({
				id: crypto.randomUUID(),
				type: "initialize",
			} as WorkerRequest);
		});
	}

	private setupWorkerListeners(): void {
		this.worker.onmessage = (event: MessageEvent) => {
			const data = event.data as WorkerResponse;
			const { id, type, payload } = data;

			// 対応するプロミスを探して解決
			const promise = this.requestPromises.get(id);
			if (promise) {
				if (type === "errorResponse") {
					promise.reject(new Error(`Worker error: ${payload}`));
				} else {
					promise.resolve(payload);
				}
				this.requestPromises.delete(id);
			} else if (type === "status") {
				// ログメッセージの処理
				const logPayload = payload as {
					level: "info" | "warn" | "error" | "verbose";
					message: string;
					args?: any[];
				};
				if (this.logger && logPayload) {
					const logMessage = `[IntegratedWorker] ${logPayload.message}`;
					const logArgs = logPayload.args || [];

					switch (logPayload.level) {
						case "info":
							this.logger.log(logMessage, ...logArgs);
							break;
						case "warn":
							this.logger.warn(logMessage, ...logArgs);
							break;
						case "error":
							this.logger.error(logMessage, ...logArgs);
							break;
						case "verbose":
							this.logger.verbose_log(logMessage, ...logArgs);
							break;
						default:
							this.logger.log(logMessage, ...logArgs);
							break;
					}
				}
			} else if (type === "progress") {
				this.logger?.verbose_log(
					`[IntegratedWorker Progress] ${JSON.stringify(payload)}`
				);
			} else {
				this.logger?.warn(
					"IntegratedWorkerProxy: Received unknown message type:",
					type
				);
			}
		};

		this.worker.onerror = (error: ErrorEvent) => {
			this.logger?.error(
				"IntegratedWorkerProxy: Uncaught error in worker:",
				error
			);
			// 保留中のすべての Promise を reject する
			this.requestPromises.forEach((promise, id) => {
				promise.reject(
					new Error(
						`Worker terminated unexpectedly. Request ${id} failed.`
					)
				);
			});
			this.requestPromises.clear();
			this.isWorkerInitialized = false;
		};
	}

	async ensureInitialized(): Promise<void> {
		if (!this.isWorkerInitialized) {
			this.logger?.verbose_log(
				"IntegratedWorkerProxy: Waiting for worker initialization..."
			);
			await this.initializationPromise;
		}
	}
	private async sendRequest<T>(
		request: Omit<WorkerRequest, "id">
	): Promise<T> {
		await this.ensureInitialized();

		return new Promise((resolve, reject) => {
			const id = crypto.randomUUID();
			this.requestPromises.set(id, { resolve, reject });

			const fullRequest = {
				...request,
				id,
			} as WorkerRequest;
			this.worker.postMessage(fullRequest);

			// タイムアウト処理
			const timeoutId = setTimeout(() => {
				if (this.requestPromises.has(id)) {
					this.requestPromises.delete(id);
					this.logger?.error(
						`IntegratedWorkerProxy: Request ${id} timed out.`
					);
					reject(new Error(`Request timed out after 60 seconds.`));
				}
			}, 60000 * 30);

			// Promiseが解決または拒否されたときにタイムアウトをクリア
			const promise = this.requestPromises.get(id);
			if (promise) {
				promise.resolve = (value) => {
					clearTimeout(timeoutId);
					resolve(value);
				};
				promise.reject = (reason) => {
					clearTimeout(timeoutId);
					reject(reason);
				};
			}
		});
	}

	// 公開メソッド（現在はスケルトンのみ）
	async vectorizeSentences(sentences: string[]): Promise<number[][]> {
		return this.sendRequest({
			type: "vectorizeSentences",
			payload: { sentences },
		});
	}

	async vectorizeAndStoreChunks(
		chunks: ChunkInfo[]
	): Promise<VectorizeAndStoreResponse["payload"]> {
		return this.sendRequest({
			type: "vectorizeAndStore",
			payload: { chunks },
		});
	}

	async searchSimilar(
		query: string,
		negativeQuery?: string,
		limit?: number,
		options?: SearchOptions
	): Promise<SearchResult["payload"]> {
		return this.sendRequest({
			type: "search",
			payload: { query, negativeQuery, limit, options },
		});
	}

	async rebuildDatabase(): Promise<RebuildDbResponse["payload"]> {
		return this.sendRequest({
			type: "rebuildDb",
		});
	}

	async testSimilarity(): Promise<string> {
		return this.sendRequest({
			type: "testSimilarity",
		});
	}

	async closeDatabase(): Promise<boolean> {
		return this.sendRequest({
			type: "closeDb",
		});
	}

	async deleteVectorsByFilePath(filePath: string): Promise<number> {
		const response = await this.sendRequest<
			DeleteVectorsByFilePathResponse["payload"]
		>({
			type: "deleteVectorsByFilePath",
			payload: { filePath },
		});
		return response.count;
	}

	async bulkVectorizeAndLoad(
		chunks: ChunkInfo[]
	): Promise<BulkVectorizeAndLoadResponse["payload"]> {
		return this.sendRequest({
			type: "bulkVectorizeAndLoad",
			payload: { chunks },
		});
	}

	async ensureIndexes(): Promise<EnsureIndexesResponse["payload"]> {
		return this.sendRequest({
			type: "ensureIndexes",
		});
	}

	async averageVectors(vectors: number[][]): Promise<number[]> {
		return this.sendRequest({
			type: "averageVectors",
			payload: { vectors },
		});
	}

	async searchSimilarByVector(
		vector: number[],
		limit?: number,
		options?: SearchOptions
	): Promise<SimilarityResultItem[]> {
		return this.sendRequest({
			type: "searchSimilarByVector",
			payload: { vector, limit, options },
		});
	}

	async getVectorsByFilePath(filePath: string): Promise<number[][]> {
		return this.sendRequest<GetVectorsByFilePathResponse["payload"]>({
			type: "getVectorsByFilePath",
			payload: { filePath },
		});
	}

	// プラグインアンロード時に Worker を終了
	terminate(): void {
		this.logger?.verbose_log(
			"IntegratedWorkerProxy: Terminating worker..."
		);
		this.worker.terminate();
		this.isWorkerInitialized = false;
		// 保留中の Promise を reject
		this.requestPromises.forEach((promise, id) => {
			promise.reject(
				new Error(`Worker terminated. Request ${id} cancelled.`)
			);
		});
		this.requestPromises.clear();
	}
}
