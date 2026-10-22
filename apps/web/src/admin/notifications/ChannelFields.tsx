import {
	type AlertChannelKind,
	type AlertChannelResult,
	MAX_ALERT_EMAIL_RECIPIENTS,
	type NotificationSettingsView,
} from "@portikus/contracts";
import { Button, Checkbox, HINT_CLASS, Select, TextField } from "@portikus/ui";
import type { ReactNode } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { TextAreaField } from "../TextAreaField.js";
import {
	CHANNEL_NAME,
	type ClearWarnings,
	channelChanged,
	FIELD_ID,
	type FormErrors,
	type NotifyForm,
	ntfyTokenWarning,
	SMTP_PASSWORD_WARNING,
} from "./form.js";
import { useTestAlert } from "./queries.js";

const KEPT = "Set. Leave blank to keep it.";
const NONE = "Not set.";

/** What each channel does, under its switch. */
const CHANNEL_LINE: Record<AlertChannelKind, string> = {
	email: "Sends each alert through the mail server above.",
	pushover: "Pushes each alert to phones through pushover.net.",
	ntfy: "Publishes each alert to an ntfy topic, on ntfy.sh or your own server.",
	teams:
		"Posts each alert as a card to a Teams channel, through a Workflows webhook that posts to a channel when it receives a request.",
	webhook:
		"Posts each alert as JSON with a text field, which Slack, Mattermost, Rocket.Chat, Google Chat and Zulip read. For Discord, use its Slack-compatible URL ending in /slack.",
};

const SWITCH_LABEL: Record<AlertChannelKind, string> = {
	email: "Send alerts by email",
	pushover: "Send alerts to Pushover",
	ntfy: "Send alerts to ntfy",
	teams: "Send alerts to Microsoft Teams",
	webhook: "Send alerts to a webhook",
};

const TEST_LABEL: Record<AlertChannelKind, string> = {
	email: "Send test email",
	pushover: "Send test to Pushover",
	ntfy: "Send test to ntfy",
	teams: "Send test to Teams",
	webhook: "Send test to the webhook",
};

/** The sender's short failure codes, in the page's words. */
function failureText(error: string | undefined): string {
	if (!error) return "it failed";
	if (/^HTTP \d{3}$/.test(error)) return `the receiver answered ${error}`;
	const known: Record<string, string> = {
		unreachable: "this server could not reach it",
		"timed out": "it did not answer within 10 seconds",
		"authentication failed": "the mail server refused the user name or password",
		"TLS failed": "a TLS connection to the mail server could not be made",
		rejected: "the mail server refused the message or a recipient",
		"not configured": "it is not saved yet",
	};
	return known[error] ?? error;
}

function testResultText(results: AlertChannelResult[]): string {
	const result = results[0];
	if (!result) return "Not sent: this channel is not saved yet.";
	return result.ok
		? "Sent. Check that it arrived."
		: `Not sent: ${failureText(result.error)}.`;
}

/** The API allows a few tests a minute per administrator. */
function testErrorText(error: unknown): string {
	if (error instanceof ApiError && error.status === 429) {
		return "Not sent: too many test alerts just now. Try again in a minute.";
	}
	return errorText(error);
}

interface ChannelProps {
	form: NotifyForm;
	view: NotificationSettingsView;
	errors: FormErrors;
	onChange: (form: NotifyForm) => void;
	onEdit: (id: string) => void;
	/** The "will be cleared" warnings, worked out when a field that causes one loses focus. */
	warned: ClearWarnings;
	/** Work the warnings out again, from `next` when the change is not in `form` yet. */
	onCheck: (next?: NotifyForm) => void;
	/** "Not saved. Was …" for a field such as "email.host", or null while it is saved. */
	notSaved: (field: string) => ReactNode;
}

/** A field's hint with its "Not saved" line first; undefined when there is neither. */
function hintWith(notSaved: ReactNode, hint?: ReactNode): ReactNode {
	if (!notSaved && !hint) return undefined;
	return (
		<>
			{notSaved}
			{hint}
		</>
	);
}

