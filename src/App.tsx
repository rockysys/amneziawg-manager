import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type Profile = { host: string; port: number; user: string; identityFile: string; privateKey: string; useSudo: boolean; scriptPath: string };
type Client = Record<string, unknown> & { name: string; ip?: string; client_ipv6?: string; clientIpv6?: string; status?: string };
type Result = { success: boolean; exitCode: number; stdout: string; stderr: string; displayCommand: string };
type Page = "overview" | "clients" | "stats" | "backups" | "check" | "diagnose" | "module" | "restart";
type Confirmation = { action: "restart" | "repair-module" | "remove" | "restore" | "delete-backup" | "regen-all"; title: string; message: string; payload?: string };
type StatRow = { name: string; ip?: string; rx: number; tx: number; last_handshake?: number; status?: string };
type Backup = { name: string; path: string; size: number; modifiedAt: number };
type RemoteFile = { name: string; mimeType: string; base64: string };
type SavedProfile = Omit<Profile, "privateKey"> & { id: string; name: string };

const initialProfile: Profile = { host: "", port: 22, user: "root", identityFile: "", privateKey: "", useSudo: false, scriptPath: "/root/awg/manage_amneziawg.sh" };
const pageMeta: Record<Page, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "СЕРВЕР AMNEZIAWG", title: "Управление VPN", description: "Состояние сервера и клиенты" },
  clients: { eyebrow: "УПРАВЛЕНИЕ ДОСТУПОМ", title: "Клиенты", description: "Устройства с доступом к VPN" },
  stats: { eyebrow: "ТРАФИК", title: "Статистика", description: "Ответ команды stats" },
  backups: { eyebrow: "ЗАЩИТА ДАННЫХ", title: "Резервные копии", description: "Создание резервной копии конфигурации" },
  check: { eyebrow: "СОСТОЯНИЕ", title: "Проверка сервера", description: "Сервис, интерфейс, порт и настройки" },
  diagnose: { eyebrow: "ОБСЛУЖИВАНИЕ", title: "Диагностика", description: "Расширенная самопроверка AmneziaWG" },
  module: { eyebrow: "ОБСЛУЖИВАНИЕ", title: "Модуль AmneziaWG", description: "Результат восстановления модуля ядра" },
  restart: { eyebrow: "ОБСЛУЖИВАНИЕ", title: "Перезапуск", description: "Результат перезапуска сервиса" },
};

function expiryText(client: Client): string {
  const keys = ["expiry_display", "expiry_remaining", "expiryRemaining", "expires_in", "expiresIn", "expiry", "expires", "expires_at", "expiresAt", "expiration"];
  for (const key of keys) {
    const value = client[key];
    if (value === undefined || value === null || value === "" || value === 0) continue;
    if (typeof value === "number" && value > 1_000_000_000) return new Date(value * 1000).toLocaleString("ru-RU");
    if (typeof value === "string") return value;
  }
  return "Без срока";
}

function formatOutput(result: Result): string {
  const raw = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (!raw) return result.success ? "Команда выполнена без текстового вывода." : "Команда завершилась с ошибкой.";
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function bytes(value = 0): string {
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GiB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function decodeText(base64: string): string {
  const binary = atob(base64); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)); return new TextDecoder().decode(bytes);
}

