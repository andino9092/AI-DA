// Compiles AI-DA's Windows helper (native/aida-win/*.cs) with the C# compiler that ships with
// Windows (.NET Framework 4.8), so building needs no .NET SDK. Skips work when up to date.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'native', 'aida-win');
// --out <path> builds somewhere else (e.g. while a running copy has the exe locked).
const outArg = process.argv.indexOf('--out');
const out =
  outArg > 0
    ? resolve(process.argv[outArg + 1])
    : join(root, 'resources', 'native', 'aida-win.exe');

if (process.platform !== 'win32') {
  console.log('[native] Skipping the Windows helper (not on Windows).');
  process.exit(0);
}

const windir = process.env.SystemRoot ?? 'C:\\Windows';
const framework = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const wpf = join(framework, 'WPF');
const winmd = join(windir, 'System32', 'WinMetadata');
const csc = join(framework, 'csc.exe');

const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.cs'))
  .map((f) => join(srcDir, f));
const newestSource = Math.max(
  ...sources.map((f) => statSync(f).mtimeMs),
  statSync(import.meta.filename).mtimeMs,
);
if (existsSync(out) && statSync(out).mtimeMs > newestSource && !process.argv.includes('--force')) {
  process.exit(0);
}

if (!existsSync(csc)) {
  console.error(`[native] The .NET Framework C# compiler was not found at ${csc}.`);
  process.exit(1);
}

const references = [
  join(framework, 'System.Web.Extensions.dll'),
  join(framework, 'System.Drawing.dll'),
  join(framework, 'Microsoft.CSharp.dll'),
  join(framework, 'System.Core.dll'),
  join(framework, 'System.Runtime.dll'),
  join(framework, 'System.Runtime.WindowsRuntime.dll'),
  join(wpf, 'UIAutomationClient.dll'),
  join(wpf, 'UIAutomationTypes.dll'),
  join(wpf, 'WindowsBase.dll'),
  ...['Foundation', 'Media', 'Graphics', 'Globalization', 'Security', 'Storage'].map((n) =>
    join(winmd, `Windows.${n}.winmd`),
  ),
];

mkdirSync(dirname(out), { recursive: true });
try {
  execFileSync(
    csc,
    [
      '-nologo',
      '-optimize+',
      '-platform:x64',
      '-target:exe',
      '-warnaserror+',
      `-out:${out}`,
      ...references.map((r) => `-r:${r}`),
      ...sources,
    ],
    { stdio: 'inherit' },
  );
  console.log(`[native] Built ${out}`);
} catch {
  console.error('[native] Building the Windows helper failed.');
  process.exit(1);
}
