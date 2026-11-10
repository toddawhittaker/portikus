/**
 * The composer's two suggestion menus (SPEC.md §10.8, #1782): `/` at the
 * start of the message lists the slash commands the host reports, and `@`
 * lists project files from the file-name search. Both narrow as the student
 * types. The editor is the combobox and this list its listbox (SPEC.md
 * §25.8): the keys stay in the editor, which names the current option with
 * aria-activedescendant, and a polite status says how many matched.
 * A command only the terminal Claude Code can run is shown dimmed and never
 * sent; where a picker below the box does the same thing, choosing the
 * command opens that picker instead.
 */
import type { ChatCommand } from "@portikus/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "./chatStore.js";
import type { ComposerMenu } from "./composerEditor.js";
import { searchFileNames } from "./fileNameSearch.js";

/** Typing pauses this long before a file search goes out. */
export const SEARCH_DEBOUNCE_MS = 150;

/** A picker below the box that does what a terminal-only command does there. */
const CONTROLS: Record<string, { testId: string; label: string }> = {
	model: { testId: "composer-model", label: "Model" },
	effort: { testId: "composer-effort", label: "Effort" },
};

const NO_COMMANDS: readonly ChatCommand[] = [];

/** The slash commands the host listed in its `commands` event. */
export function selectCommands(state: ChatState): readonly ChatCommand[] {
	return (
		(state as ChatState & { commands?: readonly ChatCommand[] }).commands ?? NO_COMMANDS
	);
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
		const control = one.terminalOnly ? CONTROLS[one.name] : undefined;
		return {
			key: `command:${one.name}`,
			label: `/${one.name}`,
			...(one.argumentHint ? { hint: one.argumentHint } : {}),
			detail: one.description,
			insert: one.terminalOnly ? null : `/${one.name}`,
			...(one.terminalOnly
				? {
						note: control ? `Use the ${control.label} picker` : "Use the terminal",
						...(control ? { control: control.testId } : {}),
					}
				: {}),
		};
	});
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

	const options = useMemo(() => {
		if (!menu) return [];
		if (menu.kind === "command") return matchCommands(commands, menu.query);
		return search && !search.failed ? search.paths.map(fileOption) : [];
	}, [menu, commands, search]);

	// A new list starts at its first option.
	const first = options[0]?.key;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the list's first option changes
	useEffect(() => setActive(0), [first, menu?.kind]);

	const count = options.length;
	return {
		options,
		loading: menu?.kind === "file" && search === null,
		failed: menu?.kind === "file" && search?.failed === true,
		truncated: menu?.kind === "file" && search?.failed === false && search.truncated,
		active: Math.min(active, Math.max(count - 1, 0)),
		setActive,
		move: (step) =>
			setActive((now) => (count === 0 ? 0 : (now + step + count) % count)),
	};
}

/** What the status line says of the list, read politely as it changes. */
export function menuStatus(menu: ComposerMenu | null, model: MenuModel): string {
	if (!menu) return "";
	if (menu.kind === "command") {
		const count = model.options.length;
		if (count === 0) return "No matching commands";
		return `${count} ${count === 1 ? "command" : "commands"}`;
	}
	if (model.loading) return "";
	if (model.failed) return "Files could not be searched just now";
	const count = model.options.length;
	if (count === 0) return "No matching files";
	const files = `${count} ${count === 1 ? "file" : "files"}`;
	return model.truncated ? `${files}, more not shown; type more to narrow` : files;
}

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

	const label = menu?.kind === "file" ? "Files" : "Commands";
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
								className={`pk-composer-option${option.insert === null ? " is-blocked" : ""}`}
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
									{option.note ? (
										<span className="pk-composer-option-note">{option.note}</span>
									) : null}
								</span>
								{option.detail ? (
									<span className="pk-composer-option-detail">{option.detail}</span>
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
