/**
 * The student's settings (issues #159, #239, #287, #288, #329 and #340,
 * SPEC.md §13.5). The left pane is the section list and a search box; the
 * right pane is the section that was chosen. Search reads that same list.
 * Every setting, the appearance included, is kept on the server per user
 * (issue #300) and saved the moment it changes; typed values (the auto-save
 * delay and the profile links) when the student leaves the field, presses
 * Enter or closes the dialog. The terminal color scheme is separate
 * from the page appearance. Profile shows the institution sign-in and a few
 * optional links and a picture, none of which is used for authorization.
 */
import {
	EDITOR_SETTINGS_DEFAULTS,
	GithubLink,
	githubHref,
	type UpdateEditorSettingsRequest,
	type UpdateProfileRequest,
	WebsiteLink,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	Dialog,
	DialogRoot,
	LABEL_CLASS,
	Select,
	TextField,
	Toggletip,
} from "@portikus/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";
import { LINK_CHANNEL, type LinkMessage } from "../link/channel.js";
import { ChangePasswordForm } from "../password/ChangePasswordForm.js";
import {
	readThemePreference,
	rememberThemePreference,
	type ThemePreference,
} from "../shell/theme.js";
import { useMe } from "../useMe.js";
import {
	startLink,
	useMyLinks,
	useProfile,
	useRemovePicture,
	useUnlink,
	useUpdateProfile,
	useUploadPicture,
} from "./profileQueries.js";
import { SETTINGS_SECTIONS, type SettingsControl, settingsHits } from "./sections.js";
import { currentZoneOption, timezoneGroups } from "./timezones.js";
import "./settings.css";

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
		<fieldset className="m-0 grid gap-2 border-0 p-0">
			<legend className={LABEL_CLASS}>{label}</legend>
			<p className="pk-hint m-0 text-[12px] leading-4 text-ink-muted">{hint}</p>
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
		</fieldset>
	);
}

const PREFERENCES = SETTINGS_SECTIONS.find((section) => section.id === "preferences");
const PROFILE = SETTINGS_SECTIONS.find((section) => section.id === "profile");
const PASSWORD = SETTINGS_SECTIONS.find((section) => section.id === "password");

/** The profile links the student has typed but not saved yet. */
interface LinkDraft {
	github?: string;
	website?: string;
}

/** A blank link clears it; anything else must pass the same check the API makes. */
export function checkLink(
	schema: typeof GithubLink | typeof WebsiteLink,
	text: string | undefined,
): { value: string | null | undefined; error: string | null } {
	if (text === undefined) return { value: undefined, error: null };
	if (text.trim() === "") return { value: null, error: null };
	const parsed = schema.safeParse(text);
	return parsed.success
		? { value: parsed.data, error: null }
		: {
				value: undefined,
				error: parsed.error.issues[0]?.message ?? "Not a valid link",
			};
}

/** Up to two initials for the avatar placeholder. */
export function initials(displayName: string): string {
	const parts = displayName.trim().split(/\s+/).slice(0, 2);
	const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
	return letters || "?";
}

/** Scroll the chosen control into view and move focus to it. */
function useShowSetting(highlightId: string | null, ready: boolean) {
	useEffect(() => {
		if (!highlightId || !ready) return;
		const node = document.getElementById(`settings-control-${highlightId}`);
		if (!node) return;
		node.scrollIntoView({ block: "nearest" });
		const focusable = node.querySelector<HTMLElement>(
			"input:not([disabled]), button:not([disabled]), textarea, select",
		);
		(focusable ?? node).focus();
	}, [highlightId, ready]);
}

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

