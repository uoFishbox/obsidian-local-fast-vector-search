import type { PGlite } from "@electric-sql/pglite";
import type { PGliteProvider } from "./PGliteProvider";

const SQL_QUERIES = {
	CHECK_TABLE_EXISTS: `SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = $1)`,
	CHECK_COLUMN_EXISTS: `SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = $1 AND column_name = $2
	)`,
	CHECK_INDEX_EXISTS: `SELECT EXISTS (
		SELECT 1 
		FROM pg_indexes 
		WHERE indexname = $1
	)`,
	GET_TABLE_DIMENSIONS: `SELECT atttypmod as dimensions FROM pg_attribute 
		WHERE attrelid = $1::regclass AND attname = 'embedding' AND atttypid::regtype::text = 'halfvec'`,
	CREATE_EXTENSION: `CREATE EXTENSION IF NOT EXISTS vector;`,
	CHECK_HALFVEC_TYPE: `SELECT 'halfvec'::regtype;`,
	DROP_TABLE: `DROP TABLE IF EXISTS $1`,
	CREATE_TABLE: `
		CREATE TABLE IF NOT EXISTS $1 (
			id SERIAL PRIMARY KEY,
			file_path TEXT NOT NULL,
			chunk_offset_start INTEGER,
			chunk_offset_end INTEGER,
			chunk TEXT,
			embedding halfvec($2)
		)
	`,
	CREATE_HNSW_INDEX: `
		CREATE INDEX IF NOT EXISTS $1
		ON $2 USING hnsw (embedding halfvec_cosine_ops)
		WITH (
			m = 10,
			ef_construction = 20
		)
	`,
};

export class PGliteTableManager {
	constructor(
		private provider: PGliteProvider,
		private tableName: string,
		private dimensions: number
	) {}

	private getClient(): PGlite {
		if (!this.provider.isReady()) {
			throw new Error("PGlite provider is not ready");
		}
		return this.provider.getClient();
	}

	private quoteIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private async checkTableExists(): Promise<boolean> {
		const pgClient = this.getClient();
		const tableExistsResult = await pgClient.query<{ exists: boolean }>(
			SQL_QUERIES.CHECK_TABLE_EXISTS,
			[this.tableName]
		);
		return tableExistsResult.rows[0]?.exists ?? false;
	}

	private async getTableDimensions(): Promise<number | undefined> {
		const pgClient = this.getClient();
		const dimensionsResult = await pgClient.query<{ dimensions: string }>(
			SQL_QUERIES.GET_TABLE_DIMENSIONS,
			[this.tableName]
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
		const columnExistsResult = await pgClient.query<{ exists: boolean }>(
			SQL_QUERIES.CHECK_COLUMN_EXISTS,
			[this.tableName, columnName]
		);
		return columnExistsResult.rows[0]?.exists ?? false;
	}

	private async checkHnswIndexExists(): Promise<boolean> {
		const pgClient = this.getClient();
		const indexName = `${this.tableName}_hnsw_idx`;
		const indexExistsResult = await pgClient.query<{ exists: boolean }>(
			SQL_QUERIES.CHECK_INDEX_EXISTS,
			[indexName]
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
			console.error(`Error during ${operation}:`, error);
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
			console.error(
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

				await pgClient.query(SQL_QUERIES.CREATE_EXTENSION);
				console.log("Ensured vector extension exists.");

				// Ensure halfvec type is available
				try {
					await pgClient.query(SQL_QUERIES.CHECK_HALFVEC_TYPE);
					console.log("Confirmed halfvec type is available.");
				} catch (error) {
					console.error(
						"halfvec type is not available. Falling back to vector extension:",
						error
					);
					throw new Error(
						"halfvec type not supported. Please ensure you have the latest vector extension that supports halfvec."
					);
				}

				if (force) {
					await pgClient.query(
						SQL_QUERIES.DROP_TABLE.replace("$1", quotedTableName)
					);
					console.log(
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
				await pgClient.query(createTableQuery);
				console.log(
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
					console.log(
						`HNSW index already exists for table ${this.tableName}`
					);
					return;
				}

				console.log(
					`Creating HNSW index for table ${this.tableName} using halfvec...`
				);

				const createIndexQuery = SQL_QUERIES.CREATE_HNSW_INDEX.replace(
					"$1",
					indexName
				).replace("$2", quotedTableName);
				await pgClient.query(createIndexQuery);
				console.log(`HNSW index created for table ${this.tableName}`);
			}
		);
	}
}
