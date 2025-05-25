import { App, Notice } from "obsidian";
import type { VectorizationService } from "./core/services/VectorizationService";
import type { SearchService } from "./core/services/SearchService";
import type { StorageManagementService } from "./core/services/StorageManagementService";
import type { SimilarityResultItem } from "./core/storage/types";
import { NotificationService } from "./shared/services/NotificationService";

export class CommandHandler {
	private app: App;
	private vectorizationService: VectorizationService;
	private searchService: SearchService;
	private storageManagementService: StorageManagementService;
	private notificationService: NotificationService;

	constructor(
		app: App,
		vectorizationService: VectorizationService,
		searchService: SearchService,
		storageManagementService: StorageManagementService,
		notificationService: NotificationService
	) {
		this.app = app;
		this.vectorizationService = vectorizationService;
		this.searchService = searchService;
		this.storageManagementService = storageManagementService;
		this.notificationService = notificationService;
	}

	async vectorizeAllNotes(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		if (files.length === 0) {
			this.notificationService.showNotice(
				"No markdown files found to vectorize.",
				3000
			);
			return;
		}

		let vectorizeNoticeId = this.notificationService.showNotice(
			"Starting vectorization for all notes..."
		);
		const startAll = performance.now();

		try {
			const { totalVectorsProcessed } =
				await this.vectorizationService.vectorizeAllNotes(
					(message: string, isOverallProgress?: boolean) => {
						this.notificationService.updateNotice(
							vectorizeNoticeId,
							message,
							0
						);
					}
				);

			const totalTime = (performance.now() - startAll) / 1000;
			this.notificationService.updateNotice(
				vectorizeNoticeId,
				`Vectorization finished! ${totalVectorsProcessed} vectors saved in ${totalTime.toFixed(
					2
				)}s.`,
				5000
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
			this.notificationService.updateNotice(
				vectorizeNoticeId,
				`Vectorization failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}. Check console.`,
				5000
			);
		}
	}
	async rebuildAllIndexes(): Promise<void> {
		let rebuildStatusNoticeId = this.notificationService.showNotice(
			"Rebuilding all indexes... This may take a while."
		);
		try {
			await this.storageManagementService.rebuildStorage(
				(message: string) => {
					this.notificationService.updateNotice(
						rebuildStatusNoticeId,
						message,
						0
					);
				}
			);

			this.notificationService.updateNotice(
				rebuildStatusNoticeId,
				"Storage cleared. Re-vectorizing all notes...",
				0
			);
			this.notificationService.hideNotice(rebuildStatusNoticeId);
			await this.vectorizeAllNotes();

			console.log("Index rebuild process completed successfully.");
		} catch (error: any) {
			console.error("Failed to rebuild all indexes:", error);
			this.notificationService.updateNotice(
				rebuildStatusNoticeId,
				`Index rebuild failed: ${
					error.message || "Unknown error"
				}. Check console.`,
				7000
			);
		}
	}
	// このメソッドは SearchModal から呼び出される
	async searchSimilarNotes(
		query: string,
		negativeQuery?: string,
		limit: number = 10
	): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			this.notificationService.showNotice("Query cannot be empty.", 3000);
			return [];
		}
		try {
			return await this.searchService.search(query, negativeQuery, limit);
		} catch (error) {
			console.error("Error during similarity search:", error);
			this.notificationService.showNotice(
				`Search failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}. Check console.`,
				5000
			);
			throw error; // Modal側でさらにエラーハンドリングする場合や、結果表示を制御する場合
		}
	}
}
