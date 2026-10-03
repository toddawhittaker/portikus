import { type AdminEgressView, EGRESS_DEFAULT_PORTS } from "@portikus/contracts";
import { Button, FIELD_CLASS, LABEL_CLASS, TextField, useToast } from "@portikus/ui";
import { useState } from "react";
import { announced } from "../../common/announced.js";
import { joinWords } from "../../text.js";
import { Part } from "../AdminSection.js";
import { egressErrorText, useEgressWrite } from "./queries.js";
import { parsePorts } from "./text.js";

/** The TCP ports a listed host may be reached on in allow-list mode. */
export function PortsPart({ view }: { view: AdminEgressView }) {
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
		<Part
			id="egress-ports-title"
			title="Ports"
			description={`In allow-list mode, listed sites are reached only on these ports. The default, ${joinWords(EGRESS_DEFAULT_PORTS.map(String))}, covers SSH, web and secure web. Separate ports with commas.`}
		>
			<form
				className="flex flex-wrap items-start gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}
			>
				{/* A short field whose error may run on under Save rather than wrap in 16ch. */}
				<TextField
					id="egress-ports"
					className="w-[16ch] grid-cols-[minmax(0,1fr)] [&_.pk-error]:w-max [&_.pk-error]:max-w-[min(60ch,100cqi)]"
					label="Allowed ports"
					mono
					autoComplete="off"
					data-testid="egress-ports"
					value={value}
					error={announced(error)}
					onChange={(event) => setDraft(event.target.value)}
				/>
				{/* An empty label row, so Save lines up with the input whatever shows under it. */}
				<div className={FIELD_CLASS}>
					<span className={LABEL_CLASS} aria-hidden={true}>
						&nbsp;
					</span>
					<Button
						type="submit"
						data-testid="egress-ports-save"
						loading={write.isPending}
					>
						Save ports
					</Button>
				</div>
			</form>
		</Part>
	);
}
