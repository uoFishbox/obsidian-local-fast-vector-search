import { Notice } from "obsidian";

export class NotificationService {
	showNotice(message: string, duration?: number): void {
		new Notice(message, duration);
	}

	// 他の通知関連メソッドをここに追加可能
}
