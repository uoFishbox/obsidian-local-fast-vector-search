import { TFile, TAbstractFile, App, type CachedMetadata } from "obsidian";
import { LoggerService } from "../../shared/services/LoggerService";
import { VectorizationService } from "../services/VectorizationService";

export class FileEventHandler {
	private fileChangeTimers: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_DELAY = 2500;

	constructor(
		private app: App,
		private logger: LoggerService | null,
		private getVectorizationService: () => VectorizationService | null,
		private onFileProcessed: () => Promise<void>
	) {}

	async handleFileChange(
		file: TFile,
		_data: string,
		_cache: CachedMetadata
	): Promise<void> {
		if (!(file instanceof TFile && file.extension === "md")) {
			return;
		}

		this.logger?.verbose_log(`File changed detected: ${file.path}`);

		if (this.fileChangeTimers.has(file.path)) {
			clearTimeout(this.fileChangeTimers.get(file.path)!);
		}

		this.fileChangeTimers.set(
			file.path,
			setTimeout(async () => {
				this.fileChangeTimers.delete(file.path);
				this.logger?.log(
					`Processing debounced file change for: ${file.path}`
				);

				try {
					const vectorizationService = this.getVectorizationService();
					if (!vectorizationService) {
						this.logger?.error(
							"Vectorization service not ready in handleFileChange for: " +
								file.path
						);
						return;
					}

					const currentContent = await this.app.vault.cachedRead(
						file
					);
					const { vectorsProcessed, vectorsDeleted } =
						await vectorizationService.vectorizeSingleFile(
							file,
							currentContent
						);

					if (vectorsProcessed > 0 || vectorsDeleted > 0) {
						const message = `Updated vectors for ${file.basename}. New: ${vectorsProcessed}, Removed: ${vectorsDeleted}.`;
						this.logger?.log(message);
					} else {
						this.logger?.verbose_log(
							`No vector changes for ${file.path} after update.`
						);
					}

					await this.onFileProcessed();
				} catch (error) {
					console.error(
						`Error processing file change for ${file.path}:`,
						error
					);
				}
			}, this.DEBOUNCE_DELAY)
		);
	}

	async handleFileDelete(file: TFile): Promise<void> {
		if (!(file instanceof TFile && file.extension === "md")) {
			return;
		}

		this.logger?.log(`File deleted detected: ${file.path}`);

		if (this.fileChangeTimers.has(file.path)) {
			clearTimeout(this.fileChangeTimers.get(file.path)!);
			this.fileChangeTimers.delete(file.path);
		}

		try {
			const vectorizationService = this.getVectorizationService();
			if (!vectorizationService) {
				this.logger?.error(
					"Vectorization service not ready in handleFileDelete for: " +
						file.path
				);
				return;
			}

			const deletedCount =
				await vectorizationService.deleteVectorsForFile(file.path);
			if (deletedCount > 0) {
				const message = `Removed ${deletedCount} vectors for deleted file ${file.basename}.`;
				this.logger?.log(message);
			} else {
				this.logger?.verbose_log(
					`No vectors found to delete for ${file.path}.`
				);
			}

			await this.onFileProcessed();
		} catch (error) {
			console.error(
				`Error processing file deletion for ${file.path}:`,
				error
			);
		}
	}

	async handleFileRename(
		file: TAbstractFile,
		oldPath: string
	): Promise<void> {
		if (!(file instanceof TFile && file.extension === "md")) {
			return;
		}

		this.logger?.log(
			`File rename detected: from '${oldPath}' to '${file.path}'`
		);

		if (this.fileChangeTimers.has(oldPath)) {
			clearTimeout(this.fileChangeTimers.get(oldPath)!);
			this.fileChangeTimers.delete(oldPath);
			this.logger?.verbose_log(
				`Cleared pending change for renamed file: ${oldPath}`
			);
		}

		if (this.fileChangeTimers.has(file.path)) {
			clearTimeout(this.fileChangeTimers.get(file.path)!);
			this.fileChangeTimers.delete(file.path);
		}

		try {
			const vectorizationService = this.getVectorizationService();
			if (!vectorizationService) {
				this.logger?.error(
					"Vectorization service not ready in handleFileRename for: " +
						oldPath
				);
				return;
			}

			const updatedCount = await vectorizationService.updateFilePath(
				oldPath,
				file.path
			);

			if (updatedCount > 0) {
				const message = `Updated file path in DB for ${
					file.basename
				} (formerly ${
					oldPath.split("/").pop() || oldPath
				}). ${updatedCount} vector(s) affected.`;
				this.logger?.log(message);
			} else {
				this.logger?.verbose_log(
					`No vectors found to update for path rename from ${oldPath} to ${file.path}.`
				);
			}

			await this.onFileProcessed();
		} catch (error) {
			console.error(
				`Error processing file rename from ${oldPath} to ${file.path}:`,
				error
			);
		}
	}

	clearAllTimers(): void {
		this.fileChangeTimers.forEach((timer) => clearTimeout(timer));
		this.fileChangeTimers.clear();
		this.logger?.verbose_log("Cleared all file change debounce timers.");
	}
}
