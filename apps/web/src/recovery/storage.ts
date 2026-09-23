/**
 * The three storage classes and when they warn (SPEC.md §18.3, §19.2, §28).
 * Warn at 80% full; at 95% say which class is nearly full and what to do.
 */
import type { StorageFigure, WorkspaceUsage } from "@portikus/contracts";

export type StorageClass = "home" | "docker" | "recovery";
export type StorageLevel = "ok" | "warning" | "critical";

export const STORAGE_CLASSES: readonly StorageClass[] = ["home", "docker", "recovery"];

export const STORAGE_LABEL: Record<StorageClass, string> = {
	home: "Projects & home",
	docker: "Docker",
	recovery: "Recovery",
};

export const WARN_AT = 0.8;
export const CRITICAL_AT = 0.95;

const NEXT_STEP: Record<StorageClass, string> = {
	home: "Delete files you no longer need.",
	docker: "Use Reset Docker in the workspace dialog, or run docker system prune.",
	recovery: "Older recovery points are removed automatically.",
};

/** How full one class is. A missing figure, or one with no size, never warns. */
export function storageLevel(figure: StorageFigure | null): StorageLevel | null {
	if (!figure || figure.totalBytes <= 0) return null;
	const ratio = figure.usedBytes / figure.totalBytes;
	if (ratio >= CRITICAL_AT) return "critical";
	if (ratio >= WARN_AT) return "warning";
	return "ok";
}

export interface StorageWarning {
	storageClass: StorageClass;
	level: "warning" | "critical";
	/** The short status-bar text. */
	text: string;
	/** The longer text, with the next step when critical. */
	detail: string;
}

/** The fullest class that has reached a threshold, or null when none has. */
export function storageWarning(
	storage: WorkspaceUsage["storage"] | undefined,
): StorageWarning | null {
	if (!storage) return null;
	let worst: { storageClass: StorageClass; ratio: number } | null = null;
	for (const storageClass of STORAGE_CLASSES) {
		const figure = storage[storageClass];
		const level = storageLevel(figure);
		if (!figure || !level || level === "ok") continue;
		const ratio = figure.usedBytes / figure.totalBytes;
		if (!worst || ratio > worst.ratio) worst = { storageClass, ratio };
	}
	if (!worst) return null;
	const label = STORAGE_LABEL[worst.storageClass];
	const percent = Math.floor(worst.ratio * 100);
	if (worst.ratio >= CRITICAL_AT) {
		return {
			storageClass: worst.storageClass,
			level: "critical",
			text: `${label} storage is nearly full`,
			detail: `${label} storage is ${percent}% full. ${NEXT_STEP[worst.storageClass]}`,
		};
	}
	return {
		storageClass: worst.storageClass,
		level: "warning",
		text: `${label} storage is ${percent}% full`,
		detail: `${label} storage is ${percent}% full.`,
	};
}
