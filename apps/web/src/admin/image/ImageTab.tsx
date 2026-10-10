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
	Meter,
	Select,
	Skeleton,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { formatBytes, WARN_AT } from "../../monitor/format.js";
import { AdminSection, AdminGroup as Group } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { JobLog } from "../JobLog.js";
import { PackagesSection } from "./PackagesSection.js";
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
	text: "The image every new workspace starts from. Update it to the newest published image, or rebuild it with current packages and a chosen Node and Python. A new image must pass its health check before you make it the default. Existing workspaces keep their image until you rebuild each one. Packages students add shows what they install most, so you can decide what belongs in the image.",
};

const NODE_LABEL: Record<ImageNodeChoice, string> = {
	"24": "Node 24",
	"26": "Node 26",
};

const PYTHON_LABEL: Record<ImagePythonChoice, string> = {
	debian: "Debian's Python 3.13",
	"uv-3.14": "Debian's plus Python 3.14 from uv",
};

const KIND_LABEL: Record<NonNullable<ImageJobView["kind"]>, string> = {
	fetch: "Update to the latest published image",
	build: "Rebuild with latest packages",
	activate: "Make default",
	rollback: "Roll back",
	delete: "Delete an image",
	"agents-update": "Update coding agents",
	"agents-rollback": "Roll back coding agent",
};

const STATE_LABEL: Record<ImageJobView["state"], string> = {
	queued: "Waiting to start",
	running: "Running",
	succeeded: "Finished",
	failed: "Failed",
	refused: "Refused",
};

const BUSY_REASON = "An image job is waiting or running. Wait until it finishes.";

/** The Workspace image tab of the admin page (docs/SPEC.md section 22.4; ADR 0030). */
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
				{/* The survey has its own route, and still guides an image built by hand on the host. */}
				<PackagesSection />
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
				<PackagesSection />
			</AdminSection>
		);
	}
	return <ImageSections data={image.data} />;
}

type Confirming =
	| { kind: "activate"; version: string }
	| { kind: "rollback" }
	| { kind: "fetch" }
	| { kind: "delete"; version: string; workspaces: number; sizeBytes: number | null };

function ImageSections({ data }: { data: AdminImage }) {
	const toast = useToast();
	const ask = useRequestImageJob();
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	// Make default, Fetch (the newer-image notice) and Delete unmount their own button, so a confirmed one sends focus to the job heading.
	const toJob = useRef(false);
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
			{data.newerPublished ? (
				// The daily check found it; it clears once that version is on the server.
				<div
					className="pk-card flex flex-wrap items-center gap-3 p-4"
					data-testid="image-newer-published"
				>
					<p className="m-0 flex-1">
						Image <strong className="pk-mono-small">{data.newerPublished}</strong> is
						published and not yet on this server.
					</p>
					<Button
						variant="primary"
						data-testid="image-newer-fetch"
						aria-disabled={busy ? true : undefined}
						aria-describedby={busy ? "image-busy-note" : undefined}
						onClick={() => (busy ? undefined : setConfirming({ kind: "fetch" }))}
					>
						Update to {data.newerPublished}
					</Button>
				</div>
			) : null}
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
				onDelete={(image) =>
					setConfirming({
						kind: "delete",
						version: image.version,
						workspaces: image.workspaces,
						sizeBytes: image.sizeBytes,
					})
				}
			/>

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open ? undefined : setConfirming(null))}
			>
				{confirming ? (
					<ConfirmDialog
						id="image-confirm"
						testId="image-confirm"
						destructive={confirming.kind === "delete"}
						title={confirmTitle(confirming, data)}
						description={confirmText(confirming)}
						confirmLabel={confirmLabel(confirming)}
						pending={ask.isPending}
						returnFocusTo={() => {
							const made = toJob.current;
							toJob.current = false;
							if (!made) return null;
							// The job heading renders once the refetch lands; the current heading always exists.
							return (
								document.getElementById("image-job-title") ??
								document.getElementById("image-current-title")
							);
						}}
						onConfirm={() =>
							submit(requestOf(confirming), () => {
								// A deleted row takes its Delete button with it, so focus goes to the job too.
								toJob.current = confirming.kind !== "rollback";
								setConfirming(null);
							})
						}
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
						<DiffView from={data.default} to={diffOf} heading="h3" />
					</Dialog>
				) : null}
			</DialogRoot>
			<PackagesSection />
		</AdminSection>
	);
}

