# dsh-composer-keys

<p align="center">
  <strong>把「发送 / 换行 / 打断」分配给你顺手的键 / Send, newline & interrupt — bound to the keys you like</strong>
</p>

> **v0.1.4 · DSH 0.2.x 版**（插件页原生表单 + 浮动面板双配置面，两处都可按键录制；**已在 DSH 0.2.1-rc.2 上实机验证有效**；兼容 0.1.7 / ≤0.1.6 的设置面）

> ⚠️ **维护状态 · Maintenance notice**：DSH 已有快捷键编辑界面（Settings → 快捷键）。若官方后续推出可自定义「发送 / 换行 / 打断」的同类功能，**本项目将停止维护**（归档，不再适配新版本 DSH）。
>
> 版本说明 · Version note：公共版本线延续浮动面板时代的 0.1.x 命名（上一发为 0.1.3）；**0.1.4 = 面向 DSH 0.2.x 的整代重写**（插件页原生表单 + 浮动面板双配置面、按键录制、插件页深链）。

`dsh-composer-keys` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 前端的输入框按键自定义插件：把 **Enter、Ctrl/Cmd+Enter、Shift+Enter 或任意自定义组合键**自由分配给「发送」「换行」「打断」三个动作，并在 DSH 原生「插件」页上提供配置表单（DSH 原生 / 微信风格方案 + 最多 3 个自定义方案的键位方案条）。

**默认保持 DSH 原生行为**——装上插件后一切照旧，只有你主动改绑（或点预设）才会变化。

## 版本兼容

| DSH 版本 | 状态 | 设置持久化通道 |
| --- | --- | --- |
| **0.1.7-rc.2** | ✅ 适配 | `configForms` + 条目 volatile `Config` 派生命名空间 |
| **0.1.7-rc.1** | ✅ 适配（本版本主目标） | `configForms` + 条目 volatile `Config` 派生命名空间 |
| ≤ 0.1.6 | ✅ 兼容（遗留路径） | `settingsScope.bind` / `settings.register` |

两个世代的差异全部在插件内部做特性检测，升级无需改配置。

## 特性

- **三通道自由分配**：「发送」「换行」「打断」各自绑定一组组合键；同一组合键不能同时属于多个动作（跨动作重复写入时自动迁移，优先级：发送 > 换行 > 打断）。
- **配置页 = 侧边栏「插件」页**（DSH 0.2.x 原生界面）：`dsh-composer-keys` bundle 页内嵌原生表单（顶置「键位方案」复选框条 + 三个文字配置项 + 「新建方案名」文字配置项，全用 DSH 官方 `SettingsForm` 组件），组件行 `composer-keys` 的「配置」入口打开同一张行配置页；两处共用同一舞台化表单，**只有点「保存」才写入**，离开页面丢弃未保存的编辑。
- **键位方案条（复选框，置顶）**：「DSH 原生」「微信风格」两套内置方案 + 你保存的自定义方案（最多 3 个）。勾选一个 = 三个键位字段整组切换为该方案，随同一次「保存」生效；字段与某方案完全一致时自动勾中它，与所有方案都不一致时全部未选。
- **新建自定义方案**：把三个键位字段改成任意组合，在「新建方案名」里填一个名字（同名覆盖，最多 3 个），点「保存」即存为一个自定义方案——同一次保存里既生效键位、也写入方案列表；留空则只保存键位、不建方案。
- **两处浮板入口：浮动面板（0.1.x 界面）**：Settings → General 的「输入框按键」一行、聊天输入框工具行右侧的小键盘按钮，两者都打开**浮动面板**。面板里改键**立即生效**（无保存按钮）：三通道键位 chip 增删、「+ 录制按键」直接按键录制、顶置方案条复选框与「保存方案」行（与插件页能力一致）；面板底部有迁移标注（后续版本将彻底迁移到插件页）和「打开插件页设置」按钮（深链直达本插件的插件页配置页）。
- **任务打断**：「打断」中断当前打开会话正在运行的任务，等同于输入框的停止按钮——走同一条原生取消管线（含子代理地址路由）。任务运行时在页面**任意位置**生效；对话框/菜单打开时让路；空闲时按下不吞键、零副作用，并在控制台打印跳过原因。默认无绑定。
- **Shift+Enter 显式绑定优先**：Shift+Enter 绑定到「换行」时恒放行给原生处理器（原生 Lexical line-break 处理，不可能被吞掉）；重绑到「发送/打断」则由本插件接管（自定义方案可以用它）；未被任何动作绑定时保持原生换行、插件不干扰。自定义换行键由插件接管（Lexical 命令身份对象 dispatch，草稿/选区/撤销历史保持同步）。
- **持久化**：键位存入 DSH 用户设置文档的 `composer-keys` 命名空间——与主题、语言等原生偏好同一条通道，重启保留、跨设备跟随用户文档。插件页「保存」为一次**原子 mutate**（单 revision、单回显），保存被拒时原生框架提示「本部署没有接受这些值」且草稿保留。
- **即时生效**：保存后无需刷新页面。

