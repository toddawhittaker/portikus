import type { SigninProvider, SigninView } from "@portikus/contracts";
import { TextField } from "@portikus/ui";
import { Choice } from "../certificate/Choice.js";
import { FIELD_ID, PROVIDER_LABEL, type SsoForm, secretRequired } from "./ssoForm.js";

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
					{form.provider === "entra"
						? text(
								"entraTenantId",
								"Tenant ID",
								"The Directory (tenant) ID on the app registration's Overview page.",
							)
						: null}
					{form.provider === "google"
						? text(
								"googleDomains",
								"Domains",
								"The domains whose accounts may sign in, such as example.edu. Separate more than one with spaces.",
							)
						: null}
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
					{form.provider === "oidc" ? (
						<fieldset className="m-0 grid min-w-0 gap-4 border-0 p-0">
							<legend className="pk-text-body m-0 mb-2 p-0 font-semibold">
								Roles from groups
							</legend>
							{text(
								"groupsClaim",
								"Groups claim",
								"The claim that lists a person's groups. Most providers use groups.",
							)}
							{text("studentGroup", "Students' group")}
							{text("instructorGroup", "Instructors' group")}
							{text("adminGroup", "Administrators' group")}
						</fieldset>
					) : null}
				</div>
			)}
		</div>
	);
}
