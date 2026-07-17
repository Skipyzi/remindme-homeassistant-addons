type RestartCall = () => Promise<void>;
type ScheduleTimer = (
	callback: () => void | Promise<void>,
	delayMs: number,
) => unknown;

export class RestartController {
	private inProgress = false;
	private timer: unknown;

	constructor(
		private readonly restart: RestartCall,
		private readonly delayMs = 300,
		private readonly scheduleTimer: ScheduleTimer = (callback, delay) =>
			setTimeout(callback, delay),
		private readonly onError: (error: unknown) => void = console.error,
	) {}

	schedule(): { accepted: true } {
		if (this.inProgress) throw new Error("Restart is already in progress");
		this.inProgress = true;
		this.timer = this.scheduleTimer(async () => {
			try {
				await this.restart();
			} catch (error) {
				this.inProgress = false;
				this.onError(error);
			}
		}, this.delayMs);
		return { accepted: true };
	}
}
