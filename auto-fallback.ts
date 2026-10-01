/**
 * auto-fallback.ts — single-file OpenCode fallback plugin.
 *
 * Self-contained: all logic (types, config, error classification, state,
 * replay, auto-retry, event handlers, plugin entry) lives in this one file
 * so it can be dropped into OpenCode as an extension with no extra modules.
 *
 * External runtime deps (provided by host / npm): `jsonc-parser` only.
 * Node builtins used: `fs`, `path`, `os`.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse as parseJsonc } from "jsonc-parser"

// Timer types: the host (Bun/Node) provides these at runtime. Declared here
// so the single file typechecks without DOM lib extras.
declare function setTimeout(
	callback: (...args: any[]) => void | Promise<void>,
	delay?: number
): ReturnType<typeof globalThis.setTimeout>
declare function clearTimeout(timeout: ReturnType<typeof globalThis.setTimeout>): void
declare function setInterval(
	callback: (...args: any[]) => void,
	delay: number
): { unref: () => void } & ReturnType<typeof globalThis.setInterval>

// ─── types.ts ───
export interface FallbackPluginConfig {
	enabled?: boolean
	retry_on_errors?: number[]
	/** Additional regex patterns (strings) that mark an error as retryable.
	 *  These supplement the built-in patterns. Each string is compiled as
	 *  a case-insensitive regex and matched against the error message. */
	retryable_error_patterns?: string[]
	max_fallback_attempts?: number
	cooldown_seconds?: number
	/** Time-to-first-token timeout in seconds.  If the fallback model does not
	 *  produce its first token within this window, it is aborted and the next
	 *  fallback is tried.  Once streaming begins the timeout is cancelled.
	 *  Set to 0 to disable. */
	timeout_seconds?: number
 	notify_on_fallback?: boolean
	fallback_models?: string | string[]
	/** Show a small toast when the plugin is ready (startup) and when a
	 *  session is armed with its fallback chain, including what the next
	 *  model will be on failure.
	 *  Default: true */
	notify_on_ready?: boolean
	/** Automatically order fallback chains by preference tier
	 *  (Claude → GPT → Muse → other American → GLM → MiMo → DeepSeek → rest).
	 *  Models within the same tier keep their configured order.
	 *  Set to false to keep configured order untouched.
	 *  Default: true */
	auto_order?: boolean
	/** When no per-agent or global fallback_models are configured,
	 *  automatically build a fallback chain from the models OpenCode
	 *  knows about (scanned from the `config` hook payload).
	 *  Set to false to disable zero-config fallback.
	 *  Default: true */
	auto_discover?: boolean
}

export interface FallbackState {
	originalModel: string
	currentModel: string
	fallbackIndex: number
	failedModels: Map<string, number>
	attemptCount: number
	pendingFallbackModel?: string
}

export interface FallbackResult {
	success: boolean
	newModel?: string
	error?: string
	maxAttemptsReached?: boolean
}

/** Returned by planFallback — describes what to do but does NOT mutate state. */
export interface FallbackPlan {
	success: true
	newModel: string
	failedModel: string
	newFallbackIndex: number
}

export interface FallbackPlanFailure {
	success: false
	error: string
	maxAttemptsReached?: boolean
}

export type MessagePart = { type: string } & Record<string, unknown>

export type ReplayTier = 1 | 2 | 3

export interface ReplayResult {
	success: boolean
	tier?: ReplayTier
	sentParts?: MessagePart[]
	droppedTypes?: string[]
	error?: string
}

export interface ChatMessageInput {
	sessionID: string
	agent?: string
	model?: {
		providerID: string
		modelID: string
	}
}

export interface ChatMessageOutput {
	message: {
		model?: {
			providerID: string
			modelID: string
		}
	}
	parts?: Array<{
		type: string
		text?: string
	}>
}

export interface FallbackPluginHook {
	event: (input: {
		event: { type: string; properties?: unknown }
	}) => Promise<void>
	"chat.message"?: (
		input: ChatMessageInput,
		output: ChatMessageOutput
	) => Promise<void>
}

export interface PluginContext {
	directory: string
	client: {
		session: {
			abort: (args: { path: { id: string } }) => Promise<void>
			messages: (args: {
				path: { id: string }
				query: { directory: string }
			}) => Promise<{
				data?: Array<{
					info?: Record<string, unknown>
					parts?: Array<{ type?: string; text?: string }>
				}>
			}>
			promptAsync: (args: {
				path: { id: string }
				body: {
					agent?: string
					model: { providerID: string; modelID: string }
					parts: MessagePart[]
				}
				query: { directory: string }
			}) => Promise<void>
			/** Re-dispatch a command (e.g. compaction) on a specific model.
			 *  Uses the SDK's path/body/query format. */
			command: (args: {
				path: { id: string }
				body: {
					command: string
					arguments: string
					model?: string
					agent?: string
					messageID?: string
				}
				query?: { directory?: string }
			}) => Promise<void>
			/** Revert a specific message, undoing its effects and restoring
			 *  the previous session state.  Used to remove failed compaction
			 *  messages so OpenCode doesn't re-queue them. */
			revert: (args: {
				path: { id: string }
				body: { messageID: string; partID?: string }
				query?: { directory?: string }
			}) => Promise<void>
			/** Re-run compaction/summarization with a specific model.
			 *  This is the actual compaction API — "compact" is not a
			 *  user-facing command. */
			summarize: (args: {
				path: { id: string }
				body: { providerID: string; modelID: string }
				query?: { directory?: string }
			}) => Promise<unknown>
			get: (args: {
				path: { id: string }
			}) => Promise<{ data?: Record<string, unknown> }>
		}
		tui: {
			showToast: (args: {
				body: {
					title: string
					message: string
					variant: string
					duration: number
				}
			}) => Promise<void>
		}
	}
}

export interface HookDeps {
	ctx: PluginContext
	config: Required<FallbackPluginConfig>
	agentConfigs: Record<string, unknown> | undefined
	globalFallbackModels: string[]
	/** Models scanned from the OpenCode `config` hook payload
	 *  (provider catalog + agent models), preference-ordered.
	 *  Used as the fallback chain when neither per-agent nor
	 *  global fallback_models are configured.
	 *  Optional so older hand-built HookDeps fixtures keep working. */
	autoDiscoveredModels?: string[]
	sessionStates: Map<string, FallbackState>
	sessionLastAccess: Map<string, number>
	sessionRetryInFlight: Set<string>
	sessionAwaitingFallbackResult: Set<string>
	sessionFallbackTimeouts: Map<string, ReturnType<typeof setTimeout>>
	sessionFirstTokenReceived: Map<string, boolean>
	/** Timestamp of the last plugin-initiated abort per session.
	 *  Used to distinguish self-inflicted MessageAbortedError from user cancellation. */
	sessionSelfAbortTimestamp: Map<string, number>
	/** Cached parentID for child sessions.  `undefined` value means "looked up,
	 *  no parent" so we distinguish from "never looked up" (key absent). */
	sessionParentID: Map<string, string | null>
	/** Resolvers for code awaiting a session to go idle (e.g. subagent-sync
	 *  waiting for a child session's fallback response to complete). */
	sessionIdleResolvers: Map<string, Array<() => void>>
	/** Timestamp of the last message.updated event per session.
	 *  Used by subagent-sync to detect child activity and reset timeouts. */
	sessionLastMessageTime: Map<string, number>
	/** Sessions with an in-flight compaction fallback via session.command.
	 *  Compaction commands produce no message.updated events, only a final
	 *  session.compacted signal.  While this flag is set, stale errors from
	 *  the pre-compaction model are suppressed and session.idle does not
	 *  treat the silence as a "silent model failure". */
	sessionCompactionInFlight: Set<string>
}

// ─── constants.ts ───
export const PLUGIN_NAME = "opencode-fallback"

export const DEFAULT_CONFIG: Required<FallbackPluginConfig> = {
	enabled: true,
	retry_on_errors: [401, 402, 429, 500, 502, 503, 504],
	retryable_error_patterns: [],
	max_fallback_attempts: 10,
	cooldown_seconds: 60,
	timeout_seconds: 30,
	notify_on_fallback: true,
	fallback_models: [],
	notify_on_ready: true,
	auto_order: true,
	auto_discover: true,
}

export const RETRYABLE_ERROR_PATTERNS = [
	/rate.?limit/i,
	/too.?many.?requests/i,
	/quota.?exceeded/i,
	/quota.?protection/i,
	/key.?limit.?exceeded/i,
	/usage\s+limit\s+has\s+been\s+reached/i,
	/service.?unavailable/i,
	/overloaded/i,
	/temporarily.?unavailable/i,
	/try.?again/i,
	/credit.*balance.*too.*low/i,
	/insufficient.?(?:credits?|funds?|balance)/i,
	/(?:^|\s)429(?:\s|$)/,
	/(?:^|\s)503(?:\s|$)/,
	/(?:^|\s)529(?:\s|$)/,
]

// ─── ready-notify.ts ───
/** Short display name for a model: last path segment (e.g. "claude-opus-4-6"). */
export function shortModelName(model: string): string {
	return model.split("/").pop() || model
}

/** Compact "a → b → c (+N more)" preview of a fallback chain (max 3 shown). */
export function formatChainPreview(models: string[], maxShown = 3): string {
	const shown = models.slice(0, maxShown).map(shortModelName)
	const extra = models.length - shown.length
	return extra > 0 ? `${shown.join(" → ")} (+${extra} more)` : shown.join(" → ")
}

/** First model in the chain that isn't the current one — i.e. what a
 *  failure would switch to. Returns undefined when there is no next model. */
export function resolveNextModel(
	currentModel: string,
	fallbackModels: string[]
): string | undefined {
	return fallbackModels.find((m) => m !== currentModel)
}

/** Message shown at startup: proves the plugin loaded + previews the chain. */
export function buildStartupMessage(
	globalFallbackModels: string[],
	autoDiscoveredModels: string[] | undefined
): string {
	const chain =
		globalFallbackModels.length > 0
			? globalFallbackModels
			: (autoDiscoveredModels ?? [])
	if (chain.length === 0) {
		return "Plugin active — no fallback models configured"
	}
	return `Plugin active — next on failure: ${shortModelName(chain[0])} (${formatChainPreview(chain)})`
}

/** Message shown when a session is armed: current model + exact next model. */
export function buildArmedMessage(
	currentModel: string,
	fallbackModels: string[]
): string {
	const next = resolveNextModel(currentModel, fallbackModels)
	if (!next) {
		return `Fallback armed for ${shortModelName(currentModel)} — no fallback configured`
	}
	return `Fallback armed for ${shortModelName(currentModel)} — next on failure: ${shortModelName(next)}`
}

/** Fire-and-forget toast that never throws (safe to call from sync hooks). */
export function showReadyToast(
	ctx: PluginContext,
	title: string,
	message: string
): void {
	try {
		ctx.client.tui
			?.showToast({
				body: { title, message, variant: "info", duration: 5000 },
			})
			?.catch(() => {})
	} catch {
		// TUI unavailable (headless/test) — log only
	}
}

// ─── logger.ts ───
const LOG_FILE = join(homedir(), ".config", "opencode", "opencode-fallback.log")

// Ensure directory exists
try {
	mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
} catch {
	// Directory might already exist
}

function writeToFile(level: string, message: string, context?: Record<string, unknown>): void {
	const timestamp = new Date().toISOString()
	const contextStr = context ? ` ${JSON.stringify(context)}` : ""
	const logLine = `[${timestamp}] [${level}] [${PLUGIN_NAME}] ${message}${contextStr}\n`
	
	try {
		appendFileSync(LOG_FILE, logLine)
	} catch {
		// Silently fail if can't write to file
	}
}

// Set to true to enable console logging (for debugging only)
const DEBUG_MODE = false

