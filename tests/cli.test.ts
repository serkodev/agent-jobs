import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { AgentJobsError, type AgentJobsRuntime } from '@agent-jobs/runtime';

import { runCli, runProcessCli } from '../src/cli.js';

function captureStream(): {
  stream: Pick<NodeJS.WritableStream, 'write'>;
  read: () => string;
} {
  let output = '';
  return {
    stream: {
      write(chunk: unknown): boolean {
        output += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WritableStream, 'write'>,
    read: () => output,
  };
}

function fakeRuntime(overrides: Partial<AgentJobsRuntime> = {}): AgentJobsRuntime {
  return {
    prepare: vi.fn().mockResolvedValue({ job_id: 'job' }),
    next: vi.fn().mockResolvedValue({ assignments: [] }),
    status: vi.fn().mockResolvedValue({ counts: { pending: 0 } }),
    validate: vi.fn().mockResolvedValue({ valid: true }),
    collect: vi.fn().mockResolvedValue({ path: '/tmp/aggregate.json' }),
    doctor: vi.fn().mockResolvedValue({ ok: true, registry_dir: '/tmp/registry' }),
    ...overrides,
  } as unknown as AgentJobsRuntime;
}

describe('runCli', () => {
  it('maps kebab-case prepare options to the async runtime contract', async () => {
    const runtime = fakeRuntime();
    const stdout = captureStream();
    const exitCode = await runCli(
      [
        'prepare',
        '--input-data',
        'data.json',
        '--task-spec',
        'spec/task.md',
        '--id-column-key',
        'id',
        '--output-dir',
        'output',
        '--max-concurrency',
        '4',
        '--max-retries',
        '0',
        '--retry-invalid',
        '--on-error',
        'continue_successes',
        '--collect-format',
        'jsonl',
      ],
      { runtime, stdout: stdout.stream },
    );

    expect(exitCode).toBe(0);
    expect(runtime.prepare).toHaveBeenCalledWith({
      inputData: 'data.json',
      taskSpec: 'spec/task.md',
      idColumnKey: 'id',
      outputDir: 'output',
      maxConcurrency: 4,
      maxRetries: 0,
      retryInvalid: true,
      onError: 'continue_successes',
      collectFormat: 'jsonl',
    });
    expect(JSON.parse(stdout.read())).toEqual({
      ok: true,
      job_id: 'job',
    });
  });

  it('dispatches job commands with the stable argument order', async () => {
    const runtime = fakeRuntime();
    const stdout = captureStream();

    expect(
      await runCli(
        [
          'next',
          '--output-dir',
          'output',
          '--job-id',
          'abc',
          '--count',
          '3',
        ],
        { runtime, stdout: stdout.stream },
      ),
    ).toBe(0);
    expect(runtime.next).toHaveBeenCalledWith('output', 'abc', { count: 3 });
  });

  it('emits domain failures as one machine-readable JSON object', async () => {
    const runtime = fakeRuntime({
      prepare: vi
        .fn()
        .mockRejectedValue(
          new AgentJobsError('duplicate_id', 'Canonical ID is duplicated'),
        ),
    });
    const stdout = captureStream();

    const exitCode = await runCli(
      [
        'prepare',
        '--input-data',
        'data.json',
        '--task-spec',
        'task.md',
        '--id-column-key',
        'id',
        '--output-dir',
        'output',
      ],
      { runtime, stdout: stdout.stream },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: false,
      error: {
        code: 'duplicate_id',
        message: 'Canonical ID is duplicated',
      },
    });
  });

  it('turns parser errors into the same machine-readable domain contract', async () => {
    const stdout = captureStream();
    const exitCode = await runCli(['next', '--count', 'zero'], {
      runtime: fakeRuntime(),
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(2);
    const payload = JSON.parse(stdout.read()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('invalid_arguments');
  });

  it('preserves doctor failure payloads and returns status 2', async () => {
    const runtime = fakeRuntime({
      doctor: vi.fn().mockResolvedValue({
        ok: false,
        checks: [{ name: 'output_dir', ok: false }],
      }),
    });
    const stdout = captureStream();

    const exitCode = await runCli(
      ['doctor', '--output-dir', 'missing'],
      { runtime, stdout: stdout.stream },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: false,
      checks: [{ name: 'output_dir', ok: false }],
    });
  });

  it('starts MCP without writing JSON to the protocol stream', async () => {
    const stdout = captureStream();
    const start = vi.fn().mockResolvedValue(undefined);

    expect(await runCli(['mcp'], { runMcp: start, stdout: stdout.stream })).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(stdout.read()).toBe('');
  });

  it('emits one interrupted JSON result and exit 130 on SIGINT', async () => {
    let finishStatus!: (value: Record<string, unknown>) => void;
    const runtime = fakeRuntime({
      status: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            finishStatus = resolve;
          }),
      ),
    });
    const stdout = captureStream();
    const signals = new EventEmitter();
    const exit = vi.fn();
    const running = runProcessCli(
      ['status', '--output-dir', 'output', '--job-id', 'abc'],
      {
        runtime,
        stdout: stdout.stream,
        signalTarget: signals,
        exit,
      },
    );
    await vi.waitFor(() => expect(runtime.status).toHaveBeenCalledOnce());

    signals.emit('SIGINT');
    finishStatus({ ok: true, counts: { completed: 1 } });

    await expect(running).resolves.toBe(130);
    expect(exit).toHaveBeenCalledWith(130);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: false,
      error: {
        code: 'interrupted',
        message: 'Batch command interrupted by SIGINT',
      },
    });
  });
});
