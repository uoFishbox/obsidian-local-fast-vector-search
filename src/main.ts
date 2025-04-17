import { Plugin, Notice } from "obsidian";

const VECTOR_DIMENSION = 512;
const EMBEDDING_KEYS: (keyof any)[] = [
	"sentence_embedding",
	"last_hidden_state",
];

type PreTrainedModelType = import("@huggingface/transformers").PreTrainedModel;
type PreTrainedTokenizerType =
	import("@huggingface/transformers").PreTrainedTokenizer;
type TensorType = import("@huggingface/transformers").Tensor;
type AutoModelType = typeof import("@huggingface/transformers").AutoModel;
type AutoTokenizerType =
	typeof import("@huggingface/transformers").AutoTokenizer;
// ---------------------------------

export default class MyVectorPlugin extends Plugin {
	model: PreTrainedModelType | null = null;
	tokenizer: PreTrainedTokenizerType | null = null;
	isModelReady: boolean = false;
	isLoading: boolean = false;
	private initializationPromise: Promise<void> | null = null;

	// --- transformers のモジュールを保持する変数 ---
	private transformers: {
		AutoModel: AutoModelType;
		AutoTokenizer: AutoTokenizerType;
		Tensor: typeof import("@huggingface/transformers").Tensor;
		env: typeof import("@huggingface/transformers").env;
	} | null = null;
	// -----------------------------------------

	async onload() {
		console.log("MyVectorPlugin loading...");

		this.app.workspace.onLayoutReady(async () => {
			console.log(
				"Obsidian layout ready. Triggering background initialization."
			);
			this.initializeResources().catch((error) => {
				console.error("Background model initialization failed:", error);
			});
		});

		this.addCommand({
			id: "vectorize-current-note",
			name: "Vectorize current note",
			editorCallback: async (editor, view) => {
				try {
					await this.ensureModelInitialized();
				} catch (error) {
					console.error("Model initialization failed:", error);
					new Notice(
						"Failed to initialize AI model. Check console for details."
					);
					return;
				}

				if (!this.isModelReady || !this.model || !this.tokenizer) {
					new Notice(
						"Model is not ready. Initialization might have failed or is still in progress."
					);
					return;
				}

				const text = editor.getValue();
				const sentences = text
					.split(/\n+/)
					.map((s) => s.trim())
					.filter((s) => s.length > 0);

				if (sentences.length === 0) {
					new Notice("No text found to vectorize.");
					return;
				}

				try {
					new Notice(`Vectorizing ${sentences.length} sentences...`);
					const vectors = await this.vectorizeSentencesInternal(
						sentences
					);
					new Notice(
						`Vectorization complete! ${vectors.length} vectors generated.`
					);
				} catch (error) {
					console.error("Vectorization failed:", error);
					new Notice(
						"Vectorization failed. Check console for details."
					);
				}
			},
		});

		console.log("MyVectorPlugin loaded command.");
	}

	async ensureModelInitialized(): Promise<void> {
		if (this.isModelReady) {
			return Promise.resolve();
		}

		if (!this.initializationPromise) {
			console.log("Initialization not yet started. Starting now.");
			this.initializationPromise = this.initializeResources();
		} else {
			console.log(
				"Initialization already in progress. Waiting for completion."
			);
		}

		await this.initializationPromise;
	}

