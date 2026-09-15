// Translates between the Chat Completions dialect this project speaks
// everywhere (both /chat/completions and the Anthropic-compatible
// /v1/messages route funnel through createChatCompletions) and Copilot's
// Responses API, which is the only endpoint some models accept requests on
// (see Model["supported_endpoints"] in services/copilot/get-models.ts).
// Keeping the translation here - rather than in the routes/handlers - means
// every existing caller of createChatCompletions keeps working unchanged.

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  TextPart,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseContentPart,
  ResponseInputItem,
  ResponseMessageItem,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { RequestError } from "~/lib/error"

function rejectUnsupportedParameters(payload: ChatCompletionsPayload): void {
  const unsupported: Array<string> = []
  if (payload.stop !== undefined && payload.stop !== null) {
    unsupported.push("stop")
  }
  if (payload.frequency_penalty && payload.frequency_penalty !== 0) {
    unsupported.push("frequency_penalty")
  }
  if (payload.presence_penalty && payload.presence_penalty !== 0) {
    unsupported.push("presence_penalty")
  }
  if (payload.logit_bias && Object.keys(payload.logit_bias).length > 0) {
    unsupported.push("logit_bias")
  }
  if (payload.logprobs === true) unsupported.push("logprobs")
  if (payload.response_format) unsupported.push("response_format")
  if (payload.seed !== undefined && payload.seed !== null) {
    unsupported.push("seed")
  }
  if (payload.user !== undefined && payload.user !== null) {
    unsupported.push("user")
  }

  if (unsupported.length > 0) {
    throw new RequestError(
      `Responses-API-only models do not support Chat Completions parameter(s): ${unsupported.join(", ")}`,
    )
  }
}

export function chatPayloadToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  if (payload.n !== undefined && payload.n !== null && payload.n !== 1) {
    throw new RequestError(
      "Responses-API-only models support exactly one completion",
    )
  }
  rejectUnsupportedParameters(payload)

  const input: Array<ResponseInputItem> = []

  for (const message of payload.messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: contentToText(message.content),
      })
      continue
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      if (message.content) {
        input.push(toMessageItem(message))
      }
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
      }
      continue
    }

    input.push(toMessageItem(message))
  }

  return {
    model: payload.model,
    input,
    max_output_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream,
    tools: payload.tools?.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
    tool_choice: translateToolChoice(payload.tool_choice),
  }
}

function toMessageItem(message: Message): ResponseMessageItem {
  return {
    type: "message",
    role: message.role as ResponseMessageItem["role"],
    content: contentToParts(message.content, message.role),
  }
}

function contentToParts(
  content: Message["content"],
  role: Message["role"],
): Array<ResponseContentPart> {
  const textType: "input_text" | "output_text" =
    role === "assistant" ? "output_text" : "input_text"

  if (content === null) return []
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: textType, text: content }] : []
  }

  return content.map((part): ResponseContentPart => {
    if (part.type === "image_url") {
      return { type: "input_image", image_url: part.image_url.url }
    }
    return { type: textType, text: part.text }
  })
}

function contentToText(content: Message["content"]): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function finalFinishReason(
  hasToolCalls: boolean,
  incomplete: boolean,
): "stop" | "length" | "tool_calls" {
  if (hasToolCalls) return "tool_calls"
  if (incomplete) return "length"
  return "stop"
}

function translateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!toolChoice || typeof toolChoice === "string") return toolChoice
  return { type: "function", name: toolChoice.function.name }
}

