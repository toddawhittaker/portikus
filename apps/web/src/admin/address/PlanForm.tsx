import type {
	AddressPlan,
	AddressSettings,
	AdminAddress,
	CertificatePreflight,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	TextField,
	useToast,
} from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup as Group } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { useAddressJob, useAddressPreflight, usePlan } from "./queries.js";
import { addressText, CHECK_LABEL } from "./text.js";

type Current = NonNullable<AdminAddress["current"]>;

/** The checked values and what the server said about them. */
interface Checked {
	settings: AddressSettings;
	plan: AddressPlan;
	preflight: CertificatePreflight | null;
}

const BLOCKED_REASON =
	"A change is waiting, running or on trial. Keep it or roll it back first.";

/** The new address, its plan and pre-flight, and Apply (ADR 0059). */
export function PlanForm({ current, blocked }: { current: Current; blocked: boolean }) {
	const toast = useToast();
	const plan = usePlan();
	const preflight = useAddressPreflight();
	const ask = useAddressJob();
	const [host, setHost] = useState("");
	const [port, setPort] = useState(String(current.port));
	const [checked, setChecked] = useState<Checked | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);

	const settings: AddressSettings = {
		host: host.trim().toLowerCase(),
		port: Number(port),
	};
	// A result for other values than those in the form no longer counts.
	const fresh =
		checked &&
		checked.settings.host === settings.host &&
		checked.settings.port === settings.port
			? checked
			: null;
	const why = blocked
		? BLOCKED_REASON
		: !fresh
			? "Plan and check the new address first."
			: !fresh.plan.certificate.allowed
				? "The certificate does not cover the new names."
				: !fresh.preflight?.ok
					? "The DNS checks must pass first."
					: null;

	function check(event: FormEvent) {
		event.preventDefault();
		setFailure(null);
		setChecked(null);
		const wanted = settings;
		plan.mutate(wanted, {
			onSuccess: (result) => {
				setChecked({ settings: wanted, plan: result, preflight: null });
				preflight.mutate(wanted, {
					onSuccess: (checks) =>
						setChecked({ settings: wanted, plan: result, preflight: checks }),
					onError: (error) => setFailure(errorText(error)),
				});
			},
			onError: (error) => setFailure(errorText(error)),
		});
	}

	function apply() {
		if (!fresh) return;
		ask.mutate(
			{ kind: "apply", body: fresh.settings },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: "Move requested" });
					setConfirming(false);
				},
				onError: (error) => {
					setConfirming(false);
					setFailure(errorText(error));
				},
			},
		);
	}

	return (
		<form className="grid gap-4" onSubmit={check} noValidate>
			<div className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<TextField
					id="address-host"
					data-testid="address-host"
					label="New host name"
					hint={`For example code.example.edu. Now ${current.host}.`}
					autoComplete="off"
					spellCheck={false}
					mono
					value={host}
					onChange={(event) => setHost(event.target.value)}
				/>
				<TextField
					id="address-port"
					data-testid="address-port"
					label="Port"
					hint="443, or 1024 to 65535."
					inputMode="numeric"
					value={port}
					onChange={(event) => setPort(event.target.value)}
				/>
			</div>
			<div className="grid justify-items-start gap-2">
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						data-testid="address-check"
						loading={plan.isPending || preflight.isPending}
					>
						Plan and check
					</Button>
					<Button
						variant="primary"
						data-testid="address-apply"
						aria-disabled={why ? true : undefined}
						aria-describedby={why ? "address-apply-note" : undefined}
						onClick={() => (why ? undefined : setConfirming(true))}
					>
						Apply as a trial
					</Button>
				</div>
				{why ? (
					<p id="address-apply-note" className="pk-muted m-0 text-[13px]">
						{why}
					</p>
				) : null}
			</div>
			{failure ? (
				<p
					className="m-0 text-[13px] text-status-error [overflow-wrap:anywhere]"
					role="alert"
					data-testid="address-error"
				>
					{failure}
				</p>
			) : null}
			{/* Always mounted, so a result that arrives later is read out (SPEC.md section 25.8). */}
			<div role="status" className="grid gap-2" data-testid="address-preflight">
				{fresh?.preflight ? <Checks result={fresh.preflight} /> : null}
			</div>
			{fresh ? <PlanPart plan={fresh.plan} /> : null}

			<ConfirmDialogRoot
				open={confirming}
				onOpenChange={(open) => (open ? undefined : setConfirming(false))}
			>
				{confirming && fresh ? (
					<ConfirmDialog
						id="address-apply-confirm"
						testId="address-apply-confirm"
						title={`Move the site to ${addressText(fresh.settings)}?`}
						description="Setup reruns with the new address. This page loses its connection; open the new address and press Keep there within 15 minutes, or the old address comes back."
						lost={[
							"Everyone is signed out, including you.",
							"Old bookmarks and preview links stop working.",
							"Sign-in through an outside provider and LMS launches fail until you update them as the checklist says.",
						]}
						confirmLabel="Apply"
						pending={ask.isPending}
						onConfirm={apply}
					/>
				) : null}
			</ConfirmDialogRoot>
		</form>
	);
}

