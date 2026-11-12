import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const binary = fileURLToPath(new URL("../bin/terraform-provider-codetelemetry", import.meta.url));
mkdirSync(new URL("../bin/", import.meta.url), { recursive: true });

// Build the Terraform provider's implementation; never copy or reimplement its
// API behavior. CODETELEMETRY_PROVIDER_DIR builds a local checkout; otherwise
// the pinned public revision is fetched and built. Keep PROVIDER_REF in step
// with the provider revision this integration is tested against.
const PROVIDER_REPOSITORY = "https://github.com/CodeTelemetry/terraform-provider-codetelemetry.git";
const PROVIDER_REF = process.env.CODETELEMETRY_PROVIDER_REF || "2d1437dd743e05a3698158a4492191c4bf222285";
if (!/^[a-f0-9]{40}$/.test(PROVIDER_REF)) throw Error("CODETELEMETRY_PROVIDER_REF must be a full commit SHA");
function buildProvider(directory) {
  execFileSync(process.env.GO_BINARY || "go", [
    "build", `-ldflags=-X main.version=${process.env.PROVIDER_VERSION || "0.1.0"}`, "-o", binary, ".",
  ], { cwd: directory, stdio: "inherit", timeout: 300_000 });
}
if (process.env.CODETELEMETRY_PROVIDER_DIR) {
  buildProvider(process.env.CODETELEMETRY_PROVIDER_DIR);
} else {
  const source = mkdtempSync(join(tmpdir(), "codetelemetry-provider-source-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "inherit", timeout: 300_000 });
    git("init", "--quiet");
    git("fetch", "--quiet", "--depth", "1", PROVIDER_REPOSITORY, PROVIDER_REF);
    git("checkout", "--quiet", "--detach", "FETCH_HEAD");
    buildProvider(source);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

// A relative path keeps the project portable; regenerate the SDK on each host.
// SDK generation needs no cloud account or persistent stack backend.
const scratch = mkdtempSync(join(tmpdir(), "codetelemetry-pulumi-setup-"));
try {
  execFileSync(process.env.PULUMI_BINARY || "pulumi", [
    "package", "gen-sdk", "terraform-provider@1.5.0",
    "--language", "nodejs", "--local", "--out", scratch,
    "--non-interactive", "--", "./bin/terraform-provider-codetelemetry",
  ], {
    cwd: project, stdio: "inherit", timeout: 300_000,
    env: { ...process.env, PULUMI_BACKEND_URL: pathToFileURL(scratch).href },
  });
  const sdk = new URL("../sdks/codetelemetry/", import.meta.url);
  rmSync(sdk, { recursive: true, force: true });
  cpSync(join(scratch, "nodejs"), fileURLToPath(sdk), { recursive: true });
  // Keep generated npm metadata in the project namespace, including local SDKs.
  const manifest = new URL("package.json", sdk);
  const metadata = JSON.parse(readFileSync(manifest, "utf8"));
  metadata.name = "@codetelemetry/pulumi-codetelemetry";
  metadata.license = "MPL-2.0";
  writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n");
  cpSync(new URL("../LICENSE", import.meta.url), new URL("LICENSE", sdk));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Install from the committed lockfile. `package add` runs npm install, which can
// rewrite local-package metadata differently between npm major versions.
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
  cwd: project, stdio: "inherit", timeout: 300_000,
});
