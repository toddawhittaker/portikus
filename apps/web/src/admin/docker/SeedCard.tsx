import {
	type DockerAdminResponse,
	overSeedCap,
	SEED_IMAGES_MAX,
	type SeedJob,
	seedDrift,
} from "@portikus/contracts";
import { Button, Meter, TextField, Toggletip, useToast } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { errorText } from "../../api/request.js";
import { announced } from "../../common/announced.js";
import { WARN_AT } from "../../monitor/format.js";
import { AdminGroup } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { useAdminImage } from "../image/queries.js";
import { DownloadSize } from "./DownloadSize.js";
import { Notice } from "./Notice.js";
import {
	dockerKey,
	isActive,
	useMatchSeed,
	useRebuildSeed,
	useSaveDockerSettings,
	useSaveSeedImages,
	useSeedJobs,
} from "./queries.js";
import {
	type DriftPart,
	downloadSize,
	driftActionSentence,
	driftOverSentence,
	driftParts,
	driftSentence,
	listSizeText,
	parseSeedMaxGiB,
	type Segment,
	seedListError,
	seedUseText,
} from "./text.js";

const STATE_LABEL: Record<SeedJob["state"], string> = {
	queued: "Waiting to start",
	running: "Running",
	succeeded: "Finished",
	failed: "Failed",
};

const SUB_HEADING = "pk-text-compact m-0 font-semibold text-ink-muted";

/** The seed meter turns to the warning colour from this share of its limit (DESIGN.md, status colour). */

/** The seed: what it holds now, its latest rebuild, the list for the next one and its size limit. */
export function SeedCard({ data }: { data: DockerAdminResponse }) {
	const jobs = useSeedJobs();
	const rebuild = useRebuildSeed();
	const toast = useToast();
	const client = useQueryClient();
	const latest = jobs.data?.jobs[0] ?? null;
	const busy = isActive(latest?.state);

	// A rebuild that just finished changed the seed; reread it once.
	const wasBusy = useRef(false);
	useEffect(() => {
		if (busy) {
			wasBusy.current = true;
		} else if (wasBusy.current) {
			wasBusy.current = false;
			void client.invalidateQueries({ queryKey: dockerKey });
		}
	}, [busy, client]);

	const listError = seedListError(data.seedImages, data.ghcrEnabled);
	const drift = driftParts(data.seedImages, data.match);
	const off = busy
		? "A rebuild is waiting or running. Wait until it finishes."
		: data.seedImages.length === 0
			? "Add at least one image before rebuilding the seed."
			: listError
				? "Fix the image list below before rebuilding the seed."
				: null;

	function start() {
		if (off) return;
		rebuild.mutate(undefined, {
			onSuccess: () => toast.show({ tone: "success", title: "Seed rebuild requested" }),
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "Could not start the rebuild",
					children: errorText(error),
				}),
		});
	}

	return (
		<AdminGroup
			id="docker-seed-title"
			title="Seed"
			testId="docker-seed"
			help={
				<Toggletip label="the seed">
					A new workspace, Reset Docker and a rebuild with Reset Docker start with a
					copy of the seed, so its images are there without a pull. The copy takes no
					space until it changes. Existing Docker storage keeps what it has.
				</Toggletip>
			}
			actions={
				<Button
					variant="primary"
					data-testid="docker-seed-rebuild"
					aria-disabled={off ? true : undefined}
					aria-describedby={off ? "docker-seed-rebuild-note" : undefined}
					loading={rebuild.isPending}
					onClick={start}
				>
					Rebuild seed
				</Button>
			}
		>
			{off ? (
				<p id="docker-seed-rebuild-note" className="pk-muted m-0 text-[13px]">
					{off}
				</p>
			) : null}
			<CurrentSeed data={data} drifting={drift !== null} />
			<LatestRebuild job={latest} loaded={jobs.data !== undefined} />
			<ImageList
				data={data}
				error={listError}
				notice={drift ? <MatchNotice data={data} busy={busy} parts={drift} /> : null}
			/>
			<SizeLimit data={data} />
		</AdminGroup>
	);
}

