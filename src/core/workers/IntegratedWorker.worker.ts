import { matmul } from "@huggingface/transformers";
import type {
	PreTrainedModelType,
	PreTrainedTokenizerType,
	TensorType,
} from "../../shared/types/huggingface";
import { EMBEDDINGS_DIMENSIONS } from "../../shared/constants/appConstants";
import {
	WorkerRequest,
	WorkerResponse,
} from "../../shared/types/integrated-worker";

// @ts-ignore global self for Worker
const worker = self as DedicatedWorkerGlobalScope;

// 重要！ Transformers.js が環境を誤認識するのを防ぐ:
// self に process が存在するかチェックし、存在すれば undefined にする。transformers を import する前に行う必要がある。
let originalProcess: any = (self as any).process;
if (
	typeof self !== "undefined" &&
	typeof (self as any).process !== "undefined"
) {
	(self as any).process = undefined;
}

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

// --- 状態管理 ---
let model: PreTrainedModelType | null = null;
let tokenizer: PreTrainedTokenizerType | null = null;
let Tensor: typeof import("@huggingface/transformers").Tensor | null = null;
let isInitialized = false;
let isInitializing = false;

// 初期化関数（スケルトン）
async function initialize(): Promise<boolean> {
	if (isInitialized || isInitializing) {
		postLogMessage(
			"info",
			"IntegratedWorker is already initialized or initializing."
		);
		return true;
	}

	isInitializing = true;
	postLogMessage("info", "Initializing IntegratedWorker...");

	try {
		// Transformers.js モデルのロードロジック
		postLogMessage("info", "Starting model download/load...");
		const transformers = await import("@huggingface/transformers");
		Tensor = transformers.Tensor;
		const AutoModel = transformers.AutoModel;
		const AutoTokenizer = transformers.AutoTokenizer;

		const modelStartTime = performance.now();
		model = await AutoModel.from_pretrained(
			"cfsdwe/static-embedding-japanese-ONNX-for-js",
			{
				//@ts-ignore
				config: {
					model_type: "bert",
				},
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

		postLogMessage("info", "Starting tokenizer download/load...");
		const tokenizerStartTime = performance.now();
		tokenizer = await AutoTokenizer.from_pretrained(
			"cfsdwe/static-embedding-japanese-ONNX-for-js"
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
		postLogMessage(
			"info",
			"IntegratedWorker initialization completed. Model ready."
		);

		(self as any).process = originalProcess; // 元の process を復元
		return true;
	} catch (error: any) {
		postLogMessage(
			"error",
			"IntegratedWorker initialization failed:",
			error
		);
		return false;
	} finally {
		isInitializing = false;
	}
}

async function vectorizeSentences(sentences: string[]): Promise<number[][]> {
	if (!isInitialized || !model || !tokenizer || !Tensor) {
		throw new Error(
			"Worker is not initialized or model/tokenizer/Tensor is missing."
		);
	}

	try {
		// nmt normalize を適用
		sentences = sentences.map((s) => nmtNormalize(s));
		const inputs = tokenizer(sentences, {
			padding: true,
			truncation: true,
		});

		const outputs = await model(inputs);
		let embeddingTensor: TensorType;

		if (outputs.sentence_embedding instanceof Tensor) {
			// sentence_embedding の場合
			postLogMessage("verbose", "Using sentence_embedding");
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
				// ベクトルを適切なサイズに切り詰める
				if (vec.length > EMBEDDINGS_DIMENSIONS) {
					vec = vec.slice(0, EMBEDDINGS_DIMENSIONS);
				}
				const magnitude = Math.sqrt(
					vec.reduce((sum, val) => sum + val * val, 0)
				);
				if (magnitude > 0) {
					vec = vec.map((val) => val / magnitude);
				}

				return vec;
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

async function testSelfSimilarity(): Promise<string> {
	if (!isInitialized || !model || !tokenizer || !Tensor) {
		throw new Error(
			"Worker is not initialized or model/tokenizer/Tensor is missing."
		);
	}

	postLogMessage("info", "Starting self-similarity test...");

	const exampleSentences = [
		"カレーはおいしい。",
		"カレースープはそこそこ美味しい。",
		"トマトジュースは好みが分かれる。",
	];

	try {
		const vectorsArray = await vectorizeSentences(exampleSentences);

		const rows = vectorsArray.length;
		const cols = vectorsArray[0].length;
		const flatData = vectorsArray.flat();
		const embeddingTensor = new Tensor("float32", flatData, [rows, cols]);

		const scoresTensor = await matmul(
			embeddingTensor,
			embeddingTensor.transpose(1, 0)
		);
		const scores = scoresTensor.tolist(); // 結果をJavaScriptの配列に変換

		postLogMessage(
			"info",
			"Self-similarity scores (dot products):",
			scores
		);

		// メモリ解放
		embeddingTensor.dispose();
		scoresTensor.dispose();

		postLogMessage("info", "Self-similarity test completed.");
		return "Test completed successfully. Check logs for scores.";
	} catch (error) {
		postLogMessage("error", "Self-similarity test error:", error);
		throw error;
	}
}

// メッセージハンドラー
worker.onmessage = async (event: MessageEvent) => {
	const request = event.data as WorkerRequest;
	const { id, type, payload } = request;

	try {
		switch (type) {
			case "initialize":
				const initResult = await initialize();
				postMessage({
					id,
					type: "initialized",
					payload: initResult,
				} as WorkerResponse);
				break;

			case "vectorizeSentences":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				if (!Array.isArray(payload.sentences)) {
					throw new Error(
						"Invalid payload for vectorizeSentences command."
					);
				}
				const vectors = await vectorizeSentences(
					payload.sentences as string[]
				);
				postMessage({
					type: "vectorizeSentencesResult",
					payload: vectors,
					id,
				});
				break;

			case "vectorizeAndStore":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				// TODO: 実装 (フェーズ3)
				postLogMessage(
					"info",
					"vectorizeAndStore request received (not yet implemented)"
				);
				postMessage({
					id,
					type: "vectorizeAndStoreResult",
					payload: {
						success: false,
						processedCount: 0,
						errors: ["Not yet implemented"],
					},
				} as WorkerResponse);
				break;

			case "search":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				// TODO: 実装
				postLogMessage(
					"info",
					"search request received (not yet implemented)"
				);
				postMessage({
					id,
					type: "searchResult",
					payload: {
						results: [],
					},
				} as WorkerResponse);
				break;

			case "rebuildDb":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				// TODO: 実装
				postLogMessage(
					"info",
					"rebuildDb request received (not yet implemented)"
				);
				postMessage({
					id,
					type: "rebuildDbResult",
					payload: {
						success: false,
						message: "Not yet implemented",
					},
				} as WorkerResponse);
				break;

			case "testSimilarity":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				const testResult = await testSelfSimilarity();
				postMessage({
					id,
					type: "testSimilarityResult",
					payload: testResult,
				} as WorkerResponse);
				break;

			case "closeDb":
				if (!isInitialized) {
					throw new Error(
						"Worker not initialized. Call initialize first."
					);
				}
				// TODO: 実装
				postLogMessage(
					"info",
					"closeDb request received (not yet implemented)"
				);
				postMessage({
					id,
					type: "dbClosed",
					payload: true,
				} as WorkerResponse);
				break;

			default:
				postLogMessage("warn", "Unknown message type:", type);
				postMessage({
					id,
					type: "error",
					payload: `Unknown message type: ${type}`,
				} as WorkerResponse);
		}
	} catch (error: any) {
		postLogMessage("error", `Error processing message ${type}:`, error);
		postMessage({
			id,
			type: "error",
			payload: `Error processing ${type}: ${error.message}`,
		} as WorkerResponse);
	}
};

function nmtNormalize(text: string): string {
	let normalizedText = text;

	// 1. Filter (remove) specific control characters.
	// These correspond to:
	// 0x0001..=0x0008  (\u{1}-\u{8})
	// 0x000B           (\u{B})
	// 0x000E..=0x001F  (\u{E}-\u{1F})
	// 0x007F           (\u{7F})
	// 0x008F           (\u{8F})
	// 0x009F           (\u{9F})
	const controlCharsRegex =
		/[\u{1}-\u{8}\u{B}\u{E}-\u{1F}\u{7F}\u{8F}\u{9F}]/gu;
	normalizedText = normalizedText.replace(controlCharsRegex, "");

	// 2. Map other specific code points to a single space ' '.
	// These correspond to:
	// 0x0009 (TAB)
	// 0x000A (LF)
	// 0x000C (FF)
	// 0x000D (CR)
	// 0x1680 (OGHAM SPACE MARK)
	// 0x200B..=0x200F (ZERO WIDTH SPACE, ZWNJ, ZWJ, LRM, RLM)
	// 0x2028 (LINE SEPARATOR)
	// 0x2029 (PARAGRAPH SEPARATOR)
	// 0x2581 (LOWER ONE EIGHTH BLOCK)
	// 0xFEFF (ZERO WIDTH NO-BREAK SPACE / BOM)
	// 0xFFFD (REPLACEMENT CHARACTER)
	const mapToSpaceRegex =
		/[\u{0009}\u{000A}\u{000C}\u{000D}\u{1680}\u{200B}-\u{200F}\u{2028}\u{2029}\u{2581}\u{FEFF}\u{FFFD}]/gu;
	normalizedText = normalizedText.replace(mapToSpaceRegex, " ");

	return normalizedText;
}
