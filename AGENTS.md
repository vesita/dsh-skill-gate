# dsh-skill-gate 开发规则

本仓是一个 DeepSeek Harness 插件包。它解决什么问题、怎么配置、边界在哪，写在 `README.md`；
本文件只写改这个仓时要遵守的规则。

## 自检与打包

```bash
pnpm install          # 只为自检与打包；node_modules 不提交
node selfcheck.mjs    # 判定逻辑自检；退出码即判据（0 = 全过）
pnpm pack             # 产出 dsh-skill-gate-<version>.tgz
```

装回本机某个 profile：

```bash
mv dsh-skill-gate-<version>.tgz "$DSH_HOME/packages/"
dsh plugin --profile <profile> add "file:$DSH_HOME/packages/dsh-skill-gate-<version>.tgz"
```

改完要**重启 dsh** 才生效。`<profile>/node_modules/dsh-skill-gate/` 是安装产物，**不要手改**
（重装即被覆盖，改本仓）。同一台机器上多个 profile 共用同一个 `node_modules`（软链）时，
装其中一个即可。

## 改代码时

- `index.js` 是唯一实现。`Config` 必须挂在默认导出上（`export default { name, inject, apply, Config }`）——
  Loader 从插件对象的 `Config` 投影条目配置，漏了插件页的配置表单会整张空白。
- 判定语义、受保护工具名单与已知边界都写在 `README.md`；改行为就同步改它，别在两处各写一份。
- 拒绝文案只引用配置里的名字与 `skill({ name: "…" })` 这种写法，**不要写死任何具体 skill 名**。
- 往受保护名单里加名字之前先问一句：拦错了会不会挡住纯探查？加了就在 `selfcheck.mjs` 补对应断言。
- 现读配置走 `liveConfig(ctx)`（`ctx.get('config')`，再退回普通字段），**绝不写 `ctx.config`** ——
  Cordis 的 ctx 是代理，未 inject 的属性是抛错（`cannot get property "config" without inject`）而不是
  undefined，而那个错误在参数求值时就炸，包住读取的 try/catch 接不住。volatile 字段是稳定引用，
  改配置不重载插件，所以每次都重新读，别把值缓存成常量。`selfcheck.mjs` 的 `configThrows` 用例钉住这条。
- catalog 软化失败时保持严格（fail-closed），不要为了「不误拦」把门禁放宽。

## 提交

一个改动一个提交，提交信息说清**为什么**（不是罗列改了哪些行）。