/** The mail server account email and email alerts send through. */
export function MailServerFields({
	form,
	view,
	errors,
	onChange,
	onEdit,
	warned,
	onCheck,
	notSaved,
}: ChannelProps) {
	const email = form.email;
	const set = (patch: Partial<NotifyForm["email"]>) =>
		onChange({ ...form, email: { ...email, ...patch } });
	const passwordSet = view.smtp?.passwordSet === true;
	const cleared = warned.smtp;
	return (
		<div
			className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-start gap-3"
			data-testid="notify-smtp"
		>
			<TextField
				id={FIELD_ID.smtpHost}
				label="Host name"
				mono
				autoComplete="off"
				spellCheck={false}
				placeholder="smtp.example.edu"
				hint={hintWith(notSaved("email.host"))}
				value={email.host}
				error={errors[FIELD_ID.smtpHost]}
				onBlur={() => onCheck()}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpHost);
					set({ host: event.target.value });
				}}
			/>
			<Select
				id="notify-smtp-port"
				label="Port"
				hint={hintWith(notSaved("email.port"))}
				value={email.port}
				options={[
					{ value: "587", label: "587, STARTTLS" },
					{ value: "465", label: "465, TLS" },
				]}
				onValueChange={(value) => {
					// A choice is made at once, so its warning is worked out now.
					const next = {
						...form,
						email: { ...email, port: value === "465" ? "465" : "587" },
					} as NotifyForm;
					onChange(next);
					onCheck(next);
				}}
			/>
			<TextField
				id={FIELD_ID.smtpUsername}
				label="User name"
				autoComplete="off"
				spellCheck={false}
				hint={hintWith(
					notSaved("email.username"),
					"Leave blank if the server takes mail without signing in.",
				)}
				value={email.username}
				error={errors[FIELD_ID.smtpUsername]}
				onBlur={() => onCheck()}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpUsername);
					set({ username: event.target.value });
				}}
			/>
			<TextField
				id={FIELD_ID.smtpPassword}
				label="Password"
				type="password"
				autoComplete="new-password"
				spellCheck={false}
				data-testid="notify-smtp-password"
				hint={hintWith(
					notSaved("email.password"),
					cleared
						? "A password is stored."
						: passwordSet
							? `${KEPT} A new server, port or user name clears it.`
							: NONE,
				)}
				warning={cleared ? SMTP_PASSWORD_WARNING : undefined}
				value={email.password}
				error={errors[FIELD_ID.smtpPassword]}
				onBlur={() => onCheck()}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpPassword);
					set({ password: event.target.value });
				}}
			/>
			<TextField
				id={FIELD_ID.smtpFrom}
				label="From"
				autoComplete="off"
				placeholder="Portikus <portikus@example.edu>"
				hint={hintWith(notSaved("email.from"))}
				value={email.from}
				error={errors[FIELD_ID.smtpFrom]}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpFrom);
					set({ from: event.target.value });
				}}
			/>
		</div>
	);
}

/**
 * One alert channel: its switch, then its fields while it is ticked, and a
 * test of the saved settings once there are some.
 */
function Channel({
	kind,
	on,
	saved,
	changed,
	notSaved,
	onToggle,
	children,
}: {
	kind: AlertChannelKind;
	on: boolean;
	saved: boolean;
	/** The fields differ from the saved ones, which a test still uses. */
	changed: boolean;
	notSaved: ReactNode;
	onToggle: (on: boolean) => void;
	children: ReactNode;
}) {
	return (
		<li className="grid min-w-0 gap-3 py-2" data-testid={`notify-${kind}`}>
			<Checkbox
				label={SWITCH_LABEL[kind]}
				description={
					<>
						{CHANNEL_LINE[kind]}
						{notSaved}
					</>
				}
				checked={on}
				onChange={(event) => onToggle(event.target.checked)}
			/>
			{on || saved ? (
				// Lined up under the switch's words, past its box.
				<div className="grid max-w-[30rem] gap-3 ps-6">
					{on ? (
						<fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0">
							<legend className="sr-only">{CHANNEL_NAME[kind]} settings</legend>
							{children}
						</fieldset>
					) : null}
					{saved ? (
						<TestRow kind={kind} changed={changed} />
					) : (
						<p className={HINT_CLASS}>Save first, then send a test.</p>
					)}
				</div>
			) : null}
		</li>
	);
}

