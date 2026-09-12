const fs = require("node:fs");
const path = require("node:path");

const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = {
  "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
  "darwin-x64": "@napi-rs/canvas-darwin-x64",
  "win32-x64": "@napi-rs/canvas-win32-x64-msvc",
  "win32-arm64": "@napi-rs/canvas-win32-arm64-msvc",
}[platformKey];

if (!platformPackage) {
  // Linux is used by the release workflow only as a packaging runner. The
  // distributable already contains the macOS and Windows native modules, so
  // there is no Linux binary to synchronize into the plugin bundle.
  console.log(`跳过 canvas 原生模块同步：${platformKey}（使用包内现有平台模块）`);
  process.exit(0);
}

const source = path.dirname(require.resolve(`${platformPackage}/package.json`));
const target = path.resolve(__dirname, "../com.upkiry.flexbarcchusage.plugin/backend/node_modules", platformPackage);
const staleMap = path.resolve(__dirname, "../com.upkiry.flexbarcchusage.plugin/backend/plugin.cjs.map");
if (fs.existsSync(staleMap)) fs.rmSync(staleMap);
fs.mkdirSync(target, { recursive: true });
const nativeBinary = fs.readdirSync(source).find((name) => name.endsWith(".node"));
if (!nativeBinary) throw new Error(`canvas 原生模块缺少二进制文件：${platformPackage}`);
for (const file of ["package.json", nativeBinary, "icudtl.dat"]) {
  const sourceFile = path.join(source, file);
  if (fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(target, file));
}
console.log(`已同步 canvas 原生模块：${platformPackage}`);
