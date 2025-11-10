if (
	typeof self !== "undefined" &&
	typeof (self as any).process !== "undefined"
) {
	(self as any).process = undefined;
}
import { matmul } from "@huggingface/transformers";
import type {
	PreTrainedModelType,
	PreTrainedTokenizerType,
	TensorType,
} from "../../shared/types/huggingface";
import {
	EMBEDDINGS_DIMENSIONS,
	DB_NAME,
	EMBEDDINGS_TABLE_NAME,
} from "../../shared/constants/appConstants";
import type {
	WorkerRequest,
	WorkerResponse,
} from "../../shared/types/integrated-worker";
import type {
	VectorItem,
	SearchOptions,
	ChunkInfo,
	SimilarityResultItem,
} from "../../core/storage/types";

import { HNSW_EF_SEARCH } from "../../shared/constants/appConstants";

// PGlite関連のインポート
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { IdbFs } from "@electric-sql/pglite";
import { type IDBPDatabase, openDB } from "idb";
import { SQL_QUERIES } from "../storage/pglite/sql-queries";

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

// PGlite関連の定数
const PGLITE_VERSION = "0.2.14";
const IDB_NAME_RESOURCES = "pglite-resources-cache";
const IDB_STORE_NAME_RESOURCES = "resources";

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

// --- 状態管理 ---
let model: PreTrainedModelType | null = null;
let tokenizer: PreTrainedTokenizerType | null = null;
let Tensor: typeof import("@huggingface/transformers").Tensor | null = null;
let pgliteInstance: PGlite | null = null;
let vectorExtensionBundleURL: URL | null = null;
let isInitialized = false;
let isInitializing = false;
let isDbInitialized = false;

