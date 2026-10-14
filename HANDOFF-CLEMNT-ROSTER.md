# 克莱门莎 / 流明干员池开关交接（2026-10-14）

## 分支与续接

- 分支：`feat/clemnt-lumen-roster-20261014`，推送目标：远端 `mine`。
- 基于 `fd9debc5`（乌尔比安特质开关提交）。
- 新 PC 执行：`git fetch mine`，然后 `git switch --track mine/feat/clemnt-lumen-roster-20261014`。
- 安装依赖：`npm ci`。启动前确认 `data/config.json` 中的开关；修改后重启服务并刷新浏览器。

## 已实现

`data/config.json` 新增 `"clemntRosterVersion": "modified"`，与 `ulpiaTraitVersion` 独立。
设置为 `"original"` 恢复原来的干员池与自选名单；未配置或未知值也按原版处理，兼容旧数据。

1. 默认从自选名单移除克莱门莎，加入6阶商店 / 共享库存；流明退出该池，加入5阶、6阶自选名单。
2. 用户最终确认：克莱门莎是 **NORMAL 普通干员，需要补位**，默认二技能「风暴潮」，不是特许干员。
   补位沿用现有6阶近卫的 Sharp（`char_609_acguad`）配置，继承她的盟约和特质。
   当前官方数据没有克莱门莎模组，未虚构模组。
3. 克莱门莎盟约：阿戈尔、迅捷。特质文本沿用圣聆初雪格式：
   `【阿戈尔】【迅捷】每叠加2层，本干员攻击力+1%`，精锐为 `+2%`。
   算法直接复用 `attrByBond`：合计两个 **已激活** 盟约层数，再除以2向下取整；叠层后在下一次模拟更新刷新。
4. 自选流明仅属于协防干员（`emptyShip`），不携带专属特质；三种技能、潜能及自选模组选择沿用现有机制。
5. 服务端、浏览器 UI、浏览器注入模拟、盟约成员名单统一通过 `shared/rosterVariant.js` 应用不可变数据视图。
   原始流明记录仍保留为隐藏兼容记录，不能出现在正常商店共享池中。
6. 新特质的界面文本已加入四个语言包；规则、历史、DATA / META / SIM 文档已同步。

## 数据生成与代码入口

- `tools/build-data.mjs` 生成 `backups.rosterVariant`（克莱门莎棋子、特质、流明自选元数据）和流明全部自选形态。
- 克莱门莎 ID：`chess_char_6_clemnt_a` / `_b`；特质：`garrison_clemnt_a` / `_b`。
- `shared/rosterVariant.js`：运行时选取数据视图，不手改原始棋子 / 特质表。
- `server/data.js`、`server/match/gamedata.js`、`server/sim/simdata.js`：服务端与模拟入口。
- `public/js/data.js`：生产数据单例启用 `rosterRules`；通用测试数据存储默认不加载额外依赖，避免破坏独立异步加载。
- `server/sim/content/kits/index.js`：克莱门莎普通棋子复用既有角色 kit；流明 kit 同时注册为自选角色。
- `test/roster-variant.test.js`：开关回退、库存、自选名单、补位、潜能、全部技能、层数边界、浏览器一致性。

本机原缓存不完整且 character_table 过旧，已刷新官方数据缓存。完整生成输出先写到会话目录检查：
chess / bonds / garrisons 语义均未变化，backups 只增加本次需要的数据；config 的完整重建会将原有
multi_abyss 第一回合准备时间由85恢复为65，因此没有覆盖该既有设置。
随后通过 `node tools/build-data.mjs --offline --roster-only --quiet` 只生成 backups 和新开关。
新增 `--roster-only` 可保留现有 config 的其他可调参数。正常完整生成命令仍保留。

## 验证

- `npm ci`：成功，依赖恢复；审计报告0漏洞。
- `node --test test/roster-variant.test.js test/diy.test.js test/content/op_clemnt.test.js test/match/standin-ownership.test.js test/sim/loadout.test.js test/docs-consistency.test.js test/docs-paths.test.js test/i18n-data.test.js`：
  **103 tests，103 passed，0 failed**。