/** A test always goes to the saved settings: the proxy lets a host through only once it is saved (ADR 0052). */
function TestRow({ kind, changed }: { kind: AlertChannelKind; changed: boolean }) {
	const test = useTestAlert();
	const resultId = `notify-${kind}-test-result`;
	const noteId = `notify-${kind}-test-note`;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<Button
				data-testid={`notify-${kind}-test`}
				loading={test.isPending}
				aria-describedby={changed ? `${noteId} ${resultId}` : resultId}
				onClick={() => test.mutate(kind)}
			>
				{TEST_LABEL[kind]}
			</Button>
			{changed ? (
				<p className={HINT_CLASS} id={noteId} data-testid={noteId}>
					Tests use the saved settings.
				</p>
			) : null}
			{/* Always mounted, so a result that arrives later is read out (SPEC.md section 25.8). */}
			<output
				id={resultId}
				className="pk-text-compact min-w-0 [overflow-wrap:anywhere]"
				data-testid={`notify-${kind}-test-result`}
			>
				{test.isSuccess ? testResultText(test.data.results) : null}
				{test.isError ? testErrorText(test.error) : null}
			</output>
		</div>
	);
}

export function EmailChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
	notSaved,
}: ChannelProps) {
	const email = form.email;
	const set = (patch: Partial<NotifyForm["email"]>) =>
		onChange({ ...form, email: { ...email, ...patch } });
	return (
		<Channel
			kind="email"
			on={email.on}
			saved={view.alerts.email !== null}
			changed={channelChanged(form, view, "email")}
			notSaved={notSaved("email.on")}
			onToggle={(on) => set({ on })}
		>
			<TextAreaField
				id={FIELD_ID.emailTo}
				label="Send to"
				rows={3}
				hint={hintWith(
					notSaved("email.to"),
					`One address per line, up to ${MAX_ALERT_EMAIL_RECIPIENTS}.`,
				)}
				error={errors[FIELD_ID.emailTo]}
				value={email.to}
				onChange={(to) => {
					onEdit(FIELD_ID.emailTo);
					set({ to });
				}}
			/>
		</Channel>
	);
}

export function PushoverChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
	notSaved,
}: ChannelProps) {
	const pushover = form.pushover;
	const stored = view.alerts.pushover;
	const set = (patch: Partial<NotifyForm["pushover"]>) =>
		onChange({ ...form, pushover: { ...pushover, ...patch } });
	return (
		<Channel
			kind="pushover"
			on={pushover.on}
			saved={stored !== null}
			changed={channelChanged(form, view, "pushover")}
			notSaved={notSaved("pushover.on")}
			onToggle={(on) => set({ on })}
		>
			<TextField
				id={FIELD_ID.pushoverUserKey}
				label="User key"
				type="password"
				mono
				// Browsers ignore "off" on password fields and may fill in a saved sign-in.
				autoComplete="new-password"
				spellCheck={false}
				hint={hintWith(notSaved("pushover.userKey"), stored?.userKeySet ? KEPT : NONE)}
				value={pushover.userKey}
				error={errors[FIELD_ID.pushoverUserKey]}
				onChange={(event) => {
					onEdit(FIELD_ID.pushoverUserKey);
					set({ userKey: event.target.value });
				}}
			/>
			<TextField
				id={FIELD_ID.pushoverAppToken}
				label="API token"
				type="password"
				mono
				autoComplete="new-password"
				spellCheck={false}
				hint={hintWith(
					notSaved("pushover.appToken"),
					stored?.appTokenSet ? KEPT : NONE,
				)}
				value={pushover.appToken}
				error={errors[FIELD_ID.pushoverAppToken]}
				onChange={(event) => {
					onEdit(FIELD_ID.pushoverAppToken);
					set({ appToken: event.target.value });
				}}
			/>
		</Channel>
	);
}

/** A URL that holds its own secret: it is never shown again, only its host. */
function SecretUrlField({
	id,
	label,
	host,
	example,
	value,
	error,
	notSaved,
	onChange,
	onBlur,
}: {
	id: string;
	label: string;
	host: string | null;
	example: string;
	value: string;
	error: string | undefined;
	notSaved: ReactNode;
	onChange: (value: string) => void;
	onBlur?: () => void;
}) {
	return (
		<TextField
			id={id}
			label={label}
			type="url"
			mono
			autoComplete="off"
			spellCheck={false}
			// A stored URL is never shown, so an example there would read as the stored one.
			placeholder={host ? undefined : example}
			hint={hintWith(
				notSaved,
				host
					? `Set, sending to ${host}. Leave blank to keep it.`
					: "Not set. It is never shown again once saved, only its host.",
			)}
			value={value}
			error={error}
			onChange={(event) => onChange(event.target.value)}
			onBlur={onBlur}
		/>
	);
}

