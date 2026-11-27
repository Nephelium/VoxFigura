#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::ffi::{c_void, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{webview::PageLoadEvent, Manager, RunEvent};

const FOOTER_MAGIC: &[u8; 8] = b"VFPORT2!";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CACHE_ROOT_MARKER: &str = ".voxfigura-cache-root";
const DEDICATED_SUBDIR_NAME: &str = "VoxFigura-Cache";
const ERROR_ALREADY_EXISTS: u32 = 183;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(
        lp_mutex_attributes: *mut c_void,
        b_initial_owner: i32,
        lp_name: *const u16,
    ) -> *mut c_void;
    fn GetLastError() -> u32;
    fn CloseHandle(h_object: *mut c_void) -> i32;
}

struct SingleInstanceGuard {
    handle: *mut c_void,
}

unsafe impl Send for SingleInstanceGuard {}
unsafe impl Sync for SingleInstanceGuard {}

impl SingleInstanceGuard {
    fn acquire(edition: &str) -> (Option<Self>, bool) {
        let safe_ed: String = edition
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let name = format!(
            "Local\\VoxFigura-SingleInstance-{}",
            if safe_ed.is_empty() { "default" } else { &safe_ed }
        );
        let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        unsafe {
            let handle = CreateMutexW(std::ptr::null_mut(), 0, wide.as_ptr());
            if handle.is_null() {
                return (None, false);
            }
            let already_exists = GetLastError() == ERROR_ALREADY_EXISTS;
            if already_exists {
                let _ = CloseHandle(handle);
                return (None, true);
            }
            (Some(Self { handle }), false)
        }
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

#[derive(Debug, Deserialize)]
struct OverlayMeta {
    edition: String,
    archive_sha256: String,
    manifest_sha256: String,
    #[serde(default)]
    extractor_sha256: Option<String>,
    extractor_offset: u64,
    extractor_len: u64,
    archive_offset: u64,
    archive_len: u64,
}

#[derive(Debug, Deserialize)]
struct BundleManifestFile {
    bytes: u64,
}

#[derive(Debug, Deserialize)]
struct BundleManifest {
    files: HashMap<String, BundleManifestFile>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct LauncherConfig {
    #[serde(rename = "cacheRoot", default, skip_serializing_if = "Option::is_none")]
    cache_root: Option<String>,
    #[serde(rename = "knownCacheRoots", default, skip_serializing_if = "Vec::is_empty")]
    known_cache_roots: Vec<String>,
    #[serde(rename = "autoCleanPolicy", default, skip_serializing_if = "Option::is_none")]
    auto_clean_policy: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Default)]
struct UiStatusState {
    last_status: Option<String>,
    last_error: Option<String>,
}

struct PreparedBundle {
    app_dir: PathBuf,
    cache_root: PathBuf,
    config_path: PathBuf,
    lock_path: PathBuf,
    lock_file: File,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn read_overlay_meta(exe: &mut File) -> Result<OverlayMeta, String> {
    let file_len = exe.metadata().map_err(|e| format!("读取程序元数据失败: {e}"))?.len();
    if file_len < 24 {
        return Err("程序文件不完整，未找到内嵌运行包。".to_string());
    }
    exe.seek(SeekFrom::End(-24)).map_err(|e| format!("定位尾部标记失败: {e}"))?;
    let mut footer = [0u8; 24];
    exe.read_exact(&mut footer).map_err(|e| format!("读取尾部标记失败: {e}"))?;
    if &footer[16..24] != FOOTER_MAGIC {
        return Err("未检测到 VoxFigura 内嵌运行包，请使用正式构建的免安装 EXE。".to_string());
    }
    let meta_offset = u64::from_le_bytes(footer[0..8].try_into().unwrap());
    let meta_len = u64::from_le_bytes(footer[8..16].try_into().unwrap());
    if meta_len == 0 || meta_len > 1024 * 1024 || meta_offset + meta_len > file_len - 24 {
        return Err("内嵌运行包头信息越界或已损坏。".to_string());
    }
    exe.seek(SeekFrom::Start(meta_offset)).map_err(|e| format!("定位包头失败: {e}"))?;
    let mut meta_buf = vec![0u8; meta_len as usize];
    exe.read_exact(&mut meta_buf).map_err(|e| format!("读取包头失败: {e}"))?;
    serde_json::from_slice(&meta_buf).map_err(|e| format!("解析包头 JSON 失败: {e}"))
}

fn peek_edition() -> String {
    env::current_exe()
        .ok()
        .and_then(|p| File::open(p).ok())
        .and_then(|mut f| read_overlay_meta(&mut f).ok())
        .map(|m| m.edition)
        .unwrap_or_else(|| "default".to_string())
}

fn extract_slice(exe: &mut File, offset: u64, len: u64, target: &Path, compute_hash: bool) -> Result<Option<String>, String> {
    exe.seek(SeekFrom::Start(offset)).map_err(|e| format!("定位内嵌数据失败: {e}"))?;
    let mut out = File::create(target).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut hasher = if compute_hash { Some(Sha256::new()) } else { None };
    let mut remaining = len;
    let mut buf = vec![0u8; 1024 * 1024];
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        let n = exe.read(&mut buf[..to_read]).map_err(|e| format!("读取内嵌数据失败: {e}"))?;
        if n == 0 {
            return Err("内嵌运行包数据提前结束，文件可能已损坏。".to_string());
        }
        out.write_all(&buf[..n]).map_err(|e| format!("写入临时文件失败: {e}"))?;
        if let Some(h) = hasher.as_mut() {
            h.update(&buf[..n]);
        }
        remaining -= n as u64;
    }
    out.flush().map_err(|e| format!("刷新临时文件失败: {e}"))?;
    Ok(hasher.map(|h| hex_encode(&h.finalize())))
}

fn is_critical_bundle_file(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.ends_with(".onnx")
        || lower.ends_with(".dll")
        || lower.ends_with(".pyd")
        || lower.ends_with(".exe")
        || lower.starts_with("server/")
    {
        return true;
    }
    matches!(
        lower.as_str(),
        "engine/server.py" | "engine/dense_channel.py" | "engine/validation.py" | "engine/onnx_inference.py"
    )
}

fn is_ready(app: &Path, manifest_hash: &str) -> bool {
    let manifest_path = app.join("bundle-manifest.json");
    if !manifest_path.is_file() {
        return false;
    }
    match sha256_file(&manifest_path) {
        Ok(h) if h == manifest_hash => {}
        _ => return false,
    }
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let manifest: BundleManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(_) => return false,
    };

    for required in [
        "runtime/node/node.exe",
        "runtime/python/python.exe",
        "runtime/media/ffmpeg.exe",
        "server/portable.mjs",
        "server/proxy.mjs",
        "engine/server.py",
    ] {
        if !manifest.files.contains_key(required) {
            return false;
        }
    }

    for (rel, entry) in &manifest.files {
        if !is_critical_bundle_file(rel) {
            continue;
        }
        let target = app.join(rel);
        let meta = match fs::symlink_metadata(&target) {
            Ok(m) => m,
            Err(_) => return false,
        };
        if !meta.is_file() || meta.len() != entry.bytes {
            return false;
        }
    }
    true
}

fn acquire_lock(lock_path: &Path) -> Result<File, String> {
    let start = Instant::now();
    loop {
        match OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .share_mode(0)
            .open(lock_path)
        {
            Ok(file) => return Ok(file),
            Err(err) => {
                if start.elapsed() >= Duration::from_secs(180) {
                    return Err(format!("等待另一实例解压完成超时: {err}"));
                }
                thread::sleep(Duration::from_millis(300));
            }
        }
    }
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{:x}", std::process::id(), nanos)
}

fn same_path_ci(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
        == b.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
}

fn is_safe_direct_cache_dir(dir: &Path) -> Result<bool, ()> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(()),
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(());
            }
            let marker = dir.join(CACHE_ROOT_MARKER);
            if let Ok(m) = fs::symlink_metadata(&marker) {
                if m.is_file() {
                    return Ok(true);
                }
            }
            let mut entries = fs::read_dir(dir).map_err(|_| ())?;
            Ok(entries.next().is_none())
        }
    }
}