function CurrentSeed({
	data,
	drifting,
}: {
	data: DockerAdminResponse;
	/** The drift notice's button rebuilds too, so this notice would repeat it. */
	drifting: boolean;
}) {
	const seed = data.seed;
	// Only to say when the seed's Docker no longer matches new workspaces.
	const image = useAdminImage();
	const defaultVersion = image.data?.default ?? null;
	return (
		<section className="grid gap-2" aria-labelledby="docker-seed-current-title">
			<h4 className={SUB_HEADING} id="docker-seed-current-title">
				Current seed
			</h4>
			{seed ? (
				<>
					<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
						<dt className="pk-muted">Seed size</dt>
						<dd className="m-0" data-testid="docker-seed-size">
							<Meter
								label="Seed size"
								value={seed.sizeBytes}
								max={data.seedMaxGiB * 1024 ** 3}
								high={data.seedMaxGiB * 1024 ** 3 * WARN_AT}
								valueText={seedUseText(seed.sizeBytes, data.seedMaxGiB)}
							/>
						</dd>
						<dt className="pk-muted">Built</dt>
						<dd className="m-0">{longTime(seed.builtAt)}</dd>
						<dt className="pk-muted">Workspace image</dt>
						<dd className="m-0" data-testid="docker-seed-image-version">
							{seed.imageVersion}
						</dd>
					</dl>
					<ImageTable
						caption="Images in the current seed"
						testId="docker-seed-images"
						names={seed.images}
						sizes={data.imageSizes}
					/>
					{!drifting && defaultVersion && defaultVersion !== seed.imageVersion ? (
						<Notice tone="warning" testId="docker-seed-stale">
							The default workspace image is now {defaultVersion}. Rebuild the seed so
							its images match the Docker in new workspaces.
						</Notice>
					) : null}
				</>
			) : (
				<p className="pk-muted m-0 text-[13px]" data-testid="docker-seed-none">
					There is no seed yet, so new Docker storage starts empty. Add images below and
					rebuild the seed.
				</p>
			)}
		</section>
	);
}

/** Image names in a notice, set as code like the tables around it. */
function Segments({ parts }: { parts: Segment[] }) {
	return (
		<>
			{parts.map((part) =>
				typeof part === "string" ? (
					part
				) : (
					// An image name appears once in a sentence.
					<code key={part.code} className="pk-mono-small">
						{part.code}
					</code>
				),
			)}
		</>
	);
}

/**
 * The seed list lacks the images matching the default workspace image.
 * One button swaps them in and rebuilds, unless the estimate
 * says the seed would pass its limit; nothing changes without the click.
 */
function MatchNotice({
	data,
	busy,
	parts,
}: {
	data: DockerAdminResponse;
	busy: boolean;
	parts: DriftPart[];
}) {
	const match = useMatchSeed();
	const toast = useToast();
	const drift = data.match ? seedDrift(data.seedImages, data.match) : null;
	if (!drift) return null;
	const over = overSeedCap(drift.next, data.imageSizes, data.seedMaxGiB);
	const off = busy ? "A rebuild is waiting or running. Wait until it finishes." : null;

	function update() {
		if (off) return;
		// The promise settles even if a reread has already removed this notice.
		match.mutateAsync().then(
			() => {
				toast.show({ tone: "success", title: "Seed list updated, rebuild requested" });
				// This notice and its button go away; the list it changed keeps the place.
				document.getElementById("docker-seed-list-title")?.focus();
			},
			(error) =>
				toast.show({
					tone: "danger",
					title: "Could not update the seed",
					children: errorText(error),
				}),
		);
	}

	return (
		<Notice tone="warning" testId="docker-seed-drift">
			<span className="grid gap-2">
				<span>
					<Segments parts={driftSentence(parts)} />
				</span>
				{over ? (
					<span data-testid="docker-seed-drift-over">
						<Segments parts={driftOverSentence(parts, data.seedMaxGiB)} />
					</span>
				) : (
					<>
						<span>
							<Segments parts={driftActionSentence(parts)} />
						</span>
						<span className="flex flex-wrap items-center gap-3">
							<Button
								size="sm"
								data-testid="docker-seed-drift-apply"
								aria-disabled={off ? true : undefined}
								aria-describedby={off ? "docker-seed-drift-note" : undefined}
								loading={match.isPending}
								onClick={update}
							>
								Update list and rebuild
							</Button>
							{off ? (
								<span id="docker-seed-drift-note" className="pk-muted">
									{off}
								</span>
							) : null}
						</span>
					</>
				)}
			</span>
		</Notice>
	);
}

