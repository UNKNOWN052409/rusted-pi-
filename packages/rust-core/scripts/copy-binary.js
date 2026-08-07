const { existsSync, copyFileSync, mkdirSync } = require("fs");
const { join } = require("path");

const src = join(__dirname, "target", "release", "rust_core.dll");
const dest = join(__dirname, "rust-core.win32-x64-msvc.node");

if (existsSync(src)) {
	mkdirSync(join(__dirname, "prebuilds"), { recursive: true });
	copyFileSync(src, dest);
	copyFileSync(src, join(__dirname, "prebuilds", "rust-core.win32-x64-msvc.node"));
	console.log(`Copied ${src} → ${dest}`);
} else {
	console.error(`Build artifact not found: ${src}`);
	console.error("Run 'cargo build --release' first.");
	process.exit(1);
}
