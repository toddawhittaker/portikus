import type { AddressSettings, AdminAddress, SiteJobView } from "@portikus/contracts";
import { Button, EmptyState, Skeleton, useToast } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { useCountdown } from "../../shell/useCountdown.js";
import { AdminSection, AdminGroup as Group } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { PlanForm } from "./PlanForm.js";
import { isOpen, useAddressJob, useAdminAddress } from "./queries.js";
import { addressText, jobText, SOURCE_LABEL } from "./text.js";

const TITLE = "Site address";

const INTRO = {
	id: "admin-address",
	helpAnchor: "admin-address",
	text: "Move the site to a new host name or port. The move is a trial: open the new address and press Keep there, or the old address comes back by itself after 15 minutes.",
};

/** The Site address tab of the admin page: plan, pre-flight and trial (ADR 0059). */
export function AddressTab() {
	const address = useAdminAddress();
	if (address.isError) {
		const off = address.error instanceof ApiError && address.error.status === 404;
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				{off ? (
					<Unavailable testId="address-off" />
				) : (
					<p className="m-0 text-status-error" role="alert">
						{errorText(address.error)}
					</p>
				)}
			</AdminSection>
		);
	}
	if (!address.data) {
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="address-loading">
					<Skeleton variant="block" height={140} />
					<Skeleton variant="block" height={280} />
				</div>
			</AdminSection>
		);
	}
	const data = address.data;
	const open = isOpen(data.job?.state);
	return (
		<AdminSection title={TITLE} intro={INTRO}>
			{data.apt && data.current ? (
				<CurrentGroup current={data.current} />
			) : (
				<Unavailable testId="address-unavailable" />
			)}
			{/* Always mounted, so each change of the job's state is read out (SPEC.md section 25.8). */}
			<p role="status" className="sr-only" data-testid="address-job-announce">
				{data.job ? jobText(data.job, data.target) : ""}
			</p>
			{data.job ? <JobGroup data={data} job={data.job} /> : null}
			{data.apt && data.current ? (
				<Group
					id="address-change-title"
					title="Change the address"
					testId="address-change"
					description="Plan the move, check DNS, then apply it as a trial."
				>
					<PlanForm current={data.current} blocked={open} />
				</Group>
			) : null}
			<RecoveryGroup />
		</AdminSection>
	);
}

function Unavailable({ testId }: { testId: string }) {
	return (
		<div className="pk-card" data-testid={testId}>
			<EmptyState icon="info" title="Changing the address is unavailable here">
				The site address can be changed on this page only on a server installed with
				apt. On this install it is set with the install's own tools.
			</EmptyState>
		</div>
	);
}

function CurrentGroup({ current }: { current: NonNullable<AdminAddress["current"]> }) {
	return (
		<Group id="address-current-title" title="Current address" testId="address-current">
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Address</dt>
				<dd className="m-0 [overflow-wrap:anywhere]" data-testid="address-current-url">
					{addressText(current)}
				</dd>
				<dt className="pk-muted">Preview names</dt>
				<dd
					className="m-0 [overflow-wrap:anywhere]"
					data-testid="address-current-preview"
				>
					*.{current.previewSuffix}
					{current.previewSuffixSetByHand ? " (set by hand, kept on a move)" : ""}
				</dd>
				<dt className="pk-muted">Certificate</dt>
				<dd className="m-0" data-testid="address-current-certificate">
					{SOURCE_LABEL[current.certificateSource]}
				</dd>
			</dl>
		</Group>
	);
}

function JobGroup({ data, job }: { data: AdminAddress; job: SiteJobView }) {
	const toast = useToast();
	const ask = useAddressJob();
	const countdown = useCountdown(job.state === "trial" ? job.trialEndsAt : null);
	const target = data.target;
	const inTrial = job.state === "trial";
	const wasTrial = useRef(inTrial);
	// Keep and Roll back remove themselves when the trial ends: focus goes to the group heading.
	useEffect(() => {
		if (wasTrial.current && !inTrial) {
			const lost = !document.activeElement || document.activeElement === document.body;
			if (lost) document.getElementById("address-job-title")?.focus();
		}
		wasTrial.current = inTrial;
	}, [inTrial]);

	function end(kind: "keep" | "rollback") {
		ask.mutate(
			{ kind },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: kind === "keep" ? "Keep requested" : "Roll back requested",
					}),
				onError: (error) =>
					toast.show({
						tone: "danger",
						title:
							kind === "keep" ? "Could not keep the address" : "Could not roll back",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<Group
			id="address-job-title"
			title={job.state === "trial" ? "Trial in progress" : "Latest change"}
			testId="address-job"
		>
			<p className="m-0 text-[13px]" data-testid="address-job-text">
				{jobText(job, target)}
			</p>
			{job.state === "trial" && target ? (
				<TrialPart
					target={target}
					clock={countdown?.clock ?? null}
					at={countdown?.at ?? null}
					pending={ask.isPending ? (ask.variables?.kind ?? null) : null}
					onKeep={() => end("keep")}
					onRollback={() => end("rollback")}
				/>
			) : null}
		</Group>
	);
}

function TrialPart({
	target,
	clock,
	at,
	pending,
	onKeep,
	onRollback,
}: {
	target: AddressSettings;
	clock: string | null;
	at: string | null;
	pending: "apply" | "keep" | "rollback" | null;
	onKeep: () => void;
	onRollback: () => void;
}) {
	const url = addressText(target);
	const here = window.location.origin === url;
	return (
		<>
			{clock ? (
				<p className="m-0 text-[13px]">
					The old address comes back in{" "}
					<span role="timer" className="font-semibold" data-testid="address-countdown">
						{clock}
					</span>
					{at ? `, at ${at},` : ""} unless you press Keep.
				</p>
			) : null}
			{here ? null : (
				<Notice tone="pending" testId="address-open-new">
					<span>
						Open{" "}
						<a href={url} className="pk-link [overflow-wrap:anywhere]">
							{url}
						</a>
						, sign in again and press Keep there. Keep works only from the new address,
						which shows that it reaches this server.
					</span>
				</Notice>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="primary"
					data-testid="address-keep"
					loading={pending === "keep"}
					onClick={onKeep}
				>
					Keep
				</Button>
				<Button
					data-testid="address-rollback"
					loading={pending === "rollback"}
					onClick={onRollback}
				>
					Roll back
				</Button>
			</div>
		</>
	);
}

function RecoveryGroup() {
	return (
		<Group
			id="address-recovery-title"
			title="If the new address stops working"
			testId="address-recovery"
		>
			<p className="m-0 max-w-[72ch] text-[13px]">
				Before you press Keep, waiting 15 minutes or pressing Roll back puts the old
				address back. After Keep, sign in to the server instead. If the port changed,
				first set{" "}
				<code className="pk-mono-body whitespace-nowrap">portikus_public_port</code> in{" "}
				<code className="pk-mono-body whitespace-nowrap">
					/etc/portikus/portikus.yaml
				</code>
				. Then run{" "}
				<code className="pk-mono-body whitespace-nowrap">
					sudo dpkg-reconfigure portikus
				</code>
				, enter the old host name, and let it rerun setup.
			</p>
		</Group>
	);
}
