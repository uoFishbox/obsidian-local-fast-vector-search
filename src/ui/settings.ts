import { Plugin, Notice, App, PluginSettingTab, Setting } from "obsidian";
import MyVectorPlugin from "../main";
import { DiscardDBModal } from "./modals/DiscardDBModal";
import { DeleteResourcesModal } from "./modals/DeleteResourcesModal";

export class VectorizerSettingTab extends PluginSettingTab {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vectorizer Settings" });

		new Setting(containerEl)
			.setName("Provider")
			.setDesc(
				"Select the vectorizer provider (Requires restart or reload after change)"
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("transformers", "Transformers.js (in Obsidian)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value;
						await this.plugin.saveSettings();
						new Notice(
							"Provider changed. Please reload the plugin for changes to take effect."
						);
					})
			);

		new Setting(containerEl)
			.setName("Discard Database")
			.setDesc("Permanently delete the PGlite database.")
			.addButton((button) =>
				button
					.setButtonText("Discard DB")
					.setCta()
					.onClick(() => {
						new DiscardDBModal(this.app, this.plugin).open();
					})
			);
		// Setting for Deleting Resources
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
						new DeleteResourcesModal(this.app, this.plugin).open();
					})
			);

		new Setting(containerEl)
			.setName("Enable Verbose Logging")
			.setDesc("Enable detailed logging for development purposes.")
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.verboseLoggingEnabled || false
					) // settingsから現在の値を取得
					.onChange(async (value) => {
						this.plugin.settings.verboseLoggingEnabled = value;
						await this.plugin.saveSettings();
						// LoggerServiceに設定変更を通知
						if (this.plugin.logger) {
							// nullチェックを追加
							this.plugin.logger.updateSettings({
								verboseLoggingEnabled: value,
							});
						}
					})
			);
	}
}
