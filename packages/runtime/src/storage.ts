/** Durable filesystem primitives and strict, bigint-safe JSON helpers. */
import type { Stats } from 'node:fs';
import type { IntegerRepresentation } from './numbers.js';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { fileURLToPath } from 'node:url';
import { JSONParse } from 'json-with-bigint';
import { stringify as stringifyLosslessJson } from 'lossless-json';

import { AgentJobsError } from './errors.js';
import {
  isPreciseNumber,
  parseJsonNumber,
} from './numbers.js';

export type FilePath = string | URL;
export interface StrictJsonStringifyOptions {
  pretty?: boolean;
  sortKeys?: boolean;
}
export interface StrictJsonParseOptions {
  integers?: IntegerRepresentation;
}
export interface AtomicWriteOptions {
  noClobber?: boolean;
}
export interface WithLockOptions {
  timeoutMs?: number;
}

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
  created_at: number;
}

interface LockIdentity {
  dev: number;
  ino: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** Parse strict JSON while retaining every numeric literal without precision loss. */
export function parseStrictJson(
  text: string,
  options: StrictJsonParseOptions = {},
): unknown {
  const { rewritten, tokens } = replaceJsonNumbersWithTokens(text);
  return reviveJsonNumbers(
    JSONParse(rewritten),
    tokens,
    options.integers ?? 'safe-number',
  );
}

/** Encode strict JSON, including bigint and precise decimal numeric literals. */
export function stringifyStrictJson(
  value: unknown,
  options: StrictJsonStringifyOptions = {},
): string {
  assertStrictJsonValue(value);
  const serializable = options.sortKeys ? sortObjectKeys(value) : value;
  const rendered = stringifyLosslessJson(
    serializable,
    null,
    options.pretty ? 2 : undefined,
  );
  if (rendered === undefined) {
    throw new TypeError('Value cannot be represented as JSON');
  }
  return rendered;
}

/** Read a file as fatal UTF-8 instead of silently inserting replacement text. */
export async function readUtf8File(path: FilePath): Promise<string> {
  const source = toPath(path);
  const bytes = await readFile(source);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Run one operation while holding a cross-process exclusive lock. */
export async function withLock<T>(
  lockPath: FilePath,
  operation: () => Promise<T> | T,
  options: WithLockOptions = {},
): Promise<T> {
  const path = toPath(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new AgentJobsError(
      'invalid_lock_timeout',
      'Filesystem lock timeout must be a finite non-negative number',
      { path, timeout_ms: timeoutMs },
    );
  }
  let acquired = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    await ensureLockAnchor(path);
    const release = await acquireOwnedLock(path, timeoutMs);
    acquired = true;

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      await release();
    } catch (error) {
      if (operationError === undefined) {
        throw ioError('lock_error', 'Could not release filesystem lock', path, error);
      }
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    return result as T;
  } catch (error) {
    if (error instanceof AgentJobsError) {
      throw error;
    }
    if (acquired) {
      throw error;
    }
    throw ioError('lock_error', 'Could not acquire filesystem lock', path, error);
  }
}

/** Read a strict UTF-8 JSON document with exact unsafe integers. */
export async function readJson(path: FilePath): Promise<unknown> {
  const source = toPath(path);
  let text: string;
  try {
    text = await readUtf8File(source);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      throw new AgentJobsError(
        'storage_not_found',
        `JSON file does not exist: ${source}`,
        { path: source },
      );
    }
    throw ioError('storage_error', 'Could not read JSON file', source, error);
  }

  try {
    return parseStrictJson(text);
  } catch (error) {
    const details: Record<string, unknown> = { path: source };
    const position = jsonErrorPosition(error);
    if (position !== undefined) {
      const location = lineAndColumn(text, position);
      details.line = location.line;
      details.column = location.column;
    }
    throw new AgentJobsError(
      'invalid_json',
      `Invalid JSON in ${source}: ${errorMessage(error)}`,
      details,
    );
  }
}