fn resolve_cache_root(local_appdata: &str) -> (PathBuf, PathBuf) {
    let base = PathBuf::from(local_appdata).join("VoxFigura");
    let config_path = base.join("launcher-config.json");
    let default_root = base.join("Portable");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(cfg) = serde_json::from_str::<LauncherConfig>(&raw) {
            if let Some(custom) = cfg.cache_root {
                let trimmed = custom.trim();
                let has_ctrl = trimmed.chars().any(|c| c.is_control());
                let candidate = PathBuf::from(trimmed);
                if !trimmed.is_empty() && !has_ctrl && candidate.is_absolute() && candidate.parent().is_some() {
                    if same_path_ci(&candidate, &default_root) {
                        return (default_root, config_path);
                    }
                    match is_safe_direct_cache_dir(&candidate) {
                        Ok(true) => return (candidate, config_path),
                        Ok(false) => {
                            let already_dedicated = candidate
                                .file_name()
                                .map(|n| n.to_string_lossy().eq_ignore_ascii_case(DEDICATED_SUBDIR_NAME))
                                .unwrap_or(false);
                            if !already_dedicated {
                                let subdir = candidate.join(DEDICATED_SUBDIR_NAME);
                                if matches!(is_safe_direct_cache_dir(&subdir), Ok(true)) {
                                    return (subdir, config_path);
                                }
                            }
                        }
                        Err(()) => {}
                    }
                }
            }
        }
    }
    (default_root, config_path)
}

