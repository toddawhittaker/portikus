import {
	LOG_LEVELS,
	LOG_SERVICES,
	type LogLevel,
	type LogService,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	Toggletip,
} from "@portikus/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { SortAnnouncement, useAnnouncedSort } from "../../table/announce.js";
import { AdminSection } from "../AdminSection.js";
import {
	personLabel,
	personOptions,
	resolvePerson,
	workspaceLabel,
} from "../people.js";
import { useAdminUsers } from "../queries.js";
import {
	DEFAULT_LEVELS,
	DEFAULT_WINDOW,
	filtersFromSearch,
	fromLocalInput,
	LOG_WINDOWS,
	type LogFilters,
	type LogWindow,
	searchFromFilters,
	toLocalInput,
	WINDOW_LABELS,
} from "./filters.js";
import { LogResults } from "./LogResults.js";
import { LEVEL_LABELS, SERVICE_LABELS } from "./line.js";
import "./logs.css";
import { ServiceLogLevel } from "./ServiceLogLevel.js";
import { DEFAULT_LOG_SORT, LOG_COLUMN_LABEL } from "./sort.js";

/** The form's copy of the filters; times are `datetime-local` values. */
interface Draft {
	levels: LogLevel[];
	services: LogService[];
	window: LogWindow | "custom";
	from: string;
	to: string;
	q: string;
	/** What the Person field holds; null until the admin types, so it follows the URL. */
	person: string | null;
	/** Whether a workspace filter from a link stays on. */
	onlyWorkspace: boolean;
}

function draftOf(filters: LogFilters): Draft {
	const preset = LOG_WINDOWS.find((item) => item === filters.since);
	return {
		levels: filters.levels,
		services: filters.services,
		window: preset && !filters.until ? preset : "custom",
		from: preset ? "" : toLocalInput(filters.since),
		to: toLocalInput(filters.until),
		q: filters.q,
		person: null,
		onlyWorkspace: filters.workspace !== "",
	};
}

/**
 * A filter chip that is a real checkbox: the box is drawn as the level's dot,
 * so the chip reads as a toggle and still checks like any box.
 */
