import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  atomicWriteText,
  BatchTasksError,
  stringifyStrictJson,
} from '@batch-tasks/runtime';

import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  CLAUDE_ALLOWED_TOOLS,
  CODEX_CONFIG_BLOCK_END,
  CODEX_CONFIG_BLOCK_START,
  claudeMcpServer,
  claudePostprocessor,
  claudeSkill,
  claudeWorker,
  codexConfigBlock,
  codexPostprocessor,
  codexSkill,
  codexWorker,
  isBatchTasksManaged,
  openAiMetadata,
  routingBlock,
} from './install-templates.js';

const PACKAGE_VERSION = '0.3.0';
const TARGETS = new Set<InstallTarget>(['all', 'codex', 'claude']);

export type InstallTarget = 'all' | 'codex' | 'claude';
type Scope = 'project' | 'global';
type Writable = Pick<NodeJS.WritableStream, 'write'>;
type Readable = NodeJS.ReadableStream & { isTTY?: boolean };

interface InstallArguments {
  path?: string;
  target: InstallTarget;
  global: boolean;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  json: boolean;
}

interface PlannedFile {
  path: string;
  content: string;
  kind: 'managed' | 'merged';
}

interface ManifestEntry {
  path: string;
  installed_sha256: string;
  original_existed: boolean;
  backup_path: string | null;
}

interface InstallManifest {
  schema_version: 1;
  package_version: string;
  scope: Scope;
  root: string;
  targets: Array<'codex' | 'claude'>;
  files: ManifestEntry[];
}

interface InstallPlan {
  operation: 'init' | 'uninstall';
  root: string;
  scope: Scope;
  targets: Array<'codex' | 'claude'>;
  createRoot: boolean;
  manifestPath: string;
  files: PlannedFile[];
  manifest?: InstallManifest;
}

interface InstallLocations {
  skillDir: string;
  agentDir: string;
  instruction: string;
  config: string;
  settings?: string;
}

export interface InstallerEnvironment {
  cwd?: string;
  homeDir?: string;
  bundlePath?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  isTTY?: boolean;
  confirm?: (message: string) => Promise<boolean>;
}

export interface InstallerCommandResult extends Record<string, unknown> {
  ok: true;
  status: 'initialized' | 'uninstalled' | 'cancelled' | 'dry_run' | 'not_installed';
  path: string;
  scope: Scope;
  targets: string[];
  create: boolean;
  changed_files: string[];
  warnings: string[];
}

function invalidArguments(message: string): never {
  throw new BatchTasksError('invalid_arguments', message);
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
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    invalidArguments(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > 1) {
    invalidArguments('init and uninstall accept at most one path');
  }
  const rawTarget = parsed.values.target ?? 'all';
  if (typeof rawTarget !== 'string' || !TARGETS.has(rawTarget as InstallTarget)) {
    invalidArguments('Invalid --target; expected all, codex, or claude');
  }
  const global = parsed.values.global === true;
  if (global && parsed.positionals.length > 0) {
    invalidArguments('A path cannot be used together with --global');
  }
  return {
    path: parsed.positionals[0],
    target: rawTarget as InstallTarget,
    global,
    yes: parsed.values.yes === true,
    dryRun: parsed.values['dry-run'] === true,
    force: parsed.values.force === true,
    json: parsed.values.json === true,
  };
}

