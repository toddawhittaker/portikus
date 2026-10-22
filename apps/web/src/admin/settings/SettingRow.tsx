import {
	FieldMessages,
	HINT_CLASS,
	LABEL_CLASS,
	Skeleton,
	UnitInput,
} from "@portikus/ui";
import type { ReactNode } from "react";

/** One row per setting, with hairlines between rows. */
export function SettingRows({ children }: { children: ReactNode }) {
	return (
		<div className="grid divide-y divide-line border-y border-line">{children}</div>
	);
}

const ROW_CLASS =
	"grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-2 py-3 @min-[36rem]/card:grid-cols-[minmax(0,1fr)_13rem]";

/**
 * One number setting: its label and what it does on the left, the box with
 * its unit on the right, then whether it is saved, any error, and its
 * default and range. Below 36rem of card the two sides stack.
 */
export function SettingRow({
	id,
	label,
	description,
	unit,
	meta,
	value,
	was,
	error,
	inputMode = "numeric",
	onChange,
}: {
	id: string;
	label: string;
	description: string;
	unit: string;
	/** The default, the range, and where else it is set. */
	meta: string;
	value: string;
	/** The saved value in words while the box holds another; null when it does not. */
	was: string | null;
	error: string | undefined;
	inputMode?: "numeric" | "decimal";
	onChange: (value: string) => void;
}) {
	const describedBy = [`${id}-desc`, was === null ? null : `${id}-was`, `${id}-meta`]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={ROW_CLASS}>
			<div className="grid min-w-0 content-start gap-1">
				<label className={LABEL_CLASS} htmlFor={id}>
					{label}
				</label>
				<p
					className="m-0 max-w-[68ch] text-[length:var(--pk-font)] leading-[1.45] text-ink"
					id={`${id}-desc`}
				>
					{description}
				</p>
			</div>
			<div className="grid min-w-0 content-start gap-1">
				<UnitInput
					id={id}
					unit={unit}
					inputMode={inputMode}
					data-testid={id}
					value={value}
					error={error}
					aria-describedby={describedBy}
					onChange={(event) => onChange(event.target.value)}
				/>
				{was === null ? null : <NotSaved id={`${id}-was`} was={was} />}
				<FieldMessages id={id} error={error} />
				<p className={HINT_CLASS} id={`${id}-meta`}>
					{meta}
				</p>
			</div>
		</div>
	);
}

/** "Not saved. Was 60 minutes." under a changed field. */
export function NotSaved({ id, was }: { id?: string; was: string | null }) {
	return (
		<span id={id} className="block text-[12px] font-semibold leading-4 text-ink">
			{/* The spaces keep it a sentence of its own in the text it is read with. */}{" "}
			{was === null ? "Not saved." : `Not saved. Was ${was}.`}{" "}
		</span>
	);
}

/** A row's shape while the settings load, so nothing moves when they arrive. */
export function SettingRowSkeleton() {
	return (
		<div className={ROW_CLASS}>
			<div className="grid content-start gap-1.5">
				<Skeleton variant="block" width="9rem" height={14} />
				<Skeleton variant="block" width="100%" height={12} />
				<Skeleton variant="block" width="70%" height={12} />
			</div>
			<Skeleton variant="block" width="8.5rem" height="var(--pk-control)" />
		</div>
	);
}
