import {
	type AdminCertificate,
	DNS_PROVIDER_FIELDS,
	type DnsProvider,
} from "@portikus/contracts";
import { Checkbox, HINT_CLASS, Select, TextField, Toggletip } from "@portikus/ui";
import type { ReactNode } from "react";
import { TextAreaField } from "../TextAreaField.js";
import { Choice } from "./Choice.js";
import {
	type CertificateForm,
	type ChallengeMode,
	DIRECTORY_CHOICES,
	DIRECTORY_LABEL,
	type DirectoryChoice,
	type DnsAccount,
	FIELD_ID,
	fieldLabel,
	hmacStored,
	PROVIDER_LABEL,
	PROVIDERS,
	plainValue,
	providerOf,
	SECRET_KEPT,
	SECRET_NONE,
	secretStored,
	secretValue,
	withPlain,
	withProvider,
	withSecret,
} from "./form.js";

const MODES: { value: ChallengeMode; label: string; text: string }[] = [
	{
		value: "dns01",
		label: "DNS-01",
		text: "Proves the name with a DNS record your DNS provider adds. The site gets one certificate, and every preview name is covered by one wildcard certificate.",
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
				<>
					<DnsAccountFields
						account="site"
						legend="DNS provider"
						testId="cert-dns"
						selectId="cert-provider"
						hint={`The credentials need permission to edit DNS records for ${data.siteName}.`}
						form={form}
						errors={errors}
						settings={settings}
						onChange={onChange}
						onEdit={onEdit}
					/>
					<Checkbox
						label="Preview domain in its own DNS zone"
						description={`Use a second DNS account when ${data.previewSuffix} is not in the same DNS zone as ${data.siteName}. Turn this off and apply to remove the stored preview account.`}
						checked={form.previewDns}
						onChange={(event) =>
							onChange({ ...form, previewDns: event.target.checked })
						}
					/>
					{form.previewDns ? (
						<DnsAccountFields
							account="preview"
							legend="Preview domain DNS provider"
							testId="cert-dns-preview"
							selectId="cert-preview-provider"
							hint={`The credentials need permission to edit DNS records for ${data.previewSuffix}.`}
							form={form}
							errors={errors}
							settings={settings}
							onChange={onChange}
							onEdit={onEdit}
						/>
					) : null}
				</>
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

/** One DNS account: its provider, that provider's plain fields, and its write-only secrets. */
function DnsAccountFields({
	account,
	legend,
	testId,
	selectId,
	hint,
	form,
	errors,
	settings,
	onChange,
	onEdit,
}: {
	account: DnsAccount;
	legend: string;
	testId: string;
	selectId: string;
	hint: string;
	form: CertificateForm;
	errors: Record<string, string>;
	settings: AdminCertificate["settings"];
	onChange: (form: CertificateForm) => void;
	onEdit: (id: string) => void;
}) {
	const provider = providerOf(form, account);
	const fields = DNS_PROVIDER_FIELDS[provider];
	// The preview account's fields repeat the site's labels, so a screen
	// reader hears which account each belongs to (SPEC.md section 25.8).
	const named = (label: string) =>
		account === "preview" ? (
			<>
				<span className="sr-only">Preview domain</span> {label}
			</>
		) : (
			label
		);
	return (
		<fieldset className="m-0 grid gap-3 border-0 p-0" data-testid={testId}>
			<legend className="mb-2 p-0 font-medium text-[13px] text-ink">{legend}</legend>
			<Select
				id={selectId}
				label={named("Provider")}
				value={provider}
				options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
				hint={hint}
				onValueChange={(v) => onChange(withProvider(form, v as DnsProvider, account))}
			/>
			{fields.plain.map((name) => {
				const id = FIELD_ID.provider(name, account);
				return (
					<TextField
						key={`${provider}-${name}`}
						id={id}
						label={named(fieldLabel(name))}
						mono
						autoComplete="off"
						spellCheck={false}
						value={plainValue(form, name, account)}
						error={errors[id]}
						onChange={(event) => {
							onEdit(id);
							onChange(withPlain(form, name, event.target.value, account));
						}}
					/>
				);
			})}
			{fields.secret.map((name) => {
				const id = FIELD_ID.provider(name, account);
				return (
					<SecretField
						key={`${provider}-${name}`}
						id={id}
						label={named(fieldLabel(name))}
						multiline={name === "service_account_json"}
						set={secretStored(settings, provider, name, account)}
						value={secretValue(form, name, account)}
						error={errors[id]}
						onChange={(value) => {
							onEdit(id);
							onChange(withSecret(form, name, value, account));
						}}
					/>
				);
			})}
		</fieldset>
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
	label: ReactNode;
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
		<TextAreaField
			id={id}
			label={label}
			rows={4}
			mono
			hint={hint}
			error={error}
			value={value}
			onChange={onChange}
		/>
	);
}
