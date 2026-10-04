import { Button } from "@portikus/ui";

/** The recovery codes, shown once right after enrolment (SPEC.md section 24.13). */
export function RecoveryCodes({
	codes,
	onDone,
}: {
	codes: string[];
	onDone: () => void | Promise<void>;
}) {
	return (
		<>
			<ul
				className="pk-mono-body m-0 grid list-none grid-cols-2 gap-2 p-0"
				aria-label="Recovery codes"
				data-testid="recovery-codes"
			>
				{codes.map((code) => (
					<li key={code}>{code}</li>
				))}
			</ul>
			<div className="pk-actions">
				<Button variant="primary" onClick={() => void onDone()}>
					I have saved them, continue
				</Button>
			</div>
		</>
	);
}
