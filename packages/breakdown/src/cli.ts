import type { CliCommandModule, CliIo } from "@hypit/hypit/cli";
import { resolve } from "node:path";
import { breakdown } from "./index.js";

function help(io: CliIo) {
  io.write("hypit breakdown <video> --to <directory> --allow-paid [--analysis-provider kie|fal] [--threshold 0.08] [--max-shots 100] [--model <endpoint>]\n"
    + "Requires ffmpeg/ffprobe and FAL_KEY; KIE analysis also requires KIE_API_KEY. Uses fal upload/Scribe and the explicitly selected video analysis service. Saves resumable receipts and JSON, Markdown, HTML, clips and source frames. Does not submit media generation. Re-run the same command to resume.\n");
}
export const cliCommandModules = [{
  format: "hypit.cli-command@1", id: "@hypit/breakdown", commands: ["breakdown"],
  writeRootHelp(io) { io.write("\nReference analysis\n  breakdown <video> --to <directory> --allow-paid\n"); },
  writeHelp(_argv, io) { help(io); },
  async run(argv, io, context) {
    const allowed = new Set(["--to", "--threshold", "--max-shots", "--model", "--analysis-provider"]), options = new Map<string, string>();
    let source: string | undefined, allowPaid = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--allow-paid") { allowPaid = true; continue; }
      if (arg.startsWith("--")) {
        if (!allowed.has(arg) || options.has(arg)) throw new Error(`Unknown or repeated option ${arg}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
        options.set(arg, value);
      } else { if (source) throw new Error("Provide exactly one source video"); source = arg; }
    }
    if (!source || !options.get("--to")) throw new Error("A source video and --to directory are required");
    const analysisProvider = options.get("--analysis-provider") ?? "kie";
    if (analysisProvider !== "kie" && analysisProvider !== "fal") throw new Error("--analysis-provider must be kie or fal");
    await breakdown({ source: resolve(context.cwd, source), to: resolve(context.cwd, options.get("--to")!), allowPaid,
      threshold: Number(options.get("--threshold") ?? "0.08"), maxShots: Number(options.get("--max-shots") ?? "100"),
      analysisProvider, ...(options.get("--model") ? { model: options.get("--model")! } : {}), log: message => io.write(message + "\n") });
  },
}] as const satisfies readonly CliCommandModule[];
