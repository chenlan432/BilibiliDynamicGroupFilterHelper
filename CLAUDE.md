# 开发备忘

## 项目概述

B站动态分组筛选助手，单文件用户脚本，兼容 Violentmonkey 和 Tampermonkey。通过拦截 B 站动态 API 实现按关注分组过滤动态。

## 文件

- `B站动态分组筛选助手.js`：可直接安装的完整用户脚本，无构建步骤。
- `tests/userscript.test.mjs`：Node 内置测试，覆盖纯函数、安全约束和发布元数据。
- `README.md`：安装、使用、限制和版本说明。
- `LICENSE`：MIT 许可证。

## 关键架构决策

### fetch 拦截器内补齐数据，但必须有预算

B 站动态页的无限滚动依赖 API 返回的 `offset`、`items` 和 `has_more`。过滤后 `items` 为空时，需要在拦截器内用原始 `fetch` 连续请求后续页面。

单次扫描必须同时受页数和时间限制，并经过统一请求节流。当前上限是 10 页、6 秒。遇到 HTTP 412/429 或风控类 API code 必须停止，不能继续重试。

错误做法：

- 返回空 `items` 后依赖 `scrollTo` 触发下一页。
- 使用 `setTimeout` 异步拉取，导致数据无法注入当前 B 站前端请求。
- 为极小概率的分组连续请求几十或几百页。

### 网络失败与空分组必须区分

获取分组成员失败时，不能把它当成“分组中没有成员”。失败必须保留用户选择，并优先使用旧的完整缓存。只有完整拉取成功后才写入新缓存，避免缓存半个成员列表。

### 原始 fetch 与 GM_xmlhttpRequest

- 保存 `unsafeWindow.fetch` 的原始引用用于同源动态分页请求，避免再次进入拦截器。
- `GM_xmlhttpRequest` 用于 `api.bilibili.com` 的分组与成员接口。
- 所有脚本主动请求统一经过 `scheduleApiTask()`，默认间隔 250ms，并使用有限重试。

### 响应重建

过滤后只复制原始响应的 `content-type`，不能完整复制 `headers`。响应体已经重新序列化，复制 `content-length`、`content-encoding` 会产生不一致。

### 安全 UI

分组名来自接口，属于不可信文本。所有动态内容必须通过 `textContent`、`dataset` 和 DOM API 渲染，禁止 `innerHTML` 或属性字符串拼接。

### 选择流程

面板中的选择是草稿，点击「应用筛选」后才持久化并刷新页面。不要在每个勾选动作中启动异步成员加载，否则容易产生旧请求覆盖新选择的竞态。

## 测试钩子

`unsafeWindow.__GF_TEST_HOOK__` 只在测试环境设置。设置后脚本导出纯函数并立即返回，不执行 DOM、存储或网络初始化。

## 验证命令

```powershell
npm run check
npm test
npm run verify
```
