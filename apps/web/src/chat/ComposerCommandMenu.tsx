/**
 * The composer's suggestion menus (SPEC.md §10.8): `/` at the start of the
 * message lists the commands and skills the host reports, each with its own
 * prefix (Claude's skills `/name`, Codex's `$name`); in a Codex chat `$` at
 * the start lists the skills alone; and `@` lists project files from the
 * file-name search. Each narrows as the student types. The editor is the
 * combobox and this list its listbox (SPEC.md §25.8): the keys stay in the
 * editor, which names the current option with aria-activedescendant, and a
 * polite status says how many matched. A command only the agent's terminal
 * can run is shown dimmed and never sent. `/model`, `/effort`,
 * `/permissions` and `/mcp` open their place in Chat options for either
 * agent instead of being sent.
 */
import type { ChatCommand } from "@portikus/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "./chatStore.js";
import type { ComposerMenu } from "./composerEditor.js";
import { searchFileNames } from "./fileNameSearch.js";

/** Typing pauses this long before a file search goes out. */
const SEARCH_DEBOUNCE_MS = 150;

/** The Chat options control that does a command's job in the web, and the note that says so. */
const CONTROLS: Record<string, { testId: string; note: string }> = {
	model: { testId: "composer-model", note: "Use the Model picker" },
	effort: { testId: "composer-effort", note: "Use the Effort picker" },
	permissions: { testId: "composer-mode", note: "Use the Permissions picker" },
	mcp: { testId: "composer-mcp", note: "Shown in Chat options" },
};

/** The control a bare `/model`, `/effort`, `/permissions` or `/mcp` opens; undefined for any other text. */
export function controlFor(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	return Object.hasOwn(CONTROLS, text.slice(1))
		? CONTROLS[text.slice(1)]?.testId
		: undefined;
}

/** The slash commands the host listed in its `commands` event. */
export function selectCommands(state: ChatState): readonly ChatCommand[] {
	return state.commands;
}

export interface MenuOption {
	key: string;
	/** What the list shows first: `/name`, or a file's name. */
	label: string;
	/** A command's argument hint. */
	hint?: string;
	/** A command's description, or the folder a file sits in. */
	detail: string;
	/** The option's full name for assistive technology, where the row splits it. */
	name?: string;
	/** Put in place of the trigger and query; null for a command that cannot be sent. */
	insert: string | null;
	/** Why a command is not sent from here, shown on its row. */
	note?: string;
	/** The picker that does a terminal-only command's job. */
	control?: string;
}

/** Commands whose name starts with the query first, then those that contain it. */
export function matchCommands(
	commands: readonly ChatCommand[],
	query: string,
): MenuOption[] {
	const typed = query.toLowerCase();
	const starts = commands.filter((one) => one.name.toLowerCase().startsWith(typed));
	const inside = commands.filter(
		(one) =>
			!one.name.toLowerCase().startsWith(typed) &&
			one.name.toLowerCase().includes(typed),
	);
	return [...starts, ...inside].map((one) => {
		const prefix = one.prefix ?? "/";
		const named = `${prefix}${one.name}`;
		const control =
			prefix === "/" && Object.hasOwn(CONTROLS, one.name)
				? CONTROLS[one.name]
				: undefined;
		const base = {
			key: `command:${named}`,
			label: named,
			...(one.argumentHint ? { hint: one.argumentHint } : {}),
			detail: one.description,
		};
		if (control)
			return { ...base, insert: null, note: control.note, control: control.testId };
		if (one.terminalOnly) return { ...base, insert: null, note: "Use the terminal" };
		return { ...base, insert: named };
	});
}

/** The skills alone, for the `$` menu. */
function skillsOf(commands: readonly ChatCommand[]): ChatCommand[] {
	return commands.filter((one) => one.prefix === "$");
}

