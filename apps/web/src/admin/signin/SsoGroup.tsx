import {
	type AdminSignin,
	isJobActive,
	SITE_JOB_STALE_MS,
	type SigninSettings,
	type SigninView,
	type SiteJobView,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Skeleton,
	useToast,
} from "@portikus/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { Notice } from "../Notice.js";
import { useAdminSignin, useApplySignin } from "./queries.js";
import { SsoFields } from "./SsoFields.js";
import { SsoTrial } from "./SsoTrial.js";
import {
	FIELD_ID,
	initialForm,
	jobText,
	openTrial,
	PROVIDER_LABEL,
	type SsoForm,
	toSettings,
	validate,
} from "./ssoForm.js";

const UNAVAILABLE =
	"Single sign-on can be changed here only on a server installed with apt. Elsewhere it is set where the server was installed.";
const LDAP_NOTE =
	"LDAP is set on the server with sudo dpkg-reconfigure portikus. You can still switch to another provider here.";
const BUSY_NOTE = "A site change is waiting, running or on trial. Wait until it ends.";
const APPLY_TEXT =
	"Setup reruns with the new provider as a trial for 30 minutes: test it, then keep it, or the current settings are put back by themselves. While a bad trial is open, students cannot sign in. The local administrator's password always works.";

/** The single sign-on provider: view, trial, test and keep (SPEC.md 20.1, ADR 0059). */
export function SsoGroup() {
	const signin = useAdminSignin();
	return (
		<AdminGroup
			id="admin-signin-sso"
			title="Single sign-on"
			description="How people sign in besides local accounts."
			testId="admin-signin-sso"
		>
			{signin.data ? (
				<SsoBody data={signin.data} />
			) : signin.isError ? (
				signin.error instanceof ApiError && signin.error.status === 404 ? (
					<p className="pk-text-compact m-0" data-testid="sso-off">
						This site runs without the site job, so single sign-on cannot be set here.
					</p>
				) : (
					<p className="pk-text-compact m-0 text-status-error" role="alert">
						{errorText(signin.error)}
					</p>
				)
			) : (
				<div aria-busy="true" data-testid="sso-loading">
					<Skeleton variant="block" height={160} />
				</div>
			)}
		</AdminGroup>
	);
}

function SsoBody({ data }: { data: AdminSignin }) {
	const view = data.current;
	const trial = openTrial(data.job);
	return (
		<div className="grid gap-5">
			{view ? <CurrentSettings view={view} /> : null}
			{/* Always mounted, so each change of the job's state is read out (SPEC.md section 25.8). */}
			<div role="status" data-testid="sso-job">
				{data.job && !trial ? <JobLine job={data.job} /> : null}
			</div>
			{!view ? (
				<p className="pk-text-compact m-0" data-testid="sso-unavailable">
					{UNAVAILABLE}
				</p>
			) : trial ? (
				<SsoTrial job={trial} view={view} lastTest={data.lastTest} />
			) : (
				<SsoChange view={view} busy={isJobActive(data.job, SITE_JOB_STALE_MS)} />
			)}
		</div>
	);
}

function CurrentSettings({ view }: { view: SigninView }) {
	const rows: [string, string][] = [["Provider", PROVIDER_LABEL[view.provider]]];
	if (view.ldapHost) rows.push(["Directory server", view.ldapHost]);
	if (view.entraTenantId) rows.push(["Tenant ID", view.entraTenantId]);
	if (view.googleDomains.length > 0)
		rows.push(["Domains", view.googleDomains.join(", ")]);
	if (view.oidcIssuer) rows.push(["Issuer URL", view.oidcIssuer]);
	if (view.clientId) rows.push(["Client ID", view.clientId]);
	if (view.provider !== "dex" && view.provider !== "ldap") {
		rows.push(["Client secret", view.clientSecretSet ? "Set" : "Not set"]);
	}
	return (
		<div className="grid gap-3">
			<dl
				className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]"
				data-testid="sso-current"
			>
				{rows.map(([term, value]) => (
					<div key={term} className="contents">
						<dt className="text-ink-muted">{term}</dt>
						<dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
					</div>
				))}
			</dl>
			{view.provider === "ldap" ? (
				<p className="pk-text-compact m-0" data-testid="sso-ldap-note">
					{LDAP_NOTE}
				</p>
			) : null}
		</div>
	);
}

