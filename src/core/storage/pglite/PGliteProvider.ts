import { Plugin, normalizePath, requestUrl } from "obsidian";
import { PGlite } from "@electric-sql/pglite";
import { IdbFs } from "@electric-sql/pglite";
import { deleteDB } from "idb";
const PGLITE_VERSION = "0.2.14";

export class PGliteProvider {
	private plugin: Plugin;
	private dbName: string;
	private pgClient: PGlite | null = null;
	private isInitialized: boolean = false;
	private relaxedDurability: boolean;

	private resourceCachePaths: {
		fsBundle: string;
		wasmModule: string;
		vectorExtensionBundle: string;
	} | null = null;

	constructor(
		plugin: Plugin,
		dbName: string,
		relaxedDurability: boolean = true
	) {
		this.plugin = plugin;
		this.dbName = dbName;
		this.relaxedDurability = relaxedDurability;

		const cacheDir = normalizePath(
			`${this.plugin.manifest.dir}/pglite-cache`
		);
		this.resourceCachePaths = {
			fsBundle: normalizePath(
				`${cacheDir}/pglite-${PGLITE_VERSION}-postgres.data`
			),
			wasmModule: normalizePath(
				`${cacheDir}/pglite-${PGLITE_VERSION}-postgres.wasm`
			),
			vectorExtensionBundle: normalizePath(
				`${cacheDir}/pglite-${PGLITE_VERSION}-vector.tar.gz`
			),
		};
		console.log("PGlite resource cache directory set to:", cacheDir);
	}

	async initialize(): Promise<void> {
		if (this.isInitialized && this.pgClient) {
			console.log("PGliteProvider already initialized.");
			return;
		}

		try {
			const { fsBundle, wasmModule, vectorExtensionBundlePath } =
				await this.loadPGliteResources();

			console.log(`Creating/Opening database: ${this.dbName}`);
			this.pgClient = await this.createPGliteInstance({
				fsBundle,
				wasmModule,
				vectorExtensionBundlePath,
			});

			// インスタンス化が完了したらBlob URLを解放
			URL.revokeObjectURL(vectorExtensionBundlePath.href);

			this.isInitialized = true;
			console.log("PGlite initialized successfully");

			const cacheDir = this.resourceCachePaths!.fsBundle.substring(
				0,
				this.resourceCachePaths!.fsBundle.lastIndexOf("/")
			);
			if (!(await this.plugin.app.vault.adapter.exists(cacheDir))) {
				await this.plugin.app.vault.adapter.mkdir(cacheDir);
			}
		} catch (error) {
			console.error("Error initializing PGlite:", error);
			// 初期化失敗時は状態をリセット
			this.pgClient = null;
			this.isInitialized = false;
			throw new Error(`Failed to initialize PGlite: ${error}`);
		}
	}

	getClient(): PGlite {
		if (!this.pgClient) {
			throw new Error("PGlite client is not initialized");
		}
		return this.pgClient;
	}

	isReady(): boolean {
		return this.isInitialized && this.pgClient !== null;
	}

	async close(): Promise<void> {
		if (this.pgClient) {
			try {
				await this.pgClient.close();
				this.pgClient = null;
				this.isInitialized = false;
				console.log("PGlite connection closed");
			} catch (error) {
				console.error("Error closing PGlite connection:", error);
			}
		}
	}

	async discardDB(): Promise<void> {
		console.log(`Discarding PGlite database: ${this.dbName} using idb.`);
		try {
			if (this.pgClient) {
				await this.close();
				console.log("Closed existing PGlite client before discarding.");
			}

			await deleteDB("/pglite/" + this.dbName);
			console.log(`Successfully discarded database: ${this.dbName}`);

			this.pgClient = null;
			this.isInitialized = false;
		} catch (error: any) {
			console.error(
				`Error discarding PGlite database ${this.dbName}:`,
				error
			);
			this.pgClient = null;
			this.isInitialized = false;
			const errorMessage = error?.message || "Unknown error";
			const errorDetails = error?.name ? `(${error.name})` : "";
			throw new Error(
				`Failed to discard PGlite database ${this.dbName}: ${errorMessage} ${errorDetails}`
			);
		}
	}

	private async createPGliteInstance(options: {
		loadDataDir?: Blob;
		fsBundle: Blob;
		wasmModule: WebAssembly.Module;
		vectorExtensionBundlePath: URL;
	}): Promise<PGlite> {
		// Create PGlite instance with options

		return await PGlite.create({
			...options,
			relaxedDurability: this.relaxedDurability,
			fs: new IdbFs(this.dbName), // ここで指定したdbNameのIndexedDBが使われる
			fsBundle: options.fsBundle,
			wasmModule: options.wasmModule,
			extensions: {
				vector: options.vectorExtensionBundlePath,
			},
		});
	}

