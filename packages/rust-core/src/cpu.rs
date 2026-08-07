/// CPU load measurement + system memory

#[cfg(target_os = "windows")]
use std::mem;

pub fn measure_cpu_load() -> f64 {
	let busy1 = cpu_busy_ticks();
	let total1 = cpu_total_ticks();

	std::thread::sleep(std::time::Duration::from_millis(100));

	let busy2 = cpu_busy_ticks();
	let total2 = cpu_total_ticks();

	let busy_delta = busy2.saturating_sub(busy1);
	let total_delta = total2.saturating_sub(total1);

	if total_delta == 0 {
		return 0.0;
	}

	busy_delta as f64 / total_delta as f64
}

pub fn num_cpus() -> u32 {
	std::thread::available_parallelism()
		.map(|n| n.get() as u32)
		.unwrap_or(4)
}

pub fn system_memory_mb() -> u64 {
	#[cfg(target_os = "windows")]
	{
		system_memory_windows()
	}

	#[cfg(target_os = "linux")]
	{
		system_memory_linux()
	}

	#[cfg(not(any(target_os = "windows", target_os = "linux")))]
	{
		4096
	}
}

#[cfg(target_os = "windows")]
fn system_memory_windows() -> u64 {
	#[repr(C)]
	struct MemoryStatusEx {
		dw_length: u32,
		dw_memory_load: u32,
		ull_total_phys: u64,
		ull_avail_phys: u64,
		ull_total_page_file: u64,
		ull_avail_page_file: u64,
		ull_total_virtual: u64,
		ull_avail_virtual: u64,
		ull_avail_extended_virtual: u64,
	}

	extern "system" {
		fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
	}

	let mut state = MemoryStatusEx {
		dw_length: mem::size_of::<MemoryStatusEx>() as u32,
		dw_memory_load: 0,
		ull_total_phys: 0,
		ull_avail_phys: 0,
		ull_total_page_file: 0,
		ull_avail_page_file: 0,
		ull_total_virtual: 0,
		ull_avail_virtual: 0,
		ull_avail_extended_virtual: 0,
	};

	unsafe {
		if GlobalMemoryStatusEx(&mut state) != 0 {
			state.ull_total_phys / (1024 * 1024)
		} else {
			4096
		}
	}
}

#[cfg(target_os = "linux")]
fn system_memory_linux() -> u64 {
	if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
		for line in content.lines() {
			if line.starts_with("MemTotal:") {
				let parts: Vec<&str> = line.split_whitespace().collect();
				if parts.len() >= 2 {
					if let Ok(kb) = parts[1].parse::<u64>() {
						return kb / 1024;
					}
				}
			}
		}
	}
	4096
}

#[cfg(target_os = "windows")]
fn cpu_busy_ticks() -> u64 {
	get_system_times().map(|(idle, kernel, user)| user + kernel - idle).unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn cpu_total_ticks() -> u64 {
	get_system_times().map(|(_, kernel, user)| user + kernel).unwrap_or(1)
}

#[cfg(target_os = "windows")]
fn get_system_times() -> Option<(u64, u64, u64)> {
	extern "system" {
		fn GetSystemTimes(
			lp_idle_time: *mut u64,
			lp_kernel_time: *mut u64,
			lp_user_time: *mut u64,
		) -> i32;
	}

	let mut idle: u64 = 0;
	let mut kernel: u64 = 0;
	let mut user: u64 = 0;

	unsafe {
		if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
			Some((idle, kernel, user))
		} else {
			None
		}
	}
}

#[cfg(not(target_os = "windows"))]
fn cpu_busy_ticks() -> u64 {
	parse_proc_stat().map(|(idle, total)| total - idle).unwrap_or(0)
}

#[cfg(not(target_os = "windows"))]
fn cpu_total_ticks() -> u64 {
	parse_proc_stat().map(|(_, total)| total).unwrap_or(1)
}

fn parse_proc_stat() -> Option<(u64, u64)> {
	let content = std::fs::read_to_string("/proc/stat").ok()?;
	let cpu_line = content.lines().find(|l| l.starts_with("cpu "))?;
	let parts: Vec<u64> = cpu_line
		.split_whitespace()
		.skip(1)
		.filter_map(|s| s.parse().ok())
		.collect();

	if parts.is_empty() {
		return None;
	}

	let total: u64 = parts.iter().sum();
	let idle = parts.get(3).copied().unwrap_or(0);
	let iowait = parts.get(4).copied().unwrap_or(0);

	Some((idle + iowait, total))
}