export function logInfo(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.log(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("INFO", message, context)
}

export function logError(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.error(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("ERROR", message, context)
}

export function getLogFilePath(): string {
	return LOG_FILE
}

// ─── model-order.ts ───
/**
 * Automatic model ordering for fallback chains.
 *
 * Scans the models OpenCode knows about and sorts them into a fixed
 * preference order so users don't have to hand-maintain `fallback_models`:
 *
 *   1. Claude products
 *   2. GPT products
 *   3. Muse
 *   4. Other American models (Gemini/Google, Grok/xAI, Llama/Meta, Copilot/Microsoft, …)
 *   5. GLM (Zhipu)
 *   6. MiMo (Xiaomi)
 *   7. DeepSeek
 *   8. Anything else (original relative order preserved — not shuffled)
 *
 * Sorting is stable: models within the same tier keep their input order.
 * Output is de-duplicated (first occurrence wins).
 */

export enum ModelTier {
	Claude = 1,
	GPT = 2,
	Muse = 3,
	American = 4,
	GLM = 5,
	MiMo = 6,
	DeepSeek = 7,
	Other = 8,
}

/** Providers owned by big American labs / infra. Matched by provider ID. */
const AMERICAN_PROVIDERS = new Set([
	"google",
	"vertex",
	"vertex-ai",
	"xai",
	"meta",
	"github",
	"github-copilot",
	"microsoft",
	"azure",
	"amazon",
	"bedrock",
	"nvidia",
])

function splitProvider(model: string): { providerID: string; modelID: string } {
	const idx = model.indexOf("/")
	if (idx === -1) return { providerID: "", modelID: model }
	return {
		providerID: model.slice(0, idx).toLowerCase(),
		modelID: model.slice(idx + 1),
	}
}

export function getModelTier(model: string): ModelTier {
	const lower = model.toLowerCase()
	const { providerID } = splitProvider(model)

	// Tier 1 — Claude products (any host: anthropic, google antigravity, copilot, …)
	if (lower.includes("claude") || providerID === "anthropic") {
		return ModelTier.Claude
	}

	// Tier 2 — GPT products
	if (
		lower.includes("gpt") ||
		lower.includes("openai") ||
		lower.includes("codex") ||
		providerID === "openai"
	) {
		return ModelTier.GPT
	}

	// Tier 3 — Muse (dedicated provider/family only — copilot-hosted
	// Claude/GPT are already claimed by tiers 1-2 above on purpose)
	if (
		providerID.includes("spark") ||
		providerID.includes("muse") ||
		lower.includes("muse-spark") ||
		lower.includes("musespark") ||
		lower.includes("muse spark") ||
		lower.includes("spark")
	) {
		return ModelTier.Muse
	}

	// Tier 4 — Other American models: big-lab families regardless of host
	// (Gemini, Grok, Llama) or big-tech providers themselves.
	if (
		AMERICAN_PROVIDERS.has(providerID) ||
		lower.includes("gemini") ||
		lower.includes("google") ||
		lower.includes("vertex") ||
		lower.includes("grok") ||
		lower.includes("xai") ||
		lower.includes("llama") ||
		lower.includes("copilot")
	) {
		return ModelTier.American
	}

	// Tier 5 — GLM (Zhipu)
	if (
		providerID === "glm" ||
		providerID === "zhipu" ||
		lower.includes("glm") ||
		lower.includes("zhipu")
	) {
		return ModelTier.GLM
	}

	// Tier 6 — MiMo (Xiaomi)
	if (
		providerID === "mimo" ||
		providerID === "xiaomi" ||
		lower.includes("mimo")
	) {
		return ModelTier.MiMo
	}

	// Tier 7 — DeepSeek
	if (providerID === "deepseek" || lower.includes("deepseek")) {
		return ModelTier.DeepSeek
	}

	return ModelTier.Other
}

/** Stable sort by tier + de-dupe (first occurrence wins). No-op for 0-1 items. */
export function sortModelsByPreference(models: string[]): string[] {
	if (models.length <= 1) return [...models]

	const seen = new Set<string>()
	const deduped: string[] = []
	for (const m of models) {
		if (typeof m !== "string" || seen.has(m)) continue
		seen.add(m)
		deduped.push(m)
	}

	return deduped
		.map((model, index) => ({ model, index, tier: getModelTier(model) }))
		.sort((a, b) => a.tier - b.tier || a.index - b.index)
		.map((entry) => entry.model)
}

function normalizeModelValue(value: unknown, providerID?: string): string[] {
	if (typeof value === "string" && value.length > 0) {
		// Bare model IDs inside a provider block get prefixed: { provider: { models: { "foo": … } } }
		if (providerID && !value.includes("/")) return [`${providerID}/${value}`]
		return [value]
	}
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		providerID
	) {
		const rec = value as Record<string, unknown>
		// Expanded object form: { model: "provider/id", providerID, modelID, … }
		if (typeof rec.model === "string" && rec.model.length > 0) return [rec.model]
		if (typeof rec.modelID === "string" && rec.modelID.length > 0) {
			const id = rec.modelID.includes("/")
				? rec.modelID
				: `${providerID}/${rec.modelID}`
			return [id]
		}
		if (typeof rec.id === "string" && rec.id.length > 0) {
			const id = rec.id.includes("/") ? rec.id : `${providerID}/${rec.id}`
			return [id]
		}
	}
	return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArrayField(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === "string")
}

/**
 * Scan an OpenCode config object for every model it references.
 * Covers: root `model`, `provider.<id>.models`, and per-agent
 * `model` + `fallback_models` under `agents`/`agent`.
 *
 * Models hidden via `disabled: true`, provider `blacklist`, or excluded
 * by a provider `whitelist` are skipped — they are not valid fallback
 * targets either.
 *
 * Returns models in discovery order (de-duplicated, NOT sorted —
 * call `sortModelsByPreference` on the result).
 */
export function collectAvailableModels(
	opencodeConfig: Record<string, unknown>
): string[] {
	const found: string[] = []
	const seen = new Set<string>()
	const push = (model: string) => {
		if (!seen.has(model)) {
			seen.add(model)
			found.push(model)
		}
	}

	// Root default model
	for (const m of normalizeModelValue(opencodeConfig.model)) push(m)

	// Provider catalog: provider.<providerID>.models
	const providers = opencodeConfig.provider
	if (isRecord(providers)) {
		for (const [providerID, providerConfig] of Object.entries(providers)) {
			if (!isRecord(providerConfig)) continue
			const blacklist = stringArrayField(providerConfig.blacklist)
			const whitelist = stringArrayField(providerConfig.whitelist)
			const isVisible = (modelKey: string): boolean => {
				const qualified = `${providerID}/${modelKey}`
				if (blacklist.includes(modelKey) || blacklist.includes(qualified)) {
					return false
				}
				if (
					whitelist.length > 0 &&
					!whitelist.includes(modelKey) &&
					!whitelist.includes(qualified)
				) {
					return false
				}
				return true
			}
			const models = providerConfig.models
			if (isRecord(models)) {
				for (const [modelKey, modelConfig] of Object.entries(models)) {
					if (!isVisible(modelKey)) continue
					// Hidden from the /models picker — not a fallback target
					if (isRecord(modelConfig) && modelConfig.disabled === true) {
						continue
					}
					if (isRecord(modelConfig)) {
						const explicit = normalizeModelValue(modelConfig, providerID)
						if (explicit.length > 0) {
							for (const m of explicit) push(m)
						} else {
							push(
								modelKey.includes("/") ? modelKey : `${providerID}/${modelKey}`
							)
						}
					} else if (typeof modelConfig === "string" && modelConfig.length > 0) {
						push(
							modelConfig.includes("/")
								? modelConfig
								: `${providerID}/${modelConfig}`
						)
					} else {
						push(
							modelKey.includes("/") ? modelKey : `${providerID}/${modelKey}`
						)
					}
				}
			} else if (Array.isArray(models)) {
				for (const entry of models) {
					for (const m of normalizeModelValue(entry, providerID)) push(m)
				}
			}
		}
	}

	// Per-agent models (both `agents` plural and `agent` singular keys)
	for (const key of ["agents", "agent"] as const) {
		const agents = opencodeConfig[key]
		if (!isRecord(agents)) continue
		for (const agentConfig of Object.values(agents)) {
			if (!isRecord(agentConfig)) continue
			for (const m of normalizeModelValue(agentConfig.model)) push(m)
			const fallbacks = agentConfig.fallback_models
			if (typeof fallbacks === "string") {
				for (const m of normalizeModelValue(fallbacks)) push(m)
			} else if (Array.isArray(fallbacks)) {
				for (const entry of fallbacks) {
					if (typeof entry === "string") {
						for (const m of normalizeModelValue(entry)) push(m)
					}
				}
			}
		}
	}

	return found
}

// ─── config-reader.ts ───
/**
 * Config reader for the standalone fallback plugin.
 *
 * Reads `fallback_models` from OpenCode's agent config section
 * (passed via the plugin config hook), NOT from oh-my-opencode.jsonc.
 */

type AgentRecord = Record<string, unknown>


const SESSION_ID_NOISE_WORDS = new Set(["ses", "work", "task", "session"])


export function normalizeFallbackModelsField(
	value: unknown
): string[] {
	if (!value) return []
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string")
	}
	return []
}

export function readFallbackModels(
	agentName: string,
	agents: AgentRecord | undefined
): string[] {
	if (!agents) return []

	const agentConfig = agents[agentName]
	if (!isRecord(agentConfig)) return []

	return normalizeFallbackModelsField(agentConfig.fallback_models)
}

export function resolveAgentForSession(
	sessionID: string,
	eventAgent?: string
): string | undefined {
	if (eventAgent && eventAgent.trim().length > 0) {
		return eventAgent.trim().toLowerCase()
	}

	const segments = sessionID.split(/[\s_\-/]+/).filter(Boolean)
	for (const segment of segments) {
		const candidate = segment.toLowerCase()
		const isAlphaOnly = /^[a-z][a-z-]*$/.test(candidate)
		if (candidate.length > 2 && isAlphaOnly && !SESSION_ID_NOISE_WORDS.has(candidate)) {
			return candidate
		}
	}

	return undefined
}

export function getFallbackModelsForSession(
	sessionID: string,
	eventAgent: string | undefined,
	agents: AgentRecord | undefined,
	globalFallbackModels?: string[],
	autoDiscoveredModels?: string[],
	autoOrder = true
): string[] {
	const order = (models: string[]): string[] =>
		autoOrder ? sortModelsByPreference(models) : [...models]

	const resolvedAgent = resolveAgentForSession(sessionID, eventAgent)

	// Tier 1: Per-agent fallback_models
	if (resolvedAgent && agents) {
		const models = readFallbackModels(resolvedAgent, agents)
		
		// Implicitly include the agent's configured primary model as a
		// last-resort fallback candidate — but only when fallback_models
		// was explicitly configured with entries.  If the user didn't set
		// fallback_models at all (or set it to []), we don't inject the
		// primary — they didn't opt into fallback for this agent.
		//
		// This handles the case where the user manually switches to a
		// fallback model and it later fails: the configured primary
		// becomes available as a recovery target instead of the chain
		// appearing exhausted.
		if (models.length > 0) {
			const agentConfig = agents[resolvedAgent]
			if (isRecord(agentConfig) && typeof agentConfig.model === "string") {
				const primaryModel = agentConfig.model
				if (!models.includes(primaryModel)) {
					models.unshift(primaryModel)
				}
			}
			return order(models)
		}
	}

	// Tier 2: Global fallback_models from plugin config
	if (globalFallbackModels && globalFallbackModels.length > 0) {
		return order(globalFallbackModels)
	}

	// Tier 3: Auto-discovered models scanned from the OpenCode config
	// (zero-config fallback — already preference-ordered at scan time,
	// re-ordered here only if the caller mutated the list)
	if (autoDiscoveredModels && autoDiscoveredModels.length > 0) {
		return order(autoDiscoveredModels)
	}

	// Tier 4: No fallback
	return []
}

// ─── error-classifier.ts ───
function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function normalizeMessage(value: string): string {
	return value.trim().length === 0 ? "" : value.toLowerCase()
}

function getStringField(value: unknown, key: string): string | undefined {
	const record = getObjectRecord(value)
	const field = record?.[key]
	if (typeof field !== "string") return undefined

	const normalized = normalizeMessage(field)
	return normalized.length > 0 ? normalized : undefined
}

export function getErrorMessage(error: unknown): string {
	if (!error) return ""
	if (typeof error === "string") return normalizeMessage(error)

	const errorObj = error as Record<string, unknown>
	const paths = [
		(errorObj.data as Record<string, unknown>)?.error,
		errorObj.data,
		errorObj.error,
		errorObj,
	]

	for (const obj of paths) {
		const record = getObjectRecord(obj)
		if (!record || !("message" in record)) continue

		const rawMessage = record.message
		if (typeof rawMessage === "string") {
			return normalizeMessage(rawMessage)
		}
	}

	try {
		return normalizeMessage(JSON.stringify(error))
	} catch {
		return ""
	}
}

export function extractStatusCode(error: unknown, retryOnErrors?: number[]): number | undefined {
	if (!error) return undefined

	const errorObj = error as Record<string, unknown>

	const statusCode =
		errorObj.statusCode ??
		errorObj.status ??
		(errorObj.data as Record<string, unknown>)?.statusCode
	if (typeof statusCode === "number") {
		return statusCode
	}

	if (typeof statusCode === "string") {
		const parsed = Number.parseInt(statusCode, 10)
		if (!Number.isNaN(parsed)) {
			return parsed
		}
	}

	const codes = retryOnErrors ?? DEFAULT_CONFIG.retry_on_errors
	const message = getErrorMessage(error)
	const contextualPattern = new RegExp(
		`(?:status(?:\\s+code)?|code|http)\D*(${codes.join("|")})\\b|\\b(${codes.join("|")})\\b(?=\\s|[^0-9])`,
		"i"
	)
	const statusMatch = message.match(contextualPattern)
	const extracted = statusMatch?.[1] ?? statusMatch?.[2]
	if (extracted) {
		return parseInt(extracted, 10)
	}

	return undefined
}

export function extractErrorName(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined

	const errorObj = error as Record<string, unknown>
	const directName = errorObj.name
	if (typeof directName === "string" && directName.length > 0) {
		return directName
	}

	const nestedError = errorObj.error as Record<string, unknown> | undefined
	const nestedName = nestedError?.name
	if (typeof nestedName === "string" && nestedName.length > 0) {
		return nestedName
	}

	const dataError = (errorObj.data as Record<string, unknown> | undefined)?.error as
		| Record<string, unknown>
		| undefined
	const dataErrorName = dataError?.name
	if (typeof dataErrorName === "string" && dataErrorName.length > 0) {
		return dataErrorName
	}

	return undefined
}

export function classifyErrorType(error: unknown): string | undefined {
	const message = getErrorMessage(error)
	const errorName = extractErrorName(error)?.toLowerCase()

	if (
		errorName?.includes("loadapi") ||
		(/api.?key.?is.?missing/i.test(message) && /environment variable/i.test(message)) ||
		/(?:x-api-key|api key).*(?:is required|missing|required)/i.test(message) ||
		/(?:missing|required).*(?:x-api-key|api key)/i.test(message)
	) {
		return "missing_api_key"
	}

	if (
		(/api.?key/i.test(message) && /must be a string/i.test(message)) ||
		/incorrect api key provided/i.test(message) ||
		/api key not valid/i.test(message) ||
		/invalid api key/i.test(message)
	) {
		return "invalid_api_key"
	}

	if (errorName?.includes("unknownerror") && /model\s+not\s+found/i.test(message)) {
		return "model_not_found"
	}

	if (
		/model\s+(?:is\s+)?not\s+(?:found|supported|available)/i.test(message) ||
		/the model .+ does not exist/i.test(message)
	) {
		return "model_not_found"
	}

	return undefined
}

export interface AutoRetrySignal {
	signal: string
}

export const AUTO_RETRY_PATTERNS: Array<(combined: string) => boolean> = [
	(combined) => /retrying\s+in/i.test(combined),
	(combined) =>
		/(?:too\s+many\s+requests|quota\s*exceeded|usage\s+limit|rate\s+limit|limit\s+reached)/i.test(
			combined
		),
]

export function extractAutoRetrySignal(
	info: Record<string, unknown> | undefined
): AutoRetrySignal | undefined {
	if (!info) return undefined

	const candidates: string[] = []

	const directStatus = info.status
	if (typeof directStatus === "string") candidates.push(directStatus)

	const summary = info.summary
	if (typeof summary === "string") candidates.push(summary)

	const message = info.message
	if (typeof message === "string") candidates.push(message)

	const details = info.details
	if (typeof details === "string") candidates.push(details)

	const combined = candidates.join("\n")
	if (!combined) return undefined

	const isAutoRetry = AUTO_RETRY_PATTERNS.every((test) => test(combined))
	if (isAutoRetry) {
		return { signal: combined }
	}

	return undefined
}

export function containsErrorContent(
	parts: Array<{ type?: string; text?: string }> | undefined
): { hasError: boolean; errorMessage?: string } {
	if (!parts || parts.length === 0) return { hasError: false }

	const errorParts = parts.filter((p) => p.type === "error")
	if (errorParts.length > 0) {
		const errorMessages = errorParts
			.map((p) => p.text)
			.filter((text): text is string => typeof text === "string")
		const errorMessage = errorMessages.length > 0 ? errorMessages.join("\n") : undefined
		return { hasError: true, errorMessage }
	}

	return { hasError: false }
}

export function detectErrorInTextParts(
	parts: Array<{ type?: string; text?: string }> | undefined
): { hasError: boolean; errorType?: string; errorMessage?: string } {
	if (!parts || parts.length === 0) return { hasError: false }

	const textContent = parts
		.filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
		.map((p) => p.text!)
		.join("\n")

	if (!textContent) return { hasError: false }

	const errorType = classifyErrorType({ message: textContent, name: "TextContent" })
	if (errorType) {
		return { hasError: true, errorType, errorMessage: textContent }
	}

	return { hasError: false }
}

export function extractErrorContentFromParts(
	parts: Array<{ type?: string; text?: string }> | undefined
): { hasError: boolean; errorMessage?: string } {
	if (!parts || parts.length === 0) return { hasError: false }

	const errorParts = parts.filter(
		(p) => p.type === "error" && typeof p.text === "string" && p.text.length > 0
	)

	if (errorParts.length > 0) {
		const errorMessage = errorParts.map((p) => p.text).join("\n")
		return { hasError: true, errorMessage }
	}

	return { hasError: false }
}

export function isRetryableError(
	error: unknown,
	retryOnErrors: number[],
	userPatterns?: string[]
): boolean {
	const statusCode = extractStatusCode(error, retryOnErrors)
	const message = getErrorMessage(error)
	const errorType = classifyErrorType(error)

	if (errorType === "missing_api_key") {
		return true
	}

	if (errorType === "model_not_found") {
		return true
	}

	if (statusCode && retryOnErrors.includes(statusCode)) {
		return true
	}

	if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
		return true
	}

	// Check user-provided retryable_error_patterns from config
	if (userPatterns && userPatterns.length > 0) {
		for (const patternStr of userPatterns) {
			try {
				const re = new RegExp(patternStr, "i")
				if (re.test(message)) return true
			} catch {
				// Invalid regex — skip silently
			}
		}
	}

	return false
}

// ─── fallback-state.ts ───
export interface FallbackStateSnapshot {
	currentModel: string
	fallbackIndex: number
	failedModels: Map<string, number>
	attemptCount: number
	pendingFallbackModel?: string
}