async function getPGliteResources(): Promise<{
	fsBundle: Blob;
	wasmModule: WebAssembly.Module;
	vectorExtensionBundlePath: URL;
}> {
	const resourceCacheKeys = {
		fsBundle: `pglite-${PGLITE_VERSION}-postgres.data`,
		wasmModule: `pglite-${PGLITE_VERSION}-postgres.wasm`,
		vectorExtensionBundle: `pglite-${PGLITE_VERSION}-vector.tar.gz`,
	};

	const resources = {
		fsBundle: {
			url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.data`,
			key: resourceCacheKeys.fsBundle,
			type: "application/octet-stream",
			process: async (buffer: ArrayBuffer) =>
				new Blob([buffer], { type: "application/octet-stream" }),
		},
		wasmModule: {
			url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.wasm`,
			key: resourceCacheKeys.wasmModule,
			type: "application/wasm",
			process: async (buffer: ArrayBuffer) => {
				const wasmBytes = new Uint8Array(buffer);
				if (!WebAssembly.validate(wasmBytes)) {
					throw new Error("Invalid WebAssembly module data.");
				}
				return WebAssembly.compile(wasmBytes);
			},
		},
		vectorExtensionBundle: {
			url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/vector.tar.gz`,
			key: resourceCacheKeys.vectorExtensionBundle,
			type: "application/gzip",
			process: async (buffer: ArrayBuffer) => {
				const blob = new Blob([buffer], { type: "application/gzip" });
				return new URL(URL.createObjectURL(blob));
			},
		},
	};

	const loadedResources: any = {};
	let db: IDBPDatabase | undefined;

	try {
		db = await openDB(IDB_NAME_RESOURCES, 1, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(IDB_STORE_NAME_RESOURCES)) {
					db.createObjectStore(IDB_STORE_NAME_RESOURCES);
				}
			},
		});

		for (const [resourceName, resourceInfo] of Object.entries(resources)) {
			postLogMessage(
				"info",
				`Loading PGlite resource: ${resourceName}...`
			);
			let cachedData: ArrayBuffer | undefined = await db.get(
				IDB_STORE_NAME_RESOURCES,
				resourceInfo.key
			);

			if (cachedData) {
				postLogMessage("verbose", `${resourceName} found in cache.`);
			} else {
				postLogMessage(
					"info",
					`${resourceName} not in cache, downloading...`
				);
				const response = await fetch(resourceInfo.url);
				if (!response.ok) {
					throw new Error(
						`Failed to download ${resourceName}: Status ${response.status}`
					);
				}
				cachedData = await response.arrayBuffer();
				await db.put(
					IDB_STORE_NAME_RESOURCES,
					cachedData,
					resourceInfo.key
				);
				postLogMessage(
					"verbose",
					`${resourceName} downloaded and cached.`
				);
			}
			loadedResources[resourceName] = await resourceInfo.process(
				cachedData
			);
		}
	} catch (error) {
		postLogMessage("error", "Error loading PGlite resources:", error);
		throw error;
	} finally {
		if (db) db.close();
	}

	return {
		fsBundle: loadedResources.fsBundle,
		wasmModule: loadedResources.wasmModule,
		vectorExtensionBundlePath: loadedResources.vectorExtensionBundle,
	};
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

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

		// PGliteの初期化ロジック
		postLogMessage("info", "Initializing PGlite...");
		const resources = await getPGliteResources();
		vectorExtensionBundleURL = resources.vectorExtensionBundlePath;

		const dbPath = `idb://${DB_NAME}`;
		postLogMessage("info", `Creating PGlite instance for ${dbPath}`);

		pgliteInstance = (await PGlite.create(dbPath, {
			relaxedDurability: true,
			fsBundle: resources.fsBundle,
			fs: new IdbFs(DB_NAME),
			wasmModule: resources.wasmModule,
			extensions: {
				vector: resources.vectorExtensionBundlePath,
			},
		})) as PGlite;
		postLogMessage("info", "PGlite instance created.");

		// スキーマ設定ロジック
		const tableName = EMBEDDINGS_TABLE_NAME;
		const dimensions = EMBEDDINGS_DIMENSIONS;

		await pgliteInstance.exec(SQL_QUERIES.SET_ENVIRONMENT);
		postLogMessage("info", "Database environment set.");

		await pgliteInstance.exec(SQL_QUERIES.CREATE_EXTENSION);
		postLogMessage("info", "Vector extension ensured.");

		const createTableSql = SQL_QUERIES.CREATE_TABLE.replace(
			"$1",
			quoteIdentifier(tableName)
		).replace("$2", dimensions.toString());
		await pgliteInstance.exec(createTableSql);
		postLogMessage("info", `Table ${tableName} ensured.`);

		isDbInitialized = true;

		isInitialized = true;
		postLogMessage(
			"info",
			"IntegratedWorker initialization completed. Model and DB ready."
		);

		return true;
	} catch (error: any) {
		postLogMessage(
			"error",
			"IntegratedWorker initialization failed:",
			error
		);
		if (vectorExtensionBundleURL) {
			URL.revokeObjectURL(vectorExtensionBundleURL.href);
			postLogMessage("info", "Revoked Blob URL for vector extension.");
		}
		return false;
	} finally {
		isInitializing = false;
	}
}

async function closeDatabase(): Promise<void> {
	if (pgliteInstance) {
		postLogMessage("info", "Closing PGlite database...");
		await pgliteInstance.close();
		pgliteInstance = null;
		isDbInitialized = false;
		postLogMessage("info", "PGlite database closed.");
	}
	if (vectorExtensionBundleURL) {
		URL.revokeObjectURL(vectorExtensionBundleURL.href);
		vectorExtensionBundleURL = null;
		postLogMessage("info", "Revoked Blob URL for vector extension.");
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

async function batchInsertRecords(
	tx: Transaction,
	items: VectorItem[],
	batchSize: number
): Promise<void> {
	const quotedTableName = quoteIdentifier(EMBEDDINGS_TABLE_NAME);

	for (let i = 0; i < items.length; i += batchSize) {
		const batchItems = items.slice(i, i + batchSize);
		if (batchItems.length === 0) continue;

		const valuePlaceholders: string[] = [];
		const params: (string | number | null)[] = [];
		let paramIndex = 1;

		for (const item of batchItems) {
			valuePlaceholders.push(
				`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
			);
			params.push(
				item.filePath,
				item.chunkOffsetStart,
				item.chunkOffsetEnd,
				JSON.stringify(item.vector)
			);
		}

		if (valuePlaceholders.length > 0) {
			const insertSql = `
				INSERT INTO ${quotedTableName} 
				(file_path, chunk_offset_start, chunk_offset_end, embedding)
				VALUES ${valuePlaceholders.join(", ")}
				ON CONFLICT (file_path, chunk_offset_start) DO UPDATE SET
					chunk_offset_end = EXCLUDED.chunk_offset_end,
					embedding = EXCLUDED.embedding
				`;
			await tx.query(insertSql, params);
			postLogMessage(
				"verbose",
				`Upserted ${batchItems.length} vectors into ${EMBEDDINGS_TABLE_NAME}`
			);
		}
	}
}

async function upsertVectors(
	items: VectorItem[],
	batchSize: number = 100
): Promise<void> {
	if (!pgliteInstance) {
		throw new Error("PGlite instance is not initialized.");
	}
	if (items.length === 0) {
		postLogMessage("verbose", "No vectors to upsert.");
		return;
	}

	try {
		await pgliteInstance.transaction(async (tx: Transaction) => {
			// UPSERT処理のみ実行（deleteExistingRecordsは削除）
			await batchInsertRecords(tx, items, batchSize);
		});

		postLogMessage(
			"verbose",
			`Successfully upserted all ${items.length} vectors into ${EMBEDDINGS_TABLE_NAME}`
		);
	} catch (error) {
		postLogMessage(
			"error",
			`Error in upsertVectors transaction for ${EMBEDDINGS_TABLE_NAME}:`,
			error
		);
		throw error;
	}
}

async function averageVectors(vectors: number[][]): Promise<number[]> {
	if (vectors.length === 0) {
		return [];
	}

	const dimensions = vectors[0].length;
	const sumVector = new Array(dimensions).fill(0);

	for (const vector of vectors) {
		if (vector.length !== dimensions) {
			postLogMessage(
				"warn",
				"Vectors have different dimensions, skipping some for averaging."
			);
			continue;
		}
		for (let i = 0; i < dimensions; i++) {
			sumVector[i] += vector[i];
		}
	}

	const averagedVector = sumVector.map((val) => val / vectors.length);

	let magnitude = 0;
	for (const val of averagedVector) {
		magnitude += val * val;
	}
	magnitude = Math.sqrt(magnitude);

	if (magnitude > 1e-6) {
		return averagedVector.map((val) => val / magnitude);
	} else {
		postLogMessage(
			"warn",
			"Averaged vector is zero or near-zero, returning as is."
		);
		return averagedVector;
	}
}

async function searchSimilar(
	vector: number[],
	limit: number = 20,
	options?: SearchOptions
): Promise<SimilarityResultItem[]> {
	if (!pgliteInstance) {
		throw new Error("PGlite instance is not initialized.");
	}
	const quotedTableName = quoteIdentifier(EMBEDDINGS_TABLE_NAME);
	const efSearch = options?.efSearch || HNSW_EF_SEARCH;
	const excludeFilePaths = options?.excludeFilePaths || [];

	try {
		await pgliteInstance.query(`SET hnsw.ef_search = ${efSearch}`);

		let querySql = `
			SELECT id, file_path, chunk_offset_start, chunk_offset_end,
			       NULL AS chunk, -- chunk カラムの代わりに NULL を返す
				   embedding <=> $1 as distance
			FROM ${quotedTableName}
		`;
		const queryParams: (string | number | string[])[] = [
			JSON.stringify(vector),
		];
		let paramIndex = 2;

		if (excludeFilePaths.length > 0) {
			const placeholders = excludeFilePaths
				.map(() => `$${paramIndex++}`)
				.join(", ");
			querySql += ` WHERE file_path NOT IN (${placeholders})`;
			queryParams.push(...excludeFilePaths);
		}

		querySql += `
			 ORDER BY distance ASC
			 LIMIT $${paramIndex++}
		`;
		queryParams.push(limit);

		const result = await pgliteInstance.query<SimilarityResultItem>(
			querySql,
			queryParams
		);
		return result.rows;
	} catch (error) {
		postLogMessage(
			"error",
			`Error searching similar vectors in ${EMBEDDINGS_TABLE_NAME}:`,
			error
		);
		throw error;
	}
}

async function rebuildDatabaseInternal(): Promise<void> {
	if (!pgliteInstance) {
		throw new Error("PGlite instance is not initialized.");
	}

	postLogMessage("info", "Rebuilding database...");
	const tableName = EMBEDDINGS_TABLE_NAME;
	const dimensions = EMBEDDINGS_DIMENSIONS;

	try {
		// 既存のテーブルを削除
		await pgliteInstance.exec(
			`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)} CASCADE;`
		);
		postLogMessage("info", `Dropped existing table ${tableName}.`);

		await pgliteInstance.exec(SQL_QUERIES.SET_ENVIRONMENT);
		postLogMessage("info", "Database environment set.");

		const createTableSql = SQL_QUERIES.CREATE_TABLE.replace(
			"$1",
			quoteIdentifier(tableName)
		).replace("$2", dimensions.toString());
		await pgliteInstance.exec(createTableSql);
		postLogMessage("info", `Table ${tableName} ensured (without index).`);

		// DO NOT CREATE INDEX HERE
		postLogMessage(
			"info",
			"Database table rebuild (without index) completed successfully."
		);
	} catch (error) {
		postLogMessage("error", "Error rebuilding database table:", error);
		throw error;
	}
}

async function handleBulkVectorizeAndLoad(
	chunksToProcess: ChunkInfo[]
): Promise<{ count: number }> {
	if (!isInitialized || !model || !tokenizer || !Tensor || !pgliteInstance) {
		throw new Error(
			"Worker or PGlite not fully initialized for bulk load."
		);
	}
	if (chunksToProcess.length === 0) {
		return { count: 0 };
	}

	const PROCESSING_BATCH_SIZE = 200;
	let totalProcessedCount = 0;

	try {
		await pgliteInstance.transaction(async (tx) => {
			const tableName = quoteIdentifier(EMBEDDINGS_TABLE_NAME);

			for (
				let i = 0;
				i < chunksToProcess.length;
				i += PROCESSING_BATCH_SIZE
			) {
				const currentChunkBatch = chunksToProcess.slice(
					i,
					i + PROCESSING_BATCH_SIZE
				);
				if (currentChunkBatch.length === 0) continue;

				postLogMessage(
					"verbose",
					`Vectorizing batch of ${currentChunkBatch.length} chunks (offset ${i})...`
				);
				const sentencesToVectorize = currentChunkBatch.map(
					(chunk) => chunk.text
				);
				const vectors = await vectorizeSentences(sentencesToVectorize);

				postLogMessage(
					"verbose",
					`Inserting batch of ${vectors.length} vectors into DB...`
				);

				const valuePlaceholders: string[] = [];
				const params: (string | number | null)[] = [];
				let paramIndex = 1;

				for (let j = 0; j < currentChunkBatch.length; j++) {
					valuePlaceholders.push(
						`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
					);
					params.push(
						currentChunkBatch[j].filePath,
						currentChunkBatch[j].chunkOffsetStart,
						currentChunkBatch[j].chunkOffsetEnd,
						JSON.stringify(vectors[j])
					);
				}

				if (valuePlaceholders.length > 0) {
					const insertSql = `INSERT INTO ${tableName} (file_path, chunk_offset_start, chunk_offset_end, embedding) VALUES ${valuePlaceholders.join(
						", "
					)}`;
					await tx.query(insertSql, params);
					totalProcessedCount += currentChunkBatch.length;
					postLogMessage(
						"verbose",
						`Inserted ${currentChunkBatch.length} vectors. Total processed in transaction: ${totalProcessedCount}`
					);
				}
			}
		});

		postLogMessage(
			"info",
			`Successfully bulk loaded ${totalProcessedCount} vectors.`
		);
		return { count: totalProcessedCount };
	} catch (error) {
		const errorDetails =
			error instanceof Error
				? {
						message: error.message,
						stack: error.stack,
						name: error.name,
				  }
				: error;
		postLogMessage("error", "Error during bulk vector load:", errorDetails);
		throw error;
	}
}

