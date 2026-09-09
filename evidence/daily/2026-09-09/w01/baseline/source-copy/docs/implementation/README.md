# 持续开发状态

[progress.json](progress.json) 是执行者每天维护的轻量状态，不是产品事实库，也不是测试通过证明。[每日任务书](../DAILY_DEVELOPMENT_WORK_ORDER.md) 规定工作项、合同与状态值；[日报模板](DAILY_REPORT_TEMPLATE.md) 规定交付材料。

初始状态全部 NOT_IMPLEMENTED 指的是各工作项的目标尚未整体实现，不否认已有 Foundation 0.1。执行者开工后设置 active_window，并记录自己的起止和 evidence_dir；本任务包生成时没有启动十小时计时。

建议 active_window 内容：window_id、started_at_utc、timezone、deadline_utc、status、evidence_dir、last_checkpoint、last_verified_source_manifest、next_action。中断后保留相同窗口身份和原时间边界。每个 W 可以记录多个 feature/profile，不能用一个 PASS 覆盖其中未实现的子项。

实现者维护 implementation、automated_checks、qualification、evidence、blockers 和当前动作。独立审查者维护 ACCEPTED/CHANGES_REQUIRED；每次审查绑定当时源码清单与 profile，之后变更可能要求复验。

每日证据使用递增、不可覆盖的窗口目录。原 foundation 证据保留。不要把原始用户项目、会话 token、秘密或运行数据库写入公开交付材料。
