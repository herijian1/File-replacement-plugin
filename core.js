/**
 * File-replacement-plugin 核心逻辑
 *
 * 把 res 目录中与插件文件同路径的文件，覆盖到插件实际“用到”该文件的地方：
 *  1. node:fs / node:fs/promises 的读取、存在性判断、stat、access、读取流
 *  2. 模板渲染生成的 HTML 中对插件资源的引用（图片、css、js 等）
 *  3. 通过 import() 加载的 js / json 文件（由 loader.mjs 完成，需 Node >= 20.6）
 *
 * 替换规则：res/<插件名>/<插件内相对路径>  ->  plugins/<插件名>/<插件内相对路径>
 * 例如 res/miao-plugin/resources/1.png    ->  plugins/miao-plugin/resources/1.png
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 文件事件防抖时间（毫秒），避免短时间内多次扫描 */
const WATCH_DEBOUNCE = 500
/** 原始 fs 方法挂载在 fs 模块对象上的符号键，热重载时不会重复包装 */
const ORIG_KEY = Symbol.for("FileReplacementPlugin.orig")
const STATE_KEY = Symbol.for("FileReplacementPlugin.state")
const ESM_FLAG = Symbol.for("FileReplacementPlugin.esmHook")

const _url = new URL(import.meta.url)
_url.search = ""
_url.hash = ""
/** 插件目录 */
export const pluginDir = path.dirname(fileURLToPath(_url))
/** 替换文件目录 */
export const resDir = path.join(pluginDir, "res")
/** Bot 根目录（Yunzai 启动目录） */
const rootDir = process.cwd()

const state = (globalThis[STATE_KEY] ??= {
  /** 被替换文件的绝对路径 -> 替换文件绝对路径 */
  byAbs: new Map(),
  /** plugins/xxx 形式的相对路径 -> 替换文件绝对路径 */
  byRel: new Map(),
  /** 当前替换项（用于列表展示） */
  entries: [],
  signature: "",
  scanning: false,
  installed: false,
  esm: false,
  /** chokidar 监听器，热重载时复用 */
  watcher: null,
  /** 防抖定时器 */
  watchTimer: null,
  /** 是否成功启动了监听 */
  watching: false,
})

/** 捕获并保存原始 fs 方法，只捕获一次 */
function captureOrig() {
  if (!fs[ORIG_KEY]) {
    const promises = fs.promises
    Object.defineProperty(fs, ORIG_KEY, {
      enumerable: false,
      value: {
        readFileSync: fs.readFileSync,
        readFile: fs.readFile,
        createReadStream: fs.createReadStream,
        existsSync: fs.existsSync,
        accessSync: fs.accessSync,
        statSync: fs.statSync,
        lstatSync: fs.lstatSync,
        stat: fs.stat,
        access: fs.access,
        writeFileSync: fs.writeFileSync,
        writeFile: fs.writeFile,
        readdirSync: fs.readdirSync,
        mkdirSync: fs.mkdirSync,
        promises,
        readFileP: promises.readFile,
        writeFileP: promises.writeFile,
        statP: promises.stat,
        accessP: promises.access,
      },
    })
  }
  return fs[ORIG_KEY]
}

/** 清空 Yunzai 渲染器的 html 模板缓存，保证替换后的模板立即生效 */
function clearTplCache() {
  try {
    if (globalThis.Renderer?.html) globalThis.Renderer.html = {}
  } catch {}
}

/** 递归扫描 res 目录，重建替换映射 */
function scanRes() {
  const orig = fs[ORIG_KEY]
  const byAbs = new Map()
  const byRel = new Map()
  const sig = []

  const walk = (dir, rel) => {
    let list
    try {
      list = orig.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of list) {
      if (item.name.startsWith(".")) continue
      const itemRel = rel ? `${rel}/${item.name}` : item.name
      const itemAbs = path.join(dir, item.name)
      if (item.isDirectory()) {
        walk(itemAbs, itemRel)
        continue
      }
      if (!item.isFile()) continue
      /** res/plugins/xxx 与 res/xxx 都指向 plugins/xxx */
      const relKey = itemRel.startsWith("plugins/") ? itemRel : `plugins/${itemRel}`
      byAbs.set(path.resolve(rootDir, relKey), itemAbs)
      byRel.set(relKey, itemAbs)
      try {
        const st = orig.statSync(itemAbs)
        sig.push(`${relKey}:${st.size}:${st.mtimeMs}`)
      } catch {}
    }
  }

  walk(resDir, "")

  state.byAbs = byAbs
  state.byRel = byRel
  state.entries = [...byRel.keys()].sort()
  const signature = sig.sort().join("\n")
  if (signature !== state.signature) {
    state.signature = signature
    clearTplCache()
  }
  return byAbs.size
}