/** A path as the CLI reads an `@` mention: quoted when it holds a space. */
export function mention(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function fileOption(path: string): MenuOption {
	const slash = path.lastIndexOf("/");
	return {
		key: `file:${path}`,
		label: path.slice(slash + 1),
		detail: slash > 0 ? path.slice(0, slash) : "",
		name: path,
		insert: mention(path),
	};
}

type Search =
	| { query: string; paths: string[]; truncated: boolean; failed: false }
	| { query: string; failed: true };

export interface MenuModel {
	options: MenuOption[];
	/** No answer yet for a file search. */
	loading: boolean;
	failed: boolean;
	truncated: boolean;
	active: number;
	setActive: (index: number) => void;
	/** Move the current option by `step`, wrapping at the ends. */
	move: (step: number) => void;
}

/**
 * The open menu's options. File searches wait SEARCH_DEBOUNCE_MS after the
 * last key, and a newer query cancels the one in flight, so its late answer
 * can never replace a newer list.
 */
export function useComposerMenu(
	menu: ComposerMenu | null,
	commands: readonly ChatCommand[],
	workspaceId: string,
	projectId: string,
): MenuModel {
	const [search, setSearch] = useState<Search | null>(null);
	const [active, setActive] = useState(0);
	const fileQuery = menu?.kind === "file" ? menu.query : null;

	useEffect(() => {
		if (fileQuery === null) {
			setSearch(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			searchFileNames(workspaceId, projectId, fileQuery, controller.signal).then(
				(found) =>
					setSearch({
						query: fileQuery,
						paths: found.paths,
						truncated: found.truncated,
						failed: false,
					}),
				() => {
					if (!controller.signal.aborted) setSearch({ query: fileQuery, failed: true });
				},
			);
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [fileQuery, workspaceId, projectId]);

	// An answer for an older query is not this query's: nothing is selectable until its own arrives.
	const current = search !== null && search.query === fileQuery ? search : null;

	const options = useMemo(() => {
		if (!menu) return [];
		if (menu.kind === "command") return matchCommands(commands, menu.query);
		if (menu.kind === "skill") return matchCommands(skillsOf(commands), menu.query);
		return current && !current.failed ? current.paths.map(fileOption) : [];
	}, [menu, commands, current]);

	// A new list starts at its first option.
	const first = options[0]?.key;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the list's first option changes
	useEffect(() => setActive(0), [first, menu?.kind]);

	const count = options.length;
	return {
		options,
		loading: menu?.kind === "file" && current === null,
		failed: menu?.kind === "file" && current?.failed === true,
		truncated: menu?.kind === "file" && current?.failed === false && current.truncated,
		active: Math.min(active, Math.max(count - 1, 0)),
		setActive,
		move: (step) =>
			setActive((now) => (count === 0 ? 0 : (now + step + count) % count)),
	};
}

/** What the status line says of the list, read politely as it changes. */
function menuStatus(menu: ComposerMenu | null, model: MenuModel): string {
	if (!menu) return "";
	if (menu.kind === "command") {
		const count = model.options.length;
		if (count === 0) return "No matching commands";
		return `${count} ${count === 1 ? "command" : "commands"}`;
	}
	if (menu.kind === "skill") {
		const count = model.options.length;
		if (count === 0) return "No matching skills";
		return `${count} ${count === 1 ? "skill" : "skills"}`;
	}
	if (model.loading) return "";
	if (model.failed) return "Files could not be searched just now";
	const count = model.options.length;
	if (count === 0) return "No matching files";
	const files = `${count} ${count === 1 ? "file" : "files"}`;
	return model.truncated ? `${files}, more not shown; type more to narrow` : files;
}

const MENU_LABEL: Record<ComposerMenu["kind"], string> = {
	command: "Commands",
	skill: "Skills",
	file: "Files",
};

export interface ComposerCommandMenuProps {
	listId: string;
	menu: ComposerMenu | null;
	model: MenuModel;
	/** False while the editor does not hold focus: the list hides until it comes back. */
	shown: boolean;
	onChoose: (index: number) => void;
}

/** The option element's id, for the editor's aria-activedescendant. */
export function optionId(listId: string, index: number): string {
	return `${listId}-${index}`;
}

export function ComposerCommandMenu({
	listId,
	menu,
	model,
	shown,
	onChoose,
}: ComposerCommandMenuProps) {
	const list = useRef<HTMLDivElement | null>(null);
	const status = menuStatus(menu, model);
	const open = menu !== null && shown;

	useEffect(() => {
		if (!open) return;
		list.current
			?.querySelector(`#${CSS.escape(optionId(listId, model.active))}`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, listId, model.active]);

	const label = MENU_LABEL[menu?.kind ?? "command"];
	const empty = model.options.length === 0;
	return (
		<>
			{open ? (
				<div className="pk-composer-menu" data-testid={`composer-menu-${menu.kind}`}>
					<div
						ref={list}
						id={listId}
						role="listbox"
						aria-label={label}
						className="pk-composer-menu-list"
						hidden={empty}
					>
						{model.options.map((option, index) => (
							// The editor is the combobox and keeps focus; it moves through these
							// by aria-activedescendant, so they take no focus or keys (SPEC.md §25.8).
							// biome-ignore lint/a11y/useFocusableInteractive: the editor holds focus for the list
							// biome-ignore lint/a11y/useKeyWithClickEvents: keys reach the list through the editor
							<div
								key={option.key}
								id={optionId(listId, index)}
								role="option"
								aria-selected={index === model.active}
								aria-disabled={
									option.insert === null && !option.control ? true : undefined
								}
								aria-label={option.name}
								className={`pk-composer-option${option.insert === null && !option.control ? " is-blocked" : ""}`}
								data-testid="composer-menu-option"
								// The editor keeps focus, so the list never takes the keyboard.
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => {
									if (index !== model.active) model.setActive(index);
								}}
								onClick={() => onChoose(index)}
							>
								<span className="pk-composer-option-head">
									<span className="pk-composer-option-label">{option.label}</span>
									{option.hint ? (
										<span className="pk-composer-option-hint">{option.hint}</span>
									) : null}
								</span>
								{option.detail || option.note ? (
									<span className="pk-composer-option-detail">
										{option.detail}
										{/* Where the command works instead, read with what it does. */}
										{option.detail && option.note ? " · " : null}
										{option.note ? (
											<span className="pk-composer-option-note">{option.note}</span>
										) : null}
									</span>
								) : null}
							</div>
						))}
					</div>
					{empty || model.truncated ? (
						<p className="pk-composer-menu-note" data-testid="composer-menu-note">
							{model.loading ? "Searching…" : status}
						</p>
					) : null}
				</div>
			) : null}
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				data-testid="composer-menu-status"
			>
				{open ? status : ""}
			</p>
		</>
	);
}
