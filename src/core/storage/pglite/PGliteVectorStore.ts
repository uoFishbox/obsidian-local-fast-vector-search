import { PGliteInterface, Transaction } from "@electric-sql/pglite";
import { PGliteProvider } from "./PGliteProvider";
import { PGliteTableManager } from "./PGliteTableManager";
import { EMBEDDINGS_TABLE_NAME } from "../../../shared/constants/appConstants";
import { LoggerService } from "../../../shared/services/LoggerService";

import {
	VectorItem,
	SimilarityResultItem,
	SearchOptions,
} from "../../storage/types";

export class PGliteVectorStore {
	private tableManager!: PGliteTableManager;
	private logger: LoggerService | null;

	constructor(
		private provider: PGliteProvider,
		private dimensions: number,
		private tableName: string = EMBEDDINGS_TABLE_NAME,
		logger: LoggerService | null
	) {
		this.logger = logger;
		this.initTableManager();
	}

	private initTableManager(): void {
		this.tableManager = new PGliteTableManager(
			this.provider,
			this.tableName,
			this.dimensions,
			this.logger
		);
	}

	private quoteIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private getClient(): PGliteInterface {
		if (!this.provider.isReady()) {
			this.throwWithLog("PGlite provider is not ready");
		}

		const client = this.provider.getClient();
		if (!client) {
			this.throwWithLog("PGlite client is not available");
		}

		return client;
	}

	private throwWithLog(message: string, error?: unknown): never {
		const exception = error instanceof Error ? error : new Error(message);
		this.logger?.error(`PGlite error: ${message}`, error || exception);
		throw exception;
	}

	private async executeSql<T>(
		sql: string,
		params: any[] = [],
		logMessage: string
	): Promise<any> {
		try {
			const client = this.getClient();
			const result = await client.query<T>(sql, params);
			this.logger?.verbose_log(logMessage);
			return result.rows;
		} catch (error) {
			this.throwWithLog(`Error executing SQL: ${logMessage}`, error);
		}
	}

	isReady(): boolean {
		return this.provider.isReady();
	}

	getDimensions(): number {
		return this.dimensions;
	}

	setDimensions(dimensions: number): void {
		this.dimensions = dimensions;
		this.initTableManager();
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
			this.initTableManager();
		}
		await this.tableManager.createTable(force);
	}

	async insertVectors(items: VectorItem[]): Promise<void> {
		if (items.length === 0) {
			this.logger?.verbose_log("No vectors to insert.");
			return;
		}

		const quotedTableName = this.quoteIdentifier(this.tableName);
		const valuesPlaceholders: string[] = [];
		const params: (string | number | string | null)[] = [];
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
				null
			);
		}

		const sql = `
            INSERT INTO ${quotedTableName} (file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
            VALUES ${valuesPlaceholders.join(", ")}
        `;

		await this.executeSql(
			sql,
			params,
			`Successfully inserted ${items.length} vectors into ${this.tableName}.`
		);
	}

	async upsertVectors(
		items: VectorItem[],
		batchSize: number = 100
	): Promise<void> {
		if (items.length === 0) {
			this.logger?.verbose_log("No vectors to upsert.");
			return;
		}

		const pgClient = this.getClient();

		try {
			await pgClient.transaction(async (tx: Transaction) => {
				// 1. まず既存のファイルパスに関連するレコードを削除
				await this.deleteExistingRecords(tx, items, batchSize);

				// 2. 新しいレコードをバッチで挿入
				await this.batchInsertRecords(tx, items, batchSize);
			});

			this.logger?.verbose_log(
				`Successfully upserted all ${items.length} vectors into ${this.tableName}`
			);
		} catch (error) {
			this.throwWithLog(
				`Error in upsertVectors transaction for ${this.tableName}:`,
				error
			);
		}
	}

	private async deleteExistingRecords(
		tx: Transaction,
		items: VectorItem[],
		batchSize: number
	): Promise<void> {
		const filePathsToDelete = [
			...new Set(items.map((item) => item.filePath)),
		];

		for (let i = 0; i < filePathsToDelete.length; i += batchSize) {
			const batchFilePaths = filePathsToDelete.slice(i, i + batchSize);
			if (batchFilePaths.length === 0) continue;

			const placeholders = batchFilePaths
				.map((_, idx) => `$${idx + 1}`)
				.join(", ");

			await tx.query(
				`DELETE FROM ${this.quoteIdentifier(
					this.tableName
				)} WHERE file_path IN (${placeholders})`,
				batchFilePaths
			);

			this.logger?.verbose_log(
				`Deleted vectors for ${batchFilePaths.length} files from ${this.tableName}`
			);
		}
	}

	private async batchInsertRecords(
		tx: Transaction,
		items: VectorItem[],
		batchSize: number
	): Promise<void> {
		for (let i = 0; i < items.length; i += batchSize) {
			const batchItems = items.slice(i, i + batchSize);
			if (batchItems.length === 0) continue;

			const valuePlaceholders: string[] = [];
			const params: (string | number | string | null)[] = [];
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
					null
				);
			}

			if (valuePlaceholders.length > 0) {
				const insertSql = `
				INSERT INTO ${this.quoteIdentifier(this.tableName)} 
				(file_path, chunk_offset_start, chunk_offset_end, embedding, chunk)
				VALUES ${valuePlaceholders.join(", ")}
				`;
				await tx.query(insertSql, params);
				this.logger?.verbose_log(
					`Inserted ${batchItems.length} vectors into ${this.tableName}`
				);
			}
		}
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
			this.throwWithLog(
				`Error searching similar vectors in ${this.tableName}:`,
				error
			);
		}
	}

	getProvider(): PGliteProvider {
		return this.provider;
	}

	getTableManager(): PGliteTableManager {
		return this.tableManager;
	}
}
