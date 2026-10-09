/**
 * A CSV file shown as a read-only table (SPEC.md §13.2). It is drawn from the
 * text in the tab, so unsaved edits show too, and only text ever reaches the
 * page: a cell is never read as markup (SPEC.md §24.2).
 */
import { CsvError } from "@portikus/contracts";
import { Button, EmptyState } from "@portikus/ui";
import { useMemo } from "react";
import { baseName } from "../files/paths.js";
import { CSV_ROW_LIMIT, type CsvTable, csvTable } from "./csv.js";
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

export function CsvView({ path, text, onShowText }: CsvViewProps) {
	const parsed = useMemo(() => read(text), [text]);
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
				{path} has no rows yet. Add some as text.
			</EmptyState>
		);
	}
	// Short records are padded so every column lines up; a column past the
	// header's last gets a name a screen reader can say.
	const columns = Array.from({ length: table.columns }, (_, at) => at);
	return (
		<div className="pk-csv" data-testid={`csv-view-${path}`}>
			<div className="pk-csv-frame">
				<section
					className="pk-csv-scroll"
					aria-label={`${baseName(path)} table`}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard must reach (WCAG 2.1.1)
					tabIndex={0}
				>
					<table className="pk-table pk-csv-table">
						<thead>
							<tr>
								{columns.map((at) => (
									<th key={at} scope="col">
										{at < table.header.length ? (
											table.header[at]
										) : (
											<span className="pk-visually-hidden">Column {at + 1}</span>
										)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{table.rows.map((row, line) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are the file's records in order and never move
								<tr key={line}>
									{columns.map((at) => (
										<td key={at}>{row[at]}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</section>
			</div>
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
