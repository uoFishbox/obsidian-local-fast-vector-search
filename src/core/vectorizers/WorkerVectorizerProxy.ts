import { IVectorizer } from "./IVectorizer";
import { Notice } from "obsidian";
import VectorizerWorker from "./TransformersVectorizer.worker?worker";
import { LoggerService } from "../../shared/services/LoggerService";

interface WorkerRequest {
	id: string;
	type: "vectorize";
	payload: string[];
}
interface WorkerResponse {
	id: string;
	type: "vectorizeResult" | "error" | "status" | "progress" | "initialized";
	payload: any;
}

export class WorkerProxyVectorizer implements IVectorizer {
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
		this.worker = new VectorizerWorker();
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
							"WorkerVectorizerProxy: Worker initialization successful."
						);
						resolve(true);
					} else {
						this.logger?.error(
							"WorkerVectorizerProxy: Worker initialization failed."
						);
						reject(new Error("Worker initialization failed."));
					}
				} else if (data.type === "error" && !this.isWorkerInitialized) {
					// 初期化中のエラー
					this.worker.removeEventListener(
						"message",
						checkInitialization
					);
					this.logger?.error(
						"WorkerVectorizerProxy: Received error during initialization:",
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

			this.worker.postMessage({ type: "initialize" });
		});
	}

	private setupWorkerListeners(): void {
		this.worker.onmessage = (event: MessageEvent) => {
			const data = event.data as WorkerResponse;
			const { id, type, payload } = data;

			if (type === "vectorizeResult") {
				const promise = this.requestPromises.get(id);
				if (promise) {
					promise.resolve(payload);
					this.requestPromises.delete(id);
				} else {
					this.logger?.warn(
						"WorkerVectorizerProxy: Received vectorizeResult for unknown ID:",
						id
					);
				}
			} else if (type === "error") {
				const promise = this.requestPromises.get(id);
				if (promise) {
					promise.reject(
						new Error(`Worker error for request ${id}: ${payload}`)
					);
					this.requestPromises.delete(id);
				} else {
					this.logger?.error(
						"WorkerVectorizerProxy: Received error without ID:",
						payload
					);
					if (!this.isWorkerInitialized) {
						new Notice(
							`Vectorizer worker initialization error: ${payload}. Check console.`
						);
					} else {
						new Notice(
							`Vectorizer worker error: ${payload}. Check console.`
						);
					}
				}
			} else if (type === "status") {
				const logPayload = payload as {
					level: "info" | "warn" | "error" | "verbose";
					message: string;
					args: any[];
				};
				if (
					this.logger &&
					logPayload &&
					typeof logPayload.level === "string" &&
					typeof logPayload.message === "string"
				) {
					const logMessage = `[Worker] ${logPayload.message}`;
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
							this.logger.log(
								`[Worker Status] ${logMessage}`,
								...logArgs
							);
							break;
					}
				} else {
					this.logger?.warn(
						"WorkerVectorizerProxy: Received unexpected status payload from worker:",
						payload
					);
				}
			} else if (type === "progress") {
				this.logger?.verbose_log(
					`[Worker Progress] ${JSON.stringify(payload)}`
				);
			} else if (type === "initialized") {
				this.logger?.verbose_log(
					`WorkerVectorizerProxy: Received initialization status: ${payload}`
				);
			} else {
				this.logger?.warn(
					"WorkerVectorizerProxy: Received unknown message type from worker:",
					type,
					payload
				);
			}
		};

		this.worker.onerror = (error: ErrorEvent) => {
			this.logger?.error(
				"WorkerVectorizerProxy: Uncaught error in worker:",
				error
			);
			new Notice(
				"A critical error occurred in the vectorizer worker. Check console."
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
			// initializationPromise がまだ解決/拒否されていない場合、rejectする
			// これは initializationPromise のリスナーが onerror を捕捉しない場合に必要
			// 現在のコードでは initializationPromise のリスナーは error タイプも捕捉するので不要かもしれないが、安全のため
			// this.initializationPromise.catch(() => {}).then(() => { /* check if already settled */ });
			// より確実には、initializationPromise の reject を onerror 内でも呼ぶが、リスナーとの重複に注意が必要
		};
	}

	async ensureInitialized(): Promise<void> {
		if (!this.isWorkerInitialized) {
			this.logger?.verbose_log(
				"WorkerVectorizerProxy: Waiting for worker initialization..."
			);
			await this.initializationPromise;
		}
	}

	async vectorizeSentences(sentences: string[]): Promise<number[][]> {
		await this.ensureInitialized();

		return new Promise((resolve, reject) => {
			const id = crypto.randomUUID();
			this.requestPromises.set(id, { resolve, reject });

			const request: WorkerRequest = {
				id,
				type: "vectorize",
				payload: sentences,
			};
			this.worker.postMessage(request);

			// タイムアウト処理
			const timeoutId = setTimeout(() => {
				if (this.requestPromises.has(id)) {
					this.requestPromises.delete(id);
					this.logger?.error(
						`WorkerVectorizerProxy: Request ${id} timed out.`
					);
					reject(
						new Error(
							`Vectorization request timed out after 60 seconds.`
						)
					);
				}
			}, 60000); // 一旦60秒

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

	// プラグインアンロード時に Worker を終了
	terminate(): void {
		this.logger?.verbose_log(
			"WorkerVectorizerProxy: Terminating worker..."
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
