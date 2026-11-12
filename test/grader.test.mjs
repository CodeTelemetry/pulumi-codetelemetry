import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const sample = JSON.parse(await readFile(new URL("../examples/grader-checks.json", import.meta.url), "utf8"));

// Real Pulumi YAML runtime + pinned bridge + local provider, including the
// artifact emitted by the MCP when CODETELEMETRY_MCP_ROOT is supplied.
test("Pulumi Grader artifact lifecycle preserves unrelated checks and published policy", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ct-grader-pulumi-"));
  const cwd = join(root, "project"); const backend = join(root, "backend");
  await mkdir(cwd); await mkdir(backend);
  await symlink(join(project, "bin"), join(cwd, "bin"), "dir");
  let checks = [{ ...sample[0], id: "unrelated", name: "Unrelated check" }];
  let writes = 0; let conflict = false; let serverFailure;
  const token = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ iss: "https://cognito-idp.example.test/pool", sub: "grader", token_use: "id" })).toString("base64url") + ".synthetic";
  const revision = () => createHash("sha256").update(JSON.stringify(checks)).digest("hex");
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/validation/policy" && req.method === "GET") {
        res.end(JSON.stringify({ revision: revision(), draft: { checks, requestedFeatures: "Keep existing focus" }, published: { version: 7 } })); return;
      }
      assert.equal(req.url, "/api/validation/policy/draft"); assert.equal(req.method, "PUT");
      let body = ""; for await (const chunk of req) { body += chunk; assert.ok(body.length <= 350000); }
      const input = JSON.parse(body);
      assert.deepEqual(Object.keys(input).sort(), ["checks", "expectedRevision"]);
      if (conflict || input.expectedRevision !== revision()) { res.writeHead(409).end("{}"); return; }
      checks = input.checks; writes++;
      res.end(JSON.stringify({ draft: { checks, requestedFeatures: "Keep existing focus" } }));
    } catch (error) { serverFailure = error; res.writeHead(500).end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, CODETELEMETRY_TOKEN: token, CODETELEMETRY_ENDPOINT: `http://127.0.0.1:${server.address().port}`, PULUMI_BACKEND_URL: pathToFileURL(backend).href, PULUMI_CONFIG_PASSPHRASE: randomBytes(24).toString("hex"), PULUMI_SKIP_UPDATE_CHECK: "true" };
  for (const key of ["PULUMI_ACCESS_TOKEN", "PULUMI_CONFIG", "PULUMI_STACK"]) delete env[key];
  async function cli(...args) {
    const result = await exec(process.env.PULUMI_BINARY || "pulumi", [...args, "--non-interactive", "--color", "never"], { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    if (serverFailure) throw serverFailure;
    assert.ok(!result.stdout.includes(token)); return result.stdout;
  }
  let program;
  const initial = structuredClone(sample);
  initial[0].description = 'Literal ${notAReference} and %{if true} from instructions';
  if (process.env.CODETELEMETRY_MCP_ROOT) {
    // Call the public MCP tool, including its input checks and no-key path.
    const { callTool } = await import(pathToFileURL(join(process.env.CODETELEMETRY_MCP_ROOT, "dist/src/tools.js")));
    const { OnboardingSession } = await import(pathToFileURL(join(process.env.CODETELEMETRY_MCP_ROOT, "dist/src/session.js")));
    await writeFile(join(cwd, "Pulumi.yaml"), "name: surrounding-python-project\nruntime: python\n");
    const result = await callTool("write_grader_config_artifact", { repositoryPath: cwd, features: "Tests from AGENTS.md", checks: initial }, { session: new OnboardingSession() });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.artifact.format, "pulumi");
    program = JSON.parse(await readFile(result.artifact.path, "utf8"));
  } else {
    program = { name: "codetelemetry-grader", runtime: "yaml", packages: { codetelemetry: { source: "terraform-provider", version: "1.5.0", parameters: ["./bin/terraform-provider-codetelemetry"] } }, resources: { grader: { type: "codetelemetry:index/graderConfig:GraderConfig", properties: {} } } };
  }
  const save = async checks => {
    program.resources.grader.properties.checksJson = { "fn::secret": JSON.stringify(checks).replaceAll("${", () => "$${") };
    await writeFile(join(cwd, "Pulumi.yaml"), JSON.stringify(program, null, 2));
  };
  const up = () => cli("up", "--yes", "--skip-preview", "--stack", "test");
  try {
    if (process.env.CODETELEMETRY_MCP_ROOT) await writeFile(join(cwd, "Pulumi.yaml"), JSON.stringify(program, null, 2));
    else await save(initial);
    await cli("install");
    await cli("stack", "init", "test", "--secrets-provider", "passphrase");
    await cli("preview", "--stack", "test"); assert.equal(writes, 0);
    await up(); assert.deepEqual(checks.find(c => c.id === sample[0].id), initial[0]); assert.equal(checks.length, 2);
    const checkpoint = JSON.parse(await cli("stack", "export", "--stack", "test"));
    const managed = checkpoint.deployment.resources.find(r => r.type === "codetelemetry:index/graderConfig:GraderConfig");
    assert.ok(managed.outputs.checksJson.ciphertext, "Grader JSON must be encrypted");
    const stable = writes; await cli("preview", "--expect-no-changes", "--stack", "test"); assert.equal(writes, stable);
    const next = [{ ...initial[0], weight: 2 }]; await save(next); conflict = true;
    await assert.rejects(up, error => /HTTP 409/.test(error.stdout + error.stderr)); assert.equal(writes, stable);
    conflict = false; await up(); assert.equal(checks.find(c => c.id === next[0].id).weight, 2);
    checks.find(c => c.id === next[0].id).weight = 8;
    const beforeRefresh = writes; await cli("refresh", "--yes", "--stack", "test"); assert.equal(writes, beforeRefresh);
    await up(); assert.equal(checks.find(c => c.id === next[0].id).weight, 2);
    await cli("destroy", "--yes", "--stack", "test"); assert.deepEqual(checks.map(c => c.id), ["unrelated"]);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});