## 与原生「繁忙时 Enter 键行为」设置的关系

这是本插件最重要的设计边界：**两层机制正交，互不冲突**。

| 层 | 归属 | 管什么 |
| --- | --- | --- |
| 手势 → 动作 | **本插件** | 哪个键触发「发送」、哪个键触发「换行」 |
| 动作 → 忙碌语义 | **DSH 原生** | 智能体忙碌时提交是「排队」还是「转向」（即原生的 busy-Enter 设置） |

具体衔接规则：

1. 命中「发送」的手势会被重放为一个合成的普通 Enter 键事件，由 **DSH 原生的提交管线**完成发送——斜杠菜单仲裁、空草稿防抖、忙碌时的排队/转向判断全部保持原生逻辑；
2. **只要键位偏离出厂默认，所有发送键（含 Ctrl/Cmd+Enter）统一遵循原生设置的「本值」行为**——忙碌时按主设置排队或转向，不再保留 Ctrl/Cmd+Enter 的"另一行为"反向特性；
3. 仅当键位保持出厂默认时，插件完全不介入，一切手势保持纯原生；
4. 插件页中的说明文字也写明了这一关系。

一句话总结：**插件决定"哪个键发送"，原生设置决定"忙碌时发送意味着什么"。**

## 安全与边界

- **零干预默认**：键位等于出厂默认时，所有原生手势直接放行，插件对页面没有任何行为影响；一旦改绑（含预设/文字编辑），已绑定的发送手势统一接管并按普通 Enter 重放；Shift+Enter 换行恒放行；打断手势仅在任务运行时触发。
- **输入法安全**：中文/日文等 IME 组合输入期间的按键（选字）永远不会被拦截。
- **范围最小**：发送/换行只作用于主聊天输入框（依赖其稳定的 DOM 锚点，含内层元素上溯识别）；打断虽是页面级监听，但对话框/菜单打开时完全让路，空闲时也不吞任何键。
- **无循环风险**：插件自己重放的合成事件通过 `isTrusted=false` 识别并放行。
- **优雅降级**：`configForms`/`settingsScope`（持久化）、`uiSession`（打断的实时状态）等服务不可用时，对应能力自动降级（会话内记忆 / 基线回退），键盘引擎照常工作。

## 安装

从本地 checkout 安装（安装方式为符号链接，改源码重启即生效）：

```bash
dsh plugin --profile web add ./dsh-composer-keys
```

重启 `dsh web` 后生效；若浏览器仍表现异常，请**硬刷新**（Ctrl+Shift+R，模块 URL 有缓存）。卸载：

```bash
dsh plugin --profile web remove dsh-composer-keys
```

## 使用

1. 打开侧边栏「插件」→ 进入 `dsh-composer-keys`（Settings → 内置插件可看运行状态）；
2. bundle 页直接看到「发送 / 换行 / 打断」三个文字配置项，值为逗号分隔的组合键（如 `enter, ctrl+enter`；修饰符顺序不限）；**每个键位字段标题行内、「已修改」徽标前面有「+ 录制按键」按钮**：点一下，直接按键即录入草稿（同名键自动从其他动作移走，Esc 取消；录制打断时按 Esc 即录入 Esc）；也可手敲逗号分隔的键位文字；
3. 「键位方案」复选框条一键切换整套三元组（DSH 原生 / 微信风格 / 自定义方案），勾选联动下方字段；标题行右侧有**「经典界面」按钮**——直接打开浮动面板（里面的改动立即生效）；要新建方案就改字段后在「新建方案名」里填名字再保存；「打断」留空 = 不启用；
4. 点「保存」后立即生效。无效格式（识别不了的组合）标红并阻止保存（此时该字段的「+ 录制」也会停用）；「已修改」徽标旁的「重置」把该字段恢复为部署默认；
5. 也可以走浮动面板（Settings→General「设置…」或输入框旁键盘按钮打开）：改键立即生效、chip 删除、「+ 录制按键」直接按键录制、顶部方案条与「保存方案」行；底部可深链到插件页设置。

## 工作原理

