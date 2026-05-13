import fs from "fs";
import path from "path";
import fg from "fast-glob";
import ignorePkg, { Ignore } from "ignore";

// Workaround for ignore's CJS typings in NodeNext ESM resolution
const createIgnore = (
  typeof ignorePkg === "function"
    ? ignorePkg
    : (ignorePkg as unknown as { default: () => Ignore }).default
) as () => Ignore;

const SUPPORTED_EXTENSIONS = [
  // Code & Data
  'ts', 'js', 'tsx', 'jsx', 'json', 'md',
  // Images
  'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp',
  // Video & Audio
  'mp4', 'webm', 'mp3', 'wav'
];

export async function scanDirectory(targetDir: string): Promise<string[]> {
  const ig: Ignore = createIgnore();

  // Load .gitignore if it exists
  const gitignorePath = path.resolve(targetDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  // Load .geraphignore if it exists
  const geraphignorePath = path.resolve(targetDir, ".geraphignore");
  if (fs.existsSync(geraphignorePath)) {
    ig.add(fs.readFileSync(geraphignorePath, "utf8"));
  }

  // Always ignore node_modules and typical build directories
  ig.add(["node_modules", "dist", ".git", ".turbo", "build"]);

  // We need to look for files recursively
  const globPatterns = SUPPORTED_EXTENSIONS.map((ext) => `**/*.${ext}`);

  // Perform the glob search.
  // Note: fast-glob REQUIRES forward slashes even on Windows.
  const normalizedCwd = targetDir.split(path.sep).join("/");

  const allFiles = await fg(globPatterns, {
    cwd: normalizedCwd,
    dot: true,
    absolute: false,
  });

  // Filter out the files using the `ignore` instance
  const validRelativeFiles = ig.filter(allFiles);

  // Convert back to absolute paths using system separators
  return validRelativeFiles.map((file) => path.resolve(targetDir, file));
}
