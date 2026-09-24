// Fixed people and courses. The `sub` values never change, so a repeated launch finds the same user.

export const ROLE_URIS = {
	Instructor: "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
	TeachingAssistant:
		"http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant",
	Learner: "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
	Administrator:
		"http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
} as const;

export type RoleName = keyof typeof ROLE_URIS;
export const ROLE_NAMES = Object.keys(ROLE_URIS) as RoleName[];

export interface Person {
	key: string;
	sub: string;
	givenName: string;
	familyName: string;
	email: string;
	role: RoleName;
}

export interface Course {
	key: string;
	id: string;
	label: string;
	title: string;
}

export const PEOPLE: readonly Person[] = [
	{
		key: "ivy",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1001",
		givenName: "Ivy",
		familyName: "Instructor",
		email: "ivy@mock-lms.test",
		role: "Instructor",
	},
	{
		key: "tom",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1002",
		givenName: "Tom",
		familyName: "Assistant",
		email: "tom@mock-lms.test",
		role: "TeachingAssistant",
	},
	{
		key: "sam",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1003",
		givenName: "Sam",
		familyName: "Student",
		email: "sam@mock-lms.test",
		role: "Learner",
	},
	{
		key: "lee",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1004",
		givenName: "Lee",
		familyName: "Learner",
		email: "lee@mock-lms.test",
		role: "Learner",
	},
	{
		key: "ada",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1005",
		givenName: "Ada",
		familyName: "Admin",
		email: "ada@mock-lms.test",
		role: "Administrator",
	},
	{
		key: "rex",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1601",
		givenName: "Rex",
		familyName: "Remover",
		email: "rex@mock-lms.test",
		role: "Instructor",
	},
	{
		key: "una",
		sub: "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a1602",
		givenName: "Una",
		familyName: "Unenrolled",
		email: "una@mock-lms.test",
		role: "Learner",
	},
];

export const COURSES: readonly Course[] = [
	{
		key: "cs101",
		id: "mock-course-cs101",
		label: "CS 101",
		title: "CS 101 Intro to Programming",
	},
	{
		key: "cs240",
		id: "mock-course-cs240",
		label: "CS 240",
		title: "CS 240 Data Structures",
	},
	{
		key: "cs350",
		id: "mock-course-cs350",
		label: "CS 350",
		title: "CS 350 Software Engineering",
	},
];

export const CLIENT_ID = "portikus-mock";
export const DEPLOYMENT_ID = "mock-deployment-1";

export function findPerson(key: string): Person | undefined {
	return PEOPLE.find((p) => p.key === key);
}

export function findCourse(key: string): Course | undefined {
	return COURSES.find((c) => c.key === key);
}

export function isRoleName(value: string): value is RoleName {
	return (ROLE_NAMES as string[]).includes(value);
}
