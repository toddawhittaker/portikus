/** Short figures for the Monitor tab and the Running details (SPEC.md §18.2). */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	if (unit === 0) return `${Math.round(value)} B`;
	const digits = value >= 100 ? 0 : 1;
	return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** One decimal. A missing sample is an em dash, not a zero. */
export function formatCpu(percent: number | null | undefined): string {
	if (percent === null || percent === undefined) return "—";
	return `${percent.toFixed(1)}%`;
}

export function formatRate(bytesPerSecond: number | null): string {
	if (bytesPerSecond === null) return "—";
	return `${formatBytes(bytesPerSecond)}/s`;
}
