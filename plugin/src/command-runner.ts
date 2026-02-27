type CommandRunnerOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
};

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: 'exit' | 'timeout' | 'signal' | string;
};

export type CommandRunner = (
  argv: string[],
  optionsOrTimeout: number | CommandRunnerOptions
) => Promise<CommandRunResult>;

export type RuntimeCommandWithTimeout = (
  argv: string[],
  optionsOrTimeout: number | CommandRunnerOptions
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: string;
}>;

export type CommandExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: string;
  error?: string;
};

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown error';
}

export function createRuntimeCommandRunner(runtimeCommand?: RuntimeCommandWithTimeout): CommandRunner | null {
  if (!runtimeCommand) return null;
  return async (argv: string[], optionsOrTimeout: number | CommandRunnerOptions): Promise<CommandRunResult> => {
    const result = await runtimeCommand(argv, optionsOrTimeout);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      signal: result.signal,
      killed: result.killed,
      termination: result.termination
    };
  };
}

export async function runCommand(
  commandRunner: CommandRunner | null | undefined,
  argv: string[],
  optionsOrTimeout: number | CommandRunnerOptions,
  label: string
): Promise<CommandExecResult> {
  if (!commandRunner) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: `${label} is unavailable: OpenClaw runtime command runner is not available`
    };
  }

  try {
    const result = await commandRunner(argv, optionsOrTimeout);
    return {
      ok: result.code === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
      signal: result.signal,
      killed: result.killed,
      termination: result.termination
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: `${label} failed: ${asErrorMessage(error)}`
    };
  }
}

export async function runAndReadStdout(
  commandRunner: CommandRunner | null | undefined,
  argv: string[],
  optionsOrTimeout: number | CommandRunnerOptions,
  label: string
): Promise<string> {
  const result = await runCommand(commandRunner, argv, optionsOrTimeout, label);
  if (!result.ok) {
    const reason = result.error || result.stderr || result.stdout || result.termination || `exit=${String(result.code)}`;
    throw new Error(`${label} failed: ${reason}`);
  }
  return result.stdout.trim();
}

export type { CommandRunnerOptions };
