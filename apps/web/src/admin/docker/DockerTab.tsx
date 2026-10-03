import type { DockerAdminResponse } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	Meter,
	Skeleton,
	TextField,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { type FormEvent, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { announced } from "../../common/announced.js";
import { AdminGroup, AdminSection } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { Notice } from "../Notice.js";
import {
	useClearCache,
	useDockerAdmin,
	useRemoveHubCredential,
	useSaveDockerSettings,
	useSetHubCredential,
} from "./queries.js";
import { SeedCard } from "./SeedCard.js";
import {
	autoClearBytes,
	CLEAR_REASON,
	cacheUseText,
	clearErrorText,
	credentialErrors,
} from "./text.js";
import { UsageCard } from "./UsageCard.js";

const INTRO = {
	id: "admin-docker",
	helpAnchor: "admin-docker",
	text: "Workspaces pull Docker Hub images through a cache on this server, so an image one student pulled comes from here for the next. New Docker storage starts with the seed images already in it. The use report shows what to add to the seed or drop from it.",
};

/** The Docker tab of the admin page. */
export function DockerTab() {
	const docker = useDockerAdmin();
	if (docker.isError) {
		const off = docker.error instanceof ApiError && docker.error.status === 404;
		return (
			<AdminSection title="Docker" intro={INTRO}>
				{off ? (
					<div className="pk-card" data-testid="docker-off">
						<EmptyState icon="info" title="The Docker cache is off on this site">
							This site was installed without the Docker pull cache, so workspaces pull
							straight from Docker Hub and start with empty Docker storage.
						</EmptyState>
					</div>
				) : (
					<p className="text-status-error" role="alert">
						{errorText(docker.error)}
					</p>
				)}
			</AdminSection>
		);
	}
	if (!docker.data) {
		return (
			<AdminSection title="Docker" intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="docker-loading">
					<Skeleton variant="block" height={140} />
					<Skeleton variant="block" height={240} />
				</div>
			</AdminSection>
		);
	}
	const data = docker.data;
	return (
		<AdminSection title="Docker" intro={INTRO}>
			{/* When the tab is wide, the two short cards stack beside the Hub account so no grid cell is left empty. The seed and use tables need the full width. */}
			<div
				className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,36rem),1fr))] items-start gap-4"
				data-testid="docker-settings"
			>
				<div className="grid content-start gap-4">
					<CacheCard data={data} />
					<GhcrCard data={data} />
				</div>
				<HubAccountCard data={data} />
			</div>
			<SeedCard data={data} />
			<UsageCard data={data} />
		</AdminSection>
	);
}

