import { CourseStuckResponse } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../api/request.js";
import { dateTimeText } from "./time.js";

/**
 * "Who is stuck?" as a plain table (SPEC.md section 20.5): only the students
 * with a reason, most likely stuck first, from counts and times alone.
 */
export function CourseStuck({ courseId }: { courseId: string }) {
	const stuck = useQuery({
		queryKey: ["courses", courseId, "stuck"],
		queryFn: () => request(CourseStuckResponse, `/courses/${courseId}/stuck`),
		refetchOnWindowFocus: false,
	});
	const flagged = stuck.data?.students.filter((one) => one.reasons.length > 0);
	return (
		<section className="mt-10 grid gap-3" aria-labelledby="stuck-title">
			<h2 className="pk-text-heading m-0" id="stuck-title">
				Who is stuck?
			</h2>
			<p className="pk-text-body pk-muted m-0 max-w-prose">
				Students with failed checks in a row, live help requests, or no activity over
				the last 7 days, most likely stuck first.
			</p>
			{stuck.isError ? (
				<p className="pk-error text-status-error m-0" role="alert">
					Portikus could not work out who is stuck. Reload the page to try again.
				</p>
			) : flagged === undefined ? null : flagged.length === 0 ? (
				<p className="pk-text-body pk-muted m-0" data-testid="course-stuck-none">
					Nobody looks stuck right now.
				</p>
			) : (
				<div className="pk-table-wrap overflow-clip">
					<table className="pk-table pk-table--page" data-testid="course-stuck">
						<caption className="sr-only">Students who may be stuck</caption>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col">Why</th>
								<th scope="col">Last activity</th>
							</tr>
						</thead>
						<tbody>
							{flagged.map((student) => (
								<tr key={student.userId}>
									<th scope="row" className="font-semibold [overflow-wrap:anywhere]">
										{student.displayName}
									</th>
									<td className="whitespace-normal">{student.reasons.join(", ")}</td>
									<td className="pk-cell-muted">
										{student.lastActivityAt ? (
											<time dateTime={student.lastActivityAt}>
												{dateTimeText(student.lastActivityAt)}
											</time>
										) : (
											"Never"
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
