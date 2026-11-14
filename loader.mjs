/**
 * ESM 解析钩子：让 import() 加载的 js / json 等模块也能被替换
 *
 * 由 core.js 通过 module.register() 注册，本文件运行在独立的加载线程中，
 * 因此这里必须使用未被包装的 node:fs（两个线程的 fs 相互独立）。
 * 提供 Node >= 20.6，低版本会注册失败，仅影响 js 模块替换，不影响其它文件类型。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const resDir = fileURLToPath(new URL("./res/", import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  try {
    if (!result?.url?.startsWith("file:")) return result
    const url = new URL(result.url)
    const file = decodeURIComponent(url.pathname)
    const idx = file.indexOf("/plugins/")
    if (idx === -1) return result
    /** miao-plugin/resources/meta/xxx.js 之类的插件内相对路径 */
    const rel = file.slice(idx + "/plugins/".length)
    const target = path.join(resDir, rel)
    if (fs.existsSync(target)) {
      return { ...result, url: pathToFileURL(target).href + url.search }
    }
  } catch {}
  return result
}