function requestOf(c: Confirming): ImageJobRequest {
	return c.kind === "delete" ? { kind: "delete", version: c.version } : c;
}

function confirmTitle(c: Confirming, data: AdminImage): string {
	if (c.kind === "delete") return `Delete image ${c.version}?`;
	if (c.kind === "fetch") return "Update to the latest published image?";
	if (c.kind === "rollback") return `Roll back to ${data.previous}?`;
	return `Make ${c.version} the default image?`;
}

function confirmText(c: Confirming): string {
	if (c.kind === "delete") {
		const made =
			c.workspaces === 0
				? "No workspaces were made from this image."
				: `${c.workspaces === 1 ? "1 workspace was" : `${c.workspaces} workspaces were`} made from this image. They keep working, because each has its own copy of its disk.`;
		const frees =
			c.sizeBytes === null
				? "Deleting it frees its space on the main disk."
				: `Deleting it frees about ${formatBytes(c.sizeBytes)} on the main disk.`;
		return `${made} ${frees} To use it again, update or rebuild.`;
	}
	if (c.kind === "fetch") {
		return "The host downloads the newest published image, checks its signature, imports it and runs its health check. Nothing changes for workspaces until you make it the default.";
	}
	return "New workspaces start from this image. Existing workspaces keep the image they have until you rebuild each one. The current default is kept as the previous image.";
}

function confirmLabel(c: Confirming): string {
	if (c.kind === "delete") return "Delete image";
	if (c.kind === "fetch") return "Update";
	if (c.kind === "rollback") return "Roll back";
	return "Make default";
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
			<dd className="pk-mono-small m-0 self-center" data-testid="image-default">
				{data.default ?? "None"}
			</dd>
			<dt className="pk-muted flex items-center gap-1">
				Previous
				<Toggletip label="the previous image">
					The image that was the default before this one. Roll back makes it the default
					again.
				</Toggletip>
			</dt>
			<dd className="pk-mono-small m-0 self-center" data-testid="image-previous">
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
	if (job.kind === "delete" && job.version) return `Delete ${job.version}`;
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
				: "pk-tag border-transparent bg-status-starting-soft text-status-starting";
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
						{shown.message &&
						(shown.state === "failed" || shown.state === "refused") ? (
							<span className="sr-only">. {shown.message}</span>
						) : null}
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
				{/* jscpd:ignore-start -- the certificate and image job panels list different facts. */}
				{shown.startedAt ? (
					<>
						<dt className="pk-muted">Started</dt>
						<dd className="m-0">{longTime(shown.startedAt)}</dd>
					</>
				) : null}
				{/* jscpd:ignore-end */}
			</dl>
			<JobLog idPrefix="image" log={log} />
			{made && defaultVersion ? (
				<div className="grid gap-3" data-testid="image-job-result">
					<h4 className="pk-text-compact m-0 font-semibold text-ink-muted">
						Changes in {made.version} against {defaultVersion}
					</h4>
					<DiffView from={defaultVersion} to={made.version} heading="h5" />
					<div>
						<MakeDefaultButton image={made} busy={busy} onMakeDefault={onMakeDefault} />
					</div>
				</div>
			) : null}
		</Group>
	);
}

/** Why Make default is off for this image alone, or null; a busy job is said once, above. */
function makeDefaultOff(image: ImageView): string | null {
	if (image.role === "default") return "This is the default image.";
	if (!image.health) return "This image has not been health-checked.";
	if (image.health.result !== "passed") return "This image failed its health check.";
	return null;
}

/** Why Delete is off for this image alone, or null. The root job refuses the same two. */
function deleteOff(image: ImageView): string | null {
	if (image.role === "default") return "The default image is never deleted.";
	if (image.role === "previous") return "Kept so you can roll back.";
	return null;
}

/**
 * A row action that is off for a reason of its own, shown under it, or off
 * while a job runs, pointing at the one busy note above the list.
 */
