export class LoggerService {
	info(message: string, ...args: any[]): void {
		console.log(`[INFO] ${message}`, ...args);
	}

	warn(message: string, ...args: any[]): void {
		console.warn(`[WARN] ${message}`, ...args);
	}

	error(message: string, ...args: any[]): void {
		console.error(`[ERROR] ${message}`, ...args);
	}

	// 将来的にログレベル管理や外部サービス連携を追加
}
