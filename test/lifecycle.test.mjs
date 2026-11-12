import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("../examples/rules.json", import.meta.url));

// Actual Pulumi CLI + Terraform bridge + shared provider. All HTTP and state are
// local; never load the caller's endpoint, token, stack, or backend.
test("Pulumi workspace lifecycle, adoption, drift, conflicts, and secrets", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codetelemetry-pulumi-test-"));
  const cwd = join(root, "project");
  const backend = join(root, "backend");
  await mkdir(cwd); await mkdir(backend);
  for (const file of ["Pulumi.yaml", "package.json", "tsconfig.json", "index.ts"]) {
    await copyFile(join(project, file), join(cwd, file));
  }
  for (const directory of ["bin", "sdks", "node_modules"]) {
    await symlink(join(project, directory), join(cwd, directory), "dir");
  }

  let rules = [];
  let revision = 0;
  let enrichment = { mintFloor: 0.6, mergeThreshold: 0.86, consolidationCadence: "nightly", budgetPct: 0.25, configRev: 1 };
  let writes = 0;
  let forceConflict = false;
  const idToken = (subject,nonce) => "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({
    iss:"https://cognito-idp.example.test/pool",sub:subject,token_use:"id",nonce,
  })).toString("base64url") + ".local-test-signature";
  const token = idToken("workspace-a","original");
  const webhookSecret = "local-webhook-secret-do-not-persist-in-plaintext";
  const sample = JSON.parse(await readFile(fixture, "utf8"));
  sample[0].channels.push({ type: "webhook", url: `https://example.com/hooks/${webhookSecret}` });
  const rulesFile = join(root, "rules.json");
  await writeFile(rulesFile, JSON.stringify(sample));

  const server = createServer(async (req, res) => {
    try {
      const supplied = req.headers.authorization?.slice("Bearer ".length);
      const claims = JSON.parse(Buffer.from(supplied.split(".")[1],"base64url").toString());
      assert.equal(claims.sub,"workspace-a","a different workspace reached HTTP");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) <= 350000);
      }
      const input = body ? JSON.parse(body) : undefined;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/alert-rules") {
        if (req.method === "PUT") {
          assert.ok(Number.isInteger(input.rev), "writes must carry a revision");
          if (forceConflict || input.rev !== revision) {
            res.writeHead(409).end(JSON.stringify({ error: "configuration changed" })); return;
          }
          assert.ok(Array.isArray(input.rules) && input.rules.length <= 60);
          rules = input.rules; revision++; writes++;
        }
        res.end(JSON.stringify({ rules, rev: revision }));
      } else if (req.url === "/api/enrichment-config") {
        if (req.method === "PUT") {
          assert.equal(input.configRev, undefined, "revision is server-owned");
          enrichment = { ...input, configRev: enrichment.configRev + 1 }; writes++;
        }
        res.end(JSON.stringify(enrichment));
      } else { res.writeHead(404).end("{}"); }
    } catch (error) {
      res.writeHead(500).end("{}");
      serverFailure = error;
    }
  });
  let serverFailure;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    PULUMI_BACKEND_URL: pathToFileURL(backend).href,
    PULUMI_CONFIG_PASSPHRASE: randomBytes(24).toString("hex"),
    PULUMI_SKIP_UPDATE_CHECK: "true",
    CODETELEMETRY_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    CODETELEMETRY_TOKEN: token,
  };
  delete env.PULUMI_ACCESS_TOKEN;
  delete env.PULUMI_CONFIG;
  delete env.PULUMI_STACK;
  const stack = "lifecycle";
  async function pulumi(...args) {
    const result = await exec(process.env.PULUMI_BINARY || "pulumi", [
      ...args, "--non-interactive", "--color", "never",
    ], { cwd, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (serverFailure) throw serverFailure;
    assert.ok(!result.stdout.includes(token) && !result.stdout.includes(webhookSecret), "CLI leaked secrets");
    return result.stdout;
  }
  const config = (key, value) => pulumi("config", "set", key, String(value), "--stack", stack);
  const up = () => pulumi("up", "--yes", "--skip-preview", "--stack", stack);

  try {
    await pulumi("stack", "init", stack, "--secrets-provider", "passphrase");
    await config("rulesPath", rulesFile);
    // Put the token in encrypted provider configuration too, to test both SDK
    // secret propagation and the environment fallback used by the HTTP client.
    await pulumi("config", "set", "token", token, "--secret", "--stack", stack);
    const initialWrites = writes;
    await pulumi("preview", "--stack", stack);
    assert.equal(writes, initialWrites, "preview performed a write");
    await up();
    assert.deepEqual(rules, sample);
    assert.equal(revision, 1);
    assert.equal(enrichment.budgetPct, 0.25);

    let exported = await pulumi("stack", "export", "--stack", stack);
    assert.ok(!exported.includes(webhookSecret) && !exported.includes(token));
    const checkpoint = JSON.parse(exported);
    const alarm = checkpoint.deployment.resources.find((r) => r.type === "codetelemetry:index/alarmRules:AlarmRules");
    assert.ok(alarm?.outputs.rulesJson.ciphertext, "alarm JSON was not encrypted in state");

    // Renewed tokens retain identity; a different tenant must fail before HTTP.
    await pulumi("config", "set", "token", idToken("workspace-a","renewed"), "--secret", "--stack", stack);
    await up();
    await pulumi("preview", "--expect-no-changes", "--stack", stack);
    await pulumi("config", "set", "token", idToken("workspace-b","different"), "--secret", "--stack", stack);
    const beforeScopeChange = writes;
    await config("budgetPct", 0.4);
    await assert.rejects(up, (error) => /workspace identity changed/.test(error.stdout+error.stderr));
    assert.equal(writes,beforeScopeChange);
    await pulumi("config", "set", "token", token, "--secret", "--stack", stack);
    await config("budgetPct", 0.25);
    await up();

    // Changes to both resource types exercise the bridge's update path.
    sample[0].tql.threshold = 200;
    await writeFile(rulesFile, JSON.stringify(sample));
    await config("budgetPct", 0.4);
    await up();
    assert.equal(revision, 2);
    assert.equal(rules[0].tql.threshold, 200);
    assert.equal(enrichment.budgetPct, 0.4);
    const stableWrites = writes;
    await pulumi("preview", "--expect-no-changes", "--stack", stack);
    assert.equal(writes, stableWrites);

    // Zero is a configured budget fraction, not a request for service defaults.
    await config("budgetPct", 0);
    await up();
    assert.equal(enrichment.budgetPct, 0);
    await pulumi("preview", "--expect-no-changes", "--stack", stack);
    await config("budgetPct", 0.4);
    await up();

    // Refuse a conflicting write; no blind retry or accidental overwrite.
    sample[0].tql.threshold = 300;
    await writeFile(rulesFile, JSON.stringify(sample));
    forceConflict = true;
    await assert.rejects(up, (error) => /HTTP 409/.test(error.stdout + error.stderr));
    forceConflict = false;
    assert.equal(revision, 2);
    assert.equal(rules[0].tql.threshold, 200);
    await up();
    assert.equal(revision, 3);

    rules = []; revision++; enrichment.budgetPct = 0.9;
    const driftWrites = writes;
    await pulumi("refresh", "--yes", "--stack", stack);
    assert.equal(writes, driftWrites, "refresh performed a write");
    await up();
    assert.deepEqual(rules, sample);
    assert.equal(enrichment.budgetPct, 0.4);

    await pulumi("destroy", "--yes", "--stack", stack);
    assert.deepEqual(rules, []);
    assert.deepEqual({ ...enrichment, configRev: 1 }, { mintFloor: 0.6, mergeThreshold: 0.86, consolidationCadence: "nightly", budgetPct: 0.25, configRev: 1 });

    // Adopt preexisting singleton settings without writing them.
    rules = structuredClone(sample); revision++;
    enrichment.budgetPct = 0.4;
    await config("importAlarms", true);
    await config("importEnrichment", true);
    const adoptionWrites = writes;
    await up();
    assert.equal(writes, adoptionWrites, "adoption rewrote configuration");
    await pulumi("destroy", "--yes", "--stack", stack);
    assert.deepEqual(rules, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
