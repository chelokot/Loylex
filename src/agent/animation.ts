import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export type PreparedAnimationFile = {
  path: string;
  filename: string;
  cleanup: () => Promise<void>;
};

export function animationConversionArguments(inputPath: string, outputPath: string): string[] {
  return [
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-an",
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareAnimationFile(path: string): Promise<PreparedAnimationFile> {
  const filename = basename(path);
  if (extname(path).toLowerCase() !== ".gif") {
    return { path, filename, cleanup: async () => {} };
  }

  const directory = await mkdtemp(join(tmpdir(), "loylex-animation-"));
  const outputPath = join(directory, "animation.mp4");
  const outputFilename = `${basename(path, extname(path))}.mp4`;
  try {
    const child = Bun.spawn(animationConversionArguments(path, outputPath), {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
    const [exitCode, diagnostics] = await Promise.all([child.exited, stderr]);
    if (exitCode !== 0) {
      throw new Error(diagnostics.trim() || `ffmpeg exited with code ${exitCode}`);
    }
    const output = await stat(outputPath);
    if (!output.isFile() || output.size === 0) {
      throw new Error("ffmpeg produced an empty animation");
    }
    return {
      path: outputPath,
      filename: outputFilename,
      cleanup: () => rm(directory, { force: true, recursive: true }),
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw new Error(`GIF animation normalization failed: ${errorMessage(error)}`);
  }
}
