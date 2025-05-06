import { IVectorizer } from "./IVectorizer";
import { Notice } from "obsidian";
import VectorizerWorker from "../vectorizer.worker?worker";

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

	constructor() {
		this.worker = new VectorizerWorker();
		this.setupWorkerListeners();

		// Worker の初期化完了を待つ Promise を作成
		this.initializationPromise = new Promise((resolve, reject) => {
			const checkInitialization = (event: MessageEvent) => {
				const data = event.data as WorkerResponse;
				if (data.type === "initialized") {
					this.isWorkerInitialized = data.payload;
					if (this.isWorkerInitialized) {
						console.log(
							"WorkerProxy: Worker initialization successful."
						);
						resolve(true);
					} else {
						console.error(
							"WorkerProxy: Worker initialization failed."
						);
						reject(new Error("Worker initialization failed."));
					}
				} else if (data.type === "error" && !this.isWorkerInitialized) {
					// 初期化中のエラー
					console.error(
						"WorkerProxy: Received error during initialization:",
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

			// Worker に初期化を指示
			this.worker.postMessage({ type: "initialize" });
		});
	}

	private setupWorkerListeners(): void {
		this.worker.onmessage = (event: MessageEvent) => {
			const data = event.data as WorkerResponse;
			const { id, type, payload } = data;

			if (type === "vectorizeResult" || type === "error") {
				const promise = this.requestPromises.get(id);
				if (promise) {
					if (type === "vectorizeResult") {
						promise.resolve(payload);
					} else {
						promise.reject(new Error(payload));
					}
					this.requestPromises.delete(id);
				}
			} else if (type === "status") {
				console.log(`[Worker Status] ${payload}`);
			} else if (type === "progress") {
			} else if (type === "initialized") {
				console.log(
					`WorkerProxy: Received initialization status: ${payload}`
				);
			} else {
				console.warn(
					"WorkerProxy: Received unknown message type from worker:",
					type
				);
			}
		};

		this.worker.onerror = (error: ErrorEvent) => {
			console.error("WorkerProxy: Uncaught error in worker:", error);
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
			this.isWorkerInitialized = false; // Worker が利用不可になったことを示す
		};
	}

	// Worker の初期化が完了するのを待つ
	async ensureInitialized(): Promise<void> {
		if (!this.isWorkerInitialized) {
			console.log("WorkerProxy: Waiting for worker initialization...");
			await this.initializationPromise;
		}
	}

	async vectorizeSentences(sentences: string[]): Promise<number[][]> {
		await this.ensureInitialized(); // Worker の準備ができるまで待つ

		return new Promise((resolve, reject) => {
			const id = crypto.randomUUID(); // 一意なリクエストIDを生成
			this.requestPromises.set(id, { resolve, reject });

			const request: WorkerRequest = {
				id,
				type: "vectorize",
				payload: sentences,
			};
			this.worker.postMessage(request);

			// タイムアウト処理 (オプション)
			setTimeout(() => {
				if (this.requestPromises.has(id)) {
					this.requestPromises.delete(id);
					reject(new Error(`Request ${id} timed out.`));
				}
			}, 60000); // 例: 60秒
		});
	}

	// プラグインアンロード時に Worker を終了
	terminate(): void {
		console.log("WorkerProxy: Terminating worker...");
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