fn ensure_cache_root_marker(root: &Path) {
    let marker = root.join(CACHE_ROOT_MARKER);
    if !marker.is_file() {
        let _ = fs::write(
            &marker,
            "{\n  \"app\": \"VoxFigura\",\n  \"purpose\": \"portable-cache-root\"\n}\n",
        );
    }
}

fn read_launcher_config(config_path: &Path) -> LauncherConfig {
    fs::read_to_string(config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LauncherConfig>(&raw).ok())
        .unwrap_or_default()
}

fn write_launcher_config(config_path: &Path, cfg: &LauncherConfig) {
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut text) = serde_json::to_string_pretty(cfg) {
        text.push('\n');
        let _ = fs::write(config_path, text);
    }
}

fn record_known_cache_root(config_path: &Path, root: &Path) {
    let root_str = root.to_string_lossy().trim().to_string();
    if root_str.is_empty() {
        return;
    }
    let mut cfg = read_launcher_config(config_path);
    if cfg.known_cache_roots.iter().any(|p| same_path_ci(Path::new(p), root)) {
        return;
    }
    cfg.known_cache_roots.push(root_str);
    if cfg.known_cache_roots.len() > 20 {
        let overflow = cfg.known_cache_roots.len() - 20;
        cfg.known_cache_roots.drain(0..overflow);
    }
    write_launcher_config(config_path, &cfg);
}

fn is_valid_version_dir_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("public-")
        .or_else(|| lower.strip_prefix("hackathon-"))
        .or_else(|| lower.strip_prefix("friends-"));
    match rest {
        Some(hex) => hex.len() >= 8 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        None => false,
    }
}

fn parse_incomplete_prefix(name: &str) -> Option<&str> {
    let idx = name.find(".incomplete-")?;
    let prefix = &name[..idx];
    let suffix = &name[idx + ".incomplete-".len()..];
    if is_valid_version_dir_name(prefix)
        && !suffix.is_empty()
        && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Some(prefix)
    } else {
        None
    }
}

