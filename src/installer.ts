import type { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  AgentJobsError,
  atomicWriteText,
} from '@agent-jobs/runtime';
import * as clack from '@clack/prompts';

import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  CLAUDE_ALLOWED_TOOLS,
  claudeMcpServer,
  claudePostprocessor,
  claudeSkill,
  claudeWorker,
  CODEX_CONFIG_BLOCK_END,
  CODEX_CONFIG_BLOCK_START,
  codexConfigBlock,
  codexPostprocessor,
  codexSkill,
  codexWorker,
  isAgentJobsManaged,
  openAiMetadata,
  routingBlock,
} from './install-templates.js';

const TARGETS = new Set<InstallTarget>(['all', 'codex', 'claude']);

export type InstallTarget = 'all' | 'codex' | 'claude';
type Scope = 'project' | 'global';
type Writable = Pick<NodeJS.WritableStream, 'write'>;
type Readable = NodeJS.ReadableStream & { isTTY?: boolean };

interface InstallArguments {
  path?: string;
  target?: InstallTarget;
  global: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
}

interface ResolvedInstallArguments extends InstallArguments {
  target: InstallTarget;
}

interface PlannedFile {
  path: string;
  content: string;
  kind: 'managed' | 'merged';
}

interface InstallPlan {
  root: string;
  scope: Scope;
  targets: Array<'codex' | 'claude'>;
  createRoot: boolean;
  files: PlannedFile[];
}

interface InstallLocations {
  skillDir: string;
  agentDir: string;
  instruction: string;
  config: string;
  settings?: string;
}

export type InstallerPrompts = Pick<
  typeof clack,
  | 'cancel'
  | 'confirm'
  | 'intro'
  | 'isCancel'
  | 'multiselect'
  | 'note'
  | 'outro'
  | 'select'
  | 'text'
>;

export interface InstallerEnvironment {
  cwd?: string;
  homeDir?: string;
  bundlePath?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  isTTY?: boolean;
  prompts?: InstallerPrompts;
}

export interface InstallerCommandResult extends Record<string, unknown> {
  ok: true;
  status: 'initialized' | 'cancelled';
  path: string;
  scope: Scope;
  targets: string[];
  create: boolean;
  changed_files: string[];
  warnings: string[];
}

function invalidArguments(message: string): never {
  throw new AgentJobsError('invalid_arguments', message);
}

function parseInstallArguments(args: readonly string[]): InstallArguments {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        target: { type: 'string' },
        global: { type: 'boolean' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    invalidArguments(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > 1) {
    invalidArguments('init accepts at most one path');
  }
  const rawTarget = parsed.values.target;
  if (
    rawTarget !== undefined
    && (typeof rawTarget !== 'string' || !TARGETS.has(rawTarget as InstallTarget))
  ) {
    invalidArguments('Invalid --target; expected all, codex, or claude');
  }
  const global = parsed.values.global === true;
  if (global && parsed.positionals.length > 0) {
    invalidArguments('A path cannot be used together with --global');
  }
  return {
    path: parsed.positionals[0],
    target: rawTarget as InstallTarget | undefined,
    global,
    yes: parsed.values.yes === true,
    force: parsed.values.force === true,
    json: parsed.values.json === true,
  };
}

function selectedTargets(target: InstallTarget): Array<'codex' | 'claude'> {
  return target === 'all' ? ['codex', 'claude'] : [target];
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      return null;
    throw error;
  }
}

async function pathInfo(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'other';
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      return 'missing';
    throw error;
  }
}

function replaceManagedBlock(
  current: string,
  block: string,
  start: string,
  end: string,
): string {
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) {
    throw new AgentJobsError(
      'config_conflict',
      `Malformed agent-jobs managed block (${start})`,
    );
  }
  if (
    startIndex !== -1
    && (current.includes(start, startIndex + start.length)
      || current.includes(end, endIndex + end.length))
  ) {
    throw new AgentJobsError(
      'config_conflict',
      `Multiple agent-jobs managed blocks (${start})`,
    );
  }
  if (startIndex !== -1) {
    const after = endIndex + end.length;
    return `${current.slice(0, startIndex)}${block}${current.slice(after)}`;
  }
  const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
  return `${prefix}${prefix.length > 0 ? '\n' : ''}${block}\n`;
}

