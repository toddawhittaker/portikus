/** Issue #287: how the zone list is offered in the settings dialog. */
import { TIMEZONES } from "@portikus/contracts";
import { expect, test } from "vitest";
import { currentZoneOption, timezoneGroups, zoneLabel } from "./timezones.js";

test("a zone reads without its region or underscores", () => {
	expect(zoneLabel("America/New_York")).toBe("New York");
	expect(zoneLabel("America/Indiana/Knox")).toBe("Indiana / Knox");
	expect(zoneLabel("UTC")).toBe("UTC");
});

test("the zone in use is offered on its own, and only once", () => {
	const current = "America/New_York";
	expect(currentZoneOption(current)).toEqual({
		value: current,
		label: "America/New York (current)",
	});
	const groups = timezoneGroups(current);
	const values = groups.flatMap((group) => group.options.map((o) => o.value));
	expect(values).not.toContain(current);
	expect(new Set(values).size).toBe(values.length);
	expect(values.length).toBe(TIMEZONES.length - 1);
});

test("the groups are regions in order, and hold every other zone", () => {
	const groups = timezoneGroups("America/New_York");
	const labels = groups.map((group) => group.label);
	expect(labels).toContain("America");
	expect(labels).toContain("Europe");
	expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
	const europe = groups.find((group) => group.label === "Europe");
	expect(europe?.options.map((o) => o.value)).toContain("Europe/Berlin");
});
