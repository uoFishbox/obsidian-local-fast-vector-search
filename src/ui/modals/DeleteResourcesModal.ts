import { App, Modal, Setting, Notice } from "obsidian";

export class DeleteResourcesModal extends Modal {
	private onConfirm: () => Promise<void>;

	constructor(app: App, onConfirm: () => Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
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
							await this.onConfirm();
							notice.hide();
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
