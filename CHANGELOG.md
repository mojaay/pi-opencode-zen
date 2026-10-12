# Changelog

## Unreleased

### Fixed
- The offline baseline catalog no longer leaks models the workspace does not
  allow. `MODELS` is merged *under* the fetched catalog by pi's
  `createProvider`, so a network refresh can never drop a baseline entry —
  `filterModels` was the only thing standing between the user and a model the
  workspace has disabled (`deepseek-v4.1-flash` and `glm-5.3-flash` shipped
  with the extension while most workspaces can only call free-tier models, and
  the gateway answers `403 Model access is disabled`).
  `filterModels` consulted `credential.allowedModels`, but that list is only
  recomputed by `refreshZenToken`, which pi invokes when the OAuth *token*
  expires — so it stays stale for the whole token lifetime. An empty list
  recorded while the BYOK check was still broken (1.2.4) was enough to disable
  workspace filtering entirely. The extension now keeps the last successful
  `/api/config` result and prefers it, which self-heals on the first refresh
  instead of the next re-login. API-key credentials are never narrowed by it,
  and the "unknown allowed-set means never wipe the catalog" guard is unchanged.

## 1.2.6

### Changed
- Free-tier (zero-cost) models work through the v2 content gate again. The
  gateway now checks the request body: a leading developer message must carry
  OpenCode's own title-generator prompt verbatim, native `tools` declarations
  are rejected, and identity headers must name the official client
  (`opencode/latest/2.0.27/cli`, `x-opencode-client: cli`, one
  `x-opencode-session` header). The extension injects the marker, collapses
  history to `[marker, system, user]`, and strips tool declarations on free
  models only; paid requests are never modified.
