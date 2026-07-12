use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DEFAULT_SCRIPT: &str = "/root/awg/manage_amneziawg.sh";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ActiveSession {
    socket: PathBuf,
    destination: String,
    port: u16,
}

static ACTIVE_SESSIONS: OnceLock<Mutex<HashSet<ActiveSession>>> = OnceLock::new();
static APP_RUNNING: AtomicBool = AtomicBool::new(true);

fn sessions() -> &'static Mutex<HashSet<ActiveSession>> {
    ACTIVE_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn session_for(profile: &SshProfile) -> ActiveSession {
    let destination = format!("{}@{}", profile.user, profile.host);
    let mut hasher = DefaultHasher::new();
    destination.hash(&mut hasher);
    profile.port.hash(&mut hasher);
    ActiveSession {
        socket: PathBuf::from(format!(
            "/tmp/amneziawg-manager-{:016x}.sock",
            hasher.finish()
        )),
        destination,
        port: profile.port,
    }
}

fn close_all_sessions() {
    APP_RUNNING.store(false, Ordering::Relaxed);
    let active = sessions()
        .lock()
        .map(|mut guard| guard.drain().collect::<Vec<_>>())
        .unwrap_or_default();
    for session in active {
        if session.socket.exists() {
            let _ = Command::new("/usr/bin/ssh")
                .args(["-S", &session.socket.to_string_lossy(), "-O", "exit", "-p"])
                .arg(session.port.to_string())
                .arg(&session.destination)
                .output();
        }
        let _ = fs::remove_file(&session.socket);
    }
}

