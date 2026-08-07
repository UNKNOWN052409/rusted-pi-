/// GPU detection (nvidia-smi, WMI, /proc/driver/nvidia)

pub fn detect_gpu() -> serde_json::Value {
	#[cfg(target_os = "windows")]
	{
		detect_gpu_windows()
	}

	#[cfg(target_os = "linux")]
	{
		detect_gpu_linux()
	}

	#[cfg(not(any(target_os = "windows", target_os = "linux")))]
	{
		serde_json::json!({
			"available": false,
			"name": "",
			"vramMb": 0,
			"computeCapability": 0.0,
			"smCount": 0,
			"isWddm": false
		})
	}
}

#[cfg(target_os = "windows")]
fn detect_gpu_windows() -> serde_json::Value {
	if let Some(info) = run_nvidia_smi() {
		return info;
	}
	if let Some(info) = detect_windows_wmi() {
		return info;
	}
	serde_json::json!({
		"available": false,
		"name": "",
		"vramMb": 0,
		"computeCapability": 0.0,
		"smCount": 0,
		"isWddm": false
	})
}

fn run_nvidia_smi() -> Option<serde_json::Value> {
	let output = std::process::Command::new("nvidia-smi")
		.args(["--query-gpu=name,memory.total,compute_cap,sm_count,driver_version",
			"--format=csv,noheader,nounits"])
		.output()
		.ok()?;

	if !output.status.success() {
		return None;
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let line = stdout.lines().next()?;
	let parts: Vec<&str> = line.split(", ").collect();
	if parts.len() < 4 {
		return None;
	}

	let name = parts[0].to_string();
	let vram_mb: u64 = parts[1].trim().parse().unwrap_or(0);
	let compute_cap: f64 = parts[2].trim().parse().unwrap_or(0.0);
	let sm_count: u32 = parts[3].trim().parse().unwrap_or(0);
	let is_wddm = parts.get(4).map(|s| s.to_lowercase().contains("wddm")).unwrap_or(false);

	Some(serde_json::json!({
		"available": true,
		"name": name,
		"vramMb": vram_mb,
		"computeCapability": compute_cap,
		"smCount": sm_count,
		"isWddm": is_wddm
	}))
}

#[cfg(target_os = "windows")]
fn detect_windows_wmi() -> Option<serde_json::Value> {
	let output = std::process::Command::new("powershell")
		.args(["-NoProfile", "-Command",
			"Get-CimInstance Win32_VideoController | Select-Object -Property Name, AdapterRAM | ConvertTo-Csv -NoTypeInformation"])
		.output()
		.ok()?;

	if !output.status.success() {
		return None;
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let line = stdout.lines().nth(1)?;
	let parts: Vec<&str> = line.split(',').collect();
	if parts.len() < 2 {
		return None;
	}

	let name = parts[0].trim_matches('"').to_string();
	let vram_str = parts[1].trim_matches('"').trim();
	let vram_mb = vram_str.parse::<u64>().unwrap_or(0) / 1_048_576;
	let is_nvidia = name.to_lowercase().contains("nvidia");

	Some(serde_json::json!({
		"available": true,
		"name": name,
		"vramMb": vram_mb,
		"computeCapability": if is_nvidia { 6.1 } else { 0.0 },
		"smCount": 0,
		"isWddm": true
	}))
}

#[cfg(target_os = "linux")]
fn detect_gpu_linux() -> serde_json::Value {
	if let Some(info) = run_nvidia_smi() {
		return info;
	}
	if let Some(info) = detect_proc_nvidia() {
		return info;
	}
	serde_json::json!({
		"available": false,
		"name": "",
		"vramMb": 0,
		"computeCapability": 0.0,
		"smCount": 0,
		"isWddm": false
	})
}

#[cfg(target_os = "linux")]
fn detect_proc_nvidia() -> Option<serde_json::Value> {
	let gpu_dir = std::path::Path::new("/proc/driver/nvidia/gpus");
	if !gpu_dir.exists() {
		return None;
	}

	for entry in std::fs::read_dir(gpu_dir).ok()?.flatten() {
		let info_path = entry.path().join("information");
		if let Ok(content) = std::fs::read_to_string(info_path) {
			let name = content.lines()
				.find(|l| l.starts_with("Model:"))
				.map(|l| l.trim_start_matches("Model:").trim())
				.unwrap_or("Unknown NVIDIA GPU")
				.to_string();

			return Some(serde_json::json!({
				"available": true,
				"name": name,
				"vramMb": 0,
				"computeCapability": 0.0,
				"smCount": 0,
				"isWddm": false
			}));
		}
	}
	None
}
