import { type AiSettingsView, MAX_AI_TRIAGE_DAILY_LIMIT } from "@portikus/contracts";
import { Button, TextField, useToast } from "@portikus/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { useUpdateAi } from "./queries.js";
import { parseDailyLimit } from "./text.js";

const DEFAULT_DAILY_LIMIT = 5;

/** One switch with its explanation line; the saved value shows while a save is pending. */
function SwitchRow({
	label,
	hint,
	checked,
	testId,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	testId: string;
	onChange: (next: boolean) => void;
}) {
	const hintId = useId();
	return (
		<div className="grid gap-1">
			<label className="pk-switch text-[14px]">
				<input
					type="checkbox"
					role="switch"
					aria-checked={checked}
					data-testid={testId}
					checked={checked}
					aria-describedby={hintId}
					onChange={(event) => onChange(event.target.checked)}
				/>
				<span>{label}</span>
			</label>
			<p id={hintId} className="pk-muted m-0 text-[13px]">
				{hint}
			</p>
		</div>
	);
}

/**
 * Alert explanations (SPEC.md section 20.4): the switch, the daily limit
 * and the forwarding switch. Both switches are off until an administrator
 * turns them on; explanations are written only while the assistant itself
 * is on with its notice accepted.
 */
export function TriageGroup({ view }: { view: AiSettingsView }) {
	const toast = useToast();
	const save = useUpdateAi();
	const [limit, setLimit] = useState(String(view.triageDailyLimit));
	const [error, setError] = useState<string>();
	// The group is never remounted, so focus stays where it was after a save; a
	// new saved value, from this tab or another, replaces the field's text.
	useEffect(() => {
		setLimit(String(view.triageDailyLimit));
	}, [view.triageDailyLimit]);
	const pending = save.isPending ? save.variables : undefined;
	const explain = pending?.triageEnabled ?? view.triageEnabled;
	const forward = pending?.triageForward ?? view.triageForward;

	function toggle(body: { triageEnabled: boolean } | { triageForward: boolean }) {
		if (save.isPending) return;
		save.mutate(body, {
			onSuccess: () => toast.show({ tone: "success", title: "Alert settings saved" }),
		});
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const parsed = parseDailyLimit(limit);
		if (parsed === null) {
			setError(`Give a whole number from 0 to ${MAX_AI_TRIAGE_DAILY_LIMIT}.`);
			document.getElementById("ai-triage-limit")?.focus();
			return;
		}
		setError(undefined);
		save.mutate(
			{ triageDailyLimit: parsed },
			{ onSuccess: () => toast.show({ tone: "success", title: "Daily limit saved" }) },
		);
	}

	return (
		<Group
			id="ai-triage-title"
			title="Alert explanations"
			testId="ai-triage"
			description="A model can explain a new warning or error alert on its own. Nobody has to ask."
		>
			<SwitchRow
				label="Explain alerts"
				testId="ai-triage-switch"
				checked={explain}
				hint={
					explain
						? "New warning and error alerts are explained while the assistant is on. The alert, health figures and redacted error lines go to the provider."
						: "Off. No alert is sent to the provider unless someone asks the assistant about it."
				}
				onChange={(next) => toggle({ triageEnabled: next })}
			/>
			{explain ? (
				<form className="grid max-w-[36rem] gap-4" noValidate onSubmit={onSubmit}>
					<TextField
						id="ai-triage-limit"
						label="Most explanations a day"
						inputMode="numeric"
						value={limit}
						error={error}
						hint={`Counted by UTC day, and at most one for each alert title an hour. 0 writes none. The default is ${DEFAULT_DAILY_LIMIT}.`}
						onChange={(e) => setLimit(e.target.value)}
					/>
					<div className="flex flex-wrap gap-2">
						<Button
							type="submit"
							variant="primary"
							data-testid="ai-triage-limit-save"
							loading={save.isPending && pending?.triageDailyLimit !== undefined}
						>
							Save daily limit
						</Button>
					</div>
				</form>
			) : null}
			<SwitchRow
				label="Add explanations to email and Pushover alerts"
				testId="ai-triage-forward-switch"
				checked={forward}
				hint={
					forward
						? "Email and Pushover alerts wait up to a minute for the explanation, then send with it or without it."
						: "Off. Email and Pushover alerts go out as they are, without an explanation."
				}
				onChange={(next) => toggle({ triageForward: next })}
			/>
			{save.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(save.error)}
				</p>
			) : null}
		</Group>
	);
}
