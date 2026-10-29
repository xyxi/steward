/** Model-facing SLARM tools; every returned field is logged through the normal DSH tool pipeline. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { artifactId, datasetId, reconstructionId, outputKinds, type Json, type SlarmService } from '@steward/dsh-slarm'

/** Loader identity. */
export const name = 'steward-tool-slarm'
/** Required services, supplied by the SLARM bundle and DSH base. */
export const inject = ['tools', 'slarm']

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: Json) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}
const key = { type: 'string' as const, required: true as const,
  description: 'Stable operation key, 8-128 letters/digits or ._:-. Reuse EXACTLY for retries, including after disconnects. Use a new key only for intentional new work.' }
const rec = { type: 'string' as const, required: true as const, description: 'Actual rec_ id returned by slarm_reconstruct. Never invent ids.' }
const wait = { type: 'number' as const, description: 'Seconds to wait for a terminal state (0-20 by default); omitted means one immediate query. Does not cancel remote work.' }

/** Build the tools over an injected SLARM service.
 * @param slarm - HTTP provider or test provider.
 * @returns definitions registered in this order.
 */
export function slarmTools(slarm: SlarmService): ToolDefinition[] {
  return [
    defineTool({ name: 'slarm_capabilities',
      description: 'Read current SLARM readiness, API version, output choices and limits before uploading. This does not run reconstruction.',
      parameters: {}, output,
      execute: (_args, exec) => slarm.capabilities(exec.signal),
    }),
    defineTool({ name: 'slarm_upload',
      description: 'Upload a local Waymo or slarm_scene_v1 ZIP to SLARM. Requires three synchronized RGB cameras, calibration and known poses. '
        + 'The path is on this DSH host beneath inputRoot, not the remote server. Returns dataset_id; query validation before reconstruction. '
        + 'This uploads file contents to the configured server. Aborting the HTTP call does not delete accepted data.',
      parameters: { archive_path: { type: 'string', required: true,
        description: 'ZIP path relative to inputRoot, or an absolute path within it.' }, request_key: key,
        format: { type: 'string', enum: ['waymo_slarm_v1', 'slarm_scene_v1'],
          description: 'Use slarm_scene_v1 for world_capture exports. Omitted means legacy waymo_slarm_v1.' } }, output,
      execute: (args, exec) => slarm.upload({ archivePath: args.archive_path, requestKey: args.request_key,
        format: args.format ?? 'waymo_slarm_v1' }, exec.signal),
    }),
    defineTool({ name: 'slarm_dataset_status',
      description: 'Read SLARM dataset validation. validating means wait; ready allows reconstruction; invalid means stop and report issues. No work is submitted.',
      parameters: { dataset_id: { type: 'string', required: true, description: 'Actual ds_ id from slarm_upload.' }, wait_seconds: wait }, output,
      execute: (args, exec) => slarm.dataset(datasetId(args.dataset_id), args.wait_seconds ?? 0, exec.signal),
    }),
    defineTool({ name: 'slarm_reconstruct',
      description: 'Submit a READY SLARM dataset. Range [start,end) must contain 16-256 time frames, within the dataset. '
        + 'Exactly 16 frames gives one model window; each uses offsets 0,5,10,15 across three cameras. '
        + 'Returns reconstruction_id and status, NOT completion. Use slarm_status then slarm_result. '
        + 'For point clouds and previews request pointcloud, rgb_video and diagnostic_video. No local SLARM/NPU environment is needed.',
      parameters: { dataset_id: { type: 'string', required: true }, request_key: key,
        start: { type: 'number', required: true, description: 'Inclusive original time-frame index, integer >=0.' },
        end: { type: 'number', required: true, description: 'Exclusive original time-frame index.' },
        outputs: { type: 'array', items: { type: 'string', enum: [...outputKinds] }, required: true,
          description: 'Nonempty unique export choices. Depth/semantic/scene_flow share render_arrays artifacts.' },
        evaluate: { type: 'boolean', description: 'Request metrics against available reference data; omitted is false. Missing GT metrics remain null.' },
        gaussian_stride: { type: 'number', description: 'Only with gaussians: integer 1-256; omitted follows server default 16. Controls exported snapshots, not model input sampling.' },
      }, output,
      execute: (args, exec) => slarm.reconstruct({ datasetId: datasetId(args.dataset_id), requestKey: args.request_key,
        start: args.start, end: args.end, outputs: args.outputs, evaluate: args.evaluate ?? false,
        ...(args.gaussian_stride === undefined ? {} : { gaussianStride: args.gaussian_stride }) }, exec.signal),
    }),
    defineTool({ name: 'slarm_status',
      description: 'Query reconstruction progress, optionally waiting. queued/starting/running/finalizing/cancelling/recovering are not completed. '
        + 'On succeeded fetch slarm_result; on failed/cancelled/expired stop. Progress at 100% alone is not success.',
      parameters: { reconstruction_id: rec, wait_seconds: wait }, output,
      execute: (args, exec) => slarm.status(reconstructionId(args.reconstruction_id), args.wait_seconds ?? 0, exec.signal),
    }),
    defineTool({ name: 'slarm_result',
      description: 'Read and save a successful reconstruction manifest. Returns predictions, coordinates, actual input/output counts, warnings and ALL artifact ids. '
        + 'Only completed=true permits reporting reconstruction complete. Point counts are not object counts; quality_status=ok is not accuracy validation. '
        + 'No instance tracks or fused MuJoCo scene are provided. Large arrays stay in files; use slarm_download selectively.',
      parameters: { reconstruction_id: rec }, output,
      execute: (args, exec) => slarm.result(reconstructionId(args.reconstruction_id), exec.signal),
    }),
    defineTool({ name: 'slarm_download',
      description: 'Download selected artifact ids from a successful result. Select ALL pointcloud artifacts for all windows plus desired videos. '
        + 'Saves beneath the configured stateDir, verifies bytes and SHA256, reuses verified files and returns absolute paths. '
        + 'There is no all-results ZIP. Download failures do not invalidate completed reconstruction; retry this operation.',
      parameters: { reconstruction_id: rec, artifact_ids: { type: 'array', items: { type: 'string' }, required: true,
        description: 'Nonempty unique artifact ids returned by slarm_result; never filenames or arbitrary URLs.' } }, output,
      execute: (args, exec) => slarm.download(reconstructionId(args.reconstruction_id), args.artifact_ids.map(artifactId), exec.signal),
    }),
    defineTool({ name: 'slarm_cancel',
      description: 'Explicitly cancel a reconstruction submitted by this local SLARM store. Closing a browser or aborting polling does NOT cancel it. '
        + 'cancelling means cleanup is ongoing; only cancelled=true confirms cancellation. Continue slarm_status if necessary.',
      parameters: { reconstruction_id: rec, wait_seconds: wait }, output,
      execute: (args, exec) => slarm.cancel(reconstructionId(args.reconstruction_id), args.wait_seconds ?? 0, exec.signal),
    }),
  ]
}

/** Register tools with plugin-owned cleanup.
 * @param ctx - context with tools and slarm services.
 * @returns no value.
 */
export function apply(ctx: Context): void {
  for (const tool of slarmTools(ctx.slarm)) ctx.effect(() => ctx.tools.register(tool))
}
