export class LoggerService {
	private verboseLoggingEnabled: boolean = false; // verbose logging の状態を保持

	log(message: string, ...args: any[]): void {
		console.log(`[INFO] ${message}`, ...args);
	}

	verbose_log(message: string, ...args: any[]): void {
		if (this.verboseLoggingEnabled) {
			// 設定が有効な場合のみ出力
			console.log(`[VERBOSE] ${message}`, ...args);
		}
	}

	warn(message: string, ...args: any[]): void {
		console.warn(`[WARN] ${message}`, ...args);
	}

	error(message: string, ...args: any[]): void {
		console.error(`[ERROR] ${message}`, ...args);
	}

	// 外部から設定を受け取り、内部状態を更新するメソッド
	updateSettings(settings: { verboseLoggingEnabled: boolean }): void {
		this.verboseLoggingEnabled = settings.verboseLoggingEnabled;
		this.verbose_log("LoggerService settings updated.", settings); // 設定更新ログはverboseで出す
	}

	// 将来的にログレベル管理や外部サービス連携を追加
}
