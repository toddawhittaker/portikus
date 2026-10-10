/**
 * A CSV file shown as a read-only table (SPEC.md §13.2). It is drawn from the
 * text in the tab, so unsaved edits show too, and only text ever reaches the
 * page: a cell is never read as markup (SPEC.md §24.2).
 */
import { CsvError } from "@portikus/contracts";
import { Button, EmptyState } from "@portikus/ui";
import { useMemo, useState } from "react";
import { baseName, displayName } from "../files/paths.js";
import {
	CSV_COLUMN_LIMIT,
	CSV_ROW_LIMIT,
	type CsvTable,
	csvTable,
	type SortDirection,
	sortedOrder,
} from "./csv.js";
import "./csv.css";

export interface CsvViewProps {
	path: string;
	text: string;
	/** Switch the tab to the file's text. */
	onShowText: () => void;
}

type Parsed = { table: CsvTable | null } | { error: string };

function read(text: string): Parsed {
	try {
		return { table: csvTable(text) };
	} catch (error) {
		if (error instanceof CsvError) return { error: error.message };
		throw error;
	}
}

interface Sort {
	column: number;
	direction: SortDirection;
}

export function CsvView({ path, text, onShowText }: CsvViewProps) {
	const parsed = useMemo(() => read(text), [text]);
	// A sorted view only: the file and the editor text are never touched.
	// The sort belongs to one version of the text and lapses when it changes.
	const [sort, setSort] = useState<{ text: string; by: Sort | null }>({
		text,
		by: null,
	});
	const by = sort.text === text ? sort.by : null;
	const order = useMemo(() => {
		if (!("table" in parsed) || parsed.table === null) return [];
		const { rows } = parsed.table;
		return by === null
			? rows.map((_, at) => at)
			: sortedOrder(rows, by.column, by.direction);
	}, [parsed, by]);
	const [announcement, setAnnouncement] = useState("");
	const cycle = (column: number, name: string) => {
		let next: Sort | null;
		if (by?.column !== column) next = { column, direction: "ascending" };
		else if (by.direction === "ascending") next = { column, direction: "descending" };
		else next = null;
		setSort({ text, by: next });
		setAnnouncement(
			next === null ? "Sorted in file order" : `Sorted by ${name}, ${next.direction}`,
		);
	};
	const showText = (
		<Button variant="primary" onClick={onShowText} data-testid="csv-show-text">
			Show as text
		</Button>
	);
	if ("error" in parsed) {
		return (
			<EmptyState
				icon="file"
				title="This file could not be read as CSV"
				actions={showText}
			>
				{parsed.error} You can still read and edit it as text.
			</EmptyState>
		);
	}
	const { table } = parsed;
	if (table === null) {
		return (
			<EmptyState icon="file" title="This file is empty" actions={showText}>
				{displayName(path)} has no rows yet. Add some as text.
			</EmptyState>
		);
	}
	// Short records are padded so every column lines up; a column past the
	// header's last, or under a blank header cell, gets a name a screen reader
	// can say.
	const columns = Array.from({ length: table.columns }, (_, at) => at);
	return (
		<div className="pk-csv" data-testid={`csv-view-${path}`}>
			<div className="pk-csv-frame">
				<section
					className="pk-csv-scroll"
					aria-label={`${displayName(baseName(path))} table`}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard must reach (WCAG 2.1.1)
					tabIndex={0}
				>
					<table className="pk-table pk-csv-table">
						<thead>
							<tr>
								<td className="pk-csv-rownum" aria-hidden="true" />
								{columns.map((at) => {
									const name = table.header[at] || `Column ${at + 1}`;
									const active = by?.column === at ? by.direction : null;
									return (
										<th key={at} scope="col" aria-sort={active ?? "none"}>
											<button
												type="button"
												className="pk-csv-sort"
												onClick={() => cycle(at, name)}
											>
												{table.header[at] ? (
													table.header[at]
												) : (
													<span className="pk-csv-blank">{name}</span>
												)}
												<span aria-hidden="true" className="pk-csv-sort-mark">
													{active === "ascending"
														? "▲"
														: active === "descending"
															? "▼"
															: ""}
												</span>
											</button>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							{order.slice(0, CSV_ROW_LIMIT).map((index) => (
								<tr key={index}>
									<th scope="row" className="pk-csv-rownum">
										{index + 1}
									</th>
									{columns.map((at) => (
										<td key={at}>{table.rows[index]?.[at]}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</section>
			</div>
			<p className="pk-visually-hidden" role="status" aria-live="polite">
				{announcement}
			</p>
			{table.totalColumns > CSV_COLUMN_LIMIT ? (
				<p className="pk-file-note" data-testid="csv-column-cap">
					Showing the first {CSV_COLUMN_LIMIT.toLocaleString("en")} of{" "}
					{table.totalColumns.toLocaleString("en")} columns.
				</p>
			) : null}
			{table.total > CSV_ROW_LIMIT ? (
				<p className="pk-file-note" data-testid="csv-row-cap">
					Showing the first {CSV_ROW_LIMIT.toLocaleString("en")} of{" "}
					{table.total.toLocaleString("en")} rows.
				</p>
			) : table.total === 0 ? (
				<p className="pk-file-note">This file has a header row and no rows under it.</p>
			) : null}
		</div>
	);
}
