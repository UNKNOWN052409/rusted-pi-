// gpu-under-cap.mjs — GPU burn spawned INSIDE the 0.1-core capped process tree.
// Verifies that a 0.1-core CPU hard-cap does not starve the GPU (matmul is async,
// launches from capped process, compute runs on GPU). Samples nvidia-smi each second.
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const burn = spawn("python", [join(here, "gpu-burn.py")], { stdio: "inherit" });
const samples = [];
const interval = setInterval(() => {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,clocks.sm --format=csv,noheader"
    )
      .toString()
      .trim();
    samples.push(out);
    console.log("[gpu]", out);
  } catch {}
}, 1000);

setTimeout(() => {
  clearInterval(interval);
  burn.kill();
  console.log("=== FINAL (last 6 samples) ===");
  samples.slice(-6).forEach((s) => console.log(s));
  process.exit(0);
}, 40000);
