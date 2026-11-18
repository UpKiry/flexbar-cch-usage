const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 插件包需要同时携带 macOS 与 Windows 的原生模块，因此这里按固定清单同步，
// 而不是只同步当前构建平台。Linux（CI）通过 npm 下载对应平台的预编译包。
const NATIVE_PACKAGES = [
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-win32-x64-msvc",
];

const canvasVersion = require("@napi-rs/canvas/package.json").version;
const targetRoot = path.resolve(
  __dirname,
  "../com.upkiry.flexbarcchusage.plugin/backend/node_modules",
);
const staleMap = path.resolve(__dirname, "../com.upkiry.flexbarcchusage.plugin/backend/plugin.cjs.map");
if (fs.existsSync(staleMap)) fs.rmSync(staleMap);

function resolveLocalPackage(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

function npmPack(spec, tempDir, cacheDir) {
  execFileSync(
    "npm",
    ["pack", spec, "--cache", cacheDir, "--pack-destination", tempDir, "--silent"],
    { stdio: "inherit" },
  );
}

function fetchPackage(name) {
  const spec = `${name}@${canvasVersion}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-canvas-"));
  console.log(`下载 canvas 原生模块：${spec}`);

  // 优先复用 npm 全局缓存；若缓存目录不可写（权限异常等），回退到临时缓存目录。
  const cacheDir = process.env.npm_config_cache || path.join(tempDir, "npm-cache");
  try {
    npmPack(spec, tempDir, cacheDir);
  } catch {
    console.warn(`缓存目录不可用，改用临时缓存重试：${cacheDir}`);
    npmPack(spec, tempDir, path.join(tempDir, "npm-cache"));
  }

  const tarball = fs
    .readdirSync(tempDir)
    .find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack 未生成压缩包：${spec}`);
  const extractDir = path.join(tempDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(tempDir, tarball), "-C", extractDir]);
  return path.join(extractDir, "package");
}

for (const name of NATIVE_PACKAGES) {
  const source = resolveLocalPackage(name) ?? fetchPackage(name);
  const target = path.join(targetRoot, name);
  fs.mkdirSync(target, { recursive: true });

  const nativeBinary = fs
    .readdirSync(source)
    .find((file) => file.endsWith(".node"));
  if (!nativeBinary) throw new Error(`canvas 原生模块缺少二进制文件：${name}`);

  for (const file of ["package.json", nativeBinary, "icudtl.dat"]) {
    const sourceFile = path.join(source, file);
    if (fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(target, file));
  }
  console.log(`已同步 canvas 原生模块：${name}`);
}
