/**
 * 文件替换插件（File-replacement-plugin）
 *
 * 作用：把自己上传的替换文件，覆盖到其它插件实际读取该文件的位置，
 * 这样修改插件内容时不用直接改动原插件目录，插件更新（git pull）时就不会冲突。
 *
 * 用法：把替换文件按「插件名/插件内相对路径」放进本插件的 res 目录，例如
 *   res/miao-plugin/resources/character/imgs/1.png
 * 就会替换掉 plugins/miao-plugin/resources/character/imgs/1.png
 */
import path from "node:path"
import { install, uninstall, refresh, getEntries, isInstalled, pluginDir } from "./core.js"

/** 启动时立即安装替换（越早越好，尽量早于其它插件加载） */
const info = await install()
if (typeof logger !== "undefined" && logger?.info) {
  logger.info(
    `文件替换插件已加载，替换项 ${info.count} 个，目录：plugins/${path.basename(pluginDir)}/res${info.esm ? "" : "（当前 Node 版本不支持 js 模块替换）"}`
  )
}

export class FileReplacement extends plugin {
  constructor() {
    super({
      name: "文件替换",
      dsc: "用本插件 res 目录下的同名文件替换其它插件读取的资源文件，避免直接改动原插件导致的更新冲突",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#替换列表$", fnc: "listReplacement", permission: "master" },
        { reg: "^#替换重载$", fnc: "reloadReplacement", permission: "master" },
      ],
    })
  }

  async init() {
    /** 热重载后重新安装（install 内部做了幂等处理） */
    await install()
    /** 插件卸载时恢复原始 fs，避免残留替换 */
    this.addCleanup(() => uninstall())
    return true
  }

  /** #替换列表 */
  async listReplacement() {
    refresh()
    const list = getEntries()
    const max = 30
    const lines = [
      "【文件替换】",
      `替换目录：plugins/${path.basename(pluginDir)}/res`,
      `当前替换项：${list.length} 个`,
    ]
    if (!list.length) {
      lines.push("", "还没有替换文件，按「插件名/插件内相对路径」放入 res 目录即可")
    } else {
      lines.push("")
      lines.push(...list.slice(0, max).map(i => `- ${i}`))
      if (list.length > max) lines.push(`... 其余 ${list.length - max} 项省略`)
    }
    lines.push("", "发送 #替换重载 可立即重新读取 res 目录")
    return this.reply(lines.join("\n"))
  }

  /** #替换重载 */
  async reloadReplacement() {
    const count = refresh()
    const esm = isInstalled()
    return this.reply(
      `【文件替换】已重新读取 res 目录\n当前替换项：${count} 个${esm ? "" : "\n（替换功能未生效，请检查插件加载日志）"}`
    )
  }
}
