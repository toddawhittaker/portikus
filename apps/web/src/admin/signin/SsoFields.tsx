import type { EntraRoleSource, SigninProvider, SigninView } from "@portikus/contracts";
import { TextField } from "@portikus/ui";
import { Choice } from "../certificate/Choice.js";
import { TextAreaField } from "../TextAreaField.js";
import {
	FIELD_ID,
	PROVIDER_LABEL,
	type SsoForm,
	secretRequired,
	usesGroups,
} from "./ssoForm.js";

const PROVIDERS: { value: SigninProvider; label: string; text: string }[] = [
	{
		value: "dex",
		label: PROVIDER_LABEL.dex,
		text: "People sign in with the local accounts administrators create on the Users tab.",
	},
	{
		value: "entra",
		label: PROVIDER_LABEL.entra,
		text: "People use their school Microsoft accounts. Register Portikus as an application in Entra first.",
	},
	{
		value: "google",
		label: PROVIDER_LABEL.google,
		text: "People use their school Google accounts from the domains you list.",
	},
	{
		value: "oidc",
		label: PROVIDER_LABEL.oidc,
		text: "Such as Okta, Keycloak or Shibboleth. Roles come from the groups you name.",
	},
];

const ENTRA_ROLE_SOURCES: { value: EntraRoleSource; label: string; text: string }[] = [
	{
		value: "appRoles",
		label: "App roles",
		text: "Assign the Portikus.Student, Portikus.Instructor and Portikus.Administrator app roles in Entra.",
	},
	{
		value: "groups",
		label: "Groups assigned to the application",
		text: 'Name three security groups by object ID. Set the token to send "Groups assigned to the application".',
	},
];

/** Why each provider's groups must be ones people cannot add themselves to (SPEC.md 5.1). */
const GROUPS_NOTE: Partial<Record<SigninProvider, string>> = {
	entra:
		"Use groups only administrators can change. Assign all three to the Portikus application. Each person still needs an invitation.",
	google:
		"Use groups people cannot join by themselves. Each person still needs an invitation.",
};

interface FieldsProps {
	form: SsoForm;
	view: SigninView | null;
	errors: Record<string, string>;
	onChange: (form: SsoForm) => void;
	onEdit: (id: string) => void;
}

/** The provider picker and the chosen provider's fields. */
export function SsoFields({ form, view, errors, onChange, onEdit }: FieldsProps) {
	function text(
		field: Exclude<keyof SsoForm, "provider">,
		label: string,
		hint?: string,
	) {
		const id = FIELD_ID[field];
		return (
			<TextField
				id={id}
				label={label}
				mono
				hint={hint}
				error={errors[id]}
				value={form[field]}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => {
					onChange({ ...form, [field]: event.target.value });
					onEdit(id);
				}}
			/>
		);
	}
	const redirect = `${window.location.origin}/dex/callback`;
	const keepsSecret = !secretRequired(form, view);
	return (
		<div className="grid gap-5 @3xl:grid-cols-[minmax(0,22rem)_minmax(0,40rem)] @3xl:gap-x-10">
			<Choice
				legend="Provider"
				name="sso-provider"
				value={form.provider}
				choices={PROVIDERS}
				onChange={(provider) => onChange({ ...form, provider })}
			/>
			{form.provider === "dex" ? (
				<p className="pk-text-compact pk-muted m-0" data-testid="sso-dex-note">
					No single sign-on: only local accounts sign in. Nothing else to set.
				</p>
			) : (
				<div className="grid min-w-0 content-start gap-4">
					{form.provider === "entra" ? (
						<>
							{text(
								"entraTenantId",
								"Tenant ID",
								"The Directory (tenant) ID on the app registration's Overview page.",
							)}
							<Choice
								legend="Roles from"
								name={FIELD_ID.entraRoleSource}
								value={form.entraRoleSource}
								choices={ENTRA_ROLE_SOURCES}
								onChange={(entraRoleSource) => onChange({ ...form, entraRoleSource })}
							/>
						</>
					) : null}
					{form.provider === "google" ? (
						<>
							{text(
								"googleDomains",
								"Domains",
								"The domains whose accounts may sign in, such as example.edu. Separate more than one with spaces.",
							)}
							{text(
								"googleAdminEmail",
								"Administrator to read groups as",
								"Optional. Blank sets roles only on the Users tab. Give an administrator whose role can only read groups.",
							)}
						</>
					) : null}
					{form.provider === "oidc"
						? text(
								"oidcIssuer",
								"Issuer URL",
								"The provider's https issuer address. Portikus finds the rest from it.",
							)
						: null}
					{text(
						"clientId",
						"Client ID",
						`The ID the provider gave Portikus. Register ${redirect} as its redirect address.`,
					)}
					<TextField
						id={FIELD_ID.clientSecret}
						label="Client secret"
						type="password"
						autoComplete="new-password"
						hint={
							keepsSecret
								? "Set. Leave blank to keep it."
								: "Required. It is never shown again once saved."
						}
						error={errors[FIELD_ID.clientSecret]}
						value={form.clientSecret}
						onChange={(event) => {
							onChange({ ...form, clientSecret: event.target.value });
							onEdit(FIELD_ID.clientSecret);
						}}
					/>
					{form.provider === "google" && usesGroups(form) ? (
						<TextAreaField
							id={FIELD_ID.googleKey}
							label="Service account key"
							rows={4}
							mono
							hint={
								view?.googleKeySet
									? "Set. Leave blank to keep it."
									: "Required. Paste the JSON key of a service account allowed only to read groups. It is never shown again."
							}
							error={errors[FIELD_ID.googleKey]}
							value={form.googleKey}
							onChange={(value) => {
								onChange({ ...form, googleKey: value });
								onEdit(FIELD_ID.googleKey);
							}}
						/>
					) : null}
					{usesGroups(form) ? (
						<fieldset className="m-0 grid min-w-0 gap-4 border-0 p-0">
							<legend className="pk-text-body m-0 mb-2 p-0 font-semibold">
								Roles from groups
							</legend>
							{GROUPS_NOTE[form.provider] ? (
								<p
									className="pk-text-compact pk-muted m-0"
									data-testid="sso-groups-note"
								>
									{GROUPS_NOTE[form.provider]}
								</p>
							) : null}
							{form.provider === "oidc"
								? text(
										"groupsClaim",
										"Groups claim",
										"The claim that lists a person's groups. Most providers use groups.",
									)
								: null}
							{text("studentGroup", "Students' group", groupHint(form.provider))}
							{text("instructorGroup", "Instructors' group", groupHint(form.provider))}
							{text("adminGroup", "Administrators' group", groupHint(form.provider))}
						</fieldset>
					) : null}
				</div>
			)}
		</div>
	);
}

function groupHint(provider: SigninProvider): string | undefined {
	if (provider === "entra")
		return "The group's object ID, from its Overview page in Entra.";
	if (provider === "google") return "The group's email address.";
	return undefined;
}