- **浏览器半件**：手写 lazy-CJS bundle（`window.__ModuleLoader__.load({id, factory})`），无构建步骤。纯手势/方案引擎在文件顶部并暴露测试钩子，Node 测试直接评估真实源码。**配置页**：向插件页注册 `plugins.bundle.config`（key = 包名 `dsh-composer-keys`，bundle 页内嵌）与 `plugins.row.config`（key = `dsh-composer-keys#composer-keys`，组件行 Configure 页）两个 slot，两处共用同一控制器；渲染 DSH 原生 `SettingsForm`（`SettingsFormModel` 舞台化三个文字字段 + 「新建方案名」字段 + 顶置复选框方案条 + 隐藏 `presets` 写入通道），修改只进草稿，Save 才提交。
- **宿主半件**：导出带 **volatile** 标记的 `Config`（`send`/`newline`/`interrupt`/`presets`/`builtinSchemes`）。0.1.7 的设置命名空间由条目 id + Config 的 volatile 字段派生；≤0.1.6 走遗留的 `settings.register`。**设置服务从不列入顶层 inject**（否则整插件会卡 `pending`），一律用可选嵌套注入。
- **「发送」** ＝ 重放合成普通 Enter（见上文两层语义）。
- **「换行」** ＝ 默认 Shift+Enter 恒放行原生；自定义换行键在 DSH ≥0.1.5 的 Lexical 编辑器中沿 DOM 上溯取 `__lexicalEditor`，从命令注册表取出 `INSERT_LINE_BREAK_COMMAND` **对象本身**并 dispatch（命令按对象身份匹配，不能用名字字符串），失败时依次回退到合成 Shift+Enter、`execCommand`、textarea value-setter。
- **「打断」** ＝ 解析当前会话（复刻官方 `uiSession.publishMain` 顺序：跟踪的 current + 主视图保留 → 主视图行 → 兼容回退，见 `resolveCurrentSessionId`），忙碌判定读 **`uiSession.sessionStatus` 合并视图**（Host 基线 + 状态事件），再调用与停止按钮完全相同的取消入口 `scope(id).get('conversation').cancel()`——子代理地址路由、错误展示与原生一致。
- **持久化** ＝ 插件页 Save 一次 `scope.mutate(ops, revision)` 原子提交；回显经 describe mirror 流入 `adoptScopeView`（无乐观门——写路径唯一，回显即真相），键盘引擎随之即时更新。清空一个字段提交 `clear` → 恢复该通道的部署默认三元组（注意：这不是「显式空 = 禁用」，打断留空恰与出厂默认一致）。

## 故障排查

控制台（F12）按时间线自诊断，每一步都有日志：

```
加载时  [composer-keys] page-wide interrupt engine installed; ... boot: [...]
通道变化 [composer-keys] interrupt channel → escape       （保存 / 从文档采纳）
按下后  [composer-keys] interrupt fired                   （成功）
        [composer-keys] interrupt skipped: <原因>           （yield / not-running / no-current-session (open: N) / ...）
```

插件页里看不到配置表单：多半是浏览器端模块缓存（硬刷新 Ctrl+Shift+R），或可选依赖 `@deepseek-ai/dsh-client-ui-primitives` 加载失败（控制台会打 `[composer-keys] optional require failed`——键盘引擎不受影响，只是插件页配置缺席）。保存被拒时由 DSH 原生表单提示「本部署没有接受这些值」。

地面真相文件（服务端实际值）：`~/.dsh/profiles/web/cordis.patch.yml` 中的 `- id: composer-keys` 条目；注册状态看同目录 `package.json`（dependency + `dsh.profile.bundles`）。若 `dsh plugin` 命令卡住，检查 `package.json.lock` 是否为**已死进程的残留锁**。

启动时报 `composer-keys (dsh-composer-keys): failed to import`：宿主半件没能在装载时拿到 `@deepseek-ai/schemastery`（0.1.7-rc.2 起 Loader 只回显这一句，不带原因）。符号链接安装（`link:`）最容易触发——Node 会先把链接 realpath 回源码目录再解析裸依赖。`index.js` 已按 `DSH_PROFILE_DIR` → `DSH_HOME/profiles/<profile>` → `dsh` 入口进程 → `cwd` 的顺序兜底解析，全部失败时会把尝试过的路径直接打进终端；按打印的清单补齐依赖即可。

## 已知限制

- DSH 大版本升级若改变输入框 DOM 结构（目前锚点是 `[data-input-scroll]`），拦截可能失效——失效模式是"插件静默不生效"，不会破坏原生功能。Lexical 换行适配依赖 `__lexicalEditor`、`_commands` 与命令的 `type` 标签；插件不会绕过编辑器直接改 DOM。
- 插件页控件全部为 DSH 原生组件（`SettingsForm` / `SettingsValueField` / `Checkbox`）与官方语义 token，深浅色随主题自动切换。
- 自定义键位方案（≤3 个）可在浮动面板的「保存方案」行（或插件页「新建方案名」字段，staged）创建与覆盖；同名覆盖、名字永不落盘（文档里只存 `presets`）。
- 需要重启 `dsh web` 才能加载新的插件代码（浏览器侧需硬刷新）。

## 开发

```bash
npm test
```

测试用 Node 内置测试运行器直接评估 `client.js` 的真实源码，无需构建、无第三方依赖。覆盖：手势归一化、绑定解析（含 mod 别名）、动作解析、零干预等价判定、互斥迁移、脏数据清洗（绑定/自定义方案/内置方案覆盖）、方案匹配与回写、当前会话解析回退链、显示格式化（当前共 24 例）。

语法检查：

```bash
node --check client.js
```

## License

MIT