fn is_temp_unpack_name(name: &str) -> bool {
    match name.strip_prefix(".u-") {
        Some(suffix) => !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        None => false,
    }
}

fn parse_lock_prefix(name: &str) -> Option<&str> {
    let prefix = name.strip_suffix(".lock")?;
    if is_valid_version_dir_name(prefix) {
        Some(prefix)
    } else {
        None
    }
}

fn is_lock_held(lock_path: &Path) -> bool {
    match fs::symlink_metadata(lock_path) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => {}
        _ => return false,
    }
    match OpenOptions::new().read(true).write(true).open(lock_path) {
        Ok(_) => false,
        Err(err) => matches!(
            err.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock
        ) || err.raw_os_error() == Some(32) || err.raw_os_error() == Some(33),
    }
}

fn try_remove_unlocked_lock(lock_path: &Path) {
    if !is_lock_held(lock_path) {
        let _ = fs::remove_file(lock_path);
    }
}

fn try_prune_empty_historical_root(
    root: &Path,
    active_root: &Path,
    default_root: &Path,
    configured_root: Option<&Path>,
) -> bool {
    if same_path_ci(root, active_root) || same_path_ci(root, default_root) {
        return false;
    }
    if let Some(cfg_root) = configured_root {
        if same_path_ci(root, cfg_root) {
            return false;
        }
    }
    let items: Vec<String> = match fs::read_dir(root) {
        Ok(rd) => rd
            .filter_map(|entry| entry.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return false,
    };
    if items.is_empty() {
        return fs::remove_dir(root).is_ok();
    }
    if items.len() == 1 && items[0] == CACHE_ROOT_MARKER {
        let marker = root.join(CACHE_ROOT_MARKER);
        if fs::symlink_metadata(&marker).map(|m| m.is_file()).unwrap_or(false) {
            let _ = fs::remove_file(&marker);
            return fs::remove_dir(root).is_ok();
        }
    }
    false
}

fn run_startup_cache_maintenance(bundle: &PreparedBundle) {
    let local_appdata = match env::var("LOCALAPPDATA") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return,
    };
    let default_root = PathBuf::from(&local_appdata).join("VoxFigura").join("Portable");
    let active_name = bundle
        .app_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut cfg = read_launcher_config(&bundle.config_path);
    let policy = cfg.auto_clean_policy.as_deref().unwrap_or("manual").to_string();
    let configured_root = cfg
        .cache_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if !roots.iter().any(|existing| same_path_ci(existing, &p)) {
            roots.push(p);
        }
    };
    push_unique(bundle.cache_root.clone());
    if let Some(ref c) = configured_root {
        push_unique(c.clone());
    }
    push_unique(default_root.clone());
    for known in &cfg.known_cache_roots {
        let trimmed = known.trim();
        if !trimmed.is_empty() {
            push_unique(PathBuf::from(trimmed));
        }
    }

    // Always clean orphan 0-byte .lock files whose bundle directory no longer exists.
    for root in &roots {
        let rd = match fs::read_dir(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let is_active_root = same_path_ci(root, &bundle.cache_root);
        let names: Vec<String> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for name in &names {
            let Some(prefix) = parse_lock_prefix(name) else { continue };
            if is_active_root && prefix.eq_ignore_ascii_case(&active_name) {
                continue;
            }
            let has_owner = names.iter().any(|other| {
                other.eq_ignore_ascii_case(prefix)
                    || parse_incomplete_prefix(other)
                        .map(|p| p.eq_ignore_ascii_case(prefix))
                        .unwrap_or(false)
            });
            if !has_owner {
                try_remove_unlocked_lock(&root.join(name));
            }
        }
    }

    if policy != "keep_current" && policy != "keep_recent_2" {
        return;
    }

    let keep_extra_stale: usize = if policy == "keep_recent_2" { 1 } else { 0 };
    let mut stale_versions: Vec<(PathBuf, PathBuf, String, u128)> = Vec::new();

    for root in &roots {
        let rd = match fs::read_dir(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let is_active_root = same_path_ci(root, &bundle.cache_root);
        for entry in rd.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if is_active_root && name.eq_ignore_ascii_case(&active_name) {
                continue;
            }
            if meta.is_dir() && is_valid_version_dir_name(&name) {
                let manifest = path.join("bundle-manifest.json");
                if fs::symlink_metadata(&manifest).map(|m| m.is_file()).unwrap_or(false) {
                    let lock = root.join(format!("{name}.lock"));
                    if !is_lock_held(&lock) {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis())
                            .unwrap_or(0);
                        stale_versions.push((root.clone(), path, name, mtime));
                    }
                }
            } else if let Some(prefix) = parse_incomplete_prefix(&name) {
                let lock = root.join(format!("{prefix}.lock"));
                if !is_lock_held(&lock) {
                    let _ = if meta.is_dir() {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    };
                    try_remove_unlocked_lock(&lock);
                }
            } else if meta.is_dir() && is_temp_unpack_name(&name) {
                let _ = fs::remove_dir_all(&path);
            }
        }
    }

    stale_versions.sort_by(|a, b| b.3.cmp(&a.3));
    for (root, path, name, _) in stale_versions.into_iter().skip(keep_extra_stale) {
        let lock = root.join(format!("{name}.lock"));
        if is_lock_held(&lock) {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            try_remove_unlocked_lock(&lock);
        }
    }

    let mut pruned_any = false;
    for root in &roots {
        if try_prune_empty_historical_root(root, &bundle.cache_root, &default_root, configured_root.as_deref()) {
            cfg.known_cache_roots.retain(|p| !same_path_ci(Path::new(p), root));
            pruned_any = true;
        }
    }
    if pruned_any {
        write_launcher_config(&bundle.config_path, &cfg);
    }
}

