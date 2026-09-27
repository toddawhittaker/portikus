import { AdminPackagesResponse } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { ApiError, request } from "../../api/request.js";

/** "27 September 2026" for a survey day, which is a UTC date. */
export function surveyDay(day: string): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

/**
 * "Packages students add" on the Health tab (SPEC.md §20.1, ADR 0042):
 * site-wide counts from the latest survey day, never a workspace's own list.
 */
export function PackagesSection() {
	const survey = useQuery({
		queryKey: ["admin", "packages"],
		queryFn: () => request(AdminPackagesResponse, "/admin/packages"),
	});
	return (
		<section className="pk-card mt-6 p-6" aria-labelledby="health-packages-title">
			<h3 className="pk-text-heading m-0" id="health-packages-title">
				Packages students add
			</h3>
			{survey.isError ? (
				<p className="pk-error text-status-error mt-4" role="alert">
					{survey.error instanceof ApiError
						? survey.error.message
						: "The package survey could not be loaded."}
				</p>
			) : !survey.data ? (
				<div aria-busy="true" data-testid="packages-loading" />
			) : (
				<PackagesTable survey={survey.data} />
			)}
		</section>
	);
}

// The API keeps a day's rows back until this many workspaces were surveyed.
const MIN_SURVEYED = 3;

export function PackagesTable({ survey }: { survey: AdminPackagesResponse }) {
	if (survey.day === null || survey.packages.length === 0) {
		return (
			<p className="pk-muted m-0 mt-4 text-[13px]" data-testid="packages-empty">
				{survey.day === null
					? "No workspace has been surveyed yet."
					: survey.surveyed < MIN_SURVEYED
						? `Not enough workspaces surveyed on ${surveyDay(survey.day)}. Packages show once at least ${MIN_SURVEYED} are surveyed in a day.`
						: `No surveyed workspace had added a package on ${surveyDay(survey.day)}.`}
			</p>
		);
	}
	const surveyed = `${survey.surveyed} workspace${survey.surveyed === 1 ? "" : "s"} surveyed on ${surveyDay(survey.day)}`;
	return (
		<div className="pk-table-wrap mt-4">
			<table className="pk-table" data-testid="packages-table">
				<caption className="pk-text-label pk-muted text-left">
					Packages added with sudo apt, out of {surveyed}. A package added in at least 2
					workspaces, and in at least a third of those surveyed, is a base-image
					candidate.
				</caption>
				<thead>
					<tr>
						<th scope="col">Package</th>
						<th scope="col">Workspaces</th>
						<th scope="col">First seen</th>
						<th scope="col">Last seen</th>
					</tr>
				</thead>
				<tbody>
					{survey.packages.map((row) => (
						<tr key={row.package} data-testid="packages-row">
							<th scope="row" className="font-mono font-normal">
								{row.package}
								{row.candidate ? (
									<span className="pk-tag ml-2 font-sans">Base-image candidate</span>
								) : null}
							</th>
							<td className="pk-num">
								{row.workspaces} of {survey.surveyed}
							</td>
							<td>
								<time dateTime={row.firstSeen}>{surveyDay(row.firstSeen)}</time>
							</td>
							<td>
								<time dateTime={row.lastSeen}>{surveyDay(row.lastSeen)}</time>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
