import type { CourseProfile } from "@portikus/contracts";
import { Select, Skeleton, useToast } from "@portikus/ui";
import { useState } from "react";
import { errorText } from "../../api/request.js";
import {
	PROFILE_CHOICES,
	PROFILE_NOTE,
	PROFILE_SUMMARY,
	profileLabel,
} from "../../course/profileText.js";
import { AdminGroup } from "../AdminSection.js";
import { useAdminCourses, useSetAdminCourseProfile } from "./queries.js";

const OPTIONS = PROFILE_CHOICES.map(({ value, label }) => ({ value, label }));

/**
 * The LTI courses on the site and the interface their students get
 * (SPEC.md §8.7, §20.1). A change saves as soon as it is chosen.
 */
export function CoursesGroup() {
	const courses = useAdminCourses();
	const save = useSetAdminCourseProfile();
	const toast = useToast();
	const list = courses.data;
	// The choice asked for, kept in state so the select shows it before the request answers.
	const [asked, setAsked] = useState<{
		courseId: string;
		profile: CourseProfile;
	} | null>(null);

	function choose(courseId: string, title: string, profile: CourseProfile) {
		if (save.isPending) return;
		setAsked({ courseId, profile });
		save.mutate(
			{ courseId, profile },
			{
				onSettled: () => setAsked(null),
				onSuccess: (saved) =>
					toast.show({
						tone: "success",
						title: `${title} is now ${profileLabel(saved.profile)}`,
					}),
				onError: (failure) =>
					toast.show({
						tone: "danger",
						title: "Profile not saved",
						children: errorText(failure),
					}),
			},
		);
	}

	return (
		<AdminGroup
			id="admin-signin-courses"
			title="Courses"
			description={`${PROFILE_SUMMARY} ${PROFILE_NOTE}`}
			testId="admin-signin-courses"
		>
			{courses.isError ? (
				<p className="pk-text-compact m-0" data-testid="courses-error">
					{errorText(courses.error)}
				</p>
			) : !list ? (
				<Skeleton variant="block" height={96} />
			) : list.length === 0 ? (
				<p className="pk-text-compact pk-muted m-0" data-testid="courses-empty">
					No courses yet. A course appears here after someone opens Portikus from it in
					a learning management system.
				</p>
			) : (
				<ul className="m-0 grid list-none gap-0 p-0" data-testid="courses-list">
					{list.map((course) => {
						const pending = asked?.courseId === course.id;
						return (
							<li
								key={course.id}
								className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0 first:pt-0"
								data-testid="courses-row"
							>
								<div className="min-w-[min(100%,14rem)] flex-1 [overflow-wrap:anywhere]">
									<span className="pk-text-compact block font-semibold">
										{course.title}
									</span>
									<span className="pk-text-caption pk-muted block">
										{course.platformName}
									</span>
								</div>
								<div className="w-48 max-w-full">
									<Select
										id={`course-profile-${course.id}`}
										label={<span className="sr-only">Profile for {course.title}</span>}
										options={OPTIONS}
										value={pending ? asked.profile : course.profile}
										ariaDisabled={pending}
										onValueChange={(value) =>
											choose(course.id, course.title, value as CourseProfile)
										}
									/>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</AdminGroup>
	);
}
