/** SLARM service interface. Remote jobs outlive individual tool invocations. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Lossless JSON returned to tools and written to local operation records. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
/** JSON object returned by SLARM operations. */
export type JsonObject = { [key: string]: Json }
/** Server dataset identity. */
export type DatasetId = Branded<'SlarmDatasetId'>
/** Server reconstruction identity. */
export type ReconstructionId = Branded<'SlarmReconstructionId'>
/** Server artifact identity. */
export type ArtifactId = Branded<'SlarmArtifactId'>

/** Validate an artifact id from a model call or manifest.
 * @param value - candidate id.
 * @returns admitted artifact id.
 */
export function artifactId(value: string): ArtifactId {
  if (!/^art_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error('Invalid SLARM artifact id')
  return brandString<ArtifactId>(value)
}

/** Validate a dataset id from a tool, wire response or saved record.
 * @param value - candidate id.
 * @returns the admitted dataset id.
 */
export function datasetId(value: string): DatasetId {
  if (!/^ds_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error('Invalid SLARM dataset id')
  return brandString<DatasetId>(value)
}

/** Validate a reconstruction id from a tool, wire response or saved record.
 * @param value - candidate id.
 * @returns the admitted reconstruction id.
 */
export function reconstructionId(value: string): ReconstructionId {
  if (!/^rec_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error('Invalid SLARM reconstruction id')
  return brandString<ReconstructionId>(value)
}

/** Export choices supported by the reconstruction API. */
export const outputKinds = ['rgb_video', 'diagnostic_video', 'depth', 'scene_flow', 'semantic', 'pointcloud', 'gaussians'] as const
/** Requested output, distinct from the artifact kind in a result manifest. */
export type OutputKind = typeof outputKinds[number]

/** Upload identity is reused for retries; a new logical upload uses a new requestKey. */
export interface UploadRequest {
  archivePath: string
  requestKey: string
}

/** Explicit resolved request; end excludes that frame and outputs are never implicitly added. */
export interface ReconstructionRequest {
  datasetId: DatasetId
  requestKey: string
  start: number
  end: number
  outputs: OutputKind[]
  evaluate: boolean
  gaussianStride?: number
}

/** Structured provider failure; submitted requests retain their keys after unknown network outcomes. */
export class SlarmError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false,
    readonly status: number | null = null, readonly details: Json = null) {
    super(`[${code}] ${message}`)
    this.name = 'SlarmError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { slarm: SlarmService }
}

/** SLARM operations; cancellation of an HTTP call does not cancel an accepted remote job. */
export abstract class SlarmService extends Service {
  constructor(ctx: Context) { super(ctx, 'slarm') }
  /** Read current service capabilities.
   * @param signal - caller cancellation.
   * @returns readiness, version and limits.
   */
  abstract capabilities(signal: AbortSignal): Promise<JsonObject>
  /** Upload a Waymo ZIP accessible beneath the configured input root.
   * @param request - archive and stable request key.
   * @param signal - caller cancellation.
   * @returns dataset id and validating/ready/invalid state; not reconstruction completion.
   */
  abstract upload(request: UploadRequest, signal: AbortSignal): Promise<JsonObject>
  /** Query validation state, optionally waiting for a terminal dataset state.
   * @param id - dataset id.
   * @param waitSeconds - bounded wait; zero performs one query.
   * @param signal - stops waiting without deleting the dataset.
   * @returns latest validation state and issues.
   */
  abstract dataset(id: DatasetId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject>
  /** Submit a ready dataset with a stable request key.
   * @param request - resolved reconstruction options.
   * @param signal - caller cancellation; use cancel() to stop accepted work.
   * @returns the server reconstruction id and current state.
   */
  abstract reconstruct(request: ReconstructionRequest, signal: AbortSignal): Promise<JsonObject>
  /** Query progress without creating work.
   * @param id - reconstruction id.
   * @param waitSeconds - bounded wait; zero performs one query.
   * @param signal - stops waiting without cancelling remote work.
   * @returns latest status; succeeded still requires result() before reporting completion.
   */
  abstract status(id: ReconstructionId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject>
  /** Fetch and save a completed result; failed, cancelled or pending jobs have no successful result.
   * @param id - reconstruction id.
   * @param signal - caller cancellation.
   * @returns summary, coordinate facts, artifact list and local manifest path.
   */
  abstract result(id: ReconstructionId, signal: AbortSignal): Promise<JsonObject>
  /** Download selected artifacts to the configured result store, verifying byte count and SHA256.
   * @param id - successful reconstruction id.
   * @param artifactIds - exact ids from result(); no arbitrary URLs or destination paths.
   * @param signal - caller cancellation; unfinished files are not published as complete.
   * @returns verified local paths, with already verified files reused.
   */
  abstract download(id: ReconstructionId, artifactIds: ArtifactId[], signal: AbortSignal): Promise<JsonObject>
  /** Request remote cancellation and optionally wait for its terminal state.
   * @param id - reconstruction created or recovered by this local store.
   * @param waitSeconds - bounded wait; zero queries immediately after submitting cancellation.
   * @param signal - caller cancellation; a cancelled request can be retried.
   * @returns latest state and whether cancellation has actually completed.
   */
  abstract cancel(id: ReconstructionId, waitSeconds: number, signal: AbortSignal): Promise<JsonObject>
}
