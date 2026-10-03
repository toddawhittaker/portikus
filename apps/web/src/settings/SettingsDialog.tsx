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
import { ChangePasswordForm } from "../password/ChangePasswordForm.js";
import {
	readThemePreference,
	rememberThemePreference,
	type ThemePreference,
} from "../shell/theme.js";
import { useMe } from "../useMe.js";
import { useProfile, useUpdateProfile } from "./profileQueries.js";
import { SETTINGS_SECTIONS, type SettingsControl, settingsHits } from "./sections.js";
import { currentZoneOption, timezoneGroups } from "./timezones.js";
import "./settings.css";

import { ControlFrame, useShowSetting } from "./controls.js";
import { checkLink, type LinkDraft, ProfilePane } from "./ProfilePane.js";

/** The delay a student may ask for, in seconds (contracts/settings.ts). */
const MIN_DELAY = 1;
const MAX_DELAY = 60;

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

/** Two or three options, shown together. A menu hides the choices until it opens. */
function ChoiceField({
	label,
	hint,
	name,
	value,
	options,
	onChange,
}: {
	label: string;
	hint: string;
	name: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	return (
		<fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={`${name}-hint`}>
			{/* A legend is not a grid item, so the rest sits in its own grid below it. */}
			<legend className={`${LABEL_CLASS} mb-1.5 p-0`}>{label}</legend>
			<div className="grid gap-1.5">
				<div className="pk-choice">
					{options.map((option) => (
						<label key={option.value}>
							<input
								type="radio"
								name={name}
								value={option.value}
								checked={value === option.value}
								onChange={() => onChange(option.value)}
							/>
							<span>{option.label}</span>
						</label>
					))}
				</div>
				<p className={HINT_CLASS} id={`${name}-hint`}>
					{hint}
				</p>
			</div>
		</fieldset>
	);
}

const PREFERENCES = SETTINGS_SECTIONS.find((section) => section.id === "preferences");
const PROFILE = SETTINGS_SECTIONS.find((section) => section.id === "profile");
const PASSWORD = SETTINGS_SECTIONS.find((section) => section.id === "password");

function NavButton({
	current,
	nested,
	onClick,
	children,
}: {
	current: boolean;
	nested?: boolean;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			type="button"
			aria-current={current ? "page" : undefined}
			onClick={onClick}
			className={`pk-focus-ring min-h-9 w-full rounded-sm py-1 text-left text-[13px] leading-[18px] text-ink ${
				nested ? "pr-2 pl-6" : "px-2"
			} ${current ? "bg-surface-selected font-medium" : "hover:bg-surface-hover"}`}
		>
			{children}
		</button>
	);
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

	const autoSave = draft.autoSave ?? current.autoSave;
	const wordWrap = draft.wordWrap ?? current.wordWrap;
	const terminalTheme = draft.terminalTheme ?? current.terminalTheme;
	const screenReaderMode = draft.screenReaderMode ?? current.screenReaderMode;
	const timezone = draft.timezone ?? current.timezone;
	const delay =
		delayText ?? String(draft.autoSaveDelaySeconds ?? current.autoSaveDelaySeconds);

	const parsedDelay = /^\d+$/.test(delay.trim()) ? Number(delay.trim()) : null;
	const delayError =
		parsedDelay === null || parsedDelay < MIN_DELAY || parsedDelay > MAX_DELAY
			? `Give a whole number of seconds between ${MIN_DELAY} and ${MAX_DELAY}.`
			: null;

	const me = useMe();
	const localPassword = me.status === "authenticated" && me.user.localPassword;
	const sections = SETTINGS_SECTIONS.filter(
		(section) => section.id !== PASSWORD?.id || localPassword,
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
						<div className="flex h-[18px] min-w-0 items-center gap-1">
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
							{sectionId === PASSWORD?.id && localPassword ? (
								<PasswordPane highlightId={highlightId} />
							) : sectionId === PROFILE?.id ? (
								<ProfilePane
									highlightId={highlightId}
									links={links}
									onLinksChange={setLinks}
									onCommitLinks={commitLinks}
								/>
							) : (
								<div className="grid gap-6">
									<h2
										id="settings-section-preferences"
										className="pk-text-heading text-ink"
									>
										Preferences
									</h2>
									{PREFERENCES?.groups.map((group) => (
										<section
											key={group.title}
											className="pk-settings-group grid gap-4"
											aria-labelledby={`settings-${group.title}`}
										>
											<h3
												id={`settings-${group.title}`}
												className="pk-text-heading text-ink"
											>
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
							)}
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
		<section className="grid gap-4" aria-labelledby="settings-section-password">
			<h2 id="settings-section-password" className="pk-text-heading text-ink">
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
