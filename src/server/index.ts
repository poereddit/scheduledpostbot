import type {ServerResponse} from 'node:http'
import {createServer, getServerPort} from '@devvit/web/server'
import {tick} from './tick.ts'

function send(res: ServerResponse, status: number, body: unknown): void {
  // The Devvit trigger wrapper rejects responses without a Content-Length.
  const text = JSON.stringify(body)
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(text)})
  res.end(text)
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return send(res, 404, {error: 'not found'})
    if (req.url === '/internal/jobs/tick') {
      const result = await tick()
      console.log(`tick; result=${JSON.stringify(result)}`)
      return send(res, 200, result ?? {status: 'skipped'})
    }
    return send(res, 404, {error: 'not found'})
  } catch (err) {
    console.error(`server error; ${err instanceof Error ? err.stack : err}`)
    send(res, 500, {error: 'internal error'})
  }
})

server.on('error', err => console.error(`server error; ${err.stack}`))
server.listen(getServerPort())
