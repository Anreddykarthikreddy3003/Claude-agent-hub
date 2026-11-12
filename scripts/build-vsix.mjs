// Packages statusbar-extension/ into dist/<extension name>.vsix (no npm deps).
// A .vsix is a zip with [Content_Types].xml, extension.vsixmanifest and the extension under extension/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, BIN, FILES } from '../src/paths.mjs';

const src = path.join(ROOT, 'statusbar-extension');
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));

// Build gate: the dashboard script lives inside a template string, where a stray escape can break it.
// Compile the generated webview script (both layouts) and refuse to package if it doesn't parse.
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? {} : orig.call(this, r, ...a); };
  const ext = require(path.join(src, 'extension.js'));
  Module._load = orig;
  for (const compact of [false, true]) {
    const h = ext._html('gate', compact);
    const s = h.slice(h.indexOf('<script nonce="gate">') + 21, h.lastIndexOf('</script>'));
    try { new Function(s); } catch (e) { console.error(`BUILD STOPPED: dashboard script does not compile (${compact ? 'sidebar' : 'tab'} layout): ${e.message}`); process.exit(1); }
  }
}
const stage = path.join(ROOT, 'dist', 'vsix-stage');
const outFile = path.join(ROOT, 'dist', `${pkg.name}.vsix`);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'extension'), { recursive: true });
for (const f of ['package.json', 'extension.js']) fs.copyFileSync(path.join(src, f), path.join(stage, 'extension', f));
fs.mkdirSync(path.join(stage, 'extension', 'media'), { recursive: true });
for (const f of fs.readdirSync(path.join(src, 'media'))) fs.copyFileSync(path.join(src, 'media', f), path.join(stage, 'extension', 'media', f));
fs.writeFileSync(path.join(stage, 'extension', 'cam-paths.json'), JSON.stringify({ node: process.execPath, cam: BIN, status: FILES.status }, null, 2));

fs.writeFileSync(
  path.join(stage, '[Content_Types].xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
</Types>
`,
);
fs.writeFileSync(
  path.join(stage, 'extension.vsixmanifest'),
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`,
);

fs.rmSync(outFile, { force: true });
const zip = path.join(ROOT, 'dist', `${pkg.name}.zip`);
fs.rmSync(zip, { force: true });
// Windows' built-in bsdtar writes zip archives with forward-slash entry names.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
const r =
  process.platform === 'win32'
    ? spawnSync(tar, ['-a', '-c', '-f', zip, '-C', stage, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { encoding: 'utf8' })
    : spawnSync('zip', ['-r', zip, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: stage, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || r.error);
  process.exit(1);
}
fs.renameSync(zip, outFile);
fs.rmSync(stage, { recursive: true, force: true });
console.log(outFile);
