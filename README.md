# dsh-composer-keys

<p align="center">
  <strong>把「发送 / 换行 / 打断」分配给你顺手的键 / Send, newline & interrupt — bound to the keys you like</strong>
</p>

> **v0.1.2 · 适配 DSH 0.1.7-rc.1**（同时通过双路径兼容 ≤0.1.6 的旧设置面）

`dsh-composer-keys` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 前端的输入框按键自定义插件：把 **Enter、Ctrl/Cmd+Enter、Shift+Enter 或任意自定义组合键**自由分配给「发送」「换行」「打断」三个动作，并提供可隔离切换的**键位方案**（预设）。

**默认保持 DSH 原生行为**——装上插件后一切照旧，只有你主动改绑（或点预设）才会变化。

## 版本兼容

| DSH 版本 | 状态 | 设置持久化通道 |
| --- | --- | --- |
| **0.1.7-rc.1** | ✅ 适配（本版本主目标） | `configForms` + 条目 volatile `Config` 派生命名空间 |
| ≤ 0.1.6 | ✅ 兼容（遗留路径） | `settingsScope.bind` / `settings.register` |

两个世代的差异全部在插件内部做特性检测，升级无需改配置。

## 特性

- **三通道自由分配**：「发送」「换行」「打断」各自绑定任意一组组合键；同一按键不能同时属于多个动作（录制时自动迁移，优先级：发送 > 换行 > 打断）。
- **方案隔离的快速预设**：
  - 内置 `DSH 原生`、`微信风格`，外加**最多 3 个自定义方案**（「+ 添加自定义预设」快照当前键位，芯片尾部 × 单独删除）；
  - 每个方案是**完整的三通道**（发送+换行+打断），点预设 = 整体切换为该方案自己的键位，方案之间**互不串值**；
  - 在某方案下录制/删除按键会**自动回写该方案**，切走再切回永远完整恢复；不匹配任何方案的键位视为自由态，只改当前不落方案。
- **任务打断**：「打断」中断当前打开会话正在运行的任务，等同于输入框的停止按钮——走同一条原生取消管线（含子代理地址路由）。任务运行时在页面**任意位置**生效；对话框/菜单/本插件面板打开时让路；空闲时按下不吞键、零副作用，并在控制台打印跳过原因。默认无绑定。
- **Shift+Enter 永远安全**：默认换行键恒放行给原生处理器（任何绑定状态下都不可能被插件吞掉）；自定义换行键才由插件接管（Lexical 命令身份对象 dispatch，草稿/选区/撤销历史保持同步）。
- **两处入口**：Settings → General 的「输入框按键」一行；聊天输入框工具行右侧的小键盘按钮。两者打开同一个配置面板。
- **持久化**：键位与方案存入 DSH 用户设置文档的 `composer-keys` 命名空间——与主题、语言等原生偏好同一条通道，重启保留、跨设备跟随用户文档。写入为**原子单次提交**并带确认门，回显与本地不一致时不会把乐观状态弹回旧值。
- **即时生效**：改绑后无需刷新页面。

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
4. 插件面板中的说明文字也写明了这一关系。

一句话总结：**插件决定"哪个键发送"，原生设置决定"忙碌时发送意味着什么"。**

## 安全与边界

- **零干预默认**：键位等于出厂默认时，所有原生手势直接放行，插件对页面没有任何行为影响；一旦改绑（含预设），已绑定的发送手势统一接管并按普通 Enter 重放；Shift+Enter 换行恒放行；打断手势仅在任务运行时触发。
- **输入法安全**：中文/日文等 IME 组合输入期间的按键（选字）永远不会被拦截。
- **范围最小**：发送/换行只作用于主聊天输入框（依赖其稳定的 DOM 锚点，含内层元素上溯识别）；打断虽是页面级监听，但对话框/菜单/本插件面板打开时完全让路，空闲时也不吞任何键。
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

