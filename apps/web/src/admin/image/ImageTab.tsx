import type {
	AdminImage,
	ImageDiff,
	ImageJobRequest,
	ImageJobView,
	ImageNodeChoice,
	ImagePythonChoice,
	ImageView,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	EmptyState,
	Select,
	Skeleton,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { type ReactNode, useState } from "react";
import { ApiError } from "../../api/request.js";
import { AdminSection } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { errorText } from "../SettingsTab.js";
import {
	isActive,
	useAdminImage,
	useImageDiff,
	useImageJob,
	useRequestImageJob,
} from "./queries.js";

const INTRO = {
	id: "admin-image",
	helpAnchor: "admin-image",
	text: "The image every new workspace starts from. Update it to the newest published image, or rebuild it with current packages and a chosen Node and Python. A new image must pass its health check before you make it the default. Existing workspaces keep their image until you rebuild each one.",
};

export const NODE_LABEL: Record<ImageNodeChoice, string> = {
	"24": "Node 24",
	"26": "Node 26",
};

export const PYTHON_LABEL: Record<ImagePythonChoice, string> = {
	debian: "Debian's Python 3.13",
	"uv-3.14": "Debian's plus Python 3.14 from uv",
};

const KIND_LABEL: Record<NonNullable<ImageJobView["kind"]>, string> = {
	fetch: "Update to the latest published image",
	build: "Rebuild with latest packages",
	activate: "Make default",
	rollback: "Roll back",
};

const STATE_LABEL: Record<ImageJobView["state"], string> = {
	queued: "Waiting to start",
	running: "Running",
	succeeded: "Finished",
	failed: "Failed",
	refused: "Refused",
};

const BUSY_REASON = "An image job is waiting or running. Wait until it finishes.";

/** The Workspace image tab of the admin page (docs/EPIC-15.md rulings 22 to 28; ADR 0030). */
export function ImageTab() {
	const image = useAdminImage();
	if (image.isError) {
		const off = image.error instanceof ApiError && image.error.status === 404;
		return (
			<AdminSection title="Workspace image" intro={INTRO}>
				{off ? (
					<div className="pk-card" data-testid="image-off">
						<EmptyState icon="info" title="Image management is off on this site">
							This site was installed without the image job, so the workspace image is
							managed on the host instead.
						</EmptyState>
					</div>
				) : (
					<p className="text-status-error" role="alert">
						{errorText(image.error)}
					</p>
				)}
			</AdminSection>
		);
	}
	if (!image.data) {
		return (
			<AdminSection title="Workspace image" intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="image-loading">
					<Skeleton variant="block" height={160} />
					<Skeleton variant="block" height={200} />
				</div>
			</AdminSection>
		);
	}
	return <ImageSections data={image.data} />;
}

type Confirming =
	| { kind: "activate"; version: string }
	| { kind: "rollback" }
	| { kind: "fetch" };

function ImageSections({ data }: { data: AdminImage }) {
	const toast = useToast();
	const ask = useRequestImageJob();
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	const [rebuilding, setRebuilding] = useState(false);
	const [diffOf, setDiffOf] = useState<string | null>(null);
	const busy = isActive(data.job?.state);
	const defaultImage = data.images.find((i) => i.role === "default") ?? null;

	function submit(body: ImageJobRequest, done: () => void) {
		ask.mutate(body, {
			onSuccess: () => {
				toast.show({ tone: "success", title: "Image job requested" });
				done();
			},
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "Could not start the image job",
					children: errorText(error),
				}),
		});
	}

	return (
		<AdminSection title="Workspace image" intro={INTRO}>
			<Group
				id="image-current-title"
				title="Current image"
				testId="image-current"
				actions={
					<div className="flex flex-wrap gap-2">
						<Button
							variant="primary"
							data-testid="image-fetch"
							aria-disabled={busy ? true : undefined}
							aria-describedby={busy ? "image-busy-note" : undefined}
							onClick={() => (busy ? undefined : setConfirming({ kind: "fetch" }))}
						>
							Update to latest published
						</Button>
						<Button
							data-testid="image-rebuild"
							aria-disabled={busy ? true : undefined}
							aria-describedby={busy ? "image-busy-note" : undefined}
							onClick={() => (busy ? undefined : setRebuilding(true))}
						>
							Rebuild with latest packages
						</Button>
						<Button
							data-testid="image-rollback"
							aria-disabled={busy || !data.previous ? true : undefined}
							aria-describedby={
								busy
									? "image-busy-note"
									: !data.previous
										? "image-no-previous"
										: undefined
							}
							onClick={() =>
								busy || !data.previous ? undefined : setConfirming({ kind: "rollback" })
							}
						>
							Roll back
						</Button>
					</div>
				}
			>
				{busy ? (
					<p id="image-busy-note" className="pk-muted m-0 text-[13px]">
						{BUSY_REASON}
					</p>
				) : null}
				{!data.previous ? (
					<p id="image-no-previous" className="pk-muted m-0 text-[13px]">
						There is no previous image to roll back to.
					</p>
				) : null}
				<CurrentList data={data} defaultImage={defaultImage} />
			</Group>

			{data.job ? (
				<JobGroup
					job={data.job}
					images={data.images}
					defaultVersion={data.default}
					busy={busy}
					onMakeDefault={(version) => setConfirming({ kind: "activate", version })}
				/>
			) : null}

			<ImagesGroup
				data={data}
				busy={busy}
				onDiff={setDiffOf}
				onMakeDefault={(version) => setConfirming({ kind: "activate", version })}
			/>

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open ? undefined : setConfirming(null))}
			>
				{confirming ? (
					<ConfirmDialog
						id="image-confirm"
						testId="image-confirm"
						destructive={false}
						title={confirmTitle(confirming, data)}
						description={confirmText(confirming)}
						confirmLabel={confirmLabel(confirming)}
						pending={ask.isPending}
						onConfirm={() => submit(confirming, () => setConfirming(null))}
					/>
				) : null}
			</ConfirmDialogRoot>

			<RebuildDialog
				open={rebuilding}
				pending={ask.isPending}
				current={defaultImage}
				onClose={() => setRebuilding(false)}
				onConfirm={(node, python) =>
					submit({ kind: "build", node, python }, () => setRebuilding(false))
				}
			/>

			<DialogRoot
				open={diffOf !== null}
				onOpenChange={(open) => (open ? undefined : setDiffOf(null))}
			>
				{diffOf && data.default ? (
					<Dialog
						testId="image-diff-dialog"
						size="lg"
						title={`Changes in ${diffOf}`}
						description={`Compared with the default image, ${data.default}.`}
						footer={<Button onClick={() => setDiffOf(null)}>Close</Button>}
					>
						<DiffView from={data.default} to={diffOf} />
					</Dialog>
				) : null}
			</DialogRoot>
		</AdminSection>
	);
}