/** Atomically and durably publish a strict JSON document. */
export async function atomicWriteJson(
  path: FilePath,
  data: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const destination = toPath(path);
  let text: string;
  try {
    text = stringifyStrictJson(data, { pretty: true, sortKeys: true });
  } catch (error) {
    throw new AgentJobsError(
      'json_not_serializable',
      `Value cannot be encoded as strict JSON: ${errorMessage(error)}`,
      { path: destination },
    );
  }
  await atomicWriteText(destination, `${text}\n`, options);
}

/** Atomically publish UTF-8 text through a synced same-directory temp file. */
export async function atomicWriteText(
  path: FilePath,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const destination = toPath(path);
  let temporary: string | undefined;
  try {
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    temporary = resolve(parent, `.${fileName(destination)}.${randomUUID()}.tmp`);

    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.noClobber === true) {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) {
          throw new AgentJobsError(
            'target_exists',
            `Refusing to overwrite existing file: ${destination}`,
            { path: destination },
          );
        }
        throw error;
      }
      await fsyncDirectory(parent);
      await unlink(temporary);
      temporary = undefined;
    } else {
      await rename(temporary, destination);
      temporary = undefined;
      await fsyncDirectory(parent);
    }
  } catch (error) {
    if (error instanceof AgentJobsError) {
      throw error;
    }
    throw ioError(
      'storage_error',
      'Could not atomically write file',
      destination,
      error,
    );
  } finally {
    if (temporary !== undefined) {
      try {
        await unlink(temporary);
      } catch {
        // A stale, dot-prefixed temp is safe; preserve the primary failure.
      }
    }
  }
}

/** Atomically move a regular file without replacing an existing destination. */
export async function atomicMove(
  source: FilePath,
  destination: FilePath,
): Promise<void> {
  const origin = toPath(source);
  const target = toPath(destination);
  try {
    const info = await lstat(origin);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AgentJobsError(
        'storage_error',
        `Source must be a regular file: ${origin}`,
        { path: target, source: origin },
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await link(origin, target);
    await fsyncDirectory(dirname(target));
    await unlink(origin);
    await fsyncDirectory(dirname(origin));
  } catch (error) {
    if (error instanceof AgentJobsError) {
      throw error;
    }
    if (hasCode(error, 'EEXIST')) {
      throw new AgentJobsError(
        'target_exists',
        `Refusing to overwrite existing file: ${target}`,
        { path: target },
      );
    }
    if (hasCode(error, 'ENOENT')) {
      throw new AgentJobsError(
        'storage_not_found',
        `Source file does not exist: ${origin}`,
        { path: origin },
      );
    }
    if (hasCode(error, 'EXDEV')) {
      throw ioError(
        'cross_device_move',
        'Atomic move requires source and destination on the same filesystem',
        target,
        error,
        origin,
      );
    }
    throw ioError('storage_error', 'Could not atomically move file', target, error, origin);
  }
}

/** Remove one file if present and durably sync its directory entry change. */
export async function safeUnlink(path: FilePath): Promise<boolean> {
  const target = toPath(path);
  try {
    await unlink(target);
    await fsyncDirectory(dirname(target));
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }
    throw ioError('storage_error', 'Could not remove file', target, error);
  }
}

function toPath(value: FilePath): string {
  return value instanceof URL ? fileURLToPath(value) : value;
}

