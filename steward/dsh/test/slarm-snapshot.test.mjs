// A real headless profile executes recorded model calls against an isolated SLARM HTTP fixture.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixture } from './slarm-fixture.mjs'

const workspace = resolve(import.meta.dirname, '..')
const cliPackage = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const cli = join(dirname(cliPackage), 'lib/bin.js')
const snapshot = join(import.meta.dirname, 'snapshots/slarm')
const prompt = 'Inspect existing SLARM reconstruction rec_one with slarm_status and slarm_result. Download ALL its pointcloud and rgb_video artifacts with slarm_download. Report model calls, distinct input images, input occurrences, output views and whether all local files verified. Do not submit work, use shell/files, or print absolute paths in your final answer.'

async function launch(args, cwd, env) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => child.kill(), 180_000)
  try {
    await new Promise((ok, fail) => {
      child.once('error', fail)
      child.once('exit', code => code === 0 ? ok() : fail(new Error(`DSH exited ${code}: ${stderr}\n${stdout}`)))
    })
    return stdout
  } finally { clearTimeout(timeout) }
}

function portable(value, f) {
  if (Array.isArray(value)) return value.map(item => portable(item, f))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, f)]))
  if (typeof value !== 'string') return value
  return value.replaceAll(f.config.endpoint, '{{endpoint}}').replaceAll(f.root, '{{cwd}}')
    .replace(/\{\{cwd\}\}\\/g, '{{cwd}}/').replaceAll('\\', '/')
    .replace(/(state\/)[a-f0-9]{16}(\/)/g, '$1{{service}}$2')
}

test('SLARM headless recorded session presents verified multi-window results without a key', { timeout: 240_000 }, async t => {
  const f = await fixture(t)
  f.state.job = 'succeeded'
  const recording = process.env.SLARM_RECORD === '1'
  const env = { ...process.env, DSH_HOME: join(f.root, 'home'), DSH_SNAPSHOT_FILE: join(snapshot, 'session.v4.jsonl') }
  if (!recording) {
    assert.doesNotMatch(await readFile(env.DSH_SNAPSHOT_FILE, 'utf8'), /[A-Za-z]:\\\\|\/(?:tmp|private\/tmp)\/steward-slarm-/,
      'recorded fixtures must not retain machine-specific temporary paths')
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
  }
  await launch(['--profile', 'slarm-test', '--from-default-profile', 'headless', '--dump-default-config'], f.root, env)
  await launch(['plugin', '--profile', 'slarm-test', 'add', join(workspace, 'packages/dsh-bundle-slarm')], f.root, env)
  const patch = [
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'steward-slarm-api', config: { endpoint: f.config.endpoint, inputRoot: f.root, stateDir: 'state' } },
    { id: 'session-persistence-jsonl', config: { root: './sessions', compression: 'none' } },
    { id: 'session-log-deepseek', config: { enabled: false } },
  ]
  if (!recording) patch.push({ id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true },
    { insert: [{ id: 'llm-replay', name: pathToFileURL(createRequire(cliPackage).resolve('@deepseek-ai/dsh-llm-replay')).href, config: {
      providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', contextWindow: 128000 }] }],
    } }] })
  const patchPath = join(f.root, 'snapshot.patch.json')
  await writeFile(patchPath, JSON.stringify(patch))
  const output = await launch(['--profile', 'slarm-test', '--patch', patchPath, '--json', prompt], f.root, env)
  const events = output.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert.ok(events.some(event => event.type === 'final'), 'the recorded turn finishes')
  const results = events.filter(event => event.type === 'tool_result')
  assert.equal(results.length, 3, output)
  assert.ok(results.every(event => event.status === 'completed'))
  const normalized = results.map(event => portable(JSON.parse(event.result), f))
  assert.deepEqual(normalized.map(result => result.next_action ?? result.completed ?? result.files.length), ['slarm_result', true, 3])
  const summary = normalized[1]
  assert.equal(summary.model_calls, 2); assert.equal(summary.distinct_input_images, 15)
  assert.equal(summary.input_image_occurrences, 24); assert.equal(summary.output_images, 63)
  assert.ok(normalized[2].files.every(file => file.verified && !file.reused))
  assert.equal(f.state.postCount, 0)
  const transcript = JSON.stringify(normalized, null, 2) + '\n'
  if (recording) {
    const records = await readdir(join(f.root, 'sessions'), { recursive: true })
    const log = records.find(path => path.endsWith('session.v4.jsonl'))
    assert.ok(log, 'the profile persists a Session')
    const staging = resolve(workspace, '../var/slarm-validation/snapshot')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'session.raw.jsonl'), await readFile(join(f.root, 'sessions', log)))
    await writeFile(join(staging, 'recording.json'), JSON.stringify({ cwd: f.root, endpoint: f.config.endpoint }))
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'tools.expected.json'), transcript)
  } else assert.equal(transcript, await readFile(join(snapshot, 'tools.expected.json'), 'utf8'))
})
