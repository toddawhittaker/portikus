import {
	canonicalImageName,
	type DockerCacheStatus,
	HubCredentialRequest,
	OTHER_IMAGES_LABEL,
	REGISTRY_AUTO_CLEAR_PERCENT,
	SEED_IMAGE_MAX_LENGTH,
	SEED_IMAGES_MAX,
	SEED_MAX_GIB_LIMIT,
	seedImageListFor,
} from "@portikus/contracts";
import { formatBytes } from "../../monitor/format.js";

/**
 * A canonical name as a person writes it: `docker.io/library/redis:7` is
 * `redis:7`, `docker.io/bitnami/redis:7` is `bitnami/redis:7`. ghcr.io keeps
 * its prefix, and "(other images)" stays as it is.
 */
export function shortImageName(name: string): string {
	if (name.startsWith("docker.io/library/"))
		return name.slice("docker.io/library/".length);
	if (name.startsWith("docker.io/")) return name.slice("docker.io/".length);
	return name;
}

/** Whether `list` holds `image`, compared as Docker would. */
export function listHas(list: readonly string[], image: string): boolean {
	const wanted = canonicalImageName(image);
	return list.some((each) => canonicalImageName(each) === wanted);
}

/** Why `list` cannot be saved now, in the contract's words as a sentence, or null. */
export function seedListError(list: string[], ghcrEnabled: boolean): string | null {
	const parsed = seedImageListFor(ghcrEnabled).safeParse(list);
	if (parsed.success) return null;
	const issue = parsed.error.issues[0];
	// The two length caps carry zod's generic wording; the rest are the contract's.
	if (issue?.code === "too_big") {
		return issue.path.length === 0
			? `The seed can hold at most ${SEED_IMAGES_MAX} images.`
			: `An image name can be at most ${SEED_IMAGE_MAX_LENGTH} characters.`;
	}
	const message = issue?.message ?? "This image list cannot be saved";
	return message.endsWith(".") ? message : `${message}.`;
}

/** Why `image` cannot be added to `list` from the usage report, or null. */
export function addRefusal(
	list: string[],
	image: string,
	ghcrEnabled: boolean,
): string | null {
	if (image === OTHER_IMAGES_LABEL) return "Stands for many images.";
	// Short, because it sits in a table cell.
	if (!ghcrEnabled && image.startsWith("ghcr.io/"))
		return "Needs the ghcr.io cache on.";
	if (
		!ghcrEnabled &&
		list.some((each) => canonicalImageName(each).startsWith("ghcr.io/"))
	)
		return "The seed list has ghcr.io images; turn on the ghcr.io cache or remove them first.";
	return seedListError([...list, shortImageName(image)], ghcrEnabled);
}

/** "4.1 GB of 20 GB used", or null before the cache first reports. */
export function cacheUseText(cache: DockerCacheStatus | null): string | null {
	if (!cache) return null;
	return `${formatBytes(cache.usedBytes)} of ${formatBytes(cache.sizeBytes)} used`;
}

/** Where the cache meter's tick goes: the point the cache empties itself. */
export function autoClearBytes(cache: DockerCacheStatus): number {
	return (cache.sizeBytes * REGISTRY_AUTO_CLEAR_PERCENT) / 100;
}

/** The seed's size against its limit, "2.0 GB of the 8.0 GB limit". */
export function seedUseText(sizeBytes: number, seedMaxGiB: number): string {
	return `${formatBytes(sizeBytes)} of the ${formatBytes(seedMaxGiB * 1024 ** 3)} limit`;
}

/** An image's download size from the cache, looked up as Docker reads the name, or null. */
export function downloadSize(
	sizes: Record<string, number>,
	name: string,
): number | null {
	return sizes[canonicalImageName(name)] ?? null;
}

/**
 * What the list for the next rebuild downloads, against the seed's limit.
 * Download sizes are compressed, so the built seed is larger; the sentence says so.
 */
export function listSizeText(
	list: readonly string[],
	sizes: Record<string, number>,
	seedMaxGiB: number,
): string {
	const known = list.map((name) => downloadSize(sizes, name));
	const total = known.reduce<number>((sum, n) => sum + (n ?? 0), 0);
	const unknown = known.filter((n) => n === null).length;
	const limit = `The limit of ${formatBytes(seedMaxGiB * 1024 ** 3)} counts the unpacked images, which take more space than their download.`;
	if (unknown === list.length) {
		return `Download sizes are not known yet; the pull cache has not held these images. ${limit}`;
	}
	const rest =
		unknown === 0
			? ""
			: `, not counting ${unknown} ${unknown === 1 ? "image" : "images"} the pull cache has not held`;
	return `These images download as ${formatBytes(total)}${rest}. ${limit}`;
}

/** "Showing 200 of 340" when the API capped the rows, or null when all are shown. */
export function shownText(shown: number, total: number): string | null {
	return total > shown ? `Showing ${shown} of ${total}.` : null;
}

/** The failed clear as a sentence; a stopped Hub cache waits for a clear that works. */
export function clearErrorText(cache: DockerCacheStatus): string | null {
	if (!cache.lastClearError) return null;
	const held = cache.hubUp
		? ""
		: " The Docker Hub cache stays stopped until Clear cache succeeds.";
	return `The last clear failed: ${cache.lastClearError}${held}`;
}

export const CLEAR_REASON: Record<
	NonNullable<DockerCacheStatus["lastClearReason"]>,
	string
> = {
	admin: "cleared by an administrator",
	full: "cleared because it was nearly full",
	credential: "cleared when the Docker Hub account changed",
};

/** The seed cap as typed, or null when it is not a whole number from 1 to 64. */
export function parseSeedMaxGiB(text: string): number | null {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const value = Number(trimmed);
	return value >= 1 && value <= SEED_MAX_GIB_LIMIT ? value : null;
}

/** The first problem with a Docker Hub account entry, per field. */
export function credentialErrors(
	username: string,
	token: string,
): { username: string | null; token: string | null } {
	const shape = HubCredentialRequest.shape;
	return {
		username: shape.username.safeParse(username).success
			? null
			: "Enter the Docker Hub username: 4 to 30 lowercase letters and digits.",
		token: shape.token.safeParse(token).success
			? null
			: "Paste the access token: 8 to 200 characters with no spaces.",
	};
}
