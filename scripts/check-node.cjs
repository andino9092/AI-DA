// Runs before dev/build. Kept as plain CommonJS so it works on any Node version,
// turning Vite's cryptic "crypto.hash is not a function" into a clear message.
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 12);

if (!ok) {
  console.error(
    `\nAI-DA needs Node 22.12+ (24 recommended), but this terminal is running Node ${process.versions.node}.\n` +
      'Update Node with: winget install --id OpenJS.NodeJS.LTS -e\n',
  );
  process.exit(1);
}
