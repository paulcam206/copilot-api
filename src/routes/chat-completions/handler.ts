import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { streamSSE } from "~/lib/stream-sse"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  // Only supply a default when the caller expressed no output limit at all. max_completion_tokens
  // is the modern spelling of the same limit, and upstream refuses a request that carries both
  // with "max_tokens and max_completion_tokens cannot both be set" -- so injecting max_tokens
  // beside a caller-supplied max_completion_tokens turns a valid request into a 400.
  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, loggedStream(response))
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

async function* loggedStream(
  response: AsyncIterable<{
    data?: string
    event?: string
    id?: string | number
    retry?: number
  }>,
): AsyncGenerator<SSEMessage> {
  for await (const chunk of response) {
    consola.debug("Streaming chunk:", JSON.stringify(chunk))
    if (chunk.data === undefined) {
      throw new Error("Upstream SSE event is missing data")
    }

    yield {
      data: chunk.data,
      event: chunk.event,
      id: chunk.id?.toString(),
      retry: chunk.retry,
    }
  }
}
