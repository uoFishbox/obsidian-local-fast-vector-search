import { Plugin, normalizePath, requestUrl } from "obsidian";
import { PGlite } from "@electric-sql/pglite";
import { IdbFs } from "@electric-sql/pglite";
import { deleteDB } from "idb";
const PGLITE_VERSION = "0.2.14";

import { LoggerService } from "../../../shared/services/LoggerService";

export class PGliteProvider {
	private plugin: Plugin;
	private dbName: string;
	private pgClient: PGlite | null = null;
	private isInitialized: boolean = false;
	private relaxedDurability: boolean;
	private logger: LoggerService | null;

	private resourceCachePaths: {
		fsBundle: string;
		wasmModule: string;
		vectorExtensionBundle: string;
	} | null = null;

	constructor(
		plugin: Plugin,
		dbName: string,
		relaxedDurability: boolean = true,
		logger: LoggerService | null
	) {
		this.plugin = plugin;
		this.logger = logger;
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
		this.logger?.verbose_log(
			"PGlite resource cache directory set to:",
			cacheDir
		);
	}

	async initialize(): Promise<void> {
		if (this.isInitialized && this.pgClient) {
			this.logger?.verbose_log("PGliteProvider already initialized.");
			return;
		}

		try {
			const { fsBundle, wasmModule, vectorExtensionBundlePath } =
				await this.loadPGliteResources();

			this.logger?.verbose_log(
				`Creating/Opening database: ${this.dbName}`
			);
			this.pgClient = await this.createPGliteInstance({
				fsBundle,
				wasmModule,
				vectorExtensionBundlePath,
			});

			// インスタンス化が完了したらBlob URLを解放
			URL.revokeObjectURL(vectorExtensionBundlePath.href);

			this.isInitialized = true;
			this.logger?.verbose_log("PGlite initialized successfully");

			const cacheDir = this.resourceCachePaths!.fsBundle.substring(
				0,
				this.resourceCachePaths!.fsBundle.lastIndexOf("/")
			);
			if (!(await this.plugin.app.vault.adapter.exists(cacheDir))) {
				await this.plugin.app.vault.adapter.mkdir(cacheDir);
			}
		} catch (error) {
			this.logger?.error("Error initializing PGlite:", error);
			// 初期化失敗時は状態をリセット
			this.pgClient = null;
			this.isInitialized = false;
			throw new Error(`Failed to initialize PGlite: ${error}`);
		}
	}

	getClient(): PGlite {
		if (!this.pgClient) {
			const error = new Error("PGlite client is not initialized");
			this.logger?.error("PGlite client error:", error);
			throw error;
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
				this.logger?.verbose_log("PGlite connection closed");
			} catch (error) {
				this.logger?.error("Error closing PGlite connection:", error);
			}
		}
	}

	async discardDB(): Promise<void> {
		this.logger?.verbose_log(
			`Discarding PGlite database: ${this.dbName} using idb.`
		);
		try {
			if (this.pgClient) {
				await this.close();
				this.logger?.verbose_log(
					"Closed existing PGlite client before discarding."
				);
			}

			await deleteDB("/pglite/" + this.dbName);
			this.logger?.verbose_log(
				`Successfully discarded database: ${this.dbName}`
			);

			this.pgClient = null;
			this.isInitialized = false;
		} catch (error: any) {
			this.logger?.error(
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
						this.logger?.error(
							"Invalid WebAssembly module data (validated as Uint8Array)."
						);
						this.logger?.error(
							`Buffer length: ${buffer.byteLength}, Uint8Array length: ${wasmBytes.length}`
						);
						throw new Error("Invalid WebAssembly module data.");
					}
					try {
						this.logger?.verbose_log(
							`Compiling WASM module from ${wasmBytes.length} bytes...`
						);
						const module = await WebAssembly.compile(wasmBytes);
						this.logger?.verbose_log(
							"WASM module compiled successfully."
						);
						return module;
					} catch (compileError) {
						this.logger?.error(
							"WebAssembly.compile failed:",
							compileError
						);
						this.logger?.error(
							`Buffer length: ${buffer.byteLength}, Uint8Array length: ${wasmBytes.length}`
						);
						if (compileError instanceof Error) {
							this.logger?.error(
								"Compile Error name:",
								compileError.name
							);
							this.logger?.error(
								"Compile Error message:",
								compileError.message
							);
							this.logger?.error(
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
					this.logger?.verbose_log(
						"Created Blob URL for vector extension bundle:",
						blobUrl
					);
					return new URL(blobUrl);
				},
			},
		};

		const loadedResources: any = {};

		for (const [key, resourceInfo] of Object.entries(resources)) {
			this.logger?.verbose_log(
				`Attempting to load ${key} from cache: ${resourceInfo.path}`
			);
			try {
				const fileExists = await this.plugin.app.vault.adapter.exists(
					resourceInfo.path
				);

				let buffer: ArrayBuffer;

				if (fileExists) {
					this.logger?.verbose_log(
						`${key} found in cache. Reading...`
					);
					buffer = await this.plugin.app.vault.adapter.readBinary(
						resourceInfo.path
					);
					this.logger?.verbose_log(
						`${key} read from cache (${buffer.byteLength} bytes).`
					);
				} else {
					this.logger?.verbose_log(
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
					this.logger?.verbose_log(
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

					this.logger?.verbose_log(
						`Saving ${key} to cache: ${resourceInfo.path}`
					);
					await this.plugin.app.vault.adapter.writeBinary(
						resourceInfo.path,
						buffer
					);
					this.logger?.verbose_log(`${key} saved to cache.`);
				}

				loadedResources[key] = await resourceInfo.process(buffer);
				this.logger?.verbose_log(`${key} processed successfully.`);
			} catch (error) {
				this.logger?.error(`Error loading or caching ${key}:`, error);
				if (error instanceof Error) {
					this.logger?.error(
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
