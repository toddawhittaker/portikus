import { BACKUP_KEY_MAX_BYTES, type BackupKeyStatus } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	FileInput,
	useToast,
} from "@portikus/ui";
import { useId, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { Notice } from "../Notice.js";
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
				<Notice tone="warning" testId="backup-key-reminder">
					<strong>Backup key not yet downloaded.</strong> Download it and store it off
					this server. Without it, a copy of your backups kept elsewhere cannot be
					restored if this server is lost.
				</Notice>
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
	// Keys the alert, so a second bad pick with the same message is read out again.
	const [picks, setPicks] = useState(0);
	const [mustReplace, setMustReplace] = useState(false);

	async function choose(file: File | undefined) {
		setPicks((n) => n + 1);
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
					// The upload step that opened it is gone, so focus goes back to its opener.
					returnFocusTo={() =>
						document.querySelector<HTMLElement>('[data-testid="backup-key-upload"]')
					}
					title="Replace this server's backup key?"
					description="This server already has a different backup key. The current key is set aside on the server, readable only by root; backups made with it can be restored only with that key."
					lost={[
						"The current key as this server's backup key",
						"Restores of backups made with it, until that key is put back",
					]}
					survives={[
						"Every backup set",
						"A copy of the current key on the server, readable only by root",
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
					<FileInput
						id={inputId}
						label="Backup key file"
						data-testid="backup-key-file"
						accept=".txt,text/plain"
						error={
							// Mounted afresh on each failure, so it is read out at once (SPEC.md section 25.8).
							error ? (
								<span key={picks} role="alert">
									{error}
								</span>
							) : null
						}
						onChange={(event) => void choose(event.target.files?.[0])}
					/>
				</ConfirmDialog>
			)}
		</ConfirmDialogRoot>
	);
}
