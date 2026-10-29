import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SlarmClient from '@steward/dsh-slarm-client'
import { slarmTools } from '@steward/dsh-tool-slarm'

const signal = () => AbortSignal.timeout(10_000)
const hash = data => createHash('sha256').update(data).digest('hex')

export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'steward-slarm-'))
  const archive = Buffer.from('PK\x03\x04fixture')
  await writeFile(join(root, 'scene.zip'), archive)
  const calls = []
  const keys = new Map()
  const state = { dataset: 'ready', job: 'running', postCount: 0, uploadCount: 0, brokenDownload: false,
    malformedPath: false, dropSubmission: false, cancelChecks: 0, metadata: null,
    capabilityError: null, holdDownload: null, submissionDataset: 'ds_one', resultDataset: 'ds_one' }
  const bytes = Buffer.from('verified pointcloud fixture')
  const makeArtifact = (n, kind) => ({ artifact_id: `art_${n}`, kind, filename: kind === 'pointcloud' ? 'points.npz' : 'video.mp4',
    media_type: 'application/octet-stream', bytes: bytes.length, sha256: hash(bytes),
    download_path: state.malformedPath ? 'http://other.invalid/secret' : `/v1/reconstructions/rec_one/artifacts/art_${n}`,
    expires_at: '2099-01-01T00:00:00Z', frame_indices: [n - 1] })
  const manifest = () => ({ schema_version: '1.0', reconstruction_id: 'rec_one', dataset_id: state.resultDataset, model: { id: 'fixture' },
    archive_sha256: hash(archive), frame_range: { start: 0, end: 21 }, frame_indices: Array.from({ length: 21 }, (_, i) => i),
    camera_ids: ['front_left', 'front', 'front_right'], coordinates: { axes: 'FLU', unit: 'm' },
    quality_status: 'ok', warnings: [], metrics: [{ value: null }],
    summary: { valid_point_count: 12, windows: [
      { context_frame_indices: [0, 5, 10, 15], target_frame_indices: Array.from({ length: 16 }, (_, i) => i) },
      { context_frame_indices: [5, 10, 15, 20], target_frame_indices: [16, 17, 18, 19, 20] },
    ] }, artifacts: [makeArtifact(1, 'pointcloud'), makeArtifact(2, 'pointcloud'), makeArtifact(3, 'rgb_video')],
    expires_at: '2099-01-01T00:00:00Z' })
  const server = createServer(async (req, res) => {
    try {
      calls.push([req.method, req.url, req.headers['idempotency-key']])
      const json = (body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.url === '/slarm/v1/capabilities') {
        if (state.capabilityError) {
          const { status, retryable, retryAfter } = state.capabilityError
          res.setHeader('Retry-After', retryAfter)
          return json({ error: { code: 'FIXTURE_ERROR', message: 'temporary', retryable } }, status)
        }
        return json({ ready: true, input_formats: ['waymo_slarm_v1'], limits: { upload_bytes: 1024 } })
      }
      if (req.url === '/slarm/v1/waymo/datasets') {
        state.uploadCount++
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const multipart = new Request('http://local/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) })
        const form = await multipart.formData()
        assert.equal(form.get('archive_sha256'), hash(archive))
        assert.equal(form.get('format'), 'waymo_slarm_v1')
        assert.deepEqual(Buffer.from(await form.get('archive').arrayBuffer()), archive)
        return json({ id: 'ds_one', status: 'validating' }, 202)
      }
      if (req.url === '/slarm/v1/datasets/ds_one') return json({ id: 'ds_one', status: state.dataset,
        scene: state.dataset === 'ready' ? { frame_count: 32 } : null, issues: [], warnings: [], expires_at: null })
      if (req.url === '/slarm/v1/reconstructions') {
        let text = ''; for await (const chunk of req) text += chunk
        const key = req.headers['idempotency-key']
        if (!keys.has(key)) { keys.set(key, text); state.postCount++ }
        assert.equal(keys.get(key), text)
        if (state.dropSubmission) { state.dropSubmission = false; req.socket.destroy(); return }
        return json({ id: 'rec_one', dataset_id: state.submissionDataset, status: state.job }, 202)
      }
      if (req.url === '/slarm/v1/reconstructions/rec_one/cancel') { state.job = 'cancelling'; return json({ id: 'rec_one', status: state.job }, 202) }
      if (req.url === '/slarm/v1/reconstructions/rec_one') {
        if (state.job === 'cancelling' && ++state.cancelChecks >= 2) state.job = 'cancelled'
        return json(state.metadata ?? { id: 'rec_one', dataset_id: 'ds_one', status: state.job,
          progress: { completed_frames: 21, total_frames: 21 }, error: null })
      }
      if (req.url === '/slarm/v1/reconstructions/rec_one/result') return json(manifest())
      if (/^\/slarm\/v1\/reconstructions\/rec_one\/artifacts\/art_[123]$/.test(req.url)) {
        if (state.holdDownload) { res.writeHead(200); res.write(bytes.subarray(0, 1)); state.holdDownload(); return }
        res.writeHead(200); res.end(state.brokenDownload ? Buffer.alloc(bytes.length) : bytes); return
      }
      json({ error: { code: 'NOT_FOUND', message: 'missing', retryable: false } }, 404)
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const contexts = []
  const config = { endpoint: `http://127.0.0.1:${server.address().port}/slarm`, inputRoot: root, stateDir: join(root, 'state'),
    pollIntervalMs: 100, retryDelayMs: 1, requestTimeoutMs: 2_000, ...options }
  const create = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(SlarmClient, config)
    const tools = Object.fromEntries(slarmTools(ctx.slarm).map(tool => [tool.name, tool]))
    return { client: ctx.slarm, ctx, call: (name, args, requestSignal = signal()) => tools[name].execute(args,
      { name, arguments: args, signal: requestSignal }) }
  }
  t.after(async () => {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  return { ...await create(), create, root, state, calls, manifest, config,
    upload: { archive_path: 'scene.zip', request_key: 'upload-test-001' },
    reconstruct: { dataset_id: 'ds_one', request_key: 'reconstruct-test-001', start: 0, end: 21,
      outputs: ['pointcloud', 'rgb_video'] } }
}
