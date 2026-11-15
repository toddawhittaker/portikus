import type { ApiKeyPeriod, ApiKeyScope, CreatedApiKey } from "@portikus/contracts";
import { Button, HINT_CLASS, LABEL_CLASS, TextField } from "@portikus/ui";
import { useState } from "react";
import { flushSync } from "react-dom";
import { errorText } from "../api/request.js";
import { focusField } from "../second-factor/focusField.js";
import {
	type NewApiKey,
	useCreateApiKey,
	useCreateApiKeyWithPasskey,
} from "./apiKeyQueries.js";
import { periodLabel, SCOPE_TEXT, SCOPES } from "./apiKeyText.js";
import { MISSING_CODE, StepUpFields } from "./StepUpFields.js";

const NAME_ID = "api-key-name";
const CODE_ID = "api-key-code";

/** The period a new key starts on: 30 days when offered, else the first the API offers. */
export function defaultPeriod(periods: readonly ApiKeyPeriod[]): ApiKeyPeriod {
	return periods.includes(30) ? 30 : (periods[0] ?? 30);
}

function periodValue(period: ApiKeyPeriod): string {
	return period === null ? "never" : String(period);
}

/**
 * The create form (SPEC.md section 24.13). It offers the periods the API
 * says this account may choose. A Dex local-password account proves a code
 * or a passkey here; other accounts owe no check.
 */
export function CreateApiKeyForm({
	periods,
	needsSecondFactor,
	onCreated,
	onCancel,
}: {
	periods: readonly ApiKeyPeriod[];
	needsSecondFactor: boolean;
	onCreated: (created: CreatedApiKey) => void;
	onCancel: () => void;
}) {
	const create = useCreateApiKey();
	const createWithPasskey = useCreateApiKeyWithPasskey();
	const [name, setName] = useState("");
	const [scope, setScope] = useState<ApiKeyScope>("read");
	const [period, setPeriod] = useState<ApiKeyPeriod>(() => defaultPeriod(periods));
	const [code, setCode] = useState("");
	const [nameError, setNameError] = useState<string | undefined>();
	const [codeError, setCodeError] = useState<string | undefined>();

	/** The form's fields, or null after moving focus to the field that needs fixing. */
	function fields(): NewApiKey | null {
		if (name.trim() === "") {
			flushSync(() =>
				setNameError("Give the key a name, such as the tool that uses it."),
			);
			focusField(NAME_ID);
			return null;
		}
		setNameError(undefined);
		return { name: name.trim(), scope, periodDays: period };
	}

	function submit() {
		const body = fields();
		if (body === null) return;
		if (needsSecondFactor && code.trim() === "") {
			flushSync(() => setCodeError(MISSING_CODE));
			focusField(CODE_ID);
			return;
		}
		setCodeError(undefined);
		create.mutate(needsSecondFactor ? { ...body, code: code.trim() } : body, {
			onSuccess: onCreated,
			onError: (failure) => {
				if (!needsSecondFactor) return;
				// The field carries a code refusal so it is read with its label (SPEC.md 25.8).
				flushSync(() => setCodeError(errorText(failure, "That code did not work.")));
				focusField(CODE_ID);
			},
		});
	}

	const shownError = needsSecondFactor ? null : create.error;

	return (
		<form
			className="grid gap-4"
			noValidate
			aria-labelledby="api-key-create-title"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<TextField
				id={NAME_ID}
				label="Name"
				hint="Something that says where it is used, such as Claude Code on my laptop."
				maxLength={100}
				autoComplete="off"
				value={name}
				error={nameError}
				onChange={(event) => setName(event.target.value)}
			/>
			<fieldset className="pk-key-options">
				<legend className={`${LABEL_CLASS} mb-1.5 p-0`}>Access</legend>
				{SCOPES.map((value) => (
					<label key={value} className="pk-key-option">
						<input
							type="radio"
							name="api-key-scope"
							value={value}
							checked={scope === value}
							aria-describedby={`api-key-scope-${value}`}
							onChange={() => setScope(value)}
						/>
						<span className="grid gap-0.5">
							<span className="pk-text-body text-ink">{SCOPE_TEXT[value].label}</span>
							<span id={`api-key-scope-${value}`} className={HINT_CLASS}>
								{SCOPE_TEXT[value].detail}
							</span>
						</span>
					</label>
				))}
			</fieldset>
			{periods.length > 1 ? (
				<fieldset
					className="pk-key-options"
					data-inline=""
					aria-describedby="api-key-period-hint"
				>
					<legend className={`${LABEL_CLASS} mb-1.5 p-0`}>Expires after</legend>
					<div className="pk-key-choices">
						{periods.map((value) => (
							<label key={periodValue(value)} className="pk-key-option">
								<input
									type="radio"
									name="api-key-period"
									value={periodValue(value)}
									checked={period === value}
									onChange={() => setPeriod(value)}
								/>
								<span className="pk-text-body text-ink">
									{value === null ? "Never" : periodLabel(value)}
								</span>
							</label>
						))}
					</div>
					<p id="api-key-period-hint" className={`${HINT_CLASS} m-0`}>
						You can renew a key before or after it expires, and it keeps its secret.
					</p>
				</fieldset>
			) : (
				<div className="grid gap-1" data-testid="api-key-period-fixed">
					<p className={`${LABEL_CLASS} m-0`}>Expires after</p>
					<p className="pk-text-body m-0 text-ink">{periodLabel(period)}</p>
					<p className={`${HINT_CLASS} m-0`}>
						Keys for accounts that sign in through your institution last{" "}
						{periodLabel(period)}. Sign in and renew one to keep using it, even after it
						expires.
					</p>
				</div>
			)}
			{needsSecondFactor ? (
				<StepUpFields
					codeId={CODE_ID}
					code={code}
					codeError={codeError}
					onCodeChange={setCode}
					passkeyLabel="Create with a passkey"
					passkeyTestId="api-key-passkey"
					onPasskey={async () => {
						const body = fields();
						if (body === null) return;
						onCreated(await createWithPasskey.mutateAsync(body));
					}}
				/>
			) : null}
			{shownError ? (
				<p className="pk-text-body m-0 text-status-error" role="alert">
					{errorText(shownError, "The key was not created. Try again.")}
				</p>
			) : null}
			<div className="pk-actions">
				<Button
					type="submit"
					variant="primary"
					loading={create.isPending}
					data-testid="api-key-create-submit"
				>
					Create key
				</Button>
				<Button type="button" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
