/* eslint-disable no-undef */
import fs from "fs";
import path from "path";
import https from "https";

// 1. Copy templates
fs.mkdirSync("dist/templates", { recursive: true });
fs.copyFileSync("src/templates/skill.md", "dist/templates/skill.md");

// 2. Copy LICENSE from project root to package root so it gets published
const rootLicensePath = path.resolve("../../LICENSE");
if (fs.existsSync(rootLicensePath)) {
  fs.copyFileSync(rootLicensePath, "LICENSE");
} else {
  console.warn("⚠ Root LICENSE file not found at " + rootLicensePath);
}

// 3. Download WASM grammars for offline usage
const parsersDir = "dist/parsers";
fs.mkdirSync(parsersDir, { recursive: true });

const grammars = ["typescript", "tsx", "javascript"];
const baseUrl = "https://unpkg.com/tree-sitter-wasms/out/";

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        file.close();
        let redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error("Redirect header missing"));
          return;
        }
        if (redirectUrl.startsWith("/")) {
          const parsedUrl = new URL(url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        const resolvedUrl = redirectUrl;
        file.on("close", () => {
          downloadFile(resolvedUrl, dest).then(resolve).catch(reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function bundleGrammars() {
  console.log("📦 Downloading WASM grammars for offline parsing...");
  for (const lang of grammars) {
    const dest = path.join(parsersDir, `tree-sitter-${lang}.wasm`);
    const url = `${baseUrl}tree-sitter-${lang}.wasm`;
    try {
      await downloadFile(url, dest);
      console.log(`✓ Bundled parser: tree-sitter-${lang}.wasm`);
    } catch (err) {
      console.error(`✗ Failed to download grammar ${lang}: ${err.message}`);
      process.exit(1);
    }
  }

  const destRuntime = "dist/tree-sitter.wasm";
  const localPaths = [
    "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    "../../node_modules/web-tree-sitter/web-tree-sitter.wasm"
  ];

  let foundLocally = false;
  for (const localPath of localPaths) {
    if (fs.existsSync(localPath)) {
      fs.copyFileSync(localPath, destRuntime);
      console.log(`✓ Bundled runtime from local file: ${localPath} -> ${destRuntime}`);
      foundLocally = true;
      break;
    }
  }

  if (!foundLocally) {
    console.log("📦 Downloading WASM runtime from CDN...");
    const cdnUrls = [
      "https://unpkg.com/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
      "https://unpkg.com/web-tree-sitter/web-tree-sitter.wasm"
    ];

    let downloaded = false;
    for (const url of cdnUrls) {
      try {
        console.log(`Trying CDN URL: ${url}`);
        await downloadFile(url, destRuntime);
        console.log(`✓ Bundled runtime (downloaded): ${url} -> ${destRuntime}`);
        downloaded = true;
        break;
      } catch (err) {
        console.warn(`⚠ Failed download from ${url}: ${err.message}`);
      }
    }

    if (!downloaded) {
      console.error("✗ Failed to find or download tree-sitter.wasm runtime.");
      process.exit(1);
    }
  }
}

await bundleGrammars();
