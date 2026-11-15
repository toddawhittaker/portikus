import type { ApiKey, CreatedApiKey } from "@portikus/contracts";
import { Badge, Button, ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useState } from "react";
import { flushSync } from "react-dom";
import { errorText } from "../api/request.js";
import {
	useMyApiKeys,
	useRenewApiKey,
	useRevokeApiKey,
	useRotateApiKey,
} from "./apiKeyQueries.js";
import {
	canRenew,
	expiryText,
	keyDay,
	lastUsedText,
	periodLabel,
	SCOPE_TEXT,
	STATE_TEXT,
} from "./apiKeyText.js";
import { CreateApiKeyForm } from "./CreateApiKeyForm.js";
import { useShowSetting } from "./controls.js";
import { NEW_SECRET_HEADING_ID, NewApiKeySecret } from "./NewApiKeySecret.js";
import "./apiKeys.css";

const INTRO_ID = "settings-section-api-keys-intro";
const CREATE_ID = "api-key-create";
const CREATE_TITLE_ID = "api-key-create-title";

function focusById(id: string) {
	document.getElementById(id)?.focus();
}

function rowHeadingId(key: ApiKey) {
	return `api-key-row-${key.id}`;
}

/** The new secret on screen, and whether it replaced an old one. */
interface Shown {
	created: CreatedApiKey;
	renewed: boolean;
}

/**
 * Settings, API keys, for administrators and instructors only (SPEC.md
 * sections 24.8 and 24.13): the owner's keys with renew, renew with a new
 * secret and revoke, and the form that makes one. A secret is shown once.
 */
export function ApiKeysPane({
	highlightId,
	needsSecondFactor,
}: {
	highlightId: string | null;
	/** A Dex local-password account proves its second factor to create a key. */
	needsSecondFactor: boolean;
}) {
	const keys = useMyApiKeys();
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState<Shown | null>(null);
	const [status, setStatus] = useState("");
	useShowSetting(highlightId, keys.isSuccess);

	function show(created: CreatedApiKey, renewed: boolean) {
		flushSync(() => {
			setCreating(false);
			setShown({ created, renewed });
		});
		focusById(NEW_SECRET_HEADING_ID);
	}

	const list = keys.data?.keys ?? [];

	return (
		<section
			className="pk-keys relative grid gap-6"
			aria-labelledby="settings-section-api-keys"
		>
			{/* The section list already shows which section is open. */}
			<h2 id="settings-section-api-keys" className="sr-only">
				API keys
			</h2>
			<p
				id={INTRO_ID}
				tabIndex={-1}
				className="pk-text-body m-0 text-ink-muted outline-none"
			>
				An API key lets a tool such as Claude Code or Codex use Portikus as you, through
				its MCP server or its API. It can do only what you can, and no more than its
				access allows. Treat it like a password.
			</p>

			{shown ? (
				<NewApiKeySecret
					created={shown.created}
					renewed={shown.renewed}
					onDone={() => {
						flushSync(() => setShown(null));
						focusById(rowHeadingId(shown.created.key));
					}}
				/>
			) : null}

			<section
				id="settings-control-api-keys-list"
				tabIndex={-1}
				className="grid gap-3 outline-none"
				aria-labelledby="api-keys-list-title"
			>
				<h3 id="api-keys-list-title" className="pk-text-heading m-0 text-ink">
					Your API keys
				</h3>
				{keys.isPending ? (
					<p className="pk-text-body m-0 text-ink-muted">Loading your keys…</p>
				) : keys.isError ? (
					<p className="pk-text-body m-0 text-status-error" role="alert">
						{errorText(
							keys.error,
							"Your API keys could not be loaded. Close Settings and try again.",
						)}
					</p>
				) : list.length === 0 ? (
					<p className="pk-text-body m-0 text-ink-muted" data-testid="api-keys-empty">
						You have no API keys yet.
					</p>
				) : (
					<ul className="pk-key-list" aria-labelledby="api-keys-list-title">
						{list.map((key) => (
							<KeyRow
								key={key.id}
								apiKey={key}
								onStatus={setStatus}
								onNewSecret={(created) => show(created, true)}
							/>
						))}
					</ul>
				)}
				{/* Always mounted, so a screen reader hears each renewal and revocation. */}
				<p
					role="status"
					className="pk-text-compact m-0 text-ink-muted"
					data-testid="api-keys-status"
				>
					{status}
				</p>
			</section>

			<section
				id="settings-control-api-key-create"
				tabIndex={-1}
				className="grid gap-3 outline-none"
				aria-labelledby={CREATE_TITLE_ID}
			>
				<h3
					id={CREATE_TITLE_ID}
					tabIndex={-1}
					className="pk-text-heading m-0 text-ink outline-none"
				>
					Create an API key
				</h3>
				{creating && keys.isSuccess ? (
					<CreateApiKeyForm
						periods={keys.data.periods}
						needsSecondFactor={needsSecondFactor}
						onCreated={(created) => show(created, false)}
						onCancel={() => {
							flushSync(() => setCreating(false));
							focusById(CREATE_ID);
						}}
					/>
				) : (
					<div className="pk-actions">
						<Button
							id={CREATE_ID}
							variant="secondary"
							iconStart="plus"
							disabled={!keys.isSuccess}
							onClick={() => {
								setStatus("");
								// The button goes away; the heading keeps focus in place.
								flushSync(() => setCreating(true));
								focusById(CREATE_TITLE_ID);
							}}
						>
							Create an API key
						</Button>
					</div>
				)}
			</section>
		</section>
	);
}

