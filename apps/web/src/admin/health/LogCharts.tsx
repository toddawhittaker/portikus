import type { HealthRange } from "@portikus/contracts";

/**
 * Stub until Epic 19 T5 fills it: errors and warnings per bucket, read from
 * `GET /admin/logs/counts`, not from the series route. Renders nothing.
 */
export function LogCharts(_props: { range: HealthRange }) {
	return null;
}
