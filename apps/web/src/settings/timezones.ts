/**
 * The timezone list the settings dialog shows (issue #287). There are a few
 * hundred zone names, so they are grouped by the region their name starts
 * with, and the zone in use is offered on its own at the top.
 */
import { TIMEZONES } from "@portikus/contracts";
import type { SelectGroup, SelectOption } from "@portikus/ui";

/** "America/Indiana/Knox" reads as "Indiana / Knox". */
export function zoneLabel(zone: string): string {
	const rest = zone.includes("/") ? zone.slice(zone.indexOf("/") + 1) : zone;
	return rest.replaceAll("_", " ").replaceAll("/", " / ");
}

function region(zone: string): string {
	return zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "Other";
}

/** The zone in use, shown first so it is never hunted for. */
export function currentZoneOption(current: string): SelectOption {
	return { value: current, label: `${current.replaceAll("_", " ")} (current)` };
}

/** Every other zone, by region. The current one is left out, it is on top. */
export function timezoneGroups(current: string): SelectGroup[] {
	const byRegion = new Map<string, SelectOption[]>();
	for (const zone of TIMEZONES) {
		if (zone === current) continue;
		const here = byRegion.get(region(zone)) ?? [];
		here.push({ value: zone, label: zoneLabel(zone) });
		byRegion.set(region(zone), here);
	}
	return [...byRegion]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, options]) => ({
			label,
			options: options.sort((a, b) => a.label.localeCompare(b.label)),
		}));
}
