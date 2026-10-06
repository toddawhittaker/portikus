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
	FIELD_ID,
	type FormErrors,
	type NotifyForm,
	ntfyTokenCleared,
	smtpPasswordCleared,
} from "./form.js";
import { useTestAlert } from "./queries.js";

const KEPT = "Set. Leave blank to keep it.";
const NONE = "Not set.";

/** What each channel does, under its name. */
const CHANNEL_LINE: Record<AlertChannelKind, string> = {
	email:
		"Sends each alert by email through your mail server. TLS is required, and the server's certificate must be valid.",
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
}

/** One channel: its switch, its fields while it is on, and a test of the saved settings. */
function Channel({
	kind,
	on,
	saved,
	onToggle,
	children,
}: {
	kind: AlertChannelKind;
	on: boolean;
	saved: boolean;
	onToggle: (on: boolean) => void;
	children: ReactNode;
}) {
	const lineId = `notify-${kind}-line`;
	return (
		<fieldset
			className="m-0 grid min-w-0 gap-3 border-0 p-0"
			aria-describedby={lineId}
			data-testid={`notify-${kind}`}
		>
			<legend className="pk-text-body m-0 p-0 font-semibold">
				{CHANNEL_NAME[kind]}
			</legend>
			<p className="pk-text-compact pk-muted m-0" id={lineId}>
				{CHANNEL_LINE[kind]}
			</p>
			<Checkbox
				label={SWITCH_LABEL[kind]}
				checked={on}
				onChange={(event) => onToggle(event.target.checked)}
			/>
			{on ? (
				<div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] items-start gap-3">
					{children}
				</div>
			) : null}
			{saved ? (
				<TestRow kind={kind} />
			) : on ? (
				<p className={HINT_CLASS}>Save first, then send a test.</p>
			) : null}
		</fieldset>
	);
}

/** A test always goes to the saved settings: the proxy lets a host through only once it is saved (ADR 0052). */
function TestRow({ kind }: { kind: AlertChannelKind }) {
	const test = useTestAlert();
	const resultId = `notify-${kind}-test-result`;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<Button
				data-testid={`notify-${kind}-test`}
				loading={test.isPending}
				aria-describedby={resultId}
				onClick={() => test.mutate(kind)}
			>
				{TEST_LABEL[kind]}
			</Button>
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

export function EmailChannel({ form, view, errors, onChange, onEdit }: ChannelProps) {
	const email = form.email;
	const set = (patch: Partial<NotifyForm["email"]>) =>
		onChange({ ...form, email: { ...email, ...patch } });
	const passwordSet = view.smtp?.passwordSet === true;
	const cleared = smtpPasswordCleared(form, view);
	return (
		<Channel
			kind="email"
			on={email.on}
			saved={view.alerts.email !== null}
			onToggle={(on) => set({ on })}
		>
			<TextField
				id={FIELD_ID.smtpHost}
				label="Mail server"
				mono
				autoComplete="off"
				spellCheck={false}
				placeholder="smtp.example.edu"
				value={email.host}
				error={errors[FIELD_ID.smtpHost]}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpHost);
					set({ host: event.target.value });
				}}
			/>
			<Select
				id="notify-smtp-port"
				label="Port"
				value={email.port}
				options={[
					{ value: "587", label: "587, STARTTLS" },
					{ value: "465", label: "465, TLS" },
				]}
				onValueChange={(value) => set({ port: value === "465" ? "465" : "587" })}
			/>
			<TextField
				id={FIELD_ID.smtpUsername}
				label="User name"
				autoComplete="off"
				spellCheck={false}
				hint="Leave blank if the server takes mail without signing in."
				value={email.username}
				error={errors[FIELD_ID.smtpUsername]}
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
				hint={passwordSet ? `${KEPT} A new server, port or user name clears it.` : NONE}
				warning={
					cleared
						? "The server, port or user name changed, so the stored password will be cleared. Enter it again."
						: undefined
				}
				value={email.password}
				error={errors[FIELD_ID.smtpPassword]}
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
				value={email.from}
				error={errors[FIELD_ID.smtpFrom]}
				onChange={(event) => {
					onEdit(FIELD_ID.smtpFrom);
					set({ from: event.target.value });
				}}
			/>
			<RecipientsField
				value={email.to}
				error={errors[FIELD_ID.emailTo]}
				onChange={(to) => {
					onEdit(FIELD_ID.emailTo);
					set({ to });
				}}
			/>
		</Channel>
	);
}

