import type {
	AdminCertificate,
	CertificatePreflight,
	CertificateSettings,
	CertificateSource,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	ConfirmDialogRoot,
	HINT_CLASS,
	useToast,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { AcmeFields } from "./AcmeFields.js";
import { Choice } from "./Choice.js";
import {
	type CertificateForm,
	DIRECTORY_LABEL,
	initialForm,
	keyStored,
	PREFLIGHT_LABEL,
	testIsReal,
	toSettings,
	uploadRefusalField,
	uploadRefusalText,
	validate,
} from "./form.js";
import { usePreflight, useRequestCertificateJob } from "./queries.js";
import { UploadFields } from "./UploadFields.js";

const SOURCES: { value: CertificateSource; label: string; text: string }[] = [
	{
		value: "internal",
		label: "Internal authority",
		text: "Caddy issues the certificate itself. Works with no setup, but each computer must install the root certificate before its browser trusts the site.",
	},
	{
		value: "acme",
		label: "ACME",
		text: "A trusted certificate from Let's Encrypt, ZeroSSL or another ACME authority, renewed on its own. The site's name must be in public DNS.",
	},
	{
		value: "files",
		label: "Upload files",
		text: "Your institution's certificate and private key. It does not renew; upload a new one before it expires.",
	},
];

/** The choice of certificate source and its settings, with Test only and Apply. */
export function SourceForm({ data, busy }: { data: AdminCertificate; busy: boolean }) {
	const toast = useToast();
	const ask = useRequestCertificateJob();
	const preflight = usePreflight();
	const settings = data.settings;
	const [form, setFormState] = useState<CertificateForm>(() => initialForm(settings));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [checks, setChecks] = useState<CertificatePreflight | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<CertificateSettings | null>(null);
	// Which button started the checks, so only that one shows the spinner.
	const [action, setAction] = useState<"test" | "apply">("apply");
	// File inputs keep their own choice; a new key empties them after an apply.
	const [uploadKey, setUploadKey] = useState(0);
	const focusError = useRef(false);
	// New settings in force (an apply or roll back finished): start the form from them.
	const [shownSettings, setShownSettings] = useState(settings);
	if (shownSettings !== settings) {
		setShownSettings(settings);
		setFormState(initialForm(settings));
		setErrors({});
		setChecks(null);
		setFailure(null);
	}

	useEffect(() => {
		if (!focusError.current) return;
		focusError.current = false;
		const first = Object.keys(errors)[0];
		if (first) document.getElementById(first)?.focus();
	}, [errors]);

	/** Takes an update too: a file is read after a wait and must not undo a change made meanwhile. */
	function setForm(
		next: CertificateForm | ((form: CertificateForm) => CertificateForm),
	) {
		setFormState(next);
		setChecks(null);
		setFailure(null);
	}

	function clearError(id: string) {
		setErrors((current) => {
			if (!(id in current)) return current;
			const { [id]: _, ...rest } = current;
			return rest;
		});
	}

	/** The settings to send, or null after showing what is wrong. */
	function checked(): CertificateSettings | null {
		const found = validate(form, settings);
		setErrors(found);
		if (Object.keys(found).length > 0) {
			focusError.current = true;
			return null;
		}
		return toSettings(form);
	}

	/** Run the pre-flight for ACME, then go on only when nothing failed. */
	function afterChecks(next: () => void) {
		setFailure(null);
		preflight.mutate(form.mode, {
			onSuccess: (result) => {
				setChecks(result);
				if (result.ok) next();
			},
			onError: (error) => setFailure(errorText(error)),
		});
	}

	function send(body: Parameters<typeof ask.mutate>[0], done: () => void) {
		setFailure(null);
		ask.mutate(body, {
			onSuccess: () => {
				toast.show({
					tone: "success",
					title: body.kind === "test" ? "Test requested" : "Change requested",
				});
				done();
				// The request held the secrets; the mutation must not keep them.
				ask.reset();
			},
			// The API names the upload check that failed.
			onError: (error) => {
				if (error instanceof ApiError && error.code === "CERTIFICATE_UPLOAD_REFUSED") {
					const text = uploadRefusalText(error.message);
					const field = uploadRefusalField(error.message);
					setFailure(text);
					if (field) setErrors({ [field]: text });
				} else {
					setFailure(errorText(error));
				}
				done();
				ask.reset();
			},
		});
	}

	function test() {
		if (busy) return;
		setAction("test");
		const next = checked();
		if (next?.source !== "acme") return;
		afterChecks(() => send({ kind: "test", settings: next }, () => undefined));
	}

	function apply() {
		if (busy) return;
		setAction("apply");
		const next = checked();
		if (!next) return;
		if (next.source === "acme") afterChecks(() => setConfirming(next));
		else setConfirming(next);
	}

	function confirmApply(next: CertificateSettings) {
		send({ kind: "apply", settings: next }, () => {
			setConfirming(null);
			// The secrets are with the job now; the page keeps none of them.
			setFormState((current) => ({
				...current,
				eabHmacKey: "",
				secrets: {},
				site: { certificate: "", chain: "", privateKey: "" },
				preview: { certificate: "", chain: "", privateKey: "" },
			}));
			setUploadKey((k) => k + 1);
		});
	}

	const offNote = busy ? "cert-busy-note" : undefined;
	const checking = preflight.isPending;

	return (
		<form
			// From @4xl the source choice sits left and the chosen source's fields right, using the card's width.
			className="grid gap-5 @4xl:grid-cols-[minmax(0,22rem)_minmax(0,48rem)] @4xl:gap-x-10"
			noValidate
			aria-labelledby="cert-change-title"
			onSubmit={(event) => {
				event.preventDefault();
				apply();
			}}
		>
			<Choice
				legend="Source"
				name="cert-source"
				value={form.source}
				choices={SOURCES}
				onChange={(source) => setForm({ ...form, source })}
			/>

			<div className="grid min-w-0 content-start gap-5">
				{form.source === "acme" ? (
					<AcmeFields
						form={form}
						errors={errors}
						data={data}
						onChange={(next) => setForm(next)}
						onEdit={clearError}
					/>
				) : null}

				{/* Kept mounted while another source is shown, so chosen files stay chosen. */}
				<div className="grid gap-5" hidden={form.source !== "files"} key={uploadKey}>
					<UploadFields
						which="site"
						legend="Site certificate"
						covers={
							form.separatePreview
								? `It must cover ${data.siteName}.`
								: `It must cover ${data.siteName} and *.${data.previewSuffix}, or add a separate preview certificate.`
						}
						keySet={keyStored(settings, "site")}
						errors={errors}
						onChange={(part, text) =>
							setForm((f) => ({ ...f, site: { ...f.site, [part]: text } }))
						}
						onEdit={clearError}
					/>
					<Checkbox
						label="Use a separate wildcard certificate for previews"
						checked={form.separatePreview}
						onChange={(event) =>
							setForm({ ...form, separatePreview: event.target.checked })
						}
					/>
					<div className="grid" hidden={!form.separatePreview}>
						<UploadFields
							which="preview"
							legend="Preview certificate"
							covers={`It must cover *.${data.previewSuffix}.`}
							keySet={keyStored(settings, "preview")}
							errors={errors}
							onChange={(part, text) =>
								setForm((f) => ({ ...f, preview: { ...f.preview, [part]: text } }))
							}
							onEdit={clearError}
						/>
					</div>
				</div>

				<div className="grid gap-2">
					<div className="pk-actions">
						{form.source === "acme" ? (
							<Button
								data-testid="cert-test"
								loading={
									(checking && action === "test") ||
									(ask.isPending && ask.variables?.kind === "test")
								}
								aria-disabled={busy ? true : undefined}
								aria-describedby={offNote}
								onClick={test}
							>
								Test only
							</Button>
						) : null}
						<Button
							type="submit"
							variant="primary"
							data-testid="cert-apply"
							loading={checking && action === "apply"}
							aria-disabled={busy ? true : undefined}
							aria-describedby={offNote}
						>
							Apply
						</Button>
					</div>
					{form.source === "acme" ? (
						<p className={HINT_CLASS} data-testid="cert-test-note">
							{testIsReal(form)
								? `${DIRECTORY_LABEL[form.directory]} has no test service, so Test only gets a real certificate from it. The test certificate is kept apart and never put in use.`
								: "Test only checks the names and gets a certificate from Let's Encrypt staging, kept apart from the live site. Nothing in use changes."}
						</p>
					) : null}
				</div>

				{/* Always mounted, so a result that arrives later is read out (SPEC.md section 25.8). */}
				<div role="status" className="grid gap-2" data-testid="cert-preflight">
					{checks ? <PreflightList checks={checks} /> : null}
				</div>
				{failure ? (
					<p
						className="m-0 flex items-start gap-1 text-[13px] text-status-error [overflow-wrap:anywhere]"
						role="alert"
						data-testid="cert-form-error"
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
						id="cert-apply-confirm"
						testId="cert-apply-confirm"
						destructive={false}
						title={applyTitle(confirming)}
						description={applyText(confirming, data.siteName)}
						confirmLabel="Apply"
						pending={ask.isPending}
						onConfirm={() => confirmApply(confirming)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</form>
	);
}

function applyTitle(settings: CertificateSettings): string {
	if (settings.source === "internal") return "Switch to the internal authority?";
	if (settings.source === "files") return "Use the uploaded certificate?";
	return "Get a certificate with these ACME settings?";
}

function applyText(settings: CertificateSettings, siteName: string): string {
	const undo =
		"If the new certificate is not in use within a few minutes, the current settings are put back.";
	if (settings.source === "internal") {
		return `Caddy issues ${siteName}'s certificate itself. Browsers warn about the site until the root certificate is installed on their computer. ${undo}`;
	}
	if (settings.source === "files") {
		return `The site reloads with the uploaded certificate. ${undo}`;
	}
	return `This server checks the names, gets a certificate for ${siteName} and its preview names in a separate copy of Caddy, and switches the site to it only once it exists. Until then the site keeps its current certificate. ${undo}`;
}

function PreflightList({ checks }: { checks: CertificatePreflight }) {
	const failed = checks.checks.filter((c) => c.result === "failed").length;
	const warned = checks.checks.filter((c) => c.result === "warning").length;
	const summary =
		failed > 0
			? `${failed} ${failed === 1 ? "check" : "checks"} failed. Fix ${failed === 1 ? "it" : "them"} and try again.`
			: warned > 0
				? `The checks passed with ${warned} ${warned === 1 ? "warning" : "warnings"}. A DNS-01 certificate does not depend on them.`
				: "All checks passed.";
	return (
		<>
			<h4
				className="pk-text-compact m-0 font-semibold"
				data-testid="cert-preflight-summary"
			>
				{summary}
			</h4>
			<ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
				{checks.checks.map((check) => (
					<li
						key={check.name}
						className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2"
						data-testid={`cert-check-${check.name}`}
					>
						<span
							// One width for all three words, so the check names line up.
							className={`w-18 justify-center ${
								check.result === "failed"
									? "pk-tag pk-tag--error"
									: check.result === "warning"
										? "pk-tag pk-tag--warning"
										: "pk-tag"
							}`}
						>
							{check.result === "failed"
								? "Failed"
								: check.result === "warning"
									? "Warning"
									: "Passed"}
						</span>
						<span>
							<span className="font-semibold">{PREFLIGHT_LABEL[check.name]}</span>
							{check.message ? (
								<span className="block text-ink-muted [overflow-wrap:anywhere]">
									{check.message}
								</span>
							) : null}
						</span>
					</li>
				))}
			</ul>
		</>
	);
}