function decodeBytes(base64: string): Uint8Array {
  const binary = atob(base64); return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function explainConnectionError(message: string): string {
  if (message.includes("Connection refused")) return `${message}\n\nПорт SSH отклонил соединение. Проверьте sshd, UFW/Fail2Ban и доступность порта 22 у провайдера.`;
  if (message.includes("Permission denied")) return `${message}\n\nСервер доступен, но ключ или пользователь не прошли авторизацию.`;
  if (message.includes("timed out")) return `${message}\n\nСервер или firewall не отвечает на SSH-подключение.`;
  return message;
}

function App() {
  const [profile, setProfile] = useState(initialProfile);
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState<Page>("overview");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [output, setOutput] = useState("Выберите операцию в меню слева.");
  const [lastCommand, setLastCommand] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error" | "busy"; text: string } | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newNames, setNewNames] = useState("");
  const [expires, setExpires] = useState("");
  const [psk, setPsk] = useState(false);
  const [editClient, setEditClient] = useState<string | null>(null);
  const [editParameter, setEditParameter] = useState("DNS");
  const [editValue, setEditValue] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [stats, setStats] = useState<StatRow[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [profileName, setProfileName] = useState("Мой сервер");
  const [clientFiles, setClientFiles] = useState<{ client: string; conf?: RemoteFile; qr?: RemoteFile; vpnuri?: RemoteFile } | null>(null);
  const [filesBusy, setFilesBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("amneziawg.profiles") ?? "[]") as SavedProfile[];
      setSavedProfiles(stored);
      const lastId = localStorage.getItem("amneziawg.lastProfile");
      const last = stored.find(item => item.id === lastId) ?? stored[0];
      if (last) { const { id: _id, name, ...rest } = last; setProfile({ ...rest, privateKey: "" }); setProfileName(name) }
    } catch { /* повреждённые локальные настройки игнорируются */ }
  }, []);

  const activeCount = useMemo(() => clients.filter(c => ["Активен", "Недавно", "active", "recent"].includes(String(c.status ?? ""))).length, [clients]);

  async function run(request: Record<string, unknown>, destination?: Page): Promise<Result> {
    if (destination) setPage(destination);
    setBusy(true); setNotice({ kind: "busy", text: "Команда отправлена на сервер…" });
    try {
      const result = await invoke<Result>("run_manage", { profile, request });
      setLastCommand(result.displayCommand); setOutput(formatOutput(result));
      setNotice({ kind: result.success ? "success" : "error", text: result.success ? "Операция успешно выполнена" : `Ошибка выполнения, код ${result.exitCode}` });
      return result;
    } catch (error) {
      setOutput(String(error)); setNotice({ kind: "error", text: "Не удалось выполнить операцию" });
      throw error;
    } finally { setBusy(false) }
  }

  async function refresh(destination: Page = "clients") {
    try {
      setConnectionError("");
      const result = await run({ action: "list", verbose: true }, destination);
      if (!result.success) throw new Error(result.stderr || "Команда завершилась с ошибкой");
      const parsed = JSON.parse(result.stdout);
      const jsonClients: Client[] = Array.isArray(parsed) ? parsed : parsed.clients ?? [];
      const textResult = await run({ action: "list-text", verbose: true });
      const expiryByName = new Map<string, string>();
      if (textResult.success) {
        for (const line of textResult.stdout.split("\n")) {
          const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*\|.*\[([^\]]+)\]\s*$/);
          if (match) expiryByName.set(match[1], match[2]);
        }
      }
      setClients(jsonClients.map(client => ({ ...client, expiry_display: expiryByName.get(client.name) ?? client.expiry_display })));
      setConnected(true); setShowSettings(false); setSelected(new Set());
      if (profile.identityFile) saveProfile();
    } catch (error) {
      const message = explainConnectionError(String(error).replace(/^Error:\s*/, ""));
      setConnected(false); setConnectionError(message); setOutput(`Ошибка подключения или чтения списка:\n${message}`);
    }
  }

  async function navigate(target: Page) {
    if (target === "overview") { setPage(target); return }
    if (target === "clients") { await refresh("clients"); return }
    if (target === "backups") { setPage("backups"); await loadBackups(); return }
    const result = await run({ action: target }, target);
    if (target === "stats" && result.success) {
      try { setStats(JSON.parse(result.stdout)) } catch { setStats([]) }
    }
  }

  function saveProfile() {
    if (!profile.host || !profile.identityFile) { setConnectionError("Для сохранения профиля укажите сервер и путь к ключу"); return }
    const id = `${profile.user}@${profile.host}:${profile.port}`;
    const { privateKey: _privateKey, ...persistable } = profile;
    const saved: SavedProfile = { ...persistable, id, name: profileName.trim() || profile.host };
    const next = [...savedProfiles.filter(item => item.id !== id), saved];
    setSavedProfiles(next); localStorage.setItem("amneziawg.profiles", JSON.stringify(next)); localStorage.setItem("amneziawg.lastProfile", id);
    setConnectionError("");
  }

  function loadProfile(id: string) {
    const saved = savedProfiles.find(item => item.id === id); if (!saved) return;
    const { name, ...withId } = saved; const rest = { ...withId } as Partial<SavedProfile>; delete rest.id;
    setProfile({ ...(rest as Omit<Profile, "privateKey">), privateKey: "" }); setProfileName(name); setConnectionError("");
    localStorage.setItem("amneziawg.lastProfile", id);
  }

  async function loadBackups() {
    setBusy(true); setNotice({ kind: "busy", text: "Получаем список резервных копий…" });
    try {
      const items = await invoke<Backup[]>("list_backups", { profile }); setBackups(items);
      setNotice({ kind: "success", text: `Найдено резервных копий: ${items.length}` });
    } catch (error) { setOutput(String(error)); setNotice({ kind: "error", text: "Не удалось получить резервные копии" }) }
    finally { setBusy(false) }
  }

  async function createBackup() {
    const result = await run({ action: "backup" }, "backups"); if (result.success) await loadBackups();
  }

  async function openClientFiles(client: string) {
    setFilesBusy(true); setSavedPath(null); setClientFiles({ client });
    try {
      const conf = await invoke<RemoteFile>("read_client_file", { profile, client, fileType: "conf" });
      const qr = await invoke<RemoteFile>("read_client_file", { profile, client, fileType: "qr" });
      const vpnuri = await invoke<RemoteFile>("read_client_file", { profile, client, fileType: "vpnuri" });
      setClientFiles({ client, conf, qr, vpnuri });
    } catch (error) { setNotice({ kind: "error", text: `Не удалось получить файлы ${client}: ${String(error)}` }) }
    finally { setFilesBusy(false) }
  }

  async function saveRemoteFile(file: RemoteFile) {
    const extension = file.name.split(".").pop() ?? "bin";
    const path = await save({ defaultPath: file.name, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!path) return;
    try {
      await writeFile(path, decodeBytes(file.base64));
      setSavedPath(path); setNotice({ kind: "success", text: `Файл сохранён: ${file.name}` });
      await revealItemInDir(path);
    } catch (error) { setNotice({ kind: "error", text: `Не удалось сохранить файл: ${String(error)}` }) }
  }

  async function downloadBackup(item: Backup) {
    setBackupBusy(item.path); setSavedPath(null); setNotice({ kind: "busy", text: `Загружаем ${item.name}…` });
    try {
      const file = await invoke<RemoteFile>("read_backup", { profile, path: item.path });
      await saveRemoteFile(file);
    } catch (error) { setNotice({ kind: "error", text: `Не удалось скачать бэкап: ${String(error)}` }) }
    finally { setBackupBusy(null) }
  }

  async function addClients(event: FormEvent) {
    event.preventDefault();
    const names = newNames.split(/[\s,]+/).filter(Boolean);
    if (!names.length) return;
    const result = await run({ action: "add", clientNames: names, expires: expires || null, psk }, "clients");
    if (result.success) { setShowAdd(false); setNewNames(""); await refresh("clients") }
  }

  async function executeConfirmation() {
    if (!confirmation) return;
    const action = confirmation.action; setConfirmation(null);
    if (action === "remove") {
      const result = await run({ action: "remove", clientNames: [...selected] }, "clients");
      if (result.success) await refresh("clients");
    } else if (action === "restore") {
      const result = await run({ action: "restore", backupPath: confirmation.payload }, "backups"); if (result.success) await loadBackups();
    } else if (action === "delete-backup") {
      try {
        await invoke("delete_backup", { profile, path: confirmation.payload });
        await loadBackups(); setNotice({ kind: "success", text: `Резервная копия удалена: ${confirmation.message}` });
      } catch (error) { setNotice({ kind: "error", text: `Не удалось удалить бэкап: ${String(error)}` }) }
    } else if (action === "regen-all") {
      const result = await run({ action: "regen" }, "clients");
      if (result.success) {
        await refresh("clients");
        setNotice({ kind: "success", text: "Конфиги, QR-коды и vpn:// URI всех клиентов перегенерированы" });
      }
    } else await run({ action }, action === "restart" ? "restart" : "module");
  }

  async function regenerateSelected() {
    for (const client of selected) { const result = await run({ action: "regen", client }, "clients"); if (!result.success) return }
    await refresh("clients");
  }

  async function modifyClient(event: FormEvent) {
    event.preventDefault(); if (!editClient) return;
    const result = await run({ action: "modify", client: editClient, parameter: editParameter, value: editValue }, "clients");
    if (result.success) { setEditClient(null); setEditValue(""); await refresh("clients") }
  }

  function toggle(name: string) { setSelected(current => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next }) }
  const meta = pageMeta[page];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">A</span><div><strong>AmneziaWG</strong><small>Manager</small></div></div>
      <nav>
        {(["overview", "clients", "stats", "backups", "check", "diagnose"] as Page[]).map((item, index) => <button key={item} className={`nav-item ${page === item ? "active" : ""}`} onClick={() => navigate(item)} disabled={busy}><span>{["◫", "♙", "⌁", "↻", "✓", "◇"][index]}</span>{pageMeta[item].title}</button>)}
        <div className="nav-separator" />
        <button className={`nav-item ${page === "module" ? "active" : ""}`} onClick={() => setConfirmation({ action: "repair-module", title: "Восстановить модуль?", message: "Будут проверены заголовки ядра, DKMS и сервис AmneziaWG." })} disabled={busy}><span>⚒</span>Восстановить модуль</button>
        <button className={`nav-item ${page === "restart" ? "active" : ""}`} onClick={() => setConfirmation({ action: "restart", title: "Перезапустить сервис?", message: "Текущие VPN-соединения кратковременно прервутся." })} disabled={busy}><span>↯</span>Перезапустить сервис</button>
      </nav>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => setShowSettings(true)}><span>⚙</span> Подключение</button><div className={`connection ${connected ? "online" : ""}`}><i />{connected ? profile.host : "Не подключено"}</div></div>
    </aside>

    <main className="content">
      <header><div><p className="eyebrow">{meta.eyebrow}</p><h1>{meta.title}</h1><p className="page-description">{meta.description}</p></div>
        <div className="header-actions"><button className="secondary" onClick={() => refresh(page === "overview" ? "overview" : "clients")} disabled={busy}>↻ Обновить</button>{page === "clients" && <button className="primary" onClick={() => setShowAdd(true)} disabled={busy}>＋ Добавить клиента</button>}</div>
      </header>

      {notice && <div className={`notice ${notice.kind}`}><span>{notice.kind === "busy" ? <i className="spinner" /> : notice.kind === "success" ? "✓" : "!"}</span><strong>{notice.text}</strong>{lastCommand && <small>{lastCommand}</small>}</div>}

      {page === "overview" ? <>
        <section className="metrics"><article><span className="metric-icon green">✓</span><div><small>Состояние</small><strong>{connected ? "Подключён" : "Нет связи"}</strong></div></article><article><span className="metric-icon blue">♙</span><div><small>Всего клиентов</small><strong>{clients.length}</strong></div></article><article><span className="metric-icon violet">⌁</span><div><small>Активны сейчас</small><strong>{activeCount}</strong></div></article></section>
        <section className="overview-grid"><button onClick={() => navigate("check")}><span>✓</span><div><strong>Проверить сервер</strong><small>Сервис, порт, firewall и forwarding</small></div></button><button onClick={() => navigate("stats")}><span>⌁</span><div><strong>Посмотреть статистику</strong><small>Трафик и последние подключения</small></div></button><button onClick={() => navigate("backups")}><span>↻</span><div><strong>Создать резервную копию</strong><small>Конфиги, ключи и сроки клиентов</small></div></button></section>
        <section className="panel server-card"><div className="panel-title"><div><h2>Текущее подключение</h2><p>Параметры активного SSH-сеанса</p></div></div><dl><div><dt>Сервер</dt><dd>{connected ? profile.host : "Не подключено"}</dd></div><div><dt>Пользователь</dt><dd>{profile.user}</dd></div><div><dt>Скрипт</dt><dd className="mono">{profile.scriptPath}</dd></div></dl></section>
      </> : page === "clients" ? <>
        <section className="panel clients-panel"><div className="panel-title"><div><h2>Клиенты</h2><p>Устройства с доступом к VPN</p></div><div className="selection-actions"><button className="secondary" onClick={() => setConfirmation({ action: "regen-all", title: "Перегенерировать конфиги всех клиентов?", message: "Будут обновлены .conf, QR-коды и vpn:// URI всех существующих клиентов. После изменения серверных настроек новые файлы может потребоваться заново импортировать на устройства." })}>Перегенерировать все</button>{selected.size > 0 && <><button className="secondary" onClick={regenerateSelected}>Только выбранные</button><button className="danger" onClick={() => setConfirmation({ action: "remove", title: "Удалить клиентов?", message: [...selected].join(", ") })}>Удалить ({selected.size})</button></>}</div></div>
          <div className="table-wrap"><table><thead><tr><th></th><th>Имя</th><th>IPv4</th><th>IPv6</th><th>Статус</th><th>Срок действия</th><th></th></tr></thead><tbody>{clients.length ? clients.map(client => <tr key={client.name}><td><input type="checkbox" checked={selected.has(client.name)} onChange={() => toggle(client.name)} /></td><td><strong>{client.name}</strong></td><td className="mono">{String(client.ip ?? "—")}</td><td className="mono">{String(client.client_ipv6 ?? client.clientIpv6 ?? "—")}</td><td><span className="status">{String(client.status ?? "Нет данных")}</span></td><td>{expiryText(client)}</td><td><div className="row-actions"><button className="row-action" onClick={() => openClientFiles(client.name)}>Файлы</button><button className="row-action" onClick={() => setEditClient(client.name)}>Изменить</button></div></td></tr>) : <tr><td colSpan={7} className="empty">Нажмите «Обновить», чтобы загрузить клиентов</td></tr>}</tbody></table></div>
        </section>
      </> : page === "stats" ? <section className="panel stats-panel"><div className="panel-title"><div><h2>Трафик клиентов</h2><p>Данные команды stats --json</p></div><button className="secondary" onClick={() => navigate("stats")}>Обновить</button></div><div className="table-wrap"><table><thead><tr><th>Клиент</th><th>IP</th><th>Получено</th><th>Отправлено</th><th>Последний handshake</th><th>Статус</th></tr></thead><tbody>{stats.length ? stats.map(row => <tr key={row.name}><td><strong>{row.name}</strong></td><td className="mono">{row.ip ?? "—"}</td><td>{bytes(row.rx)}</td><td>{bytes(row.tx)}</td><td>{row.last_handshake ? new Date(row.last_handshake * 1000).toLocaleString("ru-RU") : "Никогда"}</td><td><span className="status">{row.status ?? "Нет данных"}</span></td></tr>) : <tr><td className="empty" colSpan={6}>Статистика отсутствует</td></tr>}</tbody></table></div></section>
      : page === "backups" ? <section className="panel backups-panel"><div className="panel-title"><div><h2>Резервные копии</h2><p>Архивы из каталога сервера</p></div><div className="selection-actions"><button className="secondary" onClick={loadBackups}>Обновить список</button><button className="primary" onClick={createBackup}>Создать копию</button></div></div><div className="backup-list">{backups.length ? backups.map(item => <article key={item.path} className={backupBusy === item.path ? "downloading" : ""}><span className="backup-icon">↻</span><div><strong>{item.name}</strong><small>{bytes(item.size)} · {new Date(item.modifiedAt * 1000).toLocaleString("ru-RU")}</small>{backupBusy === item.path && <span className="download-progress"><i /></span>}</div><div className="backup-actions"><button className="secondary" disabled={!!backupBusy} onClick={() => downloadBackup(item)}>Скачать</button><button className="secondary" disabled={!!backupBusy} onClick={() => setConfirmation({ action: "restore", title: "Восстановить эту копию?", message: item.name, payload: item.path })}>Восстановить</button><button className="danger" disabled={!!backupBusy} onClick={() => setConfirmation({ action: "delete-backup", title: "Удалить резервную копию?", message: item.name, payload: item.path })}>Удалить</button></div></article>) : <div className="empty">Резервные копии не найдены</div>}</div></section>
      : <section className="panel result-panel"><div className="panel-title"><div><h2>Ответ сервера</h2><p>{lastCommand || "Команда ещё не запускалась"}</p></div>{busy && <i className="spinner dark" />}</div><pre>{busy ? "Ожидаем ответ сервера…" : output}</pre></section>}
    </main>

    {showSettings && <div className="modal-backdrop connection-backdrop"><form className="modal connection-modal" onSubmit={e => { e.preventDefault(); refresh("overview") }}><div className="modal-head"><div><p className="eyebrow">SSH</p><h2>Подключение к серверу</h2></div>{connected && <button type="button" className="icon-button" onClick={() => setShowSettings(false)}>×</button>}</div>{savedProfiles.length > 0 && <label>Сохранённый профиль<select value={`${profile.user}@${profile.host}:${profile.port}`} onChange={e => loadProfile(e.target.value)}><option value="">Выберите сервер</option>{savedProfiles.map(item => <option key={item.id} value={item.id}>{item.name} — {item.host}</option>)}</select></label>}{connectionError && <div className="inline-error"><strong>Не удалось подключиться</strong><pre>{connectionError}</pre></div>}<label>Название профиля<input value={profileName} onChange={e => setProfileName(e.target.value)} /></label><label>Адрес сервера<input required placeholder="vpn.example.com или 203.0.113.10" value={profile.host} onChange={e => setProfile({ ...profile, host: e.target.value })} /></label><div className="form-row"><label>Пользователь<input required value={profile.user} onChange={e => setProfile({ ...profile, user: e.target.value, useSudo: e.target.value !== "root" })} /></label><label>Порт<input type="number" min="1" max="65535" value={profile.port} onChange={e => setProfile({ ...profile, port: Number(e.target.value) })} /></label></div><div className="key-choice"><label>Путь к приватному ключу<input placeholder="/Users/name/.ssh/id_ed25519" value={profile.identityFile} onChange={e => setProfile({ ...profile, identityFile: e.target.value, privateKey: e.target.value ? "" : profile.privateKey })} /></label><span>или</span><label>Вставить приватный ключ<textarea rows={5} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'} value={profile.privateKey} onChange={e => setProfile({ ...profile, privateKey: e.target.value, identityFile: e.target.value ? "" : profile.identityFile })} /></label></div><label>Путь к скрипту<input value={profile.scriptPath} onChange={e => setProfile({ ...profile, scriptPath: e.target.value })} /></label><label className="check"><input type="checkbox" checked={profile.useSudo} onChange={e => setProfile({ ...profile, useSudo: e.target.checked })} /> Выполнять через sudo без запроса пароля</label><div className="form-actions"><button type="button" className="secondary" onClick={saveProfile}>Сохранить профиль</button><button className="primary" disabled={busy}>{busy ? "Подключение…" : "Подключиться"}</button></div></form></div>}

    {showAdd && <div className="modal-backdrop"><form className="modal small" onSubmit={addClients}><div className="modal-head"><h2>Добавить клиентов</h2><button type="button" className="icon-button" onClick={() => setShowAdd(false)}>×</button></div><label>Имена<input autoFocus required placeholder="iphone macbook family" value={newNames} onChange={e => setNewNames(e.target.value)} /><span className="hint">Разделяйте пробелом или запятой</span></label><label>Срок действия<select value={expires} onChange={e => setExpires(e.target.value)}><option value="">Без срока</option><option value="1h">1 час</option><option value="12h">12 часов</option><option value="1d">1 день</option><option value="7d">7 дней</option><option value="30d">30 дней</option><option value="4w">4 недели</option></select></label><label className="check"><input type="checkbox" checked={psk} onChange={e => setPsk(e.target.checked)} /> Создать отдельный PresharedKey</label><button className="primary full" disabled={busy}>Добавить</button></form></div>}

    {editClient && <div className="modal-backdrop"><form className="modal small" onSubmit={modifyClient}><div className="modal-head"><div><p className="eyebrow">{editClient}</p><h2>Изменить конфигурацию</h2></div><button type="button" className="icon-button" onClick={() => setEditClient(null)}>×</button></div><label>Параметр<select value={editParameter} onChange={e => setEditParameter(e.target.value)}><option>DNS</option><option>Endpoint</option><option>AllowedIPs</option><option>PersistentKeepalive</option></select></label><label>Новое значение<input autoFocus required placeholder={editParameter === "DNS" ? "1.1.1.1,1.0.0.1" : editParameter === "PersistentKeepalive" ? "25" : "Значение"} value={editValue} onChange={e => setEditValue(e.target.value)} /></label><p className="modal-note">После изменения скрипт автоматически обновит QR-код и vpn:// URI.</p><button className="primary full" disabled={busy}>Сохранить</button></form></div>}

    {clientFiles && <div className="modal-backdrop"><div className="modal files-modal"><div className="modal-head"><div><p className="eyebrow">{clientFiles.client}</p><h2>Файлы клиента</h2></div><button className="icon-button" onClick={() => setClientFiles(null)}>×</button></div>{filesBusy ? <div className="files-loading"><i className="spinner dark" />Получаем файлы с сервера…</div> : <div className="client-files-grid"><div className="qr-card">{clientFiles.qr && <img src={`data:image/png;base64,${clientFiles.qr.base64}`} alt={`QR ${clientFiles.client}`} />}<strong>QR-код</strong>{clientFiles.qr && <button className="secondary" onClick={() => saveRemoteFile(clientFiles.qr!)}>Сохранить PNG</button>}</div><div className="file-texts">{clientFiles.conf && <section><div><strong>{clientFiles.conf.name}</strong><button onClick={() => navigator.clipboard.writeText(decodeText(clientFiles.conf!.base64))}>Копировать</button><button onClick={() => saveRemoteFile(clientFiles.conf!)}>Сохранить</button></div><pre>{decodeText(clientFiles.conf.base64)}</pre></section>}{clientFiles.vpnuri && <section><div><strong>vpn:// URI</strong><button onClick={() => navigator.clipboard.writeText(decodeText(clientFiles.vpnuri!.base64))}>Копировать</button><button onClick={() => saveRemoteFile(clientFiles.vpnuri!)}>Сохранить</button></div><pre>{decodeText(clientFiles.vpnuri.base64)}</pre></section>}</div></div>}{savedPath && <div className="saved-file"><span>✓</span><div><strong>Файл сохранён</strong><small>{savedPath}</small></div><button className="secondary" onClick={() => revealItemInDir(savedPath)}>Показать в Finder</button></div>}</div></div>}

    {confirmation && <div className="modal-backdrop"><div className="modal small"><div className="confirm-icon">!</div><div className="confirm-copy"><h2>{confirmation.title}</h2><p>{confirmation.message}</p></div><div className="confirm-actions"><button className="secondary" onClick={() => setConfirmation(null)}>Отмена</button><button className="danger solid" onClick={executeConfirmation}>Продолжить</button></div></div></div>}
  </div>
}

export default App
