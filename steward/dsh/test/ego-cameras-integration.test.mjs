// Actual MuJoCo sensor rendering crosses the Python robot/Ego APIs and the built TS provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import EgoRuntimeClient from '@steward/dsh-ego-runtime-client'
import { egoTools } from '@steward/dsh-tool-ego'
import { fixture } from './rgbd-video-gen-fixture.mjs'
import { fixture as novelFixture } from './novelanything-fixture.mjs'
import { setTimeout as delay } from 'node:timers/promises'

const steward = resolve(import.meta.dirname, '../..')
const python = join(steward, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const program = `
import json, sys
from steward.authoring.service import AuthoringService, build_default_kitchen
from steward.assets.generators import steward_bot
from steward.ego.runtime import EgoRuntime, RobotLink
from steward.ego.server import ego_api
from steward.world.server import StewardHost
build_default_kitchen(AuthoringService(sys.argv[1]))
host = StewardHost(sys.argv[1], scenario="phase0-kitchen")
runtime = EgoRuntime(RobotLink(host.robot_servers["w:robot-1"].url), steward_bot().to_dict())
api = ego_api(runtime).start()
try:
    print(json.dumps({"endpoint": api.url}), flush=True)
    for command in sys.stdin:
        if command.strip() == "step":
            host.sim.step(500)
finally:
    api.stop()
    host.stop()
`

test('actual robot sensor images reach saved tool artifacts through both HTTP services', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'steward-camera-integration-'))
  const ctx = new Context()
  const child = spawn(python, ['-u', '-c', program, root], { cwd: steward, windowsHide: true,
    env: { ...process.env, PYTHONPATH: [join(steward, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', timedOut = false
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text })
  const exited = new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok) })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 60000)
  t.after(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      child.stdin.end()
      try {
        const code = await exited
        assert.equal(timedOut, false, stderr)
        assert.equal(code, 0, stderr)
      } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }) }
    }
  })
  const info = await new Promise((ok, fail) => {
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', text => {
      stdout += text
      const line = stdout.split('\n').find(line => line.startsWith('{'))
      if (line) ok(JSON.parse(line))
    })
    exited.then(code => fail(new Error(`Python exited before readiness: ${code}\n${stderr}`)), fail)
  })
  await ctx.plugin(EgoRuntimeClient, { endpoint: info.endpoint, cameraCaptureDir: join(root, 'workspace/captures') })
  const tool = egoTools(ctx.ego).find(tool => tool.name === 'ego_capture_cameras')
  const result = await tool.execute({}, { name: tool.name, arguments: {}, signal: AbortSignal.timeout(20000) })
  assert.equal(result.stamp, 0)
  assert.equal(result.gripper_pose.stamp, result.stamp)
  assert.equal(result.gripper_pose.pose_source, 'joint_encoders_and_robot_model')
  assert.equal(Object.keys(result.views).length, 3)
  for (const view of Object.values(result.views)) {
    const bytes = await readFile(view.image_path)
    assert.ok(bytes.length > 1000)
    assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255])
    assert.equal(view.width, 320); assert.equal(view.height, 240)
  }
  assert.equal(JSON.parse(await readFile(result.manifest_path, 'utf8')).stamp, 0)
  const calibrationTool = egoTools(ctx.ego).find(tool => tool.name === 'ego_camera_calibration')
  const calibration = await calibrationTool.execute({}, { name: calibrationTool.name, arguments: {}, signal: AbortSignal.timeout(5000) })
  assert.equal(calibration.depth_camera, undefined)
  assert.equal(result.depth_camera, undefined)
  assert.deepEqual(Object.keys(calibration.views), Object.keys(result.views))
  const poseTool = egoTools(ctx.ego).find(tool => tool.name === 'ego_gripper_pose')
  const pose = await poseTool.execute({}, { name: poseTool.name, arguments: {}, signal: AbortSignal.timeout(5000) })
  assert.deepEqual(pose, result.gripper_pose)
  const remote = await fixture(t, { inputRoot: join(root, 'workspace'), egoEndpoint: info.endpoint })
  const prepared = await remote.call('prepare_scene', { capture_manifest_path: result.manifest_path,
    targets: [{ frame: 'gripper', position: [0, 0, 0], look_at: [1, 0, 0], up: [0, 0, 1] }] })
  const scene = JSON.parse(await readFile(prepared.local_scene_path, 'utf8'))
  assert.equal(scene.frames.length, 2)
  const target = scene.frames[1].views.head_camera.camera_to_world
  const hand = pose.gripper_to_camera.head_camera
  for (let row = 0; row < 3; row++) {
    assert.equal(target[row][3], hand[row][3])
    assert.equal(target[row][2], hand[row][0])
    assert.ok(Math.abs(target[row][1] + hand[row][2]) < 1e-12)
  }
  await remote.call('submit', { scene_path: prepared.scene_path, request_key: 'actual-gripper-input',
    num_source_views: prepared.num_source_views, max_target_views: prepared.max_target_views })
  assert.equal(remote.state.postCount, 1)
  assert.doesNotMatch(JSON.stringify(result), /camera_to_world|simulation_ground_truth|w:robot/)
  const recordingTools = new Map(egoTools(ctx.ego).map(tool => [tool.name, tool]))
  const callEgo = (name, args) => recordingTools.get(name).execute(args, { name, arguments: args, signal: AbortSignal.timeout(20000) })
  const started = await callEgo('ego_rgb_recording_start', { fps: 2, max_frames: 3, request_key: 'native-recording-001' })
  child.stdin.write('step\n')
  let recorded
  const deadline = Date.now() + 20000
  do {
    recorded = await callEgo('ego_rgb_recording_status', { recording_id: started.recording_id })
    if (recorded.status !== 'recording' && recorded.status !== 'finalizing') break
    assert.ok(Date.now() < deadline, JSON.stringify(recorded))
    await delay(50)
  } while (true)
  assert.equal(recorded.status, 'succeeded', JSON.stringify(recorded))
  assert.equal(recorded.written_frames, 3)
  assert.ok(Math.abs(recorded.last_stamp - recorded.first_stamp - 1) < 1e-9)
  const temporal = await remote.call('prepare_recording', { recording_id: started.recording_id,
    targets: [{ frame: 'gripper', position: [0, 0, 0], look_at: [1, 0, 0], up: [0, 0, 1] }] })
  assert.equal(temporal.recorded_frames, 3)
  assert.equal(temporal.all_frames_used, true)
  assert.deepEqual(temporal.source_frame_indices, [0, 1, 2])
  const temporalScene = JSON.parse(await readFile(temporal.local_scene_path, 'utf8'))
  const evidenceManifest = JSON.parse(await readFile(temporal.recording_manifest_path, 'utf8'))
  assert.equal(evidenceManifest.frames.length, 3)
  for (const [index, frame] of evidenceManifest.frames.entries()) {
    const image = await readFile(join(dirname(temporal.recording_manifest_path), frame.image_path))
    assert.deepEqual(Buffer.from(temporalScene.frames[index].views.head_camera.image.split(',')[1], 'base64'), image)
  }
  await remote.call('submit', { scene_path: temporal.scene_path, request_key: 'actual-temporal-input',
    num_source_views: temporal.num_source_views, max_target_views: temporal.max_target_views })
  assert.equal(remote.state.postCount, 2)
  const novel = await novelFixture(t, { inputRoot: join(root, 'workspace'), egoEndpoint: info.endpoint })
  const novelScene = await novel.call('prepare_gripper_view', { recording_id: started.recording_id, num_source_views: 2 })
  assert.equal(novelScene.label, 'gripper_view_prediction')
  assert.equal(novelScene.metadata.fps, 2)
  assert.equal(novelScene.metadata.camera_id, 'head_camera')
  assert.deepEqual(novelScene.metadata.input_modalities, ['rgb'])
  assert.doesNotMatch(JSON.stringify(novelScene), /archive_base64|simulation_ground_truth|camera_to_world/)
  assert.deepEqual([...(await readFile(novelScene.archive_path)).subarray(0, 2)], [80, 75])
  const upload = await novel.call('upload', { archive_path: novelScene.archive_path, dataset: 'scannetpp', request_key: 'native-scene-upload' })
  novel.state.status = 'succeeded'
  const accepted = await novel.call('submit', { upload_id: upload.upload_id, context: novelScene.context, target: novelScene.target,
    metrics: false, request_key: 'native-scene-submit' })
  const generated = await novel.call('result', { job_id: accepted.id })
  const downloaded = await novel.call('download', { job_id: accepted.id, artifact_paths: generated.result.artifacts.map(a => a.path) })
  assert.ok(downloaded.local_manifest_path.includes('outputs'))
  assert.ok(downloaded.files.every(file => file.path.includes('novelanything')))
})
