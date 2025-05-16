export const SQL_QUERIES = {
	CHECK_TABLE_EXISTS: `SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = $1)`,
	SET_ENVIRONMENT: `SET max_parallel_maintenance_workers = 8`,
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
