import { test, expect, mock } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import { handleCompletion } from "../src/routes/chat-completions/handler"

// The agent runtimes this proxy serves send max_completion_tokens, the modern OpenAI spelling of
// the output limit. Upstream refuses a request that carries both spellings with
// "max_tokens and max_completion_tokens cannot both be set", so the default-injection must treat
// either field as the caller having expressed a limit.

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  data: [
    {
      id: "test-model",
      capabilities: { limits: { max_output_tokens: 64000 } },
    },
  ],
} as unknown as typeof state.models

const sent: Array<Record<string, unknown>> = []
const fetchMock = mock((_url: string, opts: { body?: string }) => {
  sent.push(JSON.parse(opts.body ?? "{}") as Record<string, unknown>)
  return {
    ok: true,
    json: () => ({ id: "1", object: "chat.completion", choices: [] }),
    headers: new Headers({ "content-type": "application/json" }),
  }
})
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

const app = new Hono().post("/chat/completions", handleCompletion)

async function send(payload: Record<string, unknown>) {
  sent.length = 0
  await app.request("/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  return sent.at(0) ?? {}
}

test("max_completion_tokens is not joined by an injected max_tokens", async () => {
  const forwarded = await send({
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 16,
  })
  expect(forwarded.max_completion_tokens).toBe(16)
  expect("max_tokens" in forwarded).toBe(false)
})

test("a caller that supplies neither limit still gets the model default", async () => {
  const forwarded = await send({
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  })
  expect(forwarded.max_tokens).toBe(64000)
  expect("max_completion_tokens" in forwarded).toBe(false)
})

test("an explicit max_tokens is preserved", async () => {
  const forwarded = await send({
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 32,
  })
  expect(forwarded.max_tokens).toBe(32)
})
