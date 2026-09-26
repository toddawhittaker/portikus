import type { WorkspaceUsage } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { formatBytes } from "../monitor/format.js";
import {
	STORAGE_CLASSES,
	STORAGE_LABEL,
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
 * One meter per storage class (SPEC.md §18.3). The "X of Y" text carries the
 * figure; the bar is decoration, so it has no role of its own.
 */
export function StorageMeters({ storage }: { storage: WorkspaceUsage["storage"] }) {
	return (
		<div className="pk-meters" data-testid="storage-meters">
			{STORAGE_CLASSES.map((storageClass) => {
				const figure = storage[storageClass];
				const level = storageLevel(figure);
				const high = level === "warning" || level === "critical";
				const percent =
					figure && figure.totalBytes > 0
						? Math.min(100, (figure.usedBytes / figure.totalBytes) * 100)
						: 0;
				return (
					<div
						key={storageClass}
						className={`pk-meter ${meterLevelClass(level)}`}
						data-testid={`storage-meter-${storageClass}`}
						data-level={level ?? undefined}
					>
						<div className="pk-meter-head">
							<span className="pk-meter-label">{STORAGE_LABEL[storageClass]}</span>
							<span className="pk-meter-value">
								{high ? <Icon name="alert" size="sm" /> : null}
								<span data-testid={`storage-${storageClass}`}>
									{figure
										? `${formatBytes(figure.usedBytes)} of ${formatBytes(figure.totalBytes)}${
												high ? ", nearly full" : ""
											}`
										: "Not available"}
								</span>
							</span>
						</div>
						{figure ? (
							<div className="pk-meter-track" aria-hidden="true">
								<div className="pk-meter-fill" style={{ width: `${percent}%` }} />
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
