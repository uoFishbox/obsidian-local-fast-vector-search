import { PGlite } from "@electric-sql/pglite";
//@ts-ignore
import { PGliteWorker } from "@electric-sql/pglite/worker";
import PGWorker from "./pglite.worker?worker";

export interface CreateDbOptions {
	dbName: string;
	tableName: string;
	dimensions: number;
	relaxedDurability?: boolean;
}

export const createAndInitDb = async (
	options: CreateDbOptions
): Promise<PGlite> => {
	const worker = new PGWorker();

	// PGliteWorker.create の第2引数は PGliteWorkerOptions だが、カスタムオプションを渡すためにキャストする
	const pg = await PGliteWorker.create(worker, options as any);
	console.log(
		`PGlite DB created/initialized in worker for: ${options.dbName}`
	);
	return pg;
};
