import { describe, expect, it, mock } from "bun:test"
import OpenCodeFallbackPlugin from "./index"
import {
	buildArmedMessage,
	buildStartupMessage,
	formatChainPreview,
	resolveNextModel,
	shortModelName,
} from "./auto-fallback"
import type { PluginContext } from "./types"

function createMockContext() {
	return {
		directory: "/test/dir",
		client: {
			session: {
				abort: mock(() => Promise.resolve()),
				messages: mock(() => Promise.resolve({ data: [] })),
				promptAsync: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve({ data: {} })),
				command: mock(() => Promise.resolve()),
				revert: mock(() => Promise.resolve()),
				summarize: mock(() => Promise.resolve({})),
			},
			tui: {
				showToast: mock(() => Promise.resolve()),
			},
		},
	} as unknown as PluginContext
}

const toastBodies = (ctx: PluginContext): Array<{ title: string; message: string }> =>
	(ctx.client.tui.showToast as any).mock.calls.map((call: any[]) => call[0].body)

describe("ready notify helpers", () => {
	it("shortens model names to the last segment", () => {
		expect(shortModelName("openai/gpt-5.4")).toBe("gpt-5.4")
		expect(shortModelName("claude-opus-4-6")).toBe("claude-opus-4-6")
	})

	it("previews chains with overflow count", () => {
		expect(formatChainPreview(["a/1", "b/2"])).toBe("1 → 2")
		expect(formatChainPreview(["a/1", "b/2", "c/3", "d/4"])).toBe("1 → 2 → 3 (+1 more)")
	})

	it("resolves the next model skipping the current one", () => {
		expect(resolveNextModel("a/x", ["a/x", "b/y"])).toBe("b/y")
		expect(resolveNextModel("a/x", ["a/x"])).toBeUndefined()
		expect(resolveNextModel("a/x", [])).toBeUndefined()
	})

	it("builds a startup message naming the next model", () => {
		const msg = buildStartupMessage([], ["anthropic/claude-opus-4-6", "openai/gpt-5.4"])
		expect(msg).toContain("claude-opus-4-6")
		expect(buildStartupMessage([], [])).toContain("no fallback")
	})

	it("builds an armed message with current + next model", () => {
		const msg = buildArmedMessage("anthropic/claude-opus-4-6", [
			"anthropic/claude-opus-4-6",
			"openai/gpt-5.4",
		])
		expect(msg).toContain("claude-opus-4-6")
		expect(msg).toContain("gpt-5.4")
		expect(buildArmedMessage("a/x", ["a/x"])).toContain("no fallback")
	})
})

describe("ready notify toasts", () => {
	it("shows a Fallback Ready toast on config with the next model", async () => {
		const ctx = createMockContext()
		const plugin: any = await OpenCodeFallbackPlugin(ctx)
		plugin.config({
			agents: {
				coder: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-5.4"],
				},
			},
		})

		const bodies = toastBodies(ctx)
		const ready = bodies.find((b) => b.title === "Fallback Ready")
		expect(ready).toBeDefined()
		expect(ready!.message).toContain("gpt-5.4")
	})

	it("shows a Fallback Armed toast on first session activity with the next model", async () => {
		const ctx = createMockContext()
		const plugin: any = await OpenCodeFallbackPlugin(ctx)
		plugin.config({
			agents: {
				coder: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-5.4"],
				},
			},
		})
		;(ctx.client.tui.showToast as any).mockClear()

		await plugin.event({
			event: {
				type: "message.updated",
				properties: {
					info: {
						sessionID: "ses-ready-test",
						role: "assistant",
						agent: "coder",
						providerID: "anthropic",
						modelID: "claude-opus-4-6",
					},
				},
			},
		})
		// Armed toast fires from an async agent-resolution continuation
		await new Promise((resolve) => setTimeout(resolve, 20))

		const bodies = toastBodies(ctx)
		const armed = bodies.find((b) => b.title === "Fallback Armed")
		expect(armed).toBeDefined()
		expect(armed!.message).toContain("claude-opus-4-6")
		expect(armed!.message).toContain("gpt-5.4")
	})

	it("shows no ready toasts when notify_on_ready is false", async () => {
		const ctx = createMockContext()
		const plugin: any = await OpenCodeFallbackPlugin(ctx, { notify_on_ready: false })
		plugin.config({
			agents: {
				coder: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-5.4"],
				},
			},
		})

		expect(toastBodies(ctx)).toHaveLength(0)

		await plugin.event({
			event: {
				type: "message.updated",
				properties: {
					info: {
						sessionID: "ses-ready-off",
						role: "assistant",
						agent: "coder",
						providerID: "anthropic",
						modelID: "claude-opus-4-6",
					},
				},
			},
		})
		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(toastBodies(ctx)).toHaveLength(0)
	})
})