fn prepare_bundle(mut on_status: impl FnMut(&str)) -> Result<PreparedBundle, String> {
    let exe_path = env::current_exe().map_err(|e| format!("无法获取当前程序路径: {e}"))?;
    let mut exe_file = File::open(&exe_path).map_err(|e| format!("无法读取当前程序文件: {e}"))?;
    let meta = read_overlay_meta(&mut exe_file)?;

    let local_appdata = env::var("LOCALAPPDATA")
        .ok()
        .filter(|v| !v.trim().is_empty() && Path::new(v).is_absolute())
        .ok_or_else(|| "当前 Windows 账户的 LocalAppData 目录不可用。".to_string())?;

    let (root, config_path) = resolve_cache_root(&local_appdata);
    fs::create_dir_all(&root).map_err(|e| format!("无法创建运行缓存目录 ({}): {e}", root.display()))?;
    ensure_cache_root_marker(&root);
    record_known_cache_root(&config_path, &root);

    let hash_prefix = &meta.archive_sha256[..meta.archive_sha256.len().min(16)];
    let app_dir = root.join(format!("{}-{}", meta.edition, hash_prefix));
    let lock_path = root.join(format!("{}-{}.lock", meta.edition, hash_prefix));
    let lock_file = acquire_lock(&lock_path)?;

    if is_ready(&app_dir, &meta.manifest_sha256) {
        return Ok(PreparedBundle {
            app_dir,
            cache_root: root,
            config_path,
            lock_path,
            lock_file,
        });
    }

    on_status("首次启动，正在校验并解压本地声道运行环境与模型…");
    let scratch = root.join(format!(".u-{}", unique_suffix()));
    fs::create_dir_all(&scratch).map_err(|e| format!("无法创建临时解压目录: {e}"))?;

    let result = (|| -> Result<PathBuf, String> {
        let extractor_path = scratch.join("7zr.exe");
        let archive_path = scratch.join("payload.7z");
        let extracted_dir = scratch.join("app");
        fs::create_dir_all(&extracted_dir).map_err(|e| format!("无法创建解压目标目录: {e}"))?;

        let actual_extractor_hash = extract_slice(
            &mut exe_file,
            meta.extractor_offset,
            meta.extractor_len,
            &extractor_path,
            true,
        )?
        .unwrap_or_default();
        if let Some(expected_ext_hash) = meta.extractor_sha256.as_deref() {
            if !expected_ext_hash.is_empty() && actual_extractor_hash != expected_ext_hash {
                return Err("内嵌解压器 SHA-256 校验不匹配，程序文件可能已损坏。".to_string());
            }
        }

        let actual_hash = extract_slice(&mut exe_file, meta.archive_offset, meta.archive_len, &archive_path, true)?
            .unwrap_or_default();
        if actual_hash != meta.archive_sha256 {
            return Err("内嵌运行包 SHA-256 校验不匹配，文件可能已损坏。".to_string());
        }

        let out_arg = format!("-o{}", extracted_dir.display());
        let status = Command::new(&extractor_path)
            .args(["x", "-y", "-bd", "-bso0", "-bsp0", "-sccUTF-8"])
            .arg(&archive_path)
            .arg(&out_arg)
            .current_dir(&scratch)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("无法启动内嵌解压器: {e}"))?;
        if !status.success() {
            return Err("内嵌运行包解压失败，请检查磁盘空间后重试。".to_string());
        }
        if !is_ready(&extracted_dir, &meta.manifest_sha256) {
            return Err("解压完成后缺少必需的运行文件或文件校验失败。".to_string());
        }
        if app_dir.exists() {
            let stale = root.join(format!("{}-{}.incomplete-{}", meta.edition, hash_prefix, unique_suffix()));
            let _ = fs::rename(&app_dir, &stale);
        }
        fs::rename(&extracted_dir, &app_dir).map_err(|e| format!("移动解压目录失败: {e}"))?;
        Ok(app_dir.clone())
    })();

    let _ = fs::remove_dir_all(&scratch);
    result.map(|dir| PreparedBundle {
        app_dir: dir,
        cache_root: root,
        config_path,
        lock_path,
        lock_file,
    })
}

