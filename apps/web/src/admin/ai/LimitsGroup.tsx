import {
	type AiSettingsView,
	MAX_AI_CONVERSATION_TOKEN_BUDGET,
	MAX_AI_MONTHLY_TOKEN_CAP,
} from "@portikus/contracts";
import { Button, Meter, TextField, useToast } from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { useUpdateAi } from "./queries.js";
import {
	DEFAULT_CONVERSATION_TOKEN_BUDGET,
	DEFAULT_MONTHLY_TOKEN_CAP,
	parseCount,
	tokens,
} from "./text.js";

type Errors = { cap?: string; budget?: string };

/** The site's monthly token cap and each conversation's budget (decision D3). */
export function LimitsGroup({ view }: { view: AiSettingsView }) {
	const toast = useToast();
	const save = useUpdateAi();
	const [cap, setCap] = useState(String(view.monthlyTokenCap));
	const [budget, setBudget] = useState(String(view.conversationTokenBudget));
	const [errors, setErrors] = useState<Errors>({});

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const capN = parseCount(cap, MAX_AI_MONTHLY_TOKEN_CAP);
		const budgetN = parseCount(budget, MAX_AI_CONVERSATION_TOKEN_BUDGET);
		const found: Errors = {};
		if (capN === null)
			found.cap = `Give a whole number from 1 to ${MAX_AI_MONTHLY_TOKEN_CAP.toLocaleString("en")}.`;
		if (budgetN === null)
			found.budget = `Give a whole number from 1 to ${MAX_AI_CONVERSATION_TOKEN_BUDGET.toLocaleString("en")}.`;
		setErrors(found);
		if (capN === null || budgetN === null) {
			document.getElementById(capN === null ? "ai-cap" : "ai-budget")?.focus();
			return;
		}
		save.mutate(
			{ monthlyTokenCap: capN, conversationTokenBudget: budgetN },
			{ onSuccess: () => toast.show({ tone: "success", title: "Limits saved" }) },
		);
	}

	return (
		<Group
			id="ai-limits-title"
			title="Limits"
			testId="ai-limits"
			description="When the site reaches its monthly cap, the assistant stops until the next month."
		>
			<div className="grid max-w-[36rem] gap-1">
				<span id="ai-used-label" className="pk-label text-[14px] font-medium">
					Used this month
				</span>
				<Meter
					aria-labelledby="ai-used-label"
					value={view.usedThisMonth}
					max={view.monthlyTokenCap}
					high={view.monthlyTokenCap * 0.9}
					valueText={`${tokens(view.usedThisMonth)} of ${tokens(view.monthlyTokenCap)}`}
				/>
			</div>
			<form className="grid max-w-[36rem] gap-4" noValidate onSubmit={onSubmit}>
				<TextField
					id="ai-cap"
					label="Monthly token cap"
					inputMode="numeric"
					value={cap}
					error={errors.cap}
					hint={`For the whole site. The default is ${DEFAULT_MONTHLY_TOKEN_CAP.toLocaleString("en")}.`}
					onChange={(e) => setCap(e.target.value)}
				/>
				<TextField
					id="ai-budget"
					label="Budget for each conversation"
					inputMode="numeric"
					value={budget}
					error={errors.budget}
					hint={`In tokens. The default is ${DEFAULT_CONVERSATION_TOKEN_BUDGET.toLocaleString("en")}.`}
					onChange={(e) => setBudget(e.target.value)}
				/>
				{save.isError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{errorText(save.error)}
					</p>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						variant="primary"
						data-testid="ai-limits-save"
						loading={save.isPending}
					>
						Save limits
					</Button>
				</div>
			</form>
		</Group>
	);
}