function RecipientsField({
	value,
	error,
	onChange,
}: {
	value: string;
	error: string | undefined;
	onChange: (value: string) => void;
}) {
	return (
		// The list spans the whole row, beside nothing, so long addresses fit.
		<TextAreaField
			id={FIELD_ID.emailTo}
			label="Send to"
			className="col-span-full"
			rows={3}
			hint={`One address per line, up to ${MAX_ALERT_EMAIL_RECIPIENTS}.`}
			error={error}
			value={value}
			onChange={onChange}
		/>
	);
}

export function PushoverChannel({
	form,
	view,
	errors,
	onChange,
	onEdit,
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
			onToggle={(on) => set({ on })}
		>
			<TextField
				id={FIELD_ID.pushoverUserKey}
				label="User key"
				type="password"
				mono
				autoComplete="off"
				spellCheck={false}
				hint={stored?.userKeySet ? KEPT : NONE}
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
				autoComplete="off"
				spellCheck={false}
				hint={stored?.appTokenSet ? KEPT : NONE}
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
	onChange,
}: {
	id: string;
	label: string;
	host: string | null;
	example: string;
	value: string;
	error: string | undefined;
	onChange: (value: string) => void;
}) {
	return (
		<TextField
			id={id}
			// The URL is long; it takes the whole row.
			className="col-span-full"
			label={label}
			type="url"
			mono
			autoComplete="off"
			spellCheck={false}
			placeholder={example}
			hint={
				host
					? `Set, sending to ${host}. Leave blank to keep it.`
					: "Not set. It is never shown again once saved, only its host."
			}
			value={value}
			error={error}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

export function NtfyChannel({ form, view, errors, onChange, onEdit }: ChannelProps) {
	const ntfy = form.ntfy;
	const stored = view.alerts.ntfy;
	const set = (patch: Partial<NotifyForm["ntfy"]>) =>
		onChange({ ...form, ntfy: { ...ntfy, ...patch } });
	const cleared = ntfyTokenCleared(form, view);
	return (
		<Channel
			kind="ntfy"
			on={ntfy.on}
			saved={stored !== null}
			onToggle={(on) => set({ on })}
		>
			<SecretUrlField
				id={FIELD_ID.ntfyUrl}
				label="Topic URL"
				host={stored?.host ?? null}
				example="https://ntfy.sh/your-topic"
				value={ntfy.url}
				error={errors[FIELD_ID.ntfyUrl]}
				onChange={(url) => {
					onEdit(FIELD_ID.ntfyUrl);
					set({ url });
				}}
			/>
			<div className="grid gap-2">
				<TextField
					id={FIELD_ID.ntfyToken}
					label="Access token"
					type="password"
					mono
					autoComplete="off"
					spellCheck={false}
					data-testid="notify-ntfy-token"
					hint={
						stored?.tokenSet
							? `${KEPT} A topic URL on another server clears it.`
							: "Not set. Only for a topic that needs one."
					}
					warning={
						cleared
							? `The new URL is not on ${stored?.host}, so the stored token will be cleared. Enter it again if the new server needs one.`
							: undefined
					}
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
						checked={ntfy.removeToken}
						onChange={(event) => set({ removeToken: event.target.checked, token: "" })}
					/>
				) : null}
			</div>
		</Channel>
	);
}

export function TeamsChannel({ form, view, errors, onChange, onEdit }: ChannelProps) {
	const stored = view.alerts.teams;
	return (
		<Channel
			kind="teams"
			on={form.teams.on}
			saved={stored !== null}
			onToggle={(on) => onChange({ ...form, teams: { ...form.teams, on } })}
		>
			<SecretUrlField
				id={FIELD_ID.teamsUrl}
				label="Workflows webhook URL"
				host={stored?.host ?? null}
				example="https://example.webhook.office.com/..."
				value={form.teams.url}
				error={errors[FIELD_ID.teamsUrl]}
				onChange={(url) => {
					onEdit(FIELD_ID.teamsUrl);
					onChange({ ...form, teams: { ...form.teams, url } });
				}}
			/>
		</Channel>
	);
}

export function WebhookChannel({ form, view, errors, onChange, onEdit }: ChannelProps) {
	const stored = view.alerts.webhook;
	return (
		<Channel
			kind="webhook"
			on={form.webhook.on}
			saved={stored !== null}
			onToggle={(on) => onChange({ ...form, webhook: { ...form.webhook, on } })}
		>
			<SecretUrlField
				id={FIELD_ID.webhookUrl}
				label="Webhook URL"
				host={stored?.host ?? null}
				example="https://hooks.slack.com/services/..."
				value={form.webhook.url}
				error={errors[FIELD_ID.webhookUrl]}
				onChange={(url) => {
					onEdit(FIELD_ID.webhookUrl);
					onChange({ ...form, webhook: { ...form.webhook, url } });
				}}
			/>
		</Channel>
	);
}
