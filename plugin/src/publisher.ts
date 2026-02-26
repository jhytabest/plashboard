import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { DisplayProfile, PlashboardConfig } from './types.js';

interface PublishOptions {
  outputPath: string;
  validateOnly: boolean;
  displayProfile: DisplayProfile;
}

function spawnPython(
  pythonBin: string,
  scriptPath: string,
  args: string[],
  profile: DisplayProfile,
  tolerance: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, ...args], {
      env: {
        ...process.env,
        PLASH_TARGET_VIEWPORT_HEIGHT: String(profile.height_px),
        PLASH_LAYOUT_SAFETY_MARGIN: String(profile.layout_safety_margin_px),
        PLASH_LAYOUT_OVERFLOW_TOLERANCE: String(tolerance),
        PLASH_FRAME_GUTTER_TOP: String(profile.safe_top_px),
        PLASH_FRAME_GUTTER_BOTTOM: String(profile.safe_bottom_px)
      }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => reject(error));

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `writer script failed with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export class DashboardValidatorPublisher {
  constructor(private readonly config: PlashboardConfig) {}

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

      const args = ['--input', inputPath];
      if (options.validateOnly) {
        args.push('--validate-only');
      } else {
        args.push('--output', options.outputPath);
      }

      const output = await spawnPython(
        this.config.python_bin,
        this.config.writer_script_path,
        args,
        options.displayProfile,
        this.config.layout_overflow_tolerance_px
      );

      return output;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
