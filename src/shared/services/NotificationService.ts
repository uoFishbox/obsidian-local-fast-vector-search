import { Notice } from "obsidian";

export class NotificationService {
	private notices: Map<string, Notice> = new Map();
	private nextId: number = 0;

	showNotice(message: string, duration?: number): string {
		const id = `notice-${this.nextId++}`;
		const notice = new Notice(message, duration ?? 0);
		this.notices.set(id, notice);
		return id;
	}

	updateNotice(id: string, message: string, timeout: number = 0): void {
		const existingNotice = this.notices.get(id);
		if (existingNotice) {
			existingNotice.setMessage(message);
			if (timeout > 0) {
				setTimeout(() => this.hideNotice(id), timeout);
			}
		} else {
			this.showNotice(message, timeout);
		}
	}

	hideNotice(id: string): void {
		const notice = this.notices.get(id);
		if (notice) {
			notice.hide();
			this.notices.delete(id);
		}
	}
}
