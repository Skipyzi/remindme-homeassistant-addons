import { readFile } from "node:fs/promises";
import os from "node:os";

/**
 * Live host telemetry for the rail: memory, CPU and temperature.
 *
 * Inference and Home Assistant share one Pi, so these are the numbers that
 * explain a slow reply — thermal throttling and memory pressure are the two
 * things that actually bite on a Pi 5 under load.
 */

export interface SystemStats {
	memoryUsedBytes: number;
	memoryTotalBytes: number;
	memoryPercent: number;
	cpuPercent: number;
	loadAverage: number;
	cpuCores: number;
	temperatureC?: number;
	/** True once the SoC is hot enough that the firmware starts throttling. */
	throttling?: boolean;
	uptimeSeconds: number;
	architecture: string;
}

/**
 * CPU busy percentage, sampled between calls.
 *
 * os.loadavg() is meaningless on Windows and lags on Linux, so busy time is
 * differenced across the cumulative counters instead. The first call has no
 * previous sample and falls back to load average.
 */
let previous: { idle: number; total: number } | undefined;

function cpuSample(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		for (const [kind, value] of Object.entries(cpu.times)) {
			total += value;
			if (kind === "idle") idle += value;
		}
	}
	return { idle, total };
}

function cpuPercent(): number {
	const sample = cpuSample();
	const last = previous;
	previous = sample;
	if (!last) {
		const cores = os.cpus().length || 1;
		return Math.min(100, Math.round((os.loadavg()[0] / cores) * 100));
	}
	const idleDelta = sample.idle - last.idle;
	const totalDelta = sample.total - last.total;
	if (totalDelta <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/**
 * SoC temperature. The thermal zone is the reliable source on a Pi;
 * vcgencmd is not available inside an add-on container.
 */
async function temperature(): Promise<number | undefined> {
	for (const path of [
		"/sys/class/thermal/thermal_zone0/temp",
		"/sys/devices/virtual/thermal/thermal_zone0/temp",
	]) {
		try {
			const raw = (await readFile(path, "utf8")).trim();
			const value = Number(raw);
			if (!Number.isFinite(value)) continue;
			// Kernels report millidegrees; some report degrees already.
			return Math.round((value > 1000 ? value / 1000 : value) * 10) / 10;
		} catch {
			/* try the next path */
		}
	}
	return undefined;
}

export async function readSystemStats(): Promise<SystemStats> {
	const total = os.totalmem();
	const free = os.freemem();
	const used = total - free;
	const temperatureC = await temperature();
	return {
		memoryUsedBytes: used,
		memoryTotalBytes: total,
		memoryPercent: total ? Math.round((used / total) * 100) : 0,
		cpuPercent: cpuPercent(),
		loadAverage: Math.round(os.loadavg()[0] * 100) / 100,
		cpuCores: os.cpus().length,
		temperatureC,
		// The Pi 5 begins throttling around 80°C; 75 is the point worth warning.
		throttling: temperatureC === undefined ? undefined : temperatureC >= 75,
		uptimeSeconds: Math.round(os.uptime()),
		architecture: process.arch,
	};
}