function Checks({ result }: { result: CertificatePreflight }) {
	const failed = result.checks.filter((c) => c.result !== "passed").length;
	return (
		<>
			<h4
				className="pk-text-compact m-0 font-semibold"
				data-testid="address-preflight-summary"
			>
				{failed === 0
					? "All DNS checks passed."
					: `${failed} ${failed === 1 ? "check" : "checks"} failed. Fix DNS and check again.`}
			</h4>
			<ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
				{result.checks.map((check) => (
					<li
						key={check.name}
						className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2"
						data-testid={`address-check-${check.name}`}
					>
						<span
							className={`w-18 justify-center ${check.result === "passed" ? "pk-tag" : "pk-tag pk-tag--error"}`}
						>
							{check.result === "passed" ? "Passed" : "Failed"}
						</span>
						<span>
							<span className="font-semibold">
								{CHECK_LABEL[check.name] ?? check.name}
							</span>
							<span className="block text-ink-muted [overflow-wrap:anywhere]">
								{check.message}
							</span>
						</span>
					</li>
				))}
			</ul>
		</>
	);
}

function PlanPart({ plan }: { plan: AddressPlan }) {
	const values: [string, string, string][] = [
		["Site address", plan.siteUrl, "url"],
		["Sign-in issuer", plan.dexIssuer, "issuer"],
		["Sign-in redirect address", plan.dexCallbackUrl, "callback"],
		["LTI login address", plan.lti.loginUrl, "lti-login"],
		["LTI launch address", plan.lti.launchUrl, "lti-launch"],
		["LTI keyset address", plan.lti.keysetUrl, "lti-keyset"],
		["Preview names", plan.previewWildcard, "preview"],
	];
	return (
		<Group id="address-plan-title" level={4} title="What changes" testId="address-plan">
			<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
				{values.map(([label, value, id]) => (
					<div key={id} className="contents">
						<dt className="pk-muted">{label}</dt>
						<dd
							className="pk-mono-small m-0 [overflow-wrap:anywhere]"
							data-testid={`address-plan-${id}`}
						>
							{value}
						</dd>
					</div>
				))}
			</dl>
			{plan.previewSuffixSetByHand ? (
				<Notice tone="pending" testId="address-plan-by-hand">
					The preview suffix was set by hand in portikus.yaml, so it stays as it is.
				</Notice>
			) : null}
			<p className="m-0 text-[13px]" data-testid="address-plan-certificate">
				{plan.certificateNote}
			</p>
			{plan.certificate.allowed ? null : (
				<Notice tone="error" testId="address-plan-certificate-refused">
					Apply is off until the certificate covers the new names.
				</Notice>
			)}
			<h5 className="pk-text-compact m-0 font-semibold">Checklist</h5>
			<ol className="m-0 grid gap-1 ps-5 text-[13px]" data-testid="address-checklist">
				{plan.checklist.map((step) => (
					<li key={step} className="[overflow-wrap:anywhere]">
						{step}
					</li>
				))}
			</ol>
			<h5 className="pk-text-compact m-0 font-semibold">Running workspaces</h5>
			{plan.workspacesKeepingOldSuffix.length === 0 ? (
				<p className="pk-muted m-0 text-[13px]" data-testid="address-plan-workspaces">
					None keep an old preview address.
				</p>
			) : (
				<>
					<p className="m-0 text-[13px]">
						These keep the old preview names until they next start. Nothing is
						restarted.
					</p>
					<ul
						className="m-0 grid gap-1 ps-5 text-[13px]"
						data-testid="address-plan-workspaces"
					>
						{plan.workspacesKeepingOldSuffix.map((w) => (
							<li key={w.id}>
								{w.ownerName} <span className="pk-mono-small">({w.label})</span>
							</li>
						))}
					</ul>
				</>
			)}
		</Group>
	);
}