function withoutManagedBlock(current: string, start: string, end: string): string {
  const startIndex = current.indexOf(start);
  if (startIndex === -1)
    return current;
  const endIndex = current.indexOf(end, startIndex + start.length);
  if (endIndex === -1)
    return current;
  return `${current.slice(0, startIndex)}${current.slice(endIndex + end.length)}`;
}

function tomlSection(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm').exec(text);
  if (!header)
    return null;
  const bodyStart = header.index + header[0].length;
  const rest = text.slice(bodyStart);
  const nextSection = /^\s*\[/m.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

function parseJsonObject(text: string | null, path: string): Record<string, unknown> {
  if (text === null || text.trim() === '')
    return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected a JSON object');
    return value as Record<string, unknown>;
  } catch {
    throw new AgentJobsError('config_conflict', `Expected a JSON object in ${path}`, {
      path,
    });
  }
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergeClaudeMcp(
  current: string | null,
  path: string,
  server: Record<string, unknown>,
): string {
  const root = parseJsonObject(current, path);
  const rawServers = root.mcpServers;
  if (
    rawServers !== undefined
    && (rawServers === null
      || typeof rawServers !== 'object'
      || Array.isArray(rawServers))
  ) {
    throw new AgentJobsError('config_conflict', `mcpServers must be an object in ${path}`);
  }
  const servers = { ...((rawServers as Record<string, unknown> | undefined) ?? {}) };
  if (Object.hasOwn(servers, 'agent_jobs')) {
    const existing = JSON.stringify(servers.agent_jobs);
    if (existing !== JSON.stringify(server)) {
      throw new AgentJobsError(
        'config_conflict',
        `Refusing to replace unmanaged mcpServers.agent_jobs in ${path}`,
      );
    }
  }
  servers.agent_jobs = server;
  return prettyJson({ ...root, mcpServers: servers });
}

function mergeClaudeSettings(current: string | null, path: string): string {
  const root = parseJsonObject(current, path);
  const enabled = Array.isArray(root.enabledMcpjsonServers)
    ? root.enabledMcpjsonServers.filter((item): item is string => typeof item === 'string')
    : [];
  const permissions
    = root.permissions !== null
      && typeof root.permissions === 'object'
      && !Array.isArray(root.permissions)
      ? (root.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((item): item is string => typeof item === 'string')
    : [];
  return prettyJson({
    ...root,
    enabledMcpjsonServers: [...new Set([...enabled, 'agent_jobs'])],
    permissions: {
      ...permissions,
      allow: [...new Set([...allow, ...CLAUDE_ALLOWED_TOOLS])],
    },
  });
}

async function resolveRoot(
  args: ResolvedInstallArguments,
  cwd: string,
  homeDir: string,
): Promise<{ root: string; scope: Scope; createRoot: boolean }> {
  if (args.global) {
    const root = resolve(homeDir);
    const kind = await pathInfo(root);
    if (kind !== 'directory') {
      throw new AgentJobsError('invalid_target', `Global home is not a directory: ${root}`);
    }
    return { root: await realpath(root), scope: 'global', createRoot: false };
  }
  const candidate = resolve(cwd, args.path ?? '.');
  const kind = await pathInfo(candidate);
  if (kind === 'other') {
    throw new AgentJobsError('invalid_target', `Target must be a directory: ${candidate}`, {
      path: candidate,
    });
  }
  if (kind === 'directory') {
    return { root: await realpath(candidate), scope: 'project', createRoot: false };
  }
  let ancestor = dirname(candidate);
  while ((await pathInfo(ancestor)) === 'missing') ancestor = dirname(ancestor);
  if ((await pathInfo(ancestor)) !== 'directory') {
    throw new AgentJobsError('invalid_target', `No writable parent directory for ${candidate}`);
  }
  try {
    await access(ancestor, fsConstants.W_OK);
  } catch {
    throw new AgentJobsError('permission_denied', `Parent directory is not writable: ${ancestor}`);
  }
  const canonicalAncestor = await realpath(ancestor);
  const canonicalCandidate = resolve(canonicalAncestor, relative(ancestor, candidate));
  return { root: canonicalCandidate, scope: 'project', createRoot: true };
}

function installLocations(
  root: string,
  scope: Scope,
  target: 'codex' | 'claude',
): InstallLocations {
  if (target === 'codex') {
    return scope === 'project'
      ? {
          skillDir: join(root, '.agents', 'skills', 'agent-jobs'),
          agentDir: join(root, '.codex', 'agents'),
          instruction: join(root, 'AGENTS.md'),
          config: join(root, '.codex', 'config.toml'),
        }
      : {
          skillDir: join(root, '.agents', 'skills', 'agent-jobs'),
          agentDir: join(root, '.codex', 'agents'),
          instruction: join(root, '.codex', 'AGENTS.md'),
          config: join(root, '.codex', 'config.toml'),
        };
  }
  return scope === 'project'
    ? {
        skillDir: join(root, '.claude', 'skills', 'agent-jobs'),
        agentDir: join(root, '.claude', 'agents'),
        instruction: join(root, 'CLAUDE.md'),
        config: join(root, '.mcp.json'),
        settings: join(root, '.claude', 'settings.local.json'),
      }
    : {
        skillDir: join(root, '.claude', 'skills', 'agent-jobs'),
        agentDir: join(root, '.claude', 'agents'),
        instruction: join(root, '.claude', 'CLAUDE.md'),
        config: join(root, '.claude.json'),
        settings: join(root, '.claude', 'settings.json'),
      };
}

async function resolveBundlePath(explicit?: string): Promise<string> {
  if (explicit !== undefined)
    return resolve(explicit);
  if (process.env.AGENT_JOBS_BUNDLE_PATH)
    return resolve(process.env.AGENT_JOBS_BUNDLE_PATH);
  const ownPath = fileURLToPath(import.meta.url);
  if (basename(ownPath) === 'agent-jobs.mjs')
    return ownPath;
  return resolve(dirname(ownPath), '..', 'dist', 'agent-jobs.mjs');
}

async function buildFiles(
  root: string,
  scope: Scope,
  targets: Array<'codex' | 'claude'>,
  bundleContent: string,
): Promise<PlannedFile[]> {
  const files: PlannedFile[] = [];
  for (const target of targets) {
    const locations = installLocations(root, scope, target);
    const scriptPath = join(locations.skillDir, 'scripts', 'agent-jobs.mjs');
    const instructionCurrent = await fileText(locations.instruction);
    const instructionSkillPath
      = scope === 'project'
        ? relative(root, join(locations.skillDir, 'SKILL.md')) || 'SKILL.md'
        : join(locations.skillDir, 'SKILL.md');
    files.push(
      {
        path: join(locations.skillDir, 'SKILL.md'),
        content: target === 'codex' ? codexSkill(scriptPath) : claudeSkill(scriptPath),
        kind: 'managed',
      },
      { path: scriptPath, content: bundleContent, kind: 'managed' },
      {
        path: locations.instruction,
        content: replaceManagedBlock(
          instructionCurrent ?? '',
          routingBlock(target, instructionSkillPath),
          AGENTS_BLOCK_START,
          AGENTS_BLOCK_END,
        ),
        kind: 'merged',
      },
    );
    if (target === 'codex') {
      files.push(
        {
          path: join(locations.skillDir, 'agents', 'openai.yaml'),
          content: openAiMetadata(),
          kind: 'managed',
        },
        {
          path: join(locations.agentDir, 'agent_job_worker.toml'),
          content: codexWorker(
            scriptPath,
            scope === 'project' ? root : undefined,
          ),
          kind: 'managed',
        },
        {
          path: join(locations.agentDir, 'agent_job_postprocessor.toml'),
          content: codexPostprocessor(),
          kind: 'managed',
        },
      );
      const configCurrent = await fileText(locations.config);
      const unmanagedConfig = withoutManagedBlock(
        configCurrent ?? '',
        CODEX_CONFIG_BLOCK_START,
        CODEX_CONFIG_BLOCK_END,
      );
      if (
        unmanagedConfig.includes('[mcp_servers.agent_jobs]')
      ) {
        throw new AgentJobsError(
          'config_conflict',
          `Refusing to replace unmanaged mcp_servers.agent_jobs in ${locations.config}`,
        );
      }
      const agentsSection = tomlSection(unmanagedConfig, 'agents');
      if (agentsSection !== null && !/^\s*enabled\s*=\s*true\s*$/m.test(agentsSection)) {
        throw new AgentJobsError(
          'config_conflict',
          `Existing [agents] in ${locations.config} must set enabled = true`,
        );
      }
      files.push({
        path: locations.config,
        content: replaceManagedBlock(
          configCurrent ?? '',
          codexConfigBlock(
            scriptPath,
            scope === 'project' ? root : undefined,
            agentsSection === null,
          ),
          CODEX_CONFIG_BLOCK_START,
          CODEX_CONFIG_BLOCK_END,
        ),
        kind: 'merged',
      });
    } else {
      files.push(
        {
          path: join(locations.agentDir, 'agent_job_worker.md'),
          content: claudeWorker(),
          kind: 'managed',
        },
        {
          path: join(locations.agentDir, 'agent_job_postprocessor.md'),
          content: claudePostprocessor(),
          kind: 'managed',
        },
      );
      files.push({
        path: locations.config,
        content: mergeClaudeMcp(
          await fileText(locations.config),
          locations.config,
          claudeMcpServer(scriptPath, scope === 'project' ? root : undefined),
        ),
        kind: 'merged',
      });
      files.push({
        path: locations.settings!,
        content: mergeClaudeSettings(await fileText(locations.settings!), locations.settings!),
        kind: 'merged',
      });
    }
  }
  return files;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

async function assertWritableTargets(files: PlannedFile[]): Promise<void> {
  for (const file of files) {
    const current = await pathInfo(file.path);
    if (current === 'other') {
      try {
        await access(file.path, fsConstants.W_OK);
      } catch {
        throw new AgentJobsError('permission_denied', `File is not writable: ${file.path}`);
      }
      continue;
    }
    if (current === 'directory') {
      throw new AgentJobsError('invalid_target', `Expected a file path: ${file.path}`);
    }
    let ancestor = dirname(file.path);
    while ((await pathInfo(ancestor)) === 'missing') ancestor = dirname(ancestor);
    if ((await pathInfo(ancestor)) !== 'directory') {
      throw new AgentJobsError('invalid_target', `File parent is not a directory: ${ancestor}`);
    }
    try {
      await access(ancestor, fsConstants.W_OK);
    } catch {
      throw new AgentJobsError('permission_denied', `Directory is not writable: ${ancestor}`);
    }
  }
}

async function pruneEmptyParents(start: string, stop: string): Promise<void> {
  let cursor = start;
  while (isWithin(cursor, stop) && cursor !== dirname(cursor)) {
    try {
      await rmdir(cursor);
    } catch (error) {
      if (hasCode(error, 'ENOENT'))
        return;
      if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST'))
        return;
      throw error;
    }
    if (cursor === stop)
      return;
    cursor = dirname(cursor);
  }
}

async function preflightFiles(
  files: PlannedFile[],
  force: boolean,
): Promise<void> {
  for (const file of files) {
    const current = await fileText(file.path);
    if (current === null || current === file.content)
      continue;
    if (file.kind === 'merged') {
      if (!isAgentJobsManaged(current))
        continue;
      if (!force) {
        throw new AgentJobsError(
          'target_conflict',
          `Managed configuration block has local changes: ${file.path}`,
          {
            path: file.path,
            hint: 'Re-run with --force to replace the managed block.',
          },
        );
      }
      continue;
    }
    if (!isAgentJobsManaged(current)) {
      throw new AgentJobsError(
        'target_conflict',
        `Refusing to overwrite unmanaged file: ${file.path}`,
        { path: file.path },
      );
    }
    if (!force) {
      throw new AgentJobsError('target_conflict', `Managed file has local changes: ${file.path}`, {
        path: file.path,
        hint: 'Re-run with --force to replace the managed file.',
      });
    }
  }
}

async function applyInit(plan: InstallPlan): Promise<{ changed: string[]; warnings: string[] }> {
  const changed: string[] = [];
  const warnings: string[] = [];
  const createdRoot = plan.createRoot;
  const applied: Array<{ path: string; original: string | null }> = [];
  try {
    if (createdRoot)
      await mkdir(plan.root, { recursive: true });
    for (const file of plan.files) {
      const current = await fileText(file.path);
      if (current === file.content)
        continue;
      applied.push({ path: file.path, original: current });
      await atomicWriteText(file.path, file.content);
      changed.push(file.path);
    }
    if (changed.length === 0)
      warnings.push('Installation is already up to date.');
    return { changed, warnings };
  } catch (error) {
    for (const item of applied.reverse()) {
      try {
        if (item.original === null)
          await rm(item.path, { force: true });
        else await atomicWriteText(item.path, item.original);
      } catch {
        warnings.push(`Rollback could not restore ${item.path}`);
      }
    }
    if (createdRoot) {
      for (const item of applied) {
        try {
          await pruneEmptyParents(dirname(item.path), plan.root);
        } catch {
          warnings.push(`Rollback could not prune ${dirname(item.path)}`);
        }
      }
      try {
        await rmdir(plan.root);
      } catch (error_) {
        if (!hasCode(error_, 'ENOENT') && !hasCode(error_, 'ENOTEMPTY')) {
          warnings.push(`Rollback could not remove ${plan.root}`);
        }
      }
    }
    throw error;
  }
}

async function createPlan(
  args: ResolvedInstallArguments,
  environment: InstallerEnvironment,
): Promise<InstallPlan> {
  const cwd = resolve(environment.cwd ?? process.cwd());
  const homeDir = resolve(environment.homeDir ?? homedir());
  const resolved = await resolveRoot(args, cwd, homeDir);
  const targets = selectedTargets(args.target);
  const bundlePath = await resolveBundlePath(environment.bundlePath);
  let bundleContent: string;
  try {
    bundleContent = await readFile(bundlePath, 'utf8');
  } catch {
    throw new AgentJobsError(
      'bundle_not_found',
      `Built bundle not found: ${bundlePath}. Run pnpm build before init.`,
      { path: bundlePath },
    );
  }
  if (!bundleContent.startsWith('#!/usr/bin/env node')) {
    throw new AgentJobsError(
      'invalid_bundle',
      `Bundle is missing its node shebang: ${bundlePath}`,
    );
  }
  const files = await buildFiles(resolved.root, resolved.scope, targets, bundleContent);
  await assertWritableTargets(files);
  await preflightFiles(files, args.force);
  return {
    ...resolved,
    targets,
    files,
  };
}

function previewText(plan: InstallPlan, args: ResolvedInstallArguments): string {
  const targets = plan.targets
    .map(target => (target === 'codex' ? 'Codex' : 'Claude'))
    .join(', ');
  return [
    `Path:    ${plan.root}`,
    `Scope:   ${plan.scope}`,
    `Targets: ${targets}`,
    `Create:  ${plan.createRoot ? 'yes' : 'no'}`,
    `Force:   ${args.force ? 'yes' : 'no'}`,
  ].join('\n');
}

function promptIo(environment: InstallerEnvironment): {
  input: NodeReadable;
  output: NodeWritable;
} {
  return {
    input: (environment.stdin ?? process.stdin) as NodeReadable,
    output: (environment.stderr ?? process.stderr) as NodeWritable,
  };
}

async function interactiveArguments(
  parsed: InstallArguments,
  environment: InstallerEnvironment,
): Promise<ResolvedInstallArguments | undefined> {
  const prompts = environment.prompts ?? clack;
  const io = promptIo(environment);
  const cwd = resolve(environment.cwd ?? process.cwd());
  const homeDir = resolve(environment.homeDir ?? homedir());
  let path = parsed.path;
  let global = parsed.global;

  prompts.intro('Initialize Agent Jobs', io);

  if (!global && path === undefined) {
    const location = await prompts.select<'current' | 'custom' | 'global'>({
      message: 'Where should Agent Jobs be configured?',
      options: [
        { value: 'current', label: 'Current project', hint: cwd },
        { value: 'custom', label: 'Another project', hint: 'Enter a path' },
        { value: 'global', label: 'Global', hint: homeDir },
      ],
      initialValue: 'current',
      ...io,
    });
    if (prompts.isCancel(location)) {
      prompts.cancel('No files were changed.', io);
      return undefined;
    }
    if (location === 'global') {
      global = true;
    } else if (location === 'custom') {
      const customPath = await prompts.text({
        message: 'Which project path should be configured?',
        placeholder: cwd,
        validate(value) {
          if (!value || value.trim().length === 0)
            return 'Path is required.';
        },
        ...io,
      });
      if (prompts.isCancel(customPath)) {
        prompts.cancel('No files were changed.', io);
        return undefined;
      }
      path = customPath.trim();
    } else {
      path = '.';
    }
  }

  let target = parsed.target;
  if (target === undefined) {
    const selected = await prompts.multiselect<'codex' | 'claude'>({
      message: 'Which agent hosts should be configured?',
      options: [
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude' },
      ],
      initialValues: [],
      required: true,
      ...io,
    });
    if (prompts.isCancel(selected)) {
      prompts.cancel('No files were changed.', io);
      return undefined;
    }
    target = selected.length === 2 ? 'all' : selected[0];
  }

  return { ...parsed, path, target, global };
}

function resolvedArguments(parsed: InstallArguments): ResolvedInstallArguments {
  return { ...parsed, target: parsed.target ?? 'all' };
}

function showPreview(
  plan: InstallPlan,
  args: ResolvedInstallArguments,
  environment: InstallerEnvironment,
): void {
  (environment.prompts ?? clack).note(
    previewText(plan, args),
    'Initialization preview',
    promptIo(environment),
  );
}

async function confirmPlan(environment: InstallerEnvironment): Promise<boolean | undefined> {
  const prompts = environment.prompts ?? clack;
  const answer = await prompts.confirm({
    message: 'Initialize with these options?',
    initialValue: true,
    ...promptIo(environment),
  });
  if (prompts.isCancel(answer))
    return undefined;
  return answer;
}

function humanResult(result: InstallerCommandResult): string {
  if (result.status === 'cancelled')
    return `Cancelled; no files were changed in ${result.path}.\n`;
  return `Initialized agent-jobs in ${result.path}; ${result.changed_files.length} file(s) changed.\n`;
}

function interactiveResult(result: InstallerCommandResult): string {
  const lines = [humanResult(result).trim()];
  lines.push(...result.warnings.map(warning => `Warning: ${warning}`));
  lines.push('Restart Codex and/or Claude to load the new skill, agents, and MCP server.');
  return lines.join('\n');
}

export async function runInstallerCommand(
  argv: readonly string[],
  environment: InstallerEnvironment = {},
): Promise<number> {
  const parsed = parseInstallArguments(argv);
  const stdout = environment.stdout ?? process.stdout;
  const stderr = environment.stderr ?? process.stderr;
  const tty = environment.isTTY ?? environment.stdin?.isTTY ?? process.stdin.isTTY === true;
  const interactive = tty && !parsed.json;
  const args = interactive
    ? await interactiveArguments(parsed, { ...environment, stderr })
    : resolvedArguments(parsed);
  if (args === undefined)
    return 0;
  const plan = await createPlan(args, environment);
  const base = {
    ok: true as const,
    path: plan.root,
    scope: plan.scope,
    targets: plan.targets,
    create: plan.createRoot,
  };
  if (!args.yes && !interactive) {
    invalidArguments('Non-interactive init requires --yes');
  }
  if (interactive)
    showPreview(plan, args, { ...environment, stderr });
  const confirmation = args.yes ? true : await confirmPlan({ ...environment, stderr });
  if (confirmation !== true) {
    const result: InstallerCommandResult = {
      ...base,
      status: 'cancelled',
      changed_files: [],
      warnings: [],
    };
    (environment.prompts ?? clack).cancel(humanResult(result).trim(), promptIo(environment));
    return 0;
  }
  const applied = await applyInit(plan);
  const result: InstallerCommandResult = {
    ...base,
    status: 'initialized',
    changed_files: applied.changed,
    warnings: applied.warnings,
  };
  if (args.json || !interactive)
    stdout.write(args.json ? `${JSON.stringify(result)}\n` : humanResult(result));
  else
    (environment.prompts ?? clack).outro(interactiveResult(result), promptIo(environment));
  if (!interactive) {
    for (const warning of applied.warnings) stderr.write(`Warning: ${warning}\n`);
  }
  if (!interactive) {
    stderr.write(
      'Restart Codex and/or Claude to load the new skill, agents, and MCP server.\n',
    );
  }
  return 0;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === code
  );
}
