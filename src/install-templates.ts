import claudePostprocessorMarkdown from '../templates/install/claude/agents/agent_job_postprocessor.md?raw';
import claudeWorkerMarkdown from '../templates/install/claude/agents/agent_job_worker.md?raw';
import claudeWorkerOrchestration from '../templates/install/claude/worker-orchestration.md?raw';
import codexAgentsEnabledToml from '../templates/install/codex/agents-enabled.toml?raw';
import codexPostprocessorToml from '../templates/install/codex/agents/agent_job_postprocessor.toml?raw';
import codexWorkerToml from '../templates/install/codex/agents/agent_job_worker.toml?raw';
import codexConfigToml from '../templates/install/codex/config.toml?raw';
import openAiMetadataYaml from '../templates/install/codex/openai.yaml?raw';
import codexProjectEnvToml from '../templates/install/codex/project-env.toml?raw';
import codexWorkerOrchestration from '../templates/install/codex/worker-orchestration.md?raw';
import routingBlockMarkdown from '../templates/install/routing-block.md?raw';
import sharedSkillMarkdown from '../templates/install/shared/SKILL.md?raw';

const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

function command(scriptPath: string): string {
  return `node ${JSON.stringify(scriptPath)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (_placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing install template value: ${key}`);
    }
    return value;
  });
}

export const AGENTS_BLOCK_START = '<!-- agent-jobs:start -->';
export const AGENTS_BLOCK_END = '<!-- agent-jobs:end -->';
export const CODEX_CONFIG_BLOCK_START = '# agent-jobs:start';
export const CODEX_CONFIG_BLOCK_END = '# agent-jobs:end';

export function routingBlock(host: 'codex' | 'claude', skillPath: string): string {
  return renderTemplate(routingBlockMarkdown, {
    INSTRUCTION_FILE: host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md',
    SKILL_PATH: skillPath,
  }).trimEnd();
}

export function codexSkill(scriptPath: string): string {
  return renderTemplate(sharedSkillMarkdown, {
    AGENT_JOBS_CLI: command(scriptPath),
    HOST: 'Codex',
    WORKER_ORCHESTRATION: codexWorkerOrchestration.trimEnd(),
  });
}

export function claudeSkill(scriptPath: string): string {
  return renderTemplate(sharedSkillMarkdown, {
    AGENT_JOBS_CLI: command(scriptPath),
    HOST: 'Claude',
    WORKER_ORCHESTRATION: claudeWorkerOrchestration.trimEnd(),
  });
}

export function openAiMetadata(): string {
  return openAiMetadataYaml;
}

function codexProjectEnv(projectRoot?: string): string {
  if (projectRoot === undefined)
    return '';
  return `\n${renderTemplate(codexProjectEnvToml, {
    PROJECT_ROOT: tomlString(projectRoot),
  }).trimEnd()}`;
}

export function codexConfigBlock(
  scriptPath: string,
  projectRoot?: string,
  includeAgents = true,
): string {
  return renderTemplate(codexConfigToml, {
    AGENTS_SECTION: includeAgents ? `${codexAgentsEnabledToml.trimEnd()}\n\n` : '',
    PROJECT_ENV_SECTION: codexProjectEnv(projectRoot),
    SCRIPT_PATH: tomlString(scriptPath),
  }).trimEnd();
}

export function codexWorker(scriptPath: string, projectRoot?: string): string {
  return renderTemplate(codexWorkerToml, {
    PROJECT_ENV_SECTION: codexProjectEnv(projectRoot),
    SCRIPT_PATH: tomlString(scriptPath),
  });
}

export function codexPostprocessor(): string {
  return codexPostprocessorToml;
}

export function claudeWorker(): string {
  return claudeWorkerMarkdown;
}

export function claudePostprocessor(): string {
  return claudePostprocessorMarkdown;
}

export function claudeMcpServer(scriptPath: string, projectRoot?: string): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'node',
    args: [scriptPath, 'mcp'],
    ...(projectRoot ? { env: { AGENT_JOBS_PROJECT_DIR: projectRoot } } : {}),
  };
}

export const CLAUDE_ALLOWED_TOOLS = [
  'mcp__agent_jobs__get_assignment',
  'mcp__agent_jobs__submit_result',
  'mcp__agent_jobs__report_failure',
];

export function isAgentJobsManaged(text: string): boolean {
  return text.includes('Managed by agent-jobs') || text.includes(AGENTS_BLOCK_START);
}