function selectedTargets(target: InstallTarget): Array<'codex' | 'claude'> {
  return target === 'all' ? ['codex', 'claude'] : [target];
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function pathInfo(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'other';
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'missing';
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
    throw new BatchTasksError(
      'config_conflict',
      `Malformed batch-tasks managed block (${start})`,
    );
  }
  if (
    startIndex !== -1 &&
    (current.indexOf(start, startIndex + start.length) !== -1 ||
      current.indexOf(end, endIndex + end.length) !== -1)
  ) {
    throw new BatchTasksError(
      'config_conflict',
      `Multiple batch-tasks managed blocks (${start})`,
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
  if (startIndex === -1) return current;
  const endIndex = current.indexOf(end, startIndex + start.length);
  if (endIndex === -1) return current;
  return `${current.slice(0, startIndex)}${current.slice(endIndex + end.length)}`;
}

function tomlSection(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm').exec(text);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const rest = text.slice(bodyStart);
  const nextSection = /^\s*\[/m.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

function parseJsonObject(text: string | null, path: string): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new BatchTasksError('config_conflict', `Expected a JSON object in ${path}`, {
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
    rawServers !== undefined &&
    (rawServers === null ||
      typeof rawServers !== 'object' ||
      Array.isArray(rawServers))
  ) {
    throw new BatchTasksError('config_conflict', `mcpServers must be an object in ${path}`);
  }
  const servers = { ...((rawServers as Record<string, unknown> | undefined) ?? {}) };
  if (Object.hasOwn(servers, 'batch_tasks')) {
    const existing = JSON.stringify(servers.batch_tasks);
    if (existing !== JSON.stringify(server)) {
      throw new BatchTasksError(
        'config_conflict',
        `Refusing to replace unmanaged mcpServers.batch_tasks in ${path}`,
      );
    }
  }
  servers.batch_tasks = server;
  return prettyJson({ ...root, mcpServers: servers });
}

function mergeClaudeSettings(current: string | null, path: string): string {
  const root = parseJsonObject(current, path);
  const enabled = Array.isArray(root.enabledMcpjsonServers)
    ? root.enabledMcpjsonServers.filter((item): item is string => typeof item === 'string')
    : [];
  const permissions =
    root.permissions !== null &&
    typeof root.permissions === 'object' &&
    !Array.isArray(root.permissions)
      ? (root.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((item): item is string => typeof item === 'string')
    : [];
  return prettyJson({
    ...root,
    enabledMcpjsonServers: [...new Set([...enabled, 'batch_tasks'])],
    permissions: {
      ...permissions,
      allow: [...new Set([...allow, ...CLAUDE_ALLOWED_TOOLS])],
    },
  });
}

async function resolveRoot(
  args: InstallArguments,
  cwd: string,
  homeDir: string,
  operation: 'init' | 'uninstall',
): Promise<{ root: string; scope: Scope; createRoot: boolean }> {
  if (args.global) {
    const root = resolve(homeDir);
    const kind = await pathInfo(root);
    if (kind !== 'directory') {
      throw new BatchTasksError('invalid_target', `Global home is not a directory: ${root}`);
    }
    return { root: await realpath(root), scope: 'global', createRoot: false };
  }
  const candidate = resolve(cwd, args.path ?? '.');
  const kind = await pathInfo(candidate);
  if (kind === 'other') {
    throw new BatchTasksError('invalid_target', `Target must be a directory: ${candidate}`, {
      path: candidate,
    });
  }
  if (kind === 'directory') {
    return { root: await realpath(candidate), scope: 'project', createRoot: false };
  }
  if (operation === 'uninstall') {
    return { root: candidate, scope: 'project', createRoot: false };
  }
  let ancestor = dirname(candidate);
  while ((await pathInfo(ancestor)) === 'missing') ancestor = dirname(ancestor);
  if ((await pathInfo(ancestor)) !== 'directory') {
    throw new BatchTasksError('invalid_target', `No writable parent directory for ${candidate}`);
  }
  try {
    await access(ancestor, fsConstants.W_OK);
  } catch {
    throw new BatchTasksError('permission_denied', `Parent directory is not writable: ${ancestor}`);
  }
  return { root: candidate, scope: 'project', createRoot: true };
}

function installLocations(
  root: string,
  scope: Scope,
  target: 'codex' | 'claude',
): InstallLocations {
  if (target === 'codex') {
    return scope === 'project'
      ? {
          skillDir: join(root, '.agents', 'skills', 'batch-tasks'),
          agentDir: join(root, '.codex', 'agents'),
          instruction: join(root, 'AGENTS.md'),
          config: join(root, '.codex', 'config.toml'),
        }
      : {
          skillDir: join(root, '.agents', 'skills', 'batch-tasks'),
          agentDir: join(root, '.codex', 'agents'),
          instruction: join(root, '.codex', 'AGENTS.md'),
          config: join(root, '.codex', 'config.toml'),
        };
  }
  return scope === 'project'
    ? {
        skillDir: join(root, '.claude', 'skills', 'batch-tasks'),
        agentDir: join(root, '.claude', 'agents'),
        instruction: join(root, 'CLAUDE.md'),
        config: join(root, '.mcp.json'),
        settings: join(root, '.claude', 'settings.local.json'),
      }
    : {
        skillDir: join(root, '.claude', 'skills', 'batch-tasks'),
        agentDir: join(root, '.claude', 'agents'),
        instruction: join(root, '.claude', 'CLAUDE.md'),
        config: join(root, '.claude.json'),
        settings: join(root, '.claude', 'settings.json'),
      };
}

async function resolveBundlePath(explicit?: string): Promise<string> {
  if (explicit !== undefined) return resolve(explicit);
  if (process.env.BATCH_TASKS_BUNDLE_PATH) return resolve(process.env.BATCH_TASKS_BUNDLE_PATH);
  const ownPath = fileURLToPath(import.meta.url);
  if (basename(ownPath) === 'batch-tasks.mjs') return ownPath;
  return resolve(dirname(ownPath), '..', 'dist', 'batch-tasks.mjs');
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
    const scriptPath = join(locations.skillDir, 'scripts', 'batch-tasks.mjs');
    const instructionCurrent = await fileText(locations.instruction);
    const instructionSkillPath =
      scope === 'project'
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
          path: join(locations.agentDir, 'batch_worker.toml'),
          content: codexWorker(
            scriptPath,
            scope === 'project' ? root : undefined,
          ),
          kind: 'managed',
        },
        {
          path: join(locations.agentDir, 'batch_postprocessor.toml'),
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
        unmanagedConfig.includes('[mcp_servers.batch_tasks]')
      ) {
        throw new BatchTasksError(
          'config_conflict',
          `Refusing to replace unmanaged mcp_servers.batch_tasks in ${locations.config}`,
        );
      }
      const agentsSection = tomlSection(unmanagedConfig, 'agents');
      if (agentsSection !== null && !/^\s*enabled\s*=\s*true\s*$/m.test(agentsSection)) {
        throw new BatchTasksError(
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
          path: join(locations.agentDir, 'batch_worker.md'),
          content: claudeWorker(),
          kind: 'managed',
        },
        {
          path: join(locations.agentDir, 'batch_postprocessor.md'),
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

function manifestPath(root: string): string {
  return join(root, '.batch-tasks-agent', 'install-manifest.json');
}

function targetInstallPaths(
  root: string,
  scope: Scope,
  target: 'codex' | 'claude',
): Set<string> {
  const paths = new Set<string>();
  const locations = installLocations(root, scope, target);
  paths.add(join(locations.skillDir, 'SKILL.md'));
  paths.add(join(locations.skillDir, 'scripts', 'batch-tasks.mjs'));
  paths.add(locations.instruction);
  paths.add(locations.config);
  if (target === 'codex') {
    paths.add(join(locations.skillDir, 'agents', 'openai.yaml'));
    paths.add(join(locations.agentDir, 'batch_worker.toml'));
    paths.add(join(locations.agentDir, 'batch_postprocessor.toml'));
  } else {
    paths.add(join(locations.agentDir, 'batch_worker.md'));
    paths.add(join(locations.agentDir, 'batch_postprocessor.md'));
    paths.add(locations.settings!);
  }
  return paths;
}

function allowedInstallPaths(root: string, scope: Scope): Set<string> {
  return new Set([
    ...targetInstallPaths(root, scope, 'codex'),
    ...targetInstallPaths(root, scope, 'claude'),
  ]);
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

async function readManifest(
  path: string,
  root: string,
  scope: Scope,
): Promise<InstallManifest | undefined> {
  const text = await fileText(path);
  if (text === null) return undefined;
  try {
    const manifest = JSON.parse(text) as InstallManifest;
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) throw new Error();
    if (manifest.root !== root || manifest.scope !== scope) throw new Error();
    const allowed = allowedInstallPaths(root, scope);
    const backupRoot = join(dirname(path), 'backups');
    for (const entry of manifest.files) {
      if (
        typeof entry.path !== 'string' ||
        !allowed.has(entry.path) ||
        !/^[a-f0-9]{64}$/.test(entry.installed_sha256) ||
        typeof entry.original_existed !== 'boolean' ||
        (entry.backup_path !== null &&
          (typeof entry.backup_path !== 'string' || !isWithin(entry.backup_path, backupRoot)))
      ) {
        throw new Error();
      }
    }
    return manifest;
  } catch {
    throw new BatchTasksError('invalid_manifest', `Invalid install manifest: ${path}`);
  }
}

async function assertWritableTargets(files: PlannedFile[]): Promise<void> {
  for (const file of files) {
    const current = await pathInfo(file.path);
    if (current === 'other') {
      try {
        await access(file.path, fsConstants.W_OK);
      } catch {
        throw new BatchTasksError('permission_denied', `File is not writable: ${file.path}`);
      }
      continue;
    }
    if (current === 'directory') {
      throw new BatchTasksError('invalid_target', `Expected a file path: ${file.path}`);
    }
    let ancestor = dirname(file.path);
    while ((await pathInfo(ancestor)) === 'missing') ancestor = dirname(ancestor);
    if ((await pathInfo(ancestor)) !== 'directory') {
      throw new BatchTasksError('invalid_target', `File parent is not a directory: ${ancestor}`);
    }
    try {
      await access(ancestor, fsConstants.W_OK);
    } catch {
      throw new BatchTasksError('permission_denied', `Directory is not writable: ${ancestor}`);
    }
  }
}

async function pruneEmptyParents(start: string, stop: string): Promise<void> {
  let cursor = start;
  while (isWithin(cursor, stop) && cursor !== dirname(cursor)) {
    try {
      await rmdir(cursor);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) return;
      throw error;
    }
    if (cursor === stop) return;
    cursor = dirname(cursor);
  }
}

async function preflightFiles(
  files: PlannedFile[],
  manifest: InstallManifest | undefined,
  force: boolean,
): Promise<void> {
  const prior = new Map(manifest?.files.map((entry) => [entry.path, entry]) ?? []);
  for (const file of files) {
    const current = await fileText(file.path);
    if (current === null || current === file.content) continue;
    const entry = prior.get(file.path);
    if (file.kind === 'merged') {
      const isUnmodifiedInstall =
        entry !== undefined && hash(current) === entry.installed_sha256;
      if (isUnmodifiedInstall || !isBatchTasksManaged(current)) continue;
      if (!force) {
        throw new BatchTasksError(
          'target_conflict',
          `Managed configuration block has local changes: ${file.path}`,
          {
            path: file.path,
            hint: 'Re-run with --force to back up and replace the managed block.',
          },
        );
      }
      continue;
    }
    const recognized = entry !== undefined || isBatchTasksManaged(current);
    if (!recognized) {
      throw new BatchTasksError(
        'target_conflict',
        `Refusing to overwrite unmanaged file: ${file.path}`,
        { path: file.path },
      );
    }
    if (!force) {
      throw new BatchTasksError('target_conflict', `Managed file has local changes: ${file.path}`, {
        path: file.path,
        hint: 'Re-run with --force to back up and replace the managed file.',
      });
    }
  }
}

async function backupFile(
  source: string,
  backupRoot: string,
  root: string,
): Promise<string> {
  const relativePath = relative(root, source).replaceAll('..', '__parent__');
  const destination = join(backupRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
  return destination;
}

async function applyInit(plan: InstallPlan): Promise<{ changed: string[]; warnings: string[] }> {
  const changed: string[] = [];
  const warnings: string[] = [];
  const createdRoot = plan.createRoot;
  const previous = new Map(plan.manifest?.files.map((entry) => [entry.path, entry]) ?? []);
  const entries = new Map(previous);
  const backupRoot = join(
    dirname(plan.manifestPath),
    'backups',
    new Date().toISOString().replaceAll(':', '-'),
  );
  const applied: Array<{ path: string; original: string | null }> = [];
  try {
    if (createdRoot) await mkdir(plan.root, { recursive: true });
    for (const file of plan.files) {
      const current = await fileText(file.path);
      const previousEntry = previous.get(file.path);
      if (current === file.content) {
        if (previousEntry === undefined) {
          const backupPath = await backupFile(file.path, backupRoot, plan.root);
          entries.set(file.path, {
            path: file.path,
            installed_sha256: hash(file.content),
            original_existed: true,
            backup_path: backupPath,
          });
        }
        continue;
      }
      let backupPath: string | null = null;
      let originalExisted = current !== null;
      if (
        current !== null &&
        previousEntry !== undefined &&
        hash(current) === previousEntry.installed_sha256
      ) {
        backupPath = previousEntry.backup_path;
        originalExisted = previousEntry.original_existed;
      } else if (current !== null) {
        backupPath = await backupFile(file.path, backupRoot, plan.root);
      }
      applied.push({ path: file.path, original: current });
      await atomicWriteText(file.path, file.content);
      entries.set(file.path, {
        path: file.path,
        installed_sha256: hash(file.content),
        original_existed: originalExisted,
        backup_path: backupPath,
      });
      changed.push(file.path);
    }
    const manifest: InstallManifest = {
      schema_version: 1,
      package_version: PACKAGE_VERSION,
      scope: plan.scope,
      root: plan.root,
      targets: [...new Set([...(plan.manifest?.targets ?? []), ...plan.targets])],
      files: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestText = stringifyStrictJson(manifest, {
      pretty: true,
      sortKeys: true,
    });
    await atomicWriteText(plan.manifestPath, `${manifestText}\n`);
    if (changed.length === 0) warnings.push('Installation is already up to date.');
    return { changed, warnings };
  } catch (error) {
    for (const item of applied.reverse()) {
      try {
        if (item.original === null) await rm(item.path, { force: true });
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

async function applyUninstall(
  plan: InstallPlan,
): Promise<{ changed: string[]; warnings: string[] }> {
  const changed: string[] = [];
  const warnings: string[] = [];
  if (!plan.manifest) return { changed, warnings };
  const selected = new Set(plan.targets);
  const codexPaths = targetInstallPaths(plan.root, plan.scope, 'codex');
  const claudePaths = targetInstallPaths(plan.root, plan.scope, 'claude');
  const remaining: ManifestEntry[] = [];
  for (const entry of plan.manifest.files) {
    let target: 'codex' | 'claude' | null = null;
    if (codexPaths.has(entry.path)) target = 'codex';
    else if (claudePaths.has(entry.path)) target = 'claude';
    if (target === null || !selected.has(target)) {
      remaining.push(entry);
      continue;
    }
    const current = await fileText(entry.path);
    if (current === null) continue;
    if (hash(current) !== entry.installed_sha256) {
      warnings.push(`Preserved locally modified file: ${entry.path}`);
      remaining.push(entry);
      continue;
    }
    if (entry.original_existed && entry.backup_path) {
      const backup = await fileText(entry.backup_path);
      if (backup === null) {
        warnings.push(`Missing backup; preserved file: ${entry.path}`);
        remaining.push(entry);
        continue;
      }
      await atomicWriteText(entry.path, backup);
    } else {
      await rm(entry.path, { force: true });
    }
    if (entry.backup_path) {
      await rm(entry.backup_path, { force: true });
      await pruneEmptyParents(
        dirname(entry.backup_path),
        join(dirname(plan.manifestPath), 'backups'),
      );
    }
    changed.push(entry.path);
  }
  if (remaining.length === 0) {
    await rm(plan.manifestPath, { force: true });
  } else {
    const targets = plan.manifest.targets.filter((target) => !selected.has(target));
    const manifestText = stringifyStrictJson(
      { ...plan.manifest, targets, files: remaining },
      { pretty: true, sortKeys: true },
    );
    await atomicWriteText(plan.manifestPath, `${manifestText}\n`);
  }
  return { changed, warnings };
}

async function createPlan(
  operation: 'init' | 'uninstall',
  args: InstallArguments,
  environment: InstallerEnvironment,
): Promise<InstallPlan> {
  const cwd = resolve(environment.cwd ?? process.cwd());
  const homeDir = resolve(environment.homeDir ?? homedir());
  const resolved = await resolveRoot(args, cwd, homeDir, operation);
  const targets = selectedTargets(args.target);
  const path = manifestPath(resolved.root);
  const manifest = await readManifest(path, resolved.root, resolved.scope);
  if (operation === 'uninstall') {
    return {
      operation,
      ...resolved,
      targets,
      manifestPath: path,
      files: [],
      manifest,
    };
  }
  const bundlePath = await resolveBundlePath(environment.bundlePath);
  let bundleContent: string;
  try {
    bundleContent = await readFile(bundlePath, 'utf8');
  } catch {
    throw new BatchTasksError(
      'bundle_not_found',
      `Built bundle not found: ${bundlePath}. Run pnpm build before init.`,
      { path: bundlePath },
    );
  }
  if (!bundleContent.startsWith('#!/usr/bin/env node')) {
    throw new BatchTasksError(
      'invalid_bundle',
      `Bundle is missing its node shebang: ${bundlePath}`,
    );
  }
  const files = await buildFiles(resolved.root, resolved.scope, targets, bundleContent);
  await assertWritableTargets(files);
  await preflightFiles(files, manifest, args.force);
  return {
    operation,
    ...resolved,
    targets,
    manifestPath: path,
    files,
    manifest,
  };
}

function promptText(plan: InstallPlan): string {
  const verb = plan.operation === 'init' ? 'Initialize' : 'Uninstall';
  const targets = plan.targets
    .map((target) => (target === 'codex' ? 'Codex' : 'Claude'))
    .join(', ');
  const create = plan.createRoot ? 'yes' : 'no';
  return `${verb} batch-tasks?\n\nPath:    ${plan.root}\nCreate:  ${create}\nTargets: ${targets}\nScope:   ${plan.scope}\n\nProceed? [y/N] `;
}

async function confirmPlan(plan: InstallPlan, environment: InstallerEnvironment): Promise<boolean> {
  const message = promptText(plan);
  if (environment.confirm) return environment.confirm(message);
  const input = environment.stdin ?? (process.stdin as Readable);
  const output = environment.stderr ?? process.stderr;
  const rl = createInterface({
    input,
    output: output as NodeJS.WritableStream,
    terminal: true,
  });
  try {
    const answer = await rl.question(message);
    return /^(?:y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function humanResult(result: InstallerCommandResult): string {
  if (result.status === 'cancelled') return `Cancelled; no files were changed in ${result.path}.\n`;
  if (result.status === 'not_installed') return `batch-tasks is not installed in ${result.path}.\n`;
  if (result.status === 'dry_run') {
    return `Dry run for ${result.path}: ${result.changed_files.length} file(s) would change.\n`;
  }
  const verb = result.status === 'initialized' ? 'Initialized' : 'Uninstalled';
  return `${verb} batch-tasks in ${result.path}; ${result.changed_files.length} file(s) changed.\n`;
}

export async function runInstallerCommand(
  operation: 'init' | 'uninstall',
  argv: readonly string[],
  environment: InstallerEnvironment = {},
): Promise<number> {
  const args = parseInstallArguments(argv);
  const stdout = environment.stdout ?? process.stdout;
  const stderr = environment.stderr ?? process.stderr;
  const plan = await createPlan(operation, args, environment);
  const base = {
    ok: true as const,
    path: plan.root,
    scope: plan.scope,
    targets: plan.targets,
    create: plan.createRoot,
  };
  if (operation === 'uninstall' && !plan.manifest) {
    const result: InstallerCommandResult = {
      ...base,
      status: 'not_installed',
      changed_files: [],
      warnings: [],
    };
    stdout.write(args.json ? `${JSON.stringify(result)}\n` : humanResult(result));
    return 0;
  }
  const previewFiles =
    operation === 'init'
      ? plan.files.map((file) => file.path)
      : plan.manifest!.files.map((file) => file.path);
  if (args.dryRun) {
    const result: InstallerCommandResult = {
      ...base,
      status: 'dry_run',
      changed_files: previewFiles,
      warnings: [],
    };
    stdout.write(args.json ? `${JSON.stringify(result)}\n` : humanResult(result));
    return 0;
  }
  const tty = environment.isTTY ?? environment.stdin?.isTTY ?? process.stdin.isTTY === true;
  if (!args.yes && (args.json || !tty)) {
    invalidArguments('Non-interactive init/uninstall requires --yes');
  }
  if (!args.yes && !(await confirmPlan(plan, { ...environment, stderr }))) {
    const result: InstallerCommandResult = {
      ...base,
      status: 'cancelled',
      changed_files: [],
      warnings: [],
    };
    stdout.write(args.json ? `${JSON.stringify(result)}\n` : humanResult(result));
    return 0;
  }
  const applied = operation === 'init' ? await applyInit(plan) : await applyUninstall(plan);
  const result: InstallerCommandResult = {
    ...base,
    status: operation === 'init' ? 'initialized' : 'uninstalled',
    changed_files: applied.changed,
    warnings: applied.warnings,
  };
  stdout.write(args.json ? `${JSON.stringify(result)}\n` : humanResult(result));
  for (const warning of applied.warnings) stderr.write(`Warning: ${warning}\n`);
  if (operation === 'init') {
    stderr.write(
      'Restart Codex and/or Claude to load the new skill, agents, and MCP server.\n',
    );
  }
  return 0;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
