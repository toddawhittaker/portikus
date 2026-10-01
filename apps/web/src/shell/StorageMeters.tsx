import type { StorageFigure, WorkspaceUsage } from "@portikus/contracts";
import { Meter, Toggletip } from "@portikus/ui";
import type * as React from "react";
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
 * One storage class's meter, named by its class. At the critical level the
 * next step is written under it, so the state is not shown by colour alone
 * (SPEC.md §19.2, §25.8).
 */
export function StorageMeterRow({
	storageClass,
	figure,
	tip,
}: {
	storageClass: StorageClass;
	figure: StorageFigure | null;
	tip?: React.ReactNode;
}) {
	const level = storageLevel(figure);
	return (
		<div
			className={`pk-meter ${meterLevelClass(level)}`}
			data-testid={`storage-meter-${storageClass}`}
			data-level={level ?? undefined}
		>
			<span className="pk-meter-label inline-flex items-center gap-1">
				{STORAGE_LABEL[storageClass]}
				{tip}
			</span>
			{figure ? (
				<span data-testid={`storage-${storageClass}`}>
					<Meter
						value={figure.usedBytes}
						max={figure.totalBytes}
						label={STORAGE_LABEL[storageClass]}
						valueText={`${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}`}
						high={nearlyFullAbove(figure.totalBytes)}
					/>
				</span>
			) : (
				<span className="pk-meter-value" data-testid={`storage-${storageClass}`}>
					Not available
				</span>
			)}
			{level === "critical" ? (
				<span className="pk-meter-step" data-testid={`storage-step-${storageClass}`}>
					{NEXT_STEP[storageClass]}
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