function RowAction({
	label,
	ariaLabel,
	testId,
	primary,
	reason,
	busy,
	onPress,
}: {
	label: string;
	ariaLabel: string;
	testId: string;
	primary?: boolean;
	reason: string | null;
	busy: boolean;
	onPress: () => void;
}) {
	const noteId = `${testId}-note`;
	const off = reason !== null || busy;
	return (
		<span className="inline-flex flex-col items-start gap-1">
			<Button
				variant={primary ? "primary" : "secondary"}
				data-testid={testId}
				aria-label={ariaLabel}
				aria-disabled={off ? true : undefined}
				aria-describedby={reason ? noteId : busy ? "image-busy-note" : undefined}
				onClick={() => (off ? undefined : onPress())}
			>
				{label}
			</Button>
			{reason ? (
				<span id={noteId} className="pk-muted text-[12px]">
					{reason}
				</span>
			) : null}
		</span>
	);
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
	return (
		<RowAction
			primary
			label="Make default"
			ariaLabel={`Make default: ${image.version}`}
			testId={`image-make-default-${image.version}`}
			reason={makeDefaultOff(image)}
			busy={busy}
			onPress={() => onMakeDefault(image.version)}
		/>
	);
}

function DeleteButton({
	image,
	busy,
	onDelete,
}: {
	image: ImageView;
	busy: boolean;
	onDelete: (image: ImageView) => void;
}) {
	return (
		<RowAction
			label="Delete"
			ariaLabel={`Delete: ${image.version}`}
			testId={`image-delete-${image.version}`}
			reason={deleteOff(image)}
			busy={busy}
			onPress={() => onDelete(image)}
		/>
	);
}

/** The main disk turns to the warning colour from this share used (DESIGN.md, status colour). */

/** The main disk's space, in the meter style of the Docker tab. */
function DiskSpace({ disk }: { disk: NonNullable<AdminImage["disk"]> }) {
	const used = Math.max(disk.totalBytes - disk.freeBytes, 0);
	return (
		<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
			<dt className="pk-muted">Main disk space</dt>
			<dd className="m-0" data-testid="image-disk-free">
				<Meter
					label="Main disk space"
					value={used}
					max={disk.totalBytes}
					high={disk.totalBytes * WARN_AT}
					valueText={`${formatBytes(used)} of ${formatBytes(disk.totalBytes)} used, ${formatBytes(disk.freeBytes)} free`}
				/>
			</dd>
		</dl>
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
	onDelete,
}: {
	data: AdminImage;
	busy: boolean;
	onDiff: (version: string) => void;
	onMakeDefault: (version: string) => void;
	onDelete: (image: ImageView) => void;
}) {
	return (
		<Group
			id="image-list-title"
			title="Images on this host"
			testId="image-list"
			help={
				<Toggletip label="images on this host">
					After each update or rebuild, the host keeps the default, the previous image
					and the new image, and deletes the rest. You can also delete an image
					yourself. A workspace never needs its image to still exist.
				</Toggletip>
			}
		>
			{data.disk ? <DiskSpace disk={data.disk} /> : null}
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
								<th scope="col">Image size (compressed)</th>
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
										<th scope="row" className="pk-mono-small">
											{image.version}
										</th>
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
										<td data-testid={`image-size-${image.version}`}>
											{image.sizeBytes === null ? (
												<>
													<span aria-hidden={true}>—</span>
													<span className="sr-only">Not measured yet</span>
												</>
											) : (
												formatBytes(image.sizeBytes)
											)}
										</td>
										<td>
											{image.role === "default" ? (
												<DeleteButton image={image} busy={busy} onDelete={onDelete} />
											) : (
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
													<DeleteButton image={image} busy={busy} onDelete={onDelete} />
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

/** heading is the level of Tools and Packages under wherever the diff is shown. */
function DiffView({
	from,
	to,
	heading,
}: {
	from: string;
	to: string;
	heading: "h3" | "h5";
}) {
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
			<DiffPart
				title="Tools"
				heading={heading}
				part={diff.data.tools}
				testId="image-diff-tools"
			/>
			<DiffPart
				title="Packages"
				heading={heading}
				part={diff.data.packages}
				testId="image-diff-packages"
			/>
		</div>
	);
}

function DiffPart({
	title,
	heading: Heading,
	part,
	testId,
}: {
	title: string;
	heading: "h3" | "h5";
	part: ImageDiff["tools"];
	testId: string;
}) {
	const none = part.added.length + part.removed.length + part.changed.length === 0;
	return (
		<div data-testid={testId}>
			<Heading className="m-0 mb-1 text-[13px] font-semibold">{title}</Heading>
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
		</div>
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
