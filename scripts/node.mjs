// Run Node with the version this project needs, whatever Node is installed.
//
// Usage: node scripts/node.mjs <node arguments…>   (all npm scripts go through this)
// If the current Node is new enough it is used directly. Otherwise the official Node build from
// nodejs.org is downloaded once into .node/ (git-ignored), checked against the SHA-256 checksums
// pinned below, and used instead. No global install, nothing outside the project folder changes.
//
// Deliberately written for old Node versions too (14+): no fetch, no newer syntax.
// To update: set VERSION and copy the matching lines from https://nodejs.org/dist/v<VERSION>/SHASUMS256.txt
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { get } from "node:https";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_MAJOR = 22;
const VERSION = "22.23.3";
const SHA256 = {
  "darwin-arm64.tar.gz": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
  "darwin-x64.tar.gz": "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
  "linux-arm64.tar.gz": "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
  "linux-x64.tar.gz": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
  "win-arm64.zip": "33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535",
  "win-x64.zip": "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
};

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".node");

function die(msg) {
  console.error(`scripts/node.mjs: ${msg}`);
  process.exit(1);
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).href, file).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url}: HTTP ${res.statusCode}`)); }
      const out = createWriteStream(file);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function projectNode() {
  const os = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
  const ext = os === "win" ? "zip" : "tar.gz";
  const asset = `${os}-${process.arch}.${ext}`;
  if (!SHA256[asset]) die(`no Node ${VERSION} build pinned for ${process.platform}-${process.arch}; install Node ${MIN_MAJOR}+ yourself.`);
  const name = `node-v${VERSION}-${os}-${process.arch}`;
  const bin = os === "win" ? join(CACHE, name, "node.exe") : join(CACHE, name, "bin", "node");
  if (existsSync(bin)) return bin;

  const archive = join(CACHE, `${name}.${ext}`);
  const tmp = join(CACHE, `${name}.tmp`);
  console.error(`Node ${process.versions.node} is too old (need ${MIN_MAJOR}+). Downloading Node ${VERSION} into .node/ (one time) …`);
  mkdirSync(CACHE, { recursive: true });
  try {
    await download(`https://nodejs.org/dist/v${VERSION}/${name}.${ext}`, archive);
    const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (hash !== SHA256[asset]) throw new Error(`checksum mismatch for ${archive} – download discarded`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    // tar ships with macOS, Linux and Windows 10+. On Windows use the system tar.exe explicitly:
    // it unpacks .zip, the GNU tar that Git Bash puts on PATH does not.
    const tarCmd = os === "win" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const tar = spawnSync(tarCmd, ["-xf", archive, "-C", tmp], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error("could not unpack the archive with tar");
    renameSync(join(tmp, name), join(CACHE, name));
  } catch (e) {
    die(`${e.message}\nInstall Node ${MIN_MAJOR}+ yourself instead (e.g. nvm install ${MIN_MAJOR}).`);
  } finally {
    rmSync(archive, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

const major = Number(process.versions.node.split(".")[0]);
const node = major >= MIN_MAJOR ? process.execPath : await projectNode();
// Put the chosen Node first on PATH, so tools that start "node" themselves (e.g. Wrangler) use it too.
const env = Object.assign({}, process.env);
const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH") || "PATH";
env[pathKey] = join(node, "..") + delimiter + (env[pathKey] || "");
const run = spawnSync(node, process.argv.slice(2), { stdio: "inherit", env });
if (run.error) die(run.error.message);
process.exit(run.status === null ? 1 : run.status);
