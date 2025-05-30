<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { MarkdownRenderer, Component } from "obsidian";
	import type { SimilarityResultItem } from "../../core/storage/types";
	import type MyVectorPlugin from "../../main";

	export let plugin: MyVectorPlugin;

	interface SimilarityResultItemWithPreview extends SimilarityResultItem {
		previewText?: string;
	}

	export let chunk: SimilarityResultItemWithPreview;
	export let onChunkClick: (item: SimilarityResultItem) => Promise<void>;

	let previewEl: HTMLDivElement;
	let markdownComponent: Component | null = null;

	onMount(async () => {
		if (previewEl && chunk.previewText) {
			markdownComponent = new Component();
			await MarkdownRenderer.render(
				plugin.app,
				chunk.previewText,
				previewEl,
				chunk.file_path,
				markdownComponent,
			);
			markdownComponent.load();
		} else if (previewEl && !chunk.previewText) {
			previewEl.textContent = "Loading preview...";
		}
	});

	onDestroy(() => {
		if (markdownComponent) {
			markdownComponent.unload();
			markdownComponent = null;
		}
	});
</script>

<div
	role="button"
	tabindex="0"
	class="chunk-item search-result-file-matches markdown-preview-view markdown-rendered"
	onclick={() => onChunkClick(chunk)}
	onkeydown={(e) => e.key === "Enter" && onChunkClick(chunk)}
>
	<div class="chunk-item-preview" bind:this={previewEl}>
		{#if !chunk.previewText && !markdownComponent}
			Loading preview...
		{/if}
	</div>

	<div class="chunk-item-meta">
		Distance: {chunk.distance.toFixed(4)}
	</div>
</div>

<style>
	.chunk-item {
		padding: var(--size-2-3);
		margin-bottom: var(--size-2-2);
		border-radius: var(--radius-s);
		cursor: pointer;
	}
	.chunk-item:hover {
		background-color: var(--background-modifier-hover);
	}
	.chunk-item-preview {
		margin-bottom: var(--size-2-1);
		color: var(--text-normal);
	}
	.chunk-item-meta {
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
	}
</style>