fn spawn_portable_server(bundle: &PreparedBundle) -> Result<Child, String> {
    let node = bundle.app_dir.join("runtime").join("node").join("node.exe");
    let script = bundle.app_dir.join("server").join("portable.mjs");
    let active_name = bundle
        .app_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .args(["--parent-stdin", "--no-browser"])
        .current_dir(&bundle.app_dir)
        .env("VOCALCUT_PORTABLE_ROOT", &bundle.cache_root)
        .env("VOCALCUT_PORTABLE_ACTIVE", &active_name)
        .env("VOCALCUT_LAUNCHER_CONFIG", &bundle.config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for key in ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_V8_COVERAGE"] {
        cmd.env_remove(key);
    }
    cmd.spawn().map_err(|e| format!("无法启动本地服务进程: {e}"))
}

fn stop_child(child_slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = child_slot.lock() {
        if let Some(mut child) = guard.take() {
            drop(child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(80));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn run_headless(no_browser: bool) -> i32 {
    let bundle = match prepare_bundle(|msg| {
        println!("{msg}");
        let _ = io::stdout().flush();
    }) {
        Ok(b) => b,
        Err(err) => {
            eprintln!("VoxFigura: {err}");
            return 1;
        }
    };

    if !no_browser {
        println!("BUNDLE={}", bundle.app_dir.display());
        let _ = io::stdout().flush();
        let lock_path = bundle.lock_path.clone();
        drop(bundle);
        let _ = fs::remove_file(&lock_path);
        return 0;
    }

    let mut child = match spawn_portable_server(&bundle) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("VoxFigura: {err}");
            return 1;
        }
    };

    // Keep child's stdin open while waiting; Child::wait() drops self.stdin internally.
    let _stdin_keepalive = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let t_out = stdout.map(|out| {
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                println!("{line}");
                let _ = io::stdout().flush();
            }
        })
    });
    let t_err = stderr.map(|err| {
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("{line}");
                let _ = io::stderr().flush();
            }
        })
    });

    let code = match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("VoxFigura: {err}");
            1
        }
    };
    if let Some(t) = t_out {
        let _ = t.join();
    }
    if let Some(t) = t_err {
        let _ = t.join();
    }
    let lock_path = bundle.lock_path.clone();
    drop(bundle);
    let _ = fs::remove_file(&lock_path);
    code
}