function JobLine({ job }: { job: SiteJobView }) {
	const text = jobText(job);
	if (isJobActive(job, SITE_JOB_STALE_MS))
		return <Notice tone="pending">{text}</Notice>;
	if (job.state === "failed") return <Notice tone="error">{text}</Notice>;
	if (job.state === "reverted") return <Notice tone="warning">{text}</Notice>;
	return <p className="pk-text-compact pk-muted m-0">{text}</p>;
}

function SsoChange({ view, busy }: { view: SigninView; busy: boolean }) {
	const toast = useToast();
	const apply = useApplySignin();
	const [form, setFormState] = useState<SsoForm>(() => initialForm(view));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [failure, setFailure] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<SigninSettings | null>(null);
	const focusError = useRef(false);

	// New settings in force after a trial ends: start the form from them.
	const viewText = JSON.stringify(view);
	const [shownView, setShownView] = useState(viewText);
	if (shownView !== viewText) {
		setShownView(viewText);
		setFormState(initialForm(view));
		setErrors({});
	}

	useEffect(() => {
		if (!focusError.current) return;
		focusError.current = false;
		const first = Object.keys(errors)[0];
		if (first) document.getElementById(first)?.focus();
	}, [errors]);

	function clearError(id: string) {
		setErrors((now) => {
			if (!(id in now)) return now;
			const { [id]: _, ...rest } = now;
			return rest;
		});
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		const found = validate(form, view);
		setErrors(found);
		setFailure(null);
		if (Object.keys(found).length > 0) {
			focusError.current = true;
			return;
		}
		setConfirming(toSettings(form));
	}

	function confirm(settings: SigninSettings) {
		apply.mutate(settings, {
			onSuccess: () => {
				toast.show({ tone: "success", title: "Sign-in change requested" });
				setConfirming(null);
				// The secret is with the job now; the page keeps none of it.
				setFormState((now) => ({ ...now, clientSecret: "" }));
				apply.reset();
			},
			onError: (error) => {
				setConfirming(null);
				setFailure(errorText(error));
				if (error instanceof ApiError && error.code === "SIGNIN_SECRET_REQUIRED") {
					setErrors({ [FIELD_ID.clientSecret]: error.message });
					focusError.current = true;
				}
				apply.reset();
			},
		});
	}

	return (
		<form
			className="grid gap-5"
			noValidate
			aria-labelledby="admin-signin-sso"
			onSubmit={submit}
		>
			<SsoFields
				form={form}
				view={view}
				errors={errors}
				onChange={(next) => {
					setFormState(next);
					setFailure(null);
				}}
				onEdit={clearError}
			/>
			<div className="grid gap-2">
				<div className="pk-actions">
					<Button
						type="submit"
						variant="primary"
						data-testid="sso-apply"
						aria-disabled={busy ? true : undefined}
						aria-describedby={busy ? "sso-busy-note" : "sso-apply-note"}
					>
						Apply as a trial
					</Button>
				</div>
				<p
					className="pk-text-compact pk-muted m-0"
					id={busy ? "sso-busy-note" : "sso-apply-note"}
				>
					{busy
						? BUSY_NOTE
						: "You test the new provider, then keep it. Unkept, it is put back after 30 minutes."}
				</p>
				{failure ? (
					<p
						className="pk-text-compact m-0 text-status-error [overflow-wrap:anywhere]"
						role="alert"
						data-testid="sso-error"
					>
						{failure}
					</p>
				) : null}
			</div>
			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open ? undefined : setConfirming(null))}
			>
				{confirming ? (
					<ConfirmDialog
						id="sso-apply-confirm"
						testId="sso-apply-confirm"
						destructive={false}
						title={`Try ${PROVIDER_LABEL[confirming.provider]} for sign-in?`}
						description={APPLY_TEXT}
						confirmLabel="Apply as a trial"
						pending={apply.isPending}
						onConfirm={() => confirm(confirming)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</form>
	);
}
