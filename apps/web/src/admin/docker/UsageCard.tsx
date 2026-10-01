import type { DockerAdminResponse, DockerImageUsage } from "@portikus/contracts";
import { Button, Skeleton, Toggletip, useToast } from "@portikus/ui";
import type { ReactNode } from "react";
import { AdminGroup } from "../AdminSection.js";
import { errorText } from "../SettingsTab.js";
import { shortTime } from "../shortTime.js";
import { useDockerUsage, useSaveSeedImages } from "./queries.js";
import { addRefusal, listHas, shortImageName, shownText } from "./text.js";

const SUB_HEADING = "pk-text-compact m-0 font-semibold text-ink-muted";

/**
 * Which images to add to the seed and which to drop (issue #840). Counts
 * only; names are shown as text, never as links or markup.
 */
export function UsageCard({ data }: { data: DockerAdminResponse }) {
	const usage = useDockerUsage();
	const save = useSaveSeedImages();
	const toast = useToast();
	const list = data.seedImages;

	function change(next: string[], name: string, added: boolean) {
		if (save.isPending) return;
		save.mutate(next, {
			onSuccess: () => {
				toast.show({
					tone: "success",
					title: added
						? `${name} added to the seed list`
						: `${name} removed from the seed list`,
					children: "It takes effect at the next seed rebuild.",
				});
				// The row's button is gone; its table heading keeps the place.
				document
					.getElementById(
						added ? "docker-usage-extra-title" : "docker-usage-unused-title",
					)
					?.focus();
			},
			onError: (failure) =>
				toast.show({
					tone: "danger",
					title: added ? `Could not add ${name}` : `Could not remove ${name}`,
					children: errorText(failure),
				}),
		});
	}

	return (
		<AdminGroup
			id="docker-usage-title"
			title="Image use"
			testId="docker-usage"
			help={
				<Toggletip label="image use">
					Counts come from the cache's pulls and from a look at each running workspace
					every hour. They never say which workspace or person.
				</Toggletip>
			}
		>
			{usage.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(usage.error)}
				</p>
			) : !usage.data ? (
				<Skeleton variant="block" height={120} />
			) : (
				<>
					<p className="pk-muted m-0 text-[13px]" data-testid="docker-usage-window">
						Over the last {usage.data.windowDays} days.
					</p>
					<section className="grid gap-2" aria-labelledby="docker-usage-extra-title">
						<h4 className={SUB_HEADING} id="docker-usage-extra-title" tabIndex={-1}>
							Used but not in the seed
						</h4>
						{usage.data.notInSeed.length === 0 ? (
							<p
								className="pk-muted m-0 text-[13px]"
								data-testid="docker-usage-extra-none"
							>
								No workspace used an image outside the seed.
							</p>
						) : (
							<UsageTable
								caption="Images used in workspaces that the seed does not hold"
								testId="docker-usage-extra"
								rows={usage.data.notInSeed}
								total={usage.data.notInSeedTotal}
								pulls
								action={(row) => {
									const name = shortImageName(row.image);
									if (listHas(list, name)) return "In the next rebuild";
									const refused = addRefusal(list, row.image, data.ghcrEnabled);
									if (refused) return <span className="pk-muted">{refused}</span>;
									return (
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Add to seed: ${name}`}
											aria-disabled={save.isPending || undefined}
											onClick={() => change([...list, name], name, true)}
										>
											Add to seed
										</Button>
									);
								}}
							/>
						)}
					</section>
					<section className="grid gap-2" aria-labelledby="docker-usage-unused-title">
						<h4 className={SUB_HEADING} id="docker-usage-unused-title" tabIndex={-1}>
							Seed images nobody used
						</h4>
						{usage.data.unusedSeed.length === 0 ? (
							<p
								className="pk-muted m-0 text-[13px]"
								data-testid="docker-usage-unused-none"
							>
								{data.seed
									? "Every seed image was used in at least one workspace."
									: "There is no seed yet."}
							</p>
						) : (
							<UsageTable
								caption="Seed images no workspace used"
								testId="docker-usage-unused"
								rows={usage.data.unusedSeed}
								total={usage.data.unusedSeedTotal}
								pulls={false}
								action={(row) => {
									const name = shortImageName(row.image);
									const entry = list.find((each) => listHas([each], row.image));
									if (entry === undefined) return "Not in the next rebuild";
									return (
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Remove from seed: ${entry}`}
											aria-disabled={save.isPending || undefined}
											onClick={() =>
												change(
													list.filter((each) => each !== entry),
													name,
													false,
												)
											}
										>
											Remove from seed
										</Button>
									);
								}}
							/>
						)}
					</section>
				</>
			)}
		</AdminGroup>
	);
}

function UsageTable({
	caption,
	testId,
	rows,
	total,
	pulls,
	action,
}: {
	caption: string;
	testId: string;
	rows: DockerImageUsage[];
	total: number;
	pulls: boolean;
	action: (row: DockerImageUsage) => ReactNode;
}) {
	const shown = shownText(rows.length, total);
	return (
		<>
			{shown ? (
				<p className="pk-muted m-0 text-[13px]" data-testid={`${testId}-shown`}>
					{shown}
				</p>
			) : null}
			<div className="pk-table-wrap">
				<table className="pk-table" data-testid={testId}>
					<caption className="sr-only">{caption}</caption>
					<thead>
						<tr>
							<th scope="col">Image</th>
							{pulls ? <th scope="col">Pulls</th> : null}
							<th scope="col">Workspaces</th>
							<th scope="col">Last seen</th>
							<th scope="col">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.image}>
								<th scope="row" className="font-mono [overflow-wrap:anywhere]">
									{shortImageName(row.image)}
								</th>
								{pulls ? <td>{row.pulls}</td> : null}
								<td>{row.workspaces}</td>
								<td>{row.lastSeen ? shortTime(row.lastSeen) : "Never"}</td>
								<td className="text-right">{action(row)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}