fn eval_window_status(window: &tauri::WebviewWindow, fn_name: &str, text: &str) {
    if let (Ok(json_fn), Ok(json_text)) = (serde_json::to_string(fn_name), serde_json::to_string(text)) {
        let script = format!(
            "(function(fn,msg){{if(typeof window[fn]==='function'){{window[fn](msg);}}else{{window.__vfPending=window.__vfPending||[];window.__vfPending.push([fn,msg]);}}}})({json_fn},{json_text});"
        );
        let _ = window.eval(&script);
    }
}

fn set_window_status(
    window: &tauri::WebviewWindow,
    ui_state: &Arc<Mutex<UiStatusState>>,
    fn_name: &str,
    text: &str,
) {
    if let Ok(mut guard) = ui_state.lock() {
        if fn_name == "__vfSetError" {
            guard.last_error = Some(text.to_string());
        } else {
            guard.last_status = Some(text.to_string());
        }
    }
    eval_window_status(window, fn_name, text);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--extract-only") {
        std::process::exit(run_headless(false));
    }
    if args.iter().any(|a| a == "--no-browser") {
        std::process::exit(run_headless(true));
    }

    let edition = peek_edition();
    let (instance_guard, already_running) = SingleInstanceGuard::acquire(&edition);
    let _instance_guard_holder = Arc::new(Mutex::new(instance_guard));

    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_setup = Arc::clone(&child_slot);
    let child_for_exit = Arc::clone(&child_slot);
    let bundle_lock_slot: Arc<Mutex<Option<(File, PathBuf)>>> = Arc::new(Mutex::new(None));
    let bundle_lock_for_setup = Arc::clone(&bundle_lock_slot);
    let bundle_lock_for_exit = Arc::clone(&bundle_lock_slot);
    let ui_state: Arc<Mutex<UiStatusState>> = Arc::new(Mutex::new(UiStatusState::default()));
    let ui_for_load = Arc::clone(&ui_state);
    let ui_for_setup = Arc::clone(&ui_state);

    let app = tauri::Builder::default()
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let url_str = payload.url().as_str();
                if !url_str.starts_with("http://127.0.0.1:") {
                    if let Some(window) = webview.app_handle().get_webview_window("main") {
                        let snapshot = ui_for_load
                            .lock()
                            .ok()
                            .map(|g| (g.last_error.clone(), g.last_status.clone()));
                        if let Some((err_opt, status_opt)) = snapshot {
                            if let Some(err_msg) = err_opt {
                                eval_window_status(&window, "__vfSetError", &err_msg);
                            } else if let Some(status_msg) = status_opt {
                                eval_window_status(&window, "__vfSetStatus", &status_msg);
                            }
                        }
                    }
                }
            }
        })
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window must exist");
            let win_bg = window.clone();
            let ui_bg = Arc::clone(&ui_for_setup);
            if already_running {
                set_window_status(
                    &win_bg,
                    &ui_bg,
                    "__vfSetError",
                    "检测到同版本的 VoxFigura 实例正在运行，请切换回已有窗口或关闭后再重新启动。",
                );
                return Ok(());
            }
            thread::spawn(move || {
                let bundle = match prepare_bundle(|msg| {
                    set_window_status(&win_bg, &ui_bg, "__vfSetStatus", msg);
                }) {
                    Ok(b) => b,
                    Err(err) => {
                        set_window_status(&win_bg, &ui_bg, "__vfSetError", &err);
                        return;
                    }
                };

                run_startup_cache_maintenance(&bundle);

                set_window_status(&win_bg, &ui_bg, "__vfSetStatus", "正在启动本地物理声道与神经推理引擎…");
                let mut child = match spawn_portable_server(&bundle) {
                    Ok(c) => c,
                    Err(err) => {
                        let lp = bundle.lock_path.clone();
                        drop(bundle);
                        let _ = fs::remove_file(&lp);
                        set_window_status(&win_bg, &ui_bg, "__vfSetError", &err);
                        return;
                    }
                };

                if let Ok(mut guard) = bundle_lock_for_setup.lock() {
                    *guard = Some((bundle.lock_file, bundle.lock_path));
                }

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let err_buf = Arc::new(Mutex::new(Vec::<String>::new()));
                let err_buf_writer = Arc::clone(&err_buf);

                if let Some(err_stream) = stderr {
                    thread::spawn(move || {
                        let reader = BufReader::new(err_stream);
                        for line in reader.lines().map_while(Result::ok) {
                            if let Ok(mut buf) = err_buf_writer.lock() {
                                if buf.len() >= 20 {
                                    buf.remove(0);
                                }
                                buf.push(line);
                            }
                        }
                    });
                }

                if let Ok(mut guard) = child_for_setup.lock() {
                    *guard = Some(child);
                }

                let mut origin: Option<String> = None;
                let mut reader_opt = stdout.map(BufReader::new);
                if let Some(reader) = reader_opt.as_mut() {
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let trimmed = line.trim();
                                if let Some(rest) = trimmed.strip_prefix("VoxFigura: ") {
                                    if let Some(url) = rest.split_whitespace().next() {
                                        if url.starts_with("http://127.0.0.1:") {
                                            origin = Some(url.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Keep draining stdout in background so the pipe buffer never blocks Node/Python logs.
                if let Some(mut reader) = reader_opt {
                    thread::spawn(move || {
                        let mut sink = String::new();
                        while matches!(reader.read_line(&mut sink), Ok(n) if n > 0) {
                            sink.clear();
                        }
                    });
                }

                if let Some(url_str) = origin {
                    match url_str.parse::<tauri::Url>() {
                        Ok(parsed) => {
                            if let Err(err) = win_bg.navigate(parsed) {
                                set_window_status(&win_bg, &ui_bg, "__vfSetError", &format!("桌面窗口加载本地工作台失败: {err}"));
                            }
                        }
                        Err(err) => {
                            set_window_status(&win_bg, &ui_bg, "__vfSetError", &format!("本地服务地址无效 ({url_str}): {err}"));
                        }
                    }
                } else {
                    let details = err_buf
                        .lock()
                        .map(|lines| lines.join("\n"))
                        .unwrap_or_default();
                    let msg = if details.trim().is_empty() {
                        "本地引擎启动失败或端口被占用，请检查是否已有 VoxFigura 实例正在运行。".to_string()
                    } else {
                        format!("本地服务启动失败：\n{details}")
                    };
                    set_window_status(&win_bg, &ui_bg, "__vfSetError", &msg);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build VoxFigura Tauri application");

    let guard_for_exit = Arc::clone(&_instance_guard_holder);
    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            stop_child(&child_for_exit);
            if let Ok(mut lock_guard) = bundle_lock_for_exit.lock() {
                if let Some((lock_file, lock_path)) = lock_guard.take() {
                    drop(lock_file);
                    let _ = fs::remove_file(&lock_path);
                }
            }
            if let Ok(mut g) = guard_for_exit.lock() {
                let _ = g.take();
            }
        }
    });
}
