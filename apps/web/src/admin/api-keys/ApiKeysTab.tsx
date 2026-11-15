import type { AdminApiKey } from "@portikus/contracts";
import {
	Badge,
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	Select,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import {
	expiryText,
	lastUsedText,
	SCOPE_TEXT,
	STATE_TEXT,
} from "../../settings/apiKeyText.js";
import { revealFocused } from "../../table/revealFocus.js";
import { plural } from "../../text.js";
import { AdminSection, focusAdminHeading } from "../AdminSection.js";
import {
	affectedCount,
	confirmText,
	type KeyTarget,
	type KeyVerb,
	keysOf,
	useAdminApiKeys,
	useKeyAction,
} from "./queries.js";
import "./api-keys.css";

const EVERYONE = "everyone";

/** The people who hold keys, once each, sorted by name. */
export function keyOwners(
	keys: readonly AdminApiKey[],
): { value: string; label: string }[] {
	const owners = new Map<string, string>();
	for (const key of keys) owners.set(key.owner.id, key.owner.displayName);
	return [...owners]
		.map(([value, label]) => ({ value, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** The action waiting on its confirm, and where focus goes after. */
interface Pending {
	verb: KeyVerb;
	target: KeyTarget;
	returnTo: string | null;
}

/**
 * The API keys tab (SPEC.md sections 24.8 and 24.13): every key on the site
 * with its owner, filtered by person, and expire or revoke for one key, one
 * person's keys, or every key. Expired keys can be renewed by their owners;
 * revoked keys cannot.
 */
export function ApiKeysTab() {
	const keys = useAdminApiKeys();
	const action = useKeyAction();
	const toast = useToast();
	const [person, setPerson] = useState(EVERYONE);
	const [pending, setPending] = useState<Pending | null>(null);
	const all = keys.data?.keys ?? [];
	const owners = keyOwners(all);
	const ownerName = owners.find((owner) => owner.value === person)?.label;
	// A filtered person whose keys are gone falls back to everyone.
	const filtered =
		ownerName === undefined ? all : all.filter((key) => key.owner.id === person);
	const personTarget: KeyTarget | null =
		ownerName === undefined
			? null
			: { kind: "person", userId: person, name: ownerName };

	function ask(verb: KeyVerb, target: KeyTarget, returnTo: string | null) {
		action.reset();
		setPending({ verb, target, returnTo });
	}

	const count = pending ? affectedCount(keysOf(all, pending.target), pending.verb) : 0;
	const words = pending ? confirmText(pending.verb, pending.target, count) : null;

	function run() {
		if (!pending || action.isPending) return;
		const { verb, target } = pending;
		action.mutate(
			{ verb, target },
			{
				onSuccess: ({ affected }) => {
					setPending(null);
					toast.show({
						tone: "success",
						title: `${plural(affected, "key")} ${verb === "expire" ? "expired" : "revoked"}`,
					});
				},
			},
		);
	}

	const totalActive = affectedCount(all, "expire");
	const totalLive = affectedCount(all, "revoke");

	return (
		<AdminSection
			title="API keys"
			intro={{
				id: "admin-api-keys",
				helpAnchor: "admin-api-keys",
				lead: "Keys that let tools such as Claude Code use Portikus as their owner.",
				text: "Expire a key to stop it until its owner signs in and renews it. Revoke a key that may have leaked: it stops for good.",
			}}
			count={keys.isSuccess ? plural(all.length, "key") : undefined}
			actions={
				<>
					<Button
						variant="secondary"
						data-testid="api-keys-expire-all"
						disabled={totalActive === 0}
						onClick={() => ask("expire", { kind: "all" }, null)}
					>
						Expire every key…
					</Button>
					<Button
						variant="danger-secondary"
						data-testid="api-keys-revoke-all"
						disabled={totalLive === 0}
						onClick={() => ask("revoke", { kind: "all" }, null)}
					>
						Revoke every key…
					</Button>
				</>
			}
		>
			{keys.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{errorText(keys.error, "API keys could not be loaded.")}
				</p>
			) : null}
			{keys.isSuccess && all.length === 0 ? (
				<EmptyState icon="lock" title="No API keys yet">
					Keys appear here when an administrator or instructor creates one in Settings.
				</EmptyState>
			) : null}
			{all.length > 0 ? (
				<>
					<div className="pk-keys-filter">
						<div className="w-64 max-w-full">
							<Select
								id="api-keys-person"
								label="Person"
								options={[{ value: EVERYONE, label: "Everyone" }, ...owners]}
								value={ownerName === undefined ? EVERYONE : person}
								onValueChange={setPerson}
							/>
						</div>
						{personTarget ? (
							<div className="pk-actions" data-testid="api-keys-person-actions">
								<Button
									variant="secondary"
									disabled={affectedCount(filtered, "expire") === 0}
									onClick={() => ask("expire", personTarget, "api-keys-person")}
								>
									Expire all of {ownerName}'s keys…
								</Button>
								<Button
									variant="danger-secondary"
									disabled={affectedCount(filtered, "revoke") === 0}
									onClick={() => ask("revoke", personTarget, "api-keys-person")}
								>
									Revoke all of {ownerName}'s keys…
								</Button>
							</div>
						) : null}
					</div>
					{/* A focusable region, so the keyboard can scroll a narrow table sideways (SPEC.md section 25.8). */}
					<section
						className="pk-table-wrap"
						aria-labelledby="api-keys-caption"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
						tabIndex={0}
						onFocus={revealFocused}
					>
						<table className="pk-table" data-testid="api-keys-table">
							<caption id="api-keys-caption" className="sr-only">
								API keys{ownerName ? ` held by ${ownerName}` : ""},{" "}
								{plural(filtered.length, "key")}
							</caption>
							<thead>
								<tr>
									<th scope="col">Owner</th>
									<th scope="col">Key</th>
									<th scope="col">Access</th>
									<th scope="col">State</th>
									<th scope="col">Expires</th>
									<th scope="col">Last used</th>
									<th scope="col">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((key) => (
									<KeyRow key={key.id} apiKey={key} onAsk={ask} />
								))}
							</tbody>
						</table>
					</section>
				</>
			) : null}
			<ConfirmDialogRoot
				open={pending !== null}
				onOpenChange={(open) => !open && !action.isPending && setPending(null)}
			>
				{pending && words ? (
					<ConfirmDialog
						testId="api-keys-confirm"
						title={words.title}
						description={words.description}
						confirmLabel={words.confirmLabel}
						destructive={pending.verb === "revoke"}
						disabled={count === 0}
						disabledReason={count === 0 ? "Nothing to change." : undefined}
						pending={action.isPending}
						onConfirm={run}
						returnFocusTo={() => {
							const back = pending.returnTo
								? document.getElementById(pending.returnTo)
								: null;
							if (back) return back;
							focusAdminHeading();
							return document.querySelector<HTMLElement>("[data-admin-heading]");
						}}
					>
						{action.error ? (
							<p className="pk-text-body m-0 text-status-error" role="alert">
								{errorText(action.error, "Nothing was changed. Try again.")}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminSection>
	);
}

function KeyRow({
	apiKey: key,
	onAsk,
}: {
	apiKey: AdminApiKey;
	onAsk: (verb: KeyVerb, target: KeyTarget, returnTo: string | null) => void;
}) {
	const state = STATE_TEXT[key.state];
	const nameId = `api-key-name-${key.id}`;
	const ownerId = `api-key-owner-${key.id}`;
	const described = `${nameId} ${ownerId}`;
	const target: KeyTarget = { kind: "key", key };
	return (
		<tr data-testid={`admin-api-key-${key.prefix}`} data-state={key.state}>
			<td>
				<span
					id={ownerId}
					className="block max-w-[24ch] truncate"
					title={key.owner.displayName}
				>
					{key.owner.displayName}
				</span>
			</td>
			<td>
				<span className="pk-cell-stack">
					<span
						id={nameId}
						tabIndex={-1}
						className="block max-w-[28ch] truncate outline-none"
						title={key.name}
					>
						{key.name}
					</span>
					<span className="pk-cell-secondary pk-mono-small">{key.prefix}</span>
				</span>
			</td>
			<td>{SCOPE_TEXT[key.scope].label}</td>
			<td>
				<Badge tone={state.tone}>{state.label}</Badge>
			</td>
			<td>{expiryText(key)}</td>
			<td>{lastUsedText(key.lastUsedAt, Date.now())}</td>
			<td className="pk-cell-actions">
				{key.state === "revoked" ? null : (
					<span className="pk-actions flex-nowrap justify-end">
						{key.state === "active" ? (
							<Button
								size="sm"
								variant="secondary"
								aria-describedby={described}
								onClick={() => onAsk("expire", target, nameId)}
							>
								Expire…
							</Button>
						) : null}
						<Button
							size="sm"
							variant="danger-secondary"
							aria-describedby={described}
							onClick={() => onAsk("revoke", target, nameId)}
						>
							Revoke…
						</Button>
					</span>
				)}
			</td>
		</tr>
	);
}
