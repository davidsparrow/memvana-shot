const MIN_MAJOR = 22;
const MIN_MINOR = 13;

/** node:sqlite needs Node 22.13+; fail with a readable message instead of a stack trace. */
export function assertNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) return;
  console.error(
    `memvana-shot needs Node.js ${MIN_MAJOR}.${MIN_MINOR} or later (found ${process.versions.node}). ` +
      "Install a current Node.js from https://nodejs.org and restart Claude.",
  );
  process.exit(1);
}
