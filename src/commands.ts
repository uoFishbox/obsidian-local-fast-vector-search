import { Notice, App } from "obsidian";
import type { VectorizationService } from "./core/services/VectorizationService";
import type { SearchService } from "./core/services/SearchService";
import type { StorageManagementService } from "./core/services/StorageManagementService";
import type { SimilarityResultItem } from "./core/storage/types";
// SearchModal は CommandHandler 経由で SearchService を利用する形でも良いし、
// 直接 SearchService を渡す形でも良い。ここでは CommandHandler が仲介する。

export class CommandHandler {
	private app: App;
	private vectorizationService: VectorizationService;
	private searchService: SearchService;
	private storageManagementService: StorageManagementService;

	constructor(
		app: App,
		vectorizationService: VectorizationService,
		searchService: SearchService,
		storageManagementService: StorageManagementService
	) {
		this.app = app;
		this.vectorizationService = vectorizationService;
		this.searchService = searchService;
		this.storageManagementService = storageManagementService;
	}

	private _showNotice(
		message: string,
		timeout: number = 0,
		existingNotice?: Notice
	): Notice {
		if (existingNotice) {
			existingNotice.setMessage(message);
			if (timeout > 0) {
				setTimeout(() => existingNotice.hide(), timeout);
			}
			return existingNotice;
		}
		return new Notice(message, timeout);
	}

	async vectorizeAllNotes(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		if (files.length === 0) {
			this._showNotice("No markdown files found to vectorize.", 3000);
			return;
		}

		let vectorizeNotice = this._showNotice(
			"Starting vectorization for all notes..."
		);
		const startAll = performance.now();

		try {
			const { totalVectorsProcessed } =
				await this.vectorizationService.vectorizeAllNotes(
					(message: string, isOverallProgress?: boolean) => {
						this._showNotice(message, 0, vectorizeNotice);
					}
				);

			const totalTime = (performance.now() - startAll) / 1000;
			this._showNotice(
				`Vectorization finished! ${totalVectorsProcessed} vectors saved in ${totalTime.toFixed(
					2
				)}s.`,
				5000,
				vectorizeNotice
			);
			console.log(
				`All notes vectorized and saved in ${totalTime.toFixed(
					2
				)}s. Total vectors processed: ${totalVectorsProcessed}`
			);
		} catch (error) {
			console.error(
				"Vectorization of all notes failed unexpectedly:",
				error
			);
			this._showNotice(
				`Vectorization failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}. Check console.`,
				5000,
				vectorizeNotice
			);
		}
	}

	async rebuildAllIndexes(): Promise<void> {
		let rebuildStatusNotice = this._showNotice(
			"Rebuilding all indexes... This may take a while."
		);
		try {
			await this.storageManagementService.rebuildStorage(
				(message: string) => {
					this._showNotice(message, 0, rebuildStatusNotice);
				}
			);

			this._showNotice(
				"Storage cleared. Re-vectorizing all notes...",
				0,
				rebuildStatusNotice
			);
			// vectorizeAllNotes が独自の Notice を出すため、一度 hide するか、
			// vectorizeAllNotes の Notice 更新を rebuildStatusNotice に委譲する
			rebuildStatusNotice.hide();
			await this.vectorizeAllNotes(); // This will show its own notices

			console.log("Index rebuild process completed successfully.");
			// vectorizeAllNotes の成功 Notice が最後に出るので、ここでは追加の Notice は不要
		} catch (error: any) {
			console.error("Failed to rebuild all indexes:", error);
			this._showNotice(
				`Index rebuild failed: ${
					error.message || "Unknown error"
				}. Check console.`,
				7000,
				rebuildStatusNotice
			);
		}
	}

	// このメソッドは SearchModal から呼び出される
	async searchSimilarNotes(
		query: string,
		limit: number = 10
	): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			this._showNotice("Query cannot be empty.", 3000);
			return [];
		}
		try {
			return await this.searchService.search(query, limit);
		} catch (error) {
			console.error("Error during similarity search:", error);
			this._showNotice(
				`Search failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}. Check console.`,
				5000
			);
			throw error; // Modal側でさらにエラーハンドリングする場合や、結果表示を制御する場合
		}
	}
}
