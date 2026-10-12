// The model ids the last successful `/api/config` fetch returned.
//
// `credential.allowedModels` looks like the same information, but it is only
// recomputed from `refreshZenToken`, which pi invokes when the OAuth *token*
// expires — so it can stay stale for the whole token lifetime. An empty list
// recorded while the BYOK check was still broken is enough to disable workspace
// filtering for weeks, which lets the offline baseline (models the workspace
// does not allow) through `filterModels`. This cache holds the fresher signal
// so the catalog self-heals on the first successful refresh instead of the
// next re-login.

let live: ReadonlySet<string> | undefined;

export function setLiveCatalog(ids: Iterable<string>): void {
	live = new Set(ids);
}

export function getLiveCatalog(): ReadonlySet<string> | undefined {
	return live;
}

// Test-only: cases start from a clean slate so one fetch cannot decide another
// test's catalog.
export function resetLiveCatalog(): void {
	live = undefined;
}
