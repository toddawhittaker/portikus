import {
	type SecondFactor,
	SecondFactorStatus,
	TotpEnrolDone,
} from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { errorText, request, sendJson } from "../api/request.js";
import { EnrolTotp } from "../second-factor/EnrolTotp.js";
import { focusField } from "../second-factor/focusField.js";
import { PasskeyButton } from "../second-factor/PasskeyButton.js";
import { passkeysSupported, registerPasskey } from "../second-factor/passkey.js";
import { RecoveryCodes } from "../second-factor/RecoveryCodes.js";
import { useShowSetting } from "./controls.js";

const STATUS_KEY = ["second-factor"];

const KIND_NAMES: Record<SecondFactor["kind"], string> = {
	totp: "Authenticator app",
	webauthn: "Passkey",
};

function day(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Rename one factor in place; Cancel keeps the old name. */
function RenameForm({ factor, onDone }: { factor: SecondFactor; onDone: () => void }) {
	const client = useQueryClient();
	const [label, setLabel] = useState(factor.label);
	const [error, setError] = useState<string | undefined>();
	const fieldId = `rename-factor-${factor.id}`;
	const rename = useMutation({
		mutationFn: (next: string) =>
			sendJson(
				z.undefined(),
				`/me/second-factor/${factor.id}`,
				{ label: next },
				"PATCH",
			),
	});

	async function submit() {
		const next = label.trim();
		if (next === "") {
			flushSync(() => setError("Give it a name."));
			focusField(fieldId);
			return;
		}
		try {
			await rename.mutateAsync(next);
		} catch (failure) {
			flushSync(() =>
				setError(errorText(failure, "The name was not changed. Try again.")),
			);
			focusField(fieldId);
			return;
		}
		await client.invalidateQueries({ queryKey: STATUS_KEY, exact: true });
		onDone();
	}

	return (
		<form
			className="grid gap-2"
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<TextField
				id={fieldId}
				label="Name"
				maxLength={60}
				value={label}
				error={error}
				onChange={(event) => setLabel(event.target.value)}
			/>
			<div className="pk-actions">
				<Button type="submit" variant="primary" loading={rename.isPending}>
					Save name
				</Button>
				<Button type="button" variant="secondary" onClick={onDone}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function FactorRow({
	factor,
	onRemoveError,
}: {
	factor: SecondFactor;
	onRemoveError: (message: string | null) => void;
}) {
	const client = useQueryClient();
	const [renaming, setRenaming] = useState(false);
	const remove = useMutation({
		mutationFn: () =>
			sendJson(z.undefined(), `/me/second-factor/${factor.id}`, {}, "DELETE"),
	});
	const renameId = `rename-button-${factor.id}`;

	async function removeFactor() {
		onRemoveError(null);
		try {
			await remove.mutateAsync();
		} catch (failure) {
			onRemoveError(errorText(failure, "It was not removed. Try again."));
			return;
		}
		await client.invalidateQueries({ queryKey: STATUS_KEY, exact: true });
		document.getElementById("settings-section-two-factor-intro")?.focus();
	}

	return (
		<li
			className="grid gap-2 rounded-sm border border-line p-3"
			data-testid={`factor-${factor.kind}`}
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid min-w-0 gap-0.5">
					<span className="pk-text-body font-medium text-ink break-words">
						{factor.label}
					</span>
					<span className="pk-text-compact text-ink-muted">
						{KIND_NAMES[factor.kind]}. Added {day(factor.createdAt)}.{" "}
						{factor.lastUsedAt ? `Last used ${day(factor.lastUsedAt)}.` : "Never used."}
					</span>
				</div>
				{renaming ? null : (
					<div className="pk-actions">
						<Button
							id={renameId}
							variant="secondary"
							aria-label={`Rename ${factor.label}`}
							onClick={() => {
								flushSync(() => setRenaming(true));
								focusField(`rename-factor-${factor.id}`);
							}}
						>
							Rename
						</Button>
						<Button
							variant="secondary"
							aria-label={`Remove ${factor.label}`}
							loading={remove.isPending}
							onClick={() => void removeFactor()}
						>
							Remove
						</Button>
					</div>
				)}
			</div>
			{renaming ? (
				<RenameForm
					factor={factor}
					onDone={() => {
						flushSync(() => setRenaming(false));
						document.getElementById(renameId)?.focus();
					}}
				/>
			) : null}
		</li>
	);
}

/**
 * Settings, Two-factor sign-in: the second factors of a Dex local
 * password (SPEC.md section 24.13). Lists them, adds an authenticator app
 * or a passkey, renames and removes them, and makes new recovery codes.
 */
export function TwoFactorPane({ highlightId }: { highlightId: string | null }) {
	const client = useQueryClient();
	const status = useQuery({
		queryKey: STATUS_KEY,
		queryFn: () => request(SecondFactorStatus, "/me/second-factor"),
	});
	const [adding, setAdding] = useState(false);
	const [codes, setCodes] = useState<string[] | null>(null);
	const [removeError, setRemoveError] = useState<string | null>(null);
	const regenerate = useMutation({
		mutationFn: () => sendJson(TotpEnrolDone, "/me/second-factor/recovery-codes", {}),
	});
	useShowSetting(highlightId, status.isSuccess);

	function showCodes(next: string[]) {
		flushSync(() => {
			setAdding(false);
			setCodes(next);
		});
		document.getElementById("two-factor-codes-title")?.focus();
		void client.invalidateQueries({ queryKey: STATUS_KEY, exact: true });
	}

	return (
		<section
			className="relative grid gap-6"
			aria-labelledby="settings-section-two-factor"
		>
			{/* The section list already shows which section is open. */}
			<h2 id="settings-section-two-factor" className="sr-only">
				Two-factor sign-in
			</h2>
			<p
				id="settings-section-two-factor-intro"
				tabIndex={-1}
				className="pk-text-body m-0 text-ink-muted outline-none"
			>
				After your password, Portikus asks for one of these. You need at least one, so
				add another before you remove your last.
			</p>

			{codes !== null ? (
				<section className="grid gap-3" aria-labelledby="two-factor-codes-title">
					<h3
						id="two-factor-codes-title"
						tabIndex={-1}
						className="pk-text-heading text-ink outline-none"
					>
						Your new recovery codes
					</h3>
					<p className="pk-text-body m-0">
						Each code signs you in once if you lose your other ways in. Keep them
						somewhere safe; they are not shown again, and your old codes no longer work.
					</p>
					<RecoveryCodes
						codes={codes}
						onDone={() => {
							flushSync(() => setCodes(null));
							document.getElementById("settings-section-two-factor-intro")?.focus();
						}}
					/>
				</section>
			) : null}

			<section
				id="settings-control-second-factors"
				tabIndex={-1}
				className="grid gap-3 outline-none"
				aria-labelledby="two-factor-list-title"
			>
				<h3 id="two-factor-list-title" className="pk-text-heading text-ink">
					Your sign-in methods
				</h3>
				{status.isPending ? (
					<p className="pk-text-body m-0 text-ink-muted">Loading…</p>
				) : status.isError ? (
					<p className="pk-text-body m-0 text-status-error" role="alert">
						{errorText(status.error, "Your sign-in methods could not be loaded.")}
					</p>
				) : (
					<ul
						className="m-0 grid list-none gap-2 p-0"
						aria-labelledby="two-factor-list-title"
					>
						{status.data.factors.map((factor) => (
							<FactorRow
								key={factor.id}
								factor={factor}
								onRemoveError={setRemoveError}
							/>
						))}
					</ul>
				)}
				{removeError ? (
					<p
						className="pk-text-body m-0 text-status-error"
						role="alert"
						data-testid="factor-remove-error"
					>
						{removeError}
					</p>
				) : null}
			</section>

			<section
				id="settings-control-add-second-factor"
				tabIndex={-1}
				className="grid gap-3 outline-none"
				aria-labelledby="two-factor-add-title"
			>
				<h3 id="two-factor-add-title" className="pk-text-heading text-ink">
					Add a sign-in method
				</h3>
				{adding ? (
					<>
						<EnrolTotp onEnrolled={showCodes} />
						<div>
							<Button variant="secondary" onClick={() => setAdding(false)}>
								Cancel
							</Button>
						</div>
					</>
				) : (
					<div className="pk-actions">
						<Button
							variant="secondary"
							iconStart="plus"
							onClick={() => setAdding(true)}
						>
							Add an authenticator app
						</Button>
					</div>
				)}
				{!adding && passkeysSupported() ? (
					<PasskeyButton
						label="Add a passkey"
						testId="add-passkey"
						action={async () => showCodes(await registerPasskey())}
					/>
				) : null}
			</section>

			<section
				id="settings-control-recovery-codes"
				tabIndex={-1}
				className="grid gap-3 outline-none"
				aria-labelledby="two-factor-recovery-title"
			>
				<h3 id="two-factor-recovery-title" className="pk-text-heading text-ink">
					Recovery codes
				</h3>
				<p className="pk-text-body m-0" data-testid="recovery-codes-left">
					{status.isSuccess
						? `${status.data.recoveryCodesLeft} unused recovery ${
								status.data.recoveryCodesLeft === 1 ? "code" : "codes"
							} left.`
						: ""}{" "}
					New codes replace all of the old ones.
				</p>
				<div>
					<Button
						variant="secondary"
						loading={regenerate.isPending}
						onClick={() =>
							regenerate.mutate(undefined, {
								onSuccess: (done) => showCodes(done.recoveryCodes),
							})
						}
					>
						Make new recovery codes
					</Button>
				</div>
				{regenerate.error ? (
					<p className="pk-text-body m-0 text-status-error" role="alert">
						{errorText(regenerate.error, "New codes were not made. Try again.")}
					</p>
				) : null}
			</section>
		</section>
	);
}
