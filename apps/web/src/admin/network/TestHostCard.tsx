import {
	type AdminEgressView,
	type EgressExplanation,
	explainHost,
} from "@portikus/contracts";
import { Button, Icon, TextField } from "@portikus/ui";
import { useState } from "react";
import { AdminGroup } from "../AdminSection.js";
import { hostFromInput, verdictText } from "./text.js";

/**
 * "Test a host": the same explainHost the API and the enforcement tests use,
 * run on the loaded policy, so the answer and the enforcement cannot disagree.
 */
export function TestHostCard({
	view,
	onAllow,
}: {
	view: AdminEgressView;
	onAllow: (host: string) => void;
}) {
	const [input, setInput] = useState("");
	const [tested, setTested] = useState<string | null>(null);
	const host = tested === null ? null : hostFromInput(tested);
	// Recomputed from the live view, so allowing the host updates the answer.
	const answer: EgressExplanation | null =
		host === null ? null : explainHost(view, host);

	return (
		<AdminGroup
			id="egress-test-title"
			title="Test a host"
			description="Check whether workspaces could reach a site, and why."
		>
			<form
				className="flex items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					setTested(input);
				}}
			>
				<TextField
					id="egress-test-input"
					className="min-w-0 flex-1"
					label="Host name or web address"
					mono
					autoComplete="off"
					spellCheck={false}
					placeholder="github.com"
					data-testid="egress-test-input"
					value={input}
					onChange={(event) => setInput(event.target.value)}
				/>
				<Button type="submit" data-testid="egress-test-run">
					Test
				</Button>
			</form>
			{/* While empty, the always-present live region takes back the grid gap it adds. */}
			<div
				role="status"
				data-testid="egress-test-result-region"
				className="empty:-mt-5"
			>
				{host !== null && answer ? (
					<div
						className={`flex items-start gap-2 rounded-sm px-3 py-2 text-[13px] ${
							answer.allowed ? "bg-status-running-soft" : "bg-surface-sunken"
						}`}
						data-testid="egress-test-result"
						data-reason={answer.reason}
					>
						<span
							className={`mt-0.5 flex-none ${answer.allowed ? "text-status-running" : "text-ink-muted"}`}
						>
							<Icon name={answer.allowed ? "check" : "x"} size="sm" />
						</span>
						<div className="grid min-w-0 gap-2">
							<p className="m-0 text-ink [overflow-wrap:anywhere]">
								{verdictText(host, answer)}
							</p>
							{answer.reason === "not-listed" ? (
								<Button
									size="sm"
									className="w-fit"
									data-testid="egress-test-allow"
									onClick={() => onAllow(host.trim().toLowerCase())}
								>
									Allow {host.trim().toLowerCase()}…
								</Button>
							) : null}
						</div>
					</div>
				) : null}
			</div>
		</AdminGroup>
	);
}
