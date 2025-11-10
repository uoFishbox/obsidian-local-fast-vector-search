import { App, Modal, Setting, Notice } from "obsidian";

export class DiscardDBModal extends Modal {
	private onConfirm: () => Promise<void>;

	constructor(app: App, onConfirm: () => Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
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
						const notice = new Notice("Discarding database...", 0);
						try {
							await this.onConfirm();
							notice.hide();
						} catch (error: any) {
							console.error("Failed to discard database:", error);
							notice.setMessage(
								`Failed to discard database: ${error.message}`
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