function ControlFrame({
	control,
	highlighted,
	children,
}: {
	control: SettingsControl;
	highlighted: boolean;
	children: ReactNode;
}) {
	return (
		<div
			id={`settings-control-${control.id}`}
			tabIndex={-1}
			data-highlighted={highlighted ? "true" : "false"}
			className={`rounded-sm outline-none ${
				highlighted ? "bg-surface-selected px-2 py-2" : ""
			}`}
		>
			{children}
		</div>
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
	// would reject (issue #287). Empty until the settings arrive.
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
					setSaved(false);
					setSaveError(failure instanceof Error ? failure.message : "");
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
					<div className="grid gap-2">
						<div className="flex min-w-0 items-center gap-1">
							<span className={LABEL_CLASS}>{control.label}</span>
							<Toggletip label={control.label}>
								You can switch one terminal from its three-dots menu. A program that is
								already running keeps the colors it started with until you restart it.
							</Toggletip>
						</div>
						<p className="pk-hint m-0 text-[12px] leading-4 text-ink-muted">
							What a new terminal starts with.
						</p>
						<label className="pk-switch">
							<input
								type="checkbox"
								role="switch"
								aria-checked={terminalTheme === "light"}
								checked={terminalTheme === "light"}
								onChange={(event) =>
									change({ terminalTheme: event.target.checked ? "light" : "dark" })
								}
							/>
							{/* A fixed name, so on and off mean light and dark (issue #373). */}
							<span>Light terminal</span>
						</label>
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
						{/* Always there, so a screen reader hears each save (review M5). */}
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
						<div ref={pane} className="min-h-0 flex-1 overflow-y-auto p-4">
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
												className="pk-text-body font-semibold text-ink"
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

/** A saved link, shown only as a plain anchor (issue #300). */
function SavedLink({ href, testId }: { href: string; testId: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			data-testid={testId}
			className="pk-text-compact break-all text-[var(--accent-text)] underline"
		>
			{href}
		</a>
	);
}

function ProfilePane({
	highlightId,
	links,
	onLinksChange,
	onCommitLinks,
}: {
	highlightId: string | null;
	links: LinkDraft;
	onLinksChange: (next: LinkDraft) => void;
	onCommitLinks: () => void;
}) {
	const me = useMe();
	const profile = useProfile();
	const upload = useUploadPicture();
	const remove = useRemovePicture();
	const pictureInput = useRef<HTMLInputElement>(null);
	const chooseButton = useRef<HTMLButtonElement>(null);
	const ready = me.status === "authenticated" && profile.isSuccess;
	useShowSetting(highlightId, ready);
	const user = me.status === "authenticated" ? me.user : null;
	const saved = profile.data;
	const pictureError = upload.error ?? remove.error;
	const github = checkLink(GithubLink, links.github);
	const website = checkLink(WebsiteLink, links.website);
	const commitOnEnter = (event: { key: string }) => {
		if (event.key === "Enter") onCommitLinks();
	};

	function signInValue(controlId: string): string {
		if (controlId === "display-name")
			return saved?.displayName ?? user?.displayName ?? "";
		if (controlId === "email") return saved?.email ?? "Not provided";
		if (controlId === "sign-in-name") return user?.signInName ?? "Not provided";
		if (controlId === "workspace-label")
			return saved?.workspaceLabel ?? "Not created yet";
		return "";
	}

	function editable(controlId: string) {
		switch (controlId) {
			case "profile-picture":
				return (
					<div className="grid gap-2">
						<span className={LABEL_CLASS}>Profile picture</span>
						<div className="flex flex-wrap items-center gap-3">
							{saved?.picture ? (
								<img
									src={saved.picture}
									alt="Your profile"
									data-testid="profile-picture"
									className="size-12 shrink-0 rounded-full border border-line object-cover"
								/>
							) : (
								<span
									className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-surface-sunken text-[15px] font-semibold text-ink"
									data-testid="account-initials"
									aria-hidden="true"
								>
									{initials(user?.displayName ?? "")}
								</span>
							)}
							{/* The native input is hidden; the button opens its file picker. */}
							<input
								ref={pictureInput}
								type="file"
								accept="image/png,image/jpeg"
								hidden
								data-testid="profile-picture-input"
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) upload.mutate(file);
									event.target.value = "";
								}}
							/>
							<Button
								ref={chooseButton}
								variant="secondary"
								data-testid="profile-picture-choose"
								loading={upload.isPending}
								onClick={() => pictureInput.current?.click()}
							>
								Choose picture…
							</Button>
							{saved?.picture ? (
								<Button
									variant="secondary"
									onClick={() =>
										remove.mutate(undefined, {
											// The button goes away with the picture; keep focus beside it.
											onSuccess: () => chooseButton.current?.focus(),
										})
									}
									loading={remove.isPending}
								>
									Remove picture
								</Button>
							) : null}
						</div>
						<p className="pk-hint m-0 text-[12px] leading-4 text-ink-muted">
							A PNG or JPEG of up to 1 MiB. It is saved as soon as you choose it and
							shows in the account menu.
						</p>
						{pictureError ? (
							<p
								className="pk-text-body m-0 text-status-error"
								data-testid="profile-picture-error"
							>
								{pictureError instanceof Error
									? pictureError.message
									: "The picture was not saved."}
							</p>
						) : null}
					</div>
				);
			case "github":
				return (
					<div className="grid gap-1">
						<TextField
							id="profile-github"
							label="GitHub"
							hint="Your GitHub username or an https:// link to your profile."
							value={links.github ?? saved?.github ?? ""}
							error={github.error}
							autoComplete="off"
							onChange={(event) =>
								onLinksChange({ ...links, github: event.target.value })
							}
							onBlur={onCommitLinks}
							onKeyDown={commitOnEnter}
						/>
						{saved?.github ? (
							<SavedLink href={githubHref(saved.github)} testId="profile-github-link" />
						) : null}
					</div>
				);
			case "website":
				return (
					<div className="grid gap-1">
						<TextField
							id="profile-website"
							label="Personal site"
							hint="One https:// link."
							value={links.website ?? saved?.website ?? ""}
							error={website.error}
							autoComplete="off"
							onChange={(event) =>
								onLinksChange({ ...links, website: event.target.value })
							}
							onBlur={onCommitLinks}
							onKeyDown={commitOnEnter}
						/>
						{saved?.website ? (
							<SavedLink href={saved.website} testId="profile-website-link" />
						) : null}
					</div>
				);
			default:
				return null;
		}
	}

	const [signIn, about, linked] = PROFILE?.groups ?? [];
	const [picture, ...linkControls] = about?.controls ?? [];

	return (
		<section className="grid gap-6" aria-labelledby="settings-section-profile">
			<h2 id="settings-section-profile" className="pk-text-heading text-ink">
				Profile
			</h2>
			{me.status === "loading" || profile.isPending ? (
				<p className="pk-text-body text-ink-muted">Loading your profile…</p>
			) : null}
			{me.status !== "loading" && !profile.isPending && !ready ? (
				<p className="pk-text-body text-status-error" data-testid="account-error">
					Your account details could not be loaded.
				</p>
			) : null}
			{ready ? (
				<>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-signin"
					>
						<h3
							id="settings-profile-signin"
							className="pk-text-body font-semibold text-ink"
						>
							{signIn?.title}
						</h3>
						<p className="pk-text-compact m-0 text-ink-muted">
							These come from the institution sign-in and cannot be changed here.
						</p>
						<dl className="m-0 grid gap-4" data-testid="profile-signin">
							{signIn?.controls.map((control) => (
								<ControlFrame
									key={control.id}
									control={control}
									highlighted={highlightId === control.id}
								>
									<dt className="pk-text-label flex min-w-0 items-center gap-1 text-ink-muted">
										{control.label}
										{control.id === "workspace-label" ? (
											<Toggletip label={control.label}>
												The name of your workspace machine. It is part of your preview
												addresses, and administrators see it.
											</Toggletip>
										) : null}
									</dt>
									<dd className="pk-text-body pk-settings-value m-0 text-ink">
										{signInValue(control.id)}
									</dd>
								</ControlFrame>
							))}
						</dl>
					</section>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-about"
					>
						<h3
							id="settings-profile-about"
							className="pk-text-body font-semibold text-ink"
						>
							{about?.title}
						</h3>
						<p className="pk-text-compact m-0 text-ink-muted">All optional.</p>
						{picture ? (
							<ControlFrame control={picture} highlighted={highlightId === picture.id}>
								{editable(picture.id)}
							</ControlFrame>
						) : null}
						{linkControls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								{editable(control.id)}
							</ControlFrame>
						))}
					</section>
					<section
						className="pk-settings-group grid gap-4"
						aria-labelledby="settings-profile-linked"
					>
						<div className="flex min-w-0 items-center gap-1">
							<h3
								id="settings-profile-linked"
								className="pk-text-body font-semibold text-ink"
								tabIndex={-1}
							>
								{linked?.title}
							</h3>
							<Toggletip label={linked?.title ?? "Linked accounts"}>
								If you open Portikus both from your course and by signing in with your
								SSO account, linking them opens the same account and workspace from
								both.
							</Toggletip>
						</div>
						{linked?.controls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								<LinkedAccounts />
							</ControlFrame>
						))}
					</section>
				</>
			) : null}
		</section>
	);
}

