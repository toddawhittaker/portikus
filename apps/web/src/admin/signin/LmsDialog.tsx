import type { AdminLtiPlatform, OperatorLtiPlatform } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { announced } from "../../common/announced.js";
import { Notice } from "../Notice.js";
import { TextAreaField } from "../TextAreaField.js";
import {
	checkDraft,
	type LmsDraft,
	type LmsErrors,
	type LmsField,
} from "./lms-form.js";

export const RESTART_WARNING =
	"Saving restarts the Portikus API. Any open root shell ends, and browser connections reconnect on their own within a few seconds.";

const FIELDS: {
	key: Exclude<LmsField, "deploymentIds">;
	label: string;
	hint?: string;
}[] = [
	{ key: "name", label: "Name", hint: "Shown to administrators and instructors." },
	{
		key: "issuer",
		label: "Issuer",
		hint: "The platform's issuer, such as https://canvas.instructure.com.",
	},
	{
		key: "clientId",
		label: "Client ID",
		hint: "The ID the LMS gave Portikus when it was registered.",
	},
	{
		key: "authLoginUrl",
		label: "Login address",
		hint: "The platform's OIDC authorization endpoint.",
	},
	{
		key: "keysetUrl",
		label: "Keyset address",
		hint: "The platform's public keys (JWKS). It must use the default HTTPS port.",
	},
	{
		key: "authTokenUrl",
		label: "Token address (optional)",
		hint: "Needed for roster sync. It must use the default HTTPS port.",
	},
];

/** Add or edit one LMS platform (ADR 0025, ADR 0059). */
export function LmsDialog({
	title,
	initial,
	others,
	operator,
	pending,
	error,
	onSave,
	onClose,
	returnFocusTo,
}: {
	title: string;
	initial: LmsDraft;
	others: AdminLtiPlatform[];
	operator: OperatorLtiPlatform[];
	pending: boolean;
	error: string | null;
	onSave: (platform: AdminLtiPlatform) => void;
	onClose: () => void;
	returnFocusTo: () => HTMLElement | null;
}) {
	const [draft, setDraft] = useState(initial);
	const [errors, setErrors] = useState<LmsErrors>({});
	const firstError = [...FIELDS.map((f) => f.key), "deploymentIds" as const].find(
		(key) => errors[key],
	);

	function save() {
		const result = checkDraft(draft, others, operator);
		if ("platform" in result) {
			setErrors({});
			onSave(result.platform);
			return;
		}
		setErrors(result.errors);
	}

	const set = (key: LmsField, value: string) => {
		setDraft((now) => ({ ...now, [key]: value }));
		setErrors(({ [key]: _, ...rest }) => rest);
	};

	return (
		<DialogRoot open onOpenChange={(open) => (open ? null : onClose())}>
			<Dialog
				testId="lms-dialog"
				returnFocusTo={returnFocusTo}
				title={title}
				description="Register Portikus in the LMS first, then enter what the LMS gave you."
				footer={
					<>
						<Button onClick={onClose}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="lms-save"
							loading={pending}
							onClick={save}
						>
							Save and restart
						</Button>
					</>
				}
			>
				<div className="grid gap-4">
					<Notice tone="warning" testId="lms-restart-warning">
						{RESTART_WARNING}
					</Notice>
					{FIELDS.map((field) => (
						<TextField
							key={field.key}
							id={`lms-${field.key}`}
							label={field.label}
							hint={field.hint}
							mono={field.key !== "name"}
							autoComplete="off"
							spellCheck={false}
							data-testid={`lms-${field.key}`}
							value={draft[field.key]}
							error={
								field.key === firstError
									? announced(errors[field.key] ?? null)
									: (errors[field.key] ?? null)
							}
							onChange={(event) => set(field.key, event.target.value)}
						/>
					))}
					<TextAreaField
						id="lms-deploymentIds"
						label="Deployment IDs"
						hint="One per line."
						rows={3}
						mono
						error={errors.deploymentIds}
						value={draft.deploymentIds}
						onChange={(value) => set("deploymentIds", value)}
					/>
				</div>
				{error ? (
					<p
						className="m-0 mt-3 text-[13px] text-status-error"
						role="alert"
						data-testid="lms-error"
					>
						{error}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}