function LatestRebuild({ job, loaded }: { job: SeedJob | null; loaded: boolean }) {
	const tone =
		job?.state === "failed"
			? "pk-tag pk-tag--error"
			: job?.state === "succeeded"
				? "pk-tag"
				: "pk-tag border-transparent bg-status-starting-soft text-status-starting";
	return (
		<section className="grid gap-2" aria-labelledby="docker-seed-job-title">
			<h4 className={SUB_HEADING} id="docker-seed-job-title">
				Latest rebuild
			</h4>
			{/* Mounted before the first job, so its arrival and each step are announced. */}
			<div role="status">
				{job ? (
					<dl
						className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]"
						data-testid="docker-seed-job"
					>
						<dt className="pk-muted">State</dt>
						<dd className="m-0" data-testid="docker-seed-job-state">
							<span className={tone}>{STATE_LABEL[job.state]}</span> {job.step}
						</dd>
						{job.message ? (
							<>
								<dt className="pk-muted">Reason</dt>
								<dd
									className="m-0 [overflow-wrap:anywhere]"
									data-testid="docker-seed-job-message"
								>
									{job.message}
								</dd>
							</>
						) : null}
						<dt className="pk-muted">Requested</dt>
						<dd className="m-0">{longTime(job.requestedAt)}</dd>
						{job.finishedAt ? (
							<>
								<dt className="pk-muted">Finished</dt>
								<dd className="m-0">{longTime(job.finishedAt)}</dd>
							</>
						) : null}
					</dl>
				) : loaded ? (
					<p className="pk-muted m-0 text-[13px]" data-testid="docker-seed-job-none">
						The seed has not been rebuilt yet.
					</p>
				) : null}
			</div>
		</section>
	);
}