export function snapshotFallbackState(state: FallbackState): FallbackStateSnapshot {
	return {
		currentModel: state.currentModel,
		fallbackIndex: state.fallbackIndex,
		failedModels: new Map(state.failedModels),
		attemptCount: state.attemptCount,
		pendingFallbackModel: state.pendingFallbackModel,
	}
}

export function restoreFallbackState(
	state: FallbackState,
	snapshot: FallbackStateSnapshot
): void {
	state.currentModel = snapshot.currentModel
	state.fallbackIndex = snapshot.fallbackIndex
	state.failedModels = new Map(snapshot.failedModels)
	state.attemptCount = snapshot.attemptCount
	state.pendingFallbackModel = snapshot.pendingFallbackModel
}

export function createFallbackState(originalModel: string): FallbackState {
	return {
		originalModel,
		currentModel: originalModel,
		fallbackIndex: -1,
		failedModels: new Map<string, number>(),
		attemptCount: 0,
		pendingFallbackModel: undefined,
	}
}

export function isModelInCooldown(
	model: string,
	state: FallbackState,
	cooldownSeconds: number
): boolean {
	const failedAt = state.failedModels.get(model)
	if (failedAt === undefined) return false
	const cooldownMs = cooldownSeconds * 1000
	return Date.now() - failedAt < cooldownMs
}

export function findNextAvailableFallback(
	state: FallbackState,
	fallbackModels: string[],
	cooldownSeconds: number
): string | undefined {
	for (let i = state.fallbackIndex + 1; i < fallbackModels.length; i++) {
		const candidate = fallbackModels[i]
		// Never select the model that is currently failing — that would
		// create an infinite retry loop.
		if (candidate === state.currentModel) {
			logInfo(`Skipping fallback model identical to current: ${candidate} (index ${i})`)
			continue
		}
		if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
			return candidate
		}
		logInfo(`Skipping fallback model in cooldown: ${candidate} (index ${i})`)
	}
	return undefined
}

function applyFallbackPlan(
	state: FallbackState,
	plan: FallbackPlan,
	pendingFallbackModel?: string
): void {
	state.fallbackIndex = plan.newFallbackIndex
	state.failedModels.set(plan.failedModel, Date.now())
	state.attemptCount++
	state.currentModel = plan.newModel
	state.pendingFallbackModel = pendingFallbackModel
}

export function prepareFallback(
	sessionID: string,
	state: FallbackState,
	fallbackModels: string[],
	config: Required<FallbackPluginConfig>,
): FallbackResult {
	const plan = planFallback(sessionID, state, fallbackModels, config)
	if (!plan.success) {
		return plan
	}

	applyFallbackPlan(state, plan, plan.newModel)
	return { success: true, newModel: plan.newModel }
}

/**
 * Phase 1: Determine the next fallback model WITHOUT mutating state.
 * Returns a plan that can be committed later via commitFallback().
 */
export function planFallback(
	sessionID: string,
	state: FallbackState,
	fallbackModels: string[],
	config: Required<FallbackPluginConfig>,
): FallbackPlan | FallbackPlanFailure {
	if (state.attemptCount >= config.max_fallback_attempts) {
		logInfo(`Max fallback attempts reached for session ${sessionID} (${state.attemptCount})`)
		return {
			success: false,
			error: "Max fallback attempts reached",
			maxAttemptsReached: true,
		}
	}

	const nextModel = findNextAvailableFallback(state, fallbackModels, config.cooldown_seconds)

	if (!nextModel) {
		logInfo(`No available fallback models for session ${sessionID}`)
		return {
			success: false,
			error: "No available fallback models (all in cooldown or exhausted)",
		}
	}

	logInfo(
		`Planned fallback for session ${sessionID}: ${state.currentModel} -> ${nextModel} (will be attempt ${state.attemptCount + 1})`
	)

	return {
		success: true,
		newModel: nextModel,
		failedModel: state.currentModel,
		newFallbackIndex: fallbackModels.indexOf(nextModel),
	}
}

/**
 * Phase 2: Commit a planned fallback to state. Call this AFTER the replay
 * dispatch to promptAsync succeeds, so state only advances when the new
 * model is actually being called.
 *
 * Idempotent: if the state already shows this plan's model (i.e. another
 * handler already committed the same plan), this is a no-op and returns false.
 */
export function commitFallback(
	state: FallbackState,
	plan: FallbackPlan,
): boolean {
	// Reject stale or already-committed plans. A plan is only valid if the state
	// still reflects the model that originally failed when the plan was created.
	if (state.currentModel !== plan.failedModel) {
		return false
	}

	applyFallbackPlan(state, plan)
	return true
}

export function recoverToOriginal(
	state: FallbackState,
	cooldownSeconds: number
): boolean {
	if (state.currentModel === state.originalModel) return false
	if (isModelInCooldown(state.originalModel, state, cooldownSeconds)) return false

	state.currentModel = state.originalModel
	state.fallbackIndex = -1
	state.attemptCount = 0
	state.pendingFallbackModel = undefined

	return true
}

// ─── message-replay.ts ───
const TIER_2_TYPES = new Set(["text", "image"])

export function filterPartsByTier(parts: MessagePart[], tier: ReplayTier): MessagePart[] {
	switch (tier) {
		case 1:
			return parts
		case 2:
			return parts.filter((p) => TIER_2_TYPES.has(p.type))
		case 3:
			return parts.filter((p) => p.type === "text")
	}
}

export async function replayWithDegradation(
	allParts: MessagePart[],
	sendFn: (parts: MessagePart[]) => Promise<void>
): Promise<ReplayResult> {
	if (allParts.length === 0) {
		return { success: false, error: "No parts to replay" }
	}

	const tiers: ReplayTier[] = [1, 2, 3]
	let lastError: unknown
	let previousLength = -1

	for (const tier of tiers) {
		const filtered = filterPartsByTier(allParts, tier)

		// Skip empty or duplicate tiers
		if (filtered.length === 0) continue
		if (filtered.length === previousLength) continue
		previousLength = filtered.length

		try {
			await sendFn(filtered)

			// Compute dropped types
			const sentTypes = new Set(filtered.map((p) => p.type))
			const allTypes = new Set(allParts.map((p) => p.type))
			const droppedTypes = [...allTypes].filter((t) => !sentTypes.has(t))

			return {
				success: true,
				tier,
				sentParts: filtered,
				droppedTypes,
			}
		} catch (err) {
			lastError = err
		}
	}

	return {
		success: false,
		error: lastError instanceof Error ? lastError.message : String(lastError),
	}
}

// ─── subagent-result-sync.ts ───
/**
 * Detect whether a task tool output contains an empty <task_result> tag,
 * indicating the child session returned no content (likely due to a model
 * failure that triggered fallback).
 */
export function isEmptyTaskResult(output: string): boolean {
	return /<task_result>\s*<\/task_result>/.test(output)
}

/**
 * Extract the child session ID from task tool output.
 * Format: `task_id: ses_XXXXX (for resuming...)`
 */
const TASK_ID_REGEX = /task_id:\s*(ses_[a-zA-Z0-9]+)/

export function extractChildSessionID(output: string): string | null {
	if (!output) return null
	const match = output.match(TASK_ID_REGEX)
	return match ? match[1] : null
}

export interface WaitOptions {
	/** Maximum time to wait in milliseconds */
	maxWaitMs?: number
	/** Polling interval in milliseconds (only used as fallback for streaming check) */
	pollIntervalMs?: number
}

/**
 * Helper to extract the session status type string from session.get() response.
 * OpenCode's SessionStatus is a discriminated union ({ type: "idle" } | ...) but
 * may also appear as a plain string.
 */
function getSessionStatusType(
	sessionData: Record<string, unknown> | undefined,
): string | undefined {
	const status = sessionData?.status
	if (!status) return undefined
	if (typeof status === "string") return status
	if (typeof status === "object" && status !== null && "type" in status) {
		return (status as { type?: string }).type
	}
	return undefined
}

/**
 * Wait for a child session to go idle using a hybrid approach:
 *
 * 1. Event-driven: registers a resolver that handleSessionIdle triggers
 * 2. Polling fallback: periodically checks session.get() status
 * 3. Activity-aware: resets the timeout whenever a message.updated is
 *    received for the child session (tracked via sessionLastMessageTime)
 *
 * The polling fallback is essential because plugin reinitialization (e.g.
 * hot-reload) wipes the sessionIdleResolvers map, orphaning any registered
 * event-driven waiters.  The poller survives reinit because it uses the
 * SDK client directly.
 *
 * Timeout behavior: the inactivityMs timeout resets every time we see a
 * new message.updated for the child.  As long as messages keep arriving,
 * the child is making progress and we keep waiting.  We only time out
 * after inactivityMs of silence.
 */
function waitForSessionIdle(
	deps: HookDeps,
	sessionID: string,
	inactivityMs: number,
	pollIntervalMs: number = 2000,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false
		let pollTimer: ReturnType<typeof setInterval> | undefined
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		let lastSeenMessageTime = deps.sessionLastMessageTime.get(sessionID) ?? Date.now()

		const settle = (result: boolean) => {
			if (settled) return
			settled = true
			if (pollTimer) clearInterval(pollTimer)
			if (timeoutTimer) clearTimeout(timeoutTimer)
			const resolvers = deps.sessionIdleResolvers.get(sessionID)
			if (resolvers) {
				const idx = resolvers.indexOf(onIdleRef)
				if (idx >= 0) resolvers.splice(idx, 1)
				if (resolvers.length === 0) deps.sessionIdleResolvers.delete(sessionID)
			}
			resolve(result)
		}

		const onIdleRef = () => settle(true)

		// Register resolver for session.idle event (primary path)
		let resolvers = deps.sessionIdleResolvers.get(sessionID)
		if (!resolvers) {
			resolvers = []
			deps.sessionIdleResolvers.set(sessionID, resolvers)
		}
		resolvers.push(onIdleRef)

		// Schedule the inactivity timeout
		const resetTimeout = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer)
			timeoutTimer = setTimeout(() => settle(false), inactivityMs)
		}
		resetTimeout()

		// Polling: check for idle status AND for new message activity
		const pollStatus = () => {
			if (settled) return

			// Check if new message.updated events arrived since last poll.
			// If so, the child is still working — reset the timeout.
			const currentMessageTime = deps.sessionLastMessageTime.get(sessionID)
			if (currentMessageTime && currentMessageTime > lastSeenMessageTime) {
				lastSeenMessageTime = currentMessageTime
				resetTimeout()
			}

			// Also poll session.get() as a fallback for idle detection
			deps.ctx.client.session.get({ path: { id: sessionID } })
				.then((sessionInfo) => {
					if (settled) return
					const statusType = getSessionStatusType(
						(sessionInfo?.data ?? sessionInfo) as Record<string, unknown> | undefined
					)
					if (statusType === "idle") {
						logInfo(`[subagent-sync] Polling detected child ${sessionID} idle`)
						settle(true)
					}
				})
				.catch(() => {})
		}

		// Immediate check + start periodic polling
		pollStatus()
		pollTimer = setInterval(pollStatus, pollIntervalMs)
	})
}

/**
 * Wait for child session fallback to complete and return the assistant's
 * response text.  Uses a hybrid approach:
 *
 * - Event-driven session.idle detection (fastest path)
 * - Polling fallback via session.get() (survives plugin reinit)
 * - Activity-aware timeout: resets every time a message.updated is received
 *   for the child, so active sessions never time out prematurely
 *
 * Returns null if the wait times out or no valid assistant response is found.
 */
export async function waitForChildFallbackResult(
	deps: HookDeps,
	childSessionID: string,
	options?: WaitOptions,
): Promise<string | null> {
	const maxWaitMs = options?.maxWaitMs ?? Math.min((deps.config.timeout_seconds || 120) * 1000, 120_000)
	const pollIntervalMs = options?.pollIntervalMs ?? 500
	const startTime = Date.now()

	logInfo(`[subagent-sync] Waiting for child ${childSessionID} fallback result (max ${maxWaitMs}ms idle timeout)`)

	// Phase 1: Wait for fallback dispatch to complete (retry flags to clear)
	// This is a short spin-wait since dispatch happens within milliseconds.
	while (deps.sessionRetryInFlight.has(childSessionID)) {
		if (Date.now() - startTime >= maxWaitMs) {
			logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} dispatch after ${maxWaitMs}ms`)
			return null
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
	}

	// Phase 2: Wait for the child session to go idle (model done generating).
	// Hybrid: event-driven idle resolver + polling via session.get().
	// The timeout resets every time a message.updated is received for the
	// child, so actively streaming sessions never time out prematurely.
	const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime))

	const wentIdle = await waitForSessionIdle(
		deps,
		childSessionID,
		remainingMs,
		pollIntervalMs,
	)

	if (!wentIdle) {
		logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} after ${Date.now() - startTime}ms`)
		return null
	}

	// Phase 3: Extract the assistant response
	const result = await extractAssistantResponse(deps, childSessionID)
	if (result) {
		logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`)
		return result
	}

	logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`)
	return null
}

/**
 * Read the child session's messages and extract the last assistant
 * message's text content.
 */
async function extractAssistantResponse(
	deps: HookDeps,
	childSessionID: string,
): Promise<string | null> {
	try {
		const msgs = await deps.ctx.client.session.messages({
			path: { id: childSessionID },
			query: { directory: deps.ctx.directory },
		})

		if (!msgs.data || msgs.data.length === 0) return null

		// Find the last assistant message
		const lastAssistant = [...msgs.data].reverse().find(
			(m) => m.info?.role === "assistant",
		)

		if (!lastAssistant?.parts) return null

		// Concatenate all text parts
		const textParts = lastAssistant.parts
			.filter((p) => p.type === "text" && p.text)
			.map((p) => p.text!)

		if (textParts.length === 0) return null

		return textParts.join("")
	} catch (err) {
		logInfo(`[subagent-sync] Error reading child messages: ${err}`)
		return null
	}
}

// ─── auto-retry.ts ───
const SESSION_TTL_MS = 30 * 60 * 1000


// Delay after abort to let OpenCode's session-level abort propagation settle.
// Without this, a promptAsync sent immediately after abort can itself be aborted
// because OpenCode's abort is session-wide and takes time to fully propagate.
const POST_ABORT_DELAY_MS = 150

function summarizeParts(parts: MessagePart[] | undefined): {
	count: number
	types: string[]
	textChars: number
	hasToolCall: boolean
} {
	if (!parts || parts.length === 0) {
		return { count: 0, types: [], textChars: 0, hasToolCall: false }
	}

	const typeSet = new Set<string>()
	let textChars = 0
	let hasToolCall = false

	for (const part of parts) {
		typeSet.add(part.type)
		const textValue = (part as Record<string, unknown>).text
		if (part.type === "text" && typeof textValue === "string") {
			textChars += textValue.length
		}
		if (part.type === "tool_call") {
			hasToolCall = true
		}
	}

	return {
		count: parts.length,
		types: Array.from(typeSet),
		textChars,
		hasToolCall,
	}
}