	async initializeResources(): Promise<void> {
		if (this.isLoading || this.isModelReady) {
			console.log(
				`Initialization skipped: isLoading=${this.isLoading}, isModelReady=${this.isModelReady}`
			);
			return;
		}

		this.isLoading = true;

		// --- window.process を削除 ---
		// @ts-ignore
		if (typeof window !== "undefined" && window.process) {
			console.log("Temporarily deleting window.process.");
			// @ts-ignore
			delete window.process;
		}
		// --------------------------

		try {
			console.log("Starting model and tokenizer initialization...");
			new Notice("Loading AI model... This may take a while.");

			// --- 動的に transformers を import ---
			if (!this.transformers) {
				console.log(
					"Dynamically importing @huggingface/transformers..."
				);
				this.transformers = await import("@huggingface/transformers");
				// 必要に応じて env 設定を行う
				this.transformers.env.useBrowserCache = true;
				console.log("Transformers module loaded.");
			}
			// ------------------------------------

			// --- initializeModelAndTokenizer に import したモジュールを渡す ---
			const { model, tokenizer } = await initializeModelAndTokenizer(
				this.transformers.AutoModel,
				this.transformers.AutoTokenizer
			);
			// ---------------------------------------------------------
			this.model = model;
			this.tokenizer = tokenizer;
			this.isModelReady = true;
			console.log("AI model and tokenizer loaded successfully!");
			new Notice("AI model loaded successfully!");
		} catch (error: any) {
			console.error("Failed to initialize model or tokenizer:", error);
			console.error("Detailed Error:", error.message, error.stack);
			this.isModelReady = false;
			this.transformers = null; // 失敗したらモジュール参照もクリア
			throw error; // エラーを再スロー
		} finally {
			this.isLoading = false;
			// --- window.process の復元は不要 (削除したままにする) ---
			console.log("Initialization process finished.");
		}
	}

	async vectorizeSentencesInternal(sentences: string[]): Promise<number[][]> {
		// --- transformers モジュールと Tensor クラスの存在を確認 ---
		if (
			!this.isModelReady ||
			!this.model ||
			!this.tokenizer ||
			!this.transformers ||
			!this.transformers.Tensor
		) {
			throw new Error(
				"Model, tokenizer, or transformers module is not initialized."
			);
		}
		const Tensor = this.transformers.Tensor; // Tensor クラスへの参照を取得
		// -----------------------------------------------------

		try {
			const inputs = this.tokenizer(sentences, {
				padding: true,
				truncation: true,
			});
			const outputs = await this.model(inputs);

			let embeddingTensor: TensorType | undefined;
			for (const key of EMBEDDING_KEYS) {
				const potentialOutput = outputs[key];
				// --- Tensor のインスタンスチェックを更新 ---
				if (potentialOutput instanceof Tensor) {
					embeddingTensor =
						key === "last_hidden_state"
							? potentialOutput.mean(1) // Mean pooling
							: potentialOutput;
					break;
				}
				// ------------------------------------
			}

			if (!embeddingTensor) {
				console.error("Model output keys:", Object.keys(outputs));
				throw new Error(
					`Could not find any expected embedding tensor (${EMBEDDING_KEYS.join(
						", "
					)}) in model output.`
				);
			}

			let resultVectorsNested = embeddingTensor.tolist();
			let resultVectors: number[][] = resultVectorsNested as number[][];

			if (
				resultVectors.length > 0 &&
				resultVectors[0].length > VECTOR_DIMENSION
			) {
				resultVectors = resultVectors.map((vector) =>
					vector.slice(0, VECTOR_DIMENSION)
				);
			}

			return resultVectors;
		} catch (error) {
			console.error("Error during internal vectorization:", error);
			throw error;
		}
	}

	onunload() {
		console.log("Unloading vector plugin...");
		this.model = null;
		this.tokenizer = null;
		this.isModelReady = false;
		this.isLoading = false;
		this.initializationPromise = null;
		this.transformers = null; // モジュール参照もクリア
	}
}

// --- initializeModelAndTokenizer のシグネチャを変更 ---
async function initializeModelAndTokenizer(
	AutoModel: AutoModelType,
	AutoTokenizer: AutoTokenizerType
): Promise<{
	model: PreTrainedModelType;
	tokenizer: PreTrainedTokenizerType;
}> {
	try {
		console.log("Starting model download/load...");
		const model = await AutoModel.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js",
			{
				progress_callback: (progress: any) => {},
			}
		);
		console.log("Model loaded. Starting tokenizer download/load...");
		const tokenizer = await AutoTokenizer.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js",
			{
				progress_callback: (progress: any) => {},
			}
		);
		console.log("Tokenizer loaded.");

		return { model, tokenizer };
	} catch (error) {
		console.error(
			"Model/Tokenizer Initialization Error in external function:",
			error
		);
		throw error;
	}
}
