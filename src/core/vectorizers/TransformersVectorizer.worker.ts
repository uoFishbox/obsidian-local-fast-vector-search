import type {
	PreTrainedModelType,
	PreTrainedTokenizerType,
	TensorType,
} from "../../shared/types/huggingface";

// @ts-ignore global self for Worker
const worker = self as DedicatedWorkerGlobalScope;

// ログメッセージをメインスレッドに送信するヘルパー関数
function postLogMessage(
	level: "info" | "warn" | "error" | "verbose",
	message: string,
	...args: any[]
) {
	postMessage({
		type: "status",
		payload: {
			level,
			message,
			args: JSON.parse(JSON.stringify(args)), // 循環参照などを避けるためにJSON化
		},
	});
}

// 重要！ Transformers.js が環境を誤認識するのを防ぐ:
// self に process が存在するかチェックし、存在すれば undefined にする。transformers を import する前に行う必要がある。

let originalProcess: any = (self as any).process;
if (
	typeof self !== "undefined" &&
	typeof (self as any).process !== "undefined"
) {
	(self as any).process = undefined;
}

// --- 状態管理 ---
let model: PreTrainedModelType | null = null;
let tokenizer: PreTrainedTokenizerType | null = null;
let Tensor: typeof import("@huggingface/transformers").Tensor | null = null;
let isInitialized = false;
let isInitializing = false;
const VECTOR_DIMENSION = 384; // ベクトルの次元数

async function initializeEmbeddingModel() {
	if (isInitialized || isInitializing) return;

	isInitializing = true;
	postMessage({ type: "status", payload: "Initializing embedding model..." });

	try {
		// 動的に import
		const transformers = await import("@huggingface/transformers");
		Tensor = transformers.Tensor;
		const AutoModel = transformers.AutoModel;
		const AutoTokenizer = transformers.AutoTokenizer;

		postLogMessage("verbose", "Starting model download/load...");
		const modelStartTime = performance.now();
		model = await AutoModel.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js",
			{
				device: "wasm",
				dtype: "q8",
				progress_callback: (progress: any) => {
					postMessage({ type: "progress", payload: progress });
				},
			}
		);
		const modelEndTime = performance.now();
		postLogMessage(
			"verbose",
			`Model loaded in ${((modelEndTime - modelStartTime) / 1000).toFixed(
				2
			)} seconds.`
		);

		postLogMessage("verbose", "Starting tokenizer download/load...");
		const tokenizerStartTime = performance.now();
		tokenizer = await AutoTokenizer.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js"
		);
		const tokenizerEndTime = performance.now();
		postLogMessage(
			"verbose",
			`Tokenizer loaded in ${(
				(tokenizerEndTime - tokenizerStartTime) /
				1000
			).toFixed(2)} seconds.`
		);

		isInitialized = true;
		postMessage({ type: "initialized", payload: true });
		postMessage({ type: "status", payload: "Model ready." });

		(self as any).process = originalProcess; // 元の process を復元
	} catch (error: any) {
		postLogMessage("error", "Initialization failed:", error);
		postMessage({
			type: "error",
			payload: `Initialization failed: ${error.message}`,
		});
		postMessage({ type: "initialized", payload: false });
	} finally {
		isInitializing = false;
	}
}

async function vectorize(sentences: string[]): Promise<number[][]> {
	if (!isInitialized || !model || !tokenizer || !Tensor) {
		throw new Error(
			"Worker is not initialized or model/tokenizer/Tensor is missing."
		);
	}

	try {
		const inputs = tokenizer(sentences, {
			padding: true,
			truncation: true,
		});

		const outputs = await model(inputs);
		let embeddingTensor: TensorType;

		if (outputs.sentence_embedding instanceof Tensor) {
			// sentence_embedding の場合
			embeddingTensor = outputs.sentence_embedding;
		} else if (outputs.last_hidden_state instanceof Tensor) {
			// last_hidden_state で平均を計算する場合 (sentence_embedding がないモデルの場合) 現状使わない
			const hidden = outputs.last_hidden_state;
			const mask = new Tensor(inputs.attention_mask).unsqueeze(2);
			const sum = hidden.mul(mask).sum(1);
			const denom = mask.sum(1).clamp_(1e-9, Infinity);
			embeddingTensor = sum.div(denom);
		} else {
			postLogMessage("error", "Model output keys:", Object.keys(outputs));
			throw new Error("Embedding tensor not found in model output.");
		}

		let resultVectors = (embeddingTensor.tolist() as number[][]).map(
			(vec) => {
				if (vec.length > VECTOR_DIMENSION) {
					vec = vec.slice(0, VECTOR_DIMENSION);
				}
				const norm = Math.hypot(...vec);
				return norm > 0 ? vec.map((x) => x / norm) : vec;
			}
		);

		// メモリ解放 (重要)
		embeddingTensor.dispose();
		if (outputs.last_hidden_state instanceof Tensor)
			outputs.last_hidden_state.dispose();

		return resultVectors;
	} catch (error) {
		postLogMessage("error", "Vectorization error:", error);
		throw error;
	}
}

worker.onmessage = async (event: MessageEvent) => {
	const { type, payload, id } = event.data;

	try {
		switch (type) {
			case "initialize":
				await initializeEmbeddingModel();
				break;
			case "vectorize":
				if (!isInitialized) {
					throw new Error("Worker not initialized yet.");
				}
				if (!Array.isArray(payload)) {
					throw new Error("Invalid payload for vectorize command.");
				}
				const vectors = await vectorize(payload as string[]);
				postMessage({ type: "vectorizeResult", payload: vectors, id });
				break;
			default:
				postLogMessage("warn", "Unknown message type:", type);
		}
	} catch (error: any) {
		postLogMessage("error", `Error processing message ${type}:`, error);
		postMessage({ type: "error", payload: error.message, id });
	}
};
