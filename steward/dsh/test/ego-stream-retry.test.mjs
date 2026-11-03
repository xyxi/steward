// Exercise the robot bundle's retry policy through the shipped CLI and owned HTTP endpoints.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { launchProfile } from './profile-test.mjs'

const cliPackage = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const { parse } = createRequire(cliPackage)('yaml')
const cli = join(dirname(cliPackage), 'lib/bin.js')
const bundle = resolve(import.meta.dirname, '../packages/dsh-bundle-ego')

function response(tool, complete) {
  const block = tool ? { type: 'tool_use', id: `call-${tool}`, name: 'ego_rgb_recording_start', input: {} }
    : { type: 'text', text: '' }
  const events = [
    { type: 'message_start', message: { id: 'msg-test', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ fps: 2, max_frames: 3, request_key: tool }) }
      : { type: 'text_delta', text: 'Recovered.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
    ...complete ? [{ type: 'message_stop' }] : [],
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

for (const exhausted of [false, true]) test(exhausted
  ? 'robot stops after five model retries when every response lacks message_stop'
  : 'robot recovers from SERVER then STREAM_CLOSED without replaying completed tools', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'steward-stream-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const requests = [], egoCalls = [], failures = []
  const server = createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      if (req.url === '/ego/rgb/record/start') {
        egoCalls.push(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ recording_id: 'rgb_' + 'c'.repeat(32), status: 'recording' }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/messages')) throw new Error(`Unexpected ${req.method} ${req.url}`)
      requests.push(JSON.parse(body))
      if (!exhausted && requests.length === 2) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Fixture overload' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(exhausted || requests.length === 3 ? response('must-not-execute', false)
        : requests.length === 1 ? response('stream-start-001', true) : response(undefined, true))
    } catch (error) {
      failures.push(error)
      res.writeHead(500); res.end('Fixture failure')
    }
  })
  server.listen(0, '127.0.0.1')
  t.after(async () => {
    const closed = new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()))
    server.closeAllConnections()
    await closed
  })
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const cwd = join(root, 'workspace'); await mkdir(cwd)
  const env = { ...process.env, DSH_HOME: join(root, 'home'), STEWARD_TEST_API_KEY: 'mock-key' }
  delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL
  await launchProfile(['--profile', 'ego', '--from-default-profile', 'headless', '--dump-default-config'], cwd, env)
  await launchProfile(['plugin', '--profile', 'ego', 'add', bundle], cwd, env)
  const composed = parse(await launchProfile(['--profile', 'ego', '--dump-config'], cwd, env), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const provider = composed.find(row => row.id === 'llm-deepseek')
  assert.equal(provider.config.retryPolicy.maxRetries, 5)
  assert.equal(provider.config.retryPolicy.mode, 'normal')
  assert.ok(provider.config.retryPolicy.retryableCodes.includes('STREAM_CLOSED'))
  const patch = [
    { id: 'llm-deepseek', config: { ...provider.config, baseURL: endpoint, apiKeyEnv: 'STEWARD_TEST_API_KEY',
      models: [{ id: 'mock-model', contextWindow: 128000 }], maxTokens: 1000, thinking: 'disabled' } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'mock-model' } },
    { id: 'steward-ego-runtime', config: { endpoint, timeoutMs: 5000 } },
    { id: 'session-persistence-jsonl', config: { root: './sessions', compression: 'none' } },
    { id: 'session-log-deepseek', config: { enabled: false } },
  ]
  const patchPath = join(root, 'patch.json'); await writeFile(patchPath, JSON.stringify(patch))
  const child = spawn(process.execPath, [cli, '--profile', 'ego', '--patch', patchPath, '--json',
    'Synthetic fixture: start one middle RGB recording, then report completion.'],
  { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok) })
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 120000)
  let code
  try { code = await closed } finally { clearTimeout(timer) }
  assert.equal(timedOut, false, stderr)
  assert.deepEqual(failures, [])
  assert.equal(requests.length, exhausted ? 6 : 4, stderr + stdout)
  assert.equal(code, exhausted ? 1 : 0, stderr + stdout)
  assert.deepEqual(egoCalls, exhausted ? [] : [{ fps: 2, max_frames: 3, request_key: 'stream-start-001' }])
  if (!exhausted) {
    assert.deepEqual(requests[1], requests[2])
    assert.deepEqual(requests[2], requests[3])
  }
  const logs = await readdir(join(cwd, 'sessions'), { recursive: true })
  const log = logs.find(path => path.endsWith('session.v4.jsonl')); assert.ok(log)
  const rows = (await readFile(join(cwd, 'sessions', log), 'utf8')).trim().split('\n').map(JSON.parse)
  const retries = rows.filter(row => row.type === 'llm/retry')
  assert.deepEqual(retries.map(row => row.data.failure.code), exhausted ? Array(5).fill('STREAM_CLOSED') : ['SERVER', 'STREAM_CLOSED'])
  assert.equal(rows.filter(row => row.type === 'tool/call').length, exhausted ? 0 : 1)
  assert.ok(rows.some(row => row.type === 'assistant/attempt'))
  const end = rows.findLast(row => row.type === 'turn/end')
  if (exhausted) assert.equal(end.data.reason.error.code, 'STREAM_CLOSED')
  else assert.equal(end.data.reason.kind, 'completed')
  const transcript = rows.flatMap(row => {
    if (row.type === 'tool/call') return [{ type: row.type, name: row.data.name, arguments: JSON.parse(row.data.arguments) }]
    if (row.type === 'llm/retry') return [{ type: row.type, code: row.data.failure.code }]
    if (row.type === 'turn/end') return [{ type: row.type, reason: row.data.reason.kind,
      ...row.data.reason.kind === 'error' ? { code: row.data.reason.error.code } : {} }]
    return []
  })
  const expected = join(import.meta.dirname, 'snapshots/ego-stream-retry', exhausted ? 'exhausted.expected.json' : 'recovered.expected.json')
  assert.deepEqual(transcript, JSON.parse(await readFile(expected, 'utf8')))
})
