import {
	ACCOUNT_IMPORT_MAX_BYTES,
	ACCOUNT_IMPORT_MAX_ROWS,
	type AccountImportPreviewRow,
	type AccountImportResultRow,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, FileInput } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { Notice } from "../Notice.js";
import { useConfirmImport, usePreviewImport } from "../queries.js";
import { downloadText, passwordsCsv, SAMPLE_IMPORT_CSV } from "./importCsv.js";

/**
 * "Import from CSV…" in the Users view: check a file, confirm, then hand
 * out the one-time passwords as a file made in the browser (SPEC.md
 * section 5.1, "Add user"; section 24.13).
 */

const STATUS_LABEL: Record<AccountImportPreviewRow["status"], string> = {
	valid: "Ready",
	invalid: "Invalid",
	duplicate: "Already exists",
};

const OUTCOME_LABEL: Record<AccountImportResultRow["outcome"], string> = {
	created: "Added",
	invited: "Invited",
	skipped: "Skipped",
	invalid: "Invalid",
	failed: "Failed",
};

function tagClass(tone: "ok" | "warning" | "error"): string {
	if (tone === "ok") return "pk-tag";
	return tone === "warning" ? "pk-tag pk-tag--warning" : "pk-tag pk-tag--error";
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function ImportAccounts() {
	const preview = usePreviewImport();
	const confirm = useConfirmImport();
	const [open, setOpen] = useState(false);
	const [csv, setCsv] = useState<string | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const busy = preview.isPending || confirm.isPending;
	const rows = preview.data?.rows ?? null;
	const result = confirm.data?.rows ?? null;
	const ready = rows?.filter((r) => r.status === "valid").length ?? 0;
	const passwords = result?.filter((r) => r.password).length ?? 0;

	function change(next: boolean) {
		if (busy) return;
		if (next) {
			preview.reset();
			confirm.reset();
			setCsv(null);
			setFileError(null);
		}
		setOpen(next);
	}

	async function pick(file: File | undefined) {
		preview.reset();
		setCsv(null);
		setFileError(null);
		if (!file) return;
		if (file.size > ACCOUNT_IMPORT_MAX_BYTES) {
			setFileError("The file is larger than 256 KB.");
			return;
		}
		const text = await file.text();
		setCsv(text);
		preview.mutate({ csv: text });
	}

	async function submit() {
		if (busy || csv === null) return;
		try {
			await confirm.mutateAsync({ csv });
		} catch {
			// The dialog shows confirm.error.
		}
	}

	const footer = result ? (
		<>
			{passwords > 0 ? (
				<Button
					data-testid="import-download"
					onClick={() =>
						downloadText("portikus-one-time-passwords.csv", passwordsCsv(result))
					}
				>
					Download passwords
				</Button>
			) : null}
			<Button variant="primary" data-testid="import-done" onClick={() => change(false)}>
				Done
			</Button>
		</>
	) : (
		<>
			<Button onClick={() => change(false)}>Cancel</Button>
			<Button
				variant="primary"
				data-testid="import-confirm"
				disabled={ready === 0 || preview.isPending}
				loading={confirm.isPending}
				onClick={() => void submit()}
			>
				{ready > 0 ? `Add ${plural(ready, "account", "accounts")}` : "Add accounts"}
			</Button>
		</>
	);

	return (
		<>
			<Button size="sm" data-testid="import-users" onClick={() => change(true)}>
				Import from CSV…
			</Button>
			<DialogRoot open={open} onOpenChange={change}>
				<Dialog
					testId="import-dialog"
					size="lg"
					title={result ? "Import finished" : "Import from CSV"}
					description={
						result
							? undefined
							: `One row per person with the columns name, email, username, role and kind, at most ${ACCOUNT_IMPORT_MAX_ROWS} rows. Kind password adds a Portikus password; kind invite invites someone who signs in through your single sign-on provider (for Microsoft Entra, put the user principal name in username). Role is student or instructor; add administrators one at a time.`
					}
					footer={footer}
				>
					{result ? (
						<ResultView rows={result} passwords={passwords} />
					) : (
						<div className="flex flex-col gap-3">
							<div>
								<Button
									size="sm"
									variant="quiet"
									data-testid="import-sample"
									onClick={() =>
										downloadText("portikus-accounts-sample.csv", SAMPLE_IMPORT_CSV)
									}
								>
									Download a sample file
								</Button>
							</div>
							<FileInput
								id="import-file"
								label="CSV file"
								accept=".csv,text/csv"
								data-testid="import-file"
								error={
									fileError ?? (preview.error ? errorText(preview.error) : undefined)
								}
								disabled={busy}
								onChange={(event) => void pick(event.target.files?.[0])}
							/>
							{preview.isPending ? (
								<p className="pk-muted m-0" role="status">
									Checking the file…
								</p>
							) : null}
							{rows ? <PreviewTable rows={rows} ready={ready} /> : null}
							{confirm.error ? (
								<p
									className="m-0 text-status-error"
									role="alert"
									data-testid="import-error"
								>
									{errorText(confirm.error)}
								</p>
							) : null}
						</div>
					)}
				</Dialog>
			</DialogRoot>
		</>
	);
}

function PreviewTable({
	rows,
	ready,
}: {
	rows: AccountImportPreviewRow[];
	ready: number;
}) {
	const skipped = rows.length - ready;
	return (
		<>
			<p className="m-0" role="status" data-testid="import-summary">
				{plural(ready, "row is", "rows are")} ready to add.
				{skipped > 0 ? ` ${plural(skipped, "row", "rows")} will be skipped.` : ""}
			</p>
			<section
				className="pk-table-wrap pk-focus-ring max-h-80 overflow-auto"
				aria-label="Rows in the file"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolled region the keyboard must reach (WCAG 2.1.1)
				tabIndex={0}
			>
				<table
					className="pk-table [&_tbody_:is(th,td)]:whitespace-normal"
					data-testid="import-preview"
				>
					<caption className="sr-only">Rows in the file</caption>
					<thead>
						<tr>
							<th scope="col">Row</th>
							<th scope="col">Name</th>
							<th scope="col">Email</th>
							<th scope="col">Username</th>
							<th scope="col">Role</th>
							<th scope="col">Kind</th>
							<th scope="col">Check</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.line} data-testid={`import-row-${row.line}`}>
								<th scope="row">{row.line}</th>
								<td>{row.name}</td>
								<td>{row.email}</td>
								<td>{row.username}</td>
								<td>{row.role}</td>
								<td>{row.kind}</td>
								<td>
									<span
										className={tagClass(
											row.status === "valid"
												? "ok"
												: row.status === "duplicate"
													? "warning"
													: "error",
										)}
									>
										{STATUS_LABEL[row.status]}
									</span>
									{row.reason ? <span className="block">{row.reason}</span> : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</>
	);
}

function ResultView({
	rows,
	passwords,
}: {
	rows: AccountImportResultRow[];
	passwords: number;
}) {
	const count = (outcome: AccountImportResultRow["outcome"]) =>
		rows.filter((r) => r.outcome === outcome).length;
	const problems = rows.filter(
		(r) => r.outcome === "failed" || r.outcome === "invalid",
	);
	return (
		<div className="flex flex-col gap-3">
			<p className="m-0" role="status" data-testid="import-result">
				{plural(count("created"), "account", "accounts")} added,{" "}
				{plural(count("invited"), "invitation", "invitations")} sent,{" "}
				{plural(count("skipped") + count("invalid"), "row", "rows")} skipped
				{count("failed") > 0 ? `, ${count("failed")} failed` : ""}.
			</p>
			{passwords > 0 ? (
				<Notice tone="warning" testId="import-password-warning">
					Download the one-time passwords now: they will not be shown again. Give each
					person theirs privately, never by a shared email or chat. Each person chooses
					their own password and sets up a second factor when they first sign in.
				</Notice>
			) : null}
			{problems.length > 0 ? (
				<ul className="m-0 ps-5" data-testid="import-problems">
					{problems.map((row) => (
						<li key={row.line}>
							Row {row.line} ({row.email || row.name || "empty"}):{" "}
							{OUTCOME_LABEL[row.outcome]}. {row.reason}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
