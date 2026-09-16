import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { translateResponsesStream } from "~/lib/responses-translation"

// Observed directly against api.githubcopilot.com: response.output_item.added and
// response.function_call_arguments.delta carry DIFFERENT identifiers for the same tool call.
// item.id is an opaque per-item token; the delta's item_id is a different opaque token. Only
// output_index is common to both. Correlating by item.id therefore never matched, every argument
// delta was dropped, and the runtime received a named tool call with no arguments -- which it
// correctly refused as "incomplete or malformed", failing every tool-using benchmark task.

// translateResponsesStream consumes SSE FRAMES ({ data: "<json>" }) and yields frames whose data
// is a chat-completions chunk, so the fixture must speak that interface rather than raw objects.
// eslint-disable-next-line @typescript-eslint/require-await -- an async generator is the interface
async function* events(...items: Array<unknown>) {
  for (const item of items) yield { data: JSON.stringify(item) }
}

async function collect(stream: AsyncIterable<{ data: string }>) {
  const chunks: Array<ChatCompletionChunk> = []
  for await (const frame of stream) {
    if (!frame.data || frame.data === "[DONE]") continue
    chunks.push(JSON.parse(frame.data) as ChatCompletionChunk)
  }
  return chunks
}

function assembled(chunks: Array<ChatCompletionChunk>) {
  const calls = new Map<number, { name: string; arguments: string }>()
  for (const chunk of chunks) {
    for (const call of chunk.choices[0].delta.tool_calls ?? []) {
      const slot = calls.get(call.index) ?? { name: "", arguments: "" }
      if (call.function?.name) slot.name += call.function.name
      if (call.function?.arguments) slot.arguments += call.function.arguments
      calls.set(call.index, slot)
    }
  }
  return calls
}

const created = {
  type: "response.created",
  response: { id: "resp_1", created_at: 1, model: "gpt-5.6-terra" },
}

describe("streaming tool calls", () => {
  test("argument deltas survive when the item identifiers differ", async () => {
    const chunks = await collect(
      translateResponsesStream(
        events(
          created,
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "ITEM_TOKEN_A",
              call_id: "call_1",
              type: "function_call",
              name: "apply_patch",
            },
          },
          // Upstream sends a DIFFERENT token here for the same call.
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "DELTA_TOKEN_Z",
            delta: '{"in',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "DELTA_TOKEN_Z",
            delta: 'put":',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "DELTA_TOKEN_Z",
            delta: '"note"}',
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: undefined },
          },
        ),
      ),
    )

    const calls = assembled(chunks)
    expect(calls.size).toBe(1)
    const call = calls.get(0)
    expect(call?.name).toBe("apply_patch")
    // The whole point: the arguments must arrive AND parse into the object the tool declared.
    expect(call?.arguments).toBe('{"input":"note"}')
    expect(JSON.parse(call?.arguments ?? "null")).toEqual({ input: "note" })
  })

  test("several tool calls in one response keep their own arguments", async () => {
    const chunks = await collect(
      translateResponsesStream(
        events(
          created,
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "A",
              call_id: "call_a",
              type: "function_call",
              name: "read",
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              id: "B",
              call_id: "call_b",
              type: "function_call",
              name: "write",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            item_id: "Z2",
            delta: '{"b":2}',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "Z1",
            delta: '{"a":1}',
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: undefined },
          },
        ),
      ),
    )

    const calls = assembled(chunks)
    expect(calls.get(0)).toEqual({ name: "read", arguments: '{"a":1}' })
    expect(calls.get(1)).toEqual({ name: "write", arguments: '{"b":2}' })
  })

  test("text content is not disturbed by a tool call in the same response", async () => {
    const chunks = await collect(
      translateResponsesStream(
        events(
          created,
          { type: "response.output_text.delta", delta: "thinking " },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "A",
              call_id: "call_a",
              type: "function_call",
              name: "read",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "Z",
            delta: '{"a":1}',
          },
          { type: "response.output_text.delta", delta: "done" },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: undefined },
          },
        ),
      ),
    )

    const text = chunks
      .map((chunk) => chunk.choices[0].delta.content ?? "")
      .join("")
    expect(text).toBe("thinking done")
    expect(assembled(chunks).get(0)).toEqual({
      name: "read",
      arguments: '{"a":1}',
    })
  })
})
