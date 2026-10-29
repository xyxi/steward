import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WorldApiClient } from '../packages/dsh-world-client/lib/index.js'
import { worldTools } from '@steward/dsh-tool-world'
import { fixture } from './slarm-fixture.mjs'

test('World tools carry capture settings and returned identity through the HTTP provider', async t => {
  const f = await fixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(WorldApiClient, { endpoint: f.config.endpoint })
  const tools = Object.fromEntries(worldTools(ctx.world).map(tool => [tool.name, tool]))
  const call = (name, args) => tools[name].execute(args, { signal: AbortSignal.timeout(5000) })
  assert.equal((await call('world_cameras', { robot: 'w:robot-1', mode: 'triple' })).mode, 'triple')
  const job = await call('world_capture', { robot: 'w:robot-1', frames: 21, fps: 10 })
  const result = await call('world_capture_status', { capture_id: job.capture_id })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.archive_path, 'scene.zip')
  await assert.rejects(call('world_capture_status', { capture_id: '../other' }), /Invalid capture_id/)
})