/** 立即重新扫描 res 目录 */
export function refresh() {
  if (state.scanning) return state.byAbs.size
  state.scanning = true
  try {
    return scanRes()
  } finally {
    state.scanning = false
  }
}

/** 防抖刷新：文件事件后延迟扫描，合并短时间内的多次变更 */
function scheduleRefresh() {
  if (state.watchTimer) clearTimeout(state.watchTimer)
  state.watchTimer = setTimeout(() => {
    state.watchTimer = null
    refresh()
  }, WATCH_DEBOUNCE)
}

/**
 * 用 chokidar 监听 res 目录变化，自动触发扫描。
 * chokidar 是 Yunzai 的依赖，从 Yunzai 根目录的 node_modules 解析；
 * 若环境中不存在 chokidar，则仅依赖手动 #替换重载，不报错。
 */
async function startWatcher() {
  if (state.watcher) return true
  let chokidar
  try {
    chokidar = (await import("chokidar")).default
  } catch {
    return false
  }
  const watcher = chokidar.watch(resDir, {
    ignored: /(^|[/\\])\./,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  })
  watcher
    .on("add", () => scheduleRefresh())
    .on("change", () => scheduleRefresh())
    .on("unlink", () => scheduleRefresh())
    .on("unlinkDir", () => scheduleRefresh())
    .on("addDir", () => scheduleRefresh())
  state.watcher = watcher
  return true
}

/** 把 fs 的第一个参数统一转成路径字符串，无法识别时返回 null */
function toPath(p) {
  if (typeof p === "string") return p
  if (p instanceof URL) {
    try {
      return fileURLToPath(p)
    } catch {
      return null
    }
  }
  if (Buffer.isBuffer(p)) return p.toString()
  return null
}

/** 若该路径存在替换版本，返回替换文件的绝对路径，否则返回原路径 */
function redirect(p) {
  if (!state.byAbs.size) return p
  const str = toPath(p)
  if (str === null) return p
  const repl = state.byAbs.get(path.resolve(str))
  return repl || str
}

