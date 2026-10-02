import { type AdminEgressView, EGRESS_DEFAULT_PORTS } from "@portikus/contracts";
import { Button, TextField, useToast } from "@portikus/ui";
import { useState } from "react";
import { announced } from "../../common/announced.js";
import { joinWords } from "../../text.js";
import { egressErrorText, useEgressWrite } from "./queries.js";
import { parsePorts } from "./text.js";

/** The TCP ports a listed host may be reached on in allow-list mode. */
export function PortsCard({ view }: { view: AdminEgressView }) {
	const write = useEgressWrite();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const value = draft ?? view.ports.join(", ");

	function save() {
		const parsed = parsePorts(value);
		if ("error" in parsed) {
			setError(parsed.error);
			return;
		}
		setError(null);
		write.mutate(
			{ kind: "ports", version: view.version, ports: parsed.ports },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Ports saved" });
				},
				onError: (failure) => setError(egressErrorText(failure)),
			},
		);
	}

	return (
		<section className="pk-card p-6" aria-labelledby="egress-ports-title">
			<h3 className="pk-text-heading m-0" id="egress-ports-title">
				Ports
			</h3>
			<p className="pk-text-body pk-muted mt-1 mb-0">
				In allow-list mode, listed sites are reached only on these ports. The default,{" "}
				{joinWords(EGRESS_DEFAULT_PORTS.map(String))}, covers SSH, web and secure web.
			</p>
			<form
				className="mt-4 flex flex-wrap items-start gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}
			>
				<TextField
					id="egress-ports"
					className="w-64"
					label="Allowed ports"
					hint="Separate them with commas."
					mono
					autoComplete="off"
					data-testid="egress-ports"
					value={value}
					error={announced(error)}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<Button
					type="submit"
					variant="primary"
					className="mt-[23px]"
					data-testid="egress-ports-save"
					loading={write.isPending}
				>
					Save
				</Button>
			</form>
		</section>
	);
}
