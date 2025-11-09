import { App, WorkspaceLeaf, MarkdownView } from "obsidian";
import { LoggerService } from "../../shared/services/LoggerService";
import { NotificationService } from "../../shared/services/NotificationService";
import { NoteVectorService } from "../services/NoteVectorService";
import {
	RelatedChunksView,
	VIEW_TYPE_RELATED_CHUNKS,
} from "../../ui/sidebar/RelatedChunksView";
import type { PluginSettings } from "../../pluginSettings";

export class ViewManager {
	public lastProcessedFilePath: string | null = null;

	constructor(
		private app: App,
		private logger: LoggerService | null,
		private settings: PluginSettings,
		private getNoteVectorService: () => NoteVectorService | null,
		private notificationService: NotificationService | null
	) {}

	async activateRelatedChunksView(): Promise<void> {
		this.logger?.verbose_log(
			`activateRelatedChunksView: Attempting to activate or create RelatedChunksView.`
		);

		try {
			const { workspace } = this.app;
			const existingLeaves = workspace.getLeavesOfType(
				VIEW_TYPE_RELATED_CHUNKS
			);

			this.logger?.verbose_log(
				`activateRelatedChunksView: Found ${existingLeaves.length} existing leaves.`
			);

			const primaryLeaf = this.cleanupDuplicateLeaves(existingLeaves);

			if (primaryLeaf) {
				this.logger?.verbose_log(
					`activateRelatedChunksView: Reusing existing leaf.`
				);
				workspace.revealLeaf(primaryLeaf);
				return;
			}

			this.logger?.verbose_log(
				`activateRelatedChunksView: Creating new leaf.`
			);

			const newLeaf = await this.createRelatedChunksLeaf();
			if (newLeaf) {
				await newLeaf.setViewState({
					type: VIEW_TYPE_RELATED_CHUNKS,
					active: true,
				});
				workspace.revealLeaf(newLeaf);
				this.logger?.verbose_log(
					`activateRelatedChunksView: New leaf created and revealed successfully.`
				);
			} else {
				throw new Error(
					"Failed to create a new leaf for RelatedChunksView"
				);
			}
		} catch (error) {
			this.logger?.error(
				`activateRelatedChunksView: Error occurred:`,
				error
			);
			throw error;
		}
	}

	private cleanupDuplicateLeaves(
		leaves: WorkspaceLeaf[]
	): WorkspaceLeaf | null {
		if (leaves.length === 0) {
			return null;
		}

		if (leaves.length > 1) {
			this.logger?.warn(
				`Found ${
					leaves.length
				} duplicate RelatedChunksView leaves. Cleaning up ${
					leaves.length - 1
				} duplicates.`
			);

			for (let i = 1; i < leaves.length; i++) {
				this.logger?.verbose_log(
					`Detaching duplicate leaf instance ${i + 1}.`
				);
				leaves[i].detach();
			}
		}

		return leaves[0];
	}

	private async createRelatedChunksLeaf(): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;

		let leaf = workspace.getRightLeaf(false);
		if (leaf) {
			this.logger?.verbose_log("Using right sidebar for new leaf.");
			return leaf;
		}

		const activeMarkdownView = workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView?.leaf) {
			this.logger?.verbose_log(
				"Creating leaf by splitting active markdown view."
			);
			try {
				leaf = workspace.createLeafBySplit(
					activeMarkdownView.leaf,
					"vertical",
					false
				);
				if (leaf) return leaf;
			} catch (error) {
				this.logger?.warn("Failed to create leaf by splitting:", error);
			}
		}

		this.logger?.verbose_log("Creating new leaf in right sidebar.");
		try {
			leaf = workspace.getLeaf("split", "vertical");
			if (leaf) return leaf;
		} catch (error) {
			this.logger?.warn("Failed to create leaf in right sidebar:", error);
		}

		this.logger?.verbose_log("Fallback: Creating floating leaf.");
		try {
			leaf = workspace.getLeaf(true);
			return leaf;
		} catch (error) {
			this.logger?.error("Failed to create fallback leaf:", error);
			return null;
		}
	}

	async handleActiveLeafChange(): Promise<void> {
		const currentActiveLeaf = this.app.workspace.activeLeaf;
		if (
			currentActiveLeaf &&
			currentActiveLeaf.view instanceof RelatedChunksView
		) {
			this.logger?.verbose_log(
				"Active leaf is RelatedChunksView itself, skipping update to prevent flickering or state loss."
			);
			return;
		}

		const activeFile = this.app.workspace.getActiveFile();
		const currentFilePath = activeFile?.path || null;

		if (currentFilePath === this.lastProcessedFilePath) {
			this.logger?.verbose_log(
				`Active file is the same as previously processed (${currentFilePath}), skipping update.`
			);
			return;
		}

		this.lastProcessedFilePath = currentFilePath;

		const noteVectorService = this.getNoteVectorService();
		if (!noteVectorService) {
			this.logger?.warn(
				"NoteVectorService not ready for active leaf change."
			);
			return;
		}

		const sidebarLeaves = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_RELATED_CHUNKS
		);

		if (activeFile && activeFile.extension === "md") {
			this.logger?.verbose_log(
				`Active file changed: ${activeFile.path}. Finding related chunks.`
			);
			try {
				const noteVector = await noteVectorService.getNoteVectorFromDB(
					activeFile
				);
				if (noteVector) {
					const searchResults =
						await noteVectorService.findSimilarChunks(
							noteVector,
							this.settings.relatedChunksResultLimit,
							activeFile.path
						);

					if (sidebarLeaves.length > 0) {
						const sidebarView = sidebarLeaves[0]
							.view as RelatedChunksView;
						sidebarView.updateView(
							activeFile.basename,
							searchResults
						);
					} else if (this.settings.autoShowRelatedChunksSidebar) {
						await this.activateRelatedChunksView();
						const newSidebarLeaves =
							this.app.workspace.getLeavesOfType(
								VIEW_TYPE_RELATED_CHUNKS
							);
						if (newSidebarLeaves.length > 0) {
							const sidebarView = newSidebarLeaves[0]
								.view as RelatedChunksView;
							sidebarView.updateView(
								activeFile.basename,
								searchResults
							);
						}
					}
				} else {
					this.logger?.verbose_log(
						`Could not get note vector for ${activeFile.path}. It might not be vectorized yet or is empty.`
					);
					if (sidebarLeaves.length > 0) {
						const sidebarView = sidebarLeaves[0]
							.view as RelatedChunksView;
						sidebarView.clearView();
					}
				}
			} catch (error) {
				this.logger?.error(
					`Error processing related chunks for ${activeFile.path}:`,
					error
				);
				this.notificationService?.showNotice(
					"Failed to find related chunks. Check console."
				);
				if (sidebarLeaves.length > 0) {
					const sidebarView = sidebarLeaves[0]
						.view as RelatedChunksView;
					sidebarView.clearView();
				}
			}
		} else {
			this.logger?.verbose_log(
				"No active markdown file or active file is not markdown."
			);
			if (sidebarLeaves.length > 0) {
				const sidebarView = sidebarLeaves[0].view as RelatedChunksView;
				sidebarView.clearView();
			}
		}
	}

	resetLastProcessedFile(): void {
		this.lastProcessedFilePath = null;
	}
}
