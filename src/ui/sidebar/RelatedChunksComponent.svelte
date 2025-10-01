<script lang="ts">
	import type MyVectorPlugin from "../../main";
	import type { SimilarityResultItem } from "../../core/storage/types";
	import type { SimilarityResultItemWithPreview } from "../../shared/types/ui";
	import { writable, type Writable } from "svelte/store";
	import { getIcon } from "obsidian";
	import ChunkItemComponent from "./ChunkItemComponent.svelte";
	import { onDestroy, onMount, tick } from "svelte";

	export let plugin: MyVectorPlugin;
	export let activeNoteName: string | null;
	export let relatedChunks: SimilarityResultItemWithPreview[];
	export let onChunkClick: (item: SimilarityResultItem) => Promise<void>;

	type FileGroup = [string, SimilarityResultItemWithPreview[]];
	type ChunkMap = Map<string, SimilarityResultItemWithPreview[]>;
	type ChunkQueue = {
		chunks: SimilarityResultItemWithPreview[];
		currentIndex: number;
		isDisplaying: boolean;
	};

	let displayedFileGroups: FileGroup[] = [];
	let allGroupedChunks: ChunkMap = new Map();
	let displayedChunksInExpandedGroups: Map<
		string,
		SimilarityResultItemWithPreview[]
	> = new Map();
	let chunkDisplayQueues: Map<string, ChunkQueue> = new Map();
	let collapseIconSvg = "";
	let isDisplaying = false;
	let pendingDisplay: (() => void) | null = null;

	const expandedFiles: Writable<Set<string>> = writable(new Set());

	$: hasActiveNote = Boolean(activeNoteName);
	$: hasChunks = allGroupedChunks.size > 0;
	$: showEmptyState = !hasChunks;

	onMount(() => {
		initializeIcon();
		processAndDisplayChunks(relatedChunks);
	});

	onDestroy(() => {
		cleanup();
	});

	$: processAndDisplayChunks(relatedChunks);

	function initializeIcon(): void {
		const iconElement = getIcon("right-triangle");
		if (iconElement) {
			collapseIconSvg = iconElement.outerHTML;
		}
	}

	function cleanup(): void {
		isDisplaying = false;
		pendingDisplay = null;
		chunkDisplayQueues.clear();
		displayedChunksInExpandedGroups.clear();
		refreshDisplayedChunks();
	}

	function resetDisplayState(): void {
		isDisplaying = false;
		pendingDisplay = null;
		displayedFileGroups = [];
	}

	function refreshDisplayedChunks(): void {
		displayedChunksInExpandedGroups = new Map(
			displayedChunksInExpandedGroups,
		);
	}

	function groupChunksByPath(
		chunks: SimilarityResultItemWithPreview[],
	): ChunkMap {
		const map = new Map<string, SimilarityResultItemWithPreview[]>();

		if (!chunks?.length) {
			return map;
		}

		const sortedChunks = [...chunks].sort(
			(a, b) => a.distance - b.distance,
		);

		for (const chunk of sortedChunks) {
			const filePath = chunk.file_path;
			if (!map.has(filePath)) {
				map.set(filePath, []);
			}
			map.get(filePath)!.push(chunk);
		}

		return map;
	}

	function processAndDisplayChunks(
		chunks: SimilarityResultItemWithPreview[],
	): void {
		resetDisplayState();
		allGroupedChunks = groupChunksByPath(chunks);

		chunkDisplayQueues.clear();
		displayedChunksInExpandedGroups.clear();
		refreshDisplayedChunks();

		if (allGroupedChunks.size === 0) {
			updateExpandedFiles(chunks);
			return;
		}

		updateExpandedFiles(chunks);

		if (!plugin.settings.expandRelatedChunksFileGroups) {
			displayAllGroups();
		} else {
			displayGroupsProgressively();
		}
	}

	function updateExpandedFiles(
		chunks: SimilarityResultItemWithPreview[],
	): void {
		if (!chunks?.length) {
			expandedFiles.set(new Set());
			return;
		}

		if (plugin.settings.expandRelatedChunksFileGroups) {
			const allFilePaths = new Set(
				chunks.map((chunk) => chunk.file_path),
			);
			expandedFiles.set(allFilePaths);
			initializeExpandedGroups(allFilePaths);
		} else {
			expandedFiles.set(new Set());
		}
	}

	function initializeExpandedGroups(filePaths: Set<string>): void {
		displayedChunksInExpandedGroups.clear();
		chunkDisplayQueues.clear();

		filePaths.forEach((filePath) => {
			const chunksForFile = allGroupedChunks.get(filePath) || [];
			displayedChunksInExpandedGroups.set(filePath, []);

			chunkDisplayQueues.set(filePath, {
				chunks: chunksForFile,
				currentIndex: 0,
				isDisplaying: true,
			});

			if (chunksForFile.length > 0) {
				displayNextChunk(filePath);
			}
		});

		refreshDisplayedChunks();
	}

	function displayAllGroups(): void {
		displayedFileGroups = Array.from(allGroupedChunks.entries());
	}

	function displayGroupsProgressively(): void {
		const filePaths = Array.from(allGroupedChunks.keys());
		let currentIndex = 0;
		isDisplaying = true;

		const displayNextGroup = (): void => {
			if (!isDisplaying || currentIndex >= filePaths.length) {
				return;
			}

			const filePath = filePaths[currentIndex];
			const group = allGroupedChunks.get(filePath);

			if (group) {
				displayedFileGroups = [
					...displayedFileGroups,
					[filePath, group],
				];
			}

			currentIndex++;
			scheduleNextGroupDisplay(
				currentIndex < filePaths.length,
				displayNextGroup,
			);
		};

		displayNextGroup();
	}

	function scheduleNextGroupDisplay(
		hasMore: boolean,
		displayFn: () => void,
	): void {
		if (hasMore) {
			pendingDisplay = () => {
				if (isDisplaying) {
					displayFn();
				}
			};
		}
	}

	function displayNextChunk(filePath: string): void {
		const queue = chunkDisplayQueues.get(filePath);
		if (
			!queue ||
			!queue.isDisplaying ||
			queue.currentIndex >= queue.chunks.length
		) {
			return;
		}

		const chunkToAdd = queue.chunks[queue.currentIndex];
		const currentChunks =
			displayedChunksInExpandedGroups.get(filePath) || [];

		displayedChunksInExpandedGroups.set(filePath, [
			...currentChunks,
			chunkToAdd,
		]);
		refreshDisplayedChunks();

		queue.currentIndex++;
		chunkDisplayQueues.set(filePath, queue);
	}

	function onGroupRendered(element: HTMLElement): void {
		if (pendingDisplay) {
			const nextDisplay = pendingDisplay;
			pendingDisplay = null;
			requestAnimationFrame(nextDisplay);
		}
	}

	function onChunkRendered(node: HTMLElement, filePath: string) {
		requestAnimationFrame(() => {
			displayNextChunk(filePath);
		});

		return {
			destroy() {},
		};
	}

	async function toggleFile(filePath: string): Promise<void> {
		const isCurrentlyExpanded = $expandedFiles.has(filePath);

		expandedFiles.update((current) => {
			const newSet = new Set(current);
			if (newSet.has(filePath)) {
				newSet.delete(filePath);
			} else {
				newSet.add(filePath);
			}
			return newSet;
		});

		await tick();

		const isNowExpanded = $expandedFiles.has(filePath);

		if (isNowExpanded && !isCurrentlyExpanded) {
			expandFile(filePath);
		} else if (!isNowExpanded && isCurrentlyExpanded) {
			collapseFile(filePath);
		}
	}

	async function openNote(filePath: string): Promise<void> {
		try {
			await plugin.app.workspace.openLinkText(filePath, "");
		} catch (error) {
			console.error(`Failed to open note: ${filePath}`, error);
		}
	}

	function expandFile(filePath: string): void {
		const chunksToDisplay = allGroupedChunks.get(filePath) || [];
		displayedChunksInExpandedGroups.set(filePath, []);

		stopExistingQueue(filePath);

		chunkDisplayQueues.set(filePath, {
			chunks: chunksToDisplay,
			currentIndex: 0,
			isDisplaying: true,
		});

		if (chunksToDisplay.length > 0) {
			displayNextChunk(filePath);
		}
	}

	function collapseFile(filePath: string): void {
		stopExistingQueue(filePath);
		displayedChunksInExpandedGroups.delete(filePath);
		refreshDisplayedChunks();
	}

	function stopExistingQueue(filePath: string): void {
		if (chunkDisplayQueues.has(filePath)) {
			const queue = chunkDisplayQueues.get(filePath)!;
			queue.isDisplaying = false;
			chunkDisplayQueues.set(filePath, queue);
		}
	}

	function getFileName(filePath: string): string {
		const parts = filePath.split("/");
		const fullName = parts[parts.length - 1] || filePath;
		return fullName.replace(/\.[^/.]+$/, "");
	}
