import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { cameraFixture } from './ego-camera-fixture.mjs'

test('camera tool saves three synchronized JPEGs and a manifest without inline pixels or World poses', async t => {
  const f = await cameraFixture(t)
  f.packet.robot = 'w:robot-1'
  f.packet.views.head_camera.camera_to_world = [[1, 0, 0, 100]]
  const [one, two] = await Promise.all([f.capture(), f.capture()])
  assert.notEqual(one.manifest_path, two.manifest_path)
  assert.equal(one.stamp, 42.125)
  assert.deepEqual(Object.keys(one.views), f.ids)
  assert.equal(one.calibration_source, 'rig_calibration')
  assert.deepEqual(one.gripper_pose, f.packet.gripper_pose)
  assert.doesNotMatch(JSON.stringify(one), /base64|camera_to_world|w:robot/)
  for (const result of [one, two]) {
    const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8'))
    assert.equal(manifest.stamp, result.stamp)
    assert.deepEqual(manifest.gripper_pose, result.gripper_pose)
    for (const id of f.ids) {
      const view = result.views[id]
      assert.equal(dirname(view.image_path), dirname(result.manifest_path))
      assert.deepEqual(await readFile(view.image_path), f.bytes)
      assert.deepEqual(view.K, f.packet.views[id].K)
      assert.deepEqual(view.camera_to_reference, f.packet.views[id].camera_to_reference)
    }
  }
  assert.deepEqual(f.calls.map(c => [c.method, c.path, c.body]), [
    ['POST', '/ego/cameras/capture', '{}'], ['POST', '/ego/cameras/capture', '{}']])
})

test('invalid images, missing cameras, calibration errors and oversized captures publish no files', async t => {
  const f = await cameraFixture(t)
  const original = structuredClone(f.packet)
  for (const change of [
    packet => { delete packet.views.head_camera_right },
    packet => { packet.views.head_camera.image = 'http://other.invalid/image' },
    packet => { packet.views.head_camera.K = [[1]] },
    packet => { packet.views.head_camera.camera_to_reference[3][0] = 1 },
    packet => { packet.views.head_camera.image = 'data:image/jpeg;base64,YWJj' },
    packet => { packet.views.head_camera.width = 0 },
    packet => { packet.gripper_pose.stamp += 1 },
    packet => { delete packet.gripper_pose.gripper_to_camera.head_camera_right },
    packet => { packet.views.head_camera.image = 'data:image/jpeg;base64,' + Buffer.alloc(2048).toString('base64') },
  ]) {
    f.state.packet = structuredClone(original); change(f.state.packet)
    await assert.rejects(f.capture(), error => error.name === 'EgoError')
    await assert.rejects(readdir(f.config.cameraCaptureDir), { code: 'ENOENT' })
  }
})

test('gripper pose tool uses only the pose endpoint and rejects malformed transforms', async t => {
  const f = await cameraFixture(t)
  f.packet.gripper_pose.camera_to_world = [[1]]
  const pose = await f.pose()
  assert.equal(pose.stamp, f.packet.stamp)
  assert.deepEqual(pose.gripper_to_camera, f.packet.gripper_pose.gripper_to_camera)
  assert.doesNotMatch(JSON.stringify(pose), /camera_to_world/)
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [['GET', '/ego/gripper/pose']])
  await assert.rejects(readdir(f.config.cameraCaptureDir), { code: 'ENOENT' })
  f.packet.gripper_pose.gripper_to_base[3][0] = 1
  await assert.rejects(f.pose(), /gripper pose transform/)
})

test('camera service failure, cancelled requests and unwritable output never report saved images', async t => {
  const f = await cameraFixture(t)
  f.state.status = 503
  await assert.rejects(f.capture(), /Camera unavailable/)
  f.state.status = 200
  await assert.rejects(f.capture(AbortSignal.abort(new Error('capture cancelled'))), /cancelled/)
  await mkdir(dirname(f.config.cameraCaptureDir), { recursive: true })
  await writeFile(f.config.cameraCaptureDir, 'existing file')
  await assert.rejects(f.capture(), /EEXIST|ENOTDIR/)
  assert.equal(await readFile(f.config.cameraCaptureDir, 'utf8'), 'existing file')
})

test('RGB calibration and captures exclude obsolete depth payloads from the runtime', async t => {
  const f = await cameraFixture(t)
  f.packet.depth_camera = { image: 'data:image/png;base64,obsolete' }
  f.calibration.depth_camera = { id: 'head_depth_camera' }
  const calibration = await f.readCalibration()
  assert.deepEqual(Object.keys(calibration.views), f.ids)
  assert.equal(calibration.depth_camera, undefined)
  await assert.rejects(readdir(f.config.cameraCaptureDir), { code: 'ENOENT' })
  const result = await f.capture()
  assert.equal(result.depth_camera, undefined)
  assert.deepEqual((await readdir(dirname(result.manifest_path))).sort(), ['capture.json', ...f.ids.map(id => `${id}.jpg`)].sort())
  for (const invalid of [2, -1]) {
    f.calibration.views.head_camera.camera_to_reference[0][0] = invalid
    await assert.rejects(f.readCalibration(), /rigid|right-handed/)
  }
})
