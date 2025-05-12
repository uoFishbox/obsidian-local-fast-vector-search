import type { PGlite } from "@electric-sql/pglite";
import type { PGliteProvider } from "./PGliteProvider";

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

	private async checkTableExistsInternal(): Promise<boolean> {
		const pgClient = this.getClient();
		const tableExistsResult = await pgClient.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = $1)`,
			[this.tableName]
		);
		return tableExistsResult.rows[0]?.exists ?? false;
	}

	private async getTableDimensionsInternal(): Promise<number | undefined> {
		const pgClient = this.getClient();
		const dimensionsResult = await pgClient.query<{ dimensions: string }>(
			`SELECT atttypmod as dimensions FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'embedding'`,
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

	private async checkColumnExistsInternal(
		columnName: string
	): Promise<boolean> {
		const pgClient = this.getClient();
		const columnExistsResult = await pgClient.query<{ exists: boolean }>(
			`SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = $1 AND column_name = $2
            )`,
			[this.tableName, columnName]
		);
		return columnExistsResult.rows[0]?.exists ?? false;
	}

	public async getTableStatus(): Promise<{
		exists: boolean;
		dimensions?: number;
		hasChunkColumn?: boolean;
		hasChunkOffsetColumns?: boolean;
	}> {
		try {
			const exists = await this.checkTableExistsInternal();
			if (!exists) {
				return { exists: false };
			}

			const dimensions = await this.getTableDimensionsInternal();
			const hasChunkColumn = await this.checkColumnExistsInternal(
				"chunk"
			);
			const hasChunkOffsetStartColumn =
				await this.checkColumnExistsInternal("chunk_offset_start");
			const hasChunkOffsetEndColumn =
				await this.checkColumnExistsInternal("chunk_offset_end");
			const hasChunkOffsetColumns =
				hasChunkOffsetStartColumn && hasChunkOffsetEndColumn;

			return {
				exists: true,
				dimensions,
				hasChunkColumn,
				hasChunkOffsetColumns,
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
		const pgClient = this.getClient();
		const quotedTableName = this.quoteIdentifier(this.tableName);

		try {
			await pgClient.query("CREATE EXTENSION IF NOT EXISTS vector;");
			console.log("Ensured vector extension exists.");

			if (force) {
				await pgClient.query(`DROP TABLE IF EXISTS ${quotedTableName}`);
				console.log(`Dropped existing vector table: ${this.tableName}`);
			}

			if (isNaN(this.dimensions) || this.dimensions <= 0) {
				throw new Error(
					`Invalid dimensions value for table creation: ${this.dimensions}`
				);
			}
			await pgClient.query(`
                CREATE TABLE IF NOT EXISTS ${quotedTableName} (
                    id SERIAL PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    chunk_offset_start INTEGER,
                    chunk_offset_end INTEGER,
                    chunk TEXT,
                    embedding VECTOR(${this.dimensions})
                )
            `);
			console.log(
				`Vector table ${this.tableName} created/ensured with ${this.dimensions} dimensions`
			);
		} catch (error) {
			console.error(
				`Error creating/ensuring vector table ${this.tableName}:`,
				error
			);
			throw new Error(
				`Failed to create/ensure vector table ${this.tableName}: ${error}`
			);
		}
	}
}
