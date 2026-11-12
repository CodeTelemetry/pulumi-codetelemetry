import * as pulumi from "@pulumi/pulumi";
import * as codetelemetry from "@codetelemetry/pulumi-codetelemetry";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = new pulumi.Config();
const provider = new codetelemetry.Provider("workspace", {
  endpoint: config.get("endpoint"),
  token: config.getSecret("token"),
  organizationId: config.get("organizationId"),
  workspace: config.get("workspace"),
});

// The complete AlertRule example matches the Terraform provider's. Set rulesPath to a JSON
// file of your own; its path is relative to this Pulumi project.
const rulesPath = config.get("rulesPath") ?? "examples/rules.json";
const rulesJson = JSON.stringify(JSON.parse(readFileSync(resolve(rulesPath), "utf8")));
const protect = config.getBoolean("protect") ?? false;

const graderOnly = config.getBoolean("graderOnly") ?? false;
const alarms = graderOnly ? undefined : new codetelemetry.AlarmRules("alarms", {
  rulesJson: pulumi.secret(rulesJson),
}, {
  provider,
  protect,
  import: config.getBoolean("importAlarms") ? "workspace" : undefined,
});

const enrichment = graderOnly ? undefined : new codetelemetry.EnrichmentConfig("enrichment", {
  mintFloor: config.getNumber("mintFloor") ?? 0.6,
  mergeThreshold: config.getNumber("mergeThreshold") ?? 0.86,
  consolidationCadence: config.get("consolidationCadence") ?? "nightly",
  budgetPct: config.getNumber("budgetPct") ?? 0.25,
}, {
  provider,
  protect,
  import: config.getBoolean("importEnrichment") ? "workspace" : undefined,
});

export const alarmRevision = alarms?.revision;
export const enrichmentRevision = enrichment?.configRevision;

// Context credentials support Grader configuration without a pasted JWT.
const graderChecksPath = config.get("graderChecksPath");
const grader = graderChecksPath ? new codetelemetry.GraderConfig("grader", {
  checksJson: pulumi.secret(JSON.stringify(JSON.parse(readFileSync(resolve(graderChecksPath), "utf8")))),
}, {provider,protect,import:config.getBoolean("importGrader")?"workspace":undefined}) : undefined;
export const graderRevision=grader?.revision;
