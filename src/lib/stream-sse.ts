import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"

import consola from "consola"

async function encodeSSE(message: SSEMessage): Promise<Uint8Array> {
  const data = await message.data
  const dataLines = data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")
  const serialized =
    [
      message.event && `event: ${message.event}`,
      dataLines,
      message.id && `id: ${message.id}`,
      message.retry && `retry: ${message.retry}`,
    ]
      .filter(Boolean)
      .join("\n") + "\n\n"

  return new TextEncoder().encode(serialized)
}

export function streamSSE(
  c: Context,
  source: AsyncIterable<SSEMessage>,
): Response {
  const iterator = source[Symbol.asyncIterator]()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
          return
        }

        controller.enqueue(await encodeSSE(next.value))
      } catch (error) {
        consola.error("Streaming response failed:", error)
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })

  c.header("Transfer-Encoding", "chunked")
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache")
  c.header("Connection", "keep-alive")
  return c.newResponse(body)
}
