import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SortAnnouncement, sortAnnouncement, useAnnouncedSort } from "./announce.js";
import { SortHeader } from "./SortHeader.js";
import { nextSort, type SortState, sortRows, sortText } from "./sort.js";

test("pressing the sorted column flips it; another column starts at its first direction", () => {
	const byName: SortState<"name" | "time"> = { column: "name", direction: "ascending" };
	expect(nextSort(byName, "name")).toEqual({ column: "name", direction: "descending" });
	expect(nextSort(nextSort(byName, "name"), "name")).toEqual(byName);
	expect(nextSort(byName, "time")).toEqual({ column: "time", direction: "ascending" });
	expect(nextSort(byName, "time", "descending")).toEqual({
		column: "time",
		direction: "descending",
	});
});

test("rows sort by text with numbers in order, ignoring case", () => {
	const rows = ["ws-10", "WS-2", "ws-1"];
	expect(sortRows(rows, (row) => row, "ascending")).toEqual(["ws-1", "WS-2", "ws-10"]);
	expect(sortRows(rows, (row) => row, "descending")).toEqual(["ws-10", "WS-2", "ws-1"]);
});

test("rows with no value go last in both directions, and ties keep their order", () => {
	const rows = [
		{ id: "a", value: 2 },
		{ id: "b", value: null },
		{ id: "c", value: 1 },
		{ id: "d", value: 2 },
	];
	const ids = (sorted: typeof rows) => sorted.map((row) => row.id);
	expect(ids(sortRows(rows, (row) => row.value, "ascending"))).toEqual([
		"c",
		"a",
		"d",
		"b",
	]);
	expect(ids(sortRows(rows, (row) => row.value, "descending"))).toEqual([
		"a",
		"d",
		"c",
		"b",
	]);
	// The input is left alone.
	expect(ids(rows)).toEqual(["a", "b", "c", "d"]);
});

test("the caption words name the column and the direction", () => {
	expect(sortText("Activity", "descending")).toBe("sorted by Activity, descending");
});

function header(sort: SortState<"name" | "time">, onSort = vi.fn()) {
	render(
		<table>
			<thead>
				<tr>
					<SortHeader column="name" label="Name" sort={sort} onSort={onSort} />
					<SortHeader
						column="time"
						label="Time"
						sort={sort}
						onSort={onSort}
						first="descending"
					/>
				</tr>
			</thead>
		</table>,
	);
	return onSort;
}

test("only the sorted column carries aria-sort, and each header is a named button", () => {
	header({ column: "name", direction: "ascending" });
	const [name, time] = screen.getAllByRole("columnheader");
	expect(name?.getAttribute("aria-sort")).toBe("ascending");
	expect(time?.hasAttribute("aria-sort")).toBe(false);
	expect(screen.getByRole("button", { name: "Name" })).toBeDefined();
	expect(screen.getByRole("button", { name: "Time" })).toBeDefined();
});

test("pressing a header asks for the next sort", () => {
	const onSort = header({ column: "name", direction: "ascending" });
	fireEvent.click(screen.getByRole("button", { name: "Name" }));
	expect(onSort).toHaveBeenLastCalledWith({ column: "name", direction: "descending" });
	fireEvent.click(screen.getByRole("button", { name: "Time" }));
	expect(onSort).toHaveBeenLastCalledWith({ column: "time", direction: "descending" });
});

test("the sorted column's chevron shows the direction; other headers draw none", () => {
	header({ column: "time", direction: "descending" });
	const icon = (name: string) =>
		screen
			.getByRole("button", { name })
			.querySelector("svg")
			?.getAttribute("data-icon");
	expect(icon("Time")).toBe("chevron-down");
	expect(icon("Name")).toBeUndefined();
});

test("an unsorted header is described as sortable; the sorted one is not", () => {
	header({ column: "name", direction: "ascending" });
	const name = screen.getByRole("button", { name: "Name" });
	const time = screen.getByRole("button", { name: "Time" });
	expect(name.hasAttribute("aria-description")).toBe(false);
	expect(time.getAttribute("aria-description")).toBe("Sort by this column");
	// No text is added to the cell, so the header reads only its label.
	expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
		"Name",
		"Time",
	]);
	// The unsorted column draws its faint hint the way its first press sorts, outside the button.
	const hint = screen
		.getAllByRole("columnheader")[1]
		?.querySelector(".pk-table-sort-hint");
	expect(hint?.getAttribute("data-icon")).toBe("chevron-down");
	expect(time.contains(hint ?? null)).toBe(false);
});

function AnnouncedTable() {
	const { sort, setSort, announcement } = useAnnouncedSort<"name" | "time">(
		{ column: "name", direction: "ascending" },
		{ name: "Name", time: "Time" },
	);
	return (
		<>
			<table>
				<thead>
					<tr>
						<SortHeader column="name" label="Name" sort={sort} onSort={setSort} />
						<SortHeader column="time" label="Time" sort={sort} onSort={setSort} />
					</tr>
				</thead>
			</table>
			<SortAnnouncement text={announcement} testId="announce" />
		</>
	);
}

test("each press is announced in a polite region, a repeat press too", () => {
	render(<AnnouncedTable />);
	const region = screen.getByTestId("announce");
	expect(region.getAttribute("role")).toBe("status");
	// Nothing is said before the first press.
	expect(region.textContent).toBe("");
	fireEvent.click(screen.getByRole("button", { name: "Time" }));
	expect(region.textContent).toBe("Sorted by Time, ascending");
	fireEvent.click(screen.getByRole("button", { name: "Time" }));
	expect(region.textContent).toBe("Sorted by Time, descending");
	fireEvent.click(screen.getByRole("button", { name: "Name" }));
	expect(region.textContent).toBe("Sorted by Name, ascending");
});

test("the announcement starts with a capital", () => {
	expect(sortAnnouncement("Workspace", "descending")).toBe(
		"Sorted by Workspace, descending",
	);
});
