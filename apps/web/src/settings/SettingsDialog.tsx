/**
 * The student's settings (SPEC.md §13.5).
 * The left pane is the section list and a search box; the
 * right pane is the section that was chosen. Search reads that same list.
 * Every setting, the appearance included, is kept on the server per user
 * and saved the moment it changes; typed values (the auto-save
 * delay and the profile links) when the student leaves the field, presses
 * Enter or closes the dialog. The terminal color scheme is separate
 * from the page appearance. Profile shows the institution sign-in and a few
 * optional links and a picture, none of which is used for authorization.
 */
import {
	EDITOR_SETTINGS_DEFAULTS,
	GithubLink,
	type UpdateEditorSettingsRequest,
	type UpdateProfileRequest,
	WebsiteLink,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	Dialog,
	DialogRoot,
	HINT_CLASS,
	LABEL_CLASS,
	Select,
	TextField,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";
import {
	askDesktopPermission,
	desktopPermission,
	desktopSupported,
} from "../notifications/desktopSupport.js";
import { ChangePasswordForm } from "../password/ChangePasswordForm.js";
import {
	readThemePreference,
	rememberThemePreference,
	type ThemePreference,
} from "../shell/theme.js";
import { useMe } from "../useMe.js";
import { voiceSupported } from "../voice/useSpeechInput.js";
import { useProfile, useUpdateProfile } from "./profileQueries.js";
import { SETTINGS_SECTIONS, type SettingsControl, settingsHits } from "./sections.js";
import { currentZoneOption, timezoneGroups } from "./timezones.js";
import "./settings.css";

import { ChoiceField, ControlFrame, NavButton, useShowSetting } from "./controls.js";
import { EditorSchemeSelect } from "./EditorSchemeSelect.js";
import { checkLink, type LinkDraft, ProfilePane } from "./ProfilePane.js";
import { TwoFactorPane } from "./TwoFactorPane.js";

/** The delay a student may ask for, in seconds (contracts/settings.ts). */
const MIN_DELAY = 1;
const MAX_DELAY = 60;

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const NOTIFICATION_OPTIONS = [
	{ value: "ask", label: "Ask me" },
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
];

const PREFERENCES = SETTINGS_SECTIONS.find((section) => section.id === "preferences");
const PROFILE = SETTINGS_SECTIONS.find((section) => section.id === "profile");
const PASSWORD = SETTINGS_SECTIONS.find((section) => section.id === "password");
const TWO_FACTOR = SETTINGS_SECTIONS.find((section) => section.id === "two-factor");

/** The typed auto-save delay as seconds, or why it is refused. */
function parseDelay(delay: string): {
	parsedDelay: number | null;
	delayError: string | null;
} {
	const parsedDelay = /^\d+$/.test(delay.trim()) ? Number(delay.trim()) : null;
	const delayError =
		parsedDelay === null || parsedDelay < MIN_DELAY || parsedDelay > MAX_DELAY
			? `Give a whole number of seconds between ${MIN_DELAY} and ${MAX_DELAY}.`
			: null;
	return { parsedDelay, delayError };
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
	const settings = useEditorSettings();
	const update = useUpdateEditorSettings();
	const profile = useProfile();
	const updateProfile = useUpdateProfile();
	const [links, setLinks] = useState<LinkDraft>({});
	const [appearanceChoice, setAppearanceChoice] = useState<ThemePreference | null>(
		null,
	);
	const preference =
		appearanceChoice ?? settings.data?.appearance ?? readThemePreference();
	// While the settings are still loading the dialog shows the defaults, the
	// same values the editor is using until they arrive.
	const current = settings.data ?? EDITOR_SETTINGS_DEFAULTS;
	// The zone names the server accepts, so the select cannot offer one it
	// would reject. Empty until the settings arrive.
	const zones = settings.data?.timezones ?? [];

	// The draft is only what the student has touched, so a setting they left
	// alone still shows what the server sent once it arrives.
	const [draft, setDraft] = useState<UpdateEditorSettingsRequest>({});
	const [delayText, setDelayText] = useState<string | null>(null);
	const [sectionId, setSectionId] = useState(PREFERENCES?.id ?? "preferences");
	const [query, setQuery] = useState("");
	const [highlightId, setHighlightId] = useState<string | null>(null);
	// The browser's answer arrives after render, so the page keeps its own copy.
	const [permission, setPermission] = useState(desktopPermission);
	const [notificationNote, setNotificationNote] = useState("");
	const notificationsField = useRef<HTMLDivElement>(null);

	// The student may allow or block notifications in the browser's own
	// settings while this dialog is open; read the answer again on return.
	useEffect(() => {
		const reread = () => setPermission(desktopPermission());
		window.addEventListener("focus", reread);
		document.addEventListener("visibilitychange", reread);
		return () => {
			window.removeEventListener("focus", reread);
			document.removeEventListener("visibilitychange", reread);
		};
	}, []);

	const autoSave = draft.autoSave ?? current.autoSave;
	const wordWrap = draft.wordWrap ?? current.wordWrap;
	const terminalTheme = draft.terminalTheme ?? current.terminalTheme;
	const screenReaderMode = draft.screenReaderMode ?? current.screenReaderMode;
	const timezone = draft.timezone ?? current.timezone;
	const agentNotifications = draft.agentNotifications ?? current.agentNotifications;
	const editorScheme = draft.editorScheme ?? current.editorScheme;
	const delay =
		delayText ?? String(draft.autoSaveDelaySeconds ?? current.autoSaveDelaySeconds);

	const { parsedDelay, delayError } = parseDelay(delay);

	const me = useMe();
	const localPassword = me.status === "authenticated" && me.user.localPassword;
	const sections = SETTINGS_SECTIONS.filter(
		(section) =>
			(section.id !== PASSWORD?.id && section.id !== TWO_FACTOR?.id) || localPassword,
	);
	const filtering = query.trim() !== "";
	const hits = settingsHits(sections, query);
	const listed = filtering
		? sections.filter((section) => hits.some((hit) => hit.sectionId === section.id))
		: sections;

	useShowSetting(highlightId, sectionId === PREFERENCES?.id);

	// One save at a time, in order, so an older answer never lands after a
	// newer one and puts back a value the student has already changed.
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const [saving, setSaving] = useState(0);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// A save still in flight when the dialog closes reports its failure as a toast.
	const toast = useToast();
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	function enqueue(
		task: () => Promise<unknown>,
		onError?: () => void,
		onSuccess?: () => void,
	) {
		setSaving((count) => count + 1);
		queue.current = queue.current
			.then(task)
			.then(
				() => {
					setSaved(true);
					setSaveError(null);
					onSuccess?.();
				},
				(failure: unknown) => {
					const message = failure instanceof Error ? failure.message : "";
					if (!mounted.current) {
						toast.show({
							tone: "danger",
							title: "Your settings change was not saved",
							children: message || undefined,
						});
						return;
					}
					setSaved(false);
					setSaveError(message);
					onError?.();
				},
			)
			.finally(() => setSaving((count) => count - 1));
	}
	function send(body: UpdateEditorSettingsRequest, onError?: () => void) {
		enqueue(() => update.mutateAsync(body), onError);
	}

	/** Show the change at once and save it; a refused change goes back to what the server holds. */
	function change(body: UpdateEditorSettingsRequest) {
		setDraft((next) => ({ ...next, ...body }));
		send(body, () =>
			setDraft((next) => {
				const kept = { ...next };
				for (const key of Object.keys(body)) {
					delete kept[key as keyof UpdateEditorSettingsRequest];
				}
				return kept;
			}),
		);
	}

	// The delay is typed, so it is saved when the student leaves the field,
	// presses Enter or closes the dialog, not on every keystroke.
	function commitDelay() {
		if (delayError !== null || parsedDelay === null) return;
		if (parsedDelay === (draft.autoSaveDelaySeconds ?? current.autoSaveDelaySeconds)) {
			return;
		}
		change({ autoSaveDelaySeconds: parsedDelay });
	}

	// A link is saved like the delay; one that fails the check keeps its
	// inline error and is not sent. `sentLinks` stops a blur followed by
	// Close from sending the same text twice.
	const sentLinks = useRef<LinkDraft>({});
	function commitLinks() {
		const body: UpdateProfileRequest = {};
		const sent: LinkDraft = {};
		for (const [key, schema] of [
			["github", GithubLink],
			["website", WebsiteLink],
		] as const) {
			const text = links[key];
			const checked = checkLink(schema, text);
			if (text === undefined || checked.value === undefined) continue;
			if (text === sentLinks.current[key]) continue;
			if (checked.value === (profile.data?.[key] ?? null)) continue;
			body[key] = checked.value;
			sent[key] = text;
		}
		if (Object.keys(body).length === 0) return;
		sentLinks.current = { ...sentLinks.current, ...sent };
		enqueue(
			() => updateProfile.mutateAsync(body),
			() => {
				sentLinks.current = {};
			},
			() =>
				// Drop the draft only where it still holds what was sent.
				setLinks((next) => {
					const kept = { ...next };
					for (const key of Object.keys(sent) as (keyof LinkDraft)[]) {
						if (kept[key] === sent[key]) delete kept[key];
					}
					return kept;
				}),
		);
	}

	function close() {
		commitDelay();
		commitLinks();
		onClose();
	}

	let savedStatus = "";
	if (saving > 0) savedStatus = "Saving…";
	else if (saved) savedStatus = "Saved";

	// Arrowing through the radios must never open the browser's prompt, so a
	// radio saves only its own value; the prompt is the button's job.
	function chooseNotifications(value: string) {
		if (value === "ask" || value === "on" || value === "off") {
			setNotificationNote("");
			change({ agentNotifications: value });
		}
	}

	async function allowInBrowser() {
		await askDesktopPermission();
		const answer = desktopPermission();
		setPermission(answer);
		// The button goes once the browser has answered; keep focus in the dialog.
		if (answer !== "default") {
			notificationsField.current
				?.querySelector<HTMLInputElement>("input[type=radio]:checked")
				?.focus();
		}
		if (answer === "granted") {
			setNotificationNote("Desktop notifications are allowed in this browser.");
		} else if (answer === "denied") {
			setNotificationNote("Your browser blocked notifications.");
		} else {
			setNotificationNote("Your browser did not allow notifications yet.");
		}
	}

	function chooseAppearance(value: ThemePreference) {
		setAppearanceChoice(value);
		rememberThemePreference(value);
		send({ appearance: value });
	}

	// The sections share one scrolling pane, so a new one starts at its top.
	const pane = useRef<HTMLDivElement>(null);
	function open(nextSectionId: string, controlId: string | null) {
		if (nextSectionId !== sectionId && pane.current) pane.current.scrollTop = 0;
		setSectionId(nextSectionId);
		setHighlightId(controlId);
	}

	/** The open section's page. */
	function sectionPane() {
		if (sectionId === TWO_FACTOR?.id && localPassword) {
			return <TwoFactorPane highlightId={highlightId} />;
		}
		if (sectionId === PASSWORD?.id && localPassword) {
			return <PasswordPane highlightId={highlightId} />;
		}
		if (sectionId === PROFILE?.id) {
			return (
				<ProfilePane
					highlightId={highlightId}
					links={links}
					onLinksChange={setLinks}
					onCommitLinks={commitLinks}
				/>
			);
		}
		return (
			<div className="relative grid gap-6">
				{/* The section list already shows which section is open. */}
				<h2 id="settings-section-preferences" className="sr-only">
					Preferences
				</h2>
				{PREFERENCES?.groups.map((group) => (
					<section
						key={group.title}
						className="pk-settings-group grid gap-4"
						aria-labelledby={`settings-${group.title}`}
					>
						<h3 id={`settings-${group.title}`} className="pk-text-heading text-ink">
							{group.title}
						</h3>
						{group.controls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								{preferenceControl(control)}
							</ControlFrame>
						))}
					</section>
				))}
			</div>
		);
	}

	function notificationsControl(control: SettingsControl) {
		if (!desktopSupported()) {
			return (
				<p className="pk-text-compact m-0 text-ink-muted">
					This browser does not offer desktop notifications.
				</p>
			);
		}
		return (
			<div className="grid gap-2" ref={notificationsField}>
				<ChoiceField
					label={control.label}
					hint="Shows a notification outside the browser when a coding agent needs you or finishes and this page is not in front. It names the agent only."
					name="desktop-notifications"
					options={NOTIFICATION_OPTIONS}
					value={agentNotifications}
					onChange={chooseNotifications}
					alsoDescribedBy={
						permission === "denied" ? "desktop-notifications-blocked" : undefined
					}
				/>
				{agentNotifications === "on" && permission === "default" ? (
					<div>
						<Button
							size="sm"
							variant="secondary"
							data-testid="settings-notifications-allow"
							onClick={() => void allowInBrowser()}
						>
							Allow in this browser
						</Button>
					</div>
				) : null}
				{/* Always mounted, so a screen reader hears the outcome. */}
				<p
					className="sr-only"
					aria-live="polite"
					data-testid="settings-notifications-status"
				>
					{notificationNote}
				</p>
				{permission === "denied" ? (
					<p
						id="desktop-notifications-blocked"
						className="pk-text-compact m-0 text-ink-muted"
						data-testid="settings-notifications-blocked"
					>
						Your browser has blocked notifications for this site. Allow them in the site
						settings next to the address, then choose On.
					</p>
				) : null}
			</div>
		);
	}

	function preferenceControl(control: SettingsControl) {
		switch (control.id) {
			case "auto-save":
				return (
					<Checkbox
						label={control.label}
						description="Write the file a few seconds after you stop typing. Ctrl+S always saves now, whether this is on or off."
						checked={autoSave}
						onChange={(event) => change({ autoSave: event.target.checked })}
						className="pk-setting-autosave"
					/>
				);
			case "auto-save-delay":
				return (
					<TextField
						id="editor-autosave-delay"
						data-testid="editor-settings-delay"
						label={control.label}
						hint={`Seconds, ${MIN_DELAY} to ${MAX_DELAY}`}
						help={
							<Toggletip label={control.label}>
								How long Portikus waits after you stop typing before it saves. Ctrl+S
								always saves at once.
							</Toggletip>
						}
						className="w-48"
						inputMode="numeric"
						value={delay}
						disabled={!autoSave}
						error={delayError}
						onChange={(event) => setDelayText(event.target.value)}
						onBlur={commitDelay}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitDelay();
						}}
					/>
				);
			case "word-wrap":
				return (
					<Checkbox
						label={control.label}
						description="Wrap long lines instead of scrolling sideways."
						checked={wordWrap}
						onChange={(event) => change({ wordWrap: event.target.checked })}
						className="pk-setting-wordwrap"
					/>
				);
			case "terminal-colours":
				return (
					<div className="grid gap-1.5">
						<div className="flex h-[20px] min-w-0 items-center gap-1">
							<span className={LABEL_CLASS}>{control.label}</span>
							<Toggletip label={control.label}>
								You can switch one terminal from its three-dots menu. A program that is
								already running keeps the colors it started with until you restart it.
							</Toggletip>
						</div>
						<label className="pk-switch">
							<input
								type="checkbox"
								role="switch"
								aria-describedby="terminal-colours-hint"
								aria-checked={terminalTheme === "light"}
								checked={terminalTheme === "light"}
								onChange={(event) =>
									change({ terminalTheme: event.target.checked ? "light" : "dark" })
								}
							/>
							{/* A fixed name, so on and off mean light and dark. */}
							<span>Light terminal</span>
						</label>
						<p className={HINT_CLASS} id="terminal-colours-hint">
							What a new terminal starts with.
						</p>
					</div>
				);
			case "desktop-notifications":
				return notificationsControl(control);
			case "screen-reader-mode":
				return (
					// The tip sits beside the checkbox, not inside its label.
					<div className="flex min-w-0 items-start gap-1">
						<Checkbox
							label={control.label}
							description="Lets a screen reader read terminals, check output and the editor."
							checked={screenReaderMode}
							onChange={(event) => change({ screenReaderMode: event.target.checked })}
						/>
						<Toggletip label={control.label}>
							While it is on, busy terminals are slower, and text from dictation, an
							emoji picker or some on-screen keyboards does not reach a terminal.
						</Toggletip>
					</div>
				);
			case "voice-input":
				// A site switch, not a student choice (SPEC.md §25.10), so this only reports it.
				return (
					<p
						className="pk-text-compact m-0 text-ink-muted"
						data-testid="settings-voice-input"
					>
						{settings.data?.voiceInputEnabled === false
							? "Your administrator turned voice input off for this site."
							: !voiceSupported()
								? "This browser does not offer voice input."
								: "Hold the microphone button in a terminal or file, or Alt+Shift+M, to dictate."}
					</p>
				);
			case "keyboard-help":
				// The keys and the terminal and editor limits live on the Help page (SPEC.md §25.8).
				return (
					<p className="pk-text-compact m-0 text-ink-muted">
						Keys and screen-reader limits are in{" "}
						<a
							href="/help#student-keyboard"
							target="_blank"
							rel="noopener"
							data-testid="settings-keyboard-help"
							className="pk-focus-ring text-[var(--accent-text)] underline"
						>
							Help
							<span className="sr-only"> (opens in a new tab)</span>
						</a>
						.
					</p>
				);
			case "workspace-timezone":
				return (
					<>
						{/* Until the server's zone list arrives the select shows the zone
						    in use and takes no choice, rather than not being there at
						    all: an empty space where a setting belongs reads as a fault. */}
						<Select
							key={zones.length === 0 ? "waiting" : "loaded"}
							// The select reads its options once, so the arrival of the
							// server's list builds it again rather than leaving it showing
							// the placeholder.
							id="workspace-timezone"
							label={control.label}
							hint="The clock your terminals, logs and Git commits use."
							help={
								<Toggletip label={control.label}>
									New terminals use it at once. A shell that is already running keeps
									its zone until the workspace restarts. Programs in Docker containers
									keep their own clock.
								</Toggletip>
							}
							options={[currentZoneOption(timezone)]}
							groups={timezoneGroups(zones, timezone)}
							value={timezone}
							disabled={zones.length === 0}
							onValueChange={(value) => change({ timezone: value })}
						/>
						{settings.isError ? (
							<p
								className="pk-text-body text-status-error"
								data-testid="editor-settings-zones-error"
							>
								The list of timezones could not be loaded, so the zone cannot be changed
								here yet.
							</p>
						) : null}
					</>
				);
			case "colour-scheme":
				return (
					<ChoiceField
						label={control.label}
						hint="Light, dark, or follow this computer."
						name="page-appearance"
						options={APPEARANCE_OPTIONS}
						value={preference}
						onChange={(value) => chooseAppearance(value as ThemePreference)}
					/>
				);
			case "editor-colour-scheme":
				return (
					<EditorSchemeSelect
						label={control.label}
						value={editorScheme}
						onChange={(value) => change({ editorScheme: value })}
					/>
				);
			default:
				return null;
		}
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && close()}>
			<Dialog
				testId="dialog-editor-settings"
				className="pk-dialog--fit pk-settings-dialog"
				size="lg"
				title="Settings"
				description="Changes are saved as you make them and follow you to any browser you sign in from."
				footer={
					<>
						{/* Always there, so a screen reader hears each save. */}
						<p
							role="status"
							className="pk-text-compact m-0 mr-auto self-center text-ink-muted"
							data-testid="settings-saved"
						>
							{savedStatus}
						</p>
						<Button variant="secondary" data-testid="settings-close" onClick={close}>
							Close
						</Button>
					</>
				}
			>
				<div className="-mx-6 mt-2 grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] border-y border-line">
					<div className="flex min-h-0 flex-col gap-3 border-r border-line p-3">
						<TextField
							id="settings-search"
							label="Search"
							placeholder="Search settings"
							value={query}
							autoComplete="off"
							onChange={(event) => {
								const next = event.target.value;
								setQuery(next);
								if (next.trim() === "") setHighlightId(null);
							}}
						/>
						<nav
							aria-label="Settings sections"
							className="min-h-0 flex-1 overflow-y-auto"
						>
							{filtering && hits.length === 0 ? (
								<p className="pk-text-compact m-0 text-ink-muted">
									No matching settings.
								</p>
							) : (
								<ul className="m-0 grid list-none gap-1 p-0">
									{listed.map((section) => {
										const controlHits = hits.filter(
											(hit) => hit.sectionId === section.id && hit.controlId !== null,
										);
										return (
											<li key={section.id} className="grid gap-1">
												<NavButton
													current={sectionId === section.id && highlightId === null}
													onClick={() => open(section.id, null)}
												>
													{section.title}
												</NavButton>
												{filtering
													? controlHits.map((hit) => (
															<NavButton
																key={hit.controlId}
																nested
																current={
																	sectionId === section.id &&
																	highlightId === hit.controlId
																}
																onClick={() => open(section.id, hit.controlId)}
															>
																{hit.label}
															</NavButton>
														))
													: null}
											</li>
										);
									})}
								</ul>
							)}
						</nav>
					</div>
					<div className="flex min-h-0 min-w-0 flex-col">
						<div
							ref={pane}
							className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]"
						>
							{sectionPane()}
						</div>
						{saveError !== null ? (
							<p
								role="alert"
								className="pk-text-body px-4 pb-4 text-status-error"
								data-testid="editor-settings-error"
							>
								Your change was not saved. {saveError}
							</p>
						) : null}
					</div>
				</div>
			</Dialog>
		</DialogRoot>
	);
}

/** Settings, Password: change a Dex local password (SPEC.md section 5.3). */
function PasswordPane({ highlightId }: { highlightId: string | null }) {
	const [changed, setChanged] = useState(false);
	useShowSetting(highlightId, true);
	return (
		<section
			className="relative grid gap-4"
			aria-labelledby="settings-section-password"
		>
			{/* The section list already shows which section is open. */}
			<h2 id="settings-section-password" className="sr-only">
				Password
			</h2>
			<p className="pk-text-body m-0 text-ink-muted">
				The password you sign in with on the Portikus sign-in page. Changing it signs
				you out everywhere else.
			</p>
			<div id="settings-control-change-password">
				<ChangePasswordForm
					idPrefix="settings-password"
					onSubmitStart={() => setChanged(false)}
					onChanged={() => setChanged(true)}
				/>
			</div>
			<p
				role="status"
				className="pk-text-body m-0 text-ink"
				data-testid="password-changed"
			>
				{changed ? "Your password has been changed." : ""}
			</p>
		</section>
	);
}
