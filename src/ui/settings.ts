import { Plugin, Notice, App, PluginSettingTab, Setting } from "obsidian";
import MyVectorPlugin from "../main";
import { DiscardDBModal } from "./modals/DiscardDBModal";

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
	}
}
