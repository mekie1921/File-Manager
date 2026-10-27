import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ensureAnonymousSession } from '../features/cloud/anonymousSession.js';
import {
  createCloudFileService,
  MAX_CLOUD_FILE_SIZE_BYTES,
} from '../features/cloud/cloudFileService.js';
import {
  supabase,
  supabaseConfigurationError,
} from '../features/cloud/supabaseClient';

const cloudFileService = supabase
  ? createCloudFileService({
      supabase,
      readLocalFile: async () => {
        throw new Error('Select a browser File to upload.');
      },
      getLocalFileSize: async () => {
        throw new Error('Select a browser File to upload.');
      },
      writeLocalFile: async (_filename, bytes) => {
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        return URL.createObjectURL(blob);
      },
    })
  : null;

const INSTALL_DISMISSED_STORAGE_KEY = 'best.install.dismissed';
const INSTALL_DISMISSED_EVENT = 'best-install-dismissed';
let installDismissedForSession = false;

function subscribeToInstallDismissed(callback) {
  window.addEventListener('storage', callback);
  window.addEventListener(INSTALL_DISMISSED_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(INSTALL_DISMISSED_EVENT, callback);
  };
}

function getInstallDismissed() {
  if (installDismissedForSession) return true;
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY) === 'true';
  } catch (error) {
    console.error('Best could not read the install dismissal preference:', error);
    return false;
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function fileKind(file) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop();
  return extension && extension !== file.name ? `${extension.toUpperCase()} file` : 'File';
}

function triggerDownload(url, filename) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function subscribeToOnline(callback) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getOnlineStatus() {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function subscribeToStandalone(callback) {
  const query = window.matchMedia?.('(display-mode: standalone)');
  if (query?.addEventListener) {
    query.addEventListener('change', callback);
  } else {
    query?.addListener?.(callback);
  }
  return () => {
    if (query?.removeEventListener) {
      query.removeEventListener('change', callback);
    } else {
      query?.removeListener?.(callback);
    }
  };
}

function getStandaloneStatus() {
  return typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      window.navigator.standalone === true);
}

