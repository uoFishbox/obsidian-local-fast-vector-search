import { App, Modal, Setting, Notice } from "obsidian";
import MyVectorPlugin from "../../main";

export class DeleteResourcesModal extends Modal {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Delete Resources" });
		contentEl.createEl("p", {
			text: "Are you sure you want to delete cached resources? This includes downloaded models for Transformers.js and cached PGlite resources (like WASM and data bundles) from IndexedDB. This action cannot be undone, and these resources will need to be re-downloaded on next use. This might take a moment.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Delete Resources")
					.setCta()
					.onClick(async () => {
						const notice = new Notice("Deleting resources...", 0);
						try {
							await this.plugin.clearResources();
							notice.setMessage(
								"Resources deleted successfully. They will be re-downloaded on next use."
							);
							setTimeout(() => notice.hide(), 5000);
						} catch (error: any) {
							console.error("Failed to delete resources:", error);
							notice.setMessage(
								`Failed to delete resources: ${error.message}. Check console.`
							);
							setTimeout(() => notice.hide(), 7000);
						} finally {
							this.close();
						}
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
