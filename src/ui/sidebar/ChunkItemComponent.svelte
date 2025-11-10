<script lang="ts">
	import { onMount } from "svelte";
	import { MarkdownRenderer, Component } from "obsidian";
	import type { SimilarityResultItem } from "../../core/storage/types";
	import type MyVectorPlugin from "../../main";

	let {
		plugin,
		chunk,
		onChunkClick,
		getChunkPreview,
	}: {
		plugin: MyVectorPlugin;
		chunk: SimilarityResultItem;
		onChunkClick: (item: SimilarityResultItem) => Promise<void>;
		getChunkPreview: (chunk: SimilarityResultItem) => Promise<string>;
	} = $props();

	let previewEl = $state<HTMLDivElement>();
	let markdownComponent = $state<Component | null>(null);
	let previewText = $state<string | null>(null);
	let isLoading = $state(true);
	let observer: IntersectionObserver;

	function viewportAction(node: HTMLElement) {
		observer = new IntersectionObserver((entries) => {
			const entry = entries[0];
			if (entry.isIntersecting) {
				loadAndRenderPreview();
				if (observer) observer.unobserve(node);
			}
		});

		observer.observe(node);

		return {
			destroy() {
				if (observer) observer.disconnect();
			},
		};
	}

	async function loadAndRenderPreview() {
		try {
			// getChunkPreviewを呼び出してテキストを取得
			const text = await getChunkPreview(chunk);
			previewText = text;
		} catch (e) {
			console.error(`Failed to load preview for chunk ${chunk.id}`, e);
			previewText = "Error loading preview.";
		} finally {
			isLoading = false;
		}
	}

	// previewTextが更新されたらMarkdownをレンダリングする
	$effect(() => {
		if (previewEl && previewText && !markdownComponent) {
			renderMarkdown();
		}
	});

	async function renderMarkdown() {
		if (markdownComponent) {
			markdownComponent.unload();
			markdownComponent = null;
		}

		if (previewEl && previewText) {
			previewEl.innerHTML = "";
			markdownComponent = new Component();
			await MarkdownRenderer.render(
				plugin.app,
				previewText, // 内部状態のpreviewTextを使用
				previewEl,
				chunk.file_path,
				markdownComponent,
			);
			if (markdownComponent) {
				markdownComponent.load();
			}
		}
	}

	onMount(() => {
		return () => {
			if (markdownComponent) {
				markdownComponent.unload();
				markdownComponent = null;
			}
		};
	});
</script>

<div
	role="button"
	tabindex="0"
	class="chunk-item search-result-file-matches markdown-preview-view markdown-rendered"
	onclick={() => onChunkClick(chunk)}
	onkeydown={(e) => e.key === "Enter" && onChunkClick(chunk)}
	use:viewportAction
>
	<div class="chunk-item-preview" bind:this={previewEl}>
		{#if isLoading}
			<!-- ローディング中のプレースホルダー。レイアウトシフトを防ぐためにmin-heightを設定 -->
			<div class="preview-placeholder">Loading...</div>
		{/if}
		<!-- previewTextがセットされたらrenderMarkdownが発火し、この要素の中身が更新される -->
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
	.preview-placeholder {
		min-height: 4em; /* コンテンツのおおよその高さに合わせる */
		color: var(--text-muted);
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
