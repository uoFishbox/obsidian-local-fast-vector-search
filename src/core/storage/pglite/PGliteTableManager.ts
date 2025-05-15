import type { PGlite } from "@electric-sql/pglite";
import type { PGliteProvider } from "./PGliteProvider";
import { LoggerService } from "../../../shared/services/LoggerService";
import { SQL_QUERIES } from "./sql-queries";

export class PGliteTableManager {
	private logger: LoggerService | null;

	constructor(
		private provider: PGliteProvider,
		private tableName: string,
		private dimensions: number,
		logger: LoggerService | null
	) {
		this.logger = logger;
	}

	private getClient(): PGlite {
		if (!this.provider.isReady()) {
			const error = new Error("PGlite provider is not ready");
			this.logger?.error("PGlite client error:", error);
			throw error;
		}
		const client = this.provider.getClient() as PGlite;
		if (!client) {
			const error = new Error("PGlite client is not available");
			this.logger?.error("PGlite client error:", error);
			throw error;
		}
		return client;
	}

	private quoteIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private async checkTableExists(): Promise<boolean> {
		const pgClient = this.getClient();
		const tableExistsResult = await this.executeQuerySafely(
			`checking if table ${this.tableName} exists`,
			async () => {
				return pgClient.query<{ exists: boolean }>(
					SQL_QUERIES.CHECK_TABLE_EXISTS,
					[this.tableName]
				);
			}
		);
		return tableExistsResult.rows[0]?.exists ?? false;
	}

	private async getTableDimensions(): Promise<number | undefined> {
		const pgClient = this.getClient();
		const dimensionsResult = await this.executeQuerySafely(
			`getting table ${this.tableName} dimensions`,
			async () => {
				return pgClient.query<{ dimensions: string }>(
					SQL_QUERIES.GET_TABLE_DIMENSIONS,
					[this.tableName]
				);
			}
		);
		if (dimensionsResult.rows.length > 0) {
			const dimVal = parseInt(dimensionsResult.rows[0].dimensions);
			if (!isNaN(dimVal)) {
				return dimVal;
			}
		}
		return undefined;
	}

	private async checkColumnExists(columnName: string): Promise<boolean> {
		const pgClient = this.getClient();
		const columnExistsResult = await this.executeQuerySafely(
			`checking if column ${columnName} exists in ${this.tableName}`,
			async () => {
				// 波括弧を追加
				return pgClient.query<{ exists: boolean }>(
					SQL_QUERIES.CHECK_COLUMN_EXISTS,
					[this.tableName, columnName]
				);
			} // 波括弧を追加
		);
		return columnExistsResult.rows[0]?.exists ?? false;
	}

	private async checkHnswIndexExists(): Promise<boolean> {
		const pgClient = this.getClient();
		const indexName = `${this.tableName}_hnsw_idx`;
		const indexExistsResult = await this.executeQuerySafely(
			`checking if HNSW index ${indexName} exists`,
			async () => {
				return pgClient.query<{ exists: boolean }>(
					SQL_QUERIES.CHECK_INDEX_EXISTS,
					[indexName]
				);
			}
		);
		return indexExistsResult.rows[0]?.exists ?? false;
	}

	private async executeQuerySafely<T>(
		operation: string,
		queryFn: () => Promise<T>
	): Promise<T> {
		try {
			return await queryFn();
		} catch (error) {
			this.logger?.error(`Error during ${operation}:`, error);
			throw new Error(`Failed during ${operation}: ${error}`);
		}
	}