/** HTML 中的路径片段（排除引号、括号、空白、逗号、分号） */
const TOKEN_RE = /[^"'()<>\s,;]+/g

/** 把 HTML 里对插件资源的引用改写到替换文件 */
export function rewriteHtml(html, htmlDir) {
  if (!state.byRel.size || !html.includes("plugins")) return html
  return html.replace(TOKEN_RE, token => {
    if (!token.includes("plugins")) return token
    /** http(s)/data/blob 等外部引用不做处理 */
    if (/^(https?|data|blob):/i.test(token)) return token
    const norm = token.replace(/\\/g, "/")
    const idx = norm.indexOf("plugins/")
    if (idx === -1) return token
    const key = norm.slice(idx).split(/[?#]/)[0]
    const repl = state.byRel.get(key)
    if (!repl) return token
    try {
      return encodeURI(path.relative(htmlDir, repl).split(path.sep).join("/"))
    } catch {
      return token
    }
  })
}

const TEMP_HTML = `${path.sep}temp${path.sep}html${path.sep}`

/** 写入渲染模板生成的 HTML 时改写其中的资源引用 */
function prepareWrite(file, data) {
  if (typeof file !== "string") return data
  if (typeof data !== "string" || !state.byRel.size) return data
  if (!file.includes(TEMP_HTML) || !data.includes("plugins")) return data
  try {
    return rewriteHtml(data, path.dirname(file))
  } catch {
    return data
  }
}

/** 包装 fs 方法 */
function patch(orig) {
  const P = fs.promises

  fs.readFileSync = function (file, ...args) {
    return orig.readFileSync.call(this, redirect(file), ...args)
  }
  fs.readFile = function (file, ...args) {
    return orig.readFile.call(this, redirect(file), ...args)
  }
  fs.createReadStream = function (file, ...args) {
    return orig.createReadStream.call(this, redirect(file), ...args)
  }
  fs.existsSync = function (file) {
    return orig.existsSync.call(this, redirect(file))
  }
  fs.accessSync = function (file, ...args) {
    return orig.accessSync.call(this, redirect(file), ...args)
  }
  fs.statSync = function (file, ...args) {
    return orig.statSync.call(this, redirect(file), ...args)
  }
  fs.lstatSync = function (file, ...args) {
    return orig.lstatSync.call(this, redirect(file), ...args)
  }
  fs.stat = function (file, ...args) {
    return orig.stat.call(this, redirect(file), ...args)
  }
  fs.access = function (file, ...args) {
    return orig.access.call(this, redirect(file), ...args)
  }
  fs.writeFileSync = function (file, data, ...args) {
    const target = redirect(file)
    return orig.writeFileSync.call(this, target, prepareWrite(target, data), ...args)
  }
  fs.writeFile = function (file, data, ...args) {
    const target = redirect(file)
    return orig.writeFile.call(this, target, prepareWrite(target, data), ...args)
  }
  P.readFile = function (file, ...args) {
    return orig.readFileP.call(this, redirect(file), ...args)
  }
  P.writeFile = function (file, data, ...args) {
    const target = redirect(file)
    return orig.writeFileP.call(this, target, prepareWrite(target, data), ...args)
  }
  P.stat = function (file, ...args) {
    return orig.statP.call(this, redirect(file), ...args)
  }
  P.access = function (file, ...args) {
    return orig.accessP.call(this, redirect(file), ...args)
  }
}

/** 注册 ESM 解析钩子，让 import() 加载的 js / json 也能被替换 */
async function registerEsmHook() {
  if (globalThis[ESM_FLAG]) return true
  try {
    const { register } = await import("node:module")
    if (typeof register !== "function") return false
    await register(new URL("./loader.mjs", _url).href, _url.href)
    globalThis[ESM_FLAG] = true
    return true
  } catch {
    return false
  }
}

/**
 * 安装替换功能（可重复调用，热重载安全）
 * @returns {Promise<{count: number, esm: boolean, resDir: string, pluginDir: string, watching: boolean}>}
 */
export async function install() {
  const orig = captureOrig()
  try {
    orig.mkdirSync(resDir, { recursive: true })
  } catch {}
  refresh()
  if (!state.installed) {
    state.installed = true
    patch(orig)
    state.esm = await registerEsmHook()
  }
  /** 监听 res 目录变化，自动更新替换映射（不影响消息响应延迟） */
  state.watching = await startWatcher()
  return { count: state.byAbs.size, esm: state.esm === true, resDir, pluginDir, watching: state.watching === true }
}

/** 卸载替换功能，恢复原始 fs 方法 */
export function uninstall() {
  const orig = fs[ORIG_KEY]
  if (!orig || !state.installed) return false
  state.installed = false
  state.byAbs = new Map()
  state.byRel = new Map()
  state.entries = []
  state.signature = ""
  if (state.watchTimer) {
    clearTimeout(state.watchTimer)
    state.watchTimer = null
  }
  if (state.watcher) {
    state.watcher.close().catch(() => {})
    state.watcher = null
  }
  state.watching = false

  const P = fs.promises
  fs.readFileSync = orig.readFileSync
  fs.readFile = orig.readFile
  fs.createReadStream = orig.createReadStream
  fs.existsSync = orig.existsSync
  fs.accessSync = orig.accessSync
  fs.statSync = orig.statSync
  fs.lstatSync = orig.lstatSync
  fs.stat = orig.stat
  fs.access = orig.access
  fs.writeFileSync = orig.writeFileSync
  fs.writeFile = orig.writeFile
  P.readFile = orig.readFileP
  P.writeFile = orig.writeFileP
  P.stat = orig.statP
  P.access = orig.accessP
  return true
}

/** 当前替换项列表（plugins/xxx 形式） */
export function getEntries() {
  return [...state.entries]
}

/** 当前替换项数量 */
export function getCount() {
  return state.byAbs.size
}

/** 是否已安装 */
export function isInstalled() {
  return state.installed
}
