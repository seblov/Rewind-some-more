// Dev launcher: builds main+preload, then starts Electron pointing the renderer at the
// Vite dev server. Run `npm run dev:renderer` separately (or use `npm run dev` which forks it).
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(root, '..')

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: projectRoot, shell: true, ...opts })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

const devUrl = 'http://localhost:5273'

let viteProc = null
if (!process.env.SKIP_VITE) {
  // Vite's exports map does not expose bin/vite.js, so resolve it from the package
  // root the same way the build script does.
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  viteProc = spawn(process.execPath, [viteBin], {
    stdio: 'inherit',
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  // Give Vite a moment to bind before Electron loads the page.
  await new Promise((r) => setTimeout(r, 2500))
}

await run(process.execPath, [path.join(projectRoot, 'scripts', 'build-main.mjs')])

const electronBin = require('electron')
const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: { ...process.env, REWIND_DEV_SERVER: devUrl },
})

child.on('exit', (code) => {
  viteProc?.kill()
  process.exit(code ?? 0)
})