async function handleEnsureIndexes(): Promise<{
	success: boolean;
	message?: string;
}> {
	if (!pgliteInstance) {
		throw new Error(
			"PGlite instance not initialized for ensuring indexes."
		);
	}
	const tableName = EMBEDDINGS_TABLE_NAME;
	const indexName = `${tableName}_hnsw_idx`;
	const quotedTableName = quoteIdentifier(tableName);
	const quotedIndexName = quoteIdentifier(indexName);

	try {
		postLogMessage(
			"info",
			`Creating HNSW index ${indexName} on ${tableName}... This may take a while.`
		);
		const createIndexSql = SQL_QUERIES.CREATE_HNSW_INDEX.replace(
			"$1",
			quotedIndexName
		).replace("$2", quotedTableName);
		await pgliteInstance.exec(createIndexSql);
		postLogMessage("info", `Index ${indexName} created successfully.`);
		return {
			success: true,
			message: `Index ${indexName} created successfully.`,
		};
	} catch (error: any) {
		postLogMessage("error", `Failed to create index ${indexName}:`, error);
		return {
			success: false,
			message: `Failed to create index ${indexName}: ${error.message}`,
		};
	}
}

async function handleGetVectorsByFilePath(
	filePath: string
): Promise<number[][]> {
	if (!pgliteInstance) {
		throw new Error(
			"PGlite instance not initialized for getVectorsByFilePath."
		);
	}
	const quotedTableName = quoteIdentifier(EMBEDDINGS_TABLE_NAME);
	try {
		const result = await pgliteInstance.query<{ embedding: string }>(
			`SELECT embedding FROM ${quotedTableName} WHERE file_path = $1`,
			[filePath]
		);
		return result.rows.map((row) => JSON.parse(row.embedding));
	} catch (error) {
		postLogMessage(
			"error",
			`Error getting vectors for file ${filePath}:`,
			error
		);
		throw error;
	}
}

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
				if (!isInitialized || !isDbInitialized) {
					throw new Error(
						"Worker or DB not initialized. Call initialize first."
					);
				}
				if (!Array.isArray(payload.chunks)) {
					throw new Error(
						"Invalid payload for vectorizeAndStore command."
					);
				}
				const chunksToUpsert = payload.chunks as ChunkInfo[];
				const sentencesToVecUpsert = chunksToUpsert.map((c) => c.text);
				const upsertVectorsArr = await vectorizeSentences(
					sentencesToVecUpsert
				);
				const vectorItemsForUpsert: VectorItem[] = chunksToUpsert.map(
					(chunk, index) => ({
						filePath: chunk.filePath,
						chunkOffsetStart: chunk.chunkOffsetStart,
						chunkOffsetEnd: chunk.chunkOffsetEnd,
						vector: upsertVectorsArr[index],
					})
				);
				await upsertVectors(vectorItemsForUpsert);
				postMessage({
					type: "vectorizeAndStoreResponse",
					payload: { count: vectorItemsForUpsert.length },
					id,
				});
				break;

			case "bulkVectorizeAndLoad":
				if (!Array.isArray(payload.chunks)) {
					throw new Error(
						"Invalid payload for bulkVectorizeAndLoad command."
					);
				}
				const bulkResult = await handleBulkVectorizeAndLoad(
					payload.chunks as ChunkInfo[]
				);
				postMessage({
					type: "bulkVectorizeAndLoadResponse",
					payload: bulkResult,
					id,
				} as WorkerResponse);
				break;

			case "ensureIndexes":
				const indexResult = await handleEnsureIndexes();
				postMessage({
					type: "ensureIndexesResponse",
					payload: indexResult,
					id,
				} as WorkerResponse);
				break;

			case "search":
				if (!isInitialized || !isDbInitialized) {
					throw new Error(
						"Worker or DB not initialized. Call initialize first."
					);
				}
				if (typeof payload.query !== "string") {
					throw new Error("Invalid query for search command.");
				}
				const positiveQuery = payload.query as string;
				const negativeQuery = payload.negativeQuery as
					| string
					| undefined;

				const positiveVectorArray = (
					await vectorizeSentences([positiveQuery])
				)[0];
				let searchVectorArray = positiveVectorArray;

				if (negativeQuery && negativeQuery.trim() !== "") {
					const negativeVectorArray = (
						await vectorizeSentences([negativeQuery])
					)[0];

					if (!Tensor) {
						postLogMessage(
							"error",
							"Tensor library (transformers.Tensor) is not available for vector operations."
						);
						throw new Error("Tensor library not available.");
					}

					if (
						positiveVectorArray.length !==
						negativeVectorArray.length
					) {
						postLogMessage(
							"warn",
							`Cannot subtract vectors of different dimensions. Positive: ${positiveVectorArray.length}, Negative: ${negativeVectorArray.length}. Skipping subtraction.`
						);
					} else {
						searchVectorArray = positiveVectorArray.map(
							(val, index) => val - negativeVectorArray[index]
						);

						let magnitude = 0;
						for (const val of searchVectorArray) {
							magnitude += val * val;
						}
						magnitude = Math.sqrt(magnitude);

						if (magnitude > 1e-6) {
							searchVectorArray = searchVectorArray.map(
								(val) => val / magnitude
							);
						} else {
							postLogMessage(
								"warn",
								"Resulting search vector is zero or near-zero after subtraction. Search may yield no results or behave unexpectedly."
							);
						}
					}
				}

				const searchResults = await searchSimilar(
					searchVectorArray,
					payload.limit,
					payload.options
				);
				postMessage({
					type: "searchResult",
					payload: searchResults,
					id,
				});
				break;

			case "rebuildDb":
				if (!isInitialized || !isDbInitialized) {
					throw new Error(
						"Worker or DB not initialized. Call initialize first."
					);
				}
				await rebuildDatabaseInternal();
				postMessage({
					type: "rebuildDbResponse",
					payload: true,
					id,
				});
				break;

			case "testSimilarity":
				const testResult = await testSelfSimilarity();
				postMessage({
					id,
					type: "testSimilarityResponse",
					payload: testResult,
				});
				break;
			case "closeDb":
				await closeDatabase();
				postMessage({
					id,
					type: "dbClosedResponse",
					payload: true,
				});
				break;
			case "deleteVectorsByFilePath":
				if (!isDbInitialized) {
					throw new Error(
						"DB not initialized for deleteVectorsByFilePath."
					);
				}
				if (typeof payload.filePath !== "string") {
					throw new Error(
						"Invalid filePath for deleteVectorsByFilePath command."
					);
				}
				const deleteFilePath = payload.filePath as string;
				const deleteResult = await pgliteInstance!.query(
					`DELETE FROM ${quoteIdentifier(
						EMBEDDINGS_TABLE_NAME
					)} WHERE file_path = $1`,
					[deleteFilePath]
				);
				postMessage({
					id,
					type: "deleteVectorsByFilePathResponse",
					payload: { count: deleteResult.affectedRows ?? 0 },
				} as WorkerResponse);
				break;

			case "averageVectors":
				if (!Array.isArray(payload.vectors)) {
					throw new Error(
						"Invalid payload for averageVectors command."
					);
				}
				const averagedVector = await averageVectors(
					payload.vectors as number[][]
				);
				postMessage({
					type: "averageVectorsResult",
					payload: averagedVector,
					id,
				});
				break;

			case "searchSimilarByVector":
				if (!Array.isArray(payload.vector)) {
					throw new Error(
						"Invalid payload for searchSimilarByVector command."
					);
				}
				const searchByVectorResults = await searchSimilar(
					payload.vector as number[],
					payload.limit,
					payload.options
				);
				postMessage({
					type: "searchSimilarByVectorResult",
					payload: searchByVectorResults,
					id,
				});
				break;

			case "getVectorsByFilePath":
				if (!isDbInitialized) {
					throw new Error(
						"DB not initialized for getVectorsByFilePath."
					);
				}
				if (typeof payload.filePath !== "string") {
					throw new Error(
						"Invalid filePath for getVectorsByFilePath command."
					);
				}
				const fileVectors = await handleGetVectorsByFilePath(
					payload.filePath as string
				);
				postMessage({
					id,
					type: "getVectorsByFilePathResult",
					payload: fileVectors,
				} as WorkerResponse);
				break;

			case "updateFilePath":
				if (!isDbInitialized) {
					throw new Error("DB not initialized for updateFilePath.");
				}
				if (
					typeof payload.oldPath !== "string" ||
					typeof payload.newPath !== "string"
				) {
					throw new Error(
						"Invalid oldPath or newPath for updateFilePath command."
					);
				}
				const oldPath = payload.oldPath as string;
				const newPath = payload.newPath as string;
				const updateResult = await pgliteInstance!.query(
					`UPDATE ${quoteIdentifier(
						EMBEDDINGS_TABLE_NAME
					)} SET file_path = $1 WHERE file_path = $2`,
					[newPath, oldPath]
				);
				postMessage({
					id,
					type: "updateFilePathResponse",
					payload: { count: updateResult.affectedRows ?? 0 },
				} as WorkerResponse);
				break;

			default:
				postLogMessage("warn", `Unknown message type: ${type}`);
				postMessage({
					id,
					type: "errorResponse",
					payload: `Unknown message type: ${type}`,
				});
				break;
		}
	} catch (error: any) {
		postLogMessage(
			"error",
			`Error processing message type ${type}:`,
			error
		);
		postMessage({
			id,
			type: "errorResponse",
			payload: error.message || "An unknown error occurred.",
		});
	}
};
