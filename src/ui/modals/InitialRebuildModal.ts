import { App, Modal, Setting } from "obsidian";

export class InitialRebuildModal extends Modal {
	private onConfirm: () => Promise<void> | void;

	constructor(app: App, onConfirm: () => Promise<void> | void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", {
			text: "Welcome to Local Fast Vector Search Plugin!",
		});
		contentEl.createEl("p", {
			text: "To get started, the plugin needs to scan your notes and create a vector index. This allows for fast similarity search. This process might take a few minutes depending on the number of notes you have.",
		});
		contentEl.createEl("p", {
			text: "Do you want to start the initial indexing now?",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Start Indexing")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			)
			.addButton((button) =>
				button.setButtonText("Later").onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
