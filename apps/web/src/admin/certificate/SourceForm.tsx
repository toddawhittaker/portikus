import {
	type AdminCertificate,
	type CertificatePreflight,
	type CertificateSettings,
	type CertificateSource,
	DNS_PROVIDER_FIELDS,
	type DnsProvider,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	CONTROL_CLASS,
	ConfirmDialog,
	ConfirmDialogRoot,
	FIELD_CLASS,
	HINT_CLASS,
	LABEL_CLASS,
	Select,
	TextField,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/request.js";
import { errorText } from "../SettingsTab.js";
import {
	type CertificateForm,
	type ChallengeMode,
	DIRECTORY_CHOICES,
	DIRECTORY_LABEL,
	type DirectoryChoice,
	FIELD_ID,
	fieldLabel,
	hmacStored,
	initialForm,
	keyStored,
	PREFLIGHT_LABEL,
	PROVIDER_LABEL,
	PROVIDERS,
	pemProblem,
	plainValue,
	secretStored,
	secretValue,
	testIsReal,
	toSettings,
	type UploadDraft,
	uploadRefusalField,
	uploadRefusalText,
	validate,
	withPlain,
	withSecret,
} from "./form.js";
import { usePreflight, useRequestCertificateJob } from "./queries.js";

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

const MODES: { value: ChallengeMode; label: string; text: string }[] = [
	{
		value: "dns01",
		label: "DNS-01",
		text: "Proves the name with a DNS record your DNS provider adds. One wildcard certificate covers the site and every preview name.",
	},
	{
		value: "http01",
		label: "HTTP-01",
		text: "Proves the name with a file this server serves on port 80, which must be open to the internet. Each preview name gets its own certificate the first time it is opened.",
	},
];

const SECRET_KEPT = "Set. Leave blank to keep it.";
const SECRET_NONE = "Not set.";

/** The choice of certificate source and its settings, with Test only and Apply (Epic 27 R11). */
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

	/** Run the pre-flight for ACME, then go on only when nothing failed (Epic 27 R10). */
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
			// The API names the upload check that failed (Epic 27 R9).
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
			className="grid max-w-[72ch] gap-5"
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

/** A radio group with a sentence under each choice, as the egress entry dialog has. */
function Choice<T extends string>({
	legend,
	name,
	value,
	choices,
	onChange,
}: {
	legend: string;
	name: string;
	value: T;
	choices: { value: T; label: string; text: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="m-0 grid gap-2 border-0 p-0">
			<legend className="mb-2 p-0 font-medium text-[13px] text-ink">{legend}</legend>
			{choices.map((choice) => {
				const id = `${name}-${choice.value}`;
				// The whole row stays clickable; the name is the short label, the sentence its description.
				return (
					<label key={choice.value} className="flex items-start gap-2 text-[13px]">
						<input
							type="radio"
							name={name}
							className="pk-focus-ring mt-0.5"
							checked={value === choice.value}
							data-testid={id}
							aria-labelledby={`${id}-label`}
							aria-describedby={`${id}-text`}
							onChange={() => onChange(choice.value)}
						/>
						<span>
							<span id={`${id}-label`}>{choice.label}</span>
							<span className="block text-ink-muted" id={`${id}-text`}>
								{choice.text}
							</span>
						</span>
					</label>
				);
			})}
		</fieldset>
	);
}

function AcmeFields({
	form,
	errors,
	data,
	onChange,
	onEdit,
}: {
	form: CertificateForm;
	errors: Record<string, string>;
	data: AdminCertificate;
	onChange: (form: CertificateForm) => void;
	onEdit: (id: string) => void;
}) {
	const settings = data.settings;
	const fields = DNS_PROVIDER_FIELDS[form.provider];
	const hmacSet = hmacStored(settings);
	return (
		<div className="grid gap-5">
			<Select
				id="cert-directory"
				label="ACME directory"
				value={form.directory}
				options={DIRECTORY_CHOICES.map((choice) => ({
					value: choice,
					label: DIRECTORY_LABEL[choice],
				}))}
				hint={
					form.directory === "letsencrypt-staging"
						? "Browsers do not trust staging certificates. Use it to try the settings, then switch to Let's Encrypt."
						: undefined
				}
				onValueChange={(v) => onChange({ ...form, directory: v as DirectoryChoice })}
			/>
			{form.directory === "custom" ? (
				<TextField
					id={FIELD_ID.customDirectory}
					label="Directory URL"
					mono
					type="url"
					autoComplete="off"
					spellCheck={false}
					placeholder="https://acme.example.edu/directory"
					value={form.customDirectory}
					error={errors[FIELD_ID.customDirectory]}
					onChange={(event) => {
						onEdit(FIELD_ID.customDirectory);
						onChange({ ...form, customDirectory: event.target.value });
					}}
				/>
			) : null}
			<TextField
				id={FIELD_ID.email}
				label="Account email"
				type="email"
				autoComplete="email"
				hint="The authority sends notices about this account here."
				value={form.email}
				error={errors[FIELD_ID.email]}
				onChange={(event) => {
					onEdit(FIELD_ID.email);
					onChange({ ...form, email: event.target.value });
				}}
			/>
			<fieldset className="m-0 grid gap-3 border-0 p-0">
				<legend className="mb-2 flex items-center gap-1 p-0 font-medium text-[13px] text-ink">
					External account binding (optional)
					<Toggletip label="external account binding">
						Some authorities, such as ZeroSSL and campus authorities, tie the account to
						you with a key ID and an HMAC key from their dashboard. Leave both blank for
						Let's Encrypt.
					</Toggletip>
				</legend>
				<TextField
					id={FIELD_ID.eabKeyId}
					label="Key ID"
					mono
					autoComplete="off"
					spellCheck={false}
					value={form.eabKeyId}
					error={errors[FIELD_ID.eabKeyId]}
					onChange={(event) => {
						onEdit(FIELD_ID.eabKeyId);
						onChange({ ...form, eabKeyId: event.target.value });
					}}
				/>
				<TextField
					id={FIELD_ID.eabHmacKey}
					label="HMAC key"
					type="password"
					mono
					autoComplete="off"
					spellCheck={false}
					hint={hmacSet ? SECRET_KEPT : SECRET_NONE}
					data-testid="cert-eab-hmac"
					value={form.eabHmacKey}
					error={errors[FIELD_ID.eabHmacKey]}
					onChange={(event) => {
						onEdit(FIELD_ID.eabHmacKey);
						onChange({ ...form, eabHmacKey: event.target.value });
					}}
				/>
			</fieldset>
			<Choice
				legend="How the authority checks the name"
				name="cert-mode"
				value={form.mode}
				choices={MODES}
				onChange={(mode) => onChange({ ...form, mode })}
			/>
			{form.mode === "dns01" ? (
				<fieldset className="m-0 grid gap-3 border-0 p-0" data-testid="cert-dns">
					<legend className="mb-2 p-0 font-medium text-[13px] text-ink">
						DNS provider
					</legend>
					<Select
						id="cert-provider"
						label="Provider"
						value={form.provider}
						options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
						hint={`The credentials need permission to edit DNS records for ${data.siteName}.`}
						onValueChange={(v) => onChange({ ...form, provider: v as DnsProvider })}
					/>
					{fields.plain.map((name) => (
						<TextField
							key={`${form.provider}-${name}`}
							id={FIELD_ID.provider(name)}
							label={fieldLabel(name)}
							mono
							autoComplete="off"
							spellCheck={false}
							value={plainValue(form, name)}
							error={errors[FIELD_ID.provider(name)]}
							onChange={(event) => {
								onEdit(FIELD_ID.provider(name));
								onChange(withPlain(form, name, event.target.value));
							}}
						/>
					))}
					{fields.secret.map((name) => (
						<SecretField
							key={`${form.provider}-${name}`}
							id={FIELD_ID.provider(name)}
							label={fieldLabel(name)}
							multiline={name === "service_account_json"}
							set={secretStored(settings, form.provider, name)}
							value={secretValue(form, name)}
							error={errors[FIELD_ID.provider(name)]}
							onChange={(value) => {
								onEdit(FIELD_ID.provider(name));
								onChange(withSecret(form, name, value));
							}}
						/>
					))}
				</fieldset>
			) : (
				<p className={HINT_CLASS} data-testid="cert-http01-note">
					Port 80 must reach this server from the internet, for {data.siteName} and
					every preview name. The checks test it from this server, so a firewall that
					blocks only outside traffic shows up in Test only, not in the checks.
				</p>
			)}
		</div>
	);
}

/** A write-only field: it starts blank, and says whether a value is stored. */
function SecretField({
	id,
	label,
	multiline,
	set,
	value,
	error,
	onChange,
}: {
	id: string;
	label: string;
	multiline: boolean;
	set: boolean;
	value: string;
	error: string | undefined;
	onChange: (value: string) => void;
}) {
	const hint = set ? SECRET_KEPT : SECRET_NONE;
	if (!multiline) {
		return (
			<TextField
				id={id}
				label={label}
				type="password"
				mono
				autoComplete="off"
				spellCheck={false}
				hint={hint}
				value={value}
				error={error}
				onChange={(event) => onChange(event.target.value)}
			/>
		);
	}
	return (
		<div className={FIELD_CLASS}>
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<textarea
				id={id}
				className={`${CONTROL_CLASS} h-auto min-h-24 py-2 font-mono aria-[invalid=true]:border-status-error`}
				rows={4}
				autoComplete="off"
				spellCheck={false}
				value={value}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-err ${id}-hint` : `${id}-hint`}
				onChange={(event) => onChange(event.target.value)}
			/>
			{error ? (
				<p className="m-0 text-[12px] text-status-error leading-4" id={`${id}-err`}>
					{error}
				</p>
			) : null}
			<p className={HINT_CLASS} id={`${id}-hint`}>
				{hint}
			</p>
		</div>
	);
}

function UploadFields({
	which,
	legend,
	covers,
	keySet,
	errors,
	onChange,
	onEdit,
}: {
	which: "site" | "preview";
	legend: string;
	covers: string;
	keySet: boolean;
	errors: Record<string, string>;
	onChange: (part: keyof UploadDraft, text: string) => void;
	onEdit: (id: string) => void;
}) {
	const part = (name: keyof UploadDraft, label: string, hint?: string) => {
		const id = FIELD_ID.upload(which, name);
		return (
			<FileField
				id={id}
				label={label}
				hint={hint}
				error={errors[id]}
				onText={(text) => {
					onEdit(id);
					onChange(name, text);
				}}
			/>
		);
	};
	return (
		<fieldset
			className="m-0 grid gap-3 border-0 p-0"
			data-testid={`cert-upload-${which}`}
		>
			<legend className="mb-1 p-0 font-medium text-[13px] text-ink">{legend}</legend>
			<p className={HINT_CLASS}>PEM files, as most authorities send them. {covers}</p>
			{part("certificate", "Certificate")}
			{part(
				"chain",
				"Intermediate chain (optional)",
				"Leave out if the certificate file already holds the chain.",
			)}
			{part("privateKey", "Private key", keySet ? SECRET_KEPT : SECRET_NONE)}
		</fieldset>
	);
}

function FileField({
	id,
	label,
	hint,
	error,
	onText,
}: {
	id: string;
	label: string;
	hint?: string;
	error: string | undefined;
	onText: (text: string) => void;
}) {
	const [problem, setProblem] = useState<string | null>(null);
	const shown = problem ?? error;
	const describedBy =
		[shown ? `${id}-err` : null, hint ? `${id}-hint` : null]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<div className={FIELD_CLASS}>
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<input
				id={id}
				type="file"
				accept=".pem,.crt,.cer,.key,application/x-pem-file"
				// The picker button drawn as a secondary Button, so it reads as one.
				className="pk-focus-ring text-[13px] text-ink-muted file:mr-3 file:h-[var(--pk-control)] file:cursor-pointer file:rounded-sm file:border file:border-line-strong file:border-solid file:bg-surface-raised file:px-[var(--pk-pad)] file:font-semibold file:text-ink hover:file:bg-surface-hover"
				aria-invalid={shown ? true : undefined}
				aria-describedby={describedBy}
				onChange={async (event) => {
					const file = event.target.files?.[0];
					const text = file ? await file.text() : "";
					setProblem(pemProblem(text));
					onText(text);
				}}
			/>
			{shown ? (
				<p
					className="m-0 text-[12px] text-status-error leading-4"
					id={`${id}-err`}
					// A problem found on picking is read out at once (SPEC.md section 25.8).
					role={problem ? "alert" : undefined}
				>
					{shown}
				</p>
			) : null}
			{hint ? (
				<p className={HINT_CLASS} id={`${id}-hint`}>
					{hint}
				</p>
			) : null}
		</div>
	);
}
