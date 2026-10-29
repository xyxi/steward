import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './slarm-fixture.mjs'

test('SLARM tools upload, resume after client restart, and preserve /slarm', async t => {
  const f = await fixture(t)
  const uploaded = await f.call('slarm_upload', f.upload)
  assert.equal(uploaded.dataset_id, 'ds_one')
  const second = await f.create()
  await second.call('slarm_upload', f.upload)
  assert.equal(f.state.uploadCount, 1)
  f.state.dropSubmission = true
  const task = await f.call('slarm_reconstruct', f.reconstruct)
  await second.call('slarm_reconstruct', f.reconstruct)
  assert.equal(task.reconstruction_id, 'rec_one')
  assert.equal(f.state.postCount, 1, 'the lost response reuses its idempotency key')
  assert.ok(f.calls.every(call => call[1].startsWith('/slarm/')))
  await assert.rejects(second.call('slarm_reconstruct', { ...f.reconstruct, end: 22 }), /LOCAL_IDEMPOTENCY_CONFLICT/)
})

test('validation and frame constraints reject submission without making a POST', async t => {
  const f = await fixture(t)
  f.state.dataset = 'validating'
  await assert.rejects(f.call('slarm_reconstruct', f.reconstruct), /DATASET_NOT_READY/)
  f.state.dataset = 'ready'
  for (const extra of [{ end: 15 }, { end: 33 }, { start: 0.5 }, { outputs: [] }, { gaussian_stride: 1 }]) {
    await assert.rejects(f.call('slarm_reconstruct', { ...f.reconstruct, request_key: `invalid-${JSON.stringify(extra).length}-${Object.keys(extra)[0]}`, ...extra }))
  }
  assert.equal(f.state.postCount, 0)
  await assert.rejects(f.call('slarm_upload', { ...f.upload, archive_path: '../outside.zip' }))
})

test('progress alone is not completion; result reports actual inputs and all windows', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('slarm_status', { reconstruction_id: 'rec_one' })).next_action, 'slarm_status')
  await assert.rejects(f.call('slarm_result', { reconstruction_id: 'rec_one' }), /RESULT_NOT_READY/)
  f.state.job = 'succeeded'
  const result = await f.call('slarm_result', { reconstruction_id: 'rec_one' })
  assert.equal(result.completed, true)
  assert.equal(result.model_calls, 2)
  assert.equal(result.input_image_occurrences, 24)
  assert.equal(result.distinct_input_images, 15)
  assert.equal(result.output_images, 63)
  assert.equal(result.metrics[0].value, null)
  assert.equal(result.artifacts.filter(a => a.kind === 'pointcloud').length, 2)
  assert.match(result.interpretation, /not object counts/)
  assert.equal(JSON.parse(await readFile(result.local_result_path, 'utf8')).reconstruction_id, 'rec_one')
})

test('downloads verify hashes, reuse good files and never publish corrupt files', async t => {
  const f = await fixture(t); f.state.job = 'succeeded'
  const args = { reconstruction_id: 'rec_one', artifact_ids: ['art_1', 'art_2', 'art_3'] }
  f.state.brokenDownload = true
  await assert.rejects(f.call('slarm_download', args), /INTEGRITY_FAILURE/)
  const names = await readdir(join(f.root, 'state'), { recursive: true })
  assert.ok(!names.some(name => name.endsWith('.part') || name.endsWith('points.npz')))
  f.state.brokenDownload = false
  const downloaded = await f.call('slarm_download', args)
  assert.equal(downloaded.files.length, 3)
  assert.notEqual(downloaded.files[0].path, downloaded.files[1].path, 'same filenames in different artifacts do not collide')
  const reused = await f.call('slarm_download', args)
  assert.ok(reused.files.every(file => file.verified && file.reused))
  f.state.malformedPath = true
  await assert.rejects(f.call('slarm_download', args), /INVALID_METADATA/)
})

