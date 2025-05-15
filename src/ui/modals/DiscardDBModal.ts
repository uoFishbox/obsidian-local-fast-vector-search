import { App, Modal, Setting, Notice } from "obsidian";
import MyVectorPlugin from "../../main";

export class DiscardDBModal extends Modal {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Discard Database" });
		contentEl.createEl("p", {
			text: "Are you sure you want to permanently discard the PGlite database? This action cannot be undone.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Discard")
					.setCta()
					.onClick(async () => {
						try {
							if (this.plugin.pgProvider) {
								await this.plugin.pgProvider.discardDB();
								new Notice("Database discarded successfully.");
							} else {
								new Notice(
									"Database provider not initialized."
								);
							}
						} catch (error: any) {
							console.error("Failed to discard database:", error);
							new Notice(
								`Failed to discard database: ${error.message}`
							);
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