export function NtfyChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
	warned,
	onCheck,
	notSaved,
}: ChannelProps) {
	const ntfy = form.ntfy;
	const stored = view.alerts.ntfy;
	const set = (patch: Partial<NotifyForm["ntfy"]>) =>
		onChange({ ...form, ntfy: { ...ntfy, ...patch } });
	const cleared = warned.ntfy;
	return (
		<Channel
			kind="ntfy"
			on={ntfy.on}
			saved={stored !== null}
			changed={channelChanged(form, view, "ntfy")}
			notSaved={notSaved("ntfy.on")}
			onToggle={(on) => set({ on })}
		>
			<SecretUrlField
				id={FIELD_ID.ntfyUrl}
				label="Topic URL"
				host={stored?.host ?? null}
				example="https://ntfy.sh/your-topic"
				value={ntfy.url}
				error={errors[FIELD_ID.ntfyUrl]}
				notSaved={notSaved("ntfy.url")}
				onChange={(url) => {
					onEdit(FIELD_ID.ntfyUrl);
					set({ url });
				}}
				onBlur={() => onCheck()}
			/>
			<div className="grid gap-2">
				<TextField
					id={FIELD_ID.ntfyToken}
					label="Access token"
					type="password"
					mono
					autoComplete="new-password"
					spellCheck={false}
					data-testid="notify-ntfy-token"
					hint={hintWith(
						notSaved("ntfy.token"),
						cleared
							? "A token is stored."
							: stored?.tokenSet
								? `${KEPT} A topic URL on another server clears it.`
								: "Not set. Only for a topic that needs one.",
					)}
					warning={cleared ? ntfyTokenWarning(view) : undefined}
					onBlur={() => onCheck()}
					value={ntfy.token}
					disabled={ntfy.removeToken}
					error={errors[FIELD_ID.ntfyToken]}
					onChange={(event) => {
						onEdit(FIELD_ID.ntfyToken);
						set({ token: event.target.value });
					}}
				/>
				{stored?.tokenSet ? (
					<Checkbox
						label="Remove the stored token"
						description={notSaved("ntfy.removeToken")}
						checked={ntfy.removeToken}
						onChange={(event) => {
							const next = {
								...form,
								ntfy: { ...ntfy, removeToken: event.target.checked, token: "" },
							};
							onChange(next);
							onCheck(next);
						}}
					/>
				) : null}
			</div>
		</Channel>
	);
}

export function TeamsChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
	notSaved,
}: ChannelProps) {
	const stored = view.alerts.teams;
	return (
		<Channel
			kind="teams"
			on={form.teams.on}
			saved={stored !== null}
			changed={channelChanged(form, view, "teams")}
			notSaved={notSaved("teams.on")}
			onToggle={(on) => onChange({ ...form, teams: { ...form.teams, on } })}
		>
			<SecretUrlField
				id={FIELD_ID.teamsUrl}
				label="Workflows webhook URL"
				host={stored?.host ?? null}
				example="https://example.webhook.office.com/..."
				value={form.teams.url}
				error={errors[FIELD_ID.teamsUrl]}
				notSaved={notSaved("teams.url")}
				onChange={(url) => {
					onEdit(FIELD_ID.teamsUrl);
					onChange({ ...form, teams: { ...form.teams, url } });
				}}
			/>
		</Channel>
	);
}

export function WebhookChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
	notSaved,
}: ChannelProps) {
	const stored = view.alerts.webhook;
	return (
		<Channel
			kind="webhook"
			on={form.webhook.on}
			saved={stored !== null}
			changed={channelChanged(form, view, "webhook")}
			notSaved={notSaved("webhook.on")}
			onToggle={(on) => onChange({ ...form, webhook: { ...form.webhook, on } })}
		>
			<SecretUrlField
				id={FIELD_ID.webhookUrl}
				label="Webhook URL"
				host={stored?.host ?? null}
				example="https://hooks.slack.com/services/..."
				value={form.webhook.url}
				error={errors[FIELD_ID.webhookUrl]}
				notSaved={notSaved("webhook.url")}
				onChange={(url) => {
					onEdit(FIELD_ID.webhookUrl);
					onChange({ ...form, webhook: { ...form.webhook, url } });
				}}
			/>
		</Channel>
	);
}
