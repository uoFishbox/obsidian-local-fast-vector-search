import { Plugin, normalizePath, requestUrl } from "obsidian";
import { PGlite } from "@electric-sql/pglite";

const PGLITE_VERSION = "0.2.14";

export class PGliteProvider {
	private plugin: Plugin;
	private dbName: string;
	private pgClient: PGlite | null = null;
	private isInitialized: boolean = false;
	private dbFilePath: string;
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

		// データベースファイル自体のパス
		this.dbFilePath = normalizePath(
			`${this.plugin.manifest.dir}/${this.dbName}.db`
		);
		console.log("Database file path set to:", this.dbFilePath);

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
			// リソースのロード（キャッシュからの読み込みまたはダウンロード）
			const { fsBundle, wasmModule, vectorExtensionBundlePath } =
				await this.loadPGliteResources();

			// データベースファイルが存在するかチェック
			const databaseFileExists =
				await this.plugin.app.vault.adapter.exists(this.dbFilePath);

			if (databaseFileExists) {
				// 既存データベースのロード
				console.log("Loading existing database from:", this.dbFilePath);
				const fileBuffer =
					await this.plugin.app.vault.adapter.readBinary(
						this.dbFilePath
					);
				const fileBlob = new Blob([fileBuffer], {
					type: "application/x-gzip",
				});

				// PGliteインスタンスの作成（既存データ付き）
				this.pgClient = await this.createPGliteInstance({
					loadDataDir: fileBlob,
					fsBundle,
					wasmModule,
					vectorExtensionBundlePath,
				});
			} else {
				// 新規データベースの作成
				console.log("Creating new database");
				this.pgClient = await this.createPGliteInstance({
					fsBundle,
					wasmModule,
					vectorExtensionBundlePath,
				});
			}

			this.isInitialized = true;
			console.log("PGlite initialized successfully");

			// データベースファイルとキャッシュファイルのディレクトリが存在することを確認
			const dbDir = this.dbFilePath.substring(
				0,
				this.dbFilePath.lastIndexOf("/")
			);
			if (!(await this.plugin.app.vault.adapter.exists(dbDir))) {
				await this.plugin.app.vault.adapter.mkdir(dbDir);
			}
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

	async save(): Promise<void> {
		if (!this.pgClient || !this.isInitialized) {
			console.log("Cannot save: PGlite not initialized");
			return;
		}

		try {
			console.log("Saving database to:", this.dbFilePath);
			const blob: Blob = await this.pgClient.dumpDataDir("gzip");
			await this.plugin.app.vault.adapter.writeBinary(
				this.dbFilePath,
				new Uint8Array(await blob.arrayBuffer())
			);
			console.log("Database saved successfully");
		} catch (error) {
			console.error("Error saving database:", error);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.pgClient) {
			try {
				// Save before closing
				await this.save();

				// Close the connection
				await this.pgClient.close();
				this.pgClient = null;
				this.isInitialized = false;
				console.log("PGlite connection closed");
			} catch (error) {
				console.error("Error closing PGlite connection:", error);
			}
		}
	}

	async deleteDatabaseFile(): Promise<void> {
		if (await this.plugin.app.vault.adapter.exists(this.dbFilePath)) {
			try {
				await this.plugin.app.vault.adapter.remove(this.dbFilePath);
				console.log(`Database file deleted: ${this.dbFilePath}`);
				this.isInitialized = false;
				this.pgClient = null;
			} catch (error) {
				console.error(
					`Error deleting database file ${this.dbFilePath}:`,
					error
				);
				throw error;
			}
		} else {
			console.log(
				`Database file not found, no need to delete: ${this.dbFilePath}`
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

		//@ts-ignore
		window.process = undefined; // Ensure process is undefined

		const resources = {
			fsBundle: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.data`,
				path: this.resourceCachePaths.fsBundle,
				type: "application/octet-stream",
				process: (buffer: ArrayBuffer) =>
					new Blob([buffer], { type: "application/octet-stream" }),
			},
			wasmModule: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/postgres.wasm`,
				path: this.resourceCachePaths.wasmModule,
				type: "application/wasm",
				process: (buffer: ArrayBuffer) => WebAssembly.compile(buffer),
			},
			vectorExtensionBundle: {
				url: `https://unpkg.com/@electric-sql/pglite@${PGLITE_VERSION}/dist/vector.tar.gz`,
				path: this.resourceCachePaths.vectorExtensionBundle,
				type: "application/gzip",
				process: (buffer: ArrayBuffer) => {
					const blob = new Blob([buffer], {
						type: "application/gzip",
					});
					return new URL(URL.createObjectURL(blob));
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

				if (fileExists) {
					console.log(`${key} found in cache. Reading...`);
					const buffer =
						await this.plugin.app.vault.adapter.readBinary(
							resourceInfo.path
						);
					loadedResources[key] = await resourceInfo.process(buffer);
					console.log(`${key} loaded from cache.`);
				} else {
					console.log(
						`${key} not found in cache. Downloading from ${resourceInfo.url}...`
					);
					const response = await requestUrl(resourceInfo.url);

					if (response.status !== 200) {
						throw new Error(
							`Failed to download ${key}: Status ${response.status}`
						);
					}

					const buffer = response.arrayBuffer;

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
						new Uint8Array(buffer)
					);
					console.log(`${key} saved to cache.`);

					loadedResources[key] = await resourceInfo.process(buffer);
					console.log(`${key} processed after download.`);
				}
			} catch (error) {
				console.error(`Error loading or caching ${key}:`, error);
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
