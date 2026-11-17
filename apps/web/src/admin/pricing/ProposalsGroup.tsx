import type { PriceProposal } from "@portikus/contracts";
import { Button, TextField, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { TableBox } from "../TableBox.js";
import { SourceCell } from "./PriceTableGroup.js";
import { useDecide } from "./queries.js";
import { DIFF_FIELDS, PROVIDER_LABEL, parseOutputPrice } from "./text.js";

/** Rows a check proposes, each beside the row it would replace; nothing changes until accepted. */
export function ProposalsGroup({ proposals }: { proposals: PriceProposal[] }) {
	if (proposals.length === 0) return null;
	return (
		<AdminGroup
			id="pricing-proposals-title"
			title="Proposed changes"
			testId="pricing-proposals"
			description="Compare each proposed row with the one in use, check the quote against the source, then accept or reject it."
		>
			<ul className="m-0 grid list-none gap-6 p-0">
				{proposals.map((p) => (
					<Proposal key={p.id} proposal={p} />
				))}
			</ul>
		</AdminGroup>
	);
}

function Proposal({ proposal }: { proposal: PriceProposal }) {
	const decide = useDecide();
	const toast = useToast();
	const { current } = proposal;
	const headingId = `proposal-${proposal.id}`;
	const deciding = decide.isPending ? decide.variables?.decision : undefined;
	// A proposal saved before output prices existed has none; accepting needs one typed here.
	const needsOutputPrice = proposal.outputPricePerMillion == null;
	const [outputPrice, setOutputPrice] = useState("");
	const [outputError, setOutputError] = useState<string | null>(null);
	const outputId = `proposal-output-${proposal.id}`;

	function choose(decision: "accept" | "reject", from: HTMLElement) {
		if (decide.isPending) return;
		let typed: number | null = null;
		if (decision === "accept" && needsOutputPrice) {
			typed = parseOutputPrice(outputPrice);
			if (typed === null) {
				setOutputError(
					"Give the price in US dollars per million output tokens, above 0.",
				);
				document.getElementById(outputId)?.focus();
				return;
			}
		}
		setOutputError(null);
		// The decided proposal leaves the list; the next one takes the keyboard, or the Prices group after the last.
		const item = from.closest("li");
		const next = item?.nextElementSibling ?? item?.previousElementSibling;
		const target = next?.querySelector<HTMLElement>("h4") ?? null;
		decide
			.mutateAsync({
				id: proposal.id,
				decision,
				...(typed === null ? {} : { outputPricePerMillion: typed }),
			})
			.then(() => {
				(target ?? document.getElementById("pricing-table-title"))?.focus();
				toast.show({
					tone: "success",
					title: `${proposal.model} ${decision === "accept" ? "accepted" : "rejected"}`,
				});
			})
			// The error shows under the buttons.
			.catch(() => undefined);
	}

	return (
		<li
			className="grid gap-3"
			aria-labelledby={headingId}
			data-testid={`proposal-${proposal.model}`}
		>
			<h4 id={headingId} tabIndex={-1} className="m-0 text-[14px] font-medium">
				<span className="pk-mono-body [overflow-wrap:anywhere]">{proposal.model}</span>{" "}
				<span className="font-normal text-ink-muted">
					{PROVIDER_LABEL[proposal.provider]}, {current ? "changes a row" : "a new row"}
				</span>
			</h4>
			<TableBox label={`Changes for ${proposal.model}`}>
				<table className="pk-table">
					<thead>
						<tr>
							<th scope="col">Figure</th>
							<th scope="col">In use</th>
							<th scope="col">Proposed</th>
						</tr>
					</thead>
					<tbody>
						{DIFF_FIELDS.map((field) => {
							const was = current ? field.show(current) : null;
							const next = field.show(proposal);
							const changed = was !== next;
							return (
								<tr key={field.key} data-changed={changed || undefined}>
									<th scope="row" className="font-normal">
										{field.label}
									</th>
									<td className="text-ink-muted [overflow-wrap:anywhere]">
										{was ?? "None"}
									</td>
									<td className="[overflow-wrap:anywhere]">
										{changed ? (
											<mark className="rounded-sm bg-status-warning-soft px-1 font-medium text-ink">
												{next}
												<span className="sr-only"> (changed)</span>
											</mark>
										) : (
											next
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</TableBox>
			{needsOutputPrice ? (
				<TextField
					id={outputId}
					label="Output price per million tokens"
					unit="USD"
					hint="This proposal has no output price. Read it from the source, then enter it to accept."
					value={outputPrice}
					error={outputError ?? undefined}
					inputMode="decimal"
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setOutputPrice(e.target.value)}
				/>
			) : null}
			<SourceCell url={proposal.sourceUrl} quote={proposal.sourceQuote} />
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="primary"
					data-testid="proposal-accept"
					loading={deciding === "accept"}
					onClick={(e) => choose("accept", e.currentTarget)}
				>
					Accept {proposal.model}
				</Button>
				<Button
					size="sm"
					data-testid="proposal-reject"
					loading={deciding === "reject"}
					onClick={(e) => choose("reject", e.currentTarget)}
				>
					Reject {proposal.model}
				</Button>
			</div>
			{decide.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(decide.error)}
				</p>
			) : null}
		</li>
	);
}
