import { PGliteInterface, Transaction } from "@electric-sql/pglite";
import { PGliteProvider } from "./PGliteProvider";
import { PGliteTableManager } from "./PGliteTableManager";
import { EMBEDDINGS_TABLE_NAME } from "../../../shared/constants/appConstants";

import {
	VectorItem,
	SimilarityResultItem,
	SearchOptions,
} from "../../storage/types";

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

	private getClient(): PGliteInterface {
		if (!this.provider.isReady()) {
			throw new Error("PGlite provider is not ready");
		}
		const client = this.provider.getClient();
		if (!client) {
			throw new Error("PGlite client is not available");
		}
		return client;
	}

	isReady(): boolean {
		return this.provider.isReady();
	}

	getDimensions(): number {
		return this.dimensions;
	}

	setDimensions(dimensions: number): void {
		this.dimensions = dimensions;
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
		hasHnswIndex?: boolean;
	}> {
		return this.tableManager.getTableStatus();
	}

	async createTable(force: boolean = false): Promise<void> {
		if (this.tableManager["dimensions"] !== this.dimensions) {
			this.tableManager = new PGliteTableManager(
				this.provider,
				this.tableName,
				this.dimensions
			);
		}
		await this.tableManager.createTable(force);
	}

	async insertVectors(items: VectorItem[]): Promise<void> {
		if (items.length === 0) {
			console.log("No vectors to insert.");
			return;
		}

		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);

		const valuesPlaceholders: string[] = [];
		const params: (string | number | string | null)[] = [];
		let paramIndex = 1;

		for (const item of items) {
			valuesPlaceholders.push(
				// (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
				`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
			);
			params.push(
				item.filePath,
				item.chunkOffsetStart,
				item.chunkOffsetEnd,
				JSON.stringify(item.vector),
				null
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

	async upsertVectors(
		items: VectorItem[],
		batchSize: number = 100
	): Promise<void> {
		if (items.length === 0) {
			console.log("No vectors to upsert.");
			return;
		}

		const pgClient = this.getClient();

		await pgClient
			.transaction(async (tx: Transaction) => {
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
						await tx.query(
							`DELETE FROM ${this.quoteIdentifier(
								this.tableName
							)} WHERE file_path IN (${placeholders})`,
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
					const params: (string | number | string | null)[] = [];
					let paramIndex = 1;

					for (const item of batchItems) {
						valuePlaceholders.push(
							// (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
							`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
						);
						params.push(
							item.filePath,
							item.chunkOffsetStart,
							item.chunkOffsetEnd,
							JSON.stringify(item.vector),
							null
						);
					}

					if (valuePlaceholders.length > 0) {
						const insertSql = `
                        INSERT INTO ${this.quoteIdentifier(
							this.tableName
						)} (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
                        VALUES ${valuePlaceholders.join(", ")}
                    `;
						await tx.query(insertSql, params);
						console.log(
							`Inserted ${batchItems.length} vectors into ${this.tableName}`
						);
					}
				}
			})
			.catch((error) => {
				console.error(
					`Error in upsertVectors transaction for ${this.tableName}:`,
					error
				);
				throw error;
			});

		console.log(
			`Successfully upserted all ${items.length} vectors into ${this.tableName}`
		);
	}

	getTableName(): string {
		return this.tableName;
	}
	async searchSimilar(
		vector: number[],
		limit: number = 20,
		options?: SearchOptions
	): Promise<SimilarityResultItem[]> {
		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);
		const efSearch = options?.efSearch || 40;

		try {
			await pgClient.query(`SET hnsw.ef_search = ${efSearch}`);

			const result = await pgClient.query<SimilarityResultItem>(
				`SELECT id, file_path, chunk_offset_start, chunk_offset_end, chunk, 1 - (embedding <#> $1) as distance
				 FROM ${quotedTableName}
				 ORDER BY distance DESC
				 LIMIT $2`,
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
}
