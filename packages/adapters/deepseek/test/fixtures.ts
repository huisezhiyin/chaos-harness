export function sseResponse(events: readonly string[], fragmentSize?: number): Response {
  const encoded = new TextEncoder().encode(
    events.map((event) => `data: ${event}\n\n`).join(""),
  )
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (fragmentSize === undefined) {
        controller.enqueue(encoded)
      } else {
        for (let offset = 0; offset < encoded.length; offset += fragmentSize) {
          controller.enqueue(encoded.slice(offset, offset + fragmentSize))
        }
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) {
    values.push(value)
  }
  return values
}

export const usageChunk = JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
})

export const finishChunk = (reason: string): string =>
  JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: null,
  })
