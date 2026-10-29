/** SLARM HTTP provider with bounded metadata, durable POST identities and verified downloads. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { openAsBlob, realpathSync } from 'node:fs'
import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { SlarmService, SlarmError, datasetId, reconstructionId, outputKinds,
  type DatasetId, type ReconstructionId, type ArtifactId, type UploadRequest, type ReconstructionRequest,
  type Json, type JsonObject } from '@steward/dsh-slarm'
import * as protocol from './protocol.ts'
import { digest, fileDigest, hasCode, load, reserve, save } from './storage.ts'

/** Deployment settings; relative directories resolve against the DSH invocation directory. */
export interface Config {
  endpoint: string
  inputRoot: string
  stateDir: string
  requestTimeoutMs: number
  uploadTimeoutMs: number
  downloadTimeoutMs: number
  pollIntervalMs: number
  maxWaitSeconds: number
  retryCount: number
  retryDelayMs: number
  maxRetryDelayMs: number
  maxMetadataBytes: number
  maxUploadBytes: number
  maxArtifactBytes: number
}

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired'])
const datasetFields = ['id', 'status', 'format', 'archive_sha256', 'scene', 'issues', 'warnings', 'expires_at']
const jobFields = ['id', 'dataset_id', 'status', 'queue_position', 'progress', 'error', 'request', 'model',
  'cancel_requested', 'created_at', 'started_at', 'finished_at', 'result_expires_at']

/** HTTP-backed SLARM service. Plugin disposal stops local I/O; accepted remote jobs remain recoverable. */
export class SlarmClient extends SlarmService {
  static Config = schema.object({
    endpoint: schema.string().required(), inputRoot: schema.string().required(), stateDir: schema.string().required(),
    requestTimeoutMs: schema.number().min(100).default(15_000),
    uploadTimeoutMs: schema.number().min(100).default(1_800_000),
    downloadTimeoutMs: schema.number().min(100).default(300_000),
    pollIntervalMs: schema.number().min(100).default(2_000),
    maxWaitSeconds: schema.number().min(0).max(60).default(20),
    retryCount: schema.number().min(0).max(5).default(2),
    retryDelayMs: schema.number().min(1).default(1_000),
    maxRetryDelayMs: schema.number().min(1).default(30_000),
    maxMetadataBytes: schema.number().min(1024).default(2_097_152),
    maxUploadBytes: schema.number().min(1).default(2_147_483_648),
    maxArtifactBytes: schema.number().min(1).default(2_147_483_648),
  })

