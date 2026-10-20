import type { CourseProfile as Profile } from "@portikus/contracts";
import { Skeleton, useToast } from "@portikus/ui";
import { useState } from "react";
import { Choice } from "../admin/certificate/Choice.js";
import { errorText } from "../api/request.js";
import { PROFILE_CHOICES, PROFILE_NOTE, profileLabel } from "./profileText.js";
import { useCourses, useSetCourseProfile } from "./queries.js";

/**
 * The instructor's choice of interface for the students of one course
 * (SPEC.md §8.7). It saves as soon as a choice is made.
 */
export function CourseProfile({ courseId }: { courseId: string }) {
	const courses = useCourses();
	const save = useSetCourseProfile(courseId);
	const toast = useToast();
	const course = courses.data?.find((item) => item.id === courseId);
	// While saving, show the choice asked for rather than the old one. It is
	// state, not the mutation's variables, so a controlled radio never snaps back.
	const [asked, setAsked] = useState<Profile | null>(null);
	const shown = asked ?? course?.profile;

	return (
		<section
			className="flex max-w-[72ch] flex-col gap-3"
			aria-labelledby="profile-title"
		>
			<h2 className="pk-text-heading m-0" id="profile-title">
				Student interface
			</h2>
			{shown ? (
				<>
					<Choice
						legend="Interface for students in this course"
						name="course-profile"
						value={shown}
						choices={PROFILE_CHOICES}
						onChange={(profile) => {
							if (save.isPending || profile === course?.profile) return;
							setAsked(profile);
							save.mutate(profile, {
								onSettled: () => setAsked(null),
								onSuccess: (saved) =>
									toast.show({
										tone: "success",
										title: `${profileLabel(saved.profile)} saved`,
										children:
											"Students see the change when they next load the page or return to the window.",
									}),
								onError: (failure) =>
									toast.show({
										tone: "danger",
										title: "Profile not saved",
										children: errorText(failure),
									}),
							});
						}}
					/>
					<p className="pk-text-compact pk-muted m-0">{PROFILE_NOTE}</p>
				</>
			) : courses.isError ? (
				<p className="pk-text-compact m-0" data-testid="course-profile-error">
					Portikus could not load this course's interface setting. Reload the page to
					try again.
				</p>
			) : (
				<Skeleton variant="block" height={96} />
			)}
		</section>
	);
}
