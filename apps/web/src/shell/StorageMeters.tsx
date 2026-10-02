import type { StorageFigure, WorkspaceUsage } from "@portikus/contracts";
import { Meter, Toggletip } from "@portikus/ui";
import { type ReactNode, useId } from "react";
import { formatBytes } from "../monitor/format.js";
import {
	NEXT_STEP,
	nearlyFullAbove,
	STORAGE_CLASSES,
	STORAGE_LABEL,
	type StorageClass,
	type StorageLevel,
	storageLevel,
} from "../recovery/storage.js";

/** The meter modifier for a level; the thresholds are storageLevel's (SPEC.md §19.2). */
export function meterLevelClass(level: StorageLevel | null): string {
	if (level === "critical") return "pk-meter--full";
	if (level === "warning") return "pk-meter--warning";
	return "";
}

/**
 * One storage class's meter, named by its visible label. At the critical
 * level `step` is written under it and read with the meter, so the state is
 * not shown by colour alone (SPEC.md §19.2, §25.8).
 */
export function StorageMeterRow({
	storageClass,
	figure,
	step,
	tip,
}: {
	storageClass: StorageClass;
	figure: StorageFigure | null;
	step: string;
	tip?: ReactNode;
}) {
	const level = storageLevel(figure);
	const id = useId();
	const labelId = `${id}-label`;
	const stepId = `${id}-step`;
	const critical = level === "critical";
	return (
		<div
			className={`pk-meter ${meterLevelClass(level)}`}
			data-testid={`storage-meter-${storageClass}`}
			data-level={level ?? undefined}
		>
			<span className="pk-meter-label inline-flex items-center gap-1">
				<span id={labelId}>{STORAGE_LABEL[storageClass]}</span>
				{tip}
			</span>
			{figure ? (
				<span data-testid={`storage-${storageClass}`}>
					<Meter
						value={figure.usedBytes}
						max={figure.totalBytes}
						aria-labelledby={labelId}
						aria-describedby={critical ? stepId : undefined}
						valueText={`${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}`}
						high={nearlyFullAbove(figure.totalBytes)}
					/>
				</span>
			) : (
				<span className="pk-meter-value" data-testid={`storage-${storageClass}`}>
					Not available
				</span>
			)}
			{critical ? (
				<span
					id={stepId}
					className="pk-meter-step"
					data-testid={`storage-step-${storageClass}`}
				>
					{step}
				</span>
			) : null}
		</div>
	);
}

/** One meter per storage class (SPEC.md §18.3). */
export function StorageMeters({ storage }: { storage: WorkspaceUsage["storage"] }) {
	return (
		<div className="pk-meters" data-testid="storage-meters">
			{STORAGE_CLASSES.map((storageClass) => (
				<StorageMeterRow
					key={storageClass}
					storageClass={storageClass}
					figure={storage[storageClass]}
					step={NEXT_STEP[storageClass]}
					tip={
						storageClass === "recovery" ? (
							<Toggletip label="Recovery storage">
								Space used by recovery points, the copies of your projects that Portikus
								keeps outside the project folders. Old points are removed automatically.
							</Toggletip>
						) : null
					}
				/>
			))}
		</div>
	);
}