1. 打开 Settings → General 找到「输入框按键」行（或点击输入框右下角的小键盘图标），点「配置…」；
2. 在「发送」「换行」「打断」区块点「+ 录制按键」，然后按下想要的组合键（Esc 取消；**录制打断键时按 Esc 即绑定 Esc**，取消改为再点一次按钮）；
3. 点击已录制键位标签上的 × 可移除；
4. 底部预设区：`DSH 原生` / `微信风格` / 你的自定义方案一键切换；「+ 添加自定义预设」把**当前完整键位**存为新方案（最多 3 个），芯片尾部 × 删除该方案。方案切换与编辑互相隔离，详见特性一节。

## 工作原理

- **浏览器半件**：手写 lazy-CJS bundle（`window.__ModuleLoader__.load({id, factory})`），无构建步骤。纯手势/方案引擎在文件顶部并暴露测试钩子，Node 测试直接评估真实源码。
- **宿主半件**：导出带 **volatile** 标记的 `Config`（`send`/`newline`/`interrupt`/`presets`/`builtinSchemes`）。0.1.7 的设置命名空间由条目 id + Config 的 volatile 字段派生；≤0.1.6 走遗留的 `settings.register`。**设置服务从不列入顶层 inject**（否则整插件会卡 `pending`），一律用可选嵌套注入。
- **「发送」** ＝ 重放合成普通 Enter（见上文两层语义）。
- **「换行」** ＝ 默认 Shift+Enter 恒放行原生；自定义换行键在 DSH ≥0.1.5 的 Lexical 编辑器中沿 DOM 上溯取 `__lexicalEditor`，从命令注册表取出 `INSERT_LINE_BREAK_COMMAND` **对象本身**并 dispatch（命令按对象身份匹配，不能用名字字符串），失败时依次回退到合成 Shift+Enter、`execCommand`、textarea value-setter。
- **「打断」** ＝ 解析当前会话（复刻官方 `uiSession.publishMain` 顺序：跟踪的 current + 主视图保留 → 主视图行 → 兼容回退，见 `resolveCurrentSessionId`），忙碌判定读 **`uiSession.sessionStatus` 合并视图**（Host 基线 + 状态事件），再调用与停止按钮完全相同的取消入口 `scope(id).get('conversation').cancel()`——子代理地址路由、错误展示与原生一致。
- **持久化** ＝ `mutate` 原子单写 + 每条流的确认门（回显匹配才放行，矛盾回显忽略，被拒写入告警后如实采纳）。

## 故障排查

控制台（F12）按时间线自诊断，每一步都有日志：

```
加载时  [composer-keys] page-wide interrupt engine installed; ... boot: [...]
通道变化 [composer-keys] interrupt channel → escape       （录制 / 从文档采纳）
按下后  [composer-keys] interrupt fired                   （成功）
        [composer-keys] interrupt skipped: <原因>           （yield / not-running / no-current-session (open: N) / ...）
写入    [composer-keys] Host rejected the ... write        （被 Host 拒绝，随后回退是如实行为）
```

地面真相文件（服务端实际值）：`~/.dsh/profiles/web/cordis.patch.yml` 中的 `- id: composer-keys` 条目；注册状态看同目录 `package.json`（dependency + `dsh.profile.bundles`）。若 `dsh plugin` 命令卡住，检查 `package.json.lock` 是否为**已死进程的残留锁**。

## 已知限制

- DSH 大版本升级若改变输入框 DOM 结构（目前锚点是 `[data-input-scroll]`），拦截可能失效——失效模式是"插件静默不生效"，不会破坏原生功能。Lexical 换行适配依赖 `__lexicalEditor`、`_commands` 与命令的 `type` 标签；插件不会绕过编辑器直接改 DOM。
- 面板样式全部引用 DSH 官方语义 token（`--dsw-alias-*`），深浅色随主题自动切换，仅保留浅色兜底。
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