export function responsesResultToChatCompletion(
  result: ResponsesResult,
): ChatCompletionResponse {
  if (result.status === "failed") {
    throw new Error("Copilot Responses API returned a failed response")
  }

  let content: string | null = null
  let refusal: string | null = null
  const toolCalls: Array<ToolCall> = []

  for (const item of result.output) {
    if (item.type === "message") {
      const text = item.content
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("")
      if (text) content = (content ?? "") + text
      const refusalText = item.content
        .filter((part) => part.type === "refusal")
        .map((part) => part.refusal)
        .join("")
      if (refusalText) refusal = (refusal ?? "") + refusalText
      // The upstream response is not runtime-validated and may add item types.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  const finishReason = finalFinishReason(
    toolCalls.length > 0,
    result.status === "incomplete",
  )

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(refusal && { refusal }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    ...(result.usage && {
      usage: {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
        ...(result.usage.input_tokens_details?.cached_tokens !== undefined && {
          prompt_tokens_details: {
            cached_tokens: result.usage.input_tokens_details.cached_tokens,
          },
        }),
      },
    }),
  }
}

interface StreamAccumulator {
  id: string
  created: number
  model: string
  toolCallIndexByItemId: Map<string, number>
  nextToolIndex: number
}

interface ChunkDelta {
  role?: "assistant"
  content?: string
  refusal?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: { name?: string; arguments?: string }
  }>
}

interface ChunkOptions {
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
}

function chatChunk(
  acc: StreamAccumulator,
  delta: ChunkDelta,
  options: ChunkOptions = {},
): ChatCompletionChunk {
  const { finishReason = null, usage } = options
  return {
    id: acc.id,
    object: "chat.completion.chunk",
    created: acc.created,
    model: acc.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage && { usage }),
  }
}

function translateResponseStreamEvent(
  event: ResponseStreamEvent,
  acc: StreamAccumulator,
): Array<ChatCompletionChunk> {
  if (event.type === "response.failed") {
    throw new Error("Copilot Responses API returned a failed response")
  }

  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      const { response } = event
      acc.id = response.id
      acc.created = response.created_at
      acc.model = response.model
      return event.type === "response.created" ?
          [chatChunk(acc, { role: "assistant", content: "" })]
        : []
    }
    case "response.output_text.delta": {
      return [chatChunk(acc, { content: event.delta })]
    }
    case "response.refusal.delta": {
      return [chatChunk(acc, { refusal: event.delta })]
    }
    case "response.output_item.added": {
      const { item } = event
      if (item.type !== "function_call") return []

      const index = acc.nextToolIndex
      acc.nextToolIndex += 1
      acc.toolCallIndexByItemId.set(item.id, index)
      return [
        chatChunk(acc, {
          tool_calls: [
            {
              index,
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: "" },
            },
          ],
        }),
      ]
    }
    case "response.function_call_arguments.delta": {
      const index = acc.toolCallIndexByItemId.get(event.item_id)
      if (index === undefined) return []
      return [
        chatChunk(acc, {
          tool_calls: [{ index, function: { arguments: event.delta } }],
        }),
      ]
    }
    case "response.completed":
    case "response.incomplete": {
      const { response } = event
      const finishReason = finalFinishReason(
        acc.toolCallIndexByItemId.size > 0,
        event.type === "response.incomplete",
      )
      const usage = response.usage && {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
        ...(response.usage.input_tokens_details?.cached_tokens
          !== undefined && {
          prompt_tokens_details: {
            cached_tokens: response.usage.input_tokens_details.cached_tokens,
          },
        }),
      }
      return [chatChunk(acc, {}, { finishReason, usage })]
    }
    default: {
      return []
    }
  }
}

const isTerminalResponseEvent = (type: string) =>
  type === "response.completed"
  || type === "response.incomplete"
  || type === "response.failed"

export async function* translateResponsesStream(
  source: AsyncIterable<{ data?: string; event?: string }>,
): AsyncGenerator<{ data: string }> {
  const acc: StreamAccumulator = {
    id: "resp-stream",
    created: Math.floor(Date.now() / 1000),
    model: "",
    toolCallIndexByItemId: new Map(),
    nextToolIndex: 0,
  }

  for await (const rawEvent of source) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") continue

    let parsed: ResponseStreamEvent
    try {
      parsed = JSON.parse(rawEvent.data) as ResponseStreamEvent
    } catch {
      continue
    }

    for (const chunk of translateResponseStreamEvent(parsed, acc)) {
      yield { data: JSON.stringify(chunk) }
    }

    if (isTerminalResponseEvent(parsed.type)) {
      yield { data: "[DONE]" }
    }
  }
}
