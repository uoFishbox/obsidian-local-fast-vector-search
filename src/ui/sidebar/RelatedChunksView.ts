import { ItemView, WorkspaceLeaf, MarkdownView, TFile } from "obsidian";
import { mount, unmount } from "svelte";
import RelatedChunksComponent from "./RelatedChunksComponent.svelte";
import MyVectorPlugin from "../../main";
import type { SimilarityResultItem } from "../../core/storage/types";
import type { SimilarityResultItemWithPreview } from "../../shared/types/ui";
import {
	offsetToPosition,
	extractChunkPreview,
} from "../../shared/utils/textUtils";

export const VIEW_TYPE_RELATED_CHUNKS = "related-chunks-sidebar";

export class RelatedChunksView extends ItemView {
	plugin: MyVectorPlugin;
	component?: RelatedChunksComponent;
	currentNoteName: string | null = null;
	currentResults: SimilarityResultItemWithPreview[] = [];
	target: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyVectorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RELATED_CHUNKS;
	}

	getDisplayText(): string {
		return "Related Chunks";
	}
	getIcon(): string {
		return "lucide-link-2";
	}
	async onOpen() {
		this.contentEl.empty();
		this.target = document.createElement("div");
		this.contentEl.appendChild(this.target);

		this.renderComponent();
	}
	private renderComponent() {
		if (this.component) {
			// 既存のコンポーネントがあればアンマウント
			const oldComponent = this.component;
			this.component = undefined; // 先にundefinedにして再帰呼び出しを防ぐ
			try {
				unmount(oldComponent);
			} catch (e) {
				this.plugin.logger?.warn(
					"Error unmounting Svelte component:",
					e
				);
			}
		}

		if (!this.target) return;

		this.component = mount(RelatedChunksComponent, {
			target: this.target,
			props: {
				plugin: this.plugin,
				activeNoteName: this.currentNoteName,
				relatedChunks: this.currentResults,
				onChunkClick: this.handleChunkClick.bind(this),
			},
		}) as RelatedChunksComponent;
	}
	async onClose() {
		if (this.component) {
			const oldComponent = this.component;
			this.component = undefined;
			try {
				unmount(oldComponent);
			} catch (e) {
				this.plugin.logger?.warn(
					"Error unmounting Svelte component on close:",
					e
				);
			}
		}

		if (this.target) {
			this.target.remove();
			this.target = null;
		}
	}
	async updateView(noteName: string | null, results: SimilarityResultItem[]) {
		this.currentNoteName = noteName;
		this.currentResults = await Promise.all(
			results.map((item) => this.createItemWithPreview(item))
		);
		this.renderComponent();
	}

	private async createItemWithPreview(
		item: SimilarityResultItem
	): Promise<SimilarityResultItemWithPreview> {
		const itemWithPreview: SimilarityResultItemWithPreview = { ...item };

		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(
				item.file_path
			);

			if (!(file instanceof TFile)) {
				itemWithPreview.previewText = "File not found for preview.";
				return itemWithPreview;
			}

			const content = await this.plugin.app.vault.cachedRead(file);
			itemWithPreview.previewText = extractChunkPreview(
				content,
				item.chunk_offset_start ?? -1,
				item.chunk_offset_end ?? -1
			);
		} catch (e) {
			console.error("Error extracting text for preview:", e);
			this.plugin.logger?.error("Error extracting text for preview:", e);
			itemWithPreview.previewText = "Error loading preview.";
		}

		return itemWithPreview;
	}

	clearView() {
		this.updateView(null, []);
	}

	private async handleChunkClick(item: SimilarityResultItem) {
		const file = this.app.vault.getAbstractFileByPath(item.file_path);
		if (!(file instanceof TFile)) {
			return;
		}

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		if (!(leaf.view instanceof MarkdownView)) {
			return;
		}

		let position = { line: 0, ch: 0 };

		if (item.chunk_offset_start != null && item.chunk_offset_start !== -1) {
			const content = await this.app.vault.cachedRead(file);
			position = offsetToPosition(content, item.chunk_offset_start);
		}

		leaf.view.editor.setCursor(position);
		leaf.view.editor.scrollIntoView({ from: position, to: position }, true);
	}
}
