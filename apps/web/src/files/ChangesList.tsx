/**
 * The Changes surface (SPEC.md §12.6): every path that differs from the last
 * commit, one row each, opening the file's diff when it is clicked.
 */
import type { GitStatus } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { useState } from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { type ChangeRow, changeRows } from "./gitStatus.js";

export function ChangesList({
	projectId,
	status,
	error = false,
}: {
	projectId: string;
	status: GitStatus | undefined;
	/** The status query failed; the list says so rather than "no changes". */
	error?: boolean;
}) {
	const [open, setOpen] = useState(true);
	const layoutStore = useLayoutStore(projectId);
	const openFile = useLayout(layoutStore, (state) => state.openFile);
	const activeTabId = useLayout(layoutStore, (state) => state.activeTabId);
	const rows = changeRows(status);
	const notARepo = status !== undefined && !status.repo;
	// Until the first status arrives nothing is known, so nothing is claimed.
	const unknown = status === undefined;

	function show(row: ChangeRow) {
		// The diff is a view of the file's own tab, so a file already open is
		// switched to its diff rather than opened a second time (issue #160).
		openFile(row.path, { diff: true });
	}

	return (
		<section className="pk-changes" data-testid="changes-section">
			<button
				type="button"
				className="pk-changes-head"
				aria-expanded={open}
				data-testid="changes-toggle"
				onClick={() => setOpen((value) => !value)}
			>
				<Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
				<span data-testid="changes-title">
					{unknown || notARepo ? "Changes" : `Changes (${rows.length})`}
				</span>
			</button>
			{open ? (
				error ? (
					<p className="pk-changes-empty" data-testid="changes-error">
						Could not read Git status
					</p>
				) : unknown ? null : notARepo ? (
					<p className="pk-changes-empty" data-testid="changes-no-repo">
						This project is not a Git repository.
					</p>
				) : rows.length === 0 ? (
					<p className="pk-changes-empty" data-testid="changes-empty">
						No changes since the last commit
					</p>
				) : (
					<ul className="pk-changes-list" data-testid="changes-list">
						{rows.map((row) => {
							// The row whose file is the tab on show is the selected one.
							const current =
								activeTabId === `file:${row.path}` ||
								activeTabId === `diff:${row.path}`;
							return (
								<li key={row.path}>
									<button
										type="button"
										className={`pk-changes-row${current ? " is-current" : ""}`}
										data-selected={current ? "true" : undefined}
										data-testid={`change-row-${row.path}`}
										data-git={row.decoration.kind}
										title={row.decoration.title}
										onClick={() => show(row)}
									>
										<span className="pk-git-letter" aria-hidden="true">
											{row.decoration.letter}
										</span>
										{row.decoration.kind === "conflict" ? (
											<Icon name="alert" size="sm" />
										) : null}
										<span className="pk-changes-path" title={row.path}>
											{row.label}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)
			) : null}
		</section>
	);
}
