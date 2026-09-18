/**
 * The Changes surface (SPEC.md §12.6): every path that differs from the last
 * commit, one row each, opening the file's diff when it is clicked.
 */
import type { GitStatus } from "@portikus/contracts";
import { Icon, useToast } from "@portikus/ui";
import { useState } from "react";
import { useLayout, useLayoutStore } from "../layout/store.js";
import { type ChangeRow, changeRows } from "./gitStatus.js";

export function ChangesList({
	projectId,
	status,
}: {
	projectId: string;
	status: GitStatus | undefined;
}) {
	const [open, setOpen] = useState(true);
	const toast = useToast();
	const layoutStore = useLayoutStore(projectId);
	const openDiff = useLayout(layoutStore, (state) => state.openDiff);
	const rows = changeRows(status);
	const notARepo = status !== undefined && !status.repo;

	function show(row: ChangeRow) {
		if (!openDiff(row.path)) {
			toast.show({
				tone: "warning",
				title: "Too many tabs are open. Close one to open another.",
			});
		}
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
					{notARepo ? "Changes" : `Changes (${rows.length})`}
				</span>
			</button>
			{open ? (
				notARepo ? (
					<p className="pk-changes-empty" data-testid="changes-no-repo">
						This project is not a Git repository.
					</p>
				) : rows.length === 0 ? (
					<p className="pk-changes-empty" data-testid="changes-empty">
						No changes since the last commit
					</p>
				) : (
					<ul className="pk-changes-list" data-testid="changes-list">
						{rows.map((row) => (
							<li key={row.path}>
								<button
									type="button"
									className="pk-changes-row"
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
									<span className="pk-changes-path">{row.label}</span>
								</button>
							</li>
						))}
					</ul>
				)
			) : null}
		</section>
	);
}
