import { PGlite } from "@electric-sql/pglite";
import { IdbFs } from "@electric-sql/pglite";
// @ts-ignore
import { PGliteWorkerOptions, worker } from "@electric-sql/pglite/worker";
import { IDBPDatabase, openDB } from "idb";
import { SQL_QUERIES } from "../sql-queries";

const PGLITE_VERSION = "0.2.14";
const IDB_NAME_RESOURCES = "pglite-resources-cache";
const IDB_STORE_NAME_RESOURCES = "resources";

interface CustomPGliteWorkerOptions extends PGliteWorkerOptions {
	dbName: string;
	tableName: string;
	dimensions: number;
	relaxedDurability?: boolean;
}

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
			// メインスレッドに進行状況を通知
			postMessage({
				type: "status",
				payload: `[Worker] Loading ${resourceName}...`,
			});
			let cachedData: ArrayBuffer | undefined = await db.get(
				IDB_STORE_NAME_RESOURCES,
				resourceInfo.key
			);

			if (cachedData) {
				postMessage({
					type: "status",
					payload: `[Worker] ${resourceName} found in cache.`,
				});
			} else {
				postMessage({
					type: "status",
					payload: `[Worker] ${resourceName} not in cache, downloading...`,
				});
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
				postMessage({
					type: "status",
					payload: `[Worker] ${resourceName} downloaded and cached.`,
				});
			}
			loadedResources[resourceName] = await resourceInfo.process(
				cachedData
			);
		}
	} catch (error) {
		console.error("[Worker] Error loading PGlite resources:", error);
		postMessage({
			type: "error",
			payload: `[Worker] Error loading resources: ${error}`,
		});
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

worker({
	async init(options: PGliteWorkerOptions): Promise<PGlite> {
		const customOptions = options as CustomPGliteWorkerOptions;
		let db: PGlite;
		let vectorBundleUrl: URL | null = null;
		try {
			postMessage({
				type: "status",
				payload: "[Worker] Initializing PGlite...",
			});
			const resources = await getPGliteResources();
			vectorBundleUrl = resources.vectorExtensionBundlePath;

			const dbPath = `idb://${customOptions.dbName}`;
			postMessage({
				type: "status",
				payload: `[Worker] Creating PGlite instance for ${dbPath}`,
			});

			postMessage({
				type: "status",
				payload: resources.vectorExtensionBundlePath.toString(),
			});

			db = (await PGlite.create(dbPath, {
				relaxedDurability: customOptions.relaxedDurability ?? true,
				fsBundle: resources.fsBundle,
				fs: new IdbFs(options.dbName),
				wasmModule: resources.wasmModule,
				extensions: {
					vector: resources.vectorExtensionBundlePath,
				},
			})) as PGlite;
			postMessage({
				type: "status",
				payload: "[Worker] PGlite instance created.",
			});
		} catch (error) {
			console.error("[Worker] Error creating PGlite instance:", error);
			postMessage({
				type: "error",
				payload: `[Worker] Error creating PGlite: ${error}`,
			});
			if (vectorBundleUrl) URL.revokeObjectURL(vectorBundleUrl.href);
			throw error;
		} finally {
			if (vectorBundleUrl) {
				URL.revokeObjectURL(vectorBundleUrl.href);
				postMessage({
					type: "status",
					payload: "[Worker] Revoked Blob URL for vector extension.",
				});
			}
		}

		const tableName = customOptions.tableName;
		const dimensions = customOptions.dimensions;
		const indexName = `${tableName}_hnsw_idx`;

		postMessage({
			type: "status",
			payload: `[Worker] Ensuring schema for table: ${tableName}, dimensions: ${dimensions}`,
		});

		await db.exec(SQL_QUERIES.CREATE_EXTENSION);
		postMessage({
			type: "status",
			payload: "[Worker] Vector extension ensured.",
		});

		const createTableSql = SQL_QUERIES.CREATE_TABLE.replace(
			"$1",
			quoteIdentifier(tableName)
		).replace("$2", dimensions.toString());
		await db.exec(createTableSql);
		postMessage({
			type: "status",
			payload: `[Worker] Table ${tableName} ensured.`,
		});

		const createIndexSql = SQL_QUERIES.CREATE_HNSW_INDEX.replace(
			"$1",
			quoteIdentifier(indexName)
		).replace("$2", quoteIdentifier(tableName));
		await db.exec(createIndexSql);
		postMessage({
			type: "status",
			payload: `[Worker] Index ${indexName} for table ${tableName} ensured.`,
		});

		postMessage({
			type: "status",
			payload: "[Worker] PGlite initialization complete.",
		});
		return db;
	},
});
