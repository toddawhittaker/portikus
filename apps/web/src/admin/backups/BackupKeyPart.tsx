import { BACKUP_KEY_MAX_BYTES, type BackupKeyStatus } from "@portikus/contracts";
import { Button, ConfirmDialog, ConfirmDialogRoot, useToast } from "@portikus/ui";
import { useId, useState } from "react";
import { ApiError } from "../../api/request.js";
import { errorText } from "../SettingsTab.js";
import { longTime } from "./model.js";
import { useDownloadBackupKey, useUploadBackupKey } from "./queries.js";

const NOT_A_KEY =
	"That file is not a backup key. Choose the portikus-backup-key.txt you downloaded.";

/**
 * The backup key on a server that backs itself up (ADR 0044): download it
 * to keep off the server, and upload one to rebuild from an off-site copy.
 */
export function BackupKeyPart({ status }: { status: BackupKeyStatus }) {
	const toast = useToast();
	const download = useDownloadBackupKey();
	const [confirmingDownload, setConfirmingDownload] = useState(false);
	const [uploading, setUploading] = useState(false);

	return (
		<div className="grid gap-4" data-testid="backup-key">
			{status.installed && !status.downloaded ? (
				<div
					className="pk-card border-status-warning bg-status-warning-soft p-4 text-status-warning"
					data-testid="backup-key-reminder"
				>
					<strong>Backup key not yet downloaded.</strong> Download it and store it off
					this server. Without it, a copy of your backups kept elsewhere cannot be
					restored if this server is lost.
				</div>
			) : null}
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Key</dt>
				<dd className="m-0" data-testid="backup-key-state">
					{status.installed
						? "Kept on this server, readable only by root"
						: "None yet. Setup makes one: run sudo portikus setup on the server."}
				</dd>
				<dt className="pk-muted">Public half</dt>
				<dd
					className="m-0 font-mono [overflow-wrap:anywhere]"
					data-testid="backup-key-recipient"
				>
					{status.recipient ?? "None"}
				</dd>
				<dt className="pk-muted">Downloaded</dt>
				<dd className="m-0" data-testid="backup-key-downloaded">
					{status.downloadedAt ? longTime(status.downloadedAt) : "Not yet"}
				</dd>
			</dl>
			<div className="flex flex-wrap gap-2">
				{status.installed ? (
					<Button
						variant={status.downloaded ? "secondary" : "primary"}
						data-testid="backup-key-download"
						onClick={() => setConfirmingDownload(true)}
					>
						Download backup key
					</Button>
				) : null}
				<Button
					variant="secondary"
					data-testid="backup-key-upload"
					onClick={() => setUploading(true)}
				>
					Upload backup key
				</Button>
			</div>

			<ConfirmDialogRoot
				open={confirmingDownload}
				onOpenChange={(open) => (open ? undefined : setConfirmingDownload(false))}
			>
				{confirmingDownload ? (
					<ConfirmDialog
						id="backup-key-download-dialog"
						testId="backup-key-download-dialog"
						destructive={false}
						title="Download the backup key?"
						description="This file unlocks every backup of this server: every student's files, the platform database and everyone's accounts. Anyone who has it and a copy of the backups can read them. Store it off this server, such as in a password manager, and never beside the backup copies."
						confirmLabel="Download key"
						pending={download.isPending}
						onConfirm={() =>
							download.mutate(undefined, {
								onSuccess: () => {
									setConfirmingDownload(false);
									toast.show({
										tone: "success",
										title: "Backup key downloaded",
										children:
											"Move it off this computer's Downloads folder to where you keep secrets.",
									});
								},
								onError: (error) =>
									toast.show({
										tone: "danger",
										title: "Could not download the backup key",
										children: errorText(error),
									}),
							})
						}
					/>
				) : null}
			</ConfirmDialogRoot>

			{uploading ? (
				<UploadDialog
					onClose={() => setUploading(false)}
					onDone={(replaced) => {
						setUploading(false);
						toast.show({
							tone: "success",
							title: replaced ? "Backup key replaced" : "Backup key uploaded",
							children:
								"Backups made with this key can now be restored here, and new backups use it.",
						});
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * Pick the key file and upload it. When the server holds a different key,
 * a second, destructive step asks before that key is replaced.
 */
function UploadDialog({
	onClose,
	onDone,
}: {
	onClose: () => void;
	onDone: (replaced: boolean) => void;
}) {
	const upload = useUploadBackupKey();
	const inputId = useId();
	const [key, setKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mustReplace, setMustReplace] = useState(false);

	async function choose(file: File | undefined) {
		setError(null);
		setKey(null);
		if (!file) return;
		if (file.size > BACKUP_KEY_MAX_BYTES) {
			setError(NOT_A_KEY);
			return;
		}
		setKey(await file.text());
	}

	function send(replace: boolean) {
		if (key === null) return;
		setError(null);
		upload.mutate(
			{ key, replace },
			{
				onSuccess: (result) => onDone(result.replacedRecipient !== null),
				onError: (failure) => {
					if (failure instanceof ApiError && failure.code === "BACKUP_KEY_EXISTS") {
						setMustReplace(true);
						return;
					}
					// A failure on the replace step stays on it, so its error is read there.
					setError(errorText(failure));
				},
			},
		);
	}

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
			{mustReplace ? (
				<ConfirmDialog
					// Its own key, so the replace step mounts fresh and focus starts on Cancel.
					key="replace"
					id="backup-key-replace-dialog"
					testId="backup-key-replace-dialog"
					title="Replace this server's backup key?"
					description="This server already has a different backup key. Replacing it deletes that key from the server for good."
					lost={[
						"The backup key on this server now",
						"Restores of backups made with it, unless you keep a copy of it",
					]}
					survives={[
						"Every backup set",
						"The key you are uploading, which new backups then use",
					]}
					confirmLabel="Replace key"
					pending={upload.isPending}
					onConfirm={() => send(true)}
				>
					{error ? (
						<p className="m-0 text-status-error" role="alert">
							{error}
						</p>
					) : null}
				</ConfirmDialog>
			) : (
				<ConfirmDialog
					key="upload"
					id="backup-key-upload-dialog"
					testId="backup-key-upload-dialog"
					destructive={false}
					title="Upload a backup key"
					description="Use this to restore backups made on another server, such as when you rebuild this one from an off-site copy. Choose the portikus-backup-key.txt you downloaded there."
					confirmLabel="Upload key"
					pending={upload.isPending}
					disabled={key === null}
					disabledReason={error ? null : "Choose the key file first."}
					onConfirm={() => send(false)}
				>
					<div className="grid gap-1">
						<label htmlFor={inputId} className="text-[13px] font-semibold">
							Backup key file
						</label>
						<input
							id={inputId}
							data-testid="backup-key-file"
							type="file"
							accept=".txt,text/plain"
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${inputId}-error` : undefined}
							onChange={(event) => void choose(event.target.files?.[0])}
						/>
						{error ? (
							<p id={`${inputId}-error`} className="m-0 text-status-error" role="alert">
								{error}
							</p>
						) : null}
					</div>
				</ConfirmDialog>
			)}
		</ConfirmDialogRoot>
	);
}
