// GPU 100% load test with temperature monitoring (thermal throttling check).
// Runs torch CUDA matmul continuously while sampling nvidia-smi.
import { execSync, spawn } from "node:child_process";

// Start GPU burn (matmul loop) in background
const burn = spawn("python", ["-c", `
import torch, time
a = torch.randn(2048, 2048, device='cuda')
b = torch.randn(2048, 2048, device='cuda')
t0 = time.time()
i = 0
while time.time() - t0 < 30:
    c = a @ b
    torch.cuda.synchronize()
    i += 1
print(f"iters: {i}, avg: {(time.time()-t0)/i*1000:.2f} ms/iter")
`], { shell: true });

// Sample nvidia-smi during burn
const samples = [];
const sampler = setInterval(() => {
	try {
		const out = execSync(
			"nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,clocks.sm,clocks.max.sm --format=csv,noheader",
			{ encoding: "utf8", timeout: 5000 },
		);
		const parts = out.trim().split(", ").map((s) => s.trim());
		samples.push({ util: parseFloat(parts[0]), temp: parseFloat(parts[1]), power: parseFloat(parts[2]), sm: parseFloat(parts[3]), maxSm: parseFloat(parts[4]) });
	} catch { /* ignore */ }
}, 500);

burn.stdout.on("data", (d) => process.stdout.write(`[burn] ${d}`));
burn.stderr.on("data", (d) => process.stderr.write(`[burn-err] ${d}`));
await new Promise((r) => burn.on("close", r));
clearInterval(sampler);

if (samples.length > 0) {
	const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
	const max = (k) => Math.max(...samples.map((s) => s[k]));
	console.log(`samples: ${samples.length}`);
	console.log(`util:    avg ${avg("util").toFixed(1)}%  peak ${max("util")}%`);
	console.log(`temp:    avg ${avg("temp").toFixed(1)}C  peak ${max("temp")}C  (throttle ~87C)`);
	console.log(`power:   avg ${avg("power").toFixed(1)}W  peak ${max("power")}W (max 70W)`);
	console.log(`clocks:  sm avg ${avg("sm").toFixed(0)} MHz / max ${max("sm")} MHz (boost target ${max("maxSm")} MHz)`);
	const throttling = max("temp") >= 86 || avg("sm") < max("maxSm") * 0.8;
	console.log(`thermal throttling: ${throttling ? "YES" : "NO"}`);
} else {
	console.log("no nvidia-smi samples");
}