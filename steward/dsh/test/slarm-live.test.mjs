import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SlarmClient from '@steward/dsh-slarm-client'
import { slarmTools } from '@steward/dsh-tool-slarm'

test('live SLARM ZIP upload, cancellation, reconstruction and verified downloads', {
  skip: !process.env.SLARM_LIVE_ARCHIVE, timeout: 1_200_000,
}, async t => {
  const archive = resolve(process.env.SLARM_LIVE_ARCHIVE)
  const root = resolve(process.env.SLARM_LIVE_STATE ?? '../var/slarm-validation/live')
  const ctx = new Context()
  await ctx.plugin(SlarmClient, { endpoint: process.env.SLARM_API ?? 'http://115.120.57.9/slarm',
    inputRoot: dirname(archive), stateDir: root })
  const tools = Object.fromEntries(slarmTools(ctx.slarm).map(tool => [tool.name, tool]))
  const trace = []
  const owned = new Set()
  const call = async (name, args) => {
    const output = await tools[name].execute(args, { name, arguments: args, signal: AbortSignal.timeout(900_000) })
    trace.push({ name, args, output })
    await mkdir(root, { recursive: true })
    await writeFile(resolve(root, 'trace.json'), JSON.stringify(trace, null, 2) + '\n')
    t.diagnostic(`${name}: ${output.status ?? output.completed ?? 'ok'}`)
    return output
  }
  t.after(async () => {
    for (const id of owned) {
      const state = await ctx.slarm.status(id, 0, AbortSignal.timeout(30_000))
      if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(state.status)) await ctx.slarm.cancel(id, 20, AbortSignal.timeout(60_000))
    }
    await ctx.fiber.dispose()
  })
  const data = await call('slarm_upload', { archive_path: archive, request_key: 'live-waymo-upload-v1' })
  let ready = data
  while (ready.status === 'validating') ready = await call('slarm_dataset_status', { dataset_id: data.dataset_id, wait_seconds: 20 })
  assert.equal(ready.status, 'ready', JSON.stringify(ready))
  const options = { dataset_id: data.dataset_id, start: 0, end: 16,
    outputs: ['pointcloud', 'rgb_video', 'diagnostic_video'], evaluate: false }
  const cancellable = await call('slarm_reconstruct', { ...options, request_key: 'live-cancel-v1' })
  owned.add(cancellable.reconstruction_id)
  let cancelled = await call('slarm_cancel', { reconstruction_id: cancellable.reconstruction_id, wait_seconds: 20 })
  while (!['cancelled', 'failed', 'succeeded', 'expired'].includes(cancelled.status)) {
    cancelled = await call('slarm_status', { reconstruction_id: cancellable.reconstruction_id, wait_seconds: 20 })
  }
  assert.equal(cancelled.status, 'cancelled')
  const job = await call('slarm_reconstruct', { ...options, request_key: 'live-reconstruct-v1' })
  owned.add(job.reconstruction_id)
  let state = job
  while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(state.status)) {
    state = await call('slarm_status', { reconstruction_id: job.reconstruction_id, wait_seconds: 20 })
  }
  assert.equal(state.status, 'succeeded', JSON.stringify(state))
  const result = await call('slarm_result', { reconstruction_id: job.reconstruction_id })
  assert.equal(result.completed, true)
  assert.equal(result.model_calls, 1)
  assert.equal(result.distinct_input_images, 12)
  assert.equal(result.output_images, 48)
  const selected = result.artifacts.filter(a => ['pointcloud', 'rgb_video', 'diagnostic_video'].includes(a.kind))
  assert.ok(selected.some(a => a.kind === 'pointcloud'))
  assert.ok(selected.some(a => a.kind === 'rgb_video'))
  const downloaded = await call('slarm_download', { reconstruction_id: job.reconstruction_id, artifact_ids: selected.map(a => a.artifact_id) })
  assert.ok(downloaded.files.every(file => file.verified))
  const resumed = await call('slarm_reconstruct', { ...options, request_key: 'live-reconstruct-v1' })
  assert.equal(resumed.reconstruction_id, job.reconstruction_id)
})