function ChipCheck({
	label,
	kind,
	checked,
	onChange,
}: {
	label: string;
	kind: LogLevel | "service";
	checked: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<label className="pk-chipcheck" data-kind={kind}>
			<input
				type="checkbox"
				className="pk-chipcheck-box"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
	return on ? [...list, item] : list.filter((value) => value !== item);
}

/** The form's checked fields, in the order they appear. */
const FIELD_ORDER = ["levels", "from", "to", "person"] as const;
const FIELD_IDS: Record<Exclude<(typeof FIELD_ORDER)[number], "levels">, string> = {
	from: "logs-from",
	to: "logs-to",
	person: "logs-person",
};

/**
 * The Logs tab (SPEC.md section 24.11): the platform's own JSON
 * lines from the journal, filtered by the URL, newest first.
 */
export function LogsTab() {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const filters = filtersFromSearch(search);
	const key = JSON.stringify(filters);
	const navigate = useNavigate();
	const users = useAdminUsers({ poll: false });
	const userList = users.data?.users ?? [];
	const people = personOptions(userList);
	const [draft, setDraft] = useState(() => draftOf(filters));
	const [draftKey, setDraftKey] = useState(key);
	const [invalid, setInvalid] = useState<Record<string, string>>({});
	// Kept here, not in the results, so a new filter does not reset it.
	const [auto, setAuto] = useState(true);
	const { sort, setSort, announcement } = useAnnouncedSort(
		DEFAULT_LOG_SORT,
		LOG_COLUMN_LABEL,
	);
	const formRef = useRef<HTMLFormElement>(null);
	// A new link (a chart bar, "View logs") refills the form.
	if (draftKey !== key) {
		setDraftKey(key);
		setDraft(draftOf(filters));
	}
	const personText =
		draft.person ?? (filters.user ? personLabel(people, filters.user) : "");

	function show(next: LogFilters) {
		void navigate({
			to: "/admin/$tab",
			params: { tab: "logs" },
			search: searchFromFilters(next),
		});
	}

	function apply(event: FormEvent) {
		event.preventDefault();
		const person =
			draft.person === null
				? { id: filters.user }
				: resolvePerson(draft.person, users.data?.users);
		const since = draft.window === "custom" ? fromLocalInput(draft.from) : draft.window;
		const until = draft.window === "custom" ? fromLocalInput(draft.to) : "";
		const errors: Record<string, string> = {};
		if (draft.levels.length === 0) errors.levels = "Choose at least one level.";
		if ("error" in person) errors.person = person.error;
		if (draft.window === "custom" && since === "") errors.from = "Enter a start time.";
		if (since !== "" && until !== "" && !errors.from && since > until) {
			errors.to = "The end must not be before the start.";
		}
		setInvalid(errors);
		const first = FIELD_ORDER.find((name) => errors[name]);
		if (first || "error" in person) {
			// Focus the first bad field so a screen reader hears its error.
			const target =
				first === "levels"
					? formRef.current?.querySelector<HTMLElement>("[data-level-checks] input")
					: document.getElementById(FIELD_IDS[first ?? "person"]);
			// Focusing the field that already has focus says nothing, so leave it first.
			if (target && target === document.activeElement) target.blur();
			target?.focus();
			return;
		}
		show({
			levels: draft.levels,
			services: draft.services,
			since,
			until,
			q: draft.q.trim(),
			user: person.id,
			workspace: draft.onlyWorkspace ? filters.workspace : "",
		});
	}

	function clear() {
		const cleared: LogFilters = {
			levels: [...DEFAULT_LEVELS],
			services: [],
			since: DEFAULT_WINDOW,
			until: "",
			q: "",
			user: "",
			workspace: "",
		};
		setInvalid({});
		// Also reset here: when the URL is already clear, nothing else refills the form.
		setDraft(draftOf(cleared));
		show(cleared);
	}

	return (
		<AdminSection
			title="Logs"
			intro={{
				id: "admin-logs",
				helpAnchor: "admin-logs",
				lead: "The platform's own error, warning, info and debug lines.",
				text: "They never include students' files, commands or terminal output.",
			}}
		>
			<form ref={formRef} onSubmit={apply} data-testid="logs-filters" noValidate>
				{/* One bar: what to search for on the first line, which lines on the second. */}
				<fieldset className="pk-logbar m-0 min-w-0 border-0">
					<legend className="sr-only">Filters</legend>
					<div className="pk-logbar-row">
						<TextField
							id="logs-text"
							label="Text"
							type="search"
							className="pk-logbar-search"
							maxLength={200}
							placeholder="Code, message or error"
							value={draft.q}
							onChange={(event) => setDraft({ ...draft, q: event.target.value })}
						/>
						<TextField
							id="logs-person"
							label="Person"
							type="search"
							className="w-56"
							list="logs-people"
							autoComplete="off"
							placeholder="Name or email"
							value={personText}
							error={invalid.person}
							onChange={(event) => setDraft({ ...draft, person: event.target.value })}
						/>
						<datalist id="logs-people">
							{people.map((option) => (
								<option key={option.id} value={option.label} />
							))}
						</datalist>
						{/* A native select, as in the Users filter bar. */}
						<div className={FIELD_CLASS}>
							<label className={LABEL_CLASS} htmlFor="logs-window">
								Time
							</label>
							<select
								id="logs-window"
								className={`${CONTROL_CLASS} w-36 cursor-pointer`}
								data-testid="logs-window"
								value={draft.window}
								onChange={(event) =>
									setDraft({ ...draft, window: event.target.value as Draft["window"] })
								}
							>
								{LOG_WINDOWS.map((window) => (
									<option key={window} value={window}>
										{WINDOW_LABELS[window]}
									</option>
								))}
								<option value="custom">Custom</option>
							</select>
						</div>
						{draft.window === "custom" ? (
							<>
								<TextField
									id="logs-from"
									label="From"
									type="datetime-local"
									className="w-56"
									value={draft.from}
									error={invalid.from}
									onChange={(event) => setDraft({ ...draft, from: event.target.value })}
								/>
								<TextField
									id="logs-to"
									label="To"
									type="datetime-local"
									className="w-56"
									hint="Leave empty for now."
									value={draft.to}
									error={invalid.to}
									onChange={(event) => setDraft({ ...draft, to: event.target.value })}
								/>
							</>
						) : null}
						<div className="pk-logbar-actions">
							<Button variant="primary" type="submit" data-testid="logs-filter-apply">
								Apply filters
							</Button>
							<Button type="button" data-testid="logs-filter-clear" onClick={clear}>
								Clear
							</Button>
						</div>
					</div>
					<div className="pk-logbar-row pk-logbar-row--chips">
						<fieldset
							className="pk-logbar-chips"
							// Named by the word alone, not also by its help button.
							aria-labelledby="logs-levels-label"
							aria-describedby={invalid.levels ? "logs-levels-err" : undefined}
						>
							<legend className="pk-logbar-legend">
								<span className="pk-overline" id="logs-levels-label">
									Levels
								</span>
								<Toggletip label="Levels">
									Debug lines exist only while the service log level is Debug. Info
									lines exist unless it is Warn or Error.
								</Toggletip>
							</legend>
							<div className="pk-logbar-chip-list" data-level-checks>
								{LOG_LEVELS.map((level) => (
									<ChipCheck
										key={level}
										label={LEVEL_LABELS[level]}
										kind={level}
										checked={draft.levels.includes(level)}
										onChange={(on) =>
											setDraft({ ...draft, levels: toggled(draft.levels, level, on) })
										}
									/>
								))}
							</div>
							{invalid.levels ? (
								<p
									id="logs-levels-err"
									className="pk-error m-0 basis-full text-[12px] leading-4 text-status-error"
								>
									{invalid.levels}
								</p>
							) : null}
						</fieldset>
						<fieldset className="pk-logbar-chips" aria-labelledby="logs-services-label">
							<legend className="pk-logbar-legend">
								<span className="pk-overline" id="logs-services-label">
									Services
								</span>
								<Toggletip label="Services">
									API answers the browser's requests. Worker runs the background jobs:
									starting, stopping and rebuilding workspaces, the resource guard and
									health samples. Controller talks to the host that runs the workspaces.
									Network is the host firewall: a workspace that sent mail or hit its
									outbound connection or packet limit.
								</Toggletip>
							</legend>
							<div className="pk-logbar-chip-list">
								{LOG_SERVICES.map((service) => (
									<ChipCheck
										key={service}
										label={SERVICE_LABELS[service]}
										kind="service"
										checked={
											draft.services.length === 0 || draft.services.includes(service)
										}
										onChange={(on) => {
											const current =
												draft.services.length === 0
													? [...LOG_SERVICES]
													: draft.services;
											setDraft({ ...draft, services: toggled(current, service, on) });
										}}
									/>
								))}
							</div>
						</fieldset>
						{filters.workspace ? (
							<div className="flex h-[var(--pk-control)] items-center">
								<Checkbox
									label={workspaceLabel(people, filters.workspace)}
									checked={draft.onlyWorkspace}
									onChange={(event) =>
										setDraft({ ...draft, onlyWorkspace: event.target.checked })
									}
								/>
							</div>
						) : null}
					</div>
				</fieldset>
			</form>
			{/* Only the results re-key on new filters, so the focused form button stays. */}
			<LogResults
				key={key}
				filters={filters}
				auto={auto}
				setAuto={setAuto}
				sort={sort}
				setSort={setSort}
				// A setting, not a filter: it sits with the results' own controls, clear of the filter bar.
				settings={<ServiceLogLevel />}
			/>
			<SortAnnouncement text={announcement} testId="logs-sort-announce" />
		</AdminSection>
	);
}