</script>

<div class="related-chunks-container search-result-container">
	{#if hasActiveNote}
		<div class="related-chunks-header">
			Related to: {activeNoteName}
		</div>
	{/if}

	{#if showEmptyState}
		<div class="related-chunks-empty">
			{hasActiveNote
				? "No related chunks found."
				: "Open a note to see related chunks."}
		</div>
	{/if}

	{#each displayedFileGroups as [filePath, chunks] (filePath)}
		{@const isExpanded = $expandedFiles.has(filePath)}
		{@const currentDisplayedChunks =
			displayedChunksInExpandedGroups.get(filePath) || []}

		<div class="related-chunks-file-group" use:onGroupRendered>
			<div
				class="related-chunks-file-header tree-item-self search-result-file-title"
				role="button"
				tabindex="0"
			>
				<div
					class="tree-item-icon collapse-icon"
					class:is-collapsed={!isExpanded}
					role="button"
					tabindex="0"
					onclick={() => toggleFile(filePath)}
					onkeydown={(e) => e.key === "Enter" && toggleFile(filePath)}
				>
					{@html collapseIconSvg || ``}
				</div>
				<div
					class="related-chunks-file-name tree-item-inner"
					role="button"
					tabindex="0"
					onclick={() => openNote(filePath)}
					onkeydown={(e) => e.key === "Enter" && openNote(filePath)}
				>
					{getFileName(filePath)}
				</div>
				<div class="tree-item-flair-outer">
					<div class="related-chunks-file-count tree-item-flair">
						{chunks.length}
					</div>
				</div>
			</div>

			{#if isExpanded}
				<div class="related-chunks-list">
					{#each currentDisplayedChunks as chunk (chunk.id)}
						<div use:onChunkRendered={filePath}>
							<ChunkItemComponent
								{chunk}
								{onChunkClick}
								{plugin}
							/>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.related-chunks-empty {
		color: var(--text-muted);
		padding: var(--size-4-3);
		text-align: center;
	}

	.related-chunks-file-header {
		display: flex;
	}

	.related-chunks-file-header:hover {
		background-color: var(--background-modifier-hover);
	}

	.related-chunks-list {
		padding-left: 21px;
	}

	.related-chunks-container {
		padding: 0px;
	}
</style>
