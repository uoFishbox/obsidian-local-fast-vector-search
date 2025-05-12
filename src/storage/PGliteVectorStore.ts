import { PGliteProvider } from "./PGliteProvider";
import { PGliteTableManager } from "./PGliteTableManager";

const EMBEDDINGS_TABLE_NAME = "embeddings";

export interface VectorItem {
	filePath: string;
	chunkOffsetStart: number;
	chunkOffsetEnd: number;
	vector: number[];
}

export interface SimilarityResultItem {
	id: number;
	file_path: string;
	chunk_offset_start: number | null;
	chunk_offset_end: number | null;
	chunk: string | null;
	distance: number;
}

export class PGliteVectorStore {
	private tableManager: PGliteTableManager;

	constructor(
		private provider: PGliteProvider,
		private dimensions: number,
		private tableName: string = EMBEDDINGS_TABLE_NAME
	) {
		this.tableManager = new PGliteTableManager(
			this.provider,
			this.tableName,
			this.dimensions
		);
	}

	// --- ヘルパー関数: SQL識別子を安全にクォートする ---
	private quoteIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private getClient() {
		if (!this.provider.isReady()) {
			throw new Error("PGlite provider is not ready");
		}
		return this.provider.getClient();
	}

	isReady(): boolean {
		return this.provider.isReady();
	}

	getDimensions(): number {
		return this.dimensions;
	}

	setDimensions(dimensions: number): void {
		this.dimensions = dimensions;
		// Update table manager's dimensions if it's already created
		// This assumes PGliteTableManager might have a way to update dimensions,
		// or it's recreated. For simplicity, we'll assume it's handled if needed,
		// or that dimensions are set before table creation.
		// If PGliteTableManager needs dynamic dimension updates, it would require a setter there.
		this.tableManager = new PGliteTableManager(
			this.provider,
			this.tableName,
			this.dimensions
		);
	}

	async checkTableExists(): Promise<{
		exists: boolean;
		dimensions?: number;
		hasChunkColumn?: boolean;
		hasChunkOffsetColumns?: boolean;
	}> {
		return this.tableManager.getTableStatus();
	}

	async createTable(force: boolean = false): Promise<void> {
		// Ensure the tableManager has the latest dimensions before creating the table
		if (this.tableManager["dimensions"] !== this.dimensions) {
			this.tableManager = new PGliteTableManager(
				this.provider,
				this.tableName,
				this.dimensions
			);
		}
		await this.tableManager.createTable(force);
	}

