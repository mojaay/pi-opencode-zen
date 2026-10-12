import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS, modelFromZen, type ZenApi } from "./models.ts";
import { freeTierHeaders, isZeroCostModel } from "./free-tier.ts";
import { buildTextToolProtocol, convertTextToolMessage, shapeFreeTierRequest } from "./v2-gate.ts";
import { UA, fetchZenModels, loginZen, refreshZenToken, type ZenCredential } from "./auth.ts";
import { getLiveCatalog, setLiveCatalog } from "./catalog-state.ts";

function withFreeTierGate<T extends object>(streams: T): T {
	const s = streams as unknown as Record<string, (...args: never[]) => unknown>;
	const wrap = (fn: (...args: never[]) => unknown) => (model: never, context: never, options?: never) => {
		const opts = (options ?? {}) as Record<string, unknown>;
		const free = isZeroCostModel(model as never) || ((model as { id?: string }).id ?? "").endsWith("-free");
		const caller = opts.onPayload as ((payload: unknown, model: unknown) => unknown) | undefined;
		let requestOptions = opts;
		if (free) {
			const headers = { ...((opts.headers as Record<string, string>) ?? {}), ...freeTierHeaders() };
			requestOptions = { ...opts, headers };
		}
		return fn(model, context, {
			...requestOptions,
			onPayload: async (payload: unknown, m: unknown) => {
				const next = free && (m as { api?: string })?.api === "openai-responses"
					? shapeFreeTierRequest(payload as Record<string, any>)
					: payload;
				return caller ? caller(next, m) : next;
			},
		} as never);
	};
	return { ...streams, stream: wrap(s.stream!), streamSimple: wrap(s.streamSimple!) };
}

function freeModelProtocol(tools: ReturnType<ExtensionAPI["getAllTools"]>, active: string[]): string {
	const activeSet = new Set(active);
	return buildTextToolProtocol(tools.filter((tool) => activeSet.has(tool.name)));
}

export const provider = createProvider<ZenApi>({
	id: "opencode-zen",
	name: "OpenCode Zen",
	baseUrl: INFERENCE_URL,
	auth: {
		oauth: {
			name: "OpenCode Zen (workspace)",
			login: loginZen,
			refresh: refreshZenToken,
			toAuth: async (credential) => {
				const { orgID, access: apiKey } = credential as ZenCredential;
				return {
					apiKey,
					headers: {
						"User-Agent": UA,
						...(orgID ? { "x-opencode-org-id": orgID } : {}),
					},
				};
			},
		},
		apiKey: {
			name: "OpenCode Zen API key",
			login: async (interaction): Promise<ApiKeyCredential> => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter OpenCode API key" }),
			}),
			resolve: async ({ ctx, credential }) => {
				const key = credential?.key ?? (await ctx.env("OPENCODE_API_KEY")) ?? undefined;
				if (!key) return undefined;
				return { auth: { apiKey: key, headers: { "User-Agent": UA } } };
			},
		},
	},
	models: MODELS,
	fetchModels: async (context) => {
		const credential = context.credential as ZenCredential | undefined;
		if (!context.allowNetwork || credential?.type !== "oauth" || !credential.orgID) return [];
		const entries = await fetchZenModels(credential.access, credential.orgID, context.signal);
		// remember it so filterModels can drop baseline models this workspace
		// does not allow, without waiting for a token refresh to rewrite
		// credential.allowedModels (see catalog-state.ts)
		setLiveCatalog(Object.keys(entries));
		return Object.entries(entries).map(([id, meta]) => modelFromZen(id, meta));
	},
	filterModels: (models, credential) => {
		const zen = credential as ZenCredential | undefined;
		// API-key users carry their own workspace's permissions — narrowing for
		// them with an OAuth catalog would hide models they can actually call
		if (zen?.type !== "oauth") return models;
		// the live catalog is fresher than the credential's list, which only
		// moves when the token itself expires
		const allowed =
			getLiveCatalog() ??
			(Array.isArray(zen.allowedModels) && zen.allowedModels.length > 0
				? new Set<string>(zen.allowedModels)
				: undefined);
		// nothing known yet (offline, first run) means "no usable workspace
		// restrictions" — never wipe the catalog (that was the "logged in, no
		// models" bug)
		return allowed ? models.filter((m) => allowed.has(m.id)) : models;
	},
	api: {
		// the gate fires for zero-cost models only; google has none today
		"openai-completions": withFreeTierGate(openAICompletionsApi()),
		"anthropic-messages": withFreeTierGate(anthropicMessagesApi()),
		"openai-responses": withFreeTierGate(openAIResponsesApi()),
		"google-generative-ai": googleGenerativeAIApi(),
	},
});

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== "opencode-zen") return;
		if (!isZeroCostModel(model) && !model.id.endsWith("-free")) return;
		const protocol = freeModelProtocol(pi.getAllTools(), pi.getActiveTools());
		return { systemPrompt: `${event.systemPrompt}${protocol}` };
	});

	pi.on("message_end", (event) => {
		const message = event.message as unknown as Record<string, any>;
		if (message.provider !== "opencode-zen" || typeof message.model !== "string") return;
		if (!message.model.endsWith("-free")) return;
		const converted = convertTextToolMessage(message);
		if (converted) return { message: converted as typeof event.message };
	});

	pi.registerProvider(provider);
}
