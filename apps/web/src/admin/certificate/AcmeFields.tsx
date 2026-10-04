import {
	type AdminCertificate,
	DNS_PROVIDER_FIELDS,
	type DnsProvider,
} from "@portikus/contracts";
import {
	CONTROL_CLASS,
	FIELD_CLASS,
	FieldMessages,
	fieldDescribedBy,
	HINT_CLASS,
	LABEL_CLASS,
	Select,
	TextField,
	Toggletip,
} from "@portikus/ui";
import { Choice } from "./Choice.js";
import {
	type CertificateForm,
	type ChallengeMode,
	DIRECTORY_CHOICES,
	DIRECTORY_LABEL,
	type DirectoryChoice,
	FIELD_ID,
	fieldLabel,
	hmacStored,
	PROVIDER_LABEL,
	PROVIDERS,
	plainValue,
	SECRET_KEPT,
	SECRET_NONE,
	secretStored,
	secretValue,
	withPlain,
	withSecret,
} from "./form.js";

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

/** The ACME settings: directory, account, and how the authority checks the name. */
export function AcmeFields({
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
				aria-describedby={fieldDescribedBy({ id, hint, error })}
				onChange={(event) => onChange(event.target.value)}
			/>
			<FieldMessages id={id} hint={hint} error={error} />
		</div>
	);
}