fn keep_sessions_alive() {
    let active = sessions()
        .lock()
        .map(|guard| guard.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session in active {
        if session.socket.exists() {
            let _ = Command::new("/usr/bin/ssh")
                .args(["-S", &session.socket.to_string_lossy(), "-O", "check", "-p"])
                .arg(session.port.to_string())
                .arg(&session.destination)
                .output();
        }
    }
}

fn start_keepalive() {
    APP_RUNNING.store(true, Ordering::Relaxed);
    thread::spawn(|| {
        while APP_RUNNING.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(120));
            if APP_RUNNING.load(Ordering::Relaxed) {
                keep_sessions_alive();
            }
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProfile {
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    private_key: Option<String>,
    use_sudo: bool,
    script_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManageRequest {
    action: String,
    client_names: Option<Vec<String>>,
    client: Option<String>,
    parameter: Option<String>,
    value: Option<String>,
    expires: Option<String>,
    psk: Option<bool>,
    carrier: Option<String>,
    backup_path: Option<String>,
    verbose: Option<bool>,
    apply_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    success: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    display_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile {
    name: String,
    mime_type: String,
    base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    name: String,
    path: String,
    size: u64,
    modified_at: f64,
}

struct TemporaryKey(PathBuf);

impl Drop for TemporaryKey {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn prepare_identity(profile: &SshProfile) -> Result<(String, Option<TemporaryKey>), String> {
    if let Some(identity) = profile.identity_file.as_deref().filter(|v| !v.is_empty()) {
        if !Path::new(identity).is_absolute() || identity.contains(['\n', '\r', '\0']) {
            return Err("Путь к SSH-ключу должен быть абсолютным".into());
        }
        if !Path::new(identity).is_file() {
            return Err(format!("SSH-ключ не найден: {identity}"));
        }
        return Ok((identity.to_string(), None));
    }

    let key = profile.private_key.as_deref().unwrap_or("").trim();
    if key.is_empty() {
        return Err("Укажите путь к приватному SSH-ключу или вставьте ключ целиком".into());
    }
    if key.contains('\0')
        || !key.starts_with("-----BEGIN ")
        || !key.contains(" PRIVATE KEY-----")
        || !key.contains("-----END ")
    {
        return Err("Вставленный SSH-ключ должен содержать строки BEGIN и END PRIVATE KEY".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "amneziawg-manager-{}-{stamp}.key",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("Не удалось подготовить временный SSH-ключ: {e}"))?;
    file.write_all(key.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("Не удалось записать временный SSH-ключ: {e}"))?;
    Ok((
        path.to_string_lossy().into_owned(),
        Some(TemporaryKey(path)),
    ))
}

fn validate_simple(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '@'))
    {
        return Err(format!("Некорректное значение: {label}"));
    }
    Ok(())
}

fn validate_client(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 63
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Некорректное имя клиента: {name}"));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn script_path(profile: &SshProfile) -> Result<&str, String> {
    let path = profile.script_path.as_deref().unwrap_or(DEFAULT_SCRIPT);
    if !path.starts_with('/')
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'))
    {
        return Err("Путь к manage_amneziawg.sh должен быть абсолютным".into());
    }
    Ok(path)
}

fn build_manage_args(request: &ManageRequest) -> Result<Vec<String>, String> {
    let mut args = vec!["--no-color".to_string(), "--yes".to_string()];

    if let Some(mode) = request.apply_mode.as_deref() {
        if !matches!(mode, "syncconf" | "restart") {
            return Err("Неизвестный режим применения конфигурации".into());
        }
        args.push(format!("--apply-mode={mode}"));
    }

    match request.action.as_str() {
        "list" => {
            args.push("--json".into());
            if request.verbose.unwrap_or(true) {
                args.push("-v".into());
            }
            args.push("list".into());
        }
        "list-text" => args.extend(["-v".into(), "list".into()]),
        "stats" => args.extend(["--json".into(), "stats".into()]),
        "add" | "remove" => {
            let names = request
                .client_names
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or("Не указаны клиенты")?;
            for name in names {
                validate_client(name)?;
            }
            if request.action == "add" {
                if let Some(expires) = request.expires.as_deref().filter(|v| !v.is_empty()) {
                    if !matches!(expires, "1h" | "12h" | "1d" | "7d" | "30d" | "4w") {
                        return Err("Недопустимый срок действия".into());
                    }
                    args.push(format!("--expires={expires}"));
                }
                if request.psk.unwrap_or(false) {
                    args.push("--psk".into());
                }
            }
            args.push(request.action.clone());
            args.extend(names.iter().cloned());
        }
        "regen" => {
            args.push("regen".into());
            if let Some(client) = request.client.as_deref().filter(|v| !v.is_empty()) {
                validate_client(client)?;
                args.push(client.into());
            }
        }
        "modify" => {
            let client = request.client.as_deref().ok_or("Не указан клиент")?;
            validate_client(client)?;
            let parameter = request.parameter.as_deref().ok_or("Не указан параметр")?;
            if !matches!(
                parameter,
                "DNS" | "Endpoint" | "AllowedIPs" | "PersistentKeepalive"
            ) {
                return Err("Этот параметр нельзя изменять".into());
            }
            let value = request
                .value
                .as_deref()
                .filter(|v| !v.is_empty())
                .ok_or("Не указано значение")?;
            if value.contains(['\n', '\r', '\0']) || value.len() > 4096 {
                return Err("Некорректное значение параметра".into());
            }
            args.extend([
                "modify".into(),
                client.into(),
                parameter.into(),
                value.into(),
            ]);
        }
        "backup" | "check" | "show" | "restart" | "repair-module" | "help" => {
            args.push(request.action.clone());
        }
        "restore" => {
            let path = request
                .backup_path
                .as_deref()
                .ok_or("Не выбран файл резервной копии")?;
            if !path.starts_with("/root/awg/backups/")
                || !path.ends_with(".tar.gz")
                || !path
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'))
            {
                return Err("Недопустимый путь резервной копии".into());
            }
            args.extend(["restore".into(), path.into()]);
        }
        "diagnose" => {
            if let Some(carrier) = request.carrier.as_deref().filter(|v| !v.is_empty()) {
                validate_simple(carrier, "оператор")?;
                args.push(format!("--carrier={carrier}"));
            }
            args.push("diagnose".into());
        }
        _ => return Err("Команда не разрешена приложением".into()),
    }
    Ok(args)
}

fn execute_ssh(profile: &SshProfile, remote_command: &str) -> Result<Output, String> {
    validate_simple(&profile.host, "сервер")?;
    validate_simple(&profile.user, "пользователь")?;
    if profile.port == 0 {
        return Err("Некорректный SSH-порт".into());
    }
    let (identity_file, _temporary_key) = prepare_identity(&profile)?;
    let session = session_for(profile);
    let port = profile.port.to_string();
    let mut command = Command::new("/usr/bin/ssh");
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=12",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPersist=180",
        "-o",
        &format!("ControlPath={}", session.socket.to_string_lossy()),
        "-p",
        &port,
    ]);
    command.args(["-o", "IdentitiesOnly=yes", "-i", &identity_file]);
    command.arg(&session.destination);
    command.arg(remote_command);
    let output = command
        .output()
        .map_err(|e| format!("Не удалось запустить SSH: {e}"))?;
    if output.status.success() && session.socket.exists() {
        if let Ok(mut active) = sessions().lock() {
            active.insert(session);
        }
    }
    Ok(output)
}

#[tauri::command]
fn run_manage(profile: SshProfile, request: ManageRequest) -> Result<CommandResult, String> {
    let path = script_path(&profile)?;
    let manage_args = build_manage_args(&request)?;
    let mut remote_parts = Vec::new();
    if profile.use_sudo && profile.user != "root" {
        remote_parts.extend(["sudo".to_string(), "-n".to_string()]);
    }
    remote_parts.extend(["bash".to_string(), shell_quote(path)]);
    remote_parts.extend(manage_args.iter().map(|arg| shell_quote(arg)));
    let output = execute_ssh(&profile, &remote_parts.join(" "))?;
    Ok(CommandResult {
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        display_command: format!("manage_amneziawg.sh {}", manage_args.join(" ")),
    })
}

fn awg_dir(profile: &SshProfile) -> Result<String, String> {
    let path = Path::new(script_path(profile)?);
    path.parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .ok_or_else(|| "Не удалось определить директорию AmneziaWG".into())
}

#[tauri::command]
fn read_client_file(
    profile: SshProfile,
    client: String,
    file_type: String,
) -> Result<RemoteFile, String> {
    validate_client(&client)?;
    let (extension, mime_type) = match file_type.as_str() {
        "conf" => ("conf", "text/plain"),
        "qr" => ("png", "image/png"),
        "vpnuri" => ("vpnuri", "text/plain"),
        _ => return Err("Этот тип файла не разрешён".into()),
    };
    let file_name = format!("{client}.{extension}");
    let path = format!("{}/{}", awg_dir(&profile)?, file_name);
    let prefix = if profile.use_sudo && profile.user != "root" {
        "sudo -n "
    } else {
        ""
    };
    let remote = format!("{prefix}base64 -w 0 -- {}", shell_quote(&path));
    let output = execute_ssh(&profile, &remote)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(RemoteFile {
        name: file_name,
        mime_type: mime_type.into(),
        base64: String::from_utf8_lossy(&output.stdout).trim().to_string(),
    })
}

#[tauri::command]
fn list_backups(profile: SshProfile) -> Result<Vec<BackupInfo>, String> {
    let directory = format!("{}/backups", awg_dir(&profile)?);
    let prefix = if profile.use_sudo && profile.user != "root" {
        "sudo -n "
    } else {
        ""
    };
    let remote = format!(
        "{prefix}find {} -maxdepth 1 -type f -name 'awg_backup_*.tar.gz' -printf '%f\\t%s\\t%T@\\n' | sort -r",
        shell_quote(&directory)
    );
    let output = execute_ssh(&profile, &remote)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut backups = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 3 {
            continue;
        }
        let name = fields[0];
        if !name.starts_with("awg_backup_") || !name.ends_with(".tar.gz") {
            continue;
        }
        backups.push(BackupInfo {
            name: name.into(),
            path: format!("{directory}/{name}"),
            size: fields[1].parse().unwrap_or(0),
            modified_at: fields[2].parse().unwrap_or(0.0),
        });
    }
    Ok(backups)
}

fn validate_backup_path(profile: &SshProfile, path: &str) -> Result<String, String> {
    let directory = format!("{}/backups/", awg_dir(profile)?);
    if !path.starts_with(&directory)
        || !path.ends_with(".tar.gz")
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'))
    {
        return Err("Недопустимый путь резервной копии".into());
    }
    Ok(path.to_string())
}

#[tauri::command]
fn read_backup(profile: SshProfile, path: String) -> Result<RemoteFile, String> {
    let path = validate_backup_path(&profile, &path)?;
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Некорректное имя резервной копии")?
        .to_string();
    let prefix = if profile.use_sudo && profile.user != "root" {
        "sudo -n "
    } else {
        ""
    };
    let output = execute_ssh(
        &profile,
        &format!("{prefix}base64 -w 0 -- {}", shell_quote(&path)),
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(RemoteFile {
        name,
        mime_type: "application/gzip".into(),
        base64: String::from_utf8_lossy(&output.stdout).trim().to_string(),
    })
}

#[tauri::command]
fn delete_backup(profile: SshProfile, path: String) -> Result<(), String> {
    let path = validate_backup_path(&profile, &path)?;
    let prefix = if profile.use_sudo && profile.user != "root" {
        "sudo -n "
    } else {
        ""
    };
    let output = execute_ssh(&profile, &format!("{prefix}rm -- {}", shell_quote(&path)))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    start_keepalive();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            run_manage,
            read_client_file,
            list_backups,
            read_backup,
            delete_backup
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                close_all_sessions();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                close_all_sessions();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(action: &str) -> ManageRequest {
        ManageRequest {
            action: action.into(),
            client_names: None,
            client: None,
            parameter: None,
            value: None,
            expires: None,
            psk: None,
            carrier: None,
            backup_path: None,
            verbose: None,
            apply_mode: None,
        }
    }

    #[test]
    fn creates_machine_readable_list_command() {
        let args = build_manage_args(&request("list")).unwrap();
        assert_eq!(args, ["--no-color", "--yes", "--json", "-v", "list"]);
    }

    #[test]
    fn rejects_unknown_commands() {
        assert!(build_manage_args(&request("rm -rf / ")).is_err());
    }

    #[test]
    fn rejects_injected_client_name() {
        let mut input = request("add");
        input.client_names = Some(vec!["phone;reboot".into()]);
        assert!(build_manage_args(&input).is_err());
    }

    #[test]
    fn quotes_single_quotes_for_remote_shell() {
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
    }
}