function confirmTitle(c: Confirming, data: AdminImage): string {
	if (c.kind === "fetch") return "Update to the latest published image?";
	if (c.kind === "rollback") return `Roll back to ${data.previous}?`;
	return `Make ${c.version} the default image?`;
}

function confirmText(c: Confirming): string {
	if (c.kind === "fetch") {
		return "The host downloads the newest published image, checks its signature, imports it and runs its health check. Nothing changes for workspaces until you make it the default.";
	}
	return "New workspaces start from this image. Existing workspaces keep the image they have until you rebuild each one. The current default is kept as the previous image.";
}

function confirmLabel(c: Confirming): string {
	if (c.kind === "fetch") return "Update";
	if (c.kind === "rollback") return "Roll back";
	return "Make default";
}

/** One of the page's h3 groups, drawn as a card, as on the Backups tab. */
function Group({
	id,
	title,
	help,
	actions,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section
			className="pk-card @container grid gap-5 p-6"
			aria-labelledby={id}
			data-testid={testId}
		>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 items-center gap-1">
					<h3 className="pk-text-heading m-0" id={id} tabIndex={-1}>
						{title}
					</h3>
					{help}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

function toolsText(image: ImageView | null): { node: string; python: string } {
	const m = image?.manifest;
	if (!m) return { node: "Unknown", python: "Unknown" };
	return {
		node: `${m.tools.node ?? "missing"} (${NODE_LABEL[m.parameters.node]})`,
		python: `${m.tools.python3 ?? "missing"} (${PYTHON_LABEL[m.parameters.python]})`,
	};
}

function CurrentList({
	data,
	defaultImage,
}: {
	data: AdminImage;
	defaultImage: ImageView | null;
}) {
	const tools = toolsText(defaultImage);
	return (
		<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] @3xl:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
			<dt className="pk-muted">Default</dt>
			<dd className="m-0" data-testid="image-default">
				{data.default ?? "None"}
			</dd>
			<dt className="pk-muted flex items-center gap-1">
				Previous
				<Toggletip label="the previous image">
					The image that was the default before this one. Roll back makes it the default
					again.
				</Toggletip>
			</dt>
			<dd className="m-0" data-testid="image-previous">
				{data.previous ?? "None"}
			</dd>
			<dt className="pk-muted">Node</dt>
			<dd className="m-0">{tools.node}</dd>
			<dt className="pk-muted">Python</dt>
			<dd className="m-0">{tools.python}</dd>
			<dt className="pk-muted">Built</dt>
			<dd className="m-0">
				{defaultImage?.manifest
					? `${longTime(defaultImage.manifest.builtAt)}, ${defaultImage.manifest.source === "local" ? "on this host" : "published"}`
					: "Unknown"}
			</dd>
			<dt className="pk-muted">Workspaces on it</dt>
			<dd className="m-0" data-testid="image-default-workspaces">
				{defaultImage?.workspaces ?? 0}
			</dd>
		</dl>
	);
}

function jobTitle(job: ImageJobView): string {
	const request = job.request;
	if (request?.kind === "build") {
		return `${KIND_LABEL.build}: ${NODE_LABEL[request.node]}, ${PYTHON_LABEL[request.python]}`;
	}
	if (job.kind === "activate" && job.version) return `Make ${job.version} the default`;
	return job.kind ? KIND_LABEL[job.kind] : "Unknown request";
}

function JobGroup({
	job,
	images,
	defaultVersion,
	busy,
	onMakeDefault,
}: {
	job: ImageJobView;
	images: ImageView[];
	defaultVersion: string | null;
	busy: boolean;
	onMakeDefault: (version: string) => void;
}) {
	const detail = useImageJob(job.id);
	const shown = detail.data?.job ?? job;
	const log = detail.data?.log ?? [];
	// A finished fetch or build leaves a new candidate: show its changes and offer Make default.
	const made =
		shown.state === "succeeded" && (shown.kind === "fetch" || shown.kind === "build")
			? images.find((i) => i.version === shown.version && i.role === "candidate")
			: undefined;
	const tone =
		shown.state === "failed" || shown.state === "refused"
			? "pk-tag pk-tag--error"
			: shown.state === "succeeded"
				? "pk-tag"
				: "pk-tag pk-tag--warning";
	return (
		<Group id="image-job-title" title="Latest job" testId="image-job">
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Job</dt>
				<dd className="m-0" data-testid="image-job-kind">
					{jobTitle(shown)}
				</dd>
				<dt className="pk-muted">State</dt>
				<dd className="m-0">
					<span role="status" data-testid="image-job-state">
						<span className={tone}>{STATE_LABEL[shown.state]}</span> {shown.step}
					</span>
				</dd>
				{shown.message ? (
					<>
						<dt className="pk-muted">Reason</dt>
						<dd
							className="m-0 [overflow-wrap:anywhere]"
							data-testid="image-job-message"
						>
							{shown.message}
						</dd>
					</>
				) : null}
				{shown.startedAt ? (
					<>
						<dt className="pk-muted">Started</dt>
						<dd className="m-0">{longTime(shown.startedAt)}</dd>
					</>
				) : null}
			</dl>
			<div className="grid gap-2">
				<h4
					className="pk-text-compact m-0 font-semibold text-ink-muted"
					id="image-log-title"
				>
					Log
				</h4>
				{/* A focusable region, so a keyboard user can scroll it (SPEC.md section 25.8).
				    Plain text in <pre>: a log line is never rendered as HTML. */}
				<section
					className="max-h-80 overflow-auto"
					data-testid="image-job-log"
					aria-labelledby="image-log-title"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
					tabIndex={0}
				>
					<pre className="pk-techdetail m-0 whitespace-pre-wrap break-all">
						{log.length > 0 ? log.join("\n") : "No output yet."}
					</pre>
				</section>
			</div>
			{made && defaultVersion ? (
				<div className="grid gap-3" data-testid="image-job-result">
					<h4 className="pk-text-compact m-0 font-semibold text-ink-muted">
						Changes in {made.version} against {defaultVersion}
					</h4>
					<DiffView from={defaultVersion} to={made.version} />
					<div>
						<MakeDefaultButton image={made} busy={busy} onMakeDefault={onMakeDefault} />
					</div>
				</div>
			) : null}
		</Group>
	);
}

/** Why Make default is off for this image, or null when it may be pressed. */
function makeDefaultOff(image: ImageView, busy: boolean): string | null {
	if (image.role === "default") return "This is the default image.";
	if (busy) return BUSY_REASON;
	if (!image.health) return "This image has not been health-checked.";
	if (image.health.result !== "passed") return "This image failed its health check.";
	return null;
}

function MakeDefaultButton({
	image,
	busy,
	onMakeDefault,
}: {
	image: ImageView;
	busy: boolean;
	onMakeDefault: (version: string) => void;
}) {
	const off = makeDefaultOff(image, busy);
	const noteId = `image-make-default-note-${image.version}`;
	return (
		<span className="inline-flex flex-col gap-1">
			<Button
				variant="primary"
				data-testid={`image-make-default-${image.version}`}
				aria-disabled={off ? true : undefined}
				aria-describedby={off ? noteId : undefined}
				onClick={() => (off ? undefined : onMakeDefault(image.version))}
			>
				Make default
			</Button>
			{off ? (
				<span id={noteId} className="pk-muted text-[12px]">
					{off}
				</span>
			) : null}
		</span>
	);
}

const ROLE_LABEL: Record<ImageView["role"], string> = {
	default: "Default",
	previous: "Previous",
	candidate: "New",
};

function ImagesGroup({
	data,
	busy,
	onDiff,
	onMakeDefault,
}: {
	data: AdminImage;
	busy: boolean;
	onDiff: (version: string) => void;
	onMakeDefault: (version: string) => void;
}) {
	return (
		<Group
			id="image-list-title"
			title="Images on this host"
			testId="image-list"
			help={
				<Toggletip label="images on this host">
					After each update or rebuild, the host keeps the default, the previous image
					and the two newest others, and deletes the rest. A workspace never needs its
					image to still exist.
				</Toggletip>
			}
		>
			{data.images.length === 0 ? (
				<p className="pk-muted m-0 text-[13px]">No images yet.</p>
			) : (
				<div className="pk-table-wrap">
					<table className="pk-table" data-testid="image-table">
						<caption className="sr-only">Workspace images on this host</caption>
						<thead>
							<tr>
								<th scope="col">Version</th>
								<th scope="col">Role</th>
								<th scope="col">Node and Python</th>
								<th scope="col">
									<span className="inline-flex items-center gap-1">
										Health
										<Toggletip label="the health check">
											The host starts a throwaway workspace from the image and checks
											that node, python3, git, docker, claude and codex run. Only an
											image that passed can become the default.
										</Toggletip>
									</span>
								</th>
								<th scope="col">Workspaces</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{data.images.map((image) => {
								const tools = toolsText(image);
								return (
									<tr key={image.version} data-testid={`image-row-${image.version}`}>
										<th scope="row">{image.version}</th>
										<td>{ROLE_LABEL[image.role]}</td>
										<td>
											{tools.node}
											<br />
											{tools.python}
										</td>
										<td data-testid={`image-health-${image.version}`}>
											{image.health ? (
												image.health.result === "passed" ? (
													"Passed"
												) : (
													<span className="pk-tag pk-tag--error">Failed</span>
												)
											) : (
												"Not checked"
											)}
										</td>
										<td data-testid={`image-workspaces-${image.version}`}>
											{image.workspaces}
										</td>
										<td>
											{image.role === "default" ? null : (
												<div className="flex flex-wrap items-start gap-2">
													{data.default ? (
														<Button
															data-testid={`image-diff-${image.version}`}
															aria-label={`Show changes in ${image.version}`}
															onClick={() => onDiff(image.version)}
														>
															Show changes
														</Button>
													) : null}
													<MakeDefaultButton
														image={image}
														busy={busy}
														onMakeDefault={onMakeDefault}
													/>
												</div>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{data.otherWorkspaces > 0 ? (
				<p className="pk-muted m-0 text-[13px]" data-testid="image-other-workspaces">
					{data.otherWorkspaces} workspace{data.otherWorkspaces === 1 ? "" : "s"} run
					{data.otherWorkspaces === 1 ? "s" : ""} an older image no longer on this host.
					Rebuild a workspace to move it to the default image.
				</p>
			) : null}
		</Group>
	);
}

function DiffView({ from, to }: { from: string; to: string }) {
	const diff = useImageDiff(from, to);
	if (diff.isError) {
		return (
			<p className="text-status-error m-0 text-[13px]" role="alert">
				{errorText(diff.error)}
			</p>
		);
	}
	if (!diff.data) return <Skeleton variant="block" height={80} />;
	return (
		<div className="grid gap-4 text-[13px]" data-testid="image-diff">
			<DiffPart title="Tools" part={diff.data.tools} testId="image-diff-tools" />
			<DiffPart
				title="Packages"
				part={diff.data.packages}
				testId="image-diff-packages"
			/>
		</div>
	);
}

function DiffPart({
	title,
	part,
	testId,
}: {
	title: string;
	part: ImageDiff["tools"];
	testId: string;
}) {
	const none = part.added.length + part.removed.length + part.changed.length === 0;
	return (
		<section aria-label={title} data-testid={testId}>
			<p className="m-0 mb-1 font-semibold">{title}</p>
			{none ? (
				<p className="pk-muted m-0">No changes.</p>
			) : (
				<ul className="m-0 grid list-none gap-1 p-0">
					{part.changed.map((c) => (
						<li key={`c-${c.name}`}>
							Changed <strong>{c.name}</strong>: {c.from} to {c.to}
						</li>
					))}
					{part.added.map((a) => (
						<li key={`a-${a.name}`}>
							Added <strong>{a.name}</strong> {a.version}
						</li>
					))}
					{part.removed.map((r) => (
						<li key={`r-${r.name}`}>
							Removed <strong>{r.name}</strong> {r.version}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function RebuildDialog({
	open,
	pending,
	current,
	onClose,
	onConfirm,
}: {
	open: boolean;
	pending: boolean;
	current: ImageView | null;
	onClose: () => void;
	onConfirm: (node: ImageNodeChoice, python: ImagePythonChoice) => void;
}) {
	const [node, setNode] = useState<ImageNodeChoice>(
		current?.manifest?.parameters.node ?? "24",
	);
	const [python, setPython] = useState<ImagePythonChoice>(
		current?.manifest?.parameters.python ?? "debian",
	);
	return (
		<DialogRoot open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			{open ? (
				<Dialog
					testId="image-rebuild-dialog"
					title="Rebuild with latest packages"
					description="The host builds a new image from the same recipe with today's Debian packages and the latest Claude Code and Codex. It takes about 20 minutes. Nothing changes for workspaces until you make it the default."
					footer={
						<>
							<Button onClick={onClose}>Cancel</Button>
							<Button
								variant="primary"
								data-testid="image-rebuild-confirm"
								loading={pending}
								onClick={() => onConfirm(node, python)}
							>
								Rebuild
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-3">
						<Select
							id="image-rebuild-node"
							label="Node"
							value={node}
							onValueChange={(v) => setNode(v as ImageNodeChoice)}
							options={(["24", "26"] as const).map((v) => ({
								value: v,
								label: NODE_LABEL[v],
							}))}
						/>
						<Select
							id="image-rebuild-python"
							label="Python"
							value={python}
							onValueChange={(v) => setPython(v as ImagePythonChoice)}
							options={(["debian", "uv-3.14"] as const).map((v) => ({
								value: v,
								label: PYTHON_LABEL[v],
							}))}
						/>
					</div>
				</Dialog>
			) : null}
		</DialogRoot>
	);
}