/** One key: what it is, its state, and what its owner can still do with it. */
function KeyRow({
	apiKey: key,
	onStatus,
	onNewSecret,
}: {
	apiKey: ApiKey;
	onStatus: (text: string) => void;
	onNewSecret: (created: CreatedApiKey) => void;
}) {
	const renew = useRenewApiKey();
	const rotate = useRotateApiKey();
	const revoke = useRevokeApiKey();
	const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
	const state = STATE_TEXT[key.state];
	const lastUsed = lastUsedText(key.lastUsedAt, Date.now());
	const headingId = rowHeadingId(key);
	const error = renew.error ?? rotate.error ?? revoke.error;

	function runRenew() {
		onStatus("");
		renew.mutate(key.id, {
			onSuccess: (renewed) =>
				onStatus(
					renewed.expiresAt === null
						? `${key.name} renewed. It never expires.`
						: `${key.name} renewed. It now expires ${keyDay(renewed.expiresAt)}.`,
				),
		});
	}

	function runRotate() {
		rotate.mutate(key.id, {
			onSuccess: (created) => {
				setConfirm(null);
				onNewSecret(created);
			},
		});
	}

	function runRevoke() {
		revoke.mutate(key.id, {
			onSuccess: () => {
				setConfirm(null);
				onStatus(`${key.name} revoked.`);
			},
		});
	}

	return (
		<li
			className="pk-key-row"
			data-state={key.state}
			data-testid={`api-key-${key.prefix}`}
		>
			<div className="pk-key-head">
				<h4
					id={headingId}
					tabIndex={-1}
					className="pk-key-name pk-text-body m-0 font-medium text-ink outline-none"
				>
					{key.name}
				</h4>
				<Badge tone={state.tone} data-testid="api-key-state">
					{state.label}
				</Badge>
			</div>
			<dl className="pk-key-facts pk-text-compact">
				<div>
					<dt>Starts with</dt>
					<dd className="pk-mono-small">{key.prefix}</dd>
				</div>
				<div>
					<dt>Access</dt>
					<dd>{SCOPE_TEXT[key.scope].label}</dd>
				</div>
				<div>
					<dt>
						{key.state === "revoked"
							? "Stopped"
							: key.state === "expired"
								? "Expired"
								: "Expires"}
					</dt>
					<dd data-testid="api-key-expiry">{expiryText(key)}</dd>
				</div>
				<div>
					<dt>Last used</dt>
					<dd>{lastUsed}</dd>
				</div>
			</dl>
			{key.state === "revoked" ? null : (
				<div className="pk-actions">
					{canRenew(key) ? (
						<>
							<Button
								size="sm"
								variant="secondary"
								aria-describedby={headingId}
								loading={renew.isPending}
								onClick={runRenew}
							>
								Renew
							</Button>
							<Button
								size="sm"
								variant="secondary"
								aria-describedby={headingId}
								onClick={() => {
									rotate.reset();
									setConfirm("rotate");
								}}
							>
								Renew with a new secret…
							</Button>
						</>
					) : null}
					<Button
						size="sm"
						variant="danger-secondary"
						aria-describedby={headingId}
						onClick={() => {
							revoke.reset();
							setConfirm("revoke");
						}}
					>
						Revoke…
					</Button>
				</div>
			)}
			{error && confirm === null ? (
				<p className="pk-text-body m-0 text-status-error" role="alert">
					{errorText(error, "That did not work. Try again.")}
				</p>
			) : null}
			<ConfirmDialogRoot
				open={confirm === "rotate"}
				onOpenChange={(open) => !open && !rotate.isPending && setConfirm(null)}
			>
				<ConfirmDialog
					testId="api-key-rotate-confirm"
					title={`Renew ${key.name} with a new secret?`}
					description={
						<>
							The key starting <span className="pk-mono-small">{key.prefix}</span> was
							last used {lastUsed === "Never used" ? "never" : lastUsed.toLowerCase()}.
							It gets a new secret and a fresh{" "}
							{periodLabel(key.periodDays).toLowerCase()} period, and its old secret
							stops working at once, so every tool that uses it needs the new one. Use
							this if the secret may have leaked.
						</>
					}
					confirmLabel="Renew with a new secret"
					destructive={false}
					pending={rotate.isPending}
					onConfirm={runRotate}
					returnFocusTo={() => document.getElementById(headingId)}
				>
					{rotate.error ? (
						<p className="pk-text-body m-0 text-status-error" role="alert">
							{errorText(rotate.error, "The key was not renewed. Try again.")}
						</p>
					) : null}
				</ConfirmDialog>
			</ConfirmDialogRoot>
			<ConfirmDialogRoot
				open={confirm === "revoke"}
				onOpenChange={(open) => !open && !revoke.isPending && setConfirm(null)}
			>
				<ConfirmDialog
					testId="api-key-revoke-confirm"
					title={`Revoke ${key.name}?`}
					description={
						<>
							Anything using the key starting{" "}
							<span className="pk-mono-small">{key.prefix}</span> stops working at once.
							A revoked key can never be renewed. This cannot be undone.
						</>
					}
					confirmLabel="Revoke key"
					pending={revoke.isPending}
					onConfirm={runRevoke}
					returnFocusTo={() => document.getElementById(headingId)}
				>
					{revoke.error ? (
						<p className="pk-text-body m-0 text-status-error" role="alert">
							{errorText(revoke.error, "The key was not revoked. Try again.")}
						</p>
					) : null}
				</ConfirmDialog>
			</ConfirmDialogRoot>
		</li>
	);
}
