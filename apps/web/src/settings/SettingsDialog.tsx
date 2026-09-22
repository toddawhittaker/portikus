/**
 * The student's settings (issues #159, #239, #287, #288, #329 and #340,
 * SPEC.md §13.5). The left pane is the section list and a search box; the
 * right pane is the section that was chosen. Search reads that same list.
 * Appearance is remembered in this browser only. Editor, terminal, and
 * workspace settings are kept on the server, per user. The terminal colour
 * scheme is separate from the page appearance.
 */
import {
	EDITOR_SETTINGS_DEFAULTS,
	type TerminalTheme,
	type UpdateEditorSettingsRequest,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	Dialog,
	DialogRoot,
	LABEL_CLASS,
	Select,
	TextField,
} from "@portikus/ui";
import { type ReactNode, useEffect, useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";
import { type ThemePreference, useThemePreference } from "../shell/theme.js";
import { useMe } from "../useMe.js";
import { SETTINGS_SECTIONS, type SettingsControl, settingsHits } from "./sections.js";
import { currentZoneOption, timezoneGroups } from "./timezones.js";

/** The delay a student may ask for, in seconds (contracts/settings.ts). */
const MIN_DELAY = 1;
const MAX_DELAY = 60;

const TERMINAL_THEME_OPTIONS = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const PREFERENCES = SETTINGS_SECTIONS.find((section) => section.id === "preferences");
const ACCOUNT = SETTINGS_SECTIONS.find((section) => section.id === "account");

function initials(displayName: string): string {
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
	const [preference, setPreference] = useThemePreference();
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
	const timezone = draft.timezone ?? current.timezone;
	const delay =
		delayText ?? String(draft.autoSaveDelaySeconds ?? current.autoSaveDelaySeconds);

	const parsedDelay = /^\d+$/.test(delay.trim()) ? Number(delay.trim()) : null;
	const delayError =
		parsedDelay === null || parsedDelay < MIN_DELAY || parsedDelay > MAX_DELAY
			? `Give a whole number of seconds between ${MIN_DELAY} and ${MAX_DELAY}.`
			: null;

	const filtering = query.trim() !== "";
	const hits = settingsHits(SETTINGS_SECTIONS, query);
	const listed = filtering
		? SETTINGS_SECTIONS.filter((section) =>
				hits.some((hit) => hit.sectionId === section.id),
			)
		: SETTINGS_SECTIONS;

	useShowSetting(highlightId, sectionId === PREFERENCES?.id);

	function save() {
		if (delayError !== null || parsedDelay === null || update.isPending) return;
		const body: UpdateEditorSettingsRequest = {
			autoSave,
			autoSaveDelaySeconds: parsedDelay,
			wordWrap,
			terminalTheme,
			timezone,
		};
		update.mutate(body, { onSuccess: onClose });
	}

	function open(nextSectionId: string, controlId: string | null) {
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
						onChange={(event) =>
							setDraft((next) => ({ ...next, autoSave: event.target.checked }))
						}
						className="pk-setting-autosave"
					/>
				);
			case "auto-save-delay":
				return (
					<TextField
						id="editor-autosave-delay"
						data-testid="editor-settings-delay"
						label={control.label}
						className="w-48"
						inputMode="numeric"
						value={delay}
						disabled={!autoSave}
						error={delayError}
						onChange={(event) => setDelayText(event.target.value)}
					/>
				);
			case "word-wrap":
				return (
					<Checkbox
						label={control.label}
						description="Wrap long lines instead of scrolling sideways."
						checked={wordWrap}
						onChange={(event) =>
							setDraft((next) => ({ ...next, wordWrap: event.target.checked }))
						}
						className="pk-setting-wordwrap"
					/>
				);
			case "terminal-colours":
				return (
					<Select
						id="terminal-theme"
						label={control.label}
						hint="What a new terminal starts with. Each terminal's three-dots menu can switch that one terminal, and a program already running keeps the colours it started with."
						options={TERMINAL_THEME_OPTIONS}
						value={terminalTheme}
						onValueChange={(value) =>
							setDraft((next) => ({
								...next,
								terminalTheme: value as TerminalTheme,
							}))
						}
					/>
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
							hint="The clock your terminals, logs, and Git commits use. A new terminal takes it at once; a shell already running keeps the zone it started with until the workspace restarts. Programs you run in Docker containers keep their own clock."
							options={[currentZoneOption(timezone)]}
							groups={timezoneGroups(zones, timezone)}
							value={timezone}
							disabled={zones.length === 0}
							onValueChange={(value) =>
								setDraft((next) => ({ ...next, timezone: value }))
							}
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
					<Select
						id="page-appearance"
						label={control.label}
						hint="Light, dark, or follow this computer. This stays in this browser and applies as soon as you choose it."
						options={APPEARANCE_OPTIONS}
						value={preference}
						onValueChange={(value) => setPreference(value as ThemePreference)}
					/>
				);
			default:
				return null;
		}
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-editor-settings"
				size="lg"
				title="Settings"
				description="Editor, terminal, and timezone settings follow you to any browser you sign in from."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							data-testid="editor-settings-save"
							variant="primary"
							loading={update.isPending}
							disabled={delayError !== null || update.isPending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<div className="-mx-6 mt-2 grid h-[min(28rem,52vh)] grid-cols-[13rem_minmax(0,1fr)] border-y border-line">
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
						<div className="min-h-0 flex-1 overflow-y-auto p-4">
							{sectionId === ACCOUNT?.id ? (
								<AccountPane highlightId={highlightId} />
							) : (
								<form
									className="grid gap-6"
									onSubmit={(event) => {
										event.preventDefault();
										save();
									}}
								>
									<h2
										id="settings-section-preferences"
										className="pk-text-heading text-ink"
									>
										Preferences
									</h2>
									{PREFERENCES?.groups.map((group) => (
										<section
											key={group.title}
											className="grid gap-4"
											aria-labelledby={`settings-${group.title}`}
										>
											<h3
												id={`settings-${group.title}`}
												className="pk-text-label text-ink"
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
									<button
										type="submit"
										className="hidden"
										tabIndex={-1}
										aria-hidden="true"
									/>
								</form>
							)}
						</div>
						{update.isError ? (
							<p
								className="pk-text-body px-4 pb-4 text-status-error"
								data-testid="editor-settings-error"
							>
								{update.error instanceof Error
									? update.error.message
									: "The settings were not saved."}
							</p>
						) : null}
					</div>
				</div>
			</Dialog>
		</DialogRoot>
	);
}

function accountValue(
	controlId: string,
	user: { displayName: string; email: string | null; oidcSubject?: string },
): string {
	if (controlId === "display-name") return user.displayName;
	if (controlId === "email") return user.email ?? "Not provided";
	if (controlId === "sign-in-name") return user.oidcSubject ?? "Not provided";
	return "";
}

function AccountPane({ highlightId }: { highlightId: string | null }) {
	const me = useMe();
	const ready = me.status === "authenticated";
	useShowSetting(highlightId, ready);
	const user = ready ? me.user : null;

	return (
		<section className="grid gap-4" aria-labelledby="settings-section-account">
			<h2 id="settings-section-account" className="pk-text-heading text-ink">
				Account
			</h2>
			{me.status === "loading" ? (
				<p className="pk-text-body text-ink-muted">Loading your account…</p>
			) : null}
			{me.status !== "loading" && !user ? (
				<p className="pk-text-body text-status-error" data-testid="account-error">
					Your account details could not be loaded.
				</p>
			) : null}
			{user ? (
				<>
					<div className="flex items-center gap-3">
						<span
							className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-surface-sunken text-[15px] font-semibold text-ink"
							data-testid="account-initials"
							aria-hidden="true"
						>
							{initials(user.displayName)}
						</span>
						<p className="pk-text-compact m-0 text-ink-muted">
							These come from the institution sign-in.
						</p>
					</div>
					{ACCOUNT?.groups.flatMap((group) =>
						group.controls.map((control) => (
							<ControlFrame
								key={control.id}
								control={control}
								highlighted={highlightId === control.id}
							>
								<div className="grid gap-1">
									<label className={LABEL_CLASS} htmlFor={`account-${control.id}`}>
										{control.label}
									</label>
									<input
										id={`account-${control.id}`}
										type="text"
										readOnly
										value={accountValue(control.id, user)}
										className="pk-focus-ring w-full break-all border-0 bg-transparent p-0 text-[14px] leading-5 text-ink"
									/>
								</div>
							</ControlFrame>
						)),
					)}
				</>
			) : null}
		</section>
	);
}