	async insertVector(
		filePath: string,
		content: string,
		vector: number[]
	): Promise<number> {
		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);
		try {
			const result = await pgClient.query<{ id: number }>(
				`INSERT INTO ${quotedTableName} (file_path, chunk, embedding, chunk_offset_start, chunk_offset_end) VALUES ($1, $2, $3, NULL, NULL) RETURNING id`,
				[filePath, content, JSON.stringify(vector)]
			);
			const id = result.rows[0]?.id;
			if (id === undefined) {
				throw new Error("Failed to retrieve ID after insertion.");
			}
			console.log(
				`Vector inserted into ${this.tableName} with ID: ${id} for file: ${filePath}`
			);
			return id;
		} catch (error) {
			console.error(`Error inserting vector for ${filePath}:`, error);
			throw error;
		}
	}

	async insertVectors(items: VectorItem[]): Promise<void> {
		if (items.length === 0) {
			console.log("No vectors to insert.");
			return;
		}

		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);

		const valuesPlaceholders: string[] = [];
		const params: (string | number | number[] | null)[] = [];
		let paramIndex = 1;

		for (const item of items) {
			valuesPlaceholders.push(
				`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
			);
			params.push(
				item.filePath,
				item.chunkOffsetStart,
				item.chunkOffsetEnd,
				JSON.stringify(item.vector),
				null // for chunk column
			);
		}

		const sql = `
            INSERT INTO ${quotedTableName} (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
            VALUES ${valuesPlaceholders.join(", ")}
        `;

		try {
			await pgClient.query(sql, params);
			console.log(
				`Successfully inserted ${items.length} vectors into ${this.tableName}.`
			);
		} catch (error) {
			console.error(
				`Error inserting batch of vectors into ${this.tableName}:`,
				error
			);
			throw error;
		}
	}

	async save(): Promise<void> {
		if (!this.isReady()) return; // Keep this check as it doesn't involve getClient()
		await this.provider.save();
	}

	async upsertVectors(
		items: VectorItem[],
		batchSize: number = 500
	): Promise<void> {
		if (items.length === 0) {
			console.log("No vectors to upsert.");
			return;
		}

		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);

		await pgClient.query("BEGIN");
		try {
			const filePathsToDelete = [
				...new Set(items.map((item) => item.filePath)),
			];

			for (let i = 0; i < filePathsToDelete.length; i += batchSize) {
				const batchFilePaths = filePathsToDelete.slice(
					i,
					i + batchSize
				);
				if (batchFilePaths.length > 0) {
					const placeholders = batchFilePaths
						.map((_, idx) => `$${idx + 1}`)
						.join(", ");
					await pgClient.query(
						`DELETE FROM ${quotedTableName} WHERE file_path IN (${placeholders})`,
						batchFilePaths
					);
					console.log(
						`Deleted vectors for ${batchFilePaths.length} files from ${this.tableName}`
					);
				}
			}

			for (let i = 0; i < items.length; i += batchSize) {
				const batchItems = items.slice(i, i + batchSize);
				if (batchItems.length === 0) continue;

				const valuePlaceholders: string[] = [];
				const params: (string | number | number[] | null)[] = [];
				let paramIndex = 1;

				for (const item of batchItems) {
					valuePlaceholders.push(
						`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
					);
					params.push(
						item.filePath,
						item.chunkOffsetStart,
						item.chunkOffsetEnd,
						JSON.stringify(item.vector),
						null // for chunk column
					);
				}

				if (valuePlaceholders.length > 0) {
					const insertSql = `
                        INSERT INTO ${quotedTableName} (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
                        VALUES ${valuePlaceholders.join(", ")}
                    `;
					await pgClient.query(insertSql, params);
					console.log(
						`Inserted ${batchItems.length} vectors into ${this.tableName}`
					);
				}
			}

			await pgClient.query("COMMIT");
			console.log(
				`Successfully upserted all ${items.length} vectors into ${this.tableName}`
			);
		} catch (error) {
			await pgClient.query("ROLLBACK");
			console.error(
				`Error in upsertVectors transaction for ${this.tableName}:`,
				error
			);
			throw error;
		}
	}

	getTableName(): string {
		return this.tableName;
	}

	async searchSimilar(
		vector: number[],
		limit: number = 20
	): Promise<SimilarityResultItem[]> {
		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);

		try {
			const result = await pgClient.query<SimilarityResultItem>(
				`SELECT id, file_path, chunk_offset_start, chunk_offset_end, chunk, embedding <=> $1 as distance FROM ${quotedTableName} ORDER BY distance LIMIT $2`,
				[JSON.stringify(vector), limit]
			);
			return result.rows;
		} catch (error) {
			console.error(
				`Error searching similar vectors in ${this.tableName}:`,
				error
			);
			throw error;
		}
	}

	getProvider(): PGliteProvider {
		return this.provider;
	}

	async rebuildStorage(): Promise<void> {
		console.log(
			"Rebuilding storage: Closing existing provider connection."
		);
		await this.provider.close(); // Close existing connection if any

		console.log("Rebuilding storage: Deleting existing database file.");
		await this.provider.deleteDatabaseFile();

		console.log("Rebuilding storage: Re-initializing provider.");
		await this.provider.initialize(); // Re-initialize to create a new DB

		console.log("Rebuilding storage: Creating new embeddings table.");
		// Since the DB is new, force=false is appropriate for createTable.
		// createTable will handle setting up schema and extensions.
		await this.createTable(false);
		console.log("Storage rebuild complete: New embeddings table created.");
		// Note: PGliteProvider handles its own saving logic during initialization and operations.
		// A specific save call here might be redundant unless createTable itself modifies data
		// in a way that requires an explicit save via vectorStore.save().
		// For now, assuming createTable and provider.initialize handle necessary persistence.
	}
}
