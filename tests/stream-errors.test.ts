import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { fetch as undiciFetch } from "undici"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const clientFetch = undiciFetch as unknown as typeof fetch
const hostname = "127.0.0.1"
const encoder = new TextEncoder()

let fetchBeforeTest: typeof fetch
let localServer: ReturnType<typeof Bun.serve>
let stateBeforeTest: State

interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

interface StreamFailureExpectation {
  fail: () => void
  partialMarker: string
  response: Response
  terminalMarker: string
}

function completionChunk(content: string | null, finishReason: string | null) {
  return {
    id: "chatcmpl_stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { role: "assistant", content },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function sseFrame(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
}

function completeUpstreamResponse(): Response {
  const frames = [
    sseFrame(completionChunk("partial", null)),
    sseFrame(completionChunk(null, "stop")),
    sseFrame("[DONE]"),
  ]
  let index = 0

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= frames.length) {
          controller.close()
          return
        }

        const frame = frames[index]
        index += 1
        controller.enqueue(encoder.encode(frame))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function failingUpstreamResponse(): {
  fail: () => void
  response: Response
} {
  const failure = Promise.withResolvers<undefined>()
  let frameSent = false

  return {
    fail: () => failure.resolve(undefined),
    response: new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!frameSent) {
            frameSent = true
            controller.enqueue(
              encoder.encode(sseFrame(completionChunk("partial", null))),
            )
            return
          }

          await failure.promise
          controller.error(new Error("upstream stream failed"))
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  }
}

function useUpstream(response: Response): void {
  globalThis.fetch = ((input, init) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url
    if (String(url).endsWith("/chat/completions")) {
      return Promise.resolve(response)
    }
    return clientFetch(input, init)
  }) as typeof fetch
}

async function request(path: string, body: object): Promise<Response> {
  return await clientFetch(`http://${hostname}:${localServer.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function getBodyReader(response: Response): BodyReader {
  if (!response.body) {
    throw new Error("Expected a response body")
  }
  return response.body.getReader()
}

async function readToEnd(response: Response): Promise<string> {
  const reader = getBodyReader(response)
  const decoder = new TextDecoder()
  let body = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) return body + decoder.decode()
    if (next.value) body += decoder.decode(next.value, { stream: true })
  }
}

async function readUntil(
  reader: BodyReader,
  decoder: TextDecoder,
  marker: string,
): Promise<string> {
  let body = ""
  while (!body.includes(marker)) {
    const next = await reader.read()
    expect(next.done).toBe(false)
    expect(next.value).toBeDefined()
    if (next.value) body += decoder.decode(next.value, { stream: true })
  }
  return body
}

async function expectStreamFailure(
  expectation: StreamFailureExpectation,
): Promise<void> {
  const { fail, partialMarker, response, terminalMarker } = expectation
  expect(response.status).toBe(200)
  const reader = getBodyReader(response)
  const decoder = new TextDecoder()
  let partial: string
  try {
    partial = await readUntil(reader, decoder, partialMarker)
  } finally {
    fail()
  }

  let error: unknown
  let remainder = ""
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value) {
        remainder += decoder.decode(next.value, { stream: true })
      }
    }
  } catch (caught) {
    error = caught
  }

  const received = partial + remainder
  expect(received).toContain(partialMarker)
  expect(received).not.toContain("event: error")
  expect(received).not.toContain(terminalMarker)
  expect(error).toBeInstanceOf(Error)
}

beforeAll(() => {
  localServer = Bun.serve({
    hostname,
    port: 0,
    fetch: (request) => server.fetch(request),
  })
})

afterAll(async () => {
  await localServer.stop(true)
})

beforeEach(() => {
  fetchBeforeTest = globalThis.fetch
  stateBeforeTest = { ...state }
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.models = undefined
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  state.vsCodeVersion = "1.0.0"
})

afterEach(() => {
  globalThis.fetch = fetchBeforeTest
  Object.assign(state, stateBeforeTest)
})

describe("stream error propagation", () => {
  test("chat completions end with DONE and a clean body on success", async () => {
    useUpstream(completeUpstreamResponse())

    const response = await request("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(await readToEnd(response)).toContain("data: [DONE]")
  })

  test("chat completion body reads reject on a mid-stream failure", async () => {
    const upstream = failingUpstreamResponse()
    useUpstream(upstream.response)

    const response = await request("/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    })

    await expectStreamFailure({
      fail: upstream.fail,
      partialMarker: '"content":"partial"',
      response,
      terminalMarker: "data: [DONE]",
    })
  })

  test("messages end with message_stop and a clean body on success", async () => {
    useUpstream(completeUpstreamResponse())

    const response = await request("/v1/messages", {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(await readToEnd(response)).toContain("event: message_stop")
  })

  test("message body reads reject on a mid-stream failure", async () => {
    const upstream = failingUpstreamResponse()
    useUpstream(upstream.response)

    const response = await request("/v1/messages", {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    })

    await expectStreamFailure({
      fail: upstream.fail,
      partialMarker: '"type":"content_block_delta"',
      response,
      terminalMarker: "event: message_stop",
    })
  })
})