	public async getTableStatus(): Promise<{
		exists: boolean;
		dimensions?: number;
		hasChunkColumn?: boolean;
		hasChunkOffsetColumns?: boolean;
		hasHnswIndex?: boolean;
	}> {
		try {
			const exists = await this.checkTableExists();
			if (!exists) {
				return { exists: false };
			}

			const dimensions = await this.getTableDimensions();
			const hasChunkColumn = await this.checkColumnExists("chunk");
			const hasChunkOffsetStartColumn = await this.checkColumnExists(
				"chunk_offset_start"
			);
			const hasChunkOffsetEndColumn = await this.checkColumnExists(
				"chunk_offset_end"
			);
			const hasChunkOffsetColumns =
				hasChunkOffsetStartColumn && hasChunkOffsetEndColumn;
			const hasHnswIndex = await this.checkHnswIndexExists();

			return {
				exists: true,
				dimensions,
				hasChunkColumn,
				hasChunkOffsetColumns,
				hasHnswIndex,
			};
		} catch (error) {
			this.logger?.error(
				`Error checking vector table ${this.tableName} status:`,
				error
			);
			return { exists: false };
		}
	}

	public async createTable(force: boolean = false): Promise<void> {
		return this.executeQuerySafely(
			`creating vector table ${this.tableName}`,
			async () => {
				const pgClient = this.getClient();
				const quotedTableName = this.quoteIdentifier(this.tableName);

				await this.executeQuerySafely(
					"creating vector extension",
					async () => {
						return pgClient.query(SQL_QUERIES.CREATE_EXTENSION);
					}
				);
				this.logger?.verbose_log("Ensured vector extension exists.");

				// Ensure halfvec type is available
				try {
					await this.executeQuerySafely(
						"checking halfvec type availability",
						async () => {
							return pgClient.query(
								SQL_QUERIES.CHECK_HALFVEC_TYPE
							);
						}
					);
					this.logger?.verbose_log(
						"Confirmed halfvec type is available."
					);
				} catch (error) {
					this.logger?.error(
						"halfvec type is not available. Falling back to vector extension:",
						error
					);
					throw new Error(
						"halfvec type not supported. Please ensure you have the latest vector extension that supports halfvec."
					);
				}

				if (force) {
					await this.executeQuerySafely(
						`dropping existing vector table ${this.tableName}`,
						async () => {
							return pgClient.query(
								SQL_QUERIES.DROP_TABLE.replace(
									"$1",
									quotedTableName
								)
							);
						}
					);
					this.logger?.verbose_log(
						`Dropped existing vector table: ${this.tableName}`
					);
				}

				if (isNaN(this.dimensions) || this.dimensions <= 0) {
					throw new Error(
						`Invalid dimensions value for table creation: ${this.dimensions}`
					);
				}

				// テーブル作成
				const createTableQuery = SQL_QUERIES.CREATE_TABLE.replace(
					"$1",
					quotedTableName
				).replace("$2", this.dimensions.toString());
				await this.executeQuerySafely(
					`creating table ${this.tableName}`,
					async () => {
						return pgClient.query(createTableQuery);
					}
				);
				this.logger?.verbose_log(
					`Vector table ${this.tableName} created/ensured with ${this.dimensions} dimensions using halfvec type`
				);

				// HNSWインデックス作成
				await this.createHnswIndex();
			}
		);
	}

	public async createHnswIndex(): Promise<void> {
		return this.executeQuerySafely(
			`creating HNSW index for ${this.tableName}`,
			async () => {
				const pgClient = this.getClient();
				const quotedTableName = this.quoteIdentifier(this.tableName);
				const indexName = this.quoteIdentifier(
					`${this.tableName}_hnsw_idx`
				);

				const hasIndex = await this.checkHnswIndexExists();
				if (hasIndex) {
					this.logger?.verbose_log(
						`HNSW index already exists for table ${this.tableName}`
					);
					return;
				}

				this.logger?.verbose_log(
					`Creating HNSW index for table ${this.tableName} using halfvec...`
				);

				const createIndexQuery = SQL_QUERIES.CREATE_HNSW_INDEX.replace(
					"$1",
					indexName
				).replace("$2", quotedTableName);
				await this.executeQuerySafely(
					`executing create HNSW index query for ${this.tableName}`,
					async () => {
						return pgClient.query(createIndexQuery);
					}
				);
				this.logger?.verbose_log(
					`HNSW index created for table ${this.tableName}`
				);
			}
		);
	}
}
