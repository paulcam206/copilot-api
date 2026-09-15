import { afterEach, describe, expect, test } from "bun:test"

import type { ModelsResponse, Model } from "~/services/copilot/get-models"

import {
  chatPayloadToResponsesPayload,
  responsesResultToChatCompletion,
  translateResponsesStream,
} from "~/lib/responses-translation"
import { state } from "~/lib/state"
import { modelRoutes } from "~/routes/models/route"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = undefined
  state.models = undefined
})

function chatPayload(
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload {
  return {
    model: "gpt-5.6-terra",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  }
}

function responsesResult(status: "completed" | "failed" = "completed") {
  return {
    id: "resp_1",
    object: "response" as const,
    created_at: 1,
    model: "gpt-5.6-terra",
    status,
    output: [],
  }
}

function model(id: string, supportedEndpoints?: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "OpenAI",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    capabilities: {
      family: "gpt",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    supported_endpoints: supportedEndpoints,
  }
}

async function* streamOf(...events: Array<object>) {
  await Promise.resolve()
  for (const event of events) {
    yield { data: JSON.stringify(event) }
  }
}

describe("Responses API translation", () => {
  test("rejects multiple choices instead of silently returning one", () => {
    expect(() => chatPayloadToResponsesPayload(chatPayload({ n: 2 }))).toThrow(
      "exactly one completion",
    )
  })

  test("rejects unsupported Chat Completions semantics", () => {
    const unsupported: Array<[string, Partial<ChatCompletionsPayload>]> = [
      ["stop", { stop: ["END"] }],
      ["frequency_penalty", { frequency_penalty: 0.5 }],
      ["presence_penalty", { presence_penalty: 0.5 }],
      ["logit_bias", { logit_bias: { "1": 1 } }],
      ["logprobs", { logprobs: true }],
      ["response_format", { response_format: { type: "json_object" } }],
      ["seed", { seed: 42 }],
      ["user", { user: "caller" }],
    ]

    for (const [name, parameter] of unsupported) {
      expect(() =>
        chatPayloadToResponsesPayload(chatPayload(parameter)),
      ).toThrow(name)
    }
  })

  test("does not turn unknown output items into malformed tool calls", () => {
    const result = {
      ...responsesResult(),
      output: [{ type: "reasoning", id: "reasoning_1" } as never],
    }

    expect(responsesResultToChatCompletion(result).choices[0]?.message).toEqual(
      {
        role: "assistant",
        content: null,
      },
    )
  })

  test("does not translate a failed response into a successful stop", () => {
    expect(() =>
      responsesResultToChatCompletion(responsesResult("failed")),
    ).toThrow("failed response")
  })

  test("preserves a non-streaming refusal", () => {
    const result = {
      ...responsesResult(),
      output: [
        {
          type: "message" as const,
          id: "message_1",
          role: "assistant" as const,
          status: "completed",
          content: [{ type: "refusal" as const, refusal: "Cannot comply" }],
        },
      ],
    }

    expect(
      responsesResultToChatCompletion(result).choices[0]?.message,
    ).toMatchObject({
      content: null,
      refusal: "Cannot comply",
    })
  })

  test("aborts a failed stream instead of emitting DONE", async () => {
    const translated = translateResponsesStream(
      streamOf({
        type: "response.failed",
        response: responsesResult("failed"),
      }),
    )
    let error: unknown
    try {
      await translated.next()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("failed response")
  })

  test("sets the Copilot vision header for translated image input", async () => {
    let requestHeaders: Headers | undefined
    globalThis.fetch = ((_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return Promise.resolve(Response.json(responsesResult()))
    }) as typeof fetch
    state.copilotToken = "copilot-token"

    await createResponses(
      chatPayloadToResponsesPayload(
        chatPayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,AA==" },
                },
              ],
            },
          ],
        }),
      ),
    )

    expect(requestHeaders?.get("copilot-vision-request")).toBe("true")
  })

  test("routes a Responses-only catalog model through /responses", async () => {
    let requestedUrl = ""
    globalThis.fetch = ((input) => {
      if (typeof input === "string") requestedUrl = input
      else if (input instanceof URL) requestedUrl = input.href
      else requestedUrl = input.url
      return Promise.resolve(Response.json(responsesResult()))
    }) as typeof fetch
    state.copilotToken = "copilot-token"
    state.models = {
      object: "list",
      data: [model("gpt-5.6-terra", ["/responses"])],
    }

    const result = await createChatCompletions(chatPayload())

    expect(requestedUrl).toEndWith("/responses")
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "gpt-5.6-terra",
    })
  })

  test("preserves cached usage and refusals in a stream", async () => {
    const translated = translateResponsesStream(
      streamOf(
        {
          type: "response.created",
          response: responsesResult(),
        },
        {
          type: "response.refusal.delta",
          item_id: "message_1",
          output_index: 0,
          delta: "Cannot comply",
        },
        {
          type: "response.completed",
          response: {
            ...responsesResult(),
            usage: {
              input_tokens: 100,
              output_tokens: 4,
              total_tokens: 104,
              input_tokens_details: { cached_tokens: 80 },
            },
          },
        },
      ),
    )
    const chunks: Array<Record<string, unknown>> = []
    for await (const event of translated) {
      if (event.data !== "[DONE]") {
        chunks.push(JSON.parse(event.data) as Record<string, unknown>)
      }
    }

    expect(chunks).toHaveLength(3)
    expect(chunks[1]).toMatchObject({
      choices: [{ delta: { refusal: "Cannot comply" } }],
    })
    expect(chunks[2]).toMatchObject({
      usage: { prompt_tokens_details: { cached_tokens: 80 } },
    })
  })
})

describe("model endpoint metadata", () => {
  test("surfaces known support and preserves unknown support as null", async () => {
    state.models = {
      object: "list",
      data: [model("responses-only", ["/responses"]), model("support-unknown")],
    } satisfies ModelsResponse

    const response = await modelRoutes.request("/")
    const body = (await response.json()) as {
      data: Array<{ id: string; supported_endpoints: Array<string> | null }>
    }

    expect(body.data).toMatchObject([
      { id: "responses-only", supported_endpoints: ["/responses"] },
      { id: "support-unknown", supported_endpoints: null },
    ])
  })
})