export default function HomeScreen() {
  const [files, setFiles] = useState([]);
  const [recentIds, setRecentIds] = useState([]);
  const [favoriteIds, setFavoriteIds] = useState([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [fileFilter, setFileFilter] = useState('all');
  const [activePanel, setActivePanel] = useState('files');
  const [notice, setNotice] = useState('');
  const online = useSyncExternalStore(subscribeToOnline, getOnlineStatus, () => true);
  const standalone = useSyncExternalStore(subscribeToStandalone, getStandaloneStatus, () => false);
  const installDismissed = useSyncExternalStore(
    subscribeToInstallDismissed,
    getInstallDismissed,
    () => false
  );
  const [appInstalled, setAppInstalled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const installed = standalone || appInstalled;
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudFiles, setCloudFiles] = useState([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState(supabaseConfigurationError || '');
  const fileInputRef = useRef(null);
  const cloudInputRef = useRef(null);
  const previewUrlRef = useRef(null);
  const nextFileId = useRef(1);

  useEffect(() => {
    const installHandler = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const appInstalledHandler = () => setAppInstalled(true);
    window.addEventListener('beforeinstallprompt', installHandler);
    window.addEventListener('appinstalled', appInstalledHandler, { once: true });

    return () => {
      window.removeEventListener('beforeinstallprompt', installHandler);
      window.removeEventListener('appinstalled', appInstalledHandler);
    };
  }, []);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const visibleFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = files.filter((item) => {
      if (fileFilter === 'recent' && !recentIds.includes(item.id)) return false;
      if (fileFilter === 'favorites' && !favoriteIds.includes(item.id)) return false;
      return !normalizedQuery ||
        item.file.name.toLowerCase().includes(normalizedQuery) ||
        fileKind(item.file).toLowerCase().includes(normalizedQuery);
    });

    return filtered.sort((left, right) => {
      if (sort === 'size') return right.file.size - left.file.size;
      if (sort === 'date') return right.file.lastModified - left.file.lastModified;
      if (sort === 'type') {
        return fileKind(left.file).localeCompare(fileKind(right.file)) ||
          left.file.name.localeCompare(right.file.name);
      }
      return left.file.name.localeCompare(right.file.name);
    });
  }, [files, fileFilter, favoriteIds, query, recentIds, sort]);

  function recordRecent(id) {
    setRecentIds((current) => [id, ...current.filter((value) => value !== id)].slice(0, 30));
  }

  function addFiles(event) {
    const selected = Array.from(event.target.files || []);
    if (selected.length) {
      const added = selected.map((file) => ({
        id: `local-${nextFileId.current++}`,
        file,
      }));
      setFiles((current) => [...added, ...current]);
      setRecentIds((current) => [
        ...added.map((item) => item.id),
        ...current,
      ].slice(0, 30));
      setNotice(`${added.length} selected file${added.length === 1 ? '' : 's'} added for this browser session.`);
    }
    event.target.value = '';
  }

  function removeSelection(item) {
    setFiles((current) => current.filter((file) => file.id !== item.id));
    setFavoriteIds((current) => current.filter((id) => id !== item.id));
    setRecentIds((current) => current.filter((id) => id !== item.id));
    setNotice(`${item.file.name} was removed from Best's list. The original file was not changed.`);
  }

  function toggleFavorite(id) {
    setFavoriteIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
  }

  async function showPreview(item) {
    recordRecent(item.id);
    setPreviewError('');
    setPreviewText('');
    setPreview(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const file = item.file;
    if (file.type.startsWith('image/') || file.type === 'application/pdf') {
      previewUrlRef.current = URL.createObjectURL(file);
      setPreview({ item, url: previewUrlRef.current, kind: file.type.startsWith('image/') ? 'image' : 'pdf' });
      return;
    }
    if (file.type.startsWith('text/') && file.size <= 1024 * 1024) {
      try {
        const contents = await file.text();
        setPreviewText(contents);
        setPreview({ item, kind: 'text' });
      } catch (error) {
        setPreviewError(error?.message || 'The selected text file could not be read.');
      }
      return;
    }
    setNotice('This file type is not previewable here. Use Download to open it with a suitable app.');
  }

  function closePreview() {
    setPreview(null);
    setPreviewText('');
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  function downloadLocalFile(item) {
    triggerDownload(URL.createObjectURL(item.file), item.file.name);
    recordRecent(item.id);
    setNotice(`Downloaded ${item.file.name}.`);
  }

  async function shareLocalFile(item) {
    if (typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [item.file] })) {
      try {
        await navigator.share({ files: [item.file], title: item.file.name });
        recordRecent(item.id);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          setNotice(error?.message || 'The browser could not share this file.');
        }
      }
      return;
    }
    downloadLocalFile(item);
    setNotice('This browser cannot share files directly, so Best downloaded the file instead.');
  }

  async function installBest() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice?.outcome === 'accepted') setAppInstalled(true);
      else dismissInstall();
    } catch (error) {
      setNotice(error?.message || 'The browser could not open its install prompt.');
      setInstallPrompt(null);
    }
  }

  function dismissInstall() {
    installDismissedForSession = true;
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, 'true');
    } catch (error) {
      console.error('Best could not save the install dismissal preference:', error);
      setNotice('Your browser could not save this preference, so the install guidance may reappear after reloading.');
    }
    window.dispatchEvent(new Event(INSTALL_DISMISSED_EVENT));
  }

  async function connectCloud() {
    if (!navigator.onLine) {
      setCloudMessage('Cloud storage requires an internet connection.');
      return;
    }
    if (!supabase || !cloudFileService) {
      setCloudMessage(supabaseConfigurationError || 'Cloud storage is not configured for this deployment.');
      return;
    }
    setCloudBusy(true);
    setCloudMessage('');
    try {
      await ensureAnonymousSession(supabase);
      const records = await cloudFileService.list();
      setCloudFiles(records);
      setCloudConnected(true);
      setCloudMessage(`Connected. ${records.length} cloud file${records.length === 1 ? '' : 's'} available.`);
    } catch (error) {
      setCloudMessage(error?.message || 'Could not connect to cloud storage.');
      setCloudConnected(false);
    } finally {
      setCloudBusy(false);
    }
  }

  async function uploadCloudFile(file) {
    if (!file || !cloudConnected || cloudBusy) return;
    if (file.size > MAX_CLOUD_FILE_SIZE_BYTES) {
      setCloudMessage(`Files must be no larger than ${formatSize(MAX_CLOUD_FILE_SIZE_BYTES)}.`);
      return;
    }
    setCloudBusy(true);
    setCloudMessage('');
    try {
      await cloudFileService.upload({
        file,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      });
      try {
        const records = await cloudFileService.list();
        setCloudFiles(records);
        setCloudMessage(`Uploaded ${file.name}.`);
      } catch (error) {
        setCloudMessage(`Upload completed, but the cloud list could not be refreshed: ${error?.message || 'unknown error'}`);
      }
    } catch (error) {
      setCloudMessage(error?.message || `Could not upload ${file.name}.`);
    } finally {
      setCloudBusy(false);
      if (cloudInputRef.current) cloudInputRef.current.value = '';
    }
  }

  async function downloadCloudFile(record) {
    if (!navigator.onLine || cloudBusy) {
      setCloudMessage('A network connection is required to download cloud files.');
      return;
    }
    setCloudBusy(true);
    setCloudMessage('');
    try {
      const result = await cloudFileService.download(record);
      triggerDownload(result.localUri, record.filename);
      setCloudMessage(`Downloaded ${record.filename}.`);
    } catch (error) {
      setCloudMessage(error?.message || `Could not download ${record.filename}.`);
    } finally {
      setCloudBusy(false);
    }
  }

  return (
    <>
      <style>{`
        :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #f2f8f5; color: #16352a; }
        button, input, select { font: inherit; }
        button { cursor: pointer; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #54b888; outline-offset: 2px; }
        .best-page { min-height: 100vh; padding: 28px 20px 56px; }
        .best-shell { max-width: 1050px; margin: 0 auto; }
        .best-header, .best-brand, .best-actions, .best-toolbar, .best-file-row, .best-cloud-row { display: flex; align-items: center; }
        .best-header { justify-content: space-between; gap: 20px; margin-bottom: 32px; }
        .best-brand { gap: 12px; }
        .best-logo { width: 48px; height: 48px; border-radius: 14px; }
        .best-title { margin: 0; font-size: 25px; letter-spacing: -0.04em; }
        .best-subtitle { margin: 3px 0 0; color: #62786d; font-size: 14px; }
        .best-status { display: inline-flex; align-items: center; gap: 8px; color: #62786d; font-size: 13px; }
        .best-dot { width: 9px; height: 9px; border-radius: 50%; background: #178a5e; }
        .best-dot.offline { background: #d18424; }
        .best-card { padding: 24px; border: 1px solid #d8e7dd; border-radius: 20px; background: #fff; box-shadow: 0 10px 30px #16352a0a; }
        .best-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
        .best-intro h2 { margin: 0 0 7px; font-size: 22px; letter-spacing: -0.03em; }
        .best-intro p, .best-helper { margin: 0; color: #62786d; line-height: 1.55; }
        .best-primary, .best-secondary, .best-tab, .best-icon-button { min-height: 42px; border: 0; border-radius: 11px; padding: 10px 15px; font-weight: 650; }
        .best-primary { background: #076344; color: #fff; }
        .best-primary:hover { background: #064f37; }
        .best-secondary { background: #e7f1eb; color: #16352a; }
        .best-secondary:hover, .best-tab:hover { background: #dff3e8; }
        .best-toolbar { justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 0; border-bottom: 1px solid #e7eee9; }
        .best-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
        .best-tab { background: transparent; color: #62786d; }
        .best-tab.active { background: #dff3e8; color: #076344; }
        .best-search { width: min(100%, 270px); min-height: 42px; padding: 9px 12px; border: 1px solid #d8e7dd; border-radius: 10px; background: #fff; color: #16352a; }
        .best-sort { min-height: 42px; padding: 8px 10px; border: 1px solid #d8e7dd; border-radius: 10px; background: #fff; color: #16352a; }
        .best-file-row, .best-cloud-row { justify-content: space-between; gap: 16px; padding: 15px 4px; border-bottom: 1px solid #edf2ee; }
        .best-file-info { display: flex; align-items: center; min-width: 0; gap: 12px; }
        .best-file-icon { display: grid; width: 42px; height: 42px; flex: 0 0 42px; place-items: center; border-radius: 12px; background: #e7f1eb; color: #076344; font-size: 12px; font-weight: 750; }
        .best-file-name { overflow: hidden; margin: 0; color: #16352a; font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
        .best-file-meta { margin: 4px 0 0; color: #71847a; font-size: 12px; }
        .best-file-buttons { display: flex; flex: 0 0 auto; gap: 7px; }
        .best-icon-button { min-height: 36px; padding: 7px 10px; background: #f2f8f5; color: #28503e; }
        .best-empty { padding: 40px 16px; color: #62786d; text-align: center; line-height: 1.55; }
        .best-note { margin-top: 18px; padding: 13px 15px; border-radius: 11px; background: #f2f8f5; color: #526c5e; font-size: 13px; line-height: 1.55; }
        .best-banner { margin-bottom: 16px; padding: 11px 14px; border-radius: 10px; background: #fff2d9; color: #704818; font-size: 14px; }
        .best-install { margin-bottom: 18px; padding: 16px; border: 1px solid #cfe7d7; border-radius: 14px; background: #eff9f2; }
        .best-install h3 { margin: 0 0 5px; font-size: 15px; }
        .best-install p { margin: 0; color: #526c5e; font-size: 13px; line-height: 1.5; }
        .best-install .best-secondary { margin-top: 10px; }
        .best-cloud-message { margin: 16px 0 0; color: #526c5e; font-size: 14px; line-height: 1.5; }
        .best-modal-backdrop { position: fixed; z-index: 10; inset: 0; display: grid; place-items: center; padding: 20px; background: #092218bb; }
        .best-modal { display: flex; width: min(100%, 900px); max-height: 90vh; flex-direction: column; overflow: hidden; border-radius: 18px; background: #fff; }
        .best-modal-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 15px 18px; border-bottom: 1px solid #e7eee9; }
        .best-modal-body { min-height: 180px; overflow: auto; padding: 16px; text-align: center; }
        .best-preview-image { max-width: 100%; max-height: 70vh; object-fit: contain; }
        .best-preview-frame { width: 100%; height: 70vh; border: 0; }
        .best-preview-text { overflow: auto; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; }
        .best-privacy { margin-top: 20px; color: #71847a; font-size: 12px; line-height: 1.5; }
        @media (max-width: 640px) {
          .best-page { padding: 18px 12px 36px; }
          .best-header { align-items: flex-start; margin-bottom: 20px; }
          .best-status-label { display: none; }
          .best-card { padding: 17px 14px; border-radius: 15px; }
          .best-intro { flex-direction: column; }
          .best-intro .best-primary { width: 100%; }
          .best-toolbar { align-items: stretch; }
          .best-toolbar > * { width: 100%; }
          .best-tabs { width: 100%; }
          .best-tab { flex: 1; padding-inline: 7px; }
          .best-search, .best-sort { width: 100%; }
          .best-file-row, .best-cloud-row { align-items: flex-start; flex-direction: column; gap: 10px; }
          .best-file-info { width: 100%; }
          .best-file-buttons { width: 100%; }
          .best-file-buttons button { flex: 1; }
        }
      `}</style>

      <main className="best-page">
        <div className="best-shell">
          <header className="best-header">
            <div className="best-brand">
              <img className="best-logo" src="/icons/best-192.png" alt="" />
              <div>
                <h1 className="best-title">Best</h1>
                <p className="best-subtitle">Your files, with your permission</p>
              </div>
            </div>
            <div className="best-status" role="status">
              <span className={`best-dot${online ? '' : ' offline'}`} />
              <span className="best-status-label">{online ? 'Online' : 'Offline'}</span>
            </div>
          </header>

          {!online && (
            <div className="best-banner" role="status">
              You are offline. The app shell and previously loaded public assets may still be available; cloud actions need a connection.
            </div>
          )}

          {!installed && !installDismissed && (
            <section className="best-install" aria-label="Install Best">
              <h3>Use Best like an app</h3>
              <p>
                Use your browser&apos;s Install or Add to Home Screen option. On iPhone or iPad, open Best in Safari and choose Share, then Add to Home Screen. Menu names and support vary by browser.
              </p>
              {installPrompt && (
                <button className="best-secondary" type="button" onClick={installBest}>
                  Install Best
                </button>
              )}
              {!installPrompt && (
                <button className="best-icon-button" type="button" onClick={dismissInstall}>
                  Dismiss
                </button>
              )}
            </section>
          )}

          <section className="best-card">
            <div className="best-intro">
              <div>
                <h2>{activePanel === 'files' ? 'Browse selected files' : 'Private cloud files'}</h2>
                <p>
                  {activePanel === 'files'
                    ? 'Choose files to browse, preview, share, or download in this browser session.'
                    : 'Use the existing Supabase cloud service when it is configured and its policies are enabled.'}
                </p>
              </div>
              {activePanel === 'files' ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    aria-label="Choose files from this device"
                    onChange={addFiles}
                  />
                  <button className="best-primary" type="button" onClick={() => fileInputRef.current?.click()}>
                    Choose files
                  </button>
                </>
              ) : (
                <div className="best-actions">
                  {!cloudConnected ? (
                    <button
                      className="best-primary"
                      type="button"
                      disabled={cloudBusy || !online}
                      onClick={connectCloud}
                    >
                      {cloudBusy ? 'Connecting…' : 'Connect cloud'}
                    </button>
                  ) : (
                    <>
                      <input
                        ref={cloudInputRef}
                        type="file"
                        hidden
                        aria-label="Choose a file to upload to cloud"
                        onChange={(event) => void uploadCloudFile(event.target.files?.[0])}
                      />
                      <button
                        className="best-primary"
                        type="button"
                        disabled={cloudBusy || !online}
                        onClick={() => cloudInputRef.current?.click()}
                      >
                        Choose upload
                      </button>
                      <button
                        className="best-secondary"
                        type="button"
                        disabled={cloudBusy || !online}
                        onClick={connectCloud}
                      >
                        Refresh
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <nav className="best-toolbar" aria-label="File manager views">
              <div className="best-tabs">
                <button
                  className={`best-tab${activePanel === 'files' ? ' active' : ''}`}
                  type="button"
                  aria-pressed={activePanel === 'files'}
                  onClick={() => setActivePanel('files')}
                >
                  This session
                </button>
                <button
                  className={`best-tab${activePanel === 'cloud' ? ' active' : ''}`}
                  type="button"
                  aria-pressed={activePanel === 'cloud'}
                  onClick={() => setActivePanel('cloud')}
                >
                  Cloud
                </button>
              </div>

              {activePanel === 'files' && (
                <>
                  <div className="best-tabs" aria-label="Filter selected files">
                    {[
                      ['all', 'All'],
                      ['recent', 'Recent'],
                      ['favorites', 'Starred'],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={`best-tab${fileFilter === value ? ' active' : ''}`}
                        type="button"
                        aria-pressed={fileFilter === value}
                        onClick={() => setFileFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <input
                    className="best-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search selected files"
                    aria-label="Search selected files"
                  />
                  <select
                    className="best-sort"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                    aria-label="Sort selected files"
                  >
                    <option value="name">Sort by name</option>
                    <option value="date">Sort by date</option>
                    <option value="size">Sort by size</option>
                    <option value="type">Sort by type</option>
                  </select>
                </>
              )}
            </nav>

            {activePanel === 'files' ? (
              <div aria-live="polite">
                {visibleFiles.length === 0 ? (
                  <div className="best-empty">
                    {files.length === 0
                      ? 'No files are selected. Choose files to begin. Best cannot scan your device storage automatically.'
                      : 'No selected files match this view or search.'}
                  </div>
                ) : visibleFiles.map((item) => (
                  <article className="best-file-row" key={item.id}>
                    <div className="best-file-info">
                      <div className="best-file-icon" aria-hidden="true">
                        {fileKind(item.file).split('/').pop().slice(0, 3).toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <p className="best-file-name" title={item.file.name}>{item.file.name}</p>
                        <p className="best-file-meta">
                          {fileKind(item.file)} · {formatSize(item.file.size)}
                        </p>
                      </div>
                    </div>
                    <div className="best-file-buttons">
                      <button
                        className="best-icon-button"
                        type="button"
                        onClick={() => void showPreview(item)}
                        aria-label={`Preview ${item.file.name}`}
                      >
                        Preview
                      </button>
                      <button
                        className="best-icon-button"
                        type="button"
                        onClick={() => downloadLocalFile(item)}
                      >
                        Download
                      </button>
                      <button
                        className="best-icon-button"
                        type="button"
                        onClick={() => void shareLocalFile(item)}
                      >
                        Share
                      </button>
                      <button
                        className="best-icon-button"
                        type="button"
                        aria-pressed={favoriteIds.includes(item.id)}
                        onClick={() => toggleFavorite(item.id)}
                      >
                        {favoriteIds.includes(item.id) ? 'Starred' : 'Star'}
                      </button>
                      <button
                        className="best-icon-button"
                        type="button"
                        onClick={() => removeSelection(item)}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div aria-live="polite">
                {cloudFiles.length === 0 ? (
                  <div className="best-empty">
                    {cloudConnected
                      ? 'No cloud files are available for this browser account.'
                      : 'Connect to the existing private Supabase project to check for cloud files.'}
                  </div>
                ) : cloudFiles.map((record) => (
                  <article className="best-cloud-row" key={record.id}>
                    <div className="best-file-info">
                      <div className="best-file-icon" aria-hidden="true">CLOUD</div>
                      <div style={{ minWidth: 0 }}>
                        <p className="best-file-name" title={record.filename}>{record.filename}</p>
                        <p className="best-file-meta">
                          {record.mime_type} · {formatSize(Number(record.file_size))}
                        </p>
                      </div>
                    </div>
                    <button
                      className="best-secondary"
                      type="button"
                      disabled={cloudBusy || !online}
                      onClick={() => void downloadCloudFile(record)}
                    >
                      Download
                    </button>
                  </article>
                ))}
                {cloudMessage && <p className="best-cloud-message" role="status">{cloudMessage}</p>}
              </div>
            )}

            {notice && <p className="best-cloud-message" role="status">{notice}</p>}

            <p className="best-note">
              Browser access is permission-based. Files you select and starred/recent views exist only in this page session; clearing or closing the tab discards Best&apos;s list, not your original files. A download or cloud operation requires an explicit action.
            </p>
          </section>

          <p className="best-privacy">
            Offline mode caches only the public app shell and versioned static assets after they load. Selected files and private cloud responses are never placed in the service-worker cache. Browser Supabase sessions, when enabled, are stored in browser storage and are not encrypted like Android SecureStore.
          </p>
        </div>
      </main>

      {preview && (
        <div className="best-modal-backdrop" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) closePreview();
        }}>
          <section className="best-modal" role="dialog" aria-modal="true" aria-label={`Preview ${preview.item.file.name}`}>
            <header className="best-modal-head">
              <strong>{preview.item.file.name}</strong>
              <button className="best-secondary" type="button" onClick={closePreview}>Close preview</button>
            </header>
            <div className="best-modal-body">
              {preview.kind === 'image' && <img className="best-preview-image" src={preview.url} alt={preview.item.file.name} />}
              {preview.kind === 'pdf' && <iframe className="best-preview-frame" title={`Preview ${preview.item.file.name}`} src={preview.url} />}
              {preview.kind === 'text' && <pre className="best-preview-text">{previewText}</pre>}
            </div>
          </section>
        </div>
      )}

      {previewError && <p role="alert">{previewError}</p>}
    </>
  );
}
