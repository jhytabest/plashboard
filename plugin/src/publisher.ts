import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAndReadStdout, type CommandRunner } from './command-runner.js';
import type { DisplayProfile, PlashboardConfig } from './types.js';

interface PublishOptions {
  outputPath: string;
  validateOnly: boolean;
  displayProfile: DisplayProfile;
}

export class DashboardValidatorPublisher {
  constructor(
    private readonly config: PlashboardConfig,
    private readonly commandRunner: CommandRunner | null
  ) {}

  async validateOnly(payload: Record<string, unknown>, displayProfile: DisplayProfile): Promise<void> {
    await this.run(payload, {
      validateOnly: true,
      outputPath: this.config.dashboard_output_path,
      displayProfile
    });
  }

  async publish(payload: Record<string, unknown>, displayProfile: DisplayProfile): Promise<string> {
    return this.run(payload, {
      validateOnly: false,
      outputPath: this.config.dashboard_output_path,
      displayProfile
    });
  }

  private async run(payload: Record<string, unknown>, options: PublishOptions): Promise<string> {
    const tempDir = await mkdtemp(join(dirname(options.outputPath), '.plashboard-run-'));
    const inputPath = join(tempDir, 'dashboard.next.json');
    try {
      await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

      const argv = [this.config.python_bin, this.config.writer_script_path, '--input', inputPath];
      if (options.validateOnly) {
        argv.push('--validate-only');
      } else {
        argv.push('--output', options.outputPath);
      }

      return await runAndReadStdout(
        this.commandRunner,
        argv,
        {
          timeoutMs: Math.max(15, this.config.session_timeout_seconds) * 1000,
          env: {
            PLASH_TARGET_VIEWPORT_HEIGHT: String(options.displayProfile.height_px),
            PLASH_LAYOUT_SAFETY_MARGIN: String(options.displayProfile.layout_safety_margin_px),
            PLASH_LAYOUT_OVERFLOW_TOLERANCE: String(this.config.layout_overflow_tolerance_px),
            PLASH_FRAME_GUTTER_TOP: String(options.displayProfile.safe_top_px),
            PLASH_FRAME_GUTTER_BOTTOM: String(options.displayProfile.safe_bottom_px)
          }
        },
        'dashboard writer'
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
