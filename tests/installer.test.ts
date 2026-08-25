import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { AgentJobsRuntime } from '@agent-jobs/runtime';

import { runInstallerCommand } from '../src/installer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(): {
  stream: Pick<NodeJS.WritableStream, 'write'>;
  read: () => string;
} {
  let value = '';
  return {
    stream: {
      write(chunk: unknown): boolean {
        value += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WritableStream, 'write'>,
    read: () => value,
  };
}

async function fixture(): Promise<{
  root: string;
  cwd: string;
  home: string;
  bundle: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'batch-installer-test-'));
  roots.push(root);
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  const bundle = join(root, 'agent-jobs.mjs');
  await mkdir(cwd);
  await mkdir(home);
  await writeFile(bundle, '#!/usr/bin/env node\nconsole.log("bundle");\n', 'utf8');
  return {
    root,
    cwd: await realpath(cwd),
    home: await realpath(home),
    bundle,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('agent-jobs installer', () => {
  it('uses cwd by default and installs both hosts with absolute script paths', async () => {
    const context = await fixture();
    const stdout = capture();
    const stderr = capture();

    await expect(
      runInstallerCommand('init', ['--yes', '--json'], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: stdout.stream,
        stderr: stderr.stream,
        isTTY: false,
      }),
    ).resolves.toBe(0);

    const result = JSON.parse(stdout.read()) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      status: 'initialized',
      path: context.cwd,
      scope: 'project',
      targets: ['codex', 'claude'],
      create: false,
    });
    const codexScript = join(
      context.cwd,
      '.agents',
      'skills',
      'agent-jobs',
      'scripts',
      'agent-jobs.mjs',
    );
    const claudeScript = join(
      context.cwd,
      '.claude',
      'skills',
      'agent-jobs',
      'scripts',
      'agent-jobs.mjs',
    );
    await expect(readFile(codexScript, 'utf8')).resolves.toContain('#!/usr/bin/env node');
    await expect(readFile(claudeScript, 'utf8')).resolves.toContain('#!/usr/bin/env node');

    const agents = await readFile(join(context.cwd, 'AGENTS.md'), 'utf8');
    const codexSkill = await readFile(
      join(context.cwd, '.agents', 'skills', 'agent-jobs', 'SKILL.md'),
      'utf8',
    );
    for (const marker of ['INPUT_DATA', 'TASK_SPEC', 'ID_COLUMN_KEY', 'OUTPUT_DIR']) {
      expect(agents).toContain(`${marker}:`);
      expect(codexSkill).toContain(`\`${marker}\``);
    }
    expect(agents).toContain('.agents/skills/agent-jobs/SKILL.md');
    expect(codexSkill).toContain(`${JSON.stringify(codexScript)} prepare`);
    expect(codexSkill).toContain('init_required');
    expect(codexSkill).toContain('fork_turns: "none"');
    expect(codexSkill).toContain('result_json');

    const codexConfig = await readFile(join(context.cwd, '.codex', 'config.toml'), 'utf8');
    expect(codexConfig).toContain(`args = [${JSON.stringify(codexScript)}, "mcp"]`);
    expect(codexConfig).toContain('required = true');
    expect(codexConfig).toContain('default_tools_approval_mode = "auto"');
    expect(codexConfig).toContain(
      'enabled_tools = ["get_assignment", "submit_result", "report_failure"]',
    );

    const codexWorker = await readFile(
      join(context.cwd, '.codex', 'agents', 'agent_job_worker.toml'),
      'utf8',
    );
    for (const restriction of [
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      'apps = false',
      'memories = false',
      'multi_agent = false',
      'shell_tool = false',
      'unified_exec = false',
      'result_json',
    ]) {
      expect(codexWorker).toContain(restriction);
    }
    expect(codexWorker).not.toMatch(/^model\s*=/m);
    expect(codexWorker).not.toMatch(/^model_reasoning_effort\s*=/m);

    const metadata = YAML.parse(
      await readFile(
        join(context.cwd, '.agents', 'skills', 'agent-jobs', 'agents', 'openai.yaml'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      interface: { display_name: 'Agent Jobs' },
      policy: { allow_implicit_invocation: true },
    });

    const claudeMcp = JSON.parse(await readFile(join(context.cwd, '.mcp.json'), 'utf8')) as {
      mcpServers: { agent_jobs: { args: string[] } };
    };
    expect(claudeMcp.mcpServers.agent_jobs.args).toEqual([claudeScript, 'mcp']);
    const claudeWorker = await readFile(
      join(context.cwd, '.claude', 'agents', 'agent_job_worker.md'),
      'utf8',
    );
    const frontmatter = claudeWorker.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(YAML.parse(frontmatter ?? '')).toMatchObject({
      name: 'agent_job_worker',
      mcpServers: ['agent_jobs'],
      permissionMode: 'dontAsk',
    });
    const claudeSkill = await readFile(
      join(context.cwd, '.claude', 'skills', 'agent-jobs', 'SKILL.md'),
      'utf8',
    );
    expect(claudeSkill).toContain('subagent_type: agent_job_worker');
    expect(claudeSkill).not.toContain('fork_turns');
    expect(stderr.read()).toContain('Restart Codex and/or Claude');
  });

  it('does not create a missing target before confirmation', async () => {
    const context = await fixture();
    const target = join(context.root, 'new', 'project');
    const canonicalTarget = join(await realpath(context.root), 'new', 'project');
    const stdout = capture();
    let prompt = '';

    await expect(
      runInstallerCommand('init', [target], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: stdout.stream,
        stderr: capture().stream,
        isTTY: true,
        confirm: async (message) => {
          prompt = message;
          return false;
        },
      }),
    ).resolves.toBe(0);

    expect(prompt).toContain(`Path:    ${canonicalTarget}`);
    expect(prompt).toContain('Create:  yes');
    expect(stdout.read()).toContain('Cancelled');
    await expect(exists(target)).resolves.toBe(false);
  });

  it('creates a missing path recursively only after --yes', async () => {
    const context = await fixture();
    const target = join(context.root, 'new', 'nested', 'project');

    await expect(
      runInstallerCommand('init', [target, '--target', 'codex', '--yes'], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: capture().stream,
        stderr: capture().stream,
        isTTY: false,
      }),
    ).resolves.toBe(0);

    await expect(exists(join(target, '.codex', 'agents', 'agent_job_worker.toml'))).resolves.toBe(true);
    await expect(exists(join(target, '.claude'))).resolves.toBe(false);
  });

  it('keeps a newly created target canonical across init and uninstall', async () => {
    const context = await fixture();
    const canonicalParent = join(context.cwd, 'canonical-parent');
    const linkedParent = join(context.cwd, 'linked-parent');
    await mkdir(join(canonicalParent, 'nested'), { recursive: true });
    await symlink(canonicalParent, linkedParent, 'dir');
    const target = join(linkedParent, 'nested', 'project');
    const canonicalTarget = join(await realpath(canonicalParent), 'nested', 'project');
    const environment = {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stderr: capture().stream,
      isTTY: false,
    };
    const initOutput = capture();

    await runInstallerCommand('init', [target, '--target', 'codex', '--yes', '--json'], {
      ...environment,
      stdout: initOutput.stream,
    });
    expect(JSON.parse(initOutput.read())).toMatchObject({ path: canonicalTarget });

    const uninstallOutput = capture();
    await runInstallerCommand(
      'uninstall',
      [target, '--target', 'codex', '--yes', '--json'],
      { ...environment, stdout: uninstallOutput.stream },
    );
    expect(JSON.parse(uninstallOutput.read())).toMatchObject({
      path: canonicalTarget,
      status: 'uninstalled',
    });
    await expect(exists(join(canonicalTarget, '.agent-jobs', 'install-manifest.json'))).resolves.toBe(
      false,
    );
  });

  it('makes doctor recognize a complete host install but not a skill alone', async () => {
    const context = await fixture();
    const skillOnly = join(context.root, 'skill-only');
    await mkdir(join(skillOnly, '.agents', 'skills', 'agent-jobs'), { recursive: true });
    await writeFile(
      join(skillOnly, '.agents', 'skills', 'agent-jobs', 'SKILL.md'),
      '---\nname: agent-jobs\ndescription: test\n---\n',
      'utf8',
    );
    const incomplete = await new AgentJobsRuntime({
      projectRoot: skillOnly,
      registryDir: join(context.root, 'registry-incomplete'),
    }).doctor();
    const incompleteCheck = (incomplete.checks as Array<Record<string, unknown>>).find(
      (check) => check.name === 'installation',
    );
    expect(incompleteCheck).toMatchObject({
      ok: false,
      detail: { code: 'init_required' },
    });

    await runInstallerCommand('init', ['--target', 'codex', '--yes'], {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stdout: capture().stream,
      stderr: capture().stream,
      isTTY: false,
    });
    const complete = await new AgentJobsRuntime({
      projectRoot: context.cwd,
      registryDir: join(context.root, 'registry-complete'),
    }).doctor();
    const completeCheck = (complete.checks as Array<Record<string, unknown>>).find(
      (check) => check.name === 'installation',
    );
    expect(completeCheck).toMatchObject({ ok: true });
  });

  it('keeps dry-run side-effect free and does not require confirmation', async () => {
    const context = await fixture();
    const target = join(context.root, 'dry-run-project');
    const stdout = capture();

    await runInstallerCommand('init', [target, '--dry-run', '--json'], {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stdout: stdout.stream,
      stderr: capture().stream,
      isTTY: false,
    });

    expect(JSON.parse(stdout.read())).toMatchObject({ status: 'dry_run', create: true });
    await expect(exists(target)).resolves.toBe(false);
  });

  it('requires --yes without a TTY and rejects path with --global', async () => {
    const context = await fixture();

    await expect(
      runInstallerCommand('init', [], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: capture().stream,
        stderr: capture().stream,
        isTTY: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });

    await expect(
      runInstallerCommand('init', ['somewhere', '--global', '--yes'], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: capture().stream,
        stderr: capture().stream,
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('installs global host assets beneath the supplied home directory', async () => {
    const context = await fixture();
    const stdout = capture();

    await runInstallerCommand(
      'init',
      ['--global', '--target', 'claude', '--yes', '--json'],
      {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: stdout.stream,
        stderr: capture().stream,
        isTTY: false,
      },
    );

    expect(JSON.parse(stdout.read())).toMatchObject({
      path: context.home,
      scope: 'global',
      targets: ['claude'],
    });
    await expect(
      exists(join(context.home, '.claude', 'skills', 'agent-jobs', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(exists(join(context.home, '.claude.json'))).resolves.toBe(true);
    await expect(exists(join(context.cwd, '.claude'))).resolves.toBe(false);
  });

  it('is idempotent and preserves unrelated configuration', async () => {
    const context = await fixture();
    await writeFile(join(context.cwd, 'AGENTS.md'), '# Existing instructions\n', 'utf8');
    await mkdir(join(context.cwd, '.claude'), { recursive: true });
    await writeFile(
      join(context.cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }, null, 2)}\n`,
      'utf8',
    );
    const environment = {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stderr: capture().stream,
      isTTY: false,
    };
    await runInstallerCommand('init', ['--yes'], {
      ...environment,
      stdout: capture().stream,
    });
    const stdout = capture();
    await runInstallerCommand('init', ['--yes', '--json'], {
      ...environment,
      stdout: stdout.stream,
    });

    expect(JSON.parse(stdout.read())).toMatchObject({ changed_files: [] });
    const agents = await readFile(join(context.cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# Existing instructions');
    expect(agents.match(/agent-jobs:start/g)).toHaveLength(1);
    const settings = JSON.parse(
      await readFile(join(context.cwd, '.claude', 'settings.local.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings).toMatchObject({ theme: 'dark' });
    expect(settings).toHaveProperty('permissions.allow');
  });

  it('merges with an existing enabled Codex agents section without duplicating it', async () => {
    const context = await fixture();
    await mkdir(join(context.cwd, '.codex'), { recursive: true });
    await writeFile(
      join(context.cwd, '.codex', 'config.toml'),
      '[agents]\nenabled = true\n\n[features]\napps = true\n',
      'utf8',
    );

    await runInstallerCommand('init', ['--target', 'codex', '--yes'], {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stdout: capture().stream,
      stderr: capture().stream,
      isTTY: false,
    });

    const config = await readFile(join(context.cwd, '.codex', 'config.toml'), 'utf8');
    expect(config.match(/^\[agents\]$/gm)).toHaveLength(1);
    expect(config).toContain('[features]\napps = true');
    expect(config).toContain('[mcp_servers.agent_jobs]');
  });

  it('backs up forced managed changes and restores them during uninstall', async () => {
    const context = await fixture();
    const environment = {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stdout: capture().stream,
      stderr: capture().stream,
      isTTY: false,
    };
    await runInstallerCommand('init', ['--target', 'codex', '--yes'], environment);
    const worker = join(context.cwd, '.codex', 'agents', 'agent_job_worker.toml');
    const modified = '# Managed by agent-jobs\nlocal change\n';
    await writeFile(worker, modified, 'utf8');

    await expect(
      runInstallerCommand('init', ['--target', 'codex', '--yes'], environment),
    ).rejects.toMatchObject({ code: 'target_conflict' });
    await runInstallerCommand(
      'init',
      ['--target', 'codex', '--yes', '--force'],
      environment,
    );
    await expect(readFile(worker, 'utf8')).resolves.toContain('name = "agent_job_worker"');

    await runInstallerCommand('uninstall', ['--target', 'codex', '--yes'], environment);
    await expect(readFile(worker, 'utf8')).resolves.toBe(modified);
  });

  it('restores pre-existing merged files and reports missing installs', async () => {
    const context = await fixture();
    const original = '# Existing instructions\n';
    await writeFile(join(context.cwd, 'AGENTS.md'), original, 'utf8');
    const environment = {
      cwd: context.cwd,
      homeDir: context.home,
      bundlePath: context.bundle,
      stdout: capture().stream,
      stderr: capture().stream,
      isTTY: false,
    };
    await runInstallerCommand('init', ['--target', 'codex', '--yes'], environment);
    await runInstallerCommand('uninstall', ['--target', 'codex', '--yes'], environment);

    await expect(readFile(join(context.cwd, 'AGENTS.md'), 'utf8')).resolves.toBe(original);
    await expect(exists(join(context.cwd, '.agents', 'skills', 'agent-jobs', 'SKILL.md'))).resolves.toBe(false);

    const stdout = capture();
    await runInstallerCommand('uninstall', ['--target', 'codex', '--yes', '--json'], {
      ...environment,
      stdout: stdout.stream,
    });
    expect(JSON.parse(stdout.read())).toMatchObject({ status: 'not_installed' });
  });

  it('rejects a target path that is a file', async () => {
    const context = await fixture();
    const target = join(context.root, 'not-a-directory');
    await writeFile(target, 'file', 'utf8');

    await expect(
      runInstallerCommand('init', [target, '--yes'], {
        cwd: context.cwd,
        homeDir: context.home,
        bundlePath: context.bundle,
        stdout: capture().stream,
        stderr: capture().stream,
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });
});
