import { Plugin, Notice, App, PluginSettingTab, Setting } from "obsidian";
import MyVectorPlugin from "../main";
import { DiscardDBModal } from "./modals/DiscardDBModal";
import { DeleteResourcesModal } from "./modals/DeleteResourcesModal";
import { RebuildIndexModal } from "./modals/RebuildIndexModal";
import { RebuildAllIndexesModal } from "./modals/RebuildAllIndexesModal";

export class VectorizerSettingTab extends PluginSettingTab {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Index management" });

		new Setting(containerEl)
			.setName("Rebuild All Indexes")
			.setDesc(
				"Rebuild the entire vector index from scratch. This will clear all existing data and re-process all your notes."
			)
			.addButton((button) =>
				button
					.setButtonText("Rebuild Indexes")
					.setCta()
					.onClick(() => {
						new RebuildAllIndexesModal(this.app, async () => {
							await this.plugin.commandRegistrar?.rebuildAllIndexes();
						}).open();
					})
			);

		containerEl.createEl("h2", { text: "Database management" });

		new Setting(containerEl)
			.setName("Discard Database")
			.setDesc("Permanently delete the PGlite database.")
			.addButton((button) =>
				button
					.setButtonText("Discard DB")
					.setCta()
					.onClick(() => {
						new DiscardDBModal(this.app, async () => {
							await this.plugin.clearResources(true);
						}).open();
					})
			);

		new Setting(containerEl)
			.setName("Delete Resources")
			.setDesc(
				"Permanently delete cached models (Transformers.js) and PGlite resources (IndexedDB). This may free up disk space but resources will need to be re-downloaded."
			)
			.addButton((button) =>
				button
					.setButtonText("Delete Resources")
					.setCta()
					.onClick(() => {
						new DeleteResourcesModal(this.app, async () => {
							await this.plugin.clearResources(false);
						}).open();
					})
			);

		containerEl.createEl("h2", { text: "Search modal" });

		new Setting(containerEl)
			.setName("Search Result Limit")
			.setDesc("Maximum number of search results to display.")
			.addText((text) =>
				text
					.setPlaceholder("e.g., 100")
					.setValue(this.plugin.settings.searchResultLimit.toString())
					.onChange(async (value) => {
						const limit = parseInt(value);
						if (!isNaN(limit) && limit > 0) {
							this.plugin.settings.searchResultLimit = limit;
							await this.plugin.saveSettings();
						} else {
							new Notice(
								"Please enter a valid positive number for search result limit."
							);
						}
					})
			);

		containerEl.createEl("h2", { text: "Related chunks view" });

		new Setting(containerEl)
			.setName("Related Chunks Result Limit")
			.setDesc(
				"Maximum number of related chunks to display in the sidebar."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g., 10")
					.setValue(
						this.plugin.settings.relatedChunksResultLimit.toString()
					)
					.onChange(async (value) => {
						const limit = parseInt(value);
						if (!isNaN(limit) && limit > 0) {
							this.plugin.settings.relatedChunksResultLimit =
								limit;
							await this.plugin.saveSettings();
						} else {
							new Notice(
								"Please enter a valid positive number for related chunks result limit."
							);
						}
					})
			);

		new Setting(containerEl)
			.setName("Auto Show Related Chunks Sidebar")
			.setDesc(
				"Automatically open the related chunks sidebar when a note is opened."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoShowRelatedChunksSidebar)
					.onChange(async (value) => {
						this.plugin.settings.autoShowRelatedChunksSidebar =
							value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Expand Related Chunks File Groups")
			.setDesc(
				"Automatically expand file groups in the related chunks sidebar when the view is updated."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.expandRelatedChunksFileGroups
					)
					.onChange(async (value) => {
						this.plugin.settings.expandRelatedChunksFileGroups =
							value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", { text: "Vectorization" });

		new Setting(containerEl)
			.setName("Exclude Headers from Vectorization")
			.setDesc(
				"If enabled, markdown headers (#, ##, etc.) will be excluded from the text before vectorization. Changing this requires a full index rebuild."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.excludeHeadersInVectorization
					)
					.onChange(async (value) => {
						const oldValue =
							this.plugin.settings.excludeHeadersInVectorization;
						if (value === oldValue) {
							return;
						}

						const onConfirm = async () => {
							this.plugin.settings.excludeHeadersInVectorization =
								value;
							await this.plugin.saveSettings();

							try {
								sessionStorage.setItem(
									"my-vector-plugin-rebuild-flag",
									"true"
								);
								new Notice(
									"Setting updated. Reloading the app to start index rebuild..."
								);
								setTimeout(() => {
									this.app.commands.executeCommandById(
										"app:reload"
									);
								}, 1500);
							} catch (error) {
								console.error(
									"Failed to set rebuild flag and reload:",
									error
								);
								new Notice(
									"Could not initiate rebuild process. Check console."
								);
								sessionStorage.removeItem(
									"my-vector-plugin-rebuild-flag"
								);
								toggle.setValue(oldValue); // Revert UI
							}
						};
						const onCancel = () => {
							new Notice("Change cancelled.");
							toggle.setValue(oldValue);
						};
						new RebuildIndexModal(
							this.app,
							onConfirm,
							onCancel
						).open();
					})
			);

		containerEl.createEl("h2", { text: "General" });

		// new Setting(containerEl)
		// 	.setName("Provider")
		// 	.setDesc(
		// 		"Select the vectorizer provider (Requires restart or reload after change)"
		// 	)
		// 	.addDropdown((dropdown) =>
		// 		dropdown
		// 			.addOption("transformers", "Transformers.js (in Obsidian)")
		// 			.setValue(this.plugin.settings.provider)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.provider = value;
		// 				await this.plugin.saveSettings();
		// 				new Notice(
		// 					"Provider changed. Please reload the plugin for changes to take effect."
		// 				);
		// 			})
		// 	);

		new Setting(containerEl)
			.setName("Enable Verbose Logging")
			.setDesc("Enable detailed logging for development purposes.")
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.verboseLoggingEnabled || false
					)
					.onChange(async (value) => {
						this.plugin.settings.verboseLoggingEnabled = value;
						await this.plugin.saveSettings();
						if (this.plugin.logger) {
							this.plugin.logger.updateSettings({
								verboseLoggingEnabled: value,
							});
						}
					})
			);
	}
}
