// AutoGlow 2 - System Settings, Backups & Auto-Updates Module



// =============================================================================

async function renderSettingsTab() {
  fetchBackupsList();
}

async function fetchBackupsList() {
  const container = document.getElementById('backupsListContainer');
  if (!container) return;

  try {
    const data = await ((await fetch('/api/system/backups')).json());

    if (data.status === 'ok' && Array.isArray(data.backups) && data.backups.length > 0) {
      container.innerHTML = data.backups.map(b => {
        const safeFile = escapeJsString(b.filename);
        const fileNameEscaped = escapeHtml(b.filename);
        const noteEscaped = escapeHtml(b.note || '');
        const verEscaped = escapeHtml(b.version || '');
        return `
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; font-family: var(--font-mono);">
            <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="dot dot-green" style="width: 5px; height: 5px; flex-shrink: 0;"></span>
                <strong style="color: var(--text-primary); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileNameEscaped}</strong>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-muted);">
                <span>${b.created_at}</span>
                <span>${b.size_kb} KB</span>
                <span style="color: var(--accent-primary); font-weight: 600;">${verEscaped}</span>
                ${noteEscaped ? `<span style="color: var(--text-secondary);">&bull; ${noteEscaped}</span>` : ''}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
              <button class="btn-ide" onclick="restoreBackup('${safeFile}')" style="color: var(--status-warning); border-color: rgba(245, 158, 11, 0.3); font-size: 10px; padding: 2px 7px;" title="Restore this snapshot">Restore</button>
              <a href="/api/system/backup/download?file=${encodeURIComponent(b.filename)}" class="btn-ide" style="color: var(--text-secondary); font-size: 10px; padding: 2px 7px; text-decoration: none;" title="Download zip">Download</a>
              <button class="btn-ide" onclick="deleteBackup('${safeFile}')" style="color: var(--status-danger); border-color: rgba(239, 68, 68, 0.3); font-size: 10px; padding: 2px 6px;" title="Delete backup">✕</button>
            </div>
          </div>
        `;
      }).join('');
    } else {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-family: var(--font-mono); font-size: 11.5px; padding: 14px 4px; text-align: center;">
          No backups created yet. Click <strong>+ Create Backup</strong> to take a snapshot of your system.
        </div>
      `;
    }
  } catch (err) {
    container.innerHTML = `<div style="color: var(--status-danger); font-family: var(--font-mono); font-size: 11.5px;">Error loading backups: ${err.message || err}</div>`;
  }
}

async function promptCreateBackup() {
  const note = await window.promptDialog({
    title: 'Create backup',
    body: 'Optional note, e.g. "Before update".',
    value: 'Snapshot before update',
    confirmLabel: 'Create',
    maxLength: 120
  });
  if (note === null) return; // User cancelled

  showToast('Creating system backup snapshot...', 'info');
  try {
    const data = await ((await fetch('/api/system/backup/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note.trim() })
    })).json());
    if (data.status === 'ok') {
      showToast(`✓ Backup created: ${data.filename} (${data.size_kb} KB)`, 'success');
      fetchBackupsList();
    } else {
      showToast(`Backup failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error creating backup: ${err.message || err}`, 'error');
  }
}

async function restoreBackup(filename) {
  const confirmed = await window.confirmDialog({
    title: 'Restore this backup?',
    body: `${filename} replaces the current files. AutoGlow reloads afterwards.`,
    confirmLabel: 'Restore',
    danger: true
  });
  if (!confirmed) return;

  showToast(`Restoring backup ${filename}...`, 'info');
  try {
    const data = await ((await fetch('/api/system/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename })
    })).json());
    if (data.status === 'ok') {
      showToast(`✓ Restored ${data.restored_files} files! Reloading system...`, 'success');
      waitForServerAndReload();
    } else {
      showToast(`Restore error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to restore backup: ${err.message || err}`, 'error');
  }
}

async function deleteBackup(filename) {
  const confirmed = await window.confirmDialog({ title: 'Delete backup?', body: filename, confirmLabel: 'Delete', danger: true });
  if (!confirmed) return;

  try {
    const data = await ((await fetch('/api/system/backup/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename })
    })).json());
    if (data.status === 'ok') {
      showToast('Backup deleted.', 'info');
      fetchBackupsList();
    } else {
      showToast(`Failed to delete: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error deleting backup: ${err.message || err}`, 'error');
  }
}

// --- Manual ZIP Software Updates ---
let selectedZipFile = null;

function triggerZipSelect() {
  const input = document.getElementById('zipUpdateFileInput');
  if (input) input.click();
}

function handleZipFileSelected(input) {
  if (input.files && input.files[0]) {
    setUpdateZip(input.files[0]);
  }
}

function handleZipDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  const dropZone = document.getElementById('zipDropZone');
  if (dropZone) {
    dropZone.style.borderColor = 'var(--accent-primary)';
    dropZone.style.background = 'rgba(var(--accent-rgb), 0.08)';
  }
}

function handleZipDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  const dropZone = document.getElementById('zipDropZone');
  if (dropZone) {
    dropZone.style.borderColor = 'rgba(var(--accent-rgb), 0.35)';
    dropZone.style.background = 'rgba(var(--accent-rgb), 0.02)';
  }
}

function handleZipDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const dropZone = document.getElementById('zipDropZone');
  if (dropZone) {
    dropZone.style.borderColor = 'rgba(var(--accent-rgb), 0.35)';
    dropZone.style.background = 'rgba(var(--accent-rgb), 0.02)';
  }

  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0];
    if (!file.name.toLowerCase().endsWith('.zip')) {
      showToast('Please select a valid .zip archive file.', 'warning');
      return;
    }
    setUpdateZip(file);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setUpdateZip(file) {
  selectedZipFile = file;
  const card = document.getElementById('selectedZipCard');
  const nameElem = document.getElementById('selectedZipName');
  const sizeElem = document.getElementById('selectedZipSize');
  const btnApply = document.getElementById('btnApplyZipUpdate');
  const statusBox = document.getElementById('zipUpdateStatusBox');

  if (nameElem) nameElem.textContent = file.name;
  if (sizeElem) sizeElem.textContent = formatFileSize(file.size);
  if (card) card.style.display = 'flex';
  if (btnApply) btnApply.style.display = 'flex';
  if (statusBox) statusBox.style.display = 'none';
}

function clearSelectedZip(e) {
  if (e) e.stopPropagation();
  selectedZipFile = null;
  const input = document.getElementById('zipUpdateFileInput');
  if (input) input.value = '';
  const card = document.getElementById('selectedZipCard');
  const btnApply = document.getElementById('btnApplyZipUpdate');
  const statusBox = document.getElementById('zipUpdateStatusBox');

  if (card) card.style.display = 'none';
  if (btnApply) btnApply.style.display = 'none';
  if (statusBox) statusBox.style.display = 'none';
}

async function applyZipUpdate() {
  if (!selectedZipFile) {
    showToast('Please select an update ZIP file first.', 'warning');
    return;
  }

  const confirmed = await window.confirmDialog({
    title: 'Install update?',
    body: `${selectedZipFile.name} is applied and AutoGlow reloads.`,
    confirmLabel: 'Install'
  });
  if (!confirmed) return;

  const btn = document.getElementById('btnApplyZipUpdate');
  const statusBox = document.getElementById('zipUpdateStatusBox');
  const chkBackup = document.getElementById('chkAutoBackupPreUpdate');
  const autoBackup = chkBackup ? chkBackup.checked : true;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin" style="display:inline-block;margin-right:4px;">⟳</span> Installing update...`;
  }

  if (statusBox) {
    statusBox.style.display = 'block';
    statusBox.style.background = 'rgba(var(--accent-rgb), 0.08)';
    statusBox.style.color = 'var(--accent-primary)';
    statusBox.style.border = '1px solid rgba(var(--accent-rgb), 0.25)';
    statusBox.innerHTML = `Uploading and applying ZIP update... please wait.`;
  }

  showToast('Uploading and applying update...', 'info');

  try {
    const data = await ((async () => {
          const fd = new FormData();
          fd.append('file', selectedZipFile);
          fd.append('auto_backup', autoBackup ? 'true' : 'false');
          const res = await fetch('/api/system/update_zip', { method: 'POST', body: fd });
          return await res.json();
        })()
    );

    if (data.status === 'ok') {
      showToast(`✓ ${data.message || 'Update applied successfully!'}`, 'success');
      
      if (statusBox) {
        statusBox.style.background = 'rgba(16, 185, 129, 0.1)';
        statusBox.style.color = 'var(--status-success)';
        statusBox.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        statusBox.innerHTML = `✓ ${data.message || 'Update applied successfully!'}<br><span style="font-size: 10.5px; opacity: 0.85;">Waiting for AutoGlow to restart...</span>`;
      }

      fetchBackupsList();

      waitForServerAndReload();
    } else {
      showToast(`Update error: ${data.message}`, 'error');
      if (statusBox) {
        statusBox.style.background = 'rgba(239, 68, 68, 0.1)';
        statusBox.style.color = 'var(--status-danger)';
        statusBox.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        statusBox.innerHTML = `✕ Update failed: ${data.message}`;
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>Install Update &amp; Reload</span>`;
      }
    }
  } catch (err) {
    showToast(`Network error applying update: ${err.message || err}`, 'error');
    if (statusBox) {
      statusBox.style.background = 'rgba(239, 68, 68, 0.1)';
      statusBox.style.color = 'var(--status-danger)';
      statusBox.style.border = '1px solid rgba(239, 68, 68, 0.3)';
      statusBox.innerHTML = `✕ Error: ${err.message || err}`;
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>Install Update &amp; Reload</span>`;
    }
  }
}

if (typeof window !== "undefined") {
  window.renderSettingsTab = renderSettingsTab;
  window.fetchBackupsList = fetchBackupsList;
  window.promptCreateBackup = promptCreateBackup;
  window.restoreBackup = restoreBackup;
  window.deleteBackup = deleteBackup;
  window.triggerZipSelect = triggerZipSelect;
  window.handleZipFileSelected = handleZipFileSelected;
  window.handleZipDragOver = handleZipDragOver;
  window.handleZipDragLeave = handleZipDragLeave;
  window.handleZipDrop = handleZipDrop;
  window.clearSelectedZip = clearSelectedZip;
  window.applyZipUpdate = applyZipUpdate;
}


