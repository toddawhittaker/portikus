/** Issue #287: how the zone list the server sent is offered in the dialog. */
import { expect, test } from "vitest";
import { currentZoneOption, timezoneGroups, zoneLabel } from "./timezones.js";

/** A stand-in for the list `GET /me/settings` hands over. */
const ZONES = [
	"UTC",
	"America/New_York",
	"America/Indiana/Knox",
	"Europe/Berlin",
	"Europe/Madrid",
	"Asia/Tokyo",
];

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
	const groups = timezoneGroups(ZONES, current);
	const values = groups.flatMap((group) => group.options.map((o) => o.value));
	expect(values).not.toContain(current);
	expect(new Set(values).size).toBe(values.length);
	expect(values.length).toBe(ZONES.length - 1);
});

/**
 * The whole point of taking the list from the server: the select offers every
 * name the API accepts and no name it does not.
 */
test("the select offers exactly the list the server sent", () => {
	const current = "Europe/Berlin";
	const groups = timezoneGroups(ZONES, current);
	const offered = [
		currentZoneOption(current).value,
		...groups.flatMap((group) => group.options.map((o) => o.value)),
	];
	expect([...offered].sort()).toEqual([...ZONES].sort());
});

test("the groups are regions in order, and hold every other zone", () => {
	const groups = timezoneGroups(ZONES, "America/New_York");
	const labels = groups.map((group) => group.label);
	expect(labels).toEqual(["America", "Asia", "Europe", "Other"]);
	const europe = groups.find((group) => group.label === "Europe");
	expect(europe?.options.map((o) => o.value)).toEqual([
		"Europe/Berlin",
		"Europe/Madrid",
	]);
	// A name with no region, such as UTC, still has a home.
	const other = groups.find((group) => group.label === "Other");
	expect(other?.options.map((o) => o.value)).toEqual(["UTC"]);
});
