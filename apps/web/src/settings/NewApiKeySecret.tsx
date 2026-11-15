import type { CreatedApiKey } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { CopyButton } from "../second-factor/CopyButton.js";
import { claudeCommand } from "./apiKeyText.js";

export const NEW_SECRET_HEADING_ID = "api-key-secret-title";

/**
 * A key's secret, shown once right after it is made or given a new secret
 * (SPEC.md section 24.13). Nothing keeps it: once this closes the secret is
 * gone from the page, and the server never sends it again.
 */
export function NewApiKeySecret({
	created,
	renewed,
	onDone,
}: {
	created: CreatedApiKey;
	/** True when an existing key got a new secret, so the old one no longer works. */
	renewed: boolean;
	onDone: () => void;
}) {
	const command = claudeCommand(window.location.origin, created.secret);
	return (
		<section
			className="pk-key-secret grid gap-3"
			aria-labelledby={NEW_SECRET_HEADING_ID}
			data-testid="api-key-secret"
		>
			<h3
				id={NEW_SECRET_HEADING_ID}
				tabIndex={-1}
				className="pk-text-heading m-0 text-ink outline-none"
			>
				Copy the secret for {created.key.name}
			</h3>
			<p className="pk-key-warning pk-text-body m-0 text-ink">
				<Icon name="alert" size="sm" className="mt-0.5 flex-none text-status-warning" />
				<span>
					This is the only time Portikus shows it. Store it where you keep passwords; if
					you lose it, renew the key with a new secret.
					{renewed ? " The old secret has stopped working." : ""}
				</span>
			</p>
			<code className="pk-key-code pk-mono-body" data-testid="api-key-secret-value">
				{created.secret}
			</code>
			<div className="pk-actions items-center">
				<CopyButton
					label="Copy secret"
					text={created.secret}
					copied="Secret copied."
					failed="Could not copy. Select the secret instead."
					testId="api-key-copy"
				/>
			</div>
			<h4 className="pk-text-label m-0 text-ink">Use it with Claude Code</h4>
			<p className="pk-text-compact m-0 text-ink-muted">
				Run this in a terminal to add Portikus as an MCP server. It holds the secret, so
				do not share it.
			</p>
			<pre
				className="pk-key-code pk-mono-small m-0"
				data-testid="api-key-claude-command"
			>
				{command}
			</pre>
			<div className="pk-actions items-center">
				<CopyButton
					label="Copy command"
					text={command}
					copied="Command copied."
					failed="Could not copy. Select the command instead."
				/>
			</div>
			<div className="pk-actions">
				<Button variant="primary" data-testid="api-key-secret-done" onClick={onDone}>
					I have saved it, continue
				</Button>
			</div>
		</section>
	);
}