	private async loadPGliteResources(): Promise<{
		fsBundle: Blob;
		wasmModule: WebAssembly.Module;
		vectorExtensionBundlePath: URL;
	}> {
		if (!this.resourceCachePaths) {
			throw new Error("Resource cache paths not set.");
		}

		// //@ts-ignore
		// window.process = undefined; // Ensure process is undefined

		const resources = {
			fsBundle: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.data`,
				path: this.resourceCachePaths.fsBundle,
				type: "application/octet-stream",
				process: async (buffer: ArrayBuffer) =>
					new Blob([buffer], { type: "application/octet-stream" }),
			},
			wasmModule: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.wasm`,
				path: this.resourceCachePaths.wasmModule,
				type: "application/wasm",
				process: async (buffer: ArrayBuffer) => {
					const wasmBytes = new Uint8Array(buffer);

					if (!WebAssembly.validate(wasmBytes)) {
						console.error(
							"Invalid WebAssembly module data (validated as Uint8Array)."
						);
						console.error(
							`Buffer length: ${buffer.byteLength}, Uint8Array length: ${wasmBytes.length}`
						);
						throw new Error("Invalid WebAssembly module data.");
					}
					try {
						console.log(
							`Compiling WASM module from ${wasmBytes.length} bytes...`
						);
						const module = await WebAssembly.compile(wasmBytes);
						console.log("WASM module compiled successfully.");
						return module;
					} catch (compileError) {
						console.error(
							"WebAssembly.compile failed:",
							compileError
						);
						console.error(
							`Buffer length: ${buffer.byteLength}, Uint8Array length: ${wasmBytes.length}`
						);
						if (compileError instanceof Error) {
							console.error(
								"Compile Error name:",
								compileError.name
							);
							console.error(
								"Compile Error message:",
								compileError.message
							);
							console.error(
								"Compile Error stack:",
								compileError.stack
							);
						}
						throw compileError;
					}
				},
			},
			vectorExtensionBundle: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/vector.tar.gz`,
				path: this.resourceCachePaths.vectorExtensionBundle,
				type: "application/gzip",
				process: async (buffer: ArrayBuffer) => {
					const blob = new Blob([buffer], {
						type: "application/gzip",
					});
					const blobUrl = URL.createObjectURL(blob);
					console.log(
						"Created Blob URL for vector extension bundle:",
						blobUrl
					);
					return new URL(blobUrl);
				},
			},
		};

		const loadedResources: any = {};

		for (const [key, resourceInfo] of Object.entries(resources)) {
			console.log(
				`Attempting to load ${key} from cache: ${resourceInfo.path}`
			);
			try {
				const fileExists = await this.plugin.app.vault.adapter.exists(
					resourceInfo.path
				);

				let buffer: ArrayBuffer;

				if (fileExists) {
					console.log(`${key} found in cache. Reading...`);
					buffer = await this.plugin.app.vault.adapter.readBinary(
						resourceInfo.path
					);
					console.log(
						`${key} read from cache (${buffer.byteLength} bytes).`
					);
				} else {
					console.log(
						`${key} not found in cache. Downloading from ${resourceInfo.url}...`
					);
					const response = await requestUrl({
						url: resourceInfo.url,
						method: "GET",
					});

					if (response.status !== 200) {
						throw new Error(
							`Failed to download ${key}: Status ${response.status}`
						);
					}

					buffer = response.arrayBuffer;
					console.log(
						`${key} downloaded (${buffer.byteLength} bytes).`
					);

					const cacheDir = resourceInfo.path.substring(
						0,
						resourceInfo.path.lastIndexOf("/")
					);
					if (
						!(await this.plugin.app.vault.adapter.exists(cacheDir))
					) {
						await this.plugin.app.vault.adapter.mkdir(cacheDir);
					}

					console.log(`Saving ${key} to cache: ${resourceInfo.path}`);
					await this.plugin.app.vault.adapter.writeBinary(
						resourceInfo.path,
						buffer
					);
					console.log(`${key} saved to cache.`);
				}

				loadedResources[key] = await resourceInfo.process(buffer);
				console.log(`${key} processed successfully.`);
			} catch (error) {
				console.error(`Error loading or caching ${key}:`, error);
				if (error instanceof Error) {
					console.error(
						`Error details for ${key}: Name: ${error.name}, Message: ${error.message}`
					);
				}
				throw new Error(
					`Failed to load or cache PGlite resource "${key}": ${error}`
				);
			}
		}

		return {
			fsBundle: loadedResources.fsBundle,
			wasmModule: loadedResources.wasmModule,
			vectorExtensionBundlePath: loadedResources.vectorExtensionBundle,
		};
	}
}
