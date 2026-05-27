import fs from "fs";
import path from "path";

// 1. Copy templates
fs.mkdirSync("dist/templates", { recursive: true });
fs.copyFileSync("src/templates/skill.md", "dist/templates/skill.md");

// 2. Copy LICENSE from project root to package root so it gets published
const rootLicensePath = path.resolve("../../LICENSE");
if (fs.existsSync(rootLicensePath)) {
  fs.copyFileSync(rootLicensePath, "LICENSE");
} else {
  // eslint-disable-next-line
  console.warn("⚠ Root LICENSE file not found at " + rootLicensePath);
}

