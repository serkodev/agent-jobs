import { readFile } from "node:fs/promises";
import { join } from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("Codex project integration", () => {
  it("routes marker prompts to the batch skill", async () => {
    const agents = await text("AGENTS.md");
    const skill = await text(".agents/skills/batch-tasks/SKILL.md");

    for (const marker of ["INPUT_DATA", "TASK_SPEC", "ID_COLUMN_KEY", "OUTPUT_DIR"]) {
      expect(agents).toContain(`${marker}:`);
      expect(skill).toContain(`\`${marker}\``);
    }
    expect(agents).toContain(".agents/skills/batch-tasks/SKILL.md");
    expect(skill).toContain("pnpm --silent batch-tasks prepare");
    expect(skill).toContain('fork_turns: "none"');
    expect(skill).toContain("result_json");
    expect(skill).not.toContain("uv run");
  });

  it("registers the required TypeScript stdio MCP server", async () => {
    const config = await text(".codex/config.toml");

    expect(config).toContain("[mcp_servers.batch_tasks]");
    expect(config).toContain('command = "pnpm"');
    expect(config).toContain('args = ["--silent", "batch-tasks", "mcp"]');
    expect(config).toContain("required = true");
    expect(config).toContain('default_tools_approval_mode = "auto"');
    expect(config).toContain(
      'enabled_tools = ["get_assignment", "submit_result", "report_failure"]',
    );
  });

  it("keeps row workers fresh, read-only, and narrowly configured", async () => {
    const worker = await text(".codex/agents/batch_worker.toml");

    expect(worker).toContain('sandbox_mode = "read-only"');
    expect(worker).toContain('web_search = "disabled"');
    expect(worker).toContain("apps = false");
    expect(worker).toContain("memories = false");
    expect(worker).toContain("multi_agent = false");
    expect(worker).toContain("shell_tool = false");
    expect(worker).toContain("unified_exec = false");
    expect(worker).toContain('command = "pnpm"');
    expect(worker).toContain('required = true');
    expect(worker).toContain(
      'enabled_tools = ["get_assignment", "submit_result", "report_failure"]',
    );
    expect(worker).toContain('default_tools_approval_mode = "auto"');
    expect(worker).toContain("result_json");
    expect(worker).not.toMatch(/^model\s*=/m);
    expect(worker).not.toMatch(/^model_reasoning_effort\s*=/m);
  });

  it("ships valid skill UI metadata", async () => {
    const metadata = YAML.parse(
      await text(".agents/skills/batch-tasks/agents/openai.yaml"),
    ) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      interface: {
        display_name: "Batch Tasks",
      },
      policy: {
        allow_implicit_invocation: true,
      },
    });
  });
});