test('cancellation waits for cancelled and refuses unknown local ownership', async t => {
  const f = await fixture(t)
  await assert.rejects(f.call('slarm_cancel', { reconstruction_id: 'rec_one' }), /UNKNOWN_LOCAL_TASK/)
  await f.call('slarm_reconstruct', f.reconstruct)
  const pending = await f.call('slarm_cancel', { reconstruction_id: 'rec_one' })
  assert.equal(pending.status, 'cancelling')
  assert.equal(pending.cancelled, false)
  assert.equal((await f.call('slarm_status', { reconstruction_id: 'rec_one', wait_seconds: 1 })).status, 'cancelled')
})

test('aborting a wait or unloading the provider leaves remote jobs recoverable', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const waiting = f.call('slarm_status', { reconstruction_id: 'rec_one', wait_seconds: 5 }, controller.signal)
  controller.abort()
  await assert.rejects(waiting)
  const disposing = f.call('slarm_status', { reconstruction_id: 'rec_one', wait_seconds: 5 })
  const rejection = assert.rejects(disposing)
  await f.ctx.fiber.dispose(); await rejection
  assert.ok(!f.calls.some(call => call[1].endsWith('/cancel')))
  assert.equal(f.state.job, 'running')
})

test('invalid server status cannot be reported as a successful result', async t => {
  const f = await fixture(t); f.state.metadata = { id: 'rec_other', status: 'succeeded' }
  await assert.rejects(f.call('slarm_result', { reconstruction_id: 'rec_one' }), /INVALID_METADATA/)
})

test('submission and result metadata cannot silently switch the dataset', async t => {
  const f = await fixture(t)
  f.state.submissionDataset = 'ds_other'
  await assert.rejects(f.call('slarm_reconstruct', f.reconstruct), /different dataset/)
  f.state.job = 'succeeded'; f.state.resultDataset = 'ds_other'
  await assert.rejects(f.call('slarm_result', { reconstruction_id: 'rec_one' }), /Result dataset differs/)
})

test('retry budget and Retry-After do not turn permanent failures into repeated requests', async t => {
  const f = await fixture(t)
  f.state.capabilityError = { status: 429, retryable: true, retryAfter: '0' }
  await assert.rejects(f.call('slarm_capabilities', {}), error => error.code === 'FIXTURE_ERROR' && error.retryable)
  assert.equal(f.calls.length, 3)
  f.calls.length = 0
  f.state.capabilityError = { status: 422, retryable: false, retryAfter: '0' }
  await assert.rejects(f.call('slarm_capabilities', {}))
  assert.equal(f.calls.length, 1)
  f.calls.length = 0
  f.state.capabilityError = { status: 429, retryable: true, retryAfter: '60' }
  await assert.rejects(f.call('slarm_capabilities', {}), error => error.details.retry_after_ms === 60_000)
  assert.equal(f.calls.length, 1, 'do not retry earlier than the server permits')
})

test('two clients reserve the same request identity without creating two jobs', async t => {
  const f = await fixture(t)
  const second = await f.create()
  const [a, b] = await Promise.all([f.call('slarm_reconstruct', f.reconstruct), second.call('slarm_reconstruct', f.reconstruct)])
  assert.equal(a.reconstruction_id, b.reconstruction_id)
  assert.equal(f.state.postCount, 1)
})

test('aborted artifact streams close files and remove incomplete downloads', async t => {
  const f = await fixture(t); f.state.job = 'succeeded'
  const controller = new AbortController()
  let downloadStarted
  const started = new Promise(resolve => { downloadStarted = resolve })
  f.state.holdDownload = downloadStarted
  const pending = f.call('slarm_download', { reconstruction_id: 'rec_one', artifact_ids: ['art_1'] }, controller.signal)
  const rejection = assert.rejects(pending)
  await started; controller.abort(); await rejection
  const names = await readdir(join(f.root, 'state'), { recursive: true })
  assert.ok(!names.some(name => name.endsWith('.part') || name.endsWith('points.npz')))
})