- 最后的浏览器存储依赖调整后，额外运行：
  `node --test --test-name-pattern="data.js" test/client-static.test.js`，通过；
  `node --test test/roster-variant.test.js test/ui/playtest3.test.js test/i18n-data.test.js`，通过。
- `npm run typecheck`：通过（最后调整后再次通过）。
- 修改文件 ESLint：0 errors；工具中有既有的 unused eslint-disable warning，详情面板另有两个既有 warning。
- `node tools/i18n.mjs check --all --strict`：四包均1191/1191，0 missing、0 errors。
- `npm run golden:update`：成功，更新全部6个 family；最后 `npm run golden`：
  roster 49、bonds 46、fields 22、matches 20、standins 10、diy 141，全部匹配（共288场景）。
- `git diff --check`：通过。
- 未运行完整 `npm run ci`，未进行真实浏览器手动 / E2E 测试。

## 已知阻塞 / 下一班可继续

1. 本次最初运行的 garrisons 两个综合测试文件有 **3个既有失败**：
   `garrisons_battle.test.js` 的 attrByBond 与 coverage、`garrisons_meta.test.js` 的乌尔比安原版获得行为。
   原因是上一提交默认启用乌尔比安新版，但原有综合断言仍期待其原版加成 / 不送装备。
   本次没有修改乌尔比安逻辑，也没有为迁就这些断言关闭它。可下一班为相关旧算法测试显式设置原版。
2. `node tools/check-imports.mjs` 报 `server/sim/nodeData.js` 原有3条 Node import-boundary violation，
   指向 fs / path / url；该文件未改动。需要检查 Windows 路径判断或该已有例外的处理。
3. 原先包含 client-static 全部语法检查、data 重建的较大测试组中断。
   曾遇到通用数据存储新增依赖与 deferred-fetch mock 冲突，已通过生产单例专用 `rosterRules` 修复，
   并单独验证相关存储测试；完整大组没有重新运行。
4. 初始工作树 `data/garrisons.json` 只有用户已有的格式化修改，语义与 HEAD 相同；
   **没有覆盖，也没有纳入本次提交**。该本机格式修改不会随新分支带到新 PC，不影响功能。

## Golden 变动

预期原因：新增 NORMAL 棋子、更换盟约成员与库存 / 自选名单，改变自动生成场景和匹配中的抽牌 / 战斗结果；
DIY 新增流明的覆盖。此前乌尔比安默认新版提交未同步的旧 golden 也在本次默认配置重算中一起对齐，
不能把所有差异都归因于克莱门莎。具体变化相对 `fd9debc5`：

- roster：017、018、019、021、036、037、038、046、047、048。
- bonds：emptyShip-high、indomShip-low、kazimierzShip-low、kjeragShip-high、raidShip-low、
  siracusaShip-high、soloShip-low、visiShip-low、visiShip-high（均带 `bond-` 前缀）。
- fields：boss-boss_1-pair、boss-boss_2-solo、boss-boss_3-pair、boss-boss_5-pair、boss-boss_7-pair、
  hidden-boss_8-pair、hidden-boss_9-pair、unite-2。
- matches：solo-NORMAL-1/2、solo-HARD-1/2、solo-ABYSS-1/2、coop2-NORMAL-3、coop2-HARD-4、
  coop4-FUNNY-6、coop4-ABYSS-7、coop2-NORMAL-8-serverrun、solo-HARD-9-boosted、
  coop2-ABYSS-10-boosted、coop2-NORMAL-14-standins、coop2-NORMAL-70-diy、
  coop2-NORMAL-1-coverage-standins、coop2-NORMAL-5-coverage-diy。
- standins：05、06、07、08、09、10（均带 `standin-` 前缀）。
- diy：004、010、055、062、074、135、136、137、138、139、140、141（均带 `diy-` 前缀，141为新增）。
