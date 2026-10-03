import { Icon } from "@portikus/ui";
import type { ReactNode } from "react";
import { nextSort, type SortDirection, type SortState } from "./sort.js";

/**
 * A column header that sorts its table when pressed (SPEC.md section 25.8):
 * the button names the column, `aria-sort` on the cell says the order, and
 * the chevron shows it. A help button, if any, follows the button. An
 * unsorted header says it sorts, and shows a faint chevron on hover or focus.
 */
export function SortHeader<C extends string>({
	column,
	label,
	sort,
	onSort,
	first = "ascending",
	className,
	children,
}: {
	column: C;
	label: string;
	sort: SortState<C>;
	onSort: (next: SortState<C>) => void;
	/** The direction the first press sorts in. */
	first?: SortDirection;
	className?: string;
	children?: ReactNode;
}) {
	const active = sort.column === column;
	return (
		<th
			scope="col"
			className={className}
			aria-sort={active ? sort.direction : undefined}
		>
			<span className="relative inline-flex items-center gap-1">
				<button
					type="button"
					className="pk-table-sort pk-focus-ring"
					data-testid={`sort-${column}`}
					// An attribute, not a hidden element: any text in the cell joins its textContent.
					aria-description={active ? undefined : "Sort by this column"}
					onClick={() => onSort(nextSort(sort, column, first))}
				>
					{label}
					{active ? (
						<Icon
							name={sort.direction === "ascending" ? "chevron-up" : "chevron-down"}
							size="sm"
						/>
					) : null}
				</button>
				{children}
				{/* Only the sorted column's chevron takes space: one on every header pushes
				    the Users and Logs tables past 1024 px (SPEC.md section 20.1), so the
				    hint sits in the gap before the label instead. */}
				{active ? null : (
					<Icon
						name={first === "ascending" ? "chevron-up" : "chevron-down"}
						size="sm"
						className="pk-table-sort-hint"
					/>
				)}
			</span>
		</th>
	);
}
