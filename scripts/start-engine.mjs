import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
// The training environment can supply CUDA/PyTorch on the original Windows workstation.
// Model discovery and all checkpoint paths are relative to engine/model_bundle.
const shared = 'F:/TensorTract3_Train/.venv/Scripts/python.exe';
const python = process.env.VOCALCUT_PYTHON ||
  (existsSync(local) ? local : process.platform === 'win32' && existsSync(shared) ? shared : 'python');
const args = process.argv.slice(2);
const setupAsr = args[0] === '--setup-asr';
const entry = setupAsr ? 'scripts/setup-asr.py' : 'engine/server.py';

const childEnv = { ...process.env };
const devTokenPath = join(root, '.cache', 'local-engine.token');
let generatedToken = '';
if (!setupAsr && !(childEnv.VOCALCUT_ENGINE_TOKEN || '').trim()) {
  generatedToken = randomBytes(32).toString('hex');
  childEnv.VOCALCUT_ENGINE_TOKEN = generatedToken;
  mkdirSync(dirname(devTokenPath), { recursive: true });
  writeFileSync(devTokenPath, generatedToken + '\n', { encoding: 'utf8', mode: 0o600 });
}

function cleanupDevToken() {
  if (!generatedToken) return;
  try {
    if (existsSync(devTokenPath) && readFileSync(devTokenPath, 'utf8').trim() === generatedToken) {
      unlinkSync(devTokenPath);
    }
  } catch {
    // Ignore cleanup errors on exit
  }
}

const child = spawn(python, ['-B', entry, ...(setupAsr ? args.slice(1) : [])], {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  cleanupDevToken();
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  cleanupDevToken();
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupDevToken();
    child.kill();
  });
}
