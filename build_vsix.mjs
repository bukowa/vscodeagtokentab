import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const STAGING = path.join(ROOT, '.pkg_staging');
const VSIX_NAME = `${pkg.name}-${pkg.version}.vsix`;

console.log('Building bundle...');
if (typeof Deno !== 'undefined') {
  execSync('deno run -A esbuild.config.mjs', { stdio: 'inherit' });
} else {
  try {
    execSync('node esbuild.config.mjs', { stdio: 'inherit' });
  } catch {
    execSync('deno run -A esbuild.config.mjs', { stdio: 'inherit' });
  }
}

if (fs.existsSync(STAGING)) {
  fs.rmSync(STAGING, { recursive: true, force: true });
}
fs.mkdirSync(STAGING, { recursive: true });

const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher || 'local'}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>${(pkg.keywords || []).join(',')}</Tags>
    <Categories>${(pkg.categories || ['Other']).join(',')}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;

const contentTypesContent = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".cjs" ContentType="application/octet-stream"/>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`;

fs.writeFileSync(path.join(STAGING, 'extension.vsixmanifest'), manifestContent, 'utf8');
fs.writeFileSync(path.join(STAGING, '[Content_Types].xml'), contentTypesContent, 'utf8');

const extDir = path.join(STAGING, 'extension');
fs.mkdirSync(extDir, { recursive: true });
fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'resources'), { recursive: true });

fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(extDir, 'package.json'));
fs.copyFileSync(path.join(ROOT, 'dist', 'extension.cjs'), path.join(extDir, 'dist', 'extension.cjs'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(extDir, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(extDir, 'LICENSE'));

for (const file of fs.readdirSync(path.join(ROOT, 'resources'))) {
  fs.copyFileSync(path.join(ROOT, 'resources', file), path.join(extDir, 'resources', file));
}

console.log('Archiving into vsix...');
const targetVsix = path.join(ROOT, VSIX_NAME);
if (fs.existsSync(targetVsix)) {
  fs.unlinkSync(targetVsix);
}

if (process.platform === 'win32') {
  const escapedStaging = STAGING.replace(/'/g, "''");
  const escapedTarget = targetVsix.replace(/'/g, "''");
  const psCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${escapedStaging}', '${escapedTarget}')"`;
  execSync(psCmd, { stdio: 'inherit' });
} else {
  execSync(`cd "${STAGING}" && zip -r "${targetVsix}" .`, { stdio: 'inherit' });
}
fs.rmSync(STAGING, { recursive: true, force: true });
console.log(`Successfully built ${VSIX_NAME}`);