  private readonly base: string
  private readonly inputRoot: string
  private readonly root: string
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    const url = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new SlarmError('SLARM endpoint must be HTTP(S), without credentials, query or fragment.', 'INVALID_CONFIG')
    }
    this.base = url.href.replace(/\/+$/, '')
    this.inputRoot = realpathSync.native(resolve(config.inputRoot))
    this.root = resolve(config.stateDir, digest(this.base).slice(0, 16))
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.pending])
    })
  }

  private async run<T>(signal: AbortSignal, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const task = body(combined)
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }

  private async responseObject(response: Response): Promise<JsonObject> {
    const reader = response.body?.getReader()
    if (!reader) throw new SlarmError('SLARM returned an empty response body.', 'INVALID_METADATA')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > this.config.maxMetadataBytes) throw new SlarmError('SLARM metadata exceeds maxMetadataBytes.', 'METADATA_TOO_LARGE')
        chunks.push(value)
      }
    } finally {
      try { await reader.cancel() } finally { reader.releaseLock() }
    }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
      throw new SlarmError(`SLARM returned invalid JSON (HTTP ${response.status}): ${String(error)}`, 'INVALID_METADATA', false, response.status)
    }
    return protocol.parse(protocol.object, value)
  }

  private async json(path: string, request: () => Promise<RequestInit>, signal: AbortSignal,
    timeoutMs = this.config.requestTimeoutMs): Promise<JsonObject> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      let waitMs = this.config.retryDelayMs * 2 ** attempt
      const init = await request()
      try {
        const response = await fetch(this.base + path, { ...init, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
        const body = await this.responseObject(response)
        if (response.ok) return body
        const remote = protocol.object.safeParse(body.error)
        const error = remote.success ? remote.data : {}
        const retryable = response.status === 429 || error.retryable === true
          && [409, 503, 507].includes(response.status)
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter !== null) {
          const seconds = Number(retryAfter)
          const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
          if (Number.isFinite(parsed)) waitMs = Math.max(waitMs, parsed)
        }
        throw new SlarmError(typeof error.message === 'string' ? error.message : `SLARM HTTP ${response.status}`,
          typeof error.code === 'string' ? error.code : 'HTTP_ERROR', retryable, response.status,
          { request_id: body.request_id ?? null, details: error.details ?? null, retry_after_ms: waitMs })
      } catch (error) {
        signal.throwIfAborted()
        const failure = error instanceof SlarmError ? error
          : new SlarmError(`SLARM request failed; retry the same request_key if submission is uncertain: ${String(error)}`, 'TRANSPORT', true)
        if (!failure.retryable || attempt >= this.config.retryCount || waitMs > this.config.maxRetryDelayMs) throw failure
      }
      await delay(waitMs, undefined, { signal })
    }
  }

  private get(path: string, signal: AbortSignal): Promise<JsonObject> {
    return this.json(path, async () => ({ method: 'GET' }), signal)
  }

  private validateWait(waitSeconds: number): void {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > this.config.maxWaitSeconds) {
      throw new SlarmError(`wait_seconds must be between 0 and ${this.config.maxWaitSeconds}.`, 'INVALID_ARGUMENT')
    }
  }

  private async poll(path: string, waitSeconds: number, isTerminal: (state: JsonObject) => boolean,
    signal: AbortSignal): Promise<JsonObject> {
    this.validateWait(waitSeconds)
    const deadline = Date.now() + waitSeconds * 1000
    for (;;) {
      const state = await this.get(path, signal)
      if (isTerminal(state) || Date.now() >= deadline) return state
      await delay(Math.min(this.config.pollIntervalMs, deadline - Date.now()), undefined, { signal })
    }
  }

  capabilities(signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => this.get('/v1/capabilities', signal))
  }

  upload(request: UploadRequest, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      protocol.parse(protocol.requestKey, request.requestKey)
      const path = await realpath(resolve(this.inputRoot, request.archivePath))
      const within = relative(this.inputRoot, path)
      if (isAbsolute(within) || within === '..' || within.startsWith('..' + sep) || !path.toLowerCase().endsWith('.zip')) {
        throw new SlarmError('archive_path must be a ZIP beneath the configured inputRoot.', 'INVALID_INPUT_PATH')
      }
      const info = await stat(path)
      const caps = await this.capabilities(signal)
      const limits = protocol.parse(z.object({ limits: z.object({ upload_bytes: z.number().positive() }),
        input_formats: z.array(z.string()) }), caps)
      if (!limits.input_formats.includes('waymo_slarm_v1')) throw new SlarmError('Service does not accept Waymo ZIP.', 'UNSUPPORTED_FORMAT')
      if (!info.isFile() || info.size === 0 || info.size > Math.min(this.config.maxUploadBytes, limits.limits.upload_bytes)) {
        throw new SlarmError('Archive is empty, not a file, or exceeds the upload limit.', 'INVALID_ARCHIVE')
      }
      const hash = await fileDigest(path, signal)
      const payload = { archive_sha256: hash, filename: basename(path), format: 'waymo_slarm_v1', bytes: info.size }
      const record = await reserve(this.root, this.base, 'upload', request.requestKey, payload)
      let accepted: JsonObject | undefined
      try { accepted = await load(record.path + '.response.json') } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      if (!accepted) {
        accepted = await this.json('/v1/waymo/datasets', async () => {
          const now = await stat(path)
          if (now.size !== info.size || now.mtimeMs !== info.mtimeMs) throw new SlarmError('Archive changed during upload; use a stable ZIP.', 'INPUT_CHANGED')
          const form = new FormData()
          form.set('archive', await openAsBlob(path, { type: 'application/zip' }), basename(path))
          form.set('archive_sha256', hash)
          form.set('format', 'waymo_slarm_v1')
          return { method: 'POST', headers: { 'Idempotency-Key': record.key }, body: form }
        }, signal, this.config.uploadTimeoutMs)
        datasetId(protocol.parse(z.object({ id: z.string() }), accepted).id)
        await save(record.path + '.response.json', accepted)
      }
      const id = datasetId(protocol.parse(z.object({ id: z.string() }), accepted).id)
      return { ...await this.dataset(id, 0, signal), dataset_id: id, request_key: request.requestKey,
        archive_sha256: hash, request_record: record.path }
    })
  }

  dataset(id: DatasetId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      const state = await this.poll(`/v1/datasets/${id}`, waitSeconds, value => {
        const valid = protocol.parse(protocol.datasetState, value)
        if (valid.id !== id) throw new SlarmError('Dataset response id does not match request.', 'INVALID_METADATA')
        return valid.status !== 'validating'
      }, signal)
      return { ...protocol.pick(state, datasetFields), dataset_id: id }
    })
  }

  reconstruct(request: ReconstructionRequest, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      protocol.parse(protocol.requestKey, request.requestKey)
      const { start, end } = request
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end - start < 16 || end - start > 256) {
        throw new SlarmError('Use a half-open frame range [start,end) of 16 to 256 frames.', 'INVALID_FRAME_RANGE')
      }
      if (!request.outputs.length || new Set(request.outputs).size !== request.outputs.length
        || request.outputs.some(value => !outputKinds.includes(value))) throw new SlarmError('outputs must be nonempty, supported and unique.', 'INVALID_OUTPUTS')
      if (request.gaussianStride !== undefined && (!request.outputs.includes('gaussians')
        || !Number.isInteger(request.gaussianStride) || request.gaussianStride < 1 || request.gaussianStride > 256)) {
        throw new SlarmError('gaussian_stride requires gaussians and an integer from 1 to 256.', 'INVALID_ARGUMENT')
      }
      const payload: JsonObject = { dataset_id: request.datasetId, frame_range: { start, end },
        outputs: [...request.outputs].sort(), evaluate: request.evaluate }
      if (request.gaussianStride !== undefined) payload.gaussian_stride = request.gaussianStride
      const record = await reserve(this.root, this.base, 'reconstruct', request.requestKey, payload)
      let accepted: JsonObject | undefined
      try { accepted = await load(record.path + '.response.json') } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      if (!accepted) {
        const data = protocol.parse(protocol.datasetState, await this.dataset(request.datasetId, 0, signal))
        if (data.status !== 'ready' || !data.scene) throw new SlarmError(`Dataset is ${data.status}; query slarm_dataset_status before submitting.`, 'DATASET_NOT_READY')
        if (end > data.scene.frame_count) throw new SlarmError('end exceeds the dataset frame count.', 'INVALID_FRAME_RANGE')
        accepted = await this.json('/v1/reconstructions', async () => ({ method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': record.key }, body: JSON.stringify(payload) }), signal)
      }
      const job = protocol.parse(protocol.jobState, accepted)
      if (job.dataset_id !== request.datasetId) throw new SlarmError('Submission response refers to a different dataset.', 'INVALID_METADATA')
      await save(record.path + '.response.json', accepted)
      const id = reconstructionId(job.id)
      await save(join(this.root, 'owned', `${id}.json`), { endpoint: this.base, request_record: record.path })
      return { ...await this.status(id, 0, signal), request_key: request.requestKey, request_record: record.path }
    })
  }

  status(id: ReconstructionId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      const state = await this.poll(`/v1/reconstructions/${id}`, waitSeconds, value => {
        const valid = protocol.parse(protocol.jobState, value)
        if (valid.id !== id) throw new SlarmError('Task response id does not match request.', 'INVALID_METADATA')
        return terminal.has(valid.status)
      }, signal)
      return { ...protocol.pick(state, jobFields), reconstruction_id: id,
        next_action: state.status === 'succeeded' ? 'slarm_result' : terminal.has(String(state.status)) ? 'stop' : 'slarm_status' }
    })
  }

  private async manifest(id: ReconstructionId, signal: AbortSignal): Promise<JsonObject> {
    const status = await this.status(id, 0, signal)
    if (status.status !== 'succeeded') throw new SlarmError(`Reconstruction is ${status.status}; no completed result is available.`, 'RESULT_NOT_READY')
    const value = await this.get(`/v1/reconstructions/${id}/result`, signal)
    const checked = protocol.parse(protocol.result, value)
    if (checked.reconstruction_id !== id) throw new SlarmError('Result belongs to a different reconstruction.', 'INVALID_METADATA')
    if (checked.dataset_id !== status.dataset_id) throw new SlarmError('Result dataset differs from the reconstruction status.', 'INVALID_METADATA')
    if (new Set(checked.artifacts.map(a => a.artifact_id)).size !== checked.artifacts.length) {
      throw new SlarmError('Duplicate artifact ids in result.', 'INVALID_METADATA')
    }
    for (const item of checked.artifacts) {
      if (item.download_path !== `/v1/reconstructions/${id}/artifacts/${item.artifact_id}`) {
        throw new SlarmError('Artifact URL does not belong to this reconstruction.', 'INVALID_METADATA')
      }
    }
    await save(join(this.root, 'results', id, 'result.json'), value)
    return value
  }

  result(id: ReconstructionId, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      const value = await this.manifest(id, signal)
      const data = protocol.parse(protocol.result, value)
      const contexts = data.summary.windows.map(window => window.context_frame_indices)
      return { ...protocol.pick(value, ['schema_version', 'reconstruction_id', 'dataset_id', 'scene_name', 'model',
        'archive_sha256', 'frame_range', 'frame_indices', 'timestamps_s', 'camera_ids', 'resolution_hw', 'coordinates',
        'motion', 'semantic_labels', 'summary', 'quality_status', 'warnings', 'evaluation_requested', 'metrics', 'expires_at']),
        completed: true, model_calls: contexts.length,
        input_image_occurrences: contexts.reduce((sum, frames) => sum + frames.length, 0) * data.camera_ids.length,
        distinct_input_images: new Set(contexts.flat()).size * data.camera_ids.length,
        output_images: data.frame_indices.length * data.camera_ids.length,
        artifacts: data.artifacts.map(a => ({ ...a, download_url: this.base + a.download_path })),
        local_result_path: join(this.root, 'results', id, 'result.json'),
        interpretation: 'Geometry, semantics and motion are predictions. Point counts are not object counts. quality_status=ok is not accuracy validation. Windows are not globally fused.' }
    })
  }

  download(id: ReconstructionId, artifactIds: ArtifactId[], signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      if (!artifactIds.length || new Set(artifactIds).size !== artifactIds.length) throw new SlarmError('Choose one or more unique artifact ids.', 'INVALID_ARGUMENT')
      const data = protocol.parse(protocol.result, await this.manifest(id, signal))
      const selected = artifactIds.map(id => {
        const item = data.artifacts.find(a => a.artifact_id === id)
        if (!item) throw new SlarmError(`Artifact ${id} is not in this result.`, 'UNKNOWN_ARTIFACT')
        if (item.bytes > this.config.maxArtifactBytes) throw new SlarmError(`Artifact ${id} exceeds maxArtifactBytes.`, 'ARTIFACT_TOO_LARGE')
        return item
      })
      const files: Json[] = []
      for (const item of selected) {
        const directory = join(this.root, 'results', id, item.artifact_id)
        await mkdir(directory, { recursive: true })
        const target = join(directory, item.filename)
        let reused = false
        try { reused = (await stat(target)).size === item.bytes && await fileDigest(target, signal) === item.sha256 }
        catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
        if (!reused) {
          const temporary = `${target}.${randomUUID()}.part`
          const response = await fetch(this.base + item.download_path, { redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]) })
          if (!response.ok || !response.body) {
            await response.body?.cancel()
            throw new SlarmError(`Artifact download returned HTTP ${response.status}.`, 'DOWNLOAD_FAILED', false, response.status)
          }
          const file = await open(temporary, 'wx')
          const reader = response.body.getReader()
          let bytes = 0
          let verified = false
          const hash = createHash('sha256')
          try {
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              signal.throwIfAborted()
              bytes += chunk.value.byteLength
              if (bytes > item.bytes) throw new SlarmError('Downloaded artifact exceeds its declared size.', 'INTEGRITY_FAILURE')
              hash.update(chunk.value)
              await file.writeFile(chunk.value)
            }
            if (bytes !== item.bytes || hash.digest('hex') !== item.sha256) throw new SlarmError('Artifact size or SHA256 mismatch; file was not published.', 'INTEGRITY_FAILURE')
            await file.sync()
            verified = true
          } finally {
            try { await reader.cancel() } finally {
              reader.releaseLock()
              await file.close()
              if (!verified) await unlink(temporary)
            }
          }
          try { await rename(temporary, target) } finally {
            try { await unlink(temporary) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
          }
        }
        files.push({ artifact_id: item.artifact_id, kind: item.kind, path: target, bytes: item.bytes,
          sha256: item.sha256, verified: true, reused })
      }
      const receipt = { reconstruction_id: id, files }
      await save(join(this.root, 'results', id, `download-${randomUUID()}.json`), receipt)
      return receipt
    })
  }

  cancel(id: ReconstructionId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject> {
    return this.run(signal, async signal => {
      this.validateWait(waitSeconds)
      try { await load(join(this.root, 'owned', `${id}.json`)) } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
        throw new SlarmError('Only reconstructions submitted or recovered in this local SLARM store can be cancelled.', 'UNKNOWN_LOCAL_TASK')
      }
      await this.json(`/v1/reconstructions/${id}/cancel`, async () => ({ method: 'POST' }), signal)
      const state = await this.status(id, waitSeconds, signal)
      return { ...state, cancelled: state.status === 'cancelled' }
    })
  }
}

export default SlarmClient