function fileName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(index + 1) || 'file';
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      hasAnyCode(error, ['EINVAL', 'ENOTSUP', 'EBADF', 'EACCES', 'EPERM'])
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertStrictJsonValue(value: unknown, seen = new WeakSet<object>()): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('non-finite numbers are not valid strict JSON');
    }
    return;
  }
  if (isPreciseNumber(value))
    return;
  if (typeof value !== 'object') {
    throw new TypeError(`unsupported JSON value type: ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError('cyclic values are not valid JSON');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertStrictJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('only plain objects can be encoded as strict JSON');
    }
    for (const item of Object.values(value)) assertStrictJsonValue(item, seen);
  }
  seen.delete(value);
}

function sortObjectKeys(value: unknown): unknown {
  if (isPreciseNumber(value))
    return value;
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, item]) => [key, sortObjectKeys(item)]),
    );
  }
  return value;
}

async function ensureLockAnchor(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentJobsError(
        'lock_error',
        `Filesystem lock path must be a regular file: ${path}`,
        { path },
      );
    }
    return;
  } catch (error) {
    if (!hasCode(error, 'ENOENT'))
      throw error;
  }

  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (!hasCode(error, 'EEXIST'))
      throw error;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentJobsError(
        'lock_error',
        `Filesystem lock path must be a regular file: ${path}`,
        { path },
      );
    }
  }
}

async function acquireOwnedLock(
  path: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const lockFile = `${path}.lock`;
  const recoveryClaim = `${lockFile}.recover`;
  const startedAt = Date.now();
  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    created_at: Date.now(),
  };
  const candidate = `${lockFile}.owner-${owner.pid}-${owner.token}`;
  await atomicWriteJson(candidate, owner, { noClobber: true });
  let delayMs = 10;
  let acquired = false;
  let linked = false;
  let identity: LockIdentity | null = null;

  try {
    const candidateInfo = await inspectLockFile(candidate);
    if (candidateInfo === null) {
      throw new AgentJobsError(
        'lock_error',
        `Prepared lock owner disappeared: ${candidate}`,
        { path: candidate },
      );
    }
    identity = lockIdentity(candidateInfo);

    for (;;) {
      if (await recoveryClaimBlocks(recoveryClaim)) {
        await waitForLockRetry(lockFile, startedAt, timeoutMs, delayMs);
        delayMs = Math.min(250, Math.ceil(delayMs * 1.2));
        continue;
      }

      try {
        await link(candidate, lockFile);
        linked = true;
        await fsyncDirectory(dirname(lockFile));
      } catch (error) {
        if (!hasCode(error, 'EEXIST'))
          throw error;
        if (await recoverAbandonedLock(lockFile, recoveryClaim)) {
          delayMs = 10;
          continue;
        }
        await waitForLockRetry(lockFile, startedAt, timeoutMs, delayMs);
        delayMs = Math.min(250, Math.ceil(delayMs * 1.2));
        continue;
      }

      // A reaper may have claimed the previous lock after our pre-link check.
      // Wait for that claim to finish before deciding whether our hard link
      // survived; never unlink a path while another process may replace it.
      while (await recoveryClaimBlocks(recoveryClaim)) {
        await waitForLockRetry(lockFile, startedAt, timeoutMs, delayMs);
        delayMs = Math.min(250, Math.ceil(delayMs * 1.2));
      }

      const current = await inspectLockFile(lockFile);
      if (current === null || !sameLockIdentity(current, identity)) {
        linked = false;
        delayMs = 10;
        continue;
      }
      const currentOwner = await readLockOwner(lockFile);
      if (currentOwner === null || currentOwner.token !== owner.token) {
        throw new AgentJobsError(
          'lock_error',
          `Filesystem lock ownership changed during acquisition: ${lockFile}`,
          { path: lockFile },
        );
      }

      await safeUnlink(candidate);
      const acquiredIdentity = identity;
      acquired = true;
      return async () => releaseOwnedLock(lockFile, owner, acquiredIdentity);
    }
  } finally {
    if (!acquired) {
      if (linked && identity !== null) {
        try {
          await releaseOwnedLock(lockFile, owner, identity);
        } catch {
          // Best effort only: never remove a lock unless both inode and token
          // still identify the candidate created by this acquisition.
        }
      }
      try {
        await safeUnlink(candidate);
      } catch {
        // Preserve the primary acquisition failure.
      }
    }
  }
}

async function releaseOwnedLock(
  lockFile: string,
  expected: LockOwner,
  identity: LockIdentity,
): Promise<void> {
  await assertOwnedLock(lockFile, expected, identity);
  await unlink(lockFile);
  await fsyncDirectory(dirname(lockFile));
}

async function assertOwnedLock(
  lockFile: string,
  expected: LockOwner,
  identity: LockIdentity,
): Promise<void> {
  const info = await inspectLockFile(lockFile);
  const owner = await readLockOwner(lockFile);
  if (info === null || !sameLockIdentity(info, identity)) {
    throw new AgentJobsError(
      'lock_error',
      `Filesystem lock identity changed before release: ${lockFile}`,
      { path: lockFile },
    );
  }
  if (owner === null || owner.token !== expected.token || owner.pid !== expected.pid) {
    throw new AgentJobsError(
      'lock_error',
      `Filesystem lock ownership changed before release: ${lockFile}`,
      { path: lockFile },
    );
  }
}

async function recoverAbandonedLock(
  lockFile: string,
  recoveryClaim: string,
): Promise<boolean> {
  const info = await inspectLockFile(lockFile);
  if (info === null)
    return true;
  const identity = lockIdentity(info);
  const owner = await readLockOwner(lockFile);
  if (owner !== null) {
    if (owner.hostname !== hostname())
      return false;
    if (pidIsAlive(owner.pid))
      return false;
  }

  const claimant: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    created_at: Date.now(),
  };
  try {
    await atomicWriteJson(recoveryClaim, claimant, { noClobber: true });
  } catch (error) {
    if (error instanceof AgentJobsError && error.code === 'target_exists') {
      return false;
    }
    throw error;
  }

  const claimInfo = await inspectLockFile(recoveryClaim);
  if (claimInfo === null) {
    throw new AgentJobsError(
      'lock_error',
      `Recovery claim disappeared after creation: ${recoveryClaim}`,
      { path: recoveryClaim },
    );
  }
  const claimIdentity = lockIdentity(claimInfo);
  try {
    const currentInfo = await inspectLockFile(lockFile);
    if (currentInfo === null)
      return true;
    if (!sameLockIdentity(currentInfo, identity))
      return false;
    const currentOwner = await readLockOwner(lockFile);
    if (currentOwner !== null) {
      if (owner === null || currentOwner.token !== owner.token)
        return false;
      if (currentOwner.hostname !== hostname() || pidIsAlive(currentOwner.pid)) {
        return false;
      }
    }
    // Existing claims are never stolen. Since only this claimant can release
    // this claim, verifying its inode and token immediately before unlinking
    // the primary lock closes the recovery CAS without a pathname race.
    await assertOwnedLock(recoveryClaim, claimant, claimIdentity);
    await unlink(lockFile);
    await fsyncDirectory(dirname(lockFile));
    return true;
  } finally {
    await releaseOwnedLock(recoveryClaim, claimant, claimIdentity);
  }
}

async function recoveryClaimBlocks(path: string): Promise<boolean> {
  return (await inspectLockFile(path)) !== null;
}

async function inspectLockFile(path: string): Promise<Stats | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentJobsError(
        'lock_error',
        `Filesystem lock must be a regular file: ${path}`,
        { path },
      );
    }
    return info;
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      return null;
    throw error;
  }
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT'))
      return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AgentJobsError(
      'lock_error',
      `Filesystem lock owner must be a regular file: ${path}`,
      { path },
    );
  }
  try {
    return parseLockOwner(await readJson(path));
  } catch (error) {
    if (error instanceof AgentJobsError && error.code === 'invalid_json')
      return null;
    throw error;
  }
}

function lockIdentity(info: { dev: number; ino: number }): LockIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameLockIdentity(
  info: { dev: number; ino: number },
  expected: LockIdentity,
): boolean {
  return info.dev === expected.dev && info.ino === expected.ino;
}

function parseLockOwner(value: unknown): LockOwner | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== 'number'
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.hostname !== 'string'
    || record.hostname.length === 0
    || typeof record.token !== 'string'
    || record.token.length === 0
    || typeof record.created_at !== 'number'
    || !Number.isFinite(record.created_at)
  ) {
    return null;
  }
  return {
    pid: record.pid,
    hostname: record.hostname,
    token: record.token,
    created_at: record.created_at,
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH'))
      return false;
    if (hasCode(error, 'EPERM'))
      return true;
    throw error;
  }
}

async function pollingDelay(delayMs: number): Promise<void> {
  const randomized = Math.max(1, Math.round(delayMs * (0.75 + Math.random() * 0.5)));
  await new Promise<void>(resolveDelay => setTimeout(resolveDelay, randomized));
}

async function waitForLockRetry(
  lockFile: string,
  startedAt: number,
  timeoutMs: number,
  delayMs: number,
): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= timeoutMs) {
    throw await lockTimeoutError(lockFile, timeoutMs, elapsed);
  }
  await pollingDelay(Math.min(delayMs, Math.max(1, timeoutMs - elapsed)));
  const waited = Date.now() - startedAt;
  if (waited >= timeoutMs) {
    throw await lockTimeoutError(lockFile, timeoutMs, waited);
  }
}

async function lockTimeoutError(
  lockFile: string,
  timeoutMs: number,
  waitedMs: number,
): Promise<AgentJobsError> {
  const details: Record<string, unknown> = {
    path: lockFile,
    timeout_ms: timeoutMs,
    waited_ms: waitedMs,
  };
  try {
    const owner = await readLockOwner(lockFile);
    if (owner !== null)
      details.owner = owner;
  } catch (error) {
    details.owner_error = errorMessage(error);
  }
  const recoveryClaim = `${lockFile}.recover`;
  try {
    if ((await inspectLockFile(recoveryClaim)) !== null) {
      details.recovery_claim_path = recoveryClaim;
      const recoveryOwner = await readLockOwner(recoveryClaim);
      details.recovery_claim_owner = recoveryOwner;
    }
  } catch (error) {
    details.recovery_claim_error = errorMessage(error);
  }
  return new AgentJobsError(
    'lock_timeout',
    `Timed out after ${waitedMs}ms waiting for filesystem lock: ${lockFile}`,
    details,
  );
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0)
      return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function ioError(
  code: string,
  message: string,
  path: string,
  error: unknown,
  source?: string,
): AgentJobsError {
  const details: Record<string, unknown> = {
    path,
    reason: errorMessage(error),
  };
  if (source !== undefined)
    details.source = source;
  if (isErrnoException(error) && error.errno !== undefined) {
    details.errno = error.errno;
  }
  return new AgentJobsError(code, `${message}: ${errorMessage(error)}`, details);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function hasCode(error: unknown, code: string): boolean {
  return isErrnoException(error) && error.code === code;
}

function hasAnyCode(error: unknown, codes: readonly string[]): boolean {
  return isErrnoException(error) && codes.includes(error.code ?? '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonErrorPosition(error: unknown): number | undefined {
  const match = /(?:position|at position)\s+(\d+)/i.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const prefix = text.slice(0, position);
  const lines = prefix.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function replaceJsonNumbersWithTokens(text: string): {
  rewritten: string;
  tokens: ReadonlyMap<string, string>;
} {
  let prefix: string;
  do {
    prefix = `__agent_jobs_number_${randomUUID()}_`;
  } while (text.includes(prefix));
  const tokens = new Map<string, string>();
  let rewritten = '';
  let index = 0;
  let tokenIndex = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const end = skipJsonString(text, index);
      rewritten += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === '-' || (character !== undefined && /\d/.test(character))) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(
        text.slice(index),
      );
      if (match) {
        const marker = `${prefix}${tokenIndex}`;
        tokenIndex += 1;
        tokens.set(marker, match[0]);
        rewritten += JSON.stringify(marker);
        index += match[0].length;
        continue;
      }
    }
    rewritten += character;
    index += 1;
  }
  return { rewritten, tokens };
}

function skipJsonString(text: string, openingQuote: number): number {
  let index = openingQuote + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"')
      return index + 1;
    index += 1;
  }
  return index;
}

function reviveJsonNumbers(
  value: unknown,
  tokens: ReadonlyMap<string, string>,
  integers: IntegerRepresentation,
): unknown {
  if (typeof value === 'string') {
    const token = tokens.get(value);
    return token === undefined ? value : parseJsonNumber(token, integers);
  }
  if (Array.isArray(value))
    return value.map(item => reviveJsonNumbers(item, tokens, integers));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        reviveJsonNumbers(item, tokens, integers),
      ]),
    );
  }
  return value;
}