function ImageList({
	data,
	error,
	notice,
}: {
	data: DockerAdminResponse;
	error: string | null;
	/** The drift notice, under the heading of the list it changes. */
	notice: ReactNode;
}) {
	const save = useSaveSeedImages();
	const toast = useToast();
	const [draft, setDraft] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const list = data.seedImages;

	function add(event: FormEvent) {
		event.preventDefault();
		const name = draft.trim();
		if (name === "") {
			setAddError("Enter an image name, such as python:3.12.");
			return;
		}
		const next = [...list, name];
		const refused = seedListError(next, data.ghcrEnabled);
		if (refused) {
			setAddError(refused);
			return;
		}
		setAddError(null);
		save.mutate(next, {
			onSuccess: () => {
				setDraft("");
				toast.show({ tone: "success", title: `${name} added to the seed list` });
			},
			onError: (failure) => setAddError(errorText(failure)),
		});
	}

	function remove(name: string) {
		if (save.isPending) return;
		save.mutate(
			list.filter((each) => each !== name),
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: `${name} removed from the seed list` });
					// Its Remove button is gone; the list heading keeps the place.
					document.getElementById("docker-seed-list-title")?.focus();
				},
				onError: (failure) =>
					toast.show({
						tone: "danger",
						title: `Could not remove ${name}`,
						children: errorText(failure),
					}),
			},
		);
	}

	return (
		<section className="grid gap-3" aria-labelledby="docker-seed-list-title">
			<div className="flex flex-wrap items-baseline gap-x-3">
				<h4 className={SUB_HEADING} id="docker-seed-list-title" tabIndex={-1}>
					Images for the next rebuild
				</h4>
				<span className="pk-muted text-[13px]" data-testid="docker-seed-list-count">
					{list.length} of {SEED_IMAGES_MAX}
				</span>
			</div>
			{notice}
			{error ? (
				<Notice tone="error" testId="docker-seed-list-error">
					{error}
				</Notice>
			) : null}
			{list.length === 0 ? (
				<p className="pk-muted m-0 text-[13px]">No images yet.</p>
			) : (
				<>
					<p className="pk-muted m-0 text-[13px]" data-testid="docker-seed-list-size">
						{listSizeText(list, data.imageSizes, data.seedMaxGiB)}
					</p>
					<ImageTable
						caption="Images for the next rebuild"
						testId="docker-seed-list"
						names={list}
						sizes={data.imageSizes}
						action={(name) => (
							<Button
								size="sm"
								variant="quiet"
								aria-label={`Remove ${name}`}
								aria-disabled={save.isPending || undefined}
								onClick={() => remove(name)}
							>
								Remove
							</Button>
						)}
					/>
				</>
			)}
			<form className="flex flex-wrap items-start gap-3" onSubmit={add} noValidate>
				<TextField
					className="w-72 max-w-full"
					id="docker-seed-add"
					label="Image"
					mono
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					placeholder="python:3.12"
					hint={
						data.ghcrEnabled
							? "A Docker Hub or ghcr.io image, with a tag."
							: "A Docker Hub image, with a tag. Turn on the ghcr.io cache to add ghcr.io images."
					}
					value={draft}
					error={announced(addError)}
					onChange={(event) => setDraft(event.target.value)}
				/>
				{/* Lines the button up with the input, below the label row. */}
				<Button
					type="submit"
					className="mt-6"
					data-testid="docker-seed-add-submit"
					loading={save.isPending}
				>
					Add image
				</Button>
			</form>
		</section>
	);
}

/** Seed image names with their download sizes, and an optional action per row. */
function ImageTable({
	caption,
	testId,
	names,
	sizes,
	action,
}: {
	caption: string;
	testId: string;
	names: readonly string[];
	sizes: Record<string, number>;
	action?: (name: string) => ReactNode;
}) {
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid={testId}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						<th scope="col">Image</th>
						<th scope="col" className="pk-num">
							Download size
						</th>
						{action ? (
							<th scope="col">
								<span className="sr-only">Actions</span>
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{names.map((name) => (
						<tr key={name}>
							<th
								scope="row"
								className="whitespace-normal font-mono [overflow-wrap:anywhere]"
							>
								{name}
							</th>
							<td className="pk-num">
								<DownloadSize bytes={downloadSize(sizes, name)} />
							</td>
							{action ? <td className="pk-cell-actions">{action(name)}</td> : null}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function SizeLimit({ data }: { data: DockerAdminResponse }) {
	const save = useSaveDockerSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const value = draft ?? String(data.seedMaxGiB);

	function submit(event: FormEvent) {
		event.preventDefault();
		const gib = parseSeedMaxGiB(value);
		if (gib === null) {
			setError("Enter a whole number from 1 to 64.");
			return;
		}
		setError(null);
		save.mutate(
			{ seedMaxGiB: gib },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Seed size limit saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<form className="flex flex-wrap items-start gap-3" onSubmit={submit} noValidate>
			<TextField
				className="w-56"
				id="docker-seed-max"
				label="Largest seed (GiB)"
				inputMode="numeric"
				hint="A rebuild that comes out larger fails and keeps the current seed."
				value={value}
				error={announced(error)}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<Button
				type="submit"
				className="mt-6"
				data-testid="docker-seed-max-save"
				loading={save.isPending}
			>
				Save limit
			</Button>
		</form>
	);
}