export function createAutoRetryHelpers(deps: HookDeps) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	/** Look up the parentID for a session, with caching.
	 *  Returns the parentID string if this is a child session, or null. */
	const getParentSessionID = async (sessionID: string): Promise<string | null> => {
		const cached = deps.sessionParentID.get(sessionID)
		if (cached !== undefined) return cached

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const parentID = typeof sessionData?.parentID === "string" && sessionData.parentID.length > 0
				? sessionData.parentID
				: null
			deps.sessionParentID.set(sessionID, parentID)
			if (parentID) {
				logInfo("Detected child session", { sessionID, parentID })
			}
			return parentID
		} catch {
			logError("Failed to look up parentID", { sessionID })
			return null
		}
	}

	const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
		try {
			await ctx.client.session.abort({ path: { id: sessionID } })
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now())
			logInfo(`Aborted in-flight session request (${source})`, { sessionID })
		} catch (error) {
			logError(`Failed to abort in-flight session request (${source})`, {
				sessionID,
				error: String(error),
			})
		}
	}

	const clearSessionFallbackTimeout = (sessionID: string) => {
		const timer = sessionFallbackTimeouts.get(sessionID)
		if (timer) {
			clearTimeout(timer)
			sessionFallbackTimeouts.delete(sessionID)
		}
	}

	const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent?: string) => {
		clearSessionFallbackTimeout(sessionID)

		const timeoutMs = config.timeout_seconds * 1000
		if (timeoutMs <= 0) return

		const timer = setTimeout(async () => {
			sessionFallbackTimeouts.delete(sessionID)

			// TTFT: if first token has been received, model is streaming — don't abort
			if (deps.sessionFirstTokenReceived.get(sessionID)) {
				logInfo("Timeout fired but first token already received, skipping abort", {
					sessionID,
				})
				return
			}

			const state = sessionStates.get(sessionID)
			if (!state) return

			// If another handler (e.g. session.idle silent-failure or
			// session.status) already holds the retry lock, it is already
			// advancing the fallback chain.  Don't interfere.
			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Timeout fired but retry already in flight, deferring", { sessionID })
				return
			}

			// For TTFT timeouts we MUST abort even for child sessions — the
			// hung model is still consuming the session and we cannot send a
			// replay until it is stopped.  The downstream autoRetryWithFallback
			// will handle the child-session concern (skipping its own abort
			// since we already did it here).
			//
			// Clear compaction-in-flight: the compaction timed out, so the
			// next attempt needs a clean slate (the new autoRetryWithFallback
			// call will re-set the flag if it dispatches compaction again).
			deps.sessionCompactionInFlight.delete(sessionID)
			await abortSessionRequest(sessionID, "session.timeout")

			if (state.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}

			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels,
				config.auto_discover ? deps.autoDiscoveredModels : undefined,
				config.auto_order
			)
			if (fallbackModels.length === 0) return

			logInfo("Session fallback timeout reached", {
				sessionID,
				timeoutSeconds: config.timeout_seconds,
				currentModel: state.currentModel,
			})

			// Timeout callback manages its own lock lifecycle
			sessionRetryInFlight.add(sessionID)
			try {
				const plan = planFallback(sessionID, state, fallbackModels, config)
				if (plan.success) {
					await autoRetryWithFallback(
						sessionID,
						plan.newModel,
						resolvedAgent,
						"session.timeout",
						plan
					)
				}
			} finally {
				sessionRetryInFlight.delete(sessionID)
			}
		}, timeoutMs)

		sessionFallbackTimeouts.set(sessionID, timer)
	}

	const autoRetryWithFallback = async (
		sessionID: string,
		newModel: string,
		resolvedAgent: string | undefined,
		source: string,
		plan?: FallbackPlan
	): Promise<boolean> => {
		// Track whether we skipped because another handler owns the dispatch.
		// In that case, the finally block must NOT clear sessionAwaitingFallbackResult.
		let deferredToOtherHandler = false

		// Guard: if the state has already been advanced past this model by
		// a concurrent handler (race between message.updated / session.error /
		// session.status), skip this retry — the other handler owns it now.
		// When using plan-based flow, state hasn't been committed yet, so
		// check against the failed model (which should still be current).
		const preCheckState = sessionStates.get(sessionID)
		if (plan) {
			if (preCheckState && preCheckState.currentModel !== plan.failedModel) {
				logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, expected failed model ${plan.failedModel}`, {
					sessionID,
					staleModel: newModel,
					currentModel: preCheckState.currentModel,
				})
				deferredToOtherHandler = true
				return false
			}
		} else if (preCheckState && preCheckState.currentModel !== newModel) {
			logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
				sessionID,
				staleModel: newModel,
				currentModel: preCheckState.currentModel,
			})
			deferredToOtherHandler = true
			return false
		}

		const modelParts = newModel.split("/")
		if (modelParts.length < 2) {
			logInfo(`Invalid model format (missing provider prefix): ${newModel}`)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			return false
		}

		const fallbackModelObj = {
			providerID: modelParts[0],
			modelID: modelParts.slice(1).join("/"),
		}

		// ── TOP-LEVEL SESSION HANDLING ──
		// Decide whether to abort based on model state, not session type.
		//
		// Error-triggered sources (session.error, message.updated): the model
		// has already stopped — abort is unnecessary and harmful (for child
		// sessions it signals the parent that the child is done, causing an
		// empty response).
		//
		// Timeout (session.timeout): the caller already aborted because the
		// model was hung — just wait for propagation.
		//
		// Status sources (session.status, session.status.immediate): the model
		// is still in a provider retry loop — abort is needed to stop it.
		const modelAlreadyStopped = source === "session.error" || source === "message.updated"
		const callerAlreadyAborted = source === "session.timeout"
		// session.idle.silent-failure: the model went idle without producing
		// tokens.  No NEW abort is needed, but a recent abort (e.g. from
		// session.timeout or session.status) may still be propagating.
		// We must wait for propagation before sending the replay.
		const mayHaveRecentAbort = source === "session.idle.silent-failure"

		if (modelAlreadyStopped) {
			logInfo(`Skipping abort — model already stopped (${source})`, {
				sessionID,
				newModel,
			})
		} else if (callerAlreadyAborted || mayHaveRecentAbort) {
			const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
			const msSinceAbort = selfAbortTs ? Date.now() - selfAbortTs : undefined
			if (selfAbortTs && msSinceAbort !== undefined && msSinceAbort < POST_ABORT_DELAY_MS * 2) {
				logInfo(`Waiting for recent abort propagation (${source})`, {
					sessionID,
					msSinceAbort,
				})
				// Wait the remaining time until the abort propagation window closes
				const remainingMs = Math.max(0, POST_ABORT_DELAY_MS - msSinceAbort)
				if (remainingMs > 0) {
					await new Promise<void>((resolve) =>
						setTimeout(() => resolve(), remainingMs)
					)
				}
			} else if (callerAlreadyAborted) {
				logInfo(`Caller already aborted (${source}), waiting for propagation`, {
					sessionID,
				})
				await new Promise<void>((resolve) =>
					setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
				)
			}
		} else {
			await abortSessionRequest(sessionID, `pre-fallback.${source}`)
			await new Promise<void>((resolve) =>
				setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
			)
		}

		// Note: The caller holds sessionRetryInFlight. We do NOT manage it here.
		deps.sessionFirstTokenReceived.set(sessionID, false)
		let retryDispatched = false
		try {
			// ── COMPACTION FALLBACK: ABORT + SUMMARIZE ON FALLBACK MODEL ──
			// OpenCode's session.summarize endpoint:
			//  1. Calls SessionRevert.cleanup (undoes any revert state)
			//  2. Creates a NEW compaction via SessionCompaction.create with
			//     the model we specify (providerID + modelID)
			//  3. Runs SessionPrompt.loop to process it
			//
			// Key insight: summarize handles cleanup internally, so we don't
			// need to revert or delete messages ourselves.  We just need to
			// abort the stuck session and wait for it to settle, then call
			// summarize with the fallback model.
			if (resolvedAgent === "compaction") {
				const failedModel = plan?.failedModel
				logInfo(`Compaction fallback: abort + summarize on fallback (${source})`, {
					sessionID,
					failedModel,
					newModel,
				})

				// Suppress stale errors from the failed compaction
				deps.sessionCompactionInFlight.add(sessionID)

				if (failedModel && plan) {
					const currentState = sessionStates.get(sessionID)
					if (currentState) {
						if (!currentState.failedModels.has(failedModel)) {
							currentState.failedModels.set(failedModel, Date.now())
						}
					}
				}

				// Step 1: Abort the stuck session
				try {
					await abortSessionRequest(sessionID, "compaction-fallback")
				} catch {
					logError(`Failed to abort session for compaction fallback (${source})`, { sessionID })
				}

				// Step 2: Wait for abort to fully propagate.
				await new Promise<void>((resolve) => setTimeout(resolve, 500))

				// Step 3: Delete the failed compaction messages from the session.
				// session.summarize calls SessionPrompt.loop which processes
				// messages in order — if the old failed compaction messages remain,
				// the loop retries them on k2p5 instead of using our new model.
				// The DELETE /session/{id}/message/{messageID} endpoint removes
				// them permanently (not available as a typed SDK method, so we
				// use the SDK's internal HTTP client directly).
				try {
					const messagesResp = await ctx.client.session.messages({
						path: { id: sessionID },
						query: { directory: ctx.directory },
					})
					const msgs = messagesResp.data ?? []

					// Collect message IDs to delete: failed assistant + compaction user
					// Delete in reverse order (newest first) to avoid index shifts
					const deleteIDs: string[] = []
					for (let i = msgs.length - 1; i >= 0; i--) {
						const msg = msgs[i]
						const msgRole = msg.info?.role as string | undefined
						const msgError = msg.info?.error
						const msgID = msg.info?.id as string | undefined
						const parts = msg.parts ?? []
						const isCompactionMsg = parts.length > 0 &&
							parts.every((p: any) => p.type === "compaction")

						if (!msgID) continue

						// Failed assistant message
						if (msgRole === "assistant" && msgError) {
							deleteIDs.push(msgID)
							continue
						}

						// Compaction user message
						if (isCompactionMsg) {
							deleteIDs.push(msgID)
							break // stop after finding both
						}
					}

					// Use the SDK's internal client to make raw DELETE calls
					const rawClient = (ctx.client.session as any)?._client
					if (rawClient && deleteIDs.length > 0) {
						for (const msgID of deleteIDs) {
							logInfo(`Deleting compaction message (${source})`, {
								sessionID,
								messageID: msgID,
							})
							try {
								await rawClient.delete({
									url: "/session/{id}/message/{messageID}",
									path: { id: sessionID, messageID: msgID },
								})
								logInfo(`Deleted compaction message (${source})`, {
									sessionID,
									messageID: msgID,
								})
							} catch (delErr) {
								logError(`Failed to delete compaction message (${source})`, {
									sessionID,
									messageID: msgID,
									error: String(delErr),
								})
							}
						}
					} else if (deleteIDs.length > 0) {
						logError(`Cannot access raw SDK client for message deletion (${source})`, {
							sessionID,
							messageCount: deleteIDs.length,
						})
					}
				} catch (msgErr) {
					logError(`Failed during compaction message cleanup (${source})`, {
						sessionID,
						error: String(msgErr),
					})
				}

				// Small delay to let deletions settle
				await new Promise<void>((resolve) => setTimeout(resolve, 200))

				// Step 4: Call session.summarize with the fallback model
				try {
					if (sessionAwaitingFallbackResult.has(sessionID)) {
						logInfo(`Skipping duplicate compaction summarize (${source})`, { sessionID })
						deferredToOtherHandler = true
						return false
					}
					sessionAwaitingFallbackResult.add(sessionID)

					logInfo(`Dispatching session.summarize on fallback model (${source})`, {
						sessionID,
						providerID: fallbackModelObj.providerID,
						modelID: fallbackModelObj.modelID,
					})

					const summarizeResult = await ctx.client.session.summarize({
						path: { id: sessionID },
						body: {
							providerID: fallbackModelObj.providerID,
							modelID: fallbackModelObj.modelID,
						},
						query: { directory: ctx.directory },
					})

					logInfo(`session.summarize response (${source})`, {
						sessionID,
						model: newModel,
						response: (JSON.stringify(summarizeResult) ?? "undefined").slice(0, 500),
					})

					// Commit fallback state after successful dispatch
					if (plan) {
						const stateToCommit = sessionStates.get(sessionID)
						if (stateToCommit) {
							const committed = commitFallback(stateToCommit, plan)
							if (committed) {
								logInfo(`Committed fallback after compaction summarize (${source})`, {
									sessionID,
									from: plan.failedModel,
									to: plan.newModel,
									attemptCount: stateToCommit.attemptCount,
								})
							}
						}
					}

					scheduleSessionFallbackTimeout(sessionID, undefined)
					retryDispatched = true

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Fallback",
									message: `${fromName} failed — retrying compaction on ${toName}`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					logInfo(`Compaction re-dispatched via summarize (${source})`, {
						sessionID,
						model: newModel,
					})
					return true
				} catch (summarizeErr) {
					logError(`session.summarize failed (${source})`, {
						sessionID,
						model: newModel,
						error: String(summarizeErr),
					})
					sessionAwaitingFallbackResult.delete(sessionID)

					// Summarize failed — commit fallback state so chat.message
					// override works for regular prompts
					if (plan) {
						const currentState = sessionStates.get(sessionID)
						if (currentState) {
							commitFallback(currentState, plan)
							logInfo(`Committed compaction fallback state as last resort (${source})`, {
								sessionID,
								from: plan.failedModel,
								to: plan.newModel,
							})
						}
					}

					deps.sessionCompactionInFlight.delete(sessionID)
					clearSessionFallbackTimeout(sessionID)
					sessionAwaitingFallbackResult.delete(sessionID)

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Failed",
									message: `${fromName} can't compact — try /compact after switching to ${toName}`,
									variant: "warning",
									duration: 10000,
								},
							})
							.catch(() => {})
					}

					deferredToOtherHandler = true
					return false
				}
			}

			// ── NORMAL REPLAY DISPATCH PATH ──
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) {
				logError(`No messages found in session for auto-retry (${source})`, { sessionID })
			}

			// Prefer replaying the last user message.  In child subagent sessions,
			// the latest replayable prompt can be non-user (e.g. system/tool), so
			// fall back to the last non-assistant message with parts.
			//
			// Skip messages that ONLY contain "compaction" type parts — these are
			// compaction-internal messages that promptAsync cannot replay.  We need
			// the real user message that preceded the compaction attempt.
			let lastUserPartsRaw: any[] | undefined
			let lastNonAssistantPartsRaw: any[] | undefined

			for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
				const m = msgs?.[i]
				const role = ((m?.info?.role ?? (m as any)?.role ?? "") as string).toLowerCase()
				const parts = m?.parts ?? (m?.info?.parts as any[] | undefined)
				if (!parts || parts.length === 0) continue

				// Skip compaction-only messages: parts where every part is
				// type "compaction" (not replayable via promptAsync).
				const hasOnlyCompactionParts = parts.every(
					(p: any) => p.type === "compaction"
				)
				if (hasOnlyCompactionParts) continue

				if (!lastNonAssistantPartsRaw && role !== "assistant") {
					lastNonAssistantPartsRaw = parts
				}

				if (role === "user") {
					lastUserPartsRaw = parts
					break
				}
			}

			const replayPartsRaw = lastUserPartsRaw ?? lastNonAssistantPartsRaw
			const replaySource = lastUserPartsRaw ? "last-user" : lastNonAssistantPartsRaw ? "last-non-assistant" : "none"

			if (replayPartsRaw && replayPartsRaw.length > 0) {
				// Second stale check: re-verify after all async work (abort + delay +
				// message fetch).  Another handler may have advanced the state during
				// any of the awaits above.
				const postCheckState = sessionStates.get(sessionID)
				const expectedCurrentModel = plan ? plan.failedModel : newModel
				if (postCheckState && postCheckState.currentModel !== expectedCurrentModel) {
					logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${postCheckState.currentModel}, expected failed model ${expectedCurrentModel}`, {
						sessionID,
						staleModel: newModel,
						currentModel: postCheckState.currentModel,
					})
					deferredToOtherHandler = true
					return false
				}


				// If another handler already dispatched and is awaiting a result
				// for this session, skip the duplicate dispatch.
				if (sessionAwaitingFallbackResult.has(sessionID)) {
					logInfo(`Skipping duplicate fallback dispatch — another handler already dispatched (${source})`, {
						sessionID,
						model: newModel,
					})
					deferredToOtherHandler = true
					return false
				}

				// Claim the dispatch slot BEFORE any async work (promptAsync).
				// This prevents a second concurrent handler from also dispatching.
				// Cleared in the finally block if dispatch fails.
				sessionAwaitingFallbackResult.add(sessionID)

				logInfo(`Auto-retrying with fallback model (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
				})

				// Cast raw parts to MessagePart (runtime parts may have any shape).
				// Filter out "compaction" type parts — these are internal to
				// OpenCode's compaction and not replayable via promptAsync.
				const allParts: MessagePart[] = replayPartsRaw.filter(
					(p): p is MessagePart =>
						typeof p.type === "string" && p.type !== "compaction"
				)

				logInfo(`Prepared replay payload (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
					payload: summarizeParts(allParts),
				})

				if (allParts.length > 0) {
					// Build the send function that calls promptAsync
					const sendFn = async (parts: MessagePart[]): Promise<void> => {
						logInfo(`Dispatching fallback replay (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
							payload: summarizeParts(parts),
						})
						await ctx.client.session.promptAsync({
							path: { id: sessionID },
							body: {
								...(resolvedAgent ? { agent: resolvedAgent } : {}),
								model: fallbackModelObj,
								parts,
							},
							query: { directory: ctx.directory },
						})
						logInfo(`Fallback replay accepted by host (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
						})
					}

					const replayResult = await replayWithDegradation(allParts, sendFn)

					if (replayResult.success) {
						// Commit the fallback plan to state NOW — after the API call
						// actually succeeded. This prevents race conditions where
						// session.error sees an advanced state before any API call
						// was made.
						let commitSucceeded = true
						if (plan) {
							const stateToCommit = sessionStates.get(sessionID)
							if (stateToCommit) {
								const committed = commitFallback(stateToCommit, plan)
								if (committed) {
									logInfo(`Committed fallback state after successful dispatch (${source})`, {
										sessionID,
										newModel: plan.newModel,
										failedModel: plan.failedModel,
										attemptCount: stateToCommit.attemptCount,
									})
								} else {
									// Another handler already committed the same plan.
									// We've sent a duplicate replay that we can't un-send.
									// Abort it to prevent the provider from processing
									// two requests for the same session, then bail out
									// so we don't schedule a competing timeout.
									logInfo(`Fallback state already committed by another handler — aborting duplicate replay (${source})`, {
										sessionID,
										newModel: plan.newModel,
									})
									commitSucceeded = false
									await abortSessionRequest(sessionID, `duplicate-replay.${source}`)
								}
							}
						}

						if (!commitSucceeded) {
							// Let the handler that won the commit own the awaiting
							// state and timeout.  Mark ourselves as deferred.
							deferredToOtherHandler = true
							return false
						}

						// sessionAwaitingFallbackResult already set before dispatch
						scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						retryDispatched = true

						logInfo(`Fallback replay succeeded (${source})`, {
							sessionID,
							tier: replayResult.tier,
							sentPartsCount: replayResult.sentParts?.length,
							droppedTypes: replayResult.droppedTypes,
							replaySource,
						})

						// Show toast if parts were dropped (tier > 1)
						if (replayResult.droppedTypes && replayResult.droppedTypes.length > 0) {
							const droppedStr = replayResult.droppedTypes.join(", ")
							await ctx.client.tui
								.showToast({
									body: {
										title: "Message Replay",
										message: `Some message parts were dropped for compatibility: ${droppedStr}`,
										variant: "warning",
										duration: 5000,
									},
								})
								.catch(() => {})
						}
					} else {
						logError(`All replay tiers failed (${source})`, {
							sessionID,
							error: replayResult.error,
						})
					}
				}
			} else {
				logInfo(`No replayable non-assistant message found for auto-retry (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
				})
			}
		} catch (retryError) {
			logError(`Auto-retry failed (${source})`, {
				sessionID,
				error: String(retryError),
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			deps.sessionCompactionInFlight.delete(sessionID)
			clearSessionFallbackTimeout(sessionID)
		} finally {
			// Note: sessionRetryInFlight is managed by the caller, not here.
			// Don't clear awaiting flag if we deferred to another handler that
			// IS dispatching — they own the flag now.
			if (!retryDispatched && !deferredToOtherHandler) {
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				const state = sessionStates.get(sessionID)
				if (state?.pendingFallbackModel) {
					state.pendingFallbackModel = undefined
				}
			}
		}

		return retryDispatched
	}

	const resolveAgentForSessionFromContext = async (
		sessionID: string,
		eventAgent?: string
	): Promise<string | undefined> => {
		const resolved = resolveAgentForSession(sessionID, eventAgent)
		if (resolved) return resolved

		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) return undefined

			for (let i = msgs.length - 1; i >= 0; i--) {
				const info = msgs[i]?.info
				const infoAgent = typeof info?.agent === "string" ? info.agent : undefined
				if (infoAgent && infoAgent.trim().length > 0) {
					return infoAgent.trim().toLowerCase()
				}
			}
		} catch {
			logError("Failed to resolve agent from messages", { sessionID })
		}

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const sdkAgent =
				typeof sessionData?.agent === "string" ? sessionData.agent : undefined
			if (sdkAgent && sdkAgent.trim().length > 0) {
				const normalized = sdkAgent.trim().toLowerCase()
				logInfo("Resolved agent from session.get", { sessionID, agent: normalized })
				return normalized
			}
		} catch {
			logError("Failed to resolve agent from session.get", { sessionID })
		}

		return undefined
	}

	const cleanupStaleSessions = () => {
		const now = Date.now()
		let cleanedCount = 0
		for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
			if (now - lastAccess > SESSION_TTL_MS) {
				sessionStates.delete(sessionID)
				sessionLastAccess.delete(sessionID)
				sessionRetryInFlight.delete(sessionID)
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionFirstTokenReceived.delete(sessionID)
				deps.sessionSelfAbortTimestamp.delete(sessionID)
				deps.sessionParentID.delete(sessionID)
				deps.sessionIdleResolvers.delete(sessionID)
				deps.sessionLastMessageTime.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				cleanedCount++
			}
		}
		if (cleanedCount > 0) {
			logInfo(`Cleaned up ${cleanedCount} stale session states`)
		}
	}

	return {
		getParentSessionID,
		abortSessionRequest,
		clearSessionFallbackTimeout,
		scheduleSessionFallbackTimeout,
		autoRetryWithFallback,
		resolveAgentForSessionFromContext,
		cleanupStaleSessions,
	}
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>

