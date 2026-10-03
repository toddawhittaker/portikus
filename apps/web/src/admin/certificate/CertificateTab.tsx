import {
	type AdminCertificate,
	CERTIFICATE_EXPIRY_WARNING_DAYS,
	type CertificateInfo,
	type CertificateJobView,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	Icon,
	Skeleton,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { AdminSection, AdminGroup as Group } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { Notice } from "../docker/Notice.js";
import { JobLog } from "../JobLog.js";
import {
	daysText,
	expiry,
	KIND_LABEL,
	SOURCE_LABEL,
	STATE_LABEL,
	settingsText,
} from "./form.js";
import {
	isActive,
	ROOT_CERTIFICATE_URL,
	useAdminCertificate,
	useCertificateJob,
	useRequestCertificateJob,
} from "./queries.js";
import { SourceForm } from "./SourceForm.js";

const TITLE = "Certificate";

const INTRO = {
	id: "admin-certificate",
	helpAnchor: "admin-certificate",
	text: "The certificate that secures this site and its preview names. Keep Caddy's internal authority, get a trusted one from Let's Encrypt or another ACME authority, or upload your institution's own. A change is checked first and undone if the new certificate does not arrive.",
};

const BUSY_REASON = "A certificate job is waiting or running. Wait until it finishes.";

/** The Certificate tab of the admin page (docs/SPEC.md section 20.1; ADR 0046). */
export function CertificateTab() {
	const certificate = useAdminCertificate();
	if (certificate.isError) {
		const off =
			certificate.error instanceof ApiError && certificate.error.status === 404;
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				{off ? (
					<div className="pk-card" data-testid="cert-off">
						<EmptyState icon="info" title="Certificate management is off on this site">
							This site was installed without the certificate job, so its certificate is
							managed on the host instead.
						</EmptyState>
					</div>
				) : (
					<p className="m-0 text-status-error" role="alert">
						{errorText(certificate.error)}
					</p>
				)}
			</AdminSection>
		);
	}
	if (!certificate.data) {
		return (
			<AdminSection title={TITLE} intro={INTRO}>
				<div className="grid gap-6" aria-busy="true" data-testid="cert-loading">
					<Skeleton variant="block" height={180} />
					<Skeleton variant="block" height={320} />
				</div>
			</AdminSection>
		);
	}
	return <CertificateSections data={certificate.data} />;
}

