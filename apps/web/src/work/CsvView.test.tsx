/**
 * A CSV file's table view (SPEC.md §13.2): a real table with column headers,
 * a scroll area the keyboard reaches, a row cap that says so, and a way back
 * to the text when the file is not valid CSV. Cells are text, never markup
 * (SPEC.md §24.2).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CsvView } from "./CsvView.js";

test("the first row heads the columns and the rest are cells", () => {
	render(
		<CsvView
			path="data/marks.csv"
			text={"name,score\nAnn,9\n"}
			onShowText={() => {}}
		/>,
	);
	const headers = screen.getAllByRole("columnheader");
	expect(headers.map((h) => h.textContent)).toEqual(["name", "score"]);
	expect(headers.every((h) => h.getAttribute("scope") === "col")).toBe(true);
	expect(screen.getByRole("cell", { name: "9" })).not.toBeNull();
	expect(screen.queryByTestId("csv-row-cap")).toBeNull();
});

test("the scroll area takes focus and is named after the file", () => {
	render(<CsvView path="data/marks.csv" text={"a\n1\n"} onShowText={() => {}} />);
	const region = screen.getByRole("region", { name: "marks.csv table" });
	expect(region.tabIndex).toBe(0);
	expect(within(region).getByRole("table")).not.toBeNull();
});

test("a short row is padded so every column lines up, and a wide one gets a named header", () => {
	render(<CsvView path="x.csv" text={"a,b\n1\n2,3,4\n"} onShowText={() => {}} />);
	const rows = screen.getAllByRole("row");
	expect(rows.map((row) => row.children.length)).toEqual([3, 3, 3]);
	expect(screen.getByRole("columnheader", { name: "Column 3" })).not.toBeNull();
});

test("only the first 1,000 rows are drawn, and the note says how many there are", () => {
	const text = ["n", ...Array.from({ length: 1234 }, (_, i) => String(i))].join("\n");
	render(<CsvView path="big.csv" text={text} onShowText={() => {}} />);
	expect(screen.getAllByRole("row")).toHaveLength(1001);
	expect(screen.getByTestId("csv-row-cap").textContent).toBe(
		"Showing the first 1,000 of 1,234 rows.",
	);
});

test("markup in a cell is text", () => {
	const { container } = render(
		<CsvView
			path="x.csv"
			text={'a\n"<img src=x onerror=alert(1)>"\n'}
			onShowText={() => {}}
		/>,
	);
	expect(container.querySelector("img")).toBeNull();
	expect(screen.getByRole("cell").textContent).toBe("<img src=x onerror=alert(1)>");
});

test("a file that is not valid CSV says so and offers the text", () => {
	const onShowText = vi.fn();
	render(<CsvView path="x.csv" text={'a\n"open\n'} onShowText={onShowText} />);
	expect(
		screen.getByRole("heading", { name: "This file could not be read as CSV" }),
	).not.toBeNull();
	expect(screen.queryByRole("table")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Show as text" }));
	expect(onShowText).toHaveBeenCalledOnce();
});

test("an empty file says so instead of drawing an empty table", () => {
	render(<CsvView path="x.csv" text="" onShowText={() => {}} />);
	expect(screen.getByRole("heading", { name: "This file is empty" })).not.toBeNull();
	expect(screen.queryByRole("table")).toBeNull();
});

test("a header with nothing under it says so", () => {
	render(<CsvView path="x.csv" text={"a,b\n"} onShowText={() => {}} />);
	expect(screen.getAllByRole("columnheader")).toHaveLength(2);
	expect(
		screen.getByText("This file has a header row and no rows under it."),
	).not.toBeNull();
});