/**
 * A course account links itself to an SSO account; an SSO account lists and
 * unlinks its course sign-ins (docs/archive/epics/EPIC-13-1.md, "The flow" steps 1, 2 and 7).
 */
function LinkedAccounts() {
	const links = useMyLinks();
	const unlink = useUnlink();
	const [waiting, setWaiting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startButton = useRef<HTMLButtonElement>(null);
	const reopenButton = useRef<HTMLButtonElement>(null);

	// The link finishes in its own tab; the app root reloads on "linked" (useLinkedReload).
	useEffect(() => {
		const channel = new BroadcastChannel(LINK_CHANNEL);
		channel.onmessage = (event: MessageEvent<LinkMessage>) => {
			if (event.data?.type === "cancelled") setWaiting(false);
		};
		return () => channel.close();
	}, []);

	// Keep focus on a control when the button under it is swapped out.
	const wasWaiting = useRef(false);
	useEffect(() => {
		if (waiting) reopenButton.current?.focus();
		else if (wasWaiting.current) startButton.current?.focus();
		wasWaiting.current = waiting;
	}, [waiting]);

	function openLinkTab() {
		// Opened synchronously in the click so it is not blocked; opener is cut by hand
		// because "noopener" would hide whether a pop-up blocker stopped it.
		const tab = window.open("", "_blank");
		if (tab === null) {
			location.assign("/link/start");
			return;
		}
		tab.opener = null;
		setStartError(null);
		setWaiting(true);
		// The start is posted from this tab, where the click happened (security review of #515).
		startLink().then(
			({ redirectUrl }) => {
				tab.location.href = redirectUrl;
			},
			(failure: unknown) => {
				tab.close();
				setWaiting(false);
				setStartError(
					failure instanceof Error ? failure.message : "The link could not be started.",
				);
			},
		);
	}

	if (links.isPending) {
		return <p className="pk-text-body m-0 text-ink-muted">Loading linked accounts…</p>;
	}
	if (!links.isSuccess) {
		return (
			<p className="pk-text-body m-0 text-status-error" data-testid="links-error">
				Your linked accounts could not be loaded.
			</p>
		);
	}

	const { source, linkUntil, links: rows } = links.data;

	if (source === "course") {
		const open = linkUntil !== null && Date.parse(linkUntil) > Date.now();
		return (
			<div className="grid gap-2" data-testid="link-course">
				<p className="pk-text-compact m-0 text-ink-muted">
					You opened Portikus from your course. If you also sign in with your SSO
					account, link the two so your course opens that account and its workspace.
					This course account's workspace is archived, not deleted.
				</p>
				{open && !waiting ? (
					<div>
						<Button
							ref={startButton}
							variant="primary"
							data-testid="link-start"
							onClick={openLinkTab}
						>
							Link to my SSO account
						</Button>
					</div>
				) : null}
				{open && waiting ? (
					<div>
						<Button ref={reopenButton} variant="secondary" onClick={openLinkTab}>
							Open the sign-in tab again
						</Button>
					</div>
				) : null}
				{open ? null : (
					<p className="pk-text-body m-0 text-ink" data-testid="link-too-late">
						Open Portikus again from your course to link it.
					</p>
				)}
				<p role="status" className="pk-text-compact m-0 text-ink-muted">
					{waiting ? "Finish signing in in the new tab." : ""}
				</p>
				{startError ? (
					<p className="pk-text-body m-0 text-status-error" role="alert">
						{startError}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<div className="grid gap-2" data-testid="link-sso">
			{rows.length === 0 ? (
				<p className="pk-text-compact m-0 text-ink-muted">
					No course sign-ins are linked to this SSO account. To link one, open Portikus
					from your course and choose Link to my SSO account in Settings.
				</p>
			) : (
				<ul className="m-0 grid list-none gap-2 p-0">
					{rows.map((row) => (
						<li
							key={row.courseUserId}
							className="flex items-center justify-between gap-3"
							data-testid={`link-row-${row.courseUserId}`}
						>
							<span className="pk-text-body text-ink">
								{row.displayName}, {row.platformName}
							</span>
							<Button
								variant="secondary"
								aria-label={`Unlink ${row.displayName} from ${row.platformName}`}
								data-unlink-id={row.courseUserId}
								loading={unlink.isPending && unlink.variables === row.courseUserId}
								onClick={() => {
									const index = rows.indexOf(row);
									const next = rows[index + 1] ?? rows[index - 1];
									unlink.mutate(row.courseUserId, {
										// Runs after useUnlink's refetch, so the row is gone; the frame lets React render.
										onSuccess: () =>
											requestAnimationFrame(() => {
												const button = next
													? document.querySelector<HTMLElement>(
															`[data-unlink-id="${next.courseUserId}"]`,
														)
													: null;
												(
													button ?? document.getElementById("settings-profile-linked")
												)?.focus();
											}),
									});
								}}
							>
								Unlink
							</Button>
						</li>
					))}
				</ul>
			)}
			<p role="status" className="pk-text-compact m-0 text-ink-muted">
				{unlink.isSuccess
					? "Unlinked. Your next launch from that course opens the course account."
					: ""}
			</p>
			{unlink.error ? (
				<p className="pk-text-body m-0 text-status-error" role="alert">
					{unlink.error.message}
				</p>
			) : null}
		</div>
	);
}
