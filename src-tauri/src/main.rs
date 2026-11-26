#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent};

const FOOTER_MAGIC: &[u8; 8] = b"VFPORT2!";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Deserialize)]
struct OverlayMeta {
    edition: String,
    archive_sha256: String,
    manifest_sha256: String,
    extractor_offset: u64,
    extractor_len: u64,
    archive_offset: u64,
    archive_len: u64,
}

#[derive(Debug, Default, Deserialize)]
struct LauncherConfig {
    #[serde(rename = "cacheRoot")]
    cache_root: Option<String>,
}

struct PreparedBundle {
    app_dir: PathBuf,
    cache_root: PathBuf,
    config_path: PathBuf,
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

fn is_ready(app: &Path, manifest_hash: &str) -> bool {
    let manifest = app.join("bundle-manifest.json");
    if !manifest.is_file() {
        return false;
    }
    match sha256_file(&manifest) {
        Ok(h) if h == manifest_hash => {
            app.join("runtime").join("node").join("node.exe").is_file()
                && app.join("runtime").join("python").join("python.exe").is_file()
                && app.join("server").join("portable.mjs").is_file()
        }
        _ => false,
    }
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

fn resolve_cache_root(local_appdata: &str) -> (PathBuf, PathBuf) {
    let base = PathBuf::from(local_appdata).join("VoxFigura");
    let config_path = base.join("launcher-config.json");
    let default_root = base.join("Portable");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(cfg) = serde_json::from_str::<LauncherConfig>(&raw) {
            if let Some(custom) = cfg.cache_root {
                let trimmed = custom.trim();
                let candidate = PathBuf::from(trimmed);
                if !trimmed.is_empty() && candidate.is_absolute() && candidate.parent().is_some() {
                    return (candidate, config_path);
                }
            }
        }
    }
    (default_root, config_path)
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

    let hash_prefix = &meta.archive_sha256[..meta.archive_sha256.len().min(16)];
    let app_dir = root.join(format!("{}-{}", meta.edition, hash_prefix));
    let lock_path = root.join(format!("{}-{}.lock", meta.edition, hash_prefix));
    let _lock = acquire_lock(&lock_path)?;

    if is_ready(&app_dir, &meta.manifest_sha256) {
        return Ok(PreparedBundle {
            app_dir,
            cache_root: root,
            config_path,
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

        extract_slice(&mut exe_file, meta.extractor_offset, meta.extractor_len, &extractor_path, false)?;
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
            return Err("解压完成后缺少必需的运行文件。".to_string());
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
    code
}

fn set_window_status(window: &tauri::WebviewWindow, fn_name: &str, text: &str) {
    if let Ok(json_text) = serde_json::to_string(text) {
        let script = format!("window.{fn_name} && window.{fn_name}({json_text});");
        let _ = window.eval(&script);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--extract-only") {
        std::process::exit(run_headless(false));
    }
    if args.iter().any(|a| a == "--no-browser") {
        std::process::exit(run_headless(true));
    }

    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_setup = Arc::clone(&child_slot);
    let child_for_exit = Arc::clone(&child_slot);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window must exist");
            let win_bg = window.clone();
            thread::spawn(move || {
                let bundle = match prepare_bundle(|msg| {
                    set_window_status(&win_bg, "__vfSetStatus", msg);
                }) {
                    Ok(b) => b,
                    Err(err) => {
                        set_window_status(&win_bg, "__vfSetError", &err);
                        return;
                    }
                };

                set_window_status(&win_bg, "__vfSetStatus", "正在启动本地物理声道与神经推理引擎…");
                let mut child = match spawn_portable_server(&bundle) {
                    Ok(c) => c,
                    Err(err) => {
                        set_window_status(&win_bg, "__vfSetError", &err);
                        return;
                    }
                };

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
                                set_window_status(&win_bg, "__vfSetError", &format!("桌面窗口加载本地工作台失败: {err}"));
                            }
                        }
                        Err(err) => {
                            set_window_status(&win_bg, "__vfSetError", &format!("本地服务地址无效 ({url_str}): {err}"));
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
                    set_window_status(&win_bg, "__vfSetError", &msg);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build VoxFigura Tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            stop_child(&child_for_exit);
        }
    });
}
