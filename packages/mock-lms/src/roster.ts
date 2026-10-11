import {
	COURSES,
	findRosterPerson,
	INITIAL_ROSTERS,
	type Person,
	ROLE_URIS,
	type RoleName,
} from "./seed.js";

export const NRPS_CLAIM =
	"https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice";
export const NRPS_SCOPE =
	"https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";

const DEFAULT_PAGE_SIZE = 3;
const MAX_PAGE_SIZE = 100;

interface Member {
	person: Person;
	role: RoleName;
}

export function membershipsUrl(issuer: string, courseId: string): string {
	return `${issuer}/nrps/${courseId}/memberships`;
}

/** The mutable course rosters behind the memberships endpoint. */
export function createRosters() {
	const rosters = new Map<string, Member[]>();

	function reset() {
		rosters.clear();
		for (const course of COURSES) {
			const members: Member[] = [];
			for (const key of INITIAL_ROSTERS[course.key] ?? []) {
				const person = findRosterPerson(key);
				if (person) members.push({ person, role: person.role });
			}
			rosters.set(course.key, members);
		}
	}
	reset();

	function members(courseKey: string): Member[] | undefined {
		return rosters.get(courseKey);
	}

	return {
		reset,
		add(courseKey: string, person: Person, role: RoleName) {
			const list = members(courseKey);
			if (!list) return false;
			const existing = list.find((m) => m.person.key === person.key);
			if (existing) existing.role = role;
			else list.push({ person, role });
			return true;
		},
		drop(courseKey: string, personKey: string) {
			const list = members(courseKey);
			const index = list?.findIndex((m) => m.person.key === personKey) ?? -1;
			if (!list || index < 0) return false;
			list.splice(index, 1);
			return true;
		},
		setRole(courseKey: string, personKey: string, role: RoleName) {
			const member = members(courseKey)?.find((m) => m.person.key === personKey);
			if (!member) return false;
			member.role = role;
			return true;
		},
		/** One page of the NRPS response and the next page's URL, if there is one. */
		page(
			issuer: string,
			courseKey: string,
			pageParam: string | null,
			limitParam: string | null,
		) {
			const course = COURSES.find((c) => c.key === courseKey);
			const list = members(courseKey);
			if (!course || !list) return undefined;
			const limit = Math.min(
				Math.max(Number.parseInt(limitParam ?? "", 10) || DEFAULT_PAGE_SIZE, 1),
				MAX_PAGE_SIZE,
			);
			const pageNumber = Math.max(Number.parseInt(pageParam ?? "", 10) || 1, 1);
			const slice = list.slice((pageNumber - 1) * limit, pageNumber * limit);
			const base = membershipsUrl(issuer, course.id);
			const next =
				pageNumber * limit < list.length
					? `${base}?page=${pageNumber + 1}&limit=${limit}`
					: undefined;
			return {
				next,
				body: {
					id: base,
					context: { id: course.id, label: course.label, title: course.title },
					// No email: a roster service shares less than a launch does.
					members: slice.map((m) => ({
						status: "Active",
						user_id: m.person.sub,
						name: `${m.person.givenName} ${m.person.familyName}`,
						given_name: m.person.givenName,
						family_name: m.person.familyName,
						roles: [ROLE_URIS[m.role]],
					})),
				},
			};
		},
	};
}

export type Rosters = ReturnType<typeof createRosters>;
