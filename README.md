# File-replacement-plugin

Yunzai（TRSS-Yunzai / Miao-Yunzai）文件替换插件。

把自己上传的替换文件，覆盖到其它插件实际读取该文件的位置。这样修改插件内容时不用直接改动原插件目录，插件更新（`git pull`）时就不会产生冲突。

## 安装

把本仓库整体放到 `Yunzai/plugins/File-replacement-plugin` 目录下即可（插件目录名保持 `File-replacement-plugin`），重启 Bot 或等待 Yunzai 热重载。

## 使用

把替换文件按「插件名 + 插件内相对路径」放进本插件的 `res` 目录：

```
Yunzai/
└── plugins/
    ├── miao-plugin/
    │   └── resources/character/imgs/1.png        ← 原文件
    └── File-replacement-plugin/
        └── res/
            └── miao-plugin/resources/character/imgs/1.png   ← 你的替换文件（同名同路径）
```

放好后，其它插件再读取 `plugins/miao-plugin/resources/character/imgs/1.png` 时，拿到的就是 `res` 里的版本。文件类型不限：图片、json、txt、html、css、js、字体等都可以。

- 举例：想改 `#心海面板` 用到的角色图片
  - 原路径：`plugins/miao-plugin/resources/character/imgs/xxx.png`
  - 替换文件放在：`plugins/File-replacement-plugin/res/miao-plugin/resources/character/imgs/xxx.png`
- `res` 下的路径也可以写成 `res/plugins/miao-plugin/...`，两种写法等价。
- 只存在于 `res` 里的新文件同样会被识别（等价于给原插件「新增」文件）。
- 文件增删后会自动生效（最多 5 秒内），也可以发送 `#替换重载` 立即生效。

## 命令（仅主人可用）

| 命令 | 说明 |
| --- | --- |
| `#替换列表` | 查看当前所有替换项 |
| `#替换重载` | 立即重新读取 `res` 目录 |

## 生效范围

| 场景 | 是否生效 |
| --- | --- |
| `fs.readFileSync` / `fs.readFile` / `fs.promises.readFile` / `createReadStream` | ✅ |
| `fs.existsSync` / `statSync` / `lstatSync` / `accessSync` / `stat` / `access`（含 promises 版） | ✅ |
| 渲染模板生成的 HTML 中对插件资源的引用（面板图片、css 等） | ✅ |
| `import()` 加载的 js / json 模块（如 miao 的 `resources/meta-*/**.js`） | ✅（需 Node ≥ 20.6） |
| 写入已被替换的文件（写入 `res` 中的替换文件，保持两侧一致） | ✅ |
| 通过 `segment.image(路径)` 发送的图片（适配器读取文件时） | ✅ |

## 注意事项

- 极少数写法如 `import { readFileSync } from 'node:fs'`（具名导入）在插件加载前就已绑定，不会被拦截；Yunzai 与 miao-plugin 均使用默认导入 `import fs from 'node:fs'`，不受影响。
- 超过 10MB 的图片被部分适配器按本地路径直传时会读原文件，正常大小图片走 base64 不受影响。
- 往 `res` 里新增 `.js` 文件时，Yunzai 的热更新监听可能提示 `[新增插件]`，属正常现象，可忽略。
- 删除 `res` 中对应文件即恢复原文件；卸载/停用本插件时会自动恢复原始 `fs` 行为。

## 目录结构

```
File-replacement-plugin/
├── index.js     插件入口（命令、初始化）
├── core.js      替换核心（fs 覆盖、HTML 资源改写、res 扫描）
├── loader.mjs   ESM 解析钩子（js / json 模块替换）
├── res/         替换文件目录（按插件结构放置）
└── README.md
```