function CacheCard({ data }: { data: DockerAdminResponse }) {
	const clear = useClearCache();
	const toast = useToast();
	const [confirming, setConfirming] = useState(false);
	const cache = data.cache;
	const clearError = cache ? clearErrorText(cache) : null;
	const cacheOff = cache?.cacheOff ?? null;

	function confirm() {
		clear.mutate(undefined, {
			onSuccess: () => {
				toast.show({
					tone: "success",
					title: "Clearing the pull cache",
					children: "The space used updates within a minute.",
				});
				setConfirming(false);
			},
		});
	}

	return (
		<AdminGroup
			id="docker-cache-title"
			title="Pull cache"
			testId="docker-cache"
			help={
				<Toggletip label="the pull cache">
					Every workspace pulls Docker Hub images through it. It forgets an image a week
					after it was stored, and empties itself when it passes 90 percent full.
				</Toggletip>
			}
			actions={
				<Button
					data-testid="docker-cache-clear"
					aria-disabled={cacheOff ? true : undefined}
					aria-describedby={cacheOff ? "docker-cache-off" : undefined}
					onClick={() => {
						if (!cacheOff) setConfirming(true);
					}}
				>
					Clear cache…
				</Button>
			}
		>
			{cacheOff ? (
				<Notice tone="warning" id="docker-cache-off" testId="docker-cache-off">
					Setup turned the pull cache off, so there is nothing to clear. {cacheOff}{" "}
					Workspaces pull straight from Docker Hub and ghcr.io. To turn it back on, free
					space on the main disk and run <code>sudo dpkg-reconfigure portikus</code>.
				</Notice>
			) : cache ? (
				<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
					<dt className="pk-muted">Pull cache space</dt>
					<dd className="m-0 grid gap-1" data-testid="docker-cache-space">
						<Meter
							label="Pull cache space"
							value={cache.usedBytes}
							max={cache.sizeBytes}
							mark={autoClearBytes(cache)}
							valueText={cacheUseText(cache) ?? ""}
						/>
						<span className="pk-muted">
							The line marks 90 percent, where the cache empties itself.
						</span>
					</dd>
					<dt className="pk-muted">Docker Hub cache</dt>
					<dd className="m-0" data-testid="docker-cache-hub">
						{cache.hubUp ? (
							"Answering"
						) : (
							<span className="pk-tag pk-tag--error">Not answering</span>
						)}
					</dd>
					<dt className="pk-muted">Last cleared</dt>
					<dd className="m-0" data-testid="docker-cache-cleared">
						{cache.lastClearedAt
							? `${longTime(cache.lastClearedAt)}, ${
									cache.lastClearReason
										? CLEAR_REASON[cache.lastClearReason]
										: "reason unknown"
								}`
							: "Never"}
					</dd>
					<dt className="pk-muted">Checked</dt>
					<dd className="m-0">{longTime(cache.updatedAt)}</dd>
				</dl>
			) : (
				<p className="pk-muted m-0 text-[13px]" data-testid="docker-cache-unknown">
					The cache has not reported yet. It reports once a minute; if this stays, the
					cache is not running on the server.
				</p>
			)}
			{clearError ? (
				<Notice tone="warning" testId="docker-cache-clear-error">
					{clearError}
				</Notice>
			) : null}
			<ConfirmDialogRoot
				open={confirming}
				onOpenChange={(open) => {
					if (!open) {
						setConfirming(false);
						clear.reset();
					}
				}}
			>
				{confirming ? (
					<ConfirmDialog
						id="docker-cache-clear-confirm"
						testId="docker-cache-clear-dialog"
						title="Clear the pull cache?"
						description="Every cached image is deleted. The next pull of each image comes from Docker Hub again and counts against its rate limit. Images already in workspaces and in the seed stay."
						confirmLabel="Clear cache"
						pending={clear.isPending}
						onConfirm={confirm}
					>
						{clear.isError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{errorText(clear.error)}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminGroup>
	);
}

function HubAccountCard({ data }: { data: DockerAdminResponse }) {
	const set = useSetHubCredential();
	const remove = useRemoveHubCredential();
	const toast = useToast();
	const [username, setUsername] = useState("");
	const [token, setToken] = useState("");
	const [errors, setErrors] = useState<{
		username: string | null;
		token: string | null;
	}>({ username: null, token: null });
	const [removing, setRemoving] = useState(false);
	// Set only when the removal succeeded, so a cancel returns focus to the opener.
	const removed = useRef(false);
	// What was last sent, until the cache reports it applied.
	const [sent, setSent] = useState<"set" | "removed" | null>(null);
	const isSet = data.hubCredential.isSet;
	const waiting = sent !== null && isSet !== (sent === "set");
	// The helper still stores the change, but nothing uses or empties until the cache is back.
	const cacheOff = Boolean(data.cache?.cacheOff);

	function save(event: FormEvent) {
		event.preventDefault();
		const found = credentialErrors(username, token);
		setErrors(found);
		if (found.username || found.token) return;
		set.mutate(
			{ username, token },
			{
				onSuccess: () => {
					// The token is never kept, not even in the field.
					setUsername("");
					setToken("");
					setSent("set");
					toast.show(
						cacheOff
							? {
									tone: "success",
									title: "Docker Hub account saved",
									children:
										"The pull cache is off. It uses the account once setup turns the cache back on.",
								}
							: {
									tone: "success",
									title: "Docker Hub account sent to the cache",
									children:
										"The cache starts using it, and empties itself, within a minute.",
								},
					);
				},
			},
		);
	}

	function confirmRemove() {
		remove.mutate(undefined, {
			onSuccess: () => {
				removed.current = true;
				setSent("removed");
				setRemoving(false);
				toast.show({
					tone: "success",
					title: "Docker Hub account removed",
					...(cacheOff
						? { children: "The pull cache is off, so there was nothing to empty." }
						: {}),
				});
			},
		});
	}

	return (
		<AdminGroup
			id="docker-hub-title"
			title="Docker Hub account"
			testId="docker-hub"
			help={
				<Toggletip label="the Docker Hub account">
					Without an account the cache pulls anonymously, and Docker Hub limits how many
					anonymous pulls one server can make. An account raises that limit.
				</Toggletip>
			}
		>
			{/* One region, so the new state is announced when the cache applies it. */}
			<div role="status" className="grid gap-2">
				<p className="m-0 text-[13px]" data-testid="docker-hub-state">
					{isSet
						? "An account is set. The cache pulls from Docker Hub with it. Its token is never shown."
						: "No account is set. The cache pulls from Docker Hub anonymously."}
				</p>
				{waiting ? (
					<Notice tone="pending" testId="docker-hub-waiting">
						Waiting for the cache to apply the change.
					</Notice>
				) : null}
			</div>
			<form
				className="grid max-w-[28rem] gap-3"
				onSubmit={save}
				noValidate
				aria-label="Docker Hub account"
			>
				<Notice tone="warning" id="docker-hub-warning" testId="docker-hub-warning">
					Every student can pull any image this account can read, so use an account with
					no private repositories. Saving, replacing or removing the account empties the
					cache.
				</Notice>
				<TextField
					id="docker-hub-username"
					label="Docker Hub username"
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					value={username}
					error={announced(errors.username)}
					onChange={(event) => setUsername(event.target.value)}
				/>
				<TextField
					id="docker-hub-token"
					type="password"
					label="Access token"
					mono
					autoComplete="new-password"
					hint='A Docker Hub personal access token with the "Public Repo Read-only" scope. Make one under Account settings, Personal access tokens.'
					value={token}
					error={announced(errors.token)}
					onChange={(event) => setToken(event.target.value)}
				/>
				{set.isError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{errorText(set.error)}
					</p>
				) : null}
				<div className="pk-actions">
					<Button
						variant="primary"
						type="submit"
						data-testid="docker-hub-save"
						aria-describedby="docker-hub-warning"
						loading={set.isPending}
					>
						{isSet ? "Replace account" : "Save account"}
					</Button>
					{isSet ? (
						<Button
							data-testid="docker-hub-remove"
							onClick={() => {
								removed.current = false;
								setRemoving(true);
							}}
						>
							Remove account…
						</Button>
					) : null}
				</div>
			</form>
			<ConfirmDialogRoot
				open={removing}
				onOpenChange={(open) => {
					if (!open) {
						setRemoving(false);
						remove.reset();
					}
				}}
			>
				{removing ? (
					<ConfirmDialog
						id="docker-hub-remove-confirm"
						testId="docker-hub-remove-dialog"
						title="Remove the Docker Hub account?"
						description="The cache pulls from Docker Hub anonymously again, and it is emptied."
						confirmLabel="Remove account"
						pending={remove.isPending}
						onConfirm={confirmRemove}
						// After a removal the Remove button is gone; the heading keeps the place.
						returnFocusTo={() =>
							removed.current ? document.getElementById("docker-hub-title") : null
						}
					>
						{remove.isError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{errorText(remove.error)}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminGroup>
	);
}

function GhcrCard({ data }: { data: DockerAdminResponse }) {
	const save = useSaveDockerSettings();
	const toast = useToast();
	// Shows the new position while the save runs.
	const on = save.isPending
		? (save.variables?.ghcrEnabled ?? data.ghcrEnabled)
		: data.ghcrEnabled;
	const cache = data.cache;
	const waiting = cache !== null && cache.ghcrEnabled !== data.ghcrEnabled;

	function toggle(next: boolean) {
		if (save.isPending) return;
		save.mutate(
			{ ghcrEnabled: next },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: next ? "ghcr.io cache turned on" : "ghcr.io cache turned off",
					}),
			},
		);
	}

	return (
		<AdminGroup
			id="docker-ghcr-title"
			title="ghcr.io cache"
			testId="docker-ghcr"
			help={
				<Toggletip label="the ghcr.io cache">
					On by default. While it is on, workspaces cannot docker push to ghcr.io,
					cannot pull private ghcr.io images, and tools other than Docker that talk to
					ghcr.io, such as curl, gh and ORAS, do not work. Build and push images from
					GitHub Actions; pull them here. Turning it off reaches a running workspace
					only when it next starts; until then, ghcr.io in that workspace still goes
					through the cache.
				</Toggletip>
			}
		>
			<div className="grid gap-2">
				<label className="pk-switch text-[13px]">
					<input
						type="checkbox"
						role="switch"
						data-testid="docker-ghcr-switch"
						aria-checked={on}
						checked={on}
						aria-disabled={save.isPending || undefined}
						aria-describedby="docker-ghcr-warning"
						onChange={(event) => toggle(event.target.checked)}
					/>
					<span>Cache ghcr.io images</span>
				</label>
				{/* Always holds a line, so a change is announced and leaves no empty gap. */}
				<div role="status">
					{waiting ? (
						<Notice tone="pending" testId="docker-ghcr-waiting">
							Waiting for the cache to apply the change.
						</Notice>
					) : cache?.cacheOff ? (
						<p className="pk-muted m-0 text-[13px]" data-testid="docker-ghcr-state">
							The pull cache is off, so workspaces reach ghcr.io directly.
						</p>
					) : data.ghcrEnabled && cache && !cache.ghcrUp ? (
						<Notice tone="error" testId="docker-ghcr-down">
							The ghcr.io cache is not answering, so ghcr.io pulls in workspaces fail.
						</Notice>
					) : (
						<p className="pk-muted m-0 text-[13px]" data-testid="docker-ghcr-state">
							{!cache
								? "The cache has not reported yet."
								: data.ghcrEnabled
									? "The ghcr.io cache is on and answering."
									: "The ghcr.io cache is off. Workspaces reach ghcr.io directly."}
						</p>
					)}
				</div>
			</div>
			{save.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(save.error)}
				</p>
			) : null}
			<p id="docker-ghcr-warning" className="m-0 text-[13px]">
				While on, workspaces cannot push to ghcr.io.
			</p>
		</AdminGroup>
	);
}
