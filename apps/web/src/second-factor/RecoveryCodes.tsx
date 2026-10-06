import { Button } from "@portikus/ui";
import { downloadBlob } from "../common/download.js";
import { CopyButton } from "./CopyButton.js";

const RECOVERY_CODES_FILE = "portikus-recovery-codes.txt";

/** The recovery codes, shown once right after enrolment (SPEC.md section 24.13). */
export function RecoveryCodes({
	codes,
	onDone,
}: {
	codes: string[];
	onDone: () => void | Promise<void>;
}) {
	const text = `${codes.join("\n")}\n`;
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
				<Button
					variant="secondary"
					onClick={() =>
						downloadBlob(RECOVERY_CODES_FILE, new Blob([text], { type: "text/plain" }))
					}
				>
					Download codes
				</Button>
				<CopyButton
					label="Copy codes"
					text={text}
					copied="Codes copied."
					failed="Could not copy. Select the codes instead."
				/>
			</div>
			<div className="pk-actions">
				<Button variant="primary" onClick={() => void onDone()}>
					I have saved them, continue
				</Button>
			</div>
		</>
	);
}