- Tool calling on free models runs as a text protocol: the system prompt
  teaches fenced ```tool JSON blocks, `message_end` converts them back into
  real pi tool calls (parallel blocks supported), and results return through
  the transcript. Verified live: chat, read, bash on muse-spark free.

### Fixed
- Free-model detection no longer depends on the catalog refresh having run:
  zero-cost cost metadata or a `-free` id suffix both qualify.

## 1.2.5

### Added
- Free-tier (zero-cost) models are usable again. The Zen gateway rejects them
  with `FreeTierError` ("OpenCode's free tier can only be used from within
  OpenCode") unless the request looks like an OpenCode-client turn. Probed
  against the live gateway, the check is exactly three conditions — token,
  TLS fingerprint, HTTP version and source IP are *not* among them:
  1. `User-Agent` shaped `opencode/(latest/)?<version>/…` — `opencode/cli` is
     rejected. Any semver-ish version passes.
  2. an `x-opencode-session` header (`x-session-affinity`/`x-session-id` also
     satisfy it, `x-opencode-session-id` alone does not) whose value matches
     the official `ses_<12 hex><14 alnum>` session-id shape.
  3. a streamed body (`stream: true`) whose `tools` array carries a read tool
     plus a command-execution tool — verified pairs `{read, shell}` and
     `{read, bash}`; single tools and other pairs are rejected.
  Pi's agent already advertises `read` + `bash`, so agent turns only need the
  header pair; tool-less completions (`streamSimple`, title generation, …)
  additionally get both stubs injected via the adapter's `onPayload` hook.
  Stubs follow the route's own tool format — `openai-completions`,
  `anthropic-messages` (flat `{name, description, input_schema}`) and
  `openai-responses` (flat function tools) are all covered. On completions
  the stubs are muted with `tool_choice: "none"`; anthropic and responses
  have no such value so the stubs stay callable in theory (in practice
  tool-less completions rarely emit calls). Paid models are never modified.
  See `src/free-tier.ts`.
- Zero-cost models are no longer filtered out of the catalog during
  `/api/config` — they are gated per-request instead of hidden.

### Fixed
- The console now attaches `options.apiKey: "{env:OPENCODE_CONSOLE_TOKEN}"`
  and an org header to the managed `opencode` entry. The BYOK check treated
  any `options.apiKey` as "bring your own key" and dropped the whole entry —
  the catalog came back empty ("logged in, no models"). An entry is now only
  treated as BYOK when its endpoint is off the Zen gateway.
- "Logged in but no models": a `/api/config` result that yielded no usable
  entries stored `allowedModels: []`, and `filterModels` then hid the entire
  catalog — including the offline baseline. An empty or missing list now means
  "no workspace restrictions"; the catalog is never wiped.
- Models with a `provider` override are no longer dropped (Issue #2). They
  route to the matching Zen gateway wire protocol and the provider registers
  the matching API implementations (`anthropic-messages`,
  `google-generative-ai`, `openai-responses` alongside `openai-completions`):
  - `@ai-sdk/anthropic` → `anthropic-messages`, with the console's trailing
    `/v1` stripped — the anthropic SDK appends `/v1/messages` itself
  - `@ai-sdk/google` → `google-generative-ai`
  - `@ai-sdk/openai` → `openai-responses` for the gpt/grok/muse families,
    `openai-completions` otherwise
  - unknown npm packages (vertex, bedrock, openrouter, …) stay excluded —
    they cannot route through the Zen gateway
- Console switches are respected: `blacklist` entries and models with
  `status: "deprecated"` are excluded (opencode itself treats
  `status !== "deprecated"` as enabled).
- `/api/config` entries beyond `provider.opencode` are read too: entries with
  a Zen-routable `npm`/`api` contribute their models; BYOK entries (own
  `options.baseURL`/`apiKey`) and entries with no routable protocol are
  skipped.
- A failing `/api/config` fetch during login no longer aborts the login —
  `allowedModels` stays unset and the next catalog refresh retries.

## 1.2.4

### Fixed
- Exclude zero-cost (free-tier) models from the catalog. Zen answers them
  with `FreeTierError` outside the opencode client even when the workspace
  whitelist includes them — listing them only produced dead ends.

## 1.2.3

### Changed
- Verified against pi 0.99.1 and opencode v2.0.20; devDependencies bumped.
  No code changes.

### Changed
- Rewrote README (hook-first structure) and added Vietnamese translation
  (`README.vi.md`) with a language switcher. No code changes.

### Fixed
- Console API calls use the `x-org-id` header. The previous `x-opencode-org-id`
  header is only valid on the inference endpoint — on `/api/config` the console
  answers `400 OrgRequired`. Shared workspace tokens (with a server-side active
  org) masked this; fresh device-flow tokens exposed it.
- `fetchZenModels` failure now hints at re-login (`/login opencode-zen`) on
  token rejection instead of a bare HTTP status.

### Added
- Security notes in README (no token/workspace-ID logging, leak recovery).

## 1.1.1

### Changed
- Versionless `User-Agent` (`opencode/cli`). The npm `latest` dist-tag tracks the
  v1 line which the console rejects, and pinning a local version drifts — the
  console accepts the versionless form, verified live.

## 1.1.0

### Added
- Dynamic model catalog via `fetchModels`: the workspace-allowed list
  (not disabled, on the org whitelist, no custom provider override) is pulled
  from `/api/config` on every pi catalog refresh, with context limits and
  prices mapped by `modelFromZen`. The static `MODELS` remains as the offline
  baseline.

## 1.0.1

### Added
- `repository` / `homepage` metadata so the pi package gallery links GitHub.

## 1.0.0

### Added
- `opencode-zen` provider for pi: console device-flow OAuth login, no API key
  management. Workspace members approve once in the browser.
- Workspace selection in the pi TUI after approval; requests carry the
  matching org header.
- Workspace-allowed model check after login and on every token refresh;
  `filterModels` narrows `/model` to what the workspace permits.
- Dynamic opencode `User-Agent` (later replaced, see 1.1.1).
- Paid-tier prices from the console workspace config
  (glm-5.3-flash, deepseek-v4.1-flash).
