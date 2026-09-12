import { ModelProtocolError } from "../../../kernel/src/index.js"

export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let bodyFinished = false
  const cancelReader = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener("abort", cancelReader, { once: true })

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason
      }
      const { done, value } = await reader.read()
      if (done) {
        bodyFinished = true
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const boundary = findEventBoundary(buffer)
        if (boundary === undefined) {
          break
        }
        const rawEvent = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const data = parseDataLines(rawEvent)
        if (data !== undefined) {
          yield data
        }
      }
    }

    if (buffer.trim().length > 0) {
      const data = parseDataLines(buffer)
      if (data !== undefined) {
        yield data
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason
    }
    throw error
  } finally {
    signal.removeEventListener("abort", cancelReader)
    // DONE and explicit errors end parsing before EOF. Release the underlying
    // response as well as the reader lock, preserving the original parse error.
    if (!bodyFinished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function findEventBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value)
  if (match?.index === undefined) {
    return undefined
  }
  return { index: match.index, length: match[0].length }
}

function parseDataLines(rawEvent: string): string | undefined {
  const lines = rawEvent.split(/\r?\n/)
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""))
    }
  }
  if (data.length === 0) {
    return undefined
  }
  const joined = data.join("\n")
  if (joined.length === 0) {
    throw new ModelProtocolError("SSE data event must not be empty")
  }
  return joined
}