// ─── event-handler.ts ───
export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	const handleActivity = async (sessionID: string, activityModel?: string) => {
		// If a fallback is awaiting results and we know the model that produced
		// this activity, verify it matches the current fallback model.  Stale
		// activity from the failed model (e.g. k2p5 emitting a final
		// message.part.delta while gemini-flash is being dispatched) must NOT
		// mark firstTokenReceived or reset the timeout — that would cause
		// session.idle to declare "fallback model completed" before the actual
		// fallback model has produced anything.
		if (activityModel && sessionAwaitingFallbackResult.has(sessionID)) {
			const state = sessionStates.get(sessionID)
			if (state && state.failedModels.has(activityModel)) {
				logInfo("Ignoring activity from already-failed model", {
					sessionID,
					activityModel,
					currentModel: state.currentModel,
				})
				return
			}
		}

		// Any model activity (text deltas, tool calls, diffs) proves the model
		// is alive and producing output.  Mark first token received so the TTFT
		// timeout handler skips the abort when it eventually fires.
		if (!deps.sessionFirstTokenReceived.get(sessionID)) {
			deps.sessionFirstTokenReceived.set(sessionID, true)
		}

		if (sessionAwaitingFallbackResult.has(sessionID)) {
			const resolvedAgent = resolveAgentForSession(sessionID, undefined)
			helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
			logInfo("Resetting fallback timeout due to activity", { sessionID, activityModel })
			return
		}

		if (sessionAwaitingFallbackResult.size === 0) {
			return
		}

		const cachedParentID = deps.sessionParentID.get(sessionID)
		const parentID =
			cachedParentID !== undefined
				? cachedParentID
				: await helpers.getParentSessionID(sessionID)

		if (parentID && sessionAwaitingFallbackResult.has(parentID)) {
			const resolvedAgent = resolveAgentForSession(parentID, undefined)
			helpers.scheduleSessionFallbackTimeout(parentID, resolvedAgent)
			logInfo("Resetting parent fallback timeout due to child activity", {
				sessionID,
				parentID,
			})
		}
	}

	const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
		const sessionInfo = props?.info as { id?: string } | undefined
		const sessionID = sessionInfo?.id
		if (!sessionID) return

		const parentID = (sessionInfo as Record<string, unknown> | undefined)?.parentID
		if (typeof parentID === "string" && parentID.length > 0) {
			deps.sessionParentID.set(sessionID, parentID)
		}

		logInfo("Session created, state will be created on-demand", { sessionID })
	}

	const handleSessionDeleted = (props: Record<string, unknown> | undefined) => {
		const sessionInfo = props?.info as { id?: string } | undefined
		const sessionID = sessionInfo?.id

		if (sessionID) {
			logInfo("Cleaning up session state", { sessionID })
			sessionStates.delete(sessionID)
			sessionLastAccess.delete(sessionID)
			sessionRetryInFlight.delete(sessionID)
			sessionAwaitingFallbackResult.delete(sessionID)
			deps.sessionFirstTokenReceived.delete(sessionID)
			deps.sessionSelfAbortTimestamp.delete(sessionID)
			deps.sessionParentID.delete(sessionID)
			deps.sessionCompactionInFlight.delete(sessionID)
			deps.sessionIdleResolvers.delete(sessionID)
			deps.sessionLastMessageTime.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
		}
	}

	const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		helpers.clearSessionFallbackTimeout(sessionID)

		if (
			sessionRetryInFlight.has(sessionID) ||
			sessionAwaitingFallbackResult.has(sessionID)
		) {
			await helpers.abortSessionRequest(sessionID, "session.stop")
		}

		sessionRetryInFlight.delete(sessionID)
		sessionAwaitingFallbackResult.delete(sessionID)
		deps.sessionCompactionInFlight.delete(sessionID)
		deps.sessionSelfAbortTimestamp.delete(sessionID)

		const state = sessionStates.get(sessionID)
		if (state?.pendingFallbackModel) {
			state.pendingFallbackModel = undefined
		}

		logInfo("Cleared fallback retry state on session.stop", { sessionID })
	}

	const handleSessionIdle = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		// Resolve any idle waiters FIRST (e.g. subagent-sync waiting for
		// a child session's fallback to complete). This must happen before
		// the sessionAwaitingFallbackResult early-return below, because
		// the waiter needs to know the child went idle regardless.
		const idleResolvers = deps.sessionIdleResolvers.get(sessionID)
		if (idleResolvers && idleResolvers.length > 0) {
			logInfo("session.idle resolving waiters", {
				sessionID,
				waiterCount: idleResolvers.length,
			})
			for (const resolve of idleResolvers) resolve()
			deps.sessionIdleResolvers.delete(sessionID)
		}

		if (sessionAwaitingFallbackResult.has(sessionID)) {
			// ── COMPACTION IN-FLIGHT: SKIP SILENT-FAILURE DETECTION ──
			// Compaction via session.command produces no message.updated events.
			// session.idle firing during compaction does NOT mean the model
			// failed — it means the session went idle between the original
			// error and the compaction starting on the new model.  Wait for
			// session.compacted (success) or TTFT timeout (failure).
			if (deps.sessionCompactionInFlight.has(sessionID)) {
				logInfo("session.idle during compaction in-flight — not a silent failure, waiting for session.compacted", {
					sessionID,
				})
				return
			}

			// ── SILENT MODEL FAILURE DETECTION ──
			// If we dispatched a fallback model (sessionAwaitingFallbackResult is
			// set) but no first token was ever received, the model silently failed
			// (e.g. model_not_found, quota exceeded, empty response). Treat this
			// idle as a real failure and advance the fallback chain immediately
			// rather than waiting for the full TTFT timeout.
			const firstTokenReceived = deps.sessionFirstTokenReceived.get(sessionID)
			if (!firstTokenReceived) {
				const state = sessionStates.get(sessionID)
				if (state) {
				logInfo("session.idle detected silent model failure (no first token received)", {
					sessionID,
					currentModel: state.currentModel,
					attemptCount: state.attemptCount,
				})

				// Acquire retry lock BEFORE clearing the timeout.  The TTFT
				// timeout callback may already be queued in the event loop
				// (clearTimeout only prevents future scheduling, not already-
				// queued macrotasks).  By holding the lock first, any racing
				// timeout callback will see sessionRetryInFlight and bail out
				// at its own lock check, preventing dual planFallback calls.
				if (sessionRetryInFlight.has(sessionID)) {
					logInfo("session.idle silent failure — retry already in flight, skipping", {
						sessionID,
					})
					return
				}
				sessionRetryInFlight.add(sessionID)

				// Now safe to clear awaiting state and timeout
				sessionAwaitingFallbackResult.delete(sessionID)
				helpers.clearSessionFallbackTimeout(sessionID)

					try {
						const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
							sessionID,
							undefined
						)
						const fallbackModels = getFallbackModelsForSession(
							sessionID,
							resolvedAgent,
							deps.agentConfigs,
							deps.globalFallbackModels,
							config.auto_discover ? deps.autoDiscoveredModels : undefined,
							config.auto_order
						)
						if (fallbackModels.length === 0) {
							logInfo("session.idle silent failure — no fallback models configured", {
								sessionID,
							})
							return
						}

						const plan = planFallback(sessionID, state, fallbackModels, config)
						if (plan.success) {
							await helpers.autoRetryWithFallback(
								sessionID,
								plan.newModel,
								resolvedAgent,
								"session.idle.silent-failure",
								plan
							)
						} else {
							logInfo("session.idle silent failure — no more fallback models available", {
								sessionID,
								error: plan.error,
							})
						}
					} finally {
						sessionRetryInFlight.delete(sessionID)
					}
					return
				}
			}

			// First token was received and session went idle — the fallback
			// model completed its work (possibly with only tool calls, no text).
			// Clear the awaiting state so the session isn't stuck.
			logInfo("session.idle with first token received — fallback model completed", {
				sessionID,
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
			sessionRetryInFlight.delete(sessionID)
			return
		}

		const hadTimeout = sessionFallbackTimeouts.has(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)
		sessionRetryInFlight.delete(sessionID)

		const state = sessionStates.get(sessionID)
		if (state?.pendingFallbackModel) {
			state.pendingFallbackModel = undefined
		}

		if (hadTimeout) {
			logInfo("Cleared fallback timeout after session completion", { sessionID })
		}
	}

	const handleSessionStatus = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		const status = props?.status as
			| { type?: string; attempt?: number; message?: string; next?: number }
			| undefined
		if (!sessionID || !status || status.type !== "retry") return

		// ── EARLY LOCK ACQUISITION ──
		if (sessionRetryInFlight.has(sessionID)) {
			logInfo("session.status skipped -- retry lock already held", { sessionID })
			return
		}
		sessionRetryInFlight.add(sessionID)

		try {
			const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
				sessionID,
				undefined
			)
			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels,
				config.auto_discover ? deps.autoDiscoveredModels : undefined,
				config.auto_order
			)

			logInfo("Provider retry detected", {
				sessionID,
				attempt: status.attempt,
				message: status.message,
				nextRetryMs: status.next,
				resolvedAgent,
				totalFallbackModels: fallbackModels.length,
			})

			if (fallbackModels.length === 0) {
				if (config.notify_on_fallback) {
					await deps.ctx.client.tui
						.showToast({
							body: {
								title: "Provider Retrying",
								variant: "info",
								duration: 3000,
								message: `${status.message || "retrying..."} (no fallback models configured)`,
							},
						})
						.catch(() => {})
				}
				return
			}

			// Check if provider retry is too far in the future - trigger immediate fallback
			const nextRetryMs = status.next
			if (typeof nextRetryMs === "number" && nextRetryMs > 0) {
				const now = Date.now()
				const timeoutMs = config.timeout_seconds * 1000
				if (nextRetryMs > now + timeoutMs) {
					logInfo("Provider retry is beyond timeout, triggering immediate fallback", {
						sessionID,
						nextRetryMs,
						now,
						timeoutMs,
						diffSeconds: Math.round((nextRetryMs - now) / 1000),
					})
					await triggerImmediateFallback(sessionID, resolvedAgent, fallbackModels, status)
					return
				}
			}

			let state = sessionStates.get(sessionID)
			if (!state) {
				const agentConfig =
					resolvedAgent && deps.agentConfigs
						? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
						: undefined
				const initialModel = (agentConfig?.model as string | undefined) ?? findFirstAgentModel()
				if (!initialModel) {
					logInfo("No model info for session.status fallback", { sessionID })
					return
				}
				logInfo("Creating on-demand state for session.status", {
					sessionID,
					model: initialModel,
					agent: resolvedAgent,
				})
				state = createFallbackState(initialModel)
				sessionStates.set(sessionID, state)
				sessionLastAccess.set(sessionID, Date.now())
			} else {
				sessionLastAccess.set(sessionID, Date.now())
			}

			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)

			const plan = planFallback(sessionID, state, fallbackModels, config)

			if (plan.success) {
				if (config.notify_on_fallback) {
					const modelName = plan.newModel?.split("/").pop() || plan.newModel
					deps.ctx.client.tui
						.showToast({
							body: {
								title: "Retry Detected -- Switching Model",
								variant: "warning",
								duration: 5000,
								message: `${status.message || "Provider retrying"} -> ${modelName} (attempt ${state.attemptCount + 1} of ${fallbackModels.length})`,
							},
						})
						.catch(() => {})
				}

				await helpers.autoRetryWithFallback(
					sessionID,
					plan.newModel,
					resolvedAgent,
					"session.status",
					plan
				)
			} else if (!plan.success) {
				logError("session.status fallback failed", {
					sessionID,
					error: plan.error,
				})
				if (plan.maxAttemptsReached && config.notify_on_fallback) {
					await deps.ctx.client.tui
						.showToast({
							body: {
								title: "All Fallbacks Exhausted",
								variant: "error",
								duration: 8000,
								message: `All ${fallbackModels.length} fallback models exhausted after ${state.attemptCount} attempts`,
							},
						})
						.catch(() => {})
				}
			}
		} finally {
			sessionRetryInFlight.delete(sessionID)
		}
	}

	const handleSessionError = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		const error = props?.error
		const agent = props?.agent as string | undefined
		const errorModel = props?.model as string | undefined

		if (!sessionID) {
			logInfo("session.error without sessionID, skipping")
			return
		}

		// ── COMPACTION IN-FLIGHT GUARD ──
		// Compaction via session.command produces no standard events.  Any
		// session.error arriving while compaction is running is from the
		// pre-compaction model — suppress entirely.
		if (deps.sessionCompactionInFlight.has(sessionID)) {
			logInfo("Ignoring session.error during compaction in-flight", {
				sessionID,
				errorName: extractErrorName(error),
			})
			return
		}

		// ── SELF-ABORT GUARD ──
		// If this is a MessageAbortedError from a plugin-initiated abort
		// (TTFT timeout, pre-fallback abort, etc.), suppress it.  The handler
		// that initiated the abort is already dispatching the fallback.
		// We check this FIRST, before any stale-model or pending guards,
		// because those guards may not yet reflect the in-progress transition.
		const SELF_ABORT_WINDOW_MS = 2000
		const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
		const errorName = extractErrorName(error)
		if (
			errorName === "MessageAbortedError" &&
			selfAbortTs &&
			Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS
		) {
			logInfo("Ignoring self-inflicted MessageAbortedError in session.error", {
				sessionID,
				msSinceAbort: Date.now() - selfAbortTs,
				awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
				retryInFlight: sessionRetryInFlight.has(sessionID),
			})
			return
		}

		// Ignore stale errors from models we already moved past
		const currentState = sessionStates.get(sessionID)
		if (currentState?.pendingFallbackModel) {
			logInfo("Ignoring session.error while fallback replay is pending", {
				sessionID,
				pendingFallbackModel: currentState.pendingFallbackModel,
				currentModel: currentState.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		if (currentState && errorModel && errorModel !== currentState.currentModel) {
			logInfo("Ignoring stale session.error from previous model", {
				sessionID,
				staleModel: errorModel,
				currentModel: currentState.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		// If the error model has already been recorded as failed, this is a
		// stale echo from a model that already triggered a fallback.  Suppress
		// it to prevent duplicate fallback planning.
		if (currentState && errorModel && currentState.failedModels.has(errorModel)) {
			logInfo("Ignoring session.error from already-failed model", {
				sessionID,
				errorModel,
				currentModel: currentState.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		// If we're awaiting a fallback result, this session.error is likely
		// a stale abort from the previous model (session.error doesn't carry
		// a model field, so we can't reliably tell which model caused it).
		//
		// If the fallback model itself fails silently (no message.updated error,
		// no first token), the session.idle handler will detect it via the
		// "silent model failure" path and advance the chain.
		if (sessionAwaitingFallbackResult.has(sessionID)) {
			logInfo("Ignoring session.error while awaiting fallback result (likely stale abort)", {
				sessionID,
				currentModel: currentState?.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		// ── EARLY LOCK ACQUISITION ──
		// Acquire the lock BEFORE any async work (resolveAgentForSessionFromContext).
		// Both message.updated and session.error fire simultaneously for the same
		// error.  The first handler to reach this point wins; the other bails out.
		if (sessionRetryInFlight.has(sessionID)) {
			logInfo("session.error skipped -- retry in flight (early lock)", {
				sessionID,
				retryInFlight: true,
			})
			return
		}
		sessionRetryInFlight.add(sessionID)

		try {
			const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
				sessionID,
				agent
			)

			// ── POST-AWAIT COMPACTION GUARD ──
			// The pre-await guard at line 431 may miss the flag if
			// message.updated's handler set it during our await.  Re-check
			// here.  Only bail if message.updated is already handling the
			// compaction fallback (compactionInFlight flag is set).
			if (deps.sessionCompactionInFlight.has(sessionID)) {
				logInfo("session.error skipping — compaction already being handled by message.updated", {
					sessionID,
					resolvedAgent,
					errorName: extractErrorName(error),
				})
				return
			}

			helpers.clearSessionFallbackTimeout(sessionID)

			// Re-check pendingFallbackModel after the await — message.updated may
			// have created state and called prepareFallback while we were resolving
			// the agent.  This is the primary guard against the dual-handler race.
			const stateAfterAwait = sessionStates.get(sessionID)
			if (stateAfterAwait?.pendingFallbackModel) {
				logInfo("Ignoring session.error — fallback replay became pending during agent resolution", {
					sessionID,
					pendingFallbackModel: stateAfterAwait.pendingFallbackModel,
					currentModel: stateAfterAwait.currentModel,
					errorName: extractErrorName(error),
				})
				return
			}

			logInfo("session.error received", {
				sessionID,
				agent,
				resolvedAgent,
				statusCode: extractStatusCode(error, config.retry_on_errors),
				errorName: extractErrorName(error),
				errorType: classifyErrorType(error),
			})

			const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns)
			
			let state = sessionStates.get(sessionID)
			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels,
				config.auto_discover ? deps.autoDiscoveredModels : undefined,
				config.auto_order
			)

			if (fallbackModels.length === 0) {
				logInfo("No fallback models configured", { sessionID, agent })
				return
			}

			// Check if we're already in a fallback chain
			const inFallbackChain = state && state.currentModel !== state.originalModel
			
			if (!isRetryable && !inFallbackChain) {
				logInfo("Error not retryable and not in fallback chain, skipping", {
					sessionID,
					retryable: false,
					inFallbackChain: false,
					statusCode: extractStatusCode(error, config.retry_on_errors),
					errorName: extractErrorName(error),
					errorType: classifyErrorType(error),
				})
				return
			}
			
			if (!isRetryable && inFallbackChain) {
				logInfo("Non-retryable error but in fallback chain, continuing to next fallback", {
					sessionID,
					retryable: false,
					inFallbackChain: true,
					currentModel: state?.currentModel,
					originalModel: state?.originalModel,
					errorName: extractErrorName(error),
				})
			}

			if (!state) {
				const currentModel = props?.model as string | undefined
				if (currentModel) {
					state = createFallbackState(currentModel)
					sessionStates.set(sessionID, state)
					sessionLastAccess.set(sessionID, Date.now())
				} else if (!errorModel && sessionRetryInFlight.has(sessionID)) {
					// No state, no model on the error, and message.updated holds the
					// retry lock — this is a stale session.error for the same failure
					// that message.updated is already handling.  Defer entirely.
					logInfo("Deferring to message.updated handler (no state, no errorModel, retry in flight)", {
						sessionID,
						errorName: extractErrorName(error),
					})
					return
				} else {
					const agentConfig =
						resolvedAgent && deps.agentConfigs
							? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
							: undefined
					const agentModel = agentConfig?.model as string | undefined
					if (agentModel) {
						logInfo("Derived model from agent config", {
							sessionID,
							agent: resolvedAgent,
							model: agentModel,
						})
						state = createFallbackState(agentModel)
						sessionStates.set(sessionID, state)
						sessionLastAccess.set(sessionID, Date.now())
					} else {
						const firstModel = findFirstAgentModel()
						if (firstModel) {
							logInfo("Using first available agent model for state creation", {
								sessionID,
								model: firstModel,
							})
							state = createFallbackState(firstModel)
							sessionStates.set(sessionID, state)
							sessionLastAccess.set(sessionID, Date.now())
						} else {
							logInfo("No model info available, cannot fallback", { sessionID })
							return
						}
					}
				}
			} else {
				sessionLastAccess.set(sessionID, Date.now())
			}

			const plan = planFallback(sessionID, state, fallbackModels, config)

			if (plan.success) {
				if (config.notify_on_fallback) {
					const modelName = plan.newModel?.split("/").pop() || plan.newModel
					const attemptInfo = `attempt ${state.attemptCount + 1} of ${fallbackModels.length}`
					deps.ctx.client.tui
						.showToast({
							body: {
								title: "Model Fallback",
								message: `Switching to ${modelName} (${attemptInfo})`,
								variant: "warning",
								duration: 5000,
							},
						})
						.catch(() => {})
				}

				await helpers.autoRetryWithFallback(
					sessionID,
					plan.newModel,
					resolvedAgent,
					"session.error",
					plan
				)
			} else {
				logError("Fallback preparation failed", {
					sessionID,
					error: plan.error,
				})
			}
		} finally {
			sessionRetryInFlight.delete(sessionID)
		}
	}

	const handleSessionCompacted = (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		const hadAwaiting = sessionAwaitingFallbackResult.has(sessionID)
		const hadCompaction = deps.sessionCompactionInFlight.has(sessionID)

		// Clear all fallback tracking state — compaction completed successfully
		sessionAwaitingFallbackResult.delete(sessionID)
		sessionRetryInFlight.delete(sessionID)
		deps.sessionFirstTokenReceived.delete(sessionID)
		deps.sessionCompactionInFlight.delete(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)

		if (hadAwaiting || hadCompaction) {
			logInfo("Compaction completed, clearing fallback state", { sessionID })
		}
	}

	function findFirstAgentModel(): string | undefined {
		if (!deps.agentConfigs) return undefined
		for (const agentName of Object.keys(deps.agentConfigs)) {
			const agentConfig = deps.agentConfigs[agentName] as
				| Record<string, unknown>
				| undefined
			const model = agentConfig?.model as string | undefined
			if (model) return model
		}
		return undefined
	}

	// Called from handleSessionStatus which already holds the sessionRetryInFlight lock.
	// Does NOT acquire/release the lock itself.
	async function triggerImmediateFallback(
		sessionID: string,
		resolvedAgent: string | undefined,
		fallbackModels: string[],
		status: { type?: string; attempt?: number; message?: string; next?: number }
	): Promise<void> {
		// Create state if needed
		let state = sessionStates.get(sessionID)
		if (!state) {
			const agentConfig =
				resolvedAgent && deps.agentConfigs
					? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
					: undefined
			const initialModel = (agentConfig?.model as string | undefined) ?? findFirstAgentModel()
			if (!initialModel) {
				logError("Cannot trigger immediate fallback - no model info", { sessionID })
				return
			}
			state = createFallbackState(initialModel)
			sessionStates.set(sessionID, state)
			sessionLastAccess.set(sessionID, Date.now())
		} else {
			sessionLastAccess.set(sessionID, Date.now())
		}

		sessionAwaitingFallbackResult.delete(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)

		const plan = planFallback(sessionID, state, fallbackModels, config)

		if (plan.success) {
			if (config.notify_on_fallback) {
				const modelName = plan.newModel?.split("/").pop() || plan.newModel
				deps.ctx.client.tui
					.showToast({
						body: {
							title: "Provider Retry Too Slow - Switching Model",
							variant: "warning",
							duration: 5000,
							message: `${status.message || "Provider retrying"} -> ${modelName} (immediate fallback)`,
						},
					})
					.catch(() => {})
			}

			await helpers.autoRetryWithFallback(
				sessionID,
				plan.newModel,
				resolvedAgent,
				"session.status.immediate",
				plan
			)
		} else if (!plan.success) {
			logError("Immediate fallback preparation failed", {
				sessionID,
				error: plan.error,
			})
			if (plan.maxAttemptsReached && config.notify_on_fallback) {
				await deps.ctx.client.tui
					.showToast({
						body: {
							title: "All Fallbacks Exhausted",
							variant: "error",
							duration: 8000,
							message: `All ${fallbackModels.length} fallback models exhausted`,
						},
					})
					.catch(() => {})
			}
		}
	}

	return {
		handleEvent: async ({ event }: { event: { type: string; properties?: unknown } }) => {
			if (!config.enabled) return

			const props = event.properties as Record<string, unknown> | undefined

			if (event.type === "session.created") {
				handleSessionCreated(props)
				return
			}
			if (event.type === "session.deleted") {
				handleSessionDeleted(props)
				return
			}
			if (event.type === "session.stop") {
				await handleSessionStop(props)
				return
			}
			if (event.type === "session.idle") {
				await handleSessionIdle(props)
				return
			}
			if (event.type === "session.error") {
				await handleSessionError(props)
				return
			}
			if (event.type === "session.status") {
				await handleSessionStatus(props)
				return
			}
			if (event.type === "session.compacted") {
				handleSessionCompacted(props)
				return
			}
		},
		handleActivity,
	}
}

// ─── message-update-handler.ts ───
export function hasVisibleAssistantResponse(
	extractAutoRetrySignalFn: typeof extractAutoRetrySignal
) {
	return async (
		ctx: HookDeps["ctx"],
		sessionID: string,
		_info: Record<string, unknown> | undefined
	): Promise<boolean> => {
		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})

			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) return false

			const lastAssistant = [...msgs]
				.reverse()
				.find((m) => m.info?.role === "assistant")
			if (!lastAssistant) return false
			if (lastAssistant.info?.error) return false

			const parts =
				lastAssistant.parts ??
				(lastAssistant.info?.parts as
					| Array<{ type?: string; text?: string; name?: string }>
					| undefined)

			const hasToolCall = (parts ?? []).some((p) => p.type === "tool_call")
			
			const textFromParts = (parts ?? [])
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text!.trim())
				.filter((text) => text.length > 0)
				.join("\n")

			// If the model made a tool call, it's an active valid response regardless of text
			if (hasToolCall) return true

			if (!textFromParts) return false
			if (extractAutoRetrySignalFn({ message: textFromParts })) return false

			return true
		} catch {
			return false
		}
	}
}

async function checkLastAssistantForErrorContent(
	ctx: HookDeps["ctx"],
	sessionID: string
): Promise<string | undefined> {
	try {
		const messagesResp = await ctx.client.session.messages({
			path: { id: sessionID },
			query: { directory: ctx.directory },
		})

		const msgs = messagesResp.data
		if (!msgs || msgs.length === 0) return undefined

		const lastAssistant = [...msgs]
			.reverse()
			.find((m) => m.info?.role === "assistant")
		if (!lastAssistant) return undefined

		const parts =
			lastAssistant.parts ??
			(lastAssistant.info?.parts as
				| Array<{ type?: string; text?: string }>
				| undefined)

		const result = extractErrorContentFromParts(parts)
		if (result.hasError) return result.errorMessage

		const textResult = detectErrorInTextParts(parts)
		if (textResult.hasError) return textResult.errorMessage

		return undefined
	} catch {
		return undefined
	}
}

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
	} = deps
	const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)

	return async (props: Record<string, unknown> | undefined) => {
		const info = props?.info as Record<string, unknown> | undefined
		const sessionID = info?.sessionID as string | undefined
		const retrySignalResult = extractAutoRetrySignal(info)
		const retrySignal = retrySignalResult?.signal
		const timeoutEnabled = config.timeout_seconds > 0
		const parts = props?.parts as
			| Array<{ type?: string; text?: string }>
			| undefined
		const errorContentResult = containsErrorContent(parts)
		let error =
			info?.error ??
			(retrySignal && timeoutEnabled
				? { name: "ProviderRateLimitError", message: retrySignal }
				: undefined) ??
			(errorContentResult.hasError
				? {
						name: "MessageContentError",
						message:
							errorContentResult.errorMessage ||
							"Message contains error content",
					}
				: undefined)
		const role = info?.role as string | undefined
		const model =
			(info?.model as string | undefined) ??
			(typeof info?.providerID === "string" && typeof info?.modelID === "string"
				? `${info.providerID}/${info.modelID}`
				: undefined)

		if (sessionID && role === "assistant") {
			// Track last message activity — used by subagent-sync to detect
			// that the child session is still alive and reset its timeout.
			deps.sessionLastMessageTime.set(sessionID, Date.now())

			logInfo("message.updated received", {
				sessionID,
				model,
				hasInfoError: !!info?.error,
				errorType: info?.error ? classifyErrorType(info.error) : undefined,
			})
		}

		if (sessionID && role === "assistant" && !error) {
			const errorContent = await checkLastAssistantForErrorContent(ctx, sessionID)
			if (errorContent) {
				logInfo("Detected error content in message parts", {
					sessionID,
					errorContent: errorContent.slice(0, 200),
				})
				error = { name: "ContentError", message: errorContent }
			}
		}

		if (sessionID && role === "assistant" && !error) {
			if (!sessionAwaitingFallbackResult.has(sessionID)) {
				// ── PRIMARY MODEL TTFT TIMEOUT ──
				// Schedule a TTFT timeout when we see the first message.updated for
				// a session that hasn't received a first token yet and doesn't
				// already have a timeout running.  This covers two scenarios:
				//   (a) Brand new session (no state yet) — create state and schedule
				//   (b) Manual model change — chat-message-handler created fresh
				//       state but didn't schedule a timeout.
				//
				// The key invariant: if timeout is enabled, first token not received,
				// and no timeout is running, we must schedule one.
				const needsTimeout =
					model &&
					config.timeout_seconds > 0 &&
					!deps.sessionFirstTokenReceived.get(sessionID) &&
					!deps.sessionFallbackTimeouts.has(sessionID)

				if (needsTimeout) {
					// Create state if this is a brand new session
					if (!sessionStates.has(sessionID)) {
						const state = createFallbackState(model)
						sessionStates.set(sessionID, state)
						sessionLastAccess.set(sessionID, Date.now())
					}

					// Resolve agent asynchronously for timeout handler
					const agent = info?.agent as string | undefined
					helpers.resolveAgentForSessionFromContext(sessionID, agent)
						.then((resolvedAgent) => {
							const fallbackModels = getFallbackModelsForSession(
								sessionID,
								resolvedAgent,
								deps.agentConfigs,
								deps.globalFallbackModels,
								config.auto_discover ? deps.autoDiscoveredModels : undefined,
								config.auto_order
							)
							if (fallbackModels.length > 0) {
								helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
								logInfo("Scheduled primary model TTFT timeout", {
									sessionID,
									model,
									timeoutSeconds: config.timeout_seconds,
								})
							}
							// Per-session "I'm here + next model" message.
							// Fires once per session when the session is first
							// armed (model known, chain resolved).
							if (config.notify_on_ready) {
								showReadyToast(
									ctx,
									"Fallback Armed",
									buildArmedMessage(model!, fallbackModels)
								)
							}
						})
						.catch(() => {})
			} else if (sessionStates.has(sessionID)) {
				// Subsequent successful message.updated — model *may* be active.
				// The timeout's purpose is to detect models that go completely
				// silent (hung/dead).  We only mark first token received when
				// actual content is present — OpenCode sends an initial
				// message.updated when it *creates* the assistant message slot
				// (before any tokens arrive) and we must not treat that empty
				// frame as proof the model is streaming.
				const eventHasContent = parts?.some(
					(p) =>
						(p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
						p.type === "tool_call" ||
						p.type === "tool"
				)
				if (eventHasContent) {
					deps.sessionFirstTokenReceived.set(sessionID, true)
				}
				// Reschedule the timeout — resets the clock on every activity
				// (even empty frames, since the server is still processing).
				// If a timeout was scheduled but model is streaming, this
				// prevents the false-abort that occurred when the model was
				// actively producing tokens but firstTokenReceived was never set.
				if (deps.sessionFallbackTimeouts.has(sessionID)) {
					const agent = info?.agent as string | undefined
					helpers.resolveAgentForSessionFromContext(sessionID, agent)
						.then((resolvedAgent) => {
							helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						})
						.catch(() => {})
				}
			}
				return
			}

			// Check whether actual text content has arrived.  OpenCode sends an
			// initial message.updated when it *creates* the assistant message
			// slot — before any tokens arrive.  We must NOT mark TTFT as
			// received for that empty frame; otherwise the timeout handler
			// skips the abort and the session gets stuck forever.
			const hasVisible = await checkVisibleResponse(ctx, sessionID, info)
			if (!hasVisible) {
				// Also check the event's own parts for any text content or tool calls.
				// If the event parts have text/tools, the model is streaming even
				// though the full-message fetch didn't find a complete response.
				const eventHasActivity = parts?.some(
					(p) => 
						(p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
						p.type === "tool_call"
				)
				if (eventHasActivity) {
					deps.sessionFirstTokenReceived.set(sessionID, true)
				}
				logError(
					"Assistant update observed without visible final response; keeping fallback timeout",
					{ sessionID, model, firstTokenReceived: deps.sessionFirstTokenReceived.get(sessionID) ?? false }
				)
				return
			}

			// Full visible response confirmed — model produced real content
			deps.sessionFirstTokenReceived.set(sessionID, true)

			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			logInfo("Assistant response observed; cleared fallback timeout", {
				sessionID,
				model,
			})
			return
		}

		if (sessionID && role === "assistant" && error) {
			// ── COMPACTION IN-FLIGHT GUARD ──
			// Compaction via session.command produces no message.updated events.
			// Any error arriving while compaction is running is from the
			// pre-compaction model (stale) — suppress it entirely.
			if (deps.sessionCompactionInFlight.has(sessionID)) {
				logInfo("Ignoring message.updated error during compaction in-flight", {
					sessionID,
					model,
					errorName: extractErrorName(error),
				})
				return
			}

			// Ignore stale errors from models we already moved past.
			// Exception: compaction errors are NOT stale — they represent a
			// new compaction attempt that OpenCode dispatched on the session's
			// bound model (which may already be in failedModels).  These must
			// be handled so we can re-dispatch compaction on the current
			// fallback model.
			const currentState = sessionStates.get(sessionID)
			const eventAgent = (info?.agent as string | undefined)?.trim().toLowerCase()
			const isCompactionError = eventAgent === "compaction"

			if (currentState && model && model !== currentState.currentModel) {
				if (isCompactionError) {
					// Compaction error from a model we already moved past.
					// Don't resync state — instead let it fall through so
					// autoRetryWithFallback dispatches compaction on the
					// current fallback model.
					logInfo("Compaction error on failed model — will retry on current fallback", {
						sessionID,
						failedModel: model,
						currentModel: currentState.currentModel,
						errorName: extractErrorName(error),
					})
				} else {
					// If the error model is already in failedModels, this is a stale
					// echo from a model that already failed and was replaced.  Never
					// resync back to a model we already moved away from — that creates
					// an infinite loop: stale error → resync → plan fallback → replay
					// → stale error from the same model → resync again.
					const isAlreadyFailed = currentState.failedModels.has(model)

					const retryableStaleError = isRetryableError(
						error,
						config.retry_on_errors,
						config.retryable_error_patterns
					)
					const canResyncToErrorModel =
						retryableStaleError &&
						!isAlreadyFailed &&
						!currentState.pendingFallbackModel &&
						!sessionAwaitingFallbackResult.has(sessionID)

					if (canResyncToErrorModel) {
						logInfo("Resyncing state to error model before fallback planning", {
							sessionID,
							previousModel: currentState.currentModel,
							errorModel: model,
							errorName: extractErrorName(error),
						})
						currentState.currentModel = model
						sessionLastAccess.set(sessionID, Date.now())
					} else {
						logInfo("Ignoring stale error from previous model", {
							sessionID,
							staleModel: model,
							currentModel: currentState.currentModel,
							errorName: extractErrorName(error),
							isAlreadyFailed,
						})
						return
					}
				}
			}

			// Safety net: if this is a MessageAbortedError and we recently
			// called session.abort() ourselves (within 2s window), this is a
			// self-inflicted abort from the fallback transition.  Ignore it —
			// the timeout handler (or whichever handler initiated the abort) is
			// already dispatching the fallback.
			//
			// We intentionally do NOT require sessionAwaitingFallbackResult to
			// be set: there is a micro-window between when the abort API call
			// returns and when the dispatching handler gets to set the awaiting
			// flag.  The MessageAbortedError event can arrive in that gap.
			const SELF_ABORT_WINDOW_MS = 2000
			const errorName = extractErrorName(error)
			const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
			if (
				errorName === "MessageAbortedError" &&
				selfAbortTs &&
				Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS
			) {
				logInfo("Ignoring self-inflicted MessageAbortedError (abort initiated by plugin)", {
					sessionID,
					model,
					msSinceAbort: Date.now() - selfAbortTs,
					awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
					retryInFlight: sessionRetryInFlight.has(sessionID),
				})
				return
			}
			
			sessionAwaitingFallbackResult.delete(sessionID)

			// ── EARLY LOCK ACQUISITION ──
			// Acquire the retry lock BEFORE any async work to prevent
			// session.error from interleaving via microtask scheduling.
			// Both message.updated and session.error fire for the same
			// original error; only one should advance the fallback state.
			if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
				logInfo("message.updated fallback skipped (retry in flight)", {
					sessionID,
				})
				return
			}

			if (
				retrySignal &&
				sessionRetryInFlight.has(sessionID) &&
				timeoutEnabled
			) {
				logError(
					"Overriding in-flight retry due to provider auto-retry signal",
					{ sessionID, model }
				)
				await helpers.abortSessionRequest(
					sessionID,
					"message.updated.retry-signal"
				)
				sessionRetryInFlight.delete(sessionID)
			}

			// Acquire the lock now — before any async calls that could yield
			// and allow session.error to interleave.
			deps.sessionRetryInFlight.add(sessionID)

			try {
				if (retrySignal && timeoutEnabled) {
					logInfo("Detected provider auto-retry signal", { sessionID, model })
				}

				if (!retrySignal) {
					helpers.clearSessionFallbackTimeout(sessionID)
				}

				logInfo("message.updated with assistant error", {
					sessionID,
					model,
					statusCode: extractStatusCode(error, config.retry_on_errors),
					errorName: extractErrorName(error),
					errorType: classifyErrorType(error),
				})

				let state = sessionStates.get(sessionID)
				const agent = info?.agent as string | undefined
				const resolvedAgent =
					await helpers.resolveAgentForSessionFromContext(sessionID, agent)

				// Set compaction-in-flight IMMEDIATELY after detecting the agent,
				// before any further async work.  session.error runs concurrently
				// and checks this flag at its compaction guard — if we don't set
				// it here (synchronously after the first await), session.error
				// slips past the guard and double-advances the fallback chain.
				if (resolvedAgent === "compaction") {
					deps.sessionCompactionInFlight.add(sessionID)
				}

				// ── COMPACTION ON ALREADY-FAILED MODEL ──
				// When a compaction error arrives from a model we already moved
				// past (e.g. OpenCode's processCompaction used the session's
				// bound model which is in failedModels), don't plan a new
				// fallback step — just re-dispatch compaction on the current
				// fallback model.  This must run BEFORE the fallback-models
				// lookup because the user may not have configured fallback_models
				// for the "compaction" agent specifically.
				if (
					isCompactionError &&
					state &&
					state.currentModel !== model &&
					state.currentModel !== state.originalModel
				) {
					logInfo("Compaction failed on stale model — re-dispatching on current fallback", {
						sessionID,
						failedModel: model,
						currentFallbackModel: state.currentModel,
					})

					deps.sessionCompactionInFlight.add(sessionID)

					if (config.notify_on_fallback) {
						const fromName = (model || "primary").split("/").pop()!
						const toName = state.currentModel.split("/").pop() || state.currentModel
						deps.ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Fallback",
									message: `${fromName} failed — retrying compaction on ${toName}`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					await helpers.autoRetryWithFallback(
						sessionID,
						state.currentModel,
						"compaction",
						"message.updated.compaction-stale",
						undefined
					)
					return
				}

				const fallbackModels = getFallbackModelsForSession(
					sessionID,
					resolvedAgent,
					deps.agentConfigs,
					deps.globalFallbackModels,
					config.auto_discover ? deps.autoDiscoveredModels : undefined,
					config.auto_order
				)

				if (fallbackModels.length === 0) {
					return
				}

				// Prevent duplicate triggers for the same failure
				if (state && state.pendingFallbackModel && model !== state.pendingFallbackModel) {
					logInfo("Skipping duplicate fallback trigger (already in progress for different model)", {
						sessionID,
						pendingFallbackModel: state.pendingFallbackModel,
						errorModel: model
					})
					return
				}

				const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns)
				const inFallbackChain = state && state.currentModel !== state.originalModel
				
				if (!isRetryable && !inFallbackChain) {
					logError(
						"message.updated error not retryable and not in fallback chain, skipping",
						{
							sessionID,
							statusCode: extractStatusCode(error, config.retry_on_errors),
							errorName: extractErrorName(error),
							errorType: classifyErrorType(error),
						}
					)
					return
				}
				
				if (!isRetryable && inFallbackChain) {
					logInfo("message.updated non-retryable error but in fallback chain, continuing", {
						sessionID,
						currentModel: state?.currentModel,
						originalModel: state?.originalModel,
						errorName: extractErrorName(error),
					})
				}

				if (!state) {
					let initialModel = model
					if (!initialModel) {
						const agentConfig =
							resolvedAgent && deps.agentConfigs
								? (deps.agentConfigs[resolvedAgent] as
										| Record<string, unknown>
										| undefined)
								: undefined
						const agentModel = agentConfig?.model as string | undefined
						if (agentModel) {
							logError(
								"Derived model from agent config for message.updated",
								{
									sessionID,
									agent: resolvedAgent,
									model: agentModel,
								}
							)
							initialModel = agentModel
						}
					}

					if (!initialModel) {
						logError(
							"message.updated missing model info, cannot fallback",
							{
								sessionID,
								errorName: extractErrorName(error),
								errorType: classifyErrorType(error),
							}
						)
						return
					}

					state = createFallbackState(initialModel)
					sessionStates.set(sessionID, state)
					sessionLastAccess.set(sessionID, Date.now())
				} else {
					sessionLastAccess.set(sessionID, Date.now())
					
					// Handle auto-retry signals from providers
					if (state.pendingFallbackModel && retrySignal && timeoutEnabled) {
						logError(
							"Clearing pending fallback due to provider auto-retry signal",
							{
								sessionID,
								pendingFallbackModel: state.pendingFallbackModel,
							}
						)
						state.pendingFallbackModel = undefined
					}
				}

				const plan = planFallback(
					sessionID,
					state,
					fallbackModels,
					config,
				)

				if (plan.success) {
					if (config.notify_on_fallback) {
						deps.ctx.client.tui
							.showToast({
								body: {
									title: "Model Fallback",
									message: `Switching to ${plan.newModel?.split("/").pop() || plan.newModel} for next request`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					await helpers.autoRetryWithFallback(
						sessionID,
						plan.newModel,
						resolvedAgent,
						"message.updated",
						plan
					)
				}
			} finally {
				deps.sessionRetryInFlight.delete(sessionID)
			}
		}
	}
}

// ─── chat-message-handler.ts ───
export function createChatMessageHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
	} = deps

	return async (input: ChatMessageInput, output: ChatMessageOutput) => {
		if (!config.enabled) return

		const { sessionID } = input
		let state = sessionStates.get(sessionID)

		if (!state) {
			return
		}

		sessionLastAccess.set(sessionID, Date.now())

		const requestedModel = input.model
			? `${input.model.providerID}/${input.model.modelID}`
			: undefined

		// If the user explicitly requests the model they're already on (the
		// fallback), adopt it as the new primary.  Without this, the recovery
		// logic would later "recover" back to the old originalModel when its
		// cooldown expires — even though the user deliberately chose to stay
		// on the current model.  This prevents a spurious "Recovered to X"
		// notification after a manual model selection.
		//
		// IMPORTANT: This check must happen BEFORE the recovery check below.
		// Otherwise recovery fires first, resetting to originalModel, and the
		// adoption check never sees the mismatch.
		//
		// SKIP when the plugin is actively managing a fallback: when
		// sessionRetryInFlight, sessionAwaitingFallbackResult, or
		// sessionCompactionInFlight is set, the chat.message event is from
		// the plugin's own promptAsync replay — NOT a deliberate user
		// adoption.  Without this guard, the replay's chat.message resets
		// the fallback state (clears failedModels, resets fallbackIndex)
		// which breaks the fallback chain and can cause an "interrupted"
		// loop when the fallback model itself errors.
		if (
			requestedModel &&
			requestedModel === state.currentModel &&
			state.currentModel !== state.originalModel &&
			!deps.sessionCompactionInFlight.has(sessionID) &&
			!sessionRetryInFlight.has(sessionID) &&
			!sessionAwaitingFallbackResult.has(sessionID)
		) {
			logInfo("Adopting current model as new primary (user confirmed manual selection)", {
				sessionID,
				model: requestedModel,
				previousOriginal: state.originalModel,
			})
			state.originalModel = requestedModel
			state.failedModels.clear()
			state.fallbackIndex = -1
			state.attemptCount = 0
			return
		}

		// Auto-recovery: check if primary model's cooldown has expired
		if (state.currentModel !== state.originalModel) {
			if (
				!sessionRetryInFlight.has(sessionID) &&
				!sessionAwaitingFallbackResult.has(sessionID)
			) {
				const recovered = recoverToOriginal(state, config.cooldown_seconds)
				if (recovered) {
					logInfo("Recovered to primary model", {
						sessionID,
						model: state.originalModel,
					})
					if (config.notify_on_fallback) {
						const modelName = state.originalModel.split("/").pop() || state.originalModel
						ctx.client.tui
							.showToast({
								body: {
									title: "Model Recovered",
									message: `Recovered to ${modelName}`,
									variant: "info",
									duration: 3000,
								},
							})
							.catch(() => {})
					}
				}
			}
		}

		if (requestedModel && requestedModel !== state.currentModel) {
			if (
				state.pendingFallbackModel &&
				state.pendingFallbackModel === requestedModel
			) {
				state.pendingFallbackModel = undefined
				return
			}

			// If the plugin is actively managing a fallback (retry in flight
			// or awaiting result), any model mismatch is from the plugin's own
			// promptAsync replay — NOT a manual user change.  Skip entirely and
			// let commitFallback handle the state transition atomically.
			//
			// Previously this guard additionally required the requestedModel to
			// be in the fallback_models list, but that check is fragile: agent
			// resolution in the chat.message context can differ from the agent
			// used during fallback planning (e.g. compaction clears the agent),
			// causing getFallbackModelsForSession to return a different list.
			// The retry-in-flight / awaiting-result flags are authoritative.
			if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
				logInfo("Ignoring model mismatch during active fallback management", {
					sessionID,
					requestedModel,
					currentModel: state.currentModel,
					retryInFlight: sessionRetryInFlight.has(sessionID),
					awaitingResult: sessionAwaitingFallbackResult.has(sessionID),
				})
				return
			}

			logError("Detected manual model change, resetting fallback state", {
				sessionID,
				from: state.currentModel,
				to: requestedModel,
			})

			helpers.clearSessionFallbackTimeout(sessionID)
			sessionAwaitingFallbackResult.delete(sessionID)
			// Reset first-token tracking so the new model gets a fresh TTFT window.
			// Without this, the new model inherits firstTokenReceived=true from the
			// old model and TTFT is never scheduled.
			deps.sessionFirstTokenReceived.delete(sessionID)

			if (sessionRetryInFlight.has(sessionID)) {
				await helpers.abortSessionRequest(sessionID, "manual-model-change")
				sessionRetryInFlight.delete(sessionID)
			}

			state = createFallbackState(requestedModel)
			sessionStates.set(sessionID, state)
			return
		}

		if (state.currentModel === state.originalModel) return

		const activeModel = state.currentModel

		logInfo("Applying fallback model override", {
			sessionID,
			from: input.model,
			to: activeModel,
		})

		if (output.message && activeModel) {
			const parts = activeModel.split("/")
			if (parts.length >= 2) {
				output.message.model = {
					providerID: parts[0],
					modelID: parts.slice(1).join("/"),
				}
			}
		}

		// Clear compaction-in-flight at the very end, AFTER all guards
		// and the model override have been applied.  Clearing it earlier
		// would let the adoption guard (which checks !compactionInFlight)
		// reset the fallback state before the override takes effect.
		deps.sessionCompactionInFlight.delete(sessionID)
	}
}

// ─── index.ts ───
function loadPluginConfig(directory: string): Partial<FallbackPluginConfig> {
	const configPaths = [
		join(directory, ".opencode", "opencode-fallback.json"),
		join(directory, ".opencode", "opencode-fallback.jsonc"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.json"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.jsonc"),
	]

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8")
				// parseJsonc handles // comments, /* */ blocks, and trailing commas seamlessly
				return parseJsonc(content) as Partial<FallbackPluginConfig>
			} catch (err) {
				logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`, err as Record<string, unknown>)
			}
		}
	}

	return {}
}

export default async function OpenCodeFallbackPlugin(
	ctx: PluginContext,
	configOverrides?: Partial<FallbackPluginConfig>
) {
	let agentConfigs: Record<string, unknown> | undefined
	let fileConfig: Partial<FallbackPluginConfig> = loadPluginConfig(ctx.directory)
	let mergedConfig: Required<FallbackPluginConfig> | undefined
	const globalFallbackModels = normalizeFallbackModelsField(fileConfig.fallback_models)

	// Config getter that builds config on first access
	const getConfig = (): Required<FallbackPluginConfig> => {
		mergedConfig ??= {
			enabled:
				configOverrides?.enabled ??
				fileConfig?.enabled ??
				DEFAULT_CONFIG.enabled,
			retry_on_errors:
				configOverrides?.retry_on_errors ??
				fileConfig?.retry_on_errors ??
				DEFAULT_CONFIG.retry_on_errors,
			retryable_error_patterns:
				configOverrides?.retryable_error_patterns ??
				fileConfig?.retryable_error_patterns ??
				DEFAULT_CONFIG.retryable_error_patterns,
			max_fallback_attempts:
				configOverrides?.max_fallback_attempts ??
				fileConfig?.max_fallback_attempts ??
				DEFAULT_CONFIG.max_fallback_attempts,
			cooldown_seconds:
				configOverrides?.cooldown_seconds ??
				fileConfig?.cooldown_seconds ??
				DEFAULT_CONFIG.cooldown_seconds,
			timeout_seconds:
				configOverrides?.timeout_seconds ??
				fileConfig?.timeout_seconds ??
				DEFAULT_CONFIG.timeout_seconds,
			notify_on_fallback:
				configOverrides?.notify_on_fallback ??
				fileConfig?.notify_on_fallback ??
				DEFAULT_CONFIG.notify_on_fallback,
			notify_on_ready:
				configOverrides?.notify_on_ready ??
				(fileConfig as Partial<FallbackPluginConfig>)?.notify_on_ready ??
				DEFAULT_CONFIG.notify_on_ready,
			auto_order:
				configOverrides?.auto_order ??
				fileConfig?.auto_order ??
				DEFAULT_CONFIG.auto_order,
			auto_discover:
				configOverrides?.auto_discover ??
				fileConfig?.auto_discover ??
				DEFAULT_CONFIG.auto_discover,
			fallback_models:
				configOverrides?.fallback_models ??
				fileConfig?.fallback_models ??
				DEFAULT_CONFIG.fallback_models,
		}

		return mergedConfig
	}

	const deps: HookDeps = {
		ctx,
		get config() {
			return getConfig()
		},
		get agentConfigs() {
			return agentConfigs
		},
		globalFallbackModels,
		autoDiscoveredModels: [] as string[],
		sessionStates: new Map(),
		sessionLastAccess: new Map(),
		sessionRetryInFlight: new Set(),
		sessionAwaitingFallbackResult: new Set(),
		sessionFallbackTimeouts: new Map(),
		sessionFirstTokenReceived: new Map(),
		sessionSelfAbortTimestamp: new Map(),
		sessionParentID: new Map(),
		sessionIdleResolvers: new Map(),
		sessionLastMessageTime: new Map(),
		sessionCompactionInFlight: new Set(),
	}

	const helpers = createAutoRetryHelpers(deps)
	const { handleEvent: baseEventHandler, handleActivity } = createEventHandler(deps, helpers)
	const messageUpdateHandler = createMessageUpdateHandler(deps, helpers)
	const chatMessageHandler = createChatMessageHandler(deps, helpers)

	const cleanupInterval = setInterval(
		helpers.cleanupStaleSessions,
		5 * 60 * 1000
	)
	cleanupInterval.unref()

	logInfo(`Plugin initialized (${globalFallbackModels.length} global fallback model(s) configured)`)

	return {
		name: PLUGIN_NAME,

		config: (opencodeConfig: Record<string, unknown>) => {
			// Try 'agents' (plural) first, then 'agent' (singular)
			const agentsValue = opencodeConfig.agents
			const agentValue = opencodeConfig.agent
			
			if (agentsValue && typeof agentsValue === "object" && !Array.isArray(agentsValue)) {
				agentConfigs = agentsValue as Record<string, unknown>
			} else if (agentValue && typeof agentValue === "object" && !Array.isArray(agentValue)) {
				agentConfigs = agentValue as Record<string, unknown>
			} else {
				agentConfigs = undefined
			}

			// Scan every model OpenCode knows about (provider catalog +
			// agent models) and preference-order it once, so sessions with
			// no explicit fallback_models still get a sensible chain.
			try {
				const scanned = collectAvailableModels(opencodeConfig)
				const ordered = sortModelsByPreference(scanned)
				const discovered = (deps.autoDiscoveredModels ??= [])
				discovered.length = 0
				discovered.push(...ordered)
			} catch (err) {
				logInfo("Failed to scan available models for auto-discovery", err as Record<string, unknown>)
			}
			
			logInfo(`Plugin initialized with ${agentConfigs ? Object.keys(agentConfigs).length : 0} agents (${deps.autoDiscoveredModels?.length ?? 0} auto-discovered model(s))`)

			// Small "I'm here + what the next model will be" message.
			// Fires once OpenCode hands us the full config (provider catalog
			// + agents), so the preview chain is complete. Gated by
			// notify_on_ready; never throws (sync hook).
			if (getConfig().notify_on_ready) {
				showReadyToast(
					ctx,
					"Fallback Ready",
					buildStartupMessage(globalFallbackModels, deps.autoDiscoveredModels)
				)
			}
		},

		event: async ({
			event,
		}: {
			event: { type: string; properties?: unknown }
		}) => {
			if (event.type === "message.updated") {
				if (!deps.config.enabled) return
				const props = event.properties as
					| Record<string, unknown>
					| undefined
				await messageUpdateHandler(props)
				return
			}
			
			if (
				event.type === "message.part.delta" ||
				event.type === "session.diff" ||
				event.type === "message.part.updated"
			) {
				const props = event.properties as Record<string, unknown> | undefined
				const info = props?.info as Record<string, unknown> | undefined
				const sessionID =
					(props?.sessionID as string | undefined) ??
					(info?.sessionID as string | undefined) ??
					(info?.id as string | undefined)
				// Extract model from activity event so handleActivity can
				// distinguish stale activity from the failed model vs real
				// activity from the fallback model.
				const activityModel =
					(info?.model as string | undefined) ??
					(typeof info?.providerID === "string" && typeof info?.modelID === "string"
						? `${info.providerID}/${info.modelID}`
						: undefined) ??
					(props?.model as string | undefined)
				if (sessionID) {
					await handleActivity(sessionID, activityModel)
				}
			}
			
			await baseEventHandler({ event })

		},

		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: any },
			output: { title: string; output: string; metadata: any }
		) => {
			// Only intercept task tool calls with empty results
			if (input.tool !== "task" || !isEmptyTaskResult(output.output)) {
				return
			}

			const childSessionID = extractChildSessionID(output.output)
			if (!childSessionID) {
				logInfo("Empty task result but no child session ID found", {
					sessionID: input.sessionID,
					outputPreview: output.output?.substring(0, 200),
				})
				return
			}

			logInfo("Detected empty task result, waiting for child fallback", {
				parentSession: input.sessionID,
				childSession: childSessionID,
			})

			// Wait for child session fallback to complete (bounded)
			const maxWaitMs = Math.min(
				(deps.config.timeout_seconds || 120) * 1000,
				120_000,
			)
			const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
				maxWaitMs,
				pollIntervalMs: 500,
			})

			if (replacementText) {
				output.output = replacementText
				logInfo("Replaced empty task result with fallback response", {
					parentSession: input.sessionID,
					childSession: childSessionID,
					responseLength: replacementText.length,
				})
			} else {
				logInfo("No fallback response available, preserving original output", {
					parentSession: input.sessionID,
					childSession: childSessionID,
				})
			}
		},

		"chat.message": async (
			input: ChatMessageInput,
			output: ChatMessageOutput
		) => {
			await chatMessageHandler(input, output)
		},
	}
}