function CertificateSections({ data }: { data: AdminCertificate }) {
	const toast = useToast();
	const ask = useRequestCertificateJob();
	const [rollingBack, setRollingBack] = useState(false);
	const busy = isActive(data.job?.state);
	// Only ACME renews on request: an upload never renews, and the internal authority's short certificates renew themselves.
	const renewable = data.settings?.source === "acme";
	const busyNote = busy ? "cert-busy-note" : undefined;
	const noPrevious = !busy && !data.previousAvailable;

	function renew() {
		ask.mutate(
			{ kind: "renew" },
			{
				onSuccess: () => toast.show({ tone: "success", title: "Renewal requested" }),
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: "Could not start the renewal",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<AdminSection title={TITLE} intro={INTRO}>
			<Group
				id="cert-current-title"
				title="Certificate in use"
				testId="cert-current"
				actions={
					// The reason a button is off sits under it, not at the top of the card.
					<div className="grid justify-items-end gap-2">
						<div className="flex flex-wrap gap-2">
							{renewable ? (
								<Button
									data-testid="cert-renew"
									loading={ask.isPending && ask.variables?.kind === "renew"}
									aria-disabled={busy ? true : undefined}
									aria-describedby={busyNote}
									onClick={() => (busy ? undefined : renew())}
								>
									Renew now
								</Button>
							) : null}
							<Button
								data-testid="cert-rollback"
								aria-disabled={busy || noPrevious ? true : undefined}
								aria-describedby={noPrevious ? "cert-rollback-note" : busyNote}
								onClick={() => (busy || noPrevious ? undefined : setRollingBack(true))}
							>
								Roll back
							</Button>
						</div>
						{busy ? (
							<p
								id="cert-busy-note"
								className="pk-muted m-0 max-w-[40ch] text-end text-[13px]"
							>
								{BUSY_REASON}
							</p>
						) : null}
						{noPrevious ? (
							<p
								id="cert-rollback-note"
								className="pk-muted m-0 max-w-[40ch] text-end text-[13px]"
							>
								There are no earlier settings to roll back to.
							</p>
						) : null}
					</div>
				}
			>
				<CurrentPart data={data} />
			</Group>

			{/* Always mounted, so each change of the job's state is read out (SPEC.md section 25.8). */}
			<p role="status" className="sr-only" data-testid="cert-job-announce">
				{data.job ? jobAnnouncement(data.job) : ""}
			</p>
			{data.job ? <JobGroup job={data.job} /> : null}

			<Group
				id="cert-change-title"
				title="Change the certificate"
				testId="cert-change"
				help={
					<Toggletip label="changing the certificate">
						Apply saves the settings in force as the previous ones, puts the new ones in
						use and waits for the certificate. If it does not arrive in time, the
						previous settings are put back on their own.
					</Toggletip>
				}
			>
				<SourceForm data={data} busy={busy} />
			</Group>

			{data.rootCertificateAvailable ? <RootGroup /> : null}

			<ConfirmDialogRoot
				open={rollingBack}
				onOpenChange={(open) => (open ? undefined : setRollingBack(false))}
			>
				{rollingBack ? (
					<ConfirmDialog
						id="cert-rollback-confirm"
						testId="cert-rollback-confirm"
						destructive={false}
						title="Roll back to the previous certificate settings?"
						description="The settings in force before the last change are put back and the site reloads with their certificate. The current settings become the previous ones, so you can roll forward again."
						confirmLabel="Roll back"
						pending={ask.isPending}
						onConfirm={() =>
							ask.mutate(
								{ kind: "rollback" },
								{
									onSuccess: () => {
										toast.show({ tone: "success", title: "Roll back requested" });
										setRollingBack(false);
									},
									onError: (error) =>
										toast.show({
											tone: "danger",
											title: "Could not start the roll back",
											children: errorText(error),
										}),
								},
							)
						}
					/>
				) : null}
			</ConfirmDialogRoot>
		</AdminSection>
	);
}

function CurrentPart({ data }: { data: AdminCertificate }) {
	const { settings, status } = data;
	const now = new Date();
	const site = status?.site ?? null;
	const siteExpiry = site
		? expiry(site.notAfter, now, CERTIFICATE_EXPIRY_WARNING_DAYS)
		: null;
	const renewal = status?.lastRenewal ?? null;
	return (
		<>
			{siteExpiry && siteExpiry.tone !== "ok" ? (
				<Notice tone="error" testId="cert-expiry-notice">
					{siteExpiry.tone === "expired"
						? "The site's certificate has expired. Browsers refuse the site until it is renewed or replaced."
						: `The site's certificate expires ${daysText(siteExpiry.days)}. Renew it now, or replace it below.`}
				</Notice>
			) : null}
			{renewal && !renewal.ok ? (
				<Notice tone="error" testId="cert-renewal-notice">
					The last renewal failed on {longTime(renewal.at)}.{" "}
					{renewal.message ? (
						<span className="[overflow-wrap:anywhere]">{renewal.message}</span>
					) : null}
				</Notice>
			) : null}
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Source</dt>
				<dd className="m-0 [overflow-wrap:anywhere]" data-testid="cert-source">
					{settings
						? settingsText(settings)
						: status
							? SOURCE_LABEL[status.source]
							: "Unknown"}
				</dd>
				{settings?.source === "acme" ? (
					<>
						<dt className="pk-muted">Account email</dt>
						<dd className="m-0 [overflow-wrap:anywhere]">{settings.email}</dd>
					</>
				) : null}
				<dt className="pk-muted flex items-center gap-1">
					Last renewal
					<Toggletip label="renewal">
						Caddy renews an ACME certificate on its own about 30 days before it expires.
						An uploaded certificate never renews; upload a new one in time.
					</Toggletip>
				</dt>
				<dd className="m-0" data-testid="cert-last-renewal">
					{renewal
						? `${renewal.ok ? "Succeeded" : "Failed"}, ${longTime(renewal.at)}`
						: "None since the last change"}
				</dd>
				<dt className="pk-muted">Last checked</dt>
				<dd className="m-0" data-testid="cert-checked">
					{status ? longTime(status.checkedAt) : "Not yet"}
				</dd>
			</dl>
			{status ? (
				<div className="pk-table-wrap">
					<table
						// Long issuers and name lists wrap in their own column, top-aligned so each row reads across.
						className="pk-table [&_tbody_:is(th,td)]:py-2 [&_tbody_:is(th,td)]:align-top [&_tbody_:is(th,td)]:whitespace-normal"
						data-testid="cert-table"
					>
						<caption className="sr-only">Certificates in use</caption>
						<colgroup>
							<col className="w-[28%]" />
							<col className="w-[24%]" />
							<col className="w-[28%]" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Certificate</th>
								<th scope="col">Issuer</th>
								<th scope="col">Covers</th>
								<th scope="col">Expires</th>
							</tr>
						</thead>
						<tbody>
							<CertificateRow label="Site" info={status.site} now={now} testId="site" />
							<CertificateRow
								label="Previews"
								info={status.preview}
								now={now}
								testId="preview"
								missing={
									settings?.source === "acme" && settings.challenge.mode === "http01"
										? "Each preview name gets its own certificate when first opened."
										: undefined
								}
							/>
						</tbody>
					</table>
				</div>
			) : (
				<p className="pk-muted m-0 text-[13px]" data-testid="cert-not-checked">
					The certificate has not been checked yet. The check runs every hour and after
					each change.
				</p>
			)}
		</>
	);
}

function CertificateRow({
	label,
	info,
	now,
	testId,
	missing,
}: {
	label: string;
	info: CertificateInfo | null;
	now: Date;
	testId: string;
	missing?: string;
}) {
	if (!info) {
		return (
			<tr data-testid={`cert-row-${testId}`}>
				<th scope="row">{label}</th>
				<td colSpan={3} className="pk-muted">
					{missing ?? "Could not be read. The next check tries again."}
				</td>
			</tr>
		);
	}
	const left = expiry(info.notAfter, now, CERTIFICATE_EXPIRY_WARNING_DAYS);
	return (
		<tr data-testid={`cert-row-${testId}`}>
			<th scope="row">
				{label}
				<span className="pk-mono-small block font-normal text-ink-muted [overflow-wrap:anywhere]">
					{info.name}
				</span>
			</th>
			<td className="[overflow-wrap:anywhere]" data-testid={`cert-issuer-${testId}`}>
				{info.issuer || "Unknown"}
			</td>
			<td>
				<ul className="m-0 grid list-none gap-0.5 p-0">
					{info.names.map((name) => (
						<li key={name} className="pk-mono-small [overflow-wrap:anywhere]">
							{name}
						</li>
					))}
				</ul>
			</td>
			<td data-testid={`cert-expires-${testId}`}>
				<span className="block">{longTime(info.notAfter)}</span>
				<span className="flex flex-wrap items-center gap-1 text-ink-muted">
					{left.tone === "expired" ? (
						<span className="pk-tag pk-tag--error">Expired</span>
					) : left.tone === "soon" ? (
						<span className="pk-tag pk-tag--warning">Expires soon</span>
					) : null}
					{daysText(left.days)}
				</span>
			</td>
		</tr>
	);
}

function jobTitle(job: CertificateJobView): string {
	if (!job.kind) return "Unknown request";
	const settings = job.request?.settings;
	if ((job.kind === "apply" || job.kind === "test") && settings) {
		return `${KIND_LABEL[job.kind]}: ${settingsText(settings)}`;
	}
	return KIND_LABEL[job.kind];
}

/** What the status region says about the job, in one line. */
function jobAnnouncement(job: CertificateJobView): string {
	const kind = job.kind ? KIND_LABEL[job.kind] : "Unknown request";
	const parts = [`${kind}: ${STATE_LABEL[job.state]}.`, sentence(job.step)];
	if (job.message && (job.state === "failed" || job.state === "refused")) {
		parts.push(sentence(job.message));
	}
	if (job.restored) parts.push("The previous certificate settings were put back.");
	return parts.filter(Boolean).join(" ");
}

function sentence(text: string): string {
	const trimmed = text.trim();
	return trimmed === "" || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function JobGroup({ job }: { job: CertificateJobView }) {
	const detail = useCertificateJob(job.id, job.state);
	const shown = detail.data?.job ?? job;
	const log = detail.data?.log ?? [];
	const ended = shown.state === "failed" || shown.state === "refused";
	const tone = ended
		? "pk-tag pk-tag--error"
		: shown.state === "succeeded"
			? "pk-tag"
			: "pk-tag border-transparent bg-status-starting-soft text-status-starting";
	return (
		<Group id="cert-job-title" title="Latest job" testId="cert-job">
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				<dt className="pk-muted">Job</dt>
				<dd className="m-0 [overflow-wrap:anywhere]" data-testid="cert-job-kind">
					{jobTitle(shown)}
				</dd>
				<dt className="pk-muted">State</dt>
				<dd className="m-0">
					<span data-testid="cert-job-state">
						<span className={tone}>{STATE_LABEL[shown.state]}</span> {shown.step}
					</span>
				</dd>
				{shown.message ? (
					<>
						<dt className="pk-muted">Reason</dt>
						<dd className="m-0 [overflow-wrap:anywhere]" data-testid="cert-job-message">
							{shown.message}
						</dd>
					</>
				) : null}
				{shown.restored ? (
					<>
						<dt className="pk-muted">Result</dt>
						<dd className="m-0" data-testid="cert-job-restored">
							The previous certificate settings were put back and are still in use.
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
			<JobLog idPrefix="cert" log={log} />
		</Group>
	);
}

/** Matches a secondary Button; a link, because the browser downloads the file itself. */
const LINK_BUTTON =
	"pk-btn pk-focus-ring inline-flex h-[var(--pk-control)] items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-line-strong bg-surface-raised px-[var(--pk-pad)] font-semibold text-[length:var(--pk-font)] text-ink leading-none no-underline hover:bg-surface-hover";

function RootGroup() {
	return (
		<Group id="cert-root-title" title="Internal root certificate" testId="cert-root">
			<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
				<p className="m-0 min-w-0 max-w-[72ch] flex-1 basis-80 text-[13px]">
					A browser trusts a certificate from the internal authority only once this root
					certificate is installed on its computer. Install it on each computer that
					opens this site, then restart the browser.
				</p>
				<a
					className={LINK_BUTTON}
					href={ROOT_CERTIFICATE_URL}
					download="portikus-root.crt"
					data-testid="cert-root-download"
				>
					<Icon name="download" />
					Download root certificate
				</a>
			</div>
			<dl
				className="m-0 grid max-w-[96ch] grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]"
				data-testid="cert-root-steps"
			>
				<dt className="pk-muted">Windows</dt>
				<dd className="m-0">
					Open the file, choose Install Certificate, then Local Machine, and place it in
					Trusted Root Certification Authorities.
				</dd>
				<dt className="pk-muted">macOS</dt>
				<dd className="m-0">
					Open the file to add it to the System keychain, then open it in Keychain
					Access and set Trust to Always Trust.
				</dd>
				<dt className="pk-muted">Linux</dt>
				<dd className="m-0">
					Copy it to{" "}
					<code className="pk-mono-body whitespace-nowrap">
						/usr/local/share/ca-certificates/
					</code>{" "}
					and run{" "}
					<code className="pk-mono-body whitespace-nowrap">
						sudo update-ca-certificates
					</code>
					.
				</dd>
				<dt className="pk-muted">Firefox</dt>
				<dd className="m-0">
					Keeps its own list: Settings, Privacy and Security, View Certificates,
					Authorities, Import.
				</dd>
			</dl>
		</Group>
	);
}
