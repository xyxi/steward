/** Validation of SLARM HTTP metadata and local request records. */
import { z } from 'zod'
import { SlarmError, type JsonObject } from '@steward/dsh-slarm'

/** JSON object preserving extra response fields and explicit nulls. */
export const object = z.record(z.string(), z.json())
const datasetPattern = /^ds_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const reconstructionPattern = /^rec_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const artifactPattern = /^art_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
/** Caller operation identity admitted before any POST. */
export const requestKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
/** Dataset fields required to admit a reconstruction range. */
export const datasetState = z.object({
  id: z.string().regex(datasetPattern), status: z.enum(['validating', 'ready', 'invalid']),
  scene: z.object({ frame_count: z.number().int().positive() }).nullable(),
})
/** Closed remote states used to decide whether polling may finish. */
export const jobState = z.object({
  id: z.string().regex(reconstructionPattern),
  dataset_id: z.string().regex(datasetPattern),
  status: z.enum(['queued', 'starting', 'running', 'finalizing', 'cancelling', 'recovering', 'succeeded', 'failed', 'cancelled', 'expired']),
})
const artifact = z.object({
  artifact_id: z.string().regex(artifactPattern), kind: z.string(),
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/), media_type: z.string(),
  bytes: z.number().int().positive().safe(), sha256,
  download_path: z.string(), expires_at: z.string(),
  frame_indices: z.array(z.number().int().nonnegative()),
})
/** Result metadata required for input counts and verified artifact transfers. */
export const result = z.object({
  schema_version: z.literal('1.0'), reconstruction_id: z.string().regex(reconstructionPattern),
  dataset_id: z.string().regex(datasetPattern), model: object, archive_sha256: sha256,
  frame_range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  frame_indices: z.array(z.number().int().nonnegative()).min(1).max(256),
  camera_ids: z.array(z.string()).length(3), coordinates: object,
  quality_status: z.enum(['ok', 'warnings', 'insufficient_valid_geometry']), warnings: z.array(z.json()),
  summary: z.object({
    windows: z.array(z.object({ context_frame_indices: z.array(z.number().int().nonnegative()),
      target_frame_indices: z.array(z.number().int().nonnegative()) })).min(1).max(16),
  }),
  artifacts: z.array(artifact).min(1), expires_at: z.string(),
})
/** Immutable local submission identity and its exact canonical payload. */
export const savedRequest = z.object({ version: z.literal(1), endpoint: z.string(), kind: z.enum(['upload', 'reconstruct']),
  request_key: requestKey, idempotency_key: z.string().uuid(), payload: object }).strict()

/** Validate untrusted JSON; schema failures are actionable provider errors.
 * @param schema - validator for fields consumed by the caller.
 * @param value - decoded wire or file value.
 * @returns validated fields.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value)
  if (!checked.success) throw new SlarmError(`Invalid SLARM metadata: ${checked.error.message}`, 'INVALID_METADATA')
  return checked.data
}

/** Pick model-facing fields while preserving explicit nulls and omitting absent fields.
 * @param value - validated JSON object.
 * @param fields - fields to retain.
 * @returns bounded projection with no invented defaults.
 */
export function pick(value: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(fields.filter(key => key in value).map(key => [key, value[key]]))
}
