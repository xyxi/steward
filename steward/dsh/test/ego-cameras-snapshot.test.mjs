// Recorded model calls use an isolated robot sensor fixture in both record and replay modes.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { cameraFixture } from './ego-camera-fixture.mjs'
import { launchProfile } from './profile-test.mjs'
import { portableSession } from './slarm-recording.mjs'

const workspace = resolve(import.meta.dirname, '..')
const cliPackage = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const prompt = '保持不动，使用你的传感器工具采集当前同一时刻的左、中、右三相机图像，并保存图片及标定清单。先调用一次 ego_capture_cameras，完成后再调用一次 ego_gripper_pose 单独查询当前手爪相对于三相机的位姿。不要调用其他工具或发起生成任务。用一句中文报告采集时间、图像数和手爪变换方向，区分图像附带的同一时刻位姿与另行查询的当前位姿，不输出绝对路径。'
test('robot model captures three cameras and reports sensor time with relative calibration', { timeout: 240000 }, async t => {
  const f = await cameraFixture(t)
  const snapshot = join(import.meta.dirname, 'snapshots/ego-cameras')
  const recording = process.env.EGO_CAMERAS_RECORD === '1'
  const cwd = join(f.root, 'workspace'); await mkdir(cwd, { recursive: true })
  const env = { ...process.env, DSH_HOME: join(f.root, 'home'), DSH_SNAPSHOT_FILE: join(snapshot, 'session.v4.jsonl') }
  if (!recording) { delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL }
  await launchProfile(['--profile', 'ego', '--from-default-profile', 'headless', '--dump-default-config'], cwd, env)
  await launchProfile(['plugin', '--profile', 'ego', 'add', join(workspace, 'packages/dsh-bundle-ego')], cwd, env)
  const patch = [
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'steward-ego-runtime', config: f.config },
    { id: 'session-persistence-jsonl', config: { root: './sessions', compression: 'none' } },
    { id: 'session-log-deepseek', config: { enabled: false } },
  ]
  if (!recording) patch.push({ id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true },
    { insert: [{ id: 'llm-replay', name: pathToFileURL(createRequire(cliPackage).resolve('@deepseek-ai/dsh-llm-replay')).href,
      config: { providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', contextWindow: 128000 }] }] } }] })
  const patchPath = join(f.root, 'camera.patch.json'); await writeFile(patchPath, JSON.stringify(patch))
  const dump = await launchProfile(['--profile', 'ego', '--patch', patchPath, '--dump-config'], cwd, env)
  const egoRow = dump.replaceAll('\r\n', '\n').split('- id: steward-ego-runtime\n')[1]?.split('\n- ')[0]
  assert.ok(egoRow?.includes(`endpoint: ${f.config.endpoint}\n`), 'Ego must use the private camera fixture before model startup')
  const output = await launchProfile(['--profile', 'ego', '--patch', patchPath, '--json', prompt], cwd, env)
  const events = output.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert.ok(events.some(e => e.type === 'final'))
  assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => e.tool), ['ego_capture_cameras', 'ego_gripper_pose'])
  const results = events.filter(e => e.type === 'tool_result')
  assert.equal(results.length, 2); assert.ok(results.every(result => result.status === 'completed'))
  const result = JSON.parse(results[0].result)
  assert.equal(result.stamp, f.packet.stamp)
  const pose = JSON.parse(results[1].result)
  assert.deepEqual(pose, result.gripper_pose)
  for (const view of Object.values(result.views)) assert.deepEqual(await readFile(view.image_path), f.bytes)
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [['POST', '/ego/cameras/capture'], ['GET', '/ego/gripper/pose']])
  const logs = await readdir(join(cwd, 'sessions'), { recursive: true })
  const raw = await readFile(join(cwd, 'sessions', logs.find(p => p.endsWith('session.v4.jsonl'))), 'utf8')
  const sessionRoot = dirname(JSON.parse(raw.split('\n')[0]).cwd)
  const transcript = JSON.stringify([result, pose], null, 2).replaceAll(f.root.replaceAll('\\', '\\\\'), '{{cwd}}')
    .replaceAll('\\\\', '/').replace(/capture-[A-Za-z0-9]+/g, '{{capture}}') + '\n'
  if (recording) {
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'session.v4.jsonl'), portableSession(raw, f.root, f.config.endpoint)
      .replaceAll(sessionRoot.replaceAll('\\', '//'), '{{cwd}}').replaceAll(sessionRoot.replaceAll('\\', '/'), '{{cwd}}')
      .replace(/capture-[A-Za-z0-9]+/g, '{{capture}}'))
    await writeFile(join(snapshot, 'tools.expected.json'), transcript)
  } else assert.equal(transcript, await readFile(join(snapshot, 'tools.expected.json'), 'utf8'))
})
