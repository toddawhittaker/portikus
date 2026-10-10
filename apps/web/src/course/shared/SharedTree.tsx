/**
 * The shared project's files as nested lists of buttons (SPEC.md §5.2,
 * §11.2). View only: unlike the student's FileTree it has no selection,
 * menus, drag or keyboard shortcuts, because there is nothing to act on.
 */
import { Icon } from "@portikus/ui";
import { fileIconName } from "../../files/fileIcon.js";
import { type GitDecorations, isIgnored } from "../../files/gitStatus.js";
import {
	displayName,
	entryCount,
	joinPath,
	visibleEntries,
} from "../../files/paths.js";
import "../../files/files.css";
import { type ShareRef, useSharedTree } from "./queries.js";

export interface SharedTreeProps {
	share: ShareRef;
	git: GitDecorations;
	showHidden: boolean;
	/** Open directories, by path. */
	expanded: ReadonlySet<string>;
	onToggle: (dir: string) => void;
	/** The file on show, if any. */
	current: string | null;
	onOpen: (path: string) => void;
	/** Names the list, such as "Files in my-app". */
	label: string;
}

export function SharedTree(props: SharedTreeProps) {
	return (
		<ul className="pk-changes-list" aria-label={props.label} data-testid="shared-tree">
			<Directory {...props} dir="" level={1} />
		</ul>
	);
}

function Directory(props: SharedTreeProps & { dir: string; level: number }) {
	const { share, dir, level, showHidden } = props;
	const query = useSharedTree(share, dir);
	const indent = { paddingLeft: `${level * 16 - 8}px` };
	if (!query.data) {
		return (
			<li className="pk-changes-empty" style={indent}>
				{query.isError ? "This folder could not be listed." : "Loading…"}
			</li>
		);
	}
	const entries = visibleEntries(query.data.entries, showHidden);
	if (entries.length === 0 && !query.data.truncated) {
		return (
			<li className="pk-changes-empty" style={indent}>
				{dir === "" ? "No files to show." : "Empty folder"}
			</li>
		);
	}
	return (
		<>
			{entries.map((entry) => (
				<Entry
					key={entry.name}
					{...props}
					path={joinPath(dir, entry.name)}
					name={entry.name}
					isDir={entry.type === "dir"}
				/>
			))}
			{query.data.truncated ? (
				<li>
					<button
						type="button"
						className="pk-changes-row"
						style={indent}
						disabled={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
					>
						<span className="pk-changes-path">
							{entryCount(entries.length)} shown. Show more
						</span>
					</button>
				</li>
			) : null}
		</>
	);
}

function Entry(
	props: SharedTreeProps & {
		path: string;
		name: string;
		isDir: boolean;
		level: number;
	},
) {
	const { path, name, isDir, level, git, expanded, current } = props;
	const open = isDir && expanded.has(path);
	const shown = displayName(name);
	const decoration = git.byPath.get(path);
	const dirty = isDir && git.changedDirs.has(path);
	const ignored = git.repo && isIgnored(path, git.ignored);
	const status = decoration
		? decoration.title
		: dirty
			? "contains changes"
			: ignored
				? "ignored"
				: null;
	const isCurrent = !isDir && current === path;
	return (
		<li>
			<button
				type="button"
				className={`pk-changes-row${isCurrent ? " is-current" : ""}`}
				style={{ paddingLeft: `${level * 16 - 8}px` }}
				aria-expanded={isDir ? open : undefined}
				aria-current={isCurrent ? "true" : undefined}
				data-testid={`shared-row-${path}`}
				data-git={decoration?.kind ?? (dirty ? "dir" : undefined)}
				onClick={() => (isDir ? props.onToggle(path) : props.onOpen(path))}
			>
				<span className="pk-tree-twisty">
					{isDir ? (
						<Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
					) : null}
				</span>
				<Icon
					name={isDir ? (open ? "folder-open" : "folder") : fileIconName(name)}
					size="md"
				/>
				<span className={`pk-changes-path${ignored ? " pk-muted" : ""}`}>{shown}</span>
				{status ? <span className="pk-visually-hidden">, {status}</span> : null}
				{decoration ? (
					<span className="pk-git-letter" aria-hidden="true">
						{decoration.letter}
					</span>
				) : dirty ? (
					<span className="pk-git-dot" aria-hidden="true" />
				) : null}
			</button>
			{open ? (
				<ul className="pk-changes-list">
					<Directory {...props} dir={path} level={level + 1} />
				</ul>
			) : null}
		</li>
	);
}
