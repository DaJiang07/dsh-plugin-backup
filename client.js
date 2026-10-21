/**
 * Browser half of the plugins & settings backup bundle.
 *
 * One Settings page: save this profile's plugins and settings into a file
 * (optionally with the local plugin sources and plugin-owned data), restore
 * such a file, and restore a backup that already sits on this computer. Every
 * Host operation goes through the authenticated `/dsh-plugin-backup` route;
 * this module owns only the page's own state.
 *
 * The dictionaries below mirror `locale/zh.json` and `locale/en.json`, which
 * the plugin manager reads for this bundle's title, description and icon
 * without activating the plugin. A browser module is self-contained, so the
 * page text travels with it rather than through another request.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'pluginBackup'
    const BASE = '/dsh-plugin-backup'
    /** A backup this large is restored by path, not through a request body. */
    const MAX_UPLOAD_BYTES = 40 * 1024 * 1024

    /**
     * Direction and zero-width marks a copy-paste drags in front of a path.
     * `String.prototype.trim` only removes whitespace, so these survive it and
     * break a `^`-anchored test against the drive letter.
     */
    const PATH_NOISE = /^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+|[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+$/g

    /**
     * Normalize what the operator pasted into the path field. A value with no
     * separator at all is the bare file name a picker echoes back, which the
     * Host cannot open, so it normalizes to an empty string.
     * @param {string} value raw field content.
     * @returns {string} a Host-openable path, or '' when the value is only a name.
     */
    function hostPath(value) {
      const cleaned = value.replace(PATH_NOISE, '')
      return /[\\/]/.test(cleaned) ? cleaned : ''
    }


    const ZH = {
      nav: '备份与恢复',
      title: '插件与设置备份',
      intro: '把「你装的插件」和「你调过的所有设置」打包成一个文件。换电脑后先装这个插件，再选中那个文件恢复，就回到原来的状态。',
      backupHeading: '备份',
      backupBody: '读取当前 profile 的插件清单、保存全部设置的配置层，以及用户设置文件。',
      statPlugins: '插件条目',
      statBundles: '插件包',
      statConfig: '设置文件',
      statOn: '已启用 {on} / {total}',
      fullToggle: '打包全部（本地插件源码 + 插件数据）',
      fullHint: '额外带上 link 到本地的插件目录，以及插件自己写在 harness 目录里的数据。换电脑时连「插件本身」和「插件的状态」一起搬过去。',
      fullRoots: '会额外带上',
      fullExcluded: '永不包含',
      fullEmpty: '没有找到可打包的本地插件或插件数据',
      backupAction: '备份并下载',
      backupBusy: '正在读取…',
      backupSaved: '已保存到 {path}',
      backupDownloaded: '备份文件已下载，请放到换电脑后能拿到的地方。',
      restoreHeading: '从文件恢复',
      restoreBody: '选择之前导出的备份文件。恢复前会先把当前配置存一份，随时可以退回去。',
      restorePick: '选择文件',
      restoreNoFile: '还没有选择文件',
      restoreClear: '清除',
      restorePicked: '已选中 {name}',
      restorePickedNameOnly: '浏览器只给了文件名，没给完整路径；下面填的是文件名，恢复请直接点「开始恢复」。',
      pathNeedsFullPath: '这里要填完整路径（例如 C:\\Users\\你\\Downloads\\dsh-plugins-….json）。只选文件的话，请点上面的「开始恢复」。',
      restoreAction: '开始恢复',
      restoreBusy: '正在恢复…',
      restoreInstalling: '正在安装 {name}（{done}/{total}）…',
      restoreTooBig: '这个文件太大，不适合走浏览器上传。把它存到硬盘上，用下面的「按路径恢复」。',
      pathLabel: '或按路径恢复',
      pathPlaceholder: 'C:\\Users\\你\\Downloads\\dsh-plugins-….json',
      pathAction: '按路径恢复',
      pathHint: 'Host 直接读硬盘上的文件，不经过浏览器，所以多大的全量备份都能恢复。',
      restoreReport: '恢复结果',
      restorePatch: '设置已写入 {path}',
      restoreSettings: '用户设置文件已恢复',
      restoreSettingsAbsent: '这份备份里没有用户设置文件',
      restoreEnabled: '已启用的插件包',
      restoreMissing: '需要安装的插件包',
      restoreKept: '保留了本机多出来的插件包',
      restoreFailures: '失败的步骤',
      restoreSafety: '恢复前的存档：{path}',
      restoreRestart: '建议重启一次 DSH，确保所有恢复的插件都已运行。',
      restoreDone: '恢复完成。',
      installOk: '已安装',
      installFailed: '失败',
      installPendingBuilds: '这个包需要运行安装脚本，请到「插件」页面批准后再试。',
      pkgSources: '本地插件源码',
      pkgData: '插件数据',
      pkgMoved: '恢复前的旧数据已移到 {dir}',
      pkgSkipped: '跳过的文件',
      pkgLinked: '已重新链接',
      pkgKept: '目录已存在，直接复用',
      pkgFailed: '失败',
      localHeading: '本机备份',
      localBody: '每份备份同时留存在 harness 目录里，包括每次恢复前自动做的那一份。',
      localEmpty: '本机还没有备份。',
      localRestore: '恢复',
      localSafetyTag: '恢复前存档',
      localFullTag: '全量',
      localFile: '文件',
      footnote: '凭据、登录状态和对话记录永远不打包（sessions、attachments、profiles、.credentials.yaml）。',
      errorHeading: '出错了',
      bytesUnit: 'B',
      kbUnit: 'KB',
      mbUnit: 'MB',
    }

    const EN = {
      nav: 'Backup',
      title: 'Plugins & settings backup',
      intro: 'Everything that makes this DSH yours — the plugins you installed and every setting in your profile — saved as one file. On a new computer, install this plugin, pick that file, and carry on from where you were.',
      backupHeading: 'Save a backup',
      backupBody: 'Reads your profile’s plugin list, the config layer that holds all your settings, and the user settings document.',
      statPlugins: 'Plugin entries',
      statBundles: 'Plugin bundles',
      statConfig: 'Settings file',
      statOn: '{on} of {total} enabled',
      fullToggle: 'Pack everything (local plugin sources + plugin data)',
      fullHint: 'Also carries every plugin that lives in a local directory, and the state plugins write under the harness home — so the next computer gets the plugins themselves, not only their names.',
      fullRoots: 'Also carried',
      fullExcluded: 'Never carried',
      fullEmpty: 'No local plugin or plugin data was found to pack',
      backupAction: 'Back up and download',
      backupBusy: 'Reading…',
      backupSaved: 'Saved to {path}',
      backupDownloaded: 'The backup file was downloaded. Keep it somewhere the next computer can reach.',
      restoreHeading: 'Restore from a file',
      restoreBody: 'Pick a backup file. Your current configuration is saved first, so this step can always be undone.',
      restorePick: 'Choose file',
      restoreNoFile: 'No file chosen',
      restoreClear: 'Clear',
      restorePicked: 'Chose {name}',
      restorePickedNameOnly: 'The browser only reveals the file name, not its full path; the field below shows that name. Use “Restore” to apply it.',
      pathNeedsFullPath: 'This field needs a full path (for example C:\\Users\\you\\Downloads\\dsh-plugins-….json). To restore a file you picked, use “Restore” above.',
      restoreAction: 'Restore',
      restoreBusy: 'Restoring…',
      restoreInstalling: 'Installing {name} ({done}/{total})…',
      restoreTooBig: 'This file is too large to send through the browser. Save it to disk and use “Restore by path” below.',
      pathLabel: 'Or restore by path',
      pathPlaceholder: 'C:\\Users\\you\\Downloads\\dsh-plugins-….json',
      pathAction: 'Restore by path',
      pathHint: 'The Host reads the file from disk, so a full backup of any size restores without an upload.',
      restoreReport: 'Restore result',
      restorePatch: 'Settings written to {path}',
      restoreSettings: 'User settings document restored',
      restoreSettingsAbsent: 'The backup carried no user settings document',
      restoreEnabled: 'Plugin bundles enabled',
      restoreMissing: 'Plugin bundles that had to be installed',
      restoreKept: 'Plugin bundles kept from this computer',
      restoreFailures: 'Steps that failed',
      restoreSafety: 'Safety copy of the previous state: {path}',
      restoreRestart: 'Restart DSH once to be sure every restored plugin is running.',
      restoreDone: 'Restore finished.',
      installOk: 'installed',
      installFailed: 'failed',
      installPendingBuilds: 'This package wants to run install scripts. Approve them on the Plugins page.',
      pkgSources: 'Local plugin sources',
      pkgData: 'Plugin data',
      pkgMoved: 'The previous data was moved to {dir}',
      pkgSkipped: 'Skipped files',
      pkgLinked: 'linked again',
      pkgKept: 'directory present, reused',
      pkgFailed: 'failed',
      localHeading: 'Backups on this computer',
      localBody: 'Every backup is also kept in your harness home, including the automatic copy taken before each restore.',
      localEmpty: 'No backups on this computer yet.',
      localRestore: 'Restore',
      localSafetyTag: 'safety',
      localFullTag: 'full',
      localFile: 'file',
      footnote: 'Credentials, sign-in state and conversation history are never packed (sessions, attachments, profiles, .credentials.yaml).',
      errorHeading: 'Something went wrong',
      bytesUnit: 'B',
      kbUnit: 'KB',
      mbUnit: 'MB',
    }

    const STYLES = `
      .pb-section { display: flex; flex-direction: column; gap: 14px; max-width: 760px; color: var(--dsw-alias-label-primary); }
      .pb-title { margin: 0; font-size: 18px; font-weight: 600; }
      .pb-intro { margin: 0; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
      .pb-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .pb-cardHead { display: flex; flex-direction: column; gap: 4px; }
      .pb-cardTitle { margin: 0; font-size: 14.5px; font-weight: 600; }
      .pb-cardBody { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .pb-stats { display: flex; flex-wrap: wrap; gap: 8px; }
      .pb-stat { display: flex; flex-direction: column; gap: 2px; min-width: 132px; padding: 8px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
      .pb-statLabel { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .pb-statValue { font-size: 13px; font-weight: 600; }
      .pb-statNote { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .pb-toggle { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; cursor: pointer; }
      .pb-toggle input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
      .pb-toggleText { display: flex; flex-direction: column; gap: 3px; }
      .pb-toggleTitle { font-size: 13px; font-weight: 600; }
      .pb-toggleHint { font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
      .pb-roots { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
      .pb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
      .pb-button { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 13px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .pb-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
      .pb-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .pb-button:disabled { opacity: .45; cursor: default; }
      .pb-primary { background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1); font-weight: 600; }
      .pb-primary:hover:not(:disabled) { background: var(--dsw-alias-label-primary); opacity: .88; }
      .pb-input { box-sizing: border-box; flex: 1; min-width: 220px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font: inherit; font-size: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .pb-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .pb-hint { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .pb-file { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .pb-fileOk { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary)); font-weight: 500; overflow-wrap: anywhere; }
      .pb-error { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
      .pb-notice { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
      .pb-report { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
      .pb-reportTitle { margin: 0; font-size: 13px; font-weight: 600; }
      .pb-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; line-height: 1.6; }
      .pb-lineLabel { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .pb-chip { padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .pb-chipOk { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .pb-chipBad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .pb-chipWarn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .pb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .pb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
      .pb-rowName { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; overflow-wrap: anywhere; }
      .pb-rowMeta { color: var(--dsw-alias-label-secondary); }
      .pb-rowGrow { flex: 1; min-width: 120px; }
      .pb-footnote { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
    `

    /** One JSON round trip against the Host route. */
    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET', credentials: 'same-origin' }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(BASE + path, init)
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        error.code = payload?.error?.code
        error.status = response.status
        throw error
      }
      return payload
    }

    /** @param {unknown} error @returns {string} */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** @param {string} value @returns {string} */
    function fileStamp(value) {
      return value.slice(0, 19).replace('T', '-').replaceAll(':', '')
    }

    /** Hand one snapshot to the browser's download flow. */
    function downloadSnapshot(snapshot) {
      const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      const full = snapshot.package === undefined ? '' : '-full'
      anchor.download = `dsh-plugins${full}-${fileStamp(snapshot.createdAt ?? new Date().toISOString())}.json`
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }

    function BackupSection(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [saved, setSaved] = React.useState(null)
      const [savedBytes, setSavedBytes] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [full, setFull] = React.useState(false)
      const [pathValue, setPathValue] = React.useState('')
      const fileInput = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          setStatus(await api('/status'))
          setError(null)
        } catch (failure) {
          setError(messageOf(failure))
        }
      }, [])

      React.useEffect(() => {
        let live = true
        void api('/status')
          .then((value) => {
            if (!live) return
            setStatus(value)
            setError(null)
          })
          .catch((failure) => {
            if (live) setError(messageOf(failure))
          })
        return () => { live = false }
      }, [])

      const formatBytes = (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${t('bytesUnit')}`
        if (bytes < 1024) return `${String(bytes)} ${t('bytesUnit')}`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('kbUnit')}`
        return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('mbUnit')}`
      }

      const runExport = async () => {
        setBusy('export')
        setError(null)
        setReport(null)
        setSaved(null)
        setSavedBytes(null)
        try {
          const payload = await api(`/export${full ? '?full=1' : ''}`)
          downloadSnapshot(payload.snapshot)
          setSaved(payload.savedTo ?? '')
          setSavedBytes(JSON.stringify(payload.snapshot).length)
          await load()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(null)
        }
      }

      const finishRestore = async (payload) => {
        const missing = Array.isArray(payload.report?.missing) ? payload.report.missing : []
        const installs = []
        for (let index = 0; index < missing.length; index += 1) {
          const item = missing[index]
          setProgress({ name: item.name, done: index, total: missing.length })
          try {
            const installed = await api('/install', { spec: item.spec })
            const result = installed.result ?? {}
            installs.push({
              spec: item.spec,
              ok: result.ok !== false && result.application !== 'failed',
              message: result.message ?? result.error?.diagnostic ?? result.error?.code ?? null,
              pendingBuilds: result.pendingBuilds ?? [],
              via: result.via ?? null,
            })
          } catch (failure) {
            installs.push({ spec: item.spec, ok: false, message: messageOf(failure), pendingBuilds: [] })
          }
          setProgress({ name: item.name, done: index + 1, total: missing.length })
        }
        setReport({ ...payload.report, installs })
        await load()
      }

      const runRestore = async (snapshot) => {
        setBusy('restore')
        setError(null)
        setReport(null)
        try {
          await finishRestore(await api('/restore', { snapshot }))
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(null)
          setProgress(null)
        }
      }

      const runRestoreByPath = async () => {
        // A bare file name is what the picker echoed back, not a path the Host
        // can open; restoring that upload is the button just above instead.
        const target = hostPath(pathValue)
        if (target === '') {
          setError(t('pathNeedsFullPath'))
          return
        }
        setBusy('restore')
        setError(null)
        setReport(null)
        try {
          await finishRestore(await api('/restore-path', { path: target }))
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(null)
          setProgress(null)
        }
      }

      const restoreLocal = async (file) => {
        setBusy('restore')
        setError(null)
        setReport(null)
        try {
          await finishRestore(await api('/restore-local', { file }))
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(null)
          setProgress(null)
        }
      }

      const pickFile = async (event) => {
        const file = event.target.files?.[0]
        if (!file) {
          setPicked(null)
          setPathValue('')
          return
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          setPicked(null)
          setPathValue('')
          setError(t('restoreTooBig'))
          return
        }
        try {
          const text = await file.text()
          setPicked({ name: file.name, snapshot: JSON.parse(text) })
          // The picker only yields a file name, never a path; echo it into the
          // path field so the choice is visible. Restoring still goes through the
          // uploaded snapshot, so a bare name in that field is harmless.
          setPathValue(file.name)
          setError(null)
        } catch (failure) {
          setPicked(null)
          setPathValue('')
          setError(messageOf(failure))
        }
      }

      const clearPicked = () => {
        setPicked(null)
        setPathValue('')
        if (fileInput.current !== null) fileInput.current.value = ''
      }

      const plugins = status?.counts?.plugins ?? 0
      const enabledPlugins = status?.counts?.enabledPlugins ?? 0
      const bundles = status?.counts?.bundles ?? 0
      const enabledBundles = status?.counts?.enabledBundles ?? 0
      const backups = Array.isArray(status?.backups) ? status.backups : []
      const packageRoots = Array.isArray(status?.packageRoots) ? status.packageRoots : []
      const packageExcluded = Array.isArray(status?.packageExcluded) ? status.packageExcluded : []
      const working = busy !== null

      const stat = (label, value, note) => h('div', { className: 'pb-stat', key: label },
        h('span', { className: 'pb-statLabel' }, label),
        h('span', { className: 'pb-statValue' }, value),
        note === null || note === undefined || note === '' ? null : h('span', { className: 'pb-statNote' }, note))

      const chipRow = (label, chips) => (chips === null || chips.length === 0 ? null : h('div', { className: 'pb-line' },
        h('span', { className: 'pb-lineLabel' }, `${label}:`),
        ...chips))

      const pkg = report?.package ?? null

      const reportView = report === null ? null : h('div', { className: 'pb-report' },
        h('p', { className: 'pb-reportTitle' }, t('restoreReport')),
        h('div', { className: 'pb-line' },
          h('span', { className: 'pb-chip pb-chipOk' }, t('restoreDone')),
          report.patch?.path === undefined
            ? null
            : h('span', { className: 'pb-lineLabel' }, t('restorePatch', { path: report.patch.path }))),
        h('div', { className: 'pb-line' },
          h('span', { className: 'pb-lineLabel' }, report.settings === 'written' ? t('restoreSettings') : t('restoreSettingsAbsent'))),
        pkg === null ? null : chipRow(t('pkgSources'), (pkg.sources ?? []).map(item => h('span', {
          className: `pb-chip ${item.action === 'failed' ? 'pb-chipBad' : 'pb-chipOk'}`,
          key: `src-${item.package}`,
          title: item.error ?? item.target ?? '',
        }, `${item.package} · ${item.action === 'failed' ? t('pkgFailed') : item.action === 'kept' ? t('pkgKept') : t('pkgLinked')}`))),
        pkg === null ? null : chipRow(t('pkgData'), (pkg.data ?? []).map(item => h('span', {
          className: 'pb-chip',
          key: `data-${item.group}-${item.root}`,
        }, `${item.root} · ${String(item.files)}`))),
        pkg === null || (pkg.moved ?? []).length === 0
          ? null
          : h('p', { className: 'pb-hint' }, t('pkgMoved', { dir: report.safetyDataDir ?? '' })),
        pkg === null || !(pkg.skipped > 0)
          ? null
          : h('p', { className: 'pb-hint' }, `${t('pkgSkipped')}: ${String(pkg.skipped)}`),
        chipRow(t('restoreEnabled'), (report.enabled ?? []).map(name => h('span', { className: 'pb-chip', key: `enabled-${name}` }, name))),
        chipRow(t('restoreKept'), (report.kept ?? []).map(name => h('span', { className: 'pb-chip', key: `kept-${name}` }, name))),
        chipRow(t('restoreMissing'), (report.installs ?? []).map(item => h('span', {
          className: `pb-chip ${item.ok ? 'pb-chipOk' : 'pb-chipBad'}`,
          key: `install-${item.spec}`,
          title: item.message ?? '',
        }, `${item.spec} · ${item.ok ? t('installOk') : t('installFailed')}`))),
        ...(report.installs ?? []).filter(item => !item.ok && item.message).map(item => h('p', {
          className: 'pb-error',
          key: `install-error-${item.spec}`,
        }, `${item.spec}: ${item.message}`)),
        (report.installs ?? []).some(item => (item.pendingBuilds ?? []).length > 0)
          ? h('p', { className: 'pb-notice' }, t('installPendingBuilds'))
          : null,
        chipRow(t('restoreFailures'), (report.failures ?? []).map((item, index) => h('span', {
          className: 'pb-chip pb-chipBad',
          key: `failure-${item.target}-${String(index)}`,
          title: item.message ?? item.code ?? '',
        }, `${item.target} · ${item.code ?? 'error'}`))),
        report.safetyFile === null || report.safetyFile === undefined
          ? null
          : h('p', { className: 'pb-hint' }, t('restoreSafety', { path: report.safetyFile })),
        report.restartRequired === true || (report.installs ?? []).some(item => item.ok)
          ? h('p', { className: 'pb-notice' }, t('restoreRestart'))
          : null)

      return h(React.Fragment, null,
        h('style', { key: 'pb-style' }, STYLES),
        h('div', { className: 'pb-section' },
          h('h1', { className: 'pb-title' }, t('title')),
          h('p', { className: 'pb-intro' }, t('intro')),

          error === null ? null : h('p', { className: 'pb-error' }, `${t('errorHeading')}: ${error}`),

          h('section', { className: 'pb-card', key: 'backup' },
            h('div', { className: 'pb-cardHead' },
              h('h2', { className: 'pb-cardTitle' }, t('backupHeading')),
              h('p', { className: 'pb-cardBody' }, t('backupBody'))),
            status === null
              ? null
              : h('div', { className: 'pb-stats' },
                  stat(t('statPlugins'), String(plugins), t('statOn', { on: enabledPlugins, total: plugins })),
                  stat(t('statBundles'), String(bundles), t('statOn', { on: enabledBundles, total: bundles })),
                  stat(t('statConfig'), formatBytes(status.patch?.bytes ?? 0), status.patch?.path ?? '')),
            h('label', { className: 'pb-toggle' },
              h('input', {
                type: 'checkbox',
                checked: full,
                disabled: working,
                onChange: (event) => setFull(event.target.checked),
              }),
              h('span', { className: 'pb-toggleText' },
                h('span', { className: 'pb-toggleTitle' }, t('fullToggle')),
                h('span', { className: 'pb-toggleHint' }, t('fullHint')))),
            packageRoots.length === 0
              ? h('p', { className: 'pb-hint' }, t('fullEmpty'))
              : h('div', { className: 'pb-cardHead' },
                  h('span', { className: 'pb-statLabel' }, t('fullRoots')),
                  h('ul', { className: 'pb-roots' },
                    ...packageRoots.map(root => h('li', {
                      key: `${root.kind}-${root.label}`,
                      className: `pb-chip ${root.kind === 'plugin-source' ? 'pb-chipWarn' : ''}`,
                      title: root.path,
                    }, root.label)))),
            packageExcluded.length === 0
              ? null
              : h('div', { className: 'pb-cardHead' },
                  h('span', { className: 'pb-statLabel' }, t('fullExcluded')),
                  h('ul', { className: 'pb-roots' },
                    ...packageExcluded.map(name => h('li', { key: `excluded-${name}`, className: 'pb-chip' }, name)))),
            h('div', { className: 'pb-actions' },
              h('button', {
                className: 'pb-button pb-primary',
                type: 'button',
                disabled: working,
                onClick: () => { void runExport() },
              }, busy === 'export' ? t('backupBusy') : t('backupAction')),
              saved === null || saved === ''
                ? null
                : h('span', { className: 'pb-hint' }, t('backupSaved', { path: saved }))),
            savedBytes === null ? null : h('p', { className: 'pb-hint' }, `${formatBytes(savedBytes)} · ${t('backupDownloaded')}`)),

          h('section', { className: 'pb-card', key: 'restore' },
            h('div', { className: 'pb-cardHead' },
              h('h2', { className: 'pb-cardTitle' }, t('restoreHeading')),
              h('p', { className: 'pb-cardBody' }, t('restoreBody'))),
            h('div', { className: 'pb-actions' },
              h('button', {
                className: 'pb-button',
                type: 'button',
                disabled: working,
                onClick: () => fileInput.current?.click(),
              }, t('restorePick')),
              h('input', {
                ref: fileInput,
                type: 'file',
                accept: 'application/json,.json',
                style: { display: 'none' },
                onChange: (event) => { void pickFile(event) },
              }),
              h('span', { className: picked === null ? 'pb-file' : 'pb-file pb-fileOk' },
                picked === null ? t('restoreNoFile') : t('restorePicked', { name: picked.name })),
              picked === null
                ? null
                : h('button', {
                    className: 'pb-button',
                    type: 'button',
                    disabled: working,
                    onClick: clearPicked,
                  }, t('restoreClear')),
              h('button', {
                className: 'pb-button pb-primary',
                type: 'button',
                disabled: working || picked === null,
                onClick: () => { if (picked !== null) void runRestore(picked.snapshot) },
              }, busy === 'restore' ? t('restoreBusy') : t('restoreAction'))),
            picked === null
              ? null
              : h('p', { className: 'pb-hint' }, t('restorePickedNameOnly')),
            h('div', { className: 'pb-cardHead' },
              h('span', { className: 'pb-statLabel' }, t('pathLabel')),
              h('div', { className: 'pb-actions' },
                h('input', {
                  className: 'pb-input',
                  type: 'text',
                  value: pathValue,
                  placeholder: t('pathPlaceholder'),
                  disabled: working,
                  spellCheck: false,
                  onChange: (event) => setPathValue(event.target.value),
                }),
                h('button', {
                  className: 'pb-button',
                  type: 'button',
                  disabled: working || pathValue.trim() === '',
                  onClick: () => { void runRestoreByPath() },
                }, t('pathAction'))),
              h('p', { className: 'pb-hint' }, t('pathHint'))),
            progress === null
              ? null
              : h('p', { className: 'pb-hint' }, t('restoreInstalling', {
                  name: progress.name,
                  done: progress.done,
                  total: progress.total,
                })),
            reportView),

          h('section', { className: 'pb-card', key: 'local' },
            h('div', { className: 'pb-cardHead' },
              h('h2', { className: 'pb-cardTitle' }, t('localHeading')),
              h('p', { className: 'pb-cardBody' }, t('localBody'))),
            backups.length === 0
              ? h('p', { className: 'pb-hint' }, t('localEmpty'))
              : h('ul', { className: 'pb-list' },
                  ...backups.map(entry => h('li', { className: 'pb-row', key: entry.file },
                    h('span', { className: `pb-chip ${entry.kind === 'safety' ? 'pb-chipWarn' : ''}` },
                      entry.kind === 'safety' ? t('localSafetyTag') : t('localFile')),
                    entry.full === true ? h('span', { className: 'pb-chip pb-chipWarn' }, t('localFullTag')) : null,
                    h('span', { className: 'pb-rowName pb-rowGrow' }, entry.file),
                    h('span', { className: 'pb-rowMeta' }, formatBytes(entry.bytes)),
                    h('span', { className: 'pb-rowMeta' }, (entry.createdAt ?? entry.modifiedAt ?? '').slice(0, 19).replace('T', ' ')),
                    h('button', {
                      className: 'pb-button',
                      type: 'button',
                      disabled: working,
                      onClick: () => { void restoreLocal(entry.file) },
                    }, t('localRestore')))))),

          h('p', { className: 'pb-footnote' }, t('footnote'))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'plugin-backup: page dictionaries')
        // The label thunk is re-read on every projection, so the nav row follows the active locale.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'plugin-backup',
          order: 45,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, BackupSection))
      },
    }
  },
})